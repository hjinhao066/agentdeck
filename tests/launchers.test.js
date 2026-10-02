'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const B = require('../board-core');
const M = require('../main-core');
const S = require('../schedule-core');

test('a blank session offers Claude, Antigravity, Grok, Cursor CLI and Codex (ChatGPT), in that order', () => {
  assert.deepEqual(B.LAUNCHERS.map((l) => l.label), ['Claude', 'Antigravity', 'Grok', 'Cursor CLI', 'Codex (ChatGPT)']);
  for (const l of B.LAUNCHERS) assert.equal(B.commandForAgent(l.key), l.cmd, l.key);
  assert.equal(B.commandForAgent('agy'), 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high --effort high');
  assert.equal(B.commandForAgent('cursor'), 'cursor-agent --force --model claude-opus-5-5-high');
  assert.equal(B.commandForAgent('cursor-agent'), B.commandForAgent('cursor'));
  assert.equal(B.commandForAgent('grok'), 'grok --permission-mode bypassPermissions');
  assert.equal(B.commandForAgent('codex'), 'codex --dangerously-bypass-approvals-and-sandbox');
  assert.match(B.commandForAgent('claude'), /^claude --dangerously-skip-permissions/);
  // `agent` collides with another tool's binary on the owner's machine
  assert.ok(B.LAUNCHERS.every((l) => !/^agent(\s|$)/.test(l.cmd)));
  assert.equal(B.inferAgentType('cursor-agent --force --model claude-sonnet-5-5-high'), 'Cursor');
  assert.equal(B.inferAgentType('agy --model gemini-3.1-pro-high'), 'Antigravity');
  assert.equal(B.inferAgentType('codex --dangerously-bypass-approvals-and-sandbox'), 'Codex');
  assert.throws(() => { B.LAUNCHERS[0].cmd = 'rm -rf ~'; });
});

test('the dialogs offer the same launch commands as the blank-session buttons', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const groups = [...html.matchAll(/<div class="presets">([\s\S]*?)<\/div>/g)]
    .map((m) => [...m[1].matchAll(/data-cmd="([^"]*)"/g)].map((x) => x[1]));
  assert.ok(groups.length >= 2);
  for (const cmds of groups) assert.deepEqual(cmds, B.LAUNCHERS.map((l) => l.cmd));
  assert.match(html, /<option value="cursor">Cursor CLI<\/option>/);
  assert.match(html, /<option value="codex">Codex \(ChatGPT\)<\/option>/);
});

test('a missing CLI is recognized from the shell, and only a new error counts', () => {
  const cmd = 'cursor-agent --model claude-opus-5-5-high';
  assert.equal(B.launchErrors('% cursor-agent\nzsh: command not found: cursor-agent', cmd), 1);
  assert.equal(B.launchErrors('bash: cursor-agent: command not found', cmd), 1);
  assert.equal(B.launchErrors("cursor-agent: The term 'cursor-agent' is not recognized as a name of a cmdlet", cmd), 1);
  assert.equal(B.launchErrors('cursor-agent : 无法将“cursor-agent”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。', cmd), 1);
  assert.equal(B.launchErrors('无法将“cursor-agent”项识别\n为 cmdlet、函数、脚本文件或可运行程序的名称。', cmd), 1);
  assert.equal(B.launchErrors('“cursor-agent”不是内部或外部命令，也不是可运行的程序或批处理文件。', cmd), 1);
  assert.equal(B.launchErrors('无法将“grok”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。', cmd), 0);
  assert.equal(B.launchErrors('fish: Unknown command: cursor-agent', cmd), 1);
  assert.equal(B.launchErrors('zsh: no such file or directory: /opt/x/agy', '/opt/x/agy --effort high'), 1);
  // a narrow column soft-wraps the message mid-word
  assert.equal(B.launchErrors("cursor-agent: The term 'cursor-agent' is not reco\ngnized as a name of a cmdlet, function", cmd), 1);
  // another program's error, ordinary output, an empty command
  assert.equal(B.launchErrors('zsh: command not found: grok', cmd), 0);
  assert.equal(B.launchErrors('cursor-agent v2026.10\n> ready', cmd), 0);
  assert.equal(B.launchErrors('zsh: command not found: x', ''), 0);
  const old = 'zsh: command not found: agy\n% agy';
  assert.equal(B.launchErrors(old, 'agy') < B.launchErrors(old + '\nzsh: command not found: agy', 'agy'), true);
});

test('Schedule can open a fresh Cursor CLI session', () => {
  assert.equal(S.normalizeSchedule({ agent: 'cursor' }).agent, 'cursor');
  assert.equal(S.normalizeSchedule({ agent: 'agent' }).agent, 'claude');
});

test('agent names resolve to their launch commands; a custom command wins; unknown falls back to Claude', () => {
  assert.equal(B.commandForAgent('  Cursor '), B.commandForAgent('cursor'));
  assert.equal(B.commandForAgent('antigravity'), B.commandForAgent('agy'));
  assert.equal(B.commandForAgent('cursor-agent'), 'cursor-agent --force --model claude-opus-5-5-high');
  assert.equal(B.commandForAgent('shell'), '');
  assert.equal(B.commandForAgent('agent'), B.commandForAgent('claude'));
  assert.equal(B.commandForAgent('cursor', '  cursor-agent --model claude-sonnet-5-5-xhigh '), 'cursor-agent --model claude-sonnet-5-5-xhigh');
  // every launcher is recognized back from its command
  const types = { claude: 'Claude', agy: 'Antigravity', grok: 'Grok', cursor: 'Cursor', codex: 'Codex' };
  for (const l of B.LAUNCHERS) assert.equal(B.inferAgentType(l.cmd), types[l.key], l.key);
  // the defaults run at the "ordinary code" tier
  for (const key of ['claude', 'agy']) assert.match(B.commandForAgent(key), /--effort high$/);
  assert.match(B.commandForAgent('cursor'), /--model claude-opus-5-5-high$/);
  assert.match(B.commandForAgent('cursor'), /^cursor-agent --force/);
});

test('every --agent name offered anywhere resolves to a real preset, never the silent default', () => {
  const root = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const offered = new Set();
  for (const src of [read('board-cli.js'), M.instructions()]) {
    for (const m of src.matchAll(/--agent ([a-z|-]+)/g)) m[1].split('|').filter(Boolean).forEach((a) => offered.add(a));
  }
  const accepted = /\[((?:'[a-z-]+',?\s*)+)\]\.includes\(agent\)/.exec(read('main-session.js'));
  assert.ok(accepted, '队长 new keeps an explicit allow-list');
  const allowed = accepted[1].match(/[a-z-]+/g);
  for (const a of offered) {
    assert.ok(allowed.includes(a), `队长 new accepts --agent ${a}`);
    assert.ok(Object.prototype.hasOwnProperty.call(B.AGENT_COMMANDS, a), `preset for ${a}`);
  }
  for (const a of allowed) assert.ok(Object.prototype.hasOwnProperty.call(B.AGENT_COMMANDS, a), `preset for ${a}`);
  assert.ok(offered.has('cursor'));
});

test('a launcher clears a half-typed line with editing keys only, per platform', () => {
  const cmd = 'cursor-agent --model claude-opus-5-5-high';
  assert.equal(B.launchInput(cmd, 'darwin'), '\x15' + cmd + '\r');
  assert.equal(B.launchInput(cmd, 'linux'), '\x15' + cmd + '\r');
  // PowerShell/conhost: Ctrl+End (delete to end) then Ctrl+Home (delete to start)
  assert.equal(B.launchInput(cmd, 'win32'), '\x1b[1;5F\x1b[1;5H' + cmd + '\r');
  for (const p of ['win32', 'darwin']) {
    const bytes = B.launchInput(cmd, p);
    // never ^C/^D/^Z: those would stop a program running in front of the shell
    assert.ok(!/[\x03\x04\x1a]/.test(bytes), p);
    assert.equal(bytes.split('\r').length, 2, 'exactly one Enter');
  }
  // a command is typed as one line: no control character or second Enter reaches the shell
  assert.equal(B.launchInput('grok\x03\r\nrm -rf ~', 'darwin'), '\x15grok rm -rf ~\r');
});

test('a launch only counts as started once the agent is identified; a Windows timeout is unknown, not success', () => {
  const v = (o) => B.launchVerdict({ alive: true, missing: false, up: false, waited: 1000, platform: 'win32', ...o });
  assert.equal(v({}), 'waiting');
  assert.equal(v({ up: true }), 'up');
  assert.equal(v({ up: true, platform: 'darwin' }), 'up');
  assert.equal(v({ waited: 60000 }), 'unknown');
  assert.equal(v({ waited: 60000, platform: 'darwin' }), 'failed');
  assert.equal(v({ waited: 60000, platform: 'linux' }), 'failed');
  // a new "not found" beats everything but a dead terminal
  assert.equal(v({ missing: true, up: true }), 'missing');
  assert.equal(v({ alive: false, missing: true, up: true }), 'exited');
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const waited of [0, 14999, 15001, 1e9]) {
      assert.notEqual(B.launchVerdict({ alive: true, missing: false, up: false, waited, platform }), 'up', `${platform} ${waited}`);
    }
  }
});

