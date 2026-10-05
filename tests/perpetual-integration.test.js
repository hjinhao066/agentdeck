'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const B = require('../board-core');
const S = require('../claude-seats-core');

function session({ tasks = [], pending = [], cmd = '', relayStartup } = {}) {
  const col = { id: 'captain', isMain: true, cmd };
  const config = { mainSession: { colId: col.id, tasks, pending, ...(relayStartup ? { relayStartup } : {}) } };
  const sends = [], saves = [];
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - 5000, lastScreen: '' };
  const elements = new Map();
  const window = { deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {} }, MainCore: require('../main-core'), BoardCore: B,
    ChatUI: { hasDraft: () => false, turnsOf: () => [] } };
  const context = vm.createContext({ window, document: {
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id); },
    querySelectorAll: () => [],
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({ config, platform: 'darwin',
    columns: () => [col], terms: new Map([[col.id, entry]]), userComposing: () => false,
    sendWhenReady: (column, text, options) => sends.push({ colId: column.id, text, options }),
    saveConfig: () => saves.push(JSON.parse(JSON.stringify(config))) });
  return { api: window.MainSession, entry, sends, saves };
}
const task = (id, title, status, failed) => ({ id, colId: 'worker-' + id, title, status, receipt: failed ? { failed } : undefined });

test('normal handoff uses high; a pending failure uses xhigh', () => {
  assert.equal(session().api.relayEffort(), 'high');
  const failed = session({ pending: [{ taskId: 'retry', failed: 'Build failed' }] });
  assert.equal(failed.api.relayEffort(), 'xhigh');
  assert.match(S.relayCodexCommand('codex --model old --effort low', failed.api.relayEffort()), /model_reasoning_effort=xhigh/);
});

test('retrying the same task title uses xhigh without promoting an unrelated or completed failure', () => {
  const previous = task('old', 'Fix build', 'failed', 'Compilation failed');
  assert.equal(session({ tasks: [previous, task('retry', 'Fix build', 'working')] }).api.relayEffort(), 'xhigh');
  assert.equal(session({ tasks: [previous, task('other', 'Review docs', 'working')] }).api.relayEffort(), 'high');
  assert.equal(session({ tasks: [previous] }).api.relayEffort(), 'high');
});

test('relay waits for a live idle Captain and a quiet screen', () => {
  const { api, entry } = session();
  assert.equal(api.relayIdle(), true);
  entry.alive = false; assert.equal(api.relayIdle(), false);
  entry.alive = true; entry.state = 'working'; assert.equal(api.relayIdle(), false);
  entry.state = 'done'; entry.lastOutputAt = Date.now(); assert.equal(api.relayIdle(), false);
});

test('MainSession restart clears old PTY startup evidence and records a newly delivered brief without extending the deadline', () => {
  const R = require('../relay-startup-core'), at = Date.now() - 60_000;
  const saved = R.begin({ failures: ['us', 'us2'] }, { colId: 'captain', targetId: 'cn', at });
  Object.assign(saved.attempt, { promptSent: true, promptSentAt: at + 1000, output: true });
  const h = session({ cmd: S.CLAUDE_COMMAND, relayStartup: JSON.parse(JSON.stringify(saved)) });
  let startup = h.api.state().relayStartup;
  assert.equal(startup.attempt.deadline, saved.attempt.deadline);
  assert.equal(startup.attempt.at, at);
  assert.deepEqual(startup.failures, ['us', 'us2']);
  assert.equal(startup.attempt.promptSent, false);
  assert.equal(startup.attempt.output, false);
  assert.equal(startup.attempt.promptSentAt, undefined);
  assert.equal(h.saves.length, 1);
  assert.deepEqual(h.saves[0].mainSession.relayStartup, startup);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].colId, 'captain');
  assert.ok(h.sends[0].text.includes('队长'));
  assert.equal(h.sends[0].options.silent, true);
  assert.equal(h.sends[0].options.guardUserInput, true);
  const beforeSend = Date.now();
  h.sends[0].options.onSent();
  startup = h.api.state().relayStartup;
  assert.equal(startup.attempt.promptSent, true);
  assert.ok(startup.attempt.promptSentAt >= beforeSend);
  assert.ok(startup.attempt.promptSentAt <= Date.now());
  assert.equal(startup.attempt.output, false);
  assert.equal(startup.attempt.deadline, saved.attempt.deadline);
  assert.deepEqual(startup.failures, ['us', 'us2']);
  assert.equal(h.saves.length, 2);
  assert.deepEqual(h.saves[1].mainSession.relayStartup, startup);
});

