'use strict';
// Token 用量 across the two machines: the summary each machine sends (only days and
// models, the last KEEP_DAYS days, under MAX_BYTES), what is read back from the hub,
// why another machine may have no numbers, and that the hub as deployed (the
// shared-store.js of 2.0.5, e4affed) keeps one record per machine that is replaced
// in place, never piling up copies (the 608 MB store of 2026-10-09).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const F = require('../fleet-usage-core');
const C = require('../token-usage-core');
const { FleetClient } = require('../sync-client');
const { TaskStore } = require('../task-board');
const { SharedStore, stripSecrets } = require('../shared-store');
const { startSyncServer } = require('../sync-server');
const FleetUI = require('../fleet-ui');
const { createTokenUsage } = require('../token-usage-main');

const TODAY = '2026-10-10';
// A scan as token-usage-scan.js returns it, `n` days back from TODAY, `models` per day.
function scan({ days = 40, models = 3, today = TODAY } = {}) {
  const out = { version: 3, today, from: C.addDays(today, -61), generatedAt: Date.parse('2026-10-10T09:30:00'), tookMs: 5, days: {}, costs: {},
    seatCosts: [{ seats: ['cn'], days: { [today]: 1 } }], plans: { pro: 20 }, pricesChecked: '2026-10-01',
    sources: [{ id: 'claude', name: 'Claude Code', state: 'ok', files: 3, records: 9, errors: 0, lastDay: today }] };
  for (let back = 0; back < days; back++) {
    const day = C.addDays(today, -back);
    out.days[day] = {}; out.costs[day] = {};
    for (let m = 0; m < models; m++) {
      const key = m === 0 ? 'claude:claude-opus-5-5' : m === 1 ? 'codex:gpt-6.1' : `deepseek:deepseek-v${m}`;
      out.days[day][key] = [1000 * (m + 1) + back, 200 * (m + 1), 5_000_000 + m, 30_000];
      out.costs[day][key] = m === 2 ? null : [0.01 * (m + 1), 0.02, 0.5, 0.0375];
    }
  }
  return out;
}

test('a summary keeps only days and models, the last 31 days up to the scan\'s today', () => {
  const s = F.summarize(scan());
  assert.deepEqual(Object.keys(s).sort(), ['costs', 'days', 'generatedAt', 'pricesChecked', 'today', 'v']);
  const days = Object.keys(s.days).sort();
  assert.equal(days.length, F.KEEP_DAYS);
  assert.equal(days[0], C.addDays(TODAY, -(F.KEEP_DAYS - 1)));
  assert.equal(days[days.length - 1], TODAY);
  assert.deepEqual(s.days[TODAY]['claude:claude-opus-5-5'], [1000, 200, 5_000_000, 30_000]);
  assert.deepEqual(s.costs[TODAY]['codex:gpt-6.1'], [0.02, 0.02, 0.5, 0.0375]);
  assert.equal(s.costs[TODAY]['deepseek:deepseek-v2'], null, '无官方价 stays null, never $0');
  // nothing about seats, plans, sources or files goes up
  assert.doesNotMatch(JSON.stringify(s), /seat|plan|claude\.json|records|files|\/|\\\\/);
  // a day after the scan's today (a clock ahead) and a day without tokens are not sent
  const odd = scan({ days: 2 });
  odd.days['2026-10-11'] = { 'claude:x': [1, 1, 1, 1] };
  odd.days['2026-10-09'] = { 'claude:x': [0, 0, 0, 0] };
  const t = F.summarize(odd);
  assert.deepEqual(Object.keys(t.days), [TODAY]);
});

