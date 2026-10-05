// Full-width pages that slide over the deck: Schedule (prompts sent to a
// session at set times) and Artifacts (files the crew delivered with their
// receipts, plus files and links the agents mentioned).
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
    recheckDisk = null; shownTab = null;
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
    close.setAttribute('aria-label', close.title);
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
      const edit = btn('', () => openEditor(s), 'tool-action');
      edit.title = '编辑定时任务'; edit.setAttribute('aria-label', edit.title); edit.innerHTML = host.ICONS.edit;
      actions.append(btn('立即运行', () => runManually(s.id)), edit);
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
  // Two sources, two tabs: the files the crew handed in with their receipts
  // (grouped by project), and whatever the agents mentioned in their replies.
  const TYPE_LABEL = { web: '网页', markdown: 'MD', pdf: 'PDF', image: '图片', text: '' };
  const GROUP_ROWS = 30;            // rows a project shows before 「显示其余」
  let artifactTab = null;           // the tab the user picked; null: whichever has something
  let shownTab = null;              // the tab on screen while the page is open
  let shownList = '';
  const onDisk = new Map();         // path key -> 0 gone, 1 file, 2 folder (absent: not checked yet)
  const shownAll = new Set();       // projects showing every row
  let diskRun = 0;
  let recheckDisk = null;
  const collapsed = () => host.config.artifactsCollapsed || [];

  function artifactTile(a) {
    const tile = el('div', 'art-tile t-' + a.type);
    if (a.type === 'web') tile.appendChild(icon('globe'));
    else if (a.type === 'image') tile.appendChild(icon('image'));
    else if (a.type === 'dir') tile.appendChild(icon('folder'));
    else {
      const ext = C.extOf(a.name).toUpperCase();
      tile.appendChild(el('span', 'art-ext', a.type === 'pdf' ? 'PDF' : a.type === 'markdown' ? 'MD' : (ext || '').slice(0, 4) || '▤'));
    }
    return tile;
  }
  // Icon-only actions: the title is both the tooltip and the accessible name.
  function toolButton(iconName, title, onClick) {
    const b = el('button', 'icon-btn art-tool');
    b.type = 'button'; b.title = title; b.innerHTML = host.ICONS[iconName] || '';
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e, b); });
    return b;
  }
  function copyButton(title, text) {
    return toolButton('copy', title, (_e, b) => {
      try { host.clipboardWrite(text); } catch (_) { host.showToast('没能复制到剪贴板'); return; }
      b.innerHTML = host.ICONS.check; b.classList.add('done');
      b.title = '已复制'; b.setAttribute('aria-label', '已复制');
      clearTimeout(b.checkTimer);
      b.checkTimer = setTimeout(() => {
        b.innerHTML = host.ICONS.copy; b.classList.remove('done');
        b.title = title; b.setAttribute('aria-label', title);
      }, 1200);
    });
  }
  const revealTitle = () => (host.platform === 'darwin' ? '在访达中显示' : host.platform === 'win32' ? '在资源管理器中显示' : '在文件管理器中显示');
  const modKey = () => (host.platform === 'darwin' ? '⌘' : 'Ctrl');
  // shown, never copied: a path under the home folder reads better as ~/…
  const shortPath = (p) => (host.home && p.startsWith(host.home) && /^[\\/]/.test(p.slice(host.home.length)) ? '~' + p.slice(host.home.length) : p);
  // A refresh rebuilds the page: whatever had the keyboard focus gets it back.
  function keepingFocus(build) {
    const at = document.activeElement && view.contains(document.activeElement) ? document.activeElement.dataset.fk : '';
    build();
    const next = at && [...view.querySelectorAll('[data-fk]')].find((n) => n.dataset.fk === at);
    if (next) next.focus();
  }

  function deliverySources() {
    const session = (c, archived) => ({ id: c.id, title: host.columnLabel(c), project: c.project, archived, lastReceipt: c.lastReceipt });
    const main = host.config.mainSession;
    return {
      sessions: [...host.columns().map((c) => session(c, false)), ...host.archived().map((a) => session(a, true))],
      tasks: main && Array.isArray(main.tasks) ? main.tasks : [],
      chats: [...window.ChatUI.artifactSources(), ...window.ChatUI.captainArchives()],
    };
  }

  // quiet: a refresh from the deck (a turn ended, a card changed). The page is
  // rebuilt only when what it lists has changed.
  function renderArtifacts(quiet) {
    const mentions = C.collectArtifacts(window.ChatUI.artifactSources(), host.findLinks);
    const delivered = C.collectDeliveries(C.deliveryReceipts(deliverySources()), host.home);
    // chosen once per visit: a receipt arriving must not switch tabs under the reader
    const tab = artifactTab || shownTab || (delivered.total ? 'delivered' : 'mentioned');
    const listed = JSON.stringify([tab, delivered, mentions]);
    if (quiet && listed === shownList && view.firstChild) return;
    shownList = listed;
    const top = shownTab === tab && !view.hidden ? view.scrollTop : 0;
    recheckDisk = null;
    keepingFocus(() => {
      const body = frame('Artifacts', `队员在回执里交付的文件按项目收在这里，回复里提到的文件和链接也在。点一下在右侧预览，${modKey()} 点击用系统应用打开。`);
      const tabs = el('div', 'art-tabs');
      tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Artifacts 来源');
      const pick = (key) => { artifactTab = key; render(); };
      [['delivered', '回执交付', delivered.total], ['mentioned', '回复里提到的', mentions.length]].forEach(([key, label, n]) => {
        const b = el('button', 'art-tab' + (tab === key ? ' active' : ''));
        b.type = 'button'; b.dataset.tab = key; b.dataset.fk = 'tab:' + key; b.tabIndex = tab === key ? 0 : -1;
        b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(tab === key));
        b.append(el('span', null, label), el('span', 'seg-count', String(n)));
        b.addEventListener('click', () => pick(key));
        tabs.appendChild(b);
      });
      tabs.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        pick(tab === 'delivered' ? 'mentioned' : 'delivered');
        view.querySelector('.art-tab.active').focus();
      });
      body.appendChild(tabs);
      const panel = el('div', 'art-panel');
      panel.setAttribute('role', 'tabpanel');
      body.appendChild(panel);
      if (tab === 'delivered') renderDelivered(panel, delivered); else renderMentioned(panel, mentions);
    });
    shownTab = tab;
    view.scrollTop = top;
  }

  // ---- 回执交付: project -> files ----
  function goneWhy(f) {
    const foreign = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(f.path) ? host.platform !== 'win32' : host.platform === 'win32' && !f.path.startsWith('~');
    return foreign
      ? { flag: '另一台电脑上的路径', why: '这是另一台电脑上的路径，这台电脑上没有这个文件，不能预览。路径还可以复制。' }
      : { flag: '已不在磁盘上', why: '这个文件已经不在磁盘上（被移走、改名或删除了），不能预览。路径还可以复制。' };
  }
  function deliveredRow(f, now) {
    const state = onDisk.get(f.key);
    const gone = state === 0 ? goneWhy(f) : null;
    const row = el('div', 'dl-row' + (gone ? ' gone' : ''));
    row.setAttribute('role', 'listitem');
    row.dataset.path = f.path;

    const main = el('button', 'dl-main');
    main.type = 'button'; main.dataset.fk = 'file:' + f.key;
    const name = el('div', 'dl-name');
    name.appendChild(el('span', 'art-name', f.name));
    if (gone) name.appendChild(el('span', 'dl-flag', gone.flag));
    const text = el('div', 'dl-text');
    // LRM marks keep a right-to-left (ellipsis on the left) path in order
    text.append(name, el('div', 'art-path', '\u200e' + shortPath(f.path) + '\u200e'));
    main.append(artifactTile({ type: state === 2 ? 'dir' : f.type, name: f.name }), text);
    main.title = gone ? gone.why : f.path;
    if (gone) main.setAttribute('aria-disabled', 'true');
    main.addEventListener('click', (e) => {
      if (gone) host.showToast(gone.why);
      else window.SidePane.openLink({ kind: 'file', text: f.path }, e, f.colId);
    });

    const who = f.gone ? (f.task || '已删除的会话') : f.session + (f.archived ? '（已归档）' : '');
    const said = f.failed ? '没做成：' + f.failed : f.summary;
    const when = f.ts ? new Date(f.ts).toLocaleString() : '';
    const by = el('div', 'dl-by');
    by.append(el('div', 'dl-session', who + (f.gone && f.task ? '（会话已删除）' : '')), el('div', 'dl-receipt', said.replace(/\s+/g, ' ')));
    by.title = ['会话：' + (f.gone ? '已删除' : who), f.task && '任务：' + f.task, said && '回执：' + (said.length > 300 ? said.slice(0, 300) + '…' : said), when && '交付：' + when].filter(Boolean).join('\n');
    const time = el('time', 'dl-time', SC.formatWhen(f.ts, now) || '时间未知');
    if (when) { time.title = '交付于 ' + when; time.dateTime = new Date(f.ts).toISOString(); }

    const actions = el('div', 'dl-actions');
    const jump = toolButton('chat', f.gone ? '交付它的会话已经删除' : '跳到交付它的会话', () => {
      if (f.gone) { host.showToast('交付这个文件的会话已经删除了，文件记录还留在这里。'); return; }
      hide();
      window.ChatUI.reveal(f.colId);
    });
    if (f.gone) jump.setAttribute('aria-disabled', 'true');
    actions.append(
      copyButton('复制路径', f.path),
      toolButton('folderOpen', gone ? '打开它原来所在的文件夹' : revealTitle(), () => window.deck.revealPath(f.path, f.colId)),
      jump);
    row.append(main, by, time, actions);
    return row;
  }
  function renderDelivered(panel, delivered) {
    if (!delivered.total) {
      const empty = el('div', 'page-empty');
      empty.append(icon('artifacts', 'page-empty-ico'), el('strong', null, '还没有交付的文件'),
        el('span', null, '队员在回执里交付的文件会自动按项目收在这里，以前的回执也算，不用你和队员做任何事。'));
      panel.appendChild(empty);
      return;
    }
    const files = delivered.groups.flatMap((g) => g.files);
    const summary = el('div', 'dl-summary');
    const list = el('div', 'dl-list');
    panel.append(summary, list);
    const fill = () => {
      const now = Date.now();
      const projects = delivered.groups.filter((g) => g.key).length;
      const lost = files.filter((f) => onDisk.get(f.key) === 0).length;
      summary.textContent = [`${delivered.total} 个文件`, projects && `${projects} 个项目`, lost && `${lost} 个已不在磁盘上`].filter(Boolean).join(' · ');
      list.textContent = '';
      delivered.groups.forEach((g) => {
        const open = !collapsed().includes(g.key);
        const sec = el('section', 'dl-group');
        sec.dataset.project = g.key;
        const head = el('button', 'dl-head');
        head.type = 'button'; head.dataset.fk = 'project:' + g.key;
        head.setAttribute('aria-expanded', String(open));
        head.title = open ? '收起这个项目' : '展开这个项目';
        const dot = el('span', 'dl-dot');
        if (g.key) dot.style.setProperty('--project-hue', window.CrewMapCore.projectHue(g.key));
        head.append(icon('chevDown', 'dl-chev'), dot, el('span', 'dl-project', g.name || '未分组'), el('span', 'dl-count', String(g.files.length)));
        const lostHere = g.files.filter((f) => onDisk.get(f.key) === 0).length;
        if (lostHere) head.appendChild(el('span', 'dl-lost', `${lostHere} 个已不在磁盘上`));
        head.append(el('span', 'tb-spacer'), el('span', 'dl-latest', '最近 ' + (SC.formatWhen(g.ts, now) || '时间未知')));
        const rows = el('div', 'dl-rows');
        rows.setAttribute('role', 'list'); rows.setAttribute('aria-label', (g.name || '未分组') + ' 的文件');
        rows.hidden = !open;
        const every = shownAll.has(g.key) || g.files.length <= GROUP_ROWS + 5;
        (every ? g.files : g.files.slice(0, GROUP_ROWS)).forEach((f) => rows.appendChild(deliveredRow(f, now)));
        if (!every) {
          const more = el('button', 'dl-more', `显示其余 ${g.files.length - GROUP_ROWS} 个`);
          more.type = 'button'; more.dataset.fk = 'more:' + g.key;
          more.addEventListener('click', () => { shownAll.add(g.key); fill(); });
          rows.appendChild(more);
        }
        head.addEventListener('click', () => {
          const opening = collapsed().includes(g.key);
          host.config.artifactsCollapsed = opening ? collapsed().filter((k) => k !== g.key) : [...collapsed(), g.key];
          host.saveConfig();
          rows.hidden = !opening;
          head.setAttribute('aria-expanded', String(opening));
          head.title = opening ? '收起这个项目' : '展开这个项目';
        });
        const h = el('h2', 'dl-h');
        h.appendChild(head);
        sec.append(h, rows);
        list.appendChild(sec);
      });
    };
    fill();
    // Files get moved and deleted behind the page's back: ask the disk now, and
    // again whenever the window comes back to the front.
    const check = async () => {
      const run = ++diskRun;
      let changed = false;
      for (let at = 0; at < files.length; at += 1000) {
        const part = files.slice(at, at + 1000);
        let res;
        try { res = await window.deck.artifactsStat(part.map((f) => f.path)); } catch (_) { return; }
        if (run !== diskRun || current !== 'artifacts' || !Array.isArray(res)) return;
        part.forEach((f, i) => {
          if (res[i] === undefined || onDisk.get(f.key) === res[i]) return;
          onDisk.set(f.key, res[i]);
          changed = true;
        });
      }
      if (changed) { const top = view.scrollTop; keepingFocus(fill); view.scrollTop = top; }
    };
    recheckDisk = check;
    check();
  }

  // ---- 回复里提到的: files and links from the replies ----
  function renderMentioned(panel, all) {
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
    search.dataset.fk = 'search';
    search.addEventListener('input', () => { artifactFilter.q = search.value; fill(); });
    search.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    bar.appendChild(search);
    panel.appendChild(bar);
    const grid = el('div', 'art-grid');
    panel.appendChild(grid);
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
        const tools = el('div', 'art-tools');
        tools.appendChild(copyButton(a.kind === 'url' ? '复制网址' : '复制路径', a.text));
        if (a.kind === 'file') tools.appendChild(toolButton('folderOpen', revealTitle(), () => window.deck.revealPath(a.text, a.colId)));
        const top = el('div', 'art-top');
        top.append(artifactTile(a), tools);
        const text = el('div', 'art-text');
        // LRM marks keep a right-to-left (ellipsis on the left) path in order
        text.append(el('div', 'art-name', a.name), el('div', 'art-path', '\u200e' + a.text + '\u200e'));
        const foot = el('div', 'art-foot');
        foot.append(el('span', 'art-session', a.title + (a.archived ? '（已归档）' : '')), el('span', 'art-time', SC.formatWhen(a.ts, now)));
        const jump = el('button', 'art-jump', '跳到对话');
        jump.type = 'button';
        jump.addEventListener('click', (e) => { e.stopPropagation(); hide(); window.ChatUI.reveal(a.colId, a.turnId, 'reply'); });
        foot.appendChild(jump);
        card.append(top, text, foot);
        const open = (e) => window.SidePane.openLink({ kind: a.kind, text: a.text }, e, a.colId);
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) open(e); });
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
    window.addEventListener('focus', () => { if (current === 'artifacts' && recheckDisk) recheckDisk(); });
    // Give the terminals a moment to come up before sending anything.
    setTimeout(() => {
      tick(true);
      setInterval(() => tick(false), 15_000);
    }, 4000);
  }

  window.Pages = {
    init, show, hide, toggle, render, openEditor, tick,
    current: () => current,
    refresh: () => { if (current === 'artifacts') renderArtifacts(true); },
  };
})();
