const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPreview, statPaths, loadAllChats, saveChat, deleteChat, MAX_TEXT_BYTES } = require('../side-main');

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

// Windows PowerShell 5.1 writes UTF-16 with a byte order mark (`>`, Out-File) and
// Notepad may add a UTF-8 one: the text is shown, not called binary.
test('text with a byte order mark is shown as text: UTF-16 from Windows PowerShell, UTF-8 from Notepad', () => {
  const text = '# 验收报告\r\n第一行 ok\r\n';
  fs.writeFileSync(path.join(tmp, 'ps-le.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  const be = Buffer.from(text, 'utf16le');
  for (let i = 0; i < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1], be[i]];
  fs.writeFileSync(path.join(tmp, 'be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  fs.writeFileSync(path.join(tmp, 'notepad.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
  for (const [name, kind] of [['ps-le.md', 'markdown'], ['be.txt', 'text'], ['notepad.md', 'markdown']]) {
    const r = readPreview(path.join(tmp, name), name);
    assert.deepEqual([r.kind, r.text], [kind, text], name);
  }
  // a NUL without a byte order mark is still a binary file
  assert.equal(readPreview(path.join(tmp, 'blob.dat'), 'blob.dat').kind, 'binary');
});

test('large text files are cut at the cap and flagged', () => {
  const file = path.join(tmp, 'big.txt');
  fs.writeFileSync(file, 'a'.repeat(MAX_TEXT_BYTES + 10));
  const r = readPreview(file, 'big.txt');
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, MAX_TEXT_BYTES);
});

test('delivered paths are reported as gone, file or folder, and nothing else', async () => {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'out', 'shots'), { recursive: true });
  fs.writeFileSync(path.join(home, 'out', 'report.md'), '# r');
  const file = path.join(home, 'out', 'report.md');
  assert.deepEqual(await statPaths([
    file, file + ':12', 'file://' + file, '~/out/report.md', '~/out/shots', path.join(home, 'out', 'shots') + path.sep,
    path.join(home, 'out', 'deleted.md'), 'out/report.md', '', 42, null, 'x'.repeat(2001),
    process.platform === 'win32' ? '/Users/someone/a.md' : 'C:\\Users\\someone\\a.md',
  ], home), [1, 1, 1, 1, 2, 2, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(await statPaths('not a list', home), []);
  assert.equal((await statPaths(Array.from({ length: 2500 }, () => file), home)).length, 2000);
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

test('a long conversation is saved and loaded whole, unfinished turn marker included', () => {
  const dir = path.join(tmp, 'long-chats');
  const turns = Array.from({ length: 1200 }, (_, i) => ({ id: 't' + i, ts: i, user: 'q' + i, reply: 'a' + i, done: true }));
  turns.push({ id: 'open', ts: 1200, user: 'still running', reply: 'half a reply', done: false, interrupted: true });
  assert.equal(saveChat(dir, 'long', { turns }), true);
  const [chat] = loadAllChats(dir);
  assert.equal(chat.turns.length, 1201);
  assert.equal(chat.turns[0].user, 'q0');
  assert.deepEqual([chat.turns[1200].reply, chat.turns[1200].done, chat.turns[1200].interrupted], ['half a reply', false, true]);
});
