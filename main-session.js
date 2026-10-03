// 队长 (Captain), internally the main session: one standing column that understands what you want, hands the work
// to other columns, and shows you short receipts. It never does the work in
// its own column. Its control channel is the existing capability-tokened board
// bridge: only this column's terminal holds a token that main-* commands
// accept; the columns it drives get no token and so no control of anything.
(function () {
  'use strict';
  const M = window.MainCore;
  const ACTIVE_OUTPUT_MS = 60_000;   // output this recent: not finished, whatever the status dot says
  const C = window.ChatCore;
  let host = null;
  const startedAt = Date.now();
  const MAX_TASKS = 120;            // cards kept in config.json; older ones drop off
  const FALLBACK_AFTER = 30_000;   // after an app restart: a column with no extracted turn gets a screen-based receipt
  // A column that looks idle is not necessarily done: it pauses between tool
  // calls, between two instructions, and Cursor can stay silent for a minute or
  // two after it starts. Only a written receipt, a question or a failure ends
  // a task at once; without one the column must stay quiet this long first.
  const STOP_QUIET = 3 * 60_000;
  const SCREEN_QUIET = 4_000;      // a receipt on the screen counts once the column has stopped printing
  const dispatches = new Map();  // one delivery loop per session; additions merge until submission

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // config.mainSession = { colId, cmd, gen, pending: [receipt], inflight: [receipt], tasks: [task], fresh, crewMarked, waitlist }
  // inflight: receipts already typed to 队长 whose turn has not finished yet.
  // fresh: the context was cleared and 队长 has not finished a turn since.
  // crewMarked: sessions opened before captainCrew existed were marked once.
  // waitlist: `new` requests waiting for a free slot (M.MAX_ACTIVE), oldest first;
  // each has a 'waiting' card with no column yet.
  // config.captainHistory: conversations from before a clear (MainCore.normalizeHistory).
  function state() {
    const s = host.config.mainSession;
    if (!s || typeof s !== 'object') return null;
    return s;
  }
  function mainCol() {
    const s = state();
    return s ? host.columns().find((c) => c.id === s.colId && c.isMain) || null : null;
  }
  const isMain = (col) => !!(col && col.isMain && state() && state().colId === col.id);
  const isMainId = (id) => !!(state() && state().colId === id && mainCol());
  function save() { host.saveConfig(); }

  function normalize() {
    host.config.captainHistory = M.normalizeHistory(host.config.captainHistory);
    const s = host.config.mainSession;
    if (!s || typeof s !== 'object' || typeof s.colId !== 'string') { host.config.mainSession = null; return; }
    s.gen = Number.isFinite(s.gen) ? s.gen : 1;
    s.cmd = typeof s.cmd === 'string' ? window.BoardCore.upgradeLegacyCommand(s.cmd) : '';
    const col = host.columns().find((c) => c.id === s.colId && c.isMain);
    if (col && col.cmd) s.cmd = col.cmd;
    s.pending = Array.isArray(s.pending) ? s.pending.slice(-50) : [];
    s.inflight = Array.isArray(s.inflight) ? s.inflight.slice(-50) : [];
    // A turn open at shutdown cannot acknowledge these items after relaunch.
    s.pending = [...s.inflight, ...s.pending].slice(-50);
    s.inflight = [];
    s.fresh = !!s.fresh;
    s.legacyReceiptInjection = s.legacyReceiptInjection === true;
    s.tasks = Array.isArray(s.tasks) ? s.tasks.filter((t) => t && typeof t.id === 'string' && typeof t.colId === 'string').slice(-MAX_TASKS) : [];
    s.waitlist = Array.isArray(s.waitlist) ? s.waitlist.filter((w) => w && typeof w.taskId === 'string' && typeof w.task === 'string' && s.tasks.some((t) => t.id === w.taskId && t.status === 'waiting')) : [];
    // the column was closed while the app was down
    if (!host.columns().some((c) => c.id === s.colId && c.isMain)) host.config.mainSession = null;
  }

  // ---- open / create ----
  function open() {
    const col = mainCol();
    if (col) { host.jumpToColumn(col); return; }
    openDialog();
  }
  function openDialog() {
    const d = $('mainDialog');
    $('mdCmd').value = window.BoardCore.commandForAgent('claude');
    $('mdCwd').value = '';
    d.showModal();
    setTimeout(() => $('mdCmd').focus(), 50);
  }
  function create(cmd, cwd) {
    if (mainCol()) { open(); return mainCol(); }
    const col = host.createMain({ cmd, cwd });
    host.config.mainSession = { colId: col.id, cmd, gen: 1, pending: [], inflight: [], tasks: [], fresh: false, crewMarked: true, waitlist: [] };
    save();
    window.Sidebar.render();
    brief(col);
    return col;
  }
  // The instructions go straight into the terminal; they are not a user bubble.
  // Receipts wait until the instructions are in: briefing is the column whose
  // brief has not gone out yet.
  let briefing = '';
  function brief(col, note) {
    if (!col.cmd) return;   // a bare shell would run them as commands
    const id = col.id;
    briefing = id;
    const done = () => { if (briefing === id) briefing = ''; };
    host.sendWhenReady(col, M.instructions(host.platform, note, state()?.legacyReceiptInjection === true), {
      silent: true, onSent: done, guardUserInput: true,
      onGiveUp: () => { done(); host.showToast('没发出去：队长的 agent 一直没准备好'); },
    });
  }
  function initDialog() {
    document.querySelectorAll('#mainDialog .preset').forEach((b) => {
      b.addEventListener('click', () => { $('mdCmd').value = b.dataset.cmd; $('mdCmd').focus(); });
    });
    $('mdCancel').addEventListener('click', () => $('mainDialog').close());
    $('mdCreate').addEventListener('click', () => {
      $('mainDialog').close();
      create($('mdCmd').value.trim(), $('mdCwd').value.trim());
    });
    $('mainDialog').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && e.target.tagName === 'INPUT') { e.preventDefault(); $('mdCreate').click(); }
    });
  }

  // ---- clear context: only 队长's model context starts over ----
  // Its agent restarts fresh and is briefed again. Work out in other columns,
  // unread receipts and questions carry over to the new context; the old
  // conversation stays saved under the old column id for `read --id`.
  function clearContext() {
    const col = mainCol();
    const s = state();
    if (!col || !s) return;
    const entry = host.terms.get(col.id);
    const busy = !!entry && entry.alive && (entry.state === 'working' || entry.state === 'input');
    const kept = '\n\n派出去的活不会中断；没处理的回执和提问留给清空后的队长；之前的对话存在本机，不会删除，队长需要时按需读取。';
    if (!confirm(busy
      ? '队长现在正在回复（或停在确认提示上）。清空会打断它这一轮，这一轮没说完的不会再有。\n确定现在清空队长的模型上下文吗？' + kept
      : '只清空队长的模型上下文：队长重新启动，重新读一遍默认说明。' + kept)) return;
    // receipts typed in but not answered yet go to the new context again
    const requeue = s.inflight;
    s.inflight = [];
    const oldId = col.id;
    const retired = window.ChatUI.retireChat(oldId);
    if (retired) {
      host.config.captainHistory = M.normalizeHistory([...(host.config.captainHistory || []), { id: oldId, ...retired, clearedAt: Date.now() }]);
    }
    s.pending = [...requeue, ...s.pending].slice(-50);
    s.gen += 1;
    const waiting = new Set(s.pending.map((p) => p.taskId).filter(Boolean));
    const latest = new Map(s.tasks.map((t) => [t.colId, t]));
    const carried = s.tasks.filter((t) => !CLOSED.includes(t.status) || waiting.has(t.id) || (t.status === 'asking' && latest.get(t.colId) === t));
    carried.forEach((t) => { t.gen = s.gen; });
    // An acknowledged notification can still need a decision. Remind the new
    // context once, even if the old Captain already finished its own reply.
    carried.forEach((t) => {
      if (t.status === 'input' && !s.pending.some((p) => p.colId === t.colId && p.waiting)) {
        push(t, { waiting: confirmationExcerpt(host.terms.get(t.colId)) });
      } else if (t.status === 'asking' && t.receipt?.question && !s.pending.some((p) => p.colId === t.colId && p.question)) {
        push(t, { question: t.receipt.question });
      }
    });
    col.cmd = M.freshCommand(col.cmd);
    delete col.modelSessionId;
    s.cmd = col.cmd;
    const fresh = host.respawnColumn(col, { freshChat: true });   // new id, new shell, new token
    s.colId = fresh.id;
    s.fresh = true;
    carried.forEach((t) => window.ChatUI.addCard(s.colId, t));
    save();
    window.Sidebar.render();
    brief(fresh, M.resetNote(retired ? oldId : '', carried.filter((t) => !CLOSED.includes(t.status))));
    host.showToast('队长的模型上下文已清空；派出去的活、回执和之前的对话都还在');
  }

  // ---- handing out work ----
  function findTarget(ref) {
    const key = String(ref || '').trim();
    if (!key) return null;
    const cols = host.columns().filter((c) => !c.isMain);
    const byId = cols.find((c) => c.id === key);
    if (byId) return byId;
    const byTitle = cols.filter((c) => host.columnLabel(c) === key);
    return byTitle.length === 1 ? byTitle[0] : null;
  }
  // col null: a 'waiting' card for work queued until a slot frees up.
  function addTask(col, title) {
    const s = state();
    const task = {
      id: 'k' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      colId: col ? col.id : '', title: String(title || host.columnLabel(col)).slice(0, 120), gen: s.gen,
      status: col ? 'queued' : 'waiting', sentAt: Date.now(), turnId: '', receipt: null,
      project: col ? col.project || '' : '', reviews: col ? col.reviews || [] : [],
    };
    s.tasks.push(task);
    if (s.tasks.length > MAX_TASKS) s.tasks.splice(0, s.tasks.length - MAX_TASKS);
    window.ChatUI.addCard(s.colId, task);
    save();
    return task;
  }
  function dispatch(col, text, title, waiting) {
    const task = waiting || addTask(col, title);
    if (waiting) {
      Object.assign(task, { colId: col.id, status: 'queued', sentAt: Date.now() });
      update(task);
    }
    let batch = dispatches.get(col.id);
    if (batch && batch.items.every((i) => i.task.status !== 'queued')) { dispatches.delete(col.id); batch = null; }
    if (batch && !batch.sending) { batch.items.push({ task, text }); return task; }
    batch = { items: [{ task, text }], sending: false, cancelled: false };
    dispatches.set(col.id, batch);
    let sentItems = [];
    host.sendWhenReady(col, () => {
      batch.sending = true;
      sentItems = batch.items.filter((i) => i.task.status === 'queued');
      return sentItems.map((i) => i.text).join('\n\n');
    }, {
      cancelled: () => batch.cancelled || batch.items.every((i) => i.task.status === 'stopped' || i.task.status === 'failed'),
      suffix: M.RECEIPT_CONTRACT, force: true, guardUserInput: true, requireIdle: true, timeout: 30 * 60_000,
      onSent: (turn) => {
        if (dispatches.get(col.id) === batch) dispatches.delete(col.id);
        if (batch.cancelled || sentItems.every((i) => i.task.status === 'stopped' || i.task.status === 'failed')) return;
        const last = sentItems.at(-1)?.task;
        if (!last) return;
        supersede(last);
        sentItems.forEach(({ task: t }) => {
          t.status = t === last ? 'working' : 'done';
          if (t === last) { t.turnId = turn ? turn.id : ''; t.startedAt = Date.now(); }
          else { t.doneAt = Date.now(); t.receipt = { summary: '已合并到后面的补充指令，一起送达。', files: [], images: [], failed: '', explicit: true }; }
          update(t);
        });
      },
      onGiveUp: () => {
        if (dispatches.get(col.id) === batch) dispatches.delete(col.id);
        batch.items.forEach(({ task: t }) => settle(t, { summary: '', files: [], images: [], failed: '30 分钟内一直发不出去：那一列的 agent 一直在忙或没有运行', explicit: true }));
      },
      onDeferred: () => { batch.sending = false; },
    });
    return task;
  }
  function cancelSupplement(colId) {
    const batch = dispatches.get(colId);
    if (batch) { batch.cancelled = true; dispatches.delete(colId); }
    state().tasks.forEach((t) => {
      if (t.colId !== colId || t.status !== 'queued') return;
      t.status = 'stopped'; t.doneAt = Date.now();
      t.receipt = { summary: '队长已取消这条尚未送达的补充指令。', files: [], images: [], failed: '', explicit: true };
      update(t);
    });
  }
  // A new instruction reached a column whose earlier card never got a receipt
  // (it carried on into the new work): close that card quietly. A receipt now
  // would be a false "stopped" for work that is still going.
  function supersede(task) {
    const s = state();
    s.tasks.forEach((t) => {
      if (t === task || t.colId !== task.colId || !['working', 'quota', 'input'].includes(t.status)) return;
      t.receipt = { summary: '后来又给这个会话发了新指令，结果看后面的卡片。', files: [], images: [], failed: '', explicit: true };
      t.status = 'done';
      t.doneAt = Date.now();
      update(t);
    });
  }
  // ---- background sessions: at most M.MAX_ACTIVE at work, the rest wait ----
  const crewIds = () => new Set(host.columns().filter((c) => c.captainCrew && !c.isMain).map((c) => c.id));
  const freeSlots = () => M.MAX_ACTIVE - M.activeCrew(state().tasks, crewIds()).size;
  function openSession(title, cmd, cwd, requestId, text, waiting, metadata = {}) {
    const col = host.createSession({ title, cmd, cwd, createdByRequestId: requestId, displayTitle: title, manualTitle: true, captainCrew: true, ...metadata }, true);
    dispatch(col, text, title, waiting);
    return col;
  }
  // A queued request keeps its text in config.json; a long one goes to a file first.
  async function enqueue(title, cmd, cwd, requestId, text, metadata) {
    const s = state();
    let body = text;
    if (body.length > 8000) {
      const file = await window.deck.saveLongPrompt(body).catch(() => '');
      if (!file) throw new Error('任务太长，存文件失败，没有排上队。');
      body = `${body.slice(0, 300).replace(/\s+/g, ' ').trim()}…\n（这件活共 ${text.length} 字，完整内容已存成文件，请先完整读取再照做：${file}）`;
      if (state() !== s) throw new Error('队长已经关掉了，这件活没有排上队。');   // closed while the file was written
    }
    const task = addTask(null, title);
    Object.assign(task, metadata);
    s.waitlist.push({ taskId: task.id, title, cmd, cwd, requestId, task: body, ...metadata });
    save();
  }
  // Start waiting work as slots free up, oldest first.
  function pump() {
    const s = state();
    if (!s || !s.waitlist.length) return;
    let free = freeSlots();
    while (free-- > 0 && s.waitlist.length) {
      const w = s.waitlist.shift();
      const task = s.tasks.find((t) => t.id === w.taskId && t.status === 'waiting');
      if (task) openSession(w.title, w.cmd, w.cwd, w.requestId, w.task, task, { project: w.project || '', reviews: w.reviews || [] });
    }
    save();
  }
  // A finished background session is archived once 队长 has its receipt and
  // nothing happened for M.ARCHIVE_AFTER; never one you are looking at.
  function maybeArchive(col, entry) {
    const s = state();
    if (!col.captainCrew || !host.isBackstage(col) || host.focusedId() === col.id) return;
    if (entry && entry.alive && (entry.state === 'working' || entry.state === 'quota' || entry.state === 'input')) return;
    // a dot that reads idle is only a guess: any recent output also means it is not finished
    if (entry && entry.alive && Date.now() - (entry.lastOutputAt || 0) < Math.min(ACTIVE_OUTPUT_MS, M.ARCHIVE_AFTER)) return;
    if (M.archivable(s, col.id, host.lastTurnTs(col.id), Date.now(), M.ARCHIVE_AFTER)) host.archiveColumn(col, { quiet: true });
  }
  // `tell` to a background session that was archived brings it back first.
  function archivedCrew(ref) {
    const key = String(ref || '').trim();
    const list = (host.config.archived || []).filter((a) => a.captainCrew);
    const byId = list.find((a) => a.id === key);
    if (byId) return byId;
    const byTitle = list.filter((a) => host.columnLabel(a) === key);
    return byTitle.length === 1 ? byTitle[0] : null;
  }

  function update(task) {
    const s = state();
    if (s && task.gen === s.gen) window.ChatUI.updateCard(s.colId, task);
    save();
  }
  // A receipt arrived: record it on the column (the ledger), show it, queue it for the model.
  const CLOSED = ['done', 'failed', 'stopped', 'asking'];
  function settle(task, receipt) {
    if (CLOSED.includes(task.status)) return;
    task.receipt = receipt;
    task.status = receipt.question ? 'asking' : receipt.failed ? 'failed' : receipt.explicit ? 'done' : 'stopped';
    task.doneAt = Date.now();
    const col = host.columns().find((c) => c.id === task.colId);
    if (col && !receipt.question) col.lastReceipt = { ...receipt, ts: task.doneAt };
    push(task, receipt.question
      ? { question: receipt.question }
      : { summary: receipt.summary, files: receipt.files, failed: receipt.failed });
    update(task);
  }
  // Queue something for 队长's background reader (or the legacy quiet-moment injection).
  function push(task, item) {
    const s = state();
    if (!s || task.gen !== s.gen) return;
    s.pending.push({ taskId: task.id, colId: task.colId, title: task.title, ts: Date.now(), ...item });
    if (s.pending.length > 50) s.pending.splice(0, s.pending.length - 50);
  }
  // Hand every pending receipt to 队长's model as text; they count as in
  // flight until its turn ends.
  function takePending(nextTurn = false, batch) {
    const s = state();
    const text = M.receiptsForModel(s.pending);
    const turnId = nextTurn ? '' : (window.ChatUI.turnsOf(s.colId).findLast((t) => t.kind !== 'task' && !t.done)?.id || '');
    s.inflight = [...s.inflight, ...s.pending.map((p) => ({ ...p, deliveryTurnId: turnId, ...(batch ? { batch } : {}) }))].slice(-50);
    s.pending = [];
    save();
    return text;
  }
  // Opt-in legacy delivery: receipts and questions reach 队长 when its agent is idle,
  // they are typed in as one message (no user bubble) and its answer shows up
  // as a normal reply. Your own next message carries them too, if sooner.
  let delivering = false;
  let blockedSince = 0;   // receipts waiting because the user has half a message in 队长's input box
  function deliver(entry) {
    const s = state();
    const col = mainCol();
    const id = col && col.id;
    closeOrphans();
    if (!s || s.legacyReceiptInjection !== true || !s.pending.length) { blockedSince = 0; return; }
    if (delivering || !col || !col.cmd || !entry.alive || entry.sendingPrompt || briefing === col.id) return;
    if (entry.state === 'working' || entry.state === 'quota' || entry.state === 'input' || M.terminalActivity(entry.lastScreen)) return;
    if (Date.now() - (entry.lastOutputAt || 0) < 1500) return;   // let it settle first
    // Never through a box the user is typing in: Enter would send their half-written message too
    if (host.userComposing(id)) { holdBack(); return; }
    // only into 队长's agent, never into a shell it may have dropped back to
    delivering = true;
    host.agentInForeground(col, false).then((ok) => {
      delivering = false;
      if (!ok || s.legacyReceiptInjection !== true || !s.pending.length || mainCol() !== col || col.id !== id || briefing === id || entry.sendingPrompt) return;
      if (host.userComposing(id)) { holdBack(); return; }   // started typing while the check ran
      blockedSince = 0;
      const batch = 'b' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
      const text = takePending(true, batch);
      // guardUserInput: sendPrompt looks at the box once more in the same tick it
      // types, and holds the user's keys until its own Enter is out
      Promise.resolve(window.ChatUI.sendPrompt(col, '', null, { prefix: text.trim(), force: true, guardUserInput: true })).then((sent) => {
        if (sent) return;
        // not typed after all: the receipts go back to waiting
        const back = s.inflight.filter((p) => p.batch === batch).map(({ batch: b, deliveryTurnId, ...item }) => item);
        s.inflight = s.inflight.filter((p) => p.batch !== batch);
        s.pending = [...back, ...s.pending].slice(-50);
        save();
      });
    }, () => { delivering = false; });
  }
  // Tell the user once if receipts have been waiting for a while.
  function holdBack() {
    if (!blockedSince) blockedSince = Date.now();
    else if (blockedSince > 0 && Date.now() - blockedSince > 20_000) {
      blockedSince = -1;
      host.showToast('队员的回执在等：队长输入框里可能还有没发的话。你发出或清空后，回执会自动送过去。');
    }
  }
  // Work handed to a column that was closed, archived or restarted since.
  function closeOrphans() {
    const s = state();
    if (!s) return;
    const ids = new Set(host.columns().map((c) => c.id));
    s.tasks.forEach((t) => {
      if (!CLOSED.includes(t.status) && t.status !== 'waiting' && !ids.has(t.colId)) {
        settle(t, { summary: '', files: [], images: [], failed: '这个会话已经关掉、归档或重启了', explicit: true });
      }
    });
  }

  // ---- heartbeat: called for every column on the 1.5s status loop ----
  function confirmationExcerpt(entry) {
    return String(entry?.lastScreen || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-8)
      .map((l) => l.slice(0, 140)).join('\n') || '（看不到提示内容）';
  }
  function onTick(id, entry) {
    const s = state();
    if (!s) return;
    if (id === s.colId) { deliver(entry); pump(); return; }
    const col = host.columns().find((c) => c.id === id);
    if (col && col.captainCrew) maybeArchive(col, entry);
    for (const task of s.tasks) {
      if (task.colId !== id || !['queued', 'working', 'quota', 'input'].includes(task.status)) continue;
      if (!entry.alive) { settle(task, { summary: '', files: [], images: [], failed: '这个会话的终端已经退出', explicit: true }); continue; }
      if (task.status === 'queued') {
        // Not delivered yet and the session is stopped on a dialog (Cursor asks "Do you
        // trust this workspace?" in a folder it has not seen): the work cannot go in until
        // someone answers, so tell 队长 once. It answers with `answer --key enter`.
        if (entry.state === 'input' && !task.blockedAsked) {
          task.blockedAsked = true;
          push(task, { waiting: confirmationExcerpt(entry) });
          update(task);
        } else if (entry.state !== 'input' && task.blockedAsked) task.blockedAsked = false;
        continue;
      }
      const activity = M.terminalActivity(entry.lastScreen);
      if (entry.state === 'quota' || activity === 'quota') {
        if (task.status !== 'quota') { task.status = 'quota'; update(task); }
        task.idleSince = 0;
        continue;
      }
      if (task.status === 'quota') { task.status = 'working'; update(task); }
      if (entry.state === 'input') {
        // just answered: the old prompt can still be on screen for a moment
        if (task.status === 'input' || (task.answeredAt && Date.now() - task.answeredAt < 5000)) continue;
        task.status = 'input';
        // a confirmation or permission prompt goes to 队长 first, with only its last lines
        push(task, { waiting: confirmationExcerpt(entry) });
        update(task);
        continue;
      }
      // the prompt is gone (answered here or in the column): back to work
      if (task.status === 'input') { task.status = 'working'; update(task); }
      if (entry.state === 'working' || activity === 'working') { task.idleSince = 0; continue; }
      // The reply normally arrives through the chat turn (onTurnDone). That
      // turn can end early (a pause, a slow start) and the receipt then appears
      // on the screen only. If the app restarted mid-task, or no turn was
      // recorded, don't wait forever either — but a quiet screen alone is not
      // an ending until it has stayed quiet for STOP_QUIET.
      if (entry.state === 'done' || entry.state === 'plain') {
        task.idleSince = task.idleSince || Date.now();
        // its chat turn is still open: that turn's reply (unwrapped) is the better source
        const turn = task.turnId && window.ChatUI.turnsOf(task.colId).find((t) => t.id === task.turnId);
        if (turn && !turn.done) continue;
        const quiet = Date.now() - Math.max(task.idleSince, entry.lastOutputAt || 0);
        const finalReply = C.extractReply(M.afterContract(entry.lastScreen).split('\n'), '', entry.term?.cols);
        const fromScreen = M.parseReceipt(finalReply, filePaths);
        const prev = col && col.lastReceipt;
        const stale = !!prev && prev.summary === fromScreen.summary && prev.failed === fromScreen.failed;   // the last task's receipt, still on screen
        if (fromScreen.explicit && !stale && quiet >= SCREEN_QUIET) { settle(task, fromScreen); continue; }
        const restarted = (task.startedAt || task.sentAt) < startedAt;
        if (quiet < (restarted ? FALLBACK_AFTER : STOP_QUIET)) continue;
        // 1) a reply already saved for this turn; 2) say what happened
        // a reply cut off when the app closed is not that turn's final reply
        const saved = task.turnId && window.ChatUI.turnsOf(task.colId).find((t) => t.id === task.turnId && t.reply && !t.interrupted);
        if (saved) settle(task, M.parseReceipt(saved.reply, filePaths));
        else if (restarted) {
          settle(task, { summary: 'AgentDeck 重启过，没收到这件活的回执，去那一列看结果。', files: [], images: [], failed: '', explicit: false });
        } else settle(task, fromScreen);
      } else {
        task.idleSince = 0;
      }
    }
  }
  function onTurnStarted(colId, turn) {
    const s = state();
    if (!s || colId !== s.colId) return;
    s.inflight.forEach((p) => { if (!p.deliveryTurnId) p.deliveryTurnId = turn.id; });
    save();
  }
  function onTurnDone(colId, turn) {
    const s = state();
    if (!s) return;
    if (colId === s.colId) {
      if (s.inflight.length || s.fresh) {
        s.inflight = s.inflight.filter((p) => p.deliveryTurnId !== turn.id);
        s.fresh = false;
        save();
      }
      return;
    }
    const task = s.tasks.find((t) => t.colId === colId && t.turnId === turn.id);
    if (!task) return;
    const entry = host.terms.get(colId);
    if (entry && (entry.state === 'working' || entry.state === 'quota' || M.terminalActivity(entry.lastScreen))) return;
    // A turn also "ends" on a pause between tool calls or a silent start. Only
    // a receipt, a question or a failure closes the task here; otherwise onTick
    // waits for the column to stay quiet before calling it stopped.
    const r = M.parseReceipt(turn.reply, filePaths);
    if (r.explicit || r.question || r.failed) settle(task, r);
  }
  function filePaths(text) {
    return String(text).split('\n').flatMap((line) => host.findLinks(line)).filter((m) => m.kind === 'file').map((m) => m.text.trim());
  }

  // Only the opt-in legacy mode adds receipts to the user's next message.
  function outgoingPrefix(col) {
    const s = state();
    if (!s || s.legacyReceiptInjection !== true || !isMain(col) || !s.pending.length) return '';
    return takePending(true);
  }
  // A cleared 队长 starts a new model context, including after a cold restart.
  function skipsResume(col) {
    const s = state();
    return !!(s && s.fresh && col && col.isMain && col.id === s.colId);
  }

  // ---- commands from the main session's terminal (board-cli) ----
  function ledgerRows() {
    const folders = new Map((host.config.folders || []).map((f) => [f.id, f.name]));
    return host.columns().filter((c) => !c.isMain).map((c) => {
      const entry = host.terms.get(c.id);
      return {
        id: c.id, title: host.columnLabel(c), state: entry ? (entry.alive ? entry.state || 'plain' : 'exited') : 'plain',
        folder: folders.get(c.folderId) || '', receipt: c.lastReceipt || null,
        project: c.project || '', reviews: c.reviews || [],
      };
    });
  }
  // Resolves to the response payload, or rejects with a message for the caller.
  async function handle(message, caller) {
    const s = state();
    if (!s || !caller || !isMain(caller)) throw new Error('只有队长可以用这个命令。');
    switch (message.action) {
      case 'main-stop':
      case 'main-archive': {
        const id = String(message.to || '').trim();
        const col = host.columns().find((c) => c.id === id && !c.isMain);
        if (!col) {
          if (message.action === 'main-archive' && (host.config.archived || []).some((c) => c.id === id && !c.isMain)) return { done: true, result: `会话 ${id} 已归档。` };
          throw new Error(`找不到可操作的会话：${id.slice(0, 80)}。先用 ledger 看 id；不能中断或归档队长。`);
        }
        const archive = message.action === 'main-archive';
        const entry = host.terms.get(id);
        if (!archive && (!entry || !entry.alive)) throw new Error('这个会话的终端已经退出。');
        if (!message.keepQueued) cancelSupplement(id);
        // Close cards before Esc/PTY exit so no delayed dispatch or receipt can
        // revive work that the Captain explicitly cancelled.
        s.tasks.forEach((t) => {
          if (t.colId !== id || !['queued', 'working', 'quota', 'input', 'asking'].includes(t.status) || (message.keepQueued && t.status === 'queued')) return;
          t.status = 'stopped';
          t.doneAt = Date.now();
          t.receipt = { summary: archive ? '队长已结束终端并归档。' : '队长已请求中断当前操作。', files: [], images: [], failed: '', explicit: true };
          update(t);
        });
        s.pending = s.pending.filter((p) => p.colId !== id);
        if (archive) host.archiveColumn(col, { captain: true, quiet: true });
        else window.deck.ptyInput(id, '\x1b');
        save();
        return { done: true, result: archive ? `已结束终端并归档「${host.columnLabel(col)}」(${id})。` : `已向「${host.columnLabel(col)}」(${id})发送 Esc，请求中断当前操作。` };
      }
      case 'main-ledger': {
        const archived = (host.config.archived || []).length;
        const history = M.historyText(host.config.captainHistory);
        const waiting = s.waitlist.map((w) => `「${w.title}」`).join('、');
        const crew = (host.config.archived || []).filter((a) => a.captainCrew).slice(0, 10)
          .map((a) => `${a.id}「${host.columnLabel(a)}」`).join('、');
        return { done: true, result: M.ledgerText(ledgerRows()) + (archived ? `\n（另有 ${archived} 个已归档的会话）` : '')
          + (crew ? `\n已归档的队员（tell 会先自动恢复）：${crew}` : '')
          + (waiting ? `\n排队等空位：${waiting}` : '') + (history ? '\n' + history : '') };
      }
      case 'main-receipts': {
        // A short read belonging to a timed watcher must not consume anything
        // if it was queued while the renderer was unavailable and has expired.
        if (message.wait && message.expiresAt !== undefined && (!Number.isFinite(message.expiresAt) || Date.now() >= message.expiresAt)) return { done: true, result: '' };
        if (!s.pending.length) return { done: true, result: message.wait ? '' : '没有新的回执。' };
        const text = takePending().trim();
        return { done: true, result: text || '没有新的回执。' };
      }
      case 'main-peek': {
        const col = host.columns().find((c) => c.id === message.to);
        if (!col) throw new Error('找不到运行中的会话；先用 ledger 看 id。peek 不会恢复已归档的会话。');
        const entry = host.terms.get(col.id);
        if (!entry || !entry.alive) throw new Error('这个会话的终端已退出，没有实时输出。');
        const lines = message.lines === undefined ? 40 : message.lines;
        if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Error('peek --lines 必须是 1–1000 的整数。');
        return { done: true, result: host.dumpScreen(entry.term, lines) };
      }
      case 'main-read': {
        const find = window.BoardCore.cleanText(message.find, 200);
        if (message.to === 'captain-history') {
          if (!find.trim()) throw new Error('查队长历史需要 --find 关键词，避免把所有旧对话带回上下文。');
          const turns = window.ChatUI.captainArchives().flatMap((chat) => chat.turns.map((t) => ({ ...t, sourceId: chat.id })))
            .sort((a, b) => a.ts - b.ts);
          return { done: true, result: M.readText('队长历史', turns, message.turns, find) };
        }
        const col = findTarget(message.to);
        if (col) return { done: true, result: M.readText(host.columnLabel(col), window.ChatUI.turnsOf(col.id), message.turns, find) };
        // a 队长 conversation from before a clear: only ids listed in captainHistory
        const key = String(message.to || '').trim();
        const old = (host.config.captainHistory || []).find((h) => h.id === key) || window.ChatUI.captainArchives().find((chat) => chat.id === key);
        if (!old && archivedCrew(key)) throw new Error(`「${host.columnLabel(archivedCrew(key))}」已归档。要接着用它就 tell 它（会自动恢复）；只是查结果，看它的回执就够了。`);
        if (!old) throw new Error(`找不到会话：${String(message.to).slice(0, 80)}。先用 ledger 看 id。`);
        return { done: true, result: M.readText('清空前的队长对话', window.ChatUI.turnsOf(old.id), message.turns, find) };
      }
      case 'main-new': {
        const title = window.BoardCore.cleanText(message.title, 80).replace(/\s+/g, ' ');
        const task = window.BoardCore.cleanText(message.task, 2_000_000);
        if (!title || !task) throw new Error('new 需要 --title 和 --task。');
        const existing = host.columns().find((c) => c.createdByRequestId === message.id);
        if (existing) return { done: true, result: `已开新会话 ${existing.id}「${host.columnLabel(existing)}」。` };
        const project = window.BoardCore.cleanText(message.project, 120).replace(/\s+/g, ' ');
        if (message.reviews !== undefined && (!Array.isArray(message.reviews) || !message.reviews.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)))) throw new Error('--reviews 需要会话 id 列表。');
        const reviews = [...new Set(message.reviews || [])];
        const sessions = [...host.columns(), ...(host.config.archived || [])];
        for (const id of reviews) {
          if (!sessions.some((c) => c.id === id && !c.isMain)) throw new Error(`找不到可审查的会话：${id}。先用 ledger 看 id；不能审查队长。`);
        }
        const metadata = { project, reviews };
        // Same agent as 队长 unless it asks for another one; never a silent default.
        const agent = String(message.agent || '').trim().toLowerCase();
        if (agent && !['claude', 'agy', 'antigravity', 'cursor', 'cursor-agent', 'grok', 'codex', 'gemini', 'shell'].includes(agent)) throw new Error(`不认识的 --agent：${agent.slice(0, 40)}。可用 claude、agy、cursor、grok、codex，或用 --command 写完整启动命令。`);
        const custom = window.BoardCore.cleanText(message.command, 1000);
        const checked = M.checkCommand(custom || (agent ? window.BoardCore.commandForAgent(agent) : s.cmd));
        if (checked.error) throw new Error(checked.error);
        const cmd = checked.cmd;
        const cwd = window.BoardCore.cleanText(message.cwd, 1000);
        if (s.waitlist.some((w) => w.requestId === message.id)) return { done: true, result: `「${title}」已在排队。` };
        // past the limit (or behind work already waiting): queue it, oldest first
        if (s.waitlist.length || freeSlots() <= 0) {
          await enqueue(title, cmd, cwd, message.id, task, metadata);
          return { done: true, result: `已排队：现在已经有 ${M.MAX_ACTIVE} 个会话在干活。有空位时会自动开新会话「${title}」并把任务发过去，不用再派。` };
        }
        const col = openSession(title, cmd, cwd, message.id, task, undefined, metadata);
        return { done: true, result: `已开新会话 ${col.id}「${title}」，任务会在它准备好后发过去。` };
      }
      case 'main-tell': {
        const text = window.BoardCore.cleanText(message.message, 2_000_000);
        if (!text) throw new Error('tell 需要 --message。');
        let col = findTarget(message.to);
        if (!col) {
          const old = archivedCrew(message.to);
          if (old) {
            col = host.restoreArchived(old.id, false, true);
            dispatch(col, text, host.columnLabel(col));
            return { done: true, result: `「${host.columnLabel(col)}」已归档，已恢复它并把指令发过去，它准备好后会收到。` };
          }
        }
        if (!col) throw new Error(`找不到会话：${String(message.to).slice(0, 80)}。先用 ledger 看 id。`);
        const entry = host.terms.get(col.id);
        if (entry && entry.state === 'input' && !message.now) throw new Error(`「${host.columnLabel(col)}」停在确认提示上：有把握就用 answer 回答它，没把握就请用户去那一列处理。`);
        // a bare shell with no agent to start would run the text as commands
        if (!col.cmd && !(await host.agentInForeground(col, false))) {
          throw new Error(`「${host.columnLabel(col)}」里只有 shell，没有在运行的 agent，不能把活发进去。请用 new 开一个新会话来做。`);
        }
        const busy = entry && (entry.state === 'working' || entry.state === 'quota');
        if (message.replace) cancelSupplement(col.id);
        if (message.now) {
          await handle({ action: 'main-stop', to: col.id, keepQueued: true }, caller);
        }
        dispatch(col, text, host.columnLabel(col));
        return { done: true, result: message.now ? `已请求中断「${host.columnLabel(col)}」，新指令在输入框就绪后立即送达。` : busy ? `「${host.columnLabel(col)}」正在干活，指令先放着（待补充），等它停下合并发送。` : `已发给「${host.columnLabel(col)}」(${col.id})。` };
      }
      case 'main-answer': {
        const col = findTarget(message.to);
        if (!col) throw new Error(`找不到会话：${String(message.to).slice(0, 80)}。先用 ledger 看 id。`);
        const entry = host.terms.get(col.id);
        if (!entry || entry.state !== 'input') throw new Error(`「${host.columnLabel(col)}」现在没有停在确认提示上；要给它指令用 tell。`);
        const key = String(message.key || '').trim().toLowerCase();
        const seq = { enter: '\r', esc: '\x1b', y: 'y', n: 'n' }[key] || (/^[1-9]$/.test(key) ? key : null);
        if (!seq) throw new Error('answer 的 --key 只能是 y、n、1-9、enter、esc。');
        window.deck.ptyInput(col.id, seq);
        if (seq.length === 1 && seq !== '\r' && seq !== '\x1b') setTimeout(() => window.deck.ptyInput(col.id, '\r'), 60);
        s.tasks.forEach((t) => { if (t.colId === col.id && t.status === 'input') { t.status = 'working'; t.answeredAt = Date.now(); update(t); } });
        return { done: true, result: `已替「${host.columnLabel(col)}」按了 ${key}。` };
      }
      default:
        throw new Error('未知命令。');
    }
  }

  // ---- task cards in the main session's chat ----
  const STATUS_TEXT = { waiting: '等空位', queued: '待补充', working: '干活中', quota: '额度用尽/等待', input: '停在确认', asking: '在问队长', done: '已完成', failed: '没做成', stopped: '已停下' };
  function renderCard(task, colId) {
    const card = el('div', 'task-card st-' + task.status);
    const head = el('div', 'task-head');
    const target = host.columns().find((c) => c.id === task.colId);
    const name = el('button', 'task-title', task.title);
    name.type = 'button';
    name.title = target ? '打开这个会话' : task.status === 'waiting' ? `同时最多 ${M.MAX_ACTIVE} 个会话干活，有空位就自动开` : '这个会话已经不在了';
    name.disabled = !target;
    name.addEventListener('click', () => { if (target) host.jumpToColumn(target); });
    head.append(el('span', 'task-arrow', '→'), name, el('span', 'task-status', STATUS_TEXT[task.status] || ''));
    card.appendChild(head);
    if (task.status === 'input') card.appendChild(el('div', 'task-note', '停在确认提示上，已交给队长判断；队长拿不准会来问你。'));
    if (task.status === 'queued') card.appendChild(el('div', 'task-note', '追加给还在忙的会话，等它空下来就发过去。'));
    if (task.status === 'waiting') card.appendChild(el('div', 'task-note', `同时最多 ${M.MAX_ACTIVE} 个会话干活，前面有空位就自动开会话开始做。`));
    const r = task.receipt;
    if (r && r.question) card.appendChild(el('div', 'task-summary', '提问：' + r.question));
    else if (r) {
      if (r.failed) card.appendChild(el('div', 'task-failed', r.failed));
      if (r.summary) card.appendChild(el('div', 'task-summary', r.summary));
      if (!r.explicit && !r.failed) card.appendChild(el('div', 'task-note', '这一列停下了，但没有写回执；结果以那一列为准。'));
      if (r.files && r.files.length) {
        const files = el('div', 'task-files');
        r.files.forEach((p) => files.appendChild(window.ChatUI.attachmentChip(p, task.colId)));
        card.appendChild(files);
      }
    }
    return card;
  }

  function init(h) {
    host = h;
    normalize();
    initDialog();
    if (mainCol()) brief(mainCol());
  }

  window.MainSession = {
    init, open, create, clearContext, handle, onTick, onTurnStarted, onTurnDone, outgoingPrefix, renderCard, skipsResume,
    isMain, isMainId, mainCol, state,
    history: () => host.config.captainHistory || [],
    exists: () => !!mainCol(),
  };
})();
