const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 终端架构图只留当前的活: after a restart, sessions that finished long ago (or failed
// and were taken over) archive themselves; what is running, asking, unread, failed
// with nobody on it, or a manual terminal stays. Stand-in agent only.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const SHOTS = process.env.CREW_MAP_SHOTS || '';
let application, page, profile;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-crewlive-'));
  const now = Date.now();
  const H = 3_600_000;
  const project = 'Live';
  const col = (id, title, extra) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, project, ...extra });
  const T = (id, colId, status, ago, extra) => ({ id, colId, title: id, gen: 1, status, sentAt: now - ago, turnId: '', project, receipt: null, ...extra });
  const finished = (id, colId, status, ago, receipt, extra) => T(id, colId, status, ago, { doneAt: now - ago + 60_000, receipt: { files: [], explicit: true, ...receipt }, ...extra });
  const history = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((id, i) => ({ ...col(id, '旧会话 ' + id), archivedAt: now - (10 + i) * H }));
  // Quiet-archive states, not a seat rotation and not interrupted jobs to resend.
  // Perpetual captain is on unless a fixture says otherwise, and it replaces this
  // stand-in 队长 with a real seat. Restart resume is on unless opted out, and it
  // resends working/asking tasks, so the map no longer shows the seeded states.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false }, resumeOnRestart: false,
    theme: 'dark', fitWindow: true, fitCols: 4,
    columns: [
      { id: 'cap', title: '队长', cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true },
      col('r1', '正在干活'), col('r7', '接手的人', { project: 'live' }), col('r2', '在问队长'),
      col('r3', '1.1.4 集成'), col('r4', '1.1.5 集成'), col('r6', '额度用尽（已有人接手）'),
      col('r5', '失败没人管'), col('r8', '回执还没读'), col('z1', '已收尾项目的会话', { project: 'Finished' }),
      { id: 'mine', title: '我自己的终端', cmd: FAKE, cwd: profile, width: 460, role: 'manual' },
    ],
    archived: history,
    mainSession: {
      colId: 'cap', cmd: FAKE, gen: 1, fresh: false, crewMarked: true, waitlist: [], inflight: [],
      pending: [{ taskId: 'k8', colId: 'r8', title: 'k8', ts: now - 3 * H, summary: '做完了', files: [], source: 'command' }],
      tasks: [
        ...history.map((h, i) => finished('x' + h.id, h.id, ['failed', 'done', 'stopped'][i % 3], (10 + i) * H, i % 3 === 0 ? { failed: '早年的失败' } : { summary: '早做完了' })),
        T('k1', 'r1', 'working', 5 * 60_000),
        T('k2', 'r2', 'asking', 6 * 60_000, { receipt: { question: '用哪个库？', files: [], explicit: true } }),
        finished('k3', 'r3', 'done', 4 * H, { summary: '集成完了' }),
        finished('k4', 'r4', 'done', 3 * H, { summary: '集成完了' }),
        finished('k5', 'r5', 'failed', 3 * H, { failed: '没有权限' }),
        finished('k6', 'r6', 'failed', 2 * H, { failed: '额度用尽' }, { boardId: 'card1' }),
        T('k7', 'r7', 'working', 90 * 60_000, { boardId: 'card1', project: 'live' }),
        finished('k8', 'r8', 'done', 3 * H, { summary: '做完了' }),
        finished('k9', 'z1', 'done', 5 * H, { summary: '收尾了' }, { project: 'Finished' }),
      ],
    },
  }));
  const env = { ...process.env, ZDOTDIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  // a 2x screen, as on the MacBook these layouts were made on (the least a map shows at depends on it; crew-map-readable covers 1x)
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`, '--force-device-scale-factor=2'], env,
  });
  page = await application.firstWindow();
  page.on('dialog', (d) => d.accept());
  await expect.poll(() => page.evaluate(() => typeof config === 'undefined' ? null : config.resumeOnRestart)).toBe(false);
  await expect.poll(() => page.evaluate(() => config.perpetualCaptain && config.perpetualCaptain.enabled)).toBe(false);
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size)).toBe(11);
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const live = () => page.evaluate(() => columns.map((c) => c.id).sort());

test('after a restart only the current work is left on the map', async () => {
  // The 10 quiet minutes are shortened so the real heartbeat can be watched; the
  // 60 s of silent output that archiveColumn itself requires is not.
  test.setTimeout(150_000);
  await page.evaluate(() => { MainCore.ARCHIVE_AFTER = 1500; });
  await expect.poll(live, { timeout: 120_000 }).toEqual(['cap', 'mine', 'r1', 'r2', 'r5', 'r7', 'r8']);
  const archived = await page.evaluate(() => config.archived.map((a) => a.id));
  expect(archived).toEqual(expect.arrayContaining(['r3', 'r4', 'r6']));
  await page.evaluate(() => showView('board'));
  await expect(page.locator('#crewMap')).toBeVisible();
  const ids = await page.locator('.cm-node.kind-worker').evaluateAll((nodes) => nodes.map((n) => n.dataset.nodeId).sort());
  expect(ids).toEqual(['r1', 'r2', 'r5', 'r7', 'r8']);
  // 'Live' and 'live' are one project box, and the finished project's box is gone
  await expect(page.locator('.cm-project')).toHaveCount(1);
  await expect(page.locator('.cm-project')).toHaveAttribute('data-project', 'Live');
  expect(await page.locator('.cm-node[data-node-id="r5"]').getAttribute('data-status')).toBe('failed');
});

test('the project title counts only what is on the map, the same as the 队长 box', async () => {
  await page.evaluate(() => showView('board'));
  const summary = page.locator('.cm-project .cm-project-summary');
  await expect(summary).toHaveText('2 干活中 · 1 待补充 · 1 失败 · 1 已完成');
  await expect(page.locator('.cm-node.kind-captain .cm-line')).toHaveText('2 干活中 · 1 待补充 · 1 失败 · 1 已完成');
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'crew-map-live-only.png'), animations: 'disabled', scale: 'css' });
  }
});
