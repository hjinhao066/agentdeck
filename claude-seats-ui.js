(function () {
  'use strict';
  const S = window.ClaudeSeatsCore;
  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ROTATE = svg('<path d="M20 7h-5V2M4 17h5v5"/><path d="M20 7a9 9 0 0 0-15-3M4 17a9 9 0 0 0 15 3"/>');
  const GEAR = svg('<circle cx="12" cy="12" r="3"/><path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/>');
  let host, seats = [], switching = false;
  const recorded = new Map();
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
  function currentClaudeModel(col) {
    const cmd = current().id === 'chatgpt' ? host.config.captainRelayClaudeCommand : col?.cmd;
    if (/claude-sonnet-5-5/.test(String(cmd || ''))) return 'sonnet';
    return 'opus';
  }
  function relaySeats() {
    // Before the first login refresh, keep offering configured seats. After it,
    // a seat that is not logged in is not a quota hop.
    if (!seats.length) return host.config.claudeSeats.map((seat) => ({ id: seat.id, name: seat.name, icon: seat.icon, loggedIn: true }));
    return host.config.claudeSeats.map((seat) => {
      const info = seats.find((item) => item.id === seat.id);
      return { id: seat.id, name: seat.name, icon: seat.icon, loggedIn: !!info?.loggedIn };
    });
  }
  function sameTarget(id, model, col) {
    if (id !== current().id) return false;
    if (!model || id === 'chatgpt') return true;
    return model === currentClaudeModel(col);
  }
  function hasDraft(col) {
    const wrap = host.terms.get(col.id)?.wrap;
    return host.userComposing(col.id) || !!wrap?.querySelector('.composer textarea')?.value.trim() || !!wrap?.querySelector('.cp-atts')?.children.length;
  }
  function rotationButton(col) {
    const b = button(ROTATE, label(), openMenu);
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
    const here = current();
    const modelNow = here.id === 'chatgpt' ? '' : currentClaudeModel(window.MainSession.mainCol());
    d.append(node('p', 'seat-current', `当前：${here.name}${modelNow ? ' · ' + (modelNow === 'sonnet' ? 'Sonnet 5.5' : 'Opus 5.5') : ''}`));
    for (const seat of seats) {
      for (const model of ['opus', 'sonnet']) {
        const selected = seat.id === here.id && model === modelNow;
        const modelName = model === 'sonnet' ? 'Sonnet 5.5' : 'Opus 5.5';
        const b = node('button', 'seat-choice');
        b.append(node('span', 'seat-account-icon', seat.icon), node('span', '', `${seat.name} · ${modelName}${selected ? ' · 当前' : seat.loggedIn ? '' : ' · 未登录'}`));
        b.type = 'button';
        b.dataset.relayModel = model;
        if (model === 'sonnet') b.dataset.relaySeat = seat.id;
        else b.dataset.seatId = seat.id;
        b.setAttribute('aria-pressed', String(selected));
        b.title = model === 'sonnet'
          ? `${seat.name} · Sonnet 5.5 · ${seat.maskedEmail || '尚未登录'}`
          : `${seat.name} · ${seat.maskedEmail || '尚未登录'}`;
        b.disabled = !seat.loggedIn || selected;
        b.addEventListener('click', async () => { d.close(); await switchSeat(seat.id, { model }); });
        d.append(b);
      }
    }
    const codex = { id: 'chatgpt', name: host.config.captainRelayCodex.name, loggedIn: true };
    const codexSelected = here.id === 'chatgpt';
    const codexButton = node('button', 'seat-choice');
    const codexIcon = node('span', 'seat-account-icon', '');
    codexIcon.innerHTML = window.AgentInfo.PROVIDER_ICONS.Codex;
    codexButton.append(codexIcon, node('span', '', `${codex.name}${codexSelected ? ' · 当前' : ''}`));
    codexButton.type = 'button';
    codexButton.dataset.seatId = 'chatgpt';
    codexButton.setAttribute('aria-pressed', String(codexSelected));
    codexButton.title = `${codex.name} · Codex GPT-6.1 Sol`;
    codexButton.disabled = codexSelected;
    codexButton.addEventListener('click', async () => { d.close(); await switchSeat('chatgpt'); });
    d.append(codexButton);
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
      try {
        const updated = await window.deck.validateClaudeSeats(fields.map((f) => ({ id: f.id, name: f.name.value.trim(), icon: f.icon.value.trim(), configDir: f.dir.value.trim() })));
        host.config.claudeSeats = updated;
        host.config.captainRelayLabel = name.input.value.trim().slice(0, 80) || 'Relay';
        host.flushConfig(); d.close(); await refresh(); window.Sidebar.render();
      } catch (_) { host.showToast('保存失败：请使用不同的独立配置目录，不能链接登录文件'); }
    });
    actions.append(save); d.append(actions); d.showModal();
  }
  async function switchSeat(id, options = {}) {
    if (switching) return false;
    const col = window.MainSession.mainCol();
    const model = options.model === 'sonnet' || options.model === 'opus' ? options.model : '';
    if (!col || sameTarget(id, model, col)) return false;
    if (hasDraft(col)) { host.showToast(`队长输入框里有未发送内容，发送或清空后再${label()}`); return false; }
    switching = true;
    window.MainSession.pauseForSeatSwitch(true);
    try {
      await refresh();
      const target = id === 'chatgpt' ? { id, loggedIn: true } : seats.find((s) => s.id === id);
      if (!target?.loggedIn) { host.showToast('这个席位尚未登录，请先在普通终端登录一次'); return false; }
      if (window.MainSession.mainCol() !== col || hasDraft(col) || sameTarget(id, model, col)) return false;
      // Token-saver integration point. The sibling branch can plug in its
      // confirmed board archive; quota exhaustion uses the durable local fallback.
      const snapshot = { colId: col.id, chat: window.ChatUI.snapshotForHandoff(col.id), tasks: window.MainSession.state().tasks };
      const board = window.MainSession.checkpointForSeatSwitch
        ? await window.MainSession.checkpointForSeatSwitch(snapshot)
        : await window.deck.captainCheckpoint(snapshot);
      if (typeof board !== 'string' || !board || window.MainSession.mainCol() !== col || hasDraft(col)) return false;
      const wasClaude = isClaude(col);
      const base = wasClaude ? col.cmd : host.config.captainRelayClaudeCommand || S.CLAUDE_COMMAND;
      const command = id === 'chatgpt' ? host.config.captainRelayCodex.command : model ? S.relayModelCommand(model, base) : base;
      if (id === 'chatgpt') { if (wasClaude) host.config.captainRelayClaudeCommand = col.cmd; }
      else if (model) host.config.captainRelayClaudeCommand = command;
      else if (wasClaude) host.config.captainRelayClaudeCommand = col.cmd;
      window.MainSession.clearContext({ seatId: id === 'chatgpt' ? col.claudeSeatId || S.active(host.config).id : id, checkpointPath: board, command, relayTargetId: id });
      host.flushConfig();
      window.dispatchEvent(new CustomEvent('claude-seat-changed', { detail: { seatId: id } }));
      return true;
    } catch (_) {
      host.showToast('进度存档失败，原队长继续运行，请检查看板和对话目录'); return false;
    } finally {
      switching = false; window.MainSession.pauseForSeatSwitch(false);
      refresh().catch(() => {});
    }
  }
  function onTick(id, entry, text) {
    const col = host.columns().find((c) => c.id === id);
    if (!col) return;
    if (col.isMain) document.querySelectorAll('.claude-seat-rotate').forEach((b) => { b.disabled = switching; });
    const usage = S.usage(text), seatId = col.claudeSeatId || S.active(host.config).id;
    if (usage && isClaude(col)) {
      const key = JSON.stringify(usage.windows);
      if (recorded.get(seatId) !== key) {
        recorded.set(seatId, key);
        window.deck.recordClaudeSeatUsage(seatId, usage, col.claudeConfigDir).then(() => window.dispatchEvent(new CustomEvent('claude-seat-usage'))).catch(() => { recorded.delete(seatId); });
      }
    }
    // Keyed per column: an idle session's unchanged statusline is never
    // re-stamped as a fresh sample of its seat.
    const footer = entry.alive && isClaude(col) && S.footerUsage((entry.footerLines || []).map((line) => line.map((s) => s.text).join('')));
    if (footer && col.claudeSeatId && col.claudeConfigDir) {
      const key = col.claudeSeatId + ':' + JSON.stringify(footer.windows);
      if (recorded.get(col.id) !== key) {
        recorded.set(col.id, key);
        window.deck.recordClaudeSeatUsage(col.claudeSeatId, footer, col.claudeConfigDir).then(() => window.dispatchEvent(new CustomEvent('claude-seat-usage'))).catch(() => { recorded.delete(col.id); });
      }
    }
    if (!col.isMain || !entry.wrap) return;
    let banner = entry.wrap.querySelector('.seat-quota-banner');
    if (entry.state !== 'quota') { if (banner) banner.remove(); return; }
    const provider = window.AgentInfo.resolveAgentInfo(col, entry).provider;
    if (!['Claude', 'Codex'].includes(provider)) { if (banner) banner.remove(); return; }
    // Manual only. Quota exhaustion does not switch by itself; the button
    // offers the next logged-in captain (other Claude seat, then Codex).
    paintQuotaBanner(entry, quotaBannerView(col, provider));
  }
  function quotaBannerView(col, provider) {
    const onCodex = provider === 'Codex' || current().id === 'chatgpt';
    const currentId = onCodex ? 'chatgpt' : (col.claudeSeatId || current().id);
    const exhausted = new Set([currentId]);
    const now = Date.now();
    for (const seat of host.config.claudeSeats) {
      if (window.QuotaCore.summary(host.config.quotas, 'Claude', now, seat).state === 'exhausted') exhausted.add(seat.id);
    }
    if (window.QuotaCore.summary(host.config.quotas, 'Codex', now).state === 'exhausted') exhausted.add('chatgpt');
    const next = S.nextRelayTarget({ seats: relaySeats(), codexName: host.config.captainRelayCodex.name, currentId, model: currentClaudeModel(col), exhaustedIds: [...exhausted] });
    if (!next) return { message: '队长额度都用尽了', action: null };
    const who = [next.icon, next.name].filter(Boolean).join(' ');
    const text = `切到 ${who}`;
    return {
      message: `${current().name}额度用尽`,
      action: { key: next.kind === 'codex' ? 'chatgpt' : `${next.id}:${next.model}`, label: text, run: () => switchSeat(next.id, next.model ? { model: next.model } : {}) },
    };
  }
  function paintQuotaBanner(entry, view) {
    let banner = entry.wrap.querySelector('.seat-quota-banner');
    if (!banner) {
      banner = node('div', 'seat-quota-banner');
      banner.setAttribute('role', 'status');
      entry.wrap.querySelector('.col-head').after(banner);
    }
    let span = banner.querySelector('.seat-quota-text');
    if (!span) banner.prepend(span = node('span', 'seat-quota-text'));
    if (span.textContent !== view.message) span.textContent = view.message;
    const button = banner.querySelector('.seat-quota-switch');
    if (!view.action) { button?.remove(); return; }
    if (button && button.dataset.target === view.action.key && button.textContent === view.action.label) return;
    button?.remove();
    const change = node('button', 'seat-quota-switch', view.action.label);
    change.type = 'button';
    change.dataset.target = view.action.key;
    change.title = view.action.label;
    change.setAttribute('aria-label', view.action.label);
    change.addEventListener('click', (e) => { e.stopPropagation(); view.action.run(); });
    banner.append(change);
  }
  function init(h) {
    host = h;
    document.getElementById('claudeSeatsSettings').innerHTML = GEAR;
    document.getElementById('claudeSeatsSettings').addEventListener('click', () => {
      document.getElementById('notificationSettings').close(); openSettings();
    });
    refresh().catch(() => {});
    setInterval(() => refresh().catch(() => {}), 30_000);
  }
  window.ClaudeSeats = { init, rotationButton, openMenu, openSettings, switchSeat, onTick, refresh };
})();
