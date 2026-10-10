'use strict';
// archived.json that cannot be read (damaged on disk, half-copied by hand) must cost nothing: the first save
// of a page that therefore sees an empty archive must not write [] over it, and the launch prune must not take
// the archive for empty and delete every archived session's saved terminal output.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../archive-recovery.js');

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-archive-unreadable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json'), archivePath = path.join(dir, 'archived.json');
  fs.writeFileSync(configPath, JSON.stringify({ columns: [{ id: 'c-live' }] }));
  fs.writeFileSync(archivePath, '{"v":1,"archived":[{"id":"c-arch-1"},{"id":"c-ar');   // cut short
  return { dir, configPath, archivePath };
}

test('a save never writes over an archive file it could not read: the file is copied aside first', (t) => {
  const p = profile(t);
  const damaged = fs.readFileSync(p.archivePath, 'utf8');
  const writer = A.createArchiveWriter({ configPath: p.configPath, archivePath: p.archivePath });
  writer.save({ columns: [{ id: 'c-live' }], archivedText: '[]' });
  const aside = fs.readdirSync(p.dir).filter((f) => f.startsWith('archived.json.unreadable-'));
  assert.equal(aside.length, 1, 'the damaged archive was overwritten without a copy');
  assert.equal(fs.readFileSync(path.join(p.dir, aside[0]), 'utf8'), damaged);
});

test('the launch prune keeps every replay while the archive file cannot be read', (t) => {
  const p = profile(t);
  assert.equal(A.replayIdsToKeep({ configPath: p.configPath, archivePath: p.archivePath }), null);
  fs.writeFileSync(p.archivePath, JSON.stringify({ v: 1, archived: [{ id: 'c-arch-1' }] }));
  assert.deepEqual([...A.replayIdsToKeep({ configPath: p.configPath, archivePath: p.archivePath })].sort(), ['c-arch-1', 'c-live']);
  fs.rmSync(p.archivePath);
  assert.deepEqual([...A.replayIdsToKeep({ configPath: p.configPath, archivePath: p.archivePath })], ['c-live'], 'no archive file: only the open columns');
  fs.writeFileSync(p.configPath, '{"columns": [');
  assert.equal(A.replayIdsToKeep({ configPath: p.configPath, archivePath: p.archivePath }), null, 'an unreadable config.json prunes nothing either');
});
