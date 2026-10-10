'use strict';
// e2e-remote-win.js end to end against stand-in `ssh` and `scp` (no Windows, no network): the
// script runs in a throw-away git repository, the stand-ins answer like the Windows PC and write
// every command they get to a log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const FILES = ['e2e-remote-win.js', 'e2e-queue.js', 'e2e-queue-core.js', 'e2e-remote-job.js'];

function setup(t, { knownTip = null, failScp = '', runSeconds = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-remote-win-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), bin = path.join(root, 'bin'), log = path.join(root, 'calls.log');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  for (const f of FILES) fs.copyFileSync(path.join(SCRIPTS, f), path.join(repo, 'scripts', f));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'one');
  const first = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'two.txt'), '2'); git('add', '-A'); git('commit', '-q', '-m', 'two');
  const second = git('rev-parse', 'HEAD');
  const tip = knownTip === 'second' ? second : '';
  // ssh <opts...> host command: answers like the Windows PC.
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
for last; do :; done
printf 'ssh %s\\n' "$last" >> ${JSON.stringify(log)}
case "$last" in
  *'echo %USERPROFILE%'*) printf '%s\\n' 'C:\\Users\\tester' ;;
  *'for-each-ref refs/e2e'*) [ -n "${tip}" ] && echo "${tip}" ;;
  *'e2e-queue.js'*) echo remote-run; sleep ${runSeconds}; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'scp'), `#!/bin/sh
printf 'scp %s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in *${failScp || '__never__'}*) exit 1 ;; esac
exit 0
`, { mode: 0o755 });
  const run = (ref) => {
    const child = spawn(process.execPath, [path.join(repo, 'scripts', 'e2e-remote-win.js'), ref, 'tests/e2e/x.spec.js', '--out', path.join(root, 'out')], {
      cwd: repo, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
    return { child, done, out: () => out };
  };
  const calls = () => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } };
  return { first, second, run, calls };
}

test('a commit Windows already holds as an ancestor of a known commit is tested without a bundle', { skip: process.platform === 'win32' }, async (t) => {
  // Windows holds "two"; testing "one" (e.g. the release baseline) needs nothing new.
  const s = setup(t, { knownTip: 'second' });
  const result = await s.run(s.first).done;
  assert.equal(result.code, 0, result.out);
  assert.match(s.calls(), /remote-run|e2e-queue\.js/);
  assert.doesNotMatch(s.calls(), /commit\.bundle/, 'an empty bundle was sent');
});

test('a run that fails after the Windows folders were made removes them again', { skip: process.platform === 'win32' }, async (t) => {
  const s = setup(t, { failScp: 'job.json' });
  const result = await s.run(s.second).done;
  assert.notEqual(result.code, 0);
  const calls = s.calls();
  assert.match(calls, /mkdir "C:\\Users\\tester\\agentdeck-e2e-win\\inbox\\[^"]+\\tools"/);
  assert.match(calls, /rmdir \/s \/q "C:\\Users\\tester\\agentdeck-e2e-win\\inbox\\[^"]+"/, `the inbox folder made on Windows is left behind:\n${calls}`);
});

test('a SIGTERM while Windows runs stops the run, brings back what there is and cleans up', { skip: process.platform === 'win32' }, async (t) => {
  const s = setup(t, { runSeconds: 30 });
  const r = s.run(s.second);
  const end = Date.now() + 10000;
  while (!/remote-run/.test(r.out()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(r.out(), /remote-run/);
  r.child.kill('SIGTERM');
  const result = await r.done;
  assert.notEqual(result.code, 0);
  const calls = s.calls();
  assert.match(calls, /scp -q .*-r .*runs\//, `results were not brought back:\n${calls}`);
  assert.match(calls, /rmdir \/s \/q "C:\\Users\\tester\\agentdeck-e2e-win\\inbox\\/, `the Windows run folders were left behind:\n${calls}`);
});
