const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Schedule's watched tasks: a task another scheduler runs is listed with how
// many of its suggestions wait on the user, opens to its latest report, takes
// 做 / 不做 per suggestion, tells 队长, and keeps working while the machine
// holding its data is out of reach.
// Everything is a copy of tests/fixtures/schedule-feed inside the test profile:
// a --test-user-data profile reads task descriptions only from
// <profile>/schedule-home, and beforeAll stops the run if anything else is
// listed. No real task folder, mirror or decisions file is read or written.
// Set AGENTDECK_SCREENSHOT_DIR to keep PNGs (dark and light).
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'schedule-feed');
const shots = process.env.AGENTDECK_SCREENSHOT_DIR;
let application, page, profile, root, mirror, flag;
test.describe.configure({ mode: 'serial' });

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const decisions = () => readJson(path.join(root, 'decisions.json')).decisions.map((d) => `${d.id} ${d.decision} ${d.reason}`);
const journal = () => readJson(path.join(profile, 'schedule-feeds', 'e2e-radar', 'journal.json')).entries;
const toCaptain = () => {
  const file = path.join(profile, 'delivered-columns.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((p) => p.colId === 'captain').map((p) => p.text.replace(/\s+/g, '')) : [];
};
function copyStore(to) {
  fs.mkdirSync(path.join(to, 'reports'), { recursive: true });
  for (const name of fs.readdirSync(path.join(FIXTURE, 'reports'))) fs.copyFileSync(path.join(FIXTURE, 'reports', name), path.join(to, 'reports', name));
  fs.copyFileSync(path.join(FIXTURE, 'decisions.json'), path.join(to, 'decisions.json'));
}
function snapshot(dir) {
  const out = {};
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
  });
  walk(dir);
  return out;
}
const feedCard = () => page.locator('.sched-card.sx-card[data-feed-id="e2e-radar"]');
const item = (id) => page.locator(`.sx-item[data-item-id="${id}"]`);
const fact = (label) => page.locator('.sx-fact', { has: page.locator('.sx-fact-label', { hasText: label }) }).locator('.sx-fact-value');
// The test window sits under the real pointer: park Playwright's own somewhere blank first.
async function quiet() {
  await page.mouse.move(700, 8);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}
async function shoot(name, prepare) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    if (prepare) await prepare();
    await page.evaluate(() => toastEl.classList.remove('show'));   // an unrelated notice must not sit on the picture
    await quiet();
    await page.waitForTimeout(450);   // the theme change fades colours in
    await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => applyTheme('dark'));
}
// Nothing on the page may be cut off with an ellipsis or spill out of its box.
const clipped = (selector) => page.locator(selector).evaluateAll((nodes) => nodes
  .filter((n) => n.scrollWidth > n.clientWidth + 1 || n.getBoundingClientRect().right > document.getElementById('pageView').getBoundingClientRect().right + 1)
  .map((n) => n.textContent.slice(0, 40)));

