const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../chat-core');

const claudeScreen = [
  '> fix the bug in app.js',
  '',
  "⏺ I'll look at the file first.",
  '',
  '⏺ Read(app.js)',
  '  ⎿  Read 120 lines',
  '',
  '⏺ Update(app.js)',
  '  ⎿  Updated app.js with 2 additions and 1 removal',
  '',
  '⏺ Fixed the null check in `app.js` line 42. The handler now returns early',
  '  when the input is empty, so the crash no longer happens.',
  '',
  '✻ Worked for 32s',
  '',
  '╭──────────────────────────────────────────╮',
  '│ >                                        │',
  '╰──────────────────────────────────────────╯',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];

test('Claude style screen keeps only the final reply, joined into one paragraph', () => {
  const reply = C.extractReply(claudeScreen, 'fix the bug in app.js', 80);
  assert.equal(reply, 'Fixed the null check in `app.js` line 42. The handler now returns early when the input is empty, so the crash no longer happens.');
});

test('Codex style screen drops tool blocks, diffs and the footer', () => {
  const screen = [
    '› fix the bug',
    '',
    '• Explored',
    '  └ Read app.js',
    '',
    '• Edited app.js (+2 -1)',
    '    41  -  if (x) {',
    '    41  +  if (!x) return;',
    '',
    '• Fixed the null check in app.js. Tests pass.',
    '',
    '  gpt-5 high · 98% context left',
  ];
  assert.equal(C.extractReply(screen, 'fix the bug', 100), 'Fixed the null check in app.js. Tests pass.');
});

test('a turn that ends on a tool call has no text reply', () => {
  const screen = ['> run it', '', '⏺ Bash(npm test)', '  ⎿  Running…'];
  assert.equal(C.extractReply(screen, 'run it', 80), '');
});

test('several text blocks after the last tool call are all kept', () => {
  const screen = ['> go', '', '⏺ Read(a.js)', '  ⎿  Read 3 lines', '', '⏺ First point.', '', '⏺ Second point.'];
  assert.equal(C.extractReply(screen, 'go', 80), 'First point.\n\nSecond point.');
});

test('output without bullets falls back to the screen text minus the prompt echo', () => {
  const screen = ['$ echo hi', 'hi', 'jinhao@mac proj %'];
  assert.equal(C.extractReply(screen, 'echo hi', 80), 'hi');
});

test('reflow joins wrapped Chinese text without spaces and leaves lists alone', () => {
  const wide = '这是一段很长的中文说明文字用来测试终端自动折行之后是否能够被正确地接回去';
  const lines = [wide, '继续的内容。', '', '- 第一项', '- 第二项'];
  const out = C.reflow(lines, C.visibleWidth(wide) + 2);
  assert.equal(out[0], wide + '继续的内容。');
  assert.deepEqual(out.slice(1), ['', '- 第一项', '- 第二项']);
});

test('menu answers are not treated as new questions', () => {
  for (const s of ['1', '2', 'y', 'N', 'yes', '', '  ']) assert.equal(C.isPromptAnswer(s), true);
  assert.equal(C.isPromptAnswer('yes please refactor this'), false);
});

test('chats are normalised and keep every turn, never evicting old ones', () => {
  const raw = { turns: Array.from({ length: 450 }, (_, i) => ({ id: 't' + i, ts: i, user: 'q' + i, reply: 'a' + i, done: true })) };
  raw.turns.push({ user: 5 }, null);
  const chat = C.normalizeChat(raw, 'c1');
  assert.equal(chat.turns.length, 450);
  assert.equal(chat.turns[0].user, 'q0');
  assert.equal(chat.turns[chat.turns.length - 1].user, 'q449');
  for (let i = 0; i < 300; i++) C.addTurn(chat, { id: 'n' + i, ts: 1000 + i, user: 'n' + i, reply: '', done: true });
  assert.equal(chat.turns.length, 750);
  assert.equal(chat.turns[0].user, 'q0');
  assert.deepEqual(C.normalizeChat('nope', 'c2'), { v: 1, id: 'c2', turns: [] });
  assert.equal(C.normalizeChat({ captainArchive: true, turns: [] }, 'old-captain').captainArchive, true);
  assert.equal(C.normalizeChat({ captainArchive: 'true', turns: [] }, 'worker').captainArchive, undefined);
});

test('old SGR mouse reports are removed without losing real Chinese prompts or replies', () => {
  const mouse = '<35;18;11M<0;21;31m<35;18;11M<0;21;31m';
  const saved = C.normalizeChat({ turns: [
    { user: mouse + '请检查中文显示', reply: '回答：正常' + mouse, done: true },
    { user: mouse, reply: '', done: true },
    { user: '文档例子 <35;18;11M', reply: '保留原文', done: true },
    { user: '0;11M' + mouse + '不是，我说的是 GPT 6', reply: '', done: true },
    { user: '0;11M 是示例坐标', reply: '', done: true },
  ] }, 'mouse');
  assert.equal(saved.turns[0].user, '请检查中文显示');
  assert.equal(saved.turns[0].reply, '回答：正常');
  assert.equal(saved.turns[1].user, '');
  assert.equal(saved.turns[2].user, '文档例子 <35;18;11M');
  assert.equal(saved.turns[3].user, '不是，我说的是 GPT 6');
  assert.equal(saved.turns[4].user, '0;11M 是示例坐标');
});

