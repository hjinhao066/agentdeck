'use strict';
// Tests for the VPS deploy scripts in deploy/vps/. They run the REAL scripts against a scratch directory
// (paths and commands overridden through environment variables / stub binaries). Nothing touches a VPS,
// a live Caddy, a live sshd, or the installed AgentDeck. Caddy-dependent tests need CADDY_BIN or `caddy` on PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./fixtures/vps/caddy-harness');

if (process.platform === 'win32') { test('VPS deploy script tests are POSIX only', { skip: true }, () => {}); return; }

const VPS = path.join(H.REPO, 'deploy', 'vps');
const caddy = H.findCaddy();
const skipCaddy = caddy ? false : 'caddy binary not found (set CADDY_BIN)';
const ADDRESS = H.PROD_DOMAIN;
const HASH = '$2a$14$' + 'a'.repeat(53); // fake bcrypt-shaped string: only used to prove it never leaks

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-vps-scripts-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const run = (cmd, args, env = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });
const read = (p) => fs.readFileSync(p, 'utf8');
const py = (args) => run('python3', [path.join(VPS, 'caddyfile_block.py'), ...args]);
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

const OTHER_SITES_BEFORE = `# global options
{
\tadmin off
\tauto_https off
}

other.example.com {
\trespond "other {not a block"
}

`;
const OLD_BLOCK = `${ADDRESS} {
\t# comment with { brace
\tbasicauth {
\t\tphone ${HASH}
\t}
\treverse_proxy 127.0.0.1:43122 {
\t\theader_up Host {host}
\t}
}
`;
const OTHER_SITES_AFTER = `
last.example.com {
\trespond \`ok}\`
}
`;
const ORIGINAL = OTHER_SITES_BEFORE + OLD_BLOCK + OTHER_SITES_AFTER;

