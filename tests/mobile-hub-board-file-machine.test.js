'use strict';
// A file path in a 看板 card opens from the computer that ran the card. Both computers
// sync the same board, and Core.mergeCards keeps `seenOn` (the copy updated last; a tie
// goes to Mac), which says nothing about where the work ran. The card's claim does:
// dispatch_claim.owner, shown on the card as 「Windows 领取」.
// Headless Chromium: run through scripts/e2e-queue.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openHub, nav, withRelay } = require('./fixtures/hub-page');

test('a path in a card Windows claimed is read from Windows, not from the computer that synced the card last', { timeout: 120000 }, async (t) => {
  const machines = withRelay();
  const stamp = new Date(Date.now() - 5 * 60000).toISOString();
  const card = { id: 'win-report', project: '资料整理', title: 'Windows 上整理的报告', detail: '', status: 'review', flag: null, order: 0, archived: false, updated: stamp,
    assignee: { agent: 'codex', model: 'gpt' }, dispatch_claim: { key: 'k9', owner: 'OWENJH', delivered: true },
    latest_receipt: '报告写好了：C:\\Users\\someone\\reports\\weekly\\summary.md' };
  // The same synced card on both computers.
  for (const m of machines) m.cards = [...m.cards, { ...card }];
  const opened = await openHub(t, { machines });
  if (!opened) return;
  const { hub, page, errors } = opened;
  await nav(page, '看板');
  const taskCard = page.locator('.task-card', { hasText: 'Windows 上整理的报告' });
  await taskCard.getByText('Windows 领取').waitFor();
  await taskCard.locator('a.file-link').click();
  const asked = (id) => hub.machines[id].requests.filter((r) => r.method === 'POST' && r.url === `/${id}/api/file`).length;
  for (let i = 0; i < 50 && !asked('mac') && !asked('win'); i++) await page.waitForTimeout(100);
  assert.deepEqual(errors, []);
  assert.deepEqual({ mac: asked('mac'), win: asked('win') }, { mac: 0, win: 1 }, 'the card says 「Windows 领取」: its files are on Windows');
});
