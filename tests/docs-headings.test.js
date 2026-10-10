'use strict';
// A doc that was stitched together wrongly shows up as a second top-level heading, a repeated section, or a
// "# heading" run into the middle of a line: the board API doc once got its first 485 lines pasted in twice.
// Every .md under docs/ is read, subfolders included (docs/captain/ holds the Captain's rules). Lines inside
// ``` or ~~~ fences are not headings; a fence closes with the same character, at least as many of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DOCS = path.resolve(__dirname, '../docs');

// docs-relative paths with forward slashes, every .md at any depth
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : entry.name.endsWith('.md') ? [path.relative(DOCS, full).split(path.sep).join('/')] : [];
});

// Each line of a doc outside the fences, as { text, line }, and the line of a fence still open at the end of
// the file (null when every fence was closed: a forgotten closing fence would hide the rest of the file).
// A fence opens with at most 3 spaces in front of it, as Markdown has it.
function scan(file, root = DOCS) {
  let fence = null;
  const kept = [];
  fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).forEach((text, i) => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (fence) {
      if (open && open[1][0] === fence.char && open[1].length >= fence.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(text)) fence = null;
      return;
    }
    if (open) { fence = { char: open[1][0], length: open[1].length, line: i + 1 }; return; }
    kept.push({ text, line: i + 1 });
  });
  return { lines: kept, openFence: fence ? fence.line : null };
}
const proseLines = (file, root) => scan(file, root).lines;

// A heading may be indented by up to 3 spaces.
const headings = (file, root) => proseLines(file, root).flatMap(({ text, line }) => {
  const m = /^ {0,3}(#{1,2}) (.*\S)\s*$/.exec(text);
  return m ? [{ level: m[1].length, text: m[2], line }] : [];
});

// "...。## 标题": a heading whose line break was lost, so its ## sits right after the end of a sentence (a full
// stop, comma, closing bracket or quote) or after a Chinese character. Only that: "C# 语言", "5 # 3", "> # 引用",
// "- # 列表", a "# 号" in the middle of prose, a "# note" in an HTML comment or a legal heading indented by 1 to 3
// spaces are ordinary text. Inline code, table rows and indented (4+ spaces) code blocks are left alone.
const GLUED_HEADING = /(?:[\p{Script=Han}。！？；：，、.!?;:,)）\]】」』”’"'])#{2,6} \S/u;
const stitchedLines = (prose) => prose.flatMap(({ text, line }) => {
  if (/^(?: {4,}|\t)/.test(text)) return [];
  const plain = text.replace(/`[^`]*`/g, '``');
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(plain) || /^\s*\|/.test(plain)) return [];
  const m = GLUED_HEADING.exec(plain);
  return m ? [{ line, near: plain.slice(Math.max(0, m.index - 10), m.index + 40) }] : [];
});
const stitched = (file, root) => stitchedLines(proseLines(file, root));

// every docs/**/*.md, the board API doc first
const COVERED = ['task-board-api.md', ...walk(DOCS).filter((f) => f !== 'task-board-api.md')];

for (const file of COVERED) {
  test(`docs/${file}: exactly one top-level heading, no repeated second-level heading, no heading run into a line`, () => {
    const found = headings(file);
    const tops = found.filter((h) => h.level === 1);
    assert.equal(tops.length, 1, `top-level headings: ${tops.map((h) => `line ${h.line} "${h.text}"`).join(', ')}`);
    const seen = new Map();
    for (const h of found.filter((x) => x.level === 2)) {
      assert.ok(!seen.has(h.text), `"## ${h.text}" at line ${h.line} repeats line ${seen.get(h.text)}`);
      seen.set(h.text, h.line);
    }
    const joined = stitched(file);
    assert.deepEqual(joined, [], `a heading run into the middle of a line: ${joined.map((j) => `line ${j.line} "${j.near}"`).join(', ')}`);
    assert.equal(scan(file).openFence, null, `the code fence opened at line ${scan(file).openFence} is never closed, so the rest of the file was not checked`);
  });
}
test('the board API doc is always covered, and so are the Captain rule files in docs/captain/', () => {
  assert.equal(COVERED[0], 'task-board-api.md');
  assert.ok(COVERED.filter((f) => f.startsWith('captain/')).length >= 9, 'docs/captain/*.md are scanned');
});

// the scanner itself
test('the scanner reads ~~~ fences, longer fences and mid-line headings', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-docs-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rel = 'x.md';
  fs.writeFileSync(path.join(dir, 'x.md'), [
    '# Title', '~~~', '# not a heading', '~~~', '````', '```', '# still fenced', '```', '````', '## Real', '正文。## 粘连标题', 'a `# code` b', '| a | # b |',
  ].join('\n'));
  assert.deepEqual(headings(rel, dir).map((h) => h.text), ['Title', 'Real']);
  assert.deepEqual(stitched(rel, dir).map((j) => j.line), [11]);
  assert.equal(scan(rel, dir).openFence, null);
});
test('a fence that is never closed is reported, and a fence opens with at most 3 spaces in front', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-docs-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, lines) => { fs.writeFileSync(path.join(dir, name), lines.join('\n')); return name; };
  // forgotten closing fence: the rest of the file is hidden, so the scan says where it opened
  const open = write('open.md', ['# Title', 'text', '```js', '## hidden', '## hidden']);
  assert.equal(scan(open, dir).openFence, 3);
  assert.deepEqual(headings(open, dir).map((h) => h.text), ['Title']);
  // a longer fence is not closed by a shorter one, and a closing fence may not carry words
  assert.equal(scan(write('short.md', ['# T', '````', '```', '```js']), dir).openFence, 2);
  assert.equal(scan(write('closed.md', ['# T', '```', 'x', '```']), dir).openFence, null);
  // 3 spaces still open a fence; 4 spaces are an indented code block, not a fence
  const three = write('three.md', ['# T', '   ```', '# not a heading', '   ```', '## Real']);
  assert.deepEqual(headings(three, dir).map((h) => h.text), ['T', 'Real']);
  assert.equal(scan(three, dir).openFence, null);
  const four = write('four.md', ['# T', '    ```', '## Real', 'tail']);
  assert.deepEqual(headings(four, dir).map((h) => h.text), ['T', 'Real']);
  assert.equal(scan(four, dir).openFence, null);
});

