const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { validatePublicTask, summary } = require('./chatgpt-web-core');

const REASONS = Object.freeze({
  LOGIN_REQUIRED: 'ChatGPT 网页未登录；需要用户在专用 Chrome 窗口手动登录。本次未尝试登录。',
  ACCESS_DENIED: 'ChatGPT 网页拒绝访问，登录可能失效或需要人工验证；请用户检查专用窗口。',
  RATE_LIMITED: 'ChatGPT 网页已达额度上限或被限流；本次停止，未自动重发。',
  COOLDOWN: 'ChatGPT 网页仍在冷却中；本次未发送，请冷却结束后再派活。',
  LOCKED: '本机其他请求正在占用 ChatGPT 网页，或留下了未处理的锁；本次未发送，请检查现有请求。',
  PENDING_REQUEST: '上次请求页仍未处理；需要用户确认生成结束并关闭该页，再等 60 秒。未重发。',
  TIMEOUT: '等待 ChatGPT 网页超时，未确认完整报告；已发送的请求页由技能保留，请用户查看，不自动重发。',
  CDP_UNAVAILABLE: '无法连接本机专用 Chrome；请运行 ask-chatgpt-web start-chrome，并由用户确认已登录。',
  CHALLENGE: 'ChatGPT 网页要求人工验证；请用户处理，本次未绕过验证。',
  INTERRUPTED: '网页调研已取消；已发送的请求页由技能保留，不自动重发。',
  TOOL_UNAVAILABLE: '本机 ask-chatgpt-web 技能工具不可用；请检查 ~/.agents/tools/ask-chatgpt-web/cli.mjs 和依赖。',
  SENSITIVE_INPUT: '问题疑似含凭据；技能已阻止发送，请队长只派公开调研。',
  BAD_STATE: '网页技能的本机冷却状态损坏；请人工检查，不自动清理状态。',
});
function failure(code) {
  return REASONS[code] || (/MODEL|EFFORT/.test(code) ? '网页无法核对或使用 6 Pro；本次停止，没有降级模型。'
    : /MODE|RESEARCH|CLARIFICATION/.test(code) ? '网页研究模式或最终报告无法核验；本次停止，没有用普通回答冒充研究。'
      : '网页调研工具未能交付完整报告；请本地查看报告旁的 .error.json，未自动重发。');
}

// No stdout/stderr/page text enters AgentDeck logs, chat, or receipts. Only
// allowlisted error codes cross the existing authenticated receipt channel.
function runCli({ cliPath, question, report, mode, timeout, env, onChild }) {
  return new Promise((resolve) => {
    const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    for (const key of Object.keys(childEnv)) if (key.startsWith('AGENTDECK_')) delete childEnv[key];
    const child = spawn(process.execPath, [cliPath, '--file', question, '--out', report, '--model', '6 Pro', '--mode', mode, '--timeout', String(timeout)],
      { env: childEnv, stdio: 'ignore', windowsHide: true });
    onChild(child);
    child.once('error', () => resolve('TOOL_UNAVAILABLE'));
    child.once('close', async (code) => {
      if (code === 0) { resolve(''); return; }
      try { const diag = JSON.parse(await fs.readFile(`${report}.error.json`, 'utf8')); resolve(typeof diag.code === 'string' ? diag.code : 'TOOL_FAILED'); }
      catch (_) { resolve('TOOL_FAILED'); }
    });
  });
}

