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
function runtime(t, { onBattery = true, mode = 'auto', cap = 3, base = 30, withBattery = true, extraConfig = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-battery-unit-'));
  const savedCap = M.MAX_ACTIVE;
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); M.MAX_ACTIVE = savedCap; });
  const captain = { id: 'captain', isMain: true, cmd: '' }, columns = [captain];
  const state = { colId: captain.id, tasks: [], pending: [], waitlist: [] };
  const store = new TaskStore(path.join(root, 'tasks'), { sessions: () => columns });
  const h = { sent: [] };
  const shared = Battery.create();
  shared.set({ onBattery, mode, cap });
  const config = { mainSession: state, folders: [], concurrencyCap: base, ...extraConfig };
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
    saveConfig() {}, flushConfig() { h.flushed = (h.flushed || 0) + 1; }, columnLabel: (c) => c.id, userComposing: () => false,
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

// ---- changing the setting from outside the settings box: the phone hub and the Captain's `settings battery` ----
test('a remote change is strict: only auto/off and a whole 1–10, nothing else, never quietly clamped', () => {
  assert.deepEqual(Battery.parseChange({ mode: 'off' }), { change: { mode: 'off' } });
  assert.deepEqual(Battery.parseChange({ cap: 7 }), { change: { cap: 7 } });
  assert.deepEqual(Battery.parseChange({ cap: '7', mode: 'auto' }), { change: { mode: 'auto', cap: 7 } });
  assert.deepEqual(Battery.parseChange({ mode: undefined, cap: 10 }), { change: { cap: 10 } });
  for (const bad of [{ cap: 0 }, { cap: 11 }, { cap: 99 }, { cap: -1 }, { cap: 2.5 }, { cap: 'abc' }, { cap: '' }, { cap: '1e1' }, { cap: null }, { cap: [3] },
    { mode: 'on' }, { mode: 'OFF' }, { mode: true }, { mode: null }, {}, null, undefined, 'off', [], { cap: 3, extra: 1 }, { concurrencyCap: 5 }]) {
    assert.ok(Battery.parseChange(bad).error, JSON.stringify(bad));
    assert.equal(Battery.parseChange(bad).change, undefined, JSON.stringify(bad));
  }
});

test('readout and the read-only text say what is set, the power, and what applies now', () => {
  const on = Battery.readout({ mode: 'auto', cap: 5, onBattery: true }, 30, 2);
  assert.deepEqual(on, { mode: 'auto', cap: 5, capMin: 1, capMax: 10, onBattery: true, active: true, boost: false, boostUntil: null, baseCap: 30, effectiveCap: 5, limited: true, working: 2 });
  const text = Battery.settingsText(on);
  assert.match(text, /电池模式：自动/);
  assert.match(text, /电池并发上限：5（可设 1–10）/);
  assert.match(text, /现在供电：电池/);
  assert.match(text, /现在生效：电池供电，同时最多开 5 个会话（设置上限 30）/);
  assert.match(text, /现在 2 个在干活/);
  const off = Battery.readout({ mode: 'off', cap: 5, onBattery: true }, 30);
  assert.equal(off.active, false);
  assert.equal(off.effectiveCap, 30);
  assert.equal('working' in off, false);
  assert.match(Battery.settingsText(off), /电池模式：关（不限制）[\s\S]*现在不生效[\s\S]*现在生效：不限制，同时最多开 30 个会话/);
  assert.equal(Battery.readout({ mode: 'auto', cap: 5, onBattery: false }, 30).active, false);
  // Junk in the saved config reads as the defaults.
  assert.deepEqual(Battery.readout({ mode: 'x', cap: 'y' }, undefined), { mode: 'auto', cap: 3, capMin: 1, capMax: 10, onBattery: false, active: false, boost: false, boostUntil: null, baseCap: 30, effectiveCap: 30, limited: false });
});

