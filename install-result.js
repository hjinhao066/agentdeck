'use strict';
const fs = require('fs');
const path = require('path');

const MAX_PENDING_MS = 30 * 60 * 1000;
function readResult(file, runtime, now = Date.now()) {
  let r;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return null;
    r = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
  if (!r || !/^[A-Za-z0-9_-]{1,160}$/.test(r.id) || !['pending', 'success', 'failed'].includes(r.status) ||
      typeof r.targetVersion !== 'string' || typeof r.appPath !== 'string' || !path.isAbsolute(r.appPath)) return null;
  // A development instance must never attest to the installed application.
  const expected = path.join(r.appPath, 'Contents', 'MacOS', 'AgentDeck');
  if (path.resolve(runtime.execPath) !== path.resolve(expected)) return null;
  if (r.status === 'pending') {
    const created = typeof r.createdAt === 'number' ? r.createdAt : Date.parse(r.createdAt);
    if (!Number.isFinite(created) || now - created < MAX_PENDING_MS) return null;
    r = { ...r, status: 'failed', reason: '安装超过 30 分钟仍未写出核对结果', activeVersion: runtime.version, running: true };
  }
  if (r.status === 'success' && (r.running !== true || r.activeVersion !== r.targetVersion || runtime.version !== r.targetVersion)) {
    r = { ...r, status: 'failed', reason: '安装结果与现役应用的运行版本不一致', activeVersion: runtime.version };
  }
  return { ...r, activeVersion: runtime.version };
}
function summary(r) {
  return `AgentDeck ${r.operation === 'rollback' ? '回滚' : '安装'} ${r.targetVersion} ${r.status === 'success' ? '成功' : '失败'}；${r.reason || '版本与启动状态已核对'}；现在运行 ${r.activeVersion || '未知版本'}。`;
}

// Separate acknowledgement: never overwrite a result while the installer is
// atomically replacing it. The renderer flushes the task receipt before ack.
function createResultMonitor({ file, runtime, getConfig, deliver, notify }) {
  const ackFile = file + '.ack.json';
  let busy = false;
  return async function poll() {
    if (busy) return;
    busy = true;
    try {
      const r = readResult(file, runtime());
      if (!r) return;
      const config = getConfig();
      const task = config.mainSession?.tasks?.find((t) => t.pendingInstall?.id === r.id || t.installResultId === r.id);
      const captain = config.columns?.find((c) => c.isMain);
      if (!captain || !task && (r.taskId || r.columnId)) return;
      if (task) {
        if (r.taskId && r.taskId !== task.id || r.columnId && r.columnId !== task.colId) return;
        r.taskId = task.id; r.columnId = task.colId;
      }
      let ack = {};
      try { ack = JSON.parse(fs.readFileSync(ackFile, 'utf8')); } catch (_) {}
      if (ack.id !== r.id) ack = { id: r.id };
      const saveAck = () => {
        fs.writeFileSync(ackFile + '.tmp', JSON.stringify(ack), { mode: 0o600 });
        fs.renameSync(ackFile + '.tmp', ackFile);
      };
      const message = summary(r);
      if (!ack.receipt) {
        await deliver({ id: 'install-' + r.id, action: 'main-install-result', callerId: captain.id, installResult: r, result: message });
        ack.receipt = true; saveAck();
      }
      if ((r.status === 'failed' || r.operation === 'rollback') && !r.notificationSent && !ack.notification) {
        ack.notification = await notify({ id: 'install-alert-' + r.id, callerId: captain.id, message, urgent: true });
      }
      saveAck();
    } finally { busy = false; }
  };
}
module.exports = { MAX_PENDING_MS, readResult, summary, createResultMonitor };
