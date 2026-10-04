const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Q = require('../quota-core');
const { INTERVAL_MS, shownUsed, officialUsage, readAccessToken, createCursorUsageReader } = require('../quota-cursor');

const day = (t) => {
  const d = new Date(t), pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

test('settings rounding matches Cursor Models and Other Models integers', () => {
  assert.equal(shownUsed(18.36), 18);
  assert.equal(shownUsed(17.4), 17);
  assert.equal(shownUsed(100), 100);
  assert.equal(shownUsed(0.4), 1);
  assert.equal(shownUsed(0), 0);
  assert.equal(shownUsed(-1), null);
  assert.equal(shownUsed('18'), null);
});

test('official usage keeps only the two pools and never echoes credentials', () => {
  const token = 'do-not-log-credential';
  const at = Date.parse('2026-10-03T18:00:00Z');
  const reset = Date.parse('2026-11-01T07:31:34Z');
  const sample = officialUsage({
    planUsage: { autoPercentUsed: 18.36, apiPercentUsed: 100, totalPercentUsed: 20.2, bonusTooltip: token },
    billingCycleEnd: String(reset), accessToken: token, displayMessage: `secret ${token}`,
  }, at);
  assert.equal(sample.windows[0].remaining, 82);
  assert.equal(sample.windows[1].remaining, 0);
  assert.equal(sample.windows[1].exhausted, true);
  assert.equal(sample.windows[0].key, 'cursorModels');
  assert.equal(sample.windows[1].key, 'otherModels');
  assert.equal(sample.windows[0].resetAt, reset);
  assert.equal(JSON.stringify(sample).includes(token), false);
  assert.equal(JSON.stringify(sample).includes('secret'), false);
  const view = Q.summary({ Cursor: { scope: 'grok-4.7', sample } }, 'Cursor', at + 1000);
  assert.equal(view.displayLabel, `Grok 82% · 其他 0% ↻${day(reset)}`);
  assert.equal(view.displayLabel.includes('已用'), false);
  assert.equal(view.displayLabel.includes('剩'), false);
  assert.equal(view.pools[1].exhausted, true);
  assert.equal(view.pools[0].exhausted, false);
  assert.match(view.detail, /采样/);
  assert.match(Q.text({ Cursor: { scope: 'grok-4.7', sample } }, at + 1000), /Grok 82% · 其他 0%.*采样/);
});

test('a failed poll keeps the last numbers, sample time, and blocks only claude models in the empty pool', () => {
  const at = Date.parse('2026-10-03T18:00:00Z');
  const reset = Date.parse('2026-11-01T07:31:34Z');
  const store = {};
  const sample = officialUsage({ planUsage: { autoPercentUsed: 17, apiPercentUsed: 100 }, billingCycleEnd: reset }, at);
  assert.equal(Q.observe(store, sample, at), true);
  assert.equal(Q.observe(store, Q.screen('Cursor', 'Usage limit reached', [], at + 1, 'grok-4.7-high-fast'), at + 1), false);
  assert.equal(Q.summary(store, 'Cursor', at + 1).displayLabel, `Grok 83% · 其他 0% ↻${day(reset)}`);
  assert.equal(Q.observe(store, {
    provider: 'Cursor', scope: 'grok-4.7', at: at + 2, failureOnly: true, official: true,
    failures: 2, checkedAt: at + 2, failure: '网络查询失败',
  }, at + 2), true);
  const failed = Q.summary(store, 'Cursor', at + 2);
  assert.equal(failed.displayLabel, `Grok 83% · 其他 0% ↻${day(reset)}`);
  assert.match(failed.detail, /查询失败：网络查询失败/);
  assert.match(failed.detail, /保留上次数字/);
  assert.match(failed.detail, /采样/);
  assert.match(failed.sampleLabel, /^采样 \d\d:\d\d$/);
  assert.equal(store.Cursor.sample.at, at);
  const claude = 'cursor-agent --force --model claude-opus-5-5-high';
  assert.match(Q.cursorLaunchBlock(claude, store, at), /该池已用尽/);
  assert.match(Q.cursorLaunchBlock('cursor-agent --model="claude-sonnet-5-5-high"', store, at), /该池已用尽/);
  assert.match(Q.cursorLaunchBlock('cursor-agent --model=claude-opus-5-5-max', store, at), /该池已用尽/);
  assert.equal(Q.cursorLaunchBlock('cursor-agent --force --model grok-4.7-high-fast', store, at), '');
  assert.equal(Q.cursorLaunchBlock('claude --model claude-opus-5-5 --effort high', store, at), '');
  assert.equal(Q.cursorLaunchBlock(claude, {}, at), '');
  assert.equal(Q.cursorLaunchBlock(claude, store, reset + 1), '');
});

test('the reader polls at most every ten minutes and drops transport errors without the token', async () => {
  const token = 'header.payload.signature';
  let calls = 0, clock = Date.parse('2026-10-03T18:00:00Z');
  const reader = createCursorUsageReader({
    now: () => clock,
    readToken: async () => token,
    fetchUsage: async (got) => {
      assert.equal(got, token);
      calls += 1;
      if (calls === 1) return { planUsage: { autoPercentUsed: 18.36, apiPercentUsed: 100 }, billingCycleEnd: String(clock + 20 * 86400000) };
      throw new Error(`boom ${token}`);
    },
  });
  const first = await reader.read();
  assert.equal(first.windows[1].remaining, 0);
  assert.equal(JSON.stringify(first).includes(token), false);
  assert.equal(await reader.read(), first);
  assert.equal(calls, 1);
  clock += INTERVAL_MS - 1;
  assert.equal(await reader.read(), first);
  assert.equal(calls, 1);
  clock += 1;
  const failed = await reader.read();
  assert.equal(failed.failureOnly, true);
  assert.equal(failed.failure, '网络查询失败');
  assert.equal(JSON.stringify(failed).includes(token), false);
  assert.equal(calls, 2);
  const quiet = createCursorUsageReader({ enabled: false, readToken: async () => { throw new Error(token); } });
  assert.equal(await quiet.read(), null);
});

test('token lookup is read-only, rejects links, and ignores a missing database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-usage-'));
  const db = path.join(dir, 'state.vscdb');
  const link = path.join(dir, 'linked.vscdb');
  assert.equal(await readAccessToken(path.join(dir, 'missing.vscdb')), null);
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE ItemTable (key TEXT, value TEXT); INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'aaa.bbb.ccc');"]);
  assert.equal(await readAccessToken(db), 'aaa.bbb.ccc');
  fs.symlinkSync(db, link);
  assert.equal(await readAccessToken(link), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