test('settings battery: no flags only reads; nothing is written, nothing re-dispatched', async (t) => {
  const h = runtime(t);
  h.busy(2);
  const captain = (message) => h.window.MainSession.handle({ action: 'main-settings', op: 'battery', input: {}, ...message }, h.captain);
  const res = await captain({});
  assert.equal(res.done, true);
  assert.doesNotMatch(res.result, /已生效/);
  assert.match(res.result, /电池模式：自动[\s\S]*电池并发上限：3[\s\S]*现在供电：电池[\s\S]*同时最多开 3 个会话[\s\S]*现在 2 个在干活/);
  assert.equal(h.flushed || 0, 0);
  assert.equal(h.config.batteryMode, undefined);
  assert.equal(h.config.batteryConcurrency, undefined);
});

test('settings battery --cap / --mode takes effect at once: live cap, config written, waiting work opens by the new rule', async (t) => {
  const h = runtime(t);
  h.busy(3);
  for (let i = 0; i < 3; i++) await h.assign(h.add());
  assert.equal(h.state.waitlist.length, 3);
  assert.equal(M.MAX_ACTIVE, 3);
  const set = (input) => h.window.MainSession.handle({ action: 'main-settings', op: 'battery', input }, h.captain);

  // cap 4: one more slot; exactly one waiting task is admitted, the other two keep waiting.
  const raised = await set({ cap: 4 });
  assert.match(raised.result, /^已生效并写入设置：\n[\s\S]*电池并发上限：4[\s\S]*同时最多开 4 个会话/);
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 4);
  assert.equal(h.state.waitlist.length, 2);
  assert.equal(h.config.batteryConcurrency, 4);
  assert.equal(h.config.batteryMode, undefined);   // only what was asked for is written
  assert.equal(h.flushed, 1);                       // written at once, not left for the 150 ms timer
  assert.deepEqual(h.shared.snapshot(), { onBattery: true, mode: 'auto', cap: 4, active: true, boost: false, boostUntil: 0 });

  // lowering never stops what is working; the same cap again changes nothing.
  await set({ cap: 2 });
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 2);
  assert.equal(h.columns.filter((c) => c.captainCrew).length, 4);   // 3 busy + the one admitted at cap 4
  assert.equal(h.state.waitlist.length, 2);
  await set({ cap: 2 });
  assert.equal(M.MAX_ACTIVE, 2);

  // mode off: unlimited, everything waiting opens, and the saved cap survives for later.
  const lifted = await set({ mode: 'off' });
  assert.match(lifted.result, /电池模式：关（不限制）[\s\S]*电池并发上限：2/);
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 30);
  assert.equal(h.state.waitlist.length, 0);
  assert.equal(h.config.batteryMode, 'off');
  assert.equal(h.config.batteryConcurrency, 2);

  // back to auto with a new cap in one go.
  await set({ mode: 'auto', cap: 1 });
  assert.equal(M.MAX_ACTIVE, 1);
  assert.deepEqual([h.config.batteryMode, h.config.batteryConcurrency], ['auto', 1]);
  // Queue rule at the new cap: new work waits while 4+ are working.
  await h.assign(h.add());
  assert.equal(h.state.waitlist.length, 1);
});

test('settings battery refuses bad input and leaves everything as it was', async (t) => {
  const h = runtime(t);
  h.busy(3);
  await h.assign(h.add());
  const before = JSON.stringify([h.shared.snapshot(), h.config, M.MAX_ACTIVE]);
  const set = (input, op = 'battery') => h.window.MainSession.handle({ action: 'main-settings', op, input }, h.captain);
  await assert.rejects(set({ cap: 99 }), /cap 要是 1–10/);
  await assert.rejects(set({ cap: 'x' }), /cap 要是 1–10/);
  await assert.rejects(set({ mode: 'maybe' }), /mode 只能是 auto/);
  await assert.rejects(set({ concurrencyCap: 5 }), /不认识的项/);
  await assert.rejects(set({}, 'sound'), /目前只有 battery/);
  assert.equal(JSON.stringify([h.shared.snapshot(), h.config, M.MAX_ACTIVE]), before);
  assert.equal(h.flushed || 0, 0);
  assert.equal(h.state.waitlist.length, 1);
});

