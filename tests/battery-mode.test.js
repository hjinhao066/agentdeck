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
const Battery = require('../battery-core');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('mode and cap settings normalize; the battery is active only in 自动 on battery', () => {
  assert.equal(Battery.normalizeMode(), 'auto');
  assert.equal(Battery.normalizeMode('off'), 'off');
  assert.equal(Battery.normalizeMode('whatever'), 'auto');
  assert.equal(Battery.normalizeCap(), 3);
  assert.equal(Battery.normalizeCap(''), 3);
  assert.equal(Battery.normalizeCap('7'), 7);
  assert.equal(Battery.normalizeCap(0), 1);
  assert.equal(Battery.normalizeCap(99), 10);
  assert.equal(Battery.normalizeCap(2.5), 3);
  assert.equal(Battery.isActive('auto', true), true);
  assert.equal(Battery.isActive('auto', false), false);
  assert.equal(Battery.isActive('off', true), false);
  assert.equal(Battery.isActive(undefined, true), true);
  assert.equal(Battery.isActive('auto', undefined), false);
});

test('effective cap: lowered to the battery cap on battery, untouched otherwise', () => {
  assert.deepEqual(Battery.effectiveCap(30, { mode: 'auto', onBattery: true, cap: 3 }), { cap: 3, limited: true });
  assert.deepEqual(Battery.effectiveCap(30, { mode: 'auto', onBattery: false, cap: 3 }), { cap: 30, limited: false });
  assert.deepEqual(Battery.effectiveCap(30, { mode: 'off', onBattery: true, cap: 3 }), { cap: 30, limited: false });
  // A settings cap already below the battery cap stays; the battery is then not what limits.
  assert.deepEqual(Battery.effectiveCap(5, { mode: 'auto', onBattery: true, cap: 10 }), { cap: 5, limited: false });
  assert.deepEqual(Battery.effectiveCap(30, { mode: 'auto', onBattery: true, cap: 1 }), { cap: 1, limited: true });
});

test('the task note is added on battery once, and never when plugged in', () => {
  assert.equal(Battery.withTaskNote('做这件事', false), '做这件事');
  const noted = Battery.withTaskNote('做这件事\n', true);
  assert.equal(noted, '做这件事\n\n当前电池供电：不要跑全量 E2E，只跑相关单测，E2E 留到接电后');
  assert.equal(Battery.withTaskNote(noted, true), noted);
});

test('poll table: every battery period is longer than the normal one', () => {
  for (const [key, [normal, onBattery]] of Object.entries(Battery.POLL)) {
    assert.ok(onBattery > normal, key);
    assert.equal(Battery.pollMs(key, false), normal);
    assert.equal(Battery.pollMs(key, true), onBattery);
  }
  assert.throws(() => Battery.pollMs('nope', true), /Unknown poll/);
});

test('every() follows the power state on each round and stop() ends it', () => {
  const state = Battery.create();
  const delays = [];
  let pending = null;
  const timers = { setTimeout: (fn, ms) => { delays.push(ms); pending = fn; return {}; }, clearTimeout: () => { pending = null; } };
  let ran = 0;
  const handle = state.every('statusTick', () => { ran++; }, timers);
  assert.deepEqual(delays, [1500]);
  pending(); // fires, schedules the next at the same (plugged-in) period
  state.set({ onBattery: true });
  assert.deepEqual(delays, [1500, 1500]);
  pending(); // the next round reads the new state
  assert.deepEqual(delays, [1500, 1500, 3000]);
  state.set({ onBattery: false });
  pending();
  assert.deepEqual(delays.slice(-1), [1500]);
  assert.equal(ran, 3);
  handle.stop();
  assert.equal(pending, null);
});

test('state notifies only on a real change and survives a throwing listener', () => {
  const state = Battery.create();
  const seen = [];
  state.onChange(() => { throw new Error('bad listener'); });
  state.onChange((snap) => seen.push(snap.active));
  assert.equal(state.set({ onBattery: false }), false);
  assert.equal(state.set({ onBattery: true }), true);
  assert.equal(state.set({ onBattery: true }), false);
  assert.equal(state.set({ mode: 'off' }), true);
  assert.equal(state.set({ mode: 'auto', cap: 5 }), true);
  assert.deepEqual(seen, [true, false, true]);
});