test('a turn open when the app closed keeps its partial reply and is marked unfinished', () => {
  const saved = C.normalizeChat({ turns: [
    { id: 'a', ts: 1, user: 'done one', reply: 'ok', done: true },
    { id: 'b', ts: 2, user: 'cut off', reply: 'half of the answer', done: false, interrupted: true },
    { id: 'c', ts: 3, user: 'never answered', reply: '', done: false },
  ] }, 'x');
  assert.equal(saved.turns[1].interrupted, true);
  assert.equal(C.normalizeChat({ turns: [{ user: 'u', interrupted: 'yes' }] }, 'y').turns[0].interrupted, undefined);
  C.closeOpenTurns(saved);
  assert.deepEqual(saved.turns.map((t) => [t.done, !!t.interrupted, t.reply]),
    [[true, false, 'ok'], [true, true, 'half of the answer'], [true, true, '']]);
});

test('turns recorded before the saved chat loaded are merged after it, without duplicates', () => {
  const saved = { v: 1, id: 'c', turns: [{ id: 'a', user: 'old' }, { id: 'b', user: 'older still saved' }] };
  const mem = { v: 1, id: 'c', turns: [{ id: 'b', user: 'dup' }, { id: 'z', user: 'typed during startup' }] };
  assert.deepEqual(C.mergeChats(saved, mem).turns.map((t) => t.id), ['a', 'b', 'z']);
  assert.equal(C.mergeChats(saved, undefined), saved);
});

test('the chat view renders a window of the latest turns, older ones on request', () => {
  assert.equal(C.windowStart(40, C.RENDER_STEP), 0);
  assert.equal(C.windowStart(500, C.RENDER_STEP), 500 - C.RENDER_STEP);
  assert.equal(C.windowStart(500, C.RENDER_STEP * 2), 500 - C.RENDER_STEP * 2);
  assert.equal(C.windowStart(500, 10_000), 0);
});

test('lines typed at a password prompt are never recorded as prompts', () => {
  for (const row of ['Password:', '[sudo] password for me: ', "Enter passphrase for key '/Users/me/.ssh/id_ed25519': ", '请输入密码：', 'Enter PIN: '])
    assert.equal(C.isSecretPrompt(row), true, row);
  for (const row of ['> ', 'me@mac proj % ', '│ > fix the password reset page', 'PS C:\\> ', ''])
    assert.equal(C.isSecretPrompt(row), false, row);
});

test('search covers prompts, replies and titles, newest first, all words must match', () => {
  const chats = [
    { colId: 'a', title: 'Claude 重构', turns: [
      { id: '1', ts: 10, user: 'refactor the parser', reply: 'Done, parser now streams.' },
      { id: '2', ts: 20, user: '再看看登录', reply: '登录逻辑已经修好' },
    ] },
    { colId: 'b', title: 'Grok', turns: [{ id: '3', ts: 15, user: 'what is a parser combinator', reply: '' }] },
  ];
  const r = C.searchChats(chats, 'parser');
  assert.deepEqual(r.map((h) => [h.colId, h.turnId, h.role]), [['b', '3', 'user'], ['a', '1', 'user'], ['a', '1', 'reply']]);
  assert.equal(r[0].match.toLowerCase(), 'parser');
  assert.equal(C.searchChats(chats, 'parser streams').length, 1);
  assert.deepEqual(C.searchChats(chats, '登录').map((h) => h.role), ['user', 'reply']);
  assert.equal(C.searchChats(chats, '重构')[0].role, 'title');
  assert.deepEqual(C.searchChats(chats, '   '), []);
});

test('file kinds and mime types', () => {
  assert.equal(C.fileKind('README.md'), 'markdown');
  assert.equal(C.fileKind('a/b.PDF'), 'pdf');
  assert.equal(C.fileKind('shot.png'), 'image');
  assert.equal(C.fileKind('main.js'), 'text');
  assert.equal(C.imageMime('x.svg'), 'image/svg+xml');
  assert.equal(C.imageMime('x.txt'), null);
});

test('markdown output cannot carry markup or script URLs', () => {
  const html = C.renderMarkdown('# <img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) and [ok](https://example.com)\n\n`<b>`');
  assert.ok(!/<img/.test(html));
  assert.ok(!/javascript:/.test(html));
  assert.ok(html.includes('<a href="https://example.com"'));
  assert.ok(html.includes('<code>&lt;b&gt;</code>'));
});

