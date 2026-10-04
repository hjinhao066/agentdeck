// Let normal Electron shutdown run after the inspector evaluation returns.
module.exports = async function closeElectron(application) {
  // The existing test/hook timeout bounds shutdown. Close Playwright's
  // context while waiting so its inspector connections can be released.
  const closed = application.waitForEvent('close', { timeout: 0 });
  await application.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  await Promise.all([closed, application.close()]);
};
