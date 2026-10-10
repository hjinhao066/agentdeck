'use strict';
// False 已结束，未提交回执 on 2026-10-09 (Mac, 22:58 → 23:01): c-board-mv1x25yc821s0t, a background worker in a
// 36-column terminal, was writing a file. After a resize its screen was repainted with the last tool output
// (an Update diff) right above the input box and no spinner row; Claude then drew nothing for minutes. The
// only live sign left was the footer under the box, "⏵⏵ bypass permissions on · esc…": the "esc to interrupt"
// hint of a running turn, cut at the width. Nothing read it, the status light went green and three minutes
// later the Captain was told the worker had ended. A finished turn ends that footer with "← for agents" ("← f…").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const M = require('../main-core');

const renderer = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
const rctx = vm.createContext({ MainCore: M, env: { platform: 'darwin' } });
vm.runInContext(renderer.slice(renderer.indexOf('const WORKING_RE'), renderer.indexOf('function setDot')), rctx);
const CMD = 'claude --dangerously-skip-permissions';
const RULE = '─'.repeat(36);
// The live screen's bottom rows, as the replay showed them (text replaced).
const DIFF = ['  ⎿  Updated tests/e2e/sample-read', '     er.spec.js (+7 -5)', '      359    await expect(inp',
  '           ut).toBeVisible();', '      362 -  // in the old wo', '          -rding of the hint', '      362 +  // in the new wo'];
const screen = (footer, above = DIFF) => [...above, '  Update available! Run: brew upg…', RULE, '❯ ', RULE, ...footer].join('\n');

test('a running turn whose only live sign is the cut "esc to interrupt" footer is working, not ended', () => {
  for (const footer of [['  ⏵⏵ bypass permissions on  · esc…'], ['  ⏵⏵ bypass permissions on · esc to i…'],
    ['  Opus 5h 64%', '  ▓▓░░░ 50% 497k/1M  ⎇ 0', '  ⏵⏵ bypass permissions on  · esc…'],
    ['  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt']]) {
    const text = screen(footer);
    assert.equal(rctx.classify(text, { state: 'done', hasWorked: true }, CMD), 'working', footer.join(' / '));
    assert.equal(M.terminalActivity(text, CMD), 'working', footer.join(' / '));
  }
});

test('a finished turn keeps reading as finished: idle footers, and esc words in the reply above the box', () => {
  const done = ['', '✻ Sautéed for 1m 12s · done 11:03 PM'];
  for (const [footer, above] of [[['  ⏵⏵ bypass permissions on  · ← f…'], DIFF], [['  ⏵⏵ bypass permissions on (shift+tab to cycle)'], done],
    [['  ⏵⏵ bypass permissions on  · ← f…'], [...done, '  so press esc to interrupt it…', '  (esc to interrupt)']]]) {
    const text = screen(footer, above);
    assert.equal(rctx.classify(text, { state: 'done', hasWorked: true }, CMD), 'done', footer.join(' / '));
    assert.equal(M.terminalActivity(text, CMD), '', footer.join(' / '));
  }
});

test('a permission menu is still a question, whatever its own footer says', () => {
  const menu = ['⏺ Bash(rm -rf build)', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'].join('\n');
  assert.equal(rctx.classify(menu, { state: 'working', hasWorked: true }, CMD), 'input');
});
