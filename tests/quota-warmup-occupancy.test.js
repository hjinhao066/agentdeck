'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { occupied, scanProcesses } = require('../quota-warmup-occupancy');
const seats = [{ id: 'cn', configDir: '~/.claude' }, { id: 'us', configDir: '~/.claude-us' }];
const row = (pid, ppid, comm) => ({ pid, ppid, comm });
const column = (id, seatId, cmd = 'claude --model claude-sonnet-5-5') => ({ id, claudeSeatId: seatId,
  claudeConfigDir: seats.find((s) => s.id === seatId)?.configDir, cmd });
const check = (columns, rows = [], ptys = new Map(columns.map((c, i) => [c.id, { pid: 100 + i }]))) =>
  occupied({ seats, columns, ptys }, async () => rows);

test('live Claude columns reserve only their frozen seat, even before the CLI starts', async () => {
  assert.deepEqual(await check([column('cap', 'cn')]), new Set(['cn']));
  assert.deepEqual(await check([column('cap', 'cn'), column('crew', 'us')]), new Set(['cn', 'us']));
  assert.deepEqual(await check([column('archived', 'cn')], [], new Map()), new Set());
  assert.deepEqual(await check([{ id: 'legacy', claudeSeatId: 'us', agentProvider: 'Claude' }]), new Set(['us']));
});

test('frozen tilde directories resolve against the supplied isolated instance home', async () => {
  const home = '/tmp/agentdeck-warmup-fixture';
  const fixtureSeats = seats.map((seat) => ({ ...seat, configDir: seat.configDir.replace('~', home) }));
  const columns = [column('shell', 'cn', '')], ptys = new Map([['shell', { pid: 100 }]]);
  assert.deepEqual(await occupied({ seats: fixtureSeats, columns, ptys, home },
    async () => [row(201, 100, '/opt/bin/claude')]), new Set(['cn']));
  assert.deepEqual(await occupied({ seats: fixtureSeats, columns: [column('boot', 'us')],
    ptys: new Map([['boot', { pid: 100 }]]), home }, async () => []), new Set(['us']));
});

test('known Codex columns do not reserve their inherited Claude seat', async () => {
  assert.deepEqual(await check([column('codex', 'cn', 'command "codex" --no-daemon')], [row(101, 100, '/opt/bin/codex')]), new Set());
  assert.deepEqual(await check([{ ...column('stand-in', 'us', 'node fake.js'), agentProvider: 'Codex' }]), new Set());
  assert.deepEqual(await check([column('quoted', 'cn', 'command "/opt/bin/claude" -p')]), new Set(['cn']));
});

test('Claude descendants of an owned shell are attributed through intermediate processes', async () => {
  const cols = [column('shell', 'us', ''), column('codex', 'cn', 'codex')];
  const rows = [row(100, 1, '/bin/zsh'), row(200, 100, '/bin/sh'), row(300, 200, '/opt/homebrew/Caskroom/claude-code@latest/2.1.288/claude'),
    row(301, 300, 'claude bg-pty-host'), row(302, 301, 'claude bg-spare'), row(101, 1, '/bin/zsh'), row(400, 101, 'codex')];
  assert.deepEqual(await check(cols, rows), new Set(['us']));
});

test('native version executables are Claude; unrelated Framework versions are not', async () => {
  const cols = [column('shell', 'cn', '')];
  assert.deepEqual(await check(cols, [row(201, 100, '/home/user/.local/share/claude/versions/2.1.288')]), new Set(['cn']));
  assert.deepEqual(await check([], [row(201, 1, '/home/user/.local/share/claude/versions/2.1.288')]), new Set(['cn', 'us']));
  assert.deepEqual(await check([], [row(201, 1, '/Library/Frameworks/Python.framework/Versions/3.14/Python')]), new Set());
  assert.deepEqual(await check([column('native', 'us', '"/home/user/.local/share/claude/versions/2.1.288" -p')]), new Set(['us']));
});