test('markdown handles fences, lists and tables', () => {
  const html = C.renderMarkdown('```js\nconst a = "x";\n```\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(html.includes('<pre class="md-code">'));
  assert.ok(html.includes('tok-k'));
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<th>a</th>'));
});

test('code highlighting escapes everything and skips plain text', () => {
  assert.equal(C.highlightCode('<script>', 'plain'), '&lt;script&gt;');
  const out = C.highlightCode('const s = "<b>"; // hi', 'js');
  assert.ok(!out.includes('<b>'));
  assert.ok(out.includes('tok-c'));
  assert.ok(out.includes('tok-s'));
});

test('artifacts collect files and links from replies, newest mention wins', () => {
  const findLinks = (line) => {
    const out = [];
    for (const m of line.matchAll(/https?:\/\/\S+|\/\S+\/\S+/g)) out.push({ kind: m[0].startsWith('http') ? 'url' : 'file', text: m[0] });
    return out;
  };
  const chats = [
    { colId: 'a', title: 'A', turns: [{ id: 't1', ts: 1, user: 'q', reply: 'see /tmp/x/report.md and https://example.com/docs/' }] },
    { colId: 'b', title: 'B', archived: true, turns: [{ id: 't2', ts: 5, user: 'q', reply: 'updated /tmp/x/report.md' }, { id: 't3', ts: 6, user: 'q', reply: '' }] },
  ];
  const list = C.collectArtifacts(chats, findLinks);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { kind: 'file', text: '/tmp/x/report.md', name: 'report.md', type: 'markdown', colId: 'b', title: 'B', archived: true, turnId: 't2', ts: 5 });
  assert.equal(list[1].name, 'example.com · docs');
  assert.equal(list[1].type, 'web');
});

test('delivered files: one entry per path on Mac and Windows spellings', () => {
  const home = '/Users/me';
  assert.equal(C.pathKey('~/reports/a.md', home), '/Users/me/reports/a.md');
  assert.equal(C.pathKey('file:///Users/me/reports//a.md:12:3', home), '/Users/me/reports/a.md');
  assert.equal(C.pathKey('/Users/me/reports/shots/', home), '/Users/me/reports/shots');
  assert.notEqual(C.pathKey('/Users/me/A.md', home), C.pathKey('/Users/me/a.md', home));
  // Windows: case and slash direction do not make a second file
  assert.equal(C.pathKey('C:\\Users\\Me\\Reports\\a.md'), C.pathKey('c:/users/me/reports/a.md'));
  assert.equal(C.pathKey('C:\\Users\\Me\\out\\'), 'c:\\users\\me\\out');
  assert.equal(C.pathKey('\\\\nas\\share\\\\a.md'), '\\\\nas\\share\\a.md');
  assert.equal(C.pathKey('~\\out\\a.md', 'C:\\Users\\Me'), 'c:\\users\\me\\out\\a.md');
  assert.equal(C.pathKey('  ', home), '');
});

test('delivered files come from every place a receipt is kept, old receipts included', () => {
  const receipts = C.deliveryReceipts({
    sessions: [
      { id: 'w1', title: '登录', project: '客户门户', archived: false, lastReceipt: { summary: '登录做完', files: ['/out/login.md'], ts: 300 } },
      { id: 'w2', title: '旧迁移', project: '报表服务', archived: true, lastReceipt: { summary: '迁完', files: ['/out/migrate.sql'], ts: 100 } },
      { id: 'w3', title: '没交文件', project: '', lastReceipt: { summary: '只说了一句', files: [] } },
      { id: 'cap', title: '队长', project: '', lastReceipt: null },
    ],
    tasks: [
      { id: 'k1', colId: 'w1', title: '做登录', project: '客户门户', sentAt: 200, doneAt: 300, receipt: { summary: '登录做完', files: ['/out/login.md'] } },
      { id: 'k2', colId: 'w1', title: '还在干', sentAt: 400, receipt: null },
      { id: 'k3', colId: 'w1', title: '在提问', sentAt: 500, receipt: { question: '用哪个库？', files: [] } },
    ],
    chats: [{ colId: 'cap', turns: [
      { id: 'u1', ts: 1, user: '普通对话', reply: '看 /out/login.md' },
      { id: 'k0', ts: 50, user: '导出报表', kind: 'task', task: { colId: 'gone', title: '导出报表', project: '报表服务', doneAt: 90, receipt: { summary: '', failed: '只导出一半', files: ['/out/half.csv', 42, '', 'tasks/G3-amend-1.md', 'Update available! Run: brew upgrade claude-code@latest'] } } },
      { id: 'k9', ts: 60, user: '老卡片', kind: 'task', task: { colId: 'w2', title: '老卡片', receipt: { summary: '迁完', files: ['/out/migrate.sql'] } } },
    ] }],
  });
  assert.deepEqual(receipts.map((r) => [r.colId, r.session, r.project, r.ts, r.files.join(','), r.gone, r.archived]), [
    ['w1', '登录', '客户门户', 300, '/out/login.md', false, false],
    ['w2', '旧迁移', '报表服务', 100, '/out/migrate.sql', false, true],
    ['w1', '登录', '客户门户', 300, '/out/login.md', false, false],
    ['gone', '', '报表服务', 90, '/out/half.csv', true, false],
    // a card from before projects were stored: its session still knows the project, its time is when the work went out
    ['w2', '旧迁移', '报表服务', 60, '/out/migrate.sql', false, true],
  ]);
  assert.deepEqual([receipts[3].task, receipts[3].failed], ['导出报表', '只导出一半']);
  assert.deepEqual(C.deliveryReceipts({}), []);
});

