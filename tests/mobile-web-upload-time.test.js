'use strict';
// A phone on a weak uplink needs more than 10 s to send a shrunk image (up to about 1 MB): the whole request may
// take 30 s now. Slow headers are still cut at 10 s, the other limits (size, one upload at a time, login and CSRF
// before the body is read) are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MobileWebServer } = require('../mobile-web');

test('the local web service gives a whole request 30 s and its headers 10 s', async (t) => {
  const server = new MobileWebServer({ getSessions: () => [], getTasks: () => [], getOutput: () => null, sendCaptain() {}, saveSettings() {} });
  t.after(() => server.close());
  assert.equal((await server.configure({ enabled: true, port: 0 })).enabled, true);
  assert.equal(server.server.requestTimeout, 30_000);
  assert.equal(server.server.headersTimeout, 10_000);
});
