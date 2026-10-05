// Restart resume: which in-flight crew to continue after AgentDeck comes back,
// and how each CLI is actually restarted. No DOM and no Electron.
//
// A safe stop is an explicit marker written by this app. Matching loose words
// such as "等待队长" treated real completions ("等待队长验收") as pauses, and
// the saved receipt kept only the first sentence, so the two layers disagreed.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RestartResume = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CHECKPOINT_TOKEN = 'AGENTDECK-CHECKPOINT';
  const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  // Same open set for a clean quit and a crash. A crash never gets to park,
  // so quota / asking / input must still be continued or they are dropped.
  const OPEN = ['queued', 'working', 'paused', 'quota', 'input', 'asking'];
  const PARK = ['queued', 'working', 'quota', 'input', 'asking'];
  const BATCH = 2;
  const WORDS = /(?:[^\s"'\\]|\\.|"(?:\\.|[^"])*"|'[^']*')+/g;
  const unquote = (w) => String(w).replace(/^["']|["']$/g, '');
  const programName = (w) => unquote(w).replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  const PROVIDERS = { claude: 'Claude', grok: 'Grok', 'cursor-agent': 'Cursor', codex: 'Codex', agy: 'Antigravity', gemini: 'Gemini' };

  function wordsOf(cmd) { return String(cmd || '').match(WORDS) || []; }
  function providerOf(cmd) {
    const words = wordsOf(cmd);
    return words.length ? (PROVIDERS[programName(words[0])] || '') : '';
  }
  function validSessionId(id) { return typeof id === 'string' && UUID.test(id); }

  // These ids arrive only with the column's authenticated receipt capability.
  // The provider sets its own id in shell-tool environments, so cwd/timestamps
  // and the machine's latest conversation are never used to infer ownership.
  function bindSessionIdentity(col, sessionIds, columns) {
    if (!col || !col.id || !sessionIds || typeof sessionIds !== 'object') return false;
    const provider = providerOf(col.cmd);
    if (!['Codex', 'Cursor', 'Antigravity'].includes(provider)) return false;
    const id = sessionIds[provider];
    if (!validSessionId(id)) return false;
    if ((columns || []).some((other) => other && other.id !== col.id && providerOf(other.cmd) === provider &&
        String(other.modelSessionId || '').toLowerCase() === id.toLowerCase())) return false;
    if (col.modelSessionId === id && col.modelSessionOwner === col.id && col.modelSessionCwd === (col.cwd || '') && col.modelSessionSource === 'agent-env') return false;
    col.modelSessionId = id;
    col.modelSessionOwner = col.id;
    col.modelSessionCwd = col.cwd || '';
    col.modelSessionSource = 'agent-env';
    return true;
  }

  function isSafetyCheckpoint(text) {
    return new RegExp('(?:^|\\s)' + CHECKPOINT_TOKEN + '(?:\\s|$)').test(String(text || ''));
  }
  function isCheckpointClosure(task) {
    if (!task) return false;
    if (task.receipt && task.receipt.checkpoint === true) return true;
    if (!['done', 'paused', 'stopped'].includes(task.status)) return false;
    if (task.receipt && task.receipt.failed) return false;
    return isSafetyCheckpoint(task.receipt && task.receipt.summary);
  }
  function shouldResume(task) {
    if (!task) return false;
    // failed / stopped / done stay closed unless this app marked a checkpoint.
    // quota and asking are still the same job; a crash never rewrites them.
    if (['failed', 'stopped', 'done'].includes(task.status)) return isCheckpointClosure(task);
    return OPEN.includes(task.status);
  }
  function holdsAcrossRestart(task) {
    return !!task && (OPEN.includes(task.status) || isCheckpointClosure(task));
  }
  function shouldPark(task) {
    return !!task && PARK.includes(task.status) && !(task.receipt && task.receipt.failed);
  }
  function resumeEnabled(config) {
    return !config || config.resumeOnRestart !== false;
  }

  // Remove provider-specific session selectors, including flags that create
  // an explicit id. A resend must not reuse an old resume or creation id.
  function freshCommand(cmd) {
    const words = wordsOf(cmd);
    if (!words.length) return String(cmd || '');
    const name = programName(words[0]);
    if (!PROVIDERS[name]) return String(cmd || '');
    const out = [words[0]];
    const valueFlags = {
      claude: ['--resume', '-r', '--session-id'],
      grok: ['--resume', '-r', '--session-id', '-s'],
      'cursor-agent': ['--resume'],
      codex: [],
      agy: ['--conversation'],
      gemini: ['--resume', '-r'],
    }[name];
    const bareFlags = ['--continue'];
    if (name === 'claude' || name === 'agy') bareFlags.push('-c');
    if (name === 'codex') bareFlags.push('--last', '--all');
    let removeSessionArgument = false;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      const flag = w.split('=')[0];
      if (valueFlags.includes(flag)) {
        if (!w.includes('=') && words[i + 1] && !words[i + 1].startsWith('-')) i++;
        continue;
      }
      if (bareFlags.includes(w)) {
        if (name === 'codex' && w === '--last') removeSessionArgument = false;
        continue;
      }
      if (name === 'codex' && ['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '-a', '--ask-for-approval', '--local-provider', '--remote', '--remote-auth-token-env', '--enable', '--disable', '--add-dir', '-i', '--image'].includes(w)) {
        out.push(w);
        if (words[i + 1]) out.push(words[++i]);
        continue;
      }
      if ((name === 'codex' && /^(?:resume|fork)$/i.test(w)) || (name === 'cursor-agent' && i === 1 && w === 'resume')) {
        removeSessionArgument = true;
        continue;
      }
      if (removeSessionArgument && !w.startsWith('-')) {
        removeSessionArgument = false;
        continue;
      }
      out.push(w);
    }
    return out.join(' ');
  }

  // Proven resume of THIS conversation. --last / --continue are the most
  // recent session on the machine, which is a different column when several
  // of the same CLI are open, so they are not used.
  function resumeCommand(cmd, sessionId) {
    const words = wordsOf(cmd);
    if (!words.length || !validSessionId(sessionId)) return String(cmd || '');
    const name = programName(words[0]);
    const base = wordsOf(freshCommand(cmd));
    const head = base[0] || words[0];
    const tail = base.slice(1).join(' ');
    const suffix = tail ? ' ' + tail : '';
    if (name === 'claude') return head + ' --resume ' + sessionId + suffix;
    if (name === 'grok') return head + ' -r ' + sessionId + suffix;
    if (name === 'cursor-agent') return head + ' --resume ' + sessionId + suffix;
    if (name === 'codex') return head + ' resume ' + sessionId + suffix;
    if (name === 'agy') return head + ' --conversation ' + sessionId + suffix;
    if (name === 'gemini') return head + ' --resume ' + sessionId + suffix;
    return String(cmd || '');
  }

  function trueResumeNote(provider) {
    return '真续接：' + provider + ' 已用原会话号恢复同一条对话，接着干，不要另开任务。';
  }
  function resendNote(provider) {
    return '重发：' + (provider || '这个会话') + ' 无法续上原对话，这是新会话。\n下面重发卡片任务和最后回执，不要当成新派的另一张卡。';
  }
  function launchChoice(input) {
    const cmd = input && input.cmd || '';
    const task = input && input.task;
    if (input && input.enabled === false) return { mode: 'leave' };
    if (!shouldResume(task)) return { mode: 'leave' };
    const provider = providerOf(cmd) || '未知';
    const id = validSessionId(input && input.sessionId) ? input.sessionId : '';
    if (id && provider !== '未知') {
      const launch = resumeCommand(cmd, id);
      if (launch !== cmd) return { mode: 'resume', launch, sessionId: id, resumedAgent: true, provider, note: trueResumeNote(provider) };
    }
    return { mode: 'resend', launch: freshCommand(cmd), sessionId: null, resumedAgent: false, provider, note: resendNote(provider) };
  }

  function resumeMessage(input) {
    const mode = input && input.mode === 'resume' ? 'resume' : 'resend';
    const provider = input && input.provider || '未知';
    const lines = [mode === 'resume' ? trueResumeNote(provider) : resendNote(provider)];
    if (input && input.retry) lines.push('这是同一次续接的再次送达。若你已经收到过同样的说明，不要另开任务。');
    lines.push('AgentDeck 刚重启。从停下的地方接着干。停在安全点不要用 complete；那会把卡片标成已完成。');
    if (mode === 'resend') {
      lines.push('卡片任务：' + String(input && input.title || '（无标题）').replace(/\s+/g, ' ').trim().slice(0, 120));
      const body = String(input && input.task || '').trim();
      if (body) lines.push(body);
      lines.push('最后回执：' + (String(input && input.receipt || '').trim() || '（没有回执）'));
    }
    const pending = String(input && input.pendingText || '').trim();
    if (pending) lines.push('重启前还没送达的指令：\n' + pending);
    return lines.join('\n');
  }
  function checkpointMessage() {
    return [
      'AgentDeck 即将重启。请停在安全点：把改动提交并推送到功能分支，用 progress 写清下一步，然后停下等待。',
      '不要用 complete 报告安全点。重启后能续上原对话的会真续接，续不上的会新开会话并重发任务和最后回执。',
    ].join('\n');
  }
  function checkpointSummary() {
    return CHECKPOINT_TOKEN + ' 应用已记录重启检查点，尚未确认队员停在安全点；重启后会自动续上。';
  }
  function failureNote(reason) {
    return '续接失败：' + (reason || '重发仍未送达') + '。已通知队长，请检查该会话。';
  }

  function latestTasks(tasks) {
    const latest = new Map();
    for (const task of Array.isArray(tasks) ? tasks : []) if (task && task.colId) latest.set(task.colId, task);
    return latest;
  }
  function planResume(columns, tasks, claims, runId) {
    const latest = latestTasks(tasks);
    const plans = [];
    for (const col of Array.isArray(columns) ? columns : []) {
      if (!col || col.isMain || !col.captainCrew || !col.coldSpawned || !col.cmd || col.archived) continue;
      const task = latest.get(col.id);
      if (!shouldResume(task)) continue;
      if (claimDisposition(claims && claims[col.id], task.id, runId) === 'skip' || claimDisposition(claims && claims[col.id], task.id, runId) === 'fail') continue;
      plans.push({ id: col.id, title: task.title || col.title || '', taskId: task.id || '' });
    }
    return plans;
  }
  function planPark(columns, tasks) {
    const latest = latestTasks(tasks);
    const plans = [];
    for (const col of Array.isArray(columns) ? columns : []) {
      if (!col || col.isMain || !col.captainCrew || col.archived) continue;
      const task = latest.get(col.id);
      if (!shouldPark(task)) continue;
      plans.push({ id: col.id, title: task.title || col.title || '', message: checkpointMessage() });
    }
    return plans;
  }
  function claimDisposition(claim, taskId, runId) {
    if (taskId && (claim?.taskId !== taskId || claim?.runId !== runId)) return 'send';
    if (!claim || !claim.phase) return 'send';
    if (claim.phase === 'armed') return 'retry';
    if (claim.phase === 'retrying') return 'fail';
    return 'skip';
  }
  // At most two continues in flight. The caller releases a slot when that
  // send lands or its own timeout fires, then asks again.
  function nextBatch(waiting, inflight, limit) {
    const room = Math.max(0, (limit || BATCH) - (inflight || 0));
    return (Array.isArray(waiting) ? waiting : []).slice(0, room);
  }
  function ledgerState(terminalState, alive, task) {
    if (task && task.status === 'paused') return 'paused';
    if (alive && task && ['working', 'queued', 'paused'].includes(task.status) && (terminalState === 'done' || terminalState === 'plain')) return 'working';
    return terminalState || 'plain';
  }
  function ignoreQuota(task, now) {
    return !!(task && task.resumeGraceUntil && now < task.resumeGraceUntil);
  }

  function emptyManifest() { return { version: 1, claims: {}, entries: [] }; }
  function parseManifest(text) {
    try {
      const doc = JSON.parse(text);
      if (!doc || doc.version !== 1 || !doc.claims || typeof doc.claims !== 'object' || Array.isArray(doc.claims) || !Array.isArray(doc.entries)) return emptyManifest();
      return { version: 1, claims: doc.claims, entries: doc.entries.filter((e) => e && typeof e.colId === 'string') };
    } catch (_) { return emptyManifest(); }
  }
  function manifestEntry(input) {
    const choice = launchChoice({ cmd: input.cmd, sessionId: input.sessionId, task: input.task, enabled: input.enabled !== false });
    return {
      colId: input.colId,
      taskId: input.task && input.task.id || '',
      title: input.title || (input.task && input.task.title) || '',
      task: String(input.detail || ''),
      receipt: String(input.receipt || ''),
      pendingText: String(input.pendingText || ''),
      boardId: input.boardId || (input.task && input.task.boardId) || '',
      mode: choice.mode === 'leave' ? 'resend' : choice.mode,
      provider: choice.provider || providerOf(input.cmd) || '未知',
      sessionId: choice.sessionId || null,
      cmd: input.cmd || '',
      cwd: input.cwd || '',
    };
  }

  // The first before-quit must not call app.quit() on the same stack: Electron
  // drops that nested quit, and a timer that treats "the page answered" as
  // "the process already exited" never tries again. Quit is always scheduled
  // for a later turn, and both the ack and the timeout share one finish().
  function createQuitGate(opts) {
    const timeoutMs = opts && opts.timeoutMs || 1500;
    const schedule = opts.schedule;
    const later = opts.later;
    let stage = 'idle';
    let timer = null;
    function finish() {
      if (stage === 'quitting' || stage === 'done') return;
      stage = 'quitting';
      if (timer) { timer(); timer = null; }
      later(() => { stage = 'done'; opts.quit(); });
    }
    return {
      beforeQuit(event, enabled) {
        if (!enabled || stage === 'done') return 'cleanup';
        if (event && event.preventDefault) event.preventDefault();
        if (stage === 'parking' || stage === 'quitting') return 'waiting';
        stage = 'parking';
        timer = schedule(finish, timeoutMs);
        if (opts.onPark) opts.onPark();
        return 'parking';
      },
      acked() { finish(); },
      stage() { return stage; },
    };
  }

  return {
    CHECKPOINT_TOKEN, OPEN, BATCH, UUID,
    providerOf, validSessionId, bindSessionIdentity, isSafetyCheckpoint, isCheckpointClosure,
    shouldResume, holdsAcrossRestart, shouldPark, resumeEnabled,
    freshCommand, resumeCommand, trueResumeNote, resendNote, launchChoice, resumeMessage,
    checkpointMessage, checkpointSummary, failureNote,
    latestTasks, planResume, planPark, claimDisposition, nextBatch, ledgerState, ignoreQuota,
    emptyManifest, parseManifest, manifestEntry, createQuitGate,
  };
});
