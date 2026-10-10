'use strict';
// The archive (closed sessions kept for restore; no cap) lives in userData/archived.json, not in
// config.json. config.json is rewritten on every save, about 8 times a minute on the user's Mac,
// and the archive was most of it (1005 entries, 2.86 MB of a 4 MB config once the board answers
// left it in 2.0.5) while it changes a few times an hour. At launch an archive still in
// config.json moves there (config.json copied aside first); after that the archive file is
// written only when the archive changed, and nothing is lost if a write fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../archive-recovery.js');

function profile(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-archive-file-'));
  const configPath = path.join(dir, 'config.json');
  if (config) fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return {
    dir, configPath, archivePath: path.join(dir, 'archived.json'),
    config: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
    archive: () => JSON.parse(fs.readFileSync(path.join(dir, 'archived.json'), 'utf8')).archived,
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
const entries = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `c-arch-${from + i}`, title: `archived ${from + i}`, cmd: 'claude', archivedAt: 1000 + from + i }));
const base = () => ({ theme: 'dark', columns: [{ id: 'c-live', title: 'open' }], folders: [{ id: 'f1', name: 'Work' }], archived: entries(3) });

test('at launch an archive in config.json moves to archived.json, config.json copied aside first', () => {
  const p = profile(base());
  try {
    const before = fs.readFileSync(p.configPath, 'utf8');
    const result = A.migrate({ configPath: p.configPath, archivePath: p.archivePath, now: () => 7000 });
    assert.equal(result.moved, 3);
    assert.deepEqual(p.archive(), entries(3));
    const { archived, ...rest } = JSON.parse(before);
    assert.deepEqual(p.config(), rest, 'config.json keeps everything else, without the archive');
    assert.equal(fs.readFileSync(path.join(p.dir, 'config.json.before-archive-split-7000'), 'utf8'), before, 'the config as it was, byte for byte');
    if (process.platform !== 'win32') for (const f of ['archived.json', 'config.json', 'config.json.before-archive-split-7000']) assert.equal(fs.statSync(path.join(p.dir, f)).mode & 0o777, 0o600, f);
    // the next launch has nothing to move and copies nothing
    assert.equal(A.migrate({ configPath: p.configPath, archivePath: p.archivePath, now: () => 8000 }).moved, 0);
    assert.equal(fs.readdirSync(p.dir).filter((f) => f.includes('before-archive-split')).length, 1);
  } finally { p.done(); }
});

test('a failed move loses nothing: config.json keeps its archive until archived.json is written', () => {
  const p = profile(base());
  try {
    fs.mkdirSync(p.archivePath); // archived.json cannot be written
    const before = fs.readFileSync(p.configPath, 'utf8');
    assert.equal(A.migrate({ configPath: p.configPath, archivePath: p.archivePath, now: () => 7000 }).moved, 0);
    assert.equal(fs.readFileSync(p.configPath, 'utf8'), before);
    // and what the page loads still has the whole archive
    assert.deepEqual(A.withArchive(p.config(), p.archivePath).archived, entries(3));
  } finally { p.done(); }
});

test('an archive in both files (an older version ran in between) is merged: config.json wins a tie, an open column is not archived', () => {
  const p = profile({ ...base(), columns: [{ id: 'c-live' }, { id: 'c-arch-1' }], archived: [{ ...entries(1, 0)[0], title: 'renamed later' }, ...entries(1, 5)] });
  try {
    fs.writeFileSync(p.archivePath, JSON.stringify({ v: 1, archived: entries(3) }));
    A.migrate({ configPath: p.configPath, archivePath: p.archivePath, now: () => 7000 });
    const ids = p.archive().map((a) => a.id);
    assert.deepEqual(ids.sort(), ['c-arch-0', 'c-arch-2', 'c-arch-5']);
    assert.equal(p.archive().find((a) => a.id === 'c-arch-0').title, 'renamed later');
    assert.equal(p.config().archived, undefined);
  } finally { p.done(); }
});

