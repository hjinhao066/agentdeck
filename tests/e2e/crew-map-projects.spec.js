const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile, controls, reviewerId;
test.describe.configure({ mode: 'serial' });

async function launch() {
  const env = { ...process.env, AGENTDECK_TEST_CONTROL_ENV_FILE: path.join(profile, 'control.json'),
    AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'received.jsonl'),
    AGENTDECK_TEST_RECEIPTS_FILE: path.join(profile, 'receipts.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect.poll(() => fs.existsSync(path.join(profile, 'control.json'))).toBe(true);
  controls = JSON.parse(fs.readFileSync(path.join(profile, 'control.json'), 'utf8'));
  await expect.poll(() => page.evaluate(() => typeof MainSession !== 'undefined' && !!MainSession.state())).toBe(true);
}
async function cli(args) {
  return exec(process.execPath, [path.resolve(__dirname, '../../board-cli.js'), ...args], { env: { ...process.env, ...controls } });
}
async function shot(name) {
  if (process.env.AGENTDECK_PROJECT_SHOTS) {
    fs.mkdirSync(process.env.AGENTDECK_PROJECT_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.AGENTDECK_PROJECT_SHOTS, name), animations: 'disabled' });
  }
}
const group = (key) => page.locator(`.cm-project[data-project="${key}"]`);
const node = (id) => page.locator(`.cm-node[data-node-id="${id}"]`);

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-projects-'));
  const column = (id, title, project, reviews = []) => ({ id, title, displayTitle: title, manualTitle: true, project, reviews, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true });
  const now = Date.now();
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [
      { ...column('cap', '队长', ''), isMain: true, captainCrew: false },
      column('a1', '登录与权限', '客户门户'), column('a2', '工作台界面', '客户门户'), column('a3', '回归测试', '客户门户'),
      column('r1', '接口与界面审查', '客户门户', ['a1', 'a2']),
      column('b1', '数据迁移', '报表服务'), column('b2', '报表接口', '报表服务'),
    ],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: ['a1', 'a2', 'a3', 'r1', 'b1', 'b2'].map((colId, i) => ({ id: 'task-' + colId, colId, title: colId, gen: 1, sentAt: now - 60_000 + i, turnId: '',
        status: ['a3', 'r1', 'b2'].includes(colId) ? 'done' : 'working',
        receipt: ['a3', 'r1', 'b2'].includes(colId) ? { summary: colId === 'r1' ? '两项审查通过，结果已收回' : '已完成并验证', files: [], explicit: true } : null,
      })) },
  }));
  await launch();
  await expect.poll(() => page.evaluate(() => terms.size)).toBe(7);
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('two project groups contain 3 workers + 1 declared reviewer and 2 workers, with one real Captain', async () => {
  await page.evaluate(() => showView('board'));
  await expect(page.locator('.cm-project')).toHaveCount(2);
  await expect(page.locator('.cm-node.kind-captain')).toHaveCount(1);
  await expect(page.locator('.cm-node.kind-worker')).toHaveCount(6);
  await expect(page.locator('.cm-edges .cm-edge.review')).toHaveCount(2);
  await expect(page.locator('.cm-edges .cm-edge.review[data-from="a3"]')).toHaveCount(0);
  const geometry = await page.evaluate(() => {
    const l = CrewMap.layout();
    return { groups: l.groups.map((g) => ({ key: g.key, x: g.x, right: g.x + g.w })), a: l.nodes.get('a1'), r: l.nodes.get('r1'), cap: l.captain };
  });
  expect(geometry.groups[0].right).toBeLessThan(geometry.groups[1].x);
  expect(geometry.cap.y).toBeLessThan(geometry.a.y);
  expect(geometry.a.y + geometry.a.h).toBeLessThan(geometry.r.y);
  await expect(page.locator('.cm-edges .cm-edge.return[data-from="r1"]')).toHaveCount(1);
  await page.locator('[data-cm="fit"]').click();
  await shot('two-projects-expanded.png');
});

test('successful projects default to one summary row; toggle is accessible and persists across reload', async () => {
  await page.evaluate(() => {
    MainSession.state().tasks.find((t) => t.colId === 'b1').status = 'done';
    CrewMap.refresh();
  });
  await expect(group('报表服务')).toHaveClass(/collapsed/);
  await expect(group('报表服务').locator('.cm-project-summary')).toHaveText('2 已完成');
  await expect(node('b1')).toHaveCount(0);
  const toggle = group('报表服务').getByRole('button', { name: '展开项目：报表服务' });
  await expect(toggle).toHaveAttribute('title', '展开项目：报表服务');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await shot('completed-project-collapsed.png');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(node('b1')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.deck.loadConfig()).crewMap.collapsedProjects['报表服务'])).toBe(false);
  await page.reload();
  await page.evaluate(() => showView('board'));
  await expect(group('报表服务')).not.toHaveClass(/collapsed/);
  await expect(node('r1')).toHaveClass(/review/);
  expect(await page.evaluate(() => columns.find((c) => c.id === 'r1').reviews)).toEqual(['a1', 'a2']);
  await group('报表服务').getByRole('button', { name: '折叠项目：报表服务' }).click();
  await expect(group('报表服务')).toHaveClass(/collapsed/);
  await group('报表服务').getByRole('button', { name: '展开项目：报表服务' }).click();
  await expect(node('b1')).toBeVisible();
});