// ---------------------------------------------------------------- caddyfile_block.py
test('caddyfile_block.py：只替换这一个站点，其余逐字节不变，可往返还原', (t) => {
  const d = tmp(t);
  const cf = path.join(d, 'Caddyfile'); fs.writeFileSync(cf, ORIGINAL);
  const base = ['--caddyfile', cf, '--address', ADDRESS];
  const rep = py(['replace', ...base, '--new', path.join(VPS, 'Caddyfile.agentdeck'), '--out', path.join(d, 'new'), '--old-out', path.join(d, 'old')]);
  assert.equal(rep.status, 0, rep.stderr);
  const updated = read(path.join(d, 'new'));
  assert.ok(updated.startsWith(OTHER_SITES_BEFORE) && updated.endsWith(OTHER_SITES_AFTER), 'other sites byte-identical');
  assert.equal(read(path.join(d, 'old')), OLD_BLOCK);
  assert.ok(!updated.includes(HASH), 'the hash lives in the auth file, not in the new Caddyfile');
  assert.match(updated, /# BEGIN agentdeck-three-ends[^\n]*\n[\s\S]*# END agentdeck-three-ends\n/);

  // second run: managed region replaced in place, result identical
  fs.writeFileSync(path.join(d, 'cf2'), updated);
  assert.equal(py(['replace', '--caddyfile', path.join(d, 'cf2'), '--address', ADDRESS, '--new', path.join(VPS, 'Caddyfile.agentdeck'), '--out', path.join(d, 'new2'), '--old-out', path.join(d, 'old2')]).status, 0);
  assert.equal(read(path.join(d, 'new2')), updated);

  // other sites edited after the install survive a restore
  const edited = updated.replace('other.example.com {', 'other.example.com {\n\theader X-Edited yes');
  fs.writeFileSync(path.join(d, 'edited'), edited);
  assert.equal(py(['restore', '--caddyfile', path.join(d, 'edited'), '--old', path.join(d, 'old'), '--out', path.join(d, 'back')]).status, 0);
  assert.equal(read(path.join(d, 'back')), ORIGINAL.replace('other.example.com {', 'other.example.com {\n\theader X-Edited yes'));
  // untouched: exact original
  assert.equal(py(['restore', '--caddyfile', path.join(d, 'new'), '--old', path.join(d, 'old'), '--out', path.join(d, 'back2')]).status, 0);
  assert.equal(read(path.join(d, 'back2')), ORIGINAL);
});

test('caddyfile_block.py：没有旧站点时追加，还原时整段移除', (t) => {
  const d = tmp(t);
  const plain = OTHER_SITES_BEFORE.trimEnd() + '\n';
  fs.writeFileSync(path.join(d, 'Caddyfile'), plain);
  const base = ['--caddyfile', path.join(d, 'Caddyfile'), '--address', ADDRESS];
  assert.equal(py(['replace', ...base, '--new', path.join(VPS, 'Caddyfile.agentdeck'), '--out', path.join(d, 'new'), '--old-out', path.join(d, 'old')]).status, 0);
  assert.equal(read(path.join(d, 'old')), '');
  assert.ok(read(path.join(d, 'new')).startsWith(plain));
  assert.equal(py(['restore', '--caddyfile', path.join(d, 'new'), '--old', path.join(d, 'old'), '--out', path.join(d, 'back')]).status, 0);
  assert.equal(read(path.join(d, 'back')), plain);
});

test('caddyfile_block.py：拿不准就拒绝（exit 2），不改文件', (t) => {
  const d = tmp(t);
  const cases = {
    duplicate: ORIGINAL + '\n' + OLD_BLOCK,
    combined: ORIGINAL.replace(`${ADDRESS} {`, `${ADDRESS}, www.${ADDRESS} {`),
    unbalanced: ORIGINAL + '\nbroken.example.com {\n',
    twoMarkers: ORIGINAL + '# BEGIN agentdeck-three-ends\n# BEGIN agentdeck-three-ends\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    fs.writeFileSync(path.join(d, name), text);
    const r = py(['replace', '--caddyfile', path.join(d, name), '--address', ADDRESS, '--new', path.join(VPS, 'Caddyfile.agentdeck'), '--out', path.join(d, name + '.out'), '--old-out', path.join(d, name + '.old')]);
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.ok(!fs.existsSync(path.join(d, name + '.out')), `${name} wrote output`);
  }
});

test('caddyfile_block.py auth：原样取出入口口令，不打印；带路径匹配器时拒绝', (t) => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'Caddyfile'), ORIGINAL);
  const r = py(['auth', '--caddyfile', path.join(d, 'Caddyfile'), '--address', ADDRESS, '--out', path.join(d, 'auth.caddy')]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(HASH) && !r.stderr.includes(HASH));
  assert.equal(read(path.join(d, 'auth.caddy')), `basicauth {\n\tphone ${HASH}\n}\n`);
  fs.writeFileSync(path.join(d, 'm'), ORIGINAL.replace('basicauth {', 'basicauth /admin/* {'));
  const bad = py(['auth', '--caddyfile', path.join(d, 'm'), '--address', ADDRESS, '--out', path.join(d, 'x')]);
  assert.equal(bad.status, 2);
  assert.ok(!fs.existsSync(path.join(d, 'x')));
});

// ---------------------------------------------------------------- install / rollback (real caddy validate)
function caddyEnv(d, extra = {}) {
  fs.mkdirSync(path.join(d, 'log'), { recursive: true });
  const reloads = path.join(d, 'reloads');
  const reloadScript = path.join(d, 'reload.sh');
  fs.writeFileSync(reloadScript, `#!/bin/sh\necho x >> "${reloads}"\nif [ -n "$RELOAD_FAIL_FIRST" ] && [ "$(wc -l < "${reloads}")" -le 1 ]; then exit 1; fi\n`, { mode: 0o755 });
  return {
    CADDYFILE: path.join(d, 'Caddyfile'), AGENTDECK_AUTH_FILE: path.join(d, 'agentdeck-basicauth.caddy'),
    AGENTDECK_LOG_FILE: path.join(d, 'log', 'agentdeck-access.log'), AGENTDECK_HUB_ROOT: path.join(d, 'hub'),
    AGENTDECK_BACKUP_ROOT: path.join(d, 'backups'), CADDY_BIN: caddy && caddy.bin, RELOAD_CMD: reloadScript, VALIDATE_AS: '',
    AGENTDECK_ALLOW_NON_ROOT: '1', ...extra,
  };
}
const reloadCount = (d) => (fs.existsSync(path.join(d, 'reloads')) ? read(path.join(d, 'reloads')).trim().split('\n').length : 0);

