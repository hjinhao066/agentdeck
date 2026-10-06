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
  test(`${name} still working is not a missing receipt`, async () => {
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
  });

  test(`${name} a normally finished turn idle past three minutes reports a missing receipt`, async () => {
    const task = openTask();
    const prompt = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: idle };
    const held = runtime({ cmd, task, entry: prompt, turns: finishedTurn });
    held.api.onTurnDone(held.worker.id, finishedTurn[0]);
    assert.ok(task.endedAt > Date.now() - 5000);
    task.endedAt = Date.now() - QUIET;
    held.api.onTick(held.worker.id, prompt);
    assert.equal(task.status, 'stopped');
    assert.equal(task.receipt.summary, '已结束，未提交回执');
    assert.equal(task.receipt.source, 'fallback');
    await flush();
    assert.equal(held.boardEvents.at(-1).input.type, 'fallback');
  });

  test(`${name} a captain interrupt left at the input box is not a missing receipt`, async () => {
    const interrupted = [{ id: 'turn', done: true, interrupted: true }];
    const task = openTask();
    const prompt = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: idle };
    const held = runtime({ cmd, task, entry: prompt, turns: interrupted });
    held.api.onTurnDone(held.worker.id, interrupted[0]);
    assert.equal(task.endedAt, undefined);
    task.endedAt = Date.now() - QUIET;
    held.api.onTick(held.worker.id, prompt);
    assert.equal(task.status, 'working');
    assert.equal(task.receipt, undefined);
    assert.equal(task.endedAt, 0);
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

    const waiting = openTask();
    waiting.endedAt = Date.now() - QUIET;
    const lock = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: `${idle}\n正在等全机测试锁` };
    const queued = runtime({ cmd, task: waiting, entry: lock, turns: finishedTurn });
    queued.api.onTick(queued.worker.id, lock);
    assert.equal(waiting.status, 'working');
    assert.equal(waiting.receipt, undefined);
    assert.equal(waiting.endedAt, 0);
    await flush();
    assert.equal(queued.boardEvents.some((e) => e.input.type === 'fallback'), false);

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

// 1.2.4 reported 已结束，未提交回执 for a Codex worker that was polling a one-hour
// job with `sleep 300`: its status row read "Waiting for background terminal"
// instead of "Working", which nothing recognised. Header text comes from the
// Codex 0.160 binary and the session's own footer ("1 background terminal
// running · /ps to view · /stop to close"); the row layout is Codex's standard
// status indicator, not a captured frame.
const CODEX = B.commandForAgent('codex');
const CODEX_PROMPT = '› Ask Codex to do anything\n? for shortcuts';
const CODEX_WAITING = [
  '◦ Waiting for background terminal (5m 12s • esc to interrupt) · sleep 300',
  '◦ Waiting for background terminal · sleep 300',
  '◦ Waiting for agents (2m 3s • esc to interrupt)',
  '◦ Compacting context (41s • esc to interrupt)',
];

test('Codex status rows other than "Working" count as still working', () => {
  for (const row of CODEX_WAITING) {
    const screen = `• Ran sleep 300\n  └ (no output)\n\n${row}\n\n${CODEX_PROMPT}`;
    assert.equal(M.codexLiveStatus(screen, CODEX), true, row);
    assert.equal(M.terminalActivity(screen, CODEX), 'working', row);
    // An older turn's divider keeps the row below it, a finished turn hides one above it.
    assert.equal(M.terminalActivity(`─ Worked for 3m 1s • 12:52 ─\n${row}\n${CODEX_PROMPT}`, CODEX), 'working', row);
    assert.equal(M.terminalActivity(`${row}\n─ Worked for 3m 1s • 12:52 ─\n${CODEX_PROMPT}`, CODEX), '', row);
  }
  // A long wrapped command detail under the row still sits in the live area above the composer.
  const wrapped = `${CODEX_WAITING[0]}\n${Array(6).fill('  └ python3 - <<PY').join('\n')}\n\n${CODEX_PROMPT}`;
  assert.equal(M.terminalActivity(wrapped, CODEX), 'working');
});

