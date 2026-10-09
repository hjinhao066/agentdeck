'use strict';
// Only Claude Code's own login error counts as "未登录": a row of its own carrying the CLI's
// /login hint, however the column width wraps it. The phrase quoted in a reply, a tool
// header or a code line is ordinary text.
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../quota-core');
const M = require('../main-core');
const CMD = 'claude --dangerously-skip-permissions --model claude-opus-5-5';
const FOOTER = ['', '────────────────────────────────────────', '❯ ', '────────────────────────────────────────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];

// 10-08 22:03, a worker fixing this very bug, at work: its tool description
// "List userData and find sessions with Not logged in" wrapped so that one row was
// just "Not logged in". AgentDeck filed 「异常回执（未登录）：Not logged in」 for it.
const MISREAD = [
  '⏺ Main-process env and launch-command both set the',
  '  seat. Looking for the actual incidents (which',
  '  sessions showed "Not logged in" today) to see what',
  '  path they took.',
  '',
  '⏺ List userData and find sessions with',
  '  Not logged in',
  '  ⎿  $ cd ~ && ls "Library/Application',
  '     Support/agentdeck/" | head -50; grep -rl -E',
  '     \'Not logged in\' "Library/Application',
  '     Support/agentdeck/sessions" 2>/dev/null | head',
  '',
  '✻ Simmering… (esc to interrupt)',
  ...FOOTER,
].join('\n');

// The real thing, 10-08 18:03 (c-board-mv064nlv04kttu), at three column widths.
const real = (rows) => ['  回执里不要贴文件正文。', ...rows, '', '✻ Baked for 1s · done 6:03 PM', ...FOOTER].join('\n');
const WIDE = real(['  ⎿  Not logged in · Please run /login']);
const NARROW = real(['  ⎿  Not logged in · Please run', '     /login']);     // as peeked at 18:22 (~36 columns)
const NARROWER = real(['  ⎿  Not logged in ·', '     Please run /login']);

test('a quoted "Not logged in" on a row of its own is not a login failure', () => {
  assert.equal(M.terminalActivity(MISREAD, CMD), '');
  assert.equal(M.resourceReceipt(MISREAD, CMD), null);
  for (const row of ['Not logged in', '  Not logged in', 'Not logged in.', '⏺ Not logged in', 'Not signed in', 'You are not logged in',
    '  sessions showed "Not logged in" today)', "  'Not logged in · Please run /login', 'auth'],"]) {
    assert.equal(Q.resourceError(row), '', row);
  }
});

test('Claude Code\'s own login error is one at every column width, read as one line', () => {
  for (const screen of [WIDE, NARROW, NARROWER]) {
    assert.equal(M.terminalActivity(screen, CMD), 'quota');
    assert.deepEqual(M.resourceReceipt(screen, CMD), { failed: '未登录：⎿  Not logged in · Please run /login', source: 'quota' });
  }
  // other CLIs keep their own hint after a full stop
  for (const row of ['Not signed in. Run codex login', "Error: Not logged in. Please run 'cursor-agent login'", 'Not logged in. Please run /login']) {
    assert.equal(Q.resourceError(row), 'auth', row);
  }
});
