'use strict';
// A seat that cannot work must not look normal. The stored login is checked passively (can it be
// read, is it JSON, has it run out), and every row (sidebar, 队长's `quota`, both phone pages) takes
// one colour from QuotaCore: ok as before, yellow for old numbers or a failed query, red for a
// damaged or expired login, a signed-out seat, or a used-up one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../claude-seats-core');
const M = require('../claude-seats-main');
const Q = require('../quota-core');
const Hub = require('../mobile-web/hub/core');
const { quotaView } = require('../mobile-web');

const NOW = Date.UTC(2026, 9, 9, 3, 0);
const SECRET = 'sk-ant-oat01-do-not-print';
const oauth = (extra = {}) => JSON.stringify({ claudeAiOauth: { accessToken: SECRET, refreshToken: SECRET + '-r', expiresAt: NOW + 3600_000, scopes: ['user:profile'], ...extra } });
// What 2.0.2's renewal left in the Keychain: the first 128 bytes of a credential.
const TRUNCATED = oauth().slice(0, 128);

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-seat-health-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const keychain = (stdout, error = null) => (file, args, options, cb) => cb(error, stdout);

test('the Keychain check says what is wrong with a stored login without ever returning it', async () => {
  const read = (stdout, error) => M.credentialStatus('Claude Code-credentials-abc', keychain(stdout, error), NOW);
  const truncated = await read(TRUNCATED);
  assert.equal(truncated.present, false);
  assert.deepEqual(truncated.credential, { state: 'invalid', bytes: 128, store: 'keychain' });
  assert.match(truncated.loginReason, /凭据格式无效.*128 字节.*不是合法 JSON/);
  assert.deepEqual((await read(oauth())).credential, { state: 'ok', bytes: Buffer.byteLength(oauth()), store: 'keychain' });
  // An expired access token with a live refresh token is renewed by Claude itself: still fine.
  assert.equal((await read(oauth({ expiresAt: NOW - 1 }))).credential.state, 'ok');
  assert.equal((await read(oauth({ expiresAt: NOW - 1, refreshToken: undefined }))).credential.state, 'expired');
  assert.equal((await read(oauth({ expiresAt: NOW - 1, refreshTokenExpiresAt: NOW - 1 }))).credential.state, 'expired');
  assert.equal((await read('{"mcpOAuth":{}}')).credential.state, 'no-oauth');
  assert.equal((await read('', { code: 44 })).credential.state, 'missing');
  const locked = await read('', { code: 1 });
  assert.equal(locked.credential.state, 'unreadable'); assert.equal(locked.loginReason, ''); assert.match(locked.authReason, /钥匙串/);
  for (const value of [truncated, await read(oauth())]) assert.doesNotMatch(JSON.stringify(value), /sk-ant|do-not-print/);
});

test('Windows and test profiles parse the credential file instead of only seeing that it exists', async (t) => {
  const dir = home(t), seat = S.normalize()[1], loc = M.credentialLocation(seat, dir);
  fs.mkdirSync(loc.dir, { recursive: true });
  fs.writeFileSync(loc.credentialsPath, TRUNCATED);
  const broken = await M.seatInfo(seat, dir, 'win32');
  assert.equal(broken.loggedIn, false);
  assert.deepEqual(broken.credential, { state: 'invalid', bytes: 128, store: 'file' });
  assert.match(broken.loginReason, /US（us）：此席位凭据格式无效/);
  fs.writeFileSync(loc.credentialsPath, '{}');
  assert.equal((await M.seatInfo(seat, dir, 'test')).credential.state, 'no-oauth');
  fs.writeFileSync(loc.credentialsPath, oauth({ expiresAt: Date.now() + 3600_000 }));
  const fine = await M.seatInfo(seat, dir, 'win32');
  assert.equal(fine.loggedIn, true); assert.equal(fine.credential.state, 'ok');
  fs.unlinkSync(loc.credentialsPath);
  assert.equal((await M.seatInfo(seat, dir, 'win32')).credential.state, 'missing');
  assert.doesNotMatch(JSON.stringify([broken, fine]), /sk-ant|do-not-print/);
});

