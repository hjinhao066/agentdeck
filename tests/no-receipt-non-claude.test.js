'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

const AGENTS = [
  ['agy', B.commandForAgent('agy'), '>\nAntigravity\nContext: [#####] 12k/2000k'],
  ['Cursor', B.commandForAgent('cursor'), 'Working on the parser.\n→ Add a follow-up\nComposer'],
  ['Codex', B.commandForAgent('codex'), '─ Worked for 34m 29s • 12:52 ─\n› Ask Codex to do anything\n? for shortcuts'],
];

function runtime({ cmd, task, entry, turns }) {
  const boardEvents = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd };
  const entries = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [worker.id, entry]]);
  const window = {
    deck: {
      saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
      taskBoard(op, input) { boardEvents.push({ op, input }); return Promise.resolve({}); },
    },
    MainCore: M, BoardCore: B,
    ChatUI: { hasDraft: () => false, turnsOf: (id) => (id === worker.id ? turns : []), updateCard() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const state = { colId: captain.id, gen: 1, tasks: [task], pending: [], waitlist: [] };
  window.MainSession.init({
    config: { mainSession: state, folders: [] }, saveConfig() {},
    columns: () => [captain, worker], terms: entries, userComposing: () => false, columnLabel: (c) => c.id,
  });
  return { api: window.MainSession, worker, boardEvents, entry };
}

function openTask() {
  return {
    id: 't', gen: 1, colId: 'worker', boardId: 'card', boardAttempt: 'attempt',
    status: 'working', turnId: 'turn', startedAt: 1,
  };
}
const finishedTurn = [{ id: 'turn', done: true }];
const QUIET = 10 * 60_000;

const flush = () => new Promise(setImmediate);

for (const [name, cmd, idle] of AGENTS) {
  test(`${name} still working, or paused at its input box, is not a missing receipt`, async () => {
    const working = openTask();
    working.endedAt = Date.now() - QUIET;
    const busy = { alive: true, state: 'working', lastOutputAt: Date.now(), lastScreen: idle };
    const live = runtime({ cmd, task: working, entry: busy, turns: [{ id: 'turn', done: false }] });
    live.api.onTick(live.worker.id, busy);
    assert.equal(working.status, 'working');
    assert.equal(working.receipt, undefined);
    assert.equal(working.endedAt, 0);
    await flush();
    assert.equal(live.boardEvents.some((e) => e.input.type === 'fallback'), false);

    const paused = openTask();
    const prompt = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: idle };
    const held = runtime({ cmd, task: paused, entry: prompt, turns: finishedTurn });
    held.api.onTurnDone(held.worker.id, finishedTurn[0]);
    assert.equal(paused.endedAt, undefined);
    paused.endedAt = Date.now() - QUIET;
    held.api.onTick(held.worker.id, prompt);
    assert.equal(paused.status, 'working');
    assert.equal(paused.receipt, undefined);
    assert.equal(paused.endedAt, 0);
    await flush();
    assert.equal(held.boardEvents.some((e) => e.input.type === 'fallback'), false);
  });

  test(`${name} process exit or a dead terminal without a receipt is still ended`, async () => {
    const exited = openTask();
    exited.processEnded = true;
    exited.endedAt = Date.now() - QUIET;
    const shell = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: idle };
    const done = runtime({ cmd, task: exited, entry: shell, turns: finishedTurn });
    done.api.onTick(done.worker.id, shell);
    assert.equal(exited.status, 'stopped');
    assert.equal(exited.receipt.source, 'fallback');
    assert.equal(exited.receipt.summary, '已结束，未提交回执');
    await flush();
    assert.equal(done.boardEvents.at(-1).input.type, 'fallback');

    const deadTask = openTask();
    const dead = { alive: false, state: 'exited', exitReason: '终端进程已退出', lastOutputAt: Date.now() - QUIET, lastScreen: idle };
    const ended = runtime({ cmd, task: deadTask, entry: dead, turns: finishedTurn });
    ended.api.onTick(ended.worker.id, dead);
    assert.equal(deadTask.status, 'failed');
    assert.equal(deadTask.receipt.source, 'process');
    assert.match(deadTask.receipt.failed, /终端进程已退出/);
  });
}

const BACKGROUND_STATUS = 'python3 run-e2e-with-lo... running';

