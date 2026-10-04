'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../main-core');

test('context tokens come from an explicit used/total status, not percentages or session quotas', () => {
  for (const [footer, used] of [
    ['Context: 29% · 290k/1000k | Session: 8%', 290000],
    ['Context: 150.5K / 1M', 150500], ['Context: 290,123/1,000,000', 290123],
    ['Context: 0/1000k', 0], ['Context: 23% | Session: 290k/1000k', null],
    ['Context: 23% │ Session: 290k/1000k', null], ['Context: 23% Session: 290k/1000k', null],
    ['Context: 23%', null], ['Session: 290k/1000k', null], ['Context: 2M/1M', null],
  ]) assert.equal(M.contextTokens(footer), used, footer);
  assert.deepEqual(M.tokenSaverSettings(), { enabled: true, threshold: 150000 });
  assert.deepEqual(M.tokenSaverSettings({ enabled: false, threshold: 250000 }), { enabled: false, threshold: 250000 });
  for (const threshold of [0, -1, NaN, Infinity, '200000']) assert.equal(M.tokenSaverSettings({ threshold }).threshold, 150000);
});

test('model receipts and ledger cap each summary at 300 Unicode characters and five paths, preserving source receipts', () => {
  const receipt = { summary: '结果😀'.repeat(150), files: Array.from({ length: 8 }, (_, i) => `/tmp/report-${i}.md`) };
  const copy = structuredClone(receipt);
  for (const text of [M.receiptsForModel([{ ...receipt, colId: 'c1', title: '报告' }]),
    M.ledgerText([{ id: 'c1', title: '报告', state: 'done', receipt }])]) {
    assert.ok(text.includes(Array.from(receipt.summary).slice(0, 300).join('')));
    assert.ok(!text.includes(Array.from(receipt.summary).slice(0, 301).join('')));
    assert.match(text, /其余见 read/);
    assert.match(text, /report-4.md/);
    assert.ok(!text.includes('report-5.md'));
  }
  assert.deepEqual(receipt, copy);
  assert.ok(!M.receiptsForModel([{ summary: '字'.repeat(300), files: copy.files.slice(0, 5) }]).includes('其余见 read'));
  assert.match(M.instructions(), /不读大文件正文，只看报告的结论段；查进度优先 peek/);
});

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

test('receipt files exclude CLI footers while keeping POSIX, Windows and UNC paths', () => {
  const r = M.parseReceipt(['【回执】', '摘要：done', '文件：/tmp/My Report.md',
    '- `C:\\work\\report.md`', '\\\\server\\share\\shot.png', '~/notes/result.txt',
    'Update available! 2.1.0 → 2.2.0', 'Run npm install -g @anthropic-ai/claude-code',
    '✻ Baked for 24s', 'https://example.com/update', '没有文件'].join('\n'));
  assert.deepEqual(r.files, ['/tmp/My Report.md', 'C:\\work\\report.md', '\\\\server\\share\\shot.png', '~/notes/result.txt']);
  assert.deepEqual(r.images, ['\\\\server\\share\\shot.png']);
  assert.deepEqual(M.parseReceipt('【回执】\n摘要：done\n文件：无\nUpdate available!').files, []);
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
  for (const cmd of ['ledger', 'new --title', 'tell --to', 'tell --to 会话id --message "指令" [--replace] [--now]', 'stop --id', 'archive --id', 'peek --id', 'read --id', 'receipts']) assert.ok(text.includes(cmd), cmd);
  assert.match(M.RECEIPT_CONTRACT, /【回执】/);
});

test('Captain maintains one Bash background receipt listener, including timeout and reset', () => {
  for (const platform of ['darwin', 'win32']) {
    const text = M.instructions(platform);
    assert.ok(text.includes('node "$AGENTDECK_BOARD_CLI" receipts --wait --timeout 300'));
    assert.ok(!text.includes('node "$env:AGENTDECK_BOARD_CLI" receipts --wait'));
    assert.match(text, /run_in_background: true/);
    assert.match(text, /恰好一个后台监听/);
    assert.match(text, /处理完立即再/);
    assert.match(text, /超时空输出也立即重挂/);
    assert.match(text, /不附在用户消息里/);
  }
  const legacy = M.instructions('darwin', undefined, true);
  assert.match(legacy, /已显式开启旧回执注入回退/);
  assert.match(legacy, /不要再挂 receipts --wait 后台监听/);
  assert.ok(!legacy.includes('run_in_background: true'));
});

