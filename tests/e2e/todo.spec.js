const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 随手记待办 on the desktop: the sidebar entry, the 待办 page and the ⌘⇧N /
// Ctrl+Shift+N quick-capture box (the key can be changed in 设置). A --test-user-data profile keeps its to-dos
// in <profile>/todos, never in ~/.agents. AGENTDECK_TODO_SHOTS=<dir> saves
// screenshots of the states the user looks at.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_TODO_SHOTS;
const mac = process.platform === 'darwin';
const quickKey = mac ? 'Meta+Shift+KeyN' : 'Control+Shift+KeyN';
const quickLabel = mac ? '⌘⇧N' : 'Ctrl+Shift+N';
let application, page, profile;

const todoDir = () => path.join(profile, 'todos');
function ownFile() {
  const files = fs.existsSync(todoDir()) ? fs.readdirSync(todoDir()).filter((n) => n.endsWith('.json') && n.startsWith('dev-') && n !== 'dev-other-computer.json') : [];
  return files.length === 1 ? path.join(todoDir(), files[0]) : null;
}
const stored = () => JSON.parse(fs.readFileSync(ownFile(), 'utf8')).items;
const input = () => page.locator('.todo-add-input');
const openRows = () => page.locator('.todo-list:not(.todo-list-done) .todo-row');
const rowFor = (text) => page.locator('.todo-row', { hasText: text });
const count = () => page.locator('#todoBtn .nav-row-count');
async function size(width, height) {
  await application.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s.width, s.height), { width, height });
  await page.waitForTimeout(250);
}
async function theme(name) {
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== name) await page.click('#themeBtn');
  await expect(page.locator('html')).toHaveAttribute('data-theme', name);
}
// The theme under a modal: a real click outside the box would close it.
async function themeBehind(name) {
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== name) await page.evaluate(() => document.getElementById('themeBtn').click());
  await expect(page.locator('html')).toHaveAttribute('data-theme', name);
}
async function shot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css' });
}
async function record(text) {
  await input().fill(text);
  await input().press('Enter');
  await expect(rowFor(text).first()).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-todo-')));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 1,
    columns: [{ id: 'todo-host', taskId: 'task-todo-host', title: '模拟会话', cmd: FAKE, cwd: profile, width: 520, role: 'manual' }],
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined, args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await application.firstWindow();
  await expect(page.locator('.column[data-col-id="todo-host"] .xterm')).toBeVisible({ timeout: 20000 });
  await size(1280, 800);
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('the sidebar 待办 entry opens a page that is ready to type into, with a friendly empty state', async () => {
  const entry = page.locator('#todoBtn');
  await expect(entry).toBeVisible();
  await expect(entry.locator('.nav-row-label')).toHaveText('待办');
  await expect(count()).toBeHidden();
  // It sits right under 搜索, after 任务看板, among the primary entries.
  const order = await page.locator('#navTop > *').evaluateAll((rows) => rows.map((r) => r.dataset.nav || r.id));
  expect(order.slice(0, 6)).toEqual(['new', 'captain', 'attention', 'tasks', 'navSearchSlot', 'todo']);
  await entry.click();
  await expect(page.locator('#pageView .page-titles h1')).toHaveText('待办');
  await expect(entry).toHaveClass(/active/);
  await expect(input()).toBeFocused();
  await expect(page.locator('.todo-empty strong')).toHaveText('清单还是空的');
  await expect(page.locator('.todo-empty kbd')).toHaveText(quickLabel);
  // The shortcut works inside AgentDeck only, and the words say so.
  await expect(page.locator('#pageView .page-titles')).toContainText('在 AgentDeck 里任何地方按');
  expect(await entry.getAttribute('title')).toContain('在 AgentDeck 里按');
  await expect(page.locator('#helpTodoKey')).toHaveText(quickLabel);
  await expect(page.locator('#helpDialog')).toContainText('速记一条待办：在 AgentDeck 里任何地方都能按');
  await expect(page.locator('.todo-add-btn')).toBeDisabled();
  await shot('desktop-wide-dark-empty');
  await theme('light');
  await shot('desktop-wide-light-empty');
  await theme('dark');
  expect(ownFile()).toBe(null); // Nothing is written until something is recorded.
});

test('one line and Enter records it, keeps the cursor for the next one and writes this computer\'s own file', async () => {
  await input().fill('  退货包裹\t放门口  ');
  await input().press('Enter');
  await expect(openRows()).toHaveCount(1);
  await expect(openRows().first().locator('.todo-text')).toHaveText('退货包裹 放门口');
  await expect(input()).toHaveValue('');
  await expect(input()).toBeFocused();
  await expect(count()).toHaveText('1');
  const items = stored();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ text: '退货包裹 放门口', done: false, deleted: false, source: 'desktop', ai: null });
  // Blank input does nothing.
  await input().fill('    ');
  await input().press('Enter');
  await expect(openRows()).toHaveCount(1);
  await input().fill('');
});

