'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../main-core');

test('a written receipt is read back: summary, files, images, failure', () => {
  const reply = [
    '我改了登录接口。',
    '',
    '【回执】',
    '摘要：修好了 500，原因是空 token 没判空。',
    '已补测试。',
    '文件：/Users/me/app/src/login.js, /Users/me/My Docs/report.md',
    '- /tmp/shot.png',
  ].join('\n');
  const r = M.parseReceipt(reply);
  assert.equal(r.explicit, true);
  assert.equal(r.summary, '修好了 500，原因是空 token 没判空。 已补测试。');
  assert.deepEqual(r.files, ['/Users/me/app/src/login.js', '/Users/me/My Docs/report.md', '/tmp/shot.png']);
  assert.deepEqual(r.images, ['/tmp/shot.png']);
  assert.equal(r.failed, '');
  const failed = M.parseReceipt('【回执】\n摘要：没做完\n文件：无\n失败：仓库没有写权限');
  assert.equal(failed.failed, '仓库没有写权限');
  assert.deepEqual(failed.files, []);
});

test('no receipt: the last lines and any paths, marked as not explicit, always short', () => {
  const long = 'x'.repeat(5000);
  const r = M.parseReceipt('first part\n\n' + long + '\n\nsaved /tmp/a/b.md', (t) => (t.match(/\/\S+\/\S+/g) || []));
  assert.equal(r.explicit, false);
  assert.ok(r.summary.length <= M.MAX_SUMMARY);
  assert.deepEqual(r.files, ['/tmp/a/b.md']);
});

test('the model only gets short receipt lines and a compact ledger', () => {
  const text = M.receiptsForModel([
    { title: '写报告', colId: 'c1', summary: '写好了', files: ['/tmp/r.md'], failed: '' },
    { title: '跑测试', colId: 'c2', summary: '', files: [], failed: '缺依赖' },
  ]);
  assert.match(text, /「写报告」\(c1\)：写好了\n {2}文件：\/tmp\/r\.md/);
  assert.match(text, /「跑测试」\(c2\)：没做成，缺依赖/);
  assert.equal(M.receiptsForModel([]), '');
  const ledger = M.ledgerText([{ id: 'c1', title: '写报告', state: 'input', receipt: null }, { id: 'c2', title: 't', state: 'done', receipt: { summary: 's', files: [] } }]);
  assert.match(ledger, /c1 {2}「写报告」 {2}等你回复/);
  assert.match(ledger, /回执：s/);
  const read = M.readText('写报告', [{ user: 'u1', reply: 'r1' }, { kind: 'task', user: 'x', reply: 'y' }, { user: 'u2', reply: 'z'.repeat(2000) }], 5);
  assert.match(read, /用户：u1\n回复：r1/);
  assert.ok(!read.includes('用户：x'));
  assert.ok(read.length < 1600);
});

test('队长 instructions name the commands but never a model', () => {
  const text = M.instructions();
  for (const cmd of ['ledger', 'new --title', 'tell --to', 'read --id', 'receipts']) assert.ok(text.includes(cmd), cmd);
  assert.ok(!/opus|sonnet|haiku|gpt|gemini|grok-\d|model/i.test(text));
  assert.match(M.RECEIPT_CONTRACT, /【回执】/);
});

test('receipt fields glued onto one line by reflow are split again', () => {
  const r = M.parseReceipt('GOT it\n【回执】\n摘要：stand-in finished the report文件：/var/T/report.md');
  assert.equal(r.summary, 'stand-in finished the report');
  assert.deepEqual(r.files, ['/var/T/report.md']);
});

test('a worker question is read out and handed to 队长, not the user', () => {
  const r = M.parseReceipt('looked around\n【提问】\n问题：用 MySQL 还是 SQLite？');
  assert.equal(r.question, '用 MySQL 还是 SQLite？');
  const text = M.receiptsForModel([
    { title: '建库', colId: 'c3', question: r.question },
    { title: '部署', colId: 'c4', waiting: 'Deploy to prod? (y/n)' },
  ]);
  assert.match(text, /「建库」\(c3\) 向你提问：用 MySQL 还是 SQLite？/);
  assert.match(text, /「部署」\(c4\) 停在确认提示上：\n {4}Deploy to prod\? \(y\/n\)/);
  assert.match(M.RECEIPT_CONTRACT, /不要停下来等用户/);
  assert.match(M.instructions(), /answer --to/);
  // a later receipt wins over an earlier question
  assert.equal(M.parseReceipt('【提问】\n问题：x\n后来想通了\n【回执】\n摘要：done').question, '');
});

test('shells are recognized by name or full path; agents are not shells', () => {
  for (const n of ['zsh', '-zsh', '/bin/zsh', '/opt/homebrew/bin/fish', 'C:\\\\Windows\\\\System32\\\\cmd.exe', 'pwsh.exe', '']) assert.equal(M.isShellProcess(n), true, n);
  for (const n of ['node', 'claude', '/usr/local/bin/agy', 'grok', 'python3']) assert.equal(M.isShellProcess(n), false, n);
});
