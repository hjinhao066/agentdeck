const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPreview, loadAllChats, saveChat, deleteChat, MAX_TEXT_BYTES } = require('../side-main');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-side-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('previews text, markdown, images, pdf, directories and binaries', () => {
  fs.writeFileSync(path.join(tmp, 'a.js'), 'const x = 1;\n');
  fs.writeFileSync(path.join(tmp, 'n.md'), '# hi');
  fs.writeFileSync(path.join(tmp, 'p.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(tmp, 'd.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(tmp, 'blob.dat'), Buffer.from([1, 2, 0, 3]));
  fs.mkdirSync(path.join(tmp, 'sub'));

  const js = readPreview(path.join(tmp, 'a.js'), '/x/a.js:12:3');
  assert.deepEqual([js.kind, js.lang, js.line, js.text], ['text', 'js', 12, 'const x = 1;\n']);
  assert.equal(readPreview(path.join(tmp, 'n.md'), 'n.md').kind, 'markdown');
  assert.ok(readPreview(path.join(tmp, 'p.png'), 'p.png').dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(readPreview(path.join(tmp, 'd.pdf'), 'd.pdf').kind, 'pdf');
  assert.equal(readPreview(path.join(tmp, 'blob.dat'), 'blob.dat').kind, 'binary');
  const dir = readPreview(tmp, tmp);
  assert.equal(dir.kind, 'dir');
  assert.equal(dir.entries[0].name, 'sub');
});

test('large text files are cut at the cap and flagged', () => {
  const file = path.join(tmp, 'big.txt');
  fs.writeFileSync(file, 'a'.repeat(MAX_TEXT_BYTES + 10));
  const r = readPreview(file, 'big.txt');
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, MAX_TEXT_BYTES);
});

test('conversations round trip, stay private, and bad ids never touch disk', () => {
  const dir = path.join(tmp, 'chats');
  assert.equal(saveChat(dir, 'c1', { turns: [{ id: 't1', ts: 1, user: 'hello', reply: 'hi', done: true }] }), true);
  const [chat] = loadAllChats(dir);
  assert.equal(chat.id, 'c1');
  assert.equal(chat.turns[0].reply, 'hi');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'c1.json')).mode & 0o077, 0);
  assert.throws(() => saveChat(dir, '../evil', { turns: [] }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
  assert.equal(loadAllChats(dir).length, 1);
  deleteChat(dir, 'c1');
  assert.equal(loadAllChats(dir).length, 0);
});
