'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJsonFileCache } = require('../config-cache');

const PINNED = 1700000000; // whole seconds, so both files carry the identical mtime
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-config-cache-'));
  return { dir, file: path.join(dir, 'config.json'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
// Counts real parses without touching the module under test.
const countParses = (fn) => { const real = JSON.parse; let n = 0; JSON.parse = (...a) => { n++; return real(...a); }; try { fn(); } finally { JSON.parse = real; } return n; };

test('an unchanged file is parsed once, however often it is read', () => {
  const t = fresh();
  try {
    fs.writeFileSync(t.file, JSON.stringify({ a: 1 }));
    const read = createJsonFileCache(t.file);
    assert.equal(countParses(() => { for (let i = 0; i < 50; i++) assert.deepEqual(read(), { a: 1 }); }), 1);
  } finally { t.done(); }
});

test('an in-place rewrite with the same size and the same mtime is still noticed', () => {
  const t = fresh();
  try {
    fs.writeFileSync(t.file, '{"seat":"aaa"}');
    fs.utimesSync(t.file, PINNED, PINNED);
    const read = createJsonFileCache(t.file);
    assert.equal(read().seat, 'aaa');
    fs.writeFileSync(t.file, '{"seat":"bbb"}');
    fs.utimesSync(t.file, PINNED, PINNED); // coarse-mtime filesystem / same clock tick
    assert.equal(read().seat, 'bbb');
  } finally { t.done(); }
});

// Windows CI: NTFS timestamps step about every 16 ms, so the real ctime (and ino, size) can stay
// the same across an in-place rewrite. Here every field of the key is pinned on any system.
const coarseStat = (t, ctimeMs) => {
  const real = fs.statSync;
  t.mock.method(fs, 'statSync', function (file, opts) {
    const s = real.call(this, file, opts);
    return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: 7n, size: 14n, mtimeNs: 1n, ctimeNs: 2n, ctimeMs: ctimeMs() });
  });
};

test('a rewrite inside one timestamp step (every key field the same) is still noticed', (t) => {
  const f = fresh();
  try {
    let ctime = Date.now();
    coarseStat(t, () => ctime);
    fs.writeFileSync(f.file, '{"seat":"aaa"}');
    const read = createJsonFileCache(f.file);
    assert.equal(read().seat, 'aaa');
    fs.writeFileSync(f.file, '{"seat":"bbb"}');
    assert.equal(read().seat, 'bbb');
    // the same step again, then the file settles: the change made while it was young is not lost
    fs.writeFileSync(f.file, '{"seat":"ccc"}');
    ctime = Date.now() - 60_000;
    assert.equal(read().seat, 'ccc');
    // settled and unchanged: parsed no more
    assert.equal(countParses(() => { for (let i = 0; i < 20; i++) assert.equal(read().seat, 'ccc'); }), 0);
  } finally { t.mock.restoreAll(); f.done(); }
});

test('an atomic replace (tmp file + rename, as main.js saves) with the same size and mtime is noticed', () => {
  const t = fresh();
  try {
    fs.writeFileSync(t.file, '{"seat":"aaa"}');
    fs.utimesSync(t.file, PINNED, PINNED);
    const read = createJsonFileCache(t.file);
    assert.equal(read().seat, 'aaa');
    fs.writeFileSync(t.file + '.tmp', '{"seat":"bbb"}');
    fs.utimesSync(t.file + '.tmp', PINNED, PINNED);
    fs.renameSync(t.file + '.tmp', t.file);
    assert.equal(read().seat, 'bbb');
  } finally { t.done(); }
});

test('an ordinary external rewrite is noticed at the next read', () => {
  const t = fresh();
  try {
    fs.writeFileSync(t.file, JSON.stringify({ seats: ['a'] }));
    const read = createJsonFileCache(t.file);
    assert.deepEqual(read().seats, ['a']);
    fs.writeFileSync(t.file, JSON.stringify({ seats: ['a', 'b', 'c'] }));
    assert.deepEqual(read().seats, ['a', 'b', 'c']);
  } finally { t.done(); }
});

test('a deleted file reads as empty, and the old content does not come back', () => {
  const t = fresh();
  try {
    fs.writeFileSync(t.file, '{"a":1}');
    const read = createJsonFileCache(t.file);
    assert.deepEqual(read(), { a: 1 });
    fs.rmSync(t.file);
    assert.deepEqual(read(), {});
    fs.writeFileSync(t.file, '{"a":1}');
    assert.deepEqual(read(), { a: 1 });
  } finally { t.done(); }
});

test('a half-written (invalid) file reads as empty like before the cache, then recovers when fixed', () => {
  const t = fresh();
  try {
    fs.writeFileSync(t.file, '{"a":1}');
    const read = createJsonFileCache(t.file);
    assert.deepEqual(read(), { a: 1 });
    fs.writeFileSync(t.file, '{"a":');
    assert.deepEqual(read(), {});
    fs.writeFileSync(t.file, '{"a":2}');
    assert.deepEqual(read(), { a: 2 });
  } finally { t.done(); }
});

test('main.js reads the seat config through the shared cache, not a private copy of the logic', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/config-cache'\)/);
  assert.match(main, /const seatConfig = createJsonFileCache\(configPath\)/);
  assert.doesNotMatch(main, /cachedConfigMtime/);
  assert.ok(require('../package.json').build.files.includes('config-cache.js'), 'packaged app must ship the module main requires');
});
