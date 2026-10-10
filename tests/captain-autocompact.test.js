'use strict';
// The 队长's Claude gets CLAUDE_CODE_AUTO_COMPACT_WINDOW (and a PreCompact hook); nothing else does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const MainCore = require('../main-core');
const AgentSessions = require('../agent-sessions');
const S = require('../claude-seats-core');
const M = require('../claude-seats-main');
const { ttyFromPty } = require('../board-credentials');

const VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('the setting: unset is 200000, 0 or empty is off, anything else sits in Claude\'s 100000–1000000', () => {
  assert.equal(MainCore.AUTO_COMPACT_DEFAULT, 200000);
  for (const unset of [undefined, null]) assert.equal(MainCore.autoCompactWindow(unset), 200000);
  assert.equal(MainCore.autoCompactWindow(), 200000);
  for (const off of [0, '0', '', '  ', -5, '-1']) assert.equal(MainCore.autoCompactWindow(off), 0, String(off));
  assert.equal(MainCore.autoCompactWindow(300000), 300000);
  assert.equal(MainCore.autoCompactWindow('250000'), 250000);
  assert.equal(MainCore.autoCompactWindow(60000), 100000, 'Claude floors the value at 100000');
  assert.equal(MainCore.autoCompactWindow(1), 100000);
  assert.equal(MainCore.autoCompactWindow(5e6), 1000000, 'and caps it at 1000000');
  assert.equal(MainCore.autoCompactWindow(150000.6), 150001);
  for (const junk of ['abc', NaN, Infinity, {}, [1, 2]]) assert.equal(MainCore.autoCompactWindow(junk), 200000, String(junk));
});

test('captainEnvironment: the 队长 carries the variable, a worker, a 小队长 or an unflagged spawn never does', () => {
  const env = { PATH: '/bin', KEEP: 'x' };
  const captain = AgentSessions.captainEnvironment(env, true, undefined);
  assert.equal(captain[VAR], '200000');
  assert.equal(captain.PATH, '/bin'); assert.equal(captain.KEEP, 'x');
  assert.equal(AgentSessions.captainEnvironment(env, true, 300000)[VAR], '300000');
  assert.equal(AgentSessions.captainEnvironment(env, true, '350000')[VAR], '350000');
  assert.equal(AgentSessions.captainEnvironment(env, true, 60000)[VAR], '100000');
  assert.ok(!(VAR in env), 'the input is not changed');
  for (const flag of [false, undefined, null, 'true', 1]) assert.ok(!(VAR in AgentSessions.captainEnvironment(env, flag, 200000)), `flag ${String(flag)}`);
  for (const off of [0, '0', '']) assert.ok(!(VAR in AgentSessions.captainEnvironment(env, true, off)), `setting ${JSON.stringify(off)}`);
  assert.equal(AgentSessions.captainEnvironment({ [VAR]: '777000' }, true, 0)[VAR], '777000', 'a value the user already exports is theirs');
});

// ---- spawnPty itself (the production function, a stand-in native process) ----
function harness(t, config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-autocompact-'));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claudeSeats: S.normalize(), activeClaudeSeatId: 'cn', ...config }));
  const ptys = new Map(), ptySeats = new Map(), launched = [];
  const source = read('main.js');
  const body = source.slice(source.indexOf('function spawnPty('), source.indexOf('\nfunction send('));
  const context = vm.createContext({ fs, path, HOME: home, tudArg: false, app: { getPath: () => home },
    quotaWarmup: null, validId: () => true, ptys, ptySeats, ptyLaunchDirs: new Map(), ENV: { PATH: '/bin' },
    ClaudeSeatsCore: S, AgentSessions, credentialLocation: M.credentialLocation, initializeOnboarding: M.initializeOnboarding, seatEnvironment: M.seatEnvironment,
    ttyFromPty, writeCredentials: () => {}, removeCredentials: () => {}, crypto: require('crypto'), managedSessions: new Map(), receiptSessions: new Map(), notifications: null,
    spoolPath: () => path.join(home, 'unused'), boardControlDir: home, boardCliPath: '/fake/board.js',
    shellFile: () => '/bin/zsh', shellArgs: () => [], send: () => {}, bufferAppend: () => {}, writeSession: () => {}, ptyBuffers: new Map(),
    killPty: (id) => { ptys.delete(id); ptySeats.delete(id); },
    pty: { spawn: (file, args, options) => { launched.push({ file, args, options }); return { ptsName: '/dev/ttys1', onData: () => {}, onExit: () => {} }; } } });
  vm.runInContext(body, context);
  const spawn = (id, ...args) => { context.spawnPty(id, home, 80, 24, ...args); return launched.at(-1).options.env; };
  return { spawn, launched, home };
}