function seatRelay(options = {}) {
  const P = require('../perpetual-captain-core'), Q = require('../quota-core'), R = require('../relay-startup-core');
  const clock = { now: options.saved?.now || Date.now() };
  let col = options.saved?.col || { id: 'captain', isMain: true, cmd: S.CLAUDE_COMMAND, claudeSeatId: options.currentId || 'cn' };
  const state = options.saved?.state || { colId: col.id, tasks: [] }, handoffs = [], notifications = [], refreshes = [], toasts = [];
  const seats = ['cn', 'us', 'us2'].map((id) => ({ id, name: id.toUpperCase(), loggedIn: true,
    onboardingComplete: true, configDir: '/test/' + id, accountKey: id + '-account', credentialKey: id + '-credential' }));
  const config = options.saved?.config || { claudeSeats: seats, quotas: {}, perpetualCaptain: P.normalizeSettings(),
    perpetualCaptainState: {}, captainRelayCodex: { name: 'ChatGPT', command: 'codex' } };
  const controls = { draft: false, idle: true, checkpoint: true };
  const terms = new Map([[col.id, options.saved?.entry || { alive: true, state: 'done', lastScreen: '', lastOutputAt: clock.now - 5000 }]]);
  function sample(id, remaining = 80, weeklyRemaining = 60, extra = {}) {
    const seat = seats.find((s) => s.id === id);
    return { provider: 'Claude', scope: 'claude', seatId: id, official: true, at: clock.now,
      accountKey: seat.accountKey, credentialKey: seat.credentialKey, configDir: seat.configDir,
      windows: [{ key: 'fiveHour', remaining, resetAt: clock.now + 3600_000 },
        { key: 'weekly', remaining: weeklyRemaining, resetAt: clock.now + 7 * 86400_000 }], ...extra };
  }
  if (!options.saved) for (const seat of seats) {
    const quota = options.quotas?.[seat.id];
    if (quota === null) continue;
    if (Array.isArray(quota)) Q.observe(config.quotas, sample(seat.id, ...quota), clock.now);
    else config.quotas[Q.seatKey(seat.id)] = { provider: 'Claude', scope: 'claude',
      configDir: seat.configDir, accountKey: seat.accountKey, blocked: { at: clock.now, resetAt: clock.now + 3600000,
        configDir: seat.configDir, accountKey: seat.accountKey, sourceColumnId: seat.id + '-terminal' } };
  }
  const window = { ClaudeSeatsCore: S, PerpetualCaptainCore: P, RelayStartupCore: R, MainCore: require('../main-core'),
    QuotaCore: { ...Q, observe: (store, next) => Q.observe(store, next, clock.now),
      commandQuota: (store, command, configured) => Q.commandQuota(store, command, configured, undefined, clock.now) },
    AgentInfo: { resolveAgentInfo: (column) => ({ provider: /codex/.test(column.cmd) ? 'Codex' : 'Claude' }) },
    deck: { claudeSeats: async () => { await controls.beforeSeatRefresh?.(); return seats; },
      claudeWarmupStatus: async () => [], claudeSeatUsage: async () => null,
      quotaRefresh: async (id) => { refreshes.push(id); return options.quotaRefresh ? options.quotaRefresh(id, sample) : []; },
      captainRelayNotify: async (id, message, urgent) => { notifications.push({ id, message, urgent }); return { ok: true }; } },
    MainSession: { mainCol: () => col, state: () => state, relayIdle: () => controls.idle,
      pauseForSeatSwitch() {}, relayEffort: () => 'high',
      checkpointForSeatSwitch: async () => controls.checkpoint ? '/test/handoff.md' : null,
      clearContext(options) {
        handoffs.push(options);
        col = { ...col, id: 'replacement-' + handoffs.length, cmd: options.command, claudeSeatId: options.seatId };
        state.colId = col.id; state.relayTargetId = options.relayTargetId;
        state.relayStartup = options.automatic ? R.begin(state.relayStartup,
          { colId: col.id, targetId: options.relayTargetId, at: clock.now }) : R.normalize();
        terms.set(col.id, { alive: true, state: 'done', lastScreen: '', lastOutputAt: clock.now });
        return col;
      } },
    ChatUI: { snapshotForHandoff: () => ({}), addNotice() {} }, dispatchEvent() {} };
  class ClockDate extends Date { static now() { return clock.now; } }
  const context = vm.createContext({ window, Date: ClockDate,
    document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] },
    setInterval() {}, CustomEvent: class {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../claude-seats-ui.js'), 'utf8'), context);
  window.ClaudeSeats.init({ config, columns: () => [col], terms,
    userComposing: () => controls.draft, flushConfig() {}, showToast: (message) => toasts.push(message) });
  return { api: window.ClaudeSeats, state, config, handoffs, notifications, refreshes, toasts, controls, clock, sample,
    entry: () => terms.get(col.id),
    snapshot: () => JSON.parse(JSON.stringify({ now: clock.now, col, state, config, entry: terms.get(col.id) })) };
}

test('automatic exhausted-seat Relay reaches Codex through the UI validation and handoff', async () => {
  const { api, state, config, handoffs } = seatRelay();
  assert.equal(await api.switchSeat('chatgpt', { automatic: true }), true);
  assert.equal(state.relayTargetId, 'chatgpt');
  assert.equal(config.perpetualCaptainState.lastSwitch.reason, 'claude-unavailable');
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].command, S.codexCommand('high'));
});

