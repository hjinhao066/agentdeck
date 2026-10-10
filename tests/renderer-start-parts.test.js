// 2.0.2: one throw at launch stopped renderer.js before 任务看板 was set up, and the board
// would not open. Every module started before it now starts on its own: a throw (or a
// rejected async init) is logged, and the script goes on to the board and the saved view.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

test('a module that fails to start is logged and the next one still starts', async () => {
  const begin = source.indexOf('\nfunction startPart(');
  assert.ok(begin >= 0, 'renderer.js defines startPart');
  const logged = [];
  const context = vm.createContext({ Promise, console: { error: (...args) => logged.push(args) } });
  vm.runInContext(source.slice(begin, source.indexOf('\n}\n', begin) + 3), context);
  const started = [];
  context.startPart('A', () => { throw new Error('A broke'); });
  context.startPart('B', async () => { throw new Error('B broke later'); });
  context.startPart('C', () => started.push('C'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['C']);
  assert.deepEqual(logged.map((args) => args[1].message), ['A broke', 'B broke later']);
});

test('every module before 任务看板 starts through startPart', () => {
  const from = source.indexOf('\nconst deckHost = ');
  const to = source.indexOf('\nTaskBoardUI.init(');
  assert.ok(from > 0 && to > from);
  const bare = source.slice(from, to).split('\n').filter((line) => /^(?:[A-Z]\w*\.init\(|render\(|renderQuotaBar\(\))/.test(line));
  assert.deepEqual(bare, [], 'started outside startPart');
});
