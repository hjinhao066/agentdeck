'use strict';
// Bug hunt ④ #8 (2.0.4 features, 路径链接识别): a Chinese file name that holds 《》 or 『』 is cut at the
// mark since d8aeb91 (t-path-links) made every Chinese bracket a place where a path ends. The link
// then covers only the folder in front of it, so a click opens that folder, not the file the agent
// named. Before d8aeb91 the same lines linked the whole file. A mark that opens right after a "/" (or
// one that closes a mark opened inside the same name) is part of the name; a path still ends at the
// Chinese punctuation that follows it (，。；：、 and the rest, tests/path-links.test.js).
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
  ['已写好 /Users/me/读书/《三体》笔记.md', ['/Users/me/读书/《三体》笔记.md']],
  ['报告在 /Users/me/书/『红楼梦』.pdf 写好了', ['/Users/me/书/『红楼梦』.pdf']],
  ['/Users/me/reports/《AgentDeck》2.0.5 说明.md，请看', ['/Users/me/reports/《AgentDeck》2.0.5 说明.md']],
  // the stops after a path still hold, and a title mark round the path or glued after it is prose
  ['详见 /Users/me/a/README.md。最急的两件：', ['/Users/me/a/README.md']],
  ['见《/Users/me/a/b.md》', ['/Users/me/a/b.md']],
  ['见 /Users/me/a/b.md《使用说明》', ['/Users/me/a/b.md']],
  ['目录 /Users/me/a/docs 《说明》', ['/Users/me/a/docs']],
];

for (const platform of ['darwin', 'win32']) {
  const find = load(platform);
  for (const [line, want] of CASES) {
    test(`${platform}: ${line}`, () => assert.deepEqual(texts(find, line), want));
  }
}

test('Windows: a C:\\ path whose file name holds 《》 is linked whole', () => {
  const line = '已写好 C:\\Users\\hjinh\\读书\\《三体》笔记.md，请看';
  assert.deepEqual(texts(load('win32'), line), ['C:\\Users\\hjinh\\读书\\《三体》笔记.md']);
});