test('the quota banner action cannot bypass its Claude-only target validation', async () => {
  const { api, state, handoffs } = seatRelay();
  assert.equal(await api.switchSeat('chatgpt', { validateRotation: true }), false);
  assert.equal(state.colId, 'captain');
  assert.equal(handoffs.length, 0);
});

test('automatic rotation refreshes unknown quota and chooses only a confirmed available seat', async () => {
  const h = seatRelay({ currentId: 'us2', quotas: { us2: [0, 60], us: null, cn: [80, 60] } });
  await h.api.refresh();
  await h.api.automaticTick();
  assert.deepEqual(h.refreshes, ['us']);
  assert.equal(h.handoffs.length, 1);
  assert.equal(h.handoffs[0].relayTargetId, 'cn');
});

test('a refresh can confirm the next unknown seat before automatic selection', async () => {
  const h = seatRelay({ currentId: 'us2', quotas: { us2: [0, 60], us: null, cn: [80, 60] },
    quotaRefresh: async (id, sample) => [sample(id)] });
  await h.api.refresh();
  await h.api.automaticTick();
  assert.deepEqual(h.refreshes, ['us']);
  assert.equal(h.handoffs[0].relayTargetId, 'us');
});

test('stale or elapsed-reset quota is refreshed and remains ineligible when refresh fails', async () => {
  for (const stale of [true, false]) {
    const h = seatRelay({ currentId: 'us2', quotas: { us2: [0, 60], us: [80, 60], cn: [80, 60] },
      quotaRefresh: async () => { throw new Error('offline'); } });
    const sample = h.config.quotas['Claude:us'].sample;
    if (stale) sample.at = h.clock.now - require('../perpetual-captain-core').FRESH_MS - 1;
    else sample.windows[0].resetAt = h.clock.now;
    await h.api.refresh();
    await h.api.automaticTick();
    assert.deepEqual(h.refreshes, ['us']);
    assert.equal(h.handoffs[0].relayTargetId, 'cn');
  }
});

test('three-minute startup watchdog retries the next available seat without needing an idle live PTY', async () => {
  const R = require('../relay-startup-core');
  for (const promptSent of [false, true]) {
    const h = seatRelay({ quotas: { cn: [80, 60], us2: [80, 60], us: [80, 0] } });
    h.state.relayStartup = R.begin({}, { colId: h.state.colId, targetId: 'cn', at: h.clock.now });
    h.state.relayStartup.attempt.promptSent = promptSent;
    h.controls.idle = false;
    await h.api.refresh();
    h.clock.now += R.STARTUP_MS - 1;
    await h.api.automaticTick();
    assert.equal(h.handoffs.length, 0);
    h.clock.now++;
    await h.api.automaticTick();
    assert.equal(h.handoffs.length, 1);
    assert.equal(h.handoffs[0].relayTargetId, 'us2');
    assert.deepEqual(h.state.relayStartup.failures, ['cn']);
    assert.equal(h.state.relayStartup.attempt.deadline, h.clock.now + R.STARTUP_MS);
  }
});

