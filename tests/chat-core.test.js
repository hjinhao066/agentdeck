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