test('delivered files group by project, newest first, a path once under its latest session', () => {
  const r = (colId, session, project, ts, files, more = {}) => ({ colId, session, project, ts, files, archived: false, gone: false, task: '', summary: session + ' 的回执', failed: '', ...more });
  const out = C.collectDeliveries([
    r('a', 'A', 'Portal', 100, ['/out/report.md', '/out/old.png']),
    r('b', 'B', 'portal', 300, ['/out/report.md:8', '/out/new.csv']),
    r('c', 'C', '', 900, ['/tmp/scratch.txt']),
    r('d', 'D', 'Reports', 200, ['C:\\out\\Sheet.xlsx', '/out/folder/']),
    r('e', 'E', 'Reports', 250, ['c:/out/sheet.xlsx']),
  ], '/Users/me');
  assert.equal(out.total, 6);
  // project names differing only in case are one project, shown as last written; no project comes last
  assert.deepEqual(out.groups.map((g) => [g.key, g.name, g.ts, g.files.map((f) => f.name + '@' + f.session)]), [
    ['portal', 'portal', 300, ['new.csv@B', 'report.md@B', 'old.png@A']],
    ['reports', 'Reports', 250, ['sheet.xlsx@E', 'folder@D']],
    ['', '', 900, ['scratch.txt@C']],
  ]);
  const report = out.groups[0].files[1];
  assert.deepEqual([report.path, report.key, report.type, report.colId, report.ts, report.summary], ['/out/report.md:8', '/out/report.md', 'markdown', 'b', 300, 'B 的回执']);
  assert.equal(out.groups[0].files[2].type, 'image');
  assert.deepEqual(C.collectDeliveries([], ''), { total: 0, groups: [] });
});

test('the same receipt kept twice: the copy that knows its project and session wins', () => {
  const base = { colId: 'w', session: '', project: '', ts: 50, files: ['/out/a.md'], archived: false, gone: true, task: '卡片标题', summary: '', failed: '' };
  const known = { ...base, session: '报表导出', project: '报表服务', gone: false };
  for (const order of [[base, known], [known, base]]) {
    const [file] = C.collectDeliveries(order, '').groups[0].files;
    assert.deepEqual([file.session, file.project, file.gone], ['报表导出', '报表服务', false]);
  }
});

test('a task card remembers its project and when the receipt came in', () => {
  const card = (task) => C.normalizeChat({ turns: [{ id: 'k', ts: 1, user: 'x', kind: 'task', task }] }, 'cap').turns[0].task;
  const kept = card({ colId: 'w', title: 't', status: 'done', project: '客户门户', doneAt: 1234, receipt: { summary: 's', files: ['/a'], explicit: true } });
  assert.deepEqual([kept.project, kept.doneAt], ['客户门户', 1234]);
  // older cards have neither and stay as they were
  const old = card({ colId: 'w', title: 't', status: 'done', receipt: null });
  assert.equal('project' in old, false);
  assert.equal('doneAt' in old, false);
});

test('reply markdown keeps terminal line breaks and stays escaped', () => {
  const html = C.renderMarkdown('## 结果\n第一行\n第二行 <b>x</b>\n\n- a\n- b', { breaks: true });
  assert.match(html, /<h2>结果<\/h2>/);
  assert.match(html, /第一行<br>第二行 &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<ul><li[^>]*>a<\/li><li[^>]*>b<\/li><\/ul>/);
});

test('the status lines under the input box never end up in the reply', () => {
  const screen = [
    '> 总结一下',
    '',
    '⏺ 已经写好了 /tmp/x/report.md',
    '',
    '────────────────────────────────────────',
    '> ',
    '────────────────────────────────────────',
    '  Context: [████░░░░] 235k/1000k (23%) | Session: 26.0% | Cost: $3.62',
    '  Model: Opus 5.5 | Reset: 3hr 37m | Weekly Reset: 16hr 17m',
    '  Thinking: xhigh',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ...Array(30).fill(''),            // the rest of a tall screen is blank
  ];
  assert.equal(C.extractReply(screen, '总结一下', 80), '已经写好了 /tmp/x/report.md');
  // a lone rule inside the answer is left alone
  assert.deepEqual(C.cutInputBox(['a', '──────────', 'b']), ['a', '──────────', 'b']);
});

test('a multi-line prompt echoed line by line is not part of the reply', () => {
  const contract = '\n---\n（约定）做完时在最后写：\n【回执】\n摘要：一到三句\n回执里不要贴文件正文。';
  const screen = [
    'please write the report', '---', '（约定）做完时在最后写：', '【回执】', '摘要：一到三句', '回执里不要贴文件正文。',
    '⏺ GOT please write the report', '  【回执】', '  摘要：done', '',
  ];
  const reply = C.extractReply(screen, 'please write the report' + contract, 80);
  assert.ok(reply.startsWith('GOT please write the report'), reply);
  assert.ok(!reply.includes('约定'));
});

test('a TUI without a ruled box: the lone prompt row and footer are cut, a closing quote is kept', () => {
  const codex = ['> fix it', '', '• Fixed the null check in app.js', '', '› Ask Codex to do anything', '', '  ⏎ send   ⌃J newline   100% context left'];
  assert.equal(C.extractReply(codex, 'fix it', 80), 'Fixed the null check in app.js');
  assert.deepEqual(C.cutInputBox(['answer', '> a closing quote']), ['answer', '> a closing quote']);
});

test('blank redraw padding before the echo does not hide it', () => {
  const screen = [...Array(20).fill(''), '> please summarize', 'line two', '', '⏺ Summary here', ''];
  assert.equal(C.extractReply(screen, 'please summarize\nline two', 80), 'Summary here');
});

