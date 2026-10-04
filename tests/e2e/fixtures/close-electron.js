// Let normal Electron shutdown run after the inspector evaluation returns.
module.exports = async function closeElectron(application) {
  const closed = application.waitForEvent('close');
  await application.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  await closed;
  await application.close();
};
