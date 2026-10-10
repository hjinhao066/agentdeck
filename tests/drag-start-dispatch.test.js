'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { TaskStore } = require('../task-board');
const B = require('../board-core');
const M = require('../main-core');
const AV = require('../auto-verify-core');

function runtime(t, dispatcher = 'gemini') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-drag-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const columns = [captain], created = [], sent = [], requests = [];
  const state = { colId: captain.id, tasks: [], pending: [], waitlist: [] };
  const store = new TaskStore(path.join(root, 'tasks'), { sessions: () => columns });
  let quotaOut = false, afterRequest, stanceFn = null, seatList = null;
  const window = {
    MainCore: M, BoardCore: B, AutoVerifyCore: AV,
    QuotaCore: {
      claudeSeats: () => seatList || [{ id: 'default', name: 'Claude', configDir: '~/.claude' }],
      commandQuota: () => ({ out: quotaOut }),
      // the passive reading the dispatcher choice asks (QuotaCore.commandStance): every command is out together or has room
      commandStance: (_s, cmd, _seats, seatId) => (stanceFn ? stanceFn(cmd, seatId) : quotaOut ? 'out' : 'ok'),
      // This harness flags every command out together, so there is no same-tier peer to switch to.
      quotaFallback: (_store, cmd) => quotaOut
        ? { action: 'queue', cmd, reason: 'out', held: 'out', note: '' }
        : { action: 'open', cmd, note: '' },
    },
    ChatUI: { addCard() {}, updateCard() {}, hasDraft: () => false, turnsOf: () => [] },
    deck: {
      onTaskStart() {},
      onTaskReview() {},
      onTaskRework() {},
      taskBoard: async (op, input) => {
        requests.push({ op, input });
        const result = store[op](input);
        if (afterRequest) afterRequest(op, input, result);
        return result;
      },
    },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({
    config: { mainSession: state, folders: [], taskBoard: { dispatcher }, activeClaudeSeatId: 'default' },
    saveConfig() {}, columns: () => columns, terms: new Map(), columnLabel: (c) => c.id,
    platform: 'darwin', userComposing: () => false,
    createSession: (col) => { created.push(col); columns.push(col); return col; },
    sendWhenReady: (col, prompt) => sent.push({ id: col.id, text: typeof prompt === 'function' ? prompt() : prompt }),
    showToast: (message) => { throw new Error(message); },
  });
  window.MainSession.pauseForSeatSwitch(true);
  return {
    board: window.TaskBoard, store, state, created, sent, requests,
    add: (extra = {}) => store.add({ project: '测试项目', title: 'Test', detail: 'Precise instructions.', ...extra }).card,
    setQuota: (value) => { quotaOut = value; },
    setStance: (fn) => { stanceFn = fn; },
    setSeats: (list) => { seatList = list; },
    afterRequest: (callback) => { afterRequest = callback; },
    tick: () => window.MainSession.onTick(captain.id, { alive: true, state: 'done' }),
  };
}

test('drag start and explicit start use the current dispatcher and deliver the same task contract', async (t) => {
  for (const dispatcher of ['gemini', 'captain']) {
    const r = runtime(t, dispatcher);
    for (const start of ['requestStart', 'startCard']) {
      const card = r.add();
      const result = await r.board[start](card.id);
      assert.equal(result.dispatcher, dispatcher);
      assert.equal(r.store.list().find((c) => c.id === card.id).dispatch_claim.delivered, true);
    }
    assert.equal(r.created.length, dispatcher === 'gemini' ? 2 : 0);
    assert.equal(r.state.pending.length, dispatcher === 'captain' ? 2 : 0);
    for (const request of r.requests.filter((x) => x.op === 'dispatch')) assert.ok(request.input.key);
    for (const delivery of r.sent) assert.match(delivery.text, /new --task-id .*--project/);
  }
});

test('important, unclear and needs-user drag starts are handed to the Captain', async (t) => {
  const r = runtime(t);
  for (const extra of [{ important: true }, { detail: '' }, { status: 'needs_user' }]) {
    const card = r.add(extra);
    if (extra.status) await r.board.move(card.id, extra.status);
    assert.equal((await r.board.requestStart(card.id)).dispatcher, 'captain');
    assert.match(r.state.pending.at(-1).summary, /需要队长判断/);
  }
  assert.equal(r.created.length, 0);
});

test('concurrent drag and explicit starts reserve and open only one dispatcher', async (t) => {
  const r = runtime(t), card = r.add();
  const results = await Promise.all([r.board.requestStart(card.id), r.board.startCard(card.id), r.board.requestStart(card.id)]);
  assert.equal(r.created.length, 1);
  assert.equal(r.sent.length, 1);
  assert.equal(new Set(results.map((x) => x.session_id)).size, 1);
  assert.equal((await r.board.requestStart(card.id)).ignored, true);
  assert.equal(r.created.length, 1);
});

test('dragging back to todo and starting again retains the unarchived dispatcher fence', async (t) => {
  const r = runtime(t), card = r.add();
  const first = await r.board.requestStart(card.id);
  await r.board.move(card.id, 'todo');
  const retry = await r.board.requestStart(card.id);
  assert.equal(retry.ignored, true);
  assert.equal(retry.occupied, true);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].id, first.session_id);
  assert.equal(r.created[0].dispatcherCardId, card.id);
});

