(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClaudeSeatsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULTS = [
    { id: 'cn', name: 'CN', icon: '🇨🇳', configDir: '~/.claude' },
    { id: 'us', name: 'US', icon: '🇺🇸', configDir: '~/.claude-us' },
  ];
  const CODEX_COMMAND = 'codex --model gpt-6.1-sol --dangerously-bypass-approvals-and-sandbox';
  const CLAUDE_COMMAND = 'claude --model claude-opus-5-5 --effort high --dangerously-skip-permissions';
  function normalize(value) {
    const ids = new Set();
    const seats = (Array.isArray(value) ? value : DEFAULTS).slice(0, 8).filter((s) => {
      if (!s || !/^[a-zA-Z0-9_-]{1,40}$/.test(s.id) || ids.has(s.id) || typeof s.configDir !== 'string' || !s.configDir.trim() || /[\x00-\x1f]/.test(s.configDir)) return false;
      ids.add(s.id); return true;
    }).map((s) => ({ id: s.id, name: String(s.name || s.id).slice(0, 80), icon: String(s.icon || (s.id === 'us' ? '🇺🇸' : s.id === 'cn' ? '🇨🇳' : '')).slice(0, 12), configDir: s.configDir.trim() }));
    return seats.length ? seats : DEFAULTS.map((s) => ({ ...s }));
  }
  function active(config) {
    const seats = normalize(config.claudeSeats);
    return seats.find((s) => s.id === config.activeClaudeSeatId) || seats[0];
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
    const match = String(command).match(/^(?:command\s+)?((?:"[^"]*claude"|'[^']*claude'|[^\s]*claude))(\s|$)/);
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
  return { normalize, active, maskEmail, configDir, launchCommand, usage, CODEX_COMMAND, CLAUDE_COMMAND };
});
