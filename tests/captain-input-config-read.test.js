'use strict';
// Keystrokes typed into the 队长 column reach main as pty:input, one IPC per key.
// While a Claude 队长 reports itself idle (every status tick) main remembers it,
// so each of those keys cancels a pending quota warm-up for its seat. Reading
// and parsing config.json for that (a few MB: archived sessions, task bodies,
// board responses) blocked the main process on every key, holding up the
// output of every terminal. The seat is now taken from the idle report.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validId } = require('../security');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function handlerSource(start) {
  const begin = source.indexOf(start);
  assert.ok(begin >= 0, `main.js still has ${start}`);
  const end = source.indexOf('\n  });', begin) + '\n  });'.length;
  return source.slice(begin, end);
}

test('typing into the 队长 column does not reread config.json for every key', () => {
  const handlers = {};
  let configReads = 0;
  const cancels = [], writes = [];
  const context = vm.createContext({
    handleMain: (name, fn) => { handlers[name] = fn; },
    onMain: (name, fn) => { handlers[name] = fn; },
    seatConfig: () => { configReads++; return { mainSession: { colId: 'cap' }, activeClaudeSeatId: 'cn', columns: [{ id: 'cap', isMain: true, claudeSeatId: 'us' }] }; },
    validId,
    ptys: new Map([['cap', { write: (data) => writes.push(data) }], ['worker', { write: (data) => writes.push(data) }]]),
    quotaWarmup: { cancel: (seatId) => cancels.push(seatId), tick: async () => {} },
    warmupCaptain: { id: '', idle: false, at: 0 },
    Date,
  });
  vm.runInContext(handlerSource("handleMain('seats:warmup-idle'"), context);
  vm.runInContext(handlerSource("onMain('pty:input'"), context);

  // The status tick reports the idle 队长 (this reads the config once, as before).
  assert.equal(handlers['seats:warmup-idle'](null, { colId: 'cap', idle: true }), true);
  const readsForReport = configReads;
  assert.ok(readsForReport >= 1);

  for (const key of 'hello world') handlers['pty:input'](null, { id: 'cap', data: key });
  assert.equal(configReads, readsForReport, 'no config.json read per keystroke');
  assert.equal(writes.join(''), 'hello world', 'every key still reaches the terminal');
  assert.deepEqual([...new Set(cancels)], ['us'], 'each key still cancels a warm-up of the 队长 seat');
  assert.equal(cancels.length, 'hello world'.length);
  assert.equal(context.warmupCaptain.idle, false, 'typing marks the 队长 busy');

  // Other columns are untouched by the warm-up logic.
  handlers['pty:input'](null, { id: 'worker', data: 'x' });
  assert.equal(cancels.length, 'hello world'.length);
});
