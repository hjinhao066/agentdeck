'use strict';
// After each quota refresh (every 30 s; 2 min on battery) main lists the seat
// login states for the page and queues the 队长's seat alerts. Every Claude
// sample's seat lookup and the 队长 lookup each parsed the whole config.json
// (several MB) on the main process again. They now read the same view of the
// file as the quota warm-up, rebuilt only when the file changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
// The view of config.json, wherever main.js declares it.
const view = (/\n {2}let seatView = [\s\S]*?\n {2}};\n/.exec(source) || [''])[0];
// From the Codex seat to the end of queueAuthReceipts, as main.js has them.
const begin = source.indexOf('\n  const codexSeat = ');
const queue = source.indexOf('\n  const queueAuthReceipts = ', begin);
const end = source.indexOf('\n  };\n', queue) + '\n  };\n'.length;
assert.ok(begin >= 0 && queue > begin && end > queue, 'main.js still has the seat login helpers');

function seats(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-auth-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  const write = (cfg) => { fs.writeFileSync(configPath + '.tmp', JSON.stringify(cfg)); fs.renameSync(configPath + '.tmp', configPath); };
  const config = (usDir) => ({ claudeSeats: [{ id: 'cn', name: 'CN', configDir: '~/.claude' }, { id: 'us', name: 'US', configDir: usDir }],
    mainSession: { colId: 'cap' }, columns: [{ id: 'worker' }, { id: 'cap', isMain: true }],
    archived: Array.from({ length: 50 }, (_, i) => ({ id: 'a' + i, taskPrompt: 'x'.repeat(2000) })) });
  write(config('~/.claude-us'));
  let parses = 0;
  const samples = [
    { provider: 'Claude', seatId: 'cn', configDir: '~/.claude', authStatus: 'logged-in' },
    { provider: 'Claude', seatId: 'us', configDir: '~/.claude-us', authStatus: 'logged-in' },
    { provider: 'Claude', seatId: 'us', configDir: '~/.old-us', authStatus: 'logged-out' },
    { provider: 'Codex', seatId: 'codex', configDir: '~/.codex', authStatus: 'logged-in' },
  ];
  const alerts = [{ id: 'alert-1', provider: 'Claude', seatId: 'us', message: 'US 掉登录' }];
  const pendingBoardCommands = new Map();
  const context = vm.createContext({
    seatConfig: () => { parses++; try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return {}; } },
    fs, configPath, ENV: {}, ClaudeSeatsCore: require('../claude-seats-core'),
    seatAuth: { samples: () => samples, pendingReceipts: () => alerts },
    boardRendererReady: true, pendingBoardCommands, dispatchPendingBoardCommands: () => {},
  });
  vm.runInContext(view + source.slice(begin, end) + '\nthis.authSamples = authSamples; this.queueAuthReceipts = queueAuthReceipts;', context);
  return { context, write, config, parses: () => parses, reset: () => { parses = 0; }, pendingBoardCommands };
}

test('listing seat logins and queueing seat alerts do not reparse an unchanged config.json', (t) => {
  const s = seats(t);
  for (let i = 0; i < 5; i++) { s.context.authSamples(); s.context.queueAuthReceipts(); }
  assert.ok(s.parses() <= 1, `${s.parses()} parses for 5 refresh cycles`);
});

test('the seat checks still follow the configuration', (t) => {
  const s = seats(t);
  const shown = () => s.context.authSamples().map((x) => `${x.seatId}:${x.configDir}`);
  assert.deepEqual(shown(), ['cn:~/.claude', 'us:~/.claude-us', 'codex:~/.codex'], 'a sample from another directory is not this seat');
  s.context.queueAuthReceipts();
  assert.equal(s.pendingBoardCommands.get('alert-1').command.callerId, 'cap', 'the alert goes to the 队长');
  s.write(s.config('~/.old-us'));   // the US seat moved back to its old directory
  s.reset();
  assert.deepEqual(shown(), ['cn:~/.claude', 'us:~/.old-us', 'codex:~/.codex']);
  assert.equal(s.parses(), 1);
});
