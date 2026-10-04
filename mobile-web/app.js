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
  };
  const svg = (name) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
  const statusNames = { working: '干活中', idle: '空闲', failed: '失败', input: '停在确认', quota: '额度用尽/等待', queued: '待补充', waiting: '排队', asking: '在问你', done: '完成' };
  const needsUser = new Set(['input', 'asking']);
  const taskStatuses = [['todo', '待办'], ['doing', '进行中'], ['review', '待验收'], ['needs_user', '等用户'], ['done', '完成']];
  const flagNames = { failed: '失败', blocked: '前置未完成', held: '挂起' };
  let sessions = [], cards = [], captainData = { turns: [] }, view = 'captain', outputFrom = 'sessions', selected = null, refreshing = false, sending = false, loaded = false, offline = false, csrfToken = '';
  let sessionsSignature, boardSignature, turnsSignature, attentionSignature;
  let outputRequest = 0, statusTimer;
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

  function renderSessions() {
    const workers = sessions.filter((s) => !s.isMain);
    const waiting = workers.filter((s) => needsUser.has(s.status)).length;
    const signature = JSON.stringify([workers, loaded]);
    if (signature === sessionsSignature) return;
    sessionsSignature = signature;
    // The tab badge counts the sessions that are waiting on the user.
    const badge = $('sessions-badge'), tab = badge.closest('.tab');
    badge.hidden = !waiting; badge.textContent = waiting > 9 ? '9+' : String(waiting);
    tab.setAttribute('aria-label', waiting ? '会话，' + waiting + ' 个等你处理' : '会话');
    const list = $('sessions'); list.replaceChildren();
    if (!workers.length) { list.append(empty(loaded ? '暂无队员会话。队长派活后会显示在这里。' : '')); return; }
    const rank = (s) => needsUser.has(s.status) ? 0 : s.status === 'working' ? 1 : 2;
    for (const session of [...workers].sort((a, b) => rank(a) - rank(b))) {
      const button = node('button', 'session-row');
      button.type = 'button'; button.dataset.sessionId = session.id;
      button.setAttribute('aria-label', session.title);
      const main = node('span', 'row-main');
      main.append(node('span', 'row-title', session.title), node('span', 'row-sub', session.receipt || session.model || '尚未提交回执'));
      const tag = node('span', 'row-tag' + (needsUser.has(session.status) ? ' alert' : session.status === 'failed' ? ' failed' : ''), statusNames[session.status] || '空闲');
      button.append(dot(session.status), main, tag);
      button.addEventListener('click', () => openOutput(session));
      list.append(button);
    }
  }
  function renderAttention() {
    // The sessions page already lists them, and settings need no reminder.
    const waiting = view === 'sessions' || view === 'more' ? [] : sessions.filter((s) => needsUser.has(s.status) && !(view === 'output' && s.id === selected?.id));
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
    const workers = sessions.filter((s) => !s.isMain);
    const counts = [[workers.filter((s) => s.status === 'working').length, ' 个干活中'], [workers.filter((s) => needsUser.has(s.status)).length, ' 个等你处理']];
    const heading = {
      captain: [captain?.title || '队长', captain ? [statusNames[captain.status] || '空闲', captain.model].filter(Boolean).join(' · ') : loaded ? '尚未创建' : '', captain ? captain.status : 'none'],
      output: [selected?.title || '队员输出', '只读' + (current ? ' · ' + (statusNames[current.status] || '空闲') : ''), current?.status || 'none'],
      sessions: ['会话', counts.filter(([count]) => count).map(([count, label]) => count + label).join(' · ') || (workers.length ? workers.length + ' 个会话' : ''), null],
      board: ['任务看板', '只读', null],
      more: ['更多', '', null],
    }[view];
    // Statuses are stale while the desktop is unreachable; say so instead.
    if (offline && view !== 'more') { heading[1] = view === 'captain' || view === 'sessions' ? '连接中断' : '只读 · 连接中断'; heading[2] = 'offline'; }
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
    ['board', 'captain', 'sessions', 'output', 'more'].forEach((name) => { $(name + '-view').hidden = name !== view; });
    // A worker's output is a page inside the sessions tab.
    tabs.forEach((tab) => { if (tab.dataset.view === (view === 'output' ? 'sessions' : view)) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); });
    $('back').hidden = view !== 'output';
    $('refresh').hidden = view === 'more';
    $('copy').hidden = view !== 'output';
    updateHeading(); updateComposer(); renderAttention();
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
      const [sessionData, taskData, captain, auth] = await Promise.all([api('/api/sessions'), api('/api/tasks'), api('/api/captain'), api('/api/auth')]);
      sessions = sessionData.sessions; cards = taskData.cards; captainData = captain; csrfToken = auth.csrfToken; loaded = true; offline = false;
      renderSessions(); renderAttention(); renderBoard(); renderCaptain(); updateHeading(); notice('');
      if (view === 'output') await loadOutput(true);
    } catch (err) {
      // fetch rejects with a TypeError when the desktop or tunnel is unreachable.
      offline = true;
      notice(err instanceof TypeError ? '暂时连不上桌面端，正在自动重连…' : err.message + ' 正在自动重试…', true);
      renderSessions(); renderCaptain(); updateHeading();
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
  tabs.forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
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
