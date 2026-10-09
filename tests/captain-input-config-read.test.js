'use strict';
// Keystrokes typed into the 队长 column reach main as pty:input, one IPC per key.
// While a Claude 队长 reports itself idle (every status tick) main remembers it,
// so each of those keys cancels a pending quota warm-up for its seat. Reading
// and parsing config.json for that (a few MB: archived sessions, task bodies,
// board responses) blocked the main process on every key, holding up the
// output of every terminal. The seat now comes from the cached view of
// config.json, which is read again only when the file changes - so a key
// still cancels the warm-up of the seat the 队长 uses now.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
// The view of config.json the handlers read, declared next to seatConfig.
const view = (/\n {2}let seatView = [\s\S]*?\n {2}};\n/.exec(source) || [''])[0];

function captain(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-input-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  // As main writes it: a new file renamed over the old one.
  const write = (cfg) => { fs.writeFileSync(configPath + '.tmp', JSON.stringify(cfg)); fs.renameSync(configPath + '.tmp', configPath); };
  const config = (seatId) => ({ mainSession: { colId: 'cap' }, activeClaudeSeatId: 'cn',
    columns: [{ id: 'cap', isMain: true, ...(seatId ? { claudeSeatId: seatId } : {}) }, { id: 'worker' }] });
  write(config('us'));
  const handlers = {};
  let configReads = 0;
  const cancels = [], writes = [];
  const context = vm.createContext({
    handleMain: (name, fn) => { handlers[name] = fn; },
    onMain: (name, fn) => { handlers[name] = fn; },
    seatConfig: () => { configReads++; try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return {}; } },
    validId, fs, configPath,
    ptys: new Map([['cap', { write: (data) => writes.push(data) }], ['worker', { write: (data) => writes.push(data) }]]),
    quotaWarmup: { cancel: (seatId) => cancels.push(seatId), tick: async () => {} },
    warmupCaptain: { id: '', idle: false, at: 0 },
    Date,
  });
  vm.runInContext(view + handlerSource("handleMain('seats:warmup-idle'") + '\n' + handlerSource("onMain('pty:input'"), context);
  return { context, handlers, write, config, cancels, writes, reads: () => configReads,
    report: (idle) => handlers['seats:warmup-idle'](null, { colId: 'cap', idle }),
    type: (id, text) => { for (const key of text) handlers['pty:input'](null, { id, data: key }); } };
}

test('typing into the 队长 column does not reread config.json for every key', (t) => {
  const c = captain(t);
  // The status tick reports the idle 队长 (this reads the config once, as before).
  assert.equal(c.report(true), true);
  const readsForReport = c.reads();
  assert.ok(readsForReport >= 1);

  c.type('cap', 'hello world');
  assert.equal(c.reads(), readsForReport, 'no config.json read per keystroke');
  assert.equal(c.writes.join(''), 'hello world', 'every key still reaches the terminal');
  assert.deepEqual([...new Set(c.cancels)], ['us'], 'each key still cancels a warm-up of the 队长 seat');
  assert.equal(c.cancels.length, 'hello world'.length);
  assert.equal(c.context.warmupCaptain.idle, false, 'typing marks the 队长 busy');

  // Other columns are untouched by the warm-up logic.
  c.type('worker', 'x');
  assert.equal(c.cancels.length, 'hello world'.length);
});

test('a key cancels the warm-up of the seat the 队长 uses now, not the one it last reported', (t) => {
  const c = captain(t);
  c.report(true);
  // The 队长's seat changes in config.json before its next idle report.
  c.write(c.config('cn2'));
  c.type('cap', 'ab');
  assert.deepEqual(c.cancels, ['cn2', 'cn2']);
  // A column without a seat of its own uses the active seat, as main always did.
  c.write(c.config(null));
  c.cancels.length = 0;
  c.type('cap', 'c');
  assert.deepEqual(c.cancels, ['cn']);
});
