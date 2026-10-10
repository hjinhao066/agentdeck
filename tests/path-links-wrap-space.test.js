'use strict';
// Bug hunt ④ #17 (2.0.4 features, 路径链接识别): d8aeb91 taught wrappedLineToCells (renderer.js) that a wide
// glyph which did not fit in a row's last column leaves that column blank, and drops that column from
// the text the links are read from. It drops it whenever the last cell is blank, including a real
// space the program printed there. On macOS xterm leaves the skipped cell empty (''), while a printed
// space is ' ', so the two can be told apart there. When the space inside "截屏2026-10-09 下午3.04.12.png"
// (a macOS screenshot name, README's own example) lands in the last column and "下" starts the next row,
// the link reads "截屏2026-10-09下午3.04.12.png": a file that does not exist, and the click opens nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const start = source.indexOf('function trimTrail(');
const end = source.indexOf('function openLink(');
const env = { platform: 'darwin' };
const findLinks = new Function('env', source.slice(start, end) + '\nreturn findLinks;')(env);
const wrapped = new Function('env', source.slice(source.indexOf('function wrappedLineToCells('), start) + '\nreturn wrappedLineToCells;')(env);
const texts = (line) => findLinks(line).sort((a, b) => a.start - b.start).map((m) => m.text);

// xterm rows of `cols` cells, filled the way xterm fills them (tests/path-links.test.js): a wide glyph
// takes two cells; one that does not fit goes to the next row and leaves the last column empty ('').
function fakeBuffer(text, cols, pad) {
  const wide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch);
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

test('macOS: a printed space in the last column, before a wide glyph on the next row, stays in the link', () => {
  const file = '/Users/me/Desktop/截屏2026-10-09 下午3.04.12.png';
  const line = '截图在 ' + file;
  const wrong = [];
  for (let cols = 20; cols <= 80; cols++) {
    const got = wrapped(fakeBuffer(line, cols, ''), 0, cols);
    const links = texts(got.str);
    if (links.length !== 1 || links[0] !== file) wrong.push(`${cols} columns: ${JSON.stringify(links)}`);
  }
  assert.deepEqual(wrong, []);
});

test('control: the blank xterm leaves before a wide glyph that did not fit is still dropped', () => {
  const line = '/Users/me/经验学习/报告.md 和 /Users/me/b.md';
  for (let cols = 20; cols <= 40; cols++) {
    const got = wrapped(fakeBuffer(line, cols, ''), 0, cols);
    assert.deepEqual(texts(got.str), ['/Users/me/经验学习/报告.md', '/Users/me/b.md'], `${cols} columns`);
  }
});
