'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TodoBackendErrors } = require('../todo-backend-errors');
const { TodoStore } = require('../todo-store');
const { TodoAI } = require('../todo-ai');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = [], receipts = [], file = path.join(dir, 'errors.json');
  const options = { file, log: (line) => log.push(line), deliver: (receipt) => receipts.push(receipt) };
  return { dir, log, receipts, file, options, errors: new TodoBackendErrors(options) };
}
test('backend failures log redacted diagnostics and retain one Captain receipt per failing episode', (t) => {
  const h = fixture(t);
  const fail = () => { throw Object.assign(new Error('secret CT /private/report auth-token'), { code: 'EACCES' }); };
  h.errors.run('scan', fail); h.errors.run('scan', fail);
  assert.equal(new Set(h.receipts.map((item) => item.id)).size, 1);
  assert.match(h.log[0], /scan.*EACCES/);
  assert.match(h.receipts[0].result, /Todo 后台异常.*scan.*EACCES/);
  assert.equal(h.receipts[0].action, 'main-todo-error');
  assert.doesNotMatch(JSON.stringify([h.log, h.receipts, fs.readFileSync(h.file, 'utf8')]), /secret|CT|\/private\/|auth-token/);
  const first = h.receipts[0].id;
  h.errors.acknowledge(first); h.errors.run('scan', fail);
  assert.equal(Object.keys(h.errors.state.pending).length, 0);
  h.errors.run('scan', () => true); h.errors.run('scan', fail);
  assert.notEqual(Object.keys(h.errors.state.pending)[0], first);
});
test('exception receipts survive restart without a Captain and clear only after durable acceptance', (t) => {
  const h = fixture(t);
  h.errors.deliver = () => {};
  h.errors.report('watch', new Error('private text'));
  const restored = new TodoBackendErrors(h.options);
  restored.flush(); restored.flush();
  assert.equal(h.receipts.length, 2); assert.equal(h.receipts[0].id, h.receipts[1].id);
  restored.acknowledge(h.receipts[0].id);
  new TodoBackendErrors(h.options).flush(); assert.equal(h.receipts.length, 2);
});
test('a corrupt Todo store and interrupted card write produce visible Captain exceptions, then recover', (t) => {
  const h = fixture(t);
  const todos = new TodoStore(path.join(h.dir, 'todos'), { deviceId: 'mac' });
  todos.add({ text: '@ai 资料' });
  let fail = true, delivered = 0;
  const ai = new TodoAI({ todos, tasks: { list: () => [], add() { if (fail) throw Object.assign(new Error('private task details'), { code: 'EIO' }); return { card: { id: 'card' } }; } },
    deliver: () => delivered++, notify: () => {} });
  h.errors.run('scan', () => ai.scan());
  assert.match(h.receipts[0].result, /EIO/); assert.equal(delivered, 0);
  fail = false; h.errors.run('scan', () => ai.scan()); assert.equal(delivered, 1);
  fs.writeFileSync(todos.ownFile(), '{broken-private-CT');
  h.errors.run('scan', () => ai.scan());
  assert.match(h.receipts.at(-1).result, /TODO_STORE_CORRUPT/);
  assert.equal(fs.readFileSync(todos.ownFile(), 'utf8'), '{broken-private-CT');
});
test('backend spool and receipt bridge errors are logged without leaking private exception messages', (t) => {
  const h = fixture(t); fs.mkdirSync(h.file);
  h.errors.deliver = () => { throw new Error('private-token'); };
  assert.doesNotThrow(() => h.errors.report('acknowledge', new Error('private materials')));
  assert.ok(h.log.some((line) => line.includes('queue write failed')));
  assert.ok(h.log.some((line) => line.includes('receipt delivery failed')));
  assert.doesNotMatch(h.log.join('\n'), /private/);
  assert.equal(Object.keys(h.errors.state.pending).length, 1);
});
test('malformed backend spool objects are reported without crashing startup', (t) => {
  const h = fixture(t);
  for (const state of [{ active: true, pending: {} }, { active: {}, pending: [] },
    { active: { scan: 'invalid' }, pending: {} }, { active: {}, pending: { bad: {} } }]) {
    fs.writeFileSync(h.file, JSON.stringify(state));
    let recovered;
    assert.doesNotThrow(() => { recovered = new TodoBackendErrors(h.options); });
    assert.equal(Object.keys(recovered.state.pending).length, 1);
    assert.match(h.receipts.at(-1).result, /error-queue-read/);
  }
});
