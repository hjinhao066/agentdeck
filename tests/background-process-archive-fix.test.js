'use strict';
// The screen can miss a background command (a footer cut at the column width, a
// status row scrolled away), so before the automatic archive ends a quiet Claude
// worker, the main process reads the terminal's process tree (pty-work.js). Only
// what Claude's Bash tool started counts (foreground or run_in_background; every such
// command sources Claude's shell snapshot) and everything under it, cmd /c or
// powershell -Command included. Claude's resident children never count, or no session
// would ever be archived: caffeinate and `npm exec …-mcp` on the Mac, and on the
// Windows PC (10-09 listing) its MCP server as `cmd.exe /d /s /c "npx -y tavily-mcp"`
// and its status line as `bash.exe -c "npx -y ccstatusline@latest"`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const { CACHE_MS, parseProcessTable, shellWork, createPtyWork } = require('../pty-work');

// `ps -A -o pid=,ppid=,command=` on the Mac, shaped like the 10-08 table
// (AgentDeck → the terminal's zsh → claude → its children); other processes trimmed.
const MAC_PS = [
  '    1     0 /sbin/launchd',
  '  756     1 /Applications/AgentDeck.app/Contents/MacOS/AgentDeck',
  '49957   756 /bin/zsh',
  '50113 49957 claude --session-id 5f0c --dangerously-skip-permissions --model claude-opus-5-5',
  '88543 50113 caffeinate -i -t 300',
  '61001 50113 npm exec @gongrzhe/server-gmail-autoauth-mcp',
  '61002 61001 node /Users/me/.npm/_npx/1/node_modules/.bin/gmail-mcp',
  '61003 50113 /bin/sh -c ~/.claude/statusline.sh',
  "70001 50113 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'sleep 900' < /dev/null && pwd -P >| /var/folders/x/claude-1-cwd",
  '70002 70001 sleep 900',
  '50200   756 /bin/zsh',
  '50201 50200 claude --model claude-sonnet-5-5',
  "70100 50201 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-2.sh && eval 'npm test'",
].join('\n') + '\n';
const without = (text, ...pids) => text.split('\n').filter((line) => !pids.some((pid) => new RegExp(`^\\s*${pid}\\s`).test(line))).join('\n');

// Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json
const WIN_ROWS = [
  { ProcessId: 4100, ParentProcessId: 900, CommandLine: '"C:\\Program Files\\AgentDeck\\AgentDeck.exe"' },
  { ProcessId: 4200, ParentProcessId: 4100, CommandLine: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo' },
  { ProcessId: 4300, ParentProcessId: 4200, CommandLine: '"D:\\npm-global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" --resume 769540a1' },
  // resident, as listed on the Windows PC: the MCP server and a status line run
  { ProcessId: 4310, ParentProcessId: 4300, CommandLine: 'C:\\windows\\system32\\cmd.exe /d /s /c "npx ^"-y^" ^"tavily-mcp^""' },
  { ProcessId: 4311, ParentProcessId: 4310, CommandLine: 'node "D:\\npm-global\\node_modules\\npm\\bin\\npx-cli.js" -y tavily-mcp' },
  { ProcessId: 4312, ParentProcessId: 4300, CommandLine: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "npx -y ccstatusline@latest"' },
  { ProcessId: 4350, ParentProcessId: 4300, CommandLine: null },
  // the Bash tool through Git Bash, running the E2E through cmd /c and a PowerShell step
  { ProcessId: 4340, ParentProcessId: 4300, CommandLine: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source C:/Users/me/.claude/shell-snapshots/snapshot-bash-1791522610826-ky7t9x.sh 2>/dev/null || true && eval \'npm run test:e2e\' < /dev/null"' },
  { ProcessId: 4320, ParentProcessId: 4340, CommandLine: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npm run test:e2e"' },
  { ProcessId: 4321, ParentProcessId: 4320, CommandLine: 'node "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run test:e2e' },
  { ProcessId: 4330, ParentProcessId: 4320, CommandLine: 'powershell.exe -NoProfile -Command "Start-Sleep 900"' },
];
const WORK_PIDS = [4320, 4321, 4330, 4340];

test('Mac: a shell command Claude started counts with what it runs; MCP servers, caffeinate and other terminals do not', () => {
  const rows = parseProcessTable(MAC_PS, 'darwin');
  assert.equal(rows.length, 13);
  assert.deepEqual(rows[3], { pid: 50113, ppid: 49957, command: 'claude --session-id 5f0c --dangerously-skip-permissions --model claude-opus-5-5' });
  assert.deepEqual(shellWork(rows, 49957).sort(), [70001, 70002]);
  assert.deepEqual(shellWork(parseProcessTable(without(MAC_PS, 70001, 70002), 'darwin'), 49957), []);
  assert.deepEqual(shellWork(rows, 50200), [70100]);
  assert.deepEqual(shellWork(rows, 12345), []);
  // A terminal started as `zsh -lc claude …` is not itself work, nor is a shell outside Claude.
  const launched = parseProcessTable(['  756     1 AgentDeck', '  900   756 /bin/zsh -lc claude --model x', '  901   900 claude --model x',
    '  902   900 /bin/bash -c echo hi', '  903   901 npm exec some-mcp'].join('\n'), 'darwin');
  assert.deepEqual(shellWork(launched, 900), []);
  // Claude installed through npm runs as node …/claude; bash -c -l counts like zsh -c.
  const npm = parseProcessTable(['  900   756 -zsh', '  901   900 node /opt/homebrew/bin/claude --model x',
    "  902   901 /bin/bash -c -l source /Users/me/.claude/shell-snapshots/snapshot-bash-2.sh && eval 'npm test'", '  903   902 node npm-cli.js test'].join('\n'), 'darwin');
  assert.deepEqual(shellWork(npm, 900).sort(), [902, 903]);
});

test('Windows: the Bash tool through Git Bash counts with its cmd /c and powershell children; the cmd /c MCP server and status line do not', () => {
  const rows = parseProcessTable(JSON.stringify(WIN_ROWS), 'win32');
  assert.equal(rows.length, WIN_ROWS.length);
  assert.deepEqual(rows[6], { pid: 4350, ppid: 4300, command: '' });
  assert.deepEqual(shellWork(rows, 4200).sort(), WORK_PIDS);
  const idle = WIN_ROWS.filter((r) => !WORK_PIDS.includes(r.ProcessId));
  assert.deepEqual(shellWork(parseProcessTable(JSON.stringify(idle), 'win32'), 4200), []);
  // ConvertTo-Json prints a single process as an object, not an array.
  assert.equal(parseProcessTable(JSON.stringify(WIN_ROWS[0]), 'win32').length, 1);
  // Claude from npm: node.exe …\@anthropic-ai\claude-code\cli.js.
  const npm = [{ ProcessId: 10, ParentProcessId: 1, CommandLine: 'cmd.exe' },
    { ProcessId: 11, ParentProcessId: 10, CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' },
    { ProcessId: 12, ParentProcessId: 11, CommandLine: '"C:\\Program Files\\Git\\bin\\bash.exe" -c -l "source C:\\Users\\me\\.claude\\shell-snapshots\\snapshot-bash-2.sh && eval \'timeout 900\'"' }];
  assert.deepEqual(shellWork(parseProcessTable(JSON.stringify(npm), 'win32'), 10), [12]);
});

// The reviewer's winpc table (2026-10-09 06:4x UTC): an AgentDeck worker running
// `bash run-spec.sh … captain.spec.js` in the background through Claude's PowerShell
// tool. The capture cut lines at 200 characters; the rest follows the launcher Claude
// Code 2.1.294 builds (cmd /d /s /c "chcp 65001 & pwsh … -Command <launcher> > output"),
// with the script itself passed in CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT.
const PWSH = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe';
const LAUNCHER = '"$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT = $null; Invoke-Expression -Command $__claudeCodeScript"';
const TASK = 'C:\\Users\\hjinh\\AppData\\Local\\Temp\\claude\\C--Users-hjinh\\769540a1-e166-4ac8-bc38-4f2850e30048';
const WIN_REVIEW_ROWS = [
  { ProcessId: 26636, ParentProcessId: 4100, CommandLine: 'C:\\windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoExit -EncodedCommand JABlAG4AdgA6AA==' },
  { ProcessId: 42372, ParentProcessId: 26636, CommandLine: '"D:\\npm-global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" --resume 769540a1-e166-4ac8-bc38-4f2850e30048' },
  { ProcessId: 40572, ParentProcessId: 42372, CommandLine: 'C:\\windows\\system32\\cmd.exe /d /s /c "npx ^"-y^" ^"tavily-mcp^""' },
  { ProcessId: 51052, ParentProcessId: 40572, CommandLine: '\\??\\C:\\windows\\system32\\conhost.exe 0x4' },
  { ProcessId: 29308, ParentProcessId: 40572, CommandLine: '"C:\\Program Files\\nodejs\\\\node.exe"  "C:\\Program Files\\nodejs\\\\node_modules\\npm\\bin\\npx-cli.js" "-y" "tavily-mcp"' },
  { ProcessId: 50688, ParentProcessId: 29308, CommandLine: 'C:\\windows\\system32\\cmd.exe /d /s /c tavily-mcp' },
  { ProcessId: 55408, ParentProcessId: 42372, CommandLine: `C:\\windows\\System32\\cmd.exe /d /s /c ""C:\\windows\\System32\\chcp.com" 65001 >nul & "${PWSH}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${LAUNCHER} > "${TASK}\\tasks\\biv1ud5or.output" 2>&1"` },
  { ProcessId: 44308, ParentProcessId: 55408, CommandLine: '\\??\\C:\\windows\\system32\\conhost.exe 0x4' },
  { ProcessId: 20828, ParentProcessId: 55408, CommandLine: `"${PWSH}"  -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${LAUNCHER}` },
  { ProcessId: 28788, ParentProcessId: 20828, CommandLine: `"C:\\Program Files\\Git\\bin\\bash.exe" "${TASK}\\scratchpad\\run-spec.sh" "${TASK}\\scratchpad" captain.spec.js` },
  { ProcessId: 38612, ParentProcessId: 42372, CommandLine: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "npx -y ccstatusline@latest"' },
  { ProcessId: 42708, ParentProcessId: 38612, CommandLine: '\\??\\C:\\windows\\system32\\conhost.exe 0x4' },
  { ProcessId: 30340, ParentProcessId: 38612, CommandLine: '"C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe" -c "npx -y ccstatusline@latest"' },
];

test('Windows: a background command through Claude\'s PowerShell tool counts (real winpc table); MCP and status line still do not', () => {
  const rows = parseProcessTable(JSON.stringify(WIN_REVIEW_ROWS), 'win32');
  assert.deepEqual(shellWork(rows, 26636).sort((a, b) => a - b), [20828, 28788, 44308, 55408]);
  const idle = WIN_REVIEW_ROWS.filter((r) => ![55408, 44308, 20828, 28788].includes(r.ProcessId));
  assert.deepEqual(shellWork(parseProcessTable(JSON.stringify(idle), 'win32'), 26636), []);
  // Without the launcher (CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER, or cmd unusable) Claude
  // starts PowerShell itself with the script encoded.
  const direct = [...idle, { ProcessId: 60001, ParentProcessId: 42372, CommandLine: `"${PWSH}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand UwB0AGEAcgB0AC0AUwBsAGUAZQBwACAAOQAwADAA` },
    { ProcessId: 60002, ParentProcessId: 60001, CommandLine: 'node build.js' }];
  assert.deepEqual(shellWork(parseProcessTable(JSON.stringify(direct), 'win32'), 26636).sort((a, b) => a - b), [60001, 60002]);
  // The same words outside Claude (here: a query that searches for them) are not its work.
  const outside = [...idle, { ProcessId: 60003, ParentProcessId: 26636, CommandLine: 'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT*\' }"' }];
  assert.deepEqual(shellWork(parseProcessTable(JSON.stringify(outside), 'win32'), 26636), []);
});

test('one process listing serves every terminal for a few seconds; a failed listing answers null', async () => {
  let at = 1_000, calls = [], fail = false;
  const execFile = (file, args, options, done) => { calls.push([file, args]); setImmediate(() => (fail ? done(new Error('denied')) : done(null, MAC_PS))); };
  const work = createPtyWork({ platform: 'darwin', execFile, now: () => at });
  assert.deepEqual(await Promise.all([work.busy(49957), work.busy(50200)]), [true, true]);
  at += 1_000;
  assert.equal(await work.busy(12345), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['/bin/ps', ['-A', '-o', 'pid=,ppid=,command=']]);
  at += CACHE_MS;
  fail = true;
  assert.equal(await work.busy(49957), null);
  assert.equal(calls.length, 2);
  assert.equal(await work.busy(0), null);

  const winCalls = [];
  const win = createPtyWork({ platform: 'win32', now: () => at,
    execFile: (file, args, options, done) => { winCalls.push([file, args, options]); setImmediate(() => done(null, JSON.stringify(WIN_ROWS))); } });
  assert.equal(await win.busy(4200), true);
  assert.equal(winCalls[0][0], 'powershell.exe');
  assert.match(winCalls[0][1].join(' '), /Get-CimInstance Win32_Process[^\n]*ParentProcessId/);
  assert.equal(winCalls[0][2].windowsHide, true);
});

// ---- the automatic archive asks the renderer's cached answer ----
function archiveRun(answer) {
  const archived = [], asked = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const col = { id: 'worker', cmd: 'claude', captainCrew: true };
  const screen = '❯ \n  ⏵⏵ bypass permissions on';
  const entry = { alive: true, state: 'done', hasWorked: true, term: {}, lastOutputAt: Date.now() - 30 * 60_000, lastScreen: screen };
  const window = {
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, taskBoard: (op) => Promise.resolve(op === 'list' ? [] : {}) },
    MainCore: M, BoardCore: B, ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const tasks = [{ id: 't', colId: col.id, status: 'done', sentAt: Date.now() - 60 * 60_000, doneAt: Date.now() - 40 * 60_000 }];
  window.MainSession.init({
    config: { mainSession: { colId: captain.id, tasks, pending: [], inflight: [], waitlist: [] }, folders: [] }, saveConfig() {},
    columns: () => [captain, col], terms: new Map([[captain.id, { alive: true, state: 'done' }], [col.id, entry]]),
    userComposing: () => false, columnLabel: (c) => c.id, isBackstage: (c) => !!c.captainCrew && !c.isMain,
    focusedId: () => '', lastTurnTs: () => Date.now() - 30 * 60_000, archiveColumn: (c) => { if (!archived.includes(c.id)) archived.push(c.id); },
    dumpScreen: () => screen, screenState: () => 'done',
    ptyBackgroundWork: (c) => { asked.push(c.id); return answer; },
  });
  return (async () => {
    window.MainSession.onTick(col.id, entry);
    await new Promise(setImmediate);
    window.MainSession.onTick(col.id, entry);
    return { archived, asked };
  })();
}

test('a quiet idle-looking session with a shell command still running under Claude is not archived', async () => {
  const busy = await archiveRun(true);
  assert.deepEqual(busy.archived, []);
  assert.ok(busy.asked.includes('worker'));
  assert.deepEqual((await archiveRun(undefined)).archived, [], 'no answer yet is not idle');
  assert.deepEqual((await archiveRun(false)).archived, ['worker']);
  assert.deepEqual((await archiveRun(null)).archived, ['worker'], 'a listing that failed leaves the decision to the screen');
});

// A busy answer is kept a minute: on Windows each listing starts PowerShell (1.2–1.7 s,
// ~180 KB on the PC), and a background job can run for hours.
test('the renderer asks at most once per terminal: every 10 seconds while idle, every minute while busy', async () => {
  const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
  let now = 50_000, answer = true;
  const calls = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    window: { deck: { ptyBackgroundWork: (id) => { calls.push(id); return Promise.resolve(answer); } } },
  });
  vm.runInContext(source.slice(source.indexOf('const PTY_WORK_MS'), source.indexOf('function ptyBackgroundWork')) +
    source.slice(source.indexOf('function ptyBackgroundWork'), source.indexOf('\n}\n', source.indexOf('function ptyBackgroundWork')) + 3), context);
  const col = { id: 'worker' };
  assert.equal(context.ptyBackgroundWork(col), undefined);
  assert.equal(context.ptyBackgroundWork(col), undefined);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['worker']);
  assert.equal(context.ptyBackgroundWork(col), true);
  answer = false;
  now += 59_000;
  assert.equal(context.ptyBackgroundWork(col), true);
  assert.deepEqual(calls, ['worker']);
  now += 2_000;
  assert.equal(context.ptyBackgroundWork(col), undefined);
  await new Promise(setImmediate);
  assert.equal(context.ptyBackgroundWork(col), false);
  assert.deepEqual(calls, ['worker', 'worker']);
  now += 9_000;
  assert.equal(context.ptyBackgroundWork(col), false);
  now += 2_000;
  assert.equal(context.ptyBackgroundWork(col), undefined);
  assert.deepEqual(calls, ['worker', 'worker']);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['worker', 'worker', 'worker']);
});
