const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startHub } = require('../fixtures/hub-proxy');

// 马上派人做 / 排到最前 (docs/task-board-api.md): the two buttons over 移到 in the card
// drawer, the request reaching 队长 on the receipts channel (receipts --wait), the card
// saying 已交给队长 · 等派人 until 队长's `new --task-id` puts a worker on it, the grey
// cases and their reasons, a computer without 队长, and the same two buttons on the
// phone hub. Real renderer, isolated profile, the stand-in agent; the phone runs against
// the hub fixture. Set AGENTDECK_DISPATCH_SHOTS to keep PNGs of both themes.
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_DISPATCH_SHOTS;
let application, page, profile, control;

async function keep(target, name, options = {}) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await target.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css', ...options });
}
const readCard = (id) => fs.readdirSync(path.join(profile, 'tasks')).filter((n) => n.endsWith('.json'))
  .flatMap((n) => JSON.parse(fs.readFileSync(path.join(profile, 'tasks', n), 'utf8')).cards).find((c) => c.id === id);
const captainNotices = () => page.evaluate(() => [...(config.mainSession?.pending || []), ...(config.mainSession?.inflight || [])].filter((p) => p.title === '任务看板').map((p) => p.summary));
const cellIds = (project, status) => page.locator(`.tbv-lane[data-project="${project}"] .tbv-cell[data-status="${status}"] .tbv-card`).evaluateAll((n) => n.map((x) => x.dataset.cardId));
function cli(args) {
  const env = { ...process.env, ...JSON.parse(fs.readFileSync(control, 'utf8')) };
  const file = path.join(profile, 'board-control/tools/agentdeck-board.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (s) => { stdout += s; }); child.stderr.on('data', (s) => { stderr += s; });
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function seed(dir) {
  const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
  let order = 0;
  const card = (id, title, status, extra = {}) => ({ id, project: '客户门户', title, detail: '登录页要防机器人刷接口，先加图形验证码，再看要不要短信。', status, flag: null, order: order++, depends_on: [],
    assignee: null, session_id: null, latest_receipt: '', verify: false, rework_count: 0, created: at(600), updated: at(30), archived: false, important: false, ...extra });
  const cards = [
    card('t-plain', '整理登录页文案', 'todo', { updated: at(80) }),
    card('t-high', '修复支付回调丢单', 'todo', { important: true, updated: at(20) }),
    card('t-now', '给登录页加验证码', 'todo', { updated: at(50) }),
    card('t-next', '补充常见问题', 'todo', { updated: at(70) }),
    card('b-doing', '构建数据工作台界面', 'doing', { session_id: 'w-busy', assignee: { agent: 'claude', model: 'Opus 5.5' }, latest_receipt: '界面骨架已搭好。', updated: at(12) }),
    card('t-ask', '确认密码策略', 'needs_user', { latest_receipt: '密码最短 8 位还是 12 位？', last_event: 'a:ask:command:x', updated: at(5) }),
    card('d-done', '登录接口限流', 'done', { latest_receipt: '完成。', updated: at(240) }),
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '客户门户.json'), JSON.stringify({ version: 1, project: '客户门户', cards }, null, 2));
}

async function launch({ captain = true } = {}) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dispatch-now-'));
  control = path.join(profile, 'control.json');
  seed(path.join(profile, 'tasks'));
  const column = (id, title, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: captain, project: '客户门户', ...extra });
  const worker = column('w-busy', '工作台界面', { boardId: 'b-doing' });
  const now = Date.now();
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 2,
    taskBoard: { dispatcher: 'captain', autoVerify: false }, concurrencyCap: 5,
    columns: captain ? [{ ...column('cap', '队长'), isMain: true, captainCrew: false, project: '' }, worker] : [worker],
    ...(captain ? { mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: [{ id: 'task-w-busy', colId: 'w-busy', gen: 1, status: 'working', sentAt: now - 60_000, startedAt: now - 50_000, turnId: '', project: '客户门户', boardId: 'b-doing', receipt: null }] } } : {}),
  }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_CONTROL_ENV_FILE: control }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  const count = captain ? 2 : 1;
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 20000 }).toBe(count);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 30000 }).toBe(count);
  if (captain) {
    await expect.poll(() => fs.existsSync(control)).toBe(true);
    await expect.poll(() => page.evaluate(() => terms.get('cap').state), { timeout: 30000 }).toBe('done');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  application = null; profile = null;
});

