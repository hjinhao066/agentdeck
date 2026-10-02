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
    Claude: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>',
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
      if (/^\s*(?:[│╭─*]\s*)*(?:Cursor Agent|Cursor CLI|cursor-agent)\b/im.test(clean)) return 'Cursor';
      if (/^\s*(?:[│╭─*]\s*)*(?:Claude Code|Welcome to Claude Code)\b/im.test(clean)) return 'Claude';
      if (/^\s*(?:[│╭─*]\s*)*(?:Antigravity|AGY CLI)\b/im.test(clean)) return 'Antigravity';
      if (/^\s*(?:[│╭─*]\s*)*(?:Grok CLI|Welcome to Grok)\b/im.test(clean)) return 'Grok';
      if (/^\s*(?:[│╭─*]\s*)*(?:OpenAI Codex|Codex CLI|Welcome to Codex)\b/im.test(clean)) return 'Codex';
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

        // Dedicated model switch / banner: e.g. "Switched model to claude-opus-5-5-high" or "> /model claude-sonnet-5-5-high"
        const switchMatch = line.match(/(?:^|[|│>❯$#]\s*)(?:switched to model|switched model to|using model:?|current model:?)\s+([a-zA-Z0-9_.-]+)/i);
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
    const cmd = String(command || '').match(/--effort\s+(xhigh|high|max|medium|low)\b/i);
    return cmd ? cmd[1].toLowerCase() : null;
  }

  function shortModelName(rawModel) {
    if (!rawModel) return null;
    let str = String(rawModel).trim();

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
    m = str.match(/gpt[- ]?(\d+(?:\.\d+)?o?)/i);
    if (m) return 'GPT-' + m[1];
    m = str.match(/(gpt[- ]?4(?:[.]5|o))/i);
    if (m) return m[1].toUpperCase().replace(' ', '-');
    m = str.match(/(o[13](?:-mini)?)/i);
    if (m) return m[1].toLowerCase();

    // Stand-in fake agent
    if (/^fake$/i.test(str)) return 'Fake';

    // Fallback: clean up hyphens/underscores, keep it short
    const cleaned = str.replace(/^models?\//i, '').replace(/[-_]/g, ' ').trim();
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

  function resolveAgentInfo(col, entry, screenText, footerRows) {
    const cmd = (col && col.cmd) || '';
    const screen = screenText || (entry && entry.lastScreen) || '';
    const footers = footerRows || (entry && entry.footerLines ? entry.footerLines.map((line) => line.map((s) => s.text).join('')) : null);

    // Provider inference: command is authoritative, screen is fallback for manual agent
    let provider = inferProvider(cmd, screen);
    if (!provider && entry && entry.detectedProvider) {
      provider = entry.detectedProvider;
    }
    if (!provider && col && col.agentProvider) {
      provider = col.agentProvider;
    }

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
    const rawModel = extractModel(screen, cmd, footers);
    const shortModel = shortModelName(rawModel);
    const effort = extractEffort(rawModel, cmd, screen);
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

    const iconSvg = PROVIDER_ICONS[info.provider] || '';
    const labelText = info.shortModel || '';

    badgeEl.innerHTML = `<span class="agent-provider-icon" aria-hidden="true">${iconSvg}</span>`;
    if (labelText) {
      const label = document.createElement('span');
      label.className = 'agent-model-label';
      label.textContent = labelText;
      badgeEl.appendChild(label);
    }
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
  };
});