test('spawnPty: only the 队长 terminal starts with the window, on every start (the seat is irrelevant)', (t) => {
  const h = harness(t, {});
  assert.equal(h.spawn('captain', true, 'cn', undefined, false, true)[VAR], '200000', 'a setting never saved means the default');
  assert.equal(h.spawn('captain-us', true, 'us', undefined, false, true)[VAR], '200000', 'Relay onto another seat');
  assert.ok(!(VAR in h.spawn('worker', true, 'cn', undefined, true, false)), 'a worker the 队长 opened');
  assert.ok(!(VAR in h.spawn('worker2', true, 'cn', undefined, false, false)), 'a managed worker');
  assert.ok(!(VAR in h.spawn('sub', true, 'cn', undefined, false)), 'a 小队长 never says it is the 队长');
  assert.ok(!(VAR in h.spawn('manual', false, 'cn')), 'a manual terminal');
});

test('spawnPty: the saved setting is read at every start; 0 and empty add nothing', (t) => {
  const h = harness(t, { captainAutoCompactWindow: 350000 });
  const save = (value) => fs.writeFileSync(path.join(h.home, 'config.json'), JSON.stringify({ claudeSeats: S.normalize(), activeClaudeSeatId: 'cn', captainAutoCompactWindow: value }));
  assert.equal(h.spawn('a', true, 'cn', undefined, false, true)[VAR], '350000');
  save(0);
  assert.ok(!(VAR in h.spawn('b', true, 'cn', undefined, false, true)), '0 is off');
  save('');
  assert.ok(!(VAR in h.spawn('c', true, 'cn', undefined, false, true)), 'empty is off');
  save(120000);
  assert.equal(h.spawn('d', true, 'cn', undefined, false, true)[VAR], '120000');
});

// ---- the launch line ----
test('captainLaunchCommand adds --settings right after Claude, and leaves every other line alone', () => {
  const file = path.join(os.tmpdir(), 'tools', 'captain-compact-settings.json');
  const add = (cmd) => AgentSessions.captainLaunchCommand(cmd, file);
  assert.equal(add('claude --model opus'), `claude --settings "${file}" --model opus`);
  assert.equal(add('claude'), `claude --settings "${file}"`);
  assert.equal(add('command claude --x'), `command claude --settings "${file}" --x`);
  assert.equal(add('"C:\\npm\\claude" --x'), `"C:\\npm\\claude" --settings "${file}" --x`);
  assert.equal(add("'/opt/bin/claude' --x"), `'/opt/bin/claude' --settings "${file}" --x`);
  assert.equal(add('/usr/local/bin/claude --dangerously-skip-permissions'), `/usr/local/bin/claude --settings "${file}" --dangerously-skip-permissions`);
  for (const other of ['codex --yolo', 'agy', 'node fixture/fake-agent.js', 'cursor-agent --force', 'claude-ds --x', 'echo claude', '', undefined]) {
    assert.equal(add(other), other === undefined ? '' : other, String(other));
  }
  assert.equal(add('claude --settings /mine.json'), 'claude --settings /mine.json', 'a --settings of the user stays');
  assert.equal(add('claude --settings=/mine.json'), 'claude --settings=/mine.json');
  for (const bad of ['', undefined, 'a"b.json', 'a$b.json', 'a`b.json', "a'b.json", 'a\nb.json']) assert.equal(AgentSessions.captainLaunchCommand('claude --x', bad), 'claude --x', String(bad));
});

