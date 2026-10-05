const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only`;

for (const mode of ['ack', 'no-ack', 'blocked-main-loop']) {
  test(`restart shutdown exits the actual process with ${mode}`, async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-restart-exit-'));
    const records = [];
    let application, child, deadline;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
      resumeOnRestart: true,
      columns: mode === 'blocked-main-loop' ? [] : [{
        id: 'exit-fake', title: 'isolated exit agent', cmd: fake, cwd: profile,
      }],
    }));
    try {
      application = await electron.launch({ args: [root, `--test-user-data=${profile}`], env });
      application.on('console', (message) => {
        const text = message.text();
        if (text.startsWith('QUIT_TEST_EVENT ')) records.push(JSON.parse(text.slice('QUIT_TEST_EVENT '.length)));
      });
      const page = await application.firstWindow();
      await expect.poll(() => page.evaluate(() => typeof window.MainSession === 'object').catch(() => false)).toBe(true);
      if (mode !== 'blocked-main-loop') {
        await expect.poll(() => page.evaluate(() => !!terms.get('exit-fake')?.alive)).toBe(true);
      }
      child = application.process();
      const start = Date.now();
      const exited = new Promise((resolve, reject) => {
        child.once('exit', (code, signal) => { clearTimeout(deadline); resolve({ code, signal }); });
        deadline = setTimeout(() => reject(new Error(`${mode}: actual Electron process did not exit within 8 seconds`)), 8000);
      });
      await application.evaluate(({ app, ipcMain }, mode) => {
        const record = (kind) => console.log('QUIT_TEST_EVENT ' + JSON.stringify({ kind, at: Date.now() }));
        if (mode === 'no-ack') ipcMain.removeAllListeners('park-for-restart-done');
        else ipcMain.on('park-for-restart-done', () => record('ack'));
        app.on('before-quit', () => record('before-quit'));
        app.on('will-quit', () => record('will-quit'));
        if (mode === 'blocked-main-loop') app.once('before-quit', () => {
          // Native teardown and synchronous cleanup can also block timers.
          // Only the independent watchdog can meet the deadline in this case.
          setImmediate(() => { const end = Date.now() + 15000; while (Date.now() < end) {} });
        });
        setTimeout(() => app.quit(), 50);
      }, mode);
      const result = await exited;
      expect(Date.now() - start).toBeLessThan(8000);
      if (mode === 'ack') expect(records.some((record) => record.kind === 'ack')).toBe(true);
      if (mode === 'no-ack') {
        expect(records.some((record) => record.kind === 'ack')).toBe(false);
        const attempts = records.filter((record) => record.kind === 'before-quit');
        expect(attempts.length).toBeGreaterThanOrEqual(2);
        expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(1400);
      }
      if (mode === 'blocked-main-loop') {
        expect(records.some((record) => record.kind === 'will-quit')).toBe(false);
        expect(result.signal === 'SIGKILL' || (process.platform === 'win32' && result.code !== 0)).toBe(true);
      }
    } finally {
      clearTimeout(deadline);
      // Harness cleanup is never counted as successful app shutdown.
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
