'use strict';
// 10-08: the Captain's tells to Claude workers in narrow columns sat queued for
// 30–60 minutes behind a background shell. A tell goes out through dispatch →
// sendWhenReady with requireIdle. These screens are the real rows (see
// background-tasks-detection-real.test.js): the turn is over and only background
// work is left, so the instruction must go in at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

const CMD = 'claude --dangerously-skip-permissions --model claude-opus-5-5';
const RULE = '─'.repeat(30);
const worker = (above, footer = '  ⏵⏵ bypass permissions on') => [...above, RULE, '❯ ', RULE, footer].join('\n');
const SCREENS = {
  'folded status row, cut footer': worker(['⏺ 测试在后台跑。', '', '✻ Churned for 3m 55s · done', '9:16 PM · 1 shell still', 'running'], '  ⏵⏵ bypass permissions on · 1 she'),
  'waiting for a background agent': worker(['⏺ 调研已经放到后台。', '', '✻ Waiting for 1 background agent to finish']),
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function world(screen) {
  let now = 1_000_000;
  const captain = { id: 'captain', isMain: true, cmd: CMD };
  const col = { id: 'worker', cmd: CMD };
  const columns = [captain, col], timers = [], delivered = [];
  const config = { mainSession: { colId: captain.id, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] } };
  const entry = { alive: true, hasWorked: true, state: 'working', lastOutputAt: now - 600_000, lastScreen: screen, foreground: true };
  const terms = new Map([[col.id, entry]]);
  const window = { MainCore: M, BoardCore: B, deck: { saveConfigSync() {}, onTaskStart() {}, onTaskReview() {}, onTaskRework() {} }, ChatUI: {
    addCard() {}, updateCard() {}, turnsOf: () => [],
    async sendPrompt(_col, text) { delivered.push(text); return { id: 'turn-' + delivered.length }; },
  } };
  const context = vm.createContext({ window, ChatUI: window.ChatUI, MainCore: M, columns, terms,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn) { timers.push(fn); }, clearTimeout() {},
    env: { platform: 'darwin' }, userComposing: () => false,
    agentInForeground: async (c) => terms.get(c.id)?.foreground,
  });
  const renderer = fs.readFileSync(path.resolve(__dirname, '../renderer.js'), 'utf8');
  vm.runInContext(renderer.slice(renderer.indexOf('const WORKING_RE'), renderer.indexOf('function setDot')), context);
  vm.runInContext(renderer.slice(renderer.indexOf('function sendWhenReady('), renderer.indexOf('\nfunction addColumn(')), context);
  // The status tick, as renderer.js runs it.
  entry.state = context.classify(screen, entry, CMD);
  entry.backgroundOnly = context.backgroundOnlyState(entry.state, false, screen, entry, CMD);
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8')
    .replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; }, dispatch };\n  window.MainSession = {');
  vm.runInContext(source, context);
  window.__test.setHost({ config, columns: () => columns, terms, saveConfig() {}, columnLabel: (c) => c.id,
    sendWhenReady: context.sendWhenReady, showToast() {} });
  return {
    entry, delivered,
    dispatch: (text) => window.__test.dispatch(col, text, '队长 tell'),
    async advance(ms) { now += ms; const due = timers.splice(0); for (const fn of due) await fn(); await flush(); },
  };
}

for (const [name, screen] of Object.entries(SCREENS)) {
  test(`a tell to a worker whose turn is over goes in at once: ${name}`, async () => {
    const w = world(screen);
    assert.equal(w.entry.state, 'working', 'the dot keeps waiting for the background work');
    const task = w.dispatch('补充：再跑一次相关测试');
    await flush();
    assert.equal(w.delivered.length, 1);
    assert.match(w.delivered[0], /补充：再跑一次相关测试/);
    assert.equal(task.status, 'working');
  });
}

test('a worker still in its turn keeps the tell until it stops', async () => {
  const w = world(worker(['⏺ 正在改。', '', '✻ Churning… (3m 55s · esc to interrupt)']));
  const task = w.dispatch('补充：再跑一次相关测试');
  await flush();
  await w.advance(5_000);
  assert.equal(w.delivered.length, 0);
  assert.equal(task.status, 'queued');
});