// ---- one colour per row ----
const seat = (info) => ({ id: 'us', name: 'US', configDir: '~/.claude-us', info: { loggedIn: true, accountEmail: 'jinhao.h.sub@example.com', plan: 'Max', ...info } });
const signedIn = { loggedIn: true, credential: { state: 'ok', bytes: 470, store: 'keychain' } };
function official(at, extra = {}) {
  return { [Q.seatKey('us')]: { scope: 'claude', configDir: '~/.claude-us', credentialKey: 'k', accountKey: 'a',
    sample: { provider: 'Claude', scope: 'claude', seatId: 'us', configDir: '~/.claude-us', credentialKey: 'k', accountKey: 'a', at, official: true, accountBound: true,
      source: Q.CLAUDE_OAUTH_SOURCE, confidence: '高（官方采样）', windows: [
        { label: '5 小时', remaining: 40, resetAt: NOW + 3600_000 }, { label: '每周', remaining: 90, resetAt: NOW + 4 * 86400_000 }] }, ...extra } };
}
const health = (store, info) => Q.summary(store, 'Claude', NOW, seat(info)).health;

test('a fresh, signed-in seat stays as it always was', () => {
  assert.deepEqual(health(official(NOW - 60_000), signedIn), { level: 'ok', kind: 'ok', label: '正常', reason: '', action: '' });
  // No seat information yet (the seat list has not answered): no colour is guessed.
  assert.equal(Q.summary(official(NOW - 60_000), 'Claude', NOW, { id: 'us', name: 'US', configDir: '~/.claude-us' }).health.level, 'ok');
});

test('old numbers and failed queries are yellow and say what to do', () => {
  const stale = health(official(NOW - 3 * 3600_000, { officialStatus: { failure: '用量查询失败', failures: 3 } }), signedIn);
  assert.equal(stale.level, 'warn'); assert.equal(stale.kind, 'stale'); assert.equal(stale.label, '数据已旧');
  assert.match(stale.reason, /连续 3 次/); assert.match(stale.action, /网络|重新登录/);
  const failed = health(official(NOW - 60_000, { officialStatus: { failure: '用量查询失败', failures: 1 } }), signedIn);
  assert.equal(failed.level, 'warn'); assert.equal(failed.kind, 'failed'); assert.equal(failed.label, '查询失败');
  const unverified = health(official(NOW - 60_000), { loggedIn: false, authReason: 'US（us）：无法核实此席位钥匙串', credential: { state: 'unreadable', bytes: 0, store: 'keychain' } });
  assert.equal(unverified.level, 'warn'); assert.equal(unverified.kind, 'unverified');
});

test('a damaged, expired or missing login, a confirmed logout and a used-up seat are red', () => {
  // This morning: the numbers are still there, but the Keychain holds 128 bytes that are not JSON.
  const broken = health(official(NOW - 3 * 3600_000, { officialStatus: { failure: '用量查询失败', failures: 3 } }),
    { loggedIn: false, loginReason: 'US（us）：此席位凭据格式无效', credential: { state: 'invalid', bytes: 128, store: 'keychain' } });
  assert.deepEqual([broken.level, broken.kind, broken.label], ['bad', 'credential', '登录凭据坏了']);
  assert.match(broken.reason, /钥匙串.*128 字节.*不是合法 JSON/); assert.match(broken.action, /需要重新登录/);
  const expired = health(official(NOW - 60_000), { loggedIn: false, loginReason: 'x', credential: { state: 'expired', bytes: 300, store: 'file' } });
  assert.deepEqual([expired.level, expired.kind, expired.label], ['bad', 'login-expired', '登录已过期']);
  const missing = health({}, { loggedIn: false, loginReason: 'x', credential: { state: 'missing', bytes: 0, store: 'keychain' } });
  assert.deepEqual([missing.level, missing.kind, missing.label], ['bad', 'logged-out', '未登录']);
  assert.match(missing.action, /需要重新登录/);
  // The CLI itself says signed out, though the stored login looks fine.
  assert.equal(health({}, { loggedIn: false, loginReason: 'US（us）：Claude 登录状态显示此席位未登录', credential: { state: 'ok', bytes: 400, store: 'keychain' } }).kind, 'logged-out');
  const confirmed = health({ [Q.seatKey('us')]: { scope: 'claude', configDir: '~/.claude-us', auth: { status: 'logged-out', at: NOW } } }, signedIn);
  assert.deepEqual([confirmed.level, confirmed.kind], ['bad', 'logged-out']);
  // Codex has no seat directory: it is not called a Claude seat.
  const codex = Q.summary({ Codex: { scope: Q.SCOPES.Codex, auth: { status: 'logged-out', at: NOW } } }, 'Codex', NOW).health;
  assert.deepEqual([codex.level, codex.kind, codex.action], ['bad', 'logged-out', '需要重新登录']); assert.doesNotMatch(codex.reason, /Claude|席位/);
  const store = official(NOW - 60_000);
  store[Q.seatKey('us')].sample.windows[0] = { label: '5 小时', remaining: 0, exhausted: true, resetAt: NOW + 3600_000 };
  const out = health(store, signedIn);
  assert.deepEqual([out.level, out.kind, out.label], ['bad', 'exhausted', '额度用尽']);
  assert.match(out.action, /恢复|换/);
});

