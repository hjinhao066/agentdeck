const { spawnSync } = require('child_process');
// Let normal Electron shutdown run after the inspector evaluation returns.
// This is fixture cleanup, not evidence that graceful shutdown succeeded.
module.exports = async function closeElectron(application) {
  const child = application.process();
  const force = setTimeout(() => {
    console.warn(`Electron fixture PID ${child.pid} did not close after normal quit; forcing cleanup`);
    // Playwright launches each POSIX Electron in its own process group.
    // Its helpers can keep inherited stdio open even after the main PID exits.
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else process.kill(-child.pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }, 10000);
  try {
    const closed = application.waitForEvent('close', { timeout: 0 });
    await application.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await Promise.all([closed, application.close().catch((error) => {
      // The normal quit may close Playwright's context before close() reaches it.
      // Still require the application close event, and propagate other errors.
      if (!/Target page, context or browser has been closed/.test(error.message)) throw error;
    })]);
  } finally { clearTimeout(force); }
};
