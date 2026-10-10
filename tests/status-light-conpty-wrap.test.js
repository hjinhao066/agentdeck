'use strict';
// 10-09 21:48 to 21:56, Windows: four Claude workers (34-column deck columns, Opus 5.5 / Sonnet 5.5) were
// working and drew "✽ <verb>… (3m 5s · thinking)", yet the ledger showed 终端:已完成 from the start and three
// of them got 已结束，未提交回执. The Windows console marks the rows it pads with spaces as wrapped; the blank row
// and the spinner row below a long tool result came up wrapped, statusScreen joined them onto the tool row, and
// WORKING_RE (a spinner glyph at the START of a row) no longer saw the spinner. No other rule matches
// "(thinking)", so the idle footer made it done.
// Fixtures are the live screens of two sessions (frames of their saved output replayed in @xterm/headless at
// 34 columns); the content rows are redacted, the spinner, rules and footer are the verbatim chrome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MainCore = require('../main-core');
const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
const context = vm.createContext({ MainCore });
vm.runInContext(source.slice(source.indexOf('const WORKING_RE'), source.indexOf('function setDot')) +
  source.slice(source.indexOf('function statusScreen'), source.indexOf('// Format elapsed ms')), context);
const { classify, statusScreen } = context;

const wideChar = (c) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c);
// rows: [{ w, t }]: w = xterm's isWrapped, t = the row's text; padded with spaces to the last column like the
// Windows console does (a wide character takes two cells)
function terminal(rows, cols) {
  const lines = rows.map(({ w, t }) => {
    const width = [...t].reduce((n, c) => n + (wideChar(c) ? 2 : 1), 0);
    return { isWrapped: !!w, translateToString: () => t + ' '.repeat(Math.max(0, cols - width)) };
  });
  return { rows: lines.length, cols, buffer: { active: { baseY: 0, getLine: (y) => lines[y] } } };
}
const fixture = (name) => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/conpty-wrapped-spinner', name + '.json'), 'utf8'));
  return terminal(f.screen, f.cols);
};

for (const name of ['tool-output-above-spinner', 'half-redrawn-no-prompt']) {
  test(`real narrow Windows Claude screen ${name}: the spinner row stays a row of its own and the column reads working`, () => {
    const live = statusScreen(fixture(name));
    assert.ok(live.split('\n').some((line) => /^✽ [A-Za-z]+… \(\d+/.test(line)), 'the spinner row starts its own row');
    assert.equal(classify(live, { hasWorked: true }, 'claude'), 'working');
    // from either state: the dot never goes green and the receipt clock never starts
    for (const state of ['working', 'done']) assert.equal(classify(live, { hasWorked: true, state }, 'claude'), 'working');
  });
}

const row = (t, w = false) => ({ w, t });
const rule = '─'.repeat(34);
const footer = [row('  Context: [███░░░░░░░░░░░░░] 1…'), row('  Model: Opus 5.5 | Thinking: h…'), row('  ⏵⏵ bypass permissions on  · ←…')];
const tool = [row('  ⎿  $ cd "xxxxx" && xxxxxxxxxxx'), row('     xxxx xxxxxxxx xxxx', true), row('     "xxxxxx|xxxxxxxx@000…', true)];

test('a spinner row after a padded wrapped row is its own row, with any spinner glyph', () => {
  for (const glyph of ['✻', '✽', '✳', '✶', '✢', '·', '*']) {
    const term = terminal([...tool, row('', true), row(`${glyph} Cascading… (3m 5s · thinking)`, true), row(''), row(rule), row('❯', true), row(rule, true), ...footer], 34);
    const live = statusScreen(term);
    assert.ok(live.split('\n').some((line) => line.startsWith(glyph + ' Cascading… (3m 5s · thinking)')), glyph + ' starts its own row');
    assert.equal(classify(live, { hasWorked: true }, 'claude'), 'working', glyph);
  }
});

test('a finished Claude turn in the same wrapped layout is still done, not working', () => {
  const term = terminal([...tool, row('', true), row('✻ Baked for 40s · done 9:24 AM', true), row(''), row(rule), row('❯', true), row(rule, true), ...footer], 34);
  const live = statusScreen(term);
  assert.ok(live.split('\n').some((line) => line.startsWith('✻ Baked for 40s · done 9:24 AM')));
  assert.equal(classify(live, { hasWorked: true }, 'claude'), 'done');
  assert.equal(classify(live, { hasWorked: false }, 'claude'), 'plain');
});

test('text carried down to the next row is still joined: only a row opening with a spinner or bullet after a blank last cell stands alone', () => {
  // the row above runs to the last column: a real soft wrap, even when the next row opens with a glyph
  const full = 'x'.repeat(34);
  assert.equal(statusScreen(terminal([row(full), row('· rest of it', true)], 34)), full + '· rest of it');
  // the row above ends in blank cells and the next row opens with a word: the existing join
  assert.match(statusScreen(terminal([row('⏺ Running the crew map'), row('tests', true)], 34)), /^⏺ Running the crew map +tests$/);
  // blank cells and a glyph followed by no space ("*args", "·x") is text, not a status row
  assert.match(statusScreen(terminal([row('⏺ Passing the'), row('*args to it', true)], 34)), /^⏺ Passing the +\*args to it$/);
});
