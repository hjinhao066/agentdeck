'use strict';
// 入口登录（第一层）：登录页 + 长期 cookie，代替浏览器自带的基础认证弹框。
// 同 vps-caddy.test.js：本机临时 Caddy 2.6.x（CADDY_BIN）加两台假电脑，不碰真实 VPS。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./fixtures/vps/caddy-harness');

const caddy = H.findCaddy();
const skip = caddy ? false : 'caddy binary not found (set CADDY_BIN)';
const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const DAY = 24 * 60 * 60;
const cookieOf = (headers) => [].concat(headers['set-cookie'] || []).find((c) => c.startsWith('__Host-agentdeck_gate='));

test('入口登录页与长期 cookie', { skip }, async (t) => {
  const s = await H.startStack(caddy);
  t.after(async () => { await s.stop(); s.cleanup(); });
  const req = (p, o = {}) => H.request(s.port, p, { auth: false, ...o });
  const none = () => assert.equal(s.mac.requests.length + s.win.requests.length, 0, 'no machine saw a request');
  s.mac.requests.length = 0; s.win.requests.length = 0;

  await t.test('没有 cookie：页面导航跳到登录页，其余请求 401 JSON，都不带 WWW-Authenticate，后端收不到任何请求', async () => {
    for (const p of ['/', '/index.html', '/mac/', '/mac/api/snapshot', '/win/api/info', '/machines.json']) {
      const page = await req(p, { headers: { Accept: 'text/html,application/xhtml+xml' } });
      assert.equal(page.status, 302, p);
      assert.equal(page.headers.location, '/gate/', p);
      assert.equal(page.headers['www-authenticate'], undefined);
      const api = await req(p, { headers: { Accept: 'application/json' } });
      assert.equal(api.status, 401, p);
      assert.deepEqual(api.json, { gate: 'login' });
      assert.equal(api.headers['www-authenticate'], undefined, 'no native Basic dialog');
      assert.match(api.headers['content-type'], /^application\/json/);
    }
    for (const method of ['POST', 'HEAD', 'OPTIONS', 'PUT']) {
      const r = await req('/mac/api/captain', { method });
      assert.equal(r.status, 401, method);
      assert.equal(r.headers['www-authenticate'], undefined);
    }
    // Looks like a cookie but is not the secret.
    const wrong = await req('/', { gate: 'a'.repeat(64), headers: { Accept: 'application/json' } });
    assert.equal(wrong.status, 401);
    const empty = await req('/', { headers: { Accept: 'application/json', Cookie: '__Host-agentdeck_gate=' } });
    assert.equal(empty.status, 401);
    none();
  });

  await t.test('登录页免登录：能打开，带严格 CSP，没有内联脚本，其余文件仍然要登录', async () => {
    const page = await req('/gate/');
    assert.equal(page.status, 200);
    assert.match(page.text, /id="gate-form"/);
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(page.text) && !/\son\w+=/.test(page.text) && !/\sstyle=/.test(page.text), 'no inline script/style/handler');
    assert.equal(page.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    assert.equal(cookieOf(page.headers), undefined);
    assert.equal((await req('/gate/gate.js')).status, 200);
    assert.equal((await req('/gate/gate.css')).status, 200);
    assert.equal((await req('/app.js', { headers: { Accept: '*/*' } })).status, 401);
    assert.equal((await req('/gate/../app.js')).status, 404, 'ambiguous path');
    assert.equal((await req('/gate/login')).status, 404, 'GET is not the login');
    assert.ok(!(await req('/gate/.x')).text.includes('secret'));
    none();
  });

  await t.test('登录：口令对发 cookie（随机长串、400 天、HttpOnly、Secure、不带 Domain），错了不发', async () => {
    const wrongs = [basic(H.AUTH_USER, 'wrong'), basic('nobody', H.AUTH_PASS), 'Basic', 'Bearer abc'];
    for (const auth of wrongs) {
      const r = await req('/gate/login', { method: 'POST', auth });
      assert.equal(r.status, 401, auth);
      assert.equal(r.headers['www-authenticate'], undefined, 'fetch() must not trigger the native dialog');
      assert.equal(cookieOf(r.headers), undefined);
    }
    const missing = await req('/gate/login', { method: 'POST' });
    assert.equal(missing.status, 401);
    assert.equal(cookieOf(missing.headers), undefined);

    const ok = await req('/gate/login', { method: 'POST', auth: basic(H.AUTH_USER, H.AUTH_PASS) });
    assert.equal(ok.status, 204);
    const cookie = cookieOf(ok.headers);
    assert.ok(cookie, 'a gate cookie is issued');
    const [pair, ...attrs] = cookie.split('; ');
    const value = pair.split('=')[1];
    assert.equal(value, s.gateSecret, 'the value is the random secret from the gate file');
    assert.match(value, /^[0-9a-f]{64}$/);
    assert.notEqual(value, H.AUTH_PASS);
    assert.ok(!value.includes(H.AUTH_PASS));
    const maxAge = Number(attrs.find((a) => /^Max-Age=/i.test(a)).split('=')[1]);
    assert.ok(maxAge >= 365 * DAY, `lasts a year or more, got ${maxAge / DAY} days`);
    assert.ok(attrs.includes('HttpOnly') && attrs.includes('Secure') && attrs.includes('Path=/'));
    assert.ok(!attrs.some((a) => /^Domain=/i.test(a)), 'host-only (__Host- prefix)');
    assert.ok(attrs.some((a) => /^SameSite=Lax$/i.test(a)));
    assert.equal(ok.headers['cache-control'], 'no-store');
  });

  await t.test('有 cookie：总台、两台电脑都放行，cookie 不会转给任何一台电脑；每次打开首页续期', async () => {
    s.mac.requests.length = 0; s.win.requests.length = 0;
    const home = await req('/', { gate: s.gateSecret, headers: { Accept: 'text/html' } });
    assert.equal(home.status, 200);
    assert.match(home.text, /hub placeholder/);
    const renewed = cookieOf(home.headers);
    assert.ok(renewed && renewed.includes(`=${s.gateSecret};`) && /Max-Age=\d{8}/.test(renewed), 'opening the hub renews the cookie');
    assert.equal(cookieOf((await req('/app.js', { gate: s.gateSecret })).headers), undefined, 'only the index renews');
    assert.equal((await req('/machines.json', { gate: s.gateSecret })).status, 200);

    const gateAndMachine = `__Host-agentdeck_gate=${s.gateSecret}; __Secure-agentdeck_mac=abcd1234abcd1234`;
    for (const cookie of [gateAndMachine, `__Secure-agentdeck_mac=abcd1234abcd1234; __Host-agentdeck_gate=${s.gateSecret}`,
      `a=1; __Host-agentdeck_gate=${s.gateSecret}; b=2`, `__Host-agentdeck_gate=${s.gateSecret}`]) {
      const r = await req('/mac/api/snapshot', { headers: { Cookie: cookie } });
      assert.equal(r.status, 200, cookie);
      assert.ok(!r.json.cookie.includes('agentdeck_gate') && !r.json.cookie.includes(s.gateSecret), `the machine never sees the gate secret (${r.json.cookie})`);
    }
    const kept = await req('/win/api/snapshot', { headers: { Cookie: `a=1; __Host-agentdeck_gate=${s.gateSecret}; __Secure-agentdeck_win=ffff0000ffff0000` } });
    assert.equal(kept.json.cookie, 'a=1; __Secure-agentdeck_win=ffff0000ffff0000', 'other cookies pass through untouched');
    assert.ok([...s.mac.requests, ...s.win.requests].every((r) => !JSON.stringify(r.headers).includes(s.gateSecret)));

    const info = await req('/win/api/info', { gate: s.gateSecret });
    assert.equal(info.status, 200);
    const login = await req('/mac/login', { method: 'POST', gate: s.gateSecret });
    assert.equal(login.status, 200);
    assert.match(cookieOf2(login.headers, '__Secure-agentdeck_mac'), /^__Secure-agentdeck_mac=/);
  });

  await t.test('旧的 Authorization: Basic 仍然可用（脚本、curl、mobile:check），口令错了 401；有效 cookie 优先', async () => {
    const good = await req('/', { auth: basic(H.AUTH_USER, H.AUTH_PASS) });
    assert.equal(good.status, 200);
    assert.equal((await req('/mac/api/info', { auth: basic(H.AUTH_USER, H.AUTH_PASS) })).status, 200);
    const bad = await req('/', { auth: basic(H.AUTH_USER, 'nope') });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers['www-authenticate'], undefined);
    const both = await req('/', { auth: basic(H.AUTH_USER, 'nope'), gate: s.gateSecret });
    assert.equal(both.status, 200, 'a valid cookie wins over a stale Basic header');
  });

  await t.test('含糊路径照旧 404（登录之前也一样）', async () => {
    for (const p of ['/mac/../win/api/snapshot', '//mac/api/snapshot']) {
      assert.equal((await req(p)).status, 404, p);
      assert.equal((await req(p, { gate: s.gateSecret })).status, 404, p);
    }
  });

  await t.test('访问日志没有 cookie 值和口令', () => {
    const log = fs.existsSync(s.logFile) ? fs.readFileSync(s.logFile, 'utf8') : '';
    assert.ok(!log.includes(s.gateSecret) && !log.includes(H.AUTH_PASS));
    assert.ok(!s.stderr.includes(s.gateSecret) && !s.stderr.includes(H.AUTH_PASS));
  });
});

function cookieOf2(headers, name) { return [].concat(headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`)); }
