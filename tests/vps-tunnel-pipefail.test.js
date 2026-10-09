'use strict';
// tunnel-account.sh runs under `set -o pipefail`. A check written as
// `printf … | grep -q pattern` fails when grep stops reading at its first match
// while printf is still writing: printf gets EPIPE (or SIGPIPE), pipefail turns
// that into a failed check, and a correct sshd setup is reported as wrong (the
// create run then rolls itself back). Real `sshd -T` output is a few hundred
// lines; these stubs print far more than a pipe holds after the matching lines,
// so the early exit of grep is certain instead of a timing accident.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform === 'win32') { test('VPS tunnel script tests are POSIX only', { skip: true }, () => {}); return; }

const SCRIPT = path.join(__dirname, '..', 'deploy', 'vps', 'tunnel-account.sh');
// Settings the script does not look at, enough to overflow any pipe buffer.
const FILLER = Array.from({ length: 12000 }, (_, i) => `setting${i} value-${i}`).join('\n') + '\n';

function fixture(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-vps-pipefail-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const bin = path.join(d, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(d, 'filler.txt'), FILLER);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // Matching lines first, then the long tail: grep -q is satisfied long before the writer is done.
  stub('sshd', `case "$1" in
  -t) exit 0 ;;
  -T)
    user="$(echo "$*" | sed -n 's/.*user=\\([^,]*\\).*/\\1/p')"
    case "$user" in
      agentdeck-tunnel-win) printf 'permitlisten 127.0.0.1:43123\\nallowtcpforwarding remote\\nmaxsessions 0\\ngatewayports no\\npermitopen none\\n' ;;
      agentdeck-tunnel) echo 'permitlisten 127.0.0.1:43122' ;;
      root) echo 'permitlisten any' ;;
    esac
    cat "${d}/filler.txt" ;;
esac`);
  const root = path.join(d, 'root');
  fs.mkdirSync(path.join(root, 'etc', 'ssh', 'sshd_config.d'), { recursive: true });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENTDECK_ROOT: root, SSHD_BIN: path.join(bin, 'sshd') };
  return { d, bin, root, env, stub };
}

const run = (args, env) => spawnSync(SCRIPT, args, { encoding: 'utf8', env });

test('tunnel-account.sh verify: a long sshd -T listing with the right settings passes (no broken-pipe false failure)', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'etc', 'ssh', 'sshd_config.d', 'agentdeck-tunnel-win.conf'), '# installed drop-in\n');
  const r = run(['verify'], f.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Mac account agentdeck-tunnel is limited to 127\.0\.0\.1:43122/);
  assert.match(r.stdout, /effective sshd settings for agentdeck-tunnel-win verified/);
  assert.match(r.stdout, /verify ok/);
  assert.doesNotMatch(r.stderr, /Broken pipe|ERROR/);
});

test('tunnel-account.sh verify: a long listing that lacks a setting still fails', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'etc', 'ssh', 'sshd_config.d', 'agentdeck-tunnel-win.conf'), '# installed drop-in\n');
  // Same stub, but the Windows account is missing permitopen none.
  const sshd = fs.readFileSync(path.join(f.bin, 'sshd'), 'utf8').replace('\\npermitopen none\\n', '\\n');
  fs.writeFileSync(path.join(f.bin, 'sshd'), sshd, { mode: 0o755 });
  const r = run(['verify'], f.env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /permitopen is not none/);
});

test('tunnel-account.sh create: a long `ss -ltn` listing still reports something already listening on the port', (t) => {
  const f = fixture(t);
  const log = path.join(f.d, 'commands.log');
  f.stub('id', `if [ "$1" = agentdeck-tunnel-win ]; then [ -e "${f.d}/.user" ]; exit $?; fi\nexec /usr/bin/id "$@"`);
  f.stub('useradd', `echo "useradd $*" >> "${log}"; touch "${f.d}/.user"`);
  f.stub('usermod', `echo "usermod $*" >> "${log}"`);
  f.stub('userdel', `echo "userdel $*" >> "${log}"; rm -f "${f.d}/.user"`);
  f.stub('chown', `echo "chown $*" >> "${log}"`);
  f.stub('systemctl', `echo "systemctl $*" >> "${log}"`);
  f.stub('pkill', `echo "pkill $*" >> "${log}"`);
  f.stub('ss', `echo 'LISTEN 0 128 127.0.0.1:43123 0.0.0.0:*'\ncat "${f.d}/filler.txt"`);
  const key = path.join(f.d, 'k');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'win-test', '-f', key]);
  const r = run(['create', '--pubkey', key + '.pub'], f.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /warning: something already listens on 127\.0\.0\.1:43123/);
  assert.doesNotMatch(r.stderr, /Broken pipe/);
});
