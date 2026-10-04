'use strict';
// Integration test for deploy/vps/Caddyfile.agentdeck: a temporary local Caddy (same 2.6.x as the VPS)
// in front of two fake AgentDeck backends. Needs a caddy binary: set CADDY_BIN or put `caddy` on PATH.
// Nothing here talks to a real VPS, a live Caddy, or the installed AgentDeck.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const H = require('./fixtures/vps/caddy-harness');

const caddy = H.findCaddy();
const skip = caddy ? false : 'caddy binary not found (set CADDY_BIN)';
if (caddy && !caddy.version.startsWith('v2.6.')) console.warn(`# note: tests written for Caddy 2.6.x (VPS runs 2.6.2), found ${caddy.version}`);

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
// Forced onto every /mac/* and /win/* response, including ones Caddy replaces.
const PREFIX_CSP = "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const single = (headers, name) => {
  const value = headers[name];
  assert.ok(!Array.isArray(value), `${name} must be one header, got ${JSON.stringify(value)}`);
  return value;
};
const wipe = (...machines) => machines.forEach((m) => { m.requests.length = 0; m.mode = 'ok'; });

test('Caddy 分流与前缀', { skip }, async (t) => {
  const s = await H.startStack(caddy);
  let stopped = false;
  t.after(async () => { if (!stopped) await s.stop(); s.cleanup(); });
  const req = (p, o) => H.request(s.port, p, o);

  await t.test('Caddyfile.agentdeck 已经是 caddy fmt 的格式，且有 BEGIN/END 标记', () => {
    const text = fs.readFileSync(H.SNIPPET, 'utf8');
    assert.equal(text.match(/^# BEGIN agentdeck-three-ends/gm).length, 1);
    assert.equal(text.match(/^# END agentdeck-three-ends/gm).length, 1);
    const fmt = spawnSync(caddy.bin, ['fmt', H.SNIPPET], { encoding: 'utf8' });
    assert.equal(fmt.status, 0);
    assert.equal(fmt.stdout, text, 'run `caddy fmt --overwrite deploy/vps/Caddyfile.agentdeck`');
  });

  await t.test('没有 basicauth（或口令错误）时，所有路径都 401，后端收不到任何请求', async () => {
    wipe(s.mac, s.win);
    const paths = ['/', '/index.html', '/machines.json', '/app.js', '/mac/', '/mac/api/snapshot', '/mac/api/info', '/win/', '/win/api/snapshot', '/win/api/info',
      '/win/login', '/mac', '/win', '/nope', '/.secret', '/mac/../win/api/snapshot', '//mac/api/snapshot', '/MAC/api/snapshot'];
    for (const p of paths) {
      for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS']) {
        const r = await req(p, { auth: false, method });
        assert.equal(r.status, 401, `${method} ${p}`);
        assert.match(r.headers['www-authenticate'], /^Basic /, `${method} ${p} must ask for credentials`);
      }
    }
    const wrong = await req('/mac/api/snapshot', { auth: 'Basic ' + Buffer.from(`${H.AUTH_USER}:wrong`).toString('base64') });
    assert.equal(wrong.status, 401);
    assert.equal(s.mac.requests.length + s.win.requests.length, 0);
  });

  await t.test('带 basicauth：/ 是静态总台，带全部安全头；点文件不外泄', async () => {
    const root = await req('/');
    assert.equal(root.status, 200);
    assert.match(root.text, /hub placeholder/);
    assert.equal(root.headers['content-security-policy'], CSP);
    assert.equal(root.headers['cache-control'], 'no-store');
    assert.equal(root.headers['x-content-type-options'], 'nosniff');
    assert.equal(root.headers['referrer-policy'], 'no-referrer');
    assert.equal(root.headers.server, undefined);
    for (const f of ['/machines.json', '/app.js', '/style.css']) {
      const r = await req(f);
      assert.equal(r.status, 200, f);
      assert.equal(r.headers['content-security-policy'], CSP, f);
    }
    assert.deepEqual((await req('/machines.json')).json.machines.map((m) => m.base), ['/mac/', '/win/']);
    for (const f of ['/.secret', '/%2e%73ecret']) assert.equal((await req(f)).status, 404, f);
    const missing = await req('/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.text, '');
    assert.equal(s.mac.requests.length + s.win.requests.length, 0, 'static paths never reach a machine');
  });

  await t.test('/mac/* 与 /win/* 各转各的，前缀、查询串、方法、请求体原样，另一台收不到', async () => {
    wipe(s.mac, s.win);
    const m = await req('/mac/api/snapshot?a=1&b=%E4%B8%AD', { headers: { Origin: 'https://x.example', 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(m.status, 200);
    assert.deepEqual([m.json.machine, m.json.url], ['mac', '/mac/api/snapshot?a=1&b=%E4%B8%AD']);
    assert.equal(s.win.requests.length, 0);
    const w = await req('/win/api/captain', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' }, body: '{"message":"hi"}' });
    assert.equal(w.status, 200);
    assert.deepEqual([w.json.machine, w.json.url], ['win', '/win/api/captain']);
    assert.equal(s.win.requests[0].method, 'POST');
    assert.equal(s.win.requests[0].body, '{"message":"hi"}');
    assert.equal(s.win.requests[0].headers['x-csrf-token'], 'tok');
    assert.equal(s.mac.requests.length, 1);
    const fwd = s.mac.requests[0].headers;
    assert.equal(fwd.origin, 'https://x.example');
    assert.equal(fwd['sec-fetch-site'], 'same-origin');
  });

  await t.test('Host / X-Forwarded-* 被覆盖，Authorization 被去掉，伪造的转发头不能带到后端', async () => {
    for (const [prefix, machine] of [['/mac/', s.mac], ['/win/', s.win]]) {
      wipe(machine);
      const r = await req(`${prefix}api/snapshot`, { headers: {
        'X-Forwarded-For': '203.0.113.9, 198.51.100.1', 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'evil.example',
        Forwarded: 'for=203.0.113.9;host=evil.example', 'X-Real-IP': '203.0.113.9', Cookie: 'k=v' } });
      assert.equal(r.status, 200);
      const h = machine.requests[0].headers;
      assert.equal(h.host, H.PROD_DOMAIN, 'Host is forced to the public domain');
      assert.equal(h['x-forwarded-proto'], 'https');
      assert.equal(h['x-forwarded-for'], '127.0.0.1', 'exactly one entry: the connecting IP, not what the client claimed');
      assert.notEqual(h['x-forwarded-host'], 'evil.example');
      assert.equal(h.forwarded, undefined);
      assert.equal(h['x-real-ip'], undefined);
      assert.equal(h.authorization, undefined, 'the entry basicauth never reaches AgentDeck');
      assert.equal(h.cookie, 'k=v');
      assert.ok(!machine.requests[0].rawHeaders.some((x) => /evil\.example|203\.0\.113\.9/.test(x)), 'no spoofed value survives in any header');
    }
  });

  await t.test('路径花样不会让请求到达另一台机器：含糊路径 404，其余只到前缀对应的那台', async () => {
    wipe(s.mac, s.win);
    const ambiguous = ['/mac/../win/api/snapshot', '/win/../mac/api/snapshot', '/mac/%2e%2e/win/api/snapshot', '/win/%2e%2e/mac/api/snapshot',
      '/mac/..%2fwin/api/snapshot', '/win/..%2fmac/api/snapshot', '//mac/api/snapshot', '//win/api/snapshot', '/mac//api/snapshot',
      '/hub/../win/api/snapshot', '/./win/api/snapshot', '/x/%2e%2e/mac/api/snapshot', '/mac/./api/snapshot', '/mac/api/..'];
    for (const p of ambiguous) {
      const r = await req(p);
      assert.equal(r.status, 404, p);
    }
    assert.equal(s.mac.requests.length + s.win.requests.length, 0, 'ambiguous paths never reach a machine');
    const others = ['/MAC/api/snapshot', '/WIN/api/snapshot', '/mac;/win/api/snapshot', '/macx/api/snapshot', '/winx/api/snapshot', '/mac', '/win',
      '/%6dac/api/snapshot', '/%77in/api/snapshot', '/mac/api/a..b', '/mac/.hidden'];
    const seen = {};
    for (const p of others) {
      const before = [s.mac.requests.length, s.win.requests.length];
      const r = await req(p);
      const gotMac = s.mac.requests.slice(before[0]), gotWin = s.win.requests.slice(before[1]);
      assert.ok(gotMac.length + gotWin.length <= 1, `${p} reached both machines`);
      const canon = (u) => decodeURIComponent(u).toLowerCase();
      for (const q of gotMac) assert.ok(canon(q.url).startsWith('/mac/'), `${p} reached mac as ${q.url}`);
      for (const q of gotWin) assert.ok(canon(q.url).startsWith('/win/'), `${p} reached win as ${q.url}`);
      seen[p] = gotMac.length ? `mac:${gotMac[0].url}` : gotWin.length ? `win:${gotWin[0].url}` : `none(${r.status})`;
    }
    for (const p of ['/mac', '/win', '/macx/api/snapshot', '/winx/api/snapshot']) assert.match(seen[p], /^none\(404\)/, `${p} must not be proxied`);
    // Forwarded verbatim (not rewritten): the app's own case-sensitive prefix check is what rejects /MAC/ and encoded prefixes.
    assert.equal(seen['/MAC/api/snapshot'], 'mac:/MAC/api/snapshot');
    assert.ok(seen['/mac/api/a..b'].startsWith('mac:') && seen['/mac/.hidden'].startsWith('mac:'), 'dots inside a segment are fine');
    t.diagnostic(`path routing (informational): ${JSON.stringify(seen)}`);
  });

  await t.test('后端自己的状态码和响应体原样透传，包括 AgentDeck 自己的 401 JSON', async () => {
    for (const [prefix, name] of [['/mac/', 'mac'], ['/win/', 'win']]) {
      for (const status of [401, 404, 429, 500]) {
        const r = await req(`${prefix}api/status/${status}`);
        assert.equal(r.status, status);
        assert.deepEqual(r.json, { machine: name, backendSays: 'own error body' });
      }
    }
  });

  await t.test('Set-Cookie 原样透传（名称、Path、属性不被改写，也没有 Domain）', async () => {
    for (const [prefix, machine] of [['/mac/', s.mac], ['/win/', s.win]]) {
      const r = await req(`${prefix}login`, { method: 'POST' });
      const cookies = [].concat(r.headers['set-cookie']);
      assert.equal(cookies.length, 1);
      assert.match(cookies[0], new RegExp(`^${machine.cookieName}=[0-9a-f]{16}; Path=${prefix}; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$`));
      assert.ok(!/domain=/i.test(cookies[0]));
    }
  });

  await t.test('前缀上的 JSON 被盖成 sandbox CSP；GET api/info 免机器登录放行，入口口令仍然要', async () => {
    for (const [prefix, machine, label, platform] of [['/mac/', s.mac, 'Mac', 'darwin'], ['/win/', s.win, 'Windows', 'win32']]) {
      wipe(machine);
      const snap = await req(`${prefix}api/snapshot`);
      assert.equal(snap.status, 200);
      assert.equal(single(snap.headers, 'content-security-policy'), PREFIX_CSP);
      assert.equal(single(snap.headers, 'x-content-type-options'), 'nosniff');
      assert.equal(snap.headers['x-frame-options'], 'DENY');
      assert.equal(snap.headers['cross-origin-resource-policy'], 'same-origin');
      assert.match(snap.headers['content-type'], /^application\/json/);
      assert.equal(machine.requests[0].headers.cookie, undefined);
      const info = await req(`${prefix}api/info`);
      assert.equal(info.status, 200);
      assert.deepEqual(info.json, { app: 'agentdeck', apiVersion: 2, capabilities: ['snapshot', 'basePath'], machine: { id: machine.name, label, platform } });
      assert.equal(info.headers['set-cookie'], undefined);
      assert.equal(single(info.headers, 'content-security-policy'), PREFIX_CSP);
      assert.equal(machine.requests.at(-1).headers.cookie, undefined, 'api/info does not need a device cookie');
      const posted = await req(`${prefix}api/info`, { method: 'POST' });
      assert.equal(posted.status, 401);
      assert.deepEqual(posted.json, { error: 'Unauthorized.' });
      assert.equal(single(posted.headers, 'content-security-policy'), PREFIX_CSP);
    }
    wipe(s.mac, s.win);
    assert.equal((await req('/mac/api/info', { auth: false })).status, 401);
    assert.equal((await req('/win/api/info', { auth: false })).status, 401);
    assert.equal(s.mac.requests.length + s.win.requests.length, 0, 'basicauth still covers the probe');
  });

  await t.test('非 JSON、缺 Content-Type、或给另一台种 cookie 的响应被换成 blocked，后端页面到不了浏览器', async () => {
    const html = '<!doctype html><script>fetch("/mac/api/snapshot")</script>';
    const cases = [
      ['html', { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "script-src 'unsafe-inline'" }, html],
      ['js', { 'Content-Type': 'text/javascript' }, 'fetch("/mac/api/snapshot")'],
      ['svg', { 'Content-Type': 'image/svg+xml' }, '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
      ['none', {}, html],
      ['plain', { 'Content-Type': 'text/plain' }, html],
      ['foreign-cookie', { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': '__Secure-agentdeck_mac=deadbeefdeadbeef; Path=/mac/; HttpOnly; Secure; SameSite=Strict' }, '{"ok":true}'],
    ];
    for (const [name, headers, body] of cases) {
      s.win.scripted = { status: 200, headers, body };
      const r = await req('/win/pwn');
      assert.equal(r.status, 403, name);
      assert.equal(r.text, '{"error":"blocked"}', name);
      assert.equal(single(r.headers, 'content-security-policy'), PREFIX_CSP, name);
      assert.equal(single(r.headers, 'x-content-type-options'), 'nosniff', name);
      assert.match(r.headers['content-type'], /^application\/json/, name);
      assert.ok(!r.text.includes('<script') && !r.text.includes('deadbeef'), name);
      assert.equal(r.headers['set-cookie'], undefined, name);
    }
    // The other direction: Mac must not be allowed to plant the Windows cookie either.
    s.mac.scripted = { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': '__Secure-agentdeck_win=deadbeefdeadbeef; Path=/win/; Secure' }, body: '{"ok":true}' };
    const planted = await req('/mac/pwn');
    assert.equal(planted.status, 403);
    assert.equal(planted.headers['set-cookie'], undefined);
  });

  await t.test('一台离线：它的前缀 502 {"offline":true}，另一台和总台照常', async () => {
    wipe(s.mac, s.win);
    await s.win.stop();
    const started = Date.now();
    const off = await req('/win/api/snapshot');
    const elapsed = Date.now() - started;
    assert.equal(off.status, 502);
    assert.equal(off.text, '{"offline":true}');
    assert.match(off.headers['content-type'], /^application\/json/);
    assert.equal(off.headers['cache-control'], 'no-store');
    assert.ok(elapsed < 3500, `fails fast (dial_timeout 3s), took ${elapsed}ms`);
    assert.equal((await req('/win/login', { method: 'POST' })).status, 502);
    assert.equal((await req('/win/', { auth: false })).status, 401, 'offline never bypasses auth');
    assert.equal((await req('/mac/api/snapshot')).json.machine, 'mac');
    assert.equal((await req('/')).status, 200);
    // Mac goes offline instead (and Windows comes back): symmetric.
    await s.win.start();
    await s.mac.stop();
    assert.equal((await req('/mac/api/snapshot')).text, '{"offline":true}');
    assert.equal((await req('/win/api/snapshot')).json.machine, 'win');
    await s.mac.start();
    assert.equal((await req('/mac/api/snapshot')).json.machine, 'mac', 'recovers without touching Caddy');
  });

  await t.test('一台无响应（半开隧道）：只有它自己挂着，另一台和总台不受影响', async () => {
    wipe(s.mac, s.win);
    s.win.mode = 'hang';
    const hung = req('/win/api/snapshot', { timeout: 1200 }).then(() => 'answered', (e) => e.code);
    const started = Date.now();
    const [mac, hub] = await Promise.all([req('/mac/api/snapshot'), req('/')]);
    assert.equal(mac.json.machine, 'mac');
    assert.equal(hub.status, 200);
    assert.ok(Date.now() - started < 1000);
    assert.equal(await hung, 'ETIMEOUT');
    s.win.mode = 'ok';
  });

  await t.test('访问日志和 Caddy 错误日志里没有 URI、请求头、口令、cookie 值', async () => {
    wipe(s.mac, s.win);
    const secrets = { uri: 'LOGPROBE-URI-9137', header: 'LOGPROBE-HEADER-5521', cookie: 'LOGPROBE-COOKIE-8842', ua: 'LOGPROBE-UA-1190' };
    const common = { headers: { Cookie: `__Secure-agentdeck_win=${secrets.cookie}`, 'X-Probe': secrets.header, 'User-Agent': secrets.ua } };
    await req(`/mac/api/snapshot?q=${secrets.uri}`, common);
    await req(`/?q=${secrets.uri}`, common);
    await req(`/nope-${secrets.uri}`, { ...common, auth: false });
    await s.win.stop();
    await req(`/win/api/snapshot?q=${secrets.uri}`, common); // produces a Caddy error log line
    await s.win.start();
    await new Promise((r) => setTimeout(r, 200));
    const access = fs.readFileSync(s.logFile, 'utf8');
    const lines = access.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length >= 4, 'access log is being written');
    assert.ok(lines.every((l) => l.request && l.request.uri === undefined && l.request.headers === undefined && l.resp_headers === undefined && l.user_id === undefined));
    assert.ok(lines.some((l) => l.status === 401) && lines.some((l) => l.status === 502) && lines.some((l) => l.status === 200));
    const basic = Buffer.from(`${H.AUTH_USER}:${H.AUTH_PASS}`).toString('base64');
    for (const [label, blob] of [['access log', access], ['caddy stderr', s.stderr]]) {
      for (const [k, v] of Object.entries(secrets)) {
        assert.ok(!blob.includes(v), `${label} leaks ${k}`);
      }
      assert.ok(!blob.includes(H.AUTH_PASS) && !blob.includes(basic), `${label} leaks the entry credentials`);
    }
  });

  await s.stop(); stopped = true;
});

test('浏览器级 cookie 隔离：两台各自的 cookie 只发给各自的前缀', { skip }, async (t) => {
  let chromium;
  try { ({ chromium } = require('@playwright/test')); } catch { return t.skip('@playwright/test not installed'); }
  const s = await H.startStack(caddy);
  let browser;
  t.after(async () => { if (browser) await browser.close(); await s.stop(); s.cleanup(); });
  try { browser = await chromium.launch(); } catch (e) { return t.skip(`chromium unavailable: ${e.message.split('\n')[0]}`); }
  const auth = 'Basic ' + Buffer.from(`${H.AUTH_USER}:${H.AUTH_PASS}`).toString('base64');
  const context = await browser.newContext({ extraHTTPHeaders: { Authorization: auth } });
  const page = await context.newPage();
  await page.goto(`${s.siteAddress}/`);
  const call = (route, method = 'GET') => page.evaluate(async ([r, m]) => {
    const res = await fetch(r, { method: m, credentials: 'same-origin' });
    return { status: res.status, body: await res.json() };
  }, [route, method]);

  assert.equal((await call('/mac/login', 'POST')).status, 200);
  assert.equal((await call('/win/login', 'POST')).status, 200);
  const jar = await context.cookies(); // no URL filter: Secure cookies are hidden from http:// URLs
  const byName = Object.fromEntries(jar.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['__Secure-agentdeck_mac', '__Secure-agentdeck_win']);
  for (const [name, p] of [['__Secure-agentdeck_mac', '/mac/'], ['__Secure-agentdeck_win', '/win/']]) {
    assert.equal(byName[name].path, p);
    assert.equal(byName[name].httpOnly, true);
    assert.equal(byName[name].secure, true);
    assert.equal(byName[name].sameSite, 'Strict');
    assert.ok(!byName[name].domain.startsWith('.'), 'host-only cookie, no Domain attribute');
  }
  s.mac.requests.length = 0; s.win.requests.length = 0;
  const mac = await call('/mac/api/snapshot');
  const win = await call('/win/api/snapshot');
  assert.match(mac.body.cookie, /^__Secure-agentdeck_mac=[0-9a-f]{16}$/, 'Mac receives only the Mac cookie');
  assert.match(win.body.cookie, /^__Secure-agentdeck_win=[0-9a-f]{16}$/, 'Windows receives only the Windows cookie');
  // Whatever the page requests, neither machine ever sees the other's cookie; the static hub and unknown paths see none.
  for (const route of ['/mac/', '/mac/api/tasks', '/mac/login', '/win/', '/win/api/tasks', '/win/login', '/', '/api/snapshot']) await call(route, route.endsWith('login') ? 'POST' : 'GET').catch(() => {});
  assert.ok(s.mac.requests.every((r) => !(r.headers.cookie || '').includes('_win=')), 'Mac never received the Windows cookie');
  assert.ok(s.win.requests.every((r) => !(r.headers.cookie || '').includes('_mac=')), 'Windows never received the Mac cookie');
  assert.ok(s.mac.requests.length >= 3 && s.win.requests.length >= 3);
});

test('被攻陷的前缀返回带脚本的 HTML 时，浏览器读不到另一台的接口', { skip }, async (t) => {
  let chromium;
  try { ({ chromium } = require('@playwright/test')); } catch { return t.skip('@playwright/test not installed'); }
  const s = await H.startStack(caddy);
  let browser;
  t.after(async () => { if (browser) await browser.close(); await s.stop(); s.cleanup(); });
  try { browser = await chromium.launch(); } catch (e) { return t.skip(`chromium unavailable: ${e.message.split('\n')[0]}`); }
  const auth = 'Basic ' + Buffer.from(`${H.AUTH_USER}:${H.AUTH_PASS}`).toString('base64');
  const context = await browser.newContext({ extraHTTPHeaders: { Authorization: auth } });
  const page = await context.newPage();
  await page.goto(`${s.siteAddress}/`);
  // The hub itself is allowed to read both machines. Log in so a stolen same-origin fetch would carry the device cookie.
  const hubRead = await page.evaluate(async () => {
    const login = await fetch('/mac/login', { method: 'POST', credentials: 'same-origin' });
    const snap = await fetch('/mac/api/snapshot', { credentials: 'include' });
    return { login: login.status, body: await snap.text() };
  });
  assert.equal(hubRead.login, 200);
  assert.match(hubRead.body, /"machine":"mac"/);

  const attack = `<!doctype html><html><head><title>pwn</title></head><body><script>
    fetch('/mac/api/snapshot', { credentials: 'include' }).then(async (r) => {
      const text = await r.text();
      document.title = 'STOLEN:' + text.slice(0, 160);
    }).catch((e) => { document.title = 'ERR:' + (e && e.name); });
  </script></body></html>`;
  s.mac.requests.length = 0;
  s.win.scripted = {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline'",
      'X-Content-Type-Options': 'sniff',
    },
    body: attack,
  };
  const resp = await page.goto(`${s.siteAddress}/win/pwn`, { waitUntil: 'commit' });
  const body = await resp.text();
  assert.equal(resp.status(), 403);
  assert.equal(body, '{"error":"blocked"}');
  assert.equal(resp.headers()['content-security-policy'], PREFIX_CSP);
  assert.equal(resp.headers()['x-content-type-options'], 'nosniff');
  assert.ok(!body.includes('<script') && !body.includes('STOLEN'));
  await page.waitForTimeout(400);
  assert.equal(await page.title(), '', 'the attacker script did not run');
  assert.ok(!s.mac.requests.some((r) => r.url.includes('/api/snapshot')), 'the HTML never fetched Mac');

  // Even from the document the browser actually committed, a same-origin read of /mac/ must fail.
  s.mac.requests.length = 0;
  const read = await page.evaluate(async () => {
    try {
      const r = await fetch('/mac/api/snapshot', { credentials: 'include' });
      return { ok: true, status: r.status, body: await r.text(), origin: location.origin };
    } catch (e) {
      return { ok: false, error: String(e && e.name || e), message: String(e && e.message || e), origin: location.origin };
    }
  });
  assert.ok(!(read.ok && read.body.includes('"machine":"mac"')), `pwn document read Mac: ${JSON.stringify(read)}`);
  assert.ok(!s.mac.requests.some((r) => r.url.startsWith('/mac/api/snapshot') && r.headers.cookie), 'Mac cookie was not presented by the pwn document');
});
