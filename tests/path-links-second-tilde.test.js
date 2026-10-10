'use strict';
// Bug hunt ④ #15 (2.0.4 features, 路径链接识别): README promises "a path ends at ... the space before the
// words after it, so two paths on one line are two links". A second path that starts with "~/" breaks
// that: findLinks' pattern lets a single space through when a "~" follows (only " /" stops it), so
//   - after a folder or a file without an extension, the "~/…" path is merged into the first link
//     ("改了 ~/agentdeck/docs 和 ~/agentdeck/tests" is one link; pathEnd cuts at a Chinese word only
//     in the last name, and "docs 和 ~" is not the last name);
//   - after a relative path ("./a.md", "src/a.js"), the match that starts inside it is skipped as
//     "the tail of something else" with everything it swallowed, so the "~/…" path is not linked.
// "/…" paths on the same lines are fine: " /" stops the pattern.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const start = source.indexOf('function trimTrail(');
const end = source.indexOf('function openLink(');
const load = (platform) => new Function('env', source.slice(start, end) + '\nreturn findLinks;')({ platform });
const texts = (find, line) => find(line).sort((a, b) => a.start - b.start).map((m) => m.text);

const CASES = [
  ['改了 ~/agentdeck/docs 和 ~/agentdeck/tests', ['~/agentdeck/docs', '~/agentdeck/tests']],
  ['见 ~/reports/x 目录和 ~/reports/y 目录', ['~/reports/x', '~/reports/y']],
  ['/Users/me/a/Makefile 和 ~/b/c.md', ['/Users/me/a/Makefile', '~/b/c.md']],
  ['see ./a.md and ~/b/c.md', ['./a.md', '~/b/c.md']],
  ['改了 src/a.js 和 ~/notes/b.md', ['src/a.js', '~/notes/b.md']],
  // control: the same lines with "/…" second paths already work
  ['改了 /Users/me/agentdeck/docs 和 /Users/me/agentdeck/tests', ['/Users/me/agentdeck/docs', '/Users/me/agentdeck/tests']],
  ['see ./a.md and /Users/me/b/c.md', ['./a.md', '/Users/me/b/c.md']],
];

for (const platform of ['darwin', 'win32']) {
  const find = load(platform);
  for (const [line, want] of CASES) {
    test(`${platform}: ${line}`, () => assert.deepEqual(texts(find, line), want));
  }
}