async function openCard(id) {
  await page.locator(`.tbv-card[data-card-id="${id}"]`).click();
  await expect(page.locator('.tbv-detail')).toHaveAttribute('data-card-id', id);
}
// The two buttons sit right above 移到, inside the drawer, at least 28px tall.
async function placement() {
  return page.evaluate(() => {
    const act = document.querySelector('.tbv-d-act'), moves = document.querySelector('.tbv-d-moves').closest('.tbv-d-section');
    const box = (n) => n.getBoundingClientRect();
    return { next: act.nextElementSibling === moves, above: box(act).bottom <= box(moves).top,
      heights: [...act.querySelectorAll('.tbv-act')].map((b) => box(b).height), inside: [...act.querySelectorAll('.tbv-act')].every((b) => box(b).right <= box(document.querySelector('.tbv-detail')).right) };
  });
}

test('desktop: 马上派人做 reaches 队长 on the receipts channel, the card waits for a worker, and 队长\'s new --task-id answers it', async () => {
  await launch();
  await page.locator('#taskBoardBtn').click();
  await expect(page.locator('#taskBoardView')).toBeVisible();
  await page.locator('.tbv-more[data-cell="客户门户/todo"]').click();
  await openCard('t-now');
  const now = page.locator('.tbv-act-now'), next = page.locator('.tbv-act-next');
  await expect(now).toHaveText('马上派人做');
  await expect(now).toBeEnabled();
  await expect(now).toHaveAttribute('title', '交给队长，请它马上派一个队员来做这张卡');
  await expect(next).toHaveText('排到最前');
  await expect(next).toHaveAttribute('aria-pressed', 'false');
  const where = await placement();
  expect(where).toMatchObject({ next: true, above: true, inside: true });
  for (const h of where.heights) expect(h).toBeGreaterThanOrEqual(28);
  // the flag says how it differs from 排到最前
  const flag = await page.locator('.tbv-d-prio').getAttribute('title');
  expect(flag).toContain('高优先级可以标好几张');
  expect(flag).toContain('「排到最前」只给一张');
  await expect(page.locator('.tbv-d-prio')).toHaveAttribute('aria-label', '标为高优先级');
  await keep(page, 'desktop-drawer-dark');
  await page.evaluate(() => applyTheme('light'));
  await keep(page, 'desktop-drawer-light');
  await page.evaluate(() => applyTheme('dark'));

  // a 队长 listening on receipts --wait gets one line; nothing is typed into its box
  const typed = await page.evaluate(() => terms.get('cap').lastScreen || '');
  const listener = cli(['receipts', '--wait', '--timeout', '30']);
  await now.click();
  const heard = await listener;
  expect(heard.code, heard.stderr).toBe(0);
  expect(heard.stdout).toContain('用户要求马上派：给登录页加验证码（t-now）');
  expect(heard.stdout).toContain('new --task-id t-now');
  expect(await page.evaluate(() => terms.get('cap').lastScreen || '')).not.toContain('用户要求马上派');
  expect(typed).not.toContain('用户要求马上派');
  await expect.poll(() => readCard('t-now').dispatch_now?.delivered).toBe(true);
  expect(readCard('t-now').status).toBe('todo');

  // the card and the drawer say it is with 队长, and the button is grey with the reason
  await expect(page.locator('.tbv-act-now')).toHaveText('已交给队长');
  await expect(page.locator('.tbv-act-now')).toBeDisabled();
  await expect(page.locator('.tbv-d-act-why')).toHaveText('已经交给队长了，等它派人');
  await expect(page.locator('.tbv-d-who-name')).toHaveText('已交给队长 · 等派人');
  await expect(page.locator('.tbv-card[data-card-id="t-now"] .tbv-activity')).toHaveText('已交给队长 · 等派人');
  await keep(page, 'desktop-asked-dark');
  // a second click (another way in) changes nothing and tells 队长 nothing new
  const told = (await captainNotices()).length;
  expect(await page.evaluate(() => TaskBoard.dispatchNow('t-now').then((r) => r.outcome))).toBe('pending');
  await page.waitForTimeout(300);
  expect(await captainNotices()).toHaveLength(told);

  // 队长 sends a worker on the card: 谁在做 shows it, the request is gone, the button is grey for that reason
  const sent = await cli(['new', '--task-id', 't-now', '--title', '加验证码', '--task', '给登录页加图形验证码', '--command', FAKE]);
  expect(sent.code, sent.stderr).toBe(0);
  await expect.poll(() => readCard('t-now').session_id || '').not.toBe('');
  await expect.poll(() => readCard('t-now').dispatch_now).toBeUndefined();
  await expect(page.locator('.tbv-d-who-name')).toHaveText('加验证码');
  await expect(page.locator('.tbv-act-now')).toHaveText('马上派人做');
  await expect(page.locator('.tbv-act-now')).toBeDisabled();
  await expect(page.locator('.tbv-d-act-why')).toHaveText('已经有队员在做这张卡了');
  await keep(page, 'desktop-dispatched-dark');
});

