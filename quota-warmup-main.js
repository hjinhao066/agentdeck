'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { seatEnvironment } = require('./claude-seats-main');
const { validId } = require('./security');

const MODEL = 'claude-sonnet-5-5';
const MAX_OUTPUT = 256 * 1024;
const ARGS = ['--print', '--model', MODEL, '--effort', 'low', '--safe-mode', '--no-session-persistence',
  '--tools', '', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
  '--settings', '{"disableAllHooks":true}', '--max-turns', '1',
  '--system-prompt', 'A', '--output-format', 'stream-json', '--verbose', 'A'];
const SUMMARIES = {
  success: 'Sonnet 5.5 预热请求已完成。', quota: '预热请求遇到额度用尽或限流。',
  authentication: '预热请求无法通过席位认证。', timeout: '预热请求超时。',
  aborted: '预热请求已取消。', failed: '预热请求失败。',
  'unverified-model': '预热请求未能确认使用 Sonnet 5.5。',
};

// Only native CLI records count. JSON inside assistant text is model output,
// and a seven-day reset is never evidence for the five-hour quota window.
function parseWarmupOutput(stdout, now = Date.now()) {
  let result, resetAt = null, resetSource = null, rejected = false;
  const reset = (value) => Number.isSafeInteger(value) && value > now / 1000 && value < 100000000000 ? value * 1000 : null;
  for (const line of String(stdout || '').split('\n')) {
    let message;
    try { message = JSON.parse(line); } catch (_) { continue; }
    if (message?.type === 'result') result = message;
    if (message?.type !== 'rate_limit_event') continue;
    const info = message.rate_limit_info;
    if (!['allowed', 'allowed_warning', 'rejected'].includes(info?.status)) continue;
    if (info.status === 'rejected') rejected = true;
    const unifiedReset = reset(info.unifiedWindows?.five_hour?.resetsAt);
    const primaryReset = info.rateLimitType === 'five_hour' ? reset(info.resetsAt) : null;
    if (unifiedReset || primaryReset) {
      resetAt = unifiedReset || primaryReset;
      resetSource = unifiedReset ? 'rate_limit_event.unifiedWindows.five_hour' : 'rate_limit_event.five_hour';
    }
  }
  const models = result?.modelUsage && Object.keys(result.modelUsage);
  const verified = models?.length > 0 && models.every((model) => /^claude-sonnet-5-5(?:-\d{8})?$/.test(model) &&
    Number.isFinite(result.modelUsage[model]?.inputTokens) && Number.isFinite(result.modelUsage[model]?.outputTokens) &&
    result.modelUsage[model].inputTokens >= 0 && result.modelUsage[model].outputTokens >= 0 &&
    result.modelUsage[model].inputTokens + result.modelUsage[model].outputTokens > 0 &&
    (!result.modelUsage[model].provider || result.modelUsage[model].provider === 'firstParty'));
  const status = rejected || result?.api_error_status === 429 ? 'quota'
    : [401, 403].includes(result?.api_error_status) ? 'authentication'
    : result?.subtype === 'success' && result.is_error === false && result.num_turns === 1
      ? verified ? 'success' : 'unverified-model' : 'failed';
  return { ok: status === 'success', status, resetAt, resetSource, provenNative: resetAt !== null,
    model: verified ? models[0] : null, summary: SUMMARIES[status] };
}

function createQuotaWarmupRunner({ home = os.homedir(), env = process.env, execFileImpl = execFile,
  now = Date.now, timeoutMs = 60000, tempRoot = os.tmpdir() } = {}) {
  const jobs = new Set();
  const deadline = Math.max(1, Math.min(60000, Number(timeoutMs) || 60000));
  let disposed = false;
  const safe = (seat, status) => ({ ok: false, status, seatId: validId(seat?.id) ? seat.id : '', at: now(),
    resetAt: null, resetSource: null, provenNative: false, model: null, summary: SUMMARIES[status] });
  function run(seat, { signal } = {}) {
    if (disposed || signal?.aborted) return Promise.resolve(safe(seat, 'aborted'));
    let cwd, childEnv;
    try {
      if (!validId(seat?.id)) throw new Error();
      childEnv = seatEnvironment(env, seat, home);
      for (const key of Object.keys(childEnv)) if (key.startsWith('AGENTDECK_')) delete childEnv[key];
      for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL']) delete childEnv[key];
      childEnv.CLAUDE_CODE_MAX_RETRIES = '0';
      cwd = fs.mkdtempSync(path.join(tempRoot, 'agentdeck-quota-warmup-'));
    } catch (_) { return Promise.resolve(safe(seat, 'failed')); }
    return new Promise((resolve) => {
      let child, finished = false, timer;
      const finish = (value) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); jobs.delete(job);
        try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
        resolve(value);
      };
      const stop = (status) => {
        if (finished) return;
        try { child?.kill('SIGKILL'); } catch (_) {}
        finish(safe(seat, status));
      };
      const abort = () => stop('aborted');
      const job = { abort }; jobs.add(job);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('timeout'), deadline);
      try {
        child = execFileImpl(process.platform === 'win32' ? 'claude.exe' : 'claude', [...ARGS], {
          cwd, env: childEnv, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: MAX_OUTPUT,
          timeout: deadline, killSignal: 'SIGKILL',
        }, (error, stdout) => {
          if (finished) return;
          const parsed = parseWarmupOutput(stdout, now());
          if (error && !['quota', 'authentication'].includes(parsed.status)) finish(safe(seat, 'failed'));
          else finish({ ...parsed, seatId: seat.id, at: now() });
        });
      } catch (_) { finish(safe(seat, 'failed')); }
    });
  }
  function dispose() { disposed = true; for (const job of [...jobs]) job.abort(); }
  return { run, dispose };
}
module.exports = { createQuotaWarmupRunner, parseWarmupOutput, MODEL };
