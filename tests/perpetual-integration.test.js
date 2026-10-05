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

function session({ tasks = [], pending = [] } = {}) {
  const col = { id: 'captain', isMain: true, cmd: '' };
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - 5000, lastScreen: '' };
  const elements = new Map();
  const window = { deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {} }, MainCore: require('../main-core'), BoardCore: B,
    ChatUI: { hasDraft: () => false, turnsOf: () => [] } };
  const context = vm.createContext({ window, document: {
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id); },
    querySelectorAll: () => [],
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({ config: { mainSession: { colId: col.id, tasks, pending } },
    columns: () => [col], terms: new Map([[col.id, entry]]), userComposing: () => false });
  return { api: window.MainSession, entry };
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

function seatRelay() {
  const now = Date.now(), P = require('../perpetual-captain-core'), Q = require('../quota-core');
  let col = { id: 'captain', isMain: true, cmd: S.CLAUDE_COMMAND, claudeSeatId: 'cn' };
  const state = { colId: col.id, tasks: [] }, handoffs = [];
  const seats = ['cn', 'us'].map((id) => ({ id, name: id.toUpperCase(), loggedIn: true,
    onboardingComplete: true, configDir: '/test/' + id, accountKey: id + '-account' }));
  const config = { claudeSeats: seats, quotas: {}, perpetualCaptain: P.normalizeSettings(),
    perpetualCaptainState: {}, captainRelayCodex: { name: 'ChatGPT', command: 'codex' } };
  for (const seat of seats) config.quotas[Q.seatKey(seat.id)] = { provider: 'Claude', scope: 'claude',
    configDir: seat.configDir, accountKey: seat.accountKey, blocked: { at: now, resetAt: now + 3600000,
      configDir: seat.configDir, accountKey: seat.accountKey, sourceColumnId: seat.id + '-terminal' } };
  const window = { ClaudeSeatsCore: S, PerpetualCaptainCore: P, QuotaCore: Q,
    AgentInfo: { resolveAgentInfo: () => ({ provider: 'Claude' }) },
    deck: { claudeSeats: async () => seats, claudeWarmupStatus: async () => [],
      claudeSeatUsage: async () => null, captainRelayNotify: async () => ({ ok: true }) },
    MainSession: { mainCol: () => col, state: () => state, relayIdle: () => true,
      pauseForSeatSwitch() {}, relayEffort: () => 'high', checkpointForSeatSwitch: async () => '/test/handoff.md',
      clearContext(options) {
        handoffs.push(options); col = { ...col, id: 'replacement', cmd: options.command };
        state.colId = col.id; state.relayTargetId = options.relayTargetId; return col;
      } },
    ChatUI: { snapshotForHandoff: () => ({}), addNotice() {} }, dispatchEvent() {} };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }),
    querySelectorAll: () => [] }, setInterval() {}, CustomEvent: class {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../claude-seats-ui.js'), 'utf8'), context);
  window.ClaudeSeats.init({ config, columns: () => [col], terms: new Map(),
    userComposing: () => false, flushConfig() {}, showToast() {} });
  return { api: window.ClaudeSeats, state, config, handoffs };
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