test('without BatteryCore (an old page) there is no battery setting to read or change', async (t) => {
  const h = runtime(t, { withBattery: false });
  assert.equal(h.window.MainSession.batteryReadout(), null);
  assert.throws(() => h.window.MainSession.setBattery({ cap: 2 }), /没有电池模式/);
  await assert.rejects(h.window.MainSession.handle({ action: 'main-settings', op: 'battery', input: {} }, h.captain), /没有电池模式/);
});

test('the Captain briefing lists settings battery once, the board CLI help documents it, and the page serves the phone ops', () => {
  for (const platform of ['darwin', 'win32']) {
    const brief = M.instructions(platform);
    assert.equal(brief.split('settings battery').length - 1, 1, platform);
    assert.match(brief, /settings battery \[--boost on\|off \[--for 2h\|--until 23:59\]\] \[--mode off\|auto\] \[--cap 1-10\]/);
    assert.match(brief, /用户说「强度拉满」就 --boost on/);
    assert.ok((brief + M.SAVER_RESUME).length <= M.BRIEFING_LIMIT, platform);
  }
  const cli = fs.readFileSync(path.join(__dirname, '..', 'board-cli.js'), 'utf8');
  assert.match(cli, /settings battery \[--boost on\|off \[--for 90m\|2h \| --until 23:59\]\] \[--mode off\|auto\] \[--cap 1-10\]/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /op === 'battery'[\s\S]*MainSession\.batteryReadout\(\)/);
  assert.match(renderer, /op === 'battery-set'[\s\S]*MainSession\.setBattery\(input\)/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /'main-quota', 'main-settings'/);
  assert.match(main, /getBattery: \(\) => requestMobile\('battery'\)/);
  assert.match(main, /setBattery: \(input\) => requestMobile\('battery-set', input\)/);
});

// ---- 临时拉满: the Captain lifts the battery limit for a while; the battery mode itself stays on ----
test('boost lifts only the battery limit; plugging in, 不限制 and the end time end it', () => {
  const sh = Battery.create();
  sh.set({ onBattery: true, mode: 'auto', cap: 2 });
  assert.deepEqual(Battery.effectiveCap(30, sh.snapshot()), { cap: 2, limited: true });
  sh.set({ boost: true });
  assert.deepEqual(sh.snapshot(), { onBattery: true, mode: 'auto', cap: 2, active: true, boost: true, boostUntil: 0 });
  assert.deepEqual(Battery.effectiveCap(30, sh.snapshot()), { cap: 30, limited: false });
  // The settings cap still rules: boost opens the battery limit, not past what the settings allow.
  assert.deepEqual(Battery.effectiveCap(5, sh.snapshot()), { cap: 5, limited: false });
  // Plugging in ends it, and it does not come back by unplugging again.
  sh.set({ onBattery: false });
  assert.equal(sh.snapshot().boost, false);
  sh.set({ onBattery: true });
  assert.deepEqual(Battery.effectiveCap(30, sh.snapshot()), { cap: 2, limited: true });
  // 不限制 ends it too; a boost asked for while nothing limits is not kept.
  sh.set({ boost: true }); sh.set({ mode: 'off' });
  assert.equal(sh.snapshot().boost, false);
  sh.set({ boost: true });
  assert.equal(sh.snapshot().boost, false);
  // End time: still on before it, off after, and the listeners hear about it once.
  sh.set({ mode: 'auto' });
  const heard = [];
  sh.onChange((snap) => heard.push(snap.boost));
  sh.set({ boost: true, boostUntil: 5000 });
  assert.equal(sh.expireBoost(4999), false);
  assert.equal(sh.snapshot().boost, true);
  assert.equal(sh.expireBoost(5000), true);
  assert.equal(sh.expireBoost(9000), false);
  assert.deepEqual(heard, [true, false]);
  assert.equal(Battery.boostLive({ boost: true, boostUntil: 5000 }, 4999), true);
  assert.equal(Battery.boostLive({ boost: true, boostUntil: 5000 }, 5000), false);
  assert.equal(Battery.boostLive({ boost: true }, 1e15), true);
  assert.equal(Battery.boostLive({ boost: false }, 0), false);
});