test('a save writes the archive only when it changed, and never loses it', () => {
  const p = profile({ theme: 'dark', columns: [] });
  try {
    const writer = A.createArchiveWriter({ configPath: p.configPath, archivePath: p.archivePath });
    const text = JSON.stringify(entries(4));
    writer.save({ theme: 'dark', columns: [], archivedText: text });
    assert.deepEqual(p.archive(), entries(4));
    assert.equal(p.config().archived, undefined);
    assert.equal(p.config().archivedText, undefined);
    const ino = fs.statSync(p.archivePath).ino;
    // an ordinary save (the page sends no archive) and one with the same archive leave the file alone
    writer.save({ theme: 'light', columns: [] });
    writer.save({ theme: 'light', columns: [], archivedText: text });
    assert.equal(fs.statSync(p.archivePath).ino, ino, 'archived.json was not rewritten');
    assert.equal(p.config().theme, 'light');
    // a save that carries the whole config (saveConfigSync) splits it the same way
    writer.save({ theme: 'light', columns: [], archived: entries(5) });
    assert.deepEqual(p.archive(), entries(5));
    assert.equal(p.config().archived, undefined);
    // an archive that is not a list is ignored, never written over the good one
    writer.save({ theme: 'light', columns: [], archivedText: '{"not":"a list"}' });
    assert.deepEqual(p.archive(), entries(5));
    // archived.json cannot be written: the archive goes into config.json instead
    fs.rmSync(p.archivePath); fs.mkdirSync(p.archivePath);
    writer.save({ theme: 'light', columns: [], archivedText: JSON.stringify(entries(6)) });
    assert.deepEqual(p.config().archived, entries(6));
    assert.deepEqual(A.withArchive(p.config(), p.archivePath).archived, entries(6));
  } finally { p.done(); }
});

test('a writer started on an existing archive file knows it: the first save of the same list writes nothing', () => {
  const p = profile({ theme: 'dark', columns: [] });
  try {
    fs.writeFileSync(p.archivePath, JSON.stringify({ v: 1, archived: entries(2) }));
    const ino = fs.statSync(p.archivePath).ino;
    A.createArchiveWriter({ configPath: p.configPath, archivePath: p.archivePath }).save({ theme: 'dark', columns: [], archivedText: JSON.stringify(entries(2)) });
    assert.equal(fs.statSync(p.archivePath).ino, ino);
  } finally { p.done(); }
});

test('recovery reads the archive from archived.json: an archived conversation is not taken for a lost one', () => {
  const p = profile({ theme: 'dark', columns: [] });
  try {
    fs.writeFileSync(p.archivePath, JSON.stringify({ v: 1, archived: [{ id: 'c-kept', title: 'kept', archivedAt: 5 }] }));
    fs.mkdirSync(path.join(p.dir, 'chats'));
    const chat = (user) => JSON.stringify({ v: 1, turns: [{ id: 'u1', ts: 1000, user, reply: 'ok', done: true, atts: [] }] });
    fs.writeFileSync(path.join(p.dir, 'chats', 'c-kept.json'), chat('archived, still listed'));
    fs.writeFileSync(path.join(p.dir, 'chats', 'c-board-lost1.json'), chat('fell out of the archive'));
    const config = fs.readFileSync(p.configPath, 'utf8'), archive = fs.readFileSync(p.archivePath, 'utf8');
    const result = A.recover({ configPath: p.configPath, archivePath: p.archivePath, chatDir: path.join(p.dir, 'chats'), backups: [], now: () => 9000 });
    assert.equal(result.added, 1);
    assert.deepEqual(p.archive().map((a) => a.id), ['c-kept', 'c-board-lost1']);
    assert.equal(fs.readFileSync(p.configPath, 'utf8'), config, 'config.json is not touched');
    assert.equal(fs.readFileSync(path.join(p.dir, 'archived.json.before-archive-recovery-9000'), 'utf8'), archive, 'the archive as it was, kept aside');
  } finally { p.done(); }
});

test('the page sends the archive only when it changed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = src.indexOf('function saveConfig() {');
  const end = src.indexOf("window.addEventListener('pagehide', flushConfig);");
  assert.ok(start > 0 && end > start, 'saveConfig / flushConfig not found in renderer.js');
  const sent = [];
  const ctx = { config: { theme: 'dark', archived: entries(2), columns: [] }, columns: [], saveTimer: 0,
    setTimeout: () => 1, clearTimeout() {}, window: { deck: { saveConfig: (cfg) => sent.push(cfg) } } };
  vm.createContext(ctx);
  vm.runInContext('var saveTimer = 0;\n' + src.slice(start, end), ctx, { filename: 'renderer.js' });
  vm.runInContext('flushConfig(); flushConfig(); config.archived[0].folderId = "f1"; flushConfig(); config.theme = "light"; flushConfig();', ctx);
  assert.equal(sent.length, 4);
  assert.ok(sent.every((cfg) => !('archived' in cfg)), 'config.json saves carry no archive');
  assert.deepEqual(sent.map((cfg) => 'archivedText' in cfg), [true, false, true, false], 'the archive goes with the first save and when it changed (an entry edited in place counts)');
  assert.deepEqual(JSON.parse(sent[2].archivedText)[0].folderId, 'f1');
  assert.equal(sent[3].theme, 'light');
  assert.ok(Array.isArray(ctx.config.archived) && ctx.config.archived.length === 2, 'the page keeps its archive');
});