test('desktop: grey 马上派人做 with its reason on a card being worked on, waiting on the user, or done', async () => {
  await launch();
  await page.locator('#taskBoardBtn').click();
  await page.locator('.tbv-head[data-status="done"]').click();
  for (const [id, why] of [['b-doing', '已经有队员在做这张卡了'], ['t-ask', '这张卡在等你回答，先回答它'], ['d-done', '这张卡已经完成了，不用再派']]) {
    await openCard(id);
    await expect(page.locator('.tbv-act-now')).toBeDisabled();
    await expect(page.locator('.tbv-act-now')).toHaveAttribute('title', why);
    await expect(page.locator('.tbv-d-act-why')).toHaveText(why);
    await expect(page.locator('.tbv-act-now')).toHaveAttribute('aria-describedby', 'tbv-act-why');
    await expect(page.locator('.tbv-act-next')).toBeDisabled();
    if (id === 'b-doing') await keep(page, 'desktop-grey-doing-dark');
  }
  expect(await page.evaluate(() => TaskBoard.dispatchNow('d-done').then(() => '', (e) => e.message))).toContain('这张卡已经完成了');
  expect(await captainNotices()).toEqual([]);
});

test('desktop: 排到最前 puts the card first with 下一个做, tells 队长 once, and only one card holds it', async () => {
  await launch();
  await page.locator('#taskBoardBtn').click();
  await page.locator('.tbv-more[data-cell="客户门户/todo"]').click();
  expect(await cellIds('客户门户', 'todo')).toEqual(['t-high', 't-plain', 't-now', 't-next']);
  await openCard('t-next');
  await page.locator('.tbv-act-next').click();
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['t-next', 't-high', 't-plain', 't-now']);
  const card = readCard('t-next');
  expect(card.important).toBe(true);
  expect(Date.parse(card.next_up)).toBeGreaterThan(0);
  const mark = page.locator('.tbv-card[data-card-id="t-next"] .tbv-next');
  await expect(mark).toHaveText('下一个做');
  await expect(mark).toHaveAttribute('role', 'img');
  await expect(mark).toHaveAttribute('title', /队长下一个就派它/);
  await expect(page.locator('.tbv-card[data-card-id="t-next"]')).toHaveAttribute('aria-label', /下一个做/);
  await expect(page.locator('.tbv-act-next')).toHaveText('下一个做');
  await expect(page.locator('.tbv-act-next')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tbv-act-next')).toBeDisabled();
  await expect(page.locator('.tbv-act-next')).toHaveAttribute('title', '已经排在最前，队长下一个派它');
  await expect.poll(captainNotices).toEqual([expect.stringMatching(/用户在任务看板把卡片 t-next「补充常见问题」排到了最前（项目：客户门户）：它是下一个要做的/)]);
  await keep(page, 'desktop-next-dark');
  await page.evaluate(() => applyTheme('light'));
  await keep(page, 'desktop-next-light');

  // a card moved to the top later takes the mark over; the first keeps 高优先级
  await openCard('t-plain');
  await page.locator('.tbv-act-next').click();
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['t-plain', 't-next', 't-high', 't-now']);
  expect(readCard('t-next').next_up).toBeUndefined();
  expect(readCard('t-next').important).toBe(true);
  await expect(page.locator('.tbv-next')).toHaveCount(1);
  expect(await captainNotices()).toHaveLength(2);
});

