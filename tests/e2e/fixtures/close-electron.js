// Let normal Electron shutdown run after the inspector evaluation returns.
module.exports = async function closeElectron(application) {
  // The existing test/hook timeout bounds shutdown. Close Playwright's
  // context while waiting so its inspector connections can be released.
  const closed = application.waitForEvent('close', { timeout: 0 });
  await application.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  await Promise.all([closed, application.close().catch((error) => {
    // The normal quit may close Playwright's context before close() reaches it.
    // Still require the application close event, and propagate other errors.
    if (!/Target page, context or browser has been closed/.test(error.message)) throw error;
  })]);
};