test('quota during startup overrides brief working output and retries immediately', async () => {
  const R = require('../relay-startup-core');
  const h = seatRelay({ quotas: { cn: [80, 60], us2: [80, 60] } });
  h.state.relayStartup = R.begin({}, { colId: h.state.colId, targetId: 'cn', at: h.clock.now });
  Object.assign(h.state.relayStartup.attempt, { promptSent: true, output: true });
  h.entry().lastScreen = "You've hit your limit · resets 5pm\nEsc to interrupt\nClaude Code";
  h.clock.now++;
  await h.api.refresh();
  await h.api.automaticTick();
  assert.equal(h.handoffs[0].relayTargetId, 'us2');
  assert.deepEqual(h.state.relayStartup.failures, ['cn']);
});

test('three consecutive failed startup attempts stop and send exactly one urgent notification', async () => {
  const R = require('../relay-startup-core');
  const h = seatRelay({ quotas: { cn: [80, 60], us2: [80, 60], us: [80, 60] } });
  h.state.relayStartup = R.begin({}, { colId: h.state.colId, targetId: 'cn', at: h.clock.now });
  await h.api.refresh();
  for (let attempt = 0; attempt < 3; attempt++) {
    h.clock.now += R.STARTUP_MS;
    await h.api.automaticTick();
  }
  assert.deepEqual(h.handoffs.map((h) => h.relayTargetId), ['us2', 'us']);
  assert.deepEqual(h.state.relayStartup.failures, ['cn', 'us2', 'us']);
  assert.equal(h.state.relayStartup.stopped, true);
  assert.equal(h.notifications.filter((n) => n.urgent).length, 1);
  assert.match(h.notifications.find((n) => n.urgent).message, /连续 3 次/);
  for (let tick = 0; tick < 4; tick++) await h.api.automaticTick();
  assert.equal(h.notifications.filter((n) => n.urgent).length, 1);
  const restarted = seatRelay({ saved: h.snapshot() });
  await restarted.api.refresh();
  await restarted.api.automaticTick();
  assert.equal(restarted.notifications.length, 0);
  assert.equal(restarted.handoffs.length, 0);
});

test('all Claude seats exhausted and Codex exhausted stops with one urgent notification', async () => {
  const h = seatRelay();
  h.config.quotas.Codex = { scope: 'codex', blocked: { at: h.clock.now, resetAt: h.clock.now + 3600_000 } };
  await h.api.refresh();
  await h.api.automaticTick();
  assert.equal(h.handoffs.length, 0);
  assert.equal(h.state.relayStartup.stopped, true);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].urgent, true);
  assert.match(h.notifications[0].message, /Codex 额度也已用尽/);
  await h.api.automaticTick();
  assert.equal(h.notifications.length, 1);
});

test('an unsent draft survives both ordinary rotation and a failed-startup retry', async () => {
  const R = require('../relay-startup-core');
  for (const retry of [false, true]) {
    const h = seatRelay({ quotas: { us2: [80, 60] } });
    const draft = { value: '保留这段未发送的队长任务' };
    h.entry().wrap = { querySelector: (selector) => selector === '.composer textarea' ? draft : null };
    if (retry) {
      h.state.relayStartup = R.begin({}, { colId: h.state.colId, targetId: 'cn', at: h.clock.now });
      h.clock.now += R.STARTUP_MS;
    }
    await h.api.refresh();
    await h.api.automaticTick();
    assert.equal(h.state.colId, 'captain');
    assert.equal(h.handoffs.length, 0);
    assert.equal(draft.value, '保留这段未发送的队长任务');
    assert.equal(h.notifications.filter((n) => n.urgent).length, retry ? 1 : 0);
    if (retry) assert.match(h.state.relayStartup.reason, /未发送内容/);
  }
});

