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

// Each line of a doc outside the fences, as { text, line }.
function proseLines(file, root = DOCS) {
  let fence = null;
  const kept = [];
  fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).forEach((text, i) => {
    const open = /^\s*(`{3,}|~{3,})/.exec(text);
    if (fence) {
      if (open && open[1][0] === fence.char && open[1].length >= fence.length && /^\s*(`{3,}|~{3,})\s*$/.test(text)) fence = null;
      return;
    }
    if (open) { fence = { char: open[1][0], length: open[1].length }; return; }
    kept.push({ text, line: i + 1 });
  });
  return kept;
}

const headings = (file, root) => proseLines(file, root).flatMap(({ text, line }) => {
  const m = /^(#{1,2}) (.*\S)\s*$/.exec(text);
  return m ? [{ level: m[1].length, text: m[2], line }] : [];
});

// "...。## 标题" or "text # Title": a heading whose line break was lost. Inline code and table rows are left alone
// (a table cell or a shell comment may carry a #).
const stitched = (file, root) => proseLines(file, root).flatMap(({ text, line }) => {
  const plain = text.replace(/`[^`]*`/g, '``');
  if (/^#{1,6}\s/.test(plain) || /^\s*\|/.test(plain)) return [];
  const m = /\S\s*#{1,6} \S/.exec(plain);
  return m ? [{ line, near: plain.slice(Math.max(0, m.index - 10), m.index + 40) }] : [];
});

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
});
