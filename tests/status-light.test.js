'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const MainCore = require('../main-core');
const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
const context = vm.createContext({ MainCore });
vm.runInContext(source.slice(source.indexOf('const WORKING_RE'), source.indexOf('function setDot')) +
  source.slice(source.indexOf('function statusScreen'), source.indexOf('// Format elapsed ms')), context);
const { classify, statusScreen } = context;
const busy = [
  '◦ Working (11m 27s • esc to interrupt) · 1 background terminal',
  '✻ Contemplating… (11m 27s · esc to interrupt · ↓ 1.2k tokens)',
  '✻ 思考中…',
  'Thinking... (31s)',
  'Searching… (31s · esc to cancel)',
  '⠋ Reading files...',
  'ctrl+c to stop',
  'Responding…',
  '  ⠰⠳ Thinking  64.14k tokens',
  '  ⠠⠜ Running  45.56k tokens',
  '  ⠘⠣ Grepping  114.61k tokens',
  '  ⠘⠆ Reading  20.5k tokens',
  ':: Thinking  69.26k tokens',
  'Editing  3k tokens',
  '◦ Waiting for background terminal',
];
function terminal(lines, baseY = 0, rows = lines.length - baseY) {
  return { rows, buffer: { active: { baseY, viewportY: 0, getLine: (y) => {
    const line = lines[y];
    return line === undefined ? undefined : { isWrapped: typeof line === 'object',
      translateToString: () => typeof line === 'object' ? line.text : line };
  } } } };
}

test('quiet Codex, Claude, Gemini/agy and Cursor busy rows stay working above a tall footer', () => {
  for (const marker of busy) {
    const term = terminal([marker, ...Array(45).fill(''), '❯', 'Claude Code']);
    const entry = { hasWorked: true, lastOutputAt: Date.now() - 15 * 60000 };
    for (let tick = 0; tick < 5; tick++) assert.equal(classify(statusScreen(term), entry), 'working', marker);
  }
});

test('live screen reads off-screen/unfocused columns and joins hard-wrapped busy hints', () => {
  const term = terminal(['old row', '◦ Work', { text: 'ing (11m 27s • esc to inter' },
    { text: 'rupt) · 1 background terminal' }, '❯'], 1);
  term.focused = false;
  term.visible = false;
  assert.equal(classify(statusScreen(term), { hasWorked: true }), 'working');
  assert.equal(term.buffer.active.viewportY, 0, 'does not scroll the reader to the bottom');
});

test('completed/idle screens exclude stale scrollback and replayed busy rows', () => {
  const term = terminal([busy[0], 'Done. Working status was checked.', '❯', 'Thinking: high'], 1);
  assert.equal(classify(statusScreen(term), { hasWorked: true }), 'done');
  assert.equal(classify(statusScreen(term), { hasWorked: false }), 'plain');
  for (const separator of ['── 以上为上次会话的输出 ──',
    '── 上次输出回放，进程已结束（模型上下文将通过 CLI 恢复）──',
    '── 上次输出回放；此栏未绑定模型会话，本次将新开对话 ──']) {
    const replay = terminal([busy[0], separator, '❯', 'Claude Code']);
    assert.equal(classify(statusScreen(replay), { hasWorked: true }), 'done');
  }
  for (const text of ['The Working indicator is now gone.', 'Thinking: xhigh', '✻ Baked for 31s',
    'Enter to send · Esc to cancel', '↑↓ to select · Enter to confirm · Esc to cancel', '⠀']) {
    assert.notEqual(classify(text + '\n❯', { hasWorked: true }), 'working', text);
  }
});

test('quota and confirmation states remain distinct from busy spinners', () => {
  assert.equal(classify("You've hit your usage limit\nContinuing at 5pm · esc to cancel", { hasWorked: true }), 'quota');
  assert.equal(classify('Proceed? (y/n)\n❯', { hasWorked: true }), 'input');
  assert.equal(classify(busy[0] + '\nwaiting for user confirmation', { hasWorked: true }), 'working');
});
