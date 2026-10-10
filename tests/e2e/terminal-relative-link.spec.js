const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Agents print paths relative to the folder they work in ("docs/plan.md:3").
// A click on one is looked up from the column's shell folder. Windows has no
// way to read a shell's live folder (lsof), and the lookup fell back to the
// home folder, so on Windows such a link never opened a project file: "路径不存在".
// It now falls back to the folder the column started in.
const ROOT = path.resolve(__dirname, '../..');
const ID = 'rel';
let app, page, profile, project;

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-relative-link-'));
  project = path.join(profile, 'project');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'plan.md'), '# Plan\n\nline three\n');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, fitWindow: true, fitCols: 2, globalViewMode: 'term',
    columns: [{ id: ID, title: 'Project shell', cmd: '', cwd: project, role: 'manual', view: 'term' }] }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(() => page.evaluate((id) => typeof terms !== 'undefined' && !!terms.get(id)?.alive, ID), { timeout: 30000 }).toBe(true);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), ID), { timeout: 15000 }).toBe(true);
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a relative path in a column opens the file in the folder that column works in', async () => {
  const preview = await page.evaluate((id) => window.deck.previewRead('docs/plan.md:3', id), ID);
  expect(preview).toMatchObject({ ok: true, name: 'plan.md', line: 3, kind: 'markdown' });
  expect(fs.realpathSync(preview.path)).toBe(fs.realpathSync(path.join(project, 'docs', 'plan.md')));
  // a name that is not in that folder is still reported missing, never found somewhere else
  expect(await page.evaluate((id) => window.deck.previewRead('docs/missing.md', id), ID)).toMatchObject({ ok: false });
});
