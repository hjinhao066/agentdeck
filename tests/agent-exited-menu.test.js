'use strict';
// 2026-10-09 (Windows): a US2 session stopped on Claude's "Bypass Permissions mode" menu (default
// row "No, exit"); the agent exited with code 1 back into PowerShell. The menu stayed on screen
// above the PS prompt, so the column kept reading 等你回复 / 停在确认提示, and an
// `answer --key 2` for it was typed straight into PowerShell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');

const renderer = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
function screenContext(platform) {
  const context = vm.createContext({ MainCore: M, env: { platform } });
  vm.runInContext(renderer.slice(renderer.indexOf('const WORKING_RE'), renderer.indexOf('function setDot')) +
    renderer.slice(renderer.indexOf('function statusScreen'), renderer.indexOf('// Format elapsed ms')), context);
  return context;
}
const W = 60;
const term = (rows) => ({ rows: rows.length, cols: W, buffer: { active: { baseY: 0, getLine: (y) => rows[y] === undefined ? undefined
  : { isWrapped: false, translateToString: () => rows[y].padEnd(W), getCell: () => ({ getChars: () => ' ', getWidth: () => 1 }) } } } });
const LAUNCH = 'PS C:\\Users\\me\\repo> claude --dangerously-skip-permissions; node "$env:AGENTDECK_BOARD_CLI" session-exit --code "$LASTEXITCODE"';
const MENU = [
  ' WARNING: Claude Code running in Bypass Permissions mode',
  ' In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
  ' ❯ 1. No, exit',
  '   2. Yes, I accept',
  ' Enter to confirm · Esc to cancel',
];
const CMD = 'claude --dangerously-skip-permissions';

test('Windows: a menu left above the PowerShell prompt after the agent exited is not a question any more', () => {
  const c = screenContext('win32');
  const live = c.liveStatusText(term([LAUNCH, ...MENU, '', 'PS C:\\Users\\me\\repo> ']));
  assert.notEqual(c.classify(live, { state: 'input', hasWorked: true }, CMD), 'input');
  // while the agent is still up, the same menu is a question
  const up = c.liveStatusText(term([LAUNCH, ...MENU]));
  assert.equal(c.classify(up, { state: 'plain', hasWorked: false }, CMD), 'input');
  // and an idle Claude (no shell prompt at the bottom) is read as before
  const idle = c.liveStatusText(term([LAUNCH, '⏺ Done.', '────────', '❯ ', '────────', '  ⏵⏵ bypass permissions on']));
  assert.equal(c.classify(idle, { state: 'done', hasWorked: true }, CMD), 'done');
});

test('macOS keeps reading the whole screen (its foreground process is known)', () => {
  const c = screenContext('darwin');
  assert.equal(c.liveStatusText(term(['x', 'y'])), 'x\ny');
});

function world({ live, foreground = true, platform = 'win32' }) {
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd: 'claude --dangerously-skip-permissions' };
  const typed = [];
  const s = { colId: 'captain', gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] };
  const terms = new Map([[worker.id, { alive: true, state: 'input', lastOutputAt: 1, lastScreen: MENU.join('\n'), term: { modes: {} } }]]);
  const window = { MainCore: M, BoardCore: B, deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, ptyInput: (id, data) => typed.push(data) },
    ChatUI: { hasDraft: () => false, updateCard() {}, turnsOf: () => [], sendPrompt: async () => true } };
  const context = vm.createContext({ window, setTimeout, Date });
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8')
    .replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; } };\n  window.MainSession = {');
  vm.runInContext(source, context);
  window.__test.setHost({ config: { mainSession: s }, terms, columns: () => [captain, worker], saveConfig() {}, platform,
    isBackstage: () => true, focusedId: () => 'captain', lastTurnTs: () => 1, columnLabel: (col) => col.id, userComposing: () => false,
    agentInForeground: async () => foreground, liveState: () => live });
  return { api: window.MainSession, captain, typed };
}

test('answer reads the terminal again: an agent that has exited gets no keys, they would land in the shell', async () => {
  const w = world({ live: 'done' });
  await assert.rejects(w.api.handle({ action: 'main-answer', to: 'worker', key: '2' }, w.captain), /不在确认提示上[\s\S]*一个键也没有按/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(w.typed, []);
});

test('macOS: a shell in the foreground gets no keys either', async () => {
  const w = world({ live: 'input', foreground: false, platform: 'darwin' });
  await assert.rejects(w.api.handle({ action: 'main-answer', to: 'worker', key: 'y' }, w.captain), /一个键也没有按/);
  assert.deepEqual(w.typed, []);
});

test('a menu that is really there is answered as before', async () => {
  const w = world({ live: 'input' });
  const reply = await w.api.handle({ action: 'main-answer', to: 'worker', key: 'down,enter' }, w.captain);
  assert.match(reply.result, /已替/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(w.typed, ['\x1b[B', '\r']);
});