test('view preference defaults legacy or invalid values to chat', () => {
  for (const value of [undefined, null, '', 'terminal', 'board', false, {}]) {
    assert.equal(C.normalizeViewMode(value), 'chat');
  }
  assert.equal(C.normalizeViewMode('term'), 'term');
  assert.equal(C.normalizeViewMode('chat'), 'chat');
});

test('global view flips its saved choice despite independent column overrides', () => {
  const config = { globalViewMode: 'chat', theme: 'dark' };
  const columns = [{ id: 'captain', isMain: true, view: 'term' },
    { id: 'background', captainCrew: true, view: 'chat' }, { id: 'new' }];
  assert.equal(C.toggleGlobalView(config, columns), 'term');
  assert.deepEqual(columns.map((c) => c.view), ['term', 'term', 'term']);
  columns[1].view = 'chat';
  assert.equal(config.globalViewMode, 'term');
  assert.equal(C.toggleGlobalView(config, columns), 'chat');
  assert.deepEqual(columns.map((c) => c.view), ['chat', 'chat', 'chat']);
  assert.deepEqual(config, { globalViewMode: 'chat', theme: 'dark' });
  assert.equal(columns[0].isMain, true);
  assert.equal(columns[1].captainCrew, true);
});

test('the global choice toggles without columns and survives a config round trip', () => {
  const config = {};
  C.toggleGlobalView(config, []);
  const saved = JSON.parse(JSON.stringify(config));
  assert.equal(C.normalizeViewMode(saved.globalViewMode), 'term');
  assert.equal(C.toggleGlobalView(saved, [{ id: 'later', view: 'chat' }]), 'chat');
});

test('local rotation notices remain notices after durable chat normalization', () => {
  const chat = C.normalizeChat({ turns: [{ kind: 'notice', id: 'relay', user: '永动机', reply: 'CN → US；额度低；2026-10-03', done: true, ts: 123 }] }, 'captain');
  assert.equal(chat.turns[0].kind, 'notice');
  assert.equal(chat.turns[0].reply, 'CN → US；额度低；2026-10-03');
  assert.equal(chat.turns[0].done, true);
});

// ---- turn work (steps) and finish time: optional, backward compatible ----
test('extractSteps keeps the tool calls and notes before the final reply, one line each', () => {
  const steps = C.extractSteps(claudeScreen, 'fix the bug in app.js');
  assert.ok(steps.length >= 2);
  assert.ok(steps.some((s) => /^Read\(app\.js\) ⎿ Read 120 lines$/.test(s)));
  assert.ok(steps.every((s) => !s.includes('\n') && s.length <= 300));
  // the final reply is not repeated in the steps
  const reply = C.extractReply(claudeScreen, 'fix the bug in app.js', 80);
  assert.ok(!steps.some((s) => reply.startsWith(s)));
  assert.deepEqual(C.extractSteps(['> hi', 'plain output, no bullets'], 'hi'), []);
});

test('capSteps keeps at most 40 of the newest lines within 8KB of UTF-8', () => {
  const many = Array.from({ length: 60 }, (_, i) => 'step ' + i);
  const kept = C.capSteps(many);
  assert.equal(kept.length, C.MAX_STEPS);
  assert.equal(kept[0], 'step 20');
  assert.equal(kept.at(-1), 'step 59');
  const wide = Array.from({ length: 40 }, () => '中'.repeat(300));   // 900 bytes each
  const fit = C.capSteps(wide);
  assert.ok(Buffer.byteLength(fit.join(''), 'utf8') <= C.MAX_STEP_BYTES);
  assert.equal(fit.length, 9);
  assert.deepEqual(C.capSteps('nope'), []);
  assert.deepEqual(C.capSteps([1, null, '  a  b ', '']), ['a b']);
});

test('normalizeChat reads old turns unchanged and new turns with end and steps', () => {
  const old = { id: 'o1', ts: 1000, user: 'q', reply: 'a', done: true, atts: [] };
  const fresh = { id: 'n1', ts: 1000, end: 61000, user: 'q', reply: 'a', done: true, atts: [], steps: ['Bash(ls) ⎿ a.js'] };
  const chat = C.normalizeChat({ turns: [old, fresh] }, 'c');
  assert.deepEqual(chat.turns[0], { id: 'o1', ts: 1000, user: 'q', reply: 'a', done: true, atts: [] });
  assert.equal(chat.turns[1].end, 61000);
  assert.deepEqual(chat.turns[1].steps, ['Bash(ls) ⎿ a.js']);
  // bad or oversized values are dropped or capped, never trusted
  const bad = C.normalizeChat({ turns: [{ user: 'q', end: 'soon', steps: 'Bash(ls)' }, { user: 'q', end: -5, steps: [] },
    { user: 'q', steps: Array.from({ length: 99 }, (_, i) => 'x'.repeat(500) + i) }] }, 'c');
  assert.equal('end' in bad.turns[0], false);
  assert.equal('steps' in bad.turns[0], false);
  assert.equal('end' in bad.turns[1], false);
  assert.equal('steps' in bad.turns[1], false);
  assert.ok(bad.turns[2].steps.length <= C.MAX_STEPS);
  assert.ok(Buffer.byteLength(bad.turns[2].steps.join(''), 'utf8') <= C.MAX_STEP_BYTES);
  // a round trip keeps the new fields (and an older app simply ignores them)
  assert.deepEqual(C.normalizeChat(JSON.parse(JSON.stringify(chat)), 'c'), chat);
});

