'use strict';
// File paths in terminal output and in chat replies become links through
// renderer.js findLinks (the xterm link provider and ChatUI.linkify both call
// it). A path ends at Chinese punctuation, full-width characters and white
// space; a space stays only inside a folder name ("Application Support") or a
// file name that reads as one ("截屏2026-10-09 下午3.04.12.png"). Two paths on
// one line are two links. The chat view renders Markdown first: a Windows path
// keeps its backslashes ("\.claude" is not an escaped dot).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Hub = require('../mobile-web/hub/core.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const start = source.indexOf('function trimTrail(');
const end = source.indexOf('function openLink(');
assert.ok(start >= 0 && end > start, 'renderer.js still defines trimTrail and findLinks');
const load = (platform) => new Function('env', source.slice(start, end) + '\nreturn findLinks;')({ platform });
const mac = load('darwin'), win = load('win32');
const texts = (find, line) => find(line).sort((a, b) => a.start - b.start).map((m) => m.text);
// every link's text is exactly what its range covers
const ranges = (find, line) => find(line).forEach((m) => assert.equal(line.slice(m.start, m.end), m.text, line));

const MAC = [
  ['详见 /Users/jinhao/agentdeck/README.md。最急的两件：', ['/Users/jinhao/agentdeck/README.md']],
  ['改了 /Users/jinhao/agentdeck/renderer.js 里的 findLinks', ['/Users/jinhao/agentdeck/renderer.js']],
  ['open /Users/me/My Project/a.md 这里', ['/Users/me/My Project/a.md']],
  ['/Users/jinhao/a/one.md 和 /Users/jinhao/b/two.md', ['/Users/jinhao/a/one.md', '/Users/jinhao/b/two.md']],
  ['see /Users/x/a.md and /Users/x/b.md', ['/Users/x/a.md', '/Users/x/b.md']],
  ['/Users/jinhao/a/one.md、/Users/jinhao/b/two.md', ['/Users/jinhao/a/one.md', '/Users/jinhao/b/two.md']],
  ['/Users/jinhao/a/one.md, /Users/jinhao/b/two.md', ['/Users/jinhao/a/one.md', '/Users/jinhao/b/two.md']],
  ['见 /Users/jinhao/Library/Application Support/agentdeck/config.json；改前的备份在同目录',
    ['/Users/jinhao/Library/Application Support/agentdeck/config.json']],
  ['配置在 ~/Library/Application Support/agentdeck/config.json 里，备份 ~/Library/Application Support/agentdeck/config.json.bak',
    ['~/Library/Application Support/agentdeck/config.json', '~/Library/Application Support/agentdeck/config.json.bak']],
  ['文件：~/notes/todo.md，另一个 ~/notes/done.md；还有', ['~/notes/todo.md', '~/notes/done.md']],
  ['~/.agents/memory/MEMORY.md：索引', ['~/.agents/memory/MEMORY.md']],
  ['“/Users/jinhao/x/y.md”和‘/Users/jinhao/x/z.md’', ['/Users/jinhao/x/y.md', '/Users/jinhao/x/z.md']],
  ['（/Users/jinhao/x/y.md）', ['/Users/jinhao/x/y.md']],
  ['/Users/jinhao/x/a.md里面写了', ['/Users/jinhao/x/a.md']],
  ['/Users/jinhao/x/y.md　全角空格后面', ['/Users/jinhao/x/y.md']],
  ['/Users/jinhao/x/y.md——这是说明', ['/Users/jinhao/x/y.md']],
  ['报告 /Users/jinhao/reports/v2.0.3版本说明.md 写好了', ['/Users/jinhao/reports/v2.0.3版本说明.md']],
  // a file name that holds spaces is still one link
  ['截图在 /Users/me/Desktop/截屏2026-10-09 下午3.04.12.png', ['/Users/me/Desktop/截屏2026-10-09 下午3.04.12.png']],
  ['/Users/me/Desktop/Screen Shot 2026-10-09 at 10.00.00.png', ['/Users/me/Desktop/Screen Shot 2026-10-09 at 10.00.00.png']],
  ['/Applications/Visual Studio Code.app/Contents/Resources', ['/Applications/Visual Studio Code.app/Contents/Resources']],
  ['/Users/me/My\\ Project/a.md 这里', ['/Users/me/My\\ Project/a.md']],
  ['file:///Users/me/a/b.md 里', ['file:///Users/me/a/b.md']],
  // relative paths stay whole, not linked from their second folder as if absolute
  ['tests/e2e/path-links.spec.js 和 src/lib/a.js:12', ['tests/e2e/path-links.spec.js', 'src/lib/a.js:12']],
  ['build/out/app.min.js.map', ['build/out/app.min.js.map']],
  // a Windows path is not a POSIX path from its first slash
  ['C:/Users/hjinh/a.md', []],
];