test('boost in a remote change: on/off only, minutes only with on, 1–2880', () => {
  assert.deepEqual(Battery.parseChange({ boost: true }), { change: { boost: true } });
  assert.deepEqual(Battery.parseChange({ boost: true, boostMinutes: 120 }), { change: { boost: true, boostMinutes: 120 } });
  assert.deepEqual(Battery.parseChange({ boost: false }), { change: { boost: false } });
  for (const bad of [{ boost: 'on' }, { boost: 1 }, { boost: null }, { boostMinutes: 30 }, { boost: false, boostMinutes: 30 }, { boost: true, boostMinutes: 0 },
    { boost: true, boostMinutes: 2881 }, { boost: true, boostMinutes: 1.5 }, { boost: true, boostMinutes: '60' }]) {
    assert.ok(Battery.parseChange(bad).error, JSON.stringify(bad));
  }
  const until = Date.now() + 90 * 60000;
  const view = Battery.readout({ mode: 'auto', cap: 2, onBattery: true, boost: true, boostUntil: until }, 30, 1);
  assert.deepEqual([view.boost, view.boostUntil, view.effectiveCap, view.limited, view.active], [true, until, 30, false, true]);
  assert.match(Battery.settingsText(view), /临时拉满：开（到 \d\d:\d\d），不受电池上限限制；settings battery --boost off 取消/);
  assert.match(Battery.settingsText(view), /同时最多开 30 个会话（设置上限 30），已临时拉满/);
  assert.match(Battery.settingsText(Battery.readout({ mode: 'auto', cap: 2, onBattery: true }, 30)), /临时拉满：关（用户要拉满强度时 settings battery --boost on/);
  // A boost left in the saved state while plugged in or 不限制 is not reported.
  assert.equal(Battery.readout({ mode: 'auto', cap: 2, onBattery: false, boost: true }, 30).boost, false);
  assert.equal(Battery.readout({ mode: 'off', cap: 2, onBattery: true, boost: true }, 30).boost, false);
  assert.match(Battery.statusLine({ mode: 'auto', cap: 2, onBattery: true, boost: true, boostUntil: 0 }, 30, 4), /电池模式：已临时拉满（直到取消或接电源），同时最多开 30 个会话（设置上限 30），现在 4 个在干活；接电源、到时间或 settings battery --boost off 后恢复省电上限 2/);
  assert.match(Battery.describe({ mode: 'auto', cap: 2, onBattery: true, boost: true, boostUntil: until }, 30).join('\n'), /已临时拉满（到 \d\d:\d\d）[\s\S]*同时最多开 30 个会话/);
  assert.match(Battery.statusLine({ mode: 'auto', cap: 2, onBattery: true }, 30, 4), /^电池模式：开（电池供电），同时最多开 2 个会话/);
});

test('settings battery --boost on opens waiting work at once, off puts the battery limit back, nothing running is stopped', async (t) => {
  const h = runtime(t);
  h.busy(3);
  for (let i = 0; i < 3; i++) await h.assign(h.add());
  assert.deepEqual([M.MAX_ACTIVE, h.state.waitlist.length], [3, 3]);
  const set = (input) => h.window.MainSession.handle({ action: 'main-settings', op: 'battery', input }, h.captain);
  const before = Date.now();
  const on = await set({ boost: true, boostMinutes: 120 });
  assert.match(on.result, /^已生效并写入设置：\n[\s\S]*临时拉满：开（到 \d\d:\d\d）/);
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 30);
  assert.equal(h.state.waitlist.length, 0);                              // every waiting task opened
  assert.equal(h.columns.filter((c) => c.captainCrew).length, 6);
  const until = h.shared.snapshot().boostUntil;
  assert.ok(until >= before + 120 * 60000 && until <= Date.now() + 120 * 60000);
  // Written at once; the battery mode and its limit are exactly as they were.
  assert.deepEqual({ ...h.config.batteryBoost }, { until });
  assert.equal(h.config.batteryMode, undefined);
  assert.equal(h.config.batteryConcurrency, undefined);
  assert.equal(h.flushed, 1);
  assert.equal(h.window.MainSession.batteryReadout().boost, true);
  // The Captain's own lines say so.
  assert.match((await h.window.MainSession.handle({ action: 'main-ledger' }, h.captain)).result, /电池模式：已临时拉满（到 \d\d:\d\d），同时最多开 30 个会话/);
  assert.match((await h.window.MainSession.handle({ action: 'main-quota' }, h.captain)).result, /电池模式：已临时拉满/);
  // Off: the battery limit is back, running sessions stay, new work waits again.
  const off = await set({ boost: false });
  assert.match(off.result, /临时拉满：关/);
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 3);
  assert.equal(h.columns.filter((c) => c.captainCrew).length, 6);
  assert.equal(h.config.batteryBoost, undefined);
  await h.assign(h.add());
  assert.equal(h.state.waitlist.length, 1);
});