test('unfinished dependencies reject drag starts without a claim or dispatch', async (t) => {
  const r = runtime(t), predecessor = r.add(), card = r.add({ depends_on: [predecessor.id] });
  await assert.rejects(r.board.requestStart(card.id), /Predecessor/);
  const blocked = r.store.list().find((c) => c.id === card.id);
  assert.equal(blocked.status, 'todo');
  assert.ok(!blocked.dispatch_claim);
  assert.equal(r.created.length, 0);
  assert.equal(r.state.pending.length, 0);
});

test('repeated quota-queued starts preserve one claim and open one dispatcher when quota returns', async (t) => {
  const r = runtime(t), card = r.add();
  r.setQuota(true);
  assert.equal((await r.board.requestStart(card.id)).queued, true);
  const key = r.store.list()[0].dispatch_claim.key;
  assert.equal((await r.board.requestStart(card.id)).ignored, true);
  assert.equal((await r.board.startCard(card.id)).ignored, true);
  assert.equal(r.store.list()[0].dispatch_claim.key, key);
  assert.equal(r.created.length, 0);
  r.setQuota(false);
  r.tick(); r.tick();
  await new Promise(setImmediate);
  assert.equal(r.created.length, 1);
  assert.equal(r.store.list()[0].dispatch_claim.delivered, true);
  r.tick();
  await new Promise(setImmediate);
  assert.equal(r.created.length, 1);
});

test('a drag back to todo while dispatch is reserving prevents the stale start from opening a session', async (t) => {
  const r = runtime(t), card = r.add();
  r.afterRequest((op, input, result) => {
    if (op === 'dispatch' && !input.session_id && !result.ignored) r.store.move({ id: card.id, status: 'todo' });
  });
  assert.equal((await r.board.requestStart(card.id)).ignored, true);
  assert.equal(r.created.length, 0);
  assert.equal(r.store.list()[0].status, 'todo');
});

test('dispatcher reservations reject replaced and delivered claim keys', (t) => {
  const r = runtime(t), card = r.add();
  const oldKey = r.store.claim({ id: card.id }).card.dispatch_claim.key;
  r.store.move({ id: card.id, status: 'todo' });
  const key = r.store.claim({ id: card.id }).card.dispatch_claim.key;
  assert.notEqual(key, oldKey);
  assert.equal(r.store.dispatch({ id: card.id, key: oldKey, session_id: 'stale-dispatcher' }).ignored, true);
  assert.equal(r.store.list()[0].dispatch_session_id, null);
  r.store.dispatched({ id: card.id, key });
  assert.equal(r.store.dispatch({ id: card.id, key, session_id: 'delivered-dispatcher' }).ignored, true);
  assert.equal(r.store.list()[0].dispatch_session_id, null);
});

// ---- who the dispatcher is: Gemini only while it has room, otherwise a Claude Haiku 5.5 session ----
test('Gemini with room dispatches on Gemini; out, stale or erroring Gemini dispatches on Claude Haiku 5.5, and the title says which', async (t) => {
  for (const [gemini, expected] of [['ok', 'agy'], ['low', 'agy'], ['out', 'claude'], ['unknown', 'claude'], ['error', 'claude']]) {
    const r = runtime(t), card = r.add({ title: '画图：全景图（Opus 5.5）' });
    r.setStance((cmd) => (/^agy/.test(cmd) ? gemini : 'ok'));
    const result = await r.board.requestStart(card.id);
    assert.equal(result.dispatcher, 'gemini', 'the key of the setting; the session behind it is the cheap dispatcher');
    assert.equal(r.created.length, 1, gemini);
    const col = r.created[0];
    if (expected === 'agy') {
      assert.match(col.cmd, /^agy .*gemini-3\.8-flash-high/); assert.equal(col.title, '调度：画图：全景图（Gemini 3.8 Flash（Antigravity））');
    } else {
      assert.match(col.cmd, /^claude --dangerously-skip-permissions --model claude-haiku-5-5 --effort medium$/);
      assert.equal(col.title, '调度：画图：全景图（Claude Haiku 5.5）', 'never the executor\'s label from the card, never a different model from the one that runs');
      assert.equal(col.displayTitle, col.title);
    }
    assert.equal(col.dispatcherCardId, card.id);
    assert.match(r.sent[0].text, /new --task-id .*--project/);
  }
});

test('the dispatcher skips a Claude seat that is out, and carries the seat it took', async (t) => {
  const r = runtime(t), card = r.add();
  r.setSeats([{ id: 'default', name: 'CN', configDir: '~/.claude' }, { id: 'us', name: 'US', configDir: '~/.claude-us' }]);
  r.setStance((cmd, seatId) => (/^agy/.test(cmd) ? 'out' : seatId === 'default' ? 'out' : 'ok'));
  await r.board.requestStart(card.id);
  assert.equal(r.created.length, 1);
  assert.match(r.created[0].cmd, /^claude .*claude-haiku-5-5/);
  assert.equal(r.created[0].claudeSeatId, 'us'); assert.equal(r.created[0].claudeConfigDir, '~/.claude-us');
});

test('Gemini and every Claude seat out: the start waits in the ordinary quota queue and opens one dispatcher when room returns', async (t) => {
  const r = runtime(t), card = r.add();
  r.setQuota(true);
  r.setStance(() => 'out');
  const queued = await r.board.requestStart(card.id);
  assert.equal(queued.queued, true); assert.equal(r.created.length, 0);
  assert.match(r.store.list()[0].dispatch_wait, /额度用尽/);
  r.setQuota(false); r.setStance((cmd) => (/^agy/.test(cmd) ? 'unknown' : 'ok'));
  r.tick(); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(r.created.length, 1); assert.match(r.created[0].cmd, /claude-haiku-5-5/);
});
