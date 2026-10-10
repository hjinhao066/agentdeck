'use strict';
// A doc that was stitched together wrongly shows up as a second top-level heading or a repeated section:
// the board API doc once got its first 485 lines pasted in twice. Lines inside ``` fences are not headings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOCS = path.resolve(__dirname, '../docs');
const headings = (file) => {
  let fenced = false;
  const found = [];
  fs.readFileSync(path.join(DOCS, file), 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    const m = !fenced && /^(#{1,2}) (.*\S)\s*$/.exec(line);
    if (m) found.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return found;
};

// every docs/*.md, the board API doc first
const COVERED = ['task-board-api.md', ...fs.readdirSync(DOCS).filter((f) => f.endsWith('.md') && f !== 'task-board-api.md')];

for (const file of COVERED) {
  test(`docs/${file}: exactly one top-level heading and no repeated second-level heading`, () => {
    const found = headings(file);
    const tops = found.filter((h) => h.level === 1);
    assert.equal(tops.length, 1, `top-level headings: ${tops.map((h) => `line ${h.line} "${h.text}"`).join(', ')}`);
    const seen = new Map();
    for (const h of found.filter((x) => x.level === 2)) {
      assert.ok(!seen.has(h.text), `"## ${h.text}" at line ${h.line} repeats line ${seen.get(h.text)}`);
      seen.set(h.text, h.line);
    }
  });
}
test('the board API doc is always covered', () => assert.equal(COVERED[0], 'task-board-api.md'));
