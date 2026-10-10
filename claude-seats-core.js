(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClaudeSeatsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULTS = [
    { id: 'cn', name: 'CN', icon: '🇨🇳', configDir: '~/.claude' },
    { id: 'us', name: 'US', icon: '🇺🇸', configDir: '~/.claude-us' },
    { id: 'us2', name: 'US2', icon: '🇺🇸', configDir: '~/.claude-us2' },
  ];
  // The account a seat is meant to hold (seat settings, local config only). Strict
  // enough to go into a shell command unquoted; anything else is no expectation at all.
  function cleanEmail(value) {
    const email = typeof value === 'string' ? value.trim() : '';
    return email.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) ? email : '';
  }
  // What the seat lists show about who is actually signed in to a seat.
  function accountCheck(expected, info) {
    if (!info?.loggedIn) return { state: 'login', text: '需登录' };
    const actual = cleanEmail(info.loginEmail), want = cleanEmail(expected);
    if (!actual) return { state: 'unknown', text: '账号未识别' };
    if (want && actual.toLowerCase() !== want.toLowerCase()) return { state: 'mismatch', text: `登成了 ${actual}，应为 ${want}` };
    return { state: 'ok', text: actual };
  }
  // The name a seat goes by everywhere: the part of its sign-in address before the @.
  function accountName(email) {
    const clean = cleanEmail(email);
    return clean ? clean.slice(0, clean.lastIndexOf('@')) : '';
  }
  // The subscription as Claude Code records it: oauthAccount.organizationType with
  // organizationRateLimitTier, or `claude auth status` subscriptionType. '' when unknown.
  function planName(type, tier) {
    const kind = String(type || '').toLowerCase().replace(/^claude_/, '');
    if (kind === 'max') {
      const times = String(tier || '').toLowerCase().match(/max_(\d{1,3})x/);
      return times ? `Max ${times[1]}x` : 'Max';
    }
    return { pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' }[kind] || '';
  }
  // What every seat list shows for a seat: the account behind its directory, never the
  // fixed seat name. The seat code stays in the hover text and in `--seat`.
  // info: seats:list row, or { accountEmail, plan } remembered from the last run (no loggedIn yet).
  function seatDisplay(seat, info) {
    const email = cleanEmail(info?.loginEmail) || cleanEmail(info?.accountEmail);
    const name = accountName(email);
    const known = typeof info?.loggedIn === 'boolean';
    const label = name || (!known ? '识别中' : info.loggedIn ? '账号未识别' : '未登录');
    const plan = name && typeof info?.plan === 'string' ? info.plan.slice(0, 20) : '';
    // The seat's own name without its icon (the quota rows carry "🇺🇸 US2", the settings "US2").
    const id = String(seat?.id || ''), named = String(seat?.name || '').replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\s]+/u, '').trim();
    const code = named && named.toLowerCase() !== id.toLowerCase() ? `${named}（${id}）` : id;
    const title = [email || label, plan && '套餐 ' + plan, '席位 ' + code, seat?.configDir].filter(Boolean).join(' · ');
    return { label, email, plan, mark: /^Max\b/.test(plan) ? 'Max' : '', code, title };
  }
  // Every seat directory and the account behind it right now, for an error that must not guess.
  function seatMapText(seats, infos) {
    return normalize(seats).map((seat) => {
      const info = (Array.isArray(infos) ? infos : []).find((i) => i && i.id === seat.id), shown = seatDisplay(seat, info || { loggedIn: false });
      return `${seat.id} → ${shown.label}${shown.email && info?.loggedIn !== true ? '（未登录）' : ''}`;
    }).join('；');
  }
  // `--seat` takes a seat code (cn / us / us2) or the account signed in there: the part of
  // its address before the @, or the whole address. An account is looked up in what the
  // seat directories hold at this moment, so it follows the account when a directory is
  // signed in to another one. Nothing found, or the same account behind two directories,
  // is an error that lists every directory and its account. Never a guess.
  function resolveSeat(value, seats, infos) {
    const wanted = typeof value === 'string' ? value.trim() : '', list = normalize(seats), lower = wanted.toLowerCase();
    const now = `当前各目录登录的账号：${seatMapText(seats, infos)}。`;
    if (!wanted) return { error: `--seat 需要账号名或目录代号。${now}` };
    const coded = list.find((seat) => seat.id === wanted) || (list.filter((seat) => seat.id.toLowerCase() === lower).length === 1 ? list.find((seat) => seat.id.toLowerCase() === lower) : null);
    if (coded) return { seat: coded };
    const whole = lower.includes('@');
    const held = list.map((seat) => {
      const info = (Array.isArray(infos) ? infos : []).find((i) => i && i.id === seat.id);
      return { seat, email: (cleanEmail(info?.loginEmail) || cleanEmail(info?.accountEmail)).toLowerCase() };
    }).filter((entry) => entry.email && (whole ? entry.email === lower : accountName(entry.email) === lower));
    if (held.length === 1) return { seat: held[0].seat };
    if (!held.length) return { error: `--seat ${wanted}：没有哪个目录登着这个账号，没有派。${now}` };
    const same = new Set(held.map((entry) => entry.email)).size === 1;
    return { error: `--seat ${wanted}：${same ? `${held.map((entry) => entry.seat.id).join('、')} 这 ${held.length} 个目录登的是同一个账号` : `有 ${held.length} 个不同的账号都叫这个名字（${held.map((entry) => `${entry.seat.id} 是 ${entry.email}`).join('，')}）`}，没有派。请改写${same ? '目录代号' : '完整邮箱或目录代号'}。${now}` };
  }
  function codexCommand(effort = 'high') {
    return `codex --model gpt-6.1-sol --no-daemon -c model_reasoning_effort=${effort === 'xhigh' ? 'xhigh' : 'high'} --dangerously-bypass-approvals-and-sandbox`;
  }
  const CODEX_COMMAND = codexCommand();
  // The Captain's own Claude command when none is saved (new Captain, Relay back from Codex).
  const CLAUDE_COMMAND = 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort max';
  function relayCodexCommand(command, effort) {
    const words = String(command).match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) || [];
    const program = (words[0] === 'command' ? words[1] : words[0]) || '';
    const name = program.replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '');
    return name.toLowerCase() === 'codex'
      ? (words[0] === 'command' ? 'command ' : '') + codexCommand(effort).replace(/^codex/, program) : command;
  }
  function normalize(value) {
    const ids = new Set();
    const seats = (Array.isArray(value) ? value : DEFAULTS).slice(0, 8).filter((s) => {
      if (!s || !/^[a-zA-Z0-9_-]{1,40}$/.test(s.id) || ids.has(s.id) || typeof s.configDir !== 'string' || !s.configDir.trim() || /[\x00-\x1f]/.test(s.configDir)) return false;
      ids.add(s.id); return true;
    }).map((s) => ({ id: s.id, name: String(s.name || s.id).slice(0, 80), icon: String(s.icon || DEFAULTS.find((d) => d.id === s.id)?.icon || '').slice(0, 12), configDir: s.configDir.trim(), email: cleanEmail(s.email) }));
    // Upgrade saved two-seat profiles without changing names, paths or active seat.
    if (seats.length === 2 && ids.has('cn') && ids.has('us')) seats.push({ ...DEFAULTS[2], email: '' });
    return seats.length ? seats : DEFAULTS.map((s) => ({ ...s, email: '' }));
  }
  function active(config) {
    const seats = normalize(config.claudeSeats);
    return seats.find((s) => s.id === config.activeClaudeSeatId) || seats[0];
  }
  function bindColumn(column, config) {
    const seat = normalize(config.claudeSeats).find((s) => s.id === (column.claudeSeatId || active(config).id));
    column.claudeSeatId ||= seat?.id;
    column.claudeConfigDir ||= seat?.configDir;
    return { ...seat, id: column.claudeSeatId, configDir: column.claudeConfigDir || '' };
  }
  // A launch line whose program is Claude: bare, quoted or by path, optionally after `command`.
  const CLAUDE_LAUNCH_RE = /^(?:command\s+)?((?:"[^"]*claude"|'[^']*claude'|[^\s]*claude))(\s|$)/;
  function claudeLaunch(command) { return CLAUDE_LAUNCH_RE.test(String(command || '')); }
  // Why a Claude session must not start on the seat it is bound to ('' when it may). Restored and
  // reopened sessions only ever go back to their own seat, never another one. Only a definite answer
  // blocks: a seat gone from the settings, or one whose login is known to be missing (seats:list
  // loginReason). An unreadable Keychain or a seat list that did not load is not a logout.
  function launchBlock(column, config, infos) {
    if (!claudeLaunch(column?.cmd)) return '';
    const id = column.claudeSeatId || active(config).id;
    const seat = normalize(config.claudeSeats).find((s) => s.id === id);
    if (!seat) return `席位 ${id} 已不在席位设置里`;
    // The seat now points at another directory: its login says nothing about this session's.
    if (column.claudeConfigDir && column.claudeConfigDir !== seat.configDir) return '';
    const info = (Array.isArray(infos) ? infos : []).find((s) => s?.id === seat.id);
    if (!info || info.loggedIn || !info.loginReason) return '';
    return `席位 ${seat.name}（${seat.email || info.maskedEmail || seat.id}）未登录`;
  }
  function maskEmail(email) {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) return '';
    const [name, domain] = email.split('@');
    return name.slice(0, 1) + '***@' + domain;
  }
  function configDir(seat, home, platform) {
    const raw = seat.configDir.replace(/^~(?=$|[\\/])/, home).replace(/\\/g, '/');
    const parts = [];
    for (const part of raw.split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); }
    const result = parts.join('/').replace(/\/$/, '');
    return platform === 'win32' ? result.replace(/\//g, '\\') : result;
  }
  function launchCommand(command, seat, home, platform) {
    // Reassert after shell profiles, and bypass a claude alias/function that
    // could route back to the other login. Other providers keep their launch.
    const match = String(command).match(CLAUDE_LAUNCH_RE);
    if (!match || !seat) return command;
    const dir = configDir(seat, home, platform);
    const standard = configDir({ configDir: '~/.claude' }, home, platform);
    const isDefault = platform === 'win32' ? dir.toLowerCase() === standard.toLowerCase() : dir === standard;
    const vars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_GATEWAY_LINEAGE'];
    const quote = (s) => "'" + s.replace(/'/g, platform === 'win32' ? "''" : "'\\''") + "'";
    if (platform === 'win32') return vars.concat('CLAUDE_CONFIG_DIR').map((key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue; `).join('')
      + (isDefault ? '' : `$env:CLAUDE_CONFIG_DIR=${quote(dir)}; `) + command;
    const binary = match[1].replace(/^['"]|['"]$/g, '');
    const direct = 'command ' + quote(binary) + command.slice(match[0].length - match[2].length);
    return `(unset ${vars.concat('CLAUDE_CONFIG_DIR').join(' ')}; ${isDefault ? '' : `export CLAUDE_CONFIG_DIR=${quote(dir)}; `}${direct})`;
  }
  function usage(text, now = Date.now()) {
    // Native /usage panels only: a global third-party statusline cache may
    // belong to the other account. Context and session cost are not quotas.
    const result = { at: now, source: 'Claude /usage', windows: [] };
    for (const [key, heading] of [['fiveHour', 'Current session'], ['weekly', 'Current week(?: \\(all models\\))?']]) {
      const m = String(text || '').match(new RegExp('^\\s*[│]*\\s*' + heading + '\\s*\\n([^]*?)(?=\\n\\s*(?:Current |$))', 'im'));
      const p = m && m[1].match(/(\d+(?:\.\d+)?)%\s*used/i);
      const r = m && m[1].match(/Resets?\s+([^\n│]+)/i);
      if (p && Number(p[1]) <= 100) result.windows.push({ key, remaining: 100 - Number(p[1]), resetText: r ? r[1].trim().slice(0, 100) : '' });
    }
    return result.windows.length ? result : null;
  }
  function footerUsage(rows, now = Date.now()) {
    // "5h剩余 83% · 7d剩余 59%" is rendered by the statusline from this
    // session's own stdin rate_limits, so it belongs to the session's login.
    // ccstatusline "Session:/Weekly:" reads a machine-wide cache: never here.
    const text = Array.isArray(rows) ? rows.join('\n') : '';
    const windows = [];
    for (const [key, name] of [['fiveHour', '5h'], ['weekly', '7d']]) {
      const m = text.match(new RegExp('(?:^|[\\s·|│])' + name + '剩余?\\s*(\\d+(?:\\.\\d+)?)%'));
      if (m && Number(m[1]) <= 100) windows.push({ key, remaining: Number(m[1]), resetText: '' });
    }
    return windows.length ? { at: now, source: 'Claude 会话状态行', windows } : null;
  }
  return { normalize, cleanEmail, accountCheck, accountName, planName, seatDisplay, seatMapText, resolveSeat, active, bindColumn, claudeLaunch, launchBlock, maskEmail, configDir, launchCommand, usage, footerUsage, codexCommand, relayCodexCommand, CODEX_COMMAND, CLAUDE_COMMAND };

});
