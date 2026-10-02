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
    Grok: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="20" y2="4"/><line x1="13" y1="20" x2="20" y2="13"/><line x1="4" y1="11" x2="11" y2="4"/></svg>',
    Codex: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 0 0-9 9c0 2.12.74 4.07 1.97 5.61L4 21l3.5-.94A8.96 8.96 0 0 0 12 21a9 9 0 0 0 9-9 9 9 0 0 0-9-9z"/><circle cx="12" cy="12" r="3"/></svg>',
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

  // Model extraction: Parse dedicated metadata/TUI lines ONLY, newest explicit line wins.
  // Avoid conversational prose containing model names.
  function extractModel(screenText, command, footerRows) {
    // 1. Dedicated footer rows from TUI if provided (most authoritative)
    if (Array.isArray(footerRows) && footerRows.length) {
      for (let i = footerRows.length - 1; i >= 0; i--) {
        const raw = stripAnsi(footerRows[i]);
        const m = raw.match(/(?:^|[|│])\s*Model:\s*([^|│\r\n]+)/i);
        if (m) {
          const val = m[1].trim();
          if (val && !/^None$/i.test(val)) return val;
        }
        const codex = raw.match(/^\s*(gpt[- ]?\d+(?:\.\d+)?(?:[- ](?:sol|astra|luna|terra|codex|mini|nano|pro))?(?:[- ](?:xhigh|high|max|medium|low))?)(?=\s*(?:[|│·•]|$))/i);
        if (codex) return codex[1].trim();
      }
    }

    // 2. Live terminal screen text: scan from bottom to top (newest first)
    if (screenText) {
      const clean = stripAnsi(screenText);
      const lines = clean.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;

        // Dedicated status line: e.g. "Model: claude-opus-5-5-high" or "| Model: Fake |"
        const statusMatch = line.match(/(?:^|[|│])\s*Model:\s*([^|│\r\n]+)/i);
        if (statusMatch) {
          const val = statusMatch[1].trim();
          if (val && !/^None$/i.test(val)) return val;
        }

        // Codex writes its selected model directly in the TUI footer, without
        // a "Model:" label. When that footer isn't split into rows by xterm,
        // the restored screen dump is the remaining source after a restart.
        const codexFooter = line.match(/^\s*(gpt[- ]?\d+(?:\.\d+)?(?:[- ](?:sol|astra|luna|terra|codex|mini|nano|pro))?(?:[- ](?:xhigh|high|max|medium|low))?)(?=\s*(?:[|│·•]))/i);
        if (codexFooter) return codexFooter[1].trim();

        // Dedicated model switch / banner: e.g. "Switched model to claude-opus-5-5-high" or "> /model claude-sonnet-5-5-high"
        const switchMatch = line.match(/(?:^|[|│>❯$#•*]\s*)(?:model\s+changed\s+to|switched to model|switched model to|using model:?|current model:?)\s+([a-zA-Z0-9_.-]+)/i);
        if (switchMatch) {
          const val = switchMatch[1].trim();
          if (val) return val;
        }
      }
    }

    // 3. Fallback to starting command: e.g. --model claude-opus-5-5-high
    if (command) {
      const cmdMatch = String(command).match(/(?:--model|-m)\s+([a-zA-Z0-9_.-]+)/i);
      if (cmdMatch) return cmdMatch[1].trim();
    }

    return null;
  }

  function extractEffort(rawModel, command, screenText) {
    const clean = stripAnsi(screenText || '');
    const lines = clean.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
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
    const footers = footerRows || (entry && entry.footerLines ? entry.footerLines.map((line) => line.map((s) => s.text).join('')) : null);

    // Provider inference: command is authoritative, screen is fallback for manual agent
    let provider = inferProvider(cmd, screen);

    // Saved replies retain explicit model footers when a restored shell ends
    // on a prompt or a transient picker menu instead of the agent's statusline.
    let historyProvider = null;
    let historyModel = null;
    let historyEffort = null;
    if (Array.isArray(historyReplies)) {
      for (let i = historyReplies.length - 1; i >= 0; i--) {
        const reply = String(historyReplies[i] || '');
        if (!reply) continue;
        const replyProvider = inferProvider(cmd, reply);
        if (!historyProvider && replyProvider) historyProvider = replyProvider;
        const targetProvider = provider || historyProvider;
        const replyModel = extractModel(reply, '', null);
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
    const liveModel = extractModel(screen, '', footers);
    const rawModel = liveModel || historyModel || (col && col.agentModel) || extractModel('', cmd, null);
    const shortModel = shortModelName(rawModel);
    const effort = extractEffort(rawModel, cmd, screen) || (historyModel && rawModel === historyModel ? historyEffort : null) || (col && col.agentEffort) || null;
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
