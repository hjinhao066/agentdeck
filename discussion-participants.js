'use strict';
// Subscription-only adapters. Output and submission evidence stay in the private
// discussion directory; subprocess diagnostics never enter logs or receipts.
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Seats = require('./claude-seats-core');
const SeatMain = require('./claude-seats-main');
const ClaudeQuota = require('./quota-claude');
const { createExecutor, runCli: runWebCli } = require('./chatgpt-web-executor');
const { summary: validateWebReport } = require('./chatgpt-web-core');

const DEADLINE_MS = 30 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
function failure(code, mayHaveSent = false) {
  const reasons = { QUOTA: '订阅额度不足或无法确认可用额度；讨论已暂停，没有换模型。',
    BILLING_UNVERIFIED: '未能从最新官方采样确认 Claude Extra Usage 已关闭；讨论已暂停，防止订阅额度耗尽后按量扣费。',
    AUTH: '无法确认订阅登录；讨论已暂停，未使用按量 API。',
    MODEL_MISMATCH: '实际模型或档位与指定不符；讨论已暂停，没有降级。',
    TIMEOUT: '参与者超时；已保存完成稿，等待定向恢复。',
    CANCELLED: '讨论已取消。', PENDING_REQUEST: '此前请求可能已发送；保留原请求，禁止自动重复发送。',
    REQUEST_CHANGED: '已存档请求与本次材料不一致，不能重用旧结果。',
    FAILED: '参与者未交付可验证答案；讨论已暂停。' };
  return Object.assign(new Error(reasons[code] || reasons.FAILED), { code, mayHaveSent });
}
function childEnvironment(env, seat, home) {
  const clean = seat ? SeatMain.seatEnvironment(env, seat, home) : { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('AGENTDECK_') || /^(?:ANTHROPIC_|OPENAI_|AGY_|GEMINI_|DEEPSEEK_|GOOGLE_API_KEY|GOOGLE_GENAI_|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_|GCLOUD_|AWS_|AZURE_|CLAUDE_API_|CLAUDE_BASE_URL|CLAUDE_CODE_USE_|CLAUDE_CODE_API_|CLAUDE_CODE_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_SECURESTORAGE_|CLAUDE_CODE_HOST_)/.test(key)) delete clean[key];
  }
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ELECTRON_RUN_AS_NODE']) delete clean[key];
  clean.CLAUDE_CODE_MAX_RETRIES = '0';
  return clean;
}
async function writeJson(file, value) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function command(value, fallback) { return Array.isArray(value) && value.length ? value : [fallback]; }
function capture(cmd, args, { env, cwd, input = '', signal, timeoutMs = DEADLINE_MS, outputFile } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('CANCELLED'));
    let text = '', size = 0, timer, child, settled = false, output;
    const finish = (error, code) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (output !== undefined) { try { fsSync.fsyncSync(output); fsSync.closeSync(output); } catch (_) {} output = undefined; }
      if (error) reject(error); else resolve({ text, code });
    };
    const stop = (code) => { child?.kill('SIGKILL'); finish(failure(code, true)); };
    const abort = () => stop('CANCELLED');
    try {
      if (outputFile) output = fsSync.openSync(outputFile, 'wx', 0o600);
      // No shell, inherited stdin, terminal, browser, or foreground window.
      child = spawn(cmd[0], cmd.slice(1).concat(args), { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      child.on('error', () => finish(failure('FAILED')));
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) return stop('FAILED');
        if (settled) return;
        try { if (output !== undefined) fsSync.writeSync(output, chunk); } catch (_) { return stop('FAILED'); }
        text += chunk.toString('utf8');
      });
      child.on('close', (code) => finish(null, code));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (_) { finish(failure('FAILED')); }
  });
}
function parseCli(text, participant) {
  const events = String(text).split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
  const result = events.findLast((event) => event.type === 'result');
  if (events.some((event) => event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') || result?.api_error_status === 429) throw failure('QUOTA', true);
  if ([401, 403].includes(result?.api_error_status)) throw failure('AUTH', true);
  if (!result || result.is_error === true || result.subtype && result.subtype !== 'success' || typeof result.result !== 'string' || !result.result.trim()) throw failure('FAILED', true);
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  let models = result.modelUsage && Object.keys(result.modelUsage);
  if (participant.provider === 'claude') {
    const expected = participant.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + expected + '(?:-\\d{8})?$');
    if (!models?.length || !models.every((model) => {
      const usage = result.modelUsage[model];
      return re.test(model) && (!usage?.provider || usage.provider === 'firstParty') && Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens) && usage.inputTokens >= 0 && usage.outputTokens >= 0 && usage.inputTokens + usage.outputTokens > 0;
    }) || init?.model && !re.test(init.model)) throw failure('MODEL_MISMATCH', true);
    // OAuth sessions can report apiKeySource:none: their subscription identity
    // was verified before spawn, independently of this native model evidence.
    if (init?.apiKeySource && !/^(?:none|oauth|claude[._ -]?ai)$/i.test(init.apiKeySource)) throw failure('AUTH', true);
  } else {
    models ||= [result.model || init?.model].filter(Boolean).map((model) => typeof model === 'string' ? model : model.id);
    const normalized = models.map((model) => String(model).toLowerCase().replace(/[\s()]+/g, '-').replace(/-+$/g, ''));
    if (!normalized.length || normalized.some((model) => model !== participant.model)) throw failure('MODEL_MISMATCH', true);
  }
  const reportedEffort = result.effort || result.model?.effort || init?.effort || init?.effortLevel || init?.model?.effort;
  if (reportedEffort && reportedEffort !== participant.effort) throw failure('MODEL_MISMATCH', true);
  return { text: result.result, actualModel: participant.model, observedModel: models[0], actualEffort: reportedEffort || participant.effort,
    effortEvidence: reportedEffort ? 'runtime' : participant.provider === 'antigravity' ? 'model-id' : 'explicit-cli-flag', auth: 'subscription' };
}
function seatEligibility(usage, info, now = Date.now()) {
  if (!info?.loggedIn) return { available: false, reason: 'AUTH' };
  if (!usage || usage.source !== 'Claude OAuth usage' || !usage.accountKey || usage.accountKey !== info.accountKey ||
      usage.configDir !== info.configDir || !Number.isFinite(usage.at) || usage.at > now + 60_000 || now - usage.at > 5 * 60_000 ||
      usage.extraUsageEnabled !== false) return { available: false, reason: 'BILLING_UNVERIFIED' };
  const remaining = ['fiveHour', 'weekly'].map((key) => usage.windows?.find((window) => window.key === key)?.remaining);
  if (!remaining.every((value) => Number.isFinite(value) && value > 0)) return { available: false, reason: 'QUOTA' };
  return { available: true, remaining: Math.min(...remaining) };
}
async function chooseSeat(config, home, now = Date.now()) {
  const candidates = [];
  let billingUnverified = false;
  for (const seat of Seats.normalize(config.claudeSeats)) {
    const info = await SeatMain.seatInfo(seat, home);
    if (!info.loggedIn) continue;
    const official = await ClaudeQuota.readSeat(seat, home);
    // Local caches do not retain the billing switch and cannot prove that
    // exhaustion would stop rather than consume paid Extra Usage.
    const eligibility = seatEligibility(official, info, now);
    if (eligibility.reason === 'BILLING_UNVERIFIED') billingUnverified = true;
    if (eligibility.available) candidates.push({ ...seat, remaining: eligibility.remaining });
  }
  candidates.sort((a, b) => b.remaining - a.remaining);
  if (!candidates.length) throw failure(billingUnverified ? 'BILLING_UNVERIFIED' : 'QUOTA');
  return candidates[0];
}
function createParticipants(options = {}) {
  const home = options.home || os.homedir(), env = options.env || process.env;
  const cli = command(options.cliCommand, 'claude'), agy = command(options.agyCommand, 'agy');
  async function recover(job, { runDir }) {
    job = normalizeJob(job);
    const dir = jobDirectory(job, runDir);
    const request = await readJson(path.join(dir, 'request.json'));
    if (!request) return null;
    checkRequest(request, job);
    const done = await readJson(path.join(dir, 'result.json'));
    if (done) {
      if (done.actualModel !== job.participant.model || done.actualEffort !== job.participant.effort || done.auth !== 'subscription' || typeof done.text !== 'string' || !done.text.trim()) throw failure('MODEL_MISMATCH', true);
      return done;
    }
    if (job.participant.provider === 'chatgpt-web') {
      const result = await recoverWeb(dir, job.participant);
      if (result) { await saveResult(dir, result); return result; }
    } else {
      try {
        const output = await fs.readFile(path.join(dir, 'response.ndjson'), 'utf8');
        const result = { ...parseCli(output, job.participant), seatId: request.seatId };
        await saveResult(dir, result); return result;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'FAILED') throw error;
      }
    }
    throw failure(request.code || 'PENDING_REQUEST', request.mayHaveSent !== false);
  }
  async function execute(job, context) {
    job = normalizeJob(job);
    const recovered = await recover(job, context);
    if (recovered) return recovered;
    const { participant } = job, { runDir, signal, onProgress = () => {} } = context;
    if (!['claude', 'chatgpt-web', 'antigravity'].includes(participant?.provider)) throw failure('AUTH');
    if (signal?.aborted) throw failure('CANCELLED');
    const dir = jobDirectory(job, runDir);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    let seat, childEnv;
    if (participant.provider === 'claude') {
      const config = options.getConfig ? await options.getConfig() : options.config || {};
      seat = options.selectSeat ? await options.selectSeat(participant, config) : await chooseSeat(config, home);
      if (participant.seatId && participant.seatId !== seat.id) throw failure('QUOTA');
      childEnv = childEnvironment(env, seat, home);
      let auth;
      try { auth = options.authStatus ? await options.authStatus(seat) : JSON.parse((await capture(cli, ['auth', 'status', '--json'], { env: childEnv, cwd: dir, timeoutMs: 15_000 })).text); }
      catch (_) { throw failure('AUTH'); }
      if (!auth?.loggedIn || !/^claude[._ -]?ai$/i.test(auth.authMethod || '') || !/^(?:max|pro|team|enterprise)$/i.test(auth.subscriptionType || '')) throw failure('AUTH');
    } else {
      childEnv = childEnvironment(env, null, home);
      if (participant.provider === 'antigravity') {
        const snapshot = options.agyStatus ? await options.agyStatus() : await readJson(path.join(home, '.gemini', 'antigravity-cli', 'agy_statusline_debug.json'));
        if (snapshot?.product !== 'antigravity' || !/^Google AI (?:Pro|Ultra)$/i.test(snapshot.plan_tier || '')) throw failure('AUTH');
        for (const key of ['gemini-5h', 'gemini-weekly']) {
          if (!(snapshot.quota?.[key]?.remaining_fraction > 0)) throw failure('QUOTA');
        }
      }
    }
    const request = { id: job.id, attemptId: job.attemptId, promptHash: hash(job.prompt), provider: participant.provider,
      model: participant.model, effort: participant.effort, seatId: seat?.id, startedAt: Date.now(), mayHaveSent: true };
    // Exclusive claim is before any send. A crash leaves a conservative hold.
    try { await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify(request), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return recover(job, context); throw error; }
    await fs.writeFile(path.join(dir, 'input.md'), job.prompt, { mode: 0o600 });
    try {
      let result;
      if (participant.provider === 'chatgpt-web') result = await executeWeb(job, dir, signal, onProgress);
      else {
        onProgress({ phase: 'running', message: '等待订阅命令行回答，单次最多 30 分钟。' });
        const args = ['--print', '--model', participant.model, '--output-format', 'stream-json', '--disable-slash-commands'];
        if (participant.provider === 'claude') args.push('--effort', participant.effort, '--safe-mode', '--no-session-persistence', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--verbose');
        else args.push('--mode', 'plan', '--input-format', 'stream-json'); // Never pass agy --effort: it can change the model.
        const response = await capture(participant.provider === 'claude' ? cli : agy, args,
          { env: childEnv, cwd: dir, input: participant.provider === 'claude' ? job.prompt : JSON.stringify({ type: 'user', message: { role: 'user', content: job.prompt } }) + '\n',
            signal, timeoutMs: options.timeoutMs || DEADLINE_MS, outputFile: path.join(dir, 'response.ndjson') });
        result = { ...parseCli(response.text, participant), seatId: seat?.id };
        if (response.code !== 0) throw failure('FAILED', true);
      }
      await saveResult(dir, result);
      return { ...result, files: [path.join(dir, 'result.md')] };
    } catch (error) {
      await writeJson(path.join(dir, 'request.json'), { ...request, code: error.code || 'FAILED', mayHaveSent: error.mayHaveSent !== false });
      throw error;
    }
  }
  async function executeWeb(job, dir, signal, onProgress) {
    if (!/^6\s+Pro$/.test(job.participant.model) || job.participant.effort && job.participant.effort !== 'Pro') throw failure('MODEL_MISMATCH');
    return new Promise((resolve, reject) => {
      let code = '', executor;
      const abort = () => executor.cancel(job.id);
      executor = (options.webExecutorFactory || createExecutor)({ reportsDir: path.join(dir, 'web'),
        stateDir: options.webStateDir || path.join(home, '.agents-state', 'ask-chatgpt-web'), cliPath: options.webCliPath,
        env: childEnvironment(env, null, home), ...(options.cooldownMs !== undefined ? { cooldownMs: options.cooldownMs } : {}),
        runCli: async (input) => { code = await (options.webRunCli || runWebCli)(input); return code; },
        emit: async (event) => {
          if (event.action === 'progress') { onProgress({ phase: event.phase, message: event.message }); return; }
          if (event.action !== 'complete') return;
          signal?.removeEventListener('abort', abort);
          executor.dispose();
          if (event.failed) {
            const safe = ['LOGIN_REQUIRED', 'CDP_UNAVAILABLE', 'COOLDOWN', 'LOCKED', 'TOOL_UNAVAILABLE', 'SENSITIVE_INPUT'].includes(code);
            reject(failure(signal?.aborted ? 'CANCELLED' : code === 'RATE_LIMITED' ? 'QUOTA' : /MODEL|EFFORT/.test(code) ? 'MODEL_MISMATCH' : safe ? 'FAILED' : 'PENDING_REQUEST', !safe));
            return;
          }
          try { resolve(await recoverWeb(dir, job.participant) || Promise.reject(failure('MODEL_MISMATCH', true))); }
          catch (error) { reject(error); }
        } });
      try { executor.submit({ id: job.id, taskId: job.id, task: job.prompt, mode: 'chat' }); }
      catch (error) { executor.dispose(); reject(error); return; }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  return { execute, recover };
}
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function normalizeJob(job) {
  const p = job.participant;
  const provider = p?.provider === 'agy' ? 'antigravity' : p?.provider;
  return { ...job, prompt: job.prompt ?? job.input, participant: { ...p, provider, effort: p?.effort || (provider === 'chatgpt-web' ? 'Pro' : 'high') } };
}
function jobDirectory(job, runDir) {
  if (!path.isAbsolute(runDir) || !/^[a-zA-Z0-9_-]{1,180}$/.test(job.id)) throw failure('FAILED');
  if (job.attemptId && !/^[a-zA-Z0-9_-]{1,180}$/.test(job.attemptId)) throw failure('FAILED');
  return path.join(runDir, 'jobs', job.id, ...(job.attemptId ? [job.attemptId] : []));
}
function checkRequest(request, job) {
  if (request.id !== job.id || request.attemptId !== job.attemptId || request.promptHash !== hash(job.prompt) || request.provider !== job.participant.provider || request.model !== job.participant.model || request.effort !== job.participant.effort) throw failure('REQUEST_CHANGED');
}
async function saveResult(dir, result) {
  await fs.writeFile(path.join(dir, 'result.md'), result.text, { mode: 0o600 });
  await writeJson(path.join(dir, 'result.json'), { ...result, files: [path.join(dir, 'result.md')] });
}
async function recoverWeb(dir, participant) {
  let entries;
  try { entries = await fs.readdir(path.join(dir, 'web'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const report = path.join(dir, 'web', entry.name, 'report.md');
    if (await readJson(report + '.error.json')) continue;
    const meta = await readJson(report + '.meta.json');
    if (!meta) continue;
    const actualModel = String(meta.selectedModel || '').replace(/^GPT[-\s]*/i, '');
    if (actualModel !== participant.model || meta.selectedMode !== 'chat' || meta.selectedEffort && meta.selectedEffort !== 'Pro') throw failure('MODEL_MISMATCH', true);
    let text;
    try { text = await fs.readFile(report, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!text.trim()) continue;
    try { validateWebReport(text); } catch (_) { throw failure('FAILED', true); }
    return { text, actualModel, actualTier: 'Pro', actualEffort: meta.selectedEffort || 'Pro', effortEvidence: 'web-model-selector', auth: 'subscription', report, metadata: report + '.meta.json' };
  }
  return null;
}
module.exports = { createParticipants, chooseSeat, seatEligibility, parseCli, childEnvironment, failure, DEADLINE_MS };
