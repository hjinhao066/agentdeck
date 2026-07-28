(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BoardCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AGENT_COMMANDS = Object.freeze({
    claude: 'claude --dangerously-skip-permissions',
    antigravity: 'agy',
    agy: 'agy',
    grok: 'grok',
    shell: '',
  });

  const STATE_LABELS = Object.freeze({
    plain: 'Not started',
    working: 'Working',
    input: 'Waiting for input',
    done: 'Completed',
    exited: 'Exited',
  });
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
    return cmd ? 'Custom agent' : 'Shell';
  }

  function commandForAgent(agent, customCommand) {
    const custom = cleanText(customCommand, 1000);
    if (custom) return custom;
    const key = cleanText(agent, 80).toLowerCase();
    return AGENT_COMMANDS[key] !== undefined ? AGENT_COMMANDS[key] : AGENT_COMMANDS.claude;
  }

  function stateLabel(state, completed) {
    if (completed) return STATE_LABELS.done;
    return STATE_LABELS[state] || STATE_LABELS.plain;
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

  function linkLabel(type) {
    if (type === 'delegation') return 'Delegation';
    if (type === 'handoff') return 'Message / handoff';
    return 'Dependency';
  }

  function linkState(inputLink, inputColumns, stateByTaskId) {
    const link = normalizeLink(inputLink);
    const columns = (inputColumns || []).map(normalizeColumn);
    const byTaskId = new Map(columns.map((c) => [c.taskId, c]));
    const source = byTaskId.get(link.fromTaskId);
    const target = byTaskId.get(link.toTaskId);
    if (!source || !target) return 'Broken';
    const states = stateByTaskId || {};
    if (link.type === 'dependency') {
      const sourceDone = source.taskCompleted || states[source.taskId] === 'done';
      return sourceDone ? 'Ready' : 'Blocked';
    }
    if (link.type === 'handoff') return 'Channel active';
    if (target.taskCompleted) return 'Completed';
    return stateLabel(states[target.taskId] || 'plain', false);
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

  function controlGrantError(inputColumns, inputSource, inputTarget, maxDepth) {
    const columns = (inputColumns || []).map(normalizeColumn);
    const source = normalizeColumn(inputSource);
    const target = normalizeColumn(inputTarget);
    if (!source.managed) return 'A manual source terminal cannot control another terminal.';
    if (source.taskId === target.taskId || isManagedDescendant(columns, target, source)) {
      return 'This delegation would create a control cycle.';
    }
    const limit = Number(maxDepth) || 8;
    if (taskDepth(columns, source) + 1 > limit) {
      return `Maximum delegation depth reached (${limit}).`;
    }
    return '';
  }

  function graphLayout(inputColumns, options) {
    const opts = options || {};
    const nodeW = opts.nodeWidth || 248;
    const nodeH = opts.nodeHeight || 142;
    const gapX = opts.gapX || 88;
    const gapY = opts.gapY || 40;
    const pad = opts.padding || 48;
    const columns = (inputColumns || []).map(normalizeColumn);
    const managed = columns.filter((c) => c.managed);
    const manual = columns.filter((c) => !c.managed);
    const byTaskId = new Map(managed.map((c) => [c.taskId, c]));
    const depthMemo = new Map();

    function depthOf(col, visiting) {
      if (depthMemo.has(col.taskId)) return depthMemo.get(col.taskId);
      const seen = visiting || new Set();
      if (seen.has(col.taskId)) return 0;
      seen.add(col.taskId);
      const parent = col.parentTaskId && byTaskId.get(col.parentTaskId);
      const depth = parent ? depthOf(parent, seen) + 1 : 0;
      depthMemo.set(col.taskId, depth);
      return depth;
    }

    const managedGroups = new Map();
    let maxDepth = 0;
    managed.forEach((col) => {
      const depth = depthOf(col);
      maxDepth = Math.max(maxDepth, depth);
      if (!managedGroups.has(depth)) managedGroups.set(depth, []);
      managedGroups.get(depth).push(col);
    });

    const manualDepth = managed.length ? maxDepth + 1 : 0;
    const groups = new Map(managedGroups);
    if (manual.length) groups.set(manualDepth, manual);
    const maxRows = Math.max(1, ...Array.from(groups.values(), (g) => g.length));
    const contentH = maxRows * nodeH + Math.max(0, maxRows - 1) * gapY;
    const nodes = [];

    Array.from(groups.entries()).sort((a, b) => a[0] - b[0]).forEach(([depth, group]) => {
      const groupH = group.length * nodeH + Math.max(0, group.length - 1) * gapY;
      const startY = pad + Math.max(0, (contentH - groupH) / 2);
      group.forEach((col, index) => {
        nodes.push({
          id: col.id,
          taskId: col.taskId,
          column: col,
          lane: col.managed ? 'managed' : 'manual',
          depth,
          x: pad + depth * (nodeW + gapX),
          y: startY + index * (nodeH + gapY),
          width: nodeW,
          height: nodeH,
        });
      });
    });

    const nodeByTaskId = new Map(nodes.map((n) => [n.taskId, n]));
    const edges = managed
      .filter((c) => {
        if (!c.parentTaskId || !nodeByTaskId.has(c.parentTaskId)) return false;
        const parent = nodeByTaskId.get(c.parentTaskId);
        const child = nodeByTaskId.get(c.taskId);
        return parent && child && parent.depth < child.depth;
      })
      .map((c) => ({
        from: c.parentTaskId,
        to: c.taskId,
        fromColumnId: nodeByTaskId.get(c.parentTaskId).id,
        toColumnId: c.id,
        relationship: c.relationship || 'Delegates',
      }));
    const depthCount = Math.max(manual.length ? manualDepth : maxDepth, 0) + 1;

    return {
      nodes,
      edges,
      width: pad * 2 + depthCount * nodeW + Math.max(0, depthCount - 1) * gapX,
      height: pad * 2 + contentH,
      manualDepth,
    };
  }

  return {
    AGENT_COMMANDS,
    STATE_LABELS,
    cleanText,
    normalizeRole,
    normalizeColumn,
    inferAgentType,
    commandForAgent,
    stateLabel,
    LINK_TYPES,
    normalizeLink,
    uniqueDisplayTitle,
    linkLabel,
    linkState,
    taskDepth,
    isManagedDescendant,
    controlGrantError,
    graphLayout,
  };
});
