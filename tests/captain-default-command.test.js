'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const S = require('../claude-seats-core');

// The 新建队长 dialog with no Captain yet: what its command field is prefilled with.
function dialogCommand(config = {}) {
  const elements = new Map();
  const window = { deck: { saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {} }, MainCore: require('../main-core'), BoardCore: B,
    ClaudeSeatsCore: S, ChatUI: { hasDraft: () => false, turnsOf: () => [] } };
  const context = vm.createContext({ window, setTimeout() {}, document: {
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, { value: '', addEventListener() {}, showModal() {}, focus() {} }); return elements.get(id); },
    querySelectorAll: () => [],
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({ config, platform: 'darwin', columns: () => [], terms: new Map(), userComposing: () => false,
    sendWhenReady() {}, saveConfig() {} });
  window.MainSession.open();
  return elements.get('mdCmd').value;
}

test('the Captain\'s default Claude command is Opus 5.5 at max effort', () => {
  assert.equal(S.CLAUDE_COMMAND, 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort max');
});

test('a new Captain is offered the saved Captain command, else the max default, never the worker preset', () => {
  assert.equal(dialogCommand(), S.CLAUDE_COMMAND);
  assert.notEqual(dialogCommand(), B.commandForAgent('claude'));
  const saved = 'claude --dangerously-skip-permissions --model claude-sonnet-5-5 --effort xhigh';
  assert.equal(dialogCommand({ captainRelayClaudeCommand: saved }), saved);
});

test('the 创建队长 dialog\'s Claude preset is the Captain default', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const dialog = html.slice(html.indexOf('<dialog id="mainDialog">'), html.indexOf('</dialog>', html.indexOf('<dialog id="mainDialog">')));
  assert.deepEqual([...dialog.matchAll(/data-cmd="(claude[^"]*)"/g)].map((m) => m[1]), [S.CLAUDE_COMMAND]);
});
