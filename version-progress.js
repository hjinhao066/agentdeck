// 当前版本进度: an icon button right of the 架构图 tabs opens a panel listing
// the task cards of the version being worked toward (VersionProgressCore),
// done ones ticked, with an overall progress bar. Reads cards only through the
// fixed TaskBoard bridge; never writes them. Plain script, self-initialising.
(function () {
  'use strict';
  const V = window.VersionProgressCore;
  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    progress: svg('<path d="m3 6 2 2 3-3"/><path d="m3 13 2 2 3-3"/><path d="M12 6.5h9M12 13.5h9M4 20.5h17"/>'),
    refresh: svg('<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    done: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.6L16 9.8"/>'),
    open: svg('<circle cx="12" cy="12" r="9"/>'),
  };
  let btn, panel, titleEl, barEl, summaryEl, listEl, unsubscribe = null, seq = 0;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function iconButton(icon, label, onClick, cls) {
    const b = el('button', 'tbv-icon' + (cls ? ' ' + cls : ''));
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.innerHTML = icon;
    b.addEventListener('click', onClick);
    return b;
  }
  const appVersion = () => { try { return window.deck.envInfo().version; } catch { return undefined; } };
  const isOpen = () => !!panel && !panel.hidden;

  async function load() {
    const mine = ++seq;
    panel.classList.add('loading');
    try {
      const cards = await window.TaskBoard.list({ archived: true });
      if (mine === seq) draw(V.progress(cards, appVersion()));
    } catch (error) {
      if (mine === seq) { listEl.textContent = ''; listEl.appendChild(el('li', 'vp-empty', '读不到任务看板：' + (error && error.message || error))); }
    } finally {
      if (mine === seq) panel.classList.remove('loading');
    }
  }

  function draw(p) {
    const name = p.version ? 'v' + p.version : '当前版本';
    titleEl.textContent = name + ' 进度';
    titleEl.title = name + ' 进度';
    barEl.style.width = p.percent + '%';
    barEl.parentElement.setAttribute('aria-valuenow', String(p.percent));
    barEl.parentElement.setAttribute('aria-valuetext', `${p.done} / ${p.total} 完成`);
    summaryEl.textContent = p.total ? `${p.done} / ${p.total} 完成 · ${p.percent}%` : '还没有卡片';
    listEl.textContent = '';
    if (!p.total) {
      listEl.appendChild(el('li', 'vp-empty', `任务看板里还没有标 ${name} 的卡片（标题、说明里写版本号，或填 version 字段）。`));
      return;
    }
    p.items.forEach((item) => {
      const li = el('li', 'vp-item' + (item.done ? ' done' : '') + ' st-' + (item.flag === 'failed' ? 'failed' : item.status));
      const mark = el('span', 'vp-mark');
      mark.innerHTML = item.done ? ICON.done : ICON.open;
      const title = el('span', 'vp-title', item.title);
      title.title = item.title;
      li.setAttribute('aria-label', `${item.done ? '已完成' : '未完成'}：${item.title}（${item.label}）`);
      li.append(mark, title, el('span', 'vp-status', item.label));
      listEl.appendChild(li);
    });
  }

  function open() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('active');
    if (!unsubscribe && window.TaskBoard) unsubscribe = window.TaskBoard.onChange(() => { if (isOpen()) load(); });
    load();
    panel.focus();
  }
  function close(returnFocus) {
    if (!isOpen()) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('active');
    if (returnFocus) btn.focus();
  }

  function init() {
    const actions = document.querySelector('#boardView .board-toolbar-actions');
    const tabs = actions && actions.querySelector('.board-mode');
    if (!tabs || !V) return;
    const anchor = el('span', 'vp-anchor');
    btn = iconButton(ICON.progress, '当前版本进度', () => (isOpen() ? close(false) : open()), 'vp-toggle');
    btn.id = 'versionProgressBtn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'versionProgress');
    panel = el('section', 'vp-panel');
    panel.id = 'versionProgress';
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '当前版本进度');
    const head = el('div', 'vp-head');
    titleEl = el('h2', 'vp-heading', '当前版本进度');
    head.append(titleEl, iconButton(ICON.refresh, '刷新', () => load(), 'vp-refresh'), iconButton(ICON.close, '关闭 (Esc)', () => close(true), 'vp-close'));
    const track = el('div', 'vp-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    barEl = el('div', 'vp-bar');
    track.appendChild(barEl);
    summaryEl = el('div', 'vp-summary');
    summaryEl.setAttribute('aria-live', 'polite');
    listEl = el('ul', 'vp-list');
    panel.append(head, track, summaryEl, listEl);
    anchor.append(btn, panel);
    tabs.after(anchor);
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } });
    document.addEventListener('pointerdown', (e) => { if (isOpen() && !anchor.contains(e.target)) close(false); }, true);
  }

  init();
  window.VersionProgress = { open, close: () => close(false), refresh: () => isOpen() && load() };
})();
