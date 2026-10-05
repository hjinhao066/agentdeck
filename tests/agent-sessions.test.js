'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../agent-sessions');

const cursorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const codexId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const agyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('cursor, codex and agy ids bind only when one conversation matches the column cwd', (t) => {
  const root = temp(t);
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(root, 'chats', 'hash', cursorId), { recursive: true });
  fs.mkdirSync(path.join(root, 'chats', 'hash', otherId), { recursive: true });
  fs.writeFileSync(path.join(root, 'chats', 'hash', cursorId, 'meta.json'), JSON.stringify({ cwd: work, updatedAtMs: 5000 }));
  fs.writeFileSync(path.join(root, 'chats', 'hash', otherId, 'meta.json'), JSON.stringify({ cwd: other, updatedAtMs: 5000 }));
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', 'rollout.jsonl'), JSON.stringify({
    type: 'session_meta', payload: { session_id: codexId, cwd: work },
  }) + '\n{"type":"noise"}\n');
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'conversations', agyId + '.db'), Buffer.from('noise file://' + encodeURI(work) + ' tail'));
  const now = Date.now();
  for (const file of [
    path.join(root, 'chats', 'hash', cursorId, 'meta.json'),
    path.join(root, 'chats', 'hash', otherId, 'meta.json'),
    path.join(root, 'sessions', 'rollout.jsonl'),
    path.join(root, 'conversations', agyId + '.db'),
  ]) fs.utimesSync(file, now / 1000, now / 1000);

  const columns = [
    { id: 'cursor', provider: 'Cursor', cwd: work, since: 0, sessionId: '' },
    { id: 'codex', provider: 'Codex', cwd: work, since: 0, sessionId: '' },
    { id: 'agy', provider: 'Antigravity', cwd: work, since: 0, sessionId: '' },
    { id: 'elsewhere', provider: 'Cursor', cwd: path.join(root, 'missing'), since: 0, sessionId: '' },
  ];
  const found = S.resolveSessions(columns, {
    platform: 'darwin',
    lookbackMs: 24 * 3600 * 1000,
    roots: { cursor: path.join(root, 'chats'), codex: path.join(root, 'sessions'), agy: path.join(root, 'conversations') },
  });
  assert.equal(found.cursor, cursorId);
  assert.equal(found.codex, codexId);
  assert.equal(found.agy, agyId);
  assert.equal(found.elsewhere, null);
});

test('two conversations in one cwd are not guessed, and a stored id is kept', (t) => {
  const root = temp(t);
  const work = path.join(root, 'work');
  const records = [
    { provider: 'Codex', id: codexId, cwd: work, at: 10 },
    { provider: 'Codex', id: otherId, cwd: work, at: 20 },
    { provider: 'Cursor', id: cursorId, cwd: work, at: 10 },
  ];
  const ambiguous = S.assignSessions([
    { id: 'a', provider: 'Codex', cwd: work, since: 0, sessionId: '' },
    { id: 'b', provider: 'Cursor', cwd: work, since: 0, sessionId: cursorId },
  ], records, 'darwin');
  assert.equal(ambiguous.a, null);
  assert.equal(ambiguous.b, cursorId);
  assert.equal(S.resolveSessions([{ id: 'a', provider: 'Codex', cwd: work }], {}).a, undefined);
});
