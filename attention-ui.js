// 待我处理: the page where the user comes back to what the AI handed them
// (things only they can do, and the short conclusions 队长 reported while they
// were away), plus the service behind it: 队长's `inbox` commands, the board's
// own items, replies carried to 队长 with their context, and the phone's view.
// Rules and texts are in attention-core.js; the items are kept in this
// computer's config.json (`config.attention`).
(function () {
  'use strict';
  const A = window.AttentionCore;
  let host = null;
  let store = null;
  let view = null;                   // the page body while the page is shown
  let showDone = false;              // 已完成 starts folded
  let doneLimit = 30;
  const opened = new Set();          // item ids whose details are unfolded
  const drafts = new Map();          // item id -> reply being written (its composer is open)
  const busy = new Set();            // item ids with a reply or tick on its way
  let syncing = false, syncAgain = false;
  let redrawWaiting = false;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(label, onClick, cls) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  // Common tool actions are icons; the title is the tooltip and the accessible name.
  function iconButton(name, title, onClick, fk) {
    const b = el('button', 'icon-btn at-tool');
    b.type = 'button'; b.title = title; b.innerHTML = host.ICONS[name] || '';
    b.setAttribute('aria-label', title);
    if (fk) b.dataset.fk = fk;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e, b); });
    return b;
  }
  function copyButton(title, text, fk) {
    return iconButton('copy', title, (_e, b) => {
      try { host.clipboardWrite(text); } catch (_) { host.showToast('没能复制到剪贴板'); return; }
      b.innerHTML = host.ICONS.check; b.classList.add('done');
      b.title = '已复制'; b.setAttribute('aria-label', '已复制');
      clearTimeout(b.checkTimer);
      b.checkTimer = setTimeout(() => {
        b.innerHTML = host.ICONS.copy; b.classList.remove('done');
        b.title = title; b.setAttribute('aria-label', title);
      }, 1200);
    }, fk);
  }
  const revealTitle = () => (host.platform === 'darwin' ? '在访达中显示' : host.platform === 'win32' ? '在资源管理器中显示' : '在文件管理器中显示');
  const shortPath = (p) => (host.home && p.startsWith(host.home) && /^[\\/]/.test(p.slice(host.home.length)) ? '~' + p.slice(host.home.length) : p);
  const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

  // ---- store ----------------------------------------------------------------
  function load() {
    if (!store) {
      store = A.normalize(host.config.attention);
      host.config.attention = store;
    }
    return store;
  }
  function save() {
    A.prune(load());
    host.config.attention = store;
    host.saveConfig();
    paintBadge();
    redraw();
  }
  const find = (id) => load().items.find((i) => i.id === id) || null;

  // ---- the sidebar's count ------------------------------------------------------
  function counts() { return A.counts(load()); }
  function paintBadge() {
    const row = document.getElementById('attentionBtn');
    if (!row) return;
    const c = counts();
    const badge = row.querySelector('.nav-row-badge');
    if (badge) {
      badge.hidden = !c.badge;
      badge.textContent = c.badge > 99 ? '99+' : String(c.badge || '');
      badge.classList.toggle('need', c.need > 0);
    }
    row.title = A.badgeTitle(c);
    row.setAttribute('aria-label', c.badge ? A.badgeTitle(c) : '待我处理');
  }

  // ---- what else knows when an item is settled ---------------------------------
  // A session waits on an answer while its terminal sits on a prompt or its
  // last piece of work asked 队长 something. null: not a live session here.
  function sessionWaiting(id) {
    const col = host.columns().find((c) => c.id === id);
    if (!col) return null;
    const entry = host.terms.get(id);
    const task = (window.MainSession && window.MainSession.state() && window.MainSession.state().tasks || []).findLast((t) => t.colId === id);
    return !!(entry && entry.alive && entry.state === 'input') || ['asking', 'input'].includes(task && task.status);
  }
  async function refresh() {
    if (!host) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try {
      const s = load();
      const now = Date.now();
      let changed = 0;
      try { changed += A.syncCards(s, await window.TaskBoard.list({ archived: true }), now); } catch (_) { /* a damaged board file: try again next time */ }
      changed += A.syncSessions(s, sessionWaiting, now);
      const ms = window.MainSession && window.MainSession.state();
      if (ms && Array.isArray(ms.pending)) changed += A.markRepliesSeen(s, ms.pending.map((p) => p.taskId));
      if (changed) save(); else paintBadge();
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; refresh(); }
    }
  }

  // ---- 队长's commands ------------------------------------------------------------
  async function cardOf(id) {
    const card = (await window.TaskBoard.list({ archived: true })).find((c) => c.id === id);
    if (!card) throw new Error(`找不到卡片 ${id}。用 task list 看卡片 id。`);
    return card;
  }
  function sessionOf(id) {
    const col = host.columns().find((c) => c.id === id) || host.archived().find((c) => c.id === id);
    if (!col) throw new Error(`找不到会话 ${id}。用 ledger 看会话 id。`);
    return col;
  }
  async function captain(message, caller) {
    const s = load();
    const input = message.input && typeof message.input === 'object' ? message.input : {};
    const now = Date.now();
    if (message.op === 'list') return { done: true, result: A.listText(s, input.all === true, now) };
    if (message.op === 'resolve') {
      const { item, changed } = A.resolve(s, input.id, 'captain', input.note, now);
      if (changed) save();
      return { done: true, result: changed ? `已打勾：${item.id}「${item.title}」，归到已完成。` : `${item.id} 已经在已完成里了。` };
    }
    if (message.op !== 'need' && message.op !== 'report') throw new Error('inbox 只有 need、report、list、resolve。');
    const card = input.card ? await cardOf(input.card) : null;
    const col = input.session ? sessionOf(input.session) : null;
    const { item, created } = A.add(s, {
      kind: message.op, type: input.type, title: input.title, ask: input.ask, detail: input.detail, files: input.files,
      project: input.project || (card && card.project) || (col && col.project) || '',
      card: input.card, cardTitle: card && card.title, session: input.session, sessionTitle: col && host.columnLabel(col),
      sessionWaiting: col ? sessionWaiting(col.id) === true : false, source: 'captain',
    }, now);
    if (created) save();
    const out = { done: true, result: A.addedText(item, created) };
    // main.js alerts the user for a newly filed need item, as notify-user does.
    if (created && item.kind === 'need' && caller) {
      out.turnId = (host.terms.get(caller.id) && host.terms.get(caller.id).captainTurnId) || message.id;
      out.visible = host.captainColumnVisible(caller.id);
    }
    return out;
  }
  // notify-user: the alert goes out as before; the user also finds it here.
  function fromNotify(text) {
    try {
      const { item, created } = A.add(load(), A.notifyItem(text), Date.now());
      if (created) save();
      return item;
    } catch (_) { return null; }
  }

  // ---- what the user does ---------------------------------------------------------
  async function reply(id, text, from) {
    const item = find(id);
    if (!item) throw new Error('这一条已经不在了，刷新一下再看。');
    const body = String(text || '').trim();
    if (!body) throw new Error('先写下你的回复。');
    if ([...body].length > A.LIMITS.reply) throw new Error(`回复最多 ${A.LIMITS.reply} 字。`);
    if (!window.MainSession || !window.MainSession.exists()) throw new Error('还没有队长：回复要交给队长，先在侧边栏创建队长。');
    let notice = '';
    // An answer to a card's question takes the board's own path: 队长 hears it
    // with the card, and the card goes back to 进行中.
    if (item.source === 'card' && item.card && item.key.startsWith('needs:') && !item.done) await window.TaskBoard.answer(item.card, body);
    else notice = window.MainSession.userNotice(A.replyNotice(item, body));
    A.reply(load(), id, body, from, Date.now(), notice);
    save();
    return item;
  }
  function tick(id) {
    const item = find(id);
    if (!item) throw new Error('这一条已经不在了，刷新一下再看。');
    const { changed } = A.resolve(load(), id, 'user', '', Date.now());
    // What 队长 asked the user to do is done: work waiting on it can go on.
    if (changed && item.kind === 'need' && item.source !== 'card' && window.MainSession && window.MainSession.exists()) {
      try { window.MainSession.userNotice(A.doneNotice(item)); } catch (_) {}
    }
    if (changed) save();
    return item;
  }
  function tickReports() {
    const now = Date.now();
    let n = 0;
    for (const item of load().items) if (!item.done && item.kind === 'report') { A.resolve(store, item.id, 'user', '', now); n++; }
    if (n) save();
    return n;
  }
  function reopen(id) {
    const { changed } = A.reopen(load(), id, Date.now());
    if (changed) save();
  }
  function markRead(ids) {
    if (A.markRead(load(), ids, Date.now())) save();
  }

  // ---- the phone -----------------------------------------------------------------------
  function mobileView() { return A.phoneView(load()); }
  async function mobileWrite(input) {
    const op = input && input.op;
    const id = input && input.id;
    if (op === 'read') { markRead(Array.isArray(input.ids) ? input.ids.slice(0, 100) : []); return { ok: true }; }
    if (typeof id !== 'string' || !A.ID.test(id)) throw new Error('没有这一条。');
    if (op === 'reply') await reply(id, input.text, 'phone');
    else if (op === 'done') tick(id);
    else if (op === 'reopen') reopen(id);
    else throw new Error('未知操作。');
    const item = find(id);
    return { item: item ? A.phoneItem(item) : null, counts: counts() };
  }

  // ---- the page -------------------------------------------------------------------------
  const visible = () => !!(window.Pages && window.Pages.current() === 'attention');
  // A sent draft must no longer defer the redraw, even while its old textarea
  // still holds focus after Enter. Unsent drafts keep their input method intact.
  const typing = () => !!view && !!document.activeElement && view.contains(document.activeElement) && document.activeElement.classList.contains('at-reply')
    && drafts.has(document.activeElement.closest('.at-card').dataset.id);
  function redraw() {
    if (!visible()) return;
    if (typing()) { redrawWaiting = true; return; }
    redrawWaiting = false;
    window.Pages.render();
  }
  // A redraw rebuilds the page: whatever had the keyboard focus gets it back,
  // and the reading position stays. Taken before frame() empties the page.
  function keepingFocus(build) {
    const scroller = document.getElementById('pageView');
    const again = !!view && !!scroller && scroller.contains(view);
    const at = again && document.activeElement && scroller.contains(document.activeElement) ? document.activeElement.dataset.fk : '';
    const top = again ? scroller.scrollTop : 0;
    build();
    if (!scroller) return;
    scroller.scrollTop = top;
    const next = at && [...scroller.querySelectorAll('[data-fk]')].find((n) => n.dataset.fk === at);
    if (next) next.focus({ preventScroll: true });
  }

  // An unread item counts as read once most of it has stayed on screen for a
  // moment. Measured on a timer rather than observed: it holds while the
  // window is in the background and painting is throttled.
  const seenSince = new Map();
  function checkSeen() {
    const scroller = document.getElementById('pageView');
    if (!visible() || document.hidden || !scroller || !view) { seenSince.clear(); return; }
    const box = scroller.getBoundingClientRect(), now = Date.now(), ready = [];
    for (const node of view.querySelectorAll('.at-card.unread:not(.done)')) {
      const r = node.getBoundingClientRect(), shown = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
      const id = node.dataset.id;
      if (shown < Math.min(r.height * 0.6, box.height * 0.5)) { seenSince.delete(id); continue; }
      if (!seenSince.has(id)) seenSince.set(id, now);
      else if (now - seenSince.get(id) >= 1500) ready.push(id);
    }
    if (ready.length) { ready.forEach((id) => seenSince.delete(id)); markRead(ready); }
  }

  async function act(id, fn) {
    if (busy.has(id)) return;
    busy.add(id);
    try { await fn(); }
    catch (error) { host.showToast(error && error.message ? error.message : String(error)); }
    finally { busy.delete(id); redraw(); }
  }
  function openComposer(id) {
    if (!drafts.has(id)) drafts.set(id, '');
    redraw();
    const box = view && view.querySelector(`.at-card[data-id="${id}"] .at-reply`);
    if (box) box.focus();
  }
  async function send(id) {
    const text = (drafts.get(id) || '').trim();
    if (!text) { host.showToast('先写下你的回复。'); return; }
    await act(id, async () => {
      await reply(id, text, 'desktop');
      drafts.delete(id);
      host.showToast('已交给队长，这一条打勾归到已完成');
    });
  }

  function composer(item) {
    const form = el('form', 'at-compose');
    const box = el('textarea', 'at-reply');
    box.rows = 2; box.maxLength = A.LIMITS.reply; box.spellcheck = false;
    box.placeholder = item.kind === 'need' ? '写下你的决定或回答，会带着这一条交给队长' : '有问题或想法就写下来，会带着这一条交给队长';
    box.setAttribute('aria-label', '回复「' + item.title + '」');
    box.dataset.fk = 'reply:' + item.id;
    box.value = drafts.get(item.id) || '';
    const grow = () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 220) + 'px'; };
    box.addEventListener('input', () => { drafts.set(item.id, box.value); grow(); sendBtn.disabled = !box.value.trim(); });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(item.id); }
      else if (e.key === 'Escape') { e.preventDefault(); drafts.delete(item.id); redraw(); }
    });
    box.addEventListener('blur', () => setTimeout(() => { if (redrawWaiting) redraw(); }, 400));
    const foot = el('div', 'at-compose-foot');
    const hint = el('span', 'at-hint', 'Enter 发送，Shift+Enter 换行');
    const sendBtn = btn(busy.has(item.id) ? '正在交给队长…' : '发送给队长', () => send(item.id), 'primary');
    sendBtn.dataset.fk = 'send:' + item.id;
    sendBtn.disabled = busy.has(item.id) || !box.value.trim();
    const cancel = iconButton('close', '不回复了', () => { drafts.delete(item.id); redraw(); }, 'cancel:' + item.id);
    foot.append(hint, el('span', 'at-spacer'), cancel, sendBtn);
    form.append(box, foot);
    form.addEventListener('submit', (e) => { e.preventDefault(); send(item.id); });
    requestAnimationFrame(grow);
    return form;
  }

  function detailBlock(item, now) {
    const box = el('div', 'at-detail');
    box.id = 'at-detail-' + item.id;
    if (item.detail) box.appendChild(el('div', 'at-text', item.detail));
    if (item.files.length) {
      const list = el('ul', 'at-files');
      list.setAttribute('aria-label', '证据和文件');
      item.files.forEach((p, i) => {
        const row = el('li', 'at-file');
        const open = el('button', 'at-file-main');
        open.type = 'button'; open.title = p; open.dataset.fk = `file:${item.id}:${i}`;
        open.append(el('span', 'at-file-name', baseName(p)), el('span', 'at-file-path', '‎' + shortPath(p) + '‎'));
        open.addEventListener('click', (e) => window.SidePane.openLink({ kind: 'file', text: p }, e, item.session || undefined));
        row.append(open, copyButton('复制路径', p, `copyfile:${item.id}:${i}`),
          iconButton('folderOpen', revealTitle(), () => window.deck.revealPath(p, item.session || undefined), `reveal:${item.id}:${i}`));
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    const links = [];
    if (item.cardTitle) links.push('任务：' + item.cardTitle);
    if (item.sessionTitle) links.push('会话：' + item.sessionTitle);
    if (links.length) box.appendChild(el('div', 'at-links', links.join(' · ')));
    if (item.replies.length) {
      const said = el('div', 'at-replies');
      item.replies.forEach((r) => {
        const one = el('div', 'at-said');
        const head = el('div', 'at-said-head');
        head.append(el('span', null, r.from === 'phone' ? '你从手机回复' : '你的回复'), el('span', 'at-said-when', A.when(r.at, now)));
        if (r.notice) head.appendChild(el('span', 'at-said-state' + (r.seen ? ' seen' : ''), r.seen ? '队长已收到' : '还在等队长读到'));
        one.append(head, el('div', 'at-said-text', r.text));
        said.appendChild(one);
      });
      box.appendChild(said);
    }
    return box;
  }
  const hasDetail = (item) => !!(item.detail || item.files.length || item.cardTitle || item.sessionTitle || item.replies.length);
  function copyText(item) {
    return [item.title, item.ask && '要你做：' + item.ask, item.detail, item.files.length && item.files.join('\n')].filter(Boolean).join('\n\n');
  }
  function liveSession(item) { return item.session && host.columns().some((c) => c.id === item.session) ? item.session : ''; }

  function cardNode(item, now) {
    const card = el('article', `at-card at-${item.kind}` + (item.readAt ? '' : ' unread') + (item.done ? ' done' : ''));
    card.dataset.id = item.id;
    const top = el('div', 'at-top');
    if (!item.done && !item.readAt) {
      const dot = el('span', 'at-unread');
      dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', '未读'); dot.title = '未读';
      top.appendChild(dot);
    }
    if (item.done) {
      const mark = el('span', 'at-check');
      mark.innerHTML = host.ICONS.check;
      mark.setAttribute('aria-hidden', 'true');
      top.appendChild(mark);
    }
    // A finished 要你处理 already has its tick; the plain label would read as still pending.
    const kind = A.label(item);
    if (!(item.done && kind === A.TYPES.other)) top.appendChild(el('span', 'at-kind', kind));
    const meta = el('span', 'at-meta');
    if (item.project) meta.appendChild(el('span', 'at-project', item.project));
    const time = el('time', 'at-when', A.when(item.done ? item.doneAt : item.created, now));
    time.dateTime = new Date(item.done ? item.doneAt : item.created).toISOString();
    time.title = (item.done ? '完成于 ' : '登记于 ') + new Date(item.done ? item.doneAt : item.created).toLocaleString();
    meta.appendChild(time);
    if (item.source === 'card') meta.appendChild(el('span', 'at-from', '来自任务看板'));
    top.append(meta, el('span', 'at-spacer'));
    const tools = el('span', 'at-tools');
    const live = liveSession(item);
    if (live) tools.appendChild(iconButton('chat', '跳到对应的会话', () => { window.Pages.hide(); window.ChatUI.reveal(live); }, 'jump:' + item.id));
    tools.appendChild(copyButton('复制这一条', copyText(item), 'copy:' + item.id));
    if (item.done) tools.appendChild(iconButton('restore', '放回待处理', () => reopen(item.id), 'reopen:' + item.id));
    top.appendChild(tools);
    card.appendChild(top);

    card.appendChild(el('h3', 'at-title', item.title));
    if (item.ask && !item.done) {
      const ask = el('div', 'at-ask');
      ask.append(el('span', 'at-ask-label', '要你做'), el('span', 'at-ask-text', item.ask));
      card.appendChild(ask);
    }
    if (item.done) {
      const last = item.replies[item.replies.length - 1];
      card.appendChild(el('div', 'at-done-text', A.doneText(item) + (last ? '：' + last.text.replace(/\s+/g, ' ') : '')));
    }
    if (hasDetail(item)) {
      const more = el('button', 'at-more');
      more.type = 'button'; more.dataset.fk = 'more:' + item.id;
      const isOpen = opened.has(item.id);
      more.setAttribute('aria-expanded', String(isOpen));
      more.setAttribute('aria-controls', 'at-detail-' + item.id);
      more.append(el('span', 'ico at-chev'), el('span', null, isOpen ? '收起细节' : '细节与证据' + (item.files.length ? `（${item.files.length} 个文件）` : '')));
      more.querySelector('.at-chev').innerHTML = host.ICONS[isOpen ? 'chevDown' : 'chevRight'];
      more.addEventListener('click', () => { if (opened.has(item.id)) opened.delete(item.id); else opened.add(item.id); redraw(); });
      card.appendChild(more);
      if (isOpen) card.appendChild(detailBlock(item, now));
    }
    if (!item.done) {
      if (drafts.has(item.id)) card.appendChild(composer(item));
      else {
        const actions = el('footer', 'at-actions');
        const answer = btn('回复', () => openComposer(item.id), 'at-answer');
        answer.dataset.fk = 'answer:' + item.id;
        const doneLabel = item.kind === 'need' ? '已处理' : '知道了';
        const done = btn(doneLabel, () => act(item.id, async () => { tick(item.id); }), 'at-done');
        done.dataset.fk = 'done:' + item.id;
        done.title = item.kind === 'need'
          ? (item.source === 'card' ? '从这里勾掉；任务看板上的卡片不变' : '勾掉并告诉队长你已经处理了')
          : '看过了，没有问题';
        answer.disabled = done.disabled = busy.has(item.id);
        actions.append(answer, done);
        card.appendChild(actions);
      }
    }
    return card;
  }

  function section(cls, title, count, note, extra) {
    const head = el('div', 'at-section ' + cls);
    const titles = el('div', 'at-section-titles');
    const h = el('h2', null, title);
    if (count != null) h.appendChild(el('span', 'at-count', String(count)));
    titles.appendChild(h);
    if (note) titles.appendChild(el('p', null, note));
    head.appendChild(titles);
    if (extra) head.appendChild(extra);
    return head;
  }

  function render(frame, h) {
    host = h || host;
    const now = Date.now();
    const v = A.view(load());
    let body = null;
    keepingFocus(() => {
      body = frame('待我处理', '你不在时交回来的事，处理完自动归到已完成。');
      body.classList.add('at-page');
      view = body;
      const open = v.needs.length + v.reports.length;
      if (!open) {
        const empty = el('div', 'page-empty at-empty');
        const ico = el('span', 'ico page-empty-ico');
        ico.innerHTML = host.ICONS.inbox;
        empty.append(ico, el('strong', null, '都处理完了'),
          el('span', null, '队长交给你拍板、登录、付款或回答的事，以及它向你汇报的结论，都会出现在这里。'));
        body.appendChild(empty);
      }
      if (v.needs.length) {
        body.appendChild(section('at-sec-need', '要你处理', v.needs.length, '只有你能做的事。处理完点「已处理」，或者直接回复。'));
        const list = el('div', 'at-list');
        v.needs.forEach((item) => list.appendChild(cardNode(item, now)));
        body.appendChild(list);
      }
      if (v.reports.length) {
        const all = btn('全部知道了', () => { const n = tickReports(); if (n) host.showToast(`${n} 条汇报归到已完成`); }, 'at-all');
        all.dataset.fk = 'all-reports';
        all.title = '把下面的结果汇报都标成看过，归到已完成（可以放回）';
        body.appendChild(section('at-sec-report', '结果汇报', v.reports.length, '你不在时跑出来的结论。有问题就回复，没问题点「知道了」。', all));
        const list = el('div', 'at-list');
        v.reports.forEach((item) => list.appendChild(cardNode(item, now)));
        body.appendChild(list);
      }
      if (v.done.length) {
        const toggle = el('button', 'at-done-toggle');
        toggle.type = 'button'; toggle.dataset.fk = 'done-toggle';
        toggle.setAttribute('aria-expanded', String(showDone));
        const chev = el('span', 'ico');
        chev.innerHTML = host.ICONS[showDone ? 'chevDown' : 'chevRight'];
        toggle.append(chev, el('span', 'at-done-title', '已完成'), el('span', 'at-count', String(v.done.length)));
        toggle.addEventListener('click', () => { showDone = !showDone; doneLimit = 30; redraw(); });
        const head = el('div', 'at-section at-sec-done');
        head.appendChild(toggle);
        body.appendChild(head);
        if (showDone) {
          const list = el('div', 'at-list at-done-list');
          v.done.slice(0, doneLimit).forEach((item) => list.appendChild(cardNode(item, now)));
          body.appendChild(list);
          if (v.done.length > doneLimit) {
            const more = btn(`再显示 ${Math.min(30, v.done.length - doneLimit)} 条`, () => { doneLimit += 30; redraw(); }, 'at-more-done');
            more.dataset.fk = 'more-done';
            body.appendChild(more);
          }
        }
      }
    });
  }

  function init(h) {
    host = h;
    load();
    paintBadge();
    // Cards change on disk (this machine, the other one through git, a worker's receipt).
    if (window.TaskBoard && window.TaskBoard.onChange) window.TaskBoard.onChange(() => refresh());
    setInterval(() => refresh(), 30_000);
    setInterval(checkSeen, 500);
    setTimeout(() => refresh(), 1500);
  }

  window.AttentionUI = {
    init, render, refresh, paintBadge, counts, captain, fromNotify, reply, tick, tickReports, reopen, markRead,
    mobileView, mobileWrite, sessionWaiting,
    open: () => { if (!visible()) host.togglePage('attention'); },
  };
})();
