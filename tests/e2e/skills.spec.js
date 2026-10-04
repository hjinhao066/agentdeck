const { test, expect } = require('@playwright/test');
const { electron, closeElectron } = require('./electron-helper');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The Skills page against a fixture home. A --test-user-data profile scans
// <profile>/skills-home instead of the real home, so no real skill is listed or
// written; beforeAll stops the run if the listing comes from anywhere else.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile, skillsHome;

const s = (...p) => path.join(skillsHome, ...p);
function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
// Windows: directory junctions need no symlink privilege but an absolute target.
function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  if (process.platform === 'win32') fs.symlinkSync(path.resolve(path.dirname(at), target), at, 'junction');
  else fs.symlinkSync(target, at, 'dir');
}
const SHARED = '---\nname: alpha\ndescription: 共享的技能\n---\n# Alpha 标题\n\n' +
  '<img src=x onerror="window.__skillXss=1">\n\n<script>window.__skillXss=2</script>\n\n' +
  '[bad](javascript:window.__skillXss=3) and [good](https://example.invalid/)\n';
const CODEX = '---\nname: alpha\ndescription: Codex 自己的副本\n---\n# Codex alpha\n';
const BETA = '---\nname: beta\ndescription: 只有 Claude 有\n---\n# Beta\n';
const sharedFile = () => s('.agents', 'skills', 'alpha', 'SKILL.md');
const codexFile = () => s('.codex', 'skills', 'alpha', 'SKILL.md');
const betaFile = () => s('.claude', 'skills', 'beta', 'SKILL.md');

