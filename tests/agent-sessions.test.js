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

test('only a launch-owned Cursor or Codex id with matching file cwd is retained', (t) => {
  const root = temp(t);
  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(root, 'chats', 'hash', cursorId), { recursive: true });
  fs.writeFileSync(path.join(root, 'chats', 'hash', cursorId, 'meta.json'), JSON.stringify({ cwd: work, updatedAtMs: 5000 }));
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', 'rollout.jsonl'), JSON.stringify({
    type: 'session_meta', payload: { session_id: codexId, cwd: work },
  }) + '\n{"type":"noise"}\n');
  const found = S.resolveSessions([
    { id: 'cursor', provider: 'Cursor', cwd: work, sessionId: cursorId, owner: 'cursor' },
    { id: 'codex', provider: 'Codex', cwd: work, sessionId: codexId, owner: 'codex' },
  ], { platform: 'darwin', roots: { cursor: path.join(root, 'chats'), codex: path.join(root, 'sessions') } });
  assert.deepEqual(found, { cursor: cursorId, codex: codexId });
});

test('Codex reads a complete large session_meta line and ignores non-metadata records', (t) => {
  const root = temp(t);
  const cwd = path.join(root, 'work');
  fs.writeFileSync(path.join(root, 'large.jsonl'), JSON.stringify({ type: 'session_meta', payload: {
    id: codexId, cwd, base_instructions: { text: '长指令'.repeat(10000) },
  } }) + '\n{"payload":{"id":"ignored"}}\n');
  fs.writeFileSync(path.join(root, 'not-meta.jsonl'), JSON.stringify({ type: 'message', payload: { id: otherId, cwd } }));
  assert.deepEqual(S.listCodex(root), [{ provider: 'Codex', id: codexId, cwd, at: fs.statSync(path.join(root, 'large.jsonl')).mtimeMs }]);
});

test('a unique cwd candidate cannot prove ownership, including two same-cwd columns', () => {
  const records = [{ provider: 'Codex', id: codexId, cwd: '/work', at: 10 }];
  assert.deepEqual(S.assignSessions([
    { id: 'a', provider: 'Codex', cwd: '/work' },
    { id: 'b', provider: 'Codex', cwd: '/work' },
  ], records, 'linux'), { a: null, b: null });
  assert.deepEqual(S.assignSessions([{ id: 'a', provider: 'Codex', cwd: '/work' }], records, 'linux'), { a: null });
});

test('stored ids require the right owner, provider, cwd and an existing file', () => {
  const record = { provider: 'Codex', id: codexId, cwd: '/work', at: 10 };
  const col = { id: 'a', provider: 'Codex', cwd: '/work', sessionId: codexId, owner: 'a' };
  assert.deepEqual(S.assignSessions([col], [record], 'linux'), { a: codexId });
  for (const change of [{ owner: '' }, { owner: 'b' }, { cwd: '/elsewhere' }, { provider: 'Cursor' }, { sessionId: otherId }]) {
    assert.deepEqual(S.assignSessions([{ ...col, ...change }], [record], 'linux'), { a: null });
  }
  assert.deepEqual(S.assignSessions([col], [], 'linux'), { a: null });
  assert.deepEqual(S.resolveSessions([col], {}), {});
});

test('duplicated session ids reject every claimant regardless of column order or cwd', () => {
  const cols = [
    { id: 'a', owner: 'a', provider: 'Codex', sessionId: codexId, cwd: '/work' },
    { id: 'b', owner: 'b', provider: 'Codex', sessionId: codexId, cwd: '/other' },
  ];
  const records = [{ provider: 'Codex', id: codexId, cwd: '/work', at: 10 }];
  assert.deepEqual(S.assignSessions(cols, records, 'linux'), { a: null, b: null });
  assert.deepEqual(S.assignSessions(cols.slice().reverse(), records, 'linux'), { b: null, a: null });
});

test('a database containing a matching file URL never proves agy ownership', (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, agyId + '.db'), Buffer.from('SQLite format 3\0 file:///work'));
  assert.deepEqual(S.listAgy(root), []);
  assert.deepEqual(S.resolveSessions([
    { id: 'a', owner: 'a', provider: 'Antigravity', cwd: '/work', sessionId: agyId },
  ], { roots: { agy: root } }), { a: null });
});


test('authenticated agent-env proof survives without legacy files but requires owner and captured cwd', () => {
  for (const provider of ['Codex', 'Cursor', 'Antigravity']) {
    const col = { id: 'worker', provider, cwd: '/work', capturedCwd: '/work', sessionId: codexId, owner: 'worker', source: 'agent-env' };
    assert.deepEqual(S.assignSessions([col], [], 'linux'), { worker: codexId });
    for (const change of [{ owner: 'other' }, { capturedCwd: '/other' }, { capturedCwd: undefined }, { source: 'unknown' }]) {
      assert.deepEqual(S.assignSessions([{ ...col, ...change }], [], 'linux'), { worker: null });
    }
    assert.deepEqual(S.assignSessions([{ ...col, cwd: '', capturedCwd: '' }], [], 'linux'), { worker: codexId });
  }
});

test('a fresh PTY removes outer CLI identities without mutating the app environment', () => {
  const env = { CODEX_THREAD_ID: codexId, CURSOR_CONVERSATION_ID: cursorId, ANTIGRAVITY_CONVERSATION_ID: agyId, PATH: '/bin', AGENTDECK_COL_ID: 'outer' };
  assert.deepEqual(S.clearInheritedSessionIds(env), { PATH: '/bin', AGENTDECK_COL_ID: 'outer' });
  assert.equal(env.CODEX_THREAD_ID, codexId);
});
