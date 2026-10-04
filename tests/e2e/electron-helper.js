'use strict';
const { _electron } = require('@playwright/test');

// Playwright closes the context before quitting Electron. Electron 44 can stall
// that route while PTYs are active. Queue quit outside the inspector evaluation
// and wait for the actual child exit. Restart tests require a graceful exit.
async function closeElectron(application, { timeout = 10000, requireGraceful = true } = {}) {
  if (!application) return;
  const child = application.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let timer;
  let forced = false;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); resolve(); }, timeout);
  });
  try {
    const quit = application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => {});
    await Promise.race([exited, deadline]);
    if (forced) {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Test Electron PID ${child.pid} did not exit after SIGKILL`)), 5000);
      })]);
      console.warn(`Test Electron PID ${child.pid} exceeded ${timeout}ms; killed only its own process.`);
      if (requireGraceful) throw new Error(`Test Electron PID ${child.pid} required forced shutdown`);
    }
    // The evaluation can reject on the closed inspector; it is already handled.
    void quit;
  } finally { clearTimeout(timer); }
}

// Observe real status-heartbeat passes, including the production quiet guard.
// Negative assertions must run after the code had a chance to act.
async function waitForTicks(page, id, count = 2, pastQuiet = false) {
  const { expect } = require('@playwright/test');
  await page.evaluate(({ id, pastQuiet }) => {
    window.testTickCount = 0;
    window.testOriginalTick = MainSession.onTick;
    MainSession.onTick = function (colId, entry) {
      window.testOriginalTick(colId, entry);
      if (colId === id && (!pastQuiet || Date.now() - (entry.typing?.lastKeyAt || 0) >= INPUT_QUIET)) window.testTickCount++;
    };
  }, { id, pastQuiet });
  try {
    await expect.poll(() => page.evaluate(() => window.testTickCount), { timeout: 20000 }).toBeGreaterThanOrEqual(count);
  } finally {
    await page.evaluate(() => { MainSession.onTick = window.testOriginalTick; delete window.testOriginalTick; delete window.testTickCount; });
  }
}

module.exports = { electron: _electron, closeElectron, waitForTicks };
