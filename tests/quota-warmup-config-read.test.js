'use strict';
// The quota warm-up ticks every 30 s while the app is open (it is on unless
// switched off). Each tick read its settings, threshold, seats, every seat's
// quota, the columns and the 队长's id through separate full parses of
// config.json - about a dozen synchronous parses of a file of several MB on
// the main process, every 30 s. They now come from one view of the file that is
// rebuilt only when the file changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { validId } = require('../security');
const { createWarmupService } = require('../quota-warmup-service');
const { occupied } = require('../quota-warmup-occupancy');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
// From the warm-up's state to the end of its IPC handlers, as main.js has it.
const startMark = 'checkQuotaBark(); // A fresh low sample at launch alerts once, across relaunches too.\n';
const endMark = '  if (tudArg) app.testQuotaWarmup = quotaWarmup;';
const begin = source.indexOf(startMark), end = source.indexOf(endMark);
assert.ok(begin >= 0 && end > begin, 'main.js still sets up the quota warm-up');
const region = source.slice(begin + startMark.length, end);
// The view of config.json, wherever main.js declares it.
const view = (/\n {2}let seatView = [\s\S]*?\n {2}};\n/.exec(source) || [''])[0];

function warmup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-warmup-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  // As main writes it: a new file renamed over the old one.
  const write = (cfg) => { fs.writeFileSync(configPath + '.tmp', JSON.stringify(cfg)); fs.renameSync(configPath + '.tmp', configPath); };
  const config = (enabled) => ({ quotaWarmup: { enabled }, perpetualCaptain: { threshold: 3 }, activeClaudeSeatId: 'cn',
    claudeSeats: [{ id: 'cn', name: 'CN', configDir: path.join(dir, 'cn') }, { id: 'us', name: 'US', configDir: path.join(dir, 'us') }],
    mainSession: { colId: 'cap', tasks: [] }, columns: [{ id: 'cap', isMain: true, claudeSeatId: 'cn' }],
    archived: Array.from({ length: 50 }, (_, i) => ({ id: 'a' + i, taskPrompt: 'x'.repeat(2000) })) });
  write(config(true));
  let parses = 0, seatReads = 0;
  const handlers = {};
  const context = vm.createContext({
    seatConfig: () => { parses++; try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return {}; } },
    fs, path, configPath, validId, Date,
    app: { getPath: () => dir }, ENV: {}, seatHome: dir, tudArg: true, ptys: new Map(),
    createQuotaWarmupRunner: () => ({ run: async () => ({ ok: false }) }), createWarmupService,
    PerpetualCaptainCore: require('../perpetual-captain-core'), ClaudeSeatsCore: require('../claude-seats-core'), QuotaCore: require('../quota-core'),
    seatInfo: async (seat) => { seatReads++; return { accountKey: 'account-' + seat.id, configDir: seat.configDir, loggedIn: true }; },
    readUsage: () => null, occupiedClaudeSeats: occupied,
    handleMain: (name, fn) => { handlers[name] = fn; },
    quotaWarmup: null, quotaWarmupRunner: null,
  });
  vm.runInContext(view + region, context);
  return { tick: () => context.quotaWarmup.tick(), handlers, write, config, parses: () => parses, seatReads: () => seatReads,
    reset: () => { parses = 0; seatReads = 0; } };
}

test('a warm-up tick over an unchanged config.json does not parse it again', async (t) => {
  const w = warmup(t);
  await w.tick();
  assert.ok(w.seatReads() > 0, 'the tick looked at the seats');
  assert.ok(w.parses() <= 1, `first tick: ${w.parses()} parses`);
  w.reset();
  await w.tick();
  await w.tick();
  assert.equal(w.parses(), 0, 'two more ticks, no parse');
  assert.ok(w.seatReads() > 0, 'and they still did their work');
});

test('a changed config.json reaches the next tick', async (t) => {
  const w = warmup(t);
  await w.tick();
  w.write(w.config(false));   // the user switched the warm-up off
  w.reset();
  await w.tick();
  assert.equal(w.parses(), 1);
  assert.equal(w.seatReads(), 0, 'a switched-off warm-up does nothing');
  w.write(w.config(true));
  w.reset();
  await w.tick();
  assert.equal(w.parses(), 1);
  assert.ok(w.seatReads() > 0, 'switched back on, it works again');
});

test('the idle report and the warm-up share the view of config.json', async (t) => {
  const w = warmup(t);
  w.handlers['seats:warmup-idle'](null, { colId: 'cap', idle: true });   // the 队长's column has no pty here: refused
  await w.tick();
  w.reset();
  w.handlers['seats:warmup-idle'](null, { colId: 'cap', idle: true });
  await w.tick();
  assert.equal(w.parses(), 0);
});