test('a dozen-plus items: newest on top, one line each, icon-only tools with names', async () => {
  const more = ['回复房东的邮件', '体检前把既往检查整理成一页', '买《置身事内》纸质版', '给妈妈打电话', '续订 Claude 订阅前比一下价格',
    '周五前交 IMT 540 作业', '把 Hermes 早报里的求职邮件回掉', '预约牙医洗牙', '整理桌面截图文件夹', '退掉没用的视频会员',
    '查一下 Mac 备份是不是正常', '下周二前把报销单交了', '这是一条很长很长的待办，用来看看在窄窗口里会不会正常换行而不是把按钮挤出去，顺便确认时间标签也不会溢出到外面'];
  for (const text of more) await record(text);
  await expect(openRows()).toHaveCount(14);
  await expect(openRows().first().locator('.todo-text')).toContainText('这是一条很长很长的待办');
  await expect(count()).toHaveText('14');
  // Every tool in a row is an icon with a tooltip and an accessible name, never a word.
  const tools = await page.locator('.todo-row button').evaluateAll((list) => list.map((b) => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label') || '', title: b.title, svg: !!b.querySelector('svg') })));
  expect(tools.length).toBeGreaterThan(14 * 2);
  for (const t of tools) { expect(t.text).toBe(''); expect(t.label).not.toBe(''); expect(t.title).not.toBe(''); expect(t.svg).toBe(true); }
  const firstTools = await openRows().nth(1).locator('.todo-actions button').evaluateAll((list) => list.map((b) => b.title));
  expect(firstTools).toEqual(['编辑', '删除']);
  // Targets are big enough to hit.
  const box = await openRows().nth(1).locator('.todo-check').boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(32);
  await shot('desktop-wide-dark-list');
  await theme('light');
  await shot('desktop-wide-light-list');
  await size(860, 720);
  // Nothing spills out sideways in a narrow window.
  const overflow = await page.evaluate(() => {
    const view = document.getElementById('pageView');
    return { scroll: view.scrollWidth - view.clientWidth, rows: [...document.querySelectorAll('.todo-row')].filter((r) => r.scrollWidth > r.clientWidth + 1).length };
  });
  expect(overflow).toEqual({ scroll: 0, rows: 0 });
  await shot('desktop-narrow-light-list');
  await theme('dark');
  await shot('desktop-narrow-dark-list');
  await size(1280, 800);
});

test('ticking moves an item to 已完成 and unticking brings it back', async () => {
  const row = rowFor('给妈妈打电话');
  await row.locator('.todo-check').click();
  await expect(page.locator('.todo-done-toggle')).toBeVisible();
  await expect(openRows()).toHaveCount(13);
  await expect(count()).toHaveText('13');
  await expect(page.locator('.todo-done-toggle .todo-section-count')).toHaveText('1');
  expect(stored().find((t) => t.text === '给妈妈打电话')).toMatchObject({ done: true });
  await rowFor('预约牙医洗牙').locator('.todo-check').click();
  await expect(openRows()).toHaveCount(12);
  await page.locator('.todo-done-toggle').click();
  await expect(page.locator('.todo-done-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.todo-list-done .todo-row')).toHaveCount(2);
  await expect(page.locator('.todo-list-done .todo-check').first()).toHaveAttribute('aria-checked', 'true');
  await page.locator('#pageView').evaluate((v) => { v.scrollTop = v.scrollHeight; });
  await shot('desktop-wide-dark-done');
  await page.locator('.todo-list-done .todo-row', { hasText: '预约牙医洗牙' }).locator('.todo-check').click();
  await expect(openRows()).toHaveCount(13);
  await expect(count()).toHaveText('13');
  await page.locator('#pageView').evaluate((v) => { v.scrollTop = 0; });
});

test('the pencil edits in place: Enter saves, Esc leaves it as it was', async () => {
  const row = rowFor('买《置身事内》纸质版');
  await row.hover();
  await row.locator('button[title="编辑"]').click();
  const edit = page.locator('.todo-edit');
  await expect(edit).toBeFocused();
  await expect(edit).toHaveValue('买《置身事内》纸质版');
  await shot('desktop-wide-dark-editing');
  await edit.fill('买《置身事内》纸质版和电子版');
  await edit.press('Enter');
  await expect(rowFor('买《置身事内》纸质版和电子版')).toHaveCount(1);
  expect(stored().some((t) => t.text === '买《置身事内》纸质版和电子版')).toBe(true);
  const other = rowFor('回复房东的邮件');
  await other.hover();
  await other.locator('button[title="编辑"]').click();
  await page.locator('.todo-edit').fill('不该存下的改动');
  await page.locator('.todo-edit').press('Escape');
  await expect(rowFor('回复房东的邮件')).toHaveCount(1);
  await expect(page.locator('#pageView .page-titles h1')).toHaveText('待办'); // Esc in the editor does not close the page.
  expect(stored().some((t) => t.text === '不该存下的改动')).toBe(false);
});

test('the trash deletes at once and 撤销 brings it back', async () => {
  const row = rowFor('整理桌面截图文件夹');
  await row.hover();
  await row.locator('button[title="删除"]').click();
  await expect(rowFor('整理桌面截图文件夹')).toHaveCount(0);
  await expect(count()).toHaveText('12');
  await expect(page.locator('.todo-undo')).toBeVisible();
  await expect(page.locator('.todo-undo')).toContainText('已删除「整理桌面截图文件夹」');
  const gone = stored().find((t) => t.text === '整理桌面截图文件夹');
  expect(gone.deleted).toBe(true);
  await page.locator('.todo-undo-btn').click();
  await expect(rowFor('整理桌面截图文件夹')).toHaveCount(1);
  await expect(count()).toHaveText('13');
  expect(stored().find((t) => t.id === gone.id).deleted).toBe(false);
});

test('keyboard: Tab reaches the circle and the tools show while focused; Esc closes the page', async () => {
  await input().focus();
  await page.keyboard.press('Tab'); // the add button is disabled while the input is empty
  const focused = await page.evaluate(() => document.activeElement.className);
  expect(focused).toContain('todo-check');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.title)).toBe('编辑');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.activeElement.closest('.todo-actions')).opacity)).toBe('1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pageView')).toBeHidden();
  await expect(page.locator('#todoBtn')).not.toHaveClass(/active/);
});

