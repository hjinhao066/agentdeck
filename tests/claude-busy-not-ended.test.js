'use strict';
// Third false 已结束，未提交回执 on 2026-10-09 (Windows, 17:41): c-board-mv1lwe79ec4ffb, just restored from
// the archive by a tell, showed "✶ Metamorphosing… (3m 11s · thinking more with xhigh effort)". The saved
// chat shows the same thing as the earlier two: the turn of the new instruction was closed 1 s after it
// was sent (17:38:34 → 17:38:35; the others 2.4 s and 4 s), and its captured screen has TUI rows glued
// together. Three things had to be true, and each is now fixed:
//  1. a send left the column's idle-tick count from its idle time, so the first status tick (the agent had
//     not drawn its spinner yet) skipped the done debounce and the chat turn was closed at once;
//  2. a spinner row the Windows console sent as a soft wrap after a row of text was glued onto it;
//  3. the no-receipt fallback trusted the status light alone; it now takes one last look at the rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const ChatCore = require('../chat-core');

const renderer = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
const rctx = vm.createContext({ MainCore: M, env: { platform: 'win32' } });
vm.runInContext(renderer.slice(renderer.indexOf('const WORKING_RE'), renderer.indexOf('function setDot')) +
  renderer.slice(renderer.indexOf('function statusScreen'), renderer.indexOf('// Format elapsed ms')), rctx);
const CMD = 'claude --dangerously-skip-permissions --model claude-opus-5-5';
const W = 74, RULE = '─'.repeat(W);
const pad = (s) => s + ' '.repeat(Math.max(0, W - [...s].length));
const term = (rows) => ({ rows: rows.length, cols: W, buffer: { active: { baseY: 0, getLine: (y) => {
  const r = rows[y]; if (r === undefined) return undefined; const text = typeof r === 'object' ? r.text : pad(r);
  return { isWrapped: typeof r === 'object', translateToString: () => text.padEnd(W), getCell: (x) => ({ getChars: () => text[x] || '', getWidth: () => 1 }) };
} } } });
const FOOTER = ['', RULE, '❯ ', RULE, '  Context: [████████░░░░░░░░] 490k/1.0M (49%)', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
const REPLAY = ['⏺ an earlier reply', '── 上次输出回放，进程已结束（模型上下文将通过 CLI 恢复）──', 'PS C:\\Users\\me> claude --resume f4b3 --dangerously-skip-permissions'];
// a text row that fills the width exactly, then the spinner row sent as its soft wrap
const FULL = '⏺ Reading the build log and the crash dump to see which call overflowed it';
const SCENES = {
  'long thinking': '✶ Metamorphosing… (3m 11s · thinking more with xhigh effort)',
  'long command': '✻ Skedaddling… (33m 14s · ↓ 12.3k tokens)',
};

test('a spinner row glued after a full row of text is still a spinner: long thinking, long command, restored from the archive', () => {
  for (const [name, spinner] of Object.entries(SCENES)) {
    for (const restored of [false, true]) {
      assert.equal([...FULL].length, W);
      const rows = [...(restored ? REPLAY : []), FULL, { text: spinner }, ...FOOTER];
      const live = rctx.liveStatusText(term(rows));
      assert.ok(live.split('\n').includes(spinner), `${name}: the spinner is its own row`);
      assert.equal(rctx.classify(live, { state: 'working', hasWorked: true }, CMD), 'working', `${name} restored=${restored}`);
    }
  }
});

// ---- 1. the done debounce starts over with every send ----
const chatUi = fs.readFileSync(path.join(__dirname, '../chat-ui.js'), 'utf8');
const body = chatUi.slice(chatUi.indexOf('  const PASTE_READ_MAX = 30_000;'), chatUi.indexOf('  // Resolves to the turn (or true) once the file is written'));
test('sending a prompt restarts the done debounce, so the next tick cannot close the new turn at once', async () => {
  const idle = ['⏺ Done earlier.', ...FOOTER];
  const entry = { alive: true, state: 'done', hasWorked: true, idleTicks: 120, lastOutputAt: 0, term: Object.assign(term(idle), { modes: { bracketedPasteMode: true } }) };
  const host = { terms: new Map([['w', entry]]), dumpScreen: () => idle.join('\n'), shellQuote: (p) => p, manualPromptSent() {}, userComposing: () => false,
    maybeAutoName() {}, showToast() {}, columnLabel: () => 'w', menuOnScreen: (t, sent) => rctx.menuOnScreen(t, sent) };
  const context = vm.createContext({ C: ChatCore, host, Date, setTimeout, Promise, pending: new Map(), refreshTurn() {}, scheduleSave() {},
    window: { deck: { ptyInput: () => {}, notifyCancel() {}, stateDebug() {} }, MainSession: null, MainCore: M, BoardCore: { inferAgentType: () => 'Claude' } },
    beginTurn: () => ({ id: 't' }) });
  vm.runInContext(body, context);
  assert.ok(await context.sendPrompt({ id: 'w', cmd: CMD }, '新指令', null, {}));
  assert.equal(entry.state, 'working');
  assert.equal(entry.idleTicks, 0);
  // the status tick's debounce: the first idle-looking tick after a send stays working
  const tick = renderer.slice(renderer.indexOf("      } else if (st === 'done') {"), renderer.indexOf("      } else {\n        // 'plain' after working"));
  assert.match(tick, /entry\.idleTicks\+\+;\s*if \(entry\.idleTicks < 2\) \{\s*st = 'working';/);
  // and a manual Enter in the terminal starts over too
  assert.match(renderer, /entry\.hasWorked = true;\s*entry\.idleTicks = 0;/);
});

// ---- 3. one last look before the fallback ----
function runtime(screenNow) {
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd: CMD };
  const idleRows = ['⏺ Done.', ...FOOTER].join('\n');
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - 600_000, lastScreen: idleRows, term: {} };
  const entries = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [worker.id, entry]]);
  const window = {
    deck: { saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, taskBoard: () => Promise.resolve({}) },
    MainCore: M, BoardCore: B,
    ChatUI: { hasDraft: () => false, turnsOf: (id) => (id === worker.id ? [{ id: 'turn', done: true }] : []), updateCard() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const task = { id: 't', gen: 1, colId: 'worker', boardId: 'card', boardAttempt: 'attempt', status: 'working', turnId: 'turn', startedAt: 1, endedAt: Date.now() - 600_000 };
  window.MainSession.init({
    config: { mainSession: { colId: captain.id, gen: 1, tasks: [task], pending: [], waitlist: [] }, folders: [] }, saveConfig() {},
    columns: () => [captain, worker], terms: entries, userComposing: () => false, columnLabel: (c) => c.id,
    dumpScreen: () => screenNow, screenState: (text, e, cmd) => rctx.classify(text, e, cmd),
  });
  return { api: window.MainSession, worker, entry, task };
}
test('the no-receipt fallback looks at the rows once more: a spinner there keeps the task open', () => {
  const busyRows = [FULL, SCENES['long thinking'], ...FOOTER].join('\n');
  const busy = runtime(busyRows);
  busy.api.onTick(busy.worker.id, busy.entry);
  assert.equal(busy.task.status, 'working');
  assert.equal(busy.task.endedAt, 0);
  const done = runtime(['⏺ Done.', ...FOOTER].join('\n'));
  done.api.onTick(done.worker.id, done.entry);
  assert.equal(done.task.status, 'stopped');
  assert.equal(done.task.receipt.summary, '已结束，未提交回执');
});