test('a cleared 队长 is relaunched fresh: resume flags are dropped, everything else kept', () => {
  assert.equal(M.freshCommand('claude --continue --dangerously-skip-permissions --effort high'), 'claude --dangerously-skip-permissions --effort high');
  assert.equal(M.freshCommand('claude -c --effort high'), 'claude --effort high');
  assert.equal(M.freshCommand('claude --resume 1234-abcd --effort high'), 'claude --effort high');
  assert.equal(M.freshCommand('/usr/local/bin/claude -r abc'), '/usr/local/bin/claude');
  assert.equal(M.freshCommand('claude --resume=abc --effort high'), 'claude --effort high');
  assert.equal(M.freshCommand('cursor-agent --resume chat-1 --model claude-opus-5-5-high'), 'cursor-agent --model claude-opus-5-5-high');
  assert.equal(M.freshCommand('cursor-agent resume chat-1'), 'cursor-agent');
  assert.equal(M.freshCommand('codex resume chat-1 --dangerously-bypass-approvals-and-sandbox'), 'codex --dangerously-bypass-approvals-and-sandbox');
  assert.equal(M.freshCommand('codex resume --last --dangerously-bypass-approvals-and-sandbox'), 'codex --dangerously-bypass-approvals-and-sandbox');
  assert.equal(M.freshCommand('codex resume'), 'codex');
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
  for (const n of ['node', 'claude', '/usr/local/bin/agy', 'grok', 'codex', 'gemini', 'python3']) assert.equal(M.isShellProcess(n), false, n);
});


test('Windows agent detection discards stale chrome and recognizes wrapped shell prompts', () => {
  const chrome = 'Welcome to Claude Code\n> \nContext: 23%\nModel: Fake\nbypass permissions on';
  assert.equal(M.windowsAgentOutput(chrome + '\nPS C:\\work> '), '');
  assert.equal(M.isWindowsShellPrompt(chrome + '\nPS C:\\long-path\n\\work> '), true);
  assert.equal(M.isWindowsShellPrompt('PS C:\\work> node fake-agent.js\n' + chrome), false);
  assert.equal(M.windowsAgentOutput('AgentDeck shortcuts: Antigravity\nPS C:\\work> '), '');
  assert.equal(M.windowsAgentOutput('PS C:\\work> node fake-agent.js\n' + chrome), chrome);
  const codexChrome = 'OpenAI Codex\n› Ask Codex to do anything\n  100% context left';
  assert.equal(M.windowsAgentOutput(codexChrome + '\nPS C:\\work> '), '');
  assert.equal(M.windowsAgentOutput('PS C:\\work> codex --dangerously-bypass-approvals-and-sandbox\n' + codexChrome), codexChrome);
});

