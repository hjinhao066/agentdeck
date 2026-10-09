'use strict';
// renderer.js findLinks runs on a terminal's whole logical line each time the
// mouse moves onto a row (xterm's link provider), and on every line of a reply
// in the chat view and the Artifacts page. A long unbroken run of path-like
// characters (a base64 blob, a hash, a long word, a slash-separated list) made
// the relative-path pattern backtrack quadratically: 20,000 characters froze
// the window for about 3.4 s, 100,000 for over a minute. A run with a dot and
// a letter in it (a JWT, "x…x.y", a dotted version list) still did after the
// first fix: 20,000 characters took 12-34 s, so terminal scrollback stalled.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const start = source.indexOf('function trimTrail(');
const end = source.indexOf('function openLink(');
assert.ok(start >= 0 && end > start, 'renderer.js still defines trimTrail and findLinks');
const load = (platform) => new Function('env', source.slice(start, end) +
  "\nreturn { findLinks, relativeLinks: typeof relativeLinks === 'function' ? relativeLinks : null };")({ platform });
const { findLinks, relativeLinks } = load('darwin');
// A JWT-like token: three base64url parts joined by dots.
function jwt(length) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let seed = 7, s = '';
  while (s.length < length) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; s += abc[seed % 64]; }
  const third = Math.floor(length / 3);
  return s.slice(0, third) + '.' + s.slice(third, 2 * third) + '.' + s.slice(2 * third);
}

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
  ['a 20,000-character token ending in ".y"', 'x'.repeat(20000) + '.y'],
  ['a 20,000-character JWT-like token', jwt(20000)],
  ['20,000 characters of "a."', 'a.'.repeat(10000)],
  ['a long list of dotted versions', 'v1.2.3-'.repeat(3000)],
  ['a long dotted path', 'a.b/'.repeat(5000) + 'c.js:12'],
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

test('relative links are exactly the matches of the pattern findLinks used before', () => {
  // The old pattern backtracked across a whole run from every position;
  // relativeLinks must find the same matches in one pass.
  const relRe = /(?:\.{1,2}\/)?(?:[\w.+@%-]+\/)+[\w+@%-][\w.+@%-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?|[\w+@%-][\w.+@%-]*\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?/g;
  const oracle = (run) => { const out = []; let m; relRe.lastIndex = 0; while ((m = relRe.exec(run))) out.push({ index: m.index, text: m[0] }); return out; };
  assert.equal(typeof relativeLinks, 'function', 'renderer.js finds relative links without the backtracking pattern');
  let seed = 1;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  for (const abc of ['ab1._/:', 'aZ9_.-/:+@%', 'x.y:12/', 'abcdefghij.0123456789/:_-']) {
    for (let t = 0; t < 5000; t++) {
      let run = '';
      for (let i = rnd(40); i > 0; i--) run += abc[rnd(abc.length)];
      assert.deepEqual(relativeLinks(run), oracle(run), JSON.stringify(run));
    }
  }
});

test('Windows paths are still found on Windows', () => {
  const win = load('win32').findLinks;
  assert.deepEqual(win('at C:\\Users\\me\\proj\\file.js:12 ok').map((m) => m.text), ['C:\\Users\\me\\proj\\file.js:12']);
});
