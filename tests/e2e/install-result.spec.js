const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No real applications or launch jobs: the real renderer/IPC persistence runs
// in a private profile; runtime evidence parsing is covered by install-result.test.
test('installation waits across restart, rejects early complete, and records success/failure durably', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-install-receipt-e2e-'));
  const prompts = path.join(profile, 'prompts.jsonl');
  const receiptEnv = path.join(profile, 'agent-env');
  fs.mkdirSync(receiptEnv);
  const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only`;
  const columns = ['captain', 'success-worker', 'failed-worker'].map((id) => ({
    id, title: id, cmd: fake, cwd: profile, role: 'manual', isMain: id === 'captain', captainCrew: id !== 'captain',
  }));
  const tasks = ['success', 'failed'].map((status) => ({ id: status + '-task', colId: status + '-worker', title: '安装核对',
    gen: 1, status: 'working', startedAt: Date.now(), instructionSent: true,
    instruction: '不要重复派发的安装指令', pendingInstall: { id: status + '-install', targetVersion: '1.2.0', createdAt: Date.now() },
  }));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, columns, resumeOnRestart: true,
    mainSession: { colId: 'captain', cmd: fake, gen: 1, fresh: false, crewMarked: true, tasks, pending: [], inflight: [], waitlist: [] } }));
  const env = { ...process.env, ZDOTDIR: profile };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  env.AGENTDECK_TEST_PROMPT_COLUMNS_FILE = prompts;
  env.AGENTDECK_TEST_RECEIPT_ENV_DIR = receiptEnv;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => !!window.MainSession?.mainCol()).catch(() => false), { timeout: 20000 }).toBe(true);
    // Prove the stand-in agents actually started before checking that no
    // installation instruction was resent across the cold start.
    await expect.poll(() => ['success-worker', 'failed-worker'].every((id) =>
      fs.existsSync(path.join(receiptEnv, id + '.json'))), { timeout: 20000 }).toBe(true);
    for (const status of ['success', 'failed']) {
      const check = await page.evaluate(async (status) => {
        const caller = columns.find((c) => c.id === status + '-worker');
        const response = await MainSession.submit({ action: 'progress', message: '安装待核对', installId: status + '-install', targetVersion: '1.2.0' }, caller);
        const early = await MainSession.submit({ action: 'complete', result: '已就绪、马上触发' }, caller).then(() => '', (e) => e.message);
        return { identity: JSON.parse(response.result), early };
      }, status);
      expect(check.identity).toEqual({ taskId: status + '-task', columnId: status + '-worker' });
      expect(check.early).toContain('安装待核对');
      const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
      expect(persisted.mainSession.tasks.find((t) => t.id === status + '-task').pendingInstall.id).toBe(status + '-install');
      await page.evaluate(async (status) => {
        await MainSession.handle({ action: 'main-install-result', result: '安装 1.2.0 ' + status + '，现役版本已核对',
          installResult: { id: status + '-install', taskId: status + '-task', columnId: status + '-worker', targetVersion: '1.2.0', status, reason: status === 'failed' ? '复制失败，已恢复旧版' : '' },
        }, MainSession.mainCol());
      }, status);
      const final = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).mainSession.tasks.find((t) => t.id === status + '-task');
      expect(final.status).toBe(status === 'success' ? 'done' : 'failed');
      expect(final.pendingInstall).toBeUndefined();
      expect(final.installResultId).toBe(status + '-install');
    }
    const delivered = fs.existsSync(prompts) ? fs.readFileSync(prompts, 'utf8') : '';
    expect(delivered).not.toContain('不要重复派发的安装指令');
  } finally {
    if (app) {
      const proc = app.process();
      await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
