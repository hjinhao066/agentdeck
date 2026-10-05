'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { build, pageMetadata, reader, verify, deploy, rollback, parseArgs, configuration } = require('../scripts/mobile-release');
const { deployMobileGate } = require('../scripts/release');
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const old = { version: '1.1.7', commit: 'a'.repeat(40), builtAt: '2026-10-04T23:00:35.000Z' };
const stamped = (value) => '<head>' + Object.entries(value).map(([key, data]) => `<meta name="agentdeck-${key}" content="${data}">`).join('\n') + '</head>';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-mobile-deploy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote'), output = path.join(root, 'output');
  fs.mkdirSync(repo); fs.mkdirSync(remote);
  fs.cpSync(path.join(__dirname, '../mobile-web/hub'), path.join(repo, 'mobile-web/hub'), { recursive: true });
  writeJSON(path.join(repo, 'package.json'), { version: '1.2.0' });
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.hooksPath', path.join(root, 'no-hooks')); git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'hub fixture');
  const previous = 'agentdeck-hub-releases/20261004T230035Z';
  fs.mkdirSync(path.join(remote, previous), { recursive: true });
  fs.writeFileSync(path.join(remote, previous, 'index.html'), stamped(old));
  fs.symlinkSync(previous, path.join(remote, 'agentdeck-hub'));
  const requests = [];
  const state = { mode: 'normal' };
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', state.mode === 'cacheable' ? 'max-age=3600' : 'no-store');
    const name = new URL(req.url, 'http://localhost').pathname;
    requests.push(name);
    if (state.mode === 'redirect') { res.writeHead(302, { Location: '/mac/' }); res.end(); return; }
    if (name === '/' && state.mode === 'stale') { res.end(stamped(old)); return; }
    if (name === '/app.js' && state.mode === 'tampered') { res.end('old app'); return; }
    try {
      const bytes = fs.readFileSync(path.join(remote, 'agentdeck-hub', name === '/' ? 'index.html' : name.slice(1)));
      if (name === '/release.json' && state.mode === 'receiptFailure') fs.rmSync(output, { recursive: true, force: true });
      res.end(bytes);
    }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { target: remote, origin: `http://127.0.0.1:${server.address().port}` };
  return { root, repo, remote, output, config, state, requests, previous };
}

test('build stamps the committed version/SHA/time and cache-busts assets without editing source', async (t) => {
  const { repo, output } = await fixture(t);
  const before = fs.readFileSync(path.join(repo, 'mobile-web/hub/index.html'));
  const manifest = build(repo, output, { version: '1.2.0', commit: git(repo, 'rev-parse', 'HEAD') });
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.deepEqual(pageMetadata(html), { version: manifest.version, commit: manifest.commit, builtAt: manifest.builtAt });
  assert.match(html, new RegExp(`app.js\\?v=${manifest.commit}`));
  assert.ok(!/<script(?![^>]*src=)|<style\b|\sstyle=|\son\w+=/.test(html));
  assert.deepEqual(fs.readFileSync(path.join(repo, 'mobile-web/hub/index.html')), before);
  assert.throws(() => build(repo, output, { version: '1.3.0' }), /differs/);
  fs.writeFileSync(path.join(repo, 'uncommitted'), 'changed');
  assert.throws(() => build(repo, output), /clean committed/);
});

test('online version mismatch and legacy missing stamps fail the read-only check', async (t) => {
  const { config, remote, requests } = await fixture(t);
  await assert.rejects(verify(reader(config), { version: '1.2.0' }), /online=1.1.7, expected=1.2.0/);
  assert.equal(requests.length, 1);
  assert.equal((await verify(reader(config), { version: '1.1.7' })).commit, old.commit);
  fs.writeFileSync(path.join(remote, 'agentdeck-hub/index.html'), '<head>legacy</head>');
  await assert.rejects(verify(reader(config), { version: '1.2.0' }), /not deployed/);
  assert.throws(() => pageMetadata(stamped({ ...old, commit: 'not-a-sha' })), /Invalid/);
});

