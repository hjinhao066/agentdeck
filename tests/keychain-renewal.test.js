'use strict';
// A seat's renewed credential must reach its macOS Keychain item whole. `security add-generic-password
// … -w` with no value reads the secret at a password prompt that keeps only its first 128 bytes and
// still exits 0; a Claude credential is several hundred bytes, so the item was left holding a cut-off,
// unparseable JSON and the seat read as signed out (2.0.2 on 10-09: the idle US seat, 07:12).
// `security -i` reads one command per line into a 4 KB buffer; a longer line is cut, a part of it
// stored, and the exit code is 1 (measured on macOS 15.7.4: a 4082-character line is stored whole, a
// 4102-character one is not).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const C = require('../quota-claude');
const S = require('../claude-seats-core');
const M = require('../claude-seats-main');

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-renewal-')));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); C.clearCredentialCache(); });
  for (const seat of S.normalize()) {
    const loc = M.credentialLocation(seat, home);
    fs.mkdirSync(loc.dir);
    fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { accountUuid: 'fake-account-' + seat.id, emailAddress: seat.id + '@example.com' } }));
  }
  return home;
}
// The size of a real one: two ~108-character tokens, expiry, scopes, plan.
function credential(extra = {}) {
  return JSON.stringify({
    claudeAiOauth: { accessToken: 'fake-expired-access-' + 'a'.repeat(88), refreshToken: 'fake-refresh-' + 'b'.repeat(95),
      expiresAt: 1, refreshTokenExpiresAt: Date.now() + 86400000, scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
    mcpOAuth: { keep: 'yes' },
    ...extra,
  });
}
const renewal = async () => ({ access_token: 'fake-fresh-access-' + 'c'.repeat(90), refresh_token: 'fake-rotated-refresh-' + 'd'.repeat(87),
  expires_in: 28800, refresh_token_expires_in: 86400 * 30, scope: 'user:inference user:profile user:sessions:claude_code' });
const free = (fn) => fn(); // no Claude runs on the seat

// /usr/bin/security as macOS runs it, for the two ways of writing an item.
function keychain(items) {
  const exec = (bin, args, opts, cb) => {
    assert.equal(bin, '/usr/bin/security');
    const service = args[args.indexOf('-s') + 1];
    queueMicrotask(() => items.has(service) ? cb(null, items.get(service) + '\n') : cb(Object.assign(new Error('not found'), { code: 44 })));
  };
  const run = (args, input) => {
    if (args.length === 1 && args[0] === '-i') {
      const line = input.split('\n')[0], kept = line.slice(0, 4094);
      const match = /^add-generic-password -U -a [\w.-]+ -s "([^"]+)" -X ([0-9a-f]+)/.exec(kept);
      if (!match) return 1;
      items.set(match[1], Buffer.from(match[2].slice(0, match[2].length - match[2].length % 2), 'hex').toString('utf8'));
      return kept === line ? 0 : 1;
    }
    if (args[0] === 'add-generic-password' && args.at(-1) === '-w') {
      items.set(args[args.indexOf('-s') + 1], Buffer.from(input.split('\n')[0]).subarray(0, 128).toString('utf8'));
      return 0;
    }
    return 1;
  };
  const spawn = (bin, args) => {
    assert.equal(bin, '/usr/bin/security');
    const child = new EventEmitter();
    let input = '';
    child.stdin = { write(chunk) { input += chunk; return true; }, end() { queueMicrotask(() => child.emit('close', run(args, input))); } };
    child.kill = () => {};
    return child;
  };
  return { exec, spawn };
}

test('a renewed credential reaches the seat\'s Keychain item whole, and the next poll reads it', async (t) => {
  const home = fixture(t), seat = S.normalize().find((item) => item.id === 'us'), service = M.credentialLocation(seat, home).keychainService;
  const items = new Map([[service, credential()]]), { exec, spawn } = keychain(items);
  const fresh = await C.readCredentials(seat, home, 'darwin', exec, { post: renewal, spawn, exclusive: free });
  assert.match(fresh, /^fake-fresh-access-/);
  const stored = items.get(service);
  assert.ok(Buffer.byteLength(stored) > 128, `the Keychain item holds ${Buffer.byteLength(stored)} bytes`);
  const parsed = JSON.parse(stored);
  assert.equal(parsed.claudeAiOauth.accessToken, fresh);
  assert.match(parsed.claudeAiOauth.refreshToken, /^fake-rotated-refresh-/);
  assert.equal(parsed.mcpOAuth.keep, 'yes');
  // Another process (the next AgentDeck launch, or the seat's own CLI) reads the item, not this cache.
  C.clearCredentialCache();
  assert.equal(await C.readCredentials(seat, home, 'darwin', exec, { post: async () => assert.fail('no second renewal'), spawn, exclusive: free }), fresh);
});

test('a credential too long for one `security -i` line is not renewed: the server keeps its refresh token and the item stays whole', async (t) => {
  const home = fixture(t), seat = S.normalize().find((item) => item.id === 'us'), service = M.credentialLocation(seat, home).keychainService;
  const big = credential({ mcpOAuth: { keep: 'yes', server: 'x'.repeat(2400) } });
  const items = new Map([[service, big]]), { exec, spawn } = keychain(items), posts = [];
  const token = await C.readCredentials(seat, home, 'darwin', exec, { post: async (body) => { posts.push(body); return renewal(); }, spawn, exclusive: free });
  // Renewing first would rotate the refresh token on the server and then fail to store the new one.
  assert.equal(posts.length, 0, 'renewed although the result cannot be stored');
  assert.equal(token, null);
  assert.equal(items.get(service), big);
});

// The real Keychain: a throwaway item (its service named after a temporary directory), deleted after.
// Opt-in, so a test run never touches a developer's or CI's login Keychain unasked:
// AGENTDECK_KEYCHAIN_TEST=1 node --test tests/keychain-renewal.test.js
test('macOS: the real `security` stores the renewed credential whole', { skip: (process.platform !== 'darwin' || process.env.AGENTDECK_KEYCHAIN_TEST !== '1') && 'macOS, AGENTDECK_KEYCHAIN_TEST=1' }, async (t) => {
  const home = fixture(t), seat = { id: 'probe', name: 'Probe', configDir: path.join(home, 'seat-probe') };
  const service = M.credentialLocation(seat, home).keychainService, account = os.userInfo().username;
  assert.match(service, /^Claude Code-credentials-[0-9a-f]{8}$/);
  const drop = () => { try { execFileSync('/usr/bin/security', ['delete-generic-password', '-a', account, '-s', service], { stdio: 'ignore' }); } catch (_) {} };
  t.after(drop);
  const raw = credential();
  // Read as the seat item, written through the real /usr/bin/security.
  const exec = (bin, args, opts, cb) => cb(null, raw);
  const fresh = await C.readCredentials(seat, home, 'darwin', exec, { post: renewal, exclusive: free });
  assert.match(fresh, /^fake-fresh-access-/);
  const back = execFileSync('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'], { encoding: 'utf8' }).trim();
  assert.ok(back.length > 128, `the Keychain item holds ${back.length} bytes`);
  assert.equal(JSON.parse(back).claudeAiOauth.accessToken, fresh);
  assert.equal(JSON.parse(back).mcpOAuth.keep, 'yes');
});
