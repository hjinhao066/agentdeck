const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The 派给 picker in 队长's composer: choosing 网页版 ChatGPT, the public-research
// notice, and the serial web queue showing 排队中 instead of 干活中.
// The page is the fake CLI in fixtures/fake-chatgpt-web.js; nothing reaches ChatGPT.
// Set AGENTDECK_WEB_DISPATCH_SHOTS to a folder to keep PNGs (prefix from AGENTDECK_WEB_DISPATCH_SHOT_PREFIX, default "after").
const ROOT = path.resolve(__dirname, '../..');
const shots = process.env.AGENTDECK_WEB_DISPATCH_SHOTS;
const shotPrefix = process.env.AGENTDECK_WEB_DISPATCH_SHOT_PREFIX || 'after';
let app, page, profile, eventsDir, captain;
test.describe.configure({ mode: 'serial' });

function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}
function events() {
  const file = path.join(eventsDir, 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
const begins = () => events().filter((e) => e.event === 'begin').map((e) => e.scenario);
const webCols = () => page.evaluate(() => columns.filter((c) => c.executor === 'chatgpt-web').map((c) => ({ id: c.id, cmd: c.cmd, webMode: c.webMode, seatDir: c.claudeConfigDir || '' })));
const taskOf = (id) => page.evaluate((colId) => config.mainSession.tasks.findLast((t) => t.colId === colId), id);
const composer = () => page.locator(`.column[data-col-id="${captain}"] .composer`);
const route = () => composer().locator('.cp-route');
const note = () => composer().locator('.cp-web-note');
const toast = () => page.locator('#toast');
async function shot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${shotPrefix}-${name}.png`), animations: 'disabled', scale: 'css' });
}
async function pick(label) {
  await route().click();
  await composer().getByRole('menuitemradio', { name: label }).click();
}

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-web-dispatch-ui-'));
  eventsDir = path.join(profile, 'web-events');
  fs.mkdirSync(eventsDir);
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, globalViewMode: 'chat', perpetualCaptain: { enabled: false }, resumeOnRestart: false,
    columns: [{ id: 'web-ui-idle-shell', title: 'Shell', cmd: '', cwd: profile, role: 'manual' }],   // no starter agents
  }));
  const executable = process.env.AGENTDECK_TEST_EXECUTABLE;
  app = await electron.launch({ executablePath: executable || undefined,
    args: [...(executable ? [] : [ROOT]), '--test-user-data=' + profile],
    env: isolatedEnv({
      AGENTDECK_TEST_CHATGPT_WEB_CLI: path.join(__dirname, 'fixtures/fake-chatgpt-web.js'),
      AGENTDECK_TEST_CHATGPT_WEB_COOLDOWN_MS: '200',
      AGENTDECK_TEST_CHATGPT_WEB_EVENTS_DIR: eventsDir,
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => typeof MainSession === 'object' && typeof TaskBoard === 'object' && typeof ChatUI === 'object');
  await page.evaluate((cwd) => MainSession.create('', cwd), profile);
  captain = await page.evaluate(() => MainSession.mainCol().id);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), captain)).toBe(true);
  await page.evaluate(() => TaskBoard.autoVerify(false));
  // setMode is a no-op until the column's chat view is mounted, and a new 队长 column is
  // jumped to in terminal view once its terminal is up: wait for that, then switch.
  await expect.poll(() => page.evaluate((id) => focusedId === id && !!terms.get(id)?.term, captain), { timeout: 60000 }).toBe(true);
  await expect.poll(async () => {
    await page.evaluate((id) => { if (!ChatUI.isChatMode(id)) ChatUI.setMode(id, 'chat'); }, captain);
    await page.waitForTimeout(500);   // still in chat view half a second later
    return page.evaluate((id) => ChatUI.isChatMode(id), captain);
  }, { timeout: 60000 }).toBe(true);
  await expect(composer().locator('textarea')).toBeVisible();
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('队长 composer offers 网页版 ChatGPT by keyboard, with 普通 and Deep Research', async () => {
  await shot('1-composer-default-dark');
  await expect(route()).toHaveText('派给：队长');
  await expect(route()).toHaveAttribute('aria-haspopup', 'menu');
  await expect(route()).toHaveAttribute('aria-expanded', 'false');
  await expect(route()).toHaveAttribute('aria-label', /选择派给谁/);
  await expect(note()).toBeHidden();
  // only 队长's composer has it
  expect(await page.locator('.cp-route').count()).toBe(1);

  await composer().locator('textarea').focus();
  await page.keyboard.press('Shift+Tab');   // 派给 sits just before the text in tab order? walk to it
  await route().focus();
  await page.keyboard.press('Enter');
  await expect(route()).toHaveAttribute('aria-expanded', 'true');
  const items = composer().getByRole('menuitemradio');
  await expect(items).toHaveText([/队长安排/, /网页版 ChatGPT · 普通/, /网页版 ChatGPT · Deep Research/]);
  await expect(items.nth(0)).toBeFocused();
  await expect(items.nth(0)).toHaveAttribute('aria-checked', 'true');
  await shot('2-picker-open-dark');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(composer().locator('.cp-menu')).toBeHidden();
  await expect(route()).toBeFocused();
  await expect(route()).toHaveText('派给：队长');

  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');     // wraps to the last one
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(route()).toHaveText('网页版 ChatGPT · Deep Research');
  await expect(route()).toBeFocused();
});

test('choosing it shows the public-research warning, explains no seat / no launch command, and can be undone with an icon button', async () => {
  await expect(note()).toBeVisible();
  await expect(note()).toContainText('仅用于公开调研：任务内容会发到 ChatGPT 网页，不要包含密钥、隐私或内部信息。');
  await expect(note()).toContainText('不占 Claude 席位，也不能改启动命令');
  await expect(note().locator('.cp-web-busy')).toBeHidden();
  const attach = composer().locator('.cp-icon.attach');
  await expect(attach).toBeDisabled();
  await expect(attach).toHaveAttribute('title', /不能带文件/);
  await expect(composer().locator('textarea')).toHaveAttribute('placeholder', /公开调研的问题/);
  await expect(composer().locator('.cp-btn.send')).toHaveAttribute('aria-label', /派给网页版 ChatGPT/);
  await composer().locator('textarea').fill('各国对瓶装水冰点标注的公开规定有哪些？');
  await shot('3-web-selected-dark');
  await page.evaluate(() => applyTheme('light'));
  await shot('3-web-selected-light');
  await page.evaluate(() => applyTheme('dark'));
  await composer().locator('textarea').fill('');

  // the way back is an icon button with a tooltip, a name and a real hit area
  const back = note().getByRole('button', { name: '改回交给队长' });
  await expect(back).toHaveAttribute('title', '改回交给队长');
  await expect(back.locator('svg')).toHaveCount(1);
  expect((await back.innerText()).trim()).toBe('');
  const box = await back.boundingBox();
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(28);
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(note()).toBeHidden();
  await expect(route()).toHaveText('派给：队长');
  await expect(attach).toBeEnabled();
  await expect(composer().locator('textarea')).toBeFocused();
  await expect(composer().locator('textarea')).toHaveAttribute('placeholder', /告诉队长要做什么/);
});

test('a question that looks like it holds a credential is refused, kept in the box and never sent', async () => {
  await pick(/网页版 ChatGPT · 普通/);
  const ta = composer().locator('textarea');
  await ta.fill('password = hunter2hunter2 是不是常见弱口令？');
  await ta.press('Enter');
  await expect(toast()).toContainText('疑似含凭据');
  await expect(ta).toHaveValue('password = hunter2hunter2 是不是常见弱口令？');
  await expect(route()).toHaveText('网页版 ChatGPT · 普通');
  expect(await webCols()).toEqual([]);
  expect(begins()).toEqual([]);
  await ta.fill('');
});

test('the first request starts; a second one while it runs says 排队中 on the card, the column dot and the sidebar until its turn', async () => {
  const ta = composer().locator('textarea');
  await ta.fill('[FIRST] 水在标准大气压下的冰点是多少？\n只用公开资料。');
  await ta.press('Shift+Enter');   // a new line, not a send
  expect(await webCols()).toEqual([]);
  await ta.fill('[FIRST] 水在标准大气压下的冰点是多少？\n只用公开资料。');
  await ta.press('Enter');
  await expect(toast()).toContainText('已派给网页版 ChatGPT');
  await expect(ta).toHaveValue('');
  await expect(route()).toHaveText('派给：队长');   // one request per choice
  await expect.poll(async () => (await webCols()).length).toBe(1);
  const [first] = await webCols();
  expect(first).toMatchObject({ cmd: 'chatgpt-web', webMode: 'chat', seatDir: '' });
  await expect.poll(begins, { timeout: 15000 }).toEqual(['FIRST']);
  await expect.poll(async () => (await taskOf(first.id)).webPhase).toBe('running');
  const card = (id) => page.locator(`.column[data-col-id="${captain}"] .task-card`).filter({ has: page.locator('.task-title', { hasText: id }) });
  const firstCard = card('[FIRST]');
  // the cards sit behind one folded 派活与回执 line: open it
  const run = page.locator(`.column[data-col-id="${captain}"] .task-run`);
  await expect(run).toBeVisible();
  if (!(await firstCard.isVisible())) await run.click();
  await expect(firstCard.locator('.task-status')).toHaveText('干活中');
  await expect(page.locator(`.column[data-col-id="${first.id}"] .dot`)).toHaveClass('dot working');

  // the picker says up front that this one will wait
  await pick(/Deep Research/);
  await expect(note().locator('.cp-web-busy')).toHaveText('现在有 1 件网页调研在跑，这件会排队，轮到它才发出去。');
  await ta.fill('[SECOND] 海水为什么比淡水更难结冰？');
  await shot('4-will-queue-dark');
  await ta.press('Enter');
  await expect(toast()).toContainText('排队中：前面还有 1 件网页调研');
  await expect.poll(async () => (await webCols()).length).toBe(2);
  const second = (await webCols())[1];
  expect(second).toMatchObject({ cmd: 'chatgpt-web', webMode: 'deep-research', seatDir: '' });
  await expect.poll(async () => (await taskOf(second.id))?.webPhase).toBe('queued');
  expect((await taskOf(second.id)).status).toBe('working');   // unchanged for the queue logic underneath

  const secondCard = card('[SECOND]');
  await expect(secondCard.locator('.task-status')).toHaveText('排队中');
  await expect(secondCard).toHaveClass(/web-queued/);
  // the folded line above the cards counts it as waiting, not as running
  await expect(run).toContainText('1 进行中');
  await expect(run).toContainText('1 排队');
  await expect(secondCard.locator('.task-summary')).toContainText('排队');
  await expect(firstCard.locator('.task-status')).toHaveText('干活中');
  const dot = page.locator(`.column[data-col-id="${second.id}"] .dot`);
  await expect(dot).toHaveClass('dot working web-queued');
  await expect(dot).toHaveAttribute('title', '排队中：前面还有网页调研在跑');
  const navDot = page.locator(`.colnav-item[data-col-id="${second.id}"] .cn-dot`);
  if (await navDot.count()) await expect(navDot).toHaveAttribute('title', '排队中：前面还有网页调研在跑');
  expect(begins()).toEqual(['FIRST']);   // the fake page has only been opened once
  await shot('5-queued-dark');
  await page.evaluate(() => applyTheme('light'));
  await shot('5-queued-light');
  await page.evaluate(() => applyTheme('dark'));

  // its turn comes: no longer 排队中
  fs.writeFileSync(path.join(eventsDir, 'release-FIRST'), 'release');
  await expect.poll(async () => (await taskOf(first.id))?.status, { timeout: 15000 }).toBe('done');
  await expect.poll(begins, { timeout: 15000 }).toEqual(['FIRST', 'SECOND']);
  await expect.poll(async () => (await taskOf(second.id))?.webPhase).toBe('running');
  await expect(secondCard.locator('.task-status')).toHaveText('干活中');
  await expect(secondCard).not.toHaveClass(/web-queued/);
  await expect(dot).toHaveClass('dot working');
  await expect(dot).toHaveAttribute('title', '干活中…');
  await shot('6-second-running-dark');
  fs.writeFileSync(path.join(eventsDir, 'release-SECOND'), 'release');
  await expect.poll(async () => (await taskOf(second.id))?.status, { timeout: 15000 }).toBe('done');
  const receipt = (await taskOf(second.id)).receipt;
  const report = receipt.files.find((file) => file.endsWith('.md'));
  expect(JSON.parse(fs.readFileSync(report + '.meta.json', 'utf8')).selectedMode).toBe('deep-research');
  expect(events().map((e) => e.event + ':' + e.scenario)).toEqual(['begin:FIRST', 'end:FIRST', 'begin:SECOND', 'end:SECOND']);
});

test('a message with the picker on 队长 still goes to 队长, not to the web', async () => {
  const before = (await webCols()).length;
  const ta = composer().locator('textarea');
  await ta.fill('echo captain-still-gets-this');
  await ta.press('Enter');
  await expect(ta).toHaveValue('');
  await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term, 60), captain)).toContain('captain-still-gets-this');
  expect((await webCols()).length).toBe(before);
  expect(begins()).toEqual(['FIRST', 'SECOND']);
});

test('editing a 网页版 ChatGPT session locks the launch command and says why', async () => {
  const [web] = await webCols();
  await page.evaluate((id) => openDialog(columns.findIndex((c) => c.id === id)), web.id);
  const dialog = page.locator('#colDialog');
  await expect(dialog.locator('#cmdInput')).toBeDisabled();
  await expect(dialog.locator('#cmdInput')).toHaveValue('chatgpt-web');
  for (const preset of await dialog.locator('.preset').all()) await expect(preset).toBeDisabled();
  await expect(dialog.locator('#cmdLockedHint')).toHaveText('网页版 ChatGPT：走本机已登录的 ChatGPT 网页，不占 Claude 席位，也不能改启动命令。');
  await shot('7-edit-locked-dark');
  await dialog.locator('#dlgCancel').click();
  // an ordinary session is unaffected
  await page.evaluate((id) => openDialog(columns.findIndex((c) => c.id === id)), captain);
  await expect(dialog.locator('#cmdInput')).toBeEnabled();
  await expect(dialog.locator('#cmdLockedHint')).toBeHidden();
  await dialog.locator('#dlgCancel').click();
});
