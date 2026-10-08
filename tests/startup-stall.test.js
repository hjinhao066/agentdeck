'use strict';
// A command line that starts but never draws anything (Claude Code 2.1.292 waiting
// on macOS's "downloaded from the Internet" dialog, 10-07) must not receive the task
// text, and the Captain must be told the task did not go in. Stand-in agents only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

const renderer = fs.readFileSync(path.resolve(__dirname, '../renderer.js'), 'utf8');
const MIN = 60_000;
const echo = (cmd) => `jinhao@mac agentdeck % ${cmd}; node "$AGENTDECK_BOARD_CLI" session-exit --code "$?"`;
const BANNER = '\n╭─────────────╮\n│ ✻ Welcome to Claude Code │\n╰─────────────╯\n? for shortcuts\n❯';

function world(cmd = 'claude --model opus') {
  let now = 10_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd };
  const columns = [captain, worker], timers = [], delivered = [], boardCalls = [];
  const config = { mainSession: { colId: captain.id, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] } };
  const entry = { alive: true, state: 'plain', lastScreen: echo(cmd), lastOutputAt: now, launchedAt: now,
    term: { modes: { bracketedPasteMode: true } } };
  const terms = new Map([[worker.id, entry]]);
  const window = { MainCore: M, BoardCore: B, deck: { saveConfigSync() {}, onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
    taskBoard: async (name, input) => { boardCalls.push({ name, ...input }); return { card: {}, notices: [] }; } }, ChatUI: {
    addCard() {}, updateCard() {}, turnsOf: () => [],
    async sendPrompt(col, text) { delivered.push(text); return { id: 'turn-' + delivered.length }; },
  } };
  const context = vm.createContext({ window, ChatUI: window.ChatUI, MainCore: M, columns, terms,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn) { timers.push(fn); }, clearTimeout() {},
    env: { platform: 'darwin' }, userComposing: () => false, agentInForeground: async () => true });
  // The real readiness code and regexes, not copies.
  vm.runInContext(renderer.slice(renderer.indexOf('const WORKING_RE'), renderer.indexOf('const WEB_QUEUED_TIP')), context);
  vm.runInContext(renderer.slice(renderer.indexOf('function sendWhenReady('), renderer.indexOf('\nfunction addColumn(')), context);
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8')
    .replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; }, dispatch };\n  window.MainSession = {');
  vm.runInContext(source, context);
  window.__test.setHost({ config, columns: () => columns, terms, saveConfig() {}, columnLabel: (col) => col.id,
    sendWhenReady: context.sendWhenReady, showToast() {}, userComposing: () => false, agentInForeground: async () => true });
  return { config, worker, captain, entry, delivered, boardCalls, api: window.MainSession, context, timers,
    dispatch(text) {
      const task = window.__test.dispatch(worker, text, '探针任务');
      task.boardId = 'card-1'; task.boardAttempt = 'attempt-1';
      return task;
    },
    screen(text) { entry.lastScreen = text; entry.lastOutputAt = now; },
    async advance(ms) {
      for (let spent = 0; spent < ms; spent += 500) {
        now += Math.min(500, ms - spent);
        const due = timers.splice(0);
        for (const fn of due) await fn();
        await tick();
      }
    },
    tick() { return this.api.onTick(worker.id, entry); },
  };
}

const BODY = '请完成这件事。\n第二段。\n第三段。\nUNIQUE-END';

test('launchEchoOnly: only the launch line on screen, however the rows wrap', () => {
  const line = echo('claude --model opus --permission-mode bypassPermissions');
  assert.equal(M.launchEchoOnly(line), true);
  assert.equal(M.launchEchoOnly(line.replace(/(.{23})/g, '$1\n')), true, 'soft-wrapped rows');
  assert.equal(M.launchEchoOnly('Last login: today\n' + line + '\n'), true);
  assert.equal(M.launchEchoOnly('PS C:\\work> codex; node "$env:AGENTDECK_BOARD_CLI" session-exit --code "$LASTEXITCODE"'), true);
  assert.equal(M.launchEchoOnly(line + BANNER), false, 'the agent drew something below the launch line');
  assert.equal(M.launchEchoOnly(line + '\nzsh: command not found: claude\njinhao@mac %'), false);
  assert.equal(M.launchEchoOnly(''), false);
  assert.equal(M.launchEchoOnly('plain shell % ls'), false);
});

test('startup limits: 3 minutes by default, longer for Cursor whose first minutes are quiet', () => {
  assert.equal(M.startupLimit('claude'), 3 * MIN);
  assert.equal(M.startupLimit('codex --yolo'), 3 * MIN);
  assert.equal(M.startupLimit('agy'), 3 * MIN);
  assert.equal(M.startupLimit('cursor-agent --force'), 6 * MIN);
  assert.ok(M.startupLimit('cursor-agent') >= 3 * 2 * MIN, 'at least three times the slowest normal Cursor start of two minutes');
});

