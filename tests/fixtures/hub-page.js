'use strict';
// The real phone hub page in a headless Chromium (no window, no focus taken) at phone
// width, against the fake machines of hub-proxy.js. For node --test files that need the
// page itself; run them through the machine queue (scripts/e2e-queue.js). Without a
// Chromium (npm test before `playwright install`) the test is skipped.
const { startHub, withRelay } = require('./hub-proxy');

async function openHub(t, { machines = withRelay(), login = ['mac', 'win'] } = {}) {
  let chromium;
  try { ({ chromium } = require('@playwright/test')); } catch { t.skip('@playwright/test not installed'); return null; }
  let browser;
  try { browser = await chromium.launch({ headless: true }); } catch (e) { t.skip(`chromium unavailable: ${e.message.split('\n')[0]}`); return null; }
  const hub = await startHub({ machines });
  t.after(async () => { await browser.close(); await hub.close(); });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(hub.url + '/');
  for (const id of login) await signIn(page, hub, id);
  return { hub, page, errors };
}
async function signIn(page, hub, id) {
  const fake = hub.machines[id], card = page.getByRole('article', { name: fake.label, exact: true });
  await card.getByLabel(`${fake.label} 的登录 token`).fill(fake.token);
  await card.getByRole('button', { name: `登录 ${fake.label}`, exact: true }).click();
  await card.locator('.pill').getByText('在线').waitFor();
}
const nav = (page, name) => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const refresh = (page) => page.getByRole('button', { name: '刷新全部电脑', exact: true }).click();

module.exports = { openHub, signIn, nav, refresh, withRelay };
