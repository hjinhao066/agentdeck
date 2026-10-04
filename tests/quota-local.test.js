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