test.beforeAll(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-schedule-radar-')));
  root = path.join(profile, 'radar', 'root');
  mirror = path.join(profile, 'radar', 'mirror');
  flag = path.join(profile, 'radar', 'unreachable');
  copyStore(root);
  copyStore(mirror);
  const copied = new Date(Date.now() - 3 * 3600_000);
  for (const file of Object.keys(snapshot(mirror))) fs.utimesSync(path.join(mirror, file), copied, copied);
  const jobs = readJson(path.join(FIXTURE, 'jobs.json'));
  Object.assign(jobs.jobs.find((j) => j.id === 'radar01'), {
    last_run_at: new Date(Date.now() - 16 * 3600_000).toISOString(), next_run_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
  });
  fs.writeFileSync(path.join(profile, 'radar', 'jobs.json'), JSON.stringify(jobs));
  const schedules = path.join(profile, 'schedule-home', '.agents', 'schedules');
  fs.mkdirSync(schedules, { recursive: true });
  fs.writeFileSync(path.join(schedules, 'radar.json'), JSON.stringify({
    id: 'e2e-radar', name: 'AgentDeck 竞品与灵感雷达', label: '雷达',
    about: '每天找和 AgentDeck 类似的项目和功能，看过的不再重复，出一份日报：建议做的几条，和看过但不建议的。只提建议，不会自己开工。',
    runner: 'Windows 上的 Hermes', when: { time: '20:30', timeZone: 'America/Los_Angeles' },
    source: { root }, mirror, job: { file: path.join(profile, 'radar', 'jobs.json'), id: 'radar01' },
    decide: [process.execPath, path.join(FIXTURE, 'decide.js'), root, flag, '--id', '{id}', '--decision', '{decision}', '--reason', '{reason}'],
  }));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, resumeOnRestart: false,
    columns: [
      { id: 'captain', title: '队长', cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true },
      { id: 'sr-a', taskId: 'task-sr-a', title: '日报对话', cmd: FAKE, cwd: profile, width: 460, role: 'manual' },
    ],
    mainSession: { colId: 'captain', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks: [] },
    schedules: [{ id: 'own-daily', name: '整理昨天的提交', prompt: 'summarize yesterday', target: 'sr-a', kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5], enabled: true, nextAt: Date.now() + 6 * 3600_000 }],
  }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'delivered-columns.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(2);
  await page.waitForFunction(() => typeof columns !== 'undefined' && typeof ChatUI !== 'undefined' && columns.every((col) => terms.get(col.id)?.wrap?.isConnected));
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(2);
  const listed = await page.evaluate(() => window.deck.scheduleFeeds(false));
  if (!listed.ok || listed.feeds.length !== 1 || listed.feeds[0].id !== 'e2e-radar') {
    throw new Error('Watched tasks are not confined to the test profile; refusing to record decisions');
  }
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('the task is listed with its timetable, its last run and how many suggestions wait', async () => {
  await page.locator('.nav-row[data-nav="schedule"]').click();
  const card = feedCard();
  await expect(card).toBeVisible();
  await expect(card.locator('.sched-name')).toHaveText('AgentDeck 竞品与灵感雷达');
  await expect(card.locator('.sx-about')).toContainText('只提建议，不会自己开工');
  await expect(card.locator('.sx-need')).toHaveText('待你审核 4 条');          // both issues, not only the newest
  await expect(card.locator('.chip', { hasText: '每天 20:30' })).toBeVisible();
  await expect(card.locator('.chip', { hasText: 'Windows 上的 Hermes' })).toBeVisible();
  await expect(card.locator('.chip', { hasText: /^下次 / })).toBeVisible();
  await expect(card.locator('.chip.st-ok')).toHaveText(/^上次 .+ · 成功$/);
  await expect(card.locator('.chip.sx-off')).toHaveCount(0);
  // AgentDeck's own schedules keep their place, switch and buttons
  await expect(page.locator('.sched-group h2')).toHaveText(['在别处运行', '由 AgentDeck 发送']);
  const own = page.locator('.sched-card[data-schedule-id="own-daily"]');
  await expect(own.locator('.switch.on')).toBeVisible();
  await expect(own.locator('.btn', { hasText: '立即运行' })).toBeVisible();
  await expect(page.locator('#pageView')).not.toContainText(/全部采纳|一键/);
  expect(await clipped('.sx-card .sched-name, .sx-card .sx-about, .sx-card .chip span, .sx-need')).toEqual([]);
  await shoot('01-list-pending');
});

