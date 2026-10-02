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

test('队长 instructions name the commands', () => {
  const text = M.instructions();
  for (const cmd of ['ledger', 'new --title', 'tell --to', 'read --id', 'receipts']) assert.ok(text.includes(cmd), cmd);
  assert.match(M.RECEIPT_CONTRACT, /【回执】/);
});

test('a cleared 队长 is relaunched fresh: resume flags are dropped, everything else kept', () => {
  assert.equal(M.freshCommand('claude --continue --dangerously-skip-permissions --effort high'), 'claude --dangerously-skip-permissions --effort high');
  assert.equal(M.freshCommand('claude -c --effort high'), 'claude --effort high');
  assert.equal(M.freshCommand('claude --resume 1234-abcd --effort high'), 'claude --effort high');
  assert.equal(M.freshCommand('/usr/local/bin/claude -r abc'), '/usr/local/bin/claude');
  assert.equal(M.freshCommand('claude --resume=abc --effort high'), 'claude --effort high');
  assert.equal(M.freshCommand('cursor-agent --resume chat-1 --model claude-opus-5-5-high'), 'cursor-agent --model claude-opus-5-5-high');
  assert.equal(M.freshCommand('cursor-agent resume chat-1'), 'cursor-agent');
  // -c / -r mean something else to other tools
  assert.equal(M.freshCommand('agy -c conf.toml --model gemini-3.8-flash-high'), 'agy -c conf.toml --model gemini-3.8-flash-high');
  assert.equal(M.freshCommand('node "/x/fake agent.js"  --flag'), 'node "/x/fake agent.js"  --flag');
  assert.equal(M.freshCommand('node "resume --continue.js"'), 'node "resume --continue.js"');
  assert.equal(M.freshCommand('"C:\\Program Files\\Claude\\claude.exe" --resume "chat id" --model "model  with spaces"'), '"C:\\Program Files\\Claude\\claude.exe" --model "model  with spaces"');
  assert.equal(M.freshCommand(''), '');
});

test('the reset note gives ids and open work, never the old conversation', () => {
  const note = M.resetNote('c123', [{ title: '写周报', colId: 'c9', status: 'working' }, { title: 'x', colId: 'c8', status: 'input' }]);
  assert.match(note, /清空了你的模型上下文/);
  assert.match(note, /read --id c123/);
  assert.match(note, /「写周报」\(c9\)：干活中/);
  assert.match(note, /「x」\(c8\)：停在确认/);
  assert.ok(!M.resetNote('', []).includes('read --id'));
  const many = M.resetNote('c1', Array.from({ length: 60 }, (_, i) => ({ title: 't' + i, colId: 'c' + i, status: 'queued' })));
  assert.equal(many.split('\n').filter((l) => l.startsWith('   - ')).length, 20);
  // the default instructions stay whole; the note sits before the closing line
  const brief = M.instructions('darwin', note);
  assert.ok(brief.startsWith(M.instructions('darwin').split('\n').slice(0, -1).join('\n')));
  assert.ok(brief.indexOf('read --id c123') < brief.indexOf('队长已就绪'));
  assert.match(M.instructions(), /--find/);
});

test('old 队长 conversations: capped metadata, listed in the ledger, read and searched on demand', () => {
  const list = M.normalizeHistory([
    { id: 'c1', from: 1, to: 2, turns: 3, clearedAt: 4 }, { id: 'c1', turns: 9 }, { id: '../x', turns: 1 }, null, { id: 'c2', turns: 'x' },
  ]);
  assert.deepEqual(list, [{ id: 'c1', from: 1, to: 2, turns: 3, clearedAt: 4 }, { id: 'c2', from: 0, to: 0, turns: 0, clearedAt: 0 }]);
  assert.equal(M.normalizeHistory(Array.from({ length: 80 }, (_, i) => ({ id: 'h' + i }))).length, M.MAX_HISTORY);
  assert.equal(M.historyText([]), '');
  const text = M.historyText(Array.from({ length: 12 }, (_, i) => ({ id: 'h' + i, from: Date.now(), to: Date.now(), turns: i })));
  assert.match(text, /read --id/);
  assert.ok(text.indexOf('h11') < text.indexOf('h2 '), 'newest first');
  assert.ok(!text.includes('h1 '));
  assert.match(text, /更早的还有 2 段/);
  const turns = [
    { user: 'plan the alpha release', reply: 'ok' },
    { kind: 'task', user: '写周报', reply: 'stand-in finished', task: { colId: 'c9' } },
    { user: 'other', reply: 'beta notes' },
  ];
  assert.match(M.readText('t', turns, 10), /派活：「写周报」 \(c9\)\n回执：stand-in finished/);
  const found = M.readText('t', turns, 10, 'ALPHA release');
  assert.match(found, /用户：plan the alpha release/);
  assert.ok(!found.includes('beta'));
  assert.match(M.readText('t', turns, 10, 'nothing-like-this'), /没有包含/);
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


test('Windows agent detection discards stale chrome and recognizes wrapped shell prompts', () => {
  const chrome = 'Welcome to Claude Code\n> \nContext: 23%\nModel: Fake\nbypass permissions on';
  assert.equal(M.windowsAgentOutput(chrome + '\nPS C:\\work> '), '');
  assert.equal(M.isWindowsShellPrompt(chrome + '\nPS C:\\long-path\n\\work> '), true);
  assert.equal(M.isWindowsShellPrompt('PS C:\\work> node fake-agent.js\n' + chrome), false);
  assert.equal(M.windowsAgentOutput('AgentDeck shortcuts: Antigravity\nPS C:\\work> '), '');
  assert.equal(M.windowsAgentOutput('PS C:\\work> node fake-agent.js\n' + chrome), chrome);
});
