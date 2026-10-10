(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BoardCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CLAUDE = 'claude --dangerously-skip-permissions --effort high';
  // Antigravity's effort is the model id's suffix: --effort beside a model id
  // makes it fall back to another model, so the preset never passes it.
  const AGY = 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high';
  // `cursor-agent`, never `agent`: that name collides with other tools' binaries.
  const CURSOR = 'cursor-agent --force --model claude-opus-5-5-high';
  const GROK = 'grok --permission-mode bypassPermissions';
  const CODEX = 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox';
  const GEMINI = 'gemini --yolo';
  const AGENT_COMMANDS = Object.freeze({
    claude: CLAUDE,
    antigravity: AGY,
    agy: AGY,
    grok: GROK,
    cursor: CURSOR,
    'cursor-agent': CURSOR,
    codex: CODEX,
    'codex (chatgpt)': CODEX,
    chatgpt: CODEX,
    'chatgpt-web': 'chatgpt-web',
    gemini: GEMINI,
    shell: '',
  });
  // What a blank session offers to start, in this order.
  const LAUNCHERS = Object.freeze([
    { key: 'claude', label: 'Claude', cmd: CLAUDE },
    { key: 'agy', label: 'Antigravity', cmd: AGY },
    { key: 'grok', label: 'Grok', cmd: GROK },
    { key: 'cursor', label: 'Cursor CLI', cmd: CURSOR },
    { key: 'codex', label: 'Codex (ChatGPT)', cmd: CODEX },
  ].map(Object.freeze));
  const LEGACY_COMMANDS = Object.freeze({
    agy: AGY,
    'agy --model gemini-3.8-flash-high --effort high': AGY,
    'agy --dangerously-skip-permissions --model gemini-3.8-flash-high --effort high': AGY,
    grok: GROK,
    cursor: CURSOR,
    'cursor-agent': CURSOR,
    'cursor-agent --model claude-opus-5-5-high': CURSOR,
    claude: CLAUDE,
    'claude --dangerously-skip-permissions': CLAUDE,
    codex: CODEX,
    'codex --dangerously-bypass-approvals-and-sandbox': CODEX,
    gemini: GEMINI,
  });

  function upgradeLegacyCommand(command) {
    if (typeof command !== 'string') return command;
    const trimmed = command.trim();
    return Object.prototype.hasOwnProperty.call(LEGACY_COMMANDS, trimmed)
      ? LEGACY_COMMANDS[trimmed]
      : command;
  }
  // zsh, bash, fish, PowerShell and cmd wording for a program that isn't there
  const NOT_FOUND_RE = /command not found|unknown command|is not recognized|no such file or directory|未找到命令|找不到命令|无法将.{0,240}?识别为\s*cmdlet|不是内部或外部命令/gi;

  const LINK_TYPES = Object.freeze(['delegation', 'dependency', 'handoff']);

  function cleanText(value, max = 4000) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, max);
  }

  function normalizeRole(role) {
    return role === 'conductor' || role === 'worker' ? role : 'manual';
  }

  function normalizeColumn(column) {
    const c = column || {};
    const role = normalizeRole(c.role);
    return {
      ...c,
      project: cleanText(c.project, 120).replace(/\s+/g, ' '),
      reviews: [...new Set((Array.isArray(c.reviews) ? c.reviews : []).filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)))],
      taskId: cleanText(c.taskId, 160) || cleanText(c.id, 160),
      displayTitle: cleanText(c.displayTitle, 200),
      role,
      managed: role !== 'manual',
      parentTaskId: role === 'worker' ? cleanText(c.parentTaskId || c.parentId, 160) || null : null,
      taskTitle: cleanText(c.taskTitle || c.title, 200),
      taskPrompt: role === 'manual' ? '' : cleanText(c.taskPrompt, 20000),
      relationship: role === 'conductor'
        ? 'Top-level task'
        : role === 'worker'
          ? cleanText(c.relationship, 200) || 'Delegated by parent'
          : 'Independent manual terminal',
      progress: cleanText(c.progress, 1000),
      result: cleanText(c.result, 12000),
      requestId: role === 'manual' ? null : cleanText(c.requestId, 200) || null,
      waitRequestIds: role === 'manual'
        ? []
        : Array.from(new Set((Array.isArray(c.waitRequestIds) ? c.waitRequestIds : [])
          .map((id) => cleanText(id, 200)).filter(Boolean))),
      createdByRequestId: role === 'manual' ? null : cleanText(c.createdByRequestId, 200) || null,
      taskCompleted: role === 'manual' ? false : !!c.taskCompleted,
      initialPromptSent: role === 'manual' ? false : !!c.initialPromptSent,
    };
  }

  function inferAgentType(command) {
    const cmd = cleanText(command, 500).toLowerCase();
    if (/^\s*claude(?:\s|$)/.test(cmd)) return 'Claude';
    if (/^\s*(?:agy|antigravity)(?:\s|$)/.test(cmd)) return 'Antigravity';
    if (/^\s*grok(?:\s|$)/.test(cmd)) return 'Grok';
    if (/^\s*cursor-agent(?:\s|$)/.test(cmd)) return 'Cursor';
    if (/^\s*codex(?:\s|$)/.test(cmd)) return 'Codex';
    if (cmd === 'chatgpt-web') return 'ChatGPT Web';
    if (/^\s*gemini(?:\s|$)/.test(cmd)) return 'Antigravity';
    return cmd ? 'Custom agent' : 'Shell';
  }

  // How often the screen says the command's program doesn't exist. Counted, so
  // an old error already on screen is not mistaken for a new one. Rows are
  // joined first: a narrow column soft-wraps the message mid-word.
  function launchErrors(screen, command) {
    const bin = cleanText(command, 1000).split(/\s+/)[0].replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '');
    if (!bin) return 0;
    const flat = String(screen || '').replace(/\r?\n/g, '');
    let n = 0;
    for (const m of flat.matchAll(NOT_FOUND_RE)) {
      if (flat.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80).includes(bin)) n++;
    }
    return n;
  }

  // What a launcher button types into the session's shell. A half-typed line is
  // dropped first with editing keys only, never ^C, which would interrupt a
  // program running there: ^U on Unix shells; on Windows Ctrl+End then Ctrl+Home
  // (delete to end, delete to start) in both PSReadLine and the console's own
  // line editor, where ^U means nothing.
  function launchInput(command, platform, reportExit = false) {
    const clear = platform === 'win32' ? '\x1b[1;5F\x1b[1;5H' : '\x15';
    const launch = shellLaunchCommand(cleanText(String(command == null ? '' : command).replace(/[\u0000-\u001f\u007f]+/g, ' '), 1000), platform);
    return clear + (reportExit ? reportAgentExit(launch, platform) : launch) + '\r';
  }

  function reportAgentExit(command, platform) {
    return platform === 'win32'
      ? `${command}; node "$env:AGENTDECK_BOARD_CLI" session-exit --code "$LASTEXITCODE"`
      : `${command}; node "$AGENTDECK_BOARD_CLI" session-exit --code "$?"`;
  }

  function codexProgram(command, platform) {
    const words = String(command).match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) || [];
    const index = ['command', '&'].includes(words[0]) ? 1 : 0;
    const program = words[index] || '';
    let literal = program.replace(/^["']|["']$/g, '');
    if (platform === 'win32' && program.startsWith("'")) literal = literal.replace(/''/g, "'");
    const name = literal.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '');
    return name.toLowerCase() === 'codex' ? { words, index, program, literal } : null;
  }

  // Capabilities come from this executable's root --help, never a version guess.
  // Saved presets are launch intent: unsupported managed flags must be removed.
  function shellLaunchCommand(command, platform, capabilities) {
    const parsed = codexProgram(command, platform);
    if (!parsed) return command;
    const { words, index, program, literal } = parsed;
    let args = words.slice(index + 1);
    if (capabilities) {
      const managed = new Set(['--no-daemon', '--yolo', '--dangerously-bypass-approvals-and-sandbox']);
      const stop = args.indexOf('--');
      const tail = stop < 0 ? [] : args.slice(stop);
      args = (stop < 0 ? args : args.slice(0, stop)).filter((w) => !managed.has(w));
      const extra = [];
      if (capabilities.noDaemon) extra.push('--no-daemon');
      if (capabilities.bypass) extra.push('--dangerously-bypass-approvals-and-sandbox');
      else if (capabilities.yolo) extra.push('--yolo');
      args = [...extra, ...args, ...tail];
    }
    const binary = capabilities?.program || literal;
    const quote = (s) => "'" + s.replace(/'/g, platform === 'win32' ? "''" : "'\\''") + "'";
    // PowerShell needs & before a quoted executable. Unix command bypasses
    // functions/aliases that may append another --yolo.
    const direct = platform === 'win32' ? '& ' + quote(binary)
      : 'command ' + (capabilities?.program || /[\\/]/.test(program) ? quote(binary) : /^["']/.test(program) ? program : `"${program}"`);
    return [direct, ...args].join(' ');
  }

  // Where a launch from those buttons stands. Only an agent identified in the
  // foreground counts as started. Windows can't report the foreground process,
  // so there a timeout without a recognized agent screen is 'unknown', never 'up'.
  const LAUNCH_TIMEOUT = 15000;
  function launchVerdict({ alive, missing, up, waited, platform }) {
    if (!alive) return 'exited';
    if (missing) return 'missing';
    if (up) return 'up';
    if (waited > LAUNCH_TIMEOUT) return platform === 'win32' ? 'unknown' : 'failed';
    return 'waiting';
  }

  function commandForAgent(agent, customCommand) {
    const custom = cleanText(customCommand, 1000);
    if (custom) return custom;
    const key = cleanText(agent, 80).toLowerCase();
    return AGENT_COMMANDS[key] !== undefined ? AGENT_COMMANDS[key] : AGENT_COMMANDS.claude;
  }

  function normalizeLink(link) {
    const value = link || {};
    const type = LINK_TYPES.includes(value.type) ? value.type : 'dependency';
    return {
      id: cleanText(value.id, 200),
      fromTaskId: cleanText(value.fromTaskId, 160),
      toTaskId: cleanText(value.toTaskId, 160),
      type,
      message: cleanText(value.message, 12000),
      grantedControl: type === 'delegation' && !!value.grantedControl,
      createdAt: Number(value.createdAt) || Date.now(),
    };
  }

  function uniqueDisplayTitle(value, inputColumns, currentTaskId) {
    const base = cleanText(value, 200) || 'Terminal';
    const used = new Set((inputColumns || [])
      .map(normalizeColumn)
      .filter((col) => col.taskId !== currentTaskId)
      .map((col) => cleanText(col.displayTitle || col.title || col.taskTitle, 200).toLowerCase())
      .filter(Boolean));
    if (!used.has(base.toLowerCase())) return base;
    let n = 2;
    while (used.has(`${base} (${n})`.toLowerCase())) n++;
    return `${base} (${n})`;
  }

  function taskDepth(inputColumns, inputColumn) {
    const columns = (inputColumns || []).map(normalizeColumn);
    const targetTaskId = normalizeColumn(inputColumn).taskId;
    const byTaskId = new Map(columns.map((c) => [c.taskId, c]));
    const seen = new Set();
    let current = byTaskId.get(targetTaskId);
    let depth = 0;
    while (current && current.parentTaskId && !seen.has(current.taskId)) {
      seen.add(current.taskId);
      current = byTaskId.get(current.parentTaskId);
      if (!current) break;
      depth++;
    }
    return depth;
  }

  function isManagedDescendant(inputColumns, inputParent, inputTarget) {
    const columns = (inputColumns || []).map(normalizeColumn);
    const parent = normalizeColumn(inputParent);
    const target = normalizeColumn(inputTarget);
    if (!parent.managed || !target.managed || parent.taskId === target.taskId) return false;
    const byTaskId = new Map(columns.map((c) => [c.taskId, c]));
    const seen = new Set();
    let taskId = target.parentTaskId;
    while (taskId && !seen.has(taskId)) {
      if (taskId === parent.taskId) return true;
      seen.add(taskId);
      const current = byTaskId.get(taskId);
      taskId = current && current.parentTaskId;
    }
    return false;
  }

  return {
    AGENT_COMMANDS,
    LAUNCHERS,
    LEGACY_COMMANDS,
    upgradeLegacyCommand,
    cleanText,
    normalizeRole,
    normalizeColumn,
    inferAgentType,
    commandForAgent,
    launchErrors,
    launchInput,
    shellLaunchCommand,
    codexProgram,
    reportAgentExit,
    launchVerdict,
    LINK_TYPES,
    normalizeLink,
    uniqueDisplayTitle,
    taskDepth,
    isManagedDescendant,
  };
});