test('desktop without 队长: the request waits on the card and goes to 队长 once one is created', async () => {
  await launch({ captain: false });
  await page.locator('#taskBoardBtn').click();
  await page.locator('.tbv-more[data-cell="客户门户/todo"]').click();
  await openCard('t-now');
  await page.locator('.tbv-act-now').click();
  await expect(page.locator('#toast')).toContainText('这台电脑没有队长，打开队长后才会派');
  await expect(page.locator('.tbv-d-act-why')).toHaveText('这台电脑没有队长，打开队长后才会派');
  await expect(page.locator('.tbv-card[data-card-id="t-now"] .tbv-activity')).toHaveText('这台电脑没有队长，打开队长后才会派');
  expect(readCard('t-now').dispatch_now).toMatchObject({ delivered: false, host: os.hostname() });
  await keep(page, 'desktop-no-captain-dark');
  // 队长 appears: the waiting request is handed over, once
  await page.evaluate((cwd) => MainSession.create('', cwd), profile);
  await expect.poll(captainNotices, { timeout: 15000 }).toEqual([expect.stringContaining('用户要求马上派：给登录页加验证码（t-now）')]);
  await expect.poll(() => readCard('t-now').dispatch_now?.delivered).toBe(true);
  await expect(page.locator('.tbv-d-who-name')).toHaveText('已交给队长 · 等派人');
  await page.waitForTimeout(500);
  expect(await captainNotices()).toHaveLength(1);
});

// ---- phone hub ----
const phoneCards = () => {
  const stamp = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const card = (id, title, status, updated, extra = {}) => ({ id, project: '客户门户', title, detail: '', status, flag: null, order: 0, assignee: null, latest_receipt: '', archived: false, important: false, updated: stamp(updated), ...extra });
  return [
    card('p-now', '给登录页加验证码', 'todo', 50), card('p-h1', '修复支付回调丢单', 'todo', 2, { important: true }),
    card('p-next', '补充常见问题', 'todo', 70),
    card('p-busy', '构建数据工作台界面', 'doing', 12, { session_id: 'w-busy', assignee: { agent: 'claude', model: 'Opus 5.5' }, latest_receipt: '界面骨架已搭好。' }),
    card('p-ask', '确认密码策略', 'needs_user', 5, { latest_receipt: '密码最短 8 位还是 12 位？' }),
    card('p-done', '回滚出错的发布', 'done', 200, { latest_receipt: '已回滚。' }),
  ];
};
async function phoneLogin(hub, browser, theme, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme });
  const phone = await context.newPage();
  const problems = [];
  phone.on('pageerror', (error) => problems.push(String(error)));
  phone.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text()); });
  await phone.goto(hub.url);
  const card = phone.getByRole('article', { name: 'Mac', exact: true });
  await card.getByLabel('Mac 的登录 token').fill(hub.machines.mac.token);
  await card.getByRole('button', { name: '登录 Mac', exact: true }).click();
  await phone.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '看板', exact: true }).click();
  await expect(phone.locator('.task-card')).toHaveCount(6);
  return { context, phone, problems };
}
const phoneCard = (phone, id) => phone.locator(`.task-card[data-task-id="${id}"]`);