test('a day with many models keeps its biggest one by one and folds the rest per source', () => {
  // the six smallest of 26: claude and codex (the smallest here) and deepseek v2-v5
  const big = scan({ days: 1, models: F.MAX_MODELS + 6 });
  const s = F.summarize(big);
  const day = s.days[TODAY];
  const folds = Object.keys(day).filter((k) => k.endsWith(':' + F.MORE)).sort();
  assert.deepEqual(folds, ['claude:' + F.MORE, 'codex:' + F.MORE, 'deepseek:' + F.MORE]);
  assert.equal(Object.keys(day).length - folds.length, F.MAX_MODELS);
  assert.ok(day['deepseek:deepseek-v25'] && !day['deepseek:deepseek-v5']);
  // every token is still counted
  const total = (d) => Object.values(d).reduce((a, v) => a + v[0] + v[1] + v[2] + v[3], 0);
  assert.equal(total(day), total(big.days[TODAY]));
  // deepseek v2 had no official price, v3-v5 had one: the fold is priced with theirs
  assert.deepEqual(s.costs[TODAY]['deepseek:' + F.MORE].map((v) => Math.round(v * 1e4) / 1e4), [0.04 + 0.05 + 0.06, 0.06, 1.5, 0.1125].map((v) => Math.round(v * 1e4) / 1e4));
  // a fold of models without an official price says 无官方价 too
  const none = scan({ days: 1, models: 0 });
  for (let i = 0; i < F.MAX_MODELS + 1; i++) { none.days[TODAY]['cursor:c' + i] = [100 - i, 0, 0, 0]; none.costs[TODAY]['cursor:c' + i] = null; }
  assert.equal(F.summarize(none).costs[TODAY]['cursor:' + F.MORE], null);
  // a fold holding a priced model is priced
  const mixed = scan({ days: 1, models: 0 });
  for (let i = 0; i < F.MAX_MODELS + 2; i++) {
    mixed.days[TODAY][`claude:m${String(i).padStart(2, '0')}`] = [1000 - i, 0, 0, 0];
    mixed.costs[TODAY][`claude:m${String(i).padStart(2, '0')}`] = i === F.MAX_MODELS ? null : [0.5, 0, 0, 0];
  }
  const m = F.summarize(mixed);
  assert.deepEqual(m.costs[TODAY]['claude:' + F.MORE], [0.5, 0, 0, 0]);
  assert.deepEqual(m.days[TODAY]['claude:' + F.MORE], [(1000 - F.MAX_MODELS) + (1000 - F.MAX_MODELS - 1), 0, 0, 0]);
});

test('a summary never passes MAX_BYTES: the oldest days go first', () => {
  const huge = scan({ days: 31, models: 0 });
  for (const day of Object.keys(huge.days)) {
    for (let i = 0; i < F.MAX_MODELS + 10; i++) {
      const key = `claude:${'model-with-a-very-long-name-'.repeat(3)}${i}`;
      huge.days[day][key] = [123456789012, 98765432101, 5678901234567, 4567890123];
      huge.costs[day][key] = [1234.567891, 2345.678912, 3456.789123, 4567.891234];
    }
  }
  const s = F.summarize(huge);
  assert.ok(F.byteSize(s) <= F.MAX_BYTES, `${F.byteSize(s)} bytes`);
  const days = Object.keys(s.days).sort();
  assert.ok(days.length < 31 && days.length > 0);
  assert.equal(days[days.length - 1], TODAY, 'today is kept');
  // a usual day: three CLIs, a handful of models, about 1.1 KB per day
  const usual = F.summarize(scan({ days: 31, models: 6 }));
  assert.ok(F.byteSize(usual) < 40 * 1024, `${F.byteSize(usual)} bytes`);
});

test('a summary read back from the hub is checked again', () => {
  const good = F.summarize(scan({ days: 3 }));
  assert.deepEqual(F.clean(JSON.parse(JSON.stringify(good))), good);
  for (const bad of [null, 'x', [], { ...good, v: 2 }, { ...good, today: 'yesterday' }]) assert.equal(F.clean(bad), null);
  const odd = JSON.parse(JSON.stringify(good));
  odd.days['not-a-day'] = { 'claude:x': [1, 1, 1, 1] };
  odd.days[TODAY]['claude:claude-opus-5-5'] = [-5, NaN, 'x', 1];
  odd.days[TODAY]['no colon'] = [1, 1, 1, 1];
  odd.days[TODAY]['codex:gpt-6.1'] = [1, 2, 3];
  const c = F.clean(odd);
  assert.equal(c.days['not-a-day'], undefined);
  assert.deepEqual(c.days[TODAY]['claude:claude-opus-5-5'], [0, 0, 0, 1]);
  assert.equal(c.days[TODAY]['no colon'], undefined);
  assert.equal(c.days[TODAY]['codex:gpt-6.1'], undefined);
  assert.deepEqual(F.fromRecord({ turns: F.turnsOf(good) }), good);
  assert.equal(F.fromRecord({ turns: [{ user: '队长的话' }] }), null);
  assert.equal(F.fromRecord({ turns: [] }), null);
});

