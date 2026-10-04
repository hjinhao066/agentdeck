// Passive subscription observations only; context percentages are never quotas.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QuotaCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PROVIDERS = ['Claude', 'Codex', 'Cursor', 'Antigravity'];
  const FRESH_MS = 15 * 60_000;
  const EXHAUSTED = /^(?:[│⏺⎿✻✽●!⚠>\s]*)(?:error:\s*)?(?:you['’]?(?:ve| have) hit your (?:(?:usage|session|weekly) )?limit|(?:usage |weekly |session )?limit (?:reached|exceeded)|you['’]?(?:re| are) out of (?:extra )?usage|individual quota reached|(?:request failed[^\n]*?[:：]\s*)?(?:you have )?(?:exceeded your usage limit|usage limit exceeded|quota exhausted)|continuing (?:automatically at|at|shortly).*esc to cancel)\b/i;
  function percent(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null; }
  function resetTime(value, now) {
    if (typeof value === 'number') return value > 1e9 && value < 1e11 ? value * 1000 : null;
    if (typeof value !== 'string') return null;
    const s = value.trim().replace(/^in\s+/i, '');
    if (/^\d{4}-\d\d-\d\dT/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
    const duration = /^(?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+$/i;
    if (duration.test(s)) {
      let ms = 0;
      for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(d\w*|h\w*|m\w*|s\w*)/gi)) ms += Number(m[1]) * ({ d: 86400000, h: 3600000, m: 60000, s: 1000 }[m[2][0].toLowerCase()]);
      return now + ms;
    }
    const clock = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_\/]+)\))?$/i);
    if (clock) {
      let h = Number(clock[1]); const min = Number(clock[2] || 0);
      if (min > 59 || h > (clock[3] ? 12 : 23) || (clock[3] && h < 1)) return null;
      if (clock[3]) h = h % 12 + (/pm/i.test(clock[3]) ? 12 : 0);
      if (clock[4]) {
        try {
          const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: clock[4], year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
          const parts = (t) => Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
          const p = parts(now);
          let target = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, min);
          const resolve = () => {
            let guess = target;
            for (let i = 0; i < 3; i++) {
              const q = parts(guess);
              const shown = Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), Number(q.hour), Number(q.minute));
              guess += target - shown;
            }
            return guess;
          };
          let t = resolve();
          if (t <= now) { target += 86400000; t = resolve(); }
          return t;
        } catch (_) { return null; }
      }
      const d = new Date(now); d.setHours(h, min, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    return null;
  }
  function windowValue(label, used, reset, at) {
    if (percent(used) === null) return null;
    return { label, remaining: Math.round((100 - used) * 10) / 10, exhausted: used === 100, resetAt: resetTime(reset, at), resetText: typeof reset === 'string' ? reset.slice(0, 100) : '' };
  }
  function screen(provider, text, footerRows, at = Date.now()) {
    if (!PROVIDERS.includes(provider)) return null;
    const clean = String(text || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '');
    const lines = clean.split('\n');
    let error = -1, resumed = -1;
    lines.forEach((line, i) => {
      if (EXHAUSTED.test(line)) error = i;
      if (/^[│⏺✻✽●\s]*(?:usage limit reset\b|quota reset\b)/i.test(line)) resumed = i;
    });
    const windows = [];
    const footer = Array.isArray(footerRows) ? footerRows.join('\n') : '';
    // Footers have already been separated from the reply/input by ChatUI.
    // /usage and /status cards are recognized by their own dedicated labels.
    const status = footer || lines.filter((l) => /^\s*[│]*\s*(?:Session\s*:|Weekly\s*:|Current (?:session|week)|5(?:-| )hour limit\s*:|Weekly limit\s*:)/i.test(l)).join('\n');
    if (provider === 'Claude') {
      for (const [label, name] of [['5 小时', 'Session'], ['每周', 'Weekly']]) {
        const re = new RegExp('(?:^|[|│])\\s*' + name + '\\s*:\\s*(\\d+(?:\\.\\d+)?)%', 'gim');
        const matches = [...status.matchAll(re)];
        const m = matches.at(-1);
        if (!m) continue;
        const tail = status.slice(m.index + m[0].length);
        const segment = name === 'Session' ? tail.split(/(?:Weekly|7d)\s*:/i)[0] : tail;
        const r = segment.match(new RegExp('(?:^|[|│\\n])\\s*' + (name === 'Weekly' ? '(?:Weekly\\s+)?' : '') + 'Reset\\s*:\\s*([^|│\\n]+)', 'i'));
        const w = windowValue(label, Number(m[1]), r ? r[1].trim() : null, at);
        if (w) windows.push(w);
      }
      for (const [label, name] of [['5 小时', '5h'], ['每周', '7d']]) {
        const m = footer.match(new RegExp('(?:^|\\s|[|│·])' + name + '\\s+(\\d+(?:\\.\\d+)?)%', 'i'));
        if (m && !windows.some((w) => w.label === label)) windows.push(windowValue(label, Number(m[1]), null, at));
      }
      // Native /usage displays a heading, percentage used, and reset on rows.
      for (const [label, heading] of [['5 小时', 'Current session'], ['每周', 'Current week(?: \\(all models\\))?']]) {
        const m = clean.match(new RegExp('^\\s*[│]*\\s*' + heading + '\\s*\\n([^]*?)(?=\\n\\s*(?:Current |$))', 'im'));
        const p = m && m[1].match(/(\d+(?:\.\d+)?)%\s*used/i);
        const r = m && m[1].match(/Resets?\s+([^\n│]+)/i);
        if (p && !windows.some((w) => w.label === label)) windows.push(windowValue(label, Number(p[1]), r && r[1].trim(), at));
      }
    } else if (provider === 'Codex') {
      for (const line of lines) {
        const m = line.match(/^\s*[│]*\s*(5(?:-| )hour|Weekly) limit:\s*(?:\[[^\]]*\]\s*)?(\d+(?:\.\d+)?)%\s*(left|used)(?:\s*\(resets?\s+([^)]*)\))?/i);
        if (!m) continue;
        const w = windowValue(/^5/.test(m[1]) ? '5 小时' : '每周', m[3].toLowerCase() === 'left' ? 100 - Number(m[2]) : Number(m[2]), m[4], at);
        if (w) windows.push(w);
      }
    }
    const exhausted = error > resumed;
    let reset = '';
    if (exhausted) {
      const m = lines.slice(error, error + 4).join(' ').match(/(?:resets?\s*(?:(?:in|at|:)\s*)?|try again (?:in|at)\s+)([^│\n]+)/i);
      const raw = m ? m[1].trim().replace(/[.)]+$/, '') : '';
      // Only time-shaped text can be retained/displayed from an error line.
      const safe = raw.match(/^(?:\d{4}-\d\d-\d\dT[\d:.+Z-]+|(?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+|\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*\([A-Za-z_\/]+\))?)/i);
      reset = safe ? safe[0].trim().slice(0, 100) : '';
    }
    return { provider, at, source: '会话屏幕', confidence: windows.length || exhausted || resumed >= 0 ? '高（CLI 显示）' : '低（仅未见用尽报错）', windows: windows.filter(Boolean), exhausted, resumed: resumed >= 0 && resumed > error, resetAt: resetTime(reset, at), resetText: reset };
  }
  function cacheClaude(data, at) {
    const windows = [windowValue('5 小时', data.sessionUsage, data.sessionResetAt, at), windowValue('每周', data.weeklyUsage, data.weeklyResetAt, at)].filter(Boolean);
    return windows.length ? { provider: 'Claude', at, source: 'ccstatusline 本地缓存', confidence: '中（第三方缓存）', windows } : null;
  }
  function cacheCodex(event) {
    if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') return null;
    const limits = event.payload.rate_limits;
    if (!limits || (limits.limit_id && limits.limit_id !== 'codex')) return null;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at)) return null;
    const windows = ['primary', 'secondary'].map((key) => {
      const w = limits[key];
      if (!w || ![300, 10080].includes(w.window_minutes)) return null;
      return windowValue(w.window_minutes === 300 ? '5 小时' : '每周', w.used_percent, w.resets_at, at);
    }).filter(Boolean);
    return windows.length ? { provider: 'Codex', at, source: 'Codex 本地 rate_limits', confidence: '高（服务端采样）', windows } : null;
  }
  function cacheAntigravity(data, at) {
    const windows = [];
    for (const [key, label] of [['gemini-5h', 'Gemini 5 小时'], ['gemini-weekly', 'Gemini 每周'], ['3p-5h', '第三方 5 小时'], ['3p-weekly', '第三方每周']]) {
      const w = data.quota?.[key], fraction = w?.remaining_fraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      windows.push(windowValue(label, (1 - fraction) * 100, w.reset_time, at));
    }
    return windows.length ? { provider: 'Antigravity', at, source: 'agy 本地状态行快照', confidence: '中（可选 CLI 调试快照）', windows } : null;
  }
  function observe(store, next, now = Date.now()) {
    if (!next || !PROVIDERS.includes(next.provider) || !Number.isFinite(next.at) || next.at > now + 60000 || now - next.at > FRESH_MS) return false;
    const before = JSON.stringify(store[next.provider] || {});
    const previous = store[next.provider] || {};
    const out = { ...previous };
    // A quota error latches across redraws, session deletion and app restart.
    if (next.exhausted && (!previous.blocked || next.at > previous.blocked.at)) out.blocked = { at: next.at, resetAt: next.resetAt, resetText: next.resetText, source: next.source };
    if (next.resumed && next.at > (out.blocked?.at || 0)) delete out.blocked;
    const zeros = (next.windows || []).filter((w) => w.exhausted);
    if (zeros.length && !out.blocked) out.blocked = {
      at: next.at, resetAt: zeros.every((w) => w.resetAt) ? Math.max(...zeros.map((w) => w.resetAt)) : null,
      resetText: '', source: next.source, numeric: true,
    };
    if (!zeros.length && next.windows?.length && out.blocked?.numeric && next.at > out.blocked.at) delete out.blocked;
    const old = previous.sample;
    const hasNumbers = next.windows?.length > 0;
    if (!old || (next.at >= old.at && (hasNumbers || !old.windows?.length)) ||
      (hasNumbers && next.source === '会话屏幕' && now - old.at < FRESH_MS && old.source !== '会话屏幕') || now - old.at > FRESH_MS) {
      // A fresh screen with numbers wins over a fallback cache until stale.
      if (!(old?.source === '会话屏幕' && old.windows?.length && now - old.at < FRESH_MS && next.source !== '会话屏幕')) out.sample = next;
    }
    store[next.provider] = out;
    return before !== JSON.stringify(out);
  }
  function summary(store, provider, now = Date.now()) {
    const entry = store[provider] || {}, sample = entry.sample;
    const fresh = sample && now - sample.at <= FRESH_MS;
    const windows = fresh ? (sample.windows || []).filter((w) => !w.resetAt || w.resetAt > now) : [];
    const blocked = entry.blocked && (!entry.blocked.resetAt || entry.blocked.resetAt > now) ? entry.blocked : null;
    const remaining = windows.length ? Math.min(...windows.map((w) => w.remaining)) : null;
    const exhausted = !!blocked || windows.some((w) => w.exhausted);
    const state = exhausted ? 'exhausted' : remaining !== null ? (remaining <= 10 ? 'danger' : remaining <= 20 ? 'warning' : 'normal') : fresh && !sample.windows?.length && !entry.blocked ? 'normal' : 'unknown';
    const label = exhausted ? '已用尽' : remaining !== null ? (remaining === 0 ? '<0.1%' : `${remaining}%`) : state === 'normal' ? '正常' : '未知';
    const details = windows.map((w) => `${w.label}剩余 ${w.remaining === 0 && !w.exhausted ? '<0.1' : w.remaining}%；重置 ${w.resetAt ? new Date(w.resetAt).toLocaleString() : w.resetText || '未知'}`);
    if (blocked) details.push(`已用尽；恢复 ${blocked.resetAt ? new Date(blocked.resetAt).toLocaleString() : blocked.resetText || '时间未知'}`);
    if (!windows.length && !blocked) details.push(state === 'normal' ? '未观察到额度用尽；无法取得数字' : '无新鲜额度信息；等待会话/缓存更新');
    const evidence = blocked || sample;
    if (evidence) details.push(`来源：${evidence.source}；${blocked ? (blocked.numeric ? '额度窗口已用尽' : '高（用尽报错）') : sample.confidence}；采样 ${new Date(evidence.at).toLocaleString()}${!fresh && !blocked ? '（已过期）' : ''}`);
    return { provider, state, label, detail: `${provider}：${label}\n${details.join('\n')}` };
  }
  function text(store, now) { return PROVIDERS.map((p) => summary(store, p, now).detail.replace(/\n/g, ' · ')).join('\n'); }
  return { PROVIDERS, FRESH_MS, EXHAUSTED, percent, resetTime, screen, cacheClaude, cacheCodex, cacheAntigravity, observe, summary, text };
});