const row = (text) => page.locator('.sk-row', { hasText: text });
const tab = (label) => page.locator('.sk-bar .seg-btn', { hasText: label });
const editor = () => page.locator('.sk-editor');
const status = () => page.locator('.sk-toolbar .sk-status');
const saveKey = process.platform === 'darwin' ? 'Meta+s' : 'Control+s';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-skills-')));
  skillsHome = path.join(profile, 'skills-home');
  put(sharedFile(), SHARED);
  link('../../.agents/skills/alpha', s('.claude', 'skills', 'alpha'));
  put(codexFile(), CODEX);
  put(betaFile(), BETA);
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 1,
    columns: [{ id: 'sk-a', taskId: 'task-sk-a', title: 'Skills host', cmd: FAKE, cwd: profile, width: 460, role: 'manual' }],
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(1);
  const listed = await page.evaluate(() => window.deck.skillsList());
  const stray = listed.ok ? listed.skills.filter((k) => !k.path.startsWith(skillsHome + path.sep)) : null;
  if (!listed.ok || stray.length || listed.skills.length !== 3) {
    throw new Error('Skills listing is not confined to the fixture home; refusing to run edits');
  }
});
test.afterAll(async () => {
  if (application) await closeElectron(application, { requireGraceful: false });
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('lists the fixture skills: the shared original once, independent copies apart', async () => {
  await page.locator('.nav-row[data-nav="skills"]').click();
  await expect(page.locator('.sk-row')).toHaveCount(3);
  await expect(row('alpha')).toHaveCount(2);
  await expect(tab('共享正本').locator('.seg-count')).toHaveText('1');
  await expect(tab('Claude').locator('.seg-count')).toHaveText('1');
  await expect(tab('Codex').locator('.seg-count')).toHaveText('1');

  await tab('共享正本').click();
  await expect(page.locator('.sk-row')).toHaveCount(1);
  await expect(page.locator('.sk-row .sk-row-meta')).toHaveText('共享 → Claude');
  // Claude's own tab holds only its own skill, not the link to the shared one
  await tab('Claude').click();
  await expect(page.locator('.sk-row')).toHaveCount(1);
  await expect(page.locator('.sk-row .sk-row-name')).toHaveText('beta');
  await tab('Codex').click();
  await expect(page.locator('.sk-row .sk-row-desc')).toHaveText('Codex 自己的副本');
  await tab('全部').click();
});

test('renders the Markdown preview as inert text', async () => {
  await row('共享的技能').click();
  const md = page.locator('.sk-preview .pv-md');
  await expect(md.locator('h1')).toHaveText('Alpha 标题');
  await expect(page.locator('.sk-preview .sk-fm')).toContainText('name: alpha');
  await expect(md).toContainText('<img src=x onerror=');
  await expect(md).toContainText('<script>');
  await expect(md.locator('img, script, [onerror]')).toHaveCount(0);
  await expect(md.locator('a')).toHaveCount(1);
  await expect(md.locator('a')).toHaveAttribute('href', 'https://example.invalid/');
  expect(await page.evaluate(() => window.__skillXss)).toBeUndefined();
});

test('saving the shared original keeps the tool link, and the link sees the change', async () => {
  await page.locator('.sk-toolbar .seg-btn', { hasText: '编辑' }).click();
  await expect(editor()).toHaveValue(SHARED);
  const next = SHARED + '\n## 用法\n中文内容 ✓\n';
  await editor().fill(next);
  await expect(page.locator('.sk-dirty')).toBeVisible();
  await editor().press(saveKey);
  await expect(status()).toContainText('已保存');
  await expect(page.locator('.sk-dirty')).toBeHidden();
  expect(fs.readFileSync(sharedFile(), 'utf8')).toBe(next);
  expect(fs.lstatSync(s('.claude', 'skills', 'alpha')).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(s('.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe(next);
  expect(fs.readdirSync(path.dirname(sharedFile()))).toEqual(['SKILL.md']);
  expect(fs.readFileSync(codexFile(), 'utf8')).toBe(CODEX);
});

test('a change made elsewhere after opening is a conflict: nothing is written, the draft stays', async () => {
  await row('Codex').click();
  await expect(editor()).toHaveValue(CODEX);
  fs.writeFileSync(codexFile(), 'changed elsewhere\n');
  await editor().fill(CODEX + 'mine\n');
  await page.locator('.sk-toolbar .btn.primary').click();
  await expect(status()).toContainText('别处改过');
  expect(fs.readFileSync(codexFile(), 'utf8')).toBe('changed elsewhere\n');
  await expect(editor()).toHaveValue(CODEX + 'mine\n');
  await expect(page.locator('.sk-dirty')).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await page.locator('.sk-toolbar .btn', { hasText: '重新载入' }).click();
  await expect(editor()).toHaveValue('changed elsewhere\n');
  await expect(page.locator('.sk-dirty')).toBeHidden();
});

test('unsaved edits survive leaving the page and are guarded when switching skills', async () => {
  await row('beta').click();
  await expect(editor()).toHaveValue(BETA);
  await editor().fill(BETA + 'draft in progress\n');
  await page.locator('.nav-row[data-nav="artifacts"]').click();
  await expect(page.locator('.sk-editor')).toHaveCount(0);
  await page.locator('.nav-row[data-nav="skills"]').click();
  await expect(editor()).toHaveValue(BETA + 'draft in progress\n');
  await expect(page.locator('.sk-dirty')).toBeVisible();

  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await row('共享的技能').click();
  expect(asked).toContain('未保存');
  await expect(page.locator('.sk-title')).toHaveText('beta');
  await expect(editor()).toHaveValue(BETA + 'draft in progress\n');

  page.once('dialog', (d) => d.accept());
  await row('共享的技能').click();
  await expect(page.locator('.sk-title')).toHaveText('alpha');
  await expect(page.locator('.sk-dirty')).toBeHidden();
  expect(fs.readFileSync(betaFile(), 'utf8')).toBe(BETA);
  for (const file of [sharedFile(), codexFile(), betaFile()]) {
    expect(fs.readdirSync(path.dirname(file))).toEqual(['SKILL.md']);
  }
});