test('restart retains startup deadline and failures and retries immediately once overdue', async () => {
  const R = require('../relay-startup-core');
  const h = seatRelay({ quotas: { cn: [80, 60], us2: [80, 60], us: [80, 60] } });
  h.state.relayStartup = R.begin({ failures: ['us'] }, { colId: h.state.colId, targetId: 'cn', at: h.clock.now });
  h.state.relayStartup.attempt.promptSent = true;
  const deadline = h.state.relayStartup.attempt.deadline;
  h.clock.now = deadline + 1;
  const restarted = seatRelay({ saved: h.snapshot() });
  await restarted.api.refresh();
  assert.equal(restarted.state.relayStartup.attempt.deadline, deadline);
  await restarted.api.automaticTick();
  assert.equal(restarted.handoffs[0].relayTargetId, 'us2');
  assert.deepEqual(restarted.state.relayStartup.failures, ['us', 'cn']);
});

test('working activity after prompt delivery survives restart and clears the failure sequence at the deadline', async () => {
  const R = require('../relay-startup-core');
  const h = seatRelay({ quotas: { cn: [80, 60], us2: [80, 60], us: [80, 60] } });
  h.state.relayStartup = R.begin({ failures: ['us'] }, { colId: h.state.colId, targetId: 'cn', at: h.clock.now });
  h.state.relayStartup.attempt.promptSent = true;
  h.clock.now++;
  Object.assign(h.entry(), { lastScreen: '✻ Doing…\nClaude Code', lastOutputAt: h.clock.now });
  await h.api.refresh();
  await h.api.automaticTick();
  assert.equal(h.state.relayStartup.attempt.output, true);
  assert.deepEqual(h.state.relayStartup.failures, ['us']);
  const restarted = seatRelay({ saved: h.snapshot() });
  restarted.clock.now = h.state.relayStartup.attempt.deadline;
  await restarted.api.refresh();
  await restarted.api.automaticTick();
  assert.deepEqual(restarted.state.relayStartup, R.normalize());
  assert.equal(restarted.handoffs.length, 0);
  assert.equal(restarted.notifications.length, 0);
});

test('long initial Thinking activity counts only after prompt delivery and survives the startup deadline', async () => {
  const R = require('../relay-startup-core');
  const h = seatRelay({ quotas: { cn: [80, 60], us2: [80, 60], us: [80, 60] } });
  h.state.relayStartup = R.begin({ failures: ['us'] }, { colId: h.state.colId, targetId: 'cn', at: h.clock.now });
  const promptSentAt = h.clock.now + 1000;
  Object.assign(h.state.relayStartup.attempt, { promptSent: true, promptSentAt });
  const entry = h.entry();
  Object.assign(entry, { state: 'working', lastScreen: 'Thinking… (2m 30s)', lastOutputAt: promptSentAt - 1 });
  assert.notEqual(require('../main-core').terminalActivity(entry.lastScreen, S.CLAUDE_COMMAND), 'working');
  h.clock.now = promptSentAt + 1;
  await h.api.refresh();
  await h.api.automaticTick();
  assert.equal(h.state.relayStartup.attempt.output, false);
  assert.equal(h.state.relayStartup.attempt.promptSentAt, promptSentAt);
  entry.lastOutputAt = h.clock.now;
  for (const pending of ['sendingPrompt', 'injecting']) {
    entry[pending] = true;
    await h.api.automaticTick();
    assert.equal(h.state.relayStartup.attempt.output, false);
    entry[pending] = false;
  }
  await h.api.automaticTick();
  assert.equal(h.state.relayStartup.attempt.output, true);
  h.clock.now = h.state.relayStartup.attempt.deadline;
  h.controls.idle = false;
  await h.api.automaticTick();
  assert.deepEqual(h.state.relayStartup, R.normalize());
  assert.equal(h.handoffs.length, 0);
  assert.equal(h.notifications.length, 0);
});