test('队长 knows the providers, only verified models, and the routing preferences', () => {
  const text = M.instructions();
  for (const key of ['agy', 'cursor', 'claude', 'codex']) assert.ok(text.includes(B.commandForAgent(key)), key);
  assert.match(text, /--agent claude\|agy\|cursor\|grok\|codex \| --command/);
  // only models the CLIs listed on the owner's accounts
  const named = new Set(text.match(/\b(?:gemini|claude|grok)-[a-z0-9.-]*\d[a-z0-9.-]*/g));
  assert.deepEqual([...named].sort(), [
    'claude-opus-4-6-thinking', 'claude-opus-5-5-high', 'claude-opus-5-5-max', 'claude-opus-5-5-medium',
    'claude-opus-5-5-xhigh', 'claude-sonnet-4-6', 'claude-sonnet-5-5-high', 'claude-sonnet-5-5-max',
    'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-xhigh',
    'gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'grok-4.7-high-fast',
  ]);
  // Antigravity has no 5.5 models
  const agyLine = text.split('\n').find((l) => l.includes('Antigravity：'));
  assert.ok(!/5-5|5\.5/.test(agyLine));
  // heavy ordinary work → Antigravity Gemini; code → Cursor Opus, then Sonnet, Grok only last
  assert.match(text, /量大的普通活[^\n]*Antigravity 的 gemini-3\.8-flash-high/);
  const code = text.split('\n').find((l) => l.includes('写代码和重要的活'));
  const at = (s) => code.indexOf(s);
  assert.ok(at('claude-opus-5-5-high') >= 0 && at('claude-opus-5-5-high') < at('claude-sonnet-5-5-high'));
  assert.ok(at('claude-sonnet-5-5-high') < at('grok-4.7-high-fast'));
  // the standalone Grok subscription is gone; quotas are not visible
  assert.match(text, /独立的 Grok CLI[^\n]*不要用它派活/);
  assert.match(text, /看不到各家的实时额度/);
  assert.ok(!/(?:查看|读取|查询|检查)[^\n。]{0,6}额度|剩余额度|quota/i.test(text), 'never promises to read quotas');
  assert.ok(text.length < 8000, 'goes out as a prompt, not a file');
});

