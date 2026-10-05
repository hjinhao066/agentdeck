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
    return new Date(seen).toLocaleString();
  }
  function deviceLabel(device) {
    if (device && device.name) return device.name;
    if (device && device.platform === 'darwin') return 'Mac';
    if (device && device.platform === 'win32') return 'Windows';
    return '电脑';
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
    if (!state || state.configured === false) return { title: '两机', rows: [], notice: '两机同步未配置', noticeKind: 'muted', history: [] };
    const rows = (state.devices || []).map((device) => {
      const online = !!device.online;
      const when = formatLastSeen(device.lastSeenAt, now);
      return {
        id: device.id,
        name: deviceLabel(device) + (device.id === state.selfId ? '（本机）' : ''),
        self: device.id === state.selfId,
        online,
        status: online ? '在线' : '离线',
        seen: online ? when : '最后在线 ' + when,
      };
    });
    let notice = state.error || '';
    let noticeKind = state.error ? 'error' : 'ok';
    if (!notice && state.conflictCount > 0) {
      notice = `有 ${state.conflictCount} 处冲突，两份修改都还在`;
      noticeKind = 'warn';
    } else if (!notice && !rows.length && !state.lastSyncAt) {
      notice = '正在连接两机同步…';
      noticeKind = 'muted';
    } else if (!notice && state.lastSyncAt) notice = '已同步';
    const history = (state.history || []).slice(0, 8).map((item) => ({
      sessionId: item.sessionId,
      deviceId: item.deviceId,
      text: (item.summary || '队长记录') + (item.updatedAt ? ' · ' + formatLastSeen(item.updatedAt, now) : ''),
    }));
    return { title: '两机', rows, notice, noticeKind, history };
  }
  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function mount(rootEl, state, now = Date.now()) {
    const model = viewModel(state, now);
    const doc = rootEl.ownerDocument;
    rootEl.replaceChildren();
    rootEl.append(el(doc, 'div', 'fleet-title', model.title));
    for (const row of model.rows) {
      const line = el(doc, 'div', 'fleet-row' + (row.online ? ' online' : ' offline') + (row.self ? ' self' : ''));
      line.dataset.deviceId = row.id;
      line.dataset.online = row.online ? 'true' : 'false';
      line.append(el(doc, 'span', 'fleet-dot'), el(doc, 'span', 'fleet-name', row.name), el(doc, 'span', 'fleet-state', row.status + ' · ' + row.seen));
      rootEl.append(line);
    }
    if (model.notice) {
      const note = el(doc, 'p', 'fleet-notice ' + model.noticeKind, model.notice);
      note.setAttribute('role', 'status');
      rootEl.append(note);
    }
    for (const item of model.history) {
      const line = el(doc, 'div', 'fleet-history', '队长记录 · ' + item.text);
      line.dataset.sessionId = item.sessionId || '';
      line.title = line.textContent;
      rootEl.append(line);
    }
    return model;
  }
  function install(rootEl, readState) {
    let timer = null;
    const tick = async () => {
      try { mount(rootEl, await readState()); }
      catch (_) { mount(rootEl, { configured: true, error: '同步状态读取失败', devices: [], history: [] }); }
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
    window.FleetUI.install(root, () => window.deck.fleetState());
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootFleet);
  else bootFleet();
}
