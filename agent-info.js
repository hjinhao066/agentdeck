// Pure helper for live provider & model identity badges and formatting.
// Runs in the browser (window.AgentInfo) and in Node.js test runners.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentInfo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROVIDER_ICONS = {
    Cursor: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 3 10.5 21 13.5 13.5 21 10.5 3 3"/></svg>',
    Claude: '<svg viewBox="0 0 100 100" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"/></svg>',
    Antigravity: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 2C12 7.5 7.5 12 2 12C7.5 12 12 16.5 12 22C12 16.5 16.5 12 22 12C16.5 12 12 7.5 12 2Z"/></svg>',
    // Official Grok mark: https://grok.com/images/favicon.svg (foreground paths).
    Grok: '<svg viewBox="36 36 440 440" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M210.484 312.759L343.465 210.383C349.984 205.364 359.302 207.322 362.408 215.117C378.758 256.231 371.454 305.64 338.925 339.563C306.397 373.487 261.137 380.927 219.768 363.983L174.577 385.803C239.394 432.008 318.104 420.581 367.289 369.251C406.303 328.564 418.386 273.104 407.088 223.091L407.19 223.198C390.807 149.726 411.218 120.359 453.03 60.3072C454.02 58.8833 455.01 57.4595 456 56L400.978 113.382V113.204L210.45 312.794"/><path d="M183.042 337.641C136.519 291.294 144.54 219.567 184.236 178.203C213.59 147.59 261.683 135.096 303.666 153.464L348.755 131.75C340.632 125.627 330.221 119.042 318.275 114.414C264.277 91.2407 199.63 102.774 155.735 148.516C113.513 192.549 100.236 260.254 123.036 318.027C140.069 361.206 112.148 391.748 84.0229 422.575C74.0561 433.503 64.0553 444.431 56 456L183.007 337.677"/></svg>',
    // OpenAI Blossom: https://openai.com/brand/ (Blossom_Light.svg, mark without guides).
    Codex: '<svg viewBox="134 213 293 293" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z"/></svg>',
  };

  function stripAnsi(str) {
    if (!str) return '';
    return String(str)
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '');
  }

  function inferProvider(command, screenText) {
    const first = String(command || '').trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const bin = first ? (first[1] || first[2] || first[3]).replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() : '';
    const providers = { 'cursor-agent': 'Cursor', claude: 'Claude', agy: 'Antigravity', antigravity: 'Antigravity', gemini: 'Antigravity', grok: 'Grok', codex: 'Codex', chatgpt: 'Codex' };
    if (providers[bin]) return providers[bin];

    // 2. Fallback to observed live provider heading when launch command is empty or generic
    if (screenText) {
      const clean = stripAnsi(screenText);
      const prefix = '^\\s*(?:[│╭─*>_❯]\\s*)*';
      if (new RegExp(prefix + '(?:Cursor Agent|Cursor CLI|cursor-agent)\\b', 'im').test(clean)) return 'Cursor';
      if (new RegExp(prefix + '(?:Claude Code|Welcome to Claude Code)\\b', 'im').test(clean)) return 'Claude';
      if (new RegExp(prefix + '(?:Antigravity|AGY CLI|Gemini CLI|Google Gemini)\\b', 'im').test(clean)) return 'Antigravity';
      if (new RegExp(prefix + '(?:Grok CLI|Grok Code|Welcome to Grok)\\b', 'im').test(clean)) return 'Grok';
      if (new RegExp(prefix + '(?:OpenAI Codex|Codex CLI|Welcome to Codex)\\b', 'im').test(clean)) return 'Codex';
    }

    return null;
  }

  function modelMatchesProvider(model, provider) {
    if (!model) return false;
    if (!provider || provider === 'Cursor' || provider === 'Antigravity') return true;
    const short = shortModelName(model);
    const family = /^(?:Opus|Sonnet|Haiku)\b/i.test(short) ? 'Claude'
      : /^(?:Flash|Pro|Gemini)\b/i.test(short) ? 'Antigravity'
      : /^Grok\b/i.test(short) ? 'Grok'
      : /^(?:GPT-|o[13]\b)/i.test(short) ? 'Codex' : null;
    return !family || family === provider;
  }

  // Claude's banner and custom statusline omit "Model:". Require a model
  // segment followed by a TUI separator, allowing its leading glyph/mascot.
  const CLAUDE_STATUS_MODEL = /^[^a-zA-Z0-9]*((?:Claude\s+)?(?:Opus|Sonnet|Haiku)\s+\d+\.\d+)(?=\s*[|│·•])/i;

  // Read the actual footer when available, never model examples above it.
  // Direct tools only accept their own family; Cursor/Antigravity support others.
  function extractModel(screenText, command, footerRows, provider = inferProvider(command)) {
    // 1. Dedicated footer rows from TUI if provided (most authoritative)
    if (Array.isArray(footerRows) && footerRows.length) {
      for (let i = footerRows.length - 1; i >= 0; i--) {
        const raw = stripAnsi(footerRows[i]);
        const m = raw.match(/(?:^|[|│])\s*Model:\s*([^|│\r\n]+)/i);
        if (m) {
          const val = m[1].trim();
          if (val && !/^None$/i.test(val) && modelMatchesProvider(val, provider)) return val;
        }
        const codex = raw.match(/^\s*(gpt[- ]?\d+(?:\.\d+)?(?:[- ](?:sol|astra|luna|terra|codex|mini|nano|pro))?(?:[- ](?:xhigh|high|max|medium|low))?)(?=\s*(?:[|│·•]|$))/i);
        if (codex && modelMatchesProvider(codex[1], provider)) return codex[1].trim();
        const claude = raw.match(CLAUDE_STATUS_MODEL);
        if (claude && modelMatchesProvider(claude[1], provider)) return claude[1].trim();
      }
    }

    // 2. Live terminal screen text: scan from bottom to top (newest first)
    if (screenText && !(Array.isArray(footerRows) && footerRows.length)) {
      const clean = stripAnsi(screenText);
      const lines = clean.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;

        // Dedicated status line: e.g. "Model: claude-opus-5-5-high" or "| Model: Fake |"
        const statusMatch = line.match(/(?:^|[|│])\s*Model:\s*([^|│\r\n]+)/i);
        if (statusMatch) {
          const val = statusMatch[1].trim();
          if (val && !/^None$/i.test(val) && modelMatchesProvider(val, provider)) return val;
        }

        // Codex writes its selected model directly in the TUI footer, without
        // a "Model:" label. When that footer isn't split into rows by xterm,
        // the restored screen dump is the remaining source after a restart.
        const codexFooter = line.match(/^\s*(gpt[- ]?\d+(?:\.\d+)?(?:[- ](?:sol|astra|luna|terra|codex|mini|nano|pro))?(?:[- ](?:xhigh|high|max|medium|low))?)(?=\s*(?:[|│·•]))/i);
        if (codexFooter && modelMatchesProvider(codexFooter[1], provider)) return codexFooter[1].trim();
        const claude = line.match(CLAUDE_STATUS_MODEL);
        if (claude && modelMatchesProvider(claude[1], provider)) return claude[1].trim();

        // Dedicated model switch / banner: e.g. "Switched model to claude-opus-5-5-high" or "> /model claude-sonnet-5-5-high"
        const switchMatch = line.match(/(?:^|[|│>❯$#•*]\s*)(?:model\s+changed\s+to|switched to model|switched model to|using model:?|current model:?)\s+([a-zA-Z0-9_.-]+)/i);
        if (switchMatch) {
          const val = switchMatch[1].trim();
          if (val && modelMatchesProvider(val, provider)) return val;
        }
      }
    }

    // 3. Fallback to starting command: e.g. --model claude-opus-5-5-high
    if (command) {
      const cmdMatch = String(command).match(/(?:^|\s)(?:--model|-m)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_.\/-]+))/i);
      const model = cmdMatch && (cmdMatch[1] || cmdMatch[2] || cmdMatch[3]).trim();
      if (model && modelMatchesProvider(model, provider)) return model;
    }

    return null;
  }

  function extractEffort(rawModel, command, screenText) {
    const clean = stripAnsi(screenText || '');
    const lines = clean.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const status = lines[i].match(CLAUDE_STATUS_MODEL);
      const statusEffort = status && lines[i].slice(status[0].length).match(/^\s*[|│·•]\s*(xhigh|high|max|medium|low)\b/i);
      if (statusEffort) return statusEffort[1].toLowerCase();
      const live = lines[i].match(/(?:^|[|│])\s*(?:Thinking|Effort):\s*(xhigh|high|max|medium|low)\b/i);
      if (live) return live[1].toLowerCase();
    }
    const model = String(rawModel || '').match(/(?:[-(\s])(xhigh|high|max|medium|low)(?=$|[)\s-])/i);
    if (model) return model[1].toLowerCase();
    for (let i = lines.length - 1; i >= 0; i--) {
      const changed = lines[i].match(/^\s*[•*]?\s*Model changed to\s+[a-zA-Z0-9_.-]+\s+(xhigh|high|max|medium|low)\b/i);
      if (changed) return changed[1].toLowerCase();
    }
    const cmd = String(command || '').match(/--effort\s+(xhigh|high|max|medium|low)\b/i);
    return cmd ? cmd[1].toLowerCase() : null;
  }

  function shortModelName(rawModel) {
    if (!rawModel) return null;
    let str = String(rawModel).trim().replace(/\s+/g, ' ');

    // Remove effort/thinking suffix for short label
    str = str.replace(/[-(](high|xhigh|max|medium|low|thinking|fast)[)]?$/i, '');
    str = str.replace(/[-_]thinking$/i, '');

    // Claude / Opus / Sonnet / Haiku
    let m = str.match(/opus[- ]?(\d+)[-.](\d+)/i);
    if (m) return `Opus ${m[1]}.${m[2]}`;
    m = str.match(/sonnet[- ]?(\d+)[-.](\d+)/i);
    if (m) return `Sonnet ${m[1]}.${m[2]}`;
    m = str.match(/(?:claude[- ])?(\d+)[-.](\d+)[- ]?sonnet/i);
    if (m) return `Sonnet ${m[1]}.${m[2]}`;
    m = str.match(/(?:claude[- ])?(\d+)[-.](\d+)[- ]?opus/i);
    if (m) return `Opus ${m[1]}.${m[2]}`;
    m = str.match(/haiku[- ]?(\d+)[-.](\d+)/i);
    if (m) return `Haiku ${m[1]}.${m[2]}`;
    m = str.match(/(?:claude[- ])?(\d+)[-.](\d+)[- ]?haiku/i);
    if (m) return `Haiku ${m[1]}.${m[2]}`;

    // Gemini / Flash / Pro
    m = str.match(/gemini[- ]?(\d+)[-.](\d+)[- ]?flash/i);
    if (m) return `Flash ${m[1]}.${m[2]}`;
    m = str.match(/flash[- ]?(\d+)[-.](\d+)/i);
    if (m) return `Flash ${m[1]}.${m[2]}`;
    m = str.match(/gemini[- ]?(\d+)[-.](\d+)[- ]?pro/i);
    if (m) return `Pro ${m[1]}.${m[2]}`;
    m = str.match(/pro[- ]?(\d+)[-.](\d+)/i);
    if (m) return `Pro ${m[1]}.${m[2]}`;
    m = str.match(/gemini[- ]?(\d+)[-.](\d+)/i);
    if (m) return `Gemini ${m[1]}.${m[2]}`;

    // Grok
    m = str.match(/grok[- ]?(\d+)[-.](\d+)/i);
    if (m) return `Grok ${m[1]}.${m[2]}`;
    if (/^grok/i.test(str)) return 'Grok';

    // OpenAI / Codex / o1 / o3
    m = str.match(/gpt[- ]?(\d+(?:\.\d+)?o?)(?:[- ](sol|astra|luna|terra|codex|mini|nano|pro))?/i);
    if (m) return 'GPT-' + m[1] + (m[2] ? ' ' + m[2][0].toUpperCase() + m[2].slice(1) : '');
    m = str.match(/(gpt[- ]?4(?:[.]5|o))/i);
    if (m) return m[1].toUpperCase().replace(' ', '-');
    m = str.match(/(o[13](?:-mini)?)/i);
    if (m) return m[1].toLowerCase();

    // Meta Muse models may be namespaced in provider model ids.
    m = str.match(/(?:meta[-/ ]*)?muse(?:[-/ ]+(spark|\d+(?:\.\d+)?))?/i);
    if (m) return 'Muse' + (m[1] ? ' ' + (m[1].toLowerCase() === 'spark' ? 'Spark' : m[1]) : '');

    // Stand-in fake agent
    if (/^fake$/i.test(str)) return 'Fake';

    // Fallback: clean up hyphens/underscores, keep it short
    const cleaned = str.replace(/^models?\//i, '').split('/').pop().replace(/[-_]/g, ' ').trim();
    if (cleaned.length <= 10) return cleaned;
    const words = cleaned.split(/\s+/);
    if (words.length > 1 && (words[0] + ' ' + words[1]).length <= 12) {
      return words[0] + ' ' + words[1];
    }
    return cleaned.slice(0, 10);
  }

  function formatFullModel(rawModel) {
    if (!rawModel) return '';
    const short = shortModelName(rawModel);
    if (!short) return String(rawModel);

    // Expand known short forms nicely if appropriate
    if (/^Opus/i.test(short)) return 'Claude ' + short;
    if (/^Sonnet/i.test(short)) return 'Claude ' + short;
    if (/^Haiku/i.test(short)) return 'Claude ' + short;
    const geminiMatch = short.match(/^(Flash|Pro)\s+(\d+\.\d+)/i);
    if (geminiMatch) return `Gemini ${geminiMatch[2]} ${geminiMatch[1]}`;
    if (/^(?:Flash|Pro)/i.test(short)) return 'Gemini ' + short;
    return short;
  }

  function formatTooltip(provider, rawModel, effort) {
    if (!provider) return '';
    const fullModel = formatFullModel(rawModel);
    const effStr = effort ? ` (${effort})` : '';
    if (fullModel) return `${provider} · ${fullModel}${effStr}`;
    return effort ? `${provider} (${effort})` : provider;
  }

  function resolveAgentInfo(col, entry, screenText, footerRows, historyReplies) {
    const cmd = (col && col.cmd) || '';
    const screen = screenText || (entry && entry.lastScreen) || '';
    const footerSource = footerRows || (entry && entry.footerLines);
    const footers = Array.isArray(footerSource) ? footerSource.map((line) => Array.isArray(line) ? line.map((s) => s.text).join('') : line) : null;

    // Provider inference: command is authoritative, screen is fallback for manual agent
    let provider = inferProvider(cmd, screen);

    // Saved replies retain explicit model footers when a restored shell ends
    // on a prompt or a transient picker menu instead of the agent's statusline.
    let historyProvider = null;
    let historyModel = null;
    let historyEffort = null;
    if (Array.isArray(historyReplies) && !inferProvider(cmd)) {
      for (let i = historyReplies.length - 1; i >= 0; i--) {
        const reply = String(historyReplies[i] || '');
        if (!reply) continue;
        const replyProvider = inferProvider('', reply);
        if (!historyProvider && replyProvider) historyProvider = replyProvider;
        const targetProvider = provider || historyProvider;
        const replyModel = extractModel(reply, '', null, targetProvider);
        if (!historyModel && replyModel && (!replyProvider || !targetProvider || replyProvider === targetProvider)) {
          historyModel = replyModel;
          historyEffort = extractEffort(replyModel, cmd, reply);
        }
        if (historyProvider && historyModel) break;
      }
    }
    if (!provider) provider = historyProvider || (entry && entry.detectedProvider) || (col && col.agentProvider) || null;

    if (provider && entry && !entry.detectedProvider) {
      entry.detectedProvider = provider;
    }

    // Plain shell
    if (!provider) {
      return {
        provider: null,
        model: null,
        rawModel: null,
        shortModel: null,
        effort: null,
        tooltip: '',
        isShell: true,
        key: 'shell',
      };
    }

    // Model extraction
    const liveModel = extractModel(screen, '', footers, provider);
    const cachedModel = col && (!col.agentProvider || col.agentProvider === provider) && modelMatchesProvider(col.agentModel, provider) ? col.agentModel : null;
    const rawModel = liveModel || historyModel || cachedModel || extractModel('', cmd, null, provider);
    const shortModel = shortModelName(rawModel);
    const liveStatus = liveModel ? (footers && footers.length ? footers.join('\n') : screen) : '';
    const effort = extractEffort(rawModel, cmd, liveStatus) || (historyModel && rawModel === historyModel ? historyEffort : null) || (cachedModel && rawModel === cachedModel ? col.agentEffort : null) || null;
    const tooltip = formatTooltip(provider, rawModel, effort);
    const key = `${provider}:${rawModel || ''}:${effort || ''}`;

    return {
      provider,
      model: shortModel,
      rawModel,
      shortModel,
      effort,
      tooltip,
      isShell: false,
      key,
    };
  }

  function renderBadge(badgeEl, info, context) {
    if (!badgeEl) return;
    if (!info || !info.provider || info.isShell) {
      badgeEl.hidden = true;
      badgeEl.textContent = '';
      badgeEl.title = '';
      badgeEl.className = 'agent-badge ' + (context === 'sidebar' ? 'cn-badge' : 'col-badge');
      badgeEl.dataset.infoKey = 'shell';
      return;
    }

    if (!badgeEl.hidden && badgeEl.dataset.infoKey === info.key && badgeEl.title === (info.tooltip || '')) return;
    const providerClass = 'provider-' + info.provider.toLowerCase();
    const baseClass = context === 'sidebar' ? 'cn-badge' : 'col-badge';
    badgeEl.className = `agent-badge ${baseClass} ${providerClass}`;
    badgeEl.title = info.tooltip || '';
    badgeEl.hidden = false;
    badgeEl.dataset.infoKey = info.key;

    const model = info.shortModel || '';
    let iconProvider = info.provider;
    if (/^(?:Opus|Sonnet|Haiku)\b/i.test(model)) iconProvider = 'Claude';
    else if (/^Grok\b/i.test(model)) iconProvider = 'Grok';
    else if (/^(?:GPT-|o[13]\b)/i.test(model)) iconProvider = 'Codex';
    else if (/^(?:Gemini\b|Flash\b|Pro\b)/i.test(model)) iconProvider = 'Antigravity';

    const iconSvg = PROVIDER_ICONS[iconProvider] || '';
    const labelText = info.shortModel || '';

    badgeEl.innerHTML = `<span class="agent-provider-icon" data-icon-provider="${iconProvider.toLowerCase()}" aria-hidden="true">${iconSvg}</span>`;
    if (labelText) {
      const label = document.createElement('span');
      label.className = 'agent-model-label';
      label.textContent = labelText;
      badgeEl.appendChild(label);
    }
  }

  function prepareAgentCommand(cmd, provider, uuid, isResume) {
    const t = (cmd || '').trim();
    if (provider !== 'Claude' && provider !== 'Grok') return cmd;
    if (/(^|\s)(--session-id|-s|--continue|-c|--resume|-r)(\s|=|$)/.test(t)) return cmd;
    if (inferProvider(t, null) !== provider) return cmd;
    const executable = t.match(/^(?:"[^"]+"|'[^']+'|\S+)/);
    if (!executable) return cmd;
    const flag = provider === 'Claude' ? (isResume ? '--resume' : '--session-id') : (isResume ? '-r' : '-s');
    return `${executable[0]} ${flag} ${uuid}${t.slice(executable[0].length)}`;
  }

  function planAgentLaunch(cmd, storedId, isFresh, skipResume, newId) {
    const provider = inferProvider(cmd, null);
    const canResume = provider === 'Claude' || provider === 'Grok';
    const explicit = /(^|\s)(--session-id|-s|--continue|-c|--resume|-r)(\s|=|$)/.test(cmd || '');
    if (!canResume || explicit) return { launch: cmd, sessionId: null, resumedAgent: false, showLegacyWarning: false };

    const validId = typeof storedId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(storedId);
    const startFresh = isFresh || skipResume;
    if (!startFresh && !validId) {
      return { launch: cmd, sessionId: null, resumedAgent: false, showLegacyWarning: true };
    }
    const sessionId = startFresh ? newId() : storedId;
    const launch = prepareAgentCommand(cmd, provider, sessionId, !startFresh);
    if (launch === cmd) return { launch: cmd, sessionId: null, resumedAgent: false, showLegacyWarning: false };
    return { launch, sessionId, resumedAgent: !startFresh, showLegacyWarning: false };
  }

  return {
    PROVIDER_ICONS,
    stripAnsi,
    inferProvider,
    extractModel,
    shortModelName,
    extractEffort,
    formatTooltip,
    resolveAgentInfo,
    renderBadge,
    prepareAgentCommand,
    planAgentLaunch,
  };
});