test('deploy uploads a real fake remote directory, verifies public bytes and preserves old release', async (t) => {
  const { repo, remote, output, config, previous, requests } = await fixture(t);
  const report = await deploy(repo, output, config, { version: '1.2.0' });
  assert.equal(report.status, 'passed'); assert.equal(report.attempts.length, 1);
  assert.equal(report.previous, previous); assert.equal(report.rollback, 'not-needed');
  assert.equal(fs.readlinkSync(path.join(remote, 'agentdeck-hub')), report.remoteRelease);
  assert.equal(fs.readFileSync(path.join(remote, previous, 'index.html'), 'utf8'), stamped(old));
  assert.equal(fs.existsSync(path.join(remote, '.agentdeck-mobile-deploy.lock')), false);
  assert.deepEqual(requests, ['/', '/core.js', '/app.js', '/style.css', '/machines.json', '/release.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'mobile-deploy-result.json'))), report);
});

for (const mode of ['stale', 'tampered', 'redirect', 'cacheable']) {
  test(`three ${mode} public responses stop and restore the exact original link`, async (t) => {
    const { repo, remote, output, config, previous, requests, state } = await fixture(t);
    state.mode = mode;
    await assert.rejects(deploy(repo, output, config), /3 attempts; stopped; rollback=restored/);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'mobile-deploy-result.json')));
    assert.equal(report.status, 'failed'); assert.equal(report.attempts.length, 3);
    assert.equal(report.rollback, 'restored');
    assert.equal(requests.filter((name) => name === '/').length, 3);
    assert.equal(requests.includes('/mac/'), false);
    assert.equal(fs.readlinkSync(path.join(remote, 'agentdeck-hub')), previous);
    assert.equal(fs.existsSync(path.join(remote, '.agentdeck-mobile-deploy.lock')), false);
  });
}

test('another deploy lock is never stolen or removed; no public requests or activation', async (t) => {
  const { repo, remote, output, config, previous, requests } = await fixture(t);
  fs.mkdirSync(path.join(remote, '.agentdeck-mobile-deploy.lock'));
  await assert.rejects(deploy(repo, output, config), /command failed/);
  assert.equal(fs.existsSync(path.join(remote, '.agentdeck-mobile-deploy.lock')), true);
  assert.equal(fs.readlinkSync(path.join(remote, 'agentdeck-hub')), previous);
  assert.deepEqual(requests, []);
});

