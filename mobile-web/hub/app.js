'use strict';

// Phone hub: one static page that talks to each computer under its own prefix
// (/mac/…, /win/…). Every computer keeps its own login, cookie and CSRF token;
// this page only decides which prefix a request goes to and never retries a
// request against a different computer.
(() => {
  const Core = window.HubCore;
  const $ = (id) => document.getElementById(id);
  const icons = {
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20.8 13a9 9 0 0 1-9.8-9.8A9 9 0 1 0 20.8 13Z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6m4-6v6"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13 7 4 4"/>',
    send: '<path d="m21 3-6.5 18-4-7.5L3 9.5 21 3Z"/><path d="m10.5 13.5 5-5"/>',
    logout: '<path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h12"/>',
    back: '<path d="m14 6-6 6 6 6M8 12h12"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    overview: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="12" width="8" height="9" rx="2"/><rect x="3" y="15" width="8" height="6" rx="2"/>',
    captain: '<path d="M5 6h14v11H9l-4 4V6Z"/><path d="M9 10h6m-6 3h4"/>',
    sessions: '<rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="16" rx="2"/>',
    board: '<path d="M4 4v16M12 4v16M20 4v16M4 8h4m4 5h4m4-5h2"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
    desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
    crown: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  };
  // The desktop's provider marks, so the phone shows the same icons as the desktop quota rows.
  const providerIcons = {
    Claude: '<svg viewBox="0 0 100 100" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"/></svg>',
    Antigravity: '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 2C12 7.5 7.5 12 2 12C7.5 12 12 16.5 12 22C12 16.5 16.5 12 22 12C16.5 12 12 7.5 12 2Z"/></svg>',
    Codex: '<svg viewBox="134 213 293 293" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z"/></svg>',
  };
  const svg = (name) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
  const statusNames = { working: '干活中', idle: '空闲', failed: '失败', input: '停在确认', quota: '额度用尽/等待', queued: '待补充', waiting: '排队', asking: '在问你', done: '完成', unavailable: '未启动' };
  const taskStatuses = [['todo', '待办'], ['doing', '进行中'], ['review', '待验收'], ['needs_user', '等用户'], ['done', '完成']];
  const flagNames = { failed: '失败', blocked: '前置未完成', held: '挂起' };
  const KEYS = { theme: 'agentdeck-hub-theme', machine: 'agentdeck-hub-machine', meta: 'agentdeck-hub-meta' };

  let machines = [], filter = 'all', target = '', view = 'overview', output = null, outputRequest = 0;
  let sending = false, sendStatus = '', boardFilter = 'all', copyTimer, outboxId = 0;
  // Quota rows whose details are open, as 'machine:key'. Memory only.
  const openQuota = new Set();
  // Messages that failed to send wait here (memory only) until the user re-edits them.
  const outbox = [];
  const signatures = new WeakMap();

  const stored = (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch (_) { /* Private browsing: keep it for this page only. */ } };
  const byId = (id) => machines.find((m) => m.id === id);
  const shown = () => machines.filter((m) => filter === 'all' || filter === m.id);
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function iconButton(icon, label, className) {
    const button = node('button', 'icon-button' + (className ? ' ' + className : ''));
    button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = svg(icon);
    return button;
  }
  function changed(el, value) {
    const signature = JSON.stringify(value);
    if (signatures.get(el) === signature) return false;
    signatures.set(el, signature);
    return true;
  }
  function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').hidden = !message;
    $('notice').classList.toggle('error', error);
  }
  function pill(state, text) {
    const el = node('span', 'pill tone-' + Core.STATES[state].tone);
    el.append(node('span', 'dot'), node('span', '', text || Core.STATES[state].label));
    return el;
  }
  function statusBadge(status) {
    const el = node('span', 'status ' + status);
    el.append(node('span', 'status-dot'), node('span', '', statusNames[status] || '空闲'));
    return el;
  }
  const glyph = (m) => { const el = node('span', 'machine-glyph'); el.innerHTML = svg(m.platform === 'win32' ? 'desktop' : 'laptop'); return el; };
  const lastSeen = (m) => m.meta.lastOnline ? '最后在线 ' + Core.ago(m.meta.lastOnline, Date.now()) : '这部手机还没连上过它';

  // ---- theme ---------------------------------------------------------------
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let savedTheme = stored(KEYS.theme);
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const label = theme === 'dark' ? '切换浅色主题' : '切换深色主题';
    $('theme').title = label; $('theme').setAttribute('aria-label', label);
    $('theme').innerHTML = svg(theme === 'dark' ? 'sun' : 'moon');
  }
  applyTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : systemTheme.matches ? 'dark' : 'light');
  systemTheme.addEventListener('change', () => { if (savedTheme !== 'dark' && savedTheme !== 'light') applyTheme(systemTheme.matches ? 'dark' : 'light'); });
  $('theme').addEventListener('click', () => {
    savedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(savedTheme); store(KEYS.theme, savedTheme);
  });
  for (const [id, icon] of [['refresh', 'refresh'], ['logout-all', 'logout'], ['back', 'back'], ['copy', 'copy'], ['send', 'send'], ['clear', 'trash']]) $(id).innerHTML = svg(icon);
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.querySelector('.nav-icon').innerHTML = svg(button.dataset.view);
    button.addEventListener('click', () => showView(button.dataset.view));
  });

  // ---- network -------------------------------------------------------------
  // Every request names its machine; the prefix is the only routing there is.
  async function request(m, path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Core.TIMEOUT);
    try {
      // redirect 'error': a machine's answer must never send this request (and its cookie or POST body) anywhere else, e.g. to the other computer.
      const response = await fetch(m.basePath + path, { credentials: 'same-origin', cache: 'no-store', ...options, redirect: 'error', signal: controller.signal });
      let body = null;
      try { body = await response.json(); } catch (_) { /* Non-JSON answers are classified by status. */ }
      return { status: response.status, body, retryAfter: Number(response.headers.get('Retry-After')) || 0 };
    } catch (_) { return controller.signal.aborted ? { timedOut: true } : { failed: true }; }
    finally { clearTimeout(timer); }
  }
  const post = (m, path, body) => request(m, path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': m.csrf }, body: JSON.stringify(body) });
  function saveMeta() {
    store(KEYS.meta, JSON.stringify(Object.fromEntries(machines.map((m) => [m.id, m.meta]))));
  }
  function settle(m, result, verdict = Core.classify(result)) {
    m.state = verdict.state; m.detail = verdict.detail || '';
    if (verdict.retryAfter) m.banUntil = Date.now() + verdict.retryAfter * 1000;
    if (m.state !== 'online') { m.snap = null; m.csrf = ''; m.quota = null; m.quotaFailed = false; m.quotaAt = 0; }
    // A machine that no longer accepts this phone must not keep showing its board.
    if (m.state === 'login' || m.state === 'upgrade') { m.cards = null; m.boardVersion = null; }
    return verdict;
  }
  async function poll(m) {
    if (m.busy) { m.again = true; return; }
    m.busy = true; m.again = false;
    renderBusy();
    // Ask what the machine is before asking for data: only a build that answers
    // api/info is ever shown a login form. Once it is online the probe is skipped
    // until a snapshot fails again.
    if (!m.current) {
      const info = Core.classifyInfo(await request(m, 'api/info'));
      if (info.current) m.current = true; else settle(m, null, info);
    }
    const result = m.current ? await request(m, 'api/snapshot') : null;
    if (m.current && settle(m, result).state !== 'online') m.current = false;
    if (m.current) {
      m.snap = result.body; m.csrf = String(result.body.csrfToken || '');
      m.hostname = String(result.body.machine.hostname || '');
      m.meta = Core.metaOf(result.body, Date.now()); saveMeta();
      if (m.snap.boardVersion !== m.boardVersion || !m.cards) {
        const tasks = await request(m, 'api/tasks');
        if (tasks.status === 200 && tasks.body && Array.isArray(tasks.body.cards)) { m.cards = tasks.body.cards; m.boardVersion = m.snap.boardVersion; }
      }
      // Quota moves slowly: read it at most every 30 seconds, and on a manual refresh.
      if (m.forceQuota || !m.quotaAt || Date.now() - m.quotaAt > 30000) {
        m.forceQuota = false;
        const quota = await request(m, 'api/quota');
        // 404: an older build without the quota route; nothing to show, nothing failed.
        if (quota.status === 200 && quota.body) { m.quota = Core.cleanQuota(quota.body); m.quotaFailed = false; }
        else if (quota.status === 404) { m.quota = null; m.quotaFailed = false; } else m.quotaFailed = true;
        m.quotaAt = Date.now();
      }
    }
    m.busy = false;
    m.nextAt = Date.now() + Core.pollInterval(m.state, filter === 'all' || filter === m.id);
    render();
    if (output && output.machineId === m.id && view === 'output') loadOutput(true);
    if (m.again) poll(m);
  }
  function refreshAll() { machines.forEach((m) => { m.forceQuota = true; poll(m); }); }
  function renderBusy() {
    const busy = machines.some((m) => m.busy);
    $('refresh').classList.toggle('refreshing', busy);
  }

  // ---- machine bar ---------------------------------------------------------
  function setFilter(id) {
    filter = id; store(KEYS.machine, id);
    if (id !== 'all') setTarget(id, true);
    shown().forEach((m) => { if (m.state === 'online') m.nextAt = 0; });
    render();
  }
  function setTarget(id, fromFilter) {
    if (sending || !byId(id)) return;
    target = id; sendStatus = '';
    // Keep the top switch and the dispatch target telling the same story.
    if (!fromFilter && filter !== 'all') { filter = id; store(KEYS.machine, id); }
    render();
  }
  // The computer switch lives in the header: a dot and the name, one tap each.
  // In the Captain view it picks who the message goes to, elsewhere what is shown.
  function renderBar() {
    const bar = $('machine-bar');
    bar.hidden = view === 'output';
    $('app-header').dataset.view = view;
    const online = machines.filter((m) => m.state === 'online').length;
    const picking = view === 'captain';
    if (!changed(bar, [view, picking ? target : filter, picking && sending, online, machines.map((m) => [m.id, m.label, m.state])])) return;
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.filter : null;
    bar.replaceChildren();
    const segment = (id, name, state, pressed, label) => {
      const button = node('button', 'segment');
      button.type = 'button'; button.dataset.filter = id;
      button.setAttribute('aria-pressed', String(pressed));
      button.setAttribute('aria-label', label); button.title = label;
      button.disabled = picking && sending;
      if (state) button.append(node('span', 'dot tone-' + Core.STATES[state].tone));
      button.append(node('span', 'segment-name', name));
      button.addEventListener('click', () => picking ? setTarget(id) : setFilter(id));
      bar.append(button);
    };
    // One computer at a time when writing to the Captain, so "all" has no place there.
    if (!picking) segment('all', '全部', '', filter === 'all', `全部电脑，${online}/${machines.length} 在线`);
    for (const m of machines) segment(m.id, m.label, m.state, (picking ? target : filter) === m.id, `${m.label}，${Core.STATES[m.state].label}`);
    if (focused) bar.querySelector(`[data-filter="${focused}"]`)?.focus();
  }

  // ---- quota ---------------------------------------------------------------
  // The same compact table as the single-machine page: one row per account with
  // its 5-hour and weekly remainder; tapping a row opens its details in place.
  function providerIcon(row) { const icon = node('span', 'quota-icon'); icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = providerIcons[row.provider] || ''; return icon; }
  function quotaMeter(cell) {
    const el = node('span', 'quota-meter'); el.setAttribute('aria-hidden', 'true');
    el.style.setProperty('--pct', (cell.out || cell.missing ? 0 : Math.max(2, Math.min(100, cell.remaining))) + '%');
    return el;
  }
  function quotaDetails(m, row, now) {
    const body = node('dl', 'quota-detail');
    const line = (key, value, level, sub) => {
      const el = node('div', 'detail-line'); if (level) el.dataset.level = level;
      const text = node('dd', 'detail-value'); text.append(node('span', 'detail-main', value));
      if (sub) text.append(node('span', 'detail-sub', sub));
      el.append(node('dt', 'detail-key', key), text); body.append(el);
    };
    for (const cell of Core.quotaCells(row)) {
      if (cell.missing) line(Core.windowName(cell.key), '未知', 'none', row.cells.length || row.status === 'out' ? '此来源未提供这个窗口' : '');
      else line(Core.windowName(cell.key), cell.out ? '已用尽' : '剩余 ' + Core.percentText(cell), Core.cellLevel(row, cell, m.quotaFailed),
        cell.resetAt > now ? Core.longReset(cell.resetAt, now) + (cell.out ? '恢复' : '重置') : (cell.out ? '恢复' : '重置') + '时间未知');
    }
    const state = Core.quotaState(row, m.quotaFailed);
    if (state) line('状态', state, 'none');
    line('账号', row.account || '未知');
    line('来源', row.source || '未知');
    line('采样', row.sampledAt ? Core.sampledText(row, now).slice(3) : '暂无采样');
    return body;
  }
  function quotaSection(m) {
    const now = Date.now(), quota = m.quota;
    const box = node('section', 'quota');
    box.setAttribute('aria-label', `${m.label} 的额度`);
    const head = node('div', 'quota-heading');
    head.append(node('h3', '', '额度'), node('span', 'quota-note', m.quotaFailed ? '未能更新' : ''));
    if (quota.rows.length) { const cols = node('span', 'quota-columns'); cols.setAttribute('aria-hidden', 'true'); cols.append(node('span', '', '5h'), node('span', '', '7d')); head.append(cols); }
    box.append(head);
    if (!quota.rows.length) { box.append(node('p', 'quota-empty', m.quotaFailed ? '暂时读不到额度。' : '这台电脑还没有额度数据。')); return box; }
    const list = node('div', 'quota-rows'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', `${m.label} 订阅剩余额度`);
    for (const row of quota.rows) {
      const id = m.id + ':' + row.key, open = openQuota.has(id);
      const item = node('div', 'quota-item'); item.setAttribute('role', 'listitem');
      item.dataset.status = row.status; item.dataset.provider = row.provider;
      const button = node('button', 'quota-row'); button.type = 'button';
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', Core.quotaLabel(row, now) + '；查看详情'); button.title = '查看详情';
      const name = node('span', 'quota-name');
      name.append(providerIcon(row), node('span', 'quota-name-text', [row.flag, row.short].filter(Boolean).join(' ')));
      if (row.captain) { const crown = node('span', 'quota-captain'); crown.title = '队长在用'; crown.innerHTML = svg('crown'); name.append(crown); }
      const values = node('span', 'quota-values');
      if (row.cells.length || row.status === 'out') {
        for (const cell of Core.quotaCells(row)) {
          const el = node('span', 'quota-cell'); el.dataset.window = cell.key;
          el.dataset.level = cell.missing ? 'none' : Core.cellLevel(row, cell, m.quotaFailed);
          const lineEl = node('span', 'quota-line');
          if (cell.missing) { el.dataset.missing = 'true'; lineEl.append(node('span', 'quota-pct', '—')); }
          else if (cell.out) {
            const ban = node('span', 'quota-ban'); ban.innerHTML = svg('ban');
            lineEl.append(ban, node('span', 'quota-reset', cell.resetAt > now ? Core.shortReset(cell.resetAt, now) : '用尽'));
          } else {
            lineEl.append(node('span', 'quota-pct', Core.percentText(cell)));
            if (cell.resetAt > now) lineEl.append(node('span', 'quota-reset', Core.shortReset(cell.resetAt, now)));
          }
          el.append(lineEl, quotaMeter(cell)); values.append(el);
        }
      } else {
        const status = node('span', 'quota-status'); status.dataset.level = 'none';
        status.append(node('span', 'quota-line', Core.emptyText(row)), quotaMeter({ out: true })); values.append(status);
      }
      button.append(name, values);
      const note = Core.quotaNote(row, now);
      if (note) button.append(node('span', 'quota-row-note', note));
      const detail = quotaDetails(m, row, now); detail.hidden = !open; detail.id = 'quota-detail-' + id.replace(/[^\w-]/g, '_');
      button.setAttribute('aria-controls', detail.id);
      button.addEventListener('click', () => {
        if (openQuota.has(id)) openQuota.delete(id); else openQuota.add(id);
        signatures.delete(m.card); render();
        // The card is rebuilt: put the focus back on the row that was tapped.
        m.card.querySelector(`[aria-controls="${detail.id}"]`)?.focus({ preventScroll: true });
      });
      item.append(button, detail); list.append(item);
    }
    box.append(list);
    return box;
  }

  // ---- overview ------------------------------------------------------------
  function latestReceipt(m) {
    const session = [...m.snap.sessions].reverse().find((s) => !s.isMain && s.receipt);
    return session ? { title: session.title, text: session.receipt } : null;
  }
  function stats(captain, working, total, dim) {
    const grid = node('dl', 'stats' + (dim ? ' dim' : ''));
    for (const [name, value] of [['队长', statusNames[captain] || '空闲'], ['干活中', `${working} 个`], ['会话', `共 ${total} 个`]]) {
      const cell = node('div'); cell.append(node('dt', '', name), node('dd', '', value)); grid.append(cell);
    }
    return grid;
  }
  function loginForm(m) {
    const form = node('form', 'login-form');
    const banned = Math.max(0, Math.ceil((m.banUntil - Date.now()) / 60000));
    const id = 'token-' + m.id;
    const label = node('label', '', `${m.label} 的登录 token`); label.htmlFor = id;
    const input = node('input'); input.id = id; input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.required = true;
    input.setAttribute('autocapitalize', 'off'); input.disabled = m.loginBusy || banned > 0;
    const button = node('button', 'primary', m.loginBusy ? '正在登录…' : `登录 ${m.label}`); button.type = 'submit'; button.disabled = m.loginBusy || banned > 0;
    const error = node('p', 'form-error', banned ? `登录尝试过多，${banned} 分钟后再试。` : m.loginError); error.setAttribute('role', 'alert');
    form.append(label, input, button, error,
      node('p', 'form-help', `在 ${m.label} 上打开 AgentDeck 设置，在「手机网页端」里复制 token。每台电脑的 token 各自独立，登录一次记住 30 天。`));
    form.addEventListener('submit', (event) => { event.preventDefault(); login(m, input.value); });
    return form;
  }
  function renderMachineCard(m) {
    const card = m.card;
    card.hidden = !(filter === 'all' || filter === m.id);
    const online = m.state === 'online';
    const banned = Math.max(0, Math.ceil((m.banUntil - Date.now()) / 60000));
    const receipt = online ? latestReceipt(m) : null;
    const signature = [m.state, m.detail, m.loginError, m.loginBusy, banned, m.logoutBusy,
      online ? [m.snap.machine, m.snap.captain && [m.snap.captain.id, m.snap.captain.status], m.meta.workingCount, m.meta.sessionCount, receipt, m.quota, m.quotaFailed, [...openQuota].filter((id) => id.startsWith(m.id + ':')), Math.floor(Date.now() / 60000)] : [m.meta, lastSeen(m)]];
    if (!changed(card, signature)) return;
    card.className = 'machine-card tone-' + Core.STATES[m.state].tone;
    card.replaceChildren();
    const head = node('div', 'machine-head'), names = node('div', 'machine-names');
    const sub = [m.meta.hostname || m.hostname, m.meta.appVersion && 'AgentDeck ' + m.meta.appVersion].filter(Boolean).join(' · ') || m.basePath;
    names.append(node('h2', '', m.label), node('p', 'machine-sub', sub));
    head.append(glyph(m), names, pill(m.state));
    card.append(head);
    if (online) {
      card.append(stats(m.meta.captainStatus, m.meta.workingCount, m.meta.sessionCount));
      if (m.quota) card.append(quotaSection(m));
      const block = node('div', 'receipt');
      block.append(node('span', 'receipt-label', receipt ? '最近回执 · ' + receipt.title : '最近回执'), node('p', '', receipt ? receipt.text : '还没有队员提交回执。'));
      const foot = node('div', 'machine-foot');
      const label = `退出 ${m.label}：只退出这台电脑，另一台不受影响`;
      const exit = iconButton('logout', label); exit.disabled = !!m.logoutBusy;
      armed(exit, label, `再点一次，确认退出 ${m.label}`, () => logout([m]));
      foot.append(node('span', 'machine-time', '自动更新中'), exit);
      card.append(block, foot);
      return;
    }
    const explain = {
      unknown: '正在连接这台电脑…',
      login: '这部手机还没登录这台电脑，或登录已被吊销。',
      offline: `${lastSeen(m)}。可能在睡眠、关机、断网，或 AgentDeck 没有运行。`,
      unresponsive: `8 秒内没有回应，可能在睡眠。${lastSeen(m)}。`,
      upgrade: '这台电脑的 AgentDeck 版本太旧，还没有总台接口。请在这台电脑上升级 AgentDeck，升级前不用在这里登录。',
      error: `${m.detail}${m.meta.lastOnline ? ' ' + lastSeen(m) + '。' : ''}`,
    }[m.state];
    card.append(node('p', 'machine-explain', explain));
    if (m.state === 'login') card.append(loginForm(m));
    else if (m.meta.lastOnline && m.state !== 'unknown') {
      card.append(node('p', 'stale-label', '上次看到的状态（不是现在）'), stats(m.meta.captainStatus, m.meta.workingCount, m.meta.sessionCount, true));
    }
  }
  function renderOverview() { machines.forEach(renderMachineCard); }

  // Destructive-ish icon actions need a second tap, so a slip does not log the
  // phone out while its owner is away from the desktop that holds the token.
  function armed(button, label, confirmLabel, action) {
    let timer;
    const reset = () => { button.classList.remove('armed'); button.title = label; button.setAttribute('aria-label', label); };
    button.addEventListener('click', () => {
      if (button.classList.contains('armed')) { clearTimeout(timer); reset(); action(); return; }
      button.classList.add('armed'); button.title = confirmLabel; button.setAttribute('aria-label', confirmLabel);
      notice(confirmLabel + '。');
      timer = setTimeout(() => { reset(); notice(''); }, 4000);
    });
  }
  async function login(m, token) {
    if (m.loginBusy || !token) return;
    m.loginBusy = true; m.loginError = ''; render();
    // The token goes out once in a JSON body to this machine's prefix and is not kept.
    const result = await request(m, 'login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    m.loginBusy = false;
    if (result.status === 200) { m.loginError = ''; m.banUntil = 0; signatures.delete(m.card); await poll(m); return; }
    if (result.status === 401) m.loginError = 'token 不正确，请重试。';
    else if (result.status === 429) { m.banUntil = Date.now() + (result.retryAfter || 900) * 1000; m.loginError = ''; }
    else { settle(m, result); m.loginError = m.state === 'login' ? '暂时无法登录，请重试。' : ''; }
    render();
    if (m.state === 'login') document.getElementById('token-' + m.id)?.focus();
  }
  async function logout(list) {
    notice('');
    const missed = [];
    for (const m of list) {
      if (m.state !== 'online') { missed.push(m.label); continue; }
      m.logoutBusy = true; render();
      const result = await request(m, 'logout', { method: 'POST', headers: { 'X-CSRF-Token': m.csrf } });
      m.logoutBusy = false;
      if (result.status === 200 || result.status === 401) { settle(m, { status: 401 }); m.current = false; m.nextAt = Date.now() + 15000; }
      else missed.push(m.label);
    }
    if (missed.length) notice(`${missed.join('、')} 没能退出（离线或没有回应）。等它上线后再退出一次，或在那台电脑的设置里吊销所有设备。`, true);
    render();
  }

  // ---- captain -------------------------------------------------------------
  // ---- conversation groups -------------------------------------------------
  // One round: what the user said, then a single reply block from the Captain
  // with the dispatching and receipts folded into a one-line "process".
  function copyText(button, text, label) {
    navigator.clipboard.writeText(text).then(() => {
      button.innerHTML = svg('check'); button.title = '已复制'; button.setAttribute('aria-label', '已复制'); button.classList.add('copied');
      setTimeout(() => { button.innerHTML = svg('copy'); button.title = label; button.setAttribute('aria-label', label); button.classList.remove('copied'); }, 1600);
    }).catch(() => notice('无法复制。可以长按文字手动选择。', true));
  }
  function processDetails(group) {
    const summary = Core.processSummary(group);
    if (!summary) return null;
    const details = node('details', 'process');
    details.append(node('summary', '', summary));
    const list = node('ul', 'process-list');
    for (const task of group.tasks) {
      const item = node('li', task.failed ? 'process-failed' : '');
      item.append(node('strong', '', task.title || '任务'));
      if (task.summary) item.append(node('span', '', ' — ' + task.summary));
      list.append(item);
    }
    for (const step of group.steps) list.append(node('li', 'process-step', step));
    details.append(list);
    return details;
  }
  function renderGroup(m, group) {
    const row = node('article', 'turn');
    if (group.id) row.dataset.turnId = group.id;
    if (group.user || group.images.length) {
      const prompt = node('div', 'bubble mine');
      prompt.append(node('span', 'bubble-label', '你'));
      if (group.user) {
        const text = node('p', 'bubble-text', group.user);
        prompt.append(text);
        // Long messages fold to a few lines; the whole text stays in the page.
        if (group.user.length > 500 || group.user.split('\n').length > 10) {
          text.classList.add('clamped');
          const toggle = node('button', 'expand-toggle', '展开全文');
          toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
          toggle.addEventListener('click', () => {
            const open = text.classList.toggle('clamped') === false;
            toggle.textContent = open ? '收起' : '展开全文'; toggle.setAttribute('aria-expanded', String(open));
          });
          prompt.append(toggle);
        }
      }
      if (group.images.length) prompt.append(node('span', 'bubble-state', `附 ${group.images.length} 张图片（在这台电脑上查看）`));
      row.append(prompt);
    }
    const body = group.replies.join('\n\n');
    const process = processDetails(group);
    if (body || process || group.pending || group.interrupted) {
      const reply = node('div', 'bubble');
      reply.append(node('span', 'bubble-label', `${m.label} 队长`));
      if (body) {
        reply.append(node('p', 'bubble-text', body));
        const actions = node('div', 'turn-actions');
        const copy = iconButton('copy', '复制队长回复');
        copy.addEventListener('click', () => copyText(copy, body, '复制队长回复'));
        actions.append(copy);
        if (group.interrupted) actions.append(node('span', 'turn-state', '已中断'));
        reply.append(actions);
      } else if (group.interrupted && !process) reply.append(node('p', 'bubble-text turn-state', '回复已中断。'));
      if (group.pending) {
        const pending = node('p', 'bubble-text pending');
        const typing = node('span', 'typing'); typing.setAttribute('aria-hidden', 'true');
        typing.append(node('i'), node('i'), node('i'));
        pending.append(typing, node('span', '', body ? '处理中…' : '队长正在处理…'));
        reply.append(pending);
      }
      if (process) reply.append(process);
      row.append(reply);
    }
    return row;
  }
  function renderCaptain() {
    const m = byId(target);
    if (!m) return;
    const captain = m.snap && m.snap.captain && m.snap.captain.id ? m.snap.captain : null;
    $('captain-title').textContent = `${m.label} 队长`;
    const status = $('captain-status');
    if (changed(status, [m.state, captain && captain.status])) status.replaceChildren(m.state === 'online' ? statusBadge(captain ? captain.status : 'unavailable') : pill(m.state));
    const conversation = $('captain-turns');
    const pending = outbox.filter((item) => item.machineId === m.id);
    const turns = captain ? captain.turns || [] : [];
    if (changed(conversation, [m.id, m.state, !!captain, turns, pending, m.state === 'online' ? '' : lastSeen(m)])) {
      const follow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48 || conversation.dataset.machine !== m.id;
      const scrollTop = conversation.scrollTop;
      conversation.dataset.machine = m.id;
      conversation.replaceChildren();
      if (m.state !== 'online') conversation.append(node('p', 'empty', `${m.label} ${Core.STATES[m.state].label}，${lastSeen(m)}。对话不会存在手机里，等它恢复后再显示。`));
      else if (!captain) conversation.append(node('p', 'empty', `${m.label} 还没有队长。先在那台电脑上创建队长。`));
      else if (!turns.length && !pending.length) conversation.append(node('p', 'empty', `还没有对话。发一条指令，让 ${m.label} 队长开始安排。`));
      for (const group of Core.groupTurns(turns)) conversation.append(renderGroup(m, group));
      for (const item of pending) {
        const row = node('article', 'turn'), bubble = node('div', 'bubble mine' + (item.state === 'failed' ? ' failed' : ''));
        bubble.append(node('span', 'bubble-label', item.state === 'failed' ? `没有发给 ${m.label}` : `正在发给 ${m.label}…`), node('p', 'bubble-text', item.text));
        if (item.state === 'failed') {
          const foot = node('div', 'bubble-foot');
          const edit = iconButton('pencil', '重新编辑这条消息');
          edit.addEventListener('click', () => {
            outbox.splice(outbox.indexOf(item), 1);
            const box = $('message');
            box.value = box.value ? box.value + '\n' + item.text : item.text;
            sendStatus = ''; render(); box.focus();
          });
          foot.append(node('p', 'bubble-reason', item.reason), edit); bubble.append(foot);
        }
        row.append(bubble); conversation.append(row);
      }
      conversation.scrollTop = follow ? conversation.scrollHeight : scrollTop;
    }
    updateComposer();
  }
  function updateComposer() {
    const m = byId(target);
    if (!m) return;
    const block = Core.sendBlock(m), box = $('message'), label = `发送给 ${m.label} 队长`;
    box.placeholder = `写给 ${m.label} 队长…`; box.disabled = sending;
    $('send').title = block || label; $('send').setAttribute('aria-label', label);
    $('send').disabled = sending || !!block || !box.value.trim();
    $('clear').disabled = sending || !box.value;
    const hint = $('send-hint');
    // Nothing to say, nothing shown: the bottom is just the input.
    hint.textContent = sending ? `正在发给 ${m.label} 队长…` : block || sendStatus;
    hint.hidden = !hint.textContent;
    hint.classList.toggle('blocked', !sending && !!block);
  }
  $('message').addEventListener('input', () => { sendStatus = ''; updateComposer(); });
  $('clear').addEventListener('click', () => { $('message').value = ''; sendStatus = ''; updateComposer(); $('message').focus(); });
  $('message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    // The destination is fixed here, at the moment of the tap, and never changes afterwards.
    const m = byId(target), text = $('message').value;
    if (sending || !m || !text.trim() || Core.sendBlock(m)) return;
    const item = { id: ++outboxId, machineId: m.id, text, state: 'sending', reason: '' };
    outbox.push(item); sending = true; sendStatus = ''; $('message').value = '';
    render();
    const result = await post(m, 'api/captain', { message: text });
    sending = false;
    if (result.status === 200 && result.body && result.body.queued) {
      outbox.splice(outbox.indexOf(item), 1);
      sendStatus = `已排队到 ${m.label} 队长。`;
    } else { item.state = 'failed'; item.reason = Core.sendFailure(result, m.label); }
    render(); poll(m);
  });

  // ---- sessions and output -------------------------------------------------
  function renderSessions() {
    const groups = $('session-groups');
    if (!changed(groups, [filter, machines.map((m) => [m.id, m.state, m.snap && m.snap.sessions, m.state === 'online' ? '' : lastSeen(m)])])) return;
    groups.replaceChildren();
    for (const m of shown()) {
      const section = node('section', 'group');
      section.setAttribute('aria-label', `${m.label} 的会话`);
      const head = node('div', 'group-head'), names = node('div', 'machine-names');
      const sessions = m.snap ? m.snap.sessions : [];
      names.append(node('h2', '', m.label), node('p', 'machine-sub', m.snap ? `${sessions.filter((s) => s.status === 'working').length} 个干活中 · 共 ${sessions.length} 个` : lastSeen(m)));
      head.append(glyph(m), names, pill(m.state));
      section.append(head);
      if (!m.snap) section.append(node('p', 'empty', `${m.label} ${Core.STATES[m.state].label}，现在看不到它的会话。`));
      else if (!sessions.length) section.append(node('p', 'empty', '暂无会话。先在这台电脑上创建队长或队员。'));
      const ordered = [...sessions.filter((s) => s.isMain), ...sessions.filter((s) => !s.isMain && s.status === 'working'), ...sessions.filter((s) => !s.isMain && s.status !== 'working')];
      for (const session of ordered) {
        const button = node('button', 'session-card' + (session.isMain ? ' is-captain' : ''));
        button.type = 'button'; button.setAttribute('aria-label', `${m.label} · ${session.title}`);
        const top = node('div', 'session-top');
        top.append(node('span', 'session-role', `${m.label} · ${session.isMain ? '队长' : '队员'}`), statusBadge(session.status));
        const heading = node('div', 'session-heading'), arrow = node('span', 'session-arrow'); arrow.innerHTML = svg('chevron');
        heading.append(node('h3', '', session.title), arrow);
        button.append(top, heading, node('p', 'session-model', session.model || '模型未识别'));
        if (session.receipt) { const receipt = node('div', 'receipt'); receipt.append(node('span', 'receipt-label', '最近回执'), node('p', '', session.receipt)); button.append(receipt); }
        button.addEventListener('click', () => { if (session.isMain) { setTarget(m.id); showView('captain'); } else openOutput(m, session); });
        section.append(button);
      }
      groups.append(section);
    }
  }
  async function loadOutput(silent) {
    if (!output) return;
    const m = byId(output.machineId), call = ++outputRequest;
    $('output-machine').textContent = `${m.label} · 队员输出 · 只读`;
    $('output-title').textContent = output.title;
    $('brand-title').textContent = m.label; $('brand-caption').textContent = '队员输出';
    if (!silent) { $('copy').disabled = true; $('output-text').textContent = '正在读取输出…'; }
    if (m.state !== 'online') { $('copy').disabled = true; $('output-text').textContent = `${m.label} ${Core.STATES[m.state].label}，现在读不到输出。`; return; }
    const result = await request(m, 'api/output?id=' + encodeURIComponent(output.id));
    if (call !== outputRequest || view !== 'output') return;
    if (result.status === 200 && result.body) { $('output-text').textContent = result.body.text || '暂无输出。'; $('copy').disabled = !result.body.text; }
    else { $('copy').disabled = true; $('output-text').textContent = result.status === 404 ? '这个会话已经不在了。' : `没能读到 ${m.label} 的输出，稍后会自动重试。`; }
  }
  function openOutput(m, session) { output = { machineId: m.id, id: session.id, title: session.title }; showView('output'); loadOutput(false); }
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('output-text').textContent);
      $('copy').innerHTML = svg('check'); $('copy').title = '已复制'; $('copy').setAttribute('aria-label', '已复制'); $('copy').classList.add('copied');
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { $('copy').innerHTML = svg('copy'); $('copy').title = '复制输出'; $('copy').setAttribute('aria-label', '复制输出'); $('copy').classList.remove('copied'); }, 1600);
    } catch (_) { notice('无法复制。可以长按输出文字手动选择。', true); }
  });

  // ---- board ---------------------------------------------------------------
  function renderBoard() {
    const sources = machines.filter((m) => m.cards);
    const cards = Core.mergeCards(sources).filter((card) => !card.archived);
    const known = machines.map((m) => ({ label: m.label, hostname: m.hostname || m.meta.hostname }));
    if (!changed($('projects'), [boardFilter, cards, known, machines.map((m) => [m.state, !!m.cards])])) return;
    const missing = machines.filter((m) => !m.cards);
    $('board-sources').textContent = !sources.length ? '还没有读到任何一台电脑的看板。'
      : missing.length ? `现在只有 ${sources.map((m) => m.label).join('、')} 看到的看板；${missing.map((m) => `${m.label} ${Core.STATES[m.state].label}`).join('，')}。`
      : `已合并 ${sources.map((m) => m.label).join(' 和 ')} 的看板，同一张卡以最后更新的为准。`;
    const filters = $('board-filters'); filters.replaceChildren();
    for (const [status, label] of [['all', '全部'], ...taskStatuses]) {
      const count = status === 'all' ? cards.length : cards.filter((card) => card.status === status).length;
      const chip = node('button', 'chip'); chip.type = 'button'; chip.setAttribute('aria-pressed', String(boardFilter === status));
      chip.append(node('span', '', label), node('span', 'chip-count', String(count)));
      chip.addEventListener('click', () => { boardFilter = status; renderBoard(); });
      filters.append(chip);
    }
    const projects = $('projects'); projects.replaceChildren();
    const grouped = new Map();
    for (const card of cards.filter((c) => boardFilter === 'all' || c.status === boardFilter)) {
      if (!grouped.has(card.project)) grouped.set(card.project, []);
      grouped.get(card.project).push(card);
    }
    if (!grouped.size) { projects.append(node('p', 'empty', cards.length ? '这个状态下没有任务。' : '暂无任务。任务在桌面端创建后会显示在这里。')); return; }
    const order = taskStatuses.map(([status]) => status);
    for (const [project, tasks] of grouped) {
      const section = node('section', 'project'), heading = node('div', 'project-heading');
      heading.append(node('h2', '', project), node('span', '', tasks.length + ' 项'));
      section.append(heading);
      for (const task of tasks.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))) {
        const card = node('article', 'task-card'); card.dataset.status = task.status;
        const top = node('div', 'task-top');
        top.append(node('span', 'task-status', (taskStatuses.find(([status]) => status === task.status) || [0, task.status])[1]));
        if (task.flag) top.append(node('span', 'task-flag ' + task.flag, flagNames[task.flag] || task.flag));
        const owner = Core.ownerLabel(task, known);
        if (owner) top.append(node('span', 'task-owner', `${owner} 领取`));
        card.append(top, node('h3', '', task.title));
        if (task.assignee) card.append(node('p', 'task-assignee', [task.assignee.agent, task.assignee.model].filter(Boolean).join(' · ')));
        if (task.latest_receipt) card.append(node('p', 'task-receipt', task.latest_receipt));
        section.append(card);
      }
      projects.append(section);
    }
  }

  // ---- shell ---------------------------------------------------------------
  function showView(next) {
    if (view === 'output' && next !== 'output') { outputRequest++; output = null; $('output-text').textContent = ''; }
    view = next;
    ['overview', 'captain', 'sessions', 'board', 'output'].forEach((name) => { $(name + '-view').hidden = name !== view; });
    document.querySelectorAll('[data-view]').forEach((button) => {
      if (button.dataset.view === (view === 'output' ? 'sessions' : view)) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('back').hidden = view !== 'output';
    $('main').classList.toggle('fill', view === 'captain');
    if (view !== 'output') { $('brand-title').textContent = 'AgentDeck'; $('brand-caption').textContent = '总台'; }
    $('main').scrollTop = 0;
    render();
    if (view === 'captain') $('captain-turns').scrollTop = $('captain-turns').scrollHeight;
  }
  function render() {
    renderBusy(); renderBar(); renderOverview(); renderCaptain(); renderSessions(); renderBoard();
    $('logout-all').disabled = !machines.some((m) => m.state === 'online');
  }
  $('refresh').addEventListener('click', refreshAll);
  $('back').addEventListener('click', () => showView('sessions'));
  {
    const label = $('logout-all').title;
    armed($('logout-all'), label, '再点一次，确认在这部手机上退出所有电脑', () => logout(machines.filter((m) => m.state === 'online')));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  // Polling only runs while the page is visible; each machine keeps its own pace.
  setInterval(() => {
    if (document.hidden) return;
    const now = Date.now();
    machines.forEach((m) => { if (!m.busy && now >= m.nextAt) poll(m); });
  }, 1000);

  async function start() {
    let list = [];
    try { list = Core.machineList(await (await fetch('machines.json', { cache: 'no-store', redirect: 'error' })).json()); } catch (_) { /* Reported below. */ }
    if (!list.length) { notice('没有读到电脑列表（machines.json）。请刷新重试。', true); return; }
    let meta = {};
    try { meta = JSON.parse(stored(KEYS.meta)) || {}; } catch (_) { /* Start without remembered metadata. */ }
    machines = list.map((m) => ({ ...m, state: 'unknown', detail: '', snap: null, csrf: '', cards: null, boardVersion: null, hostname: '',
      meta: Core.cleanMeta(meta[m.id]), quota: null, quotaFailed: false, quotaAt: 0, forceQuota: false, current: false, nextAt: 0, busy: false, again: false, banUntil: 0, loginError: '', loginBusy: false, logoutBusy: false, card: node('article', 'machine-card') }));
    machines.forEach((m) => { m.card.setAttribute('aria-label', m.label); $('machine-cards').append(m.card); });
    const saved = stored(KEYS.machine);
    filter = byId(saved) ? saved : 'all';
    // With nothing chosen, work goes to the default machine (Mac) until the user picks another.
    target = filter !== 'all' ? filter : (machines.find((m) => m.default) || machines[0]).id;
    showView('overview');
    refreshAll();
  }
  start();
})();
