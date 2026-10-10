// Sidebar "两机" status. The renderer never opens the sync socket; it only
// draws the snapshot the main process already fetched.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FleetUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const FIELD_LABELS = { title: '标题', detail: '说明', status: '状态', flag: '标记', assignee: '负责人', archived: '归档', order: '顺序', depends_on: '依赖', verify: '验收', important: '重要', latest_receipt: '回执', session_id: '会话' };

  function formatLastSeen(iso, now) {
    const seen = Date.parse(iso || '');
    if (!Number.isFinite(seen)) return '时间未知';
    const age = Math.max(0, now - seen);
    if (age < 45_000) return '刚刚';
    if (age < 3_600_000) return Math.floor(age / 60_000) + ' 分钟前';
    if (age < 86_400_000) return Math.floor(age / 3_600_000) + ' 小时前';
    if (age < 30 * 86_400_000) return Math.floor(age / 86_400_000) + ' 天前';
    const d = new Date(seen);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  function deviceLabel(device) {
    if (device && device.name) return device.name;
    if (device && device.platform === 'darwin') return 'Mac';
    if (device && device.platform === 'win32') return 'Windows';
    return '电脑';
  }
  // The one-line summary names each computer by its kind (Mac / Windows); two of the same
  // kind fall back to their own names. The full name is in the detail.
  function shortLabels(devices) {
    const kind = (d) => (d && d.platform === 'darwin' ? 'Mac' : d && d.platform === 'win32' ? 'Windows' : '');
    const kinds = devices.map(kind);
    return devices.map((d, i) => (kinds[i] && kinds.indexOf(kinds[i]) === kinds.lastIndexOf(kinds[i]) ? kinds[i] : deviceLabel(d)));
  }
  // What the summary line says after the computers: only what needs a look.
  function lineState(notice, kind, conflictCount) {
    if (kind === 'error') return notice.split('：')[0];
    if (kind === 'warn') return `${conflictCount} 处冲突`;
    if (notice === '两机同步未配置') return '未配置';
    if (notice === '正在连接两机同步…') return '连接中…';
    return notice;
  }
  function preview(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 80 ? text.slice(0, 80) + '…' : text;
  }
  function conflictText(card) {
    const parts = [];
    for (const item of (card && card.conflicts) || []) {
      for (const [key, value] of Object.entries(item && item.fields || {})) {
        parts.push(`${FIELD_LABELS[key] || key}：保留「${preview(value.kept)}」，另一份「${preview(value.other)}」`);
      }
    }
    return parts.join('；');
  }
  function viewModel(state, now = Date.now()) {
    if (!state || state.configured === false) return { title: '两机', rows: [], notice: '两机同步未配置', noticeKind: 'muted', history: [], lineState: '未配置' };
    const devices = state.devices || [];
    const shorts = shortLabels(devices);
    const rows = devices.map((device, i) => {
      const online = !!device.online;
      const when = formatLastSeen(device.lastSeenAt, now);
      return {
        id: device.id,
        name: deviceLabel(device) + (device.id === state.selfId ? '（本机）' : ''),
        short: shorts[i],
        self: device.id === state.selfId,
        online,
        status: online ? '在线' : '离线',
        seen: online ? when : '最后在线 ' + when,
      };
    });
    let notice = state.error || '';
    let noticeKind = state.error ? 'error' : 'ok';
    if (!notice && state.conflictCount > 0) {
      notice = `有 ${state.conflictCount} 处冲突：已保留一边，另一边的旧值记在冲突记录里`;
      noticeKind = 'warn';
    } else if (!notice && !rows.length && !state.lastSyncAt) {
      notice = '正在连接两机同步…';
      noticeKind = 'muted';
    } else if (!notice && state.lastSyncAt) notice = '已同步';
    // The most recent captain records, each with its own last time (the upload time
    // only when the record has none): the hub's order is oldest first.
    const when = (item) => item.endedAt || item.startedAt || item.updatedAt || '';
    const history = (state.history || []).slice().sort((a, b) => String(when(b)).localeCompare(String(when(a)))).slice(0, 8).map((item) => ({
      sessionId: item.sessionId,
      deviceId: item.deviceId,
      text: (item.summary || '队长记录') + (when(item) ? ' · ' + formatLastSeen(when(item), now) : ''),
    }));
    return { title: '两机', rows, notice, noticeKind, history, lineState: lineState(notice, noticeKind, state.conflictCount), canAck: noticeKind === 'warn' };
  }
  const ACK_LABEL = '全部标为已看';
  const ACK_DONE_LABEL = '已全部标为已看';
  const ACK_ICONS = {
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
  };
  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  // One line: 两机, a dot per computer, and only what needs a look. The computers, the whole
  // message and 队长记录 are in a detail shown on hover or keyboard focus, or kept open by a
  // click until Esc or focus leaves. Built once and filled in place, so an open detail
  // survives the refresh every few seconds.
  function skeleton(rootEl) {
    const line = rootEl.querySelector(':scope > .fleet-line');
    if (line) return { line, detail: rootEl.querySelector(':scope > .fleet-detail'), ack: rootEl.querySelector(':scope > .fleet-ack') };
    const doc = rootEl.ownerDocument;
    const button = el(doc, 'button', 'fleet-line');
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'fleetDetail');
    const state = el(doc, 'span', 'fleet-line-state');
    state.setAttribute('aria-live', 'polite');
    button.append(el(doc, 'span', 'fleet-title', '两机'), el(doc, 'span', 'fleet-chips'), state);
    const detail = el(doc, 'div', 'fleet-detail');
    detail.id = 'fleetDetail';
    const setOpen = (open) => { button.classList.toggle('open', open); button.setAttribute('aria-expanded', String(open)); };
    // A click that closes it also hides the hover view until the pointer leaves.
    button.addEventListener('click', () => {
      const open = !button.classList.contains('open');
      setOpen(open);
      button.classList.toggle('shut', !open);
    });
    button.addEventListener('mouseleave', () => button.classList.remove('shut'));
    button.addEventListener('blur', () => setOpen(false));
    button.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !button.classList.contains('open')) return;
      e.preventDefault(); e.stopPropagation(); setOpen(false);
    });
    // 全部标为已看: an icon button beside the line (a button cannot sit inside the line's own
    // button). Shown while there is something to mark, and for a moment as a tick afterwards.
    const ack = el(doc, 'button', 'fleet-ack');
    ack.type = 'button';
    ack.hidden = true;
    ack.innerHTML = ACK_ICONS.eye;
    ack.title = ACK_LABEL;
    ack.setAttribute('aria-label', ACK_LABEL);
    ack.addEventListener('click', () => {
      const act = rootEl.fleetAck;
      if (typeof act !== 'function' || ack.classList.contains('done')) return;
      Promise.resolve(act()).catch(() => {});
      ack.classList.add('done');
      ack.innerHTML = ACK_ICONS.check;
      ack.title = ACK_DONE_LABEL;
      ack.setAttribute('aria-label', ACK_DONE_LABEL);
      clearTimeout(ack.doneTimer);
      ack.doneTimer = setTimeout(() => {
        ack.classList.remove('done');
        ack.innerHTML = ACK_ICONS.eye;
        ack.title = ACK_LABEL;
        ack.setAttribute('aria-label', ACK_LABEL);
        ack.hidden = !rootEl.classList.contains('can-ack');
        rootEl.classList.toggle('has-ack', !ack.hidden);
      }, 1500);
    });
    rootEl.replaceChildren(button, detail, ack);
    return { line: button, detail, ack };
  }
  function mount(rootEl, state, now = Date.now(), actions = {}) {
    const model = viewModel(state, now);
    const doc = rootEl.ownerDocument;
    const { line, detail, ack } = skeleton(rootEl);
    rootEl.fleetAck = actions.ack || null;
    rootEl.classList.toggle('can-ack', model.canAck && typeof actions.ack === 'function');
    ack.hidden = !rootEl.classList.contains('can-ack') && !ack.classList.contains('done');
    rootEl.classList.toggle('has-ack', !ack.hidden);
    line.querySelector('.fleet-chips').replaceChildren(...model.rows.map((row) => {
      const chip = el(doc, 'span', 'fleet-chip' + (row.online ? ' online' : ' offline'));
      chip.dataset.device = row.id;
      chip.append(el(doc, 'span', 'fleet-dot'), el(doc, 'span', 'fleet-chip-name', row.short));
      return chip;
    }));
    const lineState = line.querySelector('.fleet-line-state');
    const shown = model.noticeKind === 'ok' ? '' : model.lineState;
    if (lineState.textContent !== shown) lineState.textContent = shown;
    lineState.className = 'fleet-line-state ' + model.noticeKind;
    line.dataset.state = model.noticeKind;
    line.setAttribute('aria-label', '两机：' + [model.rows.map((row) => row.short + row.status).join('，'), model.notice].filter(Boolean).join('；'));
    const parts = model.rows.map((row) => {
      const item = el(doc, 'div', 'fleet-row' + (row.online ? ' online' : ' offline') + (row.self ? ' self' : ''));
      item.dataset.deviceId = row.id;
      item.dataset.online = row.online ? 'true' : 'false';
      item.append(el(doc, 'span', 'fleet-dot'), el(doc, 'span', 'fleet-name', row.name), el(doc, 'span', 'fleet-state', row.status + ' · ' + row.seen));
      return item;
    });
    if (model.notice) parts.push(el(doc, 'p', 'fleet-notice ' + model.noticeKind, model.notice));
    if (model.history.length) parts.push(el(doc, 'div', 'fleet-history-head', '队长记录'));
    for (const item of model.history) {
      const entry = el(doc, 'div', 'fleet-history', item.text);
      entry.dataset.sessionId = item.sessionId || '';
      parts.push(entry);
    }
    detail.replaceChildren(...parts);
    return model;
  }
  function install(rootEl, readState, ackConflicts) {
    let timer = null;
    const actions = { ack: typeof ackConflicts === 'function' ? async () => { await ackConflicts(); await tick(); } : null };
    const tick = async () => {
      try { mount(rootEl, await readState(), Date.now(), actions); }
      catch (_) { mount(rootEl, { configured: true, error: '同步状态读取失败', devices: [], history: [] }, Date.now(), actions); }
    };
    tick();
    timer = setInterval(tick, 3000);
    return () => clearInterval(timer);
  }
  return { viewModel, conflictText, formatLastSeen, mount, install };
});

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const bootFleet = () => {
    const root = document.getElementById('fleetStatus');
    if (!root || !window.FleetUI || !window.deck || typeof window.deck.fleetState !== 'function') return;
    window.FleetUI.install(root, () => window.deck.fleetState(), typeof window.deck.fleetAckConflicts === 'function' ? () => window.deck.fleetAckConflicts() : null);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootFleet);
  else bootFleet();
}
