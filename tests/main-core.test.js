'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../main-core');

test('replayed TUI chrome is excluded until fresh output follows the current replay separator', () => {
  for (const separator of [
    '── 上次输出回放，进程已结束──',
    '── 上次输出回放，进程已结束（模型上下文将通过 CLI 恢复）──',
    '── 上次输出回放；此栏未绑定模型会话，本次将新开对话 ──',
    '以上为上次会话的输出',
  ]) {
    const replay = 'Claude Code\n✻ Doing…\nProceed? (y/n)\n' + separator;
    assert.equal(M.afterReplay(replay, 'win32'), '');
    assert.equal(M.afterReplay(replay + '\nPS C:\\test>', 'win32'), 'PS C:\\test>');
    assert.equal(M.afterReplay(replay + '\nClaude Code\n❯', 'win32'), 'Claude Code\n❯');
    assert.equal(M.terminalActivity(M.afterReplay(replay, 'win32')), '');
  }
  assert.equal(M.afterReplay('Claude Code\n✻ Doing…', 'win32'), 'Claude Code\n✻ Doing…');
  const current = 'Claude Code\n── 上次输出回放，进程已结束──\nPS C:\\test>';
  assert.equal(M.afterReplay(current, 'darwin'), current);
  assert.equal(M.afterReplay('old\n以上为上次会话的输出\nlive', 'darwin'), 'live');
});

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
    assert.ok(text.includes('node "$AGENTDECK_BOARD_CLI" receipts --wait（不设超时'));
    assert.ok(!text.includes('--timeout 300'));
    assert.ok(!text.includes('node "$env:AGENTDECK_BOARD_CLI" receipts --wait'));
    assert.match(text, /run_in_background: true/);
    assert.match(text, /恰好一个后台监听/);
    assert.match(text, /处理完立即再/);
    assert.match(text, /空输出退出，先检查已有监听，没有才安静立即重挂，不用向用户汇报/);
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
  assert.equal(M.freshCommand('agy --conversation abc --model gemini-3.8-flash-high'), 'agy --model gemini-3.8-flash-high');
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
  assert.equal(M.windowsCodexReady('PS C:\\long-path\n\\codex-launch\\codex.cmd --no-daemon'), false);
  assert.equal(M.windowsCodexReady('PS C:\\work> codex\n' + codexChrome), true);
  assert.equal(M.windowsCodexReady('PS C:\\work> codex\nWelcome to Codex CLI (test stand-in)'), true);
  assert.equal(M.windowsCodexReady(codexChrome + '\nPS C:\\work> '), false);
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
    'cursor-agent --force --model claude-sonnet-5-5-high', 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox', '']) {
    assert.equal(C(cmd), cmd, cmd);
  }
});

test('captain command checks leave Codex capabilities to the local launch probe', () => {
  for (const cmd of ['codex', 'codex -m gpt-6-luna', '/opt/bin/codex -m gpt-6-luna',
    'codex --yolo', 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox']) {
    assert.equal(M.checkCommand(cmd).cmd, cmd);
  }
});

test('agy can use its tested legacy models while every other CLI still rejects old Claude models', () => {
  for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']) {
    assert.equal(M.checkCommand(`agy --dangerously-skip-permissions --model ${id}`).cmd,
      `agy --dangerously-skip-permissions --model ${id}`, id);
  }
  for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
    for (const cmd of [`claude --model ${id}`, `cursor-agent --force --model ${id}`, `codex --model ${id}`]) {
      const r = M.checkCommand(cmd);
      assert.ok(r.error && !r.cmd, cmd);
      assert.match(r.error, /gemini-3\.8-flash-high[\s\S]*claude-opus-5-5-high/, 'says what to use instead');
    }
  }
  assert.equal(M.checkCommand('cursor-agent --model gpt-oss-120b-medium').cmd,
    'cursor-agent --model gpt-oss-120b-medium');
  for (const cmd of ['agy --model haiku', 'agy --model claude-haiku-4-5', 'agy --model claude-sonnet-4-5-20250929',
    'agy --model claude-opus-4-5', 'claude --model haiku', 'claude --model=claude-haiku-4-5',
    'claude --model claude-sonnet-4-5-20250929', 'cursor-agent --force --model sonnet-4.6-thinking',
    'codex --model claude-3-5-sonnet', 'claude --model "claude-3-5-sonnet"']) {
    const r = M.checkCommand(cmd);
    assert.ok(r.error && !r.cmd, cmd);
    assert.match(r.error, /gemini-3\.8-flash-high[\s\S]*claude-opus-5-5-high/, 'says what to use instead');
  }
  for (const cmd of ['claude --dangerously-skip-permissions --model claude-sonnet-5-5 --effort high', 'claude --model opus',
    'cursor-agent --force --model claude-opus-5-5-max', 'cursor-agent --force --model grok-4.7-high-fast']) {
    assert.equal(M.checkCommand(cmd).cmd, cmd, cmd);
  }
});