test('versions: 2.0.7 and later upload their usage', () => {
  assert.equal(F.versionAtLeast('2.0.7'), true);
  assert.equal(F.versionAtLeast('2.0.10'), true);
  assert.equal(F.versionAtLeast('2.1.0'), true);
  assert.equal(F.versionAtLeast('2.0.6'), false);
  assert.equal(F.versionAtLeast('1.9.99'), false);
  assert.equal(F.versionAtLeast(''), false);
  assert.equal(F.versionAtLeast('dev'), false);
});

test('another machine without numbers says why: not configured, connecting, sync error, not on the hub, old version, offline, waiting', () => {
  const at = (iso) => iso;
  const mac = (extra) => ({ id: 'dev-mac', name: 'MacBook', platform: 'darwin', version: '2.0.6', online: true, lastSeenAt: at('2026-10-10T09:00:00Z'), ...extra });
  const state = (fleet, platform = 'darwin') => F.machine({ platform, selfPlatform: 'win32', fleet });
  assert.equal(state(null, 'win32').state, 'self');
  assert.equal(state({ configured: false }).state, 'unconfigured');
  assert.equal(state({ configured: true, devices: [], usage: {}, lastSyncAt: null }).state, 'connecting');
  const error = state({ configured: true, devices: [mac()], usage: {}, error: '同步失败：连不上同步服务', lastSyncAt: null });
  assert.equal(error.state, 'error');
  assert.match(error.detail, /连不上同步服务/);
  assert.equal(state({ configured: true, selfId: 'dev-win', devices: [{ id: 'dev-win', platform: 'win32', online: true }], usage: {}, lastSyncAt: 'x' }).state, 'missing');
  const old = state({ configured: true, devices: [mac()], usage: {}, lastSyncAt: 'x' });
  assert.equal(old.state, 'old');
  assert.match(old.title, /2\.0\.6/);
  assert.match(old.detail, /2\.0\.7/);
  assert.equal(state({ configured: true, devices: [mac({ version: '2.0.7', online: false })], usage: {}, lastSyncAt: 'x' }).state, 'offline');
  assert.equal(state({ configured: true, devices: [mac({ version: '2.0.7' })], usage: {}, lastSyncAt: 'x' }).state, 'waiting');
  // an offline old version is still told to update (its version is what holds it back)
  assert.equal(state({ configured: true, devices: [mac({ online: false })], usage: {}, lastSyncAt: 'x' }).state, 'old');
});

test('another machine with numbers: its newest summary, kept while it is offline or sync fails', () => {
  const summary = F.summarize(scan({ days: 2 }));
  const older = { ...summary, generatedAt: summary.generatedAt - 86_400_000 };
  const devices = [
    { id: 'dev-mac-old', name: 'Mac 旧', platform: 'darwin', version: '2.0.7', online: false, lastSeenAt: '2026-10-01T00:00:00Z' },
    { id: 'dev-mac', name: 'MacBook', platform: 'darwin', version: '2.0.7', online: false, lastSeenAt: '2026-10-10T08:00:00Z' },
    { id: 'dev-win', name: 'PC', platform: 'win32', version: '2.0.7', online: true },
  ];
  const usage = { 'dev-mac': { summary, updatedAt: '2026-10-10T08:00:00Z' }, 'dev-mac-old': { summary: older }, 'dev-gone': { summary } };
  const m = F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet: { configured: true, selfId: 'dev-win', devices, usage, lastSyncAt: 'x', error: '同步失败：服务状态 500' } });
  assert.equal(m.state, 'ok');
  assert.equal(m.summary, summary);
  assert.equal(m.device.name, 'MacBook');
  assert.equal(m.stale, true);
  assert.match(m.syncError, /500/);
  // a summary from a device the hub no longer lists is not shown
  const gone = F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet: { configured: true, devices: [], usage: { 'dev-gone': { summary } }, lastSyncAt: 'x' } });
  assert.equal(gone.state, 'missing');
});

// ---- the hub as deployed ----
function hubDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fleet-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const turnsHash = (turns) => crypto.createHash('sha256').update(JSON.stringify(stripSecrets(turns))).digest('hex');

