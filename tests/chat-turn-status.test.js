'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MainCore = require('../main-core');

test('a Cursor turn cannot finish on the old ready screen while its prompt is being submitted', () => {
  const source = fs.readFileSync(path.join(__dirname, '../chat-ui.js'), 'utf8');
  for (const flag of ['sendingPrompt', 'injecting']) {
    const open = { turn: { done: false }, startedAt: Date.now() - 30_000 };
    const context = vm.createContext({ views: new Map([['worker', {}]]), pending: new Map([['worker', open]]),
      isChatMode: () => false, columnById: () => ({ cmd: 'cursor-agent' }), window: { MainCore },
      finalizeTurn: () => { open.turn.done = true; } });
    vm.runInContext(source.slice(source.indexOf('  function onTick(id,'), source.indexOf('  function onExit(id)')), context);
    const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - 20_000, [flag]: true };
    context.onTick('worker', entry, '→ Add a follow-up');
    assert.equal(open.turn.done, false, flag);
    entry[flag] = false; entry.state = 'working';
    context.onTick('worker', entry, '→ Add a follow-up');
    assert.equal(open.turn.done, false, 'submitted work remains open');
    entry.state = 'done';
    context.onTick('worker', entry, '→ Add a follow-up');
    assert.equal(open.turn.done, true, 'a later genuinely idle turn can finish');
  }
});

test('cursor blink after a finished turn still closes it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../chat-ui.js'), 'utf8');
  const open = { turn: { done: false }, startedAt: Date.now() - 30_000 };
  const context = vm.createContext({ views: new Map([['worker', {}]]), pending: new Map([['worker', open]]),
    isChatMode: () => false, columnById: () => ({ cmd: 'claude' }), window: { MainCore },
    finalizeTurn: () => { open.turn.done = true; } });
  vm.runInContext(source.slice(source.indexOf('  function onTick(id,'), source.indexOf('  function onExit(id)')), context);
  context.onTick('worker', { alive: true, state: 'done', lastOutputAt: Date.now() }, '❯ 继续，读测试日志然后提交回执');
  assert.equal(open.turn.done, true);
});

// 10-08 Windows Captain: after a long idle Claude printed a recap and ran its prompt hook
// before the first spinner, the next status tick read done, and the turn closed with an
// empty reply that the phone never showed.
test('a turn read as done before any reply waits for one, then closes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../chat-ui.js'), 'utf8');
  let reply = '';
  const open = { turn: { done: false }, startedAt: Date.now() - 2_000, sent: 'hi', marker: null };
  const context = vm.createContext({ views: new Map([['captain', {}]]), pending: new Map([['captain', open]]),
    isChatMode: () => false, columnById: () => ({ cmd: 'claude' }), window: { MainCore },
    C: { extractReply: () => reply }, readLines: () => [],
    finalizeTurn: () => { open.turn.done = true; } });
  vm.runInContext(source.slice(source.indexOf('  function onTick(id,'), source.indexOf('  function onExit(id)')), context);
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now(), term: { cols: 49 } };
  context.onTick('captain', entry, '❯ ');
  assert.equal(open.turn.done, false, 'no reply on screen yet');
  entry.lastOutputAt = Date.now() - 10_000;
  context.onTick('captain', entry, '❯ ');
  assert.equal(open.turn.done, false, 'a quiet screen without a reply is not the end either');
  reply = 'PONG';
  context.onTick('captain', entry, '❯ ');
  assert.equal(open.turn.done, true, 'closes once the reply is there');
  reply = ''; open.turn.done = false; open.startedAt = Date.now() - 31_000;
  context.onTick('captain', entry, '❯ ');
  assert.equal(open.turn.done, true, 'a turn that never shows a reply still closes');
});
