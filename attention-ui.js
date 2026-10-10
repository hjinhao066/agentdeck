// 待我处理: the page where the user comes back to what the AI handed them
// (things only they can do, and the short conclusions 队长 reported while they
// were away), plus the service behind it: 队长's `inbox` commands, replies
// carried to 队长 with their context, and the phone's view.
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
  const kept = new Set();            // reports read on this visit: they stay in place until the page is left
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
  // The check belongs to the button's key, not to the clicked node: the page redraws while the
  // write runs, and the new button must show it (copy-mark.js). The tooltip to go back to is kept
  // on the node.
  const copied = window.CopyMark.create({
    find: (key) => document.querySelectorAll(`[data-fk="${window.CSS && CSS.escape ? CSS.escape(key) : key}"]`),
    show: (b) => { b.innerHTML = host.ICONS.check; b.classList.add('done'); b.title = '已复制'; b.setAttribute('aria-label', '已复制'); },
    hide: (b) => { b.innerHTML = host.ICONS.copy; b.classList.remove('done'); b.title = b.dataset.tip || ''; b.setAttribute('aria-label', b.dataset.tip || ''); },
  });
  function copyButton(title, text, fk) {
    const b = iconButton('copy', title, async () => {
      try { await host.clipboardWrite(text); } catch (_) { host.showToast('没能复制到剪贴板，请再试一次'); return; }
      copied.done(fk);
    }, fk);
    b.dataset.tip = title;
    return copied.adopt(fk, b);
  }
  const revealTitle = () => (host.platform === 'darwin' ? '在访达中显示' : host.platform === 'win32' ? '在资源管理器中显示' : '在文件管理器中显示');
  const shortPath = (p) => (host.home && p.startsWith(host.home) && /^[\\/]/.test(p.slice(host.home.length)) ? '~' + p.slice(host.home.length) : p);
  const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

  // ---- store ----------------------------------------------------------------
  function load() {
    if (!store) {
      const raw = host.config.attention;
      store = A.normalize(raw);
      // Once: the board items 1.9 filed by itself go; 队长 hears which (refresh delivers it).
      const { changed } = A.migrate(store, raw && raw.version);
      host.config.attention = store;
      if (changed) host.saveConfig();
    }
    return store;
  }
  // The migration's note for 队长, delivered once a 队长 exists to read it.
  function deliverToCaptain(s) {
    if (!s.toCaptain || !window.MainSession || !window.MainSession.exists()) return 0;
    try { window.MainSession.userNotice(s.toCaptain); } catch (_) { return 0; }
    delete s.toCaptain;
    return 1;
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
      badge.hidden = !c.need;
      badge.textContent = c.need > 99 ? '99+' : String(c.need || '');
      badge.classList.toggle('need', c.need > 0);
    }
    // Reports not yet seen: a dot of their own, never added to the number.
    const dot = row.querySelector('.nav-row-dot');
    if (dot) dot.hidden = !c.unreadReports;
    row.title = A.badgeTitle(c);
    row.setAttribute('aria-label', c.need || c.unreadReports ? A.badgeTitle(c) : '待我处理');
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
      // What 队长 wrote back on a 待办 handed to AI (@ai).
      try { const t = await window.deck.todos('list'); changed += A.syncTodos(s, t && t.items, t && t.device, now); } catch (_) { /* read again next time */ }
      changed += deliverToCaptain(s);
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
    const turn = message.op === 'report' && caller ? saidIn(caller.id, now) : '';
    const { item, created } = A.add(s, {
      kind: message.op, type: input.type, title: input.title, ask: input.ask, options: input.options, detail: input.detail, files: input.files,
      project: input.project || (card && card.project) || (col && col.project) || '',
      card: input.card, cardTitle: card && card.title, session: input.session, sessionTitle: col && host.columnLabel(col),
      sessionWaiting: col ? sessionWaiting(col.id) === true : false, turn, source: 'captain',
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
  // The 队长 turn a report is said in: the one under way when it is filed, or
  // one that has just ended (the chat closes a turn after a quiet moment).
  // An older turn is not this report's: the report then waits in 没看.
  function saidIn(colId, now) {
    const id = host.terms.get(colId) && host.terms.get(colId).captainTurnId;
    const turn = id && window.ChatUI ? window.ChatUI.turnsOf(colId).find((t) => t.id === id) : null;
    return turn && (!turn.done || now - (turn.end || 0) <= 120_000) ? turn.id : '';
  }
  // 自动回执入口: a scheduled script's 结果汇报. Always a report (never a need), no
  // alert, and it says where it came from.
  function automation(message) {
    const from = message.automation;
    const { item, created } = A.add(load(), {
      kind: 'report', title: message.title, detail: message.detail, files: message.files, project: message.project,
      source: 'automation', automation: from.source,
    }, Date.now());
    if (created) save();
    return { done: true, result: created ? `已登记到「待我处理」：${item.id}，结果汇报（来自 ${from.label}）。` : `「待我处理」里已有同样一条未解决的：${item.id}，没有重复登记。` };
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
    const notice = window.MainSession.userNotice(A.replyNotice(item, body));
    A.reply(load(), id, body, from, Date.now(), notice);
    kept.delete(id);
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
    kept.delete(id);
    const { changed } = A.reopen(load(), id, Date.now());
    if (changed) save();
  }
  function markRead(ids, via) {
    if (A.markRead(load(), ids, Date.now(), via)) save();
  }

  // ---- the phone -----------------------------------------------------------------------
  function mobileView() { return A.phoneView(load()); }
  async function mobileWrite(input) {
    const op = input && input.op;
    const id = input && input.id;
    if (op === 'read') { markRead(Array.isArray(input.ids) ? input.ids.slice(0, 100) : [], input.via); return { ok: true }; }
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
  // moment (SEEN_MS) while the user has the window in front: focused (main's
  // focus/blur, so a click in the side pane still counts), shown, not minimized.
  // Leaving clears every count at once; back in front, each starts again from 0.
  // Measured on a timer rather than observed, so throttled painting does not matter.
  const SEEN_MS = 1500;
  const seenSince = new Map();
  let inFront = true;
  const attending = () => inFront && !document.hidden;
  function stopCounting() { seenSince.clear(); chatSince.clear(); }
  // Mostly in view through every box that cuts it, sideways too (HubCore.mostlyShown).
  const windowBox = () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight });
  const onScreen = (node, ...clips) => window.HubCore.mostlyShown(node.getBoundingClientRect(), [...clips.map((c) => c.getBoundingClientRect()), windowBox()]);
  function checkSeen() {
    checkChatSeen();
    const scroller = document.getElementById('pageView');
    if (!visible() || document.hidden || !scroller || !view) { seenSince.clear(); kept.clear(); return; }
    if (!attending()) { seenSince.clear(); return; }
    const now = Date.now(), ready = [];
    for (const node of view.querySelectorAll('.at-card.unread:not(.done)')) {
      const id = node.dataset.id;
      if (!onScreen(node, scroller)) { seenSince.delete(id); continue; }
      if (!seenSince.has(id)) seenSince.set(id, now);
      else if (now - seenSince.get(id) >= SEEN_MS) ready.push(id);
    }
    if (!ready.length) return;
    ready.forEach((id) => { seenSince.delete(id); if (find(id) && find(id).kind === 'report') kept.add(id); });
    markRead(ready);
  }
  // A report 队长 also said in its chat is read once that reply has stayed on
  // screen for the same moment: the 队长 conversation showing in the deck
  // (chat view), the turn finished, most of its reply in view: cut by the chat's
  // scroll area, the deck and the window, sideways as well as up and down (a
  // column scrolled almost out of the deck shows a sliver, not the reply).
  const chatSince = new Map();
  function checkChatSeen() {
    const linked = A.unseenByTurn(load());
    const captainCol = host.columns().find((c) => c.isMain);
    if (!linked.size || !captainCol || !attending() || !host.captainColumnVisible(captainCol.id)) { chatSince.clear(); return; }
    const turns = window.ChatUI ? window.ChatUI.turnsOf(captainCol.id) : [];
    const now = Date.now(), ready = [];
    for (const [turnId, ids] of linked) {
      const turn = turns.find((t) => t.id === turnId);
      const node = turn && turn.done && host.terms.get(captainCol.id).wrap.querySelector(`.msg.assistant[data-turn="${CSS.escape(turnId)}"]`);
      const scroller = node && !node.closest('[hidden]') && node.closest('.chat-scroll');
      if (!scroller || !onScreen(node, scroller, document.getElementById('deck'))) { chatSince.delete(turnId); continue; }
      if (!chatSince.has(turnId)) chatSince.set(turnId, now);
      else if (now - chatSince.get(turnId) >= SEEN_MS) { chatSince.delete(turnId); ready.push(...ids); }
    }
    if (ready.length) markRead(ready, 'chat');
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
    return [item.title, item.ask && '要你做：' + item.ask, item.options.length && '可选回答：' + item.options.join(' / '), item.detail, item.files.length && item.files.join('\n')].filter(Boolean).join('\n\n');
  }
  // One tap answers: the choice goes to 队长 like a typed reply, and the item is ticked.
  function quickReply(item, option) {
    act(item.id, async () => {
      await reply(item.id, option, 'desktop');
      drafts.delete(item.id);
      host.showToast(`已回复「${option}」，交给队长了`);
    });
  }
  function liveSession(item) { return item.session && host.columns().some((c) => c.id === item.session) ? item.session : ''; }

  function cardNode(item, now) {
    // A report read on this visit stays as it was, reply included, until the page is left.
    const stay = item.done && kept.has(item.id);
    const shut = item.done && !stay;
    const card = el('article', `at-card at-${item.kind}` + (item.readAt ? '' : ' unread') + (shut ? ' done' : '') + (stay ? ' seen' : ''));
    card.dataset.id = item.id;
    const top = el('div', 'at-top');
    if (!item.done && !item.readAt) {
      const dot = el('span', 'at-unread');
      dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', '未读'); dot.title = '未读';
      top.appendChild(dot);
    }
    if (shut) {
      const mark = el('span', 'at-check');
      mark.innerHTML = host.ICONS.check;
      mark.setAttribute('aria-hidden', 'true');
      top.appendChild(mark);
    }
    // A finished 要你处理 already has its tick; the plain label would read as still pending.
    const kind = A.label(item);
    if (!(shut && kind === A.TYPES.other)) top.appendChild(el('span', 'at-kind', kind));
    if (stay) top.appendChild(el('span', 'at-seen', '已读'));
    const meta = el('span', 'at-meta');
    if (item.project) meta.appendChild(el('span', 'at-project', item.project));
    const time = el('time', 'at-when', A.when(shut ? item.doneAt : item.created, now));
    time.dateTime = new Date(shut ? item.doneAt : item.created).toISOString();
    time.title = (shut ? '完成于 ' : '登记于 ') + new Date(shut ? item.doneAt : item.created).toLocaleString();
    meta.appendChild(time);
    if (item.source === 'card') meta.appendChild(el('span', 'at-from', '来自任务看板'));
    if (item.source === 'automation') meta.appendChild(el('span', 'at-from', '来自自动任务：' + item.automation));
    if (item.source === 'todo') meta.appendChild(el('span', 'at-from', '来自待办'));
    top.append(meta, el('span', 'at-spacer'));
    const tools = el('span', 'at-tools');
    const live = liveSession(item);
    if (live) tools.appendChild(iconButton('chat', '跳到对应的会话', () => { window.Pages.hide(); window.ChatUI.reveal(live); }, 'jump:' + item.id));
    tools.appendChild(copyButton('复制这一条', copyText(item), 'copy:' + item.id));
    if (shut) tools.appendChild(iconButton('restore', item.kind === 'report' ? '放回没看' : '放回待处理', () => reopen(item.id), 'reopen:' + item.id));
    top.appendChild(tools);
    card.appendChild(top);

    // An open need with a question: the question is the biggest thing on the
    // card, with its answers right under it; the title above says what it is
    // about, and the chip already says what kind of answer it wants.
    const asking = !!(item.ask && !item.done);
    card.appendChild(el('h3', 'at-title' + (asking ? ' at-about' : ''), item.title));
    if (asking) {
      const ask = el('div', 'at-ask');
      ask.setAttribute('role', 'group');
      ask.setAttribute('aria-label', A.label(item) + '：' + item.ask);
      ask.appendChild(el('p', 'at-ask-text', item.ask));
      if (item.options.length) {
        const quick = el('div', 'at-quick');
        item.options.forEach((option, i) => {
          const b = btn(option, () => quickReply(item, option), 'at-option');
          b.dataset.fk = `opt:${item.id}:${i}`;
          b.title = `回复「${option}」，交给队长`;
          b.disabled = busy.has(item.id);
          quick.appendChild(b);
        });
        ask.appendChild(quick);
      }
      card.appendChild(ask);
    }
    if (shut) {
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
    if (!shut) {
      if (drafts.has(item.id)) card.appendChild(composer(item));
      else {
        const actions = el('footer', 'at-actions');
        // With answers to pick from, writing one's own is the fallback, not the main action.
        const answer = btn(item.options.length ? '写别的回复' : '回复', () => openComposer(item.id), item.options.length ? 'at-answer at-own' : 'at-answer');
        answer.dataset.fk = 'answer:' + item.id;
        const doneLabel = item.kind === 'need' ? '已处理' : '知道了';
        const done = btn(doneLabel, () => act(item.id, async () => { tick(item.id); }), 'at-done');
        done.dataset.fk = 'done:' + item.id;
        done.title = item.kind === 'need'
          ? (item.source === 'card' ? '从这里勾掉；任务看板上的卡片不变' : '勾掉并告诉队长你已经处理了')
          : '看过了，没有问题';
        answer.disabled = done.disabled = busy.has(item.id);
        actions.append(answer);
        if (!stay) actions.append(done);
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

  // One column: its heading, then its items or a line saying it is empty.
  function column(cls, title, count, empty, items, now, extra) {
    const col = el('section', 'at-col ' + cls);
    col.appendChild(section(cls, title, count || null, '', extra));
    col.querySelector('h2').id = 'at-h-' + cls;
    col.setAttribute('aria-labelledby', 'at-h-' + cls);
    if (!items.length) col.appendChild(el('p', 'at-col-empty', empty));
    else {
      const list = el('div', 'at-list');
      items.forEach((item) => list.appendChild(cardNode(item, now)));
      col.appendChild(list);
    }
    return col;
  }

  function render(frame, h) {
    host = h || host;
    // A fresh visit (the page was left: its old body is gone): what was read last time is in 已读 now.
    if (!view || !view.isConnected) kept.clear();
    const now = Date.now();
    const v = A.view(load());
    // Reports read on this visit stay where the user is reading them.
    const stay = v.done.filter((i) => kept.has(i.id));
    const reports = A.sorted([...v.reports, ...stay]);
    const done = v.done.filter((i) => !kept.has(i.id));
    let body = null;
    keepingFocus(() => {
      body = frame('待我处理', '要你处理的事回复或办完才打勾；队长的汇报你在这里或队长对话里看过，就归到已读。');
      body.classList.add('at-page');
      view = body;
      if (!v.needs.length && !reports.length) {
        const empty = el('div', 'page-empty at-empty');
        const ico = el('span', 'ico page-empty-ico');
        ico.innerHTML = host.ICONS.inbox;
        empty.append(ico, el('strong', null, '都处理完了'),
          el('span', null, '队长交给你拍板、登录、付款或回答的事，以及你不在时它汇报的结论，都会出现在这里。'));
        body.appendChild(empty);
      } else {
        const cols = el('div', 'at-cols');
        cols.appendChild(column('at-sec-need', '要你处理', v.needs.length, '没有要你处理的事。', v.needs, now));
        let all = null;
        if (v.reports.length) {
          all = btn('全部看过了', () => { const n = tickReports(); if (n) host.showToast(`${n} 条汇报归到已读`); }, 'at-all');
          all.dataset.fk = 'all-reports';
          all.title = '把这一栏的汇报都标成看过，归到已读（可以放回）';
        }
        cols.appendChild(column('at-sec-report', '做完了你还没看', v.reports.length, '汇报你都看过了。', reports, now, all));
        body.appendChild(cols);
      }
      if (done.length) {
        const toggle = el('button', 'at-done-toggle');
        toggle.type = 'button'; toggle.dataset.fk = 'done-toggle';
        toggle.setAttribute('aria-expanded', String(showDone));
        const chev = el('span', 'ico');
        chev.innerHTML = host.ICONS[showDone ? 'chevDown' : 'chevRight'];
        toggle.append(chev, el('span', 'at-done-title', '已完成和已读'), el('span', 'at-count', String(done.length)));
        toggle.addEventListener('click', () => { showDone = !showDone; doneLimit = 30; redraw(); });
        const head = el('div', 'at-section at-sec-done');
        head.appendChild(toggle);
        body.appendChild(head);
        if (showDone) {
          const list = el('div', 'at-list at-done-list');
          done.slice(0, doneLimit).forEach((item) => list.appendChild(cardNode(item, now)));
          body.appendChild(list);
          if (done.length > doneLimit) {
            const more = btn(`再显示 ${Math.min(30, done.length - doneLimit)} 条`, () => { doneLimit += 30; redraw(); }, 'at-more-done');
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
    if (window.deck && window.deck.onTodosChanged) window.deck.onTodosChanged(() => refresh());
    setInterval(() => refresh(), 30_000);
    inFront = window.deck.windowInFront();
    window.deck.onWindowFront((on) => { inFront = on; if (!on) stopCounting(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopCounting(); });
    setInterval(checkSeen, 500);
    setTimeout(() => refresh(), 1500);
  }

  window.AttentionUI = {
    init, render, refresh, paintBadge, counts, captain, automation, fromNotify, reply, tick, tickReports, reopen, markRead,
    mobileView, mobileWrite, sessionWaiting,
    open: () => { if (!visible()) host.togglePage('attention'); },
  };
})();
