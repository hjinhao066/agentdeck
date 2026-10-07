'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const Core = require('./discussion-core');
const { createStore } = require('./discussion-store');

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function owner(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.runner-lock', 'owner.json'), 'utf8')); } catch { return null; }
}
function processIdentity(pid) {
  if (!alive(pid)) return null;
  try {
    let started;
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      started = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } else if (process.platform === 'win32') {
      started = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim();
    } else started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim();
    return started ? { started, boot: Date.now() - os.uptime() * 1000 } : null;
  } catch { return null; }
}
function active(lease, options = {}) {
  if (!lease || !alive(lease.pid)) return false;
  const current = (options.identity || processIdentity)(lease.pid);
  if (lease.started) return !current || current.started === lease.started; // Unverifiable live owners are never stolen.
  // Old releases had only a PID. Verify the actual runner and discussion before
  // preserving a legacy lease; a recycled PID belonging to another app is stale.
  try {
    const command = execFileSync(process.platform === 'win32' ? 'powershell.exe' : 'ps',
      process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${lease.pid}").CommandLine`]
        : ['-p', String(lease.pid), '-o', 'command='], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    return command.includes('discussion-runner.js') && options.dir && command.includes(path.basename(options.dir));
  } catch { return false; }
}
function lock(dir, options = {}) {
  const target = path.join(dir, '.runner-lock');
  const token = crypto.randomUUID(), claim = path.join(dir, '.runner-claim-' + token);
  const identity = (options.identity || processIdentity)(process.pid);
  if (!identity) throw new Error('无法核对执行器的进程启动时间；未派发讨论。');
  const lease = { pid: process.pid, token, ...identity, heartbeatAt: Date.now() };
  fs.mkdirSync(claim, { mode: 0o700 });
  fs.writeFileSync(path.join(claim, 'owner.json'), JSON.stringify(lease), { mode: 0o600 });
  try {
    try { fs.renameSync(claim, target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      const previous = owner(dir);
      if (!previous || active(previous, { ...options, dir })) throw new Error('讨论仍在运行或锁尚未核对；不能再开一个执行器。');
      // Keep a nonempty, deterministic tombstone for the old generation. Two
      // contenders cannot rename a new lease using an old observation (ABA).
      const retired = target + '-retired-' + crypto.createHash('sha256').update(JSON.stringify(previous)).digest('hex').slice(0, 24);
      fs.renameSync(target, retired);
      fs.renameSync(claim, target);
    }
  } finally { fs.rmSync(claim, { recursive: true, force: true }); }
  const pulse = setInterval(() => {
    if (owner(dir)?.token !== token) return;
    const file = path.join(target, 'owner.json'), tmp = file + '.' + token + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify({ ...lease, heartbeatAt: Date.now() }), { mode: 0o600 }); fs.renameSync(tmp, file); } catch {}
  }, 5000); pulse.unref();
  return () => { clearInterval(pulse); if (owner(dir)?.token === token) fs.rmSync(target, { recursive: true }); };
}
function receipt(run, dir) {
  const id = 'dr-' + crypto.createHash('sha256').update(run.id + run.status + run.updatedAt).digest('hex');
  let text;
  if (run.status === 'complete') {
    text = `讨论 ${run.id} 已完成。${run.summary}\n主要分歧：${run.disagreements.join('；') || '未发现尚未解决的实质分歧'}。\n少数派：${run.minority.join('；') || '无独立少数派意见'}。\n忠实性核对：汇总模型自报，未独立验证。\n${path.join(dir, 'final.md')}`;
  } else {
    const blocked = run.jobs.filter((j) => ['failed', 'unknown', 'metadata-needed'].includes(j.status)).map((j) => `${j.id}: ${j.failure}`).join('；');
    text = `讨论 ${run.id} ${run.status === 'cancelled' ? '已取消' : '已暂停'}，已保留 ${run.rounds.length} 个完整轮次。${blocked || run.pauseReason || ''}\n产物：${dir}。用 discuss status 查看，处理原因后 discuss resume 续跑；状态不明的网页请求不会自动重发。`;
  }
  // Long drafts never enter a Captain receipt.
  return { id, text: text.length <= 4000 ? text : text.slice(0, 3000) + `\n完整答案：${path.join(dir, 'final.md')}`, status: run.status };
}
async function deliver(run, dir, auth) {
  const note = receipt(run, dir), file = path.join(dir, 'receipt.json');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (previous?.id === note.id && previous.delivered) return previous;
  fs.writeFileSync(file, JSON.stringify({ ...note, delivered: false }), { mode: 0o600 });
  if (!auth?.controlDir || !auth.token) return note;
  const requestId = crypto.randomUUID();
  const requestFile = path.join(auth.controlDir, 'requests', requestId + '.json');
  const responseFile = path.join(auth.controlDir, 'responses', requestId + '.json');
  try {
    const payload = { id: requestId, action: 'main-discuss-receipt', token: auth.token, receiptId: note.id,
      result: note.text, createdAt: Date.now(), deadline: Date.now() + 5000 };
    const tmp = requestFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 }); fs.renameSync(tmp, requestFile);
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (fs.existsSync(responseFile)) {
        const response = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
        fs.unlinkSync(responseFile);
        if (response.done && !response.error) {
          const accepted = { ...note, delivered: true };
          fs.writeFileSync(file, JSON.stringify(accepted), { mode: 0o600 });
          return accepted;
        }
        break; // Old apps leave the durable receipt for discuss wait/status.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch {} finally { try { fs.unlinkSync(requestFile); } catch {} }
  return note;
}
function adapters(options) {
  const profile = process.env.AGENTDECK_DISCUSS_TEST_PROFILE;
  if (profile && process.env.AGENTDECK_DISCUSS_TEST_DRIVER) {
    const driver = path.resolve(process.env.AGENTDECK_DISCUSS_TEST_DRIVER);
    // Test stand-ins are restricted to a deliberately isolated test profile.
    if (!path.isAbsolute(profile) || !path.basename(profile).startsWith('agentdeck-discuss-test-') ||
        !fs.existsSync(path.join(profile, 'test-profile.json'))) throw new Error('Invalid isolated discussion test profile.');
    return require(driver).createParticipants(options);
  }
  return require('./discussion-participants').createParticipants(options);
}
async function recoverResults(run, adapter, dir, options = {}) {
  for (const job of run.jobs.filter((j) => ['sending', 'unknown', 'failed'].includes(j.status))) {
    try {
      const saved = await adapter.recover?.({ ...job, prompt: job.input }, { runDir: dir, allowForegroundRecovery: options.allowForegroundRecovery === true });
      if (saved) Core.acceptResult(run, job.id, { ...saved, attemptId: job.attemptId, actualTier: saved.actualTier || saved.actualEffort });
    } catch (error) {
      // A durable queued/not-submitted record survives a runner crash. Do not
      // turn affirmative unsent evidence into an unknown send below.
      if (error.mayHaveSent === false || error.answerSaved) Core.failJob(run, job.id, {
        reason: error.code || 'PARTICIPANT_FAILED', uncertain: error.mayHaveSent !== false,
        mayHaveSent: error.mayHaveSent, answerSaved: error.answerSaved,
      });
    } // Unverifiable artifacts remain paused, never resent.
  }
  Core.recover(run);
  return run;
}
async function runDiscussion(options) {
  const store = options.store || createStore({ root: options.root });
  const dir = store.dir(options.id), release = lock(dir);
  const controller = new AbortController();
  let adapter, run, timer, deadlineTimer;
  let expired = false;
  const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    run = store.load(options.id);
    adapter = options.adapter || adapters({ getConfig: () => options.config || {} });
    await recoverResults(run, adapter, dir);
    store.save(run);
    const remaining = options.timeoutMs === undefined ? 60 * 60_000 : options.timeoutMs;
    run.executionDeadline = Date.now() + remaining; store.save(run);
    deadlineTimer = setTimeout(() => { expired = true; controller.abort(); }, remaining);
    timer = setInterval(() => {
      if (run.status !== 'complete' && run.status !== 'cancelled' && fs.existsSync(path.join(dir, 'cancel.request'))) {
        Core.cancel(run); store.save(run); controller.abort();
      }
    }, 200);
    while (run.status === 'running' && !controller.signal.aborted) {
      const jobs = Core.nextJobs(run); store.save(run);
      if (!jobs.length) { if (run.jobs.some((j) => ['failed', 'unknown', 'metadata-needed'].includes(j.status))) run.status = 'paused'; break; }
      // Persist every send intent before entering either CLI or browser path.
      for (const job of jobs) Core.markStarted(run, job.id);
      store.save(run);
      const outcomes = await Promise.allSettled(jobs.map(async (job) => {
        try {
          const work = adapter.execute({ ...job, prompt: job.input }, { runDir: dir, signal: controller.signal,
            onProgress: (value) => { if (controller.signal.aborted) return; job.progress = String(value?.message || value).slice(0, 300); store.save(run); } });
          const result = await Promise.race([work, new Promise((resolve, reject) => {
            const aborted = () => reject(Object.assign(new Error('Execution stopped'), { code: expired ? 'DISCUSSION_TIMEOUT' : 'CANCELLED', mayHaveSent: true }));
            if (controller.signal.aborted) aborted(); else controller.signal.addEventListener('abort', aborted, { once: true });
            work.finally(() => controller.signal.removeEventListener('abort', aborted)).catch(() => {});
          })]);
          Core.acceptResult(run, job.id, { ...result, attemptId: job.attemptId, actualTier: result.actualTier || result.actualEffort });
        } catch (error) {
          Core.failJob(run, job.id, { reason: error.code || 'PARTICIPANT_FAILED',
            uncertain: error.mayHaveSent !== false, mayHaveSent: error.mayHaveSent, answerSaved: error.answerSaved, quota: /QUOTA|RATE_LIMIT/.test(error.code || '') });
        }
        store.save(run);
      }));
      if (outcomes.some((result) => result.status === 'rejected')) throw new Error('Discussion persistence failed; completed provider artifacts were retained.');
    }
    if (controller.signal.aborted && run.status !== 'cancelled') { Core.recover(run); run.status = 'paused'; if (expired) run.pauseReason = 'DISCUSSION_TIMEOUT'; }
    store.save(run);
    if (['complete', 'paused', 'cancelled'].includes(run.status)) await deliver(run, dir, options.auth);
    return run;
  } catch (error) {
    if (run && !['complete', 'cancelled'].includes(run.status)) {
      Core.recover(run);
      run.status = 'paused'; run.pauseReason = 'RUNNER_FAILED';
      run.updatedAt = new Date().toISOString();
      run.events.push({ at: run.updatedAt, action: 'runner-failed' });
      try { store.save(run); await deliver(run, dir, options.auth); } catch {}
    }
    throw error;
  } finally {
    clearInterval(timer); clearTimeout(deadlineTimer); adapter?.dispose?.(); release();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
if (require.main === module) {
  const [root, id, configFile] = process.argv.slice(2);
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
  runDiscussion({ root, id, config, auth: { controlDir: process.env.AGENTDECK_CONTROL_DIR, token: process.env.AGENTDECK_CONTROL_TOKEN } })
    .catch(() => { process.exitCode = 1; }); // No prompts or provider output in logs.
}
module.exports = { runDiscussion, recoverResults, lock, owner, alive, active, processIdentity, receipt, deliver, adapters };