test('status line and tooltip say what is limited', () => {
  const on = { mode: 'auto', onBattery: true, cap: 3 };
  assert.match(Battery.statusLine(on, 30, 2), /电池模式：开（电池供电），同时最多开 3 个会话（设置上限 30），现在 2 个在干活/);
  // Plugged in or 不限制: no line at all.
  assert.equal(Battery.statusLine({ ...on, onBattery: false }, 30, 2), '');
  assert.equal(Battery.statusLine({ ...on, mode: 'off' }, 30), '');
  const tip = Battery.describe(on, 30).join('\n');
  assert.match(tip, /同时最多开 3 个会话/);
  assert.match(tip, /不跑全量 E2E/);
  assert.match(tip, /动效.*光标闪烁/);
  assert.match(tip, /轮询放慢/);
  assert.match(Battery.describe({ ...on, onBattery: false }, 30)[0], /待命/);
});

test('the queue wording for a full battery cap', () => {
  assert.equal(M.queueNote(3, false, true), '电池供电，稍后自动开');
  assert.equal(M.queueTitle(3, false, true), '电池供电，稍后自动开');
  assert.equal(M.queueNote(3, true, true), '内存吃紧，稍后自动开');
  assert.equal(M.queueNote(7, false, false), '同时最多 7 个会话干活，前面有空位就自动开会话开始做。');
  assert.match(Battery.queueReason('改按钮', 3, 3), /已排队：电池供电，稍后自动开新会话「改按钮」.*最多 3 个.*现有 3 个.*接电/);
});

// ---- the Captain's queue under a battery cap (same stand-in runtime as queue-dispatch.test.js) ----
function runtime(t, { onBattery = true, mode = 'auto', cap = 3, base = 30, withBattery = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-battery-unit-'));
  const savedCap = M.MAX_ACTIVE;
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); M.MAX_ACTIVE = savedCap; });
  const captain = { id: 'captain', isMain: true, cmd: '' }, columns = [captain];
  const state = { colId: captain.id, tasks: [], pending: [], waitlist: [] };
  const store = new TaskStore(path.join(root, 'tasks'), { sessions: () => columns });
  const h = { sent: [] };
  const shared = Battery.create();
  shared.set({ onBattery, mode, cap });
  const config = { mainSession: state, folders: [], concurrencyCap: base };
  const window = {
    MainCore: M, BoardCore: B, BatteryCore: withBattery ? { ...Battery, shared } : undefined,
    QuotaCore: { commandQuota: () => ({ out: false }), quotaFallback: (_s, cmd) => ({ action: 'open', cmd }) },
    ChatUI: { addCard() {}, updateCard() {}, hasDraft: () => false, turnsOf: () => [] },
    deck: {
      onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
      memoryPressure: async () => ({ level: 1 }),
      saveLongPrompt: async () => '/tmp/battery-unit-long.txt',
      taskBoard: async (op, input) => store[op](input),
    },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  M.MAX_ACTIVE = Battery.effectiveCap(base, shared.snapshot()).cap;   // what renderer.js does at load
  window.MainSession.init({
    config, columns: () => columns, terms: new Map(),
    saveConfig() {}, flushConfig() {}, columnLabel: (c) => c.id, userComposing: () => false,
    quotaText: () => 'Claude 额度正常',
    createSession: (col) => { columns.push(col); return col; },
    sendWhenReady: (col, text) => h.sent.push({ col, text }),
  });
  return Object.assign(h, {
    window, columns, state, captain, store, shared, config,
    busy(n) {
      for (let i = 0; i < n; i++) {
        const id = 'working-' + columns.length;
        columns.push({ id, captainCrew: true });
        state.tasks.push({ colId: id, status: 'working' });
      }
    },
    add: () => store.add({ project: 'test', title: 'Queued task', detail: 'Do the task' }).card,
    assign: (card, task = 'Original body') => window.MainSession.handle({ action: 'main-new', id: 'req-' + Math.random().toString(36).slice(2), boardId: card.id, title: 'Battery test', command: 'available', task }, captain),
    queue: async () => JSON.parse((await window.MainSession.handle({ action: 'main-queue', op: 'list' }, captain)).result),
    text: (i = 0) => (typeof h.sent[i].text === 'function' ? h.sent[i].text() : h.sent[i].text),
  });
}

