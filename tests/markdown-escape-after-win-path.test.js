'use strict';
// Bug hunt ④ #16 (2.0.4 features, 路径链接识别): d8aeb91 keeps the backslashes of a Windows path in the
// shared Markdown renderer (mobile-web/hub/core.js inline(), used by the desktop chat bubbles and both
// phone pages): an escape inside a "C:\…" path is left alone. The path's extent (WIN_PATH) lets single
// spaces through, so it runs on over the rest of the line, and every Markdown escape written after the
// path on that line stops working: "\*" shows its backslash, "\[x\](y)" turns into a broken link text.
// Before d8aeb91 the same lines rendered "*不是斜体*" and "[x](y)". Any reply that names a Windows path
// (on either computer) and escapes something later on the same line.
const test = require('node:test');
const assert = require('node:assert/strict');
const Hub = require('../mobile-web/hub/core.js');

const render = (s) => Hub.renderMarkdown(s, { breaks: true });

test('an escaped star after a Windows path on the same line is still an escape', () => {
  assert.equal(render('见 C:\\Users\\me\\a.md 里 \\*不是斜体\\*'), '<p>见 C:\\Users\\me\\a.md 里 *不是斜体*</p>');
});

test('escaped brackets after a Windows path stay brackets', () => {
  assert.equal(render('用 C:\\a\\b.md 和 \\[x\\](y)'), '<p>用 C:\\a\\b.md 和 [x](y)</p>');
});

test('escaped underscores after a Windows path stay underscores', () => {
  assert.equal(render('Path C:\\x\\y and \\_name\\_ here'), '<p>Path C:\\x\\y and _name_ here</p>');
});

test('an escape right after the space that ends a Windows path is still an escape', () => {
  assert.equal(render('改了 C:\\a\\b.md \\*注意\\*'), '<p>改了 C:\\a\\b.md *注意*</p>');
});

test('control: the path itself keeps its backslashes, also with a space in a folder name', () => {
  for (const p of ['C:\\Users\\hjinh\\.claude\\settings.json', 'C:\\Program Files\\AgentDeck\\_x.md', 'C:\\Users\\My Docs\\.claude\\a.json', 'D:\\work\\_backup\\a.json']) {
    const html = render(`改好了：${p}；改前的备份在同目录`);
    assert.ok(html.includes(p), html);
  }
});
