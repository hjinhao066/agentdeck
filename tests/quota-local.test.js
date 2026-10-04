'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLocal } = require('../quota-local');
const M = require('../claude-seats-main');
const { accountIdentity } = require('../quota-codex');
test('bounded local reads return only quota fields, skip partial records and tolerate missing/malformed caches', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-local-'));
  const now = Date.now();
  try {
    const cache = path.join(home, '.cache/ccstatusline/usage.json');
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ sessionUsage: 25, weeklyUsage: 50, secret: 'do-not-return' }));
    const d = new Date(now);
    const dir = path.join(home, '.codex/sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(home, '.codex/auth.json'), 'never-open-me');
    const agy = path.join(home, '.gemini/antigravity-cli/agy_statusline_debug.json');
    fs.mkdirSync(path.dirname(agy), { recursive: true });
    fs.writeFileSync(agy, JSON.stringify({ email: 'do-not-return', quota: { 'gemini-5h': { remaining_fraction: 0.25 } } }));
    const log = path.join(dir, 'rollout.jsonl');
    const event = { type: 'event_msg', timestamp: d.toISOString(), payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor(now / 1000) + 500 } } } };
    fs.writeFileSync(log, JSON.stringify({ type: 'response_item', secret: 'do-not-return' }) + '\n' + JSON.stringify(event) + '\n{"rate_limits":');
    const data = await readLocal(home, undefined, now);
    assert.deepEqual(data.map((q) => q.provider), ['Claude', 'Antigravity', 'Codex']);
    assert.equal(data[1].windows[0].remaining, 25);
    assert.equal(data[2].windows[0].remaining, 90);
    assert.ok(!JSON.stringify(data).includes('do-not-return'));
    fs.utimesSync(cache, new Date(now - 3600000), new Date(now - 3600000));
    fs.utimesSync(log, new Date(now - 3600000), new Date(now - 3600000));
    fs.utimesSync(agy, new Date(now - 3600000), new Date(now - 3600000));
    assert.deepEqual(await readLocal(home, undefined, now), []);
    fs.writeFileSync(cache, '{');
    assert.deepEqual(await readLocal(home, undefined, now), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('profile metadata exposes masked accounts only, not auth data or fabricated normal status', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-identity-'));
  try {
    fs.mkdirSync(path.join(home, '.cursor'));
    fs.writeFileSync(path.join(home, '.cursor/cli-config.json'), JSON.stringify({ authInfo: { email: 'bob@example.com', token: 'NEVER-RETURN' }, secret: 'NEVER-RETURN' }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com', accountUuid: 'NEVER-RETURN' } }));
    const observations = await readLocal(home);
    assert.deepEqual(observations.map(q => [q.provider, q.account, q.identityOnly]), [['Claude', 'al***@example.com', true], ['Cursor', 'bo***@example.com', true]]);
    assert.ok(!JSON.stringify(observations).includes('NEVER-RETURN'));
    const Q = require('../quota-core'), store = {};
    observations.forEach(q => Q.observe(store, q));
    assert.equal(Q.summary(store, 'Cursor').label, '未知');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('configured seats read only their own cache, never the shared cache or a cross-seat cache link', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-seat-cache-'));
  const now = Date.now();
  const seats = [{ id: 'east', name: '东席', configDir: '~/.claude' }, { id: 'west', name: '西席', configDir: '~/.claude-west' }];
  try {
    for (const dir of ['.claude', '.claude-west', '.cache/ccstatusline']) fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, '.cache/ccstatusline/usage.json'), JSON.stringify({ sessionUsage: 100 }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'east@example.com' } }));
    fs.writeFileSync(path.join(home, '.claude/usage-cache.json'), JSON.stringify({ accountKey: accountIdentity('east@example.com').accountKey, configDir: path.join(home, '.claude'), five_hour: { utilization: 25, resets_at: new Date(now + 3600000).toISOString() }, seven_day: { utilization: 30 }, secret: 'NEVER-RETURN' }));
    fs.writeFileSync(path.join(home, '.claude-west/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'west@example.com' } }));
    let data = await readLocal(home, undefined, now, seats);
    let numbers = data.filter(q => q.windows?.length);
    assert.equal(numbers.length, 1);
    assert.equal(numbers[0].seatId, 'east');
    assert.deepEqual(numbers[0].windows.map(w => w.remaining), [75, 70]);
    fs.symlinkSync(path.join(home, '.claude/usage-cache.json'), path.join(home, '.claude-west/usage-cache.json'));
    data = await readLocal(home, undefined, now, seats);
    assert.equal(data.filter(q => q.windows?.length).length, 1);
    fs.unlinkSync(path.join(home, '.claude-west/usage-cache.json'));
    fs.writeFileSync(path.join(home, '.claude-west/usage-cache.json'), JSON.stringify({ accountKey: accountIdentity('west@example.com').accountKey, configDir: path.join(home, '.claude-west'), sessionUsage: 40, weeklyUsage: 80 }));
    data = await readLocal(home, undefined, now, seats);
    numbers = data.filter(q => q.windows?.length);
    assert.deepEqual(numbers.map(q => [q.seatId, q.windows[0].remaining]), [['east', 75], ['west', 60]]);
    assert.equal(numbers[1].account, 'we***@example.com');
    assert.ok(!JSON.stringify(data).includes('NEVER-RETURN'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('feat/claude-seats agentdeck-usage cache preserves observation time and relative reset', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-seat-record-'));
  const now = Date.now(), at = now - 60000;
  try {
    fs.mkdirSync(path.join(home, '.claude-west'));
    const file = path.join(home, '.claude-west/agentdeck-usage.json');
    const data = { at, source: 'Claude /usage', windows: [{ key: 'fiveHour', remaining: 65, resetText: 'in 1h' }, { key: 'weekly', remaining: 30, resetText: 'in 4d' }] };
    fs.writeFileSync(path.join(home, '.claude-west/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'west@example.com' } }));
    M.writeUsage({ id: 'west', configDir: '~/.claude-west' }, home, data);
    const seats = [{ id: 'west', name: '西席', configDir: '~/.claude-west' }];
    const result = (await readLocal(home, undefined, now, seats)).filter(q => q.windows);
    assert.equal(result[0].at, at);
    assert.deepEqual(result[0].windows.map(w => [w.remaining, w.resetAt]), [[65, at + 3600000], [30, at + 4 * 86400000]]);
    fs.writeFileSync(file, JSON.stringify({ ...data, at: now - 3600000 }));
    assert.equal((await readLocal(home, undefined, now, seats)).filter(q => q.windows).length, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test('relogin metadata cannot reassign an old cache; copied and unbound caches are unknown without touching credentials', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-account-binding-')), now = Date.now();
  const seats = [{ id: 'cn', configDir: '~/.claude' }, { id: 'us', configDir: '~/.claude-us' }];
  try {
    for (const seat of seats) fs.mkdirSync(path.join(home, seat.configDir.slice(2)));
    const profile = path.join(home, '.claude.json');
    fs.writeFileSync(profile, JSON.stringify({ oauthAccount: { emailAddress: 'us@example.test' } }));
    fs.writeFileSync(path.join(home, '.claude-us/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'us@example.test' } }));
    const creds = path.join(home, '.claude/.credentials.json');
    fs.writeFileSync(creds, 'credential-fixture-must-remain-unchanged');
    for (const seat of seats) M.writeUsage(seat, home, { at: now, windows: [{ key: 'fiveHour', remaining: 53 }, { key: 'weekly', remaining: 55 }] });
    fs.writeFileSync(profile, JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test' } }));
    assert.equal(M.readUsage(seats[0], home), null);
    let data = await readLocal(home, undefined, now, seats);
    assert.deepEqual(data.filter(q => q.windows).map(q => q.seatId), ['us']);
    fs.copyFileSync(path.join(home, '.claude-us/agentdeck-usage.json'), path.join(home, '.claude/agentdeck-usage.json'));
    data = await readLocal(home, undefined, now, seats);
    assert.deepEqual(data.filter(q => q.windows).map(q => q.seatId), ['us']);
    fs.writeFileSync(path.join(home, '.claude/agentdeck-usage.json'), JSON.stringify({ at: now, windows: [{ key: 'fiveHour', remaining: 53 }] }));
    assert.deepEqual((await readLocal(home, undefined, now, seats)).filter(q => q.windows).map(q => q.seatId), ['us']);
    assert.equal(fs.readFileSync(creds, 'utf8'), 'credential-fixture-must-remain-unchanged');
    M.writeUsage(seats[0], home, { at: now, windows: [{ key: 'fiveHour', remaining: 70 }] });
    assert.deepEqual((await readLocal(home, undefined, now, seats)).filter(q => q.windows).map(q => q.windows[0].remaining), [70, 53]);
    // The same email can no longer conceal a changed account ID.
    fs.writeFileSync(profile, JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test', accountUuid: 'account-cn-original' } }));
    M.writeUsage(seats[0], home, { at: now, windows: [{ key: 'fiveHour', remaining: 70 }] });
    fs.writeFileSync(profile, JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test', accountUuid: 'account-cn-replaced' } }));
    assert.equal(M.readUsage(seats[0], home), null);
    assert.deepEqual((await readLocal(home, undefined, now, seats)).filter(q => q.windows).map(q => q.seatId), ['us']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('two seats with bound data each show their own numbers; an unattributable legacy cache stays unknown', async () => {
  const Q = require('../quota-core'), S = require('../claude-seats-core');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-two-seats-')), now = Date.now();
  const seats = [{ id: 'cn', name: 'CN', configDir: '~/.claude' }, { id: 'us', name: 'US', configDir: '~/.claude-us' }];
  try {
    for (const seat of seats) fs.mkdirSync(path.join(home, seat.configDir.slice(2)));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test', accountUuid: 'cn-id' } }));
    fs.writeFileSync(path.join(home, '.claude-us/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'us@example.test', accountUuid: 'us-id' } }));
    // Legacy caches written before attribution: same numbers in both, no account.
    for (const seat of seats) fs.writeFileSync(path.join(home, seat.configDir.slice(2), 'agentdeck-usage.json'), JSON.stringify({ at: now, source: 'Claude /usage', windows: [{ key: 'fiveHour', remaining: 53 }, { key: 'weekly', remaining: 55 }] }));
    const summaries = async () => {
      const store = {};
      for (const sample of await readLocal(home, undefined, now, seats)) Q.observe(store, sample, now);
      return Q.claudeSeats(seats).map((seat) => Q.summary(store, 'Claude', now, seat, 'us'));
    };
    let [cn, us] = await summaries();
    assert.equal(cn.label, '未知'); assert.equal(us.label, '未知');
    assert.doesNotMatch(cn.detail + us.detail, /剩余 5[35]/);
    assert.match(us.detail, /账号：us\*\*\*@example\.test/);
    M.writeUsage(seats[1], home, S.footerUsage(['Opus 5.5   5h剩余 83% · 7d剩余 59%'], now));
    [cn, us] = await summaries();
    assert.equal(cn.label, '未知');
    assert.equal(us.displayLabel, '5h 83% · 7d 59%');
    assert.match(us.detail, /会话状态行/);
    M.writeUsage(seats[0], home, S.usage('Current session\n  10% used\n  Resets 11pm\nCurrent week (all models)\n  40% used\n', now));
    [cn, us] = await summaries();
    assert.equal(cn.displayLabel, '5h 90% · 7d 60%');
    assert.equal(us.displayLabel, '5h 83% · 7d 59%');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