const quick = () => page.locator('#todoQuick');
const quickInput = () => quick().locator('.todo-quick-input');
const quickRows = () => quick().locator('.todo-list:not(.todo-list-done) .todo-row');
const quickDone = () => quick().locator('.todo-list-done .todo-row');
const termFocus = () => page.locator('.column[data-col-id="todo-host"] .xterm-helper-textarea');
async function fromTerminal() {
  if (await page.locator('#pageView .page-close').isVisible()) await page.locator('#pageView .page-close').click();
  await page.locator('.column[data-col-id="todo-host"] .xterm').click();
  await expect(termFocus()).toBeFocused();
}

test('the shortcut opens a box in the middle of the window, from inside a terminal, with the list under it', async () => {
  await fromTerminal();
  const columns = await page.locator('.column').count();
  await page.keyboard.press(quickKey);
  await expect(quick()).toBeVisible();
  await expect(quickInput()).toBeFocused();
  // ⌘⇧N is not also ⌘N (新对话): no column was added.
  await page.waitForTimeout(300);
  expect(await page.locator('.column').count()).toBe(columns);
  // In the middle of the window.
  const box = await quick().boundingBox();
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(2);
  expect(Math.abs(box.y + box.height / 2 - view.height / 2)).toBeLessThan(2);
  // The list: open ones newest first, then the finished ones.
  await expect(quickRows()).toHaveCount(13);
  await expect(quickRows().first().locator('.todo-text')).toContainText('这是一条很长很长的待办');
  await expect(quickRows().last().locator('.todo-text')).toHaveText('退货包裹 放门口');
  await expect(quickDone()).toHaveCount(1);
  await expect(quickDone().first()).toContainText('给妈妈打电话');
  // Close is an icon with a name, big enough to hit.
  const close = quick().locator('.todo-quick-close');
  await expect(close).toHaveAttribute('aria-label', '关闭速记');
  expect(await close.getAttribute('title')).toBe('关闭（Esc）');
  expect((await close.boundingBox()).width).toBeGreaterThanOrEqual(28);
  await quickInput().fill('下班路上取快递');
  await shot('quick-dark');
  if (shots) {
    await themeBehind('light');
    await shot('quick-light');
    await themeBehind('dark');
    await size(700, 560);
    await shot('quick-narrow-dark');
    const spill = await quick().evaluate((d) => d.scrollWidth - d.clientWidth);
    expect(spill).toBe(0);
    await size(1280, 800);
  }
});

