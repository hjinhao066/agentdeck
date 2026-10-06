'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const signing = require('../scripts/signing-check');

const pinned = signing.loadPinned();
const SHA = 'a'.repeat(40);

test('pinned DR parsing and classification', () => {
  const stable = signing.expectedRequirement(pinned);
  assert.equal(stable, `identifier "com.jinhao.agentdeck" and certificate leaf = H"${pinned.leafSha1}"`);
  assert.equal(signing.parseDesignatedRequirement(`Executable=/x\ndesignated => ${stable.toUpperCase().replace('IDENTIFIER', 'identifier')}\n`).includes(pinned.leafSha1), true);
  assert.equal(signing.parseDesignatedRequirement('Executable=/x\n'), null);
  assert.equal(signing.checkRequirement(stable, pinned).ok, true);
  const adhoc = signing.checkRequirement(`cdhash H"${SHA}"`, pinned);
  assert.equal(adhoc.ok, false); assert.match(adhoc.reason, /ad-hoc/);
  assert.equal(signing.checkRequirement(`identifier "other" and certificate leaf = H"${pinned.leafSha1}"`, pinned).ok, false);
  assert.equal(signing.checkRequirement(`identifier "${pinned.identifier}" and certificate leaf = H"${SHA}"`, pinned).ok, false);
});

test('package.json signs the Mac build with the pinned identity name', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.build.mac.identity, pinned.name);
  assert.equal(pkg.build.appId, pinned.identifier);
});

test('identity gate reports missing identity and a missing DR', () => {
  const none = () => ({ stdout: '     0 valid identities found\n', stderr: '' });
  assert.equal(signing.identityAvailable(pinned, none), false);
  const some = () => ({ stdout: `  1) ${pinned.leafSha1.toUpperCase()} "${pinned.name}"\n     1 valid identities found\n`, stderr: '' });
  assert.equal(signing.identityAvailable(pinned, some), true);
  assert.throws(() => signing.readRequirement('/x.app', () => ({ stdout: '', stderr: 'code object is not signed at all' })), /No designated requirement/);
});

// Real codesign. Two versions of the same app are signed with the pinned identity and with
// ad-hoc, and checked the way TCC checks: does the old requirement still accept the new build?
const real = process.platform === 'darwin' && fs.existsSync('/usr/bin/codesign') && (() => { try { return signing.identityAvailable(pinned); } catch (_) { return false; } })();

function fixtureApp(root, version) {
  const app = path.join(root, version, 'AgentDeck.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.copyFileSync('/bin/echo', path.join(app, 'Contents/MacOS/AgentDeck'));
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${pinned.identifier}</string><key>CFBundleExecutable</key><string>AgentDeck</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
  return app;
}
const sign = (app, identity) => { const r = spawnSync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--sign', identity, app], { encoding: 'utf8', timeout: 60000 }); assert.equal(r.status, 0, r.stderr); };
const cdhash = (app) => /CDHash=(\w+)/.exec(spawnSync('/usr/bin/codesign', ['-dvvv', app], { encoding: 'utf8' }).stderr)[1];
const satisfies = (requirement, app) => spawnSync('/usr/bin/codesign', ['--verify', '-R', `=${requirement}`, app], { encoding: 'utf8' }).status === 0;

test('two versions signed with the pinned identity keep the same designated requirement', { skip: !real && 'pinned AgentDeck Dev identity not in this keychain' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-signing-'));
  try {
    const a = fixtureApp(root, '1.0.0'); const b = fixtureApp(root, '1.0.1');
    sign(a, pinned.leafSha1); sign(b, pinned.leafSha1);
    assert.notEqual(cdhash(a), cdhash(b), 'fixture versions must be different binaries');
    const reqA = signing.readRequirement(a); const reqB = signing.readRequirement(b);
    assert.equal(reqA, reqB);
    assert.equal(reqA, signing.expectedRequirement(pinned));
    assert.equal(signing.checkApps([a, b], pinned).ok, true);
    assert.equal(satisfies(reqA, b), true, 'a grant stored from 1.0.0 must accept 1.0.1');
    assert.equal(signing.main([a, b], { log() {}, error() {} }), 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ad-hoc builds are rejected: their DR changes every version and the old grant stops matching', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/codesign') }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-signing-'));
  try {
    const a = fixtureApp(root, '1.0.0'); const b = fixtureApp(root, '1.0.1');
    sign(a, '-'); sign(b, '-');
    const reqA = signing.readRequirement(a); const reqB = signing.readRequirement(b);
    assert.match(reqA, /^cdhash H"/); assert.notEqual(reqA, reqB);
    assert.equal(satisfies(reqA, a), true); assert.equal(satisfies(reqA, b), false, 'the screen-recording failure mode');
    assert.equal(signing.checkApps([a], pinned).ok, false);
    const errors = []; assert.equal(signing.main([a], { log() {}, error: (m) => errors.push(m) }), 1); assert.match(errors.join('\n'), /ad-hoc/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
