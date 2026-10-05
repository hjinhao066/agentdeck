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
