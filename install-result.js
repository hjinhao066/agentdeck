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
function notificationOutcome(value) {
  if (value === true) return { accepted: true, queued: false, sent: true };
  const queued = value?.queued === true;
  const sent = value?.sent === true || value?.ok === true && !queued && value?.sent !== false;
  return { accepted: value?.accepted === true || queued || sent, queued, sent };
}
function notificationOwnerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function notificationLease(result) {
  if (result.notificationPending !== true) return { busy: false, ownerExited: false };
  const pid = result.notificationOwnerPid;
  if (Number.isInteger(pid) && pid > 0 && pid <= 2147483647) {
    const busy = notificationOwnerAlive(pid);
    return { busy, ownerExited: !busy };
  }
  const finished = typeof result.finishedAt === 'number' ? result.finishedAt : Date.parse(result.finishedAt);
  return { busy: Number.isFinite(finished) && Date.now() - finished < 15000, ownerExited: false };
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
      let ack = {};
      try { ack = JSON.parse(fs.readFileSync(ackFile, 'utf8')); } catch (_) {}
      if (ack.id !== r.id) ack = { id: r.id };
      // The installer leaves its result in place, so this runs every second for as long as
      // this version runs. Once the receipt is in and no alert can be owed, nothing below
      // would change anything: skip the config.json parse and the acknowledgement rewrite.
      if (ack.receipt && (ack.notification || ack.notificationAccepted || ack.notificationQueued || (ack.notificationAttempts || 0) >= 3 ||
          r.notificationPending !== true && (r.status !== 'failed' && r.operation !== 'rollback' || r.notificationAccepted || r.notificationQueued || r.notificationSent))) return;
      const config = getConfig();
      const task = config.mainSession?.tasks?.find((t) => t.pendingInstall?.id === r.id || t.installResultId === r.id);
      const captain = config.columns?.find((c) => c.isMain);
      if (!captain || !task && (r.taskId || r.columnId)) return;
      if (task) {
        if (r.taskId && r.taskId !== task.id || r.columnId && r.columnId !== task.colId) return;
        r.taskId = task.id; r.columnId = task.colId;
      }
      const saveAck = () => {
        fs.writeFileSync(ackFile + '.tmp', JSON.stringify(ack), { mode: 0o600 });
        fs.renameSync(ackFile + '.tmp', ackFile);
      };
      const message = summary(r);
      if (!ack.receipt) {
        await deliver({ id: 'install-' + r.id + '-' + Date.now(), action: 'main-install-result', callerId: captain.id, installResult: r, result: message });
        ack.receipt = true; saveAck();
      }
      // Calendar reads, outbox locks and transport may outlast the legacy 15 s
      // window. Only a definitely exited owner relinquishes a pending attempt.
      let notificationResult = r, lease = notificationLease(r);
      if (lease.ownerExited) {
        // The owner may have written its accepted/sent state while deliver()
        // awaited the receipt. Read only after observing its exit, when that
        // final atomic write is complete; a changed/missing result is not ours.
        const current = readResult(file, runtime());
        if (!current || current.id !== r.id) return;
        notificationResult = current;
        lease = notificationLease(current);
      }
      if (!lease.busy && (notificationResult.status === 'failed' || notificationResult.operation === 'rollback') &&
          !notificationResult.notificationAccepted && !notificationResult.notificationQueued && !notificationResult.notificationSent &&
          !ack.notification && !ack.notificationAccepted && !ack.notificationQueued &&
          (ack.notificationAttempts || 0) < 3 && Date.now() >= (ack.nextNotificationAt || 0)) {
        ack.notificationAttempts = (ack.notificationAttempts || 0) + 1;
        ack.nextNotificationAt = Date.now() + 60000;
        saveAck();
        const outcome = notificationOutcome(await notify({ id: 'install-alert-' + r.id, callerId: captain.id,
          message: summary(notificationResult), urgent: true, dedupeKey: 'install:' + r.id }));
        ack.notification = outcome.accepted;
        ack.notificationAccepted = outcome.accepted;
        ack.notificationQueued = outcome.queued;
        ack.notificationSent = outcome.sent;
      }
      saveAck();
    } finally { busy = false; }
  };
}
module.exports = { MAX_PENDING_MS, readResult, summary, notificationOutcome, createResultMonitor };