// Ordinary lines that carry a # are not a glued heading, one case each.
for (const [name, text] of [
  ['a quoted heading', '> # 引用里的标题'], ['a heading inside a list item', '- # 列表里的标题'], ['C# the language', '用 C# 语言写'],
  ['a # sign opening a word', '标题用 # 号开头'], ['"# 号" in Chinese quotes', '「# 号开头」'], ['a number sign between numbers', '5 # 3'],
  ['a comment in an indented code block', '    # 注释'], ['a comment in a tab-indented code block', '\t## 注释'], ['a # in an HTML comment', '<!-- # 备注 -->'],
  ['a heading indented by 1 space', ' ## 合法标题'], ['a heading indented by 3 spaces', '   ## 合法标题'], ['a # in inline code', '用 `句末。## 标题` 表示'],
  ['a # in a table row', '| a | 汉字## b |'], ['an issue number', '见 #12 和 汉字#12'], ['a link anchor', '[x](a.md#sec) 和 [y](b.md#sec)'],
]) {
  test(`not a glued heading: ${name}`, () => assert.deepEqual(stitchedLines([{ text, line: 1 }]), [], text));
}
test('a heading glued to the end of a sentence or to a Chinese character is reported', () => {
  for (const text of ['正文。## 粘连标题', '汉字## 标题', '句末.## Title', '结束！### 小节', '见（附录）## 附录', '他说「好」## 下一节', 'ends here;## Next'])
    assert.equal(stitchedLines([{ text, line: 7 }]).length, 1, text);
  assert.equal(stitchedLines([{ text: '一句话。## 标题', line: 7 }])[0].line, 7);
});
