const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { validId, privateFile, trustedSender, boundedAppend } = require('../security');

test('terminal paths reject traversal, absolute paths, ADS and invalid identifiers', () => {
  for (const id of ['../config', '..\\config', '/tmp/a', 'C:\\temp', 'a:b', '', null, {}, '.hidden', 'ok\n', 'NUL', 'COM1.txt']) {
    assert.equal(validId(id), false);
    assert.throws(() => privateFile('/sessions', id));
  }
  assert.equal(validId('c123-abc.def_1'), true);
});
test('IPC rejects foreign windows, child frames and navigated pages', () => {
  const file = path.resolve('index.html');
  const frame = { url: pathToFileURL(file).href };
  const wc = { mainFrame: frame };
  const win = { isDestroyed: () => false, webContents: wc };
  assert.equal(trustedSender({ sender: wc, senderFrame: frame }, win, file), true);
  assert.equal(trustedSender({ sender: {}, senderFrame: frame }, win, file), false);
  assert.equal(trustedSender({ sender: wc, senderFrame: { ...frame } }, win, file), false);
  frame.url = 'https://example.com/index.html';
  assert.equal(trustedSender({ sender: wc, senderFrame: frame }, win, file), false);
});
test('a giant PTY chunk cannot bypass the replay memory limit', () => {
  const buffer = { chunks: [], totalSize: 0 };
  boundedAppend(buffer, 'x'.repeat(1000), 100);
  assert.equal(buffer.totalSize, 100);
  boundedAppend(buffer, 'last', 100);
  assert.ok(buffer.totalSize <= 100);
  assert.ok(buffer.chunks.join('').endsWith('last'));
});
