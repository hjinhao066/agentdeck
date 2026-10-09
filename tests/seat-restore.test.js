'use strict';
// A restored or reopened Claude session starts only on the seat it is bound to. A seat that
// is definitely signed out, or no longer in the seat settings, starts nothing and says so.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const S = require('../claude-seats-core');
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

const seats = [
  { id: 'cn', name: 'CN', configDir: '~/.claude', email: '' },
  { id: 'us2', name: 'US2', configDir: '~/.claude-us2', email: 'us2@example.test' },
];
const crew = (extra) => ({ id: 'c-board-us2', title: 'Crew map', cmd: 'claude --dangerously-skip-permissions --model claude-opus-5-5',
  claudeSeatId: 'us2', claudeConfigDir: '~/.claude-us2', captainCrew: true, ...extra });
const signedIn = { id: 'us2', loggedIn: true, loginReason: '', authReason: '', maskedEmail: 'u***@example.test' };
const signedOut = { id: 'us2', loggedIn: false, loginReason: 'US2（us2）：没有登录凭据', authReason: '', maskedEmail: 'u***@example.test' };
const unreadable = { id: 'us2', loggedIn: false, loginReason: '', authReason: 'US2（us2）：无法核实此席位钥匙串', maskedEmail: '' };

test('launchBlock names the bound seat and its account when that seat is definitely signed out', () => {
  const config = { claudeSeats: seats, activeClaudeSeatId: 'cn' };
  assert.equal(S.launchBlock(crew(), config, [signedIn]), '');
  assert.equal(S.launchBlock(crew(), config, [signedOut]), '席位 US2（us2@example.test）未登录');
  // without a configured address, the masked account from the seat's own metadata
  assert.equal(S.launchBlock(crew(), { ...config, claudeSeats: seats.map((s) => ({ ...s, email: '' })) }, [signedOut]), '席位 US2（u***@example.test）未登录');
  // an unreadable Keychain or a failed seat list is not a logout: never stop a good session on it
  assert.equal(S.launchBlock(crew(), config, [unreadable]), '');
  assert.equal(S.launchBlock(crew(), config, []), '');
  // a seat removed from the settings: no other seat, no fallback
  assert.equal(S.launchBlock(crew({ claudeSeatId: 'us9', claudeConfigDir: '~/.claude-us9' }), config, [signedIn]), '席位 us9 已不在席位设置里');
  // the seat was pointed at another directory since: its login says nothing about this session's directory
  assert.equal(S.launchBlock(crew({ claudeConfigDir: '~/.claude-old' }), config, [signedOut]), '');
  // another program: the Claude seat is not its login
  assert.equal(S.launchBlock(crew({ cmd: 'codex --no-daemon' }), config, [signedOut]), '');
  assert.equal(S.claudeLaunch('claude --resume 1'), true);
  assert.equal(S.claudeLaunch('/opt/bin/claude --model x'), true);
  assert.equal(S.claudeLaunch('codex --model gpt'), false);
});

function world(infos) {
  const now = 1_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const columns = [captain];
  const config = { claudeSeats: seats, activeClaudeSeatId: 'cn', archived: [crew({ archivedAt: now - 1000 })],
    mainSession: { colId: captain.id, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] } };
  const restored = [];
  const window = { MainCore: M, BoardCore: B, ClaudeSeatsCore: S,
    deck: { saveConfigSync() {}, onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, claudeSeats: async () => infos },
    ChatUI: { addCard() {}, updateCard() {}, turnsOf: () => [], captainArchives: () => [] } };
  const context = vm.createContext({ window, ChatUI: window.ChatUI, MainCore: M,
    Date: class extends Date { static now() { return now; } }, setTimeout() {}, clearTimeout() {} });
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8')
    .replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; } };\n  window.MainSession = {');
  vm.runInContext(source, context);
  window.__test.setHost({ config, columns: () => columns, terms: new Map(), saveConfig() {}, flushConfig() {}, showToast() {},
    columnLabel: (col) => col.title, captainColumnVisible: () => true,
    sendWhenReady() {},
    restoreArchived(id) {
      const a = config.archived.find((x) => x.id === id);
      config.archived = config.archived.filter((x) => x !== a);
      const col = { ...a }; delete col.archivedAt;
      columns.push(col); restored.push(id);
      return col;
    } });
  return { config, captain, restored, api: window.MainSession };
}

test('tell to an archived session whose seat is signed out refuses with the seat, restores nothing and starts nothing', async () => {
  const w = world([signedOut]);
  await assert.rejects(w.api.handle({ action: 'main-tell', to: 'c-board-us2', message: '接着做' }, w.captain),
    /席位 US2（us2@example\.test）未登录/);
  await tick();
  assert.deepEqual(w.restored, []);
  assert.deepEqual(w.config.archived.map((a) => a.id), ['c-board-us2'], 'it stays archived, on its own seat');
  assert.equal(w.config.archived[0].claudeSeatId, 'us2');
});

test('tell restores an archived session when its own seat is signed in, or when the login cannot be read', async () => {
  for (const infos of [[signedIn], [unreadable]]) {
    const w = world(infos);
    const result = await w.api.handle({ action: 'main-tell', to: 'c-board-us2', message: '接着做' }, w.captain);
    assert.match(result.result, /已恢复/);
    assert.deepEqual(w.restored, ['c-board-us2']);
  }
});
