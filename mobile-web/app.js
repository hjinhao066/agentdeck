'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const icons = {
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',
    moon: '<path d="M20.8 13a9 9 0 0 1-9.8-9.8A9 9 0 1 0 20.8 13Z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    logout: '<path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h12"/>',
    back: '<path d="m14 6-6 6 6 6M8 12h12"/>',
    chat: '<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>',
    sessions: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.4c1.7.7 2.7 2.3 3 4.6"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5L21 17"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    board: '<path d="M4 4v16M12 4v16M20 4v16M4 8h4m4 5h4m4-5h2"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    crown: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/>',
    gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="m12 13 4-5"/><circle cx="12" cy="13" r="1.2"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
  };
  // The desktop's provider marks (agent-info.js PROVIDER_ICONS), so both ends show the same icons.
  const providerIcons = {
    Cursor: '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 3 10.5 21 13.5 13.5 21 10.5 3 3"/></svg>',
    Claude: '<svg viewBox="0 0 100 100" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"/></svg>',
    Antigravity: '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 2C12 7.5 7.5 12 2 12C7.5 12 12 16.5 12 22C12 16.5 16.5 12 22 12C16.5 12 12 7.5 12 2Z"/></svg>',
    Grok: '<svg viewBox="36 36 440 440" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M210.484 312.759L343.465 210.383C349.984 205.364 359.302 207.322 362.408 215.117C378.758 256.231 371.454 305.64 338.925 339.563C306.397 373.487 261.137 380.927 219.768 363.983L174.577 385.803C239.394 432.008 318.104 420.581 367.289 369.251C406.303 328.564 418.386 273.104 407.088 223.091L407.19 223.198C390.807 149.726 411.218 120.359 453.03 60.3072C454.02 58.8833 455.01 57.4595 456 56L400.978 113.382V113.204L210.45 312.794"/><path d="M183.042 337.641C136.519 291.294 144.54 219.567 184.236 178.203C213.59 147.59 261.683 135.096 303.666 153.464L348.755 131.75C340.632 125.627 330.221 119.042 318.275 114.414C264.277 91.2407 199.63 102.774 155.735 148.516C113.513 192.549 100.236 260.254 123.036 318.027C140.069 361.206 112.148 391.748 84.0229 422.575C74.0561 433.503 64.0553 444.431 56 456L183.007 337.677"/></svg>',
    Codex: '<svg viewBox="134 213 293 293" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z"/></svg>',
  };
  const svg = (name) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
  const statusNames = { working: '干活中', idle: '空闲', failed: '失败', input: '停在确认', quota: '额度用尽/等待', queued: '待补充', waiting: '排队', asking: '在问你', done: '完成' };
  const needsUser = new Set(['input', 'asking']);
  const taskStatuses = [['todo', '待办'], ['doing', '进行中'], ['review', '待验收'], ['needs_user', '等用户'], ['done', '完成']];
  const flagNames = { failed: '失败', blocked: '前置未完成', held: '挂起' };
  let sessions = [], cards = [], captainData = { turns: [] }, view = 'captain', outputFrom = 'captain', selected = null, refreshing = false, sending = false, loaded = false, offline = false, csrfToken = '';
  let sessionsSignature, boardSignature, turnsSignature, attentionSignature;
  let outputRequest = 0, statusTimer;
  // Quota rows as the desktop sidebar shows them; quotaFailed means the last read did not arrive.
  let quota = { rows: [], version: '' }, quotaLoaded = false, quotaFailed = false, quotaBusy = false, quotaSignature, chipSignature;
  let drawerOpen = false, drawerOpener = null;
  const expandedQuota = new Set();
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let savedTheme;
  try { savedTheme = localStorage.getItem('agentdeck-mobile-theme'); } catch (_) { /* Storage can be unavailable in private browsers. */ }
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('theme').setAttribute('aria-checked', String(theme === 'dark'));
    // Safari tints its own bars with this, so they match the page edge to edge.
    $('theme-color').content = theme === 'dark' ? '#171717' : '#ffffff';
  }
  applyTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : systemTheme.matches ? 'dark' : 'light');
  systemTheme.addEventListener('change', () => { if (!savedTheme) applyTheme(systemTheme.matches ? 'dark' : 'light'); });
  $('theme').addEventListener('click', () => {
    savedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(savedTheme);
    try { localStorage.setItem('agentdeck-mobile-theme', savedTheme); } catch (_) { /* Keep the choice for this page. */ }
  });
  ['refresh', 'copy', 'send', 'back'].forEach((name) => { $(name).innerHTML = svg(name); });
  $('menu').innerHTML = svg('sidebar');
  $('drawer-close').innerHTML = svg('close');
  $('quota-refresh').innerHTML = svg('refresh');
  $('drawer-captain').querySelector('.row-icon').innerHTML = svg('crown');
  $('quota-entry').querySelector('.row-icon').innerHTML = svg('gauge');
  $('quota-entry').querySelector('.row-chevron').innerHTML = svg('chevron');
  $('attach').innerHTML = svg('image');
  $('theme').querySelector('.row-icon').innerHTML = svg('moon');
  $('logout').querySelector('.row-icon').innerHTML = svg('logout');
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((tab) => tab.querySelector('.tab-icon').insertAdjacentHTML('afterbegin', svg({ captain: 'chat', sessions: 'sessions', board: 'board', more: 'more' }[tab.dataset.view])));

  // Keep the shell inside the visual viewport so the soft keyboard pushes the
  // composer up instead of covering it (iOS Safari does not resize the layout).
  // The keyboard counts as open while a text field has focus and the visible
  // height is well below the tallest seen at this width (iOS keeps innerHeight,
  // Android shrinks it too). The tab bar hides then, so the composer sits on
  // the keyboard and the conversation keeps its room.
  const viewport = window.visualViewport;
  let fullHeight = 0, fullWidth = 0;
  function fitViewport() {
    if (!viewport) return;
    const root = document.documentElement.style;
    root.setProperty('--app-height', viewport.height + 'px');
    root.setProperty('--app-top', viewport.offsetTop + 'px');
    if (viewport.width !== fullWidth) { fullWidth = viewport.width; fullHeight = 0; }
    fullHeight = Math.max(fullHeight, viewport.height, window.innerHeight);
    $('app').classList.toggle('keyboard-open', document.activeElement === $('message') && fullHeight - viewport.height > 120);
  }
  function onResize() { const follow = atBottom($('captain-turns')); fitViewport(); if (follow) toBottom($('captain-turns')); }
  if (viewport) {
    viewport.addEventListener('resize', onResize);
    viewport.addEventListener('scroll', fitViewport);
    window.addEventListener('resize', onResize);
    $('message').addEventListener('focus', onResize);
    $('message').addEventListener('blur', onResize);
    fitViewport();
  }

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function dot(status) { const el = node('span', 'dot'); el.dataset.status = status || 'idle'; el.setAttribute('aria-hidden', 'true'); return el; }
  function atBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 48; }
  function toBottom(el) { el.scrollTop = el.scrollHeight; }
  function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').hidden = !message;
    $('notice').classList.toggle('error', error);
  }
  function sendStatus(message, sticky = false) {
    clearTimeout(statusTimer);
    $('send-status').textContent = message;
    if (message && !sticky) statusTimer = setTimeout(() => { $('send-status').textContent = ''; }, 6000);
  }
  async function api(url, options) {
    if (options?.method === 'POST') options = { ...options, headers: { ...options.headers, 'X-CSRF-Token': csrfToken } };
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    if (response.status === 401) { window.location.reload(); throw new Error('登录已过期。'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败，请稍后刷新。');
    return result;
  }
  function iconButton(name, label, onClick) {
    const button = node('button', 'icon-button');
    button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    button.innerHTML = svg(name);
    button.addEventListener('click', () => onClick(button));
    return button;
  }
  const copyTimers = new WeakMap();
  async function copyText(button, text, label) {
    try {
      await navigator.clipboard.writeText(text);
      button.innerHTML = svg('check'); button.title = '已复制'; button.setAttribute('aria-label', '已复制');
      clearTimeout(copyTimers.get(button));
      copyTimers.set(button, setTimeout(() => { button.innerHTML = svg('copy'); button.title = label; button.setAttribute('aria-label', label); }, 1600));
    } catch (_) { notice('无法复制。可长按文字手动选择。', true); }
  }
  function empty(message) { return node('p', 'empty', message); }

  // Minimal Markdown for Captain replies. Every piece of text goes in through
  // textContent and links are limited to http(s); no markup is ever parsed.
  // Bare links stop at the first non-ASCII character, so Chinese text or
  // punctuation right after a URL (https://x.com/a。然后) stays outside it.
  const inlinePattern = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`\u0080-￿]+)/g;
  function link(text, href) {
    let url;
    try { url = new URL(href); } catch (_) { return document.createTextNode(text); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return document.createTextNode(text);
    const a = node('a', '', text);
    a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  }
  function inline(parent, text) {
    let last = 0;
    for (const match of text.matchAll(inlinePattern)) {
      let [whole, code, bold, label, labelHref, bare] = match;
      let end = match.index + whole.length;
      if (bare) {
        const trimmed = bare.replace(/[.,;:!?)\]。，；：！？）」』]+$/, '');
        end -= bare.length - trimmed.length; bare = trimmed;
      }
      if (match.index > last) parent.append(text.slice(last, match.index));
      if (code) parent.append(node('code', 'md-code', code.slice(1, -1)));
      else if (bold) parent.append(node('strong', '', bold.slice(2, -2)));
      else if (label) parent.append(link(label, labelHref));
      else parent.append(link(bare, bare));
      last = end;
    }
    if (last < text.length) parent.append(text.slice(last));
    return parent;
  }
  function codeBlock(code, language) {
    const block = node('div', 'code-block');
    const bar = node('div', 'code-bar');
    bar.append(node('span', '', language || '代码'), iconButton('copy', '复制代码', (button) => copyText(button, code, '复制代码')));
    const pre = node('pre'); pre.tabIndex = 0;
    pre.append(node('code', '', code));
    block.append(bar, pre);
    return block;
  }
  // Pipe tables: a header row, a |---|:--:| separator, then body rows. Cells go
  // through the same inline renderer; the wrapper scrolls sideways when wide.
  const tableSeparator = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const cells = (line) => line.trim().replace(/\\\|/g, '\0').replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim().replace(/\0/g, '|'));
  function table(header, separator, rows) {
    const align = cells(separator).map((cell) => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : '');
    const wrap = node('div', 'table-wrap'); wrap.tabIndex = 0;
    const el = node('table'), head = node('thead'), body = node('tbody');
    const row = (values, tag) => {
      const tr = node('tr');
      header.forEach((_, i) => {
        const cell = inline(node(tag), values[i] || '');
        if (align[i]) cell.style.textAlign = align[i];
        tr.append(cell);
      });
      return tr;
    };
    head.append(row(header, 'th'));
    rows.forEach((values) => body.append(row(values, 'td')));
    el.append(head);
    if (rows.length) el.append(body);
    wrap.append(el);
    return wrap;
  }
  function markdown(text) {
    const root = node('div', 'chat-text markdown');
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [], list = null;
    const flush = () => {
      if (paragraph.length) root.append(inline(node('p'), paragraph.join('\n')));
      paragraph = []; list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flush();
        const body = [];
        for (i++; i < lines.length && !new RegExp('^\\s*' + fence[1] + '\\s*$').test(lines[i]); i++) body.push(lines[i]);
        root.append(codeBlock(body.join('\n'), fence[2]));
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && tableSeparator.test(lines[i + 1])) {
        flush();
        const header = cells(line), separator = lines[i + 1], rows = [];
        for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
        i--;
        root.append(table(header, separator, rows));
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); root.append(node('hr')); continue; }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line), ordered = /^\s*(\d{1,9})[.)]\s+(.*)$/.exec(line);
      if (bullet || ordered) {
        const tag = bullet ? 'ul' : 'ol';
        if (paragraph.length) flush();
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = node(tag);
          if (ordered && ordered[1] !== '1') list.start = Number(ordered[1]);
          root.append(list);
        }
        list.append(inline(node('li'), bullet ? bullet[1] : ordered[2]));
        continue;
      }
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(line), quote = /^\s*>\s?(.*)$/.exec(line);
      if (heading) { flush(); root.append(inline(node('p', 'md-heading'), heading[1])); continue; }
      if (quote) { flush(); root.append(inline(node('blockquote'), quote[1])); continue; }
      if (!line.trim()) { flush(); continue; }
      if (list) list = null;
      paragraph.push(line);
    }
    flush();
    return root;
  }

  // The drawer mirrors the desktop sidebar: the Captain first, then its
  // sessions grouped by project, each with a status dot.
  function renderSessions() {
    const captain = sessions.find((s) => s.isMain);
    const workers = sessions.filter((s) => !s.isMain);
    const waiting = workers.filter((s) => needsUser.has(s.status)).length;
    const current = view === 'output' ? selected?.id : null;
    const signature = JSON.stringify([sessions, loaded, view, current, offline]);
    if (signature === sessionsSignature) return;
    sessionsSignature = signature;
    // The tab badge counts the sessions that are waiting on the user.
    const badge = $('sessions-badge'), tab = badge.closest('.tab');
    badge.hidden = !waiting; badge.textContent = waiting > 9 ? '9+' : String(waiting);
    tab.setAttribute('aria-label', waiting ? '会话，' + waiting + ' 个等你处理' : '会话');
    const row = $('drawer-captain');
    row.querySelector('.row-title').textContent = captain?.title || '队长';
    $('captain-dot').dataset.status = offline ? 'offline' : captain ? captain.status : 'none';
    $('captain-state').textContent = offline ? '连接中断' : captain ? statusNames[captain.status] || '空闲' : loaded ? '尚未创建' : '';
    row.classList.toggle('active', view === 'captain');
    if (view === 'captain') row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current');
    const list = $('sessions');
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.sessionId : null;
    list.replaceChildren();
    if (!workers.length) { list.append(empty(loaded ? '暂无队员会话。队长派活后会显示在这里。' : '')); return; }
    const groups = new Map();
    for (const session of workers) {
      const project = session.project || '';
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project).push(session);
    }
    const rank = (s) => needsUser.has(s.status) ? 0 : s.status === 'working' ? 1 : 2;
    // Named projects first; sessions without a project close the list.
    const names = [...groups.keys()].sort((a, b) => !a - !b);
    for (const project of names) {
      const members = groups.get(project).sort((a, b) => rank(a) - rank(b));
      const label = project || (names.length > 1 ? '未分项目' : '会话');
      const section = node('section', 'session-group'); section.setAttribute('aria-label', label);
      const heading = node('h2', 'nav-section');
      heading.append(node('span', 'nav-section-label', label), node('span', 'nav-section-count', String(members.length)));
      section.append(heading);
      for (const session of members) {
        const button = node('button', 'session-row' + (session.id === current ? ' active' : ''));
        button.type = 'button'; button.dataset.sessionId = session.id;
        button.setAttribute('aria-label', session.title + '，' + (statusNames[session.status] || '空闲'));
        if (session.id === current) button.setAttribute('aria-current', 'page');
        const main = node('span', 'row-main');
        main.append(node('span', 'row-title', session.title), node('span', 'row-sub', session.receipt || session.model || '尚未提交回执'));
        const tag = node('span', 'row-tag' + (needsUser.has(session.status) ? ' alert' : session.status === 'failed' || session.status === 'quota' ? ' failed' : ''), statusNames[session.status] || '空闲');
        button.append(dot(session.status), main, tag);
        button.addEventListener('click', () => { closeDrawer(false); openOutput(session); $('back').focus({ preventScroll: true }); });
        section.append(button);
      }
      list.append(section);
    }
    if (focused) list.querySelector('[data-session-id="' + CSS.escape(focused) + '"]')?.focus();
  }

  // ---- quota ----
  const pad = (value) => String(value).padStart(2, '0');
  const hm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const monthDay = (t) => { const d = new Date(t); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const weekday = (t) => '周' + '日一二三四五六'[new Date(t).getDay()];
  // Same wording as the desktop rows: a clock inside 24 hours, then the weekday, then the date.
  function shortReset(t, now) { const gap = t - now; return gap <= 86400000 ? hm(t) : gap < 6 * 86400000 ? weekday(t) : monthDay(t); }
  function longReset(t, now) {
    const mins = Math.max(1, Math.round((t - now) / 60000));
    const left = mins < 60 ? mins + ' 分钟' : mins < 1440 ? Math.floor(mins / 60) + ' 小时' + (mins % 60 ? ' ' + mins % 60 + ' 分' : '') : Math.floor(mins / 1440) + ' 天';
    return (t - now <= 86400000 ? '' : monthDay(t) + ' ') + hm(t) + '（' + left + '后）';
  }
  function sampledText(row, now) { return row.sampledAt ? '采样 ' + (Math.abs(now - row.sampledAt) > 86400000 ? monthDay(row.sampledAt) + ' ' : '') + hm(row.sampledAt) : '暂无采样'; }
  // Old, missing or unreadable numbers are grey: they never read as usable.
  const dimmed = (row) => quotaFailed || ['stale', 'expired', 'unknown', 'nodigits'].includes(row.status);
  const percentText = (cell) => cell.out ? '用尽' : cell.remaining < 1 ? '<1%' : Math.round(cell.remaining) + '%';
  const cellLevel = (row, cell) => cell.out ? 'out' : dimmed(row) ? 'none' : cell.remaining <= 10 ? 'danger' : cell.remaining <= 20 ? 'low' : 'ok';
  function meter(cell) {
    const el = node('span', 'quota-meter'); el.setAttribute('aria-hidden', 'true');
    el.style.setProperty('--pct', (cell.out ? 0 : Math.max(2, Math.min(100, cell.remaining))) + '%');
    return el;
  }
  // One explicit line whenever a row is not plain live numbers.
  function quotaNote(row, now) {
    const parts = [];
    if (row.status === 'out') parts.push('已用尽', row.recoveryAt > now ? longReset(row.recoveryAt, now) + '恢复' : '恢复时间未知');
    if (row.failed) parts.push('查询失败');
    if (row.status === 'stale' || row.status === 'expired') parts.push('数据已旧', sampledText(row, now));
    else if (row.status === 'unknown') parts.push('未知', '暂无采样');
    else if (row.status === 'nodigits') parts.push('未见用尽报错', '此来源不提供百分比');
    else if (row.failed) parts.push(sampledText(row, now));
    return parts.join(' · ');
  }
  function quotaLabel(row, now) {
    const windows = row.cells.map((cell) => (cell.key === '5h' ? '5 小时' : '每周') + (cell.out ? '已用尽' : '剩余 ' + percentText(cell)) + (cell.resetAt > now ? '，' + longReset(cell.resetAt, now) + '重置' : ''));
    return [row.name + (row.captain ? '（队长在用）' : ''), ...windows, quotaNote(row, now) || (row.cells.length ? '' : '未知')].filter(Boolean).join('；');
  }
  function renderQuota() {
    const now = Date.now();
    // Reset clocks change by the minute; nothing else needs a redraw.
    const signature = JSON.stringify([quota, quotaLoaded, quotaFailed, [...expandedQuota], Math.floor(now / 60000)]);
    if (signature !== quotaSignature) {
      quotaSignature = signature;
      const box = $('quota-rows');
      const focused = box.contains(document.activeElement) ? document.activeElement.closest('.quota-item')?.dataset.quotaKey : null;
      box.replaceChildren();
      $('version').textContent = quota.version ? 'V' + quota.version : '';
      $('quota-note').textContent = quotaFailed ? '未能更新' : '';
      if (!quota.rows.length) box.append(node('p', 'quota-empty', quotaFailed ? '暂时读不到额度。' : quotaLoaded ? '桌面端还没有额度数据。' : ''));
      quota.rows.forEach((row, index) => {
        const item = node('div', 'quota-item'); item.setAttribute('role', 'listitem');
        item.dataset.quotaKey = row.key; item.dataset.status = row.status; item.dataset.provider = row.provider;
        if (dimmed(row)) item.dataset.dim = 'true';
        if (row.captain) item.dataset.captain = 'true';
        const open = expandedQuota.has(row.key), detailId = 'quota-detail-' + index;
        const button = node('button', 'quota-row'); button.type = 'button';
        button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-controls', detailId);
        button.setAttribute('aria-label', quotaLabel(row, now)); button.title = open ? '收起详情' : '展开详情';
        const icon = node('span', 'quota-icon'); icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = providerIcons[row.provider === 'Cursor' ? 'Grok' : row.provider] || '';
        const name = node('span', 'quota-name');
        name.append(node('span', 'quota-name-text', [row.flag, row.short].filter(Boolean).join(' ')));
        if (row.captain) { const crown = node('span', 'quota-captain'); crown.title = '队长在用'; crown.innerHTML = svg('crown'); name.append(crown); }
        const values = node('span', 'quota-values');
        for (const cell of row.cells) {
          const el = node('span', 'quota-cell'); el.dataset.window = cell.key; el.dataset.level = cellLevel(row, cell);
          el.append(node('span', 'quota-key', cell.key), node('span', 'quota-pct', percentText(cell)));
          if (cell.resetAt > now) el.append(node('span', 'quota-reset', shortReset(cell.resetAt, now)));
          el.append(meter(cell)); values.append(el);
        }
        if (!row.cells.length) {
          const status = node('span', 'quota-status', row.status === 'out' ? '已用尽' : row.status === 'nodigits' ? '未见用尽' : '未知');
          status.dataset.level = row.status === 'out' ? 'out' : 'none'; values.append(status);
        }
        button.append(icon, name, values);
        const note = quotaNote(row, now);
        if (note) button.append(node('span', 'quota-row-note' + (row.status === 'out' ? ' out' : ''), note));
        button.addEventListener('click', () => { if (open) expandedQuota.delete(row.key); else expandedQuota.add(row.key); renderQuota(); });
        const detail = node('div', 'quota-detail'); detail.id = detailId; detail.hidden = !open;
        const head = node('p', 'quota-detail-head', row.name);
        if (row.captain) head.append(node('span', 'quota-detail-captain', '队长在用'));
        detail.append(head);
        for (const cell of row.cells) {
          const line = node('p', 'quota-detail-line'); line.dataset.level = cellLevel(row, cell);
          line.append(node('span', 'quota-detail-key', cell.key === '5h' ? '5 小时' : '每周'), node('span', 'quota-pct', cell.out ? '已用尽' : '剩余 ' + percentText(cell)),
            node('span', 'quota-detail-reset', cell.resetAt > now ? longReset(cell.resetAt, now) + '重置' : '重置时间未知'));
          detail.append(line);
        }
        if (!row.cells.length) detail.append(node('p', 'quota-detail-line', row.status === 'nodigits' ? '未见用尽报错，此来源不提供百分比' : '暂无额度数据，等待桌面端下次采样'));
        detail.append(node('p', 'quota-detail-foot', [row.account, sampledText(row, now) + (row.status === 'stale' || row.status === 'expired' ? '（数据已旧）' : '')].filter(Boolean).join(' · ')));
        item.append(button, detail); box.append(item);
      });
      if (focused) box.querySelector('[data-quota-key="' + CSS.escape(focused) + '"] .quota-row')?.focus();
    }
    renderSeat();
  }
  // The small indicator next to the title: the seat the Captain is on and
  // its 5-hour remainder. It only opens the quota rows; it adds no height.
  function renderSeat() {
    const now = Date.now(), row = quota.rows.find((r) => r.captain);
    const chip = $('seat-chip');
    const signature = JSON.stringify([row, quotaFailed, view, Math.floor(now / 60000)]);
    if (signature === chipSignature) return;
    chipSignature = signature;
    chip.hidden = !row || view !== 'captain';
    const summary = $('quota-entry-text');
    if (!row) { summary.textContent = quotaFailed ? '未能更新' : ''; return; }
    const cell = row.cells.find((c) => c.key === '5h'), weekly = row.cells.find((c) => c.key === '7d');
    const shown = cell || weekly;
    const value = row.status === 'out' || shown?.out ? '用尽' : shown ? (cell ? '' : '周 ') + percentText(shown) : '—';
    const level = value === '用尽' ? 'out' : !shown || dimmed(row) ? 'none' : shown.remaining < 10 ? 'low' : 'ok';
    const label = [row.flag, row.short].filter(Boolean).join(' ');
    $('seat-chip-text').textContent = row.short + ' ' + value;
    chip.dataset.level = level;
    const spoken = '当前席位 ' + row.name + '：' + (value === '用尽' ? '已用尽' : !shown ? '额度未知' : (cell ? '5 小时' : '每周') + '剩余 ' + percentText(shown)) + (level === 'none' && shown ? '（数据已旧）' : '') + '，查看额度';
    chip.title = spoken; chip.setAttribute('aria-label', spoken);
    summary.textContent = label + ' ' + value; summary.dataset.level = level;
  }
  async function loadQuota() {
    try { const data = await api('/api/quota'); quota = { rows: Array.isArray(data.rows) ? data.rows : [], version: data.version || '' }; quotaLoaded = true; quotaFailed = false; }
    catch (_) { quotaFailed = true; }
  }
  async function refreshQuota() {
    if (quotaBusy) return;
    quotaBusy = true; $('quota-refresh').disabled = true; $('quota-refresh').classList.add('refreshing');
    await loadQuota(); renderQuota();
    quotaBusy = false; $('quota-refresh').disabled = false; $('quota-refresh').classList.remove('refreshing');
  }

  // ---- drawer ----
  // Open: everything behind is inert and focus moves inside. Closed: the
  // drawer itself is inert, so it is out of the tab order and unreadable.
  function setDrawer(open) {
    drawerOpen = open;
    $('app').classList.toggle('drawer-open', open);
    for (const el of $('app').children) if (el.id !== 'drawer' && el.id !== 'scrim') el.inert = open;
    $('drawer').inert = !open;
    for (const id of ['menu', 'seat-chip', 'quota-entry']) $(id).setAttribute('aria-expanded', String(open));
    document.querySelector('.tab[data-view="sessions"]').setAttribute('aria-expanded', String(open));
  }
  function openDrawer(target) {
    if (!drawerOpen) { drawerOpener = document.activeElement; $('message').blur(); setDrawer(true); }
    if (target === 'quota') { $('quota').scrollIntoView({ block: 'end' }); $('quota').focus({ preventScroll: true }); }
    else $('drawer-close').focus({ preventScroll: true });
  }
  function closeDrawer(restore = true) {
    if (!drawerOpen) return;
    setDrawer(false);
    if (restore && drawerOpener?.isConnected && !drawerOpener.hidden) drawerOpener.focus({ preventScroll: true });
    drawerOpener = null;
  }
  $('menu').addEventListener('click', () => openDrawer());
  $('seat-chip').addEventListener('click', () => openDrawer('quota'));
  $('quota-entry').addEventListener('click', () => openDrawer('quota'));
  $('drawer-close').addEventListener('click', () => closeDrawer());
  $('scrim').addEventListener('click', () => closeDrawer());
  $('drawer-captain').addEventListener('click', () => { closeDrawer(false); showView('captain'); $('menu').focus({ preventScroll: true }); });
  $('quota-refresh').addEventListener('click', refreshQuota);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && drawerOpen) { event.preventDefault(); closeDrawer(); } });
  // A right swipe that starts at the left edge opens the drawer; a left swipe
  // on the open drawer or the scrim closes it. Mostly-vertical moves scroll.
  let swipe = null;
  document.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    swipe = event.touches.length === 1 && (drawerOpen || touch.clientX <= 24) ? { x: touch.clientX, y: touch.clientY } : null;
  }, { passive: true });
  document.addEventListener('touchmove', (event) => {
    if (!swipe) return;
    const dx = event.touches[0].clientX - swipe.x, dy = event.touches[0].clientY - swipe.y;
    if (Math.abs(dy) > 24 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (!drawerOpen && dx > 56) { swipe = null; openDrawer(); }
    else if (drawerOpen && dx < -56) { swipe = null; closeDrawer(); }
  }, { passive: true });
  document.addEventListener('touchend', () => { swipe = null; }, { passive: true });

  function renderAttention() {
    // Settings need no reminder.
    const waiting = view === 'more' ? [] : sessions.filter((s) => needsUser.has(s.status) && !(view === 'output' && s.id === selected?.id));
    const signature = JSON.stringify(waiting.map((s) => [s.id, s.title, s.status]));
    if (signature === attentionSignature) return;
    attentionSignature = signature;
    const bar = $('attention'); bar.replaceChildren();
    bar.hidden = !waiting.length;
    for (const session of waiting) {
      const chip = node('button', 'attention-chip');
      chip.type = 'button'; chip.dataset.sessionId = session.id;
      chip.append(dot(session.status), node('span', 'chip-title', session.title), node('span', 'chip-state', statusNames[session.status]));
      chip.addEventListener('click', () => session.isMain ? showView('captain') : openOutput(session));
      bar.append(chip);
    }
  }
  function renderBoard() {
    const signature = JSON.stringify(cards);
    if (signature === boardSignature) return;
    boardSignature = signature;
    const projects = $('projects'); projects.replaceChildren();
    const grouped = new Map();
    for (const card of cards.filter((c) => !c.archived)) {
      if (!grouped.has(card.project)) grouped.set(card.project, []);
      grouped.get(card.project).push(card);
    }
    if (!grouped.size) { projects.append(empty('暂无任务。任务会在桌面端创建后显示。')); return; }
    for (const [project, tasks] of grouped) {
      const section = node('section', 'project');
      const heading = node('div', 'project-heading');
      heading.append(node('h2', '', project), node('span', '', tasks.length + ' 项'));
      const lanes = node('div', 'board-lanes');
      lanes.tabIndex = 0; lanes.setAttribute('aria-label', project + '，左右滑动查看状态列');
      for (const [status, label] of taskStatuses) {
        const tasksInLane = tasks.filter((t) => t.status === status);
        const lane = node('section', 'board-lane' + (tasksInLane.length ? '' : ' is-empty')); lane.dataset.status = status;
        const laneTitle = node('h3', 'lane-heading');
        laneTitle.append(node('span', '', label), node('span', 'lane-count', String(tasksInLane.length)));
        lane.append(laneTitle);
        for (const task of tasksInLane) {
          const card = node('article', 'task-card'); card.dataset.taskId = task.id;
          if (task.flag) card.append(node('span', 'task-flag ' + task.flag, flagNames[task.flag] || task.flag));
          card.append(node('h4', '', task.title));
          if (task.assignee) card.append(node('p', 'task-assignee', [task.assignee.agent, task.assignee.model].filter(Boolean).join(' · ')));
          if (task.latest_receipt) card.append(node('p', 'task-receipt', task.latest_receipt));
          lane.append(card);
        }
        if (!tasksInLane.length) lane.append(node('p', 'lane-empty', '暂无任务'));
        lanes.append(lane);
      }
      section.append(heading, lanes); projects.append(section);
    }
  }
  function renderCaptain() {
    const captain = sessions.find((s) => s.isMain);
    const conversation = $('captain-turns');
    const signature = JSON.stringify([captainData.turns, !!captain, !loaded && offline]);
    if (signature !== turnsSignature) {
      const follow = turnsSignature === undefined || atBottom(conversation);
      const scrollTop = conversation.scrollTop;
      turnsSignature = signature;
      conversation.replaceChildren();
      if (!loaded && offline) conversation.append(empty('暂时连不上桌面端，正在自动重连…'));
      else if (!captain && loaded) conversation.append(empty('尚未创建队长。先在桌面端创建队长。'));
      else if (!captainData.turns.length) conversation.append(empty(loaded ? '还没有对话。发一条指令，让队长开始安排。' : ''));
      for (const turn of captain ? captainData.turns : []) {
        const row = node('article', 'captain-turn');
        if (turn.id) row.dataset.turnId = turn.id;
        const images = (turn.images || []).filter((id) => imageId.test(id));
        if (images.length) {
          const strip = node('div', 'sent-images');
          images.forEach((id, i) => {
            const open = node('a', 'sent-image'), img = node('img');
            open.href = '/api/image?id=' + id; open.target = '_blank'; open.rel = 'noopener noreferrer';
            img.src = open.href; img.alt = '你发的图片 ' + (i + 1);
            // Old images are cleared from the desktop after a while.
            img.addEventListener('error', () => { open.remove(); if (!strip.childElementCount) strip.remove(); });
            open.append(img); strip.append(open);
          });
          row.append(strip);
        }
        if (turn.user) {
          const prompt = node('div', 'chat-message user-message');
          prompt.append(node('span', 'chat-label', '你'), node('p', 'chat-text', turn.user));
          row.append(prompt);
        }
        const reply = node('div', 'chat-message captain-message');
        reply.append(node('span', 'chat-label', '队长'));
        if (turn.reply) {
          reply.append(markdown(turn.reply));
          const actions = node('div', 'turn-actions');
          actions.append(iconButton('copy', '复制队长回复', (button) => copyText(button, turn.reply, '复制队长回复')));
          if (turn.interrupted) actions.append(node('span', 'turn-state', '已中断'));
          else if (!turn.done) actions.append(node('span', 'turn-state', '处理中…'));
          reply.append(actions);
        } else if (turn.interrupted || turn.done) {
          reply.append(node('p', 'chat-text turn-state', turn.interrupted ? '回复已中断。' : '本次处理已结束。'));
        } else {
          const pending = node('p', 'chat-text pending');
          const typing = node('span', 'typing'); typing.setAttribute('aria-hidden', 'true');
          typing.append(node('i'), node('i'), node('i'));
          pending.append(typing, node('span', '', '队长正在处理…'));
          reply.append(pending);
        }
        row.append(reply);
        conversation.append(row);
      }
      conversation.scrollTop = follow ? conversation.scrollHeight : scrollTop;
    }
    // Offline keeps the draft editable (flaky mobile networks) but blocks sending.
    $('message').disabled = !captain || sending;
    $('attach').disabled = !captain || sending;
    updateComposer(); updateSend();
  }
  function updateHeading() {
    const captain = sessions.find((s) => s.isMain);
    const current = view === 'output' ? sessions.find((s) => s.id === selected?.id) || selected : null;
    const heading = {
      captain: [captain?.title || '队长', captain ? [statusNames[captain.status] || '空闲', captain.model].filter(Boolean).join(' · ') : loaded ? '尚未创建' : '', captain ? captain.status : 'none'],
      output: [selected?.title || '队员输出', '只读' + (current ? ' · ' + (statusNames[current.status] || '空闲') : ''), current?.status || 'none'],
      board: ['任务看板', '只读', null],
      more: ['更多', '', null],
    }[view];
    // Statuses are stale while the desktop is unreachable; say so instead.
    if (offline && view !== 'more') { heading[1] = view === 'captain' ? '连接中断' : '只读 · 连接中断'; heading[2] = 'offline'; }
    $('view-title').textContent = heading[0];
    $('view-meta').textContent = heading[1];
    $('title-dot').hidden = !heading[2];
    $('title-dot').dataset.status = heading[2] || 'none';
    document.title = heading[0] + ' · AgentDeck';
  }
  function updateComposer() {
    const worker = view === 'output' && selected;
    $('message-form').hidden = view !== 'captain' && view !== 'output';
    $('message').placeholder = offline ? '连接中断，恢复后可发送' : worker ? '回复这位队员（由队长转达）' : '给队长发消息';
  }
  function showView(next) {
    if (view === 'output' && next !== 'output') outputRequest++;
    if (next === 'output' && view !== 'output') outputFrom = view;
    view = next;
    ['board', 'captain', 'output', 'more'].forEach((name) => { $(name + '-view').hidden = name !== view; });
    // A worker's output belongs to the sessions tab, which opens the drawer.
    tabs.forEach((tab) => { if (tab.dataset.view === (view === 'output' ? 'sessions' : view)) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); });
    $('back').hidden = view !== 'output';
    $('menu').hidden = view === 'output';
    $('refresh').hidden = view === 'more';
    $('copy').hidden = view !== 'output';
    updateHeading(); updateComposer(); renderAttention(); renderSessions(); renderSeat();
    if (view === 'captain') toBottom($('captain-turns'));
  }
  async function loadOutput(silent = false) {
    if (!selected) return;
    const request = ++outputRequest;
    const output = $('outputText');
    if (!silent) { $('copy').disabled = true; output.textContent = '正在读取输出…'; }
    try {
      const result = await api('/api/output?id=' + encodeURIComponent(selected.id));
      if (request !== outputRequest || view !== 'output') return;
      const follow = !silent || atBottom(output);
      const text = result.text || '暂无输出。';
      if (output.textContent !== text) output.textContent = text;
      $('copy').disabled = !result.text;
      if (follow) toBottom(output);
    } catch (err) {
      if (request !== outputRequest || view !== 'output') return;
      output.textContent = '未能读取输出。请刷新重试。'; notice(err.message, true);
    }
  }
  async function openOutput(session) {
    selected = session; notice(''); showView('output');
    await loadOutput();
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true; $('refresh').disabled = true; $('refresh').classList.add('refreshing');
    if (!loaded) notice('正在读取会话和看板…');
    try {
      // Quota follows the same polling; a failed quota read never blocks the rest.
      const [sessionData, taskData, captain, auth] = await Promise.all([api('/api/sessions'), api('/api/tasks'), api('/api/captain'), api('/api/auth'), quotaBusy ? null : loadQuota()]);
      sessions = sessionData.sessions; cards = taskData.cards; captainData = captain; csrfToken = auth.csrfToken; loaded = true; offline = false;
      renderSessions(); renderAttention(); renderBoard(); renderCaptain(); renderQuota(); updateHeading(); notice('');
      if (view === 'output') await loadOutput(true);
    } catch (err) {
      // fetch rejects with a TypeError when the desktop or tunnel is unreachable.
      offline = true;
      notice(err instanceof TypeError ? '暂时连不上桌面端，正在自动重连…' : err.message + ' 正在自动重试…', true);
      quotaFailed = true;
      renderSessions(); renderCaptain(); renderQuota(); updateHeading();
    }
    finally { refreshing = false; $('refresh').disabled = false; $('refresh').classList.remove('refreshing'); }
  }
  function fitComposer() {
    const message = $('message');
    message.style.height = 'auto';
    message.style.height = message.scrollHeight + 'px';
  }
  // ---- images ----
  // A picked or pasted image is shrunk on the phone, uploaded straight away
  // and sent with the next message as a server-issued id.
  const imageId = /^[a-f0-9]{32}\.(?:jpg|png|gif|webp)$/;
  const MAX_IMAGES = 6, KEEP_BYTES = 800 * 1024, MAX_EDGE = 1600, THUMB_EDGE = 160;
  let attachments = [];
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
    item.state = 'uploading'; item.progress = 0; renderAttachments();
    const request = new XMLHttpRequest();
    item.request = request;
    request.open('POST', '/api/upload');
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-CSRF-Token', csrfToken);
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      item.progress = event.loaded / event.total;
      if (item.bar) item.bar.style.width = Math.round(item.progress * 100) + '%';
    });
    const failed = (message) => { item.state = 'failed'; item.error = message; renderAttachments(); };
    request.addEventListener('load', () => {
      if (request.status === 401) { window.location.reload(); return; }
      let id;
      try { id = JSON.parse(request.responseText).id; } catch (_) { /* Reported below. */ }
      if (request.status === 200 && imageId.test(id)) { item.state = 'done'; item.id = id; renderAttachments(); }
      else failed(request.status === 413 ? '图片太大，没能上传。' : request.status === 415 ? '这种图片格式不支持。' : request.status === 507 ? '桌面端存手机图片的空间满了（最近一天传得太多），请明天再发图。' : '图片上传失败，可重试。');
    });
    request.addEventListener('error', () => failed('网络中断，图片没传上去，可重试。'));
    request.addEventListener('abort', () => {});
    request.send(item.blob);
  }
  async function addImages(files) {
    const images = [...files].filter((file) => /^image\//.test(file.type) || /\.(?:heic|heif)$/i.test(file.name));
    if (!images.length) return;
    for (const file of images) {
      try {
        const item = await prepare(file);
        // Counted after decoding, so two quick picks cannot both use the same room.
        if (attachments.length >= MAX_IMAGES) { notice('一次最多发 ' + MAX_IMAGES + ' 张图片，多出的没有添加。', true); break; }
        attachments.push(item);
        upload(item);
      } catch (_) { notice('有一张图片读不出来（这台设备不支持该格式），请换成截图、JPEG 或 PNG。', true); }
    }
    renderAttachments();
  }
  function renderAttachments() {
    const box = $('attachments'), conversation = $('captain-turns'), follow = atBottom(conversation);
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
        const retry = iconButton('refresh', '重试上传', () => upload(item));
        retry.classList.add('attachment-retry'); chip.append(retry);
      }
      const remove = iconButton('close', '移除图片', () => {
        if (item.request) item.request.abort();
        attachments = attachments.filter((other) => other !== item);
        renderAttachments();
      });
      remove.classList.add('attachment-remove'); chip.append(remove);
      box.append(chip);
    });
    const failed = attachments.find((item) => item.state === 'failed');
    if (failed) sendStatus(failed.error, true);
    else if (attachments.some((item) => item.state === 'uploading')) sendStatus('正在上传图片…', true);
    else if (/图片/.test($('send-status').textContent)) sendStatus('');
    updateSend();
    if (follow) toBottom(conversation);
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
  function updateSend() {
    const ready = attachments.every((item) => item.state === 'done');
    $('send').disabled = sending || offline || !csrfToken || !sessions.some((s) => s.isMain) || !ready || !($('message').value.trim() || attachments.length);
  }
  $('message').addEventListener('input', () => {
    const conversation = $('captain-turns'), follow = atBottom(conversation);
    if (!attachments.length) sendStatus('');
    fitComposer(); updateSend();
    if (follow) toBottom(conversation);
  });
  $('message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('message').value, images = attachments.map((item) => item.id);
    if (sending || !(text.trim() || images.length) || images.includes(undefined) || !sessions.some((s) => s.isMain)) return;
    // Workers have no direct channel; a reply from a worker's page goes to the
    // Captain with the worker named, through the same validated endpoint.
    const message = view === 'output' && selected ? '关于队员「' + selected.title + '」：\n' + text : text;
    sending = true; $('message').disabled = true; $('attach').disabled = true; updateSend(); sendStatus('正在发送…', true);
    try {
      const result = await api('/api/captain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(images.length ? { message, images } : { message }) });
      if (!result.queued) throw new Error('消息未加入队列，请重试。');
      $('message').value = ''; fitComposer(); attachments = []; renderAttachments();
      sendStatus(view === 'output' ? '已转给队长，等待处理。' : '已排队，等待队长处理。');
      refresh();
    } catch (err) { sendStatus(err.message + ' 消息已保留，可重试。', true); }
    finally { sending = false; renderCaptain(); }
  });
  $('copy').addEventListener('click', () => copyText($('copy'), $('outputText').textContent, '复制输出'));
  $('refresh').addEventListener('click', refresh);
  $('back').addEventListener('click', () => showView(outputFrom));
  tabs.forEach((tab) => tab.addEventListener('click', () => tab.dataset.view === 'sessions' ? openDrawer() : showView(tab.dataset.view)));
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    try { await api('/logout', { method: 'POST' }); window.location.reload(); }
    catch (err) { notice(err.message, true); $('logout').disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  showView('captain');
  refresh();
})();