const WIN = [
  ['C:\\Users\\hjinh\\.claude\\settings.json；改前的备份在同目录的 settings.json.bak', ['C:\\Users\\hjinh\\.claude\\settings.json']],
  ['C:\\Users\\hjinh\\.claude\\settings.json 改前的备份在同目录的 settings.json.bak', ['C:\\Users\\hjinh\\.claude\\settings.json']],
  ['C:\\Users\\hjinh\\a.json 和 C:\\Users\\hjinh\\b.json', ['C:\\Users\\hjinh\\a.json', 'C:\\Users\\hjinh\\b.json']],
  ['C:\\Users\\hjinh\\a.json, C:\\Users\\hjinh\\b.json', ['C:\\Users\\hjinh\\a.json', 'C:\\Users\\hjinh\\b.json']],
  ['C:\\Users\\hjinh\\a.json、C:\\Users\\hjinh\\b.json；D:\\x\\c.json', ['C:\\Users\\hjinh\\a.json', 'C:\\Users\\hjinh\\b.json', 'D:\\x\\c.json']],
  ['已改 C:\\Users\\hjinh\\AppData\\Roaming\\agentdeck\\config.json，备份在 C:\\Users\\hjinh\\AppData\\Roaming\\agentdeck\\config.json.bak',
    ['C:\\Users\\hjinh\\AppData\\Roaming\\agentdeck\\config.json', 'C:\\Users\\hjinh\\AppData\\Roaming\\agentdeck\\config.json.bak']],
  ['C:\\Users\\hjinh\\agentdeck\\README.md。最急的两件：', ['C:\\Users\\hjinh\\agentdeck\\README.md']],
  ['C:\\Users\\hjinh\\agentdeck\\README.md 里写了', ['C:\\Users\\hjinh\\agentdeck\\README.md']],
  ['路径 C:\\Program Files\\AgentDeck\\AgentDeck.exe 已更新', ['C:\\Program Files\\AgentDeck\\AgentDeck.exe']],
  ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']],
  ['C:/Users/hjinh/proj/file.js:12，然后', ['C:/Users/hjinh/proj/file.js:12']],
  ['at C:\\Users\\me\\proj\\file.js:12:3 ok', ['C:\\Users\\me\\proj\\file.js:12:3']],
  ['C:\\Users\\hjinh\\x\\a.md里面写了', ['C:\\Users\\hjinh\\x\\a.md']],
  ['~/.agents/memory/MEMORY.md：索引', ['~/.agents/memory/MEMORY.md']],
  ['/Users/jinhao/a/one.md 和 /Users/jinhao/b/two.md', ['/Users/jinhao/a/one.md', '/Users/jinhao/b/two.md']],
];

for (const [line, want] of MAC) {
  test(`macOS: ${line}`, () => {
    assert.deepEqual(texts(mac, line), want);
    ranges(mac, line);
  });
}
for (const [line, want] of WIN) {
  test(`Windows: ${line}`, () => {
    assert.deepEqual(texts(win, line), want);
    ranges(win, line);
  });
}

test('the chat view keeps the backslashes of a Windows path, so the link opens the real file', () => {
  for (const p of ['C:\\Users\\hjinh\\.claude\\settings.json', 'C:\\Users\\hjinh\\.agents\\memory\\MEMORY.md', 'D:\\work\\_backup\\a.json']) {
    const html = Hub.renderMarkdown(`改好了：${p}；改前的备份在同目录`, { breaks: true });
    assert.ok(html.includes(p), html);
    const shown = html.replace(/<[^>]+>/g, '');
    assert.deepEqual(texts(win, shown), [p]);
  }
  // escapes elsewhere still work
  assert.equal(Hub.renderMarkdown('1\\. 不是列表 \\*不是斜体\\*'), '<p>1. 不是列表 *不是斜体*</p>');
});

// xterm rows of `cols` cells built the way xterm fills them: a wide glyph takes
// two cells (the second has width 0); one that does not fit in the last column
// goes to the next row and leaves that column empty (''), or holds the space
// Windows' console writes there (' ').
function fakeBuffer(text, cols, pad) {
  const wide = (ch) => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch);
  const rows = [[]];
  for (const ch of text) {
    const w = wide(ch) ? 2 : 1;
    if (rows[rows.length - 1].length + w > cols) {
      while (rows[rows.length - 1].length < cols) rows[rows.length - 1].push({ chars: pad, width: 1 });
      rows.push([]);
    }
    rows[rows.length - 1].push({ chars: ch, width: w });
    if (w === 2) rows[rows.length - 1].push({ chars: '', width: 0 });
  }
  for (const row of rows) while (row.length < cols) row.push({ chars: '', width: 1 });
  const lines = rows.map((cells, i) => ({
    isWrapped: i > 0,
    getCell: (x) => cells[x] && { getWidth: () => cells[x].width, getChars: () => cells[x].chars },
  }));
  return { length: lines.length, getLine: (i) => lines[i] };
}
const wrapped = new Function(source.slice(source.indexOf('function wrappedLineToCells('), start) + '\nreturn wrappedLineToCells;')();

test('a wide character wrapped to the next row adds no space to the line the links are read from', () => {
  const line = 'C:\\Users\\hjinh\\经验学习\\报告.md 和 C:\\Users\\hjinh\\b.json';
  for (const pad of ['', ' ']) {
    for (let cols = 20; cols <= 40; cols++) {
      const got = wrapped(fakeBuffer(line, cols, pad), 0, cols);
      assert.deepEqual(texts(win, got.str), ['C:\\Users\\hjinh\\经验学习\\报告.md', 'C:\\Users\\hjinh\\b.json'], `${cols} columns`);
      assert.equal(got.colOf.length, got.str.length);
    }
  }
  // where nothing wraps before a wide glyph, the line reads back as it was written
  assert.equal(wrapped(fakeBuffer(line, 80, ''), 0, 80).str.trimEnd(), line);
});
