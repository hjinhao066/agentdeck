'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { readCodex, accountIdentity } = require('../quota-codex');
function server(mode, methods) {
  return (command, args, options) => {
    assert.match(command, /^codex(?:\.exe)?$/);
    assert.deepEqual(args, ['app-server']);
    assert.equal(options.shell, false);
    assert.equal(options.stdio[2], 'ignore');
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; };
    child.stdin.on('data', line => {
      const m = JSON.parse(line); methods.push(m.method);
      if (mode === 'timeout' || !m.id) return;
      let result = {};
      if (m.id === 2) result = { account: { type: mode === 'api' ? 'apiKey' : 'chatgpt', email: 'alice@example.com', accessToken: 'DO-NOT-RETURN' } };
      if (m.id === 2 && mode === 'logout') result = { account: null };
      if (m.id === 2 && mode === 'malformed') result = {};
      if (m.id === 3) result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300 }, secondary: { usedPercent: 28, windowDurationMins: 10080 } }, secret: 'DO-NOT-RETURN' };
      const payload = JSON.stringify(m.id === 2 && mode === 'error' || m.id === 3 && mode === 'quota-error'
        ? { id: m.id, error: { message: 'DO-NOT-RETURN' } } : { id: m.id, result }) + '\n';
      setImmediate(() => { child.stdout.write(payload.slice(0, 7)); child.stdout.write(payload.slice(7)); });
    });
    return child;
  };
}
test('read-only official RPC client handles partial stdout and returns only quota and masked account', async () => {
  const methods = [];
  const q = await readCodex({}, server('ok', methods));
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.deepEqual(q.windows.map(w => w.remaining), [88, 72]);
  assert.equal(q.account, 'al***@example.com');
  assert.equal(q.authStatus, 'logged-in');
  assert.ok(!JSON.stringify(q).includes('DO-NOT-RETURN'));
  assert.ok(!JSON.stringify(q).includes('alice@example.com'));
});
test('missing CLI, API-key login and RPC timeout return no invented quota', async () => {
  assert.equal(await readCodex({}, () => { throw new Error('not installed'); }), null);
  const methods = [];
  assert.equal(await readCodex({}, server('api', methods)), null);
  assert.ok(!methods.includes('account/rateLimits/read'));
  assert.equal(await readCodex({}, server('timeout', []), 15), null);
  assert.deepEqual(accountIdentity('opaque-access-token'), {});
});

test('only an explicit empty account proves logout; RPC failures and malformed responses stay unknown', async () => {
  const methods = [], sample = await readCodex({}, server('logout', methods));
  assert.equal(sample.authStatus, 'logged-out');
  assert.equal(sample.failureOnly, true);
  assert.equal(sample.windows, undefined);
  assert.ok(!methods.includes('account/rateLimits/read'));
  assert.equal(await readCodex({}, server('error', [])), null);
  assert.equal(await readCodex({}, server('malformed', [])), null);
  const quotaError = await readCodex({}, server('quota-error', []));
  assert.equal(quotaError.authStatus, undefined);
  assert.equal(quotaError.identityOnly, true);
  assert.equal(quotaError.account, 'al***@example.com');
  assert.ok(!JSON.stringify(quotaError).includes('DO-NOT-RETURN'));
});
