'use strict';
// 2026-10-09 (Windows): two Claude workers still busy were reported 已结束，未提交回执 and their
// cards went to needs_user. Replays of the saved terminal output (structure only, text replaced):
//  - c-board-mv1lwe79ec4ffb, 42x70: the fullscreen view was scrolled up. The spinner had scrolled
//    away with the transcript; only Claude's "N new messages (ctrl+End) ↓" pill and the footer were
//    left. 37 of 41 such frames read as done.
//  - the Windows console sends some rows of the full-screen TUI as soft wraps of the row above
//    (the input box rule and the "❯ " row, a padded row and the spinner row). The live screen joined
//    them, so the spinner stood mid-line and the prompt row vanished into the rule.
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
const CMD = 'claude --dangerously-skip-permissions --model claude-opus-5-5';
const W = 42;
const RULE = '─'.repeat(W);
const pad = (s) => s + ' '.repeat(Math.max(0, W - [...s].length));
// rows: strings, or { text, wrapped: true } for a row the console sent as a soft wrap
function terminal(rows) {
  return { rows: rows.length, cols: W, buffer: { active: { baseY: 0, getLine: (y) => {
    const row = rows[y];
    if (row === undefined) return undefined;
    const text = pad(typeof row === 'object' ? row.text : row);
    return { isWrapped: typeof row === 'object', translateToString: () => text, getCell: (x) => ({ getChars: () => text[x] || '', getWidth: () => 1 }) };
  } } } };
}
const FOOTER = ['  Context: [████░░░░░░░░░░░░] 249k/1.0M…', '  Model: Opus 5.5 | Thinking: xhigh | S…', '  ⏵⏵ bypass permissions on (shift+tab to'];
const scrolled = (pill, wrapped = false) => [
  '  2. xxxx: xxx 10 xxxxxxx xxxxxxxx',
  '  xxxxxxxxx xxx/xxxxxxxxxx xx, xxxx',
  '  xxxxx.',
  pill,
  '',
  wrapped ? { text: RULE } : RULE,
  wrapped ? { text: '❯ ' } : '❯ ',
  wrapped ? { text: RULE } : RULE,
  ...FOOTER,
];

test('scrolled up in Claude\'s fullscreen view, a working turn stays working (the pill forms Claude draws)', () => {
  for (const pill of ['       10 new messages (ctrl+End) ↓', '  ---   1 new message (ctrl+End) ↓', '        Jump to bottom (ctrl+End) ↓',
    '  ⎿  xxxx xxxx out 8 new messages (ctrl+En', '   3 new messages ↓', '   3 new messages', '  Jump to bottom: fn+↓ to scroll']) {
    for (const wrapped of [false, true]) {
      const live = statusScreen(terminal(scrolled(pill, wrapped)));
      assert.equal(MainCore.claudeScrolledUp(live, CMD), true, `${pill} wrapped=${wrapped}`);
      assert.equal(classify(live, { state: 'working', hasWorked: true }, CMD), 'working', `${pill} wrapped=${wrapped}`);
    }
  }
});

test('the pill only holds a turn that was working; a finished one and an ordinary screen are judged as before', () => {
  const live = statusScreen(terminal(scrolled('        Jump to bottom (ctrl+End) ↓')));
  assert.equal(classify(live, { state: 'done', hasWorked: true }, CMD), 'done');
  const bottom = statusScreen(terminal(['⏺ All done.', '', RULE, '❯ ', RULE, ...FOOTER]));
  assert.equal(MainCore.claudeScrolledUp(bottom, CMD), false);
  assert.equal(classify(bottom, { state: 'working', hasWorked: true }, CMD), 'done');
  // a reply that merely mentions new messages is not the pill
  const prose = statusScreen(terminal(['⏺ The inbox had 3 new messages today, all read.', '', RULE, '❯ ', RULE, ...FOOTER]));
  assert.equal(MainCore.claudeScrolledUp(prose, CMD), false);
  // other agents never draw it
  assert.equal(MainCore.claudeScrolledUp(live, 'codex --yolo'), false);
});

test('Windows soft-wrapped TUI rows: the input box keeps its prompt row and the spinner row stays a row', () => {
  const rows = ['⏺ Running the test suite now.', '', pad('  ⎿  $ node --test tests/x.test.js'), { text: '✽ Skedaddling… (4s · thought for 1s)' },
    '', { text: RULE }, { text: '❯ ' }, { text: RULE }, ...FOOTER];
  const live = statusScreen(terminal(rows));
  const lines = live.split('\n');
  assert.ok(lines.includes('✽ Skedaddling… (4s · thought for 1s)'), 'the spinner is its own row');
  assert.ok(lines.includes('❯'), 'the prompt row is not glued to the rule');
  assert.equal(classify(live, { state: 'working', hasWorked: true }, CMD), 'working');
  // the same rows, as a plain terminal sends them, read the same
  assert.equal(classify(statusScreen(terminal(rows.map((r) => typeof r === 'object' ? r.text : r))), { state: 'working', hasWorked: true }, CMD), 'working');
});

test('real text wraps are still joined (a long line that fills the row)', () => {
  const long = 'x'.repeat(W);
  const live = statusScreen(terminal([long, { text: 'continued here' }]));
  assert.equal(live, long + 'continued here');
  // a row ending in blank cells followed by ordinary text is joined as before
  assert.equal(statusScreen(terminal(['abc', { text: 'def' }])), pad('abc') + 'def');
});
