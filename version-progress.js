// 版本进度 drawer: an icon button right of the 架构图 tabs slides a drawer in
// from the right of the board view. It shows the version being worked toward
// (VersionProgressCore): a progress bar, then that version's cards grouped by
// status with model, latest receipt and elapsed time, done ones ticked. While
// open it follows task board changes live; the crew map narrows to make room.
// Open/closed and the cards already shown for the version are remembered in
// localStorage. Reads cards only through the TaskBoard bridge; never writes them.
(function () {
  'use strict';
  const V = window.VersionProgressCore;
  const STORE = 'agentdeck.versionDrawer';
  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    progress: svg('<path d="m3 6 2 2 3-3"/><path d="m3 13 2 2 3-3"/><path d="M12 6.5h9M12 13.5h9M4 20.5h17"/>'),
    refresh: svg('<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    done: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.25" fill="currentColor"/><path d="m4.9 8.3 2.1 2.1 4.1-4.3" fill="none" stroke="var(--vd-check-ink)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const RULES = [
    ['点名', '卡片的 version 字段、标题或说明里写了这个版本号'],
    ['在做', 'AgentDeck 里进行中、待验收或等你的卡，没写更晚的版本号'],
    ['已纳入', '之前在这一版里出现过的卡，做完了也留着打勾'],
    ['前置', '上面这些卡依赖的卡（顺着依赖一路找，跨项目也算）'],
  ];
  const RULE_TIP = Object.fromEntries(RULES);
  const BAR_ORDER = ['done', 'review', 'doing', 'attention', 'todo'];
  let btn, drawer, boardView, titleEl, subEl, percentEl, countEl, trackEl, legendEl, listEl, refreshBtn;
  let unsubscribe = null, seq = 0, last = null, ticker = null;

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
  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
  }
  function writeStore(patch) {
    try { localStorage.setItem(STORE, JSON.stringify({ ...readStore(), ...patch })); } catch { /* per-viewer convenience only */ }
  }
  const appVersion = () => { try { return window.deck.envInfo().version; } catch { return undefined; } };
  const isOpen = () => !!drawer && drawer.classList.contains('open');

  function modelText(item) {
    const raw = item.model && item.model !== 'default' ? item.model : '';
    const short = raw && window.AgentInfo ? window.AgentInfo.shortModelName(raw) : raw;
    return short || item.agent || '';
  }

  async function load() {
    const mine = ++seq;
    refreshBtn.classList.add('busy');
    try {
      const cards = await window.TaskBoard.list({ archived: true });
      if (mine !== seq) return;
      const app = appVersion();
      const version = V.targetVersion(cards, app);
      const saved = readStore();
      const p = V.progress(cards, app, { remembered: saved.version === version ? saved.ids : [] });
      writeStore({ version: p.version, ids: p.items.map((i) => i.id) });
      draw(p);
    } catch (error) {
      if (mine === seq) { listEl.textContent = ''; listEl.appendChild(el('p', 'vd-empty', '读不到任务看板：' + (error && error.message || error))); }
    } finally {
      if (mine === seq) refreshBtn.classList.remove('busy');
    }
  }

  function draw(p) {
    last = p;
    const name = p.version ? 'v' + p.version : '当前版本';
    titleEl.textContent = name;
    const app = appVersion();
    subEl.textContent = p.version && app && V.parse(app) && V.compare(p.version, app) > 0 ? `下一版 · 正在用 v${app}` : '正在用的版本';
    percentEl.textContent = String(p.percent);
    countEl.textContent = p.total ? `${p.done} / ${p.total} 完成` : '还没有卡片';
    trackEl.setAttribute('aria-valuenow', String(p.percent));
    trackEl.setAttribute('aria-valuetext', `${p.done} / ${p.total} 完成`);
    trackEl.textContent = '';
    legendEl.textContent = '';
    // Finished work fills from the left, work not started stays on the right.
    BAR_ORDER.map((key) => p.groups.find((g) => g.key === key)).filter(Boolean).forEach((g) => {
      const seg = el('span', 'vd-seg');
      seg.dataset.group = g.key;
      seg.style.flexGrow = String(g.items.length);
      trackEl.appendChild(seg);
    });
    p.groups.forEach((g) => {
      const chip = el('span', 'vd-chip');
      chip.dataset.group = g.key;
      chip.append(el('i', 'vd-chip-dot'), el('span', null, g.label), el('b', null, String(g.items.length)));
      legendEl.appendChild(chip);
    });
    listEl.textContent = '';
    if (!p.total) {
      listEl.appendChild(el('p', 'vd-empty', `任务看板里还没有属于 ${name} 的卡片。在标题或说明里写上版本号，或把卡片挂到发版卡的依赖上。`));
      return;
    }
    p.groups.forEach((g) => {
      const section = el('section', 'vd-group');
      section.dataset.group = g.key;
      const head = el('h3', 'vd-group-head');
      head.append(el('i', 'vd-group-dot'), el('span', null, g.label), el('span', 'vd-group-count', String(g.items.length)));
      const ul = el('ul', 'vd-items');
      g.items.forEach((item) => ul.appendChild(row(item)));
      section.append(head, ul);
      listEl.appendChild(section);
    });
  }

  function row(item) {
    const li = el('li', 'vd-item' + (item.done ? ' done' : ''));
    li.dataset.group = item.group;
    li.dataset.cardId = item.id;
    const mark = el('span', 'vd-mark');
    if (item.done) mark.innerHTML = ICON.done; else mark.appendChild(el('i', 'vd-dot'));
    const main = el('div', 'vd-main');
    const top = el('div', 'vd-top');
    const title = el('span', 'vd-title', item.title);
    title.title = item.title;
    const spent = V.elapsed(item);
    const timeEl = el('span', 'vd-time', spent);
    timeEl.title = spent ? (item.done ? '用时（建卡到完成）' : '已用时（从建卡算起）') : '';
    top.append(title, timeEl);
    const meta = el('div', 'vd-meta');
    if (item.label !== V.GROUPS.find((g) => g.key === item.group).label && item.group !== 'done') {
      meta.appendChild(el('span', 'vd-tag vd-flag', item.label));
    }
    if (item.reason !== 'named') {
      const tag = el('span', 'vd-tag', item.reasonLabel);
      tag.title = `${item.reasonLabel}：${RULE_TIP[item.reasonLabel]}`;
      meta.appendChild(tag);
    }
    const model = modelText(item);
    if (model) {
      const m = el('span', 'vd-model');
      const icon = window.AgentInfo && window.AgentInfo.PROVIDER_ICONS[item.agent];
      if (icon) { const i = el('span', 'vd-model-icon'); i.innerHTML = icon; m.appendChild(i); }
      m.appendChild(el('span', null, model));
      m.title = [item.agent, item.model].filter(Boolean).join(' · ');
      meta.appendChild(m);
    }
    const note = item.receipt || (item.waits.length ? `等「${item.waits.join('」「')}」完成` : item.done ? '' : item.group === 'todo' ? '还没派' : '干活中，还没有回执');
    main.appendChild(top);
    if (meta.childElementCount) main.appendChild(meta);
    if (note) {
      const r = el('p', 'vd-receipt' + (item.receipt ? '' : ' none'), note);
      r.title = note;
      main.appendChild(r);
    }
    li.append(mark, main);
    li.setAttribute('aria-label', `${item.done ? '已完成' : item.label}：${item.title}${model ? '，' + model : ''}${spent ? '，' + spent : ''}`);
    return li;
  }

  function place() {
    const toolbar = boardView.querySelector('.board-toolbar');
    drawer.style.top = (toolbar ? toolbar.offsetHeight : 0) + 'px';
  }
  function setOpen(open, { focus = false, remember = true } = {}) {
    if (open === isOpen()) return;
    drawer.classList.toggle('open', open);
    drawer.inert = !open;
    drawer.setAttribute('aria-hidden', String(!open));
    boardView.classList.toggle('vd-open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('active', open);
    if (remember) writeStore({ open });
    if (open) {
      place();
      if (!unsubscribe && window.TaskBoard) unsubscribe = window.TaskBoard.onChange(() => { if (isOpen()) load(); });
      ticker = setInterval(() => { if (last) draw(last); }, 30000);
      load();
      if (focus) drawer.focus();
    } else {
      clearInterval(ticker); ticker = null;
      if (focus) btn.focus();
    }
  }

  function init() {
    boardView = document.getElementById('boardView');
    const actions = boardView && boardView.querySelector('.board-toolbar-actions');
    const tabs = actions && actions.querySelector('.board-mode');
    if (!tabs || !V) return;
    btn = iconButton(ICON.progress, '版本进度', () => setOpen(!isOpen(), { focus: true }), 'vd-toggle');
    btn.id = 'versionProgressBtn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'versionProgress');
    tabs.after(btn);

    drawer = el('aside', 'vd');
    drawer.id = 'versionProgress';
    drawer.tabIndex = -1;
    drawer.inert = true;
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('aria-label', '版本进度');
    const head = el('header', 'vd-head');
    const kicker = el('div', 'vd-kicker');
    kicker.append(el('span', null, '版本进度'), el('span', 'vd-live', '实时'));
    refreshBtn = iconButton(ICON.refresh, '刷新', () => load(), 'vd-refresh');
    const tools = el('div', 'vd-tools');
    tools.append(refreshBtn, iconButton(ICON.close, '收起 (Esc)', () => setOpen(false, { focus: true }), 'vd-close'));
    const top = el('div', 'vd-head-row');
    top.append(kicker, tools);
    titleEl = el('h2', 'vd-version', '当前版本');
    subEl = el('div', 'vd-sub');
    head.append(top, titleEl, subEl);

    const hero = el('div', 'vd-hero');
    const figure = el('div', 'vd-figure');
    percentEl = el('span', 'vd-percent', '0');
    figure.append(percentEl, el('span', 'vd-percent-unit', '%'));
    countEl = el('div', 'vd-count');
    countEl.setAttribute('aria-live', 'polite');
    const nums = el('div', 'vd-nums');
    nums.append(figure, countEl);
    trackEl = el('div', 'vd-track');
    trackEl.setAttribute('role', 'progressbar');
    trackEl.setAttribute('aria-label', '完成进度');
    trackEl.setAttribute('aria-valuemin', '0');
    trackEl.setAttribute('aria-valuemax', '100');
    legendEl = el('div', 'vd-legend');
    hero.append(nums, trackEl, legendEl);

    listEl = el('div', 'vd-list');
    const rules = el('details', 'vd-rules');
    rules.appendChild(el('summary', null, '哪些卡算进这一版'));
    const dl = el('dl');
    RULES.forEach(([k, v]) => dl.append(el('dt', null, k), el('dd', null, v)));
    rules.append(dl, el('p', null, '归档的卡只有完成的才算；写了更晚版本号的卡留给下一版。'));
    drawer.append(head, hero, listEl, rules);
    boardView.appendChild(drawer);

    drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false, { focus: true }); } });
    window.addEventListener('resize', () => { if (isOpen()) place(); });
    if (readStore().open) setOpen(true, { remember: false });
  }

  init();
  window.VersionProgress = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    refresh: () => isOpen() && load(),
  };
})();
