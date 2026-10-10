'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const B = require('../board-core');
const M = require('../main-core');
const { rulebook } = require('./fixtures/captain-rulebook');
const S = require('../schedule-core');

test('a blank session offers Claude, Antigravity, Grok, Cursor CLI and Codex (ChatGPT), in that order', () => {
  assert.deepEqual(B.LAUNCHERS.map((l) => l.label), ['Claude', 'Antigravity', 'Grok', 'Cursor CLI', 'Codex (ChatGPT)']);
  for (const l of B.LAUNCHERS) assert.equal(B.commandForAgent(l.key), l.cmd, l.key);
  assert.equal(B.commandForAgent('agy'), 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high');
  assert.equal(B.commandForAgent('cursor'), 'cursor-agent --force --model claude-opus-5-5-high');
  assert.equal(B.commandForAgent('cursor-agent'), B.commandForAgent('cursor'));
  assert.equal(B.commandForAgent('grok'), 'grok --permission-mode bypassPermissions');
  assert.equal(B.commandForAgent('codex'), 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox');
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
  // 创建队长 offers the Captain's own Claude command in Claude's place.
  const captainAt = html.indexOf('<dialog id="mainDialog">'), captainEnd = html.indexOf('</dialog>', captainAt);
  const groups = [...html.matchAll(/<div class="presets">([\s\S]*?)<\/div>/g)]
    .map((m) => ({ captain: m.index > captainAt && m.index < captainEnd, cmds: [...m[1].matchAll(/data-cmd="([^"]*)"/g)].map((x) => x[1]) }));
  assert.ok(groups.length >= 2 && groups.some((g) => g.captain));
  for (const g of groups) assert.deepEqual(g.cmds, B.LAUNCHERS.map((l) => g.captain && l.key === 'claude' ? require('../claude-seats-core').CLAUDE_COMMAND : l.cmd));
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
  // the defaults run at the "ordinary code" tier; Antigravity's is in the model id
  assert.match(B.commandForAgent('claude'), /--effort high$/);
  assert.match(B.commandForAgent('agy'), /--model gemini-3\.8-flash-high$/);
  assert.ok(!/--effort/.test(B.commandForAgent('agy')), 'agy switches models when given --effort');
  assert.match(B.commandForAgent('cursor'), /--model claude-opus-5-5-high$/);
  assert.match(B.commandForAgent('cursor'), /^cursor-agent --force/);
});

test('every --agent name offered anywhere resolves to a real preset, never the silent default', () => {
  const root = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const offered = new Set();
  for (const src of [read('board-cli.js'), rulebook()]) {
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

test('Codex app launches bypass shell wrappers without duplicating their --yolo flag', () => {
  const cmd = B.commandForAgent('codex');
  assert.equal(B.shellLaunchCommand(cmd, 'darwin'), 'command "codex" --no-daemon --dangerously-bypass-approvals-and-sandbox');
  assert.equal(B.launchInput(cmd, 'linux'), '\x15command "codex" --no-daemon --dangerously-bypass-approvals-and-sandbox\r');
  assert.equal(B.shellLaunchCommand('codex resume --last --yolo', 'darwin'), 'command "codex" resume --last --yolo');
  assert.equal(B.shellLaunchCommand(cmd, 'win32'), "& 'codex' --no-daemon --dangerously-bypass-approvals-and-sandbox");
  assert.equal(B.shellLaunchCommand('codex --no-daemon --yolo', 'darwin'), 'command "codex" --no-daemon --yolo');
  assert.equal(B.shellLaunchCommand('/opt/bin/codex --yolo', 'darwin'), "command '/opt/bin/codex' --yolo");
  assert.equal(B.shellLaunchCommand('command "codex" --yolo', 'darwin'), 'command "codex" --yolo');

  for (const custom of ['node fake-agent.js', './codex-wrapper.sh']) {
    assert.equal(B.shellLaunchCommand(custom, 'darwin'), custom);
  }
});

test('Codex launch bytes bypass a real shell function that injects --yolo', { skip: process.platform === 'win32' }, () => {
  const os = require('os');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-codex-'));
  try {
    // Argument-printing stand-in only; no real CLI, settings or account touched.
    fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const wrap = 'codex() { command codex --yolo "$@"; }\n';
    const command = B.shellLaunchCommand(B.commandForAgent('codex'), process.platform);
    const output = execFileSync('/bin/sh', ['-c', wrap + command], { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH }, encoding: 'utf8' });
    assert.equal(output, '--no-daemon\n--dangerously-bypass-approvals-and-sandbox\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('custom and restored Codex commands use their own server on both platforms without duplicate flags', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const cmd of ['codex -m gpt-6-luna', 'codex resume --last --yolo', '/opt/bin/codex --yolo',
      '"C:\\Program Files\\codex.exe" resume chat-1', 'command "codex" --yolo']) {
      const capabilities = { noDaemon: true, bypass: true };
      const launch = B.shellLaunchCommand(cmd, platform, capabilities);
      assert.equal(launch.match(/--no-daemon/g).length, 1, launch);
      assert.equal(B.shellLaunchCommand(launch, platform, capabilities), launch);
    }
    assert.equal(B.shellLaunchCommand('agy --model gemini-3.8-flash-high', platform), 'agy --model gemini-3.8-flash-high');
  }
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
  const text = rulebook();
  for (const key of ['agy']) assert.ok(text.includes(B.commandForAgent(key)), key);
  assert.ok(text.includes('claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high'));
  assert.ok(text.includes('cursor-agent --force --model grok-4.7-high-fast'));
  // Codex: --agent codex (default GPT-6.1 Sol), not used for execution work for now; the bypass flag is named only to forbid writing it
  assert.match(text, /Codex：使用 --agent codex，默认模型 GPT-6\.1 Sol[^\n]*暂不消耗 ChatGPT 额度[^\n]*--dangerously-bypass-approvals-and-sandbox[^\n]*--no-daemon[^\n]*不要手动拼接/);
  assert.ok(!text.includes(B.commandForAgent('codex')), 'no ready-made codex command with the flag to copy');
  assert.match(text, /--agent claude\|agy\|cursor\|grok\|codex\|chatgpt-web \| --command/);
  // only models the CLIs listed on the owner's accounts
  const named = new Set(text.match(/\b(?:gemini|claude|grok)-[a-z0-9.-]*\d[a-z0-9.-]*/g));
  assert.deepEqual([...named].sort(), [
    'claude-haiku-5-5', 'claude-opus-4-6-thinking',
    'claude-opus-5-5', 'claude-opus-5-5-high', 'claude-opus-5-5-max', 'claude-opus-5-5-medium',
    'claude-opus-5-5-xhigh', 'claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5-5-high',
    'claude-sonnet-5-5-max', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-xhigh',
    'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'grok-4.7-high-fast',
  ]);
  assert.match(text, /Claude Code、Cursor、Codex 命令仍禁止 Claude 4\.x 和 Haiku 4\.x 及更早（Haiku 5\.5 可用[^\n]*claude-haiku-5-5/);
  assert.ok(!/Claude 4\.x 和 Haiku。/.test(text), 'Haiku 5.5 is no longer banned');
  // Antigravity has no 5.5 models
  const agyLine = text.split('\n').find((l) => l.includes('Antigravity：'));
  assert.ok(!/5-5|5\.5/.test(agyLine));
  assert.match(agyLine, /claude-sonnet-4-6[^\n]*claude-opus-4-6-thinking[^\n]*gpt-oss-120b-medium/);
  assert.ok(!text.includes('gemini-3.1-pro-high'));
  // who gets what
  const routing = text.slice(text.indexOf('模型分工（用户点名优先）：'), text.indexOf('用多大的档位（effort）：'));
  const route = (needle) => routing.split('\n').find((l) => l.startsWith('- ') && l.includes(needle)) || '';
  assert.match(route('UI 设计'), /Opus 5\.5[^\n]*最关键核心代码[^\n]*最终审核/);
  assert.match(route('重要代码'), /Sonnet 5\.5[^\n]*核心改动/);
  assert.match(route('批量写代码'), /^- Haiku 5\.5[^\n]*写测试[^\n]*CI[^\n]*--model claude-haiku-5-5[^\n]*--effort[^\n]*Sonnet 5\.5/);
  assert.ok(!/GPT-6 Luna|gpt-6-luna/.test(text), 'Luna is no longer an execution fallback');
  assert.ok(!routing.split('\n').some((l) => l.startsWith('- Codex')), 'no Codex routing line');
  assert.match(route('检索、整理'), /Gemini 3\.8 Flash[^\n]*中文[^\n]*不用 Gemini 3\.1 Pro/);
  assert.match(route('检索、整理'), /Gemini 周额度用尽时[^\n]*GPT-OSS[^\n]*Sonnet 4\.6[^\n]*Opus 4\.6/);
  assert.match(route('脏活'), /Cursor Grok 4\.7[^\n]*抓数据/);
  assert.match(text, /Claude Code：[^\n]*--model claude-opus-5-5 --effort high[^\n]*--model claude-sonnet-5-5[^\n]*--model claude-haiku-5-5[^\n]*开工后用 peek/);
  assert.match(text, /Cursor CLI：[^\n]*1–2 分钟可能没有任何输出[^\n]*别急着判定卡死/);
  // The standalone Grok subscription is gone; quota is passive and read-only.
  assert.match(text, /独立的 Grok CLI[^\n]*不要用它派活/);
  assert.match(text, /quota.*只读各家订阅额度/);
  assert.match(text, /派活前可跑 quota，避开已用尽或快用尽/);
  // progress boards, concurrency, scraping fallbacks and stuck-session patience
  assert.match(text, /13\. 任务看板：[^\n]*tasks\/<项目名>\.json[^\n]*记了卡的活 new 必须带 --task-id 和 --project，恢复已有任务不重复建卡[^\n]*状态由程序随命令回执自动改/);
  assert.match(text, /14\. [^\n]*内存压力等级[^\n]*不要因为 swap 用了几个 G 就少开[^\n]*kern\.memorystatus_vm_pressure_level[^\n]*全量 E2E/);
  assert.ok(!text.includes('vm.swapusage'));
  assert.ok(!text.includes('剩不到 1GB'));
  assert.match(text, /GitHub 现成工具、OpenCLI、agent-reach[^\n]*Muse\.ai 或 ChatGPT 浏览器/);
  // A clear goal goes straight out; gaps a look at the project can close are checked, not asked.
  assert.match(text, /3\. 目标清楚就派活：[^\n]*明确且已获授权，直接拆开派下去[^\n]*先派人检查[^\n]*影响目标、范围、授权或关键结果又查不出来的才问用户[^\n]*已有授权不因 Relay、重启或清空而重新确认，也不因此扩大[^\n]*自己决定，不拿去问用户/);
  assert.match(text, /7\. 派完马上用一两句话告诉用户交给了哪个会话、已启动还是在排队[^\n]*命令没成功返回不说已启动/);
  assert.match(text, /9\. [^\n]*先看清它问的是什么，不盲按 y 或 enter/);
  assert.match(text, /10\. [^\n]*已有明确报错（进程退出、参数非法、认证失败、限流）或停在等输入时不用等，直接按原因处理/);
  assert.match(text, /4\. 派活单步原则：一个会话一次只派一件活/);
  assert.match(text, /5\. 界面类的活要写明图标规则：[^\n]*任务正文里必须写明[^\n]*复制=两个重叠方框、删除=垃圾桶、编辑=铅笔[^\n]*tooltip[^\n]*无障碍名称[^\n]*不用「复制」这类文字按钮/);
  assert.ok(text.indexOf('3. 目标清楚就派活') < text.indexOf('4. 派活单步原则'), 'the ask-or-dispatch rule comes before the dispatch rules');
  assert.match(text, /10\. 判断会话卡没卡先用 peek，至少等 5 分钟/);
  assert.match(text, /「待补充」[^\n]*自动执行/);
  assert.ok(M.instructions().length <= M.CORE_LIMIT, 'what is pasted every time is only the core');
});

test('队长 picks the effort: simple medium, ordinary code high, complex or failed xhigh, critical max', () => {
  assert.deepEqual(M.EFFORT.map((e) => e.tier), ['medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...M.CURSOR_MODELS], [
    'claude-opus-5-5-medium', 'claude-opus-5-5-high', 'claude-opus-5-5-xhigh', 'claude-opus-5-5-max',
    'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high', 'claude-sonnet-5-5-xhigh', 'claude-sonnet-5-5-max',
  ]);
  const lines = rulebook().split('\n');
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
  assert.ok(!/claude-(?:opus|sonnet)-5-5-(?!medium|high|xhigh|max)/.test(rulebook()));
  // Antigravity's tier is the model id's suffix, never --effort (it would switch models)
  const agy = lines.find((l) => l.includes('Antigravity：'));
  assert.match(agy, /gemini-3\.8-flash-low、gemini-3\.8-flash-medium、gemini-3\.8-flash-high/);
  assert.match(agy, /绝对不要给 agy 加 --effort/);
  assert.match(rulebook(), /Antigravity 的 Gemini Flash 把档位写在模型名最后，只有 low、medium、high（没有 xhigh 和 max）/);
});

test('队长 instructions call the board CLI the way the column\'s shell reads env vars', () => {
  assert.equal(M.boardCli('win32'), 'node "$env:AGENTDECK_BOARD_CLI"');
  assert.equal(M.boardCli('darwin'), 'node "$AGENTDECK_BOARD_CLI"');
  const win = M.instructions('win32');
  const mac = M.instructions('darwin');
  // The prefix is written once, above the command list, the way this column's shell reads it.
  assert.ok(win.includes('命令，前面都加 node "$env:AGENTDECK_BOARD_CLI"：\n'), 'win prefix');
  assert.ok(mac.includes('命令，前面都加 node "$AGENTDECK_BOARD_CLI"：\n'), 'mac prefix');
  for (const text of [win, mac]) {
    const list = text.slice(text.indexOf('命令，前面都加'), text.indexOf('做下面的事之前'));
    for (const cmd of ['ledger', 'new --title', 'tell --to', 'read --id', 'receipts', 'answer --to']) assert.match(list, new RegExp(`(?:^ {3}|｜)${cmd}`, 'm'), cmd);
  }
  // Terminal commands use PowerShell; the background Bash tool uses POSIX
  // syntax on Windows too. Only its explicitly labelled rule may contain it.
  const bashRule = win.split('\n').find((line) => line.startsWith('- 回执监听：'));
  assert.match(bashRule, /Bash 工具.*node "\$AGENTDECK_BOARD_CLI" receipts --wait/);
  assert.ok(!/"\$AGENTDECK_BOARD_CLI"/.test(win.split('\n').filter((line) => line !== bashRule).join('\n')));
  assert.ok(!/\$env:/.test(mac));
  assert.equal(M.instructions('linux'), mac);
  assert.equal(M.instructions(), mac);
  // the host passes its platform when it briefs 队长
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'main-session.js'), 'utf8'), /M\.instructions\(host\.platform[,)]/);
});