test('editsFromSteps sums Claude and Codex file edits per path', () => {
  const edits = C.editsFromSteps([
    'Update(notes/plan.md) ⎿ Added 12 lines, removed 3 lines',
    'Write(docs/new.md) ⎿ Wrote 140 lines to docs/new.md',
    'Update(src/a.js) ⎿ Updated src/a.js with 2 additions and 1 removal',
    'Edited src/a.js (+5 -2)',
    'Edited 3 files (+9 -1)',
    'Bash(npm test) ⎿ ok',
    'Reading the plan first.',
  ]);
  assert.deepEqual(edits, [
    { path: 'notes/plan.md', add: 12, del: 3 },
    { path: 'docs/new.md', add: 140, del: 0 },
    { path: 'src/a.js', add: 7, del: 3 },
  ]);
  assert.deepEqual(C.editsFromSteps(undefined), []);
  assert.equal(C.isToolStep('Bash(npm test) ⎿ ok'), true);
  assert.equal(C.isToolStep('Reading the plan first.'), false);
});

test('fmtDuration and turnTimeLabel read like the chat header', () => {
  assert.equal(C.fmtDuration(5000), '5秒');
  assert.equal(C.fmtDuration((18 * 60 + 43) * 1000), '18分43秒');
  assert.equal(C.fmtDuration((2 * 3600 + 5 * 60) * 1000), '2小时05分');
  const now = new Date(2026, 9, 4, 12, 0).getTime();   // Sunday
  assert.equal(C.turnTimeLabel(new Date(2026, 9, 4, 9, 5).getTime(), now), '今天 09:05');
  assert.equal(C.turnTimeLabel(new Date(2026, 9, 3, 21, 46).getTime(), now), '昨天 21:46');
  assert.equal(C.turnTimeLabel(new Date(2026, 9, 2, 21, 46).getTime(), now), '周五 21:46');
  assert.equal(C.turnTimeLabel(new Date(2026, 8, 1, 8, 0).getTime(), now), '9月1日 08:00');
  assert.equal(C.turnTimeLabel(new Date(2025, 8, 1, 8, 0).getTime(), now), '2025年9月1日 08:00');
  assert.equal(C.turnTimeLabel(0, now), '');
});

test('code fences carry their language for the chat code bar', () => {
  assert.ok(C.renderMarkdown('```bash\necho hi\n```').includes('<code data-lang="bash">'));
  assert.ok(C.renderMarkdown('```\nplain\n```').includes('<code data-lang="">'));
  assert.ok(!C.renderMarkdown('```"><img>\nx\n```').includes('<img>'));
});

// ---- the reply as the chat view shows it (desktop 队长 page) ----
const Hub = require('../mobile-web/hub/core.js');
const captain = require('./fixtures/captain-chat.js');
const captainTurns = captain.turns(1_800_000_000_000);
const captainSaid = captainTurns.map((t) => t.user || '').join('\n');
const shown = (reply, prompt) => C.shownReply(reply, captainSaid, Hub.cleanReply, prompt);
const RESIDUE = /^[❯›] |\(click\) ↓|^Ran \d+ shell command|^Background command|How is Claude doing|^1: Bad|^ {2,}\d{1,6}(?: [+-]| {2}\S|\s*$)|^\s*\+|用户未反对|卡在哪|交付状态/m;

test('the desktop page loads the phone hub rules and cleans replies with them, not with a second set', () => {
  const fs = require('fs'), path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const hub = html.indexOf('<script src="mobile-web/hub/core.js">');
  assert.ok(hub > html.indexOf('<script src="chat-core.js">') && hub < html.indexOf('<script src="chat-ui.js">'));
  const ui = fs.readFileSync(path.join(__dirname, '..', 'chat-ui.js'), 'utf8');
  assert.match(ui, /C\.shownReply\(reply, said, window\.HubCore && window\.HubCore\.cleanReply, turn\.user\)/);
  // the rules themselves are called, with what the user wrote
  const calls = [];
  assert.equal(C.shownReply('a\r\nb', 'said', (text, said, prompt) => { calls.push([text, said, prompt]); return 'cleaned'; }, 'asked'), 'cleaned');
  assert.deepEqual(calls, [['a\nb', 'said', 'asked']]);
  // without them (a column that is not cleaned) the reply is shown as saved
  assert.equal(C.shownReply('❯ ls\nfile', 'ls'), '❯ ls\nfile');
  assert.equal(C.shownReply(undefined, '', Hub.cleanReply), '');
});

