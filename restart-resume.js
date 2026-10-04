// Restart resume: which crew sessions to continue after AgentDeck or the
// computer comes back, and which "complete" receipts are only a safe stop.
// No DOM and no Electron. Runs in the page and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RestartResume = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A worker reporting a pause must not look like a finished task. Real
  // completions ("已做完并推送") do not match.
  const CHECKPOINT_RE = /停在安全点|安全停点|安全停工|安全检查点|停下等待|等待接续|等待续派|等待队长|safe point|safety checkpoint|checkpoint before restart/i;
  const CAPTAIN_STOP_RE = /队长已请求中断|队长已结束|队长已取消/;
  const RESUME_STATUSES = ['queued', 'working', 'paused'];
  const HOLD_STATUSES = ['queued', 'working', 'paused', 'quota', 'input', 'asking'];

  function isSafetyCheckpoint(text) {
    return CHECKPOINT_RE.test(String(text || ''));
  }

  function isCheckpointClosure(task) {
    if (!task || !['done', 'stopped'].includes(task.status)) return false;
    if (task.receipt?.failed || task.receipt?.question) return false;
    const summary = String(task.receipt?.summary || '');
    if (CAPTAIN_STOP_RE.test(summary)) return false;
    return isSafetyCheckpoint(summary);
  }

  // Still the same job after a restart: in flight, or closed only because the
  // worker said it had stopped at a safe point.
  function shouldResume(task) {
    if (!task || task.receipt?.failed) return false;
    if (RESUME_STATUSES.includes(task.status)) return true;
    return isCheckpointClosure(task);
  }

  // Any open card is protected from the "terminal exited" failure while the
  // new process is still starting. Quota and questions are not auto-continued.
  function holdsAcrossRestart(task) {
    return !!task && (HOLD_STATUSES.includes(task.status) || isCheckpointClosure(task));
  }

  function shouldPark(task) {
    return !!task && ['queued', 'working', 'input'].includes(task.status) && !task.receipt?.failed;
  }

  function resumeMessage(title) {
    const name = title ? `「${String(title).replace(/\s+/g, ' ').trim().slice(0, 80)}」` : '原来的任务';
    return [
      `AgentDeck 刚重启。${name}还没做完，从你停下的地方接着干，不要另开一件新任务。`,
      '如果工作区还有没提交的改动，先提交并推送到你的功能分支。',
      '进度用 progress 汇报。只有整件任务真正做完才 complete。',
      '停在安全点、等重启、等队长续派，都不要用 complete：那会把卡片标成已完成，后面的续派会被拒绝。',
    ].join('\n');
  }

  function checkpointMessage() {
    return [
      'AgentDeck 即将重启。请停在安全点：把改动提交并推送到你的功能分支，用 progress 写清下一步，然后停下等待。',
      '不要用 complete 报告安全点。重启后会自动让你接着干。',
    ].join('\n');
  }

  function latestTasks(tasks) {
    const latest = new Map();
    for (const task of Array.isArray(tasks) ? tasks : []) if (task && task.colId) latest.set(task.colId, task);
    return latest;
  }

  // columns need coldSpawned so a hot reload (the process is still alive)
  // does not type a second "continue" into a worker that never stopped.
  function planResume(columns, tasks) {
    const latest = latestTasks(tasks);
    const plans = [];
    for (const col of Array.isArray(columns) ? columns : []) {
      if (!col || col.isMain || !col.captainCrew || !col.coldSpawned || !col.cmd) continue;
      const task = latest.get(col.id);
      if (!shouldResume(task)) continue;
      const title = task.title || col.title || '';
      plans.push({ id: col.id, title, message: resumeMessage(title) });
    }
    return plans;
  }

  function planPark(columns, tasks) {
    const latest = latestTasks(tasks);
    const plans = [];
    for (const col of Array.isArray(columns) ? columns : []) {
      if (!col || col.isMain || !col.captainCrew) continue;
      const task = latest.get(col.id);
      if (!shouldPark(task)) continue;
      plans.push({ id: col.id, title: task.title || col.title || '', message: checkpointMessage() });
    }
    return plans;
  }

  // An open instruction is not finished, even when the restored screen still
  // shows the previous idle prompt. That idle prompt was being reported as 已完成.
  function ledgerState(terminalState, alive, task) {
    if (task && task.status === 'paused') return 'paused';
    if (alive && task && ['working', 'queued', 'paused'].includes(task.status) && (terminalState === 'done' || terminalState === 'plain')) return 'working';
    return terminalState || 'plain';
  }

  return {
    isSafetyCheckpoint, isCheckpointClosure, shouldResume, holdsAcrossRestart, shouldPark,
    resumeMessage, checkpointMessage, planResume, planPark, ledgerState,
  };
});
