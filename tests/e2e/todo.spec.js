const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 随手记待办 on the desktop: the sidebar entry, the 待办 page and the ⌘T /
// Ctrl+Shift+T quick-capture bar. A --test-user-data profile keeps its to-dos
// in <profile>/todos, never in ~/.agents. AGENTDECK_TODO_SHOTS=<dir> saves
// screenshots of the states the user looks at.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_TODO_SHOTS;
const quickKey = process.platform === 'darwin' ? 'Meta+t' : 'Control+Shift+T';
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
  // It sits right under 任务看板 among the primary entries.
  const order = await page.locator('#navTop .nav-row').evaluateAll((rows) => rows.map((r) => r.dataset.nav));
  expect(order.indexOf('todo')).toBe(order.indexOf('tasks') + 1);
  await entry.click();
  await expect(page.locator('#pageView .page-titles h1')).toHaveText('待办');
  await expect(entry).toHaveClass(/active/);
  await expect(input()).toBeFocused();
  await expect(page.locator('.todo-empty strong')).toHaveText('清单还是空的');
  await expect(page.locator('.todo-empty kbd')).toHaveText(process.platform === 'darwin' ? '⌘T' : 'Ctrl+Shift+T');
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

test('the quick-capture shortcut records from inside a terminal and gives the terminal its focus back', async () => {
  await page.locator('.column[data-col-id="todo-host"] .xterm').click();
  await expect(page.locator('.column[data-col-id="todo-host"] .xterm-helper-textarea')).toBeFocused();
  await page.keyboard.press(quickKey);
  const bar = page.locator('#todoQuick');
  await expect(bar).toBeVisible();
  await expect(bar.locator('.todo-quick-input')).toBeFocused();
  await bar.locator('.todo-quick-input').fill('下班路上取快递');
  await shot('desktop-quick-capture-dark');
  if (shots) {
    // The theme button is outside the bar, and a click outside puts the bar away (keeping nothing).
    await theme('light');
    await expect(bar).toBeHidden();
    await page.locator('.column[data-col-id="todo-host"] .xterm').click();
    await page.keyboard.press(quickKey);
    await bar.locator('.todo-quick-input').fill('下班路上取快递');
    await shot('desktop-quick-capture-light');
    await bar.locator('.todo-quick-input').press('Escape');
    await theme('dark');
    await page.locator('.column[data-col-id="todo-host"] .xterm').click();
    await page.keyboard.press(quickKey);
    await bar.locator('.todo-quick-input').fill('下班路上取快递');
  }
  await bar.locator('.todo-quick-input').press('Enter');
  await expect(bar.locator('.todo-quick-status')).toHaveText('已记下');
  await expect(bar).toBeHidden();
  await expect(count()).toHaveText('14');
  await expect(page.locator('.column[data-col-id="todo-host"] .xterm-helper-textarea')).toBeFocused();
  expect(stored().some((t) => t.text === '下班路上取快递')).toBe(true);
  // Esc puts it away without saving; the terminal never saw the keys.
  await page.keyboard.press(quickKey);
  await bar.locator('.todo-quick-input').fill('不存');
  await bar.locator('.todo-quick-input').press('Escape');
  await expect(bar).toBeHidden();
  expect(stored().some((t) => t.text === '不存')).toBe(false);
  // With the page open, the shortcut just puts the cursor in the page's own box.
  await page.locator('#todoBtn').click();
  await page.locator('.todo-row .todo-check').first().focus();
  await page.keyboard.press(quickKey);
  await expect(input()).toBeFocused();
  await expect(bar).toBeHidden();
});

test('a list written by the other computer (arriving through git) shows up without reopening the page', async () => {
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(todoDir(), 'dev-other-computer.json'), JSON.stringify({ version: 1, device: 'dev-other-computer', items: [
    { id: 'td-from-windows-0001', text: '在 Windows 上记的一条', done: false, doneAt: null, created: at, updated: at, deleted: false, source: 'desktop', device: 'dev-other-computer', ai: null },
  ] }));
  await expect(rowFor('在 Windows 上记的一条')).toHaveCount(1, { timeout: 10000 });
  await expect(count()).toHaveText('15');
  // This computer still writes only its own file.
  await rowFor('在 Windows 上记的一条').locator('.todo-check').click();
  await expect(count()).toHaveText('14');
  const other = JSON.parse(fs.readFileSync(path.join(todoDir(), 'dev-other-computer.json'), 'utf8'));
  expect(other.items[0].done).toBe(false);
  expect(stored().find((t) => t.id === 'td-from-windows-0001').done).toBe(true);
});
