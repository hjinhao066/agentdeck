'use strict';
// Bug hunt ④ #7 (2.0.4 features, 自动归档): 8b7be5e stopped counting a chunk made only of terminal queries
// as output (renderer.js writePtyData: lastOutputAt moves only when MainCore.drawsOutput). That is what
// the automatic archive needed, but the same lastOutputAt also feeds MainSession's silence watchdog
// (main-session.js, before the background-task check): a task still working whose terminal drew
// nothing for MainCore.silenceTimeout (20 min for Claude) sends 队长 an anomaly receipt
// 「已连续 20 分钟没有任何终端输出，请检查会话」. A Claude worker whose turn is over while its
// background shell or Monitor runs (README: 「回合已结束、只剩后台 shell / Monitor」, still working: no
// 已结束，未提交回执, no automatic archive) shows a static status row ("✻ Baked for 1m 5s · done 8:27 AM ·
// 1 monitor still running") and only asks for the cursor every few seconds. Before 8b7be5e those
// questions kept the watchdog quiet; now every background wait over 20 minutes (a queued E2E run, the
// real case in tests/claude-background-status-row.test.js) reaches 队长 as a false "no output" anomaly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');

const RULE = '───────────────────────────────────────────────────────';
// the worker screen of tests/claude-background-status-row.test.js: turn over, a monitor still running
const WAITING = ['  ⏺ 继续等包内 E2E，不重跑。', '', '✻ Baked for 1m 5s · done 8:27 AM · 1 monitor still running',
  RULE, '❯ ', RULE, 'Sonnet 5h 69%', '░░░░░░░░░░ ctx 41%'].join('\n');

// tests/crew-exceptions.test.js's world, with a Claude worker
function world() {
  let now = 10_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd: 'claude' };
  const columns = [captain, worker], turns = [];
  const s = { colId: 'captain', gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] };
  const terms = new Map([[worker.id, { alive: true, state: 'working', backgroundOnly: true, lastOutputAt: now, lastScreen: WAITING }]]);
  const window = { MainCore: M, BoardCore: B, deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, ptyInput() {} }, ChatUI: {
    hasDraft: () => false, updateCard() {}, turnsOf: () => turns, sendPrompt: async () => true,
  } };
  const context = vm.createContext({ window, setTimeout, Date: class extends Date { static now() { return now; } } });
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8')
    .replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; } };\n  window.MainSession = {');
  vm.runInContext(source, context);
  window.__test.setHost({ config: { mainSession: s }, terms, columns: () => columns, saveConfig() {},
    isBackstage: () => true, focusedId: () => 'captain', lastTurnTs: () => 1, archiveColumn() {},
    columnLabel: (c) => c.id, userComposing: () => false, agentInForeground: async () => true });
  const entry = terms.get(worker.id);
  return {
    s, entry,
    task() { const t = { id: 'task-' + s.tasks.length, colId: worker.id, gen: 1, status: 'working', title: 'e2e', startedAt: now, sentAt: now }; s.tasks.push(t); return t; },
    // what the PTY sends meanwhile, as renderer.js writePtyData takes it
    pty(ms, data) { for (let t = 0; t < ms; t += 2000) { now += 2000; if (M.drawsOutput(data)) entry.lastOutputAt = now; window.MainSession.onTick(worker.id, entry); } },
  };
}

test('a Claude worker waiting on its background monitor for 25 minutes is not reported as silent', () => {
  const w = world(), t = w.task();
  assert.equal(M.claudeBackgroundTasks(WAITING, 'claude'), true, 'the screen reads as a background wait');
  w.pty(25 * 60_000, '\x1b[?6n');
  assert.equal(t.status, 'working');
  assert.deepEqual(w.s.pending.filter((p) => p.anomaly === 'no_output').map((p) => p.summary), []);
});

test('control: a Claude worker with no background task and nothing drawn for 25 minutes is still reported', () => {
  const w = world(), t = w.task();
  w.entry.backgroundOnly = false;
  w.entry.lastScreen = WAITING.replace(' · 1 monitor still running', '').replace('  ⏺ 继续等包内 E2E，不重跑。', '  ⏺ 正在想。');
  w.entry.state = 'working';
  // a working Claude with a static screen: no status row, no background task, nothing drawn
  w.entry.lastScreen = ['  ⏺ 正在想。', RULE, '❯ ', RULE].join('\n');
  assert.equal(M.claudeBackgroundTasks(w.entry.lastScreen, 'claude'), false);
  w.pty(25 * 60_000, '\x1b[?6n');
  assert.equal(t.status, 'working');
  assert.equal(w.s.pending.filter((p) => p.anomaly === 'no_output').length, 1);
});
