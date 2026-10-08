'use strict';
// renderer.js findLinks runs on a terminal's whole logical line each time the
// mouse moves onto a row (xterm's link provider), and on every line of a reply
// in the chat view and the Artifacts page. A long unbroken run of path-like
// characters (a base64 blob, a hash, a long word, a slash-separated list) made
// the relative-path pattern backtrack quadratically: 20,000 characters froze
// the window for about 3.4 s, 100,000 for over a minute.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const start = source.indexOf('function trimTrail(');
const end = source.indexOf('function openLink(');
assert.ok(start >= 0 && end > start, 'renderer.js still defines trimTrail and findLinks');
const load = (platform) => new Function('env', source.slice(start, end) + '\nreturn findLinks;')({ platform });
const findLinks = load('darwin');

const BUDGET_MS = 1000;
function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

for (const [name, text] of [
  ['a 40,000-character word', 'x'.repeat(40000)],
  ['a base64 blob', 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAA+/'.repeat(1600)],
  ['a long slash-separated run', 'a/'.repeat(20000)],
  ['a long absolute-looking run', '/a'.repeat(20000)],
  ['a 40,000-character URL', 'https://example.com/' + 'c'.repeat(40000)],
]) {
  test(`findLinks on ${name} finishes in linear time`, () => {
    findLinks('/warm/up.js:1');
    const { ms } = timed(() => findLinks(text));
    assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`);
  });
}

test('links found in ordinary lines are unchanged', () => {
  // Exactly what findLinks returned before the change, quirks included.
  const kinds = (text) => findLinks(text).map((m) => `${m.kind}:${m.text}@${m.start}`);
  assert.deepEqual(kinds('see src/renderer.js:406 and main.js:12 now'), ['file:src/renderer.js:406@4', 'file:main.js:12@28']);
  assert.deepEqual(kinds('open /Users/me/My Project/a.md 这里'), ['file:/Users/me/My Project/a.md 这里@5']);
  assert.deepEqual(kinds('https://example.com/a/b.js?x=1, then ./lib/x.ts'), ['url:https://example.com/a/b.js?x=1@0', 'file:./lib/x.ts@37']);
  assert.deepEqual(kinds('"file":"src/a.js:10","n":1.5'), ['file:src/a.js:10@8']);
  assert.deepEqual(kinds('x/~src/a.js and node.js or and/or'), ['file:/~src/a.js and node.js or and/or@1']);
  assert.deepEqual(kinds('a+src/b.js q@r/s.txt'), ['file:/b.js q@r/s.txt@5']);
  assert.deepEqual(kinds('~/notes/todo.md:3:7'), ['file:~/notes/todo.md:3:7@0']);
  assert.deepEqual(kinds('build/out/app.min.js.map'), ['file:/out/app.min.js.map@5']);
  assert.deepEqual(kinds('ok main.js:1, b.ts:22 x'), ['file:main.js:1@3', 'file:b.ts:22@14']);
});

test('Windows paths are still found on Windows', () => {
  const win = load('win32');
  assert.deepEqual(win('at C:\\Users\\me\\proj\\file.js:12 ok').map((m) => m.text), ['C:\\Users\\me\\proj\\file.js:12']);
});