test('upload failures are attempted exactly three times and preserve the previous release', async (t) => {
  const { root, repo, remote, output, config, previous, requests } = await fixture(t);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const counter = path.join(root, 'tar-calls');
  const stub = path.join(bin, 'tar');
  fs.writeFileSync(stub, `#!/bin/sh\necho call >> '${counter}'\nexit 1\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + originalPath;
  try { await assert.rejects(deploy(repo, output, config), /3 attempts; stopped; rollback=restored/); }
  finally { process.env.PATH = originalPath; }
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 3);
  assert.equal(fs.readlinkSync(path.join(remote, 'agentdeck-hub')), previous);
  assert.deepEqual(requests, []);
});

test('absolute rollback links are restored unchanged after three failed checks', async (t) => {
  const { repo, remote, output, config, previous, state } = await fixture(t);
  const absolute = path.join(remote, previous);
  fs.unlinkSync(path.join(remote, 'agentdeck-hub')); fs.symlinkSync(absolute, path.join(remote, 'agentdeck-hub'));
  state.mode = 'stale';
  await assert.rejects(deploy(repo, output, config), /rollback=restored/);
  assert.equal(fs.readlinkSync(path.join(remote, 'agentdeck-hub')), absolute);
});

test('malformed private JSON errors never include credentials or raw input', async (t) => {
  const { root } = await fixture(t);
  const authFile = path.join(root, 'bad-auth.json');
  const privateRoot = path.join(root, '.config/agentdeck-remote'); fs.mkdirSync(privateRoot, { recursive: true });
  const secret = 'fixture-secret-that-must-not-leak';
  fs.writeFileSync(authFile, `{"password":"${secret}",bad`);
  fs.writeFileSync(path.join(privateRoot, 'mobile-deploy.json'), `{"password":"${secret}",bad`);
  for (const action of [() => reader({ origin: 'https://agentdeck.18-139-28-180.sslip.io', authFile }), () => configuration(root)]) {
    assert.throws(action, (error) => !error.message.includes(secret) && error.message === 'Cannot read private mobile configuration/credentials');
  }
});

test('CSP-incompatible hub code is refused before deployment', async (t) => {
  const { repo, output } = await fixture(t);
  fs.appendFileSync(path.join(repo, 'mobile-web/hub/index.html'), '<script>unsafe()</script>');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'bad script');
  assert.throws(() => build(repo, output), /CSP lint/);
});

test('standalone deployment reads an arbitrary reviewed commit without checkout/merge/version bump', async (t) => {
  const { repo, remote, output, config } = await fixture(t);
  git(repo, 'checkout', '-qb', 'reviewed-phone-ui');
  fs.appendFileSync(path.join(repo, 'mobile-web/hub/app.js'), '\n// reviewed phone-only revision\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'phone-only revision');
  const reviewed = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-qb', 'unrelated', 'HEAD^');
  fs.writeFileSync(path.join(repo, 'local-note'), 'uncommitted file must stay');
  const before = git(repo, 'status', '--porcelain');
  const report = await deploy(repo, output, config, { ref: 'reviewed-phone-ui' });
  assert.equal(report.release.commit, reviewed); assert.equal(report.release.version, '1.2.0');
  assert.match(fs.readFileSync(path.join(remote, 'agentdeck-hub/app.js'), 'utf8'), /reviewed phone-only revision/);
  assert.equal(git(repo, 'branch', '--show-current'), 'unrelated');
  assert.equal(git(repo, 'status', '--porcelain'), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).version, '1.2.0');
});

test('one-command rollback restores and verifies the saved old page, including legacy unstamped HTML', async (t) => {
  const { repo, remote, output, config, previous } = await fixture(t);
  fs.writeFileSync(path.join(remote, 'agentdeck-hub/index.html'), '<head>old unstamped phone</head>\n');
  await deploy(repo, output, config);
  const result = await rollback(path.join(output, 'mobile-deploy-result.json'), config);
  assert.equal(result.status, 'passed'); assert.equal(result.attempts.length, 1);
  assert.equal(fs.readlinkSync(path.join(remote, 'agentdeck-hub')), previous);
  assert.equal(fs.existsSync(path.join(remote, '.agentdeck-mobile-deploy.lock')), false);
});

test('a stale rollback receipt cannot overwrite a subsequent deployment', async (t) => {
  const { repo, remote, output, root, config } = await fixture(t);
  await deploy(repo, output, config);
  const current = await deploy(repo, path.join(root, 'second-output'), config);
  await assert.rejects(rollback(path.join(output, 'mobile-deploy-result.json'), config), /another release is now current/);
  assert.equal(fs.readlinkSync(path.join(remote, 'agentdeck-hub')), current.remoteRelease);
  assert.equal(fs.existsSync(path.join(remote, '.agentdeck-mobile-deploy.lock')), false);
});

test('receipt write failure after successful public verification restores the old release', async (t) => {
  const { repo, remote, output, config, previous, state } = await fixture(t);
  state.mode = 'receiptFailure';
  await assert.rejects(deploy(repo, output, config), /rollback=restored; cannot write deployment report/);
  assert.equal(fs.readlinkSync(path.join(remote, 'agentdeck-hub')), previous);
  assert.equal(fs.existsSync(path.join(remote, '.agentdeck-mobile-deploy.lock')), false);
});

test('release gate rejects skipped deployment, stale receipts and every online stamp mismatch', async (t) => {
  const { repo, output } = await fixture(t); fs.mkdirSync(output);
  const commit = git(repo, 'rev-parse', 'HEAD');
  const plan = { version: '1.2.0', output, worktree: repo };
  const receipt = { status: 'passed', release: { version: '1.2.0', commit, builtAt: old.builtAt }, online: { version: '1.2.0', commit, builtAt: old.builtAt } };
  const file = path.join(output, 'mobile-deploy-result.json');
  writeJSON(file, receipt);
  await assert.rejects(deployMobileGate(plan, commit, async () => {}), /not deployed/);
  assert.equal(fs.existsSync(file), false);
  for (const mismatch of [{ version: '1.1.7' }, { commit: old.commit }, { builtAt: '2026-01-01T00:00:00Z' }]) {
    await assert.rejects(deployMobileGate(plan, commit, async () => writeJSON(file, { ...receipt, online: { ...receipt.online, ...mismatch } })), /does not match/);
  }
  await assert.rejects(deployMobileGate(plan, commit, async () => writeJSON(file, { ...receipt, status: 'failed' })), /does not match/);
  assert.deepEqual(await deployMobileGate(plan, commit, async (cmd, args, cwd, log, env) => {
    assert.ok(args.includes('deploy')); assert.ok(args.includes('--version')); assert.ok(args.includes(commit));
    assert.equal(cwd, repo); assert.equal(Object.keys(env).some((key) => key.startsWith('AGENTDECK_')), false);
    writeJSON(file, receipt);
  }), receipt);
});

test('defaults reference existing private paths; unknown flags and bare-IP public URLs fail closed', () => {
  const config = configuration('/fixture-home');
  assert.equal(config.origin, 'https://agentdeck.18-139-28-180.sslip.io');
  assert.equal(config.identityFile, '/fixture-home/portfolio-tracker/binance-proxy.pem');
  assert.equal(config.authFile, '/fixture-home/.config/agentdeck-remote/vps-access.json');
  assert.throws(() => reader({ origin: 'https://18.139.28.180' }), /sslip/);
  assert.throws(() => parseArgs(['deploy']), /--output/);
  assert.throws(() => parseArgs(['check', '--skip']), /Invalid/);
});
