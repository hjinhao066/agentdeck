'use strict';
// Runs a real, unprivileged OpenSSH sshd on loopback with the shipped deploy/vps/sshd_agentdeck-tunnel-win.conf
// and the authorized_keys options written by tunnel-account.sh, then proves: the Windows key can listen only on
// its own port, the Mac key only on its own, neither can do anything else. Ports are substituted with free
// local ones; the shipped strings are asserted to contain the production ports first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { freePort } = require('./fixtures/vps/caddy-harness');

if (process.platform === 'win32') { test('VPS sshd tests are POSIX only', { skip: true }, () => {}); return; }

const VPS = path.resolve(__dirname, '..', 'deploy', 'vps');
const SSHD = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd'].find((p) => fs.existsSync(p));
const skip = SSHD ? false : 'sshd binary not found';
const USER = os.userInfo().username;
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

function authOptsTemplate() {
  const m = fs.readFileSync(path.join(VPS, 'tunnel-account.sh'), 'utf8').match(/^AUTH_OPTS="(.*)"$/m);
  assert.ok(m, 'AUTH_OPTS found in tunnel-account.sh');
  return m[1].replace(/\\"/g, '"').replace('$PORT', '43123');
}

test('sshd 片段：生产端口写死 43123、只允许 remote 转发、无 shell；其他用户不受影响', { skip }, (t) => {
  const conf = fs.readFileSync(path.join(VPS, 'sshd_agentdeck-tunnel-win.conf'), 'utf8');
  assert.match(conf, /^Match User agentdeck-tunnel-win$/m);
  assert.match(conf, /^\tPermitListen 127\.0\.0\.1:43123$/m);
  assert.match(conf, /^\tPermitOpen none$/m);
  assert.ok(!/43122/.test(conf.replace(/^#.*$/gm, '')), 'the Mac port never appears in the Windows account config');
  assert.equal(authOptsTemplate(), 'restrict,port-forwarding,permitlisten="127.0.0.1:43123"');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sshd-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'host')]);
  fs.writeFileSync(path.join(dir, 'drop-in.conf'), conf);
  fs.writeFileSync(path.join(dir, 'sshd_config'), `HostKey ${dir}/host\nPidFile ${dir}/pid\nInclude ${dir}/drop-in.conf\n`);
  const check = sh(SSHD, ['-t', '-f', path.join(dir, 'sshd_config')]);
  assert.equal(check.status, 0, `sshd -t rejected the shipped config: ${check.stderr}`);
  const eff = (user) => Object.fromEntries(sh(SSHD, ['-T', '-f', path.join(dir, 'sshd_config'), '-C', `user=${user},host=localhost,addr=127.0.0.1`]).stdout
    .split('\n').filter(Boolean).map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)]; }));
  const win = eff('agentdeck-tunnel-win');
  assert.equal(win.permitlisten, '127.0.0.1:43123');
  assert.equal(win.permitopen, 'none');
  assert.equal(win.allowtcpforwarding, 'remote');
  assert.equal(win.allowstreamlocalforwarding, 'no');
  assert.equal(win.gatewayports, 'no');
  assert.equal(win.maxsessions, '0');
  assert.equal(win.permittty, 'no');
  assert.equal(win.passwordauthentication, 'no');
  assert.equal(win.authenticationmethods, 'publickey');
  assert.equal(win.allowagentforwarding, 'no');
  assert.equal(win.x11forwarding, 'no');
  assert.equal(win.clientaliveinterval, '30');
  assert.equal(win.clientalivecountmax, '3');
  assert.equal(win.forcecommand, '/usr/sbin/nologin');
  const other = eff('someoneelse');
  assert.notEqual(other.maxsessions, '0');
  assert.equal(other.permitlisten, 'any');
  assert.equal(other.permitopen, 'any');
  assert.equal(other.forcecommand, 'none');
  assert.deepEqual(eff('root'), other, 'root is configured exactly like any other user: the Match block does not leak');
});

