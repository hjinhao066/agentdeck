(function () {
  'use strict';
  const S = window.ClaudeSeatsCore, P = window.PerpetualCaptainCore;
  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ROTATE = svg('<path d="M20 7h-5V2M4 17h5v5"/><path d="M20 7a9 9 0 0 0-15-3M4 17a9 9 0 0 0 15 3"/>');
  // Switch account: two opposing arrows, clearer than the refresh-like cycle.
  const SWAP = svg('<path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 12 4 4-4 4"/><path d="M21 16H7"/>');
  const GEAR = svg('<circle cx="12" cy="12" r="3"/><path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/>');
  let host, seats = [], warmups = [], switching = false, retryAt = 0;
  const POWER = svg('<path d="M12 2v10"/><path d="M6 5a9 9 0 1 0 12 0"/>');
  const recorded = new Map(), quotaRefreshAt = new Map();
  let automaticRunning = false;
  const label = () => host.config.captainRelayLabel || 'Relay';
  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(icon, title, action) {
    const b = node('button', 'seat-icon');
    b.type = 'button'; b.innerHTML = icon; b.title = title; b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => { e.stopPropagation(); action(e); });
    return b;
  }
  function current() {
    const main = window.MainSession.mainCol();
    if (main && (window.MainSession.state()?.relayTargetId === 'chatgpt' || window.AgentInfo.resolveAgentInfo(main, host.terms.get(main.id)).provider === 'Codex')) return { id: 'chatgpt', name: host.config.captainRelayCodex.name, icon: '' };
    const id = window.MainSession.mainCol()?.claudeSeatId || S.active(host.config).id;
    return host.config.claudeSeats.find((s) => s.id === id) || S.active(host.config);
  }
  function isClaude(col) {
    if (!col) return false;
    if (col.isMain && window.MainSession.state()?.relayTargetId === 'chatgpt') return false;
    return window.AgentInfo.resolveAgentInfo(col, host.terms.get(col.id)).provider === 'Claude';
  }
  function hasDraft(col) {
    const wrap = host.terms.get(col.id)?.wrap;
    return host.userComposing(col.id) || !!wrap?.querySelector('.composer textarea')?.value.trim() || !!wrap?.querySelector('.cp-atts')?.children.length;
  }
  function rotationButton(col) {
    const b = button(SWAP, label(), openMenu);
    b.classList.add('claude-seat-rotate');
    b.disabled = switching;
    b.setAttribute('aria-haspopup', 'dialog');
    const seat = current(), info = seats.find((s) => s.id === seat.id);
    b.title = `${label()} · 当前 ${seat.name}${info?.maskedEmail ? ' · ' + info.maskedEmail : ''}`;
    return b;
  }
  async function refresh() {
    host.flushConfig();
    seats = await window.deck.claudeSeats();
    warmups = await window.deck.claudeWarmupStatus();
    await Promise.all(seats.map(async (info) => {
      const configured = host.config.claudeSeats.find((s) => s.id === info.id);
      if (!configured) return;
      window.QuotaCore.observe(host.config.quotas, { provider: 'Claude', scope: 'claude', seatId: info.id,
        at: Date.now(), identityOnly: true, configDir: configured.configDir, accountKey: info.accountKey, account: info.maskedEmail,
        credentialKey: info.credentialKey });
      const usage = await window.deck.claudeSeatUsage(info.id);
      if (usage) acceptUsage(info.id, usage);
    }));
    document.querySelectorAll('.claude-seat-rotate').forEach((b) => {
      const seat = current(), info = seats.find((s) => s.id === seat.id);
      b.title = `${label()} · 当前 ${seat.name}${info?.maskedEmail ? ' · ' + info.maskedEmail : ''}`;
      b.setAttribute('aria-label', label());
      b.disabled = switching;
    });
    return seats;
  }
  function dialog(id, title) {
    let d = document.getElementById(id);
    if (d) d.remove();
    d = node('dialog', 'seat-dialog'); d.id = id;
    const head = node('div', 'seat-dialog-head');
    head.append(node('h3', '', title), button(host.ICONS.close, '关闭', () => d.close()));
    d.append(head);
    d.addEventListener('keydown', (e) => e.stopPropagation());
    d.addEventListener('close', () => { const main = window.MainSession.mainCol(); if (main) host.jumpToColumn(main); });
    document.body.append(d);
    return d;
  }
  async function openMenu() {
    if (switching) return;
    try { await refresh(); } catch (_) { host.showToast('席位配置读取失败，请检查设置'); return; }
    const d = dialog('claudeSeatMenu', label());
    d.append(node('p', 'seat-current', `当前：${current().name}`));
    const choices = [...seats, { id: 'chatgpt', name: host.config.captainRelayCodex.name, icon: '', loggedIn: true }];
    for (const seat of choices) {
      const selected = seat.id === current().id;
      const b = node('button', 'seat-choice');
      const icon = node('span', 'seat-account-icon', seat.icon);
      if (seat.id === 'chatgpt') icon.innerHTML = window.AgentInfo.PROVIDER_ICONS.Codex;
      b.append(icon, node('span', '', `${seat.name}${selected ? ' · 当前' : seat.loggedIn ? '' : seat.loginReason ? ' · 需登录' : ' · 待核实'}`));
      b.type = 'button'; b.dataset.seatId = seat.id;
      b.setAttribute('aria-pressed', String(selected));
      b.title = seat.id === 'chatgpt' ? `${seat.name} · Codex GPT-6.1 Sol` : `${seat.name} · ${seat.loginReason || seat.authReason || seat.maskedEmail || '已登录'}`;
      b.disabled = !seat.loggedIn || selected;
      b.addEventListener('click', async () => { d.close(); await switchSeat(seat.id); });
      d.append(b);
    }
    const actions = node('div', 'seat-dialog-actions');
    actions.append(button(GEAR, '席位设置', () => { d.close(); openSettings(); }));
    d.append(actions);
    d.showModal();
  }
  async function openSettings() {
    try { await refresh(); } catch (_) { host.showToast('席位配置读取失败，请检查配置目录'); return; }
    const d = dialog('claudeSeatSettings', '设置 · 席位');
    const field = (title, value) => {
      const l = node('label', 'seat-field', title), input = node('input');
      input.value = value; l.append(input); return { l, input };
    };
    const name = field('切换功能名称', label()); d.append(name.l);
    const settings = P.normalizeSettings(host.config.perpetualCaptain);
    let enabled = settings.enabled;
    const toggleRow = node('div', 'perpetual-toggle-row');
    const toggle = button(POWER, '永动机自动轮换', () => {
      enabled = !enabled; toggle.setAttribute('aria-pressed', String(enabled)); threshold.input.disabled = !enabled;
    });
    toggle.id = 'perpetualEnabled'; toggle.setAttribute('aria-pressed', String(enabled));
    toggleRow.append(node('span', '', '永动机 · 自动轮换队长'), toggle); d.append(toggleRow);
    const threshold = field('5 小时剩余阈值（%）', settings.threshold);
    threshold.input.id = 'perpetualThreshold'; threshold.input.type = 'number'; threshold.input.min = '0';
    threshold.input.max = '100'; threshold.input.step = '0.1'; threshold.input.required = true; threshold.input.disabled = !enabled;
    d.append(threshold.l, node('p', 'seat-help', '仅在队长空闲时轮换；没有已确认可用的 Claude 席位时交给 Codex，新采样确认恢复后优先回 Claude。同一席位 10 分钟内不回切。'));
    let preferEarlier = settings.preferEarlier;
    const priorityRow = node('div', 'perpetual-toggle-row');
    const priorityToggle = button(POWER, '优先用快到期的席位', () => {
      preferEarlier = !preferEarlier; priorityToggle.setAttribute('aria-pressed', String(preferEarlier));
    });
    priorityToggle.id = 'preferEarlierSeat'; priorityToggle.setAttribute('aria-pressed', String(preferEarlier));
    priorityRow.append(node('span', '', '优先用快到期的席位'), priorityToggle); d.append(priorityRow);
    let warmupEnabled = window.QuotaWarmupCore.normalizeSettings(host.config.quotaWarmup).enabled;
    const warmupRow = node('div', 'perpetual-toggle-row');
    const warmupToggle = button(POWER, '额度窗口预热', () => {
      warmupEnabled = !warmupEnabled; warmupToggle.setAttribute('aria-pressed', String(warmupEnabled));
    });
    warmupToggle.id = 'quotaWarmupEnabled'; warmupToggle.setAttribute('aria-pressed', String(warmupEnabled));
    warmupRow.append(node('span', '', '额度窗口预热'), warmupToggle); d.append(warmupRow);
    d.append(node('p', 'seat-help', '已知 5 小时窗口重置约 1 分钟后，空闲席位后台发一个字母请求；正在用的队长空闲时也可补一次。每周额度不足或未知不预热，每窗一次，失败仅重试一次。'));
    const bark = field('Bark 密钥文件路径', host.config.barkKeyFile || '');
    bark.input.id = 'perpetualBarkKeyFile'; d.append(bark.l);
    const fields = host.config.claudeSeats.map((s) => {
      const row = node('section', 'seat-setting-row'), info = seats.find((i) => i.id === s.id);
      row.dataset.seatId = s.id;
      row.append(node('strong', '', `${s.name} · ${info?.loggedIn ? '已登录' : '未登录'}`));
      row.title = info?.maskedEmail || '尚未登录';
      const seatName = field('席位名称', s.name), icon = field('席位图标', s.icon), dir = field('配置目录', s.configDir);
      row.append(seatName.l, icon.l, dir.l); d.append(row);
      return { id: s.id, name: seatName.input, icon: icon.input, dir: dir.input };
    });
    d.append(node('p', 'seat-help', '每个席位只需在普通终端登录一次。共享技能、设置、记忆和对话，登录与额度各自独立。'));
    const actions = node('div', 'seat-dialog-actions');
    actions.append(button(ROTATE, '刷新登录状态', () => { d.close(); openSettings(); }));
    const save = node('button', 'btn primary', '保存设置'); save.type = 'button';
    save.addEventListener('click', async () => {
      if (enabled && !threshold.input.reportValidity()) return;
      try {
        const updated = await window.deck.validateClaudeSeats(fields.map((f) => ({ id: f.id, name: f.name.value.trim(), icon: f.icon.value.trim(), configDir: f.dir.value.trim() })));
        host.config.claudeSeats = updated;
        host.config.perpetualCaptain = P.normalizeSettings({ enabled, threshold: Number(threshold.input.value), preferEarlier, order: settings.order });
        host.config.quotaWarmup = window.QuotaWarmupCore.normalizeSettings({ enabled: warmupEnabled });
        host.config.barkKeyFile = bark.input.value.trim();
        retryAt = 0;
        if (enabled && window.MainSession.state()) delete window.MainSession.state().relayStartup;
        host.config.captainRelayLabel = name.input.value.trim().slice(0, 80) || 'Relay';
        host.flushConfig(); d.close(); await refresh(); window.Sidebar.render();
      } catch (_) { host.showToast('保存失败：请使用不同的独立配置目录，不能链接登录文件'); }
    });
    actions.append(save); d.append(actions); d.showModal();
  }
  async function switchSeat(id, options = {}) {
    if (switching) return false;
    const col = window.MainSession.mainCol();
    if (!col || id === current().id) return false;
    if (options.automatic && !options.startupRetry && !window.MainSession.relayIdle()) return false;
    if (hasDraft(col)) { host.showToast(`队长输入框里有未发送内容，发送或清空后再${label()}`); return false; }
    switching = true;
    window.MainSession.pauseForSeatSwitch(true);
    try {
      await refresh();
      const target = id === 'chatgpt' ? { id, loggedIn: true } : seats.find((s) => s.id === id);
      if (!target?.loggedIn) { host.showToast(`${target?.name || id}：${target?.loginReason || target?.authReason || '席位不存在'}${target?.loginReason ? '，请在此席位配置目录下登录' : ''}`); return false; }
      if (window.MainSession.mainCol() !== col || hasDraft(col)) return false;
      let decision = options.decision;
      if (options.automatic || options.validateRotation) {
        decision = options.startupRetry ? startupRetryDecision() : options.validateRotation ? quotaRotationDecision() : rotationDecision(false, true);
        // The quota banner offers Claude seats only; automatic exhaustion
        // fallback must still be allowed to hand off to Codex.
        if (decision?.targetId !== id || (options.validateRotation && decision.targetId === P.CODEX_ID)) return false;
      }
      const from = current(), at = Date.now();
      const message = rotationMessage(from.name, id === 'chatgpt' ? host.config.captainRelayCodex.name : target.name, decision, at, options.automatic);
      const snapshot = { colId: col.id, chat: window.ChatUI.snapshotForHandoff(col.id), tasks: window.MainSession.state().tasks, relayMessage: message };
      const board = window.MainSession.checkpointForSeatSwitch
        ? await window.MainSession.checkpointForSeatSwitch(snapshot, { local: options.automatic })
        : await window.deck.captainCheckpoint(snapshot);
      if (window.MainSession.mainCol() !== col || hasDraft(col)) return false;
      if (typeof board !== 'string' || !board) throw new Error('checkpoint failed');
      if ((options.automatic || options.validateRotation) && (options.startupRetry ? startupRetryDecision() : options.validateRotation ? quotaRotationDecision() : rotationDecision(false, true))?.targetId !== id) return false;
      const wasClaude = isClaude(col);
      if (wasClaude) host.config.captainRelayClaudeCommand = col.cmd;
      const configuredCodex = host.config.captainRelayCodex.command;
      const codexCommand = options.automatic ? S.relayCodexCommand(configuredCodex, window.MainSession.relayEffort()) : configuredCodex;
      const command = id === 'chatgpt' ? codexCommand
        : wasClaude ? col.cmd : host.config.captainRelayClaudeCommand || S.CLAUDE_COMMAND;
      const fresh = window.MainSession.clearContext({ seatId: id === 'chatgpt' ? col.claudeSeatId || S.active(host.config).id : id, checkpointPath: board, command, relayTargetId: id, relayMessage: message, automatic: options.automatic });
      if (!fresh) throw new Error('captain spawn failed');
      host.config.perpetualCaptainState = P.recordSwitch(host.config.perpetualCaptainState, { fromId: from.id, targetId: id, reason: decision?.reason || 'manual', at });
      window.MainSession.state().relayRecord = { message, at };
      window.ChatUI.addNotice(fresh.id, message, at);
      showRotationBanner(host.terms.get(fresh.id));
      host.flushConfig();
      window.deck.captainRelayNotify(fresh.id, message).then((r) => { if (!r.ok) host.showToast(r.message); }).catch(() => host.showToast('轮换已完成，Bark 提醒发送失败'));
      window.dispatchEvent(new CustomEvent('claude-seat-changed', { detail: { seatId: id } }));
      return true;
    } catch (_) {
      options.failed = true;
      host.showToast('进度存档或队长启动失败，请检查看板和对话目录'); return false;
    } finally {
      switching = false; window.MainSession.pauseForSeatSwitch(false);
      refresh().catch(() => {});
    }
  }
  function acceptUsage(seatId, usage) {
    const sample = window.QuotaCore.cacheClaude(usage, usage.at);
    if (sample && usage.accountBound && window.QuotaCore.observe(host.config.quotas, {
      ...sample, credentialKey: seats.find((s) => s.id === seatId)?.credentialKey, source: sample.official ? sample.source : 'Claude 席位本地用量缓存', confidence: '高（原生用量及账号归属已验证）', seatId, accountBound: true, accountKey: usage.accountKey,
      configDir: usage.configDir, sourceColumnId: usage.sourceColumnId,
    })) host.flushConfig();
  }
  function rotationContext() {
    const now = Date.now(), settings = P.normalizeSettings(host.config.perpetualCaptain);
    const candidates = seats.map((info) => {
      const configured = host.config.claudeSeats.find((s) => s.id === info.id);
      let state = P.observe(host.config.perpetualCaptainState, { seatId: info.id, accountKey: info.accountKey, configDir: configured?.configDir }, now);
      const q = P.seatQuota(host.config.quotas[window.QuotaCore.seatKey(info.id)], { ...info, configuredDir: configured?.configDir,
        officialNotBefore: state.seats[info.id]?.officialNotBefore }, now);
      if (q.exhausted) state = P.observe(state, { seatId: info.id, at: q.exhaustedAt, exhausted: true, resetAt: q.exhaustedResetAt }, now);
      if (q.trusted) state = P.observe(state, { seatId: info.id, at: q.remainingAt, remainingAt: q.remainingAt, remaining: q.remaining, trusted: true, resetAt: q.resetAt, threshold: settings.threshold }, now);
      if (q.weeklyTrusted) state = P.observe(state, { seatId: info.id, at: q.weeklyRemainingAt,
        weeklyTrusted: true, weeklyRemaining: q.weeklyRemaining, weeklyRemainingAt: q.weeklyRemainingAt, weeklyResetAt: q.weeklyResetAt, threshold: settings.threshold }, now);
      if (q.resumedAt) state = P.observe(state, { seatId: info.id, at: q.resumedAt, resumed: true }, now);
      host.config.perpetualCaptainState = state;
      const loginScreen = host.columns().some((col) => col.claudeSeatId === info.id &&
        /select\s+login\s+method/i.test(host.terms.get(col.id)?.lastScreen || ''));
      return { id: info.id, loggedIn: info.loggedIn,
        onboardingComplete: info.onboardingComplete !== false && !loginScreen,
        ...q };
    });
    return { settings, state: host.config.perpetualCaptainState, currentId: current().id, seats: candidates, now };
  }
  function rotationDecision(checkSwitching = true, checkBusy = true) {
    return P.decide({ ...rotationContext(), busy: checkBusy && !window.MainSession.relayIdle(), switching: checkSwitching && switching });
  }
  function quotaRotationDecision() {
    const context = rotationContext();
    return P.decide({ ...context, settings: { ...context.settings, enabled: true } });
  }
  function rotationMessage(from, to, decision, at, automatic) {
    const reasons = { 'threshold': `5 小时剩余 ${decision?.remaining}% ≤ ${host.config.perpetualCaptain.threshold}%`,
      'weekly-threshold': `每周剩余 ${decision?.remaining}% ≤ ${host.config.perpetualCaptain.threshold}%`,
      'quota-exhausted': '当前席位额度用尽或限流', 'claude-unavailable': '没有已确认可用的 Claude 席位', 'claude-recovered': 'Claude 席位额度已恢复',
      'startup-onboarding': '席位仍停在首次启动引导，跳过该席位',
      'startup-retry': '新队长未能在 3 分钟内接续，尝试下一可用席位',
      'earlier-reset': '优先用还有余额、快到期的席位' };
    return `${automatic ? '永动机自动轮换' : label()}：${from} → ${to}；${reasons[decision?.reason] || '手动切换'}；${new Date(at).toLocaleString()}`;
  }
  function showRotationBanner(entry) {
    const record = window.MainSession.state()?.relayRecord;
    if (!entry?.wrap || !record) return;
    let banner = entry.wrap.querySelector('.perpetual-relay-banner');
    if (!banner) {
      banner = node('div', 'seat-quota-banner perpetual-relay-banner'); banner.setAttribute('role', 'status');
      entry.wrap.querySelector('.col-head').after(banner);
    }
    banner.textContent = record.message;
  }
  function recoveryLabel(at) {
    return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  }
  function renderQuotaBanner(entry, action) {
    let banner = entry.wrap.querySelector('.seat-quota-banner:not(.perpetual-relay-banner)');
    if (entry.state !== 'quota') { banner?.remove(); return; }
    if (!banner) {
      banner = node('div', 'seat-quota-banner'); banner.setAttribute('role', 'status');
      banner.append(node('span', 'quota-message', ''));
      const actionButton = button(ROTATE, '', () => {
        const context = rotationContext(), selected = P.quotaAction(context);
        if (selected.targetId) switchSeat(selected.targetId, { validateRotation: true });
      });
      actionButton.classList.add('quota-seat-action');
      banner.append(actionButton);
      entry.wrap.querySelector('.col-head').after(banner);
    }
    const message = banner.querySelector('.quota-message'), actionButton = banner.querySelector('.quota-seat-action');
    const selected = action.targetId && host.config.claudeSeats.find((seat) => seat.id === action.targetId);
    if (selected) {
      message.textContent = `${current().name}额度用尽，下一可用席位 ${selected.name}`;
      actionButton.disabled = false;
      actionButton.title = `${label()}到${selected.name}`;
      actionButton.setAttribute('aria-label', actionButton.title);
    } else {
      const recovery = action.recoveryAt ? `；最早恢复 ${recoveryLabel(action.recoveryAt)}` : '；最早恢复时间未知';
      message.textContent = `${current().name}额度用尽，没有可用席位${recovery}`;
      actionButton.disabled = true;
      actionButton.title = message.textContent;
      actionButton.setAttribute('aria-label', '没有可用席位');
    }
  }
  function onTick(id, entry, text) {
    const col = host.columns().find((c) => c.id === id);
    if (!col) return;
    if (col.isMain) document.querySelectorAll('.claude-seat-rotate').forEach((b) => { b.disabled = switching; });
    const usage = S.usage(text, entry.lastOutputAt || Date.now()), seatId = col.claudeSeatId || S.active(host.config).id;
    if (usage && isClaude(col)) {
      const key = JSON.stringify([col.id, col.claudeConfigDir, usage.windows]);
      if (recorded.get(seatId) !== key) {
        recorded.set(seatId, key);
        host.flushConfig();
        window.deck.recordClaudeSeatUsage(col.id, seatId, col.claudeConfigDir, usage).then(() => window.deck.claudeSeatUsage(col.claudeSeatId)).then((bound) => { if (bound) acceptUsage(col.claudeSeatId, bound); window.dispatchEvent(new CustomEvent('claude-seat-usage')); }).catch(() => { recorded.delete(seatId); });
      }
    }
    // Keyed per column: an idle session's unchanged statusline is never
    // re-stamped as a fresh sample of its seat.
    const footer = entry.alive && isClaude(col) && S.footerUsage((entry.footerLines || []).map((line) => line.map((s) => s.text).join('')));
    if (footer && col.claudeSeatId && col.claudeConfigDir) {
      const key = col.claudeSeatId + ':' + JSON.stringify(footer.windows);
      if (recorded.get(col.id) !== key) {
        recorded.set(col.id, key);
        host.flushConfig();
        window.deck.recordClaudeSeatUsage(col.id, col.claudeSeatId, col.claudeConfigDir, footer).then(() => window.deck.claudeSeatUsage(col.claudeSeatId)).then((bound) => { if (bound) acceptUsage(col.claudeSeatId, bound); window.dispatchEvent(new CustomEvent('claude-seat-usage')); }).catch(() => { recorded.delete(col.id); });

      }
    }
    if (!col.isMain || !entry.wrap) return;
    showRotationBanner(entry);
    const provider = window.MainSession.state()?.relayTargetId === 'chatgpt' ? 'Codex' : window.AgentInfo.resolveAgentInfo(col, entry).provider;
    if (!['Claude', 'Codex'].includes(provider)) return;
    if (provider === 'Claude') window.deck.claudeWarmupIdle(col.id, !switching && window.MainSession.relayIdle()).catch(() => {});
    renderQuotaBanner(entry, P.quotaAction(rotationContext()));
    automaticTick().catch(() => {});
  }
  function codexUnavailable() {
    return window.QuotaCore.commandQuota(host.config.quotas, 'codex', host.config.claudeSeats)?.out === true;
  }
  function startupRetryDecision() {
    const context = rotationContext(), startup = window.MainSession.state()?.relayStartup;
    const failed = new Set(startup?.failures || []);
    if (startup?.stopped || !failed.size) return null;
    const ordered = P.orderSeats(context.seats, context.settings.order);
    const index = ordered.findIndex((seat) => seat.id === context.currentId);
    const circle = index < 0 ? ordered : ordered.slice(index + 1).concat(ordered.slice(0, index));
    const next = circle.find((seat) => !failed.has(seat.id) && seat.id !== context.currentId &&
      P.status(seat, context.state.seats[seat.id], context.settings.threshold, context.now).available);
    const targetId = next?.id || (context.currentId !== P.CODEX_ID && !failed.has(P.CODEX_ID) && !codexUnavailable() ? P.CODEX_ID : null);
    return targetId ? { targetId, reason: 'startup-retry', at: context.now } : null;
  }
  async function refreshUnknownQuota() {
    const context = rotationContext();
    const unknown = context.seats.filter((seat) => {
      const check = P.status(seat, context.state.seats[seat.id], context.settings.threshold, context.now);
      return seat.loggedIn && (!check.trusted || !check.weeklyTrusted) &&
        context.now - (quotaRefreshAt.get(seat.id) || 0) >= 60_000;
    });
    await Promise.all(unknown.map(async (seat) => {
      quotaRefreshAt.set(seat.id, context.now);
      try {
        for (const sample of await window.deck.quotaRefresh(seat.id)) window.QuotaCore.observe(host.config.quotas, sample);
      } catch (_) { /* Unknown remains ineligible; confirmed seats can proceed. */ }
    }));
    if (unknown.length) host.flushConfig();
  }
  async function stopRotation(reason) {
    const state = window.MainSession.state();
    const notified = state.relayStartup?.notified === true;
    state.relayStartup = { ...window.RelayStartupCore.normalize(state.relayStartup), attempt: null, stopped: true, reason, notified };
    host.flushConfig();
    const message = `永动机已停止：${reason}。请检查队长；处理后可手动 Relay 或在席位设置重新开启永动机。`;
    host.showToast(message);
    // Persist before sending: subsequent ticks/restarts must not spam the phone.
    if (state.relayStartup.notified) return;
    state.relayStartup.notified = true; host.flushConfig();
    try {
      const result = await window.deck.captainRelayNotify(state.colId, message, true);
      if (!result.ok || /失败|跳过/.test(result.message || '')) host.showToast(result.message);
    } catch (_) { host.showToast('永动机已停止，紧急提醒发送失败，请检查通知设置'); }
  }
  async function automaticTick() {
    if (automaticRunning || switching || !P.normalizeSettings(host.config.perpetualCaptain).enabled) return;
    const col = window.MainSession.mainCol(), state = window.MainSession.state();
    if (!col || !state) return;
    automaticRunning = true;
    try {
      if (state.relayStartup?.stopped) {
        if (!state.relayStartup.notified) await stopRotation(state.relayStartup.reason || '队长启动失败');
        return;
      }
      const R = window.RelayStartupCore, entry = host.terms.get(col.id);
      const startup = state.relayStartup;
      if (startup?.attempt) {
        const activity = window.MainCore?.terminalActivity(entry?.lastScreen, col.cmd);
        const result = R.check(startup, { colId: col.id, now: Date.now(),
          quota: entry?.state === 'quota' || activity === 'quota', exited: entry?.alive === false,
          promptSent: startup.attempt.promptSent,
          output: startup.attempt.output || (startup.attempt.promptSent && !entry?.sendingPrompt && !entry?.injecting &&
            (activity === 'working' || entry?.state === 'working' || /^\s*[⏺●•]\s+\S/m.test(entry?.lastScreen || '')) &&
            entry?.lastOutputAt > (startup.attempt.promptSentAt || startup.attempt.at)) });
        if (JSON.stringify(result.state) !== JSON.stringify(startup)) { state.relayStartup = result.state; host.flushConfig(); }
        if (result.action === 'stop') { await stopRotation('连续 3 次队长启动失败'); return; }
        if (result.action === 'waiting') return;
      }
      if (!state.relayStartup?.attempt && current().id === P.CODEX_ID &&
        (entry?.state === 'quota' || codexUnavailable()) && !state.relayStartup?.failures?.length) {
        state.relayStartup = R.fail(R.begin({}, { colId: col.id, targetId: P.CODEX_ID, at: Date.now() }), 'quota').state;
        host.flushConfig();
      }
      const retry = !!state.relayStartup?.failures?.length;
      if (!retry && !window.MainSession.relayIdle()) return;
      if (hasDraft(col)) { if (retry) await stopRotation('队长启动失败，但输入框有未发送内容，无法安全重试'); return; }
      await refreshUnknownQuota();
      if (window.MainSession.mainCol() !== col) return;
      const before = JSON.stringify(host.config.perpetualCaptainState);
      const decision = retry ? startupRetryDecision() : rotationDecision();
      if (before !== JSON.stringify(host.config.perpetualCaptainState)) host.flushConfig();
      if (retry && !decision) { await stopRotation('没有剩余可用席位，Codex 也不可用'); return; }
      if (!decision || Date.now() < retryAt) return;
      if (decision.targetId === P.CODEX_ID && codexUnavailable()) { await stopRotation('Claude 席位都不可用，Codex 额度也已用尽'); return; }
      const options = { automatic: true, startupRetry: retry, decision };
      const ok = await switchSeat(decision.targetId, options);
      if (!ok && window.MainSession.mainCol() === col && window.MainSession.state() === state && options.failed) {
        // A failed checkpoint/spawn is also a failed attempt; never retry forever.
        const pending = R.begin(state.relayStartup, { colId: col.id, targetId: decision.targetId, at: Date.now() });
        const failed = R.fail(pending, '轮换存档或启动失败');
        state.relayStartup = failed.state; host.flushConfig();
        if (failed.action === 'stop') await stopRotation('连续 3 次队长启动失败');
        else retryAt = Date.now() + 1500;
      } else if (!ok) retryAt = Date.now() + 60_000;
    } finally { automaticRunning = false; }
  }

  function init(h) {
    host = h;
    document.getElementById('claudeSeatsSettings').innerHTML = GEAR;
    document.getElementById('claudeSeatsSettings').addEventListener('click', () => {
      document.getElementById('notificationSettings').close(); openSettings();
    });
    refresh().catch(() => {});
    // Slower on battery (BatteryCore.POLL); a page without BatteryCore keeps the fixed periods.
    const every = (key, fn, ms) => window.BatteryCore ? window.BatteryCore.shared.every(key, fn) : setInterval(fn, ms);
    every('claudeSeatsRefresh', () => refresh().catch(() => {}), 30_000);
    // Independent of a live PTY/status tick: crashed or unstarted Captains need the watchdog too.
    every('claudeSeatsWatchdog', () => automaticTick().catch(() => {}), 1500);
  }
  function warmupDetail(seatId) {
    const entry = warmups.find((s) => s.seatId === seatId);
    let detail = entry?.status === 'abandoned' ? '\n预热失败 · 本窗口已放弃' : entry?.status === 'retry' ? '\n预热失败 · 等待仅一次重试' : '';
    const reset = entry?.newResetAt > Date.now() ? new Date(entry.newResetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '未知';
    if (!detail && entry?.warmAt) detail = `\n已预热 · 下次重置 ${reset}`;
    const now = Date.now();
    const candidates = seats.map((info) => ({ ...info, ...P.seatQuota(host.config.quotas?.[window.QuotaCore.seatKey(info.id)],
      { ...info, configuredDir: host.config.claudeSeats.find((s) => s.id === info.id)?.configDir }, now) }));
    return detail + '\n' + P.strategyText({ settings: host.config.perpetualCaptain, state: host.config.perpetualCaptainState, currentId: current().id, seats: candidates, warmups, now });
  }
  window.ClaudeSeats = { init, rotationButton, openMenu, openSettings, switchSeat, onTick, refresh, warmupDetail, automaticTick };
})();
