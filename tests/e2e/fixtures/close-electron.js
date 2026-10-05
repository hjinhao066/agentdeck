// Let normal Electron shutdown run after the inspector evaluation returns.
// This is fixture cleanup, not evidence that graceful shutdown succeeded.
module.exports = async function closeElectron(application) {
  const child = application.process();
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      console.warn(`Electron fixture PID ${child.pid} did not exit after normal quit; forcing cleanup`);
      child.kill('SIGKILL');
    }
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
