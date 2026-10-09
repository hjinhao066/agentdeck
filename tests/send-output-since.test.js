// A Relay/restart note follows the Captain's briefing. A terminal that reads lines gets the
// briefing typed, and through ConPTY the agent can still be reading it while its screen looks
// idle: a note typed then joins the briefing as one prompt. sendWhenReady's outputSince holds a
// send until the agent has drawn something after that time (at most a minute).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

const PROMPT = '\n❯ \n────────\n  ⏵⏵ bypass permissions on';

function world() {
  const renderer = fs.readFileSync(path.resolve(__dirname, '../renderer.js'), 'utf8');
  const delivered = [];
  const col = { id: 'cap', cmd: 'claude' };
  const entry = { alive: true, state: 'done', lastScreen: 'ready' + PROMPT, lastOutputAt: Date.now() - 5000, hasWorked: true };
  const context = vm.createContext({
    MainCore: M, columns: [col], terms: new Map([['cap', entry]]), env: { platform: 'win32' }, Date, setTimeout, clearTimeout, Promise,
    AGENT_IDLE_RE: /bypass permissions/, terminalIdle: () => true, userComposing: () => false, agentInForeground: async () => true,
    showToast() {}, columnLabel: (c) => c.id,
    ChatUI: { async sendPrompt(_col, text) { delivered.push(text); return true; } },
    window: { SleepResume: null, BoardCore: B },
  });
  vm.runInContext(renderer.slice(renderer.indexOf('function sendWhenReady('), renderer.indexOf('\nfunction addColumn(')), context);
  return { context, col, entry, delivered };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a send with outputSince waits until the agent has drawn something after that time', async () => {
  const w = world();
  w.context.sendWhenReady(w.col, 'RELAY-NOTE', { silent: true, outputSince: Date.now(), timeout: 5000 });
  await wait(1500);
  assert.deepEqual(w.delivered, [], 'idle-looking screen, but nothing drawn since the briefing');
  w.entry.lastOutputAt = Date.now();
  await wait(1500);
  assert.deepEqual(w.delivered, ['RELAY-NOTE']);
});

test('without outputSince the same idle screen gets the send at once', async () => {
  const w = world();
  w.context.sendWhenReady(w.col, 'NOW', { silent: true, timeout: 5000 });
  await wait(1200);
  assert.deepEqual(w.delivered, ['NOW']);
});

test('outputSince gives up waiting for output after a minute', async () => {
  const w = world();
  w.context.sendWhenReady(w.col, 'LATE', { silent: true, outputSince: Date.now() - 61_000, timeout: 5000 });
  await wait(1200);
  assert.deepEqual(w.delivered, ['LATE']);
});

test('the Captain briefing sends its note with outputSince', () => {
  const session = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8');
  assert.match(session, /if \(note && !notice\) host\.sendWhenReady\(col, note, \{ silent: true, guardUserInput: true, outputSince: Date\.now\(\) \}\);/);
});