test('unknown PTYs and terminals added or replaced while scanning invalidate the occupancy snapshot', async () => {
  const unknown = new Map([['not-yet-saved', { pid: 100 }]]);
  assert.deepEqual(await check([], [], unknown), new Set(['cn', 'us']));
  for (const mutation of [(ptys) => ptys.set('late', { pid: 200 }), (ptys) => ptys.set('shell', { pid: 300 })]) {
    const cols = [column('shell', 'cn', '')], ptys = new Map([['shell', { pid: 100 }]]);
    assert.deepEqual(await occupied({ seats, columns: cols, ptys }, async () => { mutation(ptys); return []; }), new Set(['cn', 'us']));
  }
});

test('external Claude, unbound directories, cycles and unavailable inventories block both seats', async () => {
  assert.deepEqual(await check([], [row(201, 1, 'claude')]), new Set(['cn', 'us']));
  assert.deepEqual(await check([{ ...column('old', 'cn'), claudeConfigDir: '~/.old-claude' }]), new Set(['cn', 'us']));
  assert.deepEqual(await check([], [row(201, 202, 'claude'), row(202, 201, 'node')]), new Set(['cn', 'us']));
  for (const scan of [async () => { throw new Error('access denied'); }, async () => null, async () => [{ pid: 1, ppid: 0 }]]) {
    assert.deepEqual(await occupied({ seats, columns: [], ptys: new Map() }, scan), new Set(['cn', 'us']));
  }
});

test('only exact macOS Desktop UI executables are excluded; external native CLIs still block both seats', async () => {
  const desktop = ['/Applications/Claude.app/Contents/MacOS/Claude',
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper',
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)',
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper (GPU).app/Contents/MacOS/Claude Helper (GPU)'];
  assert.deepEqual(await check([], desktop.map((comm, i) => row(201 + i, 1, comm))), new Set());
  for (const comm of ['/Applications/Claude.app/Contents/Resources/cli/claude',
    '/opt/homebrew/Caskroom/claude-code@latest/2.1.288/claude', 'Claude.exe', 'claude bg-pty-host']) {
    assert.deepEqual(await check([], [row(201, 1, comm)]), new Set(['cn', 'us']));
  }
});

test('Windows paths match without case sensitivity and executable metadata attributes descendants', async () => {
  const windowsSeats = [{ id: 'cn', configDir: 'C:\\Users\\Me\\.claude' }, { id: 'us', configDir: 'C:\\Users\\Me\\.claude-us' }];
  const cols = [{ id: 'shell', cmd: '', claudeSeatId: 'cn', claudeConfigDir: 'c:/users/me/.CLAUDE' }];
  assert.deepEqual(await occupied({ seats: windowsSeats, columns: cols, ptys: new Map([['shell', { pid: 100 }]]) },
    async () => [row(201, 100, 'C:\\Program Files\\Claude\\claude.exe')]), new Set(['cn']));
});

test('process scanner requests only PID, PPID and process name/path, never arguments or environment', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const rows = await scanProcesses({ platform, execFileImpl: (command, args, options, callback) => {
      assert.equal(options.shell, false); assert.ok(options.timeout <= 3000);
      if (platform === 'win32') {
        assert.equal(command, 'powershell.exe');
        assert.match(args.at(-1), /ProcessId,ParentProcessId,Name,ExecutablePath/);
        assert.ok(!/CommandLine|Environment/i.test(args.at(-1)));
        callback(null, '\uFEFF[{"ProcessId":201,"ParentProcessId":100,"Name":"claude.exe","ExecutablePath":null}]');
      } else {
        assert.equal(command, 'ps'); assert.deepEqual(args, ['-eo', 'pid=,ppid=,comm=']);
        callback(null, '  100  1 /bin/zsh\n  201  100 /a directory/claude\n');
      }
    } });
    assert.equal(rows.at(-1).pid, 201); assert.equal(rows.at(-1).ppid, 100);
  }
});

test('scanner rejects empty, incomplete or failed command output instead of pretending a seat is idle', async () => {
  for (const stdout of ['', 'garbled\n', '100 1\n']) {
    await assert.rejects(scanProcesses({ execFileImpl: (_command, _args, _options, callback) => callback(null, stdout) }));
  }
  await assert.rejects(scanProcesses({ platform: 'win32', execFileImpl: (_command, _args, _options, callback) => callback(new Error('denied')) }));
});