test('队长\'s Antigravity commands carry the effort in the model id, never --effort', () => {
  const C = (cmd) => M.checkCommand(cmd).cmd;
  // what happened: --effort medium beside flash-high made agy run Claude Sonnet 4.6
  assert.equal(C('agy --dangerously-skip-permissions --model gemini-3.8-flash-high --effort medium'), 'agy --dangerously-skip-permissions --model gemini-3.8-flash-medium');
  assert.equal(C('agy --dangerously-skip-permissions --model gemini-3.8-flash-high --effort high'), 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high');
  assert.equal(C('agy --model=gemini-3.8-flash-high --effort=low'), 'agy --model=gemini-3.8-flash-low');
  // no xhigh/max in Antigravity; Pro has only high and low
  assert.equal(C('agy --effort xhigh --model gemini-3.8-flash-low'), 'agy --model gemini-3.8-flash-high');
  assert.equal(C('agy --model gemini-3.1-pro-high --effort medium'), 'agy --model gemini-3.1-pro-high');
  // no model: Flash, not whatever agy ran last
  assert.equal(C('agy --dangerously-skip-permissions'), 'agy --model gemini-3.8-flash-high --dangerously-skip-permissions');
  assert.equal(C('/opt/bin/agy --effort medium'), '/opt/bin/agy --model gemini-3.8-flash-medium');
  // already right, or not Antigravity: untouched
  for (const cmd of ['agy --dangerously-skip-permissions --model gemini-3.8-flash-medium', 'claude --dangerously-skip-permissions --effort high',
    'cursor-agent --force --model claude-sonnet-5-5-high', 'codex --dangerously-bypass-approvals-and-sandbox', '']) {
    assert.equal(C(cmd), cmd, cmd);
  }
});

test('队长\'s Codex commands always run without confirmation prompts, never with the flag twice', () => {
  const C = (cmd) => M.checkCommand(cmd).cmd;
  // GPT-6 Luna: `codex -m gpt-6-luna` would otherwise stop at the first approval
  assert.equal(C('codex -m gpt-6-luna'), 'codex --dangerously-bypass-approvals-and-sandbox -m gpt-6-luna');
  assert.equal(C('codex'), 'codex --dangerously-bypass-approvals-and-sandbox');
  assert.equal(C('/opt/bin/codex -m gpt-6-luna'), '/opt/bin/codex --dangerously-bypass-approvals-and-sandbox -m gpt-6-luna');
  // already has one of the two spellings (a duplicate fails to start)
  for (const cmd of ['codex --dangerously-bypass-approvals-and-sandbox', 'codex -m gpt-6-luna --yolo', 'codex --yolo']) assert.equal(C(cmd), cmd, cmd);
});

test('队长 cannot hand work to Claude 4.x or Haiku in any CLI', () => {
  for (const cmd of ['agy --dangerously-skip-permissions --model claude-sonnet-4-6', 'agy --model claude-opus-4-6-thinking',
    'claude --model haiku', 'claude --model=claude-haiku-4-5', 'claude --model claude-sonnet-4-5-20250929',
    'cursor-agent --force --model sonnet-4.6-thinking', 'claude --model "claude-3-5-sonnet"']) {
    const r = M.checkCommand(cmd);
    assert.ok(r.error && !r.cmd, cmd);
    assert.match(r.error, /gemini-3\.8-flash-high[\s\S]*claude-opus-5-5-high/, 'says what to use instead');
  }
  for (const cmd of ['claude --dangerously-skip-permissions --model claude-sonnet-5-5 --effort high', 'claude --model opus',
    'cursor-agent --force --model claude-opus-5-5-max', 'cursor-agent --force --model grok-4.7-high-fast']) {
    assert.equal(M.checkCommand(cmd).cmd, cmd, cmd);
  }
});

test('sessions 队长 opened before they were marked are found from its first card', () => {
  const columns = [{ id: 'c1790997115851448' }, { id: 'c1780813940263781' }, { id: 'c179099695406244', isMain: true }, { id: 'odd' }];
  const tasks = [
    { colId: 'c1790997115851448', sentAt: 1790997115860 },   // opened by `new`: card right at creation
    { colId: 'c1780813940263781', sentAt: 1790997200000 },   // an old session 队长 only told something
    { colId: 'c179099695406244', sentAt: 1790996954100 },    // 队长 itself never
    { colId: 'c1790990000000000', sentAt: 1790990000100 },   // closed since
    { colId: 'odd', sentAt: 1 }, null,
  ];
  assert.deepEqual([...M.openedByCaptain(columns, tasks)], ['c1790997115851448']);
  assert.deepEqual([...M.openedByCaptain(columns, undefined)], []);
});

test('background sessions with work still out hold a slot; finished ones free it', () => {
  const crew = new Set(['a', 'b', 'c', 'd']);
  const tasks = [
    { colId: 'a', status: 'done' }, { colId: 'a', status: 'working' },   // latest card counts
    { colId: 'b', status: 'working' }, { colId: 'b', status: 'done' },
    { colId: 'c', status: 'asking' },                                      // waits on 队长: still busy
    { colId: 'd', status: 'input' },
    { colId: 'x', status: 'working' },                                     // not 队长's background session
    { colId: '', status: 'waiting' },                                      // queued, no column yet
  ];
  assert.deepEqual([...M.activeCrew(tasks, crew)].sort(), ['a', 'c', 'd']);
  assert.equal(M.MAX_ACTIVE, 30);
});

test('a finished background session is archived only after 10 quiet minutes with its receipt read', () => {
  const now = 10_000_000;
  const min = 60_000;
  const s = { tasks: [{ colId: 'a', status: 'done', sentAt: now - 30 * min, doneAt: now - 11 * min }], pending: [], inflight: [] };
  assert.equal(M.ARCHIVE_AFTER, 10 * min);
  assert.equal(M.archivable(s, 'a', now - 20 * min, now), true);
  assert.equal(M.archivable(s, 'a', now - 9 * min, now), false, 'something happened in it since');
  assert.equal(M.archivable({ ...s, pending: [{ colId: 'a' }] }, 'a', 0, now), false, '队长 has not seen the receipt');
  assert.equal(M.archivable({ ...s, inflight: [{ colId: 'a' }] }, 'a', 0, now), false);
  for (const status of ['queued', 'working', 'input', 'asking']) {
    assert.equal(M.archivable({ ...s, tasks: [...s.tasks, { colId: 'a', status, sentAt: 0 }] }, 'a', 0, now), false, status);
  }
  assert.equal(M.archivable(s, 'nobody', 0, now), false, 'never one 队长 gave no work');
  assert.equal(M.archivable(s, 'a', 0, now - 9 * min + 11 * min, 0), true, 'the wait can be shortened');
});

test('队长 is told about background work, the limit and automatic archiving', () => {
  const text = M.instructions();
  assert.match(text, /后台跑[^\n]*最多 30 个会话在干活[^\n]*自动排队/);
  assert.match(text, /10 分钟后会自动归档[^\n]*tell 发给它会自动恢复/);
});

test('the 后台 list puts work in progress on top, then finished ones, newest first', () => {
  const tasks = [
    { colId: 'old', status: 'done', sentAt: 1, doneAt: 10 },
    { colId: 'ask', status: 'asking', sentAt: 5, doneAt: 6 },          // waits on 队长: in progress
    { colId: 'new', status: 'done', sentAt: 2, doneAt: 50 },
    { colId: 'run', status: 'working', sentAt: 3 },
    { colId: 'run2', status: 'done', sentAt: 1, doneAt: 4 },          // its card is done but the terminal works again
  ];
  const items = [
    { id: 'old', state: 'done', lastActive: 10 }, { id: 'new', state: 'done', lastActive: 0 },
    { id: 'run', state: 'working' }, { id: 'ask', state: 'done' }, { id: 'run2', state: 'working' },
    { id: 'none', state: 'plain', lastActive: 20 },                     // never given work: finished at its last turn
  ];
  assert.deepEqual(M.crewOrder(items, tasks), { running: ['run2', 'run', 'ask'], finished: ['new', 'none', 'old'] });
});

test('receipts wait while the user has text in the input box, and ignore key-free quiet only after 5s', () => {
  const now = 100_000;
  assert.equal(M.draftBlocks(null, now, 5000), false);
  assert.equal(M.draftBlocks({ draft: '', unknown: false, lastKeyAt: 0 }, now, 5000), false);
  assert.equal(M.draftBlocks({ draft: '我写到一半', unknown: false, lastKeyAt: 0 }, now, 5000), true, 'unsent text, however old');
  assert.equal(M.draftBlocks({ draft: '', unknown: true, lastKeyAt: 0 }, now, 5000), true, 'history recall: cannot tell');
  assert.equal(M.draftBlocks({ draft: '', unknown: false, lastKeyAt: now - 1000 }, now, 5000), true, 'still typing');
  assert.equal(M.draftBlocks({ draft: '', unknown: false, lastKeyAt: now - 6000 }, now, 5000), false);
});

test('the agent\'s input box on screen: typed text counts, placeholder and caret do not', () => {
  const rule = '─'.repeat(40);
  const rows = (prompt) => ['⏺ done', '', rule, prompt, rule, 'Context: 20%'];
  const read = (plainPrompt, maskedPrompt) => M.inputBoxText(rows(plainPrompt), rows(maskedPrompt));
  assert.equal(read('> ', '> '), '');
  assert.equal(read('> half a sentence', '> half a sentence'), 'half a sentence');
  // dim placeholder text arrives masked (\u0000), as does the inverse caret
  assert.equal(read('> Try "fix the bug"', '> \u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000'), '');
  assert.equal(read('❯ 你好 ', '❯ 你好\u0000'), '你好');
  assert.equal(read('│ > boxed text │', '│ > boxed text │'), 'boxed text');
  // an earlier "> message" in the transcript is not the box
  assert.equal(M.inputBoxText(['> old message', '', rule, '> ', rule], ['> old message', '', rule, '> ', rule]), '');
  // no recognisable box: no opinion
  assert.equal(M.inputBoxText(['$ ls', 'file'], ['$ ls', 'file']), null);
  assert.equal(M.inputBoxText([rule, 'text', rule], [rule, 'text', rule]), null);
});

test('a receipt only counts below the task contract echoed on screen', () => {
  const echo = `${M.RECEIPT_CONTRACT}\n`;
  assert.equal(M.parseReceipt(M.afterContract(`> do it\n${echo}`)).explicit, false, 'the echo\'s own field names are not a receipt');
  const wrapped = echo.replace('回执里不要贴文件正文。', '回执里不要贴\n文件正文。');
  assert.equal(M.parseReceipt(M.afterContract(`${wrapped}⏺ working`)).explicit, false);
  const done = `${echo}⏺ ok\n【回执】\n摘要：做完了\n文件：无\n`;
  const r = M.parseReceipt(M.afterContract(done));
  assert.equal(r.explicit, true);
  assert.equal(r.summary, '做完了');
  assert.equal(M.afterContract('no contract here'), 'no contract here');
});

test('work added to a busy session is 待补充; only a full house is 排队', () => {
  const text = M.resetNote('', [{ title: 'a', colId: 'c1', status: 'queued' }, { title: 'b', colId: 'c2', status: 'waiting' }]);
  assert.match(text, /「a」\(c1\)：待补充/);
  assert.match(text, /「b」\(c2\)：排队等空位/);
});

test('only a real final receipt/question counts, never a contract or code example', () => {
  for (const text of [M.RECEIPT_CONTRACT, '【提问】\n问题：一两句话说清要队长决定什么',
    '【提问】\n问题：一两句话…', '【提问】\n问题：一 两 句 话说清要队长决定什么\n还在工作',
    '【回执】\n摘要：一到三句话说清结果\n文件：每行一个落盘文件的完整路径',
    '格式使用【提问】\n问题：用哪个库？', '```text\n【提问】\n问题：用哪个库？\n```\n我继续实现。',
    '【提问】\n问题：用哪个库？\n接下来继续实现。', '【回执】\n摘要：样例\n文件：无\n接下来继续实现。',
    '（AgentDeck 约定）\n【提问】\n问题：用哪个库？']) {
    const r = M.parseReceipt(text);
    assert.equal(r.explicit, false, text);
    assert.equal(r.question, '', text);
    assert.equal(r.failed, '', text);
  }
  const r = M.parseReceipt(`${M.RECEIPT_CONTRACT}\n⏺ 最终结果\n【提问】\n问题：保留哪个分支？`);
  assert.equal(r.explicit, true);
  assert.equal(r.question, '保留哪个分支？');
  const final = M.parseReceipt('【回执】\n摘要：上次完成\n【提问】\n问题：还需发布吗？');
  assert.equal(final.question, '还需发布吗？');
  assert.equal(final.summary, '');
});

test('quota wait and Claude queued-message chrome are not completion', () => {
  for (const screen of ["You've hit your limit · resets 5pm\nEsc to interrupt\nClaude Code", 'Usage limit reached\nChoose /rate-limit-options', 'You’re out of extra usage']) {
    assert.equal(M.terminalActivity(screen), 'quota', screen);
  }
  for (const screen of ['✻ Doing…\nClaude Code', 'Doing...\nClaude Code', 'Press up to edit queued messages\nClaude Code']) assert.equal(M.terminalActivity(screen), 'working');
  assert.equal(M.terminalActivity('我已经处理了 usage limit reached 的错误。\nClaude Code'), '');
  assert.equal(M.terminalActivity('Usage limit reached · limit resets 5pm\nContinuing at 5pm · esc to cancel\nPress up to edit queued messages'), 'quota');
  assert.equal(M.terminalActivity('Usage limit reached\nUsage limit reset · continuing automatically\n✻ Doing…'), 'working');
  assert.equal(M.terminalActivity('Usage limit reached\nAutomatic continue cancelled\nClaude Code'), '');
  assert.equal(M.statusLabel('quota'), '额度用尽/等待');
  const tasks = [{ colId: 'a', status: 'quota' }];
  assert.equal(M.activeCrew(tasks, new Set(['a'])).size, 1);
  assert.equal(M.archivable({ tasks }, 'a', 0, Date.now()), false);
});


test('Captain briefing stays static and includes explicit models, boards and two-round acceptance', () => {
  assert.equal(M.instructions('darwin', 'time and board A'), M.instructions('darwin', 'time and board B'));
  const text = M.instructions('darwin');
  assert.match(text, /--model claude-opus-5-5 --effort high/);
  assert.ok(!text.includes('默认模型是 Opus'));
  assert.match(text, /开工后用 peek 看状态行确认模型/);
  assert.match(text, /用户交代的任务默认先记进/);
  assert.match(text, /鸡毛蒜皮/);
  assert.match(text, /截图真的落盘/);
  assert.match(text, /最多返工 2 轮/);
});

test('Captain explains one-level projects, declared review targets and provider sub-agent defaults', () => {
  const text = M.instructions();
  assert.match(text, /同一个 --project/);
  assert.match(text, /--reviews 会话id\[,会话id\]/);
  assert.match(text, /不层层外包/);
  assert.match(text, /Claude 会话默认不要自己开 Claude 子 agent/);
  assert.match(text, /Codex\/Gemini 会话可以开子 agent/);
  const ledger = M.ledgerText([{ id: 'r', title: 'Review', state: 'done', project: '网站', reviews: ['a', 'b'] }]);
  assert.match(ledger, /项目:网站/);
  assert.match(ledger, /审查:a,b/);
});


test('manual reset commands require a single exact provider command', () => {
  for (const provider of ['Claude', 'Codex']) {
    for (const command of ['/clear', '/new', ' /new named session  ']) assert.equal(M.contextResetCommand(provider, command), true);
    for (const command of ['clear', 'please /clear', '/clear-all', '/clear\n', '/new name\nmore', '\x1b[2J', '"/clear"']) {
      assert.equal(M.contextResetCommand(provider, command), false, command);
    }
  }
  assert.equal(M.contextResetCommand('Claude', '/reset'), true);
  for (const provider of ['Codex', 'Cursor', 'Antigravity', 'shell', '']) assert.equal(M.contextResetCommand(provider, '/reset'), false);
});

test('manual reset requires fresh success evidence, including low-context clear without a numeric decrease', () => {
  for (const output of ['⏺ Conversation cleared\n', 'Cleared context.\n', '\x1b[32m⏺ (no content)\x1b[0m\r\n']) {
    assert.equal(M.contextResetEvidence('Claude', 'Context: 23%', 'Context: 23%', output), true);
  }
  assert.equal(M.contextResetEvidence('Claude', 'Context: 290k/1000k', 'Context: 23k/1000k', ''), true);
  assert.equal(M.contextResetEvidence('Codex', '98% context left', '100% context left', 'OpenAI Codex (v0.160.0)'), true);
  for (const output of ['Welcome to Claude Code', 'Claude Code v2.1.0', 'OpenAI Codex (v0.160.0)', 'Do you trust the contents of this directory? (y/n)', 'User: Conversation cleared', '> /new Conversation cleared']) {
    assert.equal(M.contextResetEvidence('Claude', 'Context: 23%', 'Context: 23%', output), false, output);
    assert.equal(M.contextResetEvidence('Codex', '98% context left', '98% context left', output), false, output);
  }
  for (const output of ['Unknown slash command', 'Failed to start new session', 'Cancelled', 'Canceled', 'clear not available']) {
    assert.equal(M.contextResetEvidence('Codex', 'Context: 290k/1000k', 'Context: 23k/1000k', output), false, output);
  }
  assert.equal(M.contextResetEvidence('Codex', '98% context left', '101% context left', ''), false);
  assert.equal(M.contextResetEvidence('Claude', 'Context: 290k/1000k', 'Context: 145k/1000k', ''), false);
});


test('Codex reset evidence reads its native footer below the prompt, never a quoted status', () => {
  assert.equal(M.codexContextFooter('• example 100% context left\n› Ask Codex to do anything\n\n  ⏎ send   98% context left'), '\n  ⏎ send   98% context left');
  assert.equal(M.codexContextFooter('• 100% context left'), '');
  assert.equal(M.codexContextFooter('› old prompt\n100% context left\n› current prompt\n98% context left'), '98% context left');
});
