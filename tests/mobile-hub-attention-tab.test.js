'use strict';
// The hub opens on the tab the user left, and …/#<tab> opens that tab (app.js TABS).
// 待我处理 ('attention') is a tab like the others.
// Headless Chromium: run through scripts/e2e-queue.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openHub, nav } = require('./fixtures/hub-page');

// The tab shown once the page has started (start() picks it right after the machine cards).
async function shownAfterLoad(page) {
  await page.locator('#machine-cards .machine-card').first().waitFor({ state: 'attached' });
  return page.evaluate(() => [...document.querySelectorAll('main > .view')].filter((v) => !v.hidden).map((v) => v.id).join(','));
}

test('待我处理 is remembered across a reload like the other tabs, and #attention opens it', { timeout: 120000 }, async (t) => {
  const opened = await openHub(t);
  if (!opened) return;
  const { hub, page, errors } = opened;
  // 待办 as a control.
  await nav(page, '待办');
  await page.reload();
  const todo = await shownAfterLoad(page);
  await nav(page, '待我处理');
  await page.reload();
  const attention = await shownAfterLoad(page);
  // A bookmark, with another tab remembered.
  await nav(page, '待办');
  await page.goto(hub.url + '/#attention');
  await page.reload();
  const bookmark = await shownAfterLoad(page);
  assert.deepEqual(errors, []);
  assert.equal(todo, 'todo-view', 'control: 待办 is remembered');
  assert.equal(attention, 'attention-view', '待我处理 is remembered across a reload');
  assert.equal(bookmark, 'attention-view', '…/#attention opens 待我处理');
});