test('project cards open real sessions where the user can speak directly', async () => {
  await node('a1').click();
  await expect.poll(() => page.evaluate(() => [activeView, focusedId])).toEqual(['terminals', 'a1']);
  const column = page.locator('.column[data-col-id="a1"]');
  await column.locator('.view-toggle').click();
  await expect(column).toHaveClass(/chat-mode/);
  await column.locator('.composer textarea').fill('用户直接交代的新说明');
  await column.locator('.composer textarea').press('Enter');
  await expect(column.locator('.msg.user .bubble')).toContainText('用户直接交代的新说明');
  await page.evaluate(() => showView('board'));
});

test('real authenticated new CLI stores project/reviews, rejects unknown targets, and archive/tell preserve metadata', async ({}, testInfo) => {
  try {
  await expect(cli(['new', '--title', 'invalid', '--task', 'Inspect', '--command', FAKE, '--reviews', 'missing'])).rejects.toThrow(/找不到可审查的会话/);
  await cli(['new', '--title', '专项审查', '--task', 'Inspect only declared sessions', '--command', FAKE, '--cwd', profile, '--project', '客户门户', '--reviews', 'a1,a3']);
  reviewerId = await page.evaluate(() => columns.find((c) => columnLabel(c) === '专项审查').id);
  await expect.poll(() => page.evaluate((id) => {
    const c = columns.find((c) => c.id === id);
    return [c.project, c.reviews, MainSession.state().tasks.find((t) => t.colId === id).status];
  }, reviewerId), { timeout: 20000 }).toEqual(['客户门户', ['a1', 'a3'], 'done']);
  await cli(['archive', '--id', reviewerId]);
  expect(await page.evaluate((id) => config.archived.find((c) => c.id === id).reviews, reviewerId)).toEqual(['a1', 'a3']);
  await cli(['tell', '--to', reviewerId, '--message', 'Verify once again']);
  await expect.poll(() => page.evaluate((id) => columns.find((c) => c.id === id)?.project, reviewerId)).toBe('客户门户');
  await expect.poll(() => page.evaluate((id) => MainSession.state().tasks.filter((t) => t.colId === id).at(-1).status, reviewerId), { timeout: 20000 }).toBe('done');
  } catch (error) {
    const state = await page.evaluate((id) => {
      const e = terms.get(id);
      return { screen: e && dumpScreen(e.term), state: e?.state, lastScreen: e?.lastScreen,
        sending: e?.sendingPrompt, injecting: e?.injecting, typing: e?.typing,
        alive: e?.alive, inputBox: e && visibleInputBox(e), composing: userComposing(id),
        tasks: MainSession.state().tasks.filter(t => t.colId === id), turns: ChatUI.turnsOf(id) };
    }, reviewerId);
    const file = path.join(profile, 'received.jsonl');
    const received = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(p => p.colId === reviewerId) : [];
    const receiptsFile = path.join(profile, 'receipts.jsonl');
    const receipts = fs.existsSync(receiptsFile) ? fs.readFileSync(receiptsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(p => p.colId === reviewerId) : [];
    await testInfo.attach('reviewer-state', { body: JSON.stringify({ state, received, receipts }, null, 2), contentType: 'application/json' });
    throw error;
  }
});

test('new at the concurrency limit retains project/reviews in queue and applies them when the slot opens', async () => {
  await page.evaluate(() => {
    // Isolated stand-ins for occupied slots: no agent launches and no real data.
    for (let i = 0; i < 15; i++) {
      const id = 'busy-' + i;
      columns.push({ id, title: id, captainCrew: true });
      MainSession.state().tasks.push({ id: 'slot-' + i, colId: id, status: 'working', sentAt: Date.now(), gen: 1 });
    }
  });
  const result = await cli(['new', '--title', '排队审查', '--task', 'Inspect queue metadata', '--command', FAKE, '--cwd', profile, '--project', '报表服务', '--reviews', 'b1,b2']);
  expect(result.stdout).toContain('已排队');
  await expect.poll(() => page.evaluate(async () => {
    const s = (await window.deck.loadConfig()).mainSession;
    const w = s.waitlist.find((w) => w.title === '排队审查');
    const t = s.tasks.find((t) => t.id === w?.taskId);
    return w && [w.project, w.reviews, t.project, t.reviews];
  })).toEqual(['报表服务', ['b1', 'b2'], '报表服务', ['b1', 'b2']]);
  await page.evaluate(() => {
    for (let i = columns.length - 1; i >= 0; i--) if (columns[i].id.startsWith('busy-')) columns.splice(i, 1);
    MainSession.state().tasks = MainSession.state().tasks.filter((t) => !t.id.startsWith('slot-'));
  });
  await expect.poll(() => page.evaluate(() => columns.find((c) => columnLabel(c) === '排队审查')?.reviews), { timeout: 15000 }).toEqual(['b1', 'b2']);
  await expect.poll(() => page.evaluate(async () => (await window.deck.loadConfig()).columns.find((c) => c.displayTitle === '排队审查')?.project)).toBe('报表服务');
});