test('a short silent captain brief reply proves startup without onTurnDone, while prompt and chrome do not', async () => {
  const R = require('../relay-startup-core');
  for (const marker of ['⏺', '●', '•']) {
    const h = seatRelay({ quotas: { cn: [80, 60], us2: [80, 60], us: [80, 60] } });
    h.state.relayStartup = R.begin({ failures: ['us'] }, { colId: h.state.colId, targetId: 'cn', at: h.clock.now });
    const promptSentAt = h.clock.now + 1000, entry = h.entry();
    h.clock.now = promptSentAt + 1;
    Object.assign(entry, { state: 'done', lastScreen: marker + ' 队长已就绪。', lastOutputAt: h.clock.now });
    await h.api.refresh();
    await h.api.automaticTick();
    assert.equal(h.state.relayStartup.attempt.output, false, 'reply without a delivered prompt');
    Object.assign(h.state.relayStartup.attempt, { promptSent: true, promptSentAt });
    entry.lastScreen = 'Claude Code\n❯ 你是队长，请读看板接续\n? for shortcuts';
    await h.api.automaticTick();
    assert.equal(h.state.relayStartup.attempt.output, false, 'prompt echo and chrome only');
    entry.lastScreen = marker + ' 队长已就绪。';
    entry.lastOutputAt = promptSentAt;
    await h.api.automaticTick();
    assert.equal(h.state.relayStartup.attempt.output, false, 'reply predates prompt delivery');
    entry.lastOutputAt = h.clock.now;
    for (const pending of ['sendingPrompt', 'injecting']) {
      entry[pending] = true;
      await h.api.automaticTick();
      assert.equal(h.state.relayStartup.attempt.output, false, pending);
      entry[pending] = false;
    }
    await h.api.automaticTick();
    assert.equal(h.state.relayStartup.attempt.output, true);
    h.clock.now = h.state.relayStartup.attempt.deadline;
    await h.api.automaticTick();
    assert.deepEqual(h.state.relayStartup, R.normalize());
    assert.equal(h.handoffs.length, 0);
    assert.equal(h.notifications.length, 0);
  }
});

test('a new user task or draft during seat refresh cancels switching without counting a startup failure', async () => {
  for (const change of ['busy', 'draft']) {
    const h = seatRelay({ quotas: { cn: [0, 60], us2: [80, 60], us: [80, 60] } });
    await h.api.refresh();
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const refreshing = new Promise((resolve) => { entered = resolve; });
    h.controls.beforeSeatRefresh = async () => { entered(); await gate; };
    const tick = h.api.automaticTick();
    await refreshing;
    if (change === 'busy') h.controls.idle = false;
    else h.controls.draft = true;
    release();
    await tick;
    assert.equal(h.state.relayStartup, undefined);
    assert.equal(h.state.colId, 'captain');
    assert.equal(h.handoffs.length, 0);
    assert.equal(h.notifications.length, 0);
  }
});

test('a real checkpoint failure counts once and retries a different available seat', async () => {
  const h = seatRelay({ quotas: { cn: [0, 60], us2: [80, 60], us: [80, 60] } });
  h.controls.checkpoint = false;
  await h.api.refresh();
  await h.api.automaticTick();
  assert.deepEqual(h.state.relayStartup.failures, ['us2']);
  assert.equal(h.state.relayStartup.stopped, false);
  assert.equal(h.handoffs.length, 0);
  await h.api.automaticTick();
  assert.deepEqual(h.state.relayStartup.failures, ['us2']);
  h.controls.checkpoint = true;
  h.clock.now += 1500;
  await h.api.automaticTick();
  assert.equal(h.handoffs[0].relayTargetId, 'us');
  assert.deepEqual(h.state.relayStartup.failures, ['us2']);
  assert.equal(h.notifications.filter((n) => n.urgent).length, 0);
});

test('samples older than a later recovery observation are refreshed before a seat reenters rotation', async () => {
  const h = seatRelay({ currentId: 'us2', quotas: { us2: [0, 60], us: [80, 60], cn: [80, 60] },
    quotaRefresh: async (id, sample) => [sample(id)] });
  h.config.perpetualCaptainState = { seats: { us: { accountKey: 'us-account', configDir: '/test/us',
    recoveredAt: h.clock.now + 1, clearedAt: h.clock.now + 1 } } };
  h.clock.now += 2;
  await h.api.refresh();
  await h.api.automaticTick();
  assert.deepEqual(h.refreshes, ['us']);
  assert.equal(h.handoffs[0].relayTargetId, 'us');
  assert.equal(h.config.quotas['Claude:us'].sample.at, h.clock.now);
});