test('boost ends by itself: plugging in, the end time, and a restart that finds it already over', async (t) => {
  const h = runtime(t);
  h.busy(3);
  const set = (input) => h.window.MainSession.handle({ action: 'main-settings', op: 'battery', input }, h.captain);
  await set({ boost: true });
  assert.deepEqual({ ...h.config.batteryBoost }, { until: 0 });
  await h.assign(h.add());
  assert.equal(h.state.waitlist.length, 0);
  h.shared.set({ onBattery: false });                                     // plug in
  await tick(); await tick();
  assert.equal(h.config.batteryBoost, undefined);
  h.shared.set({ onBattery: true });                                      // unplug: the boost does not come back
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 3);
  // End time reached: the next read drops it and the limit is back.
  await set({ boost: true, boostMinutes: 1 });
  assert.equal(M.MAX_ACTIVE, 30);
  h.shared.set({ boostUntil: Date.now() - 1000 });                       // the end time passes
  assert.equal(h.window.MainSession.batteryReadout().boost, false);
  await tick(); await tick();
  assert.equal(M.MAX_ACTIVE, 3);
  assert.equal(h.config.batteryBoost, undefined);
});

test('a boost kept in the config comes back after a restart while on battery, and is dropped when plugged in or past its time', async (t) => {
  const live = runtime(t, { extraConfig: { batteryBoost: { until: Date.now() + 3600000 } } });
  assert.equal(live.shared.snapshot().boost, true);
  assert.equal(M.MAX_ACTIVE, 30);
  const forever = runtime(t, { extraConfig: { batteryBoost: { until: 0 } } });
  assert.equal(forever.shared.snapshot().boost, true);
  const over = runtime(t, { extraConfig: { batteryBoost: { until: Date.now() - 1000 } } });
  assert.equal(over.shared.snapshot().boost, false);
  assert.equal(M.MAX_ACTIVE, 3);
  assert.equal(over.config.batteryBoost, undefined);
  const plugged = runtime(t, { onBattery: false, extraConfig: { batteryBoost: { until: 0 } } });
  assert.equal(plugged.shared.snapshot().boost, false);
  assert.equal(plugged.config.batteryBoost, undefined);
  const junk = runtime(t, { extraConfig: { batteryBoost: { until: 'soon' } } });
  assert.equal(junk.shared.snapshot().boost, false);
});

test('boost is refused when nothing is limiting, and a bad boost changes nothing', async (t) => {
  const set = (h, input) => h.window.MainSession.handle({ action: 'main-settings', op: 'battery', input }, h.captain);
  const plugged = runtime(t, { onBattery: false });
  await assert.rejects(set(plugged, { boost: true }), /现在不需要拉满：现在接着电源/);
  const off = runtime(t, { mode: 'off' });
  await assert.rejects(set(off, { boost: true }), /现在不需要拉满：电池模式已关/);
  // Turning the mode back on in the same command is fine.
  await set(off, { mode: 'auto', boost: true });
  assert.equal(off.shared.snapshot().boost, true);
  const h = runtime(t);
  const snapshot = JSON.stringify([h.shared.snapshot(), h.config, M.MAX_ACTIVE]);
  for (const bad of [{ boost: 'on' }, { boostMinutes: 30 }, { boost: true, boostMinutes: 99999 }]) await assert.rejects(set(h, bad), /boost|时长|到期/);
  assert.equal(JSON.stringify([h.shared.snapshot(), h.config, M.MAX_ACTIVE]), snapshot);
  assert.equal(h.flushed || 0, 0);
});