test('Enter saves, keeps the box open for the next line and the new line lands on top of the list', async () => {
  await quickInput().press('Enter');
  await expect(quickInput()).toHaveValue('');
  await expect(quickInput()).toBeFocused();
  await expect(quick()).toBeVisible();
  await expect(quickRows().first().locator('.todo-text')).toHaveText('下班路上取快递');
  await expect(quickRows().first()).toHaveClass(/is-new/);
  await expect(count()).toHaveText('14');
  expect(stored().some((t) => t.text === '下班路上取快递')).toBe(true);
  await quickInput().fill('顺便买牛奶');
  await quickInput().press('Enter');
  await expect(quickRows().first().locator('.todo-text')).toHaveText('顺便买牛奶');
  await expect(quickRows().nth(1).locator('.todo-text')).toHaveText('下班路上取快递');
  await expect(count()).toHaveText('15');
  await shot('quick-saved-dark');
  // Blank does nothing.
  await quickInput().fill('   ');
  await quickInput().press('Enter');
  await expect(quickRows()).toHaveCount(15);
});

test('a row ticks off right in the box and can be put back', async () => {
  await quickRows().filter({ hasText: '顺便买牛奶' }).locator('.todo-check').click();
  await expect(quickDone().filter({ hasText: '顺便买牛奶' })).toHaveCount(1);
  await expect(quickRows()).toHaveCount(14);
  await expect(count()).toHaveText('14');
  expect(stored().find((t) => t.text === '顺便买牛奶').done).toBe(true);
  await quickDone().filter({ hasText: '顺便买牛奶' }).locator('.todo-check').click();
  await expect(quickRows().filter({ hasText: '顺便买牛奶' })).toHaveCount(1);
  await expect(count()).toHaveText('15');
  await quickRows().filter({ hasText: '顺便买牛奶' }).locator('.todo-check').click();
  await expect(count()).toHaveText('14');
});

test('Esc and × close it and throw the draft away; the terminal gets its focus back', async () => {
  await quickInput().fill('不存');
  await quickInput().press('Escape');
  await expect(quick()).toBeHidden();
  await expect(termFocus()).toBeFocused();
  expect(stored().some((t) => t.text === '不存')).toBe(false);
  await page.keyboard.press(quickKey);
  await expect(quickInput()).toHaveValue('');
  await quickInput().fill('也不存');
  await quick().locator('.todo-quick-close').click();
  await expect(quick()).toBeHidden();
  await expect(termFocus()).toBeFocused();
  expect(stored().some((t) => t.text === '也不存')).toBe(false);
  await page.keyboard.press(quickKey);
  await expect(quickInput()).toHaveValue('');
  await quickInput().press('Escape');
});

