'use strict';
// The phone 看板 names a card in the desktop 任务看板's words: a card stopped by a login,
// quota or rate-limit failure (flag 'quota') is 登录 / 额度 / 限流, never the raw 「quota」,
// and a card the app put in 需要你 itself (no receipt, nobody dispatched) is said plainly,
// never in the internal 「已结束，未提交回执」 / 「调度已结束…」.
// Headless Chromium: run through scripts/e2e-queue.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openHub, nav } = require('./fixtures/hub-page');

const now = new Date().toISOString();
const card = (id, title, status, extra = {}) => ({ id, project: 'AgentDeck', title, detail: '', status, flag: null, order: 0, depends_on: [], assignee: null,
  session_id: null, latest_receipt: '', verify: false, rework_count: 0, created: now, updated: now, archived: false, important: false, ...extra });
const cards = [
  card('t-auth', '登录掉了的卡', 'doing', { flag: 'quota', resource_failure: 'auth', latest_receipt: 'Not logged in · Please run /login' }),
  card('t-quota', '额度用完的卡', 'doing', { flag: 'quota', resource_failure: 'quota', latest_receipt: "You've hit your limit · resets 3pm" }),
  card('t-rate', '被限流的卡', 'doing', { flag: 'quota', resource_failure: 'rate_limit', latest_receipt: 'Rate limited' }),
  card('t-held', '挂起的卡', 'todo', { flag: 'held' }),
  card('t-fallback', '没交回执的卡', 'needs_user', { latest_receipt: '已结束，未提交回执' }),
  card('t-dispatch', '调度没派出的卡', 'needs_user', { latest_receipt: '调度已结束，尚未派出执行会话' }),
];

test('the phone board names a card the way the desktop board does', { timeout: 120000 }, async (t) => {
  const opened = await openHub(t, { machines: [{ id: 'mac', label: 'Mac', platform: 'darwin', hostname: 'Mac.local', cards }], login: ['mac'] });
  if (!opened) return;
  const { page, errors } = opened;
  await nav(page, '看板');
  await page.locator('.task-card').nth(cards.length - 1).waitFor();
  const shown = Object.fromEntries(await page.evaluate(() => [...document.querySelectorAll('.task-card')].map((n) => [n.querySelector('h3').textContent,
    { flag: n.querySelector('.task-flag')?.textContent || '', receipt: n.querySelector('.task-receipt')?.textContent.trim() || '' }])));
  assert.deepEqual(errors, []);
  assert.deepEqual([shown['登录掉了的卡'].flag, shown['额度用完的卡'].flag, shown['被限流的卡'].flag, shown['挂起的卡'].flag], ['登录', '额度', '限流', '挂起']);
  assert.equal(shown['没交回执的卡'].receipt, '队员停下了，但没有交结果。');
  assert.equal(shown['调度没派出的卡'].receipt, '这件事还没有派给队员。');
});