test('真 sshd：Windows 的密钥只能占 Windows 的端口，抢不了 Mac 的，别的一概不行', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sshd-'));
  fs.chmodSync(dir, 0o700);
  const procs = [];
  t.after(() => { procs.forEach((p) => p.kill('SIGKILL')); fs.rmSync(dir, { recursive: true, force: true }); });
  const [sshdPort, macPort, winPort, echoPort, localPort] = await Promise.all([1, 2, 3, 4, 5].map(freePort));
  const key = (n) => { sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', n, '-f', path.join(dir, n)]); return path.join(dir, n); };
  const [host, winKey, macKey, confOnlyKey, strangerKey] = ['host', 'win', 'mac', 'confonly', 'stranger'].map(key);
  const pub = (k) => fs.readFileSync(k + '.pub', 'utf8').trim();
  const opts = (port) => authOptsTemplate().replace('43123', String(port));
  // confonly: no permitlisten in its key line, so only the sshd drop-in limits it (each layer is tested on its own)
  fs.writeFileSync(path.join(dir, 'authorized_keys'), `${opts(winPort)} ${pub(winKey)}\n${opts(macPort)} ${pub(macKey)}\nrestrict,port-forwarding ${pub(confOnlyKey)}\n`);
  const shipped = fs.readFileSync(path.join(VPS, 'sshd_agentdeck-tunnel-win.conf'), 'utf8')
    .replace('Match User agentdeck-tunnel-win', `Match User ${USER}`).replaceAll('127.0.0.1:43123', `127.0.0.1:${winPort}`);
  assert.ok(shipped.includes(`Match User ${USER}`) && shipped.includes(`127.0.0.1:${winPort}`), 'substitution applied');
  fs.writeFileSync(path.join(dir, 'drop-in.conf'), shipped);
  fs.writeFileSync(path.join(dir, 'sshd_config'), [`Port ${sshdPort}`, 'ListenAddress 127.0.0.1', `HostKey ${host}`, `PidFile ${dir}/sshd.pid`,
    `AuthorizedKeysFile ${dir}/authorized_keys`, 'StrictModes no', 'UsePAM no', 'LogLevel ERROR', 'PubkeyAuthentication yes', `Include ${dir}/drop-in.conf`, ''].join('\n'));
  const daemon = spawn(SSHD, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(daemon);
  let daemonErr = ''; daemon.stderr.on('data', (c) => { daemonErr += c; });
  const up = await waitConnectable(sshdPort, 5000);
  if (!up) return t.skip(`unprivileged sshd could not start here: ${daemonErr.split('\n')[0]}`);

  // a tiny "AgentDeck" on the local side of the tunnel
  const echo = net.createServer((s) => s.on('data', (d) => s.end(`echo:${d}`))); await new Promise((r) => echo.listen(echoPort, '127.0.0.1', r)); t.after(() => echo.close());

  const sshArgs = (k, extra) => ['-F', '/dev/null', '-i', k, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=5', '-p', String(sshdPort), ...extra, `${USER}@127.0.0.1`];
  // start `ssh -N ...`; resolve {alive} after a settle time, plus whatever it printed
  async function tunnel(k, extra, probePort) {
    const p = spawn('ssh', sshArgs(k, ['-N', ...extra]), { stdio: ['ignore', 'ignore', 'pipe'] });
    procs.push(p);
    let err = ''; p.stderr.on('data', (c) => { err += c; });
    const exited = new Promise((r) => p.once('exit', (code) => r(code)));
    const outcome = await Promise.race([exited.then((code) => ({ alive: false, code })), (probePort ? waitConnectable(probePort, 3000) : sleep(2500)).then((ok) => ({ alive: ok !== false }))]);
    return { p, err, ...outcome, stop: () => { p.kill('SIGKILL'); return exited; } };
  }
  const roundTrip = (port) => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('ping'));
    let got = ''; s.on('data', (d) => { got += d; }); s.on('close', () => resolve(got)); s.on('error', () => resolve(got));
    setTimeout(() => { s.destroy(); resolve(got); }, 2000);
  });
  const fwd = (bind, port) => ['-R', `${bind}${port}:127.0.0.1:${echoPort}`];

  await t.test('Windows 密钥：能占自己的端口，流量真的通到本机服务', async () => {
    const w = await tunnel(winKey, fwd('127.0.0.1:', winPort), winPort);
    assert.equal(w.alive, true, w.err);
    assert.equal(await roundTrip(winPort), 'echo:ping');
    await w.stop();
  });
  await t.test('Windows 密钥占不了 Mac 的端口（抢占防护）', async () => {
    const w = await tunnel(winKey, fwd('127.0.0.1:', macPort));
    assert.equal(w.alive, false, 'ssh must exit: remote forward refused');
    assert.notEqual(w.code, 0);
    assert.match(w.err, /forwarding failed|administratively prohibited|Could not request/i);
    assert.equal(await waitConnectable(macPort, 300), false, 'nothing is listening on the Mac port');
  });
  await t.test('Mac 密钥（密钥选项只放行 Mac 端口）占不了 Windows 的端口：只靠密钥这一层也挡得住', async () => {
    const bad = await tunnel(macKey, fwd('127.0.0.1:', winPort));
    assert.equal(bad.alive, false);
    assert.equal(await waitConnectable(winPort, 300), false);
  });
  await t.test('只靠 sshd 片段这一层（密钥行没有 permitlisten）也只放行 Windows 端口', async () => {
    const ok = await tunnel(confOnlyKey, fwd('127.0.0.1:', winPort), winPort);
    assert.equal(ok.alive, true, ok.err);
    await ok.stop();
    const bad = await tunnel(confOnlyKey, fwd('127.0.0.1:', macPort));
    assert.equal(bad.alive, false);
    assert.equal(await waitConnectable(macPort, 300), false);
  });
  await t.test('不能把端口开到非回环地址', async () => {
    const w = await tunnel(winKey, fwd('0.0.0.0:', winPort));
    assert.equal(w.alive, false);
    assert.equal(await waitConnectable(winPort, 300), false);
  });
  await t.test('不能本地转发、执行命令；未登记的密钥进不来', async () => {
    const l = await tunnel(winKey, ['-L', `${localPort}:127.0.0.1:${echoPort}`], localPort);
    assert.equal(l.alive, true, 'ssh itself listens locally; the server must refuse the channel');
    assert.notEqual(await roundTrip(localPort), 'echo:ping', 'server-side local forwarding is refused');
    await l.stop();
    const cmd = sh('ssh', sshArgs(winKey, ['echo', 'SHELL-RAN']), { timeout: 8000 });
    assert.notEqual(cmd.status, 0);
    assert.ok(!cmd.stdout.includes('SHELL-RAN'));
    const stranger = await tunnel(strangerKey, fwd('127.0.0.1:', winPort));
    assert.equal(stranger.alive, false);
    assert.match(stranger.err, /Permission denied/);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitConnectable(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}