test('the hub keeps one usage record per machine, replaced in place: no kept copies, only small receipts', (t) => {
  const root = hubDir(t);
  const file = path.join(root, 'store.json');
  const hub = new SharedStore({ file });
  const sizes = [];
  for (let i = 0; i < 60; i++) {
    const s = F.summarize(scan({ days: 31, models: 6 }));
    s.days[TODAY]['claude:claude-opus-5-5'][1] += i;          // today's numbers keep moving
    s.generatedAt += i * 60_000;
    const turns = F.turnsOf(s);
    hub.pushHistory({ opId: 'op-usage-' + String(i).padStart(4, '0'), sessionId: F.USAGE_SESSION, deviceId: 'dev-win', contentHash: turnsHash(turns), summary: F.LABEL, startedAt: F.EPOCH, endedAt: F.EPOCH, turns });
    sizes.push(fs.statSync(file).size);
  }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const record = saved.history[F.USAGE_SESSION + '@dev-win'];
  assert.equal(record.alternatives.length, 0, 'a new summary is the same turn moving on, never a kept copy');
  assert.equal(record.turns.length, 1);
  assert.equal(F.fromRecord(record).days[TODAY]['claude:claude-opus-5-5'][1], 200 + 59);
  // each upload adds only its receipt (~200 bytes), not another summary
  const perUpload = (sizes[59] - sizes[9]) / 50;
  assert.ok(perUpload < 400, `${perUpload} bytes per upload`);
  // reloading (compactHistory) keeps it as it is
  const again = new SharedStore({ file });
  assert.deepEqual(F.fromRecord(again.record(F.USAGE_SESSION, 'dev-win')), F.fromRecord(record));
});

test('an older client lists the usage record after every real 队长记录 (it sorts as 1970)', () => {
  const real = Array.from({ length: 3 }, (_, i) => ({ sessionId: 'cap-' + i, deviceId: 'dev-mac', summary: '队长 ' + i, endedAt: `2026-10-0${i + 1}T00:00:00.000Z` }));
  const usage = { sessionId: F.USAGE_SESSION, deviceId: 'dev-win', summary: F.LABEL, startedAt: F.EPOCH, endedAt: F.EPOCH, updatedAt: '2026-10-10T09:00:00.000Z' };
  const model = FleetUI.viewModel({ configured: true, devices: [], history: [usage, ...real] }, Date.parse('2026-10-10T10:00:00Z'));
  assert.equal(model.history[model.history.length - 1].sessionId, F.USAGE_SESSION);
  const eight = Array.from({ length: 8 }, (_, i) => ({ ...real[0], sessionId: 'cap-x' + i }));
  assert.ok(!FleetUI.viewModel({ configured: true, devices: [], history: [usage, ...eight] }).history.some((h) => h.sessionId === F.USAGE_SESSION), 'past eight real records it is not listed at all');
});

// ---- two clients through a real sync server ----
function client(root, name, platform, extra = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  return new FleetClient({
    baseUrl: extra.url, tokenFile: path.join(root, 'token'), device: { id: 'dev-' + name, name, platform },
    taskStore: new TaskStore(path.join(dir, 'tasks')), historyDir: path.join(dir, 'history'), stateFile: path.join(dir, 'state.json'),
    version: '2.0.7', ...extra,
  });
}