test('install-caddy-site.sh --check：只校验，什么都不改', { skip: skipCaddy }, (t) => {
  const d = tmp(t); fs.writeFileSync(path.join(d, 'Caddyfile'), ORIGINAL);
  const r = run(path.join(VPS, 'install-caddy-site.sh'), ['--check'], caddyEnv(d));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /caddy validate: ok/);
  assert.ok(!(r.stdout + r.stderr).includes(HASH));
  assert.equal(read(path.join(d, 'Caddyfile')), ORIGINAL);
  assert.ok(!fs.existsSync(path.join(d, 'agentdeck-basicauth.caddy')) && !fs.existsSync(path.join(d, 'backups')));
  assert.equal(reloadCount(d), 0);
  assert.deepEqual(fs.readdirSync(d).filter((f) => f.startsWith('.')), [], 'no stray candidate files');
});

test('install-caddy-site.sh：备份、取出口令、只换这一段、校验、reload；rollback 还原', { skip: skipCaddy }, (t) => {
  const d = tmp(t); fs.writeFileSync(path.join(d, 'Caddyfile'), ORIGINAL);
  const env = caddyEnv(d);
  const inst = run(path.join(VPS, 'install-caddy-site.sh'), [], env);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  assert.ok(!(inst.stdout + inst.stderr).includes(HASH));
  const after = read(path.join(d, 'Caddyfile'));
  assert.ok(after.startsWith(OTHER_SITES_BEFORE) && after.endsWith(OTHER_SITES_AFTER));
  assert.ok(!after.includes(HASH));
  assert.match(after, new RegExp(`import ${path.join(d, 'agentdeck-basicauth.caddy').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(read(path.join(d, 'agentdeck-basicauth.caddy')), `basicauth {\n\tphone ${HASH}\n}\n`);
  assert.equal(mode(path.join(d, 'agentdeck-basicauth.caddy')), '600');
  const [bk] = fs.readdirSync(path.join(d, 'backups'));
  assert.equal(read(path.join(d, 'backups', bk, 'Caddyfile')), ORIGINAL);
  assert.equal(read(path.join(d, 'backups', bk, 'old-block.caddy')), OLD_BLOCK);
  assert.equal(mode(path.join(d, 'backups', bk)), '700');
  assert.equal(reloadCount(d), 1);
  assert.ok(fs.existsSync(path.join(d, 'log', 'agentdeck-access.log')));
  assert.equal(run(caddy.bin, ['validate', '--config', path.join(d, 'Caddyfile'), '--adapter', 'caddyfile']).status, 0, 'installed Caddyfile validates on its own');
  assert.deepEqual(fs.readdirSync(d).filter((f) => f.startsWith('.')), [], 'no stray candidate files');

  // someone edits another site after the install; rollback must keep that edit
  fs.writeFileSync(path.join(d, 'Caddyfile'), after.replace('other.example.com {', 'other.example.com {\n\theader X-Edited yes'));
  const rb = run(path.join(VPS, 'rollback-caddy-site.sh'), [], env);
  assert.equal(rb.status, 0, rb.stdout + rb.stderr);
  assert.equal(read(path.join(d, 'Caddyfile')), ORIGINAL.replace('other.example.com {', 'other.example.com {\n\theader X-Edited yes'));
  assert.equal(reloadCount(d), 2);
  assert.ok(fs.existsSync(path.join(d, 'agentdeck-basicauth.caddy')), 'auth file kept');

  // installing again after a rollback works
  assert.equal(run(path.join(VPS, 'install-caddy-site.sh'), [], env).status, 0);
});

test('install-caddy-site.sh：重复运行结果不变，口令文件不被覆盖', { skip: skipCaddy }, (t) => {
  const d = tmp(t); fs.writeFileSync(path.join(d, 'Caddyfile'), ORIGINAL);
  const env = caddyEnv(d);
  assert.equal(run(path.join(VPS, 'install-caddy-site.sh'), [], env).status, 0);
  const once = read(path.join(d, 'Caddyfile'));
  fs.writeFileSync(path.join(d, 'agentdeck-basicauth.caddy'), `basicauth {\n\tphone ${'$2a$14$' + 'b'.repeat(53)}\n}\n`);
  assert.equal(run(path.join(VPS, 'install-caddy-site.sh'), [], env).status, 0);
  assert.equal(read(path.join(d, 'Caddyfile')), once);
  assert.match(read(path.join(d, 'agentdeck-basicauth.caddy')), /b{53}/, 'existing auth file kept');
});

test('install-caddy-site.sh：现有 Caddyfile 校验不过、口令取不出、reload 失败，都不留下半成品', { skip: skipCaddy }, (t) => {
  // 1. invalid existing config: refuse, change nothing
  let d = tmp(t);
  const broken = ORIGINAL + '\nbad.example.com {\n\timport /nonexistent/file.caddy\n}\n';
  fs.writeFileSync(path.join(d, 'Caddyfile'), broken);
  let r = run(path.join(VPS, 'install-caddy-site.sh'), [], caddyEnv(d));
  assert.notEqual(r.status, 0);
  assert.equal(read(path.join(d, 'Caddyfile')), broken);
  assert.ok(!fs.existsSync(path.join(d, 'backups')) && !fs.existsSync(path.join(d, 'agentdeck-basicauth.caddy')));
  assert.equal(reloadCount(d), 0);

  // 2. credentials that cannot be lifted safely: refuse
  d = tmp(t);
  const odd = ORIGINAL.replace('basicauth {', 'basicauth /admin/* {');
  fs.writeFileSync(path.join(d, 'Caddyfile'), odd);
  r = run(path.join(VPS, 'install-caddy-site.sh'), [], caddyEnv(d));
  assert.notEqual(r.status, 0);
  assert.equal(read(path.join(d, 'Caddyfile')), odd);
  assert.equal(reloadCount(d), 0);

  // 3. reload fails the first time: the previous block is put back and Caddy reloaded again
  d = tmp(t);
  fs.writeFileSync(path.join(d, 'Caddyfile'), ORIGINAL);
  r = run(path.join(VPS, 'install-caddy-site.sh'), [], caddyEnv(d, { RELOAD_FAIL_FIRST: '1' }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rolled back/);
  assert.equal(read(path.join(d, 'Caddyfile')), ORIGINAL);
  assert.equal(reloadCount(d), 2);
});

// ---------------------------------------------------------------- tunnel-account.sh (stubbed system commands)
function tunnelFixture(t) {
  const d = tmp(t);
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  const log = path.join(d, 'commands.log');
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const realId = '/usr/bin/id';
  stub('id', `if [ "$1" = agentdeck-tunnel-win ]; then [ -e "${d}/.user" ]; exit $?; fi\nexec ${realId} "$@"`);
  stub('useradd', `echo "useradd $*" >> "${log}"; touch "${d}/.user"`);
  stub('usermod', `echo "usermod $*" >> "${log}"`);
  stub('userdel', `echo "userdel $*" >> "${log}"; rm -f "${d}/.user"`);
  stub('chown', `echo "chown $*" >> "${log}"`);
  stub('systemctl', `echo "systemctl $*" >> "${log}"`);
  stub('sshd', `echo "sshd $*" >> "${log}"\ncase "$1" in -t) [ -z "$STUB_SSHD_FAIL" ] ;; -T) printf 'permitlisten 127.0.0.1:43123\\nallowtcpforwarding remote\\nmaxsessions 0\\ngatewayports no\\n' ;; esac`);
  const env = { PATH: `${bin}:${process.env.PATH}`, AGENTDECK_ROOT: path.join(d, 'root'), SSHD_BIN: path.join(bin, 'sshd') };
  fs.mkdirSync(path.join(d, 'root', 'etc', 'ssh'), { recursive: true });
  const key = (name) => { const f = path.join(d, name); run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'win-test', '-f', f]); return f; };
  return { d, env, log, key, logText: () => (fs.existsSync(log) ? read(log) : '') };
}

test('tunnel-account.sh create：账号、受限 authorized_keys、sshd 片段、先 sshd -t 再 reload', (t) => {
  const f = tunnelFixture(t); const root = f.env.AGENTDECK_ROOT;
  const key = f.key('k');
  const r = run(path.join(VPS, 'tunnel-account.sh'), ['create', '--pubkey', key + '.pub'], f.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const auth = read(path.join(root, 'var/lib/agentdeck-tunnel-win/.ssh/authorized_keys'));
  assert.equal(auth, `restrict,port-forwarding,permitlisten="127.0.0.1:43123" ${read(key + '.pub').trim()}\n`);
  assert.equal(mode(path.join(root, 'var/lib/agentdeck-tunnel-win/.ssh/authorized_keys')), '600');
  assert.equal(mode(path.join(root, 'var/lib/agentdeck-tunnel-win/.ssh')), '700');
  assert.equal(read(path.join(root, 'etc/ssh/sshd_config.d/agentdeck-tunnel-win.conf')), read(path.join(VPS, 'sshd_agentdeck-tunnel-win.conf')));
  const cmds = f.logText().split('\n');
  assert.ok(cmds.some((c) => /^useradd .*--shell \/usr\/sbin\/nologin .*agentdeck-tunnel-win$/.test(c)));
  assert.ok(cmds.includes("usermod -p * agentdeck-tunnel-win"), 'account is password-less but not locked');
  const iT = cmds.findIndex((c) => c === 'sshd -t'), iR = cmds.findIndex((c) => /^systemctl reload ssh/.test(c));
  assert.ok(iT >= 0 && iR > iT, 'sshd -t runs before the reload');
  assert.ok(!f.logText().includes('agentdeck-tunnel '), 'the Mac account is never touched');
  assert.ok(fs.readdirSync(path.join(root, 'var/backups/agentdeck-three-ends')).length === 1);
  // rerun is fine (account exists)
  assert.equal(run(path.join(VPS, 'tunnel-account.sh'), ['create', '--pubkey', key + '.pub'], f.env).status, 0);
});

test('tunnel-account.sh create：--dry-run 什么都不建；sshd -t 失败时撤回片段且不 reload', (t) => {
  const f = tunnelFixture(t); const root = f.env.AGENTDECK_ROOT; const key = f.key('k');
  const dry = run(path.join(VPS, 'tunnel-account.sh'), ['create', '--pubkey', key + '.pub', '--dry-run'], f.env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\[dry-run\]/);
  assert.equal(f.logText(), '');
  assert.ok(!fs.existsSync(path.join(root, 'etc/ssh/sshd_config.d/agentdeck-tunnel-win.conf')));

  const bad = run(path.join(VPS, 'tunnel-account.sh'), ['create', '--pubkey', key + '.pub'], { ...f.env, STUB_SSHD_FAIL: '1' });
  assert.notEqual(bad.status, 0);
  assert.ok(!fs.existsSync(path.join(root, 'etc/ssh/sshd_config.d/agentdeck-tunnel-win.conf')), 'drop-in removed after a failed sshd -t');
  assert.ok(!/systemctl reload/.test(f.logText()), 'never reloads an invalid config');
});

test('tunnel-account.sh create：私钥、多行、非 ed25519、带选项的行一律拒绝', (t) => {
  const f = tunnelFixture(t); const root = f.env.AGENTDECK_ROOT; const key = f.key('k');
  const pub = read(key + '.pub').trim();
  const rsa = path.join(f.d, 'rsa'); run('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-N', '', '-f', rsa]);
  const cases = {
    private: [key, /PRIVATE key/],
    twoLines: [path.join(f.d, 'two'), /exactly one/],
    rsa: [rsa + '.pub', /ed25519/],
    options: [path.join(f.d, 'opt'), /ed25519/],
    garbage: [path.join(f.d, 'garbage'), /not a valid public key/],
    missing: [path.join(f.d, 'nope'), /no such file/],
  };
  fs.writeFileSync(cases.twoLines[0], `${pub}\n${pub}\n`);
  fs.writeFileSync(cases.options[0], `command="/bin/sh" ${pub}\n`);
  fs.writeFileSync(cases.garbage[0], 'ssh-ed25519 AAAAnotakey junk\n');
  for (const [name, [file, re]] of Object.entries(cases)) {
    const r = run(path.join(VPS, 'tunnel-account.sh'), ['create', '--pubkey', file], f.env);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, re, name);
  }
  assert.equal(f.logText(), '', 'no system command ran for a rejected key');
  assert.ok(!fs.existsSync(path.join(root, 'var/lib')));
});

test('tunnel-account.sh remove：删片段和账号，sshd -t 后 reload，不碰 Mac 账号', (t) => {
  const f = tunnelFixture(t); const root = f.env.AGENTDECK_ROOT; const key = f.key('k');
  assert.equal(run(path.join(VPS, 'tunnel-account.sh'), ['create', '--pubkey', key + '.pub'], f.env).status, 0);
  fs.writeFileSync(f.log, '');
  const r = run(path.join(VPS, 'tunnel-account.sh'), ['remove'], f.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(path.join(root, 'etc/ssh/sshd_config.d/agentdeck-tunnel-win.conf')));
  const cmds = f.logText().split('\n');
  assert.ok(cmds.includes('userdel -r agentdeck-tunnel-win'));
  assert.ok(cmds.indexOf('sshd -t') < cmds.findIndex((c) => /^systemctl reload ssh/.test(c)));
  assert.ok(!/agentdeck-tunnel( |$)/.test(f.logText()), 'Mac account untouched');
});

// ---------------------------------------------------------------- deploy-hub.sh (local target)
test('deploy-hub.sh：原子发布、保留旧版本、可回滚、拒绝覆盖真实目录', (t) => {
  const d = tmp(t); const parent = path.join(d, 'srv'); fs.mkdirSync(parent);
  const src = path.join(d, 'hub'); fs.cpSync(path.join(__dirname, 'fixtures', 'vps', 'hub'), src, { recursive: true });
  fs.writeFileSync(path.join(src, 'app.js.map'), '{}');
  fs.mkdirSync(path.join(src, 'tests')); fs.writeFileSync(path.join(src, 'tests', 'x.js'), '');
  const deploy = (args, env = {}) => run(path.join(VPS, 'deploy-hub.sh'), args, env);

  const first = deploy(['push', src, parent], { DEPLOY_HUB_TIMESTAMP: '20260101T000001Z' });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.lstatSync(path.join(parent, 'agentdeck-hub')).isSymbolicLink());
  const live = path.join(parent, 'agentdeck-hub');
  assert.match(read(path.join(live, 'index.html')), /hub placeholder/);
  for (const hidden of ['.secret', 'app.js.map', 'tests']) assert.ok(!fs.existsSync(path.join(live, hidden)), `${hidden} not uploaded`);

  fs.writeFileSync(path.join(src, 'app.js'), 'document.title = "v2";');
  assert.equal(deploy(['push', src, parent], { DEPLOY_HUB_TIMESTAMP: '20260101T000002Z' }).status, 0);
  assert.match(read(path.join(live, 'app.js')), /v2/);
  const rb = deploy(['rollback', parent]);
  assert.equal(rb.status, 0, rb.stderr);
  assert.match(read(path.join(live, 'app.js')), /hub";/);
  assert.notEqual(deploy(['rollback', parent]).status, 0, 'nothing older to go back to');
  assert.match(deploy(['list', parent]).stdout, /current: agentdeck-hub-releases\/20260101T000001Z/);

  // keeps the newest 5
  for (let i = 3; i <= 9; i++) assert.equal(deploy(['push', src, parent], { DEPLOY_HUB_TIMESTAMP: `20260101T00000${i}Z` }).status, 0);
  assert.equal(fs.readdirSync(path.join(parent, 'agentdeck-hub-releases')).length, 5);

  // never replaces a real directory
  const other = path.join(d, 'srv2'); fs.mkdirSync(path.join(other, 'agentdeck-hub'), { recursive: true });
  fs.writeFileSync(path.join(other, 'agentdeck-hub', 'keep.txt'), 'mine');
  const refused = deploy(['push', src, other]);
  assert.notEqual(refused.status, 0);
  assert.equal(read(path.join(other, 'agentdeck-hub', 'keep.txt')), 'mine');
});

test('deploy-hub.sh：CSP 检查拦住内联脚本、样式和事件属性', (t) => {
  const d = tmp(t); const parent = path.join(d, 'srv'); fs.mkdirSync(parent);
  const variants = {
    inlineScript: '<script>alert(1)</script>',
    inlineStyle: '<style>a{}</style>',
    styleAttr: '<p style="color:red">x</p>',
    handler: '<button onclick="go()">x</button>',
  };
  for (const [name, html] of Object.entries(variants)) {
    const src = path.join(d, name); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'index.html'), `<!doctype html>${html}`);
    const r = run(path.join(VPS, 'deploy-hub.sh'), ['push', src, parent]);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /CSP lint/, name);
  }
  assert.ok(!fs.existsSync(path.join(parent, 'agentdeck-hub')), 'nothing was published');
  const ok = path.join(d, 'ok'); fs.mkdirSync(ok);
  fs.writeFileSync(path.join(ok, 'index.html'), '<!doctype html><link rel="stylesheet" href="s.css"><script src="a.js"></script><script type="module" src="b.js"></script>');
  assert.equal(run(path.join(VPS, 'deploy-hub.sh'), ['push', ok, parent]).status, 0);
  const forced = path.join(d, 'forced'); fs.mkdirSync(forced); fs.writeFileSync(path.join(forced, 'index.html'), '<script>1</script>');
  assert.equal(run(path.join(VPS, 'deploy-hub.sh'), ['push', forced, parent], { DEPLOY_HUB_SKIP_CSP_LINT: '1' }).status, 0);
});

test('deploy-hub.sh：远程目标（host:path）走 ssh，引用与流水线正确（用假 ssh 在本地执行）', (t) => {
  const d = tmp(t); const parent = path.join(d, 'srv with space'); fs.mkdirSync(parent);
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(d, 'ssh.log');
  // fake ssh: records the host, then runs the single remote command string with a local shell, like sshd would
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash\nwhile [ "\${1#-}" != "$1" ]; do shift 2; done\necho "$1" >> "${calls}"\nshift\nexec bash -c "$1"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const src = path.join(d, 'hub'); fs.cpSync(path.join(__dirname, 'fixtures', 'vps', 'hub'), src, { recursive: true });
  const r = run(path.join(VPS, 'deploy-hub.sh'), ['push', src, `admin@vps.example:${parent}`], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(read(path.join(parent, 'agentdeck-hub', 'index.html')), /hub placeholder/);
  assert.ok(read(calls).split('\n').filter(Boolean).every((h) => h === 'admin@vps.example'));
  assert.equal(run(path.join(VPS, 'deploy-hub.sh'), ['list', `admin@vps.example:${parent}`], env).status, 0);
});