test('real 队长 replies lose their terminal residue and keep every sentence', () => {
  for (const turn of captainTurns.filter((t) => !t.kind)) assert.doesNotMatch(shown(turn.reply), RESIDUE, turn.id);
  assert.equal(shown(captainTurns.find((t) => t.id === 'f-quiet').reply), '');
  assert.match(shown(captain.WHY), /^已按你说的换人[\s\S]*要重派。$/);
  assert.match(shown(captain.BUG), /^你说得对，这是严重 bug[\s\S]*手机对话页修整）。$/);
  assert.match(shown(captain.STEPS), /^你说得对，不需要等你回家[\s\S]*失败自动回滚。$/);
  // a reply that begins inside a diff tail: its first row lost its indent to the trim and goes with the rest
  assert.match(shown(captain.TABLE), /^那边尤其靠它。/);
  assert.equal(shown('上），用户未反对\n    25\n    26 +- 一行改动\n\n收到。'), '收到。');
  // an ordinary first paragraph is never mistaken for one
  for (const text of ['第一行\n  3 件事都做完了\n\n第二段', '1. 第一步\n2. 第二步\n    - 缩进的子项', '结论：\n    npm test']) assert.equal(shown(text), text);
});

test('a reply read from the middle of your own echoed message opens with 队长\'s words, not yours', () => {
  const late = captainTurns.find((t) => t.id === 'f-late');
  // as saved: the end of the message you sent while 队长 was busy, then the reply
  assert.ok(late.reply.startsWith(captain.LATE_TAIL) && late.user.endsWith(captain.LATE_TAIL));
  const text = shown(late.reply, late.user);
  assert.match(text, /^先更正一处\n\n之前我说那张卡/);
  assert.ok(!text.includes('印象里是有的'));
  assert.match(text, /等预习材料的格式定下来就派。$/);
  // without the turn's own message nothing is taken for an echo
  assert.ok(shown(late.reply).startsWith(captain.LATE_TAIL));
});