test('two machines: each sends its summary and reads the other\'s; 队长记录 and the history folder stay as they were', async (t) => {
  const root = hubDir(t);
  fs.writeFileSync(path.join(root, 'token'), 'usage-token\n', { mode: 0o600 });
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  const server = await startSyncServer({ store, token: 'usage-token' });
  t.after(() => server.close());
  let now = 1_000_000;
  const win = client(root, 'win', 'win32', { url: server.url, now: () => now, usageEveryMs: 15 * 60_000 });
  const mac = client(root, 'mac', 'darwin', { url: server.url, now: () => now });
  const winSummary = F.summarize(scan({ days: 5 }));
  win.noteUsage(winSummary);
  win.noteCaptain('cap-win', { turns: [{ user: '队长的第一句', reply: '好', ts: Date.parse('2026-10-10T08:00:00Z') }] });
  await win.syncOnce();
  assert.equal(win.error, null);
  await mac.syncOnce();
  assert.equal(mac.error, null);
  const seen = mac.usageSnapshot();
  assert.deepEqual(seen.usage['dev-win'].summary, winSummary);
  assert.equal(seen.devices.find((d) => d.id === 'dev-win').platform, 'win32');
  assert.deepEqual(mac.snapshot().history.map((h) => h.sessionId), ['cap-win'], 'the usage record is not a 队长记录');
  assert.deepEqual(fs.readdirSync(path.join(root, 'mac', 'history')), ['cap-win--dev-win.json']);
  const view = F.machine({ platform: 'win32', selfPlatform: 'darwin', fleet: seen });
  assert.equal(view.state, 'ok');
  assert.deepEqual(view.summary, winSummary);
  // the Mac has not sent anything yet: Windows is told it is waiting for it
  await win.syncOnce();
  assert.equal(F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet: win.usageSnapshot() }).state, 'waiting');

  // a changed summary waits out usageEveryMs; an unchanged one is never sent again
  const posts = () => store.snapshot().history.find((h) => h.sessionId === F.USAGE_SESSION && h.deviceId === 'dev-win').updatedAt;
  const first = posts();
  win.noteUsage(winSummary);
  assert.equal(win.usageItem, null, 'unchanged');
  const next = F.summarize(scan({ days: 6 }));
  win.noteUsage(next);
  now += 60_000;
  await win.syncOnce();
  assert.equal(posts(), first, 'too soon');
  now += 15 * 60_000;
  await win.syncOnce();
  assert.notEqual(posts(), first);
  await mac.syncOnce();
  assert.deepEqual(mac.usageSnapshot().usage['dev-win'].summary, next);
  // nothing is fetched again while the hub's copy stays the same
  const fetched = [];
  const real = mac.fetchImpl;
  mac.fetchImpl = (url, init) => { if (String(url).includes('/v1/history?')) fetched.push(url); return real(url, init); };
  await mac.syncOnce();
  assert.deepEqual(fetched, []);

  // the last numbers stay after a restart (another machine offline) and go when the hub drops them
  const again = client(root, 'mac', 'darwin', { url: 'http://127.0.0.1:9/' });
  assert.deepEqual(again.usageSnapshot().usage['dev-win'].summary, next);
  await again.syncOnce();
  assert.match(again.error, /连不上/);
  assert.equal(F.machine({ platform: 'win32', selfPlatform: 'darwin', fleet: again.usageSnapshot() }).state, 'ok', 'a failed sync keeps the last numbers');
  delete store.data.history[F.USAGE_SESSION + '@dev-win'];
  await mac.syncOnce();
  assert.equal(mac.usageSnapshot().usage['dev-win'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'mac', 'state-usage.json'), 'utf8')).devices['dev-win'], undefined);
});

test('a client restarted with its summary already on the hub does not send it again', async (t) => {
  const root = hubDir(t);
  fs.writeFileSync(path.join(root, 'token'), 'usage-token\n', { mode: 0o600 });
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  const server = await startSyncServer({ store, token: 'usage-token' });
  t.after(() => server.close());
  const summary = F.summarize(scan({ days: 2 }));
  const one = client(root, 'win', 'win32', { url: server.url });
  one.noteUsage(summary);
  await one.syncOnce();
  const sent = Object.keys(store.data.ops).length;
  const two = client(root, 'win', 'win32', { url: server.url });
  await two.syncOnce();                 // learns the hub's copy
  two.noteUsage(summary);
  assert.equal(two.usageItem, null);
  await two.syncOnce();
  assert.equal(Object.keys(store.data.ops).length, sent);
});

test('every scan the Token view runs also feeds the sync (onResult)', async () => {
  const seen = [];
  let n = 0;
  const usage = createTokenUsage({ run: async () => ({ n: ++n }), onResult: (r) => seen.push(r.n), maxAge: 0 });
  await usage.get();
  await usage.get({ fresh: true });
  assert.deepEqual(seen, [1, 2]);
  const broken = createTokenUsage({ run: async () => ({ ok: 1 }), onResult: () => { throw new Error('x'); } });
  assert.deepEqual(await broken.get(), { ok: 1 }, 'a failing listener never fails the view');
});

