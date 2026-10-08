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
    attention: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    restore: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
    desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
    crown: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.5m0 2.6v.2"/>',
    done: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.2 9.5"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    todo: '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8M13 12h8M13 18h8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
    shrink: '<path d="M20 10h-6V4M4 14h6v6M14 10l6-6M10 14l-6 6"/>',
    code: '<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
    paneRight: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>',
    paneLeft: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
    down: '<path d="M12 5v14m0 0-5.5-5.5M12 19l5.5-5.5"/>',
    swap: '<path d="M4 8h14m0 0-3.5-3.5M18 8l-3.5 3.5M20 16H6m0 0 3.5-3.5M6 16l3.5 3.5"/>',
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
  const KEYS = { theme: 'agentdeck-hub-theme', machine: 'agentdeck-hub-machine', meta: 'agentdeck-hub-meta', view: 'agentdeck-hub-view' };
  const TABS = ['overview', 'captain', 'todo', 'sessions', 'board'];

  let machines = [], filter = 'all', target = '', view = 'overview', output = null, outputRequest = 0;
  // Images picked for the next message; each was uploaded to the computer it will be sent to.
  let attachments = [];
  let sending = false, sendStatus = '', boardFilter = 'all', copyTimer, outboxId = 0;
  // 随手记待办: a write in flight, the line under the box, and ticks shown before their computer confirms them.
  let todoSaving = false, todoHint = '', todoHintError = false, todoDoneOpen = false;
  const todoPending = new Map();
  // Quota rows whose details are open, as 'machine:key'. Memory only.
  const openQuota = new Set();
  // What this phone sent and the conversation does not show yet (memory only):
  // on its way, accepted and waiting for the Captain, or failed. `arrived` keeps
  // the last minute of delivered ones, to notice the same words sent twice.
  const outbox = [], arrived = [];
  let repeatAsked = null;
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
  for (const [id, icon] of [['refresh', 'refresh'], ['logout-all', 'logout'], ['back', 'back'], ['copy', 'copy'], ['send', 'send'], ['clear', 'trash'], ['attach', 'plus'], ['todo-add', 'plus'], ['side-toggle', 'paneLeft'], ['pane-toggle', 'paneRight'], ['preview-back', 'back'], ['jump', 'down']]) $(id).innerHTML = svg(icon);
  // Scrolled up to read: new replies do not pull the page down; this button shows instead, with a dot when something new came in.
  const awayFromEnd = () => { const el = $('captain-turns'); return el.scrollHeight - el.scrollTop - el.clientHeight > 160; };
  function updateJump() { const away = awayFromEnd(); $('jump').hidden = !away; if (!away) { $('jump').classList.remove('fresh'); $('jump').title = '回到最新'; $('jump').setAttribute('aria-label', '回到最新'); } }
  $('captain-turns').addEventListener('scroll', updateJump, { passive: true });
  $('jump').addEventListener('click', () => { const el = $('captain-turns'); el.scrollTo({ top: el.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); $('jump').classList.remove('fresh'); });
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.querySelector('.nav-icon').innerHTML = svg(button.dataset.view);
    button.addEventListener('click', () => {
      showView(button.dataset.view);
      // Tapping 待办 is for writing one down: the cursor (and the phone's keyboard) goes straight to the box.
      if (view === 'todo') $('todo-text').focus();
    });
  });

  // ---- shell ---------------------------------------------------------------
  // The shell is pinned to what is visible. iOS Safari keeps the page its full
  // height under the soft keyboard and pans it instead, so the shell takes the
  // visual viewport's height and follows its offset: the input sits on the
  // keyboard and the conversation scrolls above it. The keyboard counts as
  // open while a text field has focus and the visible height is well below
  // the tallest seen at this width; the bottom navigation hides then.
  const viewport = window.visualViewport, shell = document.querySelector('.app');
  let fullHeight = 0, fullWidth = 0;
  function fitViewport() {
    if (!viewport) return;
    const turns = $('captain-turns'), follow = turns.scrollHeight - turns.scrollTop - turns.clientHeight < 48;
    const root = document.documentElement.style, typing = !!document.activeElement && document.activeElement.matches('textarea, input');
    root.setProperty('--app-height', viewport.height + 'px');
    root.setProperty('--app-top', viewport.offsetTop + 'px');
    // A window resized with no field in use (iPad split view) starts the measure again.
    if (viewport.width !== fullWidth || !typing) { fullWidth = viewport.width; fullHeight = 0; }
    fullHeight = Math.max(fullHeight, viewport.height, window.innerHeight);
    shell.classList.toggle('keyboard-open', typing && fullHeight - viewport.height > 120);
    if (follow) turns.scrollTop = turns.scrollHeight;
  }
  if (viewport) {
    viewport.addEventListener('resize', fitViewport);
    viewport.addEventListener('scroll', fitViewport);
    window.addEventListener('resize', fitViewport);
    document.addEventListener('focusin', fitViewport);
    document.addEventListener('focusout', fitViewport);
    fitViewport();
  }
  // A finger that drags where nothing scrolls, or past the end of a list, would
  // pull the whole page and the input with it (the rubber band). Decided once
  // per touch, on its first move; sideways drags and pinches are left alone.
  let drag = null;
  document.addEventListener('touchstart', (event) => { drag = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, held: null } : null; }, { passive: true });
  document.addEventListener('touchmove', (event) => {
    if (!drag || event.touches.length !== 1) return;
    if (drag.held === null) {
      const dx = event.touches[0].clientX - drag.x, dy = event.touches[0].clientY - drag.y;
      if (Math.abs(dx) > Math.abs(dy)) drag.held = false;
      else {
        let scroller = null;
        for (let el = event.target; el && el !== document.body && !scroller; el = el.parentElement) {
          if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) scroller = el;
        }
        drag.held = Core.dragMovesPage(scroller, dy);
      }
    }
    if (drag.held && event.cancelable) event.preventDefault();
  }, { passive: false });

  // ---- network -------------------------------------------------------------
  // Every request names its machine; the prefix is the only routing there is.
  async function request(m, path, { timeout = Core.TIMEOUT, ...options } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
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
    if (m.state !== 'online') { m.snap = null; m.csrf = ''; m.quota = null; m.quotaFailed = false; m.quotaAt = 0; m.relay = null; m.relayAt = 0; }
    // A machine that no longer accepts this phone must not keep showing its board.
    if (m.state === 'login' || m.state === 'upgrade') { m.cards = null; m.boardVersion = null; m.todos = null; m.todosReady = null; m.todosAt = 0; }
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
      // To-dos: every poll while the 待办 tab is open, otherwise every 30 seconds for the tab's count.
      if (view === 'todo' || m.forceQuota || !m.todosAt || Date.now() - m.todosAt > 30000) await loadTodos(m);
      // Quota moves slowly: read it at most every 30 seconds, and on a manual refresh.
      // The Captain's accounts move as slowly as quota, except while the switch sheet is open on this computer.
      // A running switch has its own faster watch.
      if ((!m.relayJob || m.relayJob.phase !== 'switching') && (m.forceQuota || !m.relayAt || Date.now() - m.relayAt > 30000 || (sheet && sheet.machineId === m.id))) await loadRelay(m);
      if (m.forceQuota || !m.quotaAt || Date.now() - m.quotaAt > 30000) {
        m.forceQuota = false;
        const quota = await request(m, 'api/quota');
        // 404: an older build without the quota route; nothing to show, nothing failed.
        if (quota.status === 200 && quota.body) { m.quota = Core.cleanQuota(quota.body); m.quotaFailed = false; }
        else if (quota.status === 404) { m.quota = null; m.quotaFailed = false; } else m.quotaFailed = true;
        m.quotaAt = Date.now();
      }
      // 待我处理: every poll while its tab or the 队长 chat (whose replies read reports) is open,
      // otherwise every 30 seconds for the tab's count.
      if (view === 'attention' || view === 'captain' || !m.attentionAt || Date.now() - m.attentionAt > 30000) await loadAttention(m);
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
    // An uploaded image lives on one computer; switching the destination drops it.
    if (id !== target && attachments.length) { attachments.forEach((item) => item.request && item.request.abort()); attachments = []; renderAttachments(); }
    target = id; sendStatus = '';
    // Keep the top switch and the dispatch target telling the same story.
    if (!fromFilter && filter !== 'all') { filter = id; store(KEYS.machine, id); }
    render();
  }
  // The computer switch lives in the header: a dot and the name, one tap each.
  // In the Captain view it picks who the message goes to, elsewhere what is shown.
  function renderBar() {
    const bar = $('machine-bar');
    // One list for both computers on the 待办 tab, so there is nothing to pick there.
    bar.hidden = view === 'output' || view === 'todo';
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
  // `where` keeps ids apart when the same table stands in a computer's card and in the sidebar.
  function quotaSection(m, where = '') {
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
      const detail = quotaDetails(m, row, now); detail.hidden = !open; detail.id = 'quota-detail-' + where + id.replace(/[^\w-]/g, '_');
      button.setAttribute('aria-controls', detail.id);
      button.addEventListener('click', () => {
        if (openQuota.has(id)) openQuota.delete(id); else openQuota.add(id);
        signatures.delete(m.card); signatures.delete($('side-quota')); render();
        // The table is rebuilt: put the focus back on the row that was tapped.
        document.querySelector(`[aria-controls="${detail.id}"]`)?.focus({ preventScroll: true });
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
      online ? [m.snap.machine, m.snap.captain && [m.snap.captain.id, m.snap.captain.status], m.meta.workingCount, m.meta.sessionCount, receipt, m.quota, m.quotaFailed, seatSignature(m), [...openQuota].filter((id) => id.startsWith(m.id + ':')), Math.floor(Date.now() / 60000)] : [m.meta, lastSeen(m)]];
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
      const seat = seatRow(m);
      if (seat) card.append(seat);
      if (m.quota) card.append(quotaSection(m));
      const block = node('div', 'receipt');
      block.append(node('span', 'receipt-label', receipt ? '最近回执 · ' + receipt.title : '最近回执'), receipt ? markdownNode(receipt.text, { reply: true, className: 'receipt-text' }) : node('p', '', '还没有队员提交回执。'));
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

  // ---- switching the Captain's account ---------------------------------------
  // Each computer has its own Captain on its own accounts. The sheet belongs to
  // one computer from the moment it opens: every request in it goes to that
  // computer's prefix, whatever the header switch shows afterwards.
  let sheet = null; // { machineId, step: 'pick' | 'confirm', seatId }
  const dialog = node('dialog', 'sheet');
  dialog.id = 'switch-sheet'; dialog.setAttribute('aria-labelledby', 'switch-title');
  document.querySelector('.app').append(dialog);
  const captainSeat = node('div', 'captain-seat-bar'); captainSeat.id = 'captain-seat'; captainSeat.hidden = true;
  $('captain-turns').before(captainSeat);

  async function loadRelay(m) {
    const result = await request(m, 'api/relay');
    // 404: an older build without the switch; the entry is simply not offered.
    if (result.status === 200 && result.body) { m.relay = Core.cleanRelay(result.body); m.relayFailed = false; }
    else if (result.status === 404) { m.relay = null; m.relayFailed = false; } else m.relayFailed = true;
    m.relayAt = Date.now();
    return result.status === 200 && result.body ? m.relay : null;
  }
  const seatLevel = (seat) => {
    const cell = seat && (seat.cells.find((c) => c.key === '5h') || seat.cells[0]);
    return !cell ? 'none' : cell.out ? 'out' : cell.remaining <= 10 ? 'danger' : cell.remaining <= 20 ? 'low' : 'ok';
  };
  const seatSignature = (m) => [m.relay, m.relayJob && [m.relayJob.phase, m.relayJob.targetName], m.csrf ? 1 : 0];
  // "队长在用 Claude US · 5 小时剩 72%" with the one worded action next to it.
  function seatRow(m, inCaptain) {
    if (m.state !== 'online' || !m.relay || !m.relay.captainId) return null;
    const seat = Core.currentSeat(m.relay), job = m.relayJob, busy = job && job.phase === 'switching';
    const row = node('div', 'captain-seat'); row.dataset.level = busy ? 'none' : seatLevel(seat);
    const info = node('div', 'captain-seat-info'), label = node('span', 'captain-seat-label');
    label.innerHTML = svg('crown'); label.append(inCaptain ? `${m.label} 队长在用` : '队长在用');
    const value = node('span', 'captain-seat-value', busy ? `正在换到 ${job.targetName}…` : seat ? Core.seatLabel(seat) : '账号未知');
    info.append(label, value);
    // The slim line in the conversation has room for the nearest limit only.
    const quota = !busy && Core.seatQuotaText(inCaptain && seat ? { cells: seat.cells.slice(0, 1) } : seat);
    if (quota) info.append(node('span', 'captain-seat-quota', quota));
    const button = node('button', 'text-button', busy ? '查看进度' : '切换队长');
    button.type = 'button'; button.dataset.switch = m.id; button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-label', busy ? `查看 ${m.label} 队长的切换进度` : `切换 ${m.label} 队长`);
    button.addEventListener('click', () => openSwitch(m));
    row.append(info, button);
    return row;
  }
  function openSwitch(m) {
    sheet = { machineId: m.id, step: 'pick', seatId: '' };
    signatures.delete(dialog); renderSheet();
    if (!dialog.open) dialog.showModal();
    // Always pick from a fresh answer of this computer, not from what was on screen.
    if (!m.relayJob) loadRelay(m).then(() => renderSheet());
  }
  dialog.addEventListener('close', () => {
    const m = sheet && byId(sheet.machineId), opener = m && document.querySelector(`[data-switch="${m.id}"]`);
    // A finished switch has been read. A running one carries on and reports in the notice line.
    if (m && m.relayJob && m.relayJob.phase !== 'switching') m.relayJob = null;
    sheet = null; render();
    (m && document.querySelector(`#${view}-view [data-switch="${m.id}"]`) || opener)?.focus({ preventScroll: true });
  });
  // A tap on the dimmed page closes the sheet; a tap inside it does not.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

  function watchJob(m) {
    clearTimeout(m.relayTimer);
    const job = m.relayJob;
    if (!job || job.phase !== 'switching') return;
    m.relayTimer = setTimeout(async () => {
      const relay = await loadRelay(m);
      if (m.relayJob !== job) return;
      job.unreachable = !relay;
      const outcome = Core.relayOutcome(job, relay);
      if (outcome.phase === 'switching') { render(); watchJob(m); } else finishJob(m, job, outcome);
    }, 1500);
  }
  function finishJob(m, job, outcome) {
    job.phase = outcome.phase; job.error = outcome.error;
    // A new Captain is a new conversation: read this computer again right away.
    m.forceQuota = true; m.nextAt = 0; poll(m);
    if (!sheet || sheet.machineId !== m.id) {
      const seat = Core.currentSeat(m.relay);
      notice(job.phase === 'done' ? `${m.label} 队长已换到 ${job.targetName}。` : `${m.label} 队长没有换成：${job.error}${seat ? ` 队长现在用的是 ${Core.seatLabel(seat)}。` : ''}`, job.phase !== 'done');
      m.relayJob = null;
    }
    render();
  }
  async function startSwitch(m, seat) {
    const from = Core.currentSeat(m.relay);
    const job = m.relayJob = { id: '', phase: 'switching', targetId: seat.id, targetName: Core.seatLabel(seat), fromName: Core.seatLabel(from), startedAt: Date.now(), error: '', unreachable: false };
    render();
    const result = await post(m, 'api/relay', { seatId: seat.id, ...(m.relay.currentId ? { expectCurrent: m.relay.currentId } : {}) });
    if (m.relayJob !== job) return;
    if (result.status === 200 && result.body && result.body.started === true && typeof result.body.id === 'string') { job.id = result.body.id; watchJob(m); return; }
    // No confirmation: this computer's own record says whether a switch is running.
    const relay = await loadRelay(m);
    if (m.relayJob !== job) return;
    if (result.timedOut && relay && relay.job && relay.job.status === 'switching' && relay.job.targetId === seat.id) { job.id = relay.job.id; watchJob(m); render(); return; }
    finishJob(m, job, { phase: 'failed', error: Core.relayRefusal(result, m.label) });
  }
  function seatOption(m, seat, now) {
    const button = node('button', 'seat-option'); button.type = 'button'; button.dataset.seatId = seat.id; button.dataset.provider = seat.provider;
    if (seat.current) button.dataset.current = 'true';
    // Not `disabled`: an account that cannot be picked still has to be reachable to read why.
    if (!seat.selectable) button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-label', Core.seatSpoken(seat, now));
    const icon = node('span', 'quota-icon'); icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = providerIcons[seat.provider] || '';
    const main = node('span', 'seat-main'), top = node('span', 'seat-top');
    top.append(node('span', 'seat-name', Core.seatLabel(seat)));
    if (seat.current) { const tag = node('span', 'seat-tag'); tag.innerHTML = svg('crown'); tag.append('队长在用'); top.append(tag); }
    main.append(top);
    if (seat.account) main.append(node('span', 'seat-account', seat.account));
    const reason = seat.current ? '' : Core.seatReason(seat, now);
    if (reason) { const line = node('span', 'seat-reason', reason); if (!seat.selectable) line.dataset.blocked = 'true'; main.append(line); }
    const values = node('span', 'seat-values');
    for (const cell of seat.cells) {
      const el = node('span', 'seat-cell'); el.dataset.level = cell.out ? 'out' : cell.remaining <= 10 ? 'danger' : cell.remaining <= 20 ? 'low' : 'ok';
      el.append(node('span', 'seat-cell-key', cell.key), node('span', 'seat-cell-value', Core.percentText(cell)));
      values.append(el);
    }
    button.append(icon, main, values);
    button.addEventListener('click', () => { if (!seat.selectable) return; sheet.step = 'confirm'; sheet.seatId = seat.id; renderSheet(); });
    return button;
  }
  function renderSheet() {
    if (!sheet) return;
    const m = byId(sheet.machineId), job = m.relayJob, relay = m.relay, now = Date.now();
    const picked = relay && relay.seats.find((seat) => seat.id === sheet.seatId && seat.selectable);
    // The chosen account stopped being available while the question was on screen: back to the list.
    if (!job && sheet.step === 'confirm' && !picked) sheet.step = 'pick';
    const phase = job ? job.phase : sheet.step;
    if (!changed(dialog, [m.id, m.label, m.state, phase, sheet.seatId, relay, m.relayFailed, job && [job.targetName, job.fromName, job.error, job.unreachable], Math.floor(now / 60000)])) return;
    const focused = dialog.contains(document.activeElement) ? document.activeElement.dataset.seatId || document.activeElement.dataset.action : null;
    const moved = dialog.dataset.phase !== phase;
    dialog.dataset.phase = phase;
    const body = node('div', 'sheet-body'), head = node('div', 'sheet-head'), title = node('h2', '', '');
    title.id = 'switch-title'; title.tabIndex = -1;
    const close = iconButton('close', '关闭'); close.dataset.action = 'close';
    close.addEventListener('click', () => dialog.close());
    head.append(glyph(m), title, close); body.append(head);
    const text = (className, value) => { const el = node('p', className, value); body.append(el); return el; };
    const action = (className, label, name, onClick) => { const button = node('button', className, label); button.type = 'button'; button.dataset.action = name; button.addEventListener('click', onClick); return button; };
    const figure = (icon, tone) => { const el = node('div', 'sheet-figure tone-' + tone); if (icon) el.innerHTML = svg(icon); else el.append(node('span', 'spinner')); el.setAttribute('aria-hidden', 'true'); body.append(el); };
    const route = (from, to) => { const el = node('div', 'sheet-route'), arrow = node('span', 'sheet-route-arrow'); arrow.innerHTML = svg('arrow'); arrow.setAttribute('aria-hidden', 'true');
      const target = node('span', 'sheet-route-seat target', to); el.append(node('span', 'sheet-route-seat', from || '现在的账号'), arrow, target); el.setAttribute('aria-label', `从 ${from || '现在的账号'} 换到 ${to}`); body.append(el); };
    const current = Core.currentSeat(relay);
    if (phase === 'pick') {
      title.textContent = `切换 ${m.label} 队长`;
      if (!relay) text('sheet-lead', m.state !== 'online' ? `${m.label} ${Core.STATES[m.state].label}，现在换不了队长。` : m.relayFailed ? `暂时读不到 ${m.label} 的账号，稍后会自动重试。` : `正在读取 ${m.label} 的账号…`);
      else {
        text('sheet-lead', current ? `只换 ${m.label} 这台电脑的队长。它现在用的是 ${Core.seatLabel(current)}，要换到哪个账号？` : `只换 ${m.label} 这台电脑的队长。要换到哪个账号？`);
        const list = node('div', 'seat-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', `${m.label} 可以用的账号`);
        for (const seat of relay.seats) list.append(seatOption(m, seat, now));
        body.append(list);
        if (!relay.seats.some((seat) => seat.selectable)) text('sheet-note warn', '现在没有别的账号可以换。等额度恢复，或回到电脑上登录别的账号。');
        else text('sheet-note', '选好以后还会再问你一次。');
      }
    } else if (phase === 'confirm') {
      title.textContent = `确认切换 ${m.label} 队长？`;
      route(Core.seatLabel(current), Core.seatLabel(picked));
      text('sheet-lead', `${m.label} 现在这位队长会先把进度存好再下线，新队长用 ${Core.seatLabel(picked)} 读着存档接着干。`);
      text('sheet-note warn', '换了以后，现在这位队长正在说的话会中断，它没存下来的内容会丢。派出去的队员和任务不受影响。');
      if (picked.reason === 'unknown') text('sheet-note', `${Core.seatLabel(picked)} 的额度还不清楚，换过去以后可能马上又不够用。`);
      const actions = node('div', 'sheet-actions');
      actions.append(action('primary', '确认切换', 'confirm', () => startSwitch(m, picked)), action('secondary', '先不换', 'back', () => { sheet.step = 'pick'; sheet.seatId = ''; renderSheet(); }));
      body.append(actions);
    } else if (phase === 'switching') {
      title.textContent = `正在切换 ${m.label} 队长`;
      figure('', 'accent'); route(job.fromName, job.targetName);
      const status = text('sheet-lead', '先让现在的队长存好进度，再启动新队长。一般不到一分钟，队长正忙的时候最长要几分钟。'); status.setAttribute('role', 'status');
      const waited = text('sheet-elapsed', '已经等了 ' + Core.elapsedText(now - job.startedAt)); waited.id = 'switch-elapsed';
      if (job.unreachable) text('sheet-note warn', `暂时连不上 ${m.label}。恢复以后这里会自动显示结果，不用重新点。`);
      text('sheet-note', '可以先关掉这个窗口，切换会继续，结果会显示在页面顶部。');
    } else if (phase === 'done') {
      title.textContent = `已换到 ${job.targetName}`;
      figure('done', 'ok');
      const status = text('sheet-lead', `${m.label} 的新队长已经用 ${job.targetName} 接手，正在读存档。这里会自动连到新队长。`); status.setAttribute('role', 'status');
      const actions = node('div', 'sheet-actions');
      actions.append(action('primary', '去看新队长', 'view', () => { dialog.close(); setTarget(m.id); showView('captain'); }));
      body.append(actions);
    } else {
      title.textContent = `${m.label} 队长没有换成`;
      figure('alert', 'bad');
      const status = text('sheet-lead', job.error); status.setAttribute('role', 'alert');
      text('sheet-note', current ? `${m.label} 队长现在用的还是 ${Core.seatLabel(current)}${current.id === job.targetId ? '' : '，没有变化'}。` : `${m.label} 队长的账号暂时读不到，恢复连接后会显示。`);
      const actions = node('div', 'sheet-actions');
      actions.append(action('secondary', '重新选账号', 'retry', () => { m.relayJob = null; sheet.step = 'pick'; sheet.seatId = ''; renderSheet(); loadRelay(m).then(() => renderSheet()); }));
      body.append(actions);
    }
    dialog.replaceChildren(body);
    // A new step is announced from its title; a refreshed list keeps the finger where it was.
    if (moved && dialog.open) title.focus({ preventScroll: true });
    else if (focused) dialog.querySelector(`[data-seat-id="${focused}"], [data-action="${focused}"]`)?.focus({ preventScroll: true });
  }

  // ---- captain -------------------------------------------------------------
  // One round: what the user said on the right, then one bubble on the left with
  // the Captain's words. Dispatching, receipts and tool steps are not shown.
  function copyText(button, text, label) {
    navigator.clipboard.writeText(text).then(() => {
      button.innerHTML = svg('check'); button.title = '已复制'; button.setAttribute('aria-label', '已复制'); button.classList.add('copied');
      setTimeout(() => { button.innerHTML = svg('copy'); button.title = label; button.setAttribute('aria-label', label); button.classList.remove('copied'); }, 1600);
    }).catch(() => notice('无法复制。可以长按文字手动选择。', true));
  }
  // What the user said: the same bubble whether it is still on its way or already in the computer's record.
  function mineBubble(words, extra) {
    const prompt = node('div', 'bubble mine' + extra);
    prompt.append(node('span', 'sr-only', '你'));
    if (!words) return prompt;
    const text = node('p', 'bubble-text', words);
    prompt.append(text);
    // Long messages fold to a few lines; the whole text stays in the page.
    if (words.length > 500 || words.split('\n').length > 10) {
      text.classList.add('clamped');
      const toggle = node('button', 'expand-toggle', '展开全文');
      toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        const open = text.classList.toggle('clamped') === false;
        toggle.textContent = open ? '收起' : '展开全文'; toggle.setAttribute('aria-expanded', String(open));
      });
      prompt.append(toggle);
    }
    return prompt;
  }
  function renderGroup(m, group) {
    const row = node('article', 'turn');
    row.dataset.machine = m.id;
    if (group.id) row.dataset.turnId = group.id;
    if (group.said && group.said.length) row.dataset.said = group.said.join(' ');
    if (group.user || group.images.length) {
      const prompt = mineBubble(group.user, '');
      if (group.images.length) prompt.append(node('span', 'bubble-state', `附 ${group.images.length} 张图片（在这台电脑上查看）`));
      row.append(prompt);
    }
    if (group.reply || group.pending || group.interrupted) {
      const reply = node('div', 'reply'), bubble = node('div', 'bubble');
      const label = node('span', 'bubble-label');
      label.innerHTML = svg('crown'); label.append(`${m.label} 队长`);
      bubble.append(label);
      if (group.reply) bubble.append(markdownNode(group.reply, { reply: true, className: 'bubble-md' }));
      else if (group.interrupted) bubble.append(node('p', 'bubble-text turn-state', '回复已中断。'));
      if (group.pending) {
        const pending = node('p', 'bubble-text pending');
        const typing = node('span', 'typing'); typing.setAttribute('aria-hidden', 'true');
        typing.append(node('i'), node('i'), node('i'));
        pending.append(typing, node('span', '', group.reply ? '处理中…' : '队长正在处理…'));
        bubble.append(pending);
      }
      reply.append(bubble);
      if (group.reply) {
        const actions = node('div', 'turn-actions');
        const copy = iconButton('copy', '复制队长回复');
        copy.addEventListener('click', () => copyText(copy, group.reply, '复制队长回复'));
        actions.append(copy);
        if (group.interrupted) actions.append(node('span', 'turn-state', '已中断'));
        reply.append(actions);
      }
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
    if (changed(captainSeat, [m.id, m.state, seatSignature(m)])) {
      const row = seatRow(m, true);
      captainSeat.hidden = !row; captainSeat.replaceChildren(...(row ? [row] : []));
    }
    const conversation = $('captain-turns');
    const turns = captain ? captain.turns || [] : [];
    // A sent message and the computer's record of it are one bubble: the record takes over in place.
    const mine = outbox.filter((item) => item.machineId === m.id), pending = Core.settleOutbox(mine, turns);
    for (const item of mine) if (!pending.includes(item)) { outbox.splice(outbox.indexOf(item), 1); if (item.state !== 'failed') arrived.push({ ...item, arrived: true }); }
    if (changed(conversation, [m.id, m.state, !!captain, captain && captain.status === 'working', turns, pending.map((item) => [item.id, item.state, item.reason]), sending, Core.sendBlock(m), m.state === 'online' ? '' : lastSeen(m)])) {
      const follow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48 || conversation.dataset.machine !== m.id;
      const scrollTop = conversation.scrollTop;
      conversation.dataset.machine = m.id;
      conversation.replaceChildren();
      if (m.state !== 'online') conversation.append(node('p', 'empty', `${m.label} ${Core.STATES[m.state].label}，${lastSeen(m)}。对话不会存在手机里，等它恢复后再显示。`));
      else if (!captain) conversation.append(node('p', 'empty', `${m.label} 还没有队长。先在那台电脑上创建队长。`));
      else if (!turns.length && !pending.length) conversation.append(node('p', 'empty', `还没有对话。发一条指令，让 ${m.label} 队长开始安排。`));
      for (const group of Core.groupTurns(turns)) conversation.append(renderGroup(m, group));
      for (const item of pending) {
        const failed = item.state === 'failed';
        const row = node('article', 'turn outgoing'), bubble = mineBubble(item.text || `（${item.images.length} 张图片）`, failed ? ' failed' : '');
        row.dataset.state = item.state;
        row.append(bubble);
        if (failed) {
          bubble.prepend(node('span', 'bubble-label', `没有发给 ${m.label}`));
          const foot = node('div', 'bubble-foot');
          const resend = iconButton('refresh', '重新发送这条消息');
          resend.disabled = sending || !!Core.sendBlock(m);
          resend.addEventListener('click', () => deliver(m, item));
          const edit = iconButton('pencil', '重新编辑这条消息');
          edit.addEventListener('click', () => {
            outbox.splice(outbox.indexOf(item), 1);
            const box = $('message');
            box.value = box.value ? box.value + '\n' + item.text : item.text;
            sendStatus = ''; render(); fitComposer(); box.focus();
          });
          foot.append(node('p', 'bubble-reason', item.reason), resend, edit); bubble.append(foot);
        } else {
          // Under the bubble, like a delivery receipt: on its way, then waiting for the Captain to take it.
          const state = node('p', 'bubble-meta'), mark = node('span', 'meta-mark'); mark.setAttribute('aria-hidden', 'true');
          if (item.state === 'sending') mark.append(node('span', 'spinner')); else mark.innerHTML = svg('check');
          state.append(mark, node('span', '', item.state === 'sending' ? '发送中…' : captain && captain.status === 'working' ? `已发出，${m.label} 队长忙完手上的就会看到` : `已发出，等 ${m.label} 队长接收`));
          row.append(state);
        }
        conversation.append(row);
      }
      conversation.scrollTop = follow ? conversation.scrollHeight : scrollTop;
      if (!follow) { $('jump').classList.add('fresh'); $('jump').title = '有新内容，回到最新'; $('jump').setAttribute('aria-label', '有新内容，回到最新'); }
      updateJump();
    }
    updateComposer();
  }
  function updateComposer() {
    const m = byId(target);
    if (!m) return;
    const block = Core.sendBlock(m), box = $('message'), label = `发送给 ${m.label} 队长`;
    box.placeholder = `写给 ${m.label} 队长…`;
    $('send').title = block || label; $('send').setAttribute('aria-label', label);
    const ready = attachments.every((item) => item.state === 'done');
    $('send').disabled = sending || !!block || !ready || !(box.value.trim() || attachments.length);
    $('attach').disabled = !!block;
    $('clear').hidden = !box.value;
    const hint = $('send-hint');
    // Nothing to say, nothing shown: the bottom is just the input.
    hint.textContent = sending ? `正在发给 ${m.label} 队长…` : block || sendStatus;
    hint.hidden = !hint.textContent;
    hint.classList.toggle('blocked', !sending && !!block);
  }
  // One line that grows with the draft; the conversation stays pinned to its newest reply.
  function fitComposer() {
    const box = $('message'), conversation = $('captain-turns');
    const follow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48;
    box.style.height = 'auto'; box.style.height = box.scrollHeight + 'px';
    if (follow) conversation.scrollTop = conversation.scrollHeight;
  }
  $('message').addEventListener('input', () => { sendStatus = ''; updateComposer(); fitComposer(); });
  $('clear').addEventListener('click', () => { $('message').value = ''; sendStatus = ''; updateComposer(); fitComposer(); $('message').focus(); });
  // ---- images ----
  // A picked or pasted image is shrunk on the phone, uploaded straight away to
  // the chosen computer and sent with the next message as a server-issued id.
  const imageId = /^[a-f0-9]{32}\.(?:jpg|png|gif|webp)$/;
  const MAX_IMAGES = 6, KEEP_BYTES = 800 * 1024, MAX_EDGE = 1600, THUMB_EDGE = 160;
  async function decode(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (_) { return createImageBitmap(file); }
  }
  function draw(bitmap, edge) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    // JPEG has no transparency; put screenshots with alpha on white.
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  // Small JPEG/PNG/GIF/WebP files go up unchanged. Anything larger, and any
  // other format the browser can decode (HEIC on iPhone), becomes a JPEG.
  async function prepare(file) {
    const bitmap = await decode(file);
    try {
      const thumb = draw(bitmap, THUMB_EDGE).toDataURL('image/jpeg', 0.75);
      if (/^image\/(?:jpeg|png|gif|webp)$/.test(file.type) && file.size <= KEEP_BYTES) return { thumb, blob: file };
      const blob = await new Promise((resolve) => draw(bitmap, MAX_EDGE).toBlob(resolve, 'image/jpeg', 0.82));
      if (!blob) throw new Error('encode');
      return { thumb, blob };
    } finally { bitmap.close(); }
  }
  function upload(item) {
    const m = byId(item.machineId);
    item.state = 'uploading'; item.progress = 0; renderAttachments();
    const request = new XMLHttpRequest();
    item.request = request;
    request.open('POST', m.basePath + 'api/upload');
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-CSRF-Token', m.csrf);
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      item.progress = event.loaded / event.total;
      if (item.bar) item.bar.style.width = Math.round(item.progress * 100) + '%';
    });
    const failed = (message) => { item.state = 'failed'; item.error = message; renderAttachments(); };
    request.addEventListener('load', () => {
      let id;
      try { id = JSON.parse(request.responseText).id; } catch (_) { /* Reported below. */ }
      if (request.status === 200 && imageId.test(id)) { item.state = 'done'; item.id = id; renderAttachments(); }
      else failed(request.status === 401 ? `${m.label} 需要重新登录，图片没传上去。` : request.status === 404 ? `${m.label} 上的 AgentDeck 版本太旧，还不能收图片。` : request.status === 413 ? '图片太大，没能上传。' : request.status === 415 ? '这种图片格式不支持。' : request.status === 507 ? '桌面端存手机图片的空间满了（最近一天传得太多），请明天再发图。' : '图片上传失败，可重试。');
    });
    request.addEventListener('error', () => failed('网络中断，图片没传上去，可重试。'));
    request.send(item.blob);
  }
  async function addImages(files) {
    const m = byId(target);
    const images = [...files].filter((file) => /^image\//.test(file.type) || /\.(?:heic|heif)$/i.test(file.name));
    if (!m || !images.length) return;
    for (const file of images) {
      try {
        const item = { ...(await prepare(file)), machineId: m.id };
        // Counted after decoding, so two quick picks cannot both use the same room.
        if (attachments.length >= MAX_IMAGES) { notice('一次最多发 ' + MAX_IMAGES + ' 张图片，多出的没有添加。', true); break; }
        if (target !== m.id) break;
        attachments.push(item);
        upload(item);
      } catch (_) { notice('有一张图片读不出来（这台设备不支持该格式），请换成截图、JPEG 或 PNG。', true); }
    }
    renderAttachments();
  }
  function renderAttachments() {
    const box = $('attachments');
    box.replaceChildren(); box.hidden = !attachments.length;
    attachments.forEach((item, i) => {
      const chip = node('div', 'attachment'); chip.dataset.state = item.state; chip.setAttribute('role', 'listitem');
      const img = node('img'); img.src = item.thumb; img.alt = '待发送的图片 ' + (i + 1);
      chip.append(img);
      if (item.state === 'uploading') {
        const track = node('span', 'upload-track'); track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', '正在上传图片 ' + (i + 1));
        item.bar = node('span', 'upload-bar'); item.bar.style.width = Math.round(item.progress * 100) + '%';
        track.append(item.bar); chip.append(track);
      } else if (item.state === 'failed') {
        const retry = iconButton('refresh', '重试上传', 'attachment-retry');
        retry.addEventListener('click', () => upload(item));
        chip.append(retry);
      }
      const remove = iconButton('close', '移除图片', 'attachment-remove');
      remove.addEventListener('click', () => {
        if (item.request) item.request.abort();
        attachments = attachments.filter((other) => other !== item);
        renderAttachments();
      });
      chip.append(remove);
      box.append(chip);
    });
    const failed = attachments.find((item) => item.state === 'failed');
    sendStatus = failed ? failed.error : attachments.some((item) => item.state === 'uploading') ? '正在上传图片…' : /图片/.test(sendStatus) ? '' : sendStatus;
    updateComposer(); fitComposer();
  }
  // Tapping remove or retry must not take focus from the message box: losing
  // it closes the keyboard and moves the thumbnails under the finger mid-tap.
  $('attachments').addEventListener('mousedown', (event) => event.preventDefault());
  $('attach').addEventListener('click', () => $('image-input').click());
  $('image-input').addEventListener('change', () => { addImages($('image-input').files); $('image-input').value = ''; });
  $('message').addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => /^image\//.test(file.type));
    if (!files.length) return;
    event.preventDefault(); addImages(files);
  });
  // One message, one request. The box is not locked meanwhile (locking it would
  // fold the phone's keyboard on every send); only the send button waits.
  async function deliver(m, item) {
    if (sending || Core.sendBlock(m)) return;
    item.state = 'sending'; item.reason = ''; item.unsure = false; item.at = Date.now();
    item.known = Core.userTurnIds(m.snap && m.snap.captain && m.snap.captain.turns);
    sending = true; sendStatus = '';
    render(); fitComposer();
    $('captain-turns').scrollTop = $('captain-turns').scrollHeight;
    const result = await post(m, 'api/captain', item.images.length ? { message: item.text, images: item.images } : { message: item.text });
    sending = false;
    if (result.status === 200 && result.body && result.body.queued) {
      item.state = 'sent';
      sendStatus = `已排队到 ${m.label} 队长。`;
    } else {
      // No answer at all: it may have arrived. If it shows up in the conversation, this bubble gives way to it.
      item.state = 'failed'; item.unsure = !!(result.timedOut || result.failed); item.reason = Core.sendFailure(result, m.label);
    }
    render(); poll(m);
  }
  $('message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    // The destination is fixed here, at the moment of the tap, and never changes afterwards.
    const m = byId(target), text = $('message').value, now = Date.now(), images = attachments.map((item) => item.id);
    if (sending || !m || !(text.trim() || images.length) || images.includes(undefined) || Core.sendBlock(m)) return;
    while (arrived.length && now - arrived[0].at > 60000) arrived.shift();
    // The same words as a message that just went out: say so instead of sending them twice.
    // A second tap within a few seconds means it, and sends.
    const again = repeatAsked && repeatAsked.text === text && repeatAsked.machineId === m.id && now - repeatAsked.at < 15000;
    if (!images.length && !again && Core.repeatedSend([...outbox, ...arrived].filter((item) => item.machineId === m.id), text, now)) {
      repeatAsked = { text, machineId: m.id, at: now };
      sendStatus = '刚才那条已发出，就在上面的对话里，不用再发。确实要再发一遍，就再点一次发送。';
      updateComposer(); $('captain-turns').scrollTop = $('captain-turns').scrollHeight;
      return;
    }
    repeatAsked = null;
    const item = { id: ++outboxId, machineId: m.id, text, images, state: 'sending', reason: '', known: [], at: now };
    outbox.push(item); $('message').value = ''; attachments = []; renderAttachments();
    deliver(m, item);
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

  // ---- 待我处理 --------------------------------------------------------------
  // What both computers handed back to the user, on one page: 要你处理 first,
  // then 结果汇报. Every item stays tied to the computer it came from; a reply
  // or a tick goes to that computer only, never to the other one.
  let attentionDoneOpen = false, attentionHint = '', attentionHintError = false, attentionHintTimer = 0, attentionWaiting = false;
  const attentionDrafts = new Map(), attentionOpen = new Set(), attentionBusy = new Set(), attentionErrors = new Map();
  async function loadAttention(m) {
    const result = await request(m, 'api/attention');
    m.attentionAt = Date.now();
    // 404: a build without 待我处理. Nothing to show from it, and nothing failed.
    if (result.status === 200 && result.body) m.attention = Core.cleanAttention(result.body);
    else if (result.status === 404) m.attention = 'missing';
  }
  const attentionSources = () => machines.filter((m) => m.state === 'online' && Array.isArray(m.attention)).map((m) => ({ id: m.id, label: m.label, items: m.attention }));
  function keepAttention(m, item) {
    const [clean] = Core.cleanAttention({ items: [item] });
    if (!clean || !Array.isArray(m.attention)) return;
    const at = m.attention.findIndex((i) => i.id === clean.id);
    if (at >= 0) m.attention[at] = clean; else m.attention.push(clean);
  }
  function setAttentionHint(text, error) {
    attentionHint = text; attentionHintError = !!error;
    clearTimeout(attentionHintTimer);
    if (text && !error) attentionHintTimer = setTimeout(() => { attentionHint = ''; renderAttention(); }, 3500);
    renderAttention();
  }
  async function attentionWrite(item, body, okText) {
    const m = byId(item.machineId);
    // A failure is said under the item itself, where the finger is.
    if (!m || m.state !== 'online') { attentionErrors.set(item.key, `${item.machineLabel} 现在不在线，等它上线再处理这一条。`); renderAttention(); return false; }
    attentionBusy.add(item.key); attentionErrors.delete(item.key); renderAttention();
    const result = await post(m, 'api/attention', { ...body, id: item.id });
    attentionBusy.delete(item.key);
    if (result.status === 200 && result.body) {
      if (result.body.item) keepAttention(m, result.body.item);
      m.nextAt = 0;
      setAttentionHint(okText || '');
      return true;
    }
    attentionErrors.set(item.key, Core.attentionFailure(result, m.label));
    renderAttention();
    return false;
  }
  async function sendAttentionReply(item) {
    const text = (attentionDrafts.get(item.key) || '').trim();
    if (!text || attentionBusy.has(item.key)) return;
    if (await attentionWrite(item, { op: 'reply', text }, `已交给 ${item.machineLabel} 的队长，这一条打勾归到已完成。`)) { attentionDrafts.delete(item.key); attentionKept.delete(item.key); }
    renderAttention();
  }
  // An unread item counts as read once most of it has stayed on screen for a
  // moment. Measured on a timer rather than observed: it holds when the browser
  // throttles painting.
  const attentionSeenSince = new Map();
  // Reports read on this visit stay where the user is reading them until the tab is left.
  const attentionKept = new Set();
  const SEEN_MS = 1500;
  // Mostly in view through its scroll area and the window, on both axes (the same rule as the desktop).
  const onScreen = (el, box) => Core.mostlyShown(el.getBoundingClientRect(), [box, { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight }]);
  function checkAttentionSeen() {
    checkCaptainSeen();
    if (document.hidden || view !== 'attention') { attentionSeenSince.clear(); attentionKept.clear(); return; }
    const box = $('main').getBoundingClientRect(), now = Date.now(), ready = [];
    for (const el of document.querySelectorAll('#attention-lists .at-item.unread')) {
      const key = el.dataset.key;
      if (!onScreen(el, box)) { attentionSeenSince.delete(key); continue; }
      if (!attentionSeenSince.has(key)) attentionSeenSince.set(key, now);
      else if (now - attentionSeenSince.get(key) >= SEEN_MS) ready.push(key);
    }
    if (ready.length) markAttentionRead(ready);
  }
  // A report 队长 also said in its chat is read once that reply has stayed on
  // screen here for the same moment, as on the desktop.
  const captainSeenSince = new Map();
  function checkCaptainSeen() {
    const m = byId(target);
    const unseen = m && m.state === 'online' && Array.isArray(m.attention) ? m.attention.filter((i) => i.kind === 'report' && !i.done && i.turn) : [];
    if (document.hidden || view !== 'captain' || !unseen.length) { captainSeenSince.clear(); return; }
    const box = $('captain-turns').getBoundingClientRect(), now = Date.now(), ready = [];
    for (const row of $('captain-turns').querySelectorAll(`.turn[data-said][data-machine="${CSS.escape(m.id)}"]`)) {
      const said = row.dataset.said.split(' '), ids = unseen.filter((i) => said.includes(i.turn)).map((i) => m.id + ':' + i.id);
      const reply = row.querySelector('.reply'), key = row.dataset.turnId;
      if (!ids.length || !reply || !onScreen(reply, box)) { captainSeenSince.delete(key); continue; }
      if (!captainSeenSince.has(key)) captainSeenSince.set(key, now);
      else if (now - captainSeenSince.get(key) >= SEEN_MS) { captainSeenSince.delete(key); ready.push(...ids); }
    }
    if (ready.length) markAttentionRead(ready, 'chat');
  }
  setInterval(checkAttentionSeen, 500);
  async function markAttentionRead(keys, via) {
    for (const m of machines) {
      if (m.state !== 'online' || !Array.isArray(m.attention)) continue;
      const items = m.attention.filter((i) => keys.includes(m.id + ':' + i.id) && !i.readAt && !i.done);
      if (!items.length) continue;
      // Read here at once (a report goes to 已读); the computer's next answer says the
      // same, or brings it back if it did not take it.
      const now = Date.now();
      items.forEach((i) => {
        i.readAt = now; attentionSeenSince.delete(m.id + ':' + i.id);
        if (i.kind !== 'report') return;
        Object.assign(i, { done: true, doneAt: now, doneBy: via === 'chat' ? 'chat' : 'seen', doneText: via === 'chat' ? '你在队长对话里看过了' : '你看过了' });
        if (via !== 'chat') attentionKept.add(m.id + ':' + i.id);
      });
      renderAttention();
      await post(m, 'api/attention', { op: 'read', ids: items.map((i) => i.id), ...(via === 'chat' ? { via } : {}) });
    }
  }
  const attentionTyping = () => !!document.activeElement && $('attention-lists').contains(document.activeElement) && document.activeElement.classList.contains('at-reply');
  function attentionCopy(item) {
    const label = '复制这一条';
    const button = iconButton('copy', label, 'at-copy');
    const text = [item.title, item.ask && '要你做：' + item.ask, item.options.length && '可选回答：' + item.options.join(' / '), item.detail, item.files.join('\n')].filter(Boolean).join('\n\n');
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); } catch (_) { setAttentionHint('无法复制。可以长按文字手动选择。', true); return; }
      button.innerHTML = svg('check'); button.classList.add('copied'); button.title = '已复制'; button.setAttribute('aria-label', '已复制');
      setTimeout(() => { button.innerHTML = svg('copy'); button.classList.remove('copied'); button.title = label; button.setAttribute('aria-label', label); }, 1500);
    });
    return button;
  }
  function attentionCard(item, multi, now) {
    // A report read on this visit stays as it was, reply included, until the tab is left.
    const stay = item.done && attentionKept.has(item.key), shut = item.done && !stay;
    const card = node('article', `at-item at-${item.kind}` + (shut ? ' done' : stay ? ' seen' : item.readAt ? '' : ' unread'));
    card.dataset.key = item.key; card.dataset.machine = item.machineId;
    const top = node('div', 'at-top');
    if (!item.done && !item.readAt) { const dot = node('span', 'at-unread'); dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', '未读'); top.append(dot); }
    if (shut) { const ok = node('span', 'at-ok'); ok.innerHTML = svg('done'); ok.setAttribute('aria-hidden', 'true'); top.append(ok); }
    if (!(shut && item.label === '要你处理')) top.append(node('span', 'at-kind', item.label));
    if (stay) top.append(node('span', 'at-seen', '已读'));
    const when = shut ? item.doneAt : item.created;
    const meta = node('span', 'at-meta', [multi && item.machineLabel, item.project, Core.ago(when, now)].filter(Boolean).join(' · '));
    if (when) meta.title = (shut ? '完成于 ' : '登记于 ') + new Date(when).toLocaleString();
    top.append(meta);
    // An open need with a question: the question is the biggest thing on the card,
    // its answers right under it; the title above says what it is about, and the
    // chip already says what kind of answer it wants.
    const asking = !!(item.ask && !item.done), busy = attentionBusy.has(item.key);
    card.append(top, node('h3', 'at-title' + (asking ? ' at-about' : ''), item.title));
    if (asking) {
      const ask = node('div', 'at-ask');
      ask.setAttribute('role', 'group'); ask.setAttribute('aria-label', item.label + '：' + item.ask);
      ask.append(markdownNode(item.ask, { reply: true, className: 'at-ask-text' }));
      if (item.options.length) {
        const quick = node('div', 'at-quick');
        for (const option of item.options) {
          const b = node('button', 'at-option', option); b.type = 'button'; b.disabled = busy;
          b.title = `回复「${option}」，交给 ${item.machineLabel} 的队长`;
          b.addEventListener('click', async () => {
            if (attentionBusy.has(item.key)) return;
            if (await attentionWrite(item, { op: 'reply', text: option }, `已回复「${option}」，交给 ${item.machineLabel} 的队长。`)) attentionDrafts.delete(item.key);
            renderAttention();
          });
          quick.append(b);
        }
        ask.append(quick);
      }
      card.append(ask);
    }
    const last = item.replies[item.replies.length - 1];
    if (shut) card.append(node('p', 'at-done-text', item.doneText + (last ? '：' + last.text.replace(/\s+/g, ' ') : '')));
    const more = item.detail || item.files.length || item.cardTitle || item.sessionTitle || item.replies.length;
    if (more) {
      const open = attentionOpen.has(item.key), id = 'at-detail-' + item.key.replace(/[^\w-]/g, '_');
      const toggle = node('button', 'at-more'); toggle.type = 'button'; toggle.dataset.more = item.key;
      toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-controls', id);
      const chev = node('span', 'at-chev' + (open ? ' open' : '')); chev.innerHTML = svg('chevron');
      toggle.append(chev, node('span', '', open ? '收起细节' : '细节与证据' + (item.files.length ? `（${item.files.length} 个文件）` : '')));
      toggle.addEventListener('click', () => { if (attentionOpen.has(item.key)) attentionOpen.delete(item.key); else attentionOpen.add(item.key); renderAttention(); });
      card.append(toggle);
      if (open) {
        const box = node('div', 'at-detail'); box.id = id;
        if (item.detail) box.append(markdownNode(item.detail, { reply: true, className: 'at-text' }));
        if (item.files.length) { const list = node('ul', 'at-files'); list.setAttribute('aria-label', '证据和文件'); item.files.forEach((f) => { const li = node('li'); li.append(fileEntry(f)); list.append(li); }); box.append(list); }
        const links = [item.cardTitle && '任务：' + item.cardTitle, item.sessionTitle && '会话：' + item.sessionTitle].filter(Boolean).join(' · ');
        if (links) box.append(node('p', 'at-links', links));
        for (const r of item.replies) {
          const said = node('div', 'at-said');
          said.append(node('span', 'at-said-head', `${r.from === 'phone' ? '你从手机回复' : '你的回复'} · ${Core.ago(r.at, now)} · ${r.seen ? '队长已收到' : '还在等队长读到'}`), node('p', 'at-said-text', r.text));
          box.append(said);
        }
        card.append(box);
      }
    }
    if (attentionErrors.has(item.key)) { const error = node('p', 'at-error', attentionErrors.get(item.key)); error.setAttribute('role', 'alert'); card.append(error); }
    if (!shut && attentionDrafts.has(item.key)) {
      const form = node('form', 'at-compose');
      const label = node('label', 'sr-only', '回复「' + item.title + '」'); label.htmlFor = 'reply-' + item.key.replace(/[^\w-]/g, '_');
      const box = node('textarea', 'at-reply'); box.id = label.htmlFor; box.rows = 3; box.maxLength = 4000;
      box.placeholder = `写下你的${item.kind === 'need' ? '决定或回答' : '问题或想法'}，会带着这一条交给 ${item.machineLabel} 的队长`;
      box.value = attentionDrafts.get(item.key) || '';
      const send = node('button', 'primary', busy ? '正在交给队长…' : `发送给 ${item.machineLabel} 队长`); send.type = 'submit';
      send.disabled = busy || !box.value.trim();
      box.addEventListener('input', () => { attentionDrafts.set(item.key, box.value); send.disabled = busy || !box.value.trim(); });
      box.addEventListener('blur', () => setTimeout(() => { if (attentionWaiting && !attentionTyping()) { attentionWaiting = false; signatures.delete($('attention-lists')); renderAttention(); } }, 300));
      const cancel = iconButton('close', '不回复了', 'at-cancel');
      cancel.addEventListener('click', () => { attentionDrafts.delete(item.key); attentionErrors.delete(item.key); renderAttention(); });
      const row = node('div', 'at-compose-row'); row.append(box, cancel);
      form.append(label, row, send);
      form.addEventListener('submit', (event) => { event.preventDefault(); sendAttentionReply(item); });
      card.append(form);
    } else {
      const actions = node('div', 'at-actions');
      if (!shut) {
        // With answers to pick from, writing one's own is the fallback.
        const answer = node('button', 'text-button' + (item.options.length ? ' quiet' : ''), item.options.length ? '写别的回复' : '回复'); answer.type = 'button'; answer.dataset.answer = item.key; answer.disabled = busy;
        answer.addEventListener('click', () => { attentionDrafts.set(item.key, ''); renderAttention(); $('attention-lists').querySelector(`[data-key="${CSS.escape(item.key)}"] .at-reply`)?.focus(); });
        const done = node('button', 'text-button quiet', item.kind === 'need' ? '已处理' : '知道了'); done.type = 'button'; done.disabled = busy;
        done.title = item.kind === 'need' ? (item.source === 'card' ? '从这里勾掉；任务看板上的卡片不变' : '勾掉并告诉队长你已经处理了') : '看过了，没有问题';
        done.addEventListener('click', () => attentionWrite(item, { op: 'done' }, item.kind === 'need' ? '已勾掉，归到已完成。' : '已归到已完成。'));
        actions.append(answer);
        if (!stay) actions.append(done);
      } else {
        const backLabel = item.kind === 'report' ? '放回没看' : '放回待处理';
        const back = iconButton('restore', backLabel, 'at-restore'); back.disabled = busy;
        back.addEventListener('click', () => { attentionKept.delete(item.key); attentionWrite(item, { op: 'reopen' }, `已${backLabel}。`); });
        actions.append(back);
      }
      actions.append(node('span', 'at-spacer'), attentionCopy(item));
      card.append(actions);
    }
    return card;
  }
  function renderAttention() {
    const lists = $('attention-lists'), sources = attentionSources(), now = Date.now();
    const { needs, reports, done, counts } = Core.mergeAttention(sources);
    // The number counts 要你处理 only; reports not yet seen are a dot of their own.
    for (const badge of document.querySelectorAll('.nav-attention')) {
      badge.textContent = counts.need > 99 ? '99+' : String(counts.need); badge.hidden = !counts.need;
      badge.classList.toggle('need', counts.need > 0);
    }
    for (const dot of document.querySelectorAll('.nav-attention-dot')) dot.hidden = !counts.unreadReports;
    $('attention-tab').setAttribute('aria-label', counts.need || counts.unreadReports ? '待我处理，' + [counts.need ? `${counts.need} 件要你处理` : '没有要你处理的事', counts.unreadReports && `${counts.unreadReports} 条汇报你还没看`].filter(Boolean).join('，') : '待我处理');
    const missing = machines.filter((m) => !(m.state === 'online' && Array.isArray(m.attention)));
    const why = (m) => m.attention === 'missing' && m.state === 'online' ? `${m.label} 的 AgentDeck 还没有这个页面` : `${m.label} ${Core.STATES[m.state].label}`;
    $('attention-sources').textContent = !sources.length ? (machines.some((m) => m.state === 'online') ? '正在读取…' : '还没有连上任何一台电脑。')
      : missing.length ? `现在只看得到 ${sources.map((m) => m.label).join('、')} 交回来的事；${missing.map(why).join('，')}。` : `${sources.map((m) => m.label).join(' 和 ')} 交回来的事都在这里，回复只发给那条所在的电脑。`;
    if (!changed(lists, [view === 'attention', needs, reports, done, [...attentionKept], attentionDoneOpen, [...attentionDrafts.keys()], [...attentionOpen], [...attentionBusy], [...attentionErrors], attentionHint, attentionHintError, sources.length, Math.floor(now / 60000)])) return;
    // Rebuilding under someone typing would drop their caret and their input method's state.
    if (attentionTyping()) { attentionWaiting = true; signatures.delete(lists); return; }
    attentionWaiting = false;
    const focused = document.activeElement && lists.contains(document.activeElement) ? document.activeElement.dataset.answer || document.activeElement.dataset.more || '' : '';
    lists.replaceChildren();
    const hint = node('p', 'send-hint at-hint' + (attentionHintError ? ' blocked' : ''), attentionHint);
    hint.setAttribute('role', 'status'); hint.setAttribute('aria-live', 'polite'); hint.hidden = !attentionHint;
    lists.append(hint);
    const multi = sources.length > 1;
    // Reports read on this visit stay in their column; the rest of 已读 is folded below.
    const stay = done.filter((i) => attentionKept.has(i.key));
    const shownReports = [...reports, ...stay].sort((a, b) => b.created - a.created || (a.key < b.key ? -1 : 1));
    const history = done.filter((i) => !attentionKept.has(i.key));
    if (!needs.length && !shownReports.length && sources.length) {
      const box = node('div', 'at-empty'), art = node('div', 'at-empty-art'); art.innerHTML = svg('attention');
      box.append(art, node('strong', '', '都处理完了'), node('p', '', '队长交给你拍板、登录、付款或回答的事，以及你不在时它汇报的结论，都会出现在这里。'));
      lists.append(box);
    } else if (sources.length) {
      const cols = node('div', 'at-cols');
      const column = (cls, title, count, empty, items, extra) => {
        const col = node('section', 'at-col ' + cls), head = node('div', 'at-section ' + cls), titles = node('div', 'at-section-titles'), h = node('h2', '');
        h.id = 'at-h-' + cls; col.setAttribute('aria-labelledby', h.id);
        h.append(node('span', '', title));
        if (count) h.append(node('span', 'at-count', String(count)));
        titles.append(h);
        head.append(titles);
        if (extra) head.append(extra);
        col.append(head);
        if (!items.length) col.append(node('p', 'at-col-empty', empty));
        items.forEach((item) => col.append(attentionCard(item, multi, now)));
        cols.append(col);
      };
      column('at-sec-need', '要你处理', needs.length, '没有要你处理的事。', needs);
      let all = null;
      if (reports.length) {
        all = node('button', 'text-button quiet at-all', '全部看过了'); all.type = 'button';
        all.title = '把这一栏的汇报都标成看过，归到已读（可以放回）';
        all.addEventListener('click', async () => { for (const item of reports) if (!(await attentionWrite(item, { op: 'done' }))) return; setAttentionHint(`${reports.length} 条汇报归到已读。`); });
      }
      column('at-sec-report', '做完了你还没看', reports.length, '汇报你都看过了。', shownReports, all);
      lists.append(cols);
    }
    if (history.length) {
      const toggle = node('button', 'at-done-toggle'); toggle.type = 'button'; toggle.dataset.more = 'done-toggle';
      toggle.setAttribute('aria-expanded', String(attentionDoneOpen));
      const chev = node('span', 'at-chev' + (attentionDoneOpen ? ' open' : '')); chev.innerHTML = svg('chevron');
      toggle.append(chev, node('span', '', '已完成和已读'), node('span', 'at-count', String(history.length)));
      toggle.addEventListener('click', () => { attentionDoneOpen = !attentionDoneOpen; renderAttention(); });
      lists.append(toggle);
      if (attentionDoneOpen) history.slice(0, 60).forEach((item) => lists.append(attentionCard(item, multi, now)));
    }
    if (focused) lists.querySelector(`[data-answer="${CSS.escape(focused)}"], [data-more="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  // ---- board ---------------------------------------------------------------
  // 高优先级 is the card's `important` flag: the user named it as urgent. An
  // unfinished one wears a flag in its own colour and is listed first.
  const urgentTask = (task) => task.important === true && task.status !== 'done';
  function priorityMark() {
    const mark = node('span', 'task-prio');
    mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 21V4"/><path d="M5.5 4.6h12l-2.7 4 2.7 4h-12z" fill="currentColor"/></svg>';
    mark.append(node('span', '', '高优先级'));
    mark.setAttribute('role', 'img'); mark.setAttribute('aria-label', '高优先级'); mark.title = '高优先级：你点名要优先做的事';
    return mark;
  }
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
    // Column names for the wide layout, where each status has its own column (hidden otherwise).
    // A status with no card shown gets no column, so the ones in use have the room.
    const shown = [...grouped.values()].flat(), used = taskStatuses.filter(([status]) => shown.some((card) => card.status === status));
    const lanes = node('div', 'lanes-head'); lanes.setAttribute('aria-hidden', 'true');
    for (const [status, label] of used) lanes.append(node('span', '', `${label} ${shown.filter((card) => card.status === status).length}`));
    projects.style.setProperty('--lanes', String(used.length || 1));
    projects.append(lanes);
    for (const [project, tasks] of grouped) {
      const section = node('section', 'project'), heading = node('div', 'project-heading');
      heading.append(node('h2', '', project), node('span', '', tasks.length + ' 项'));
      section.append(heading);
      for (const task of tasks.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || urgentTask(b) - urgentTask(a))) {
        const card = node('article', 'task-card'); card.dataset.status = task.status; card.dataset.machine = task.seenOn || '';
        card.style.setProperty('--lane', String(used.findIndex(([status]) => status === task.status) + 1 || 1));
        const top = node('div', 'task-top');
        if (urgentTask(task)) { card.dataset.priority = 'high'; top.append(priorityMark()); }
        top.append(node('span', 'task-status', (taskStatuses.find(([status]) => status === task.status) || [0, task.status])[1]));
        if (task.flag) top.append(node('span', 'task-flag ' + task.flag, flagNames[task.flag] || task.flag));
        const owner = Core.ownerLabel(task, known);
        if (owner) top.append(node('span', 'task-owner', `${owner} 领取`));
        card.append(top, node('h3', '', task.title));
        if (task.assignee) card.append(node('p', 'task-assignee', [task.assignee.agent, task.assignee.model].filter(Boolean).join(' · ')));
        if (task.latest_receipt) card.append(markdownNode(task.latest_receipt, { reply: true, className: 'task-receipt' }));
        section.append(card);
      }
      projects.append(section);
    }
  }

  // ---- 随手记待办 ------------------------------------------------------------
  // One list for both computers: each answers with what it sees, the hub keeps
  // the newest copy of every item. Recording and ticking go to one computer
  // (Core.todoWriter); git carries it to the other within half an hour.
  async function loadTodos(m) {
    const result = await request(m, 'api/todos');
    m.todosAt = Date.now();
    // 404: a build without to-dos. Nothing to show from it, and nothing failed.
    if (result.status === 200 && result.body) { m.todos = Core.cleanTodos(result.body); m.todosReady = true; }
    else if (result.status === 404) { m.todos = null; m.todosReady = false; }
  }
  const todoSources = () => machines.filter((m) => Array.isArray(m.todos));
  const todoWriter = () => Core.todoWriter(machines, target);
  // The computer's answer goes into its own copy at once; the next poll confirms it.
  function keepTodo(m, item) {
    const [clean] = Core.cleanTodos({ items: [item] });
    if (!clean || !Array.isArray(m.todos)) return;
    const at = m.todos.findIndex((t) => t.id === clean.id);
    if (at >= 0) m.todos[at] = clean; else m.todos.push(clean);
  }
  let todoHintTimer = 0;
  function setTodoHint(text, error) {
    todoHint = text; todoHintError = !!error;
    clearTimeout(todoHintTimer);
    if (text && !error) todoHintTimer = setTimeout(() => { todoHint = ''; updateTodoForm(); }, 3000);
    updateTodoForm();
  }
  function updateTodoForm() {
    const writer = todoWriter(), box = $('todo-text'), block = Core.todoBlock(machines);
    $('todo-add').disabled = todoSaving || !writer || !box.value.trim();
    const label = writer ? `记下这条待办（存到 ${writer.label}）` : '记下这条待办';
    $('todo-add').title = block || label; $('todo-add').setAttribute('aria-label', label);
    const hint = $('todo-hint');
    hint.textContent = todoSaving ? `正在记到 ${writer ? writer.label : ''}…` : todoHint || block;
    hint.hidden = !hint.textContent;
    hint.classList.toggle('blocked', !todoSaving && (todoHintError || (!todoHint && !!block)));
  }
  function todoRow(t, writer) {
    const row = node('li', 'todo-row' + (t.done ? ' is-done' : ''));
    const check = node('button', 'todo-check');
    check.type = 'button'; check.dataset.todo = t.id;
    check.setAttribute('role', 'checkbox'); check.setAttribute('aria-checked', String(t.done));
    const name = t.done ? '标为未完成' : '勾掉';
    check.title = name; check.setAttribute('aria-label', `${name}：${t.text}`);
    check.innerHTML = svg('check');
    check.disabled = !writer;
    check.addEventListener('click', () => toggleTodo(t, row, check));
    const body = node('div', 'todo-main');
    const when = t.done ? '完成于 ' + Core.ago(Date.parse(t.doneAt || t.updated), Date.now()) : Core.ago(Date.parse(t.created), Date.now());
    body.append(node('p', 'todo-text', t.text), node('p', 'todo-when', when));
    row.append(check, body);
    return row;
  }
  async function toggleTodo(t, row, check) {
    const m = todoWriter();
    if (!m || row.classList.contains('is-saving')) return;
    const done = !t.done;
    row.classList.add('is-saving'); row.classList.toggle('is-done', done); check.setAttribute('aria-checked', String(done));
    // The base lets a computer tick an item the other one recorded less than a git sync ago.
    const base = { text: t.text, done: t.done, doneAt: t.doneAt, created: t.created, updated: t.updated };
    const result = await post(m, 'api/todos', { op: 'update', id: t.id, done, base });
    if (result.status === 200 && result.body && result.body.item) {
      keepTodo(m, result.body.item);
      setTodoHint(done ? `已勾掉（记在 ${m.label}）` : `已放回未完成（记在 ${m.label}）`);
      // Let the tick show before the row moves.
      setTimeout(renderTodos, 350);
    } else {
      row.classList.remove('is-saving'); row.classList.toggle('is-done', t.done); check.setAttribute('aria-checked', String(t.done));
      setTodoHint(Core.todoFailure(result, m.label), true);
    }
  }
  function renderTodos() {
    const lists = $('todo-lists'), sources = todoSources(), writer = todoWriter();
    const { open, done } = Core.mergeTodos(sources);
    for (const badge of document.querySelectorAll('.nav-badge')) { badge.textContent = open.length > 99 ? '99+' : String(open.length); badge.hidden = !open.length; }
    updateTodoForm();
    const missing = machines.filter((m) => !Array.isArray(m.todos));
    $('todo-foot').textContent = !sources.length ? '' : (missing.length ? `现在只读到 ${sources.map((m) => m.label).join('、')} 的待办。` : `已合并 ${sources.map((m) => m.label).join(' 和 ')} 的待办。`)
      + '两台电脑每 30 分钟自动同步一次。';
    if (!changed(lists, [open, done, todoDoneOpen, !!writer, sources.length, Core.todoBlock(machines)])) return;
    const focusedId = document.activeElement && lists.contains(document.activeElement) ? document.activeElement.dataset.todo || document.activeElement.id : '';
    lists.replaceChildren();
    if (!sources.length) {
      lists.append(node('p', 'empty', Core.todoBlock(machines) || '正在读取待办…'));
      return;
    }
    if (!open.length) {
      const box = node('div', 'todo-empty'), art = node('div', 'todo-empty-art');
      art.innerHTML = svg(done.length ? 'check' : 'todo');
      box.append(art, node('strong', '', done.length ? '都做完了' : '清单还是空的'), node('p', '', done.length ? '新冒出来的事，直接在上面记一条。' : '买东西、回邮件、别忘了的小事——打一句话，点右边的 ＋ 就存好。'));
      lists.append(box);
    } else {
      const head = node('h2', 'todo-section');
      head.append(node('span', '', '未完成'), node('span', 'todo-count', String(open.length)));
      const list = node('ul', 'todo-list'); list.setAttribute('aria-label', '未完成的待办');
      open.forEach((t) => list.append(todoRow(t, writer)));
      lists.append(head, list);
    }
    if (done.length) {
      const toggle = node('button', 'todo-section todo-done-toggle');
      toggle.type = 'button'; toggle.id = 'todo-done-toggle';
      toggle.setAttribute('aria-expanded', String(todoDoneOpen));
      const chev = node('span', 'todo-chev' + (todoDoneOpen ? ' open' : '')); chev.innerHTML = svg('chevron');
      toggle.append(chev, node('span', '', '已完成'), node('span', 'todo-count', String(done.length)));
      toggle.addEventListener('click', () => { todoDoneOpen = !todoDoneOpen; renderTodos(); });
      lists.append(toggle);
      if (todoDoneOpen) {
        const list = node('ul', 'todo-list todo-list-done'); list.setAttribute('aria-label', '已完成的待办');
        done.forEach((t) => list.append(todoRow(t, writer)));
        lists.append(list);
      }
    }
    if (focusedId) (lists.querySelector(`[data-todo="${CSS.escape(focusedId)}"]`) || $(focusedId))?.focus();
  }
  $('todo-text').addEventListener('input', () => { if (todoHintError) setTodoHint(''); else updateTodoForm(); });
  // Enter while an input method is still composing picks a candidate; it never records.
  $('todo-text').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault(); });
  $('todo-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const box = $('todo-text'), text = box.value, m = todoWriter();
    if (todoSaving || !text.trim() || !m) return;
    // The box stays enabled and focused, so the phone keyboard stays up for the next one.
    todoSaving = true; todoHint = ''; updateTodoForm();
    const result = await post(m, 'api/todos', { op: 'add', text });
    todoSaving = false;
    if (result.status === 200 && result.body && result.body.item) {
      if (box.value === text) box.value = '';
      keepTodo(m, result.body.item);
      setTodoHint(`已记下（存在 ${m.label}）`);
    } else setTodoHint(Core.todoFailure(result, m.label), true);
    renderTodos();
  });

  // ---- Markdown ------------------------------------------------------------
  // Captain replies, receipts, 待我处理 details and previewed .md files all go
  // through the one renderer in core.js. Its output is escaped HTML; it is read
  // into an inert document and copied over piece by piece, keeping only the
  // tags and attributes listed here, so nothing else can reach the page.
  const MD_TAGS = new Set(['P', 'BR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'SPAN', 'DIV']);
  const MD_CLASS = /^(?:md-code|md-table|tok-[cskn]|al-[cr])$/;
  function copyClean(source, target) {
    for (const child of source.childNodes) {
      if (child.nodeType === 3) { target.append(child.textContent); continue; }
      if (child.nodeType !== 1) continue;
      if (!MD_TAGS.has(child.tagName)) { target.append(child.textContent); continue; }
      const name = child.tagName.toLowerCase();
      let el;
      if (name === 'a') {
        const href = child.getAttribute('href') || '', file = child.getAttribute('data-file');
        if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
          el = node('a', 'web-link'); el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer';
        } else if (file) {
          // Opens the preview: a control, not a place to go.
          el = node('a', 'file-link'); el.dataset.file = file; el.setAttribute('role', 'button'); el.tabIndex = 0; el.title = file;
          // A bare path is shown by its end; a link with its own words keeps them.
          if (!child.hasAttribute('data-rel') && child.textContent.startsWith(file)) { el.textContent = Core.shortPath(child.textContent); target.append(el); el.dataset.line = String(parseInt(child.getAttribute('data-line'), 10) || 0); continue; }
          if (child.getAttribute('data-line')) el.dataset.line = String(parseInt(child.getAttribute('data-line'), 10) || 0);
          if (child.hasAttribute('data-rel')) el.dataset.rel = '1';
        } else el = node('span');
      } else el = node(name);
      const classes = (child.getAttribute('class') || '').split(/\s+/).filter((c) => MD_CLASS.test(c));
      if (classes.length) el.classList.add(...classes);
      if (name === 'ol' && /^\d{1,9}$/.test(child.getAttribute('start') || '')) el.start = Number(child.getAttribute('start'));
      if (name === 'code' && /^[\w+-]{1,20}$/.test(child.getAttribute('data-lang') || '')) el.dataset.lang = child.getAttribute('data-lang');
      copyClean(child, el);
      target.append(el);
    }
  }
  // reply: text read off a terminal (line breaks are meant, titles and tables are read back from the rows).
  function markdownNode(text, { reply = false, className = '' } = {}) {
    const box = node('div', 'md' + (className ? ' ' + className : ''));
    const html = Core.renderMarkdown(reply ? Core.tidyReply(text) : text, { breaks: reply, links: true });
    copyClean(new DOMParser().parseFromString(html, 'text/html').body, box);
    // A wide table scrolls inside its own frame; a code block carries its copy button.
    for (const table of box.querySelectorAll('.md-table')) {
      table.tabIndex = 0; table.setAttribute('role', 'region'); table.setAttribute('aria-label', '表格，可以左右滑动');
      table.style.setProperty('--cols', String(table.querySelectorAll('th').length));
      // A short cell (a name, a state) stays on one line; long ones wrap.
      for (const cell of table.querySelectorAll('td')) if ([...cell.textContent].reduce((w, ch) => w + (Core.isWide(ch) ? 2 : 1), 0) <= 12) cell.classList.add('short');
    }
    for (const pre of box.querySelectorAll('pre.md-code')) {
      const wrap = node('div', 'md-pre'), copy = iconButton('copy', '复制这段代码', 'md-copy');
      copy.addEventListener('click', () => copyText(copy, pre.textContent, '复制这段代码'));
      pre.replaceWith(wrap); wrap.append(pre, copy);
    }
    return box;
  }
  // One path on its own line (待我处理 lists its files that way): the whole line opens it.
  function fileEntry(path) {
    const link = node('a', 'file-link', Core.shortPath(path, 48));
    link.dataset.file = path; link.title = path; link.setAttribute('role', 'button'); link.tabIndex = 0;
    return link;
  }
  // A tap on a file path opens it from the computer the text came from.
  function followLink(link, event) {
    const owner = link.closest('[data-machine]'), inPreview = !!link.closest('#preview');
    const machineId = inPreview ? preview.machineId : owner ? owner.dataset.machine : '';
    let path = link.dataset.file;
    // A link written inside a file is read against that file's folder.
    if (link.dataset.rel) path = inPreview && preview.path ? Core.resolvePath(Core.splitPath(preview.path).dir, path) : '';
    if (event) event.preventDefault();
    if (!path || !byId(machineId)) { notice('这个链接指向的文件不知道在哪台电脑上，打不开。', true); return; }
    openPreview(machineId, path, { line: Number(link.dataset.line) || 0, opener: inPreview ? null : link });
  }
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element && event.target.closest('a.file-link');
    if (link) followLink(link, event);
  });
  document.addEventListener('keydown', (event) => {
    const link = event.target instanceof Element && event.target.closest('a.file-link');
    if (link && (event.key === 'Enter' || event.key === ' ') && !event.repeat) followLink(link, event);
  });

  // ---- file preview --------------------------------------------------------
  // One panel, two shapes. Beside the page on a wide screen, like the desktop
  // app's side pane; on a phone a sheet that rises from the bottom, can be
  // dragged up to the full screen and down to close. The file is read from the
  // computer whose text named it, in JSON pieces (the entry lets nothing else
  // through); what may be read is decided on that computer.
  const wide = window.matchMedia('(min-width: 900px) and (min-height: 600px)');
  const docked = window.matchMedia('(min-width: 1180px) and (min-height: 600px)');
  const preview = { open: false, machineId: '', path: '', line: 0, stack: [], state: 'empty', error: '', data: null, source: false, full: false, call: 0, opener: null, snap: 'half', pdf: null };
  const panel = $('preview'), scrim = $('preview-scrim'), previewBody = $('preview-body');
  const assetVersion = (() => { const script = [...document.scripts].find((el) => /(?:^|\/)app\.js(?:\?|$)/.test(el.getAttribute('src') || '')); return script ? script.getAttribute('src').replace(/^[^?]*/, '') : ''; })();

  function openPreview(machineId, path, { line = 0, opener, replace = false } = {}) {
    if (preview.open && preview.path && !replace && !(preview.machineId === machineId && preview.path === path)) preview.stack.push({ machineId: preview.machineId, path: preview.path, line: preview.line });
    if (opener) { preview.opener = opener; preview.stack = []; }
    Object.assign(preview, { machineId, path, line, source: false });
    showPanel();
    loadPreview();
  }
  function showPanel() {
    const fresh = !preview.open;
    preview.open = true;
    if (fresh) preview.snap = 'half';
    placePanel();
    // The sheet takes the focus like a dialog; the side pane leaves it where the user is typing.
    if (fresh && !docked.matches) $('preview-name').focus({ preventScroll: true });
  }
  function closePreview() {
    if (!preview.open) return;
    preview.open = false; preview.call++; preview.full = false;
    dropPdf();
    placePanel();
    const opener = preview.opener;
    preview.opener = null;
    if (opener && opener.isConnected && !docked.matches) opener.focus({ preventScroll: true });
  }
  // Where the panel stands and how tall it is, for the screen as it is now.
  function placePanel() {
    const sheet = !docked.matches;
    shell.classList.toggle('pane-open', preview.open && !sheet);
    shell.classList.toggle('pane-full', preview.open && !sheet && preview.full);
    panel.hidden = !preview.open;
    panel.classList.toggle('sheet', sheet);
    panel.dataset.snap = preview.snap;
    scrim.hidden = !(preview.open && sheet);
    if (sheet && preview.open) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
    else { panel.setAttribute('role', 'complementary'); panel.removeAttribute('aria-modal'); }
    // Behind the sheet nothing is reachable; beside the pane everything is.
    document.querySelector('.center').inert = preview.open && sheet;
    $('sidebar').inert = preview.open && sheet;
    panel.style.removeProperty('height');
    const toggle = $('pane-toggle'), label = preview.open ? '收起右侧预览栏' : '打开右侧预览栏';
    toggle.title = label; toggle.setAttribute('aria-label', label); toggle.setAttribute('aria-expanded', String(preview.open));
    renderPreview();
  }
  $('pane-toggle').addEventListener('click', () => { if (preview.open) closePreview(); else showPanel(); });
  scrim.addEventListener('click', closePreview);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && preview.open && !docked.matches && !dialog.open) { event.preventDefault(); closePreview(); } });
  $('preview-back').addEventListener('click', () => {
    const last = preview.stack.pop();
    if (last) { Object.assign(preview, last, { source: false }); loadPreview(); }
  });

  const fileFailure = (result, m) => {
    const code = result && result.body && result.body.code;
    if (!result || result.failed) return '手机连不上入口，文件没有读到。';
    if (result.timedOut) return `${m.label} 没有回应（可能在睡眠），文件没有读到。`;
    if (code === 'denied') return '这个文件不在可以查看的范围里。这里只能看队长、回执和「待我处理」里提到的文件，以及报告文件夹里的；密钥、口令一类的文件一律不给看。';
    if (code === 'missing' || (result.status === 404 && code)) return `这个文件已经不在 ${m.label} 上了，可能被移走或删掉了。`;
    if (result.status === 404) return `${m.label} 上的 AgentDeck 还是旧版，升级以后才能在这里看文件。`;
    if (result.status === 401) return `${m.label} 的登录已失效，先在总览里重新登录。`;
    if (result.status === 403) return `${m.label} 的安全校验已过期，刷新页面后再试。`;
    if (result.status === 502) return `${m.label} 离线，现在读不到它上面的文件。`;
    return `${m.label} 没有给出这个文件（HTTP ${result.status}）。`;
  };
  async function loadPreview() {
    const call = ++preview.call, m = byId(preview.machineId), path = preview.path;
    dropPdf();
    Object.assign(preview, { state: 'loading', error: '', data: null, got: 0, total: 0 });
    renderPreview();
    const stop = (text) => { if (call !== preview.call) return; preview.state = 'error'; preview.error = text; renderPreview(); };
    if (!m) return stop('这个文件不知道在哪台电脑上。');
    if (m.state !== 'online' || !m.csrf) return stop(`${m.label} ${Core.STATES[m.state].label}，现在读不到它上面的文件。`);
    const read = (offset) => request(m, 'api/file', { method: 'POST', timeout: 30000, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': m.csrf }, body: JSON.stringify(offset ? { path, offset } : { path }) });
    const first = await read(0);
    if (call !== preview.call) return;
    if (first.status !== 200 || !first.body || first.body.ok !== true) return stop(fileFailure(first, m));
    const data = first.body, parts = [];
    if (typeof data.data === 'string') {
      parts.push(data.data);
      preview.total = data.size; preview.got = Math.min(data.size, data.next || data.size);
      let next = data.next;
      // A PDF or a large picture arrives in pieces; a file that changed on the way is read again from the top.
      while (Number.isSafeInteger(next)) {
        renderPreview();
        const more = await read(next);
        if (call !== preview.call) return;
        if (more.status !== 200 || !more.body || typeof more.body.data !== 'string') return stop(fileFailure(more, m));
        if (more.body.size !== data.size || more.body.mtime !== data.mtime) return stop('这个文件刚被改动过，点刷新图标重新读一次。');
        parts.push(more.body.data);
        next = more.body.next; preview.got = Math.min(data.size, next || data.size);
      }
      data.base64 = parts.join('');
    }
    preview.data = data; preview.state = 'ready';
    renderPreview();
  }
  const bytesOf = (base64) => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  function saveFile() {
    const data = preview.data;
    if (!data) return;
    const blob = typeof data.base64 === 'string' ? new Blob([bytesOf(data.base64)], { type: data.mime || 'application/octet-stream' }) : new Blob([data.text || ''], { type: 'text/plain;charset=utf-8' });
    const link = node('a'), url = URL.createObjectURL(blob);
    link.href = url; link.download = data.name || 'file';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---- PDF -----------------------------------------------------------------
  // A phone browser shows only the first page of an embedded PDF, so pages are
  // drawn onto canvases by pdf.js (loaded the first time a PDF is opened). Each
  // page holds its place from the start and is drawn when it comes near the
  // screen; pages far away give their memory back.
  let pdfLibrary = null;
  function dropPdf() {
    const pdf = preview.pdf;
    preview.pdf = null;
    if (!pdf) return;
    pdf.watch && pdf.watch.disconnect();
    try { pdf.task.destroy(); } catch (_) { /* Already gone. */ }
  }
  async function showPdf(box, data, call) {
    const status = node('p', 'pv-note', '正在打开 PDF…');
    box.append(status);
    try {
      if (!pdfLibrary) {
        pdfLibrary = await import(new URL('pdf.min.js' + assetVersion, document.baseURI).href);
        pdfLibrary.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js' + assetVersion, document.baseURI).href;
      }
      const task = pdfLibrary.getDocument({ data: bytesOf(data.base64), isEvalSupported: false, enableXfa: false, useWasm: false, verbosity: 0 });
      const pdf = { task, pages: new Map(), watch: null };
      preview.pdf = pdf;
      const doc = await task.promise;
      if (call !== preview.call || preview.pdf !== pdf) return;
      status.remove();
      const first = await doc.getPage(1), base = first.getViewport({ scale: 1 });
      const pages = node('div', 'pv-pdf');
      pages.setAttribute('aria-label', `PDF，共 ${doc.numPages} 页`);
      const draw = async (holder) => {
        const number = Number(holder.dataset.page);
        if (pdf.pages.has(number) || preview.pdf !== pdf) return;
        pdf.pages.set(number, true);
        const page = number === 1 ? first : await doc.getPage(number), natural = page.getViewport({ scale: 1 });
        const width = holder.clientWidth || 320;
        // Sharp on a dense screen, but never more pixels than a phone can hold in one canvas.
        const scale = Math.min((width / natural.width) * Math.min(window.devicePixelRatio || 1, 2), Math.sqrt(5e6 / (natural.width * natural.height)));
        const view = page.getViewport({ scale }), canvas = node('canvas');
        canvas.width = Math.floor(view.width); canvas.height = Math.floor(view.height);
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `第 ${number} 页`);
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: view }).promise.catch(() => {});
        if (preview.pdf !== pdf) return;
        holder.replaceChildren(canvas);
        // Keep about a dozen pages drawn; the ones furthest from this one are emptied.
        if (pdf.pages.size > 12) {
          const far = [...pdf.pages.keys()].sort((a, b) => Math.abs(b - number) - Math.abs(a - number))[0];
          pdf.pages.delete(far);
          const old = pages.querySelector(`[data-page="${far}"]`), drawn = old && old.querySelector('canvas');
          if (drawn) { drawn.width = 0; drawn.height = 0; old.replaceChildren(node('span', 'pv-page-number', String(far))); }
        }
      };
      pdf.watch = new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) draw(entry.target); }, { root: previewBody, rootMargin: '600px 0px' });
      for (let number = 1; number <= doc.numPages; number++) {
        const holder = node('div', 'pv-page');
        holder.dataset.page = String(number);
        holder.style.aspectRatio = `${base.width} / ${base.height}`;
        holder.append(node('span', 'pv-page-number', String(number)));
        pages.append(holder);
        pdf.watch.observe(holder);
      }
      box.append(pages);
      pdf.count = doc.numPages;
      const metaLine = $('preview-path').querySelector('.pv-meta');
      if (metaLine) metaLine.textContent += ` · 共 ${doc.numPages} 页`;
    } catch (_) {
      if (call !== preview.call) return;
      status.className = 'pv-empty';
      status.textContent = '这个 PDF 没能在这里打开。可以点上面的下载图标存到手机里再看。';
    }
  }

  function renderPreview() {
    if (!preview.open) return;
    const data = preview.data, m = byId(preview.machineId), sheet = !docked.matches;
    const parts = Core.splitPath(preview.path);
    $('preview-name').textContent = preview.path ? (data && data.name) || parts.name : '预览';
    // The folder a file is in, cut from the left so the end of it stays readable.
    const meta = !preview.path ? '' : [m && machines.length > 1 ? m.label : '', data && data.kind !== 'dir' && data.size ? Core.sizeText(data.size) : '', preview.pdf && preview.pdf.count ? `共 ${preview.pdf.count} 页` : ''].filter(Boolean).join(' · ');
    $('preview-path').replaceChildren(...(meta ? [node('span', 'pv-meta', meta)] : []), ...(parts.dir && preview.path ? [node('span', 'pv-where', '\u200e' + parts.dir + '\u200e')] : []));
    $('preview-path').title = preview.path;
    $('preview-back').hidden = !preview.stack.length;
    const actions = $('preview-actions');
    actions.replaceChildren();
    const add = (icon, label, onClick) => { const button = iconButton(icon, label); button.addEventListener('click', onClick); actions.append(button); return button; };
    if (preview.state === 'ready' && data.kind === 'markdown') add(preview.source ? 'eye' : 'code', preview.source ? '看排好版的样子' : '看原文', () => { preview.source = !preview.source; renderPreview(); });
    if (preview.path) {
      const copy = add('copy', '复制文件路径', () => copyText(copy, preview.path, '复制文件路径'));
      if (preview.state === 'ready' && (typeof data.base64 === 'string' || typeof data.text === 'string')) add('download', '下载到这台设备', saveFile);
      add('refresh', '重新读取这个文件', loadPreview);
    }
    if (!sheet) add(preview.full ? 'shrink' : 'expand', preview.full ? '恢复成侧栏' : '放大到整页', () => { preview.full = !preview.full; placePanel(); });
    add('close', '关闭预览', closePreview);

    const progress = $('preview-progress');
    progress.hidden = !(preview.state === 'loading' && preview.total > 0);
    if (!progress.hidden) {
      progress.textContent = `正在读取 ${Core.sizeText(preview.got)} / ${Core.sizeText(preview.total)}`;
      progress.style.setProperty('--done', Math.round(preview.got / preview.total * 100) + '%');
    }
    const body = previewBody;
    body.dataset.machine = preview.machineId;
    if (!changed(body, [preview.state, preview.path, preview.machineId, preview.error, preview.source, data && [data.mtime, data.size, data.kind]])) return;
    dropPdf();
    body.replaceChildren(); body.scrollTop = 0;
    body.className = 'preview-body';
    const say = (icon, title, text) => {
      const box = node('div', 'pv-empty'), art = node('div', 'pv-empty-art');
      art.innerHTML = svg(icon);
      box.append(art, node('strong', '', title));
      if (text) box.append(node('p', '', text));
      body.append(box);
    };
    if (preview.state === 'empty') return say('file', '点一个文件路径', '队长的回复、回执和「待我处理」里的文件路径都可以点，内容会显示在这里。');
    if (preview.state === 'loading') { const box = node('div', 'pv-empty'), spin = node('span', 'spinner'); box.setAttribute('role', 'status'); box.append(spin, node('p', '', `正在从 ${m ? m.label : '电脑'} 读取…`)); body.append(box); return; }
    if (preview.state === 'error') { say('alert', '没能打开', preview.error); body.firstChild.setAttribute('role', 'alert'); return; }
    if (data.kind === 'dir') {
      body.classList.add('is-list');
      if (!data.entries.length) return say('folder', '这个文件夹是空的');
      const list = node('div', 'pv-dir');
      list.setAttribute('role', 'list');
      for (const entry of data.entries) {
        const row = node('button', 'pv-dir-row'); row.type = 'button'; row.setAttribute('role', 'listitem');
        const icon = node('span', 'pv-dir-icon'); icon.innerHTML = svg(entry.dir ? 'folder' : 'file'); icon.setAttribute('aria-hidden', 'true');
        row.append(icon, node('span', 'pv-dir-name', entry.name));
        if (entry.dir) { const arrow = node('span', 'pv-dir-arrow'); arrow.innerHTML = svg('chevron'); arrow.setAttribute('aria-hidden', 'true'); row.append(arrow); }
        row.addEventListener('click', () => openPreview(preview.machineId, Core.resolvePath(preview.path.replace(/[\\/]+$/, ''), entry.name)));
        list.append(row);
      }
      body.append(list);
      if (data.more) body.append(node('p', 'pv-note', `还有 ${data.more} 项没有列出来。`));
    } else if (data.kind === 'markdown' && !preview.source) {
      body.append(markdownNode(data.text, { className: 'pv-md' }));
    } else if (data.kind === 'markdown' || data.kind === 'text') {
      const wrap = node('div', 'pv-code'), total = data.text.split('\n').length;
      const gutter = node('pre', 'pv-gutter', Array.from({ length: total }, (_, i) => i + 1).join('\n')); gutter.setAttribute('aria-hidden', 'true');
      const source = node('pre', 'pv-src');
      copyClean(new DOMParser().parseFromString('<pre>' + Core.highlightCode(data.text, data.kind === 'markdown' ? 'plain' : data.lang || 'plain') + '</pre>', 'text/html').body.firstChild, source);
      wrap.append(gutter, source);
      body.append(wrap);
    } else if (data.kind === 'image') {
      const image = node('img', 'pv-image');
      image.alt = data.name; image.src = `data:${data.mime || 'image/png'};base64,${data.base64}`;
      image.title = '点一下看原始大小';
      image.addEventListener('click', () => image.classList.toggle('actual'));
      body.classList.add('is-image');
      body.append(image);
    } else if (data.kind === 'pdf') {
      body.classList.add('is-pdf');
      showPdf(body, data, preview.call);
    } else if (data.kind === 'toolarge') {
      say('file', data.name, `这个文件有 ${Core.sizeText(data.size)}，超过了能在这里看的上限（${Core.sizeText(data.limit)}），没有读取。它还在 ${m.label} 上，路径可以用上面的复制图标复制。`);
    } else {
      say('file', data.name, `${Core.sizeText(data.size)} · 这种文件不能在这里预览（不是文字、图片或 PDF）。它还在 ${m.label} 上，路径可以用上面的复制图标复制。`);
    }
    if (data.truncated) body.append(node('p', 'pv-note', `文件有 ${Core.sizeText(data.size)}，这里只显示了前 1 MB。`));
    if (preview.line > 0 && body.querySelector('.pv-src')) requestAnimationFrame(() => { body.scrollTop = Math.max(0, (preview.line - 4) * 20); });
  }

  // The sheet follows the finger: up to the full screen, down past a third to close.
  // From its handle and title always; from the content only when that is scrolled to its top.
  {
    let pull = null;
    const tall = () => shell.clientHeight;
    const begin = (y) => { pull = { y, from: panel.getBoundingClientRect().height, at: Date.now(), last: y, moved: false }; };
    const move = (y) => {
      if (!pull) return;
      pull.moved = pull.moved || Math.abs(y - pull.y) > 6;
      if (!pull.moved) return;
      pull.speed = (y - pull.last) / Math.max(1, Date.now() - pull.at); pull.last = y; pull.at = Date.now();
      panel.classList.add('dragging');
      panel.style.height = Math.max(80, Math.min(tall(), pull.from - (y - pull.y))) + 'px';
    };
    const end = () => {
      if (!pull) return;
      const drag = pull; pull = null;
      panel.classList.remove('dragging');
      if (!drag.moved) return;
      const height = panel.getBoundingClientRect().height, share = height / tall(), flick = drag.speed || 0;
      panel.style.removeProperty('height');
      if (flick > 0.6 || share < 0.34) return closePreview();
      preview.snap = flick < -0.6 || share > 0.78 ? 'full' : 'half';
      panel.dataset.snap = preview.snap;
    };
    const sheetNow = () => preview.open && !docked.matches;
    for (const handle of [$('preview-grip'), panel.querySelector('.preview-title')]) {
      handle.addEventListener('pointerdown', (event) => { if (!sheetNow() || event.button > 0) return; begin(event.clientY); handle.setPointerCapture(event.pointerId); });
      handle.addEventListener('pointermove', (event) => { if (pull) { move(event.clientY); if (pull && pull.moved) event.preventDefault(); } });
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }
    // A tap on the handle steps between half and full height.
    $('preview-grip').addEventListener('click', () => { if (!sheetNow()) return; preview.snap = preview.snap === 'full' ? 'half' : 'full'; panel.dataset.snap = preview.snap; });
    let touch = null;
    previewBody.addEventListener('touchstart', (event) => { touch = sheetNow() && event.touches.length === 1 ? { y: event.touches[0].clientY, x: event.touches[0].clientX, top: scrollTopUnder(event.target) <= 0 } : null; }, { passive: true });
    previewBody.addEventListener('touchmove', (event) => {
      if (!touch || event.touches.length !== 1) return;
      const y = event.touches[0].clientY, dy = y - touch.y, dx = event.touches[0].clientX - touch.x;
      if (!pull) { if (!(touch.top && dy > 8 && dy > Math.abs(dx) * 1.5)) return; begin(touch.y); }
      move(y);
      if (event.cancelable) event.preventDefault();
    }, { passive: false });
    previewBody.addEventListener('touchend', end);
    previewBody.addEventListener('touchcancel', end);
  }
  // How far the list under the finger is scrolled (the body itself, or a table or code block inside it).
  function scrollTopUnder(target) {
    let top = 0;
    for (let el = target; el && el !== panel; el = el.parentElement) top = Math.max(top, el.scrollTop || 0);
    return top;
  }

  // ---- wide screens: the desktop app's layout ----------------------------------
  // A tablet lying on its side has room for what the desktop shows: the sidebar
  // (pages, each computer's Captain with its sessions under it, quota, the tool
  // row) on the left, the page in the middle, the preview on the right. The
  // conversation keeps its phone look. Below that width nothing changes.
  const sideIcons = { captain: 'crown', attention: 'attention', board: 'board', todo: 'todo', overview: 'overview' };
  document.querySelectorAll('[data-side-view]').forEach((button) => {
    button.querySelector('.side-icon').innerHTML = svg(sideIcons[button.dataset.sideView]);
    button.addEventListener('click', () => { showView(button.dataset.sideView); if (view === 'todo') $('todo-text').focus(); });
  });
  const KEY_SIDEBAR = 'agentdeck-hub-sidebar';
  let sidebarClosed = stored(KEY_SIDEBAR) === 'closed';
  function applyLayout() {
    const isWide = wide.matches;
    shell.classList.toggle('wide', isWide);
    shell.classList.toggle('sidebar-closed', isWide && sidebarClosed);
    // The tool row sits at the foot of the sidebar there, as on the desktop; on a phone it stays in the header.
    const actions = document.querySelector('.header-actions');
    if (isWide && actions.parentElement !== $('side-foot')) $('side-foot').append(actions);
    else if (!isWide && actions.parentElement !== $('app-header')) $('pane-toggle').before(actions);
    const toggle = $('side-toggle'), label = sidebarClosed ? '展开侧边栏' : '收起侧边栏';
    toggle.title = label; toggle.setAttribute('aria-label', label); toggle.setAttribute('aria-expanded', String(!sidebarClosed));
    // The session list is in the sidebar there, so the list page has nothing to add.
    if (isWide && view === 'sessions' && machines.length) showView('captain');
    placePanel();
    if (machines.length) render();
  }
  $('side-toggle').addEventListener('click', () => { sidebarClosed = !sidebarClosed; store(KEY_SIDEBAR, sidebarClosed ? 'closed' : 'open'); applyLayout(); });
  wide.addEventListener('change', applyLayout);
  docked.addEventListener('change', applyLayout);

  function renderSidebar() {
    if (!wide.matches) return;
    document.querySelectorAll('[data-side-view]').forEach((button) => {
      if (button.dataset.sideView === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    const list = $('side-sessions');
    if (changed(list, [view, target, output && [output.machineId, output.id], machines.map((m) => [m.id, m.label, m.state, m.snap && m.snap.captain && [m.snap.captain.id, m.snap.captain.status], m.snap && m.snap.sessions.map((s) => [s.id, s.title, s.status, s.isMain]), seatSignature(m)])])) {
      const focused = list.contains(document.activeElement) ? document.activeElement.dataset.row : '';
      list.replaceChildren();
      for (const m of machines) {
        const group = node('div', 'side-group'), head = node('div', 'side-captain');
        const captain = m.snap && m.snap.captain && m.snap.captain.id ? m.snap.captain : null, online = m.state === 'online';
        const row = node('button', 'side-row is-captain'); row.type = 'button'; row.dataset.row = m.id + ':captain';
        const crown = node('span', 'side-crown'); crown.innerHTML = svg('crown'); crown.setAttribute('aria-hidden', 'true');
        const status = online ? (captain ? captain.status : 'unavailable') : '';
        const dot = node('span', online ? 'status-dot ' + status : 'dot tone-' + Core.STATES[m.state].tone); dot.setAttribute('aria-hidden', 'true');
        const seat = online && m.relay ? Core.currentSeat(m.relay) : null;
        const state = online ? (seat ? Core.seatLabel(seat) : statusNames[status] || '') : Core.STATES[m.state].short;
        row.append(crown, dot, node('span', 'side-title', `${m.label} 队长`), node('span', 'side-state', state));
        row.setAttribute('aria-label', `${m.label} 队长，${online ? statusNames[status] || '空闲' : Core.STATES[m.state].label}${seat ? '，在用 ' + Core.seatLabel(seat) : ''}`);
        row.title = online ? `${statusNames[status] || '空闲'}${seat ? ' · ' + Core.seatLabel(seat) + ' ' + Core.seatQuotaText(seat) : ''}` : Core.STATES[m.state].label;
        if (view === 'captain' && target === m.id) row.setAttribute('aria-current', 'true');
        // A computer that is not answering opens its card, where it says why and takes the login.
        row.addEventListener('click', () => { if (online) { setTarget(m.id); showView('captain'); } else { setFilter(m.id); showView('overview'); } });
        head.append(row);
        if (online && m.relay && m.relay.captainId) {
          const swap = iconButton('swap', `切换 ${m.label} 队长的账号`, 'side-switch');
          swap.dataset.switch = m.id; swap.setAttribute('aria-haspopup', 'dialog');
          swap.addEventListener('click', () => openSwitch(m));
          head.append(swap);
        }
        group.append(head);
        const crew = (m.snap ? m.snap.sessions : []).filter((s) => !s.isMain);
        if (crew.length) {
          // Sessions hang under their Captain on a gold line, as in the desktop sidebar; those at work come first.
          const box = node('div', 'side-crew');
          for (const session of [...crew.filter((s) => s.status === 'working'), ...crew.filter((s) => s.status !== 'working')]) {
            const item = node('button', 'side-row'); item.type = 'button'; item.dataset.row = m.id + ':' + session.id;
            const mark = node('span', 'status-dot ' + session.status); mark.setAttribute('aria-hidden', 'true');
            item.append(mark, node('span', 'side-title', session.title), node('span', 'side-state', statusNames[session.status] || '空闲'));
            item.title = session.title;
            if (view === 'output' && output && output.machineId === m.id && output.id === session.id) item.setAttribute('aria-current', 'true');
            item.addEventListener('click', () => openOutput(m, session));
            box.append(item);
          }
          group.append(box);
        }
        list.append(group);
      }
      if (focused) list.querySelector(`[data-row="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }
    // Quota of the computer the conversation is with, at the foot like the desktop sidebar.
    const quotaBox = $('side-quota'), m = byId(target), now = Math.floor(Date.now() / 60000);
    if (changed(quotaBox, [target, m && m.state, m && m.quota, m && m.quotaFailed, [...openQuota], machines.length, now])) {
      const focused = quotaBox.contains(document.activeElement) ? document.activeElement.getAttribute('aria-controls') : '';
      quotaBox.replaceChildren();
      if (m && m.state === 'online' && m.quota) {
        const section = quotaSection(m, 'side-');
        if (machines.length > 1) section.querySelector('h3').textContent = `额度 · ${m.label}`;
        quotaBox.append(section);
      }
      if (focused) document.getElementById(focused)?.previousElementSibling?.focus({ preventScroll: true });
    }
    $('side-version').textContent = m && m.meta.appVersion ? 'V' + m.meta.appVersion : '';
    $('side-version').title = machines.filter((x) => x.meta.appVersion).map((x) => `${x.label} 上的 AgentDeck ${x.meta.appVersion}`).join('，');
  }

  // ---- shell ---------------------------------------------------------------
  function showView(next) {
    if (view === 'output' && next !== 'output') { outputRequest++; output = null; $('output-text').textContent = ''; }
    view = next;
    if (TABS.includes(view)) store(KEYS.view, view);
    ['overview', 'captain', 'todo', 'sessions', 'board', 'output'].forEach((name) => { $(name + '-view').hidden = name !== view; });
    document.querySelectorAll('[data-view]').forEach((button) => {
      if (button.dataset.view === (view === 'output' ? 'sessions' : view)) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('back').hidden = view !== 'output';
    $('attention-view').hidden = view !== 'attention';
    if (view === 'attention') machines.forEach((m) => { if (m.state === 'online') m.nextAt = 0; });
    $('main').classList.toggle('fill', view === 'captain');
    if (view === 'todo') { $('brand-title').textContent = '待办'; $('brand-caption').textContent = '两台电脑同一份'; }
    else if (view !== 'output') { $('brand-title').textContent = 'AgentDeck'; $('brand-caption').textContent = '总台'; }
    $('main').scrollTop = 0;
    render();
    if (view === 'captain') $('captain-turns').scrollTop = $('captain-turns').scrollHeight;
    // The 待办 tab reads fresh lists at once rather than on the next 30-second turn.
    if (view === 'todo') machines.forEach((m) => { if (m.state === 'online') m.nextAt = 0; });
  }
  function render() {
    renderBusy(); renderBar(); renderOverview(); renderCaptain(); renderTodos(); renderSessions(); renderBoard(); renderSheet();
    $('logout-all').disabled = !machines.some((m) => m.state === 'online');
    renderAttention();
    renderSidebar();
  }
  $('refresh').addEventListener('click', refreshAll);
  $('back').addEventListener('click', () => showView(wide.matches ? 'captain' : 'sessions'));
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
    const m = sheet && byId(sheet.machineId), waited = document.getElementById('switch-elapsed');
    if (waited && m && m.relayJob) waited.textContent = '已经等了 ' + Core.elapsedText(now - m.relayJob.startedAt);
  }, 1000);

  async function start() {
    let list = [];
    try { list = Core.machineList(await (await fetch('machines.json', { cache: 'no-store', redirect: 'error' })).json()); } catch (_) { /* Reported below. */ }
    if (!list.length) { notice('没有读到电脑列表（machines.json）。请刷新重试。', true); return; }
    let meta = {};
    try { meta = JSON.parse(stored(KEYS.meta)) || {}; } catch (_) { /* Start without remembered metadata. */ }
    machines = list.map((m) => ({ ...m, state: 'unknown', detail: '', snap: null, csrf: '', cards: null, boardVersion: null, hostname: '', todos: null, todosReady: null, todosAt: 0,
      meta: Core.cleanMeta(meta[m.id]), quota: null, quotaFailed: false, quotaAt: 0, forceQuota: false, relay: null, relayFailed: false, relayAt: 0, relayJob: null, relayTimer: 0, current: false, nextAt: 0, busy: false, again: false, banUntil: 0, loginError: '', loginBusy: false, logoutBusy: false, card: node('article', 'machine-card') }));
    machines.forEach((m) => { m.card.setAttribute('aria-label', m.label); m.card.dataset.machine = m.id; $('machine-cards').append(m.card); });
    const saved = stored(KEYS.machine);
    filter = byId(saved) ? saved : 'all';
    // With nothing chosen, work goes to the default machine (Mac) until the user picks another.
    target = filter !== 'all' ? filter : (machines.find((m) => m.default) || machines[0]).id;
    // Open where the user left off; a bookmark ending in #todo (or another tab's name) opens that tab.
    const asked = location.hash.slice(1), last = stored(KEYS.view);
    showView(TABS.includes(asked) ? asked : TABS.includes(last) ? last : 'overview');
    applyLayout();
    refreshAll();
  }
  start();
})();