test('a reply drawn as plain rows gets its titles, lists and tables back', () => {
  const md = (reply) => C.tidyReply(shown(reply));
  const html = (reply) => C.renderMarkdown(md(reply), { breaks: true });
  // short lines standing alone are section titles; a sentence is not
  assert.deepEqual(md(captain.WHY).split('\n').filter((l) => l.startsWith('### ')), ['### 为什么一晚上没更新到 1.2', '### 昨晚 21:00 到凌晨 4:00 做完的活（约 55 张卡）', '### 没做成的']);
  assert.doesNotMatch(md(captain.WHY), /### 已按你说的/);
  // nested items nest, and stay inside their parent
  assert.match(html(captain.WHY), /<li>AgentDeck 修复和功能：<ul><li>重启后旧回执重发<\/li><li>派活前看额度自动换模型<\/li><li>看板拖到“进行中”自动开会话<\/li><li>自动验收闭环<\/li><\/ul><\/li><li>AgentDeck 发版：/);
  assert.match(html(captain.BUG), /<li>机制照你说的改：<ul><li>哪个席位用尽就跳过哪个[^<]*<\/li><li>[^<]*<\/li><li>[^<]*<\/li><\/ul><\/li><li>你问是不是换到了/);
  // an item the terminal wrapped is one item, numbered 1 to 4 in one list
  const steps = html(captain.STEPS);
  assert.equal(steps.match(/<ol>/g).length, 1);
  assert.match(steps, /<li>Mac 先装带多机支持的新版：/);
  assert.equal(steps.match(/<li>/g).length, 4);
  // records repeating the same keys are a table again, the glued third record included
  const progress = md(captain.PROGRESS);
  assert.ok(progress.includes('| 版本 | Mac | Windows | 手机网页 | 主要内容 |'));
  assert.ok(progress.includes('| 1.2.1 | 14:04 装上 | 已升 | 已上线 | 安装防死循环、席位轮换跳过用尽席位、监听不再空转、手机对话页气泡、手机页面单独部署 |'));
  assert.ok(progress.includes('| 1.2.2 | 15:20 装上 | 还没升 | 已上线 | Relay 交接重构、看板星图外观、“指令送不进去”修复 |'));
  // a reply drawn two columns in: the indent is gone, the wrapped item is whole, a title sits right over its list
  assert.match(progress, /^### 今天已经落地的\n/);
  assert.ok(progress.includes('\n### 额度\n- Claude：CN'));
  assert.match(html(captain.PROGRESS), /<li>1\.2\.2 收尾（Cursor Grok）：合回 main、打标签、Windows 升到 1\.2\.2。已经动了 11 个文件，正在等一条命令跑完。<\/li>/);
  assert.equal(html(captain.PROGRESS).match(/<table>/g).length, 1);
  // rows of │ cells glued onto one line
  assert.ok(md(captain.TABLE).includes('| UI 任务 | 状态 |\n| --- | --- |\n| 桌面额度区改版 | 已做完并推送到分支 feat/quota-panel-compact |\n| 终端架构图重做 | 刚重开，Opus·CN |'));
  assert.match(html(captain.TABLE), /<li>Sonnet 还没开出来：任务卡还挂在 Grok 名下，/);
  // a line that leads into a list ("…：") stays a sentence
  assert.doesNotMatch(md(captain.TABLE), /### 额度：/);
});

test('what is not a title, a table or a record is left as the agent wrote it', () => {
  for (const text of ['好的', '能实现，而且就该这么做。\n\n为什么能单独上线', 'node scripts/release.js 1.2 --dry-run\n\n跑完告诉你。', '看 docs/chat-view.md\n\n里面有说明。',
    '版本: 1.2.0\n\n只有这一条。', 'npm test\n\n- a\n- b', '```\n没做成的\n\n  缩进的代码\n```\n\n后面的话。', '名称: a: b\n名称: c']) assert.equal(C.tidyReply(text), text);
  assert.equal(C.tidyReply('Summary\n- one\n- two'), '### Summary\n- one\n- two');
  assert.equal(C.tidyReply('第一段。\n\n小结\n\n第二段。'), '第一段。\n\n### 小结\n\n第二段。');
  // a title right above its paragraph; a few short lines in a row are not titles
  assert.equal(C.tidyReply('先说结论。\n\n监听优化（Codex Sol）\n你理解得对：队员干完自动通知我，这条本来就有。\n- 改成由程序盯队员'), '先说结论。\n\n### 监听优化（Codex Sol）\n你理解得对：队员干完自动通知我，这条本来就有。\n- 改成由程序盯队员');
  assert.equal(C.tidyReply('前言。\n\n张三\n李四\n王五'), '前言。\n\n张三\n李四\n王五');
  assert.equal(C.tidyReply(null), '');
  // records with different keys, or only one of them, are not a table
  assert.equal(C.tidyReply('版本: 1\nMac: 好\n版本: 2\n手机: 好'), '版本: 1\nMac: 好\n版本: 2\n手机: 好');
  // a cell with a bar in it stays one cell
  assert.match(C.renderMarkdown(C.tidyReply('键: a|b\n值: 1\n键: c\n值: 2')), /<td>a\|b<\/td><td>1<\/td>/);
});

test('lists: wrapped items, nesting, numbers that carry on, and what ends a list', () => {
  assert.equal(C.renderMarkdown('- a\n  - b\n    - c\n  - d\n- e'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>');
  assert.equal(C.renderMarkdown('1. a\n\n2. b\n   more\n3) c'), '<ol><li>a</li><li>b more</li><li>c</li></ol>');
  assert.equal(C.renderMarkdown('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(C.renderMarkdown('- a\n1. b'), '<ul><li>a</li></ul>\n<ol><li>b</li></ol>');
  assert.equal(C.renderMarkdown('- 中文\n  续行\n后面的话'), '<ul><li>中文续行</li></ul>\n<p>后面的话</p>');
  assert.equal(C.renderMarkdown('- a\n\n段落'), '<ul><li>a</li></ul>\n<p>段落</p>');
  // a table right under a sentence is still a table, wrapped so it can scroll on its own
  assert.equal(C.renderMarkdown('看表\n| a | b |\n|---|---|\n| 1 |'), '<p>看表</p>\n<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td></td></tr></tbody></table></div>');
});

test('a line the terminal broke gets its space back only where one was', () => {
  assert.equal(C.joinGap('已经动了 11', '个文件'), ' ');
  assert.equal(C.joinGap('挂在 Grok', '名下'), ' ');
  assert.equal(C.joinGap('这是一段中文', '继续的内容'), '');
  assert.equal(C.joinGap('见 AgentDeck', '，然后'), '');
  assert.equal(C.joinGap('“指令送不进去”', '修复'), '');
  assert.equal(C.joinGap('first', 'second'), ' ');
  assert.equal(C.joinGap('', 'x'), '');
  const wide = '查清服务器上的现状和这台电脑在不在线以及现在手机是经哪条路连到 Windows';
  assert.equal(C.reflow([wide, '的。'], C.visibleWidth(wide) + 2)[0], wide + ' 的。');
});

test('a table the TUI drew with box lines is saved as a Markdown table, wrapped cells whole', () => {
  const screen = ['> 进度', '', '⏺ 两件事的状态：', '',
    '  ┌──────────────┬──────────────────────┐', '  │ 任务         │ 状态                 │', '  ├──────────────┼──────────────────────┤',
    '  │ 桌面额度区   │ 已做完并推送到分支   │', '  │ 改版         │ feat/quota-panel     │', '  ├──────────────┼──────────────────────┤',
    '  │ 架构图重做   │ 刚重开               │', '  └──────────────┴──────────────────────┘', '', '  其他的我先不动。',
    '', '────────────────────────', ' > ', '────────────────────────', '  ? for shortcuts'];
  assert.equal(C.extractReply(screen, '进度', 44), '两件事的状态：\n\n| 任务 | 状态 |\n| --- | --- |\n| 桌面额度区改版 | 已做完并推送到分支 feat/quota-panel |\n| 架构图重做 | 刚重开 |\n\n其他的我先不动。');
  // cut off by the screen edge, or not a table at all: left as it was
  assert.equal(C.extractReply(['表：', '┌─────┬─────┐', '│ a   │ b   │'], 'x', 80), '表：\n│ a   │ b   │');
  assert.equal(C.extractReply(['框：', '┌───────────┐', '│ 不是表格  │', '└───────────┘'], 'x', 80), '框：\n│ 不是表格  │');
});

test('a web task card keeps its queued/running phase and drops anything else', () => {
  const card = (webPhase) => C.normalizeChat({ turns: [{ user: 'q', kind: 'task', task: { title: 'q', status: 'working', webPhase } }] }, 'x').turns[0].task;
  assert.equal(card('queued').webPhase, 'queued');
  assert.equal(card('running').webPhase, 'running');
  assert.equal('webPhase' in card('later'), false);
  assert.equal('webPhase' in card(undefined), false);
});