// ---- second round (review of ea38926) ----
test('every scan goes up: a summary that differs only in its time is new (generatedAt stays in the hash), at most once per usageEveryMs', async (t) => {
  const root = hubDir(t);
  fs.writeFileSync(path.join(root, 'token'), 'usage-token\n', { mode: 0o600 });
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  const server = await startSyncServer({ store, token: 'usage-token' });
  t.after(() => server.close());
  let now = 5_000_000;
  const win = client(root, 'win', 'win32', { url: server.url, now: () => now });
  const first = F.summarize(scan({ days: 3 }));
  win.noteUsage(first);
  await win.syncOnce();
  const sent = () => F.fromRecord(store.record(F.USAGE_SESSION, 'dev-win')).generatedAt;
  assert.equal(sent(), first.generatedAt);
  const later = { ...first, generatedAt: first.generatedAt + 30 * 60_000 };   // same numbers, the next scan
  win.noteUsage(later);
  assert.ok(win.usageItem, 'only the time changed, still a new summary');
  now += 60_000;
  await win.syncOnce();
  assert.equal(sent(), first.generatedAt, 'not before usageEveryMs');
  now += 15 * 60_000;
  await win.syncOnce();
  assert.equal(sent(), later.generatedAt, "so the other machine's 截至 moves on");
  // each upload leaves the hub one receipt of about 300 bytes (30 days): 96 a day at worst is under 0.9 MB
  const file = path.join(root, 'hub', 'store.json');
  const before = fs.statSync(file).size;
  for (let i = 1; i <= 20; i++) { now += 15 * 60_000; win.noteUsage({ ...later, generatedAt: later.generatedAt + i }); await win.syncOnce(); }
  const perUpload = (fs.statSync(file).size - before) / 20;
  assert.ok(perUpload > 200 && perUpload < 360, `${perUpload} bytes per upload`);
  assert.ok(perUpload * 96 * 30 < 0.95 * 1024 * 1024);
});

test('the note beside noteUsage names the hub rule and a fleet-usage test that exists', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sync-client.js'), 'utf8');
  assert.ok(source.includes("turnExtends' `moving && key === 'task'`"));
  const named = /fleet-usage test "([^"]+)"/.exec(source.replace(/\n\s*\/\/\s*/g, ' '));
  assert.ok(named, 'a test is named');
  const tests = fs.readFileSync(__filename, 'utf8');
  assert.ok(tests.includes("test('" + named[1] + "'"), named[1]);
  // the rule itself is still in the hub this client relies on
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'shared-store.js'), 'utf8').includes("if (moving && key === 'task') return true;"));
});

test("数据来源 lists this machine's logs: shown only while the chart shows this machine", () => {
  assert.equal(F.showsSources(null), true);
  assert.equal(F.showsSources({ state: 'self' }), true);
  for (const state of ['ok', 'old', 'unconfigured', 'newer', 'offline']) assert.equal(F.showsSources({ state }), false, state);
});

test('the notice is keyed by what it says, so a refresh saying the same is not read out again; a switch says nothing over it', () => {
  const fleet = { configured: true, devices: [{ id: 'dev-mac', platform: 'darwin', version: '2.0.6', online: true }], usage: {}, lastSyncAt: 'x' };
  const a = F.notice(F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet }));
  const b = F.notice(F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet: { ...fleet, lastSyncAt: 'y' } }));
  assert.equal(a.key, b.key, 'only the sync time moved');
  assert.equal(a.state, 'old');
  const c = F.notice(F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet: { ...fleet, devices: [{ ...fleet.devices[0], version: '2.0.7' }] } }));
  assert.notEqual(c.key, a.key);
  assert.equal(F.notice({ state: 'self' }), null);
  assert.equal(F.notice({ state: 'ok', label: 'Mac' }), null);
  assert.equal(F.announcement({ state: 'self', label: 'Windows' }), 'Windows（本机）的用量');
  assert.equal(F.announcement({ state: 'ok', label: 'Mac' }), 'Mac 的用量');
  assert.equal(F.announcement({ state: 'old', label: 'Mac', title: 'x' }), '', 'the status region reads a notice itself');
});

