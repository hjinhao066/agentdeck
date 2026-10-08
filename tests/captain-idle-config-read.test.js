'use strict';
// A Claude 队长 reports itself idle to main on every status tick (1.5 s, 3 s on
// battery), so the quota warm-up knows that seat is free. Each report read and
// parsed the whole config.json (a few MB: archived sessions, task bodies,
// board responses) on the main process, holding up every terminal's output,
// although the file rarely changes between two ticks. It is now parsed again
// only when the file has changed.

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
// State the handler keeps between reports, declared right above it.
const state = (/\n {2}let warmupIdleConfig = [^\n]*\n/.exec(source) || [''])[0];

function captain(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-idle-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  // As main writes it: a new file renamed over the old one.
  const write = (cfg) => { fs.writeFileSync(configPath + '.tmp', JSON.stringify(cfg)); fs.renameSync(configPath + '.tmp', configPath); };
  const config = (colId, seatId) => ({ mainSession: { colId }, activeClaudeSeatId: 'cn',
    columns: [{ id: 'cap', isMain: true, claudeSeatId: seatId }, { id: 'next', isMain: true }] });
  write(config('cap', 'us'));
  let parses = 0;
  const handlers = {}, cancels = [];
  const context = vm.createContext({
    handleMain: (name, fn) => { handlers[name] = fn; },
    seatConfig: () => { parses++; try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return {}; } },
    fs, configPath, validId,
    ptys: new Map([['cap', {}], ['next', {}]]),
    quotaWarmup: { cancel: (seatId) => cancels.push(seatId), tick: async () => {} },
    warmupCaptain: { id: '', idle: false, at: 0, seatId: '' },
    Date,
  });
  vm.runInContext(state + handlerSource("handleMain('seats:warmup-idle'"), context);
  return { report: (colId, idle) => handlers['seats:warmup-idle'](null, { colId, idle }), parses: () => parses, write, config, cancels, context };
}

test('an idle 队长 reporting every tick parses an unchanged config.json once', (t) => {
  const c = captain(t);
  for (let i = 0; i < 10; i++) assert.equal(c.report('cap', true), true);
  assert.equal(c.parses(), 1, 'ten reports, one parse');
  assert.equal(c.context.warmupCaptain.id, 'cap');
  assert.equal(c.context.warmupCaptain.idle, true);
  assert.equal(c.context.warmupCaptain.seatId, 'us');
});

test('a changed config.json is read again at the next report', (t) => {
  const c = captain(t);
  c.report('cap', true);
  // The 队长 moved to another seat: a busy report cancels that seat's warm-up.
  c.write(c.config('cap', 'cn'));
  assert.equal(c.report('cap', false), true);
  assert.equal(c.parses(), 2);
  assert.deepEqual(c.cancels, ['cn']);
  // Another column became the 队长: the old one's reports are refused.
  c.write(c.config('next', 'cn'));
  assert.equal(c.report('cap', true), false);
  assert.equal(c.report('next', true), true);
  assert.equal(c.parses(), 3);
});
