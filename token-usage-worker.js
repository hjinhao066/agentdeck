'use strict';
// The Token 用量 scan in its own utility process (token-usage-main.js forks it
// once per scan), so reading a few GB of logs never holds up the app's main
// process. One message in ({ home, cacheFile, extraClaude }), one message out,
// then it exits.
const { scan } = require('./token-usage-scan');

process.parentPort.once('message', async ({ data }) => {
  try {
    const result = await scan(data || {});
    process.parentPort.postMessage({ ok: true, result });
  } catch (error) {
    process.parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
  }
  setImmediate(() => process.exit(0));
});
