'use strict';
// 10-08 evening: Claude workers in narrow columns were archived while a background
// shell still ran (its render/test got killed), and the Captain's tells to them sat
// queued for 30–60 minutes. The rows below are the ones the Captain read off those
// screens: the footer cut at the column width ("· 1 she"), the completed-turn status
// row folded onto three rows, and the row Claude shows while a background agent runs.
// Each screen goes through the same steps as the app: the status tick (classify,
// backgroundOnlyState), the tell gate (workingForSend, tellWaitReason) and the
// automatic archive (maybeArchive).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
const rendererContext = vm.createContext({ MainCore: M });
vm.runInContext(source.slice(source.indexOf('const WORKING_RE'), source.indexOf('function setDot')), rendererContext);
const { classify, backgroundOnlyState, terminalIdle } = rendererContext;

const CMD = 'claude --dangerously-skip-permissions --model claude-opus-5-5';
const MIN = 60_000;
const RULE = '─'.repeat(30);
const FOOTER = '  ⏵⏵ bypass permissions on';
const FOOTER_CUT = '  ⏵⏵ bypass permissions on · 1 she';
const worker = (above, footer = FOOTER) => [...above, RULE, '❯ ', RULE, footer].join('\n');

const LIVE = {
  // The status row folded onto three rows, and the footer cut short.
  'folded status row': worker(['⏺ 测试在后台跑，跑完我再交回执。', '', '✻ Churned for 3m 55s · done', '9:16 PM · 1 shell still', 'running'], FOOTER_CUT),
  // A background notice landed under the status row, so that row is history: only
  // the cut footer still counts the shell that is left.
  'cut footer only': worker(['✻ Churned for 3m 55s · done', '9:16 PM · 2 shells still', 'running', '',
    '⏺ Background command "Run unit', '  tests" completed (exit code 0)'], FOOTER_CUT),
  'waiting for a background agent': worker(['⏺ 两个调研已经放到后台。', '', '✻ Waiting for 1 background agent to finish']),
  'waiting row folded': worker(['⏺ 两个调研已经放到后台。', '', '✻ Waiting for 1 background', 'agent to finish']),
  'status row folded onto four rows': worker(['⏺ 继续等。', '', '✻ Churned for 3m 55s ·', 'done 9:16 PM · 1 shell,', '1 monitor still', 'running']),
};
// The same session once the shell ended and the turn after it finished: the folded
// row is history, the footer has no count.
const ENDED = worker(['✻ Churned for 3m 55s · done', '9:16 PM · 1 shell still', 'running', '',
  '⏺ Background command "Run unit', '  tests" completed (exit code 0)', '', '⏺ 测试全过，回执已交。', '', '✻ Brewed for 12s · done 9:31 PM']);

// One status tick, as renderer.js runs it.
function tick(screen) {
  const entry = { alive: true, hasWorked: true, state: 'working', lastOutputAt: Date.now() - 10 * MIN, lastScreen: screen };
  const st = classify(screen, entry, CMD);
  entry.state = st;
  entry.backgroundOnly = backgroundOnlyState(st, false, screen, entry, CMD);
  return entry;
}

test('real narrow screens: the background shell, monitor or agent is seen', () => {
  for (const [name, screen] of Object.entries(LIVE)) assert.equal(M.claudeBackgroundTasks(screen, CMD), true, name);
  assert.equal(M.claudeBackgroundTasks(ENDED, CMD), false);
});

test('real narrow screens: the dot stays busy, but the idle prompt takes a tell', () => {
  for (const [name, screen] of Object.entries(LIVE)) {
    const entry = tick(screen);
    assert.equal(entry.state, 'working', name);
    assert.equal(entry.backgroundOnly, true, name);
    assert.equal(M.workingForSend(entry), false, name);
    assert.equal(M.tellWaitReason({ entry, screen, cmd: CMD, composing: false, foreground: true }), '', name);
  }
});

test('after the work ended, the old folded "running" row does not keep the session busy', () => {
  const entry = tick(ENDED);
  assert.equal(entry.state, 'done');
  assert.equal(M.workingForSend(entry), false);
  assert.equal(M.tellWaitReason({ entry, screen: ENDED, cmd: CMD, composing: false, foreground: true }), '');
  assert.equal(terminalIdle({ cmd: CMD }, { ...entry, lastScreen: ENDED }), true);
});

// 10-09 06:04, Claude Code 2.1.294 in this repo's real-app check: an effort hint and a
// rule carrying the session name sit between the status row and the prompt.
const REAL_2_1_294 = ['✻ Worked for 2s · done 11:04 PM · 1 ', '  shell still running', '                  ◐ medium · /effort',
  '────────────────────────── verify-bg ─', '❯ ', '──────────────────────────────────────'];
