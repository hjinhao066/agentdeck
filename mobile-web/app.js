'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const icons = {
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20.8 13a9 9 0 0 1-9.8-9.8A9 9 0 1 0 20.8 13Z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    send: '<path d="m21 3-6.5 18-4-7.5L3 9.5 21 3Z"/><path d="m10.5 13.5 5-5"/>',
    logout: '<path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h12"/>',
    back: '<path d="m14 6-6 6 6 6M8 12h12"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    sessions: '<rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="16" rx="2"/>',
    board: '<path d="M4 4v16M12 4v16M20 4v16M4 8h4m4 5h4m4-5h2"/>',
    captain: '<path d="M5 6h14v11H9l-4 4V6Z"/><path d="M9 10h6m-6 3h4"/>',
  };
  const svg = (name) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
  const statusNames = { working: '干活中', idle: '空闲', failed: '失败', input: '停在确认', quota: '额度用尽/等待', queued: '待补充', waiting: '排队', asking: '在问你', done: '完成' };
  const taskStatuses = [['todo', '待办'], ['doing', '进行中'], ['review', '待验收'], ['needs_user', '等用户'], ['done', '完成']];
  const flagNames = { failed: '失败', blocked: '前置未完成', held: '挂起' };
  let sessions = [], cards = [], captainData = { turns: [] }, view = 'captain', selected = null, refreshing = false, sending = false, loaded = false, csrfToken = '';
  let sessionsSignature, boardSignature, turnsSignature;
  let outputRequest = 0, copyTimer;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let savedTheme;
  try { savedTheme = localStorage.getItem('agentdeck-mobile-theme'); } catch (_) { /* Storage can be unavailable in private browsers. */ }
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const label = theme === 'dark' ? '切换浅色主题' : '切换深色主题';
    $('theme').title = label;
    $('theme').innerHTML = svg(theme === 'dark' ? 'sun' : 'moon');
  }
  applyTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : systemTheme.matches ? 'dark' : 'light');
  systemTheme.addEventListener('change', () => { if (!savedTheme) applyTheme(systemTheme.matches ? 'dark' : 'light'); });
  $('theme').addEventListener('click', () => {
    savedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(savedTheme);
    try { localStorage.setItem('agentdeck-mobile-theme', savedTheme); } catch (_) { /* Keep the choice for this page. */ }
  });
  ['refresh', 'copy', 'send', 'back', 'logout'].forEach((name) => { $(name).innerHTML = svg(name); });
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.querySelector('.nav-icon').innerHTML = svg(button.dataset.view);
    button.addEventListener('click', () => showView(button.dataset.view));
  });
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').hidden = !message;
    $('notice').classList.toggle('error', error);
  }
  async function api(url, options) {
    if (options?.method === 'POST') options = { ...options, headers: { ...options.headers, 'X-CSRF-Token': csrfToken } };
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    if (response.status === 401) { window.location.reload(); throw new Error('登录已过期。'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败，请稍后刷新。');
    return result;
  }
  function statusBadge(status) {
    const el = node('span', 'status ' + status);
    el.append(node('span', 'status-dot'), node('span', '', statusNames[status] || '空闲'));
    return el;
  }
  function empty(message) { return node('p', 'empty', message); }
  function renderSessions() {
    const signature = JSON.stringify(sessions);
    if (signature === sessionsSignature) return;
    sessionsSignature = signature;
    const list = $('sessions'); list.replaceChildren();
    if (!sessions.length) { list.append(empty('暂无会话。先在桌面端创建队长或队员。')); return; }
    const ordered = [...sessions.filter((s) => s.isMain), ...sessions.filter((s) => !s.isMain && s.status === 'working'), ...sessions.filter((s) => !s.isMain && s.status !== 'working')];
    for (const session of ordered) {
      const button = node('button', 'session-card' + (session.isMain ? ' is-captain' : ''));
      button.type = 'button'; button.dataset.sessionId = session.id;
      button.setAttribute('aria-label', session.title);
      const top = node('div', 'session-top');
      top.append(node('span', 'session-role', session.isMain ? '队长' : '队员'), statusBadge(session.status));
      const heading = node('div', 'session-heading');
      const arrow = node('span', 'session-arrow'); arrow.innerHTML = svg('chevron');
      heading.append(node('h2', '', session.title), arrow);
      button.append(top, heading, node('p', 'session-model', session.model || '模型未识别'));
      const receipt = node('div', 'receipt');
      receipt.append(node('span', 'receipt-label', '最近回执'), node('p', '', session.receipt || '尚未提交回执'));
      button.append(receipt);
      button.addEventListener('click', () => session.isMain ? showView('captain') : openOutput(session));
      list.append(button);
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
        const lane = node('section', 'board-lane'); lane.dataset.status = status;
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
    const target = $('captain-target'); target.replaceChildren();
    const captain = sessions.find((s) => s.isMain);
    if (captain) {
      const heading = node('div', 'captain-top'); heading.append(node('span', 'session-role', '队长'), statusBadge(captain.status));
      target.append(heading, node('h2', '', captain.title), node('p', 'session-model', captain.model || '模型未识别'));
    } else target.append(empty('尚未创建队长。先在桌面端创建队长。'));
    const conversation = $('captain-turns');
    const signature = JSON.stringify(captainData.turns);
    if (signature !== turnsSignature) {
      const follow = turnsSignature === undefined || conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48;
      const scrollTop = conversation.scrollTop;
      turnsSignature = signature;
      conversation.replaceChildren();
      if (!captainData.turns.length) conversation.append(empty('还没有对话。发一条指令，让队长开始安排。'));
      for (const turn of captainData.turns) {
        const row = node('article', 'captain-turn');
        if (turn.id) row.dataset.turnId = turn.id;
        if (turn.user) {
          const prompt = node('div', 'chat-message user-message');
          prompt.append(node('span', 'chat-label', '你'), node('p', 'chat-text', turn.user));
          row.append(prompt);
        }
        const reply = node('div', 'chat-message captain-message');
        reply.append(node('span', 'chat-label', '队长'), node('p', 'chat-text', turn.reply || (turn.interrupted ? '回复已中断。' : turn.done ? '本次处理已结束。' : '队长正在处理…')));
        if (turn.interrupted) reply.append(node('span', 'turn-state', '已中断'));
        else if (!turn.done) reply.append(node('span', 'turn-state', '处理中'));
        row.append(reply);
        conversation.append(row);
      }
      conversation.scrollTop = follow ? conversation.scrollHeight : scrollTop;
    }
    $('message').disabled = !captain || sending;
    updateSend();
  }
  function updateHeading() {
    const titles = { sessions: ['会话', '队长与队员'], board: ['任务看板', '项目进度'], captain: ['队长', '交给队长处理'], output: ['队员输出', selected?.title || '最新输出'] };
    $('eyebrow').textContent = titles[view][0]; $('view-title').textContent = titles[view][1];
    $('view-meta').textContent = view === 'sessions' ? sessions.filter((s) => s.status === 'working').length + ' 个干活中' : view === 'board' ? '只读' : '';
  }
  function showView(next) {
    if (view === 'output' && next !== 'output') outputRequest++;
    view = next;
    ['sessions', 'board', 'captain', 'output'].forEach((name) => { $(name + '-view').hidden = name !== view; });
    document.querySelectorAll('[data-view]').forEach((button) => {
      if (button.dataset.view === (view === 'output' ? 'sessions' : view)) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('back').hidden = view !== 'output';
    updateHeading(); window.scrollTo(0, 0);
  }
  async function loadOutput(silent = false) {
    if (!selected) return;
    const request = ++outputRequest;
    if (!silent) { $('copy').disabled = true; $('outputText').textContent = '正在读取输出…'; }
    try {
      const result = await api('/api/output?id=' + encodeURIComponent(selected.id));
      if (request !== outputRequest || view !== 'output') return;
      $('outputText').textContent = result.text || '暂无输出。';
      $('copy').disabled = !result.text;
    } catch (err) {
      if (request !== outputRequest || view !== 'output') return;
      $('outputText').textContent = '未能读取输出。请刷新重试。'; notice(err.message, true);
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
      sessions = sessionData.sessions; cards = taskData.cards; captainData = captain; csrfToken = auth.csrfToken; loaded = true;
      renderSessions(); renderBoard(); renderCaptain(); updateHeading(); notice('');
      if (view === 'output') await loadOutput(true);
    } catch (err) { notice(err.message + ' 点击右上角刷新重试。', true); }
    finally { refreshing = false; $('refresh').disabled = false; $('refresh').classList.remove('refreshing'); }
  }
  function updateSend() { $('send').disabled = sending || !csrfToken || !sessions.some((s) => s.isMain) || !$('message').value.trim(); }
  $('message').addEventListener('input', () => { $('send-status').textContent = ''; updateSend(); });
  $('message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('message').value;
    if (sending || !message.trim() || !sessions.some((s) => s.isMain)) return;
    sending = true; $('message').disabled = true; updateSend(); $('send-status').textContent = '正在发送…';
    try {
      const result = await api('/api/captain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
      if (!result.queued) throw new Error('消息未加入队列，请重试。');
      $('message').value = ''; $('send-status').textContent = '已排队，等待队长处理。';
      refresh();
    } catch (err) { $('send-status').textContent = err.message + ' 消息已保留，可重试。'; }
    finally { sending = false; renderCaptain(); }
  });
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('outputText').textContent);
      $('copy').innerHTML = svg('check'); $('copy').title = '已复制'; $('copy').setAttribute('aria-label', '已复制');
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { $('copy').innerHTML = svg('copy'); $('copy').title = '复制输出'; $('copy').setAttribute('aria-label', '复制输出'); }, 1600);
    } catch (_) { notice('无法复制。可长按输出文字手动选择。', true); }
  });
  $('refresh').addEventListener('click', refresh);
  $('back').addEventListener('click', () => showView('sessions'));
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    try { await api('/logout', { method: 'POST' }); window.location.reload(); }
    catch (err) { notice(err.message, true); $('logout').disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  refresh();
})();
