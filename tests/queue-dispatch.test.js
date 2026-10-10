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
      quotaFallback: (_s, cmd, _seats, _active, _now, options) => h.low?.has(cmd) && options?.explicit
        ? { action: 'queue', cmd, reason: 'explicit', held: 'low', note: '已用 --command 点名模型，不自动更换' }
        : h.out.has(cmd)
        ? { action: 'queue', cmd, reason: 'out', held: 'out' } : { action: 'open', cmd },
    },
    ChatUI: { addCard() {}, updateCard() {}, hasDraft: () => false, turnsOf: () => [] },
    deck: {
      onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
      memoryPressure: async () => ({ level: h.pressure }),
      saveLongPrompt: async () => { if (h.failLong) throw new Error('disk full'); return '/tmp/queue-unit-long.txt'; },
      taskBoard: async (op, input) => {
        if (op === 'bind' && h.failBind) throw new Error('bind failed');
        if (op === 'list') { h.lists = (h.lists || 0) + 1; if (h.listDown || h.listFailsAt === h.lists) throw new Error('board busy: list'); }
        return store[op](input);
      },
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

test('explicit named command queue reason clarifies 5-hour quota is below threshold', async (t) => {
  const h = runtime(t), card = h.add();
  h.low = new Set(['low-cmd']);
  const result = await h.assign(card, 'low-cmd');
  assert.equal(result.done, true);
  assert.match(result.result, /已用 --command 点名模型，不自动更换。5 小时额度低于阈值，稍后自动开新会话/);
  assert.match((await h.queue())[0].reason, /5 小时额度低于阈值/);
});

// ---- what waited for quota must not start by itself once the card is no longer the Captain's order ----
const tickAndWait = async (h) => { h.window.ChatUI.readFooter ??= () => []; h.window.MainSession.onTick(h.captain.id, { alive: true, state: 'plain' }); for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const notices = (h) => h.state.pending.filter((p) => p.title === '任务看板').map((p) => p.summary);

test('a card left unchanged while it waited for quota opens when quota returns; a priority mark or a receipt does not hold it back', async (t) => {
  const h = runtime(t), card = h.add();
  await h.assign(card);
  assert.equal(h.state.waitlist.length, 1); assert.ok(h.state.waitlist[0].cardGist);
  const current = h.store.list().find((c) => c.id === card.id);
  h.store.update({ id: card.id, updated: current.updated, patch: { important: true } });
  h.out.clear();
  await tickAndWait(h);
  assert.equal(h.state.waitlist.length, 0); assert.equal(h.columns.length, 2, 'the session opened');
  assert.equal(notices(h).filter((n) => n.includes('没有自动')).length, 0);
});

test('the user put the card on 需要你, back with a new note, or archived it while it waited: quota returning opens nothing and the Captain is told', async (t) => {
  const changes = {
    '需要你': (h, card) => h.store.move({ id: card.id, status: 'needs_user' }),
    '改了说明（暂缓）': (h, card) => h.store.update({ id: card.id, updated: h.store.list().find((c) => c.id === card.id).updated, patch: { detail: '用户要先讨论设计，暂不派' } }),
    '归档': (h, card) => { h.store.move({ id: card.id, status: 'done' }); h.store.archive({ done: true, project: 'test' }); },
  };
  for (const [name, change] of Object.entries(changes)) {
    const h = runtime(t), card = h.add();
    await h.assign(card);
    assert.equal(h.state.waitlist.length, 1, name);
    change(h, card);   // written straight to the board, as the other machine or the UI of another process would
    h.out.clear();
    await tickAndWait(h);
    assert.equal(h.columns.length, 1, name + ': no session');
    assert.equal(h.state.waitlist.length, 0, name);
    assert.equal(h.state.tasks[0].status, 'stopped', name); assert.match(h.state.tasks[0].receipt.summary, /没有自动派/);
    assert.equal(notices(h).filter((n) => n.includes('额度回来后没有自动开')).length, 1, name);
    if (name === '需要你') assert.equal(storeStatus(h, card), 'needs_user', 'the card stays where the user put it');
  }
});

test('moving a queued card to 需要你 on this machine cancels its request at once', async (t) => {
  const h = runtime(t), card = h.add();
  await h.assign(card);
  await h.window.TaskBoard.move(card.id, 'needs_user');
  assert.equal(h.state.waitlist.length, 0);
  assert.equal(storeStatus(h, card), 'needs_user');
});

test('a card the Captain queued while it was already on 需要你 opens when quota returns: only a card put there while it waited is stopped', async (t) => {
  const h = runtime(t), card = h.add();
  h.store.move({ id: card.id, status: 'needs_user' });   // e.g. a dispatcher's finish put it there; the Captain then orders the work
  await h.assign(card);
  assert.equal(h.state.waitlist.length, 1); assert.equal(JSON.parse(h.state.waitlist[0].cardGist)[0], 'needs_user');
  h.out.clear();
  await tickAndWait(h);
  assert.equal(h.columns.length, 2, 'the session opened'); assert.equal(h.state.waitlist.length, 0);
  assert.equal(notices(h).filter((n) => n.includes('没有自动开')).length, 0);
  // and the one moved there while it waited is stopped, as before
  const h2 = runtime(t), card2 = h2.add();
  await h2.assign(card2);
  h2.store.move({ id: card2.id, status: 'needs_user' });
  h2.out.clear();
  await tickAndWait(h2);
  assert.equal(h2.columns.length, 1); assert.match(notices(h2).join('\n'), /在排队期间被放到了「需要你」/);
});

test('a board that cannot be read when the request is due puts it back and judges it on the next turn; it neither opens blind nor drops', async (t) => {
  // read later: the card went to 需要你 while it waited -> nothing opens
  const h = runtime(t), card = h.add();
  await h.assign(card);
  h.store.move({ id: card.id, status: 'needs_user' });
  h.out.clear(); h.listDown = true;
  await tickAndWait(h);
  assert.equal(h.columns.length, 1, 'no session while the board is unreadable'); assert.equal(h.state.waitlist.length, 1, 'the request is still in the queue');
  assert.equal(h.state.tasks[0].status, 'waiting');
  const before = h.lists;
  await tickAndWait(h); await tickAndWait(h);
  assert.equal(h.columns.length, 1); assert.equal(h.state.waitlist.length, 1);
  assert.ok(h.lists >= before, 'it is tried again on every turn');
  h.listDown = false;
  await tickAndWait(h);
  assert.equal(h.columns.length, 1); assert.equal(h.state.waitlist.length, 0);
  assert.equal(h.state.tasks[0].status, 'stopped'); assert.match(notices(h).join('\n'), /在排队期间被放到了「需要你」/);
  // read later: nothing changed -> it opens, once
  const h2 = runtime(t), card2 = h2.add();
  await h2.assign(card2);
  h2.out.clear(); h2.listDown = true;
  await tickAndWait(h2);
  assert.equal(h2.columns.length, 1); assert.equal(h2.state.waitlist.length, 1);
  h2.listDown = false;
  await tickAndWait(h2);
  assert.equal(h2.columns.length, 2, 'it opened'); assert.equal(h2.state.waitlist.length, 0);
});

test('a request queued while the board could not be read has no record of the card: when it is due the Captain decides, nothing opens by itself', async (t) => {
  const h = runtime(t), card = h.add();
  // count the board reads of one assign, then make exactly the read the queue takes fail
  const probe = runtime(t), probeCard = probe.add();
  const base = probe.lists || 0;
  await probe.assign(probeCard);
  const used = probe.lists - base;
  h.listFailsAt = (h.lists || 0) + used;   // the last read of the assign is the queue's own
  await h.assign(card);
  assert.equal(h.state.waitlist.length, 1); assert.equal(h.state.waitlist[0].gistUnread, true); assert.equal(h.state.waitlist[0].cardGist, undefined);
  h.out.clear();
  await tickAndWait(h);
  assert.equal(h.columns.length, 1); assert.equal(h.state.waitlist.length, 0);
  assert.match(notices(h).join('\n'), /排队那一刻看板读不到/);
});

test('a board that cannot be read puts the requests back in priority order: a 高优先级 one is never overtaken by ordinary work', async (t) => {
  const h = runtime(t), plain = h.add(), urgent = h.add();
  await h.assign(plain); await h.assign(urgent);
  assert.equal(h.state.waitlist.length, 2);
  const marked = h.state.waitlist.find((w) => w.metadata.boardId === urgent.id);
  marked.metadata.important = true;
  h.state.waitlist = M.highFirst(h.state.waitlist, (w) => w.metadata?.important === true);
  assert.equal(h.state.waitlist[0], marked);
  h.out.clear(); h.listDown = true;
  await tickAndWait(h);
  assert.equal(h.columns.length, 1, 'nothing opens while the board is unreadable');
  assert.deepEqual(h.state.waitlist.map((w) => w.metadata.boardId), [urgent.id, plain.id], 'the marked request is still first');
  await tickAndWait(h);
  assert.deepEqual(h.state.waitlist.map((w) => w.metadata.boardId), [urgent.id, plain.id]);
  h.listDown = false;
  await tickAndWait(h);
  assert.equal(h.state.waitlist.length, 0); assert.equal(h.columns.length, 3);
});