test('Claude 2.1.294: the effort hint and a named rule under the status row do not hide its count', () => {
  for (const footer of ['  ⏵⏵ bypass permissions on · 1 shell', '  ⏵⏵ bypass permissions on']) {
    assert.equal(M.claudeBackgroundTasks([...REAL_2_1_294, footer].join('\n'), CMD), true, footer);
  }
  const apart = ['✻ Worked for 2s · done 11:04 PM · 1 shell still running', '', '                  ◐ medium · /effort', ...REAL_2_1_294.slice(3), '  ⏵⏵ bypass permissions on'];
  assert.equal(M.claudeBackgroundTasks(apart.join('\n'), CMD), true);
  const entry = tick([...REAL_2_1_294, '  ⏵⏵ bypass permissions on'].join('\n'));
  assert.equal(entry.state, 'working');
  assert.equal(M.workingForSend(entry), false);
  // Once the work is over the same layout reads idle.
  assert.equal(M.claudeBackgroundTasks(['✻ Worked for 2s · done 11:09 PM', '                  ◐ medium · /effort', ...REAL_2_1_294.slice(3), '  ⏵⏵ bypass permissions on'].join('\n'), CMD), false);
});

test('a live spinner right under a finished turn row is not taken for a folded part of that row', () => {
  for (const spinner of ['· Thinking… (esc to interrupt)', '* Brewing… (3s · ↓ 12 tokens)', '✢ Considering...']) {
    const live = worker(['✻ Brewed for 12s', spinner]);
    assert.equal(tick(live).state, 'working', spinner);
  }
  // A real fold may still start with the separator.
  assert.equal(M.claudeBackgroundTasks(worker(['✻ Churned for 3m 55s', '· done 9:16 PM · 1 shell still running']), CMD), true);
});

test('only the background-agent wait is blanked: another live "Waiting for …" spinner is still work', () => {
  const live = worker(['⏺ 正在调接口。', '', '✻ Waiting for the API response… (12s · esc to interrupt)']);
  assert.equal(tick(live).state, 'working');
  assert.equal(M.claudeBackgroundTasks(live, CMD), false);
  assert.equal(tick(live).backgroundOnly, false);
});

test('cut footers count only a background word cut at the end, never other segments', () => {
  for (const footer of ['  ⏵⏵ bypass permissions on · 1 sh', '  ⏵⏵ bypass permissions on · 2 shells', '  ⏵⏵ bypass permissions on · 1 mon',
    '  ⏵⏵ bypass permissions on · 1 shell still runn', '  ⏵⏵ bypass permissions on · 1 shell · es…']) {
    assert.equal(M.claudeBackgroundTasks(worker([], footer), CMD), true, footer);
  }
  for (const footer of ['  ⏵⏵ bypass permissions on · 1 s', '  ⏵⏵ bypass permissions on · 1 MCP server failed',
    '  ⏵⏵ bypass permissions on · 1 shell completed', '  ⏵⏵ bypass permissions on · 0 she', '  ⏵⏵ bypass permissions on · 1 she · ? for shortcuts']) {
    assert.equal(M.claudeBackgroundTasks(worker([], footer), CMD), false, footer);
  }
  // The waiting row counts only right above the prompt; a reply under it makes it history.
  assert.equal(M.claudeBackgroundTasks(worker(['✻ Waiting for 1 background agent to finish', '', '⏺ 后台调研回来了。']), CMD), false);
  assert.equal(M.claudeBackgroundTasks(worker(['⏺ I am Waiting for 1 background agent to finish']), CMD), false);
  assert.equal(M.claudeBackgroundTasks(LIVE['cut footer only'], 'codex'), false);
});

// ---- the automatic archive ----
function archiveRun(screen) {
  const archived = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const col = { id: 'worker', cmd: CMD, captainCrew: true };
  const entry = { ...tick(screen), term: {}, lastOutputAt: Date.now() - 30 * MIN };
  const terms = new Map([[captain.id, { alive: true, state: 'done' }], [col.id, entry]]);
  const window = {
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, taskBoard: (op) => Promise.resolve(op === 'list' ? [] : {}) },
    MainCore: M, BoardCore: B, ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const tasks = [{ id: 't', colId: col.id, status: 'done', sentAt: Date.now() - 60 * MIN, doneAt: Date.now() - 40 * MIN }];
  window.MainSession.init({
    config: { mainSession: { colId: captain.id, tasks, pending: [], inflight: [], waitlist: [] }, folders: [] }, saveConfig() {},
    columns: () => [captain, col], terms, userComposing: () => false, columnLabel: (c) => c.id, isBackstage: (c) => !!c.captainCrew && !c.isMain,
    focusedId: () => '', lastTurnTs: () => Date.now() - 30 * MIN, archiveColumn: (c) => { if (!archived.includes(c.id)) archived.push(c.id); },
    dumpScreen: () => screen, screenState: (text, e, cmd) => classify(text, e, cmd),
  });
  return (async () => {
    window.MainSession.onTick(col.id, entry);
    await new Promise(setImmediate);
    window.MainSession.onTick(col.id, entry);
    return archived;
  })();
}

test('a quiet session showing any of these screens is never archived; once the work ended it is', async () => {
  for (const [name, screen] of Object.entries(LIVE)) assert.deepEqual(await archiveRun(screen), [], name);
  assert.deepEqual(await archiveRun(ENDED), ['worker']);
});