test('the task opens to what it is, when it runs, and its latest report with clickable links', async () => {
  await feedCard().locator('.sched-open').click();
  const detail = page.locator('.sx-detail[data-feed-id="e2e-radar"]');
  await expect(detail).toBeVisible();
  await expect(page.locator('.page-titles h1')).toHaveText('AgentDeck 竞品与灵感雷达');
  await expect(page.locator('.page-titles p')).toContainText('每天找和 AgentDeck 类似的项目和功能');
  await expect(page.locator('.sx-kicker')).toHaveText('Windows 上的 Hermes · 每天 20:30');
  await expect(fact('下次运行')).toHaveText(/\d\d:\d\d$/);
  await expect(fact('上次运行')).toHaveText(/\d\d:\d\d$/);
  await expect(fact('上次结果')).toHaveText('成功');
  await expect(fact('待你审核')).toHaveText('4 条');
  await expect(page.locator('.sx-banner')).toHaveCount(0);
  await expect(page.locator('.sx-fresh').first()).toHaveText(/^已是最新 · 读取于 /);

  const report = page.locator('.sx-report[data-date="2026-10-05"]');
  await expect(report.locator('.sx-report-title')).toHaveText('竞品与灵感雷达 · 2026-10-05');
  await expect(report.locator('.sx-lead')).toContainText('建议补三处');
  await expect(report.locator('.sx-items-head h3')).toHaveText('建议做的 3 条');
  await expect(report.locator('.sx-items-count')).toHaveText('还有 3 条等你决定');
  await expect(report.locator('.sx-item')).toHaveCount(3);
  await expect(report.locator('.sx-item[data-state="open"]')).toHaveCount(3);
  const first = item('ADR-0002');
  await expect(first.locator('.sx-item-id')).toHaveText('ADR-0002');
  await expect(first.locator('.sx-item-title')).toHaveText('任务卡给出完成证据，并把审过、已合入、已交付分开');
  await expect(first.locator('.sx-rows dt')).toHaveText(['借鉴', '改什么', '用户好处', '工作量', '队长建议']);
  await expect(first.locator('.sx-rows dd').nth(1)).toContainText('首期只做只读展示');
  // two worded choices and an optional reason per suggestion; nothing that decides them all at once
  for (const id of ['ADR-0002', 'ADR-0003', 'ADR-0004']) {
    await expect(item(id).locator('.sx-decide .btn')).toHaveText(['做', '不做']);
    await expect(item(id).locator('.sx-reason')).toHaveAttribute('placeholder', /不写也行/);
  }
  await expect(page.locator('#pageView')).not.toContainText(/全部采纳|一键/);

  // links open like every other link in the app: a click previews in the side pane
  await page.evaluate(() => { window.__opened = []; window.__openLink = SidePane.openLink; SidePane.openLink = (m) => window.__opened.push(m.text); });
  await first.locator('.sx-rows a', { hasText: 'deckhand' }).click();
  const passed = report.locator('.sx-md table');
  await expect(passed.locator('th')).toHaveText(['项目', '原因']);
  await expect(passed.locator('tbody tr')).toHaveCount(2);
  await passed.locator('a', { hasText: 'tasktrail' }).click();
  await report.locator('.sx-more summary').click();
  await report.locator('.sx-more a', { hasText: 'quotalens' }).click();
  expect(await page.evaluate(() => window.__opened)).toEqual(['https://example.invalid/acme/deckhand', 'https://example.invalid/acme/tasktrail', 'https://example.invalid/acme/quotalens']);
  await page.evaluate(() => { SidePane.openLink = window.__openLink; });
  await report.locator('.sx-more summary').click();

  // tool actions are icon buttons with a tooltip, a name and a focus ring
  for (const [selector, name] of [['.sx-back', '回到定时任务列表'], ['[data-fk="refresh"]', '刷新：重新读取最新结果'], ['[data-fk="older"]', '上一期'], ['[data-fk="newer"]', '下一期']]) {
    const b = page.locator(selector);
    await expect(b).toHaveAttribute('aria-label', name);
    await expect(b).toHaveAttribute('title', new RegExp('^' + name));
    await expect(b).toHaveText('');
    await expect(b.locator('svg')).toHaveCount(1);
  }
  await page.locator('[data-fk="refresh"]').focus();
  await expect(page.locator('[data-fk="refresh"]')).toBeFocused();
  const ringed = await page.evaluate(() => [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((r) => /:focus-visible/.test(r.selectorText || '')).map((r) => r.selectorText));
  for (const selector of ['.tool-action:focus-visible', '.page-close:focus-visible', '.sched-open:focus-visible', '.sx-decide .btn:focus-visible']) expect(ringed).toContain(selector);
  expect(await clipped('.sx-item-title, .sx-rows dd, .sx-fact-value, .sx-kicker, .sx-md td, .page-titles h1')).toEqual([]);
  await shoot('02-detail', () => page.evaluate(() => { document.activeElement?.blur(); document.getElementById('pageView').scrollTop = 0; }));

  // earlier issues: the picker says which ones still wait; a report without a structured twin reads the same
  const pick = page.locator('.sx-issue');
  await expect(pick.locator('option')).toHaveText(['2026-10-05（最新） · 待审核 3 条', '2026-10-04 · 待审核 1 条']);
  await expect(page.locator('[data-fk="newer"]')).toBeDisabled();
  await page.locator('[data-fk="older"]').click();
  const old = page.locator('.sx-report[data-date="2026-10-04"]');
  await expect(old.locator('.sx-item')).toHaveCount(1);
  await expect(item('ADR-0001').locator('.sx-md')).toContainText('队长建议：建议做');
  await expect(item('ADR-0001').locator('.sx-decide .btn')).toHaveText(['做', '不做']);
  await expect(page.locator('[data-fk="older"]')).toBeDisabled();
  await pick.selectOption('2026-10-05');
  await expect(page.locator('.sx-report[data-date="2026-10-05"] .sx-item')).toHaveCount(3);

  // Esc steps back to the list before it closes the page
  await page.locator('[data-fk="refresh"]').focus();
  await page.keyboard.press('Escape');
  await expect(feedCard()).toBeVisible();
  await expect(feedCard().locator('.sched-open')).toBeFocused();
});

test('做 with a reason is written by the task\'s own command, reaches 队长, and can be changed', async () => {
  const columnsBefore = await page.evaluate(() => columns.map((c) => c.id));
  await feedCard().locator('.sched-open').click();
  const it = item('ADR-0002');
  await it.locator('.sx-reason').fill('现在最缺交付证据');
  await it.locator('.sx-decide .btn', { hasText: /^做$/ }).click();
  await expect(it).toHaveAttribute('data-state', 'accepted');
  await expect(it.locator('.sx-verdict')).toHaveText('已决定：做');
  await expect(it.locator('.sx-decided-when')).toHaveText(/^今天 \d\d:\d\d$/);
  await expect(it.locator('.sx-decided-reason')).toHaveText('理由：现在最缺交付证据');
  await expect(it.locator('.sx-decide')).toHaveCount(0);
  await expect.poll(decisions).toEqual(['ADR-0002 accepted 现在最缺交付证据']);
  await expect.poll(toCaptain, { timeout: 20000 }).toContainEqual(expect.stringMatching(/^雷达审核：做ADR-0002「任务卡给出完成证据，并把审过、已合入、已交付分开」，理由：现在最缺交付证据。.*2026-10-05期.*已经写进「AgentDeck竞品与灵感雷达」的决定文件.*不要因此自动开卡或开工/));
  await expect(it.locator('.sx-tag')).toHaveCount(0);            // written and told: nothing left waiting
  await expect(fact('待你审核')).toHaveText('3 条');
  await expect(page.locator('.sx-items-count')).toHaveText('还有 2 条等你决定');
  await expect(page.locator('.sx-issue option').first()).toHaveText('2026-10-05（最新） · 待审核 2 条');

  // the other choice, without a reason
  const other = item('ADR-0004');
  await other.locator('.sx-decide .btn', { hasText: '不做' }).click();
  await expect(other).toHaveAttribute('data-state', 'rejected');
  await expect(other.locator('.sx-verdict')).toHaveText('已决定：不做');
  await expect(other.locator('.sx-decided-reason')).toHaveCount(0);
  await expect.poll(decisions).toEqual(['ADR-0002 accepted 现在最缺交付证据', 'ADR-0004 rejected ']);
  await expect.poll(toCaptain, { timeout: 20000 }).toContainEqual(expect.stringMatching(/^雷达审核：不做ADR-0004「.+」，没写理由。/));
  await shoot('03-decided', () => page.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sx-items-head').scrollIntoView(); }));

  // a change of mind: the pencil reopens the two choices with the old reason
  const change = it.locator('[data-fk="change:ADR-0002"]');
  await expect(change).toHaveAttribute('aria-label', '改主意：重新决定 ADR-0002');
  await expect(change).toHaveText('');
  await change.click();
  await expect(it.locator('.sx-reason')).toBeFocused();
  await expect(it.locator('.sx-reason')).toHaveValue('现在最缺交付证据');
  await expect(it.locator('[data-fk="keep:ADR-0002"]')).toHaveAttribute('aria-label', '不改了');
  await it.locator('.sx-reason').fill('先做工作区那条');
  await it.locator('.sx-decide .btn', { hasText: '不做' }).click();
  await expect(it).toHaveAttribute('data-state', 'rejected');
  await expect(it.locator('.sx-decided-reason')).toHaveText('理由：先做工作区那条');
  await expect.poll(decisions).toEqual(['ADR-0002 accepted 现在最缺交付证据', 'ADR-0004 rejected ', 'ADR-0002 rejected 先做工作区那条']);
  await expect.poll(toCaptain, { timeout: 20000 }).toContainEqual(expect.stringMatching(/^雷达审核：改为不做ADR-0002「/));
  await expect(fact('待你审核')).toHaveText('2 条');

  // a decision is only a record: no session was opened and no card was written for it
  expect(await page.evaluate(() => columns.map((c) => c.id))).toEqual(columnsBefore);
  expect(fs.existsSync(path.join(profile, 'tasks')) ? fs.readdirSync(path.join(profile, 'tasks')).filter((n) => n.endsWith('.json')) : []).toEqual([]);
  expect(await page.evaluate(() => MainSession.state().tasks.length)).toBe(0);
  await page.locator('.sx-back').click();
  await expect(feedCard().locator('.sx-need')).toHaveText('待你审核 2 条');
});

test('out of reach: the kept copy is shown with its age, and a decision waits here without blocking', async () => {
  fs.renameSync(root, root + '.away');                           // the machine holding the data is off
  fs.writeFileSync(flag, '');
  const mirrorBefore = snapshot(mirror);
  const awayBefore = snapshot(root + '.away');
  await feedCard().locator('.sched-open').click();
  const banner = page.locator('.sx-banner[data-state="offline"]');
  await expect(banner.locator('strong')).toHaveText('现在连不上「Windows 上的 Hermes」');
  await expect(banner).toContainText(/下面是这台电脑上存的最近结果，数据截至 (今天|昨天) \d\d:\d\d。/);
  await expect(banner).toContainText('你的决定会先记在这台电脑上，连上后自动写进去，不会丢。');
  await expect(fact('上次结果')).toHaveText('还不知道');          // the copy knows nothing of the last run
  await expect(fact('上次运行')).toHaveText('2026-10-05 那一期');
  await expect(fact('下次运行')).toHaveText(/\d\d:\d\d$/);        // the timetable still stands
  // the report is all there, and what was decided before is still decided
  await expect(page.locator('.sx-report[data-date="2026-10-05"] .sx-item')).toHaveCount(3);
  await expect(item('ADR-0002')).toHaveAttribute('data-state', 'rejected');
  await expect(item('ADR-0004')).toHaveAttribute('data-state', 'rejected');
  await expect(fact('待你审核')).toHaveText('2 条');

  const it = item('ADR-0003');
  await it.locator('.sx-reason').fill('并行编码冲突太多');
  const clicked = Date.now();
  await it.locator('.sx-decide .btn', { hasText: /^做$/ }).click();
  await expect(it).toHaveAttribute('data-state', 'accepted');
  expect(Date.now() - clicked).toBeLessThan(5000);                // shown at once, not after the write gives up
  await expect(it.locator('.sx-verdict')).toHaveText('已决定：做');
  await expect(it.locator('.sx-tag', { hasText: '待同步' })).toBeVisible();
  await expect.poll(() => journal().filter((e) => !e.synced).map((e) => `${e.itemId} ${e.decision} ${e.reason}`)).toEqual(['ADR-0003 accepted 并行编码冲突太多']);
  await expect.poll(toCaptain, { timeout: 30000 }).toContainEqual(expect.stringMatching(/^雷达审核：做ADR-0003「.+」，理由：并行编码冲突太多。.*正本现在连不上，决定先记在这台电脑上.*不要因此自动开卡或开工/));
  await expect(it.locator('.sx-tag', { hasText: '还没告诉队长' })).toHaveCount(0);
  await expect(fact('待你审核')).toHaveText('1 条');
  // the page wrote neither into the copy nor into the task's own folder
  expect(snapshot(mirror)).toEqual(mirrorBefore);
  expect(snapshot(root + '.away')).toEqual(awayBefore);
  expect(await clipped('.sx-banner span, .sx-banner strong, .sx-decided-reason')).toEqual([]);
  await shoot('04-offline', () => page.evaluate(() => { document.activeElement?.blur(); document.getElementById('pageView').scrollTop = 0; }));
  await shoot('05-offline-waiting', () => page.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sx-items-head').scrollIntoView(); }));

  await page.locator('.sx-back').click();
  const card = feedCard();
  await expect(card.locator('.chip.sx-off', { hasText: /^连不上 · 数据截至 / })).toBeVisible();
  await expect(card.locator('.chip.sx-off', { hasText: '1 个决定待同步' })).toBeVisible();
  await expect(card.locator('.sx-need')).toHaveText('待你审核 1 条');
  await shoot('06-list-offline');

  // AgentDeck restarts while the machine is still off: nothing decided is lost
  expect(journal().filter((e) => !e.synced).length).toBe(1);
});

test('back in reach: the waiting decision is written by itself and the notice goes away', async () => {
  fs.renameSync(root + '.away', root);
  fs.rmSync(flag);
  await feedCard().locator('.sched-open').click();
  await expect.poll(decisions, { timeout: 20000 }).toEqual([
    'ADR-0002 accepted 现在最缺交付证据', 'ADR-0004 rejected ', 'ADR-0002 rejected 先做工作区那条', 'ADR-0003 accepted 并行编码冲突太多']);
  await expect(page.locator('.sx-banner')).toHaveCount(0, { timeout: 20000 });
  await expect(item('ADR-0003')).toHaveAttribute('data-state', 'accepted');
  await expect(item('ADR-0003').locator('.sx-tag')).toHaveCount(0);
  await expect(fact('上次结果')).toHaveText('成功');
  await expect(fact('待你审核')).toHaveText('1 条');               // ADR-0001, in the earlier issue
  await expect(page.locator('.sx-items-count')).toHaveText('这一期都决定了');
  await page.locator('.sx-back').click();
  await expect(feedCard().locator('.chip.sx-off')).toHaveCount(0);
  await expect(feedCard().locator('.sx-need')).toHaveText('待你审核 1 条');
});

test('an AgentDeck schedule opens to its prompt, and shows its last reply once it has one', async () => {
  const own = page.locator('.sched-card[data-schedule-id="own-daily"]');
  await own.locator('.sched-open').click();
  const detail = page.locator('.sx-detail[data-schedule-id="own-daily"]');
  await expect(page.locator('.page-titles h1')).toHaveText('整理昨天的提交');
  await expect(page.locator('.sx-kicker')).toHaveText('工作日 09:00 · 日报对话');
  await expect(fact('上次运行')).toHaveText('还没有跑过');
  await expect(detail.locator('.sx-prompt')).toHaveText('summarize yesterday');
  await expect(detail.locator('.sx-section-head h2')).toHaveText(['发送的提示词']);   // no result yet: no empty block
  await expect(detail.locator('.sx-item, .sx-need')).toHaveCount(0);                  // suggestions belong to tasks that have them
  await expect(page.locator('[data-fk="edit"]')).toHaveAttribute('aria-label', '编辑定时任务');

  await page.locator('.page-actions .btn', { hasText: '立即运行' }).click();
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('sr-a').map((t) => t.reply).join('\n')), { timeout: 20000 }).toContain('GOT summarize yesterday');
  await page.locator('.nav-row[data-nav="schedule"]').click();
  await page.locator('.sched-card[data-schedule-id="own-daily"] .sched-open').click();
  await expect(fact('上次结果')).toHaveText('已发送');
  await expect(detail.locator('.sx-section-head h2')).toHaveText(['发送的提示词', '最近结果']);
  await expect(detail.locator('.sx-report')).toContainText('GOT summarize yesterday');
  await shoot('07-own-schedule-detail', () => page.evaluate(() => { document.activeElement?.blur(); }));
  await page.locator('.page-close:not(.sx-back)').click();
  await expect(page.locator('#pageView')).toBeHidden();
});
