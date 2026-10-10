// Every operation, a rollback included, first backs up the app it replaces. A rollback
// without --backup used to take the newest backup, so a second rollback put back the
// version the first one left, and a rollback after a failed upgrade (old app restored,
// newest backup = that same version) reinstalled the installed version. A rollback
// goes back: only a backup older than the installed version counts.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { newestBackup } = require('../scripts/install-agentdeck');

// backups: [name, version, mtime]; each backup holds AgentDeck.app/version.
function backups(t, list) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-rollback-older-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, version, mtime] of list) {
    fs.mkdirSync(path.join(root, name, 'AgentDeck.app'), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'AgentDeck.app', 'version'), version);
    fs.utimesSync(path.join(root, name), mtime, mtime);
  }
  return root;
}
const versionOf = (app) => fs.readFileSync(path.join(app, 'version'), 'utf8');

test('after one rollback, the next one does not put back the version it left', (t) => {
  // 2.0.2 → 2.0.3 backed up 2.0.2; rolling back to 2.0.2 backed up 2.0.3.
  const dir = backups(t, [['1000-up', '2.0.2', 100], ['2000-back-1', '2.0.3', 200]]);
  assert.equal(newestBackup(dir, { installed: '2.0.2', versionOf }), undefined);
  const older = path.join(dir, '0500-older');
  fs.mkdirSync(path.join(older, 'AgentDeck.app'), { recursive: true });
  fs.writeFileSync(path.join(older, 'AgentDeck.app', 'version'), '2.0.1');
  fs.utimesSync(older, 50, 50);
  assert.equal(newestBackup(dir, { installed: '2.0.2', versionOf }), older);
});

test('after a failed upgrade, rollback goes back past the installed version', (t) => {
  // 2.0.3 installed; a failed 2.0.3 → 2.0.4 attempt left a newer backup of 2.0.3 itself.
  const dir = backups(t, [['1000-up', '2.0.2', 100], ['2000-failed-204', '2.0.3', 200], ['3000-broken', 'garbage', 300]]);
  assert.equal(newestBackup(dir, { installed: '2.0.3', versionOf }), path.join(dir, '1000-up'));
  assert.equal(newestBackup(dir, { installed: '2.0.10', versionOf }), path.join(dir, '2000-failed-204'));
});

// The real entry, plan only: without --go nothing is stopped or copied. plutil reads the Info.plist.
function plan(t, installed, list) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-rollback-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plist = (dir, v) => {
    fs.mkdirSync(path.join(dir, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`);
  };
  plist(path.join(root, 'AgentDeck.app'), installed);
  for (const [name, version, mtime] of list) {
    plist(path.join(root, 'backups', name, 'AgentDeck.app'), version);
    fs.utimesSync(path.join(root, 'backups', name), mtime, mtime);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTDECK_')));
  Object.assign(env, { AGENTDECK_APP: path.join(root, 'AgentDeck.app'), AGENTDECK_BACKUPS: path.join(root, 'backups'),
    AGENTDECK_DATA: path.join(root, 'data'), AGENTDECK_LOG: path.join(root, 'log') });
  return spawnSync(process.execPath, [path.join(__dirname, '../scripts/install-agentdeck.js'), '--rollback'], { env, encoding: 'utf8' });
}
const mac = { skip: process.platform !== 'darwin' && 'plutil is macOS only' };

test('rollback-agentdeck.sh plans the newest backup older than the installed app', mac, (t) => {
  const run = plan(t, '2.0.3', [['1000-up', '2.0.2', 100], ['2000-failed-204', '2.0.3', 200]]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1000-up/);
});

test('rollback-agentdeck.sh with no older backup stops and asks for --backup', mac, (t) => {
  const run = plan(t, '2.0.2', [['1000-up', '2.0.2', 100], ['2000-back-1', '2.0.3', 200]]);
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout, /2000-back-1/);
  assert.match(run.stderr, /No app backup older than the installed 2\.0\.2; pass --backup/);
});