test('on battery the live cap is the battery cap, and new work queues with the battery reason', async (t) => {
  const h = runtime(t);
  assert.equal(M.MAX_ACTIVE, 3);
  h.busy(3);
  const card = h.add();
  const res = await h.assign(card);
  assert.equal(h.state.waitlist.length, 1);
  assert.match(res.result, /电池供电，稍后自动开/);
  assert.match((await h.queue())[0].reason, /电池供电，稍后自动开新会话/);
  assert.match(h.state.tasks.at(-1).waitReason, /电池供电/);
  assert.equal(h.sent.length, 0);
  // Sessions already working are left alone.
  assert.equal(h.state.tasks.filter((x) => x.status === 'working').length, 3);
});

test('work already running above the battery cap is not stopped, and only new work waits', async (t) => {
  const h = runtime(t, { onBattery: false });
  h.busy(5);
  h.shared.set({ onBattery: true });   // unplugged with 5 working, cap 3
  await tick();
  assert.equal(M.MAX_ACTIVE, 3);
  assert.equal(h.state.tasks.filter((x) => x.status === 'working').length, 5);
  assert.equal(h.columns.filter((c) => c.captainCrew).length, 5);
  const card = h.add();
  await h.assign(card);
  assert.equal(h.state.waitlist.length, 1);
  // Two finish (still 3 working): the cap is still full. A third finishing frees a slot.
  h.state.tasks[0].status = 'done'; h.state.tasks[1].status = 'done';
  await h.window.MainSession.syncEffectiveCap();
  assert.equal(h.state.waitlist.length, 1);
  h.state.tasks[2].status = 'done';
  await h.window.MainSession.syncEffectiveCap();
  assert.equal(h.state.waitlist.length, 0);
});

test('plugging in opens the waiting work without a re-dispatch', async (t) => {
  const h = runtime(t);
  h.busy(3);
  for (let i = 0; i < 2; i++) await h.assign(h.add());
  assert.equal(h.state.waitlist.length, 2);
  const before = h.columns.length;
  h.shared.set({ onBattery: false });
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 30);
  assert.equal(h.state.waitlist.length, 0);
  assert.equal(h.columns.length, before + 2);
  assert.doesNotMatch(h.state.tasks.map((x) => x.waitReason || '').join(' '), /电池供电/);
});

test('raising the battery cap in settings admits waiting work; setting 关闭 lifts it', async (t) => {
  const h = runtime(t);
  h.busy(3);
  for (let i = 0; i < 2; i++) await h.assign(h.add());
  h.shared.set({ cap: 4 });
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 4);
  assert.equal(h.state.waitlist.length, 1);
  h.shared.set({ mode: 'off' });
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 30);
  assert.equal(h.state.waitlist.length, 0);
});

test('mode 关闭 on battery changes nothing: cap, queueing and task text', async (t) => {
  const h = runtime(t, { mode: 'off' });
  assert.equal(M.MAX_ACTIVE, 30);
  h.busy(5);
  await h.assign(h.add());
  assert.equal(h.state.waitlist.length, 0);
  assert.equal(h.sent.length, 1);
  assert.doesNotMatch(h.text(), /电池供电/);
});

test('plugged in behaves exactly as before: full cap, no queue, no task note', async (t) => {
  const h = runtime(t, { onBattery: false });
  assert.equal(M.MAX_ACTIVE, 30);
  h.busy(5);
  const res = await h.assign(h.add(), '只做这件事');
  assert.equal(h.state.waitlist.length, 0);
  assert.doesNotMatch(res.result, /电池/);
  assert.equal(h.text(), '只做这件事');
});