test('队长 picks the effort: simple medium, ordinary code high, complex or failed xhigh, critical max', () => {
  assert.deepEqual(M.EFFORT.map((e) => e.tier), ['medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...M.CURSOR_MODELS], [
    'claude-opus-5-5-medium', 'claude-opus-5-5-high', 'claude-opus-5-5-xhigh', 'claude-opus-5-5-max',
    'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high', 'claude-sonnet-5-5-xhigh', 'claude-sonnet-5-5-max',
  ]);
  const lines = M.instructions().split('\n');
  const tierOf = (cue) => {
    const l = lines.find((x) => x.includes(cue));
    assert.ok(l, cue);
    return l.slice(l.lastIndexOf('：') + 1).trim();
  };
  assert.equal(tierOf('简单的活'), 'medium');
  assert.equal(tierOf('一般的写代码'), 'high');
  assert.equal(tierOf('已经失败过'), 'xhigh');
  assert.equal(tierOf('最关键、最难'), 'max');
  // Cursor's tier is the exact model id, no other suffix is ever offered
  const cursor = lines.find((l) => l.includes('Cursor 把档位写在模型名最后'));
  for (const id of M.CURSOR_MODELS) assert.ok(cursor.includes(id), id);
  assert.ok(!/claude-(?:opus|sonnet)-5-5-(?!medium|high|xhigh|max)/.test(M.instructions()));
  // Antigravity's --effort has no xhigh
  const agy = lines.find((l) => l.includes('Antigravity：'));
  assert.match(agy, /--effort 可选 low\|medium\|high\|max/);
  assert.match(M.instructions(), /Antigravity 没有 xhigh/);
});

test('队长 instructions call the board CLI the way the column\'s shell reads env vars', () => {
  assert.equal(M.boardCli('win32'), 'node "$env:AGENTDECK_BOARD_CLI"');
  assert.equal(M.boardCli('darwin'), 'node "$AGENTDECK_BOARD_CLI"');
  const win = M.instructions('win32');
  const mac = M.instructions('darwin');
  for (const cmd of ['ledger', 'new --title', 'tell --to', 'read --id', 'receipts', 'answer --to']) {
    assert.ok(win.includes(`node "$env:AGENTDECK_BOARD_CLI" ${cmd}`), `win ${cmd}`);
    assert.ok(mac.includes(`node "$AGENTDECK_BOARD_CLI" ${cmd}`), `mac ${cmd}`);
  }
  // a bare $AGENTDECK_BOARD_CLI is an empty, undefined variable in PowerShell
  assert.ok(!/"\$AGENTDECK_BOARD_CLI"/.test(win));
  assert.ok(!/\$env:/.test(mac));
  assert.equal(M.instructions('linux'), mac);
  assert.equal(M.instructions(), mac);
  // the host passes its platform when it briefs 队长
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'main-session.js'), 'utf8'), /M\.instructions\(host\.platform[,)]/);
});