test('quoted and absolute Codex Relay commands keep their binary and use fixed Sol/high or xhigh', () => {
  for (const effort of ['high', 'xhigh']) {
    for (const program of ['codex', 'command codex', '"codex"', 'command "codex"',
      '/opt/bin/codex', '"C:\\Program Files\\codex.exe"']) {
      const launch = S.relayCodexCommand(program + ' --model gpt-6-luna --no-daemon -c model_reasoning_effort=low', effort);
      assert.ok(launch.startsWith(program + ' '), launch);
      assert.match(launch, /--model gpt-6\.1-sol/);
      assert.equal(launch.match(/--no-daemon/g).length, 1);
      assert.ok(launch.includes('model_reasoning_effort=' + effort));
      assert.ok(!launch.includes('gpt-6-luna'));
    }
  }
  const custom = 'node "fake-agent.js" --provider=codex';
  assert.equal(S.relayCodexCommand(custom, 'xhigh'), custom);
});

test('Codex Relay bypasses a real shell function for bare, quoted and absolute binaries', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-relay-codex-'));
  try {
    const binary = path.join(dir, 'codex');
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH };
    const wrapper = 'codex() { command codex --yolo "$@"; }\n';
    for (const program of ['codex', 'command codex', '"codex"', "'codex'", 'command "codex"', '"' + binary + '"']) {
      for (const effort of ['high', 'xhigh']) {
        const command = B.shellLaunchCommand(S.relayCodexCommand(program + ' --model old', effort), process.platform);
        const args = execFileSync('/bin/sh', ['-c', wrapper + command], { env, encoding: 'utf8' }).trim().split('\n');
        assert.deepEqual(args, ['--model', 'gpt-6.1-sol', '--no-daemon', '-c', 'model_reasoning_effort=' + effort,
          '--dangerously-bypass-approvals-and-sandbox'], command);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('official refresh and its disk cache carry ownership usable by Relay and warmup', async (t) => {
  const C = require('../quota-claude'), M = require('../claude-seats-main');
  const Q = require('../quota-core'), P = require('../perpetual-captain-core');
  const { readLocal } = require('../quota-local');
  const { createWarmupService } = require('../quota-warmup-service');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-official-relay-')), now = Date.now(), seats = S.normalize();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const seat of seats) {
    const loc = M.credentialLocation(seat, home);
    fs.mkdirSync(loc.dir, { recursive: true });
    fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { emailAddress: seat.id + '@example.test', accountUuid: 'offline-' + seat.id } }));
    fs.writeFileSync(loc.credentialsPath, '{}');
  }
  const refresh = C.createRefresh({ home, getSeats: () => seats, now: () => now,
    read: async (seat) => {
      const loc = M.credentialLocation(seat, home);
      return { accountKey: M.usageAccountKey(loc), configDir: loc.dir, windows: [
        { key: 'fiveHour', remaining: 80, resetText: new Date(now + 5 * 3600_000).toISOString() },
        { key: 'weekly', remaining: 60, resetText: new Date(now + 7 * 86400_000).toISOString() },
      ] };
    } });
  t.after(() => refresh.dispose());
  await refresh.tick();
  const store = {};
  for (const sample of refresh.samples()) assert.equal(Q.observe(store, sample, now), true);
  const cached = await readLocal(home, path.join(home, '.codex'), now, seats);
  for (const seat of seats) {
    const info = await M.seatInfo(seat, home, 'test');
    const sample = store[Q.seatKey(seat.id)].sample;
    assert.equal(sample.credentialKey, info.credentialKey);
    const relay = P.seatQuota({ sample }, { ...info, configuredDir: seat.configDir }, now);
    assert.equal(relay.trusted, true); assert.equal(relay.weeklyTrusted, true);
    assert.equal(relay.remaining, 80);
    assert.equal(P.bound(cached.find((q) => q.seatId === seat.id && q.official), { ...info, configuredDir: seat.configDir }), true);
    const service = createWarmupService({ stateFile: path.join(home, seat.id + '-warmup.json'), logFile: path.join(home, seat.id + '-warmup.log'),
      getSettings: () => ({ enabled: true }), getSeats: () => [seat], now: () => now,
      readSeat: async () => ({ ...info, quota: { sample }, usage: M.readUsage(seat, home) }),
      occupied: async () => new Set(), run: async () => { throw new Error('future window must not invoke a model'); } });
    t.after(() => service.dispose());
    assert.equal((await service.snapshot())[0].resetAt, now + 5 * 3600_000);
    await service.tick();
  }
});