// Rework of 3a7d352 (review.md items 1 to 3).
test('Codex waiting row needs its bullet: bare text lines in output are not a status row', () => {
  for (const text of [
    'Waiting for background terminal',
    'Waiting for background terminal · sleep 300',
    'Waiting for background terminal (5m 12s • esc to interrupt)',
    '  Waiting for background terminals',
    '• Waiting for background terminal',
    '• Waiting for background terminal to finish',
  ]) assert.equal(M.terminalActivity(`• Ran ls\n${text}\n\n${CODEX_PROMPT}`, CODEX), '', text);
});

test('Codex status rows cut at the screen edge ("(5m 3s • esc…") still count', () => {
  for (const row of [
    '• Waiting for background terminal (18m 29s • esc…',
    '• Waiting for agents (2m 3s • esc…',
    '◦ Compacting context (41s • esc to interr…',
    '◦ Compacting context (41s • esc to interrupt',
    '◦ Waiting for agents (1h 2m 3s • esc',
  ]) assert.equal(M.terminalActivity(`• Ran ls\n\n${row}\n  └ python3 - <<'PY'…\n\n${CODEX_PROMPT}`, CODEX), 'working', row);
  assert.equal(M.terminalActivity(`• Ran ls\n◦ Compacting context (41s • press\n\n${CODEX_PROMPT}`, CODEX), '');
});

test('Codex wait text left in scrollback, far above the input box, is history', () => {
  const filler = Array(30).fill('  some output').join('\n');
  for (const row of CODEX_WAITING) {
    assert.equal(M.terminalActivity(`${row}\n${filler}\n\n${CODEX_PROMPT}`, CODEX), '', row);
    assert.equal(M.codexLiveStatus(`${row}\n${filler}\n${CODEX_PROMPT}`, CODEX), false, row);
  }
  // Without a visible input box only the bottom of the screen is read.
  assert.equal(M.codexLiveStatus(`${CODEX_WAITING[0]}\n${filler}`, CODEX), false);
  assert.equal(M.codexLiveStatus(`${filler}\n${CODEX_WAITING[0]}`, CODEX), true);
});

test('Codex prose, history rows and other agents never look like a waiting status row', () => {
  for (const text of [
    '• Waiting for background terminal to finish, then I will report.',
    'Waiting for background terminal sessions is slow',
    '• Waited for background terminal · sleep 300',
    '• Worked for 5m 3s',
    '• Ran sleep 300\n  └ (no output)',
    'The row "◦ Waiting for agents (2m 3s • esc to interrupt)" is quoted here.',
  ]) assert.equal(M.terminalActivity(`${text}\n\n${CODEX_PROMPT}`, CODEX), '', text);
  const row = CODEX_WAITING[0];
  assert.equal(M.codexLiveStatus(`${row}\n${CODEX_PROMPT}`, B.commandForAgent('claude')), false);
  assert.equal(M.terminalActivity(`${row}\n>\nAntigravity`, B.commandForAgent('agy')), '');
});

test('Codex background-terminal footer with its "/ps to view" hint is a running command', () => {
  for (const footer of [
    '1 background terminal running · /ps to view · /stop to close',
    '3 background terminals running · /ps to view · /',
    '1 background terminal running',
  ]) assert.equal(M.backgroundCommandStatus(`${CODEX_PROMPT}\n${footer}`, CODEX), true, footer);
  assert.equal(M.backgroundCommandStatus(`${CODEX_PROMPT}\nNo background terminals running.`, CODEX), false);
  assert.equal(M.backgroundCommandStatus(`1 background terminal running · /ps to view\n${CODEX_PROMPT}`, CODEX), false);
});

