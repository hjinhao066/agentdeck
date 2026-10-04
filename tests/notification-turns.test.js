'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const NotificationPolicy = require('../notification-policy');
const source = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');

function harness() {
  let now = 1000;
  const sent = [];
  const columns = [{ id: 'manual', role: 'manual' }, { id: 'crew', role: 'manual', captainCrew: true }, { id: 'captain', isMain: true }];
  const terms = new Map(columns.map((c) => [c.id, { alive: true, term: { cols: 80 }, lastOutputAt: now }]));
  const turns = new Map(columns.map((c) => [c.id, []]));
  const ctx = vm.createContext({ columns, terms, NotificationPolicy,
    Date: { now: () => now }, getComputedStyle: () => ({ display: 'none' }),
    MainCore: require('../main-core'),
    ChatUI: { turnsOf: (id) => turns.get(id) }, ChatCore: { extractReply: () => 'finished' },
    window: { deck: { notifyCancel() {}, notifyState: (p) => sent.push(p) } } });
  vm.runInContext(source.slice(source.indexOf('const WORKING_RE ='), source.indexOf('function setDot(')), ctx);
  vm.runInContext(source.slice(source.indexOf('function manualPromptSent('), source.indexOf('let lastAttnCount =')), ctx);
  return { ctx, columns, terms, turns, sent, time: (v) => { now = v; },
    start(id = 'manual', user = true) {
      const turn = { id: 'turn-' + turns.get(id).length, user: 'do work', reply: 'finished', done: true };
      turns.get(id).push(turn);
      ctx.manualPromptSent(id, turn, user);
      ctx.manualTurnDone(id, turn);
      return turn;
    }, tick(id = 'manual', state = 'done') { ctx.maybeNotifyState(id, terms.get(id), state); } };
}

test('startup, replayed history and a fresh renderer never arm manual or Captain startup alerts', () => {
  const h = harness();
  for (const id of ['manual', 'crew', 'captain']) {
    h.turns.get(id).push({ id: 'old-turn', reply: 'old output', done: true });
    h.terms.get(id).hasWorked = true;
    h.tick(id, 'input'); h.time(60000); h.tick(id);
  }
  assert.equal(h.sent.length, 0);
});
test('only this live user turn can notify, after 12 seconds without new output', () => {
  const h = harness(); h.start();
  h.time(12999); h.tick(); assert.equal(h.sent.length, 0);
  h.terms.get('manual').lastOutputAt = 12999;
  h.time(24998); h.tick(); assert.equal(h.sent.length, 0);
  h.time(24999); h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].userInitiated, true);
  h.tick(); assert.equal(h.sent.length, 1);
});
test('automatic sends revoke an armed manual turn; managed workers cannot arm even from user input', () => {
  const h = harness(); h.start();
  h.ctx.manualPromptSent('manual', null, false);
  h.start('crew'); h.time(60000); h.tick(); h.tick('crew');
  assert.equal(h.sent.length, 0);
  h.start('manual', false); h.time(90000); h.tick();
  assert.equal(h.sent.length, 0);
});
test('a live user turn with no reply still alerts, without deriving eligibility from stale output', () => {
  const h = harness(); const turn = h.start(); turn.reply = '';
  h.ctx.manualTurnDone('manual', turn); h.time(60000); h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].reply, '本轮输出已停止。');
});
test('interruption and exit never become manual completion; a new user turn can alert', () => {
  const h = harness(); const turn = h.start();
  h.tick('manual', 'working'); turn.interrupted = true;
  h.ctx.manualTurnDone('manual', turn); h.time(60000); h.tick();
  assert.equal(h.sent.length, 0);
  h.terms.get('manual').alive = false;
  const next = h.start(); h.ctx.manualTurnDone('manual', next); h.tick('manual', 'exited');
  assert.equal(h.sent.length, 0);
  h.terms.get('manual').alive = true; h.start(); h.time(90000); h.tick();
  assert.equal(h.sent.length, 1);
});
test('Gemini thinking prose is not a confirmation dialog; actual idle controls still are', () => {
  const h = harness();
  for (const screen of ['I am waiting for confirmation before continuing.\nAntigravity',
    'waiting for confirmation\nAntigravity', 'Thinking: waiting for confirmation\n⠋ Working\nAntigravity']) {
    assert.notEqual(h.ctx.classify(screen, { hasWorked: true }), 'input', screen);
  }
  for (const screen of ['Proceed with the change? (y/n)', '❯ 1. Allow once\n  2. Reject', 'Approve tool use\nEnter to confirm']) {
    assert.equal(h.ctx.classify(screen, {}), 'input', screen);
  }
});
