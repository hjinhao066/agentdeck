'use strict';
// The phone hub page when a computer's 队长 terminal has exited (captain.status
// 'exited'): the overview says 已退出, as the desktop does, and the send button stays off
// with the reason instead of sending a message the desktop will refuse.
// Headless Chromium: run through scripts/e2e-queue.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openHub, nav, refresh } = require('./fixtures/hub-page');

test('an exited 队长 reads 已退出 on the phone and cannot be sent to', { timeout: 120000 }, async (t) => {
  const opened = await openHub(t);
  if (!opened) return;
  const { hub, page, errors } = opened;
  hub.machines.mac.captain.status = 'exited';
  const snapshots = () => hub.machines.mac.requests.filter((r) => r.url === '/mac/api/snapshot').length;
  const before = snapshots();
  await refresh(page);
  // Two snapshots after the change: the first one that read it has been drawn.
  for (let i = 0; i < 100 && snapshots() < before + 2; i++) await page.waitForTimeout(200);
  const macCard = page.getByRole('article', { name: 'Mac', exact: true });
  const captainCell = (await macCard.locator('.stats > div').first().locator('dd').textContent()).trim();
  await nav(page, '队长');
  await page.locator('#message').fill('继续上次的任务');
  const sendDisabled = await page.locator('#send').isDisabled();
  const hint = (await page.locator('#send-hint').textContent()).trim();
  assert.deepEqual(errors, []);
  assert.equal(captainCell, '已退出', 'the desktop names this state 已退出');
  assert.equal(sendDisabled, true, `send stays off for an exited 队长 (hint: "${hint}")`);
  assert.match(hint, /队长终端已经退出/);
});