test('a summary in a newer format: Mac 上的 AgentDeck 比本机新, never 几分钟内会传上来, and kept over a restart', async (t) => {
  const v2 = { ...F.summarize(scan({ days: 2 })), v: F.VERSION + 1, extra: { newField: 1 } };
  assert.equal(F.fromRecord({ turns: F.turnsOf(v2) }), null);
  assert.equal(F.newerOf({ turns: F.turnsOf(v2) }), F.VERSION + 1);
  assert.equal(F.newerOf({ turns: F.turnsOf({ ...v2, v: 0 }) }), 0);
  assert.equal(F.newerOf({ turns: F.turnsOf({ ...v2, v: '2' }) }), 0);
  const root = hubDir(t);
  fs.writeFileSync(path.join(root, 'token'), 'usage-token\n', { mode: 0o600 });
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  store.heartbeat({ id: 'dev-mac', name: 'Mac', platform: 'darwin', version: '2.1.0' });
  const turns = F.turnsOf(v2);
  store.pushHistory({ opId: 'op-newer-0001', sessionId: F.USAGE_SESSION, deviceId: 'dev-mac', contentHash: turnsHash(turns), summary: F.LABEL, startedAt: F.EPOCH, endedAt: F.EPOCH, turns });
  const server = await startSyncServer({ store, token: 'usage-token' });
  t.after(() => server.close());
  const win = client(root, 'win', 'win32', { url: server.url });
  await win.syncOnce();
  const m = F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet: win.usageSnapshot() });
  assert.equal(m.state, 'newer');
  assert.equal(m.title, 'Mac 上的 AgentDeck 比本机新，本机升级后才能看');
  assert.equal(m.detail, '把这台电脑的 AgentDeck 升级到最新版就能看到');
  assert.doesNotMatch(m.title + m.detail, /几分钟|版本|第 \d 版|\d+\.\d+/, 'plain words: no format or version numbers in the notice');
  assert.equal(m.hint, `Mac 传来的是第 ${F.VERSION + 1} 版用量格式，这台只认得第 ${F.VERSION} 版`);
  assert.equal(F.notice(m).hint, m.hint, 'the format numbers go to the hover hint');
  const again = client(root, 'win', 'win32', { url: 'http://127.0.0.1:9/' });
  assert.equal(F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet: { ...again.usageSnapshot(), devices: win.usageSnapshot().devices } }).state, 'newer');
  // a machine with readable numbers seen more recently than the newer one wins
  const summary = F.summarize(scan({ days: 2 }));
  const both = F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet: { configured: true, lastSyncAt: 'x',
    devices: [{ id: 'a', platform: 'darwin', lastSeenAt: '2026-10-01T00:00:00Z' }, { id: 'b', platform: 'darwin', lastSeenAt: '2026-10-10T00:00:00Z', online: true }],
    usage: { a: { newer: 2 }, b: { summary } } } });
  assert.equal(both.state, 'ok');
});

test('icons: not connected is a broken link (no slash, which read as a muted bell), waiting is a clock, the rest an alert', () => {
  const icon = (state) => F.notice({ state, title: 't', detail: 'd' }).icon;
  assert.equal(icon('unconfigured'), 'unlinked');
  for (const s of ['offline', 'waiting', 'connecting']) assert.equal(icon(s), 'clock', s);
  for (const s of ['old', 'newer', 'missing', 'error']) assert.equal(icon(s), 'alert', s);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'token-usage-ui.js'), 'utf8');
  for (const name of ['unlinked', 'clock', 'alert']) assert.match(ui, new RegExp('^\\s+' + name + ': svgIcon\\(', 'm'), name);
  const unlinked = /^\s+unlinked: svgIcon\('(.*)'\),$/m.exec(ui)[1];
  assert.doesNotMatch(unlinked, /M3 3l18 18|M2 2l20 20/, 'no strike-through');
});

// ---- third round (re-review of 9e0d089) ----
test('a notice is said once when it comes into view and once when what it says changes, never on a refresh saying the same', () => {
  const fleet = (version) => ({ configured: true, devices: [{ id: 'dev-mac', platform: 'darwin', version, online: true }], usage: {}, lastSyncAt: 'x' });
  const note = (version) => F.notice(F.machine({ platform: 'darwin', selfPlatform: 'win32', fleet: fleet(version) }));
  let spoken = '';
  const step = (n) => { const r = F.speakNotice(spoken, n); spoken = r.spoken; return r.say; };
  assert.equal(step(note('2.0.6')), 'Mac 上的 AgentDeck 2.0.6 还不会上传用量', 'switched to it: said once');
  assert.equal(step(note('2.0.6')), '', 'a poll saying the same: silent');
  assert.equal(step(note('2.0.6')), '', 'a refresh saying the same: silent');
  assert.equal(step(note('2.0.7')), 'Mac 还没传上用量', 'what it says changed in the same tab: said once');
  assert.equal(step(note('2.0.7')), '');
  assert.equal(step(null), '', 'back to a machine with numbers: nothing to say here');
  assert.equal(spoken, '');
  assert.equal(step(note('2.0.7')), 'Mac 还没传上用量', 'switched back to it: said again, once');
  // the notice itself is no live region any more: the page's own live region says it
  const ui = fs.readFileSync(path.join(__dirname, '..', 'token-usage-ui.js'), 'utf8');
  assert.match(ui, /<div class="tu-off" hidden><\/div>/);
});