for (const [name, cmd, idle] of AGENTS) {
  test(`${name} waiting on a background command or the test lock is not a missing receipt`, async () => {
    const screen = `${idle}\n${BACKGROUND_STATUS}`;
    assert.equal(M.backgroundCommandStatus(screen, cmd), true);
    assert.equal(M.terminalActivity(screen, cmd), 'working');
    assert.equal(M.terminalActivity(`${idle}\npython3 run-e2e-with-lo… running`, cmd), 'working');
    assert.equal(M.backgroundCommandStatus(`${idle}\n2 background tasks running`, cmd), true);
    assert.equal(M.backgroundCommandStatus(`${idle}\n正在等全机测试锁`, cmd), true);
    assert.equal(M.backgroundCommandStatus(`${idle}\nwaiting for the test lock`, cmd), true);
    // Quoted above the prompt, or a sentence that continues past "running".
    assert.equal(M.terminalActivity(`${BACKGROUND_STATUS}\n${idle}`, cmd), '');
    assert.equal(M.terminalActivity(`${idle}\nThe notes mention ${BACKGROUND_STATUS} in the background.`, cmd), '');
    assert.equal(M.backgroundCommandStatus(`${idle}\nWaiting for execution to complete.`, cmd), false);

    const task = openTask();
    task.endedAt = Date.now() - QUIET;
    const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: screen };
    const live = runtime({ cmd, task, entry, turns: finishedTurn });
    live.api.onTick(live.worker.id, entry);
    assert.equal(task.status, 'working');
    assert.equal(task.receipt, undefined);
    assert.equal(task.endedAt, 0);
    await flush();
    assert.equal(live.boardEvents.some((e) => e.input.type === 'fallback'), false);

    const judged = openTask();
    judged.status = 'stopped';
    judged.receipt = { summary: '已结束，未提交回执', source: 'fallback', files: [] };
    judged.doneAt = Date.now();
    const again = runtime({ cmd, task: judged, entry, turns: finishedTurn });
    again.api.onTick(again.worker.id, entry);
    assert.equal(judged.status, 'working');
    assert.equal(judged.receipt, undefined);
    assert.equal(judged.endedAt, 0);
  });
}

test('Claude and a generic session do not inherit the non-Claude background status', () => {
  const screen = `❯\n${BACKGROUND_STATUS}`;
  assert.equal(M.backgroundCommandStatus(screen, B.commandForAgent('claude')), false);
  assert.equal(M.terminalActivity(screen, B.commandForAgent('claude')), '');
  assert.equal(M.backgroundCommandStatus(`>\n${BACKGROUND_STATUS}`, 'node fake-agent.js --screen-only'), false);
});

test('Antigravity "Running command…" under the ready prompt still counts as work', async () => {
  const cmd = B.commandForAgent('agy');
  const screen = '>\nAntigravity\nRunning command...';
  assert.equal(M.terminalActivity(screen, cmd), 'working');
  assert.equal(M.terminalActivity('⣾ Running command…\n>\nModel: Gemini', cmd), 'working');
  assert.equal(M.terminalActivity('The notes mention Running command...\n>\nAntigravity', cmd), '');
  const task = openTask();
  task.endedAt = Date.now() - QUIET;
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: screen };
  const { api, worker, boardEvents } = runtime({ cmd, task, entry, turns: finishedTurn });
  api.onTick(worker.id, entry);
  assert.equal(task.status, 'working');
  assert.equal(task.receipt, undefined);
  await flush();
  assert.equal(boardEvents.some((e) => e.input.type === 'fallback'), false);
});

test('Claude and a generic session still get the no-receipt notice from a quiet finished turn', () => {
  for (const cmd of [B.commandForAgent('claude'), 'node fake-agent.js --screen-only']) {
    const task = openTask();
    const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: '❯\nClaude Code' };
    const { api, worker } = runtime({ cmd, task, entry, turns: finishedTurn });
    api.onTurnDone(worker.id, finishedTurn[0]);
    assert.ok(task.endedAt > Date.now() - 5000);
    task.endedAt = Date.now() - QUIET;
    api.onTick(worker.id, entry);
    assert.equal(task.status, 'stopped');
    assert.equal(task.receipt.summary, '已结束，未提交回执');
    assert.equal(task.receipt.source, 'fallback');
  }
});

test('Claude background work still blocks the no-receipt clock', async () => {
  const endedAt = Date.now() - QUIET;
  const task = openTask();
  task.endedAt = endedAt;
  const entry = {
    alive: true, state: 'done', lastOutputAt: endedAt,
    lastScreen: '❯ \n⏵⏵ bypass permissions on · 1 shell, 1 monitor still running',
  };
  const { api, worker, boardEvents } = runtime({ cmd: B.commandForAgent('claude'), task, entry, turns: finishedTurn });
  api.onTurnDone(worker.id, finishedTurn[0]);
  assert.equal(task.endedAt, endedAt);
  api.onTick(worker.id, entry);
  assert.equal(task.status, 'working');
  assert.equal(task.endedAt, 0);
  assert.equal(task.receipt, undefined);
  await flush();
  assert.equal(boardEvents.some((e) => e.input.type === 'fallback'), false);
});