test('phone hub: the two buttons on a card, the request to the computer with 队长, the grey cases, in both themes', async () => {
  const hub = await startHub({ machines: [{ id: 'mac', label: 'Mac', platform: 'darwin', hostname: 'Test-Mac.local', cards: phoneCards(),
    sessions: [{ id: 'mac-captain', title: '队长', model: 'claude-opus', status: 'idle', isMain: true, receipt: '' }], turns: [] }] });
  const browser = await chromium.launch();
  try {
    const { context, phone, problems } = await phoneLogin(hub, browser, 'dark');
    const card = phoneCard(phone, 'p-now');
    await expect(card.locator('.task-act.now')).toHaveText('马上派人做');
    await expect(card.locator('.task-act.next')).toHaveText('排到最前');
    for (const b of await card.locator('.task-act').all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
    // grey, with the reason written on the card
    await expect(phoneCard(phone, 'p-busy').locator('.task-act.now')).toBeDisabled();
    await expect(phoneCard(phone, 'p-busy').locator('.task-act-why')).toHaveText('已经有队员在做这张卡了');
    await expect(phoneCard(phone, 'p-ask').locator('.task-act-why')).toHaveText('这张卡在等你回答，先回答它');
    await expect(phoneCard(phone, 'p-done').locator('.task-act'), 'a finished card has nothing to send out').toHaveCount(0);
    await keep(phone, 'phone-board-dark', { fullPage: false });

    await card.locator('.task-act.now').click();
    await expect.poll(() => hub.machines.mac.taskWrites).toEqual([{ op: 'dispatch-now', id: 'p-now' }]);
    await expect(card.locator('.task-act-why')).toHaveText('已交给 Mac 的队长，等它派人。');
    await expect(card.locator('.task-asked')).toHaveText('已交给队长 · 等派人');
    await expect(card.locator('.task-act.now')).toHaveText('已交给队长');
    await expect(card.locator('.task-act.now')).toBeDisabled();
    await card.scrollIntoViewIfNeeded();
    await keep(phone, 'phone-asked-dark');

    await phoneCard(phone, 'p-next').locator('.task-act.next').click();
    await expect.poll(() => hub.machines.mac.taskWrites.length).toBe(2);
    await expect(phoneCard(phone, 'p-next').locator('.task-next')).toHaveText('下一个做');
    const todo = await phone.locator('.task-card[data-status="todo"] h3').allTextContents();
    expect(todo[0]).toBe('补充常见问题');
    await expect(phoneCard(phone, 'p-next').locator('.task-act.next')).toHaveAttribute('aria-pressed', 'true');
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phoneCard(phone, 'p-next').scrollIntoViewIfNeeded();
    await keep(phone, 'phone-next-dark');
    expect(problems).toEqual([]);
    await context.close();

    for (const width of [390, 320]) {
      const light = await phoneLogin(hub, browser, 'light', width);
      await expect(phoneCard(light.phone, 'p-next').locator('.task-next')).toHaveText('下一个做');
      expect(await light.phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await phoneCard(light.phone, 'p-now').scrollIntoViewIfNeeded();
      await keep(light.phone, `phone-light-${width}`);
      expect(light.problems).toEqual([]);
      await light.context.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
});

test('phone hub: a computer without 队长 keeps the request and says so; a refusal is shown on the card', async () => {
  const hub = await startHub({ machines: [{ id: 'mac', label: 'Mac', platform: 'darwin', hostname: 'Test-Mac.local', cards: phoneCards(), captain: false, sessions: [], turns: [] }] });
  const browser = await chromium.launch();
  try {
    const { context, phone, problems } = await phoneLogin(hub, browser, 'dark');
    const card = phoneCard(phone, 'p-now');
    await card.locator('.task-act.now').click();
    await expect(card.locator('.task-act-why')).toHaveText('Mac 没有队长，打开队长后才会派。');
    await expect(card.locator('.task-asked')).toHaveText('Mac 没有队长，打开队长后才会派');
    await card.scrollIntoViewIfNeeded();
    await keep(phone, 'phone-no-captain-dark');
    // the computer refuses (its board changed meanwhile): the reason is on the card
    hub.machines.mac.cards.find((c) => c.id === 'p-h1').session_id = 'w-late';
    hub.machines.mac.cards.find((c) => c.id === 'p-h1').status = 'doing';
    await phoneCard(phone, 'p-h1').locator('.task-act.now').click();
    await expect(phoneCard(phone, 'p-h1').locator('.task-act-why')).toHaveText('已经有队员在做这张卡了');
    expect(problems).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
    await hub.close();
  }
});
