// Passive subscription observations only; context percentages are never quotas.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QuotaCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PROVIDERS = ['Claude', 'Codex', 'Cursor', 'Antigravity'];
  const FRESH_MS = 15 * 60_000;
  const CLAUDE_OAUTH_SOURCE = 'Claude OAuth usage';
  const freshMs = (sample) => sample?.source === CLAUDE_OAUTH_SOURCE ? 30 * 60_000 : FRESH_MS;
  // An official sample with a 5-hour window and every window above 0% proves the account still has room.
  const officialRoom = (sample) => !!sample?.official && !!sample.windows?.some((w) => w.key === 'fiveHour') && sample.windows.every((w) => w.remaining > 0 && !w.exhausted);
  const SCOPES = { Claude: 'claude', Codex: 'codex', Cursor: 'grok-4.7', Antigravity: 'gemini' };
  const NAMES = { Claude: 'Claude', Codex: 'Codex / ChatGPT', Cursor: 'Cursor / Grok 4.7', Antigravity: 'Antigravity / Gemini' };
  function claudeSeats(value) {
    const ids = new Set();
    const seats = (Array.isArray(value) ? value : []).slice(0, 8).filter((s) => {
      if (!s || !/^[a-zA-Z0-9_-]{1,40}$/.test(s.id) || ids.has(s.id) || typeof s.configDir !== 'string' || !s.configDir.trim() || /[\x00-\x1f]/.test(s.configDir)) return false;
      ids.add(s.id); return true;
    }).map((s) => {
      const flag = { us: '🇺🇸', cn: '🇨🇳' }[s.id];
      const name = String(s.name || (flag ? s.id.toUpperCase() : s.id)).slice(0, 80);
      return { id: s.id, name: flag && !name.includes(flag) ? `${flag} ${name}` : name, configDir: s.configDir.trim() };
    });
    return seats.length ? seats : [{ id: 'default', name: 'Claude', configDir: '~/.claude' }];
  }
  function seatKey(id) { return id && id !== 'default' ? `Claude:${id}` : 'Claude'; }
  function seatForColumn(column, seats) {
    if (!column) return null;
    if (column.claudeSeatId) return seats.find((s) => s.id === column.claudeSeatId && (!column.claudeConfigDir || s.configDir === column.claudeConfigDir)) || null;
    const dir = column.claudeConfigDir || String(column.cmd || '').match(/CLAUDE_CONFIG_DIR\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/)?.slice(1).find(Boolean);
    if (dir) return seats.find((s) => s.configDir === dir) || null;
    return seats.find((s) => s.configDir === '~/.claude') || null;
  }
  function items(seats) { return [...claudeSeats(seats).map((seat) => ({ provider: 'Claude', seat, key: seatKey(seat.id) })), ...PROVIDERS.slice(1).map((provider) => ({ provider, key: provider }))]; }
  function modelScope(provider, model) {
    if (provider === 'Antigravity') return /^gemini(?:[- ]|$)/i.test(model || '') ? 'gemini' : null;
    if (provider === 'Cursor') return /^grok[- ]4[.-]7(?:[- ]|$)/i.test(model || '') ? 'grok-4.7' : null;
    return SCOPES[provider];
  }
  function modelName(value) {
    return typeof value === 'string' && /^(?:gemini|grok|gpt|claude|opus|sonnet)[- .\d\w()]{0,80}$/i.test(value) ? value : '';
  }
  // Native resource errors of every CLI are recognized here and nowhere else.
  // A line counts only when it starts with the CLI's own phrase and the phrase
  // ends there: end of line, a TUI separator (· ∙ •) followed by the CLI's own
  // reset time / login / slash-command segment, or punctuation followed by the
  // CLI's own reset/retry/login sentence. A topic prefix such as "Rate limit
  // handling test fails", code, grep output, or a reply that quotes the full
  // message and then keeps talking ("… · limit resets 3:10pm 的识别已补测试")
  // stays ordinary.
  const WHEN = String.raw`(?:at|in|on|after|about|tomorrow|today|later|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|utc|gmt|[ecmp][sd]t|\d{1,4}(?:[:\/-]\d{1,2}){0,2}(?:st|nd|rd|th)?\s?(?:[ap]\.?m\.?)?|\d+(?:\.\d+)?\s?(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)|\([a-z_\/+:\d -]*\)?)`;
  const RESET = String.raw`(?:limit |your (?:limit|quota) (?:will )?)?resets?(?:[\s,]+${WHEN})*(?:\s+[\x21-\x7e]+)?[.!]?`; // one unreadable trailing token is still the CLI's reset value
  const LOGIN = String.raw`(?:please )?run ['"\x60]?(?:\/login|[\w-]+ login)['"\x60]?`;
  const REST = String.raw`[\x20-\x7e’…]*`; // the CLI's own sentence is plain ASCII; narration in another script is not
  const SEP = String.raw`(?:\s*[·∙•]\s*(?:${RESET}|${LOGIN}[.!]?|(?:please )?(?:log|sign) in(?: again)?[.!]?|(?:please )?try again(?:[\s,]+${WHEN})*[.!]?|\/[a-z-]+(?: to [a-z' \/-]+)?[.!]?))+`;
  const tail = (hints) => String.raw`(?:[.!]?|${SEP}|\s*[.!,:;—–-]\s*['"\x60]?(?:${RESET}|(?:${hints})(?!\w)${REST}))`;
  const QUOTA_HINT = String.raw`(?:please )?try again|(?:please )?wait|to continue|to get more|upgrade (?:to|your)|visit https?:\/\/\S+|purchase|switch to|contact|\/[a-z-]+`;
  const RATE_HINT = QUOTA_HINT + '|retry(?:ing)?';
  const AUTH_HINT = String.raw`${LOGIN}(?=$|[.!,]| first| again| to )|please (?:log|sign) in|(?:log|sign) in (?:again|to|with)|to continue|visit https?:\/\/\S+|\/login`;
  // Second-person messages are unambiguous; "for/on <model>" may sit before the ending.
  const QUOTA_OWN = String.raw`(?:you['’]?(?:ve| have) (?:hit|reached|exceeded|exhausted|used up) your (?:[\w-]+ ){0,3}(?:limit|quota|capacity|usage)|you['’]?(?:re| are) out of (?:extra )?(?:usage|credits)|(?:your )?credit balance is too low)(?:\s+(?:for|on)\s[\w .()-]{1,40}?)?(?:${tail(QUOTA_HINT)}|\|\d{9,})`;
  const QUOTA_TOPIC = String.raw`(?:request failed[^\n]*?[:：]\s*)?(?:(?:claude (?:ai )?)?(?:usage|weekly|session|daily|monthly|5[- ]hour|opus|sonnet)(?: weekly)? limit (?:reached|exceeded)|usage limit exceeded|exceeded your usage limit|individual quota reached|quota (?:exhausted|exceeded))(?:${tail(QUOTA_HINT)}|\|\d{9,}|\s+for (?:quota )?(?:metric|model)\b[^\n]*)`;
  const EXHAUSTED = new RegExp(String.raw`^(?:${QUOTA_OWN}|${QUOTA_TOPIC}|RESOURCE_EXHAUSTED(?:\s*:\s*[^\n]+|[.!]?)|429\s+\{[^\n]*"status"\s*:\s*"RESOURCE_EXHAUSTED"[^\n]*\}|continuing (?:automatically at|at|shortly)[^\n]*esc to cancel|额度用尽|配额(?:用尽|耗尽))$`, 'i');
  const RATE_LIMITED = new RegExp(String.raw`^(?:(?:429\s+)?rate_limit_error(?:\s*:\s*[^\n]+|[.!]?)|429\s+\{[^\n]*"type"\s*:\s*"rate_limit_error"[^\n]*\}|(?:429\s+)?too many requests(?:\s*:\s*[^\n]+|${tail(RATE_HINT)})|rate[ -]limit(?: reached| exceeded|ed)${tail(RATE_HINT)}|(?:stream error:\s*)?exceeded retry limit, last status: 429[^\n]*|请求被限流|被限流)$`, 'i');
  const AUTH = new RegExp(String.raw`^(?:401\s+Unauthorized(?:[.!]?|\s*:\s*[^\n]+)|401\s+\{[^\n]*"type"\s*:\s*"authentication_error"[^\n]*\}|authentication_error(?:\s*:\s*[^\n]+|[.!]?)|(?:(?:you['’]?(?:re| are) )?not (?:logged|signed) in|authentication required|login required)${tail(AUTH_HINT)}|authentication failed(?:\s*:\s*${REST}|${tail(AUTH_HINT)})|(?:invalid api key|oauth token (?:has )?(?:been )?(?:expired|revoked))(?:${SEP}|\s*[.!,:;—–-]\s*(?:${AUTH_HINT})(?!\w)${REST})|please (?:(?:log|sign) in|login)(?:[.!]?|${SEP}|\s*[.!,:;—–-]\s*(?:${AUTH_HINT})(?!\w)${REST}|\s+(?:to|again|with|using|first|by|via)\s${REST})|${LOGIN}(?=$|[.!,]| first| again| to )${REST}|未登录|尚未登录|请先登录)$`, 'i');
  function resourceError(raw) {
    // Leading glyphs of each TUI: Claude ⏺ ⎿ ✻ ✽ ✳ ✶ ✢ ✺, Codex • ■ ⚠ ✗ ✘, Cursor ● ◦ ◆ ⬢, agy/Gemini ✦ ✕ ✖ ℹ.
    const line = String(raw || '').trim().replace(/^[│┃⏺⎿✻✽✳✶✢✺●•◦◆▪⬢✦■✗✘✖✕×▲!⚠ℹ️>\s]+/, '').replace(/\s*[│┃]$/, '')
      .replace(/^\[?(?:API |request )?error:\s*/i, '').replace(/\]$/, '');
    if (EXHAUSTED.test(line)) return 'quota';
    if (RATE_LIMITED.test(line)) return 'rate_limit';
    if (AUTH.test(line)) return 'auth';
    return '';
  }
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
    const dateClock = s.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (dateClock) {
      const [, month, day, hour, minute] = dateClock.map(Number);
      const d = new Date(now); d.setMonth(month - 1, 1); d.setDate(day); d.setHours(hour, minute, 0, 0);
      if (month < 1 || month > 12 || d.getMonth() !== month - 1 || d.getDate() !== day || hour > 23 || minute > 59) return null;
      if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
      return d.getTime();
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
    return { key: label === '5 小时' ? 'fiveHour' : label === '每周' ? 'weekly' : label, label, used, remaining: Math.round((100 - used) * 10) / 10, exhausted: used === 100, resetAt: resetTime(reset, at), resetText: typeof reset === 'string' ? reset.slice(0, 100) : '' };
  }
  function screen(provider, text, footerRows, at = Date.now(), model = '') {
    if (!PROVIDERS.includes(provider)) return null;
    const scope = modelScope(provider, model);
    if (!scope) return null; // Other-model errors cannot mark the selected pool exhausted.
    const clean = String(text || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '');
    const lines = clean.split('\n');
    let error = -1, resumed = -1;
    lines.forEach((line, i) => {
      if (['quota', 'rate_limit'].includes(resourceError(line))) error = i;
      if (/^[│⏺✻✽●\s]*(?:usage limit reset\b|quota reset\b)/i.test(line)) resumed = i;
      // A model switch below an old error means that error belongs to the
      // previous model, even if it remains visible in the screen history.
      if ((provider === 'Cursor' || provider === 'Antigravity') && /^\s*[│>❯●*]*\s*(?:model changed to|switched to model|switched model to)\s+/i.test(line)) error = -1;
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
        const m = footer.match(new RegExp('(?:^|\\s|[|│·])' + name + '\\s*(?:(剩余|剩|remaining|left|used|已用)\\s*)?(\\d+(?:\\.\\d+)?)%(?:\\s*(remaining|left|used|已用))?(?:\\s*↻\\s*([^|│·\\n]+))?', 'i'));
        if (!m || /used|已用/i.test(m[1] || m[3] || '') || windows.some((w) => w.label === label)) continue;
        const w = windowValue(label, 100 - Number(m[2]), m[4]?.trim(), at);
        if (w) windows.push(w);
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
      const raw = m ? m[1].trim().replace(/\.+$/, '') : '';
      // Only time-shaped text can be retained/displayed from an error line.
      const safe = raw.match(/^(?:\d{4}-\d\d-\d\dT[\d:.+Z-]+|(?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+|\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*\([A-Za-z_\/]+\))?)/i);
      reset = safe ? safe[0].trim().slice(0, 100) : '';
    }
    return { provider, scope, model: modelName(model), at, source: '会话屏幕', confidence: windows.length || exhausted || resumed >= 0 ? '高（CLI 显示）' : '低（仅未见用尽报错）', windows: windows.filter(Boolean), exhausted, resumed: resumed >= 0 && resumed > error, resetAt: resetTime(reset, at), resetText: reset };
  }
  function cacheClaude(data, at) {
    const native = data.rate_limits || data;
    const windows = Array.isArray(data.windows) ? data.windows.slice(0, 2).map((w) => ['fiveHour', 'weekly'].includes(w?.key) && percent(w.remaining) !== null ? windowValue(w.key === 'fiveHour' ? '5 小时' : '每周', 100 - w.remaining, w.resetText, at) : null).filter(Boolean)
      : [windowValue('5 小时', data.sessionUsage ?? native.five_hour?.utilization ?? native.five_hour?.used_percentage, data.sessionResetAt ?? native.five_hour?.resets_at, at), windowValue('每周', data.weeklyUsage ?? native.seven_day?.utilization ?? native.seven_day?.used_percentage, data.weeklyResetAt ?? native.seven_day?.resets_at, at)].filter(Boolean);
    const oauth = data.source === CLAUDE_OAUTH_SOURCE;
    return windows.length || oauth ? { provider: 'Claude', scope: 'claude', at, official: oauth, source: oauth ? CLAUDE_OAUTH_SOURCE : 'ccstatusline 本地缓存', confidence: oauth ? windows.length ? '高（服务端采样）' : '未知（刷新未取得数据）' : '中（第三方缓存）', windows } : null;
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
    return windows.length ? { provider: 'Codex', scope: 'codex', at, source: 'Codex 本地 rate_limits', confidence: '高（服务端采样）', windows } : null;
  }
  function codexServer(result, at) {
    const limits = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
    if (!limits || (limits.limitId && limits.limitId !== 'codex')) return null;
    const q = cacheCodex({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'token_count', rate_limits: {
      limit_id: limits.limitId,
      ...Object.fromEntries(['primary', 'secondary'].map((k) => [k, limits[k] && { used_percent: limits[k].usedPercent, window_minutes: limits[k].windowDurationMins, resets_at: limits[k].resetsAt }])),
    } } });
    return q && { ...q, source: 'Codex 官方 account/rateLimits/read', note: !q.windows.some((w) => w.label === '5 小时') ? '5 小时：服务端未提供，无法取得数字' : '' };
  }
  function cacheAntigravity(data, at) {
    const windows = [];
    for (const [key, label] of [['gemini-5h', 'Gemini 5 小时'], ['gemini-weekly', 'Gemini 每周']]) {
      const w = data.quota?.[key], fraction = w?.remaining_fraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      windows.push(windowValue(label, (1 - fraction) * 100, w.reset_time, at));
    }
    const model = typeof data.model === 'string' ? data.model : data.model?.id;
    return windows.length ? { provider: 'Antigravity', scope: 'gemini', model: modelScope('Antigravity', model) ? modelName(model) : 'Gemini（共享分组）', at, source: 'agy 本地状态行快照', confidence: '中（可选 CLI 调试快照）', windows } : null;
  }
  function observe(store, next, now = Date.now()) {
    if (!next || !PROVIDERS.includes(next.provider) || !Number.isFinite(next.at) || next.at > now + 60000 || (!next.official && !next.failureOnly && now - next.at > freshMs(next))) return false;
    if (next.scope !== SCOPES[next.provider]) return false;
    if (next.provider === 'Claude' && next.source === CLAUDE_OAUTH_SOURCE &&
      (!next.accountBound || !next.accountKey || !next.configDir || !next.windows?.length)) return false;
    if (next.provider === 'Claude' && next.seatId && next.seatId !== 'default' && !next.accountBound && !next.official) next = { ...next, windows: [] };
    const key = next.provider === 'Claude' ? seatKey(next.seatId) : next.provider;
    const before = JSON.stringify(store[key] || {});
    let previous = store[key] || {};
    const identityChanged = (next.accountKey && previous.accountKey && next.accountKey !== previous.accountKey && next.legacyAccountKey !== previous.accountKey) ||
      (next.configDir && previous.configDir && next.configDir !== previous.configDir);
    const officialNotBefore = Math.max(previous.officialNotBefore || 0, identityChanged ? next.at : 0);
    if (next.official && next.at < officialNotBefore) return false;
    if (next.provider === 'Claude' && next.source === CLAUDE_OAUTH_SOURCE &&
      ((previous.accountKey && next.accountKey !== previous.accountKey && next.legacyAccountKey !== previous.accountKey) ||
       (previous.configDir && next.configDir !== previous.configDir))) return false;
    // Drop the old provider-wide latches: their model/account was not recorded.
    if (previous.scope !== next.scope || (next.accountKey && previous.accountKey && next.accountKey !== previous.accountKey && next.legacyAccountKey !== previous.accountKey) || (next.configDir && previous.configDir && next.configDir !== previous.configDir)) previous = {};
    if (next.provider === 'Claude' && next.seatId && next.seatId !== 'default' && previous.sample && !previous.sample.accountBound && !previous.sample.official) {

      previous = { ...previous, sample: { ...previous.sample, windows: [] } };
      if (previous.blocked?.numeric) delete previous.blocked;
    }
    const out = { ...previous };
    if (out.blocked?.resetAt && out.blocked.resetAt <= Math.max(now, next.at)) delete out.blocked; // past its reset time
    if (officialNotBefore) out.officialNotBefore = officialNotBefore;

    out.scope = next.scope;
    for (const key of ['account', 'accountKey', 'credentialKey', 'model', 'configDir']) if (next[key]) out[key] = next[key];
    if (next.accountKey && next.legacyAccountKey === previous.accountKey && out.blocked && !out.blocked.numeric && out.blocked.accountKey === previous.accountKey) {
      out.blocked = { ...out.blocked, accountKey: next.accountKey };
    }
    if (next.accountKey && next.legacyAccountKey === previous.accountKey && out.resumed && out.resumed.accountKey === previous.accountKey) out.resumed = { ...out.resumed, accountKey: next.accountKey };
    if (next.identityOnly) {
      store[key] = out;
      return before !== JSON.stringify(out);
    }
    if (next.failureOnly) {
      out.officialStatus = { failures: next.failures, checkedAt: next.checkedAt, failure: next.failure };
      store[key] = out;
      return before !== JSON.stringify(out);
    }
    if (next.official) {
      out.officialStatus = { failures: 0, checkedAt: next.at };
      // A newer official sample with room outranks an older screen error.
      if (out.blocked && next.at > out.blocked.at && officialRoom(next)) delete out.blocked;
      if (out.blocked && !out.blocked.resetAt) {
        const resets = next.windows.filter((w) => w.resetAt > now && (w.exhausted || w.key === 'fiveHour')).map((w) => w.resetAt);
        if (resets.length) out.blocked = { ...out.blocked, resetAt: Math.max(...resets) };
      }
    }
    // Failed queries never grant screen/cache numbers authority over the last
    // successful official sample. Still retain genuine CLI exhaustion errors.
    if (previous.sample?.official && !next.official) {
      if (next.exhausted) {
        const resets = previous.sample.windows.filter((w) => w.resetAt > now && (w.exhausted || w.key === 'fiveHour')).map((w) => w.resetAt);
        out.blocked = { at: next.at, resetAt: next.resetAt || (resets.length ? Math.max(...resets) : null), resetText: next.resetText, source: next.source, sourceColumnId: next.sourceColumnId, accountKey: out.accountKey, configDir: out.configDir };
      }
      if (next.resumed && next.at > (out.blocked?.at || 0) && next.at > (out.resumed?.at || 0)) {
        delete out.blocked;
        out.resumed = { at: next.at, sourceColumnId: next.sourceColumnId, accountKey: out.accountKey, configDir: out.configDir, source: next.source, accountBound: next.accountBound === true };
      }
      store[key] = out;
      return before !== JSON.stringify(out);
    }
    // Non-official observations cannot clear a CLI exhaustion latch. Older
    // observations cannot override a newer server sample or quota error.
    if (next.provider === 'Claude' && next.source === CLAUDE_OAUTH_SOURCE &&
      (next.at < (previous.sample?.at || 0) || next.at < (previous.blocked?.at || 0))) return false;
    if (previous.sample?.source === CLAUDE_OAUTH_SOURCE && now - previous.sample.at <= freshMs(previous.sample) &&
      next.at <= previous.sample.at) return false;
    // A quota error latches across redraws, session deletion and app restart.
    if (next.exhausted && (!previous.blocked || next.at > previous.blocked.at)) out.blocked = { at: next.at, resetAt: next.resetAt, resetText: next.resetText, source: next.source,
      sourceColumnId: next.sourceColumnId, accountKey: out.accountKey, configDir: out.configDir };
    if (next.resumed && next.at > (out.blocked?.at || 0) && next.at > (out.resumed?.at || 0)) {
      delete out.blocked;
      // Keep explicit recovery even when an older numeric sample wins below.
      out.resumed = { at: next.at, sourceColumnId: next.sourceColumnId, accountKey: out.accountKey, configDir: out.configDir, source: next.source, accountBound: next.accountBound === true };
    }

    const zeros = (next.windows || []).filter((w) => w.exhausted);
    if (zeros.length && !out.blocked) out.blocked = {
      at: next.at, resetAt: zeros.every((w) => w.resetAt) ? Math.max(...zeros.map((w) => w.resetAt)) : null,
      resetText: '', source: next.source, sourceColumnId: next.sourceColumnId, accountKey: out.accountKey, configDir: out.configDir, accountBound: next.accountBound === true, numeric: true,
    };
    if (!zeros.length && next.windows?.length && out.blocked?.numeric && next.at > out.blocked.at) delete out.blocked;
    const old = previous.sample;
    const hasNumbers = next.windows?.length > 0;
    if (next.official || !old || (hasNumbers && !old.windows?.length) || (next.at >= old.at && (hasNumbers || !old.windows?.length)) ||
      (hasNumbers && next.source === '会话屏幕' && now - old.at < FRESH_MS && old.source !== '会话屏幕') || now - old.at > FRESH_MS) {
      // A fresh screen with numbers wins over a fallback cache until stale.
      if (next.official || !(old?.source === '会话屏幕' && old.windows?.length && now - old.at < FRESH_MS && next.source !== '会话屏幕')) out.sample = next;
    }
    store[key] = out;
    return before !== JSON.stringify(out);
  }
  function summary(store, provider, now = Date.now(), seat = null, captainSeatId = null) {
    const saved = store[seat ? seatKey(seat.id) : provider] || {};
    const entry = saved.scope === SCOPES[provider] && (!seat || !saved.configDir || saved.configDir === seat.configDir) ? saved : {}, sample = entry.sample;
    const trusted = !seat || seat.id === 'default' || (sample?.accountBound && sample.accountKey && sample.accountKey === entry.accountKey && sample.configDir === seat.configDir && sample.at >= (entry.officialNotBefore || 0)) ||
      (sample?.official && sample.seatId === seat.id && sample.credentialKey && sample.credentialKey === entry.credentialKey &&
        sample.configDir === seat.configDir && sample.at >= (entry.officialNotBefore || 0));
    const fresh = sample && trusted && now - sample.at <= freshMs(sample);
    const retained = trusted && !!sample?.official;
    const stale = retained && (!fresh || entry.officialStatus?.failures >= 3 || sample.windows?.some((w) => w.resetAt && w.resetAt <= now));
    const windows = retained ? sample.windows || [] : fresh ? (sample.windows || []).filter((w) => !w.resetAt || w.resetAt > now) : [];

    const blocked = entry.blocked && (!entry.blocked.numeric || trusted) && (!entry.blocked.resetAt || entry.blocked.resetAt > now) &&
      !(retained && sample.at > entry.blocked.at && officialRoom(sample)) ? entry.blocked : null;
    const remaining = windows.length ? Math.min(...windows.map((w) => w.remaining)) : null;
    const exhausted = !!blocked || windows.some((w) => w.exhausted && (!w.resetAt || w.resetAt > now));
    const state = exhausted ? 'exhausted' : remaining !== null ? (remaining <= 10 ? 'danger' : remaining <= 20 ? 'warning' : 'normal') : provider !== 'Claude' && fresh && !sample.windows?.length && !entry.blocked ? 'normal' : 'unknown';
    const label = exhausted ? '已用尽' : remaining !== null ? (remaining === 0 ? '<0.1%' : `${remaining}%`) : provider === 'Claude' ? '未知' : state === 'normal' ? '正常' : '未知';
    const clock = (t, weekly = false) => {
      const d = new Date(t), pad = (v) => String(v).padStart(2, '0');
      return `${weekly ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const recovery = blocked?.resetAt || Math.max(0, ...windows.filter((w) => w.exhausted && w.resetAt > now).map((w) => w.resetAt));
    const claudeWindow = (w, showBlock = true) => {
      const isWeekly = w.label === '每周';
      const isBlocked = showBlock && (w.exhausted && w.resetAt > now || !isWeekly && !!blocked && !windows.some((v) => v.exhausted && v.label === '每周'));
      const reset = showBlock && !isWeekly && blocked ? recovery || w.resetAt : w.resetAt;
      return `${isWeekly ? '7d' : '5h'} ${isBlocked ? '已用尽' : w.remaining === 0 && !w.exhausted ? '<0.1%' : `${w.remaining}%`} ↻${reset ? clock(reset, isWeekly) : w.resetText || '未知'}`;
    };
    const details = windows.map((w) => provider === 'Claude' ? claudeWindow(w) : `${w.label}剩余 ${w.remaining === 0 && !w.exhausted ? '<0.1' : w.remaining}%；重置 ${w.resetAt ? new Date(w.resetAt).toLocaleString() : w.resetText || '未知'}`);
    details.unshift(`模型：${entry.model || ({ Claude: 'Claude（账号共享额度）', Codex: 'Codex（账号共享额度）', Cursor: 'Grok 4.7', Antigravity: 'Gemini（共享分组）' }[provider])}；账号：${entry.account || (seat ? '未识别（此席位）' : '未识别（本机当前登录）')}`);
    if (seat) details.unshift(`席位：${seat.name}（${seat.id}）${seat.id === captainSeatId ? '；当前队长使用此席位' : ''}；配置目录：${seat.configDir}`);
    if (provider === 'Claude') for (const [name, short] of [['5 小时', '5h'], ['每周', '7d']]) if (!windows.some((w) => w.label === name)) details.push(`${short} 无数据 ↻未知`);

    if (provider === 'Cursor') details.push('仅统计 Grok 4.7；Cursor Models 池百分比暂不可可靠取得');
    if (provider === 'Antigravity') details.push('仅统计 Gemini 分组；不含 agy Claude / 第三方额度');
    if (sample?.note) details.push(sample.note);
    if (provider === 'Codex' && !windows.some((w) => w.label === '5 小时') && !sample?.note) details.push('5 小时：无新鲜数字');
    if (blocked) details.push(provider === 'Claude' ? `已用尽 ↻${recovery ? clock(recovery, recovery - now > 86400000) : blocked.resetText || '未知'}` : `已用尽；恢复 ${blocked.resetAt ? new Date(blocked.resetAt).toLocaleString() : blocked.resetText || '时间未知'}`);
    if (provider === 'Claude' && blocked && windows.length) details.push(`上次采样：${windows.map((w) => claudeWindow(w, false)).join(' · ')}；采样 ${new Date(sample.at).toLocaleString()}`);
    if (blocked?.sourceColumnId) details.push(`报错会话：${blocked.sourceColumnId}`);

    if (!windows.length && !blocked) details.push(state === 'normal' ? '未观察到额度用尽；无法取得数字' : '无新鲜额度信息；等待会话/缓存更新');
    if (entry.officialStatus?.failure) details.push(`查询失败：${entry.officialStatus.failure}；连续 ${entry.officialStatus.failures} 次${entry.officialStatus.failures >= 3 ? '，保留上次成功采样（数据已旧）' : '，保留上次数字'}`);
    if (retained && windows.some((w) => w.resetAt <= now)) details.push('窗口重置时间已过，等待新采样（显示上次数字）');
    const evidence = retained ? sample : blocked || sample;
    const confidence = evidence ? (blocked && !retained ? (blocked.numeric ? '额度窗口已用尽' : '高（用尽报错）') : sample.confidence) : '';
    if (evidence) details.push(`来源：${evidence.source}；${confidence}；采样 ${new Date(evidence.at).toLocaleString()}${stale ? '（数据已旧）' : !fresh && (!blocked || retained) ? '（已过期）' : ''}`);
    const displayLabel = provider === 'Claude' && windows.length ? (blocked && !windows.some((w) => w.label === '5 小时') ? `5h 已用尽 ↻${recovery ? clock(recovery) : blocked.resetText || '未知'} · ` : '') + windows.map((w) => claudeWindow(w)).join(' · ') : provider === 'Claude' && blocked ? `5h 已用尽 ↻${recovery ? clock(recovery) : blocked.resetText || '未知'}` : label;
    const sampleLabel = provider === 'Claude' && (fresh || retained) ? `采样 ${stale ? new Date(sample.at).toLocaleString() : new Date(sample.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}${stale ? '（数据已旧）' : ''}` : '';
    // Compact panel fields: the two remaining percentages, or the recovery time while exhausted.
    const pick = (re) => windows.find((w) => re.test(w.label))?.remaining ?? null;
    // Any live window at 0% (5-hour or weekly) makes the account unusable until the latest such reset.
    const empty = windows.filter((w) => (w.exhausted || w.remaining <= 0) && (!w.resetAt || w.resetAt > now));
    const out = exhausted || empty.length > 0;
    const outAt = recovery || (empty.length && empty.every((w) => w.resetAt) ? Math.max(...empty.map((w) => w.resetAt)) : null);
    const statusText = out ? '已用尽' : { danger: '快用完', warning: '快用完', normal: '正常' }[state] || '未知';
    const sampledAt = (fresh || retained) ? sample.at : evidence?.at || null;
    // Panel cells: one per known window in 5h → 7d order; a provider without windows shows its status alone.
    const weeklyOut = windows.some((w) => /每周$/.test(w.label) && w.exhausted);
    const cells = [[/5 小时$/, '5h'], [/每周$/, '7d']].map(([re, key]) => {
      const w = windows.find((v) => re.test(v.label));
      if (!w) return null;
      const cellOut = ((w.exhausted || w.remaining <= 0) && (!w.resetAt || w.resetAt > now)) || (key === '5h' && !!blocked && !weeklyOut);
      return { key, remaining: w.remaining, out: cellOut, resetAt: (cellOut && key === '5h' && blocked ? recovery || w.resetAt : w.resetAt) || null };
    }).filter(Boolean);
    // Shared fallback for a row that has no 5-hour cell to show: weekly % (Codex), 正常 (Grok), else — when truly unknown.
    const fiveHour = pick(/5 小时$/), weekly = pick(/每周$/);
    const shortRemaining = fiveHour ?? weekly;
    const shortText = shortRemaining === null ? (state === 'normal' ? '正常' : '—') : `${fiveHour === null ? '周 ' : ''}${shortRemaining < 1 ? '<1' : Math.round(shortRemaining)}%`;
    return { provider, state, label, displayLabel, sampleLabel, statusText, fiveHour, weekly, shortText, shortRemaining, out, recoveryAt: out && outAt || null, sampledAt, stale: !!stale, failures: entry.officialStatus?.failure ? entry.officialStatus.failures || 1 : 0, cells, account: entry.account || '', source: evidence?.source || '', confidence: confidence || '', name: seat ? seat.name + (seat.id === captainSeatId ? ' · 队长' : '') : provider === 'Antigravity' ? 'Gemini' : provider === 'Cursor' ? 'Grok 4.7' : '', detail: `${seat ? 'Claude / ' + seat.name : NAMES[provider]}：${label}\n${details.join('\n')}` };
  }
  function commandQuota(store, command, seats, activeSeatId, now = Date.now()) {
    const cmd = String(command || '').trim();
    const bin = cmd.match(/^(claude|codex|cursor-agent|agy|antigravity|gemini)(?:\s|$)/i)?.[1]?.toLowerCase();
    const provider = { claude: 'Claude', codex: 'Codex', 'cursor-agent': 'Cursor', agy: 'Antigravity', antigravity: 'Antigravity', gemini: 'Antigravity' }[bin];
    if (!provider) return null;
    const model = cmd.match(/(?:--model|-m)(?:\s+|=)["']?([^\s"']+)/)?.[1] || '';
    if (provider === 'Antigravity' && model && !modelScope(provider, model) || provider === 'Cursor' && !modelScope(provider, model)) return null;
    const seatList = claudeSeats(seats);
    const seat = provider === 'Claude' ? seatList.find((s) => s.id === activeSeatId) || seatForColumn({ cmd }, seatList) : null;
    return summary(store || {}, provider, now, seat);
  }
  // The phone only ever shows h***@example.com, whatever a source stored.
  function maskAccount(value) {
    const m = typeof value === 'string' && value.length <= 200 ? value.match(/^([^\s@*])[^\s@]*@([^\s@*]+)$/) : null;
    return m ? `${m[1]}***@${m[2]}` : '';
  }
  // Rows for the phone page: the same summaries as the desktop sidebar, cut down
  // to display fields. No config directory, account key, source or raw detail.
  function mobile(store, now = Date.now(), seats, captainSeatId = null, captainProvider = '') {
    return items(seats).map(({ provider, seat, key }) => {
      const q = summary(store || {}, provider, now, seat, captainSeatId);
      const named = seat && seat.id !== 'default';
      const flag = named ? seat.name.match(/\p{Regional_Indicator}{2}/u)?.[0] || '' : '';
      const plain = named ? seat.name.replace(flag, '').trim() || seat.id.toUpperCase() : '';
      const status = q.out ? 'out' : q.cells.length ? (q.stale ? 'stale' : q.state) : q.state === 'normal' ? 'nodigits' : q.sampledAt ? 'expired' : 'unknown';
      return { key, provider,
        name: seat ? (named ? `Claude ${seat.name}` : 'Claude') : { Codex: 'Codex', Cursor: 'Cursor Grok', Antigravity: 'Gemini' }[provider],
        short: seat ? plain || 'Claude' : { Codex: 'Codex', Cursor: 'Grok', Antigravity: 'Gemini' }[provider], flag,
        captain: seat ? seat.id === captainSeatId : !!captainProvider && captainProvider === provider,
        status, failed: q.failures > 0, cells: q.cells.map((c) => ({ key: c.key, remaining: c.remaining, out: !!c.out, resetAt: c.resetAt || null })),
        recoveryAt: q.recoveryAt || null, sampledAt: q.sampledAt || null, account: maskAccount(q.account) };
    });
  }
  function text(store, now, seats, captainSeatId) { return items(seats).map(({ provider, seat }) => summary(store, provider, now, seat, captainSeatId).detail.replace(/\n/g, ' · ')).join('\n'); }
  return { PROVIDERS, SCOPES, FRESH_MS, CLAUDE_OAUTH_SOURCE, freshMs, EXHAUSTED, RATE_LIMITED, resourceError, claudeSeats, seatKey, seatForColumn, items, percent, resetTime, modelName, screen, cacheClaude, cacheCodex, codexServer, cacheAntigravity, observe, summary, commandQuota, text, maskAccount, mobile };

});