function createExecutor(options = {}) {
  const cliPath = options.cliPath || path.join(os.homedir(), '.agents', 'tools', 'ask-chatgpt-web', 'cli.mjs');
  const stateDir = options.stateDir || path.join(os.homedir(), '.agents-state', 'ask-chatgpt-web');
  const reportsDir = options.reportsDir || path.join(os.homedir(), 'reports', 'agentdeck-chatgpt-web');
  const cooldownMs = options.cooldownMs ?? 60000;
  const now = options.now || Date.now;
  const run = options.runCli || runCli;
  const emit = options.emit || (() => {});
  const jobs = new Map(), completed = new Map(), queue = [];
  let active = null, lastFinished = 0, closed = false;

  // phase 'queued': behind another request or the cooldown, nothing sent yet.
  // phase 'running': the skill has this request open in the page.
  function progress(job, message, phase) {
    job.progress = message;
    job.phase = phase;
    emit({ action: 'progress', callerId: job.id, taskId: job.taskId, message, phase });
  }
  function complete(job, result, failed, files = []) {
    const receipt = { action: 'complete', callerId: job.id, taskId: job.taskId, result, ...(failed ? { failed } : {}), files };
    if (jobs.get(job.id) === job) { completed.set(job.id, receipt); jobs.delete(job.id); }
    emit(receipt);
  }
  async function cooldownRemaining() {
    let last = lastFinished;
    try {
      const state = JSON.parse(await fs.readFile(path.join(stateDir, 'cooldown.json'), 'utf8'));
      const value = state.finishedAt ?? state.submittedAt;
      if (!Number.isFinite(value)) throw new Error('BAD_STATE');
      last = Math.max(last, value);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('BAD_STATE'); }
    return Math.max(0, last + cooldownMs - now());
  }
  function wait(job, ms) {
    return new Promise((resolve) => {
      job.wake = () => { clearTimeout(job.timer); resolve(); };
      job.timer = setTimeout(job.wake, ms);
    });
  }
  async function pump() {
    if (active || closed) return;
    const job = queue.shift();
    if (!job) return;
    active = job;
    let attempted = false;
    try {
      const delay = await cooldownRemaining();
      if (delay) { progress(job, `冷却排队：还需等待 ${Math.ceil(delay / 1000)} 秒，尚未打开提问网页。`, 'queued'); await wait(job, delay); }
      if (job.cancelled || closed) throw new Error('INTERRUPTED');
      const dir = path.join(reportsDir, crypto.randomUUID());
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const question = path.join(dir, 'question.md'), report = path.join(dir, 'report.md');
      await fs.writeFile(question, job.task, { mode: 0o600, flag: 'wx' });
      job.task = ''; // keep only the skill's private input file until exit
      progress(job, `等待 ChatGPT 网页：${job.mode === 'deep-research' ? 'Deep Research，最多 60 分钟' : '6 Pro，最多 30 分钟'}；完整报告确认后交回执。`, 'running');
      let code;
      try {
        if (job.cancelled || closed) throw new Error('INTERRUPTED');
        attempted = true;
        code = await run({ cliPath, question, report, mode: job.mode, timeout: job.mode === 'deep-research' ? 60 : 30,
          env: options.env || process.env, onChild: (child) => { job.child = child; if (job.cancelled) child.kill('SIGTERM'); } });
      } finally { await fs.unlink(question).catch(() => {}); }
      if (job.cancelled) code = 'INTERRUPTED';
      if (code) throw new Error(code);
      const meta = JSON.parse(await fs.readFile(`${report}.meta.json`, 'utf8'));
      if (!/^6\s+Pro$/.test(String(meta.selectedModel).replace(/^GPT[-\s]*/i, '')) || meta.selectedMode !== job.mode) throw new Error('MODEL_UNVERIFIABLE');
      complete(job, summary(await fs.readFile(report, 'utf8')), '', [report]);
    } catch (error) {
      const reason = failure(error.message);
      complete(job, reason, reason);
    } finally {
      if (attempted) lastFinished = now();
      active = null;
      void pump();
    }
  }
  function submit(input) {
    if (closed) throw new Error('网页执行器已关闭。');
    validatePublicTask(input.task);
    if (!input.id || !input.taskId || (jobs.has(input.id) && !jobs.get(input.id).cancelled)) throw new Error('这个网页队员已经有任务在排队或执行。');
    const mode = input.mode || 'chat';
    if (!['chat', 'deep-research'].includes(mode)) throw new Error('网页模式只能是 chat 或 deep-research。');
    const job = { id: input.id, taskId: input.taskId, mode, task: input.task };
    completed.delete(job.id); jobs.set(job.id, job); queue.push(job);
    queueMicrotask(() => { if (jobs.get(job.id) !== job) return; progress(job, '排队等待 ChatGPT 网页：本机一次只做一个请求。', 'queued'); void pump(); });
    return { accepted: true };
  }
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.cancelled = true;
    if (job === active) { job.wake?.(); job.child?.kill('SIGTERM'); }
    else { queue.splice(queue.indexOf(job), 1); complete(job, failure('INTERRUPTED'), failure('INTERRUPTED')); }
    return true;
  }
  function status(id) { const job = jobs.get(id); return job ? { active: true, taskId: job.taskId, progress: job.progress, phase: job.phase || 'queued' } : { active: false, receipt: completed.get(id) }; }
  function dispose() { closed = true; for (const id of jobs.keys()) cancel(id); }
  return { submit, cancel, status, dispose };
}
module.exports = { createExecutor, runCli, failure };