test('a click anywhere outside closes it and keeps the half-typed words for next time', async () => {
  await fromTerminal();
  await page.keyboard.press(quickKey);
  await quickInput().fill('手滑点到别处');
  const box = await quick().boundingBox();
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  // Above, below, left, right, just past each edge, and the far corners (over the sidebar and the terminal).
  const outside = [[cx, box.y - 12], [cx, box.y + box.height + 12], [box.x - 12, cy], [box.x + box.width + 12, cy],
    [60, view.height - 60], [view.width - 40, view.height - 40], [60, 120], [view.width - 40, 120]];
  await page.evaluate(() => { window.__underClicks = 0; document.addEventListener('click', (e) => { if (!e.target.closest('#todoQuick')) window.__underClicks++; }, true); });
  for (const [x, y] of outside) {
    await page.mouse.click(x, y);
    await expect(quick(), `click at ${Math.round(x)},${Math.round(y)}`).toBeHidden();
    await expect(termFocus()).toBeFocused();
    await page.keyboard.press(quickKey);
    await expect(quick()).toBeVisible();
    await expect(quickInput()).toHaveValue('手滑点到别处');
  }
  // The click that closed the box never reached what is underneath (no sidebar entry or page opened).
  expect(await page.evaluate(() => window.__underClicks)).toBe(0);
  await expect(page.locator('#pageView')).toBeHidden();
  // A click inside — the title, the padding at each edge, the list — leaves it open.
  const inside = [[cx, box.y + 4], [cx, box.y + box.height - 4], [box.x + 4, cy], [box.x + box.width - 4, cy]];
  for (const [x, y] of inside) {
    await page.mouse.click(x, y);
    await expect(quick(), `click at ${Math.round(x)},${Math.round(y)}`).toBeVisible();
  }
  await quick().locator('.todo-quick-title').click();
  await quick().locator('.todo-quick-list .todo-section').first().click();
  // Selecting text in the input and letting go outside the box is not a click outside.
  const field = await quickInput().boundingBox();
  await page.mouse.move(field.x + field.width - 10, field.y + field.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 40, field.y + field.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(quick()).toBeVisible();
  await expect(quickInput()).toHaveValue('手滑点到别处');
  await quickInput().press('Escape');
  await expect(quick()).toBeHidden();
  expect(stored().some((t) => t.text === '手滑点到别处')).toBe(false);
});

test('on the 待办 page the shortcut opens the same box, and what it saves shows on the page too', async () => {
  await page.locator('#todoBtn').click();
  await expect(input()).toBeFocused();
  await page.keyboard.press(quickKey);
  await expect(quick()).toBeVisible();
  await expect(quickInput()).toBeFocused();
  await quickInput().fill('从待办页速记');
  await quickInput().press('Enter');
  await quickInput().press('Escape');
  await expect(quick()).toBeHidden();
  await expect(page.locator('#pageView .todo-list:not(.todo-list-done) .todo-row').first()).toContainText('从待办页速记');
  await expect(input()).toBeFocused();
  await expect(count()).toHaveText('15');
});

test('设置 · 快捷键: record a new key; AgentDeck\'s own keys are refused; every label follows; 恢复默认 brings ⌘⇧N back', async () => {
  const configFile = path.join(profile, 'config.json');
  await page.locator('#pageView .page-close').click();
  await page.locator('#settingsBtn').click();
  const field = page.locator('#todoShortcutBtn');
  const note = page.locator('#todoShortcutNote');
  const reset = page.locator('#todoShortcutReset');
  await field.scrollIntoViewIfNeeded();
  await expect(field).toHaveText(quickLabel);
  await expect(reset).toBeHidden();
  const columns = await page.locator('.column').count();
  await field.click();
  await expect(field).toHaveClass(/is-recording/);
  // ⌘N / Ctrl+N is refused with the reason, and never opens a new 对话 while recording.
  await page.keyboard.press(mac ? 'Meta+KeyN' : 'Control+KeyN');
  await expect(note).toHaveClass(/is-warn/);
  await expect(note).toContainText(mac ? '⌘N 已经是「新对话」' : 'Shift 或 Alt');
  expect(await page.locator('.column').count()).toBe(columns);
  await expect(field).toHaveClass(/is-recording/);
  await shot('settings-shortcut-refused-dark');
  const next = mac ? 'Meta+Alt+KeyT' : 'Control+Alt+KeyT';
  const nextLabel = mac ? '⌘⌥T' : 'Ctrl+Alt+T';
  await page.keyboard.press(next);
  await expect(field).not.toHaveClass(/is-recording/);
  await expect(field).toHaveText(nextLabel);
  await expect(note).toContainText(`已改成 ${nextLabel}`);
  await expect(reset).toBeVisible();
  await expect(reset).toHaveAttribute('aria-label', `恢复默认（${quickLabel}）`);
  await expect.poll(() => JSON.parse(fs.readFileSync(configFile, 'utf8')).todoShortcut, { timeout: 5000 }).toBe('Mod+Alt+T');
  await shot('settings-shortcut-dark');
  if (shots) { await themeBehind('light'); await shot('settings-shortcut-light'); await themeBehind('dark'); }
  await page.keyboard.press('Escape');
  await expect(page.locator('#notificationSettings')).toBeHidden();
  // The labels follow.
  await expect(page.locator('#helpTodoKey')).toHaveText(nextLabel);
  expect(await page.locator('#todoBtn').getAttribute('title')).toContain(nextLabel);
  await page.locator('#todoBtn').click();
  await expect(page.locator('#pageView .page-titles')).toContainText(`任何地方按 ${nextLabel}`);
  await page.locator('#pageView .page-close').click();
  // The old key no longer opens the box; the new one does.
  await fromTerminal();
  await page.keyboard.press(quickKey);
  await page.waitForTimeout(300);
  await expect(quick()).toBeHidden();
  await page.keyboard.press(next);
  await expect(quick()).toBeVisible();
  await quickInput().press('Escape');
  // Back to the default.
  await page.locator('#settingsBtn').click();
  await reset.scrollIntoViewIfNeeded();
  await reset.click();
  await expect(field).toHaveText(quickLabel);
  await expect(reset).toBeHidden();
  await expect.poll(() => JSON.parse(fs.readFileSync(configFile, 'utf8')).todoShortcut, { timeout: 5000 }).toBe('Mod+Shift+N');
  await page.keyboard.press('Escape');
  await expect(page.locator('#helpTodoKey')).toHaveText(quickLabel);
  await fromTerminal();
  await page.keyboard.press(quickKey);
  await expect(quick()).toBeVisible();
  await quickInput().press('Escape');
});

test('a list written by the other computer (arriving through git) shows up without reopening the page', async () => {
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(todoDir(), 'dev-other-computer.json'), JSON.stringify({ version: 1, device: 'dev-other-computer', items: [
    { id: 'td-from-windows-0001', text: '在 Windows 上记的一条', done: false, doneAt: null, created: at, updated: at, deleted: false, source: 'desktop', device: 'dev-other-computer', ai: null },
  ] }));
  await page.locator('#todoBtn').click();
  await expect(rowFor('在 Windows 上记的一条')).toHaveCount(1, { timeout: 10000 });
  await expect(count()).toHaveText('16');
  // This computer still writes only its own file.
  await rowFor('在 Windows 上记的一条').locator('.todo-check').click();
  await expect(count()).toHaveText('15');
  const other = JSON.parse(fs.readFileSync(path.join(todoDir(), 'dev-other-computer.json'), 'utf8'));
  expect(other.items[0].done).toBe(false);
  expect(stored().find((t) => t.id === 'td-from-windows-0001').done).toBe(true);
});
