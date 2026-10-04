'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLocal } = require('../quota-local');
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
    fs.writeFileSync(path.join(home, '.claude/usage-cache.json'), JSON.stringify({ five_hour: { utilization: 25, resets_at: new Date(now + 3600000).toISOString() }, seven_day: { utilization: 30 }, secret: 'NEVER-RETURN' }));
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
    fs.writeFileSync(path.join(home, '.claude-west/usage-cache.json'), JSON.stringify({ sessionUsage: 40, weeklyUsage: 80 }));
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
    fs.writeFileSync(file, JSON.stringify(data));
    const seats = [{ id: 'west', name: '西席', configDir: '~/.claude-west' }];
    const result = await readLocal(home, undefined, now, seats);
    assert.equal(result[0].at, at);
    assert.deepEqual(result[0].windows.map(w => [w.remaining, w.resetAt]), [[65, at + 3600000], [30, at + 4 * 86400000]]);
    fs.writeFileSync(file, JSON.stringify({ ...data, at: now - 3600000 }));
    assert.deepEqual(await readLocal(home, undefined, now, seats), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