test('Antigravity "Running command" holds the work open on every dot frame of its spinner', () => {
  const cmd = B.commandForAgent('agy');
  for (const frame of ['⣾  Running command', '⣟  Running command.', '⣻  Running command..', '⣽  Running command...']) {
    assert.equal(M.terminalActivity(`${frame}\n>\nAntigravity`, cmd), 'working', frame);
  }
  assert.equal(M.terminalActivity('Running command\n>\nAntigravity', cmd), '');
  assert.equal(M.terminalActivity('Running command.\n>\nAntigravity', cmd), '');
});

test('Codex blocked on a background terminal is not a missing receipt, however long it waits', async () => {
  for (const row of CODEX_WAITING) {
    const screen = `• Ran sleep 300\n\n${row}\n\n${CODEX_PROMPT}`;
    // The turn was closed early (state done) and the grace period already ran out.
    const task = openTask();
    task.endedAt = Date.now() - QUIET;
    const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: screen };
    const live = runtime({ cmd: CODEX, task, entry, turns: finishedTurn });
    live.api.onTurnDone(live.worker.id, finishedTurn[0]);
    live.api.onTick(live.worker.id, entry);
    assert.equal(task.status, 'working', row);
    assert.equal(task.receipt, undefined);
    assert.equal(task.endedAt, 0);
    await flush();
    assert.equal(live.boardEvents.some((e) => e.input.type === 'fallback'), false);

    // A fallback that already went out is withdrawn once the screen shows the wait again.
    const judged = openTask();
    judged.status = 'stopped';
    judged.receipt = { summary: '已结束，未提交回执', source: 'fallback', files: [] };
    judged.doneAt = Date.now();
    const again = runtime({ cmd: CODEX, task: judged, entry, turns: finishedTurn });
    again.api.onTick(again.worker.id, entry);
    assert.equal(judged.status, 'working');
    assert.equal(judged.receipt, undefined);
  }
});

test('Codex that finished and sits idle still reports a missing receipt after the wait row is gone', async () => {
  const idle = '─ Worked for 34m 29s • 12:52 ─\n› Ask Codex to do anything\n? for shortcuts';
  // The wait ended: the same row is above the new divider and no longer counts.
  const screen = `◦ Waiting for background terminal (5m 12s • esc to interrupt) · sleep 300\n${idle}`;
  assert.equal(M.terminalActivity(screen, CODEX), '');
  const task = openTask();
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: screen };
  const held = runtime({ cmd: CODEX, task, entry, turns: finishedTurn });
  held.api.onTurnDone(held.worker.id, finishedTurn[0]);
  assert.ok(task.endedAt > Date.now() - 5000);
  task.endedAt = Date.now() - QUIET;
  held.api.onTick(held.worker.id, entry);
  assert.equal(task.status, 'stopped');
  assert.equal(task.receipt.summary, '已结束，未提交回执');
  assert.equal(task.receipt.source, 'fallback');
  await flush();
  assert.equal(held.boardEvents.at(-1).input.type, 'fallback');
});

test('Codex that ended with wait text still in its scrollback reports a missing receipt after 3 minutes', async () => {
  // No new "Worked for" divider (so the trimming never applies); the old row has scrolled far up.
  const screen = `${CODEX_WAITING[0]}\n${Array(40).fill('  some output').join('\n')}\n\n${CODEX_PROMPT}`;
  assert.equal(M.terminalActivity(screen, CODEX), '');
  const task = openTask();
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: screen };
  const held = runtime({ cmd: CODEX, task, entry, turns: finishedTurn });
  held.api.onTurnDone(held.worker.id, finishedTurn[0]);
  task.endedAt = Date.now() - QUIET;
  held.api.onTick(held.worker.id, entry);
  assert.equal(task.status, 'stopped');
  assert.equal(task.receipt.summary, '已结束，未提交回执');
  await flush();
  assert.equal(held.boardEvents.at(-1).input.type, 'fallback');
});