test('队长 reads the same state in words, and the phone gets it field by field', () => {
  const info = { loggedIn: false, loginReason: 'US（us）：此席位凭据格式无效', credential: { state: 'invalid', bytes: 128, store: 'keychain' } };
  const store = official(NOW - 3 * 3600_000, { officialStatus: { failure: '用量查询失败', failures: 3 } });
  const text = Q.text(store, NOW, [seat(info)]).split('\n')[0];
  assert.match(text, /【红】登录凭据坏了：钥匙串.*128 字节.*需要重新登录/);
  assert.match(Q.text(official(NOW - 3 * 3600_000, { officialStatus: { failure: 'x', failures: 3 } }), NOW, [seat(signedIn)]).split('\n')[0], /【黄】数据已旧/);
  assert.doesNotMatch(Q.text(official(NOW - 60_000), NOW, [seat(signedIn)]).split('\n')[0], /【[红黄]】/);
  const row = Q.mobile(store, NOW, [seat(info)]).find((r) => r.key === Q.seatKey('us'));
  assert.deepEqual(Object.keys(row.health).sort(), ['action', 'kind', 'label', 'level', 'reason']);
  assert.equal(row.health.level, 'bad');
  // The phone service and the hub keep only known values: an odd level never reads as fine or alarming.
  const served = quotaView({ rows: [row, { ...row, key: 'x', health: { level: 'purple', kind: 'boom', label: 1 } }] }, NOW).rows;
  assert.deepEqual(served[0].health, row.health);
  assert.equal('health' in served[1], false);
  const hub = Hub.cleanQuota({ rows: served }).rows;
  assert.deepEqual(hub[0].health, row.health); assert.equal(hub[1].health, null);
});

test('both phone pages colour a row from its health, or from its status when an older computer sends none', () => {
  const bad = { status: 'stale', failed: true, cells: [], health: { level: 'bad', kind: 'credential', label: '登录凭据坏了', reason: '钥匙串里的登录凭据有 128 字节，不是合法 JSON', action: '需要重新登录' } };
  assert.equal(Hub.rowHealth(bad).level, 'bad');
  assert.equal(Hub.quotaNote(bad, NOW), '登录凭据坏了 · 需要重新登录');
  assert.match(Hub.quotaState(bad, false), /^登录凭据坏了：钥匙串.*；需要重新登录/);
  assert.match(Hub.quotaLabel({ ...bad, name: 'Claude jinhao.h.sub' }, NOW), /^Claude jinhao\.h\.sub；登录凭据坏了，需要重新登录/);
  assert.equal(Hub.rowHealth({ status: 'out', cells: [] }).level, 'bad');
  assert.equal(Hub.rowHealth({ status: 'stale', cells: [] }).level, 'warn');
  assert.equal(Hub.rowHealth({ status: 'normal', failed: true, cells: [] }).level, 'warn');
  assert.equal(Hub.rowHealth({ status: 'normal', cells: [] }).level, 'ok');
  // The single-machine page uses the same rule.
  const page = fs.readFileSync(path.join(__dirname, '..', 'mobile-web', 'app.js'), 'utf8');
  assert.match(page, /dataset\.health = rowHealth\(row\)\.level/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'mobile-web', 'hub', 'app.js'), 'utf8'), /const health = Core\.rowHealth\(row\);\s+item\.dataset\.health = health\.level/);
});
