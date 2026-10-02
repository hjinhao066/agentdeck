// Full-width pages that slide over the deck: Schedule (prompts sent to a
// session at set times) and Artifacts (files and links the agents mentioned).
// The deck stays mounted underneath, so terminals keep their size and status.
(function () {
  'use strict';
  const SC = window.ScheduleCore;
  const C = window.ChatCore;
  let host = null;
  let view = null;
  let current = null;
  let artifactFilter = { type: 'all', q: '' };
  let editing = null;               // schedule being edited, or null for a new one
  let sdKind = 'daily';
  const waiting = new Map();        // schedule id -> when it first found its session busy

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name, cls) {
    const s = el('span', 'ico' + (cls ? ' ' + cls : ''));
    s.innerHTML = host.ICONS[name] || '';
    return s;
  }
  function btn(label, onClick, cls) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  const schedules = () => host.config.schedules;

  // ---- page frame ----
  function show(name) {
    current = name;
    view.hidden = false;
    render();
    window.Sidebar.markPage(name);
  }
  function hide() {
    if (!current) return;
    current = null;
    view.hidden = true;
    view.textContent = '';
    window.Sidebar.markPage(null);
  }
  function toggle(name) { if (current === name) hide(); else show(name); }
  function render() {
    if (current === 'schedule') renderSchedule();
    else if (current === 'artifacts') renderArtifacts();
    else if (current === 'skills') window.SkillsPage.render(frame, host);
  }
  function frame(title, subtitle, actions) {
    view.textContent = '';
    const page = el('div', 'page');
    const head = el('header', 'page-head');
    const titles = el('div', 'page-titles');
    titles.append(el('h1', null, title), el('p', null, subtitle));
    const right = el('div', 'page-actions');
    (actions || []).forEach((a) => right.appendChild(a));
    const close = el('button', 'page-close');
    close.type = 'button'; close.title = '关闭 (Esc)'; close.innerHTML = host.ICONS.close;
    close.addEventListener('click', hide);
    right.appendChild(close);
    head.append(titles, right);
    const body = el('div', 'page-body');
    page.append(head, body);
    view.appendChild(page);
    return body;
  }

  // ---- Schedule ----
  function targetLabel(s) {
    if (s.target === 'new') return '新对话 · ' + ({ claude: 'Claude', agy: 'Antigravity', cursor: 'Cursor CLI', grok: 'Grok', shell: '普通终端' }[s.agent] || 'Claude');
    const col = host.columns().find((c) => c.id === s.target);
    if (col) return host.columnLabel(col);
    const arch = host.archived().find((a) => a.id === s.target);
    if (arch) return host.columnLabel(arch) + '（已归档）';
    return '已删除的对话';
  }
  const STATUS = { ok: '已发送', missed: '错过（当时没开）', skipped: '跳过（对话一直在忙）', error: '没发出去' };

  function renderSchedule() {
    const body = frame('Schedule', '到点自动把提示词发给某个对话，和你自己在输入框里发送一样。只在 AgentDeck 开着时运行。',
      [btn('新建定时任务', () => openEditor(null), 'primary')]);
    const list = schedules();
    if (!list.length) {
      const empty = el('div', 'page-empty');
      empty.append(icon('clock', 'page-empty-ico'), el('strong', null, '还没有定时任务'),
        el('span', null, '比如：每个工作日早上 9 点，让 Claude 把昨天的提交整理成日报。'),
        btn('新建定时任务', () => openEditor(null), 'primary'));
      body.appendChild(empty);
      return;
    }
    const now = Date.now();
    const box = el('div', 'sched-list');
    list.forEach((s) => {
      const card = el('div', 'sched-card' + (s.enabled ? '' : ' off'));
      card.dataset.scheduleId = s.id;
      const sw = el('button', 'switch' + (s.enabled ? ' on' : ''));
      sw.type = 'button'; sw.title = s.enabled ? '暂停' : '启用';
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(s.enabled));
      sw.addEventListener('click', () => setEnabled(s.id, !s.enabled));
      const main = el('div', 'sched-main');
      main.appendChild(el('div', 'sched-name', s.name || s.prompt.split('\n')[0].slice(0, 80)));
      const rest = s.name ? s.prompt : s.prompt.split('\n').slice(1).join(' ');
      if (rest.trim()) main.appendChild(el('div', 'sched-prompt', rest.replace(/\s+/g, ' ')));
      const meta = el('div', 'sched-meta');
      meta.append(chip('clock', SC.describe(s, now)), chip('send', targetLabel(s)));
      if (s.enabled && s.nextAt) meta.appendChild(chip(null, '下次 ' + SC.formatWhen(s.nextAt, now)));
      if (s.lastRunAt) {
        const last = chip(null, '上次 ' + SC.formatWhen(s.lastRunAt, now) + ' · ' + (STATUS[s.lastStatus] || ''));
        last.classList.add('st-' + (s.lastStatus || 'none'));
        if (s.lastNote) last.title = s.lastNote;
        meta.appendChild(last);
      }
      main.appendChild(meta);
      const actions = el('div', 'sched-actions');
      actions.append(btn('立即运行', () => runManually(s.id)), btn('编辑', () => openEditor(s)));
      card.append(sw, main, actions);
      box.appendChild(card);
    });
    body.appendChild(box);
  }
  function chip(iconName, text) {
    const c = el('span', 'chip');
    if (iconName) c.appendChild(icon(iconName));
    c.appendChild(el('span', null, text));
    return c;
  }
  function update(id, fn) {
    host.config.schedules = schedules().map((s) => (s.id === id ? fn(s) : s));
    host.saveConfig();
    if (current === 'schedule') render();
  }
  function setEnabled(id, on) {
    update(id, (s) => {
      const next = SC.arm({ ...s, enabled: on }, Date.now());
      if (on && !next.enabled) host.showToast('这个一次性任务的时间已经过了，请编辑一个新时间');
      return next;
    });
  }

  // Sends the prompt; returns { status: ok|busy|error, note }.
  function runSchedule(s, manual) {
    const prompt = s.prompt;
    if (s.target === 'new') {
      const col = host.createSession({
        title: s.name || prompt.split('\n')[0].slice(0, 24),
        cmd: window.BoardCore.commandForAgent(s.agent === 'shell' ? 'shell' : s.agent),
        cwd: s.cwd,
      }, !manual);
      host.sendWhenReady(col, prompt, { allowShell: true });
      return { status: 'ok', note: '开了新对话「' + host.columnLabel(col) + '」' };
    }
    let col = host.columns().find((c) => c.id === s.target);
    if (!col && host.archived().some((a) => a.id === s.target)) {
      col = host.restoreArchived(s.target, manual);
      if (!col) return { status: 'error', note: '恢复归档对话失败' };
      host.sendWhenReady(col, prompt, { allowShell: true });
      return { status: 'ok', note: '恢复了归档的对话再发送' };
    }
    if (!col) return { status: 'error', note: '目标对话已经删掉了' };
    const entry = host.terms.get(col.id);
    if (!entry) { host.sendWhenReady(col, prompt, { allowShell: true }); return { status: 'ok', note: '' }; }
    if (!entry.alive) return { status: 'error', note: '这个对话的终端已经退出了' };
    if (entry.state === 'working' || entry.state === 'input') return { status: 'busy', note: '' };
    host.sendWhenReady(col, prompt, { allowShell: true });
    return { status: 'ok', note: '' };
  }
  function runManually(id) {
    const s = schedules().find((x) => x.id === id);
    if (!s) return;
    const r = runSchedule(s, true);
    if (r.status === 'busy') { host.showToast('这个对话正在忙，等它停下来再试'); return; }
    if (r.status === 'error') host.showToast(r.note);
    update(id, (x) => ({ ...x, lastRunAt: Date.now(), lastStatus: r.status, lastNote: r.note }));
    if (r.status === 'ok') { hide(); }
  }

  function tick(startup) {
    const now = Date.now();
    let changed = false;
    host.config.schedules = schedules().map((s) => {
      const act = SC.dueAction(s, now, startup);
      if (!act) return s;
      if (act === 'missed') { changed = true; return SC.settle(s, now, 'missed', 'AgentDeck 当时没开'); }
      let r;
      try { r = runSchedule(s, false); } catch (e) { r = { status: 'error', note: String(e && e.message || e) }; }
      if (r.status === 'busy') {
        const since = waiting.get(s.id) || now;
        waiting.set(s.id, since);
        if (now - since < SC.BUSY_LIMIT) return s;
        r = { status: 'skipped', note: '目标对话 30 分钟内一直在忙' };
      }
      waiting.delete(s.id);
      changed = true;
      return SC.settle(s, now, r.status, r.note);
    });
    if (changed) {
      host.saveConfig();
      if (current === 'schedule') render();
    }
  }

  // ---- schedule editor dialog ----
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const DAY_NAME = ['日', '一', '二', '三', '四', '五', '六'];
  function pad(n) { return String(n).padStart(2, '0'); }
  function toLocalInput(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function setKind(kind) {
    sdKind = kind;
    document.querySelectorAll('#scheduleDialog .sd-kind').forEach((b) => {
      b.classList.toggle('active', b.dataset.kind === kind);
      b.setAttribute('aria-checked', String(b.dataset.kind === kind));
    });
    document.querySelectorAll('#scheduleDialog .sd-when').forEach((w) => { w.hidden = w.dataset.kind !== kind; });
  }
  function syncTargetOpts() { $('sdNewOpts').hidden = $('sdTarget').value !== 'new'; }
  function openEditor(s) {
    editing = s;
    const now = Date.now();
    const d = $('scheduleDialog');
    $('sdTitle').textContent = s ? '编辑定时任务' : '新建定时任务';
    $('sdPrompt').value = s ? s.prompt : '';
    $('sdName').value = s ? s.name : '';
    const target = $('sdTarget');
    target.textContent = '';
    const add = (value, label) => { const o = el('option', null, label); o.value = value; target.appendChild(o); };
    add('new', '每次新开一个对话');
    host.columns().forEach((c) => add(c.id, host.columnLabel(c)));
    if (s && s.target !== 'new' && !host.columns().some((c) => c.id === s.target)) add(s.target, targetLabel(s));
    target.value = s ? s.target : (host.focusedId() && host.columns().some((c) => c.id === host.focusedId()) ? host.focusedId() : 'new');
    $('sdAgent').value = s ? s.agent : 'claude';
    $('sdCwd').value = s ? s.cwd : '';
    syncTargetOpts();
    const base = Math.ceil((now + 3600_000) / 300_000) * 300_000;
    $('sdAt').value = toLocalInput(s && s.at ? s.at : base);
    $('sdTime').value = s ? s.time : '09:00';
    const days = new Set(s ? s.days : [1, 2, 3, 4, 5]);
    const dayBox = $('sdDays');
    dayBox.textContent = '';
    DAY_ORDER.forEach((day) => {
      const b = el('button', 'sd-day' + (days.has(day) ? ' on' : ''), DAY_NAME[day]);
      b.type = 'button'; b.dataset.day = String(day);
      b.addEventListener('click', () => b.classList.toggle('on'));
      dayBox.appendChild(b);
    });
    const every = s ? s.every : 60;
    $('sdUnit').value = every % 60 === 0 ? '60' : '1';
    $('sdEvery').value = String(every % 60 === 0 ? every / 60 : every);
    $('sdEnabled').checked = s ? s.enabled || s.kind !== 'once' : true;
    $('sdDelete').hidden = !s;
    $('sdError').hidden = true;
    setKind(s ? s.kind : 'daily');
    d.showModal();
    setTimeout(() => $('sdPrompt').focus(), 50);
  }
  function saveEditor() {
    const now = Date.now();
    const days = [...document.querySelectorAll('#sdDays .sd-day.on')].map((b) => Number(b.dataset.day));
    const raw = {
      ...(editing || { createdAt: now }),
      name: $('sdName').value,
      prompt: $('sdPrompt').value,
      target: $('sdTarget').value,
      agent: $('sdAgent').value,
      cwd: $('sdCwd').value,
      kind: sdKind,
      at: new Date($('sdAt').value).getTime(),
      time: $('sdTime').value,
      days,
      every: Math.round(Number($('sdEvery').value) * Number($('sdUnit').value)),
      enabled: $('sdEnabled').checked,
    };
    const s = SC.normalizeSchedule(raw);
    if (sdKind === 'daily' && !days.length) s.days = [];
    const problem = SC.validate(s, now);
    if (problem && (s.enabled || !s.prompt.trim())) {
      $('sdError').textContent = problem;
      $('sdError').hidden = false;
      return;
    }
    const armed = SC.arm(s, now);
    const list = schedules();
    const at = list.findIndex((x) => x.id === armed.id);
    if (at >= 0) list[at] = armed; else list.push(armed);
    host.saveConfig();
    $('scheduleDialog').close();
    if (current !== 'schedule') show('schedule'); else render();
  }
  function initEditor() {
    document.querySelectorAll('#scheduleDialog .sd-kind').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
    $('sdTarget').addEventListener('change', syncTargetOpts);
    $('sdCancel').addEventListener('click', () => $('scheduleDialog').close());
    $('sdSave').addEventListener('click', saveEditor);
    $('sdDelete').addEventListener('click', () => {
      if (!editing || !confirm('删除这个定时任务？')) return;
      host.config.schedules = schedules().filter((x) => x.id !== editing.id);
      host.saveConfig();
      $('scheduleDialog').close();
      render();
    });
    $('scheduleDialog').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEditor(); }
    });
  }

  // ---- Artifacts ----
  const TYPE_LABEL = { web: '网页', markdown: 'MD', pdf: 'PDF', image: '图片', text: '' };
  function artifactTile(a) {
    const tile = el('div', 'art-tile t-' + a.type);
    if (a.type === 'web') tile.appendChild(icon('globe'));
    else if (a.type === 'image') tile.appendChild(icon('image'));
    else {
      const ext = C.extOf(a.name).toUpperCase();
      tile.appendChild(el('span', 'art-ext', a.type === 'pdf' ? 'PDF' : a.type === 'markdown' ? 'MD' : (ext || '').slice(0, 4) || '▤'));
    }
    return tile;
  }
  function renderArtifacts() {
    const all = C.collectArtifacts(window.ChatUI.artifactSources(), host.findLinks);
    const body = frame('Artifacts', 'agent 在回复里提到的文件和链接都收在这里。点一下在右侧预览，⌘ 点击用系统应用打开。');
    const bar = el('div', 'art-bar');
    const counts = { all: all.length, file: all.filter((a) => a.kind === 'file').length, web: all.filter((a) => a.kind === 'url').length };
    [['all', '全部'], ['file', '文件'], ['web', '网页']].forEach(([key, label]) => {
      const b = el('button', 'seg-btn' + (artifactFilter.type === key ? ' active' : ''));
      b.type = 'button';
      b.append(el('span', null, label), el('span', 'seg-count', String(counts[key])));
      b.addEventListener('click', () => { artifactFilter.type = key; render(); });
      bar.appendChild(b);
    });
    bar.appendChild(el('span', 'tb-spacer'));
    const search = el('input', 'art-search');
    search.type = 'text'; search.placeholder = '筛选文件名、路径或对话'; search.value = artifactFilter.q; search.spellcheck = false;
    search.addEventListener('input', () => { artifactFilter.q = search.value; fill(); });
    search.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    bar.appendChild(search);
    body.appendChild(bar);
    const grid = el('div', 'art-grid');
    body.appendChild(grid);
    function fill() {
      grid.textContent = '';
      const q = artifactFilter.q.trim().toLowerCase();
      const shown = all.filter((a) => (artifactFilter.type === 'all' || (artifactFilter.type === 'file' ? a.kind === 'file' : a.kind === 'url')) &&
        (!q || (a.name + ' ' + a.text + ' ' + a.title).toLowerCase().includes(q)));
      if (!shown.length) {
        const empty = el('div', 'page-empty');
        empty.append(icon('artifacts', 'page-empty-ico'), el('strong', null, all.length ? '没有匹配的产物' : '还没有产物'),
          el('span', null, all.length ? '换个关键词试试。' : 'agent 回复里出现文件路径或网址时，会自动收集到这里。'));
        grid.appendChild(empty);
        return;
      }
      const now = Date.now();
      shown.forEach((a) => {
        const card = el('div', 'art-card');
        card.tabIndex = 0;
        card.dataset.kind = a.kind;
        card.title = a.text;
        const text = el('div', 'art-text');
        // LRM marks keep a right-to-left (ellipsis on the left) path in order
        text.append(el('div', 'art-name', a.name), el('div', 'art-path', '\u200e' + a.text + '\u200e'));
        const foot = el('div', 'art-foot');
        foot.append(el('span', 'art-session', a.title + (a.archived ? '（已归档）' : '')), el('span', 'art-time', SC.formatWhen(a.ts, now)));
        const jump = el('button', 'art-jump', '跳到对话');
        jump.type = 'button';
        jump.addEventListener('click', (e) => { e.stopPropagation(); hide(); window.ChatUI.reveal(a.colId, a.turnId, 'reply'); });
        foot.appendChild(jump);
        card.append(artifactTile(a), text, foot);
        const open = (e) => window.SidePane.openLink({ kind: a.kind, text: a.text }, e, a.colId);
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
        grid.appendChild(card);
      });
    }
    fill();
  }

  function init(h) {
    host = h;
    view = $('pageView');
    host.config.schedules = SC.normalizeSchedules(host.config.schedules);
    initEditor();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && current && !document.querySelector('dialog[open]') && !document.querySelector('.ctx-menu')) {
        e.preventDefault();
        hide();
      }
    });
    // Give the terminals a moment to come up before sending anything.
    setTimeout(() => {
      tick(true);
      setInterval(() => tick(false), 15_000);
    }, 4000);
  }

  window.Pages = {
    init, show, hide, toggle, render, openEditor, tick,
    current: () => current,
    refresh: () => { if (current === 'artifacts') render(); },
  };
})();
