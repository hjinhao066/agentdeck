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

test('chats are normalised and capped', () => {
  const raw = { turns: Array.from({ length: 450 }, (_, i) => ({ id: 't' + i, ts: i, user: 'q' + i, reply: 'a' + i, done: true })) };
  raw.turns.push({ user: 5 }, null);
  const chat = C.normalizeChat(raw, 'c1');
  assert.equal(chat.turns.length, C.MAX_TURNS);
  assert.equal(chat.turns[chat.turns.length - 1].user, 'q449');
  assert.deepEqual(C.normalizeChat('nope', 'c2'), { v: 1, id: 'c2', turns: [] });
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