test('on battery the text handed to a session ends with the E2E reminder; plugging in drops it', async (t) => {
  const h = runtime(t);
  await h.assign(h.add(), '改一下按钮');
  assert.equal(h.sent.length, 1);
  assert.equal(h.text(0), '改一下按钮\n\n当前电池供电：不要跑全量 E2E，只跑相关单测，E2E 留到接电后');
  h.shared.set({ onBattery: false });
  await h.assign(h.add(), '再改一个');
  assert.equal(h.text(1), '再改一个');
});

test('ledger and quota add one battery line only while battery mode is on', async (t) => {
  const h = runtime(t);
  h.busy(2);
  const ledger = (await h.window.MainSession.handle({ action: 'main-ledger' }, h.captain)).result;
  assert.match(ledger, /\n电池模式：开（电池供电），同时最多开 3 个会话（设置上限 30），现在 2 个在干活/);
  const quota = (await h.window.MainSession.handle({ action: 'main-quota' }, h.captain)).result;
  assert.match(quota, /^Claude 额度正常\n电池模式：开/);
});

// Plugged in or 不限制, ledger/quota must read exactly as they did before battery mode existed:
// compare with the same Captain state running without BatteryCore at all.
async function captainOutput(t, opts) {
  const h = runtime(t, { ...opts, cap: 2 });
  h.busy(4);                                     // above the battery cap, so a battery line would show up
  await h.assign(h.add());
  h.config.captainHistory = [];
  const ask = async (action) => (await h.window.MainSession.handle({ action }, h.captain)).result;
  return { ledger: await ask('main-ledger'), quota: await ask('main-quota') };
}
test('plugged in or 不限制: ledger and quota are word for word what they were before battery mode', async (t) => {
  const before = await captainOutput(t, { withBattery: false, onBattery: false });
  assert.equal(before.quota, 'Claude 额度正常');
  assert.doesNotMatch(before.ledger, /电池/);
  for (const opts of [{ onBattery: false }, { onBattery: false, mode: 'off' }, { onBattery: true, mode: 'off' }]) {
    const now = await captainOutput(t, opts);
    assert.equal(now.quota, before.quota, JSON.stringify(opts));
    const ids = (text) => text.replace(/c-board-[a-z0-9]+/g, 'CARD');   // fresh card ids each run
    assert.equal(ids(now.ledger), ids(before.ledger), JSON.stringify(opts));
  }
});

test('battery files ship with the app and the page loads the core before the Captain code', () => {
  const manifest = require('../package.json');
  assert.ok(manifest.build.files.includes('battery-core.js'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('battery-core.js') > 0 && html.indexOf('battery-core.js') < html.indexOf('main-core.js'));
  assert.match(html, /id="batteryMode"[\s\S]*value="auto"[\s\S]*value="off"/);
  assert.match(html, /id="batteryConcurrency"[^>]*min="1"[^>]*max="10"/);
  assert.match(html, /id="batteryIndicator"[^>]*aria-label=/);
});

test('every() with the default timers runs and stops (the page calls it unbound)', async () => {
  const state = Battery.create();
  let ran = 0;
  const handle = state.every('statusTick', () => { ran++; });
  assert.equal(typeof handle.stop, 'function');
  handle.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ran, 0);
});

test('the preload exposes the power source and a change callback', () => {
  const Module = require('node:module');
  const exposed = {}, listeners = {}, sent = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { on: (ch, fn) => { listeners[ch] = fn; }, send() {}, invoke: async () => undefined, removeListener() {},
      sendSync: (ch) => { sent.push(ch); return { onBattery: true }; } },
    webUtils: { getPathForFile: () => '' },
  };
  const load = Module._load;
  Module._load = (request, ...rest) => request === 'electron' ? electron : load(request, ...rest);
  try { delete require.cache[require.resolve('../preload')]; require('../preload'); } finally { Module._load = load; }
  assert.deepEqual(exposed.deck.powerState(), { onBattery: true });
  assert.deepEqual(sent, ['power-state']);
  const seen = [];
  exposed.deck.onPowerChanged((on) => seen.push(on));
  listeners['power:changed']({}, { onBattery: false });
  listeners['power:changed']({}, { onBattery: true });
  listeners['power:changed']({}, undefined);
  assert.deepEqual(seen, [false, true, false]);
});