for (const cmd of ['claude --model opus', 'codex --yolo', 'agy']) test(`${cmd}: silent start never receives the task; the Captain gets a startup-failure receipt after 3 minutes`, async () => {
  const w = world(cmd); const task = w.dispatch(BODY);
  await w.advance(2 * MIN + 55_000);
  assert.deepEqual(w.delivered, [], 'nothing typed while the agent has drawn nothing');
  assert.equal(task.status, 'queued'); assert.equal(w.config.mainSession.pending.length, 0);
  await w.advance(10_000);
  assert.deepEqual(w.delivered, []);
  assert.equal(task.status, 'failed');
  assert.equal(task.receipt.source, 'startup');
  assert.equal(task.instructionSent, false);
  assert.equal(task.receipt.undeliveredInstruction, BODY, 'the full text is kept for re-dispatch');
  const failed = task.receipt.failed;
  assert.match(failed, /启动失败/); assert.match(failed, /没有送达|没送达/); assert.match(failed, /3 分钟/);
  assert.match(failed, /可能原因/); assert.ok(failed.includes('session-exit'), 'the last screen rows are in the receipt');
  assert.ok(!failed.includes('UNIQUE-END'), 'the task text is not echoed into the receipt');
  const pending = w.config.mainSession.pending;
  assert.equal(pending.length, 1); assert.equal(pending[0].anomaly, 'startup'); assert.equal(pending[0].undeliveredTaskId, task.id);
  const read = await w.api.handle({ action: 'main-receipts' }, w.captain);
  assert.match(read.result, /异常回执（启动失败/); assert.match(read.result, new RegExp('read --id ' + task.id));
  // The card goes to the failure path, never to 完成/待验收 or the "stopped without a result" path.
  await tick();
  assert.deepEqual(w.boardCalls.map((c) => c.type), ['failed']);
  assert.equal(w.boardCalls[0].source, 'startup');
  assert.match(w.boardCalls[0].message, /启动失败/);
  // Later: nothing more is typed, and the old "已结束，未提交回执" never appears.
  await w.advance(15 * MIN); w.tick(); w.tick();
  assert.deepEqual(w.delivered, []);
  assert.ok(!JSON.stringify(w.config.mainSession).includes('已结束，未提交回执'));
  assert.equal(w.config.mainSession.pending.length, 0, 'the Captain was told once');
  // The user finally clicks "Open": the late banner still does not resurrect the dead task.
  w.screen(echo(cmd) + BANNER); await w.advance(30_000);
  assert.deepEqual(w.delivered, []); assert.equal(task.status, 'failed');
});

test('Cursor: two quiet minutes are normal; it is not given up on before 6 minutes', async () => {
  const w = world('cursor-agent --force'); const task = w.dispatch(BODY);
  await w.advance(5 * MIN + 50_000);
  assert.deepEqual(w.delivered, []); assert.equal(task.status, 'queued');
  await w.advance(20_000);
  assert.equal(task.status, 'failed'); assert.equal(task.receipt.source, 'startup'); assert.match(task.receipt.failed, /6 分钟/);
});

test('Cursor that draws its prompt after 110 seconds gets the task', async () => {
  const w = world('cursor-agent --force'); const task = w.dispatch(BODY);
  await w.advance(110_000);
  assert.deepEqual(w.delivered, []);
  w.screen(echo('cursor-agent --force') + '\nCursor Agent\n→ Add a follow-up');
  await w.advance(5_000);
  assert.equal(w.delivered.length, 1); assert.equal(task.status, 'working');
});

test('normal start is unchanged: Claude that paints its banner is served at once', async () => {
  const fast = world(); const a = fast.dispatch(BODY);
  fast.screen(echo('claude --model opus') + BANNER);
  await fast.advance(2_000);
  assert.deepEqual(fast.delivered, [BODY]);
  assert.equal(a.status, 'working');
});

test('a slow but alive Claude (banner at 2.5 minutes) is waited for and then served', async () => {
  const slow = world(); const b = slow.dispatch(BODY);
  await slow.advance(150_000);
  assert.deepEqual(slow.delivered, []); assert.equal(b.status, 'queued');
  slow.screen(echo('claude --model opus') + BANNER);
  await slow.advance(2_000);
  assert.equal(slow.delivered.length, 1); assert.equal(b.status, 'working');
  assert.equal(slow.boardCalls.filter((c) => c.type === 'failed').length, 0);
});

test('an unrecognised agent that prints something still settles for quiet output after 15 seconds', async () => {
  const w = world('my-agent --chat'); const task = w.dispatch(BODY);
  w.screen(echo('my-agent --chat') + '\nhello, ask me anything >');
  await w.advance(14_000); assert.deepEqual(w.delivered, []);
  await w.advance(6_000);
  assert.equal(w.delivered.length, 1); assert.equal(task.status, 'working');
});

test('a session whose launch line has scrolled away (alt-screen TUI) is not mistaken for a silent start', async () => {
  const w = world('agy'); const task = w.dispatch(BODY);
  w.screen('Antigravity\n> ');
  await w.advance(2_000);
  assert.equal(w.delivered.length, 1); assert.equal(task.status, 'working');
});

test('the other readiness check (managed tasks) also refuses a launch line that only looks like "codex"', () => {
  const w = world('codex --yolo');
  assert.equal(w.context.terminalIdle(w.worker, w.entry), false, 'the echoed word codex is not the agent');
  w.screen(echo('codex --yolo') + '\n>_ OpenAI Codex (v0.1)\n› ');
  assert.equal(w.context.terminalIdle(w.worker, w.entry), true);
});
