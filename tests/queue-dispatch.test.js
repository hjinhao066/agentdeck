'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { TaskStore } = require('../task-board');
const M = require('../main-core');
const B = require('../board-core');

function runtime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-queue-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captain = { id: 'captain', isMain: true, cmd: '' }, columns = [captain];
  const state = { colId: captain.id, tasks: [], pending: [], waitlist: [] };
  const store = new TaskStore(path.join(root, 'tasks'), { sessions: () => columns });
  const h = { pressure: 1, out: new Set(['held']), failBind: false, failLong: false, sent: [] };
  const window = {
    MainCore: M, BoardCore: B,
    QuotaCore: {
      commandQuota: (_s, cmd) => ({ out: h.out.has(cmd) }),
      quotaFallback: (_s, cmd) => h.out.has(cmd)
        ? { action: 'queue', cmd, reason: 'out', held: 'out' } : { action: 'open', cmd },
    },
    ChatUI: { addCard() {}, updateCard() {}, hasDraft: () => false, turnsOf: () => [] },
    deck: {
      onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
      memoryPressure: async () => ({ level: h.pressure }),
      saveLongPrompt: async () => { if (h.failLong) throw new Error('disk full'); return '/tmp/queue-unit-long.txt'; },
      taskBoard: async (op, input) => { if (op === 'bind' && h.failBind) throw new Error('bind failed'); return store[op](input); },
    },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({
    config: { mainSession: state, folders: [] }, columns: () => columns, terms: new Map(),
    saveConfig() {}, flushConfig() {}, columnLabel: (c) => c.id, userComposing: () => false,
    createSession: (col) => { columns.push(col); return col; },
    sendWhenReady: (col, text) => h.sent.push({ col, text }),
  });
  return Object.assign(h, {
    window, columns, state, captain, store,
    add: () => store.add({ project: 'test', title: 'Queued task', detail: 'Do the task' }).card,
    assign: (card, command = 'held', task = 'Original body', caller = captain) => window.MainSession.handle({ action: 'main-new', id: 'req-' + Math.random().toString(36).slice(2), boardId: card.id, title: 'Queue test', command, task, dispatcherCardId: caller.dispatcherCardId }, caller),
    queue: async () => JSON.parse((await window.MainSession.handle({ action: 'main-queue', op: 'list' }, captain)).result),
  });
}

test('failed long-body save or board bind preserves the original queued request and body', async (t) => {
  for (const mode of ['save', 'bind']) {
    const h = runtime(t), card = h.add();
    await h.assign(card);
    const old = h.state.waitlist[0], task = h.state.tasks[0];
    if (mode === 'save') { h.out.add('next-held'); h.failLong = true; }
    else h.failBind = true;
    await assert.rejects(h.assign(card, mode === 'save' ? 'next-held' : 'available', mode === 'save' ? 'x'.repeat(M.LONG_PROMPT + 1) : 'New body'), /存文件失败|bind failed/);
    assert.equal(h.state.waitlist.length, 1);
    assert.equal(h.state.waitlist[0], old);
    assert.equal(old.task, 'Original body');
    assert.equal(task.status, 'waiting');
    assert.equal(h.columns.length, 1);
  }
});

test('a dispatcher cannot replace its one queued assignment, but the Captain can', async (t) => {
  const h = runtime(t), card = h.add();
  const dispatcher = { id: 'dispatcher', dispatcherCardId: card.id };
  await h.assign(card, 'held', 'Original body', dispatcher);
  await assert.rejects(h.assign(card, 'available', 'Changed body', dispatcher), /只有队长可以替换排队/);
  assert.equal(h.state.waitlist.length, 1);
  assert.match((await h.assign(card, 'available', 'Captain replacement')).result, /已开新会话/);
  assert.equal(h.state.waitlist.length, 0);
  assert.equal(h.sent.length, 1);
  assert.equal(h.columns[1].taskPrompt, 'Captain replacement');
});

test('waiting notes follow current memory, occupied slots and recovered quota', async (t) => {
  const h = runtime(t), card = h.add();
  h.out.clear(); h.pressure = 4;
  assert.match((await h.assign(card, 'available')).result, /内存吃紧/);
  assert.match((await h.queue())[0].reason, /内存吃紧/);
  h.pressure = 1;
  for (let i = 0; i < M.MAX_ACTIVE; i++) {
    const id = 'working-' + i;
    h.columns.push({ id, captainCrew: true });
    h.state.tasks.push({ colId: id, status: 'working' });
  }
  assert.match((await h.queue())[0].reason, /现在有 30 个会话占用干活名额/);
  h.state.tasks.at(-1).status = 'quota';
  assert.doesNotMatch((await h.queue())[0].reason, /内存吃紧|30 个会话/);
  h.out.add('available');
  assert.match((await h.queue())[0].reason, /额度用尽/);
});

test('idle quota queue ticks do not redraw the sidebar, but changed waiting state does', async (t) => {
  const h = runtime(t), card = h.add();
  let renders = 0;
  h.window.Sidebar = { render: () => renders++ };
  h.window.ChatUI.readFooter = () => [];
  await h.assign(card);
  renders = 0;
  const tick = async () => {
    h.window.MainSession.onTick(h.captain.id, { alive: true, state: 'plain' });
    await new Promise((resolve) => setImmediate(resolve));
  };
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(renders, 0);
  assert.equal(h.state.waitlist.length, 1);
  assert.match(h.state.tasks[0].waitReason, /额度用尽/);

  h.pressure = 4;
  await tick();
  assert.equal(renders, 1);
  assert.equal(h.window.MainSession.memoryHeld(), true);
  await tick();
  assert.equal(renders, 1);

  h.out.clear();
  await tick();
  assert.equal(renders, 2);
  assert.match(h.state.tasks[0].waitReason, /内存吃紧/);
  await tick();
  assert.equal(renders, 2);
});

test('concurrent replacements leave one request and a concurrent done move cancels it', async (t) => {
  const h = runtime(t), card = h.add();
  h.out.add('next-held'); h.out.add('last-held');
  await h.assign(card);
  await Promise.all([h.assign(card, 'next-held'), h.assign(card, 'last-held')]);
  assert.equal(h.state.waitlist.length, 1);
  assert.equal(h.state.waitlist[0].cmd, 'last-held');
  await Promise.all([h.assign(card, 'next-held'), h.window.TaskBoard.move(card.id, 'done')]);
  assert.equal(h.state.waitlist.length, 0);
  assert.equal(storeStatus(h, card), 'done');
  assert.equal(h.columns.length, 1);
});
function storeStatus(h, card) { return h.store.list().find((c) => c.id === card.id).status; }