test('the launch handler: only the 队长 column gets the hook file', async (t) => {
  const source = read('main.js');
  const begin = source.indexOf("handleMain('pty:prepare-launch'");
  const end = source.indexOf('\n});', begin) + 4;
  const columns = [{ id: 'captain', isMain: true }, { id: 'worker', captainCrew: true }, { id: 'sub', subCaptain: true }];
  const file = path.join(os.tmpdir(), 'captain-compact-settings.json');
  let handler;
  const context = vm.createContext({
    handleMain: (_n, fn) => { handler = fn; },
    ptys: new Map(columns.map((c) => [c.id, {}])), ptyLaunchDirs: new Map(columns.map((c) => [c.id, os.tmpdir()])),
    readLocalConfig: () => ({ columns }),
    prepareWorkspaceTrust: (command) => ({ command }),
    codexLauncher: { prepare: (cmd) => cmd },
    tudArg: null, HOME: os.tmpdir(), send() {}, seatGate: null, AgentSessions, captainCompactSettings: file,
  });
  vm.runInContext(source.slice(begin, end), context);
  assert.equal(await handler(null, { id: 'captain', command: 'claude --model opus' }), `claude --settings "${file}" --model opus`);
  assert.equal(await handler(null, { id: 'worker', command: 'claude --model opus' }), 'claude --model opus');
  assert.equal(await handler(null, { id: 'sub', command: 'claude --model opus' }), 'claude --model opus');
  assert.equal(await handler(null, { id: 'captain', command: 'codex --yolo' }), 'codex --yolo', 'a Codex 队长 has no Claude hook');
  context.captainCompactSettings = '';
  assert.equal(await handler(null, { id: 'captain', command: 'claude --model opus' }), 'claude --model opus', 'no file was written: nothing added');
});

test('the hook settings and its note script', () => {
  const script = path.join(__dirname, '..', 'captain-compact-note.js');
  const settings = AgentSessions.captainCompactSettings('C:\\Users\\me\\AppData\\Roaming\\agentdeck\\board-control\\tools\\captain-compact-note.js');
  assert.deepEqual(Object.keys(settings), ['hooks']);
  assert.deepEqual(Object.keys(settings.hooks), ['PreCompact']);
  const [group] = settings.hooks.PreCompact;
  assert.equal(group.matcher, '', 'manual and auto compaction both');
  assert.equal(group.hooks.length, 1);
  assert.equal(group.hooks[0].type, 'command');
  assert.equal(group.hooks[0].command, 'node "C:/Users/me/AppData/Roaming/agentdeck/board-control/tools/captain-compact-note.js"', 'forward slashes read the same in bash, PowerShell and cmd');
  assert.ok(group.hooks[0].timeout > 0);
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, MainCore.COMPACT_NOTE + '\n');
  assert.equal(MainCore.COMPACT_NOTE, '保留在跑和排队的会话、卡号和提交号、等用户拍板的事；其余以看板和决定文件为准');
});

test('wiring: renderer flags the 队长 column, the main process writes the files, settings save the number', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /boundSeat\.configDir, !!col\.captainCrew && !col\.isMain, !!col\.isMain\)/);
  assert.match(renderer, /captainAutoCompactWindow: MainCore\.autoCompactWindow\(\)/);
  assert.match(renderer, /config\.captainAutoCompactWindow = MainCore\.autoCompactWindow\(saved\.captainAutoCompactWindow\)/);
  const main = read('main.js');
  assert.match(main, /AgentSessions\.captainEnvironment\(terminalEnv, captain === true, compactSetting\)/);
  assert.match(main, /captain-compact-note\.js/);
  assert.match(main, /captain-compact-settings\.json/);
  const html = read('index.html');
  assert.match(html, /id="captainAutoCompact"[^>]*type="number"|type="number"[^>]*id="captainAutoCompact"/);
  const session = read('main-session.js');
  assert.match(session, /host\.config\.captainAutoCompactWindow = M\.autoCompactWindow\(compactBox\.value\)/);
  assert.match(session, /\$\('captainAutoCompact'\)\.value = M\.autoCompactWindow\(host\.config\.captainAutoCompactWindow\)/);
  const pkg = require('../package.json');
  for (const file of ['captain-compact-note.js', 'agent-sessions.js', 'main-core.js']) assert.ok(pkg.build.files.includes(file), file);
});