test('Haiku 5.x and up is allowed everywhere; Haiku 4.x and older, a bare haiku alias, and every Claude 3/4 id stay refused', () => {
  // Claude Code needs the full id and --effort (measured: claude 2.1.294 takes it on claude-haiku-5-5); Cursor lists
  // claude-haiku-5-5-<tier> and claude-haiku-5-5-thinking-<tier>
  for (const cmd of ['claude --dangerously-skip-permissions --model claude-haiku-5-5 --effort medium',
    'claude --model=claude-haiku-5-5 --effort high', 'claude --model "claude-haiku-5-5"', 'claude --model claude-haiku-5',
    'cursor-agent --force --model claude-haiku-5-5-medium', 'cursor-agent --force --model claude-haiku-5-5-thinking-max',
    'claude --model claude-haiku-6-0', 'claude --model claude-haiku-10-1', 'codex --model haiku-5.5']) {
    const r = M.checkCommand(cmd);
    assert.equal(r.cmd, cmd, cmd);
    assert.ok(!r.error, cmd);
  }
  // Opus/Sonnet 5.5 are unchanged, and Claude Code is not made to carry --effort by the check
  for (const cmd of ['claude --model claude-opus-5-5 --effort max', 'claude --model claude-sonnet-5-5', 'claude --model claude-haiku-5-5',
    'cursor-agent --force --model claude-sonnet-5-5-high']) assert.equal(M.checkCommand(cmd).cmd, cmd, cmd);
  for (const cmd of ['claude --model claude-haiku-4-5', 'claude --model claude-haiku-4-5-20251001', 'claude --model=claude-haiku-4.5',
    'claude --model claude-3-haiku', 'claude --model claude-3-haiku-20240307', 'claude --model claude-3-5-haiku-20241022',
    'claude --model haiku', 'claude --model claude-haiku', 'claude --model claude-haiku-20250101',
    'cursor-agent --force --model haiku-4.5', 'cursor-agent --model claude-haiku-4-5-medium', 'codex --model claude-haiku-3-5',
    'claude --model claude-opus-4-8', 'claude --model claude-sonnet-4-6', 'claude --model claude-4-haiku']) {
    const r = M.checkCommand(cmd);
    assert.ok(r.error && !r.cmd, cmd);
    assert.match(r.error, /Haiku 4\.x 及更早[\s\S]*claude-haiku-5-5/, 'tells 队长 Haiku 5.5 is the one to use');
    assert.match(r.error, /gemini-3\.8-flash-high[\s\S]*claude-opus-5-5-high/, 'and what else to use');
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

test('background sessions with work still out hold a slot; finished and quota waits free it', () => {
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

test('four working sessions and twenty-six quota waits leave twenty-six admission slots', () => {
  const tasks = Array.from({ length: 30 }, (_, i) => ({ colId: 'c' + i, status: i < 4 ? 'working' : 'quota' }));
  const crew = new Set(tasks.map((t) => t.colId));
  const active = M.activeCrew(tasks, crew).size;
  assert.equal(active, 4);
  assert.deepEqual(M.admission({ cap: 30, active, waiting: 2 }), { limit: 30, free: 26, start: 2, paused: false });
  for (const task of tasks.slice(4)) assert.equal(M.archivable({ tasks }, task.colId, 0, Date.now()), false);
  tasks.push({ colId: 'c4', status: 'working' });
  assert.equal(M.activeCrew(tasks, crew).size, 5);
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

test('Claude suggestion text is not a draft; a real prompt and an unruled typed line are', () => {
  const suggestion = '继续，读测试日志然后提交回执';
  const plain = ['要我继续，还是你想换个做法？', '✻ Churned for 16s', '❯\u00a0' + suggestion];
  const masked = ['要我继续，还是你想换个做法？', '✻ Churned for 16s', '❯\u00a0' + '\u0000'.repeat(suggestion.length)];
  assert.equal(M.inputBoxText(plain, masked), '', 'dim suggestion cells are not typed text');
  assert.equal(M.promptRowIdle(plain.join('\n')), true, 'a prompt row is idle even when plain text still shows the suggestion');
  assert.equal(M.inputBoxText(['done', '❯ 真实草稿'], ['done', '❯ 真实草稿']), '真实草稿');
  assert.equal(M.inputBoxText(['❯ 1. Trust this workspace'], ['❯ 1. Trust this workspace']), null, 'a numbered menu is not an input draft');
  assert.equal(M.tellWaitReason({ entry: { alive: true, state: 'done', lastScreen: plain.join('\n') }, composing: false, screen: plain.join('\n') }), '');
  assert.equal(M.tellWaitReason({ entry: { alive: true, state: 'done', lastScreen: '❯ 真实草稿' }, composing: true, screen: '❯ 真实草稿' }), '输入框里有未发送的草稿');
  assert.match(M.tellWaitReason({ entry: { alive: true, state: 'working', lastScreen: '✻ Doing…' }, composing: false, screen: '✻ Doing…' }), /干活/);
});

test('a finished reply that asks the captain yields that question once per text', () => {
  const screen = [
    '接下来我打算读三份测试日志，有失败就修，然后提交回执。',
    '要我继续，还是你想换个做法？',
    '',
    '✻ Churned for 16s · 11:35 AM',
    '❯\u00a0继续，读测试日志然后提交回执',
  ].join('\n');
  assert.equal(M.implicitCaptainQuestion(screen), '要我继续，还是你想换个做法？');
  assert.equal(M.implicitCaptainQuestion('已经做完。\n❯\u00a0继续，读测试日志然后提交回执'), '');
  assert.equal(M.implicitCaptainQuestion('【提问】\n问题：用哪个库？'), '');
  assert.equal(M.implicitCaptainQuestion(M.RECEIPT_CONTRACT), '');
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
  assert.equal(M.activeCrew(tasks, new Set(['a'])).size, 0);
  assert.equal(M.archivable({ tasks }, 'a', 0, Date.now()), false);
});


test('Captain briefing stays static and includes explicit models, boards and two-round acceptance', () => {
  assert.equal(M.instructions('darwin', 'time and board A'), M.instructions('darwin', 'time and board B'));
  const text = M.instructions('darwin');
  assert.match(text, /--model claude-opus-5-5 --effort high/);
  for (const trigger of ['讨论一下', 'group discussion', 'do a group discussion', 'group chat']) assert.ok(text.includes(trigger));
  assert.match(text, /discuss start --topic/);
  assert.ok(!text.includes('默认模型是 Opus'));
  assert.match(text, /开工后用 peek 看状态行确认模型/);
  assert.match(text, /claude-sonnet-4-6/);
  assert.match(text, /claude-opus-4-6-thinking/);
  assert.match(text, /gpt-oss-120b-medium/);
  assert.match(text, /agy 绝不能加 --effort/);
  assert.match(text, /Gemini 周额度用尽时/);
  assert.match(text, /--command 点名的不换，只排队/);
  assert.match(text, /用户交代的任务默认先记进/);
  assert.match(text, /鸡毛蒜皮/);
  assert.match(text, /截图真的落盘/);
  assert.match(text, /最多返工 2 轮/);
  // How to start depends on the live state, so the closing paragraph points at handoff:
  // nothing to do means a short "ready"; authorised work means carry on without being told.
  assert.match(text, /开工先跑 handoff，照它的「接手动作」做：没有待办就简短回复「队长已就绪」等用户指令，不自行立项/);
  assert.match(text, /有已授权待办，核对后主动续接，不要等用户说“继续”，被暂停或取消的不续派/);
  assert.doesNotMatch(text, /重新派起来|持续自主拆解并派活/);
  assert.match(text, /额度紧时保持 3–5 个活并行/);
  assert.match(text, /额度多时开十几个/);
  assert.match(text, /测试全过并进入打包后停止派新活/);
  assert.match(text, /存档后直接安装并重启/);
  assert.match(text, /安装只用正式 restart-agentdeck.sh／rollback-agentdeck.sh 或发版入口/);
  assert.match(text, /待核对不能 complete，版本启动核验后才结卡/);
  assert.equal(M.REBRIEF_NOTE, M.AUTONOMOUS_CONTINUATION);
  // The Captain's boundary is one rule, with the one exception the user set.
  assert.match(text, /1\. 不要在这一列里改文件[^\n]*实际工作和返工都交给别的会话[^\n]*例外：各家都没额度而你还有额度时可以亲自动手，活不能停/);
  assert.match(text, /仍不通过，换更强模型的队员接手，最后才找用户/);
  assert.doesNotMatch(text, /自己处理/);
  // Stable rules here, live state in handoff; history may be read whenever recovery needs it.
  assert.match(text, /17\. 本提示词只放稳定规则；动态状态和恢复顺序看 handoff/);
  assert.match(text, /read --id 会话id \[--turns 3\] \[--find 关键词\]   读某个会话已保存的对话；恢复、诊断、验收、核对矛盾或用户追问时按需读/);
  assert.doesNotMatch(text, /只在用户追问细节时用/);
  assert.match(text, /会话结束、任务完成、验收通过、交付到哪一步（提交、合并、打包、安装）是四件事，分开判断；审查结束但不通过就是要返工/);
  assert.match(text, /谁接任队长只看设置里的 Relay 轮换，与队员模型分工无关/);
  assert.match(text, /汇报核对完的会话立即 archive，还在验收的先留着/);
  // Commands as the CLI takes them: one line each, the keys answer really accepts.
  assert.equal(text.split('\n').filter((line) => /AGENTDECK_BOARD_CLI" (?:briefing|handoff)/.test(line)).length, 1, 'handoff and briefing share one line');
  assert.match(text, /AGENTDECK_BOARD_CLI" handoff {3}生成当前交接快照[^\n]*briefing 只读本提示词全文/);
  assert.match(text, /answer --to 会话id --key y\|n\|1-9\|enter\|esc\|up\|down[^\n]*down,enter/);
  assert.ok(!/ {4,}\S/.test(text.split('\n').filter((line) => line.includes('AGENTDECK_BOARD_CLI')).join('\n')), 'no alignment padding in the command list');
  // chat-ui replaces a briefing longer than M.BRIEFING_LIMIT with a file pointer.
  // The closing paragraph must stay inside the pasted briefing on both platforms.
  for (const platform of ['darwin', 'win32']) {
    const brief = M.instructions(platform);
    assert.ok(brief.length <= M.BRIEFING_LIMIT, platform);
    assert.ok((brief + M.SAVER_RESUME).length <= M.BRIEFING_LIMIT, platform + ' saver');
    assert.match(brief, /写代码的活加 --worktree 仓库路径，程序会建独立副本和分支/);
    assert.ok(!brief.endsWith('然后等用户的指令。'));
  }
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

test('manual reset preserves ConPTY row boundaries without accepting horizontal quoted success text', () => {
  // Captured Windows stand-in reset: ConPTY goes straight from the success
  // text to the input rule using CUP, with no newline between them.
  const packet = '\x1b[H\x1b[?25h\x1b[?25l⏺ (no content)\x1b[3;1H────────────────\r\n> \r\n────────────────\x1b[33m\r\nContext: 23%\x1b[m';
  assert.equal(M.contextResetEvidence('Claude', 'Context: 23%', 'Context: 23%', packet, 'win32'), true);
  assert.equal(M.contextResetEvidence('Claude', 'Context: 23%', 'Context: 23%', packet, 'darwin'), false);
  assert.equal(M.contextResetEvidence('Claude', '', '', '\x1b[1;1H⏺ Conversation cleared\x1b[3;1H────', 'win32'), true);
  assert.equal(M.contextResetEvidence('Claude', '', '', '\x1b[1;1HUser: \x1b[1;7HConversation cleared\x1b[3;1H────', 'win32'), false);
  assert.equal(M.contextResetEvidence('Claude', '', '', '\x1b[1;1H⏺ Conversation cleared\x1b[3;1HFailed to start new session', 'win32'), false);
});


test('Codex reset evidence reads its native footer below the prompt, never a quoted status', () => {
  assert.equal(M.codexContextFooter('• example 100% context left\n› Ask Codex to do anything\n\n  ⏎ send   98% context left'), '\n  ⏎ send   98% context left');
  assert.equal(M.codexContextFooter('• 100% context left'), '');
  assert.equal(M.codexContextFooter('› old prompt\n100% context left\n› current prompt\n98% context left'), '98% context left');
});

test('native rate limit waits are quota state and a newer working line wins', () => {
  assert.equal(M.terminalActivity('API Error: 429 rate_limit_error: Too many requests'), 'quota');
  assert.equal(M.terminalActivity('Rate limit reached.\n✻ Doing…'), 'working');
  assert.equal(M.terminalActivity('The report mentions rate_limit errors.'), '');

});

test('archivable: a failed or stopped session needs its card done or taken over; a done one does not', () => {
  const now = 10_000_000, min = 60_000;
  const old = { sentAt: now - 30 * min, doneAt: now - 20 * min };
  const mk = (status, extra) => ({ tasks: [{ colId: 'a', status, boardId: 'c1', ...old, ...extra }], pending: [], inflight: [] });
  assert.equal(M.archivable(mk('done'), 'a', 0, now), true);
  for (const status of ['failed', 'stopped']) {
    assert.equal(M.archivable(mk(status), 'a', 0, now), false, status + ' with no card information');
    assert.equal(M.archivable(mk(status), 'a', 0, now, M.ARCHIVE_AFTER, { c1: { status: 'doing', session_id: 'a' } }), false, status + ' nobody took over');
    assert.equal(M.archivable(mk(status), 'a', 0, now, M.ARCHIVE_AFTER, { c1: { status: 'done' } }), true, status + ' card done');
    assert.equal(M.archivable(mk(status), 'a', 0, now, M.ARCHIVE_AFTER, { c1: { status: 'doing', session_id: 'b' } }), true, status + ' card bound to another session');
    const taken = { ...mk(status), tasks: [...mk(status).tasks, { colId: 'b', status: 'working', boardId: 'c1', sentAt: now - 10 * min }] };
    assert.equal(M.archivable(taken, 'a', 0, now), true, status + ' same card sent to another session');
    assert.equal(M.archivable(mk(status, { boardId: '' }), 'a', 0, now, M.ARCHIVE_AFTER, { '': { status: 'done' } }), false, status + ' without a card stays');
    assert.equal(M.needsCardCheck(mk(status), 'a'), true);
  }
  assert.equal(M.needsCardCheck(mk('done'), 'a'), false);
  assert.equal(M.needsCardCheck(mk('failed', { boardId: '' }), 'a'), false);
});

test('archivable: a successor who also failed is not a takeover; the newest failure stays', () => {
  const now = 10_000_000, min = 60_000;
  const task = (colId, status, ago) => ({ colId, status, boardId: 'c1', sentAt: now - ago * min, doneAt: status === 'working' ? 0 : now - ago * min });
  const quiet = (tasks) => ({ tasks, pending: [], inflight: [] });
  const doing = (session_id) => ({ c1: { status: 'doing', session_id } });
  const gone = (s, colId, cards) => M.archivable(s, colId, 0, now, M.ARCHIVE_AFTER, cards);

  // A failed, B took over and is working. The binding can still name A.
  let s = quiet([task('a', 'failed', 40), task('b', 'working', 30)]);
  assert.equal(gone(s, 'a', doing('a')), true, 'A archives once B is working');
  assert.equal(gone(s, 'b', doing('a')), false, 'B is still working');

  // B also failed. A may leave; B stays even though the card still names A.
  for (const status of ['failed', 'stopped']) {
    s = quiet([task('a', 'failed', 40), task('b', status, 30)]);
    assert.equal(gone(s, 'a', doing('a')), true, 'earlier failure may archive after B ' + status);
    assert.equal(gone(s, 'b', doing('a')), false, 'newest ' + status + ' stays while the card is open');
    assert.equal(gone(s, 'b', doing('b')), false, 'newest ' + status + ' stays when the card names B');
  }

  // C takes over. B archives whether or not the binding has caught up.
  s = quiet([task('a', 'failed', 40), task('b', 'failed', 30), task('c', 'working', 20)]);
  assert.equal(gone(s, 'b', doing('a')), true, 'B archives once C is working');
  assert.equal(gone(s, 'c', doing('c')), false, 'C is still working');

  // Card completed: every finished attempt on it archives.
  s = quiet([task('a', 'failed', 40), task('b', 'failed', 30), task('c', 'done', 20)]);
  const done = { c1: { status: 'done', session_id: 'c' } };
  assert.equal(gone(s, 'a', done), true, 'A archives when the card is done');
  assert.equal(gone(s, 'b', done), true, 'B archives when the card is done');
  assert.equal(gone(s, 'c', done), true, 'C archives when the card is done');
});

test('answer --key keeps the one-key forms and can move a menu cursor before Enter', () => {
  // unchanged: a lone y, n or digit is typed and then submitted with Enter
  for (const key of ['y', 'n', '1', '9', ' Y ']) assert.deepEqual(M.answerKeys(key), { keys: [key.trim().toLowerCase()], submit: true }, key);
  assert.deepEqual(M.answerKeys('enter'), { keys: ['\r'], submit: false });
  assert.deepEqual(M.answerKeys('esc'), { keys: ['\x1b'], submit: false });
  // Claude Code's folder-trust menu exits on 1, 2 and y: down then Enter is what picks "Yes, I trust this folder"
  assert.deepEqual(M.answerKeys('down,enter'), { keys: ['\x1b[B', '\r'], submit: false });
  assert.deepEqual(M.answerKeys('DOWN, Enter').keys, ['\x1b[B', '\r']);
  assert.deepEqual(M.answerKeys('down:2,enter').keys, ['\x1b[B', '\x1b[B', '\r']);
  assert.deepEqual(M.answerKeys('up:3,tab,space,left,right').keys, ['\x1b[A', '\x1b[A', '\x1b[A', '\t', ' ', '\x1b[D', '\x1b[C']);
  // a list of keys is exact: no extra Enter, even when it is a single digit followed by nothing
  assert.deepEqual(M.answerKeys('down,2'), { keys: ['\x1b[B', '2'], submit: false });
  // a terminal in application cursor mode wants SS3 arrows
  assert.deepEqual(M.answerKeys('down,up', { appCursor: true }).keys, ['\x1bOB', '\x1bOA']);
  for (const bad of ['', ' ', 'x', '0', '10', 'ctrl-c', 'down,', ',enter', 'down:0', 'down:21', 'down:x', 'down:1:2', 'enter:2', 'y:2',
    Array(21).fill('down').join(','), Array(3).fill('down:20').join(',')]) {
    assert.throws(() => M.answerKeys(bad), /answer 的 --key 只能是/, JSON.stringify(bad));
  }
});
