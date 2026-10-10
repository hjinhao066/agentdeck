// 队长 (Captain), internally the main session: one standing column that understands what you want, hands the work
// to other columns, and shows you short receipts. It never does the work in
// its own column. Its control channel is the existing capability-tokened board
// bridge: only this column's terminal holds a token that main-* commands
// accept; workers receive a separate submission-only capability.
(function () {
  'use strict';
  const M = window.MainCore;
  const nativeCaptain = (cmd) => /codex-captain-host\.js["']?(?:\s|$)/.test(cmd || '');
  const QUOTA_RESUME_CONFIRM = 15_000; // work seen this long after a quota receipt voids it
  const ACTIVE_OUTPUT_MS = 60_000;   // output this recent: not finished, whatever the status dot says
  let host = null;
  const MAX_TASKS = 120;            // cards kept in config.json; older ones drop off
  const STOP_QUIET = 3 * 60_000; // ended turns with no command receipt
  const dispatches = new Map();  // one delivery loop per session; additions merge until submission
  let tokenSaving = null;
  let tokenSaverPaused = false;  // cancel/failure: no retry until usage falls below the threshold
  let contextReset = null;
  let mobileDelivery = null;
  let listenerStatus = null;
  let listenerReminder = false;
  let listenerReminderSending = false;

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // config.mainSession = { colId, cmd, gen, pending: [receipt], inflight: [receipt], receiptsSeen: [id], tasks: [task], fresh, crewMarked, waitlist }
  // inflight: receipts already handed to 队长 whose turn has not finished yet.
  // A receipt the background channel returned carries viaChannel itself (and takenAt),
  // saved with the rest of mainSession, so a relaunch or Relay neither delivers it
  // again nor loses it. Legacy injection never sets the mark.
  // receiptsSeen: the last ids the channel returned. Only read for receipts an older
  // version took, which have no mark. It is trimmed, so nothing still in flight may
  // depend on it.
  // fresh: the context was cleared and 队长 has not finished a turn since.
  // crewMarked: sessions opened before captainCrew existed were marked once.
  // waitlist: `new` requests waiting for a free slot (settings cap, live on M.MAX_ACTIVE), oldest first;
  // each has a 'waiting' card with no column yet.
  // captainSettledAt: when the last stretch of work 队长 finished began. A receipt
  // the CLI took after that has no sign of being dealt with.
  // handoffCarry: such receipts at the last Relay or restart, { at, kind, fromId, items };
  // they are never delivered again, the handoff lists them until the next Relay.
  // Never trimmed: a receipt dropped here is a result nobody will ever see.
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
  // ---- 小队长 (sub-captain) ----
  // A background session the Captain opened with `new --sub-captain` (column.subCaptain).
  // Sessions it opens with create-child carry column.subCaptainId = its column id. Their
  // receipts, questions and prompts wait in s.subReceipts[its id] for its own `receipts`,
  // never in the Captain's pending. Its terminal holds a control token, but only the
  // commands in SUB_ACTIONS, and only on its own children, are accepted from it.
  // Only the Captain's `new --sub-captain` sets the flag; filing the session into a folder keeps the role.
  const isSubCaptain = (col) => !!(col && col.subCaptain === true && !col.isMain && host.columns().includes(col));
  function subCaptainOf(col) {
    if (!col || !col.subCaptainId) return null;
    const sub = host.columns().find((c) => c.id === col.subCaptainId);
    return isSubCaptain(sub) ? sub : null;
  }
  const childrenOf = (sub) => host.columns().filter((c) => c.subCaptainId === sub.id && !c.isMain);
  function subQueue(s, id) {
    if (!s.subReceipts || typeof s.subReceipts !== 'object') s.subReceipts = {};
    if (!Array.isArray(s.subReceipts[id])) s.subReceipts[id] = [];
    return s.subReceipts[id];
  }
  const allPending = (s) => [...s.pending, ...Object.values(s.subReceipts || {}).flat()];
  // Take receipts out wherever they wait: the Captain's pending or a sub-captain's.
  function dropReceipts(s, drop) {
    s.pending = s.pending.filter((p) => !drop(p));
    for (const id of Object.keys(s.subReceipts || {})) s.subReceipts[id] = s.subReceipts[id].filter((p) => !drop(p));
  }
  function save() { host.saveConfig(); }
  function persistInstallation() {
    host.flushConfig?.();
    if (typeof window.deck.saveConfigSync !== 'function' || !window.deck.saveConfigSync(host.config)) throw new Error('安装状态无法持久保存，禁止继续安装。');
  }

  // Unread Todo receipts outlive the Captain column. Accepted is not delivered:
  // the consuming channel, native ack or a finished legacy turn confirms delivery.
  const todoReceiptKey = (id) => typeof id === 'string' && /^todo-(?:error-|change-)?[a-f0-9]{64}$/.test(id);
  function normalizeTodoInbox() {
    const raw = host.config.todoInbox;
    host.config.todoInbox = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter(([id, item]) => item && todoReceiptKey(item.taskId) && id === 'r-' + item.taskId && typeof item.summary === 'string')) : {};
    const s = state();
    // Upgrade the previous acceptance-only index while the unread text exists.
    for (const item of Array.isArray(s?.pending) ? s.pending : []) {
      if (!todoReceiptKey(item.taskId) || item.receiptId !== 'r-' + item.taskId) continue;
      host.config.todoInbox[item.receiptId] = item;
      if (host.config.todoDeliveries) delete host.config.todoDeliveries[item.taskId];
    }
  }
  function restoreTodoInbox() {
    const s = state();
    if (!s) return;
    const present = new Set([...s.pending, ...s.inflight].map((item) => item.receiptId));
    for (const item of Object.values(host.config.todoInbox || {})) {
      if (!present.has(item.receiptId)) { s.pending.push({ ...item, colId: s.colId }); present.add(item.receiptId); }
    }
  }
  function confirmTodoReceipts(items) {
    const inbox = { ...(host.config.todoInbox || {}) }, accepted = { ...(host.config.todoDeliveries || {}) };
    let changed = false;
    for (const item of items) {
      if (!inbox[item.receiptId]) continue;
      delete inbox[item.receiptId]; accepted[item.taskId] = true; changed = true;
    }
    if (changed) { host.config.todoInbox = inbox; host.config.todoDeliveries = accepted; }
    return changed;
  }
  function persistTodoInbox() {
    save(); host.flushConfig?.();
    if (typeof window.deck.saveConfigSync !== 'function' || !window.deck.saveConfigSync(host.config)) throw new Error('Todo 回执未能持久保存，请稍后重试。');
  }

  function boardNotice(message) {
    const s = state();
    if (!s) throw new Error('请先创建队长，再开始卡片。');
    s.pending.push({ taskId: 'board-' + Date.now(), colId: s.colId, title: '任务看板', ts: Date.now(), summary: message, source: 'command' });
    save();
  }
  // 待我处理: the user's reply to an item, or a tick on something 队长 asked of
  // them, reaches 队长 as one receipt. Returns its id, so the page can tell
  // when 队长 has taken it off the channel.
  function userNotice(message) {
    const s = state();
    if (!s || !mainCol()) throw new Error('还没有队长：回复要交给队长，先在侧边栏创建队长。');
    const taskId = 'attention-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    s.pending.push({ taskId, colId: s.colId, title: '待我处理', ts: Date.now(), summary: message, source: 'command' });
    save();
    return taskId;
  }
  // 自动回执入口: what a scheduled script on this computer may do, and nothing else.
  // main.js already checked the token, the allowed fields and the rate; these
  // commands have no calling session (callerId is empty), cannot hand out work
  // and are never shown as the user's words.
  async function automation(message) {
    const from = message && message.automation;
    if (!from || message.callerId || typeof from.source !== 'string' || from.label !== '自动任务：' + from.source) throw new Error('自动回执：来源无效。');
    const s = state();
    if (message.action === 'automation-receipt') {
      if (!s || !mainCol()) throw new Error('队长还没创建或启动，这条自动回执没有送达。');
      const taskId = 'auto-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      s.pending.push({ taskId, colId: s.colId, title: from.label, ts: Date.now(), summary: String(message.message || ''), source: 'command', automation: from.source });
      save();
      return { done: true, result: '已交给队长：' + from.label + '。' };
    }
    if (message.action === 'automation-task-add') {
      // Always a plain 待办 card; the board starts nothing from there.
      const detail = '【' + from.label + '】本机定时脚本经自动回执入口登记，不是用户本人建的。' + (message.detail ? '\n\n' + message.detail : '');
      const { card } = await boardRequest('add', { project: message.project, title: message.title, detail });
      return { done: true, result: '已建卡 ' + card.id + '（项目 ' + card.project + '，待办，没有开始做）。' };
    }
    if (message.action === 'automation-inbox-report') return window.AttentionUI.automation(message);
    throw new Error('自动回执入口不支持这个命令。');
  }
  async function boardRequest(op, input) {
    const result = await window.deck.taskBoard(op, input);
    if (op === 'move' && ['done', 'todo', 'needs_user'].includes(result.card?.status)) cancelWaiting((w) => w.metadata?.boardId === result.card.id, '卡片已移到' + result.card.status + '，取消排队。');
    for (const notice of result.notices || []) boardNotice(notice);
    return result;
  }
  // ---- 高优先级 ----
  // The user named this work as urgent. With a card, the card's `important` flag
  // is the one record (read from the board, so a change made on the other machine
  // counts too); every session on that card shows the mark: executor, reviewer,
  // queued request. Work handed out without a card carries the flag on its own
  // dispatch record (and on its queue entry while it waits): the mark belongs to
  // that piece of work, never to the session, so the next thing the session is
  // told does not inherit it once the marked work is done. A session's own
  // `important` is only a mark set while it has no unfinished work; the next
  // piece of work it is given takes it over (addTask).
  let highCards = new Set();
  const cardIdOf = (x) => x?.boardId || x?.metadata?.boardId || '';
  function isHigh(x) {
    return !!x && (x.important === true || x.metadata?.important === true || highCards.has(cardIdOf(x)));
  }
  // Whether a session wears the mark: its newest piece of work is unfinished and
  // marked (itself, or through its card). With no unfinished work, only a mark
  // put on the session since then counts.
  function sessionHigh(col) {
    if (!col || col.isMain) return false;
    const last = state()?.tasks.findLast((t) => t.colId === col.id);
    if (!last) return isHigh(col);
    if (last.status === 'done') return col.important === true;
    return last.important === true || highCards.has(last.boardId || col.boardId || '');
  }
  function priorityChanged() {
    const s = state();
    if (s && Array.isArray(s.waitlist)) {
      const sorted = M.highFirst(s.waitlist, isHigh);
      if (sorted.some((w, i) => w !== s.waitlist[i])) { s.waitlist = sorted; save(); refreshWaitingNotes(); pump(); }
    }
    window.Sidebar?.render?.();
  }
  async function refreshPriority() {
    let list;
    try { list = await window.TaskBoard.list(); } catch (_) { return; }
    const next = new Set((Array.isArray(list) ? list : []).filter((c) => c.important === true && c.status !== 'done').map((c) => c.id));
    if (next.size === highCards.size && [...next].every((id) => highCards.has(id))) return;
    highCards = next;
    priorityChanged();
  }
  // `task priority`, and the user's own click on a card or a session. id: a card,
  // a session, or a queued request. byUser: marking a card nobody has started
  // tells 队长 once, since the mark means "start this now".
  async function setPriority(id, level, byUser = false) {
    if (!['high', 'normal'].includes(level)) throw new Error('优先级只能是 high 或 normal。');
    const s = state();
    const key = String(id || '').trim();
    const high = level === 'high', word = high ? '标为高优先级' : '改回普通优先级';
    const col = host.columns().find((c) => c.id === key && !c.isMain);
    const waiting = s?.waitlist?.find((w) => w.taskId === key);
    const cardId = cardIdOf(col) || cardIdOf(waiting) || key;
    const card = /^[A-Za-z0-9_-]{1,160}$/.test(cardId) ? (await window.TaskBoard.list({ archived: true })).find((c) => c.id === cardId) : null;
    if (card) {
      await boardRequest('priority', { id: card.id, level });
      await refreshPriority();
      if (byUser && high && card.important !== true && card.status === 'todo' && !card.archived && mainCol()) {
        boardNotice(`用户在任务看板把卡片 ${card.id}「${card.title}」标为高优先级（项目：${card.project}），它还没开始做，请立刻安排。`);
      }
      return `已把卡片 ${card.id}「${card.title}」${word}。`;
    }
    if (!col && !waiting) throw new Error(`找不到卡片或会话：${key.slice(0, 80)}。先用 task list 或 ledger 看 id。`);
    const mark = (x) => { if (high) x.important = true; else delete x.important; };
    if (col) {
      // unfinished work carries the mark itself; an idle session holds it for its next piece of work
      const last = s?.tasks.findLast((t) => t.colId === col.id);
      if (last && last.status !== 'done') { mark(last); delete col.important; }
      else mark(col);
    }
    if (waiting) {
      waiting.metadata = { ...(waiting.metadata || {}) };
      mark(waiting.metadata);
      const task = s.tasks.find((t) => t.id === waiting.taskId);
      if (task) mark(task);
    }
    save();
    priorityChanged();
    return `已把${col ? `会话 ${col.id}「${host.columnLabel(col)}」` : `排队中的「${waiting.title}」`}${word}。`;
  }
  // ---- 马上派人做 / 排到最前 (the two buttons on a card, desktop and phone) ----
  // 马上派人做 asks 队长 to put a worker on the card now. It goes the way a 待办 handed
  // to 队长 goes: one line on the receipts channel (receipts --wait), never typed into
  // 队长's box. The request is recorded on the card first; with no 队长 on this computer
  // it waits there and is handed over once one exists (create, init, a board change).
  // 队长 answers with `new --task-id`, which clears it (task-board.js bind).
  const dispatchWords = (card) => `用户要求马上派：${card.title}（${card.id}）。项目：${card.project}。` +
    `请读这张卡（task list），用 new --task-id ${card.id} --project ${JSON.stringify(card.project)} 派一个队员；已经派了就回一句派给了谁。`;
  const handingOver = new Set();
  async function handOverDispatch(card) {
    const key = card.id + '\n' + card.dispatch_now.at;
    if (handingOver.has(key) || !mainCol()) return false;
    handingOver.add(key);
    try {
      // marked first, under the board lock: two calls never both tell 队长
      const marked = await boardRequest('dispatchNowDelivered', { id: card.id, at: card.dispatch_now.at });
      if (marked.ignored) return false;
      boardNotice(dispatchWords(marked.card));
      return true;
    } finally { handingOver.delete(key); }
  }
  let dispatchSweep = null;
  function deliverWaitingDispatch() {
    if (!mainCol() || dispatchSweep) return dispatchSweep;
    dispatchSweep = (async () => {
      try {
        // a plain read first: only a board holding an undelivered request asks which are this computer's
        const all = await window.deck.taskBoard('list', {});
        if (!Array.isArray(all) || !all.some((c) => c && c.dispatch_now && c.dispatch_now.delivered !== true)) return;
        for (const card of await window.deck.taskBoard('dispatchNowWaiting', {})) await handOverDispatch(card);
      }
      catch (_) { /* the next board change or start tries again */ }
      finally { dispatchSweep = null; }
    })();
    return dispatchSweep;
  }
  // outcome: 'delivered' (队长 has it), 'waiting' (no 队长 here yet) or 'pending' (asked before, still waiting).
  async function dispatchNow(id) {
    const result = await boardRequest('dispatchNow', { id: String(id || '') });
    if (result.ignored) return { card: result.card, outcome: 'pending' };
    if (!mainCol()) return { card: result.card, outcome: 'waiting' };
    await handOverDispatch(result.card);
    return { card: result.card, outcome: 'delivered' };
  }
  // 排到最前: 高优先级 + first in its project + the one 下一个做 card. 队长 hears of it
  // once, so the next worker it sends goes to this card.
  async function nextUp(id) {
    const before = (await window.TaskBoard.list({ archived: true })).find((c) => c.id === id);
    const { card } = await boardRequest('nextUp', { id: String(id || '') });
    await refreshPriority();
    if (before && !before.next_up && mainCol()) {
      boardNotice(`用户在任务看板把卡片 ${card.id}「${card.title}」排到了最前（项目：${card.project}）：它是下一个要做的，有空位就先派它，排在其他待办前面。`);
    }
    return { card, outcome: 'next' };
  }
  // The phone's two actions (mobile-web.js POST api/tasks), through the same code as a click.
  function boardAction(input) {
    if (input?.op === 'dispatch-now') return dispatchNow(input.id);
    if (input?.op === 'next-up') return nextUp(input.id);
    throw new Error('看板操作无效。');
  }
  let boardWrites = Promise.resolve();
  function boardEvent(task, type, message = '', source = '', files) {
    if (!task.boardId) return Promise.resolve();
    const input = { id: task.boardId, session_id: task.colId, attempt_id: task.boardAttempt, type, message, source, ...(files?.length ? { files } : {}) };
    const write = boardWrites.catch(() => {}).then(() => window.deck.taskBoard('event', input)).then((result) => {
      // The normal receipt already carries the complete failure reason. Only
      // the extra no-retry decision needs a separate board notice.
      if (result.card?.flag === 'held' && !result.ignored) boardNotice(`卡片 ${task.boardId} 连续失败 2 次，已挂起，不再自动重试。`);
      return result;
    });
    boardWrites = write;
    return write;
  }
  function autoBoardEvent(task, type, message = '', source = '') {
    if (!task.boardId) return;
    const event = { type, message, source };
    task.pendingBoardEvent = event;
    boardEvent(task, type, message, source).then(() => {
      if (task.pendingBoardEvent === event) { delete task.pendingBoardEvent; save(); }
    }, (error) => host.showToast('看板写入失败，稍后重试：' + error.message));
  }
  function receiptBoardEvent(task, receipt) {
    return boardEvent(task, receipt.failed ? 'failed' : receipt.question ? 'ask' : receipt.source === 'fallback' ? 'fallback' : 'complete', receipt.failed || receipt.question || receipt.summary, receipt.source || 'automatic', receipt.files);
  }
  async function recordReceiptForBoard(task, receipt) {
    try { await receiptBoardEvent(task, receipt); }
    catch (error) {
      // A git conflict must not swallow an authenticated worker receipt. Keep
      // the transition in private config and retry when the shared file recovers.
      task.pendingBoardEvent = { type: receipt.failed ? 'failed' : receipt.question ? 'ask' : 'complete', message: receipt.failed || receipt.question || receipt.summary, source: receipt.source || 'automatic', files: receipt.files };
      boardNotice(`卡片 ${task.boardId} 的回执已收到；看板写入待重试：${error.message}`);
      save();
    }
  }
  function retryBoardWrites(s) {
    for (const task of s.tasks) {
      if (!task.pendingBoardEvent || task.boardRetrying) continue;
      task.boardRetrying = true;
      const e = task.pendingBoardEvent;
      boardEvent(task, e.type, e.message, e.source, e.files).then(() => { if (task.pendingBoardEvent === e) delete task.pendingBoardEvent; }, () => {}).finally(() => { delete task.boardRetrying; save(); });
    }
  }
  // Serialize queue decisions and opening so two new requests cannot both claim
  // the last slot, or race a cancellation against an in-flight board bind.
  let queueWrites = Promise.resolve();
  function withQueue(run) {
    const result = queueWrites.then(run);
    queueWrites = result.catch(() => {});
    return result;
  }
  const startingCards = new Map();
  const quotaStarts = new Map();
  const commandQuota = (cmd, seatId) => window.QuotaCore.commandQuota(host.config.quotas, cmd, host.config.claudeSeats, seatId || host.config.activeClaudeSeatId);
  function quotaPlan(cmd, seatId, explicit) {
    const plan = window.QuotaCore.quotaFallback(host.config.quotas, cmd, host.config.claudeSeats, seatId || host.config.activeClaudeSeatId, Date.now(), { explicit: !!explicit });
    if (plan.action !== 'switch') return plan;
    const checked = M.checkCommand(plan.cmd);
    return checked.error || !checked.cmd ? { ...plan, action: 'queue', reason: 'out', held: 'out', note: '', cmd: plan.cmd } : { ...plan, cmd: checked.cmd };
  }
  // Claude seats an automatic chooser (the reviewer of a --verify card, the board's dispatcher) may
  // use, in the order a new session would take them: the active seat first. A seat that is signed
  // out is left out; one whose login cannot be read stays, and its quota reading decides.
  // The seats handed to the quota reading carry each seat's login and credential (`info`), the same
  // ClaudeSeats.described list `quota` and the sidebar use, with the seat list just fetched laid over it: a seat
  // whose stored credential is damaged or expired reads as `error`, never as room, and never as the unverified fallback.
  let seatsForQuota = null, lastSeatChoices = null;
  // How a seat is named in any sentence (a review reason, a notice): the account signed in behind its directory, the part
  // of the e-mail before the @ (the user's rule of 2026-10-08), never the fixed seat name or its flag. A directory nobody is
  // known to be signed in at reads 未登录. The seat code stays in `--seat` and the hover text.
  const seatLabel = (seat, info) => window.ClaudeSeatsCore?.seatDisplay ? window.ClaudeSeatsCore.seatDisplay(seat, { loggedIn: false, ...(info || {}) }).label : '账号未识别';
  async function claudeSeatChoices() {
    const seats = window.QuotaCore.claudeSeats ? window.QuotaCore.claudeSeats(host.config.claudeSeats) : [];
    let infos = [];
    try { infos = (await window.deck.claudeSeats?.()) || []; } catch (_) {}
    const raw = Array.isArray(host.config.claudeSeats) ? host.config.claudeSeats : [];
    const described = window.ClaudeSeats?.described ? window.ClaudeSeats.described(raw) : raw;
    seatsForQuota = infos.length ? raw.map((s) => ({ ...s, info: infos.find((i) => i.id === s.id) || described.find((d) => d.id === s.id)?.info })) : described;
    const active = host.config.activeClaudeSeatId;
    lastSeatChoices = seats.filter((s) => infos.find((i) => i.id === s.id)?.loggedIn !== false)
      .map((s) => ({ id: s.id, label: seatLabel(s, seatsForQuota.find((x) => x.id === s.id)?.info), configDir: s.configDir }))
      .sort((a, b) => (b.id === active) - (a.id === active));
    return lastSeatChoices;
  }
  // The same passive reading as the `quota` command (QuotaCore.commandStance): out, error and
  // unknown (old or missing) are never taken for "has quota".
  const commandStance = (cmd, seatId) => window.QuotaCore.commandStance(host.config.quotas, cmd, seatsForQuota && seatsForQuota.length ? seatsForQuota : host.config.claudeSeats, seatId || host.config.activeClaudeSeatId);
  // Is there a dispatcher the start could open on right now? The very question startCard asks (pickDispatcher over the same
  // readings), answered without touching the board: the quota retry below asks it every heartbeat.
  function dispatcherReady() {
    const AV = window.AutoVerifyCore;
    const seats = lastSeatChoices || (window.QuotaCore.claudeSeats ? window.QuotaCore.claudeSeats(host.config.claudeSeats).map((x) => ({ id: x.id, label: seatLabel(x, x.info), configDir: x.configDir })) : []);
    return !!AV.pickDispatcher({ commandOf: (c) => c.command || window.BoardCore.commandForAgent(c.agent), seats, stanceOf: commandStance }).cmd;
  }
  // A test instance never lets an automatic opener (the board's dispatcher, the auto reviewer) start a real model.
  const testRefusal = (cmd, what) => (host.testInstance ? window.AutoVerifyCore.testInstanceRefusal(cmd, what) : '');
  // A seat other than the one a new session defaults to travels with the session, as `new --seat` does.
  const seatMeta = (seat) => seat && seat.id !== host.config.activeClaudeSeatId ? { claudeSeatId: seat.id, claudeConfigDir: seat.configDir } : {};
  function notedTitle(title, note) { return window.QuotaCore.quotaFallbackTitle(title, note); }
  function launchMeta(metadata, plan) {
    const meta = { ...(metadata || {}) };
    delete meta.quotaExplicit;
    if (plan.action === 'switch' && plan.provider !== 'Claude') { delete meta.claudeSeatId; delete meta.claudeConfigDir; }
    return meta;
  }
  function announceSwitch(col, title, plan) {
    if (plan.action === 'switch') boardNotice(`会话 ${col.id}「${title}」。${plan.note}。`);
  }
  // Automatic reviewers are already chosen for family and remaining quota.
  // A fully exhausted pool still waits; a low pool must not swap that reviewer.
  function openPlan(cmd, seatId, explicit, metadata) {
    if (metadata?.executor === 'chatgpt-web') return { action: 'open', cmd, note: '' };
    // a Claude Code reviewer (automatic, or the Captain's own new --reviews): low quota still opens on Claude, out waits, never another provider
    if (metadata?.autoReviewRound || (metadata?.reviews?.length && window.AutoVerifyCore?.isClaudeCommand(cmd))) {
      return commandQuota(cmd, seatId)?.out
        ? { action: 'queue', cmd, reason: 'out', held: 'out', note: '' }
        : { action: 'open', cmd, note: '' };
    }
    return quotaPlan(cmd, seatId, explicit);
  }
  function quotaQueueText(plan, title, dispatch = false) {
    if (plan.reason === 'explicit') {
      const why = plan.held === 'low' ? '5 小时额度低于阈值' : '额度用尽';
      return `已排队：${plan.note}。${why}，稍后自动开${dispatch ? '调度会话' : `新会话「${title}」`}。`;
    }
    return dispatch ? '已排队：额度用尽，稍后自动开调度会话。' : `已排队：额度用尽，稍后自动开新会话「${title}」。`;
  }
  // `notice(card)`: the words for 队长 when the user asked for the start on the
  // task board itself; such a start never opens a dispatcher session.
  async function startCard(id, heartbeat, notice) {
    if (startingCards.has(id)) return startingCards.get(id);
    const start = startCardOnce(id, heartbeat, notice);
    startingCards.set(id, start);
    try { return await start; } finally { startingCards.delete(id); }
  }
  async function startCardOnce(id, heartbeat, notice) {
    if (!mainCol()) throw new Error('请先创建队长，再开始卡片。');
    const claimed = heartbeat
      ? { card: (await window.TaskBoard.list()).find((c) => c.id === id) }
      : await boardRequest('claim', { id, ...(notice ? { newEntry: true } : {}) });
    if (claimed.ignored) return { card: claimed.card, ignored: true, occupied: claimed.occupied };
    if (!claimed.card || !claimed.card.dispatch_claim || claimed.card.dispatch_claim.delivered || heartbeat && claimed.card.dispatch_claim.key !== heartbeat.key) return { ignored: true };
    const key = claimed.card.dispatch_claim.key;
    if (state()?.waitlist.some((w) => w.metadata?.boardId === id)) {
      await boardRequest('dispatched', { id, key }); quotaStarts.delete(id);
      return { card: claimed.card, ignored: true };
    }
    const { card, captain, ignored } = await boardRequest('dispatch', { id, key });
    if (ignored) { await boardRequest('dispatched', { id, key }); quotaStarts.delete(id); return { card, ignored: true }; }
    if (notice) { boardNotice(notice(card)); await boardRequest('dispatched', { id, key }); return { card, dispatcher: 'captain' }; }
    if (window.TaskBoard.settings().dispatcher !== 'gemini' || captain) {
      boardNotice(`用户要开始卡片 ${card.id}「${card.title}」${captain ? '（需要队长判断）' : ''}。项目：${card.project}。`);
      await boardRequest('dispatched', { id, key });
      return { card, dispatcher: 'captain' };
    }
    if (freeSlots() <= 0) { boardNotice(`用户要开始卡片 ${card.id}「${card.title}」，调度会话无空位，请队长安排。`); await boardRequest('dispatched', { id, key }); return { card, dispatcher: 'captain' }; }
    // Gemini only while a fresh reading says it has room; out, stale or erroring: a Claude Haiku
    // session. When nothing is usable the Claude one is still the choice, and the ordinary quota
    // queue below holds it until the account has room again.
    const AV = window.AutoVerifyCore;
    const seats = await claudeSeatChoices();
    const picked = AV.pickDispatcher({ commandOf: (c) => c.command || window.BoardCore.commandForAgent(c.agent), seats, stanceOf: commandStance });
    if (picked.reason && picked.allError) {
      boardNotice(`用户要开始卡片 ${card.id}「${card.title}」，调度会话没有开：Claude 各席位的登录或额度查询都出错（${picked.reason}），请队长安排。`);
      await boardRequest('dispatched', { id, key }); quotaStarts.delete(id);
      return { card, dispatcher: 'captain' };
    }
    const fallback = AV.DISPATCHERS.find((c) => c.command);
    // Nothing usable now: the Haiku waits on a seat whose login is not damaged (never the active one when that is the
    // damaged one), and starts there when its quota returns.
    const choice = picked.cmd ? picked : { candidate: fallback, cmd: fallback.command, seat: picked.fallbackSeat || null };
    const checkedDispatcher = M.checkCommand(choice.cmd);
    if (checkedDispatcher.error) { boardNotice(`用户要开始卡片 ${card.id}「${card.title}」，调度会话的命令不能用（${checkedDispatcher.error}），请队长安排。`); await boardRequest('dispatched', { id, key }); return { card, dispatcher: 'captain' }; }
    const cmd = checkedDispatcher.cmd;
    const seatInfo = seatMeta(choice.seat);
    const planned = quotaPlan(cmd, seatInfo.claudeSeatId);
    // The chooser found every undamaged seat without room: a plan that would open anyway (the general quota reading is
    // laxer than the chooser's) still waits, as "all exhausted".
    const plan = !picked.cmd && picked.fallbackSeat && planned.action === 'open' ? { ...planned, action: 'queue', reason: 'out', held: 'out' } : planned;
    if (plan.action === 'queue') {
      const waiting = await boardRequest('dispatchWait', { id, key, message: picked.reason ? `${quotaQueueText(plan, card.title, true)}（${picked.reason}）` : quotaQueueText(plan, card.title, true) });
      if (!waiting.ignored) quotaStarts.set(id, { id, key });
      return { card: waiting.card, queued: true };
    }
    // what would really launch (a same-tier switch may have changed the command) must be a stand-in in a test instance
    const refused = testRefusal(plan.cmd, '调度员');
    if (refused) { boardNotice(`用户要开始卡片 ${card.id}「${card.title}」，调度会话没有开：${refused}。`); await boardRequest('dispatched', { id, key }); quotaStarts.delete(id); return { card, dispatcher: 'captain', refused }; }
    quotaStarts.delete(id);
    const sessionId = 'c-dispatch-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const reserved = await boardRequest('dispatch', { id, key, session_id: sessionId });
    if (reserved.ignored) return { card: reserved.card, ignored: true };
    const cli = M.boardCli(host.platform);
    const prompt = M.dispatcherInstructions(host.platform, card);
    // The title names what really runs (the card's own title may end with the executor's make).
    const plain = AV.reviewTitle(card.title, plan.action === 'switch' ? plan.to : choice.candidate.label, 120, '调度：');
    const title = plan.action === 'switch' ? notedTitle(plain, plan.note) : plain;
    const col = host.createSession({ id: sessionId, title, displayTitle: title, cmd: plan.cmd, captainCrew: true, project: card.project, dispatcherCardId: id, ...(plan.action === 'switch' && plan.provider !== 'Claude' ? {} : seatInfo) }, true);
    if (plan.action === 'switch') announceSwitch(col, title, plan);
    dispatch(col, prompt + `\n整理后用 ${cli} new --task-id ${id} --project ${JSON.stringify(card.project)} --title "标题" --task "整理后的任务" --agent … 派出去，然后 complete 说明派给谁。拿不准就 ask 交队长。`, title);
    await boardRequest('dispatched', { id, key });
    return { card, dispatcher: 'gemini', session_id: col.id };
  }
  // The user's answer to a 需要你 card goes to 队长 as an instruction naming the
  // card, and the card returns to 进行中: a session still bound to it keeps its
  // binding (队长 passes the answer on); otherwise the start is claimed for 队长
  // so the heartbeat does not hand the card to a dispatcher as well.
  async function answer(id, reply) {
    const text = String(reply || '').trim();
    if (!text) throw new Error('请先写下你的答案。');
    if (!mainCol()) throw new Error('请先创建队长，再回答卡片。');
    const card = (await window.TaskBoard.list({ archived: true })).find((c) => c.id === id);
    if (!card) throw new Error('这张卡片已经不在看板上了。');
    const question = window.TaskBoardUICore.userQuestion(card);
    const words = (c) => `用户在任务看板回答了卡片 ${c.id}「${c.title}」（项目：${c.project}）。${question ? '问题：' + question + '\n' : ''}用户的答案：${text}\n请按这个答案继续推进这张卡片。`;
    if (card.status !== 'needs_user') { boardNotice(words(card)); return { card }; }
    if (card.session_id && !card.attempt_closed) {
      boardNotice(words(card));
      return boardRequest('event', { id, session_id: card.session_id, attempt_id: card.attempt_id, type: 'started', source: 'answer-' + Date.now() });
    }
    try {
      const started = await startCard(id, undefined, words);
      if (started.ignored) boardNotice(words(card));
      return started;
    } catch (error) { boardNotice(words(card)); return { card, stayed: error.message }; }
  }
  window.TaskBoard = {
    onChange: (callback) => window.deck.onTasksChanged(callback),
    list: (filter = {}) => window.deck.taskBoard('list', filter),
    add: (input) => boardRequest('add', input),
    update: (id, patch, updated) => boardRequest('update', { id, patch, updated }),
    move: (id, status, updated) => withQueue(() => boardRequest('move', { id, status, updated })),
    archiveDone: (project) => boardRequest('archive', { done: true, ...(project ? { project } : {}) }),
    startCard,
    reorder: (id, anchor = {}) => boardRequest('reorder', { id, ...anchor }),
    // Dragging into 进行中 uses the same routing and claims as an explicit start.
    requestStart: (id) => startCard(id),
    answer,
    // The user's own click: mark a card 高优先级 or ordinary again.
    setPriority: (id, level) => setPriority(id, level, true),
    // 马上派人做 / 排到最前: { card, outcome }
    dispatchNow, nextUp,
    settings: (dispatcher) => {
      if (dispatcher !== undefined) {
        if (!['captain', 'gemini'].includes(dispatcher)) throw new Error('dispatcher must be captain or gemini.');
        host.config.taskBoard = { ...host.config.taskBoard, dispatcher }; save();
      }
      return { dispatcher: host.config.taskBoard?.dispatcher || 'gemini' };
    },
    // The switch for automatic verification (on unless turned off). The main-process
    // heartbeat reads it from config.json, so write it out at once.
    autoVerify: (enabled) => {
      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') throw new Error('autoVerify must be boolean.');
        host.config.taskBoard = { ...host.config.taskBoard, autoVerify: enabled }; save(); host.flushConfig?.();
      }
      return host.config.taskBoard?.autoVerify !== false;
    },
  };
  window.deck.onTaskStart((input) => {
    if (mainCol()) startCard(input.id, input).catch((error) => host.showToast('看板调度暂未发出：' + error.message));
  });

  // ---- automatic verification ----
  // The main-process heartbeat claims each review round once and writes it down.
  // These turn the claim into a reviewer session (through the same queue and
  // limits as any `new`) and a rejection into a message to the original executor.
  // Both can run again after a restart: attempt ids are fixed per card and round,
  // and every step first checks whether it already happened.
  const verifyRuns = new Map();
  const verifyFailures = new Map();
  function runVerify(kind, id, input, once) {
    const key = kind + id;
    if (verifyRuns.has(key)) return verifyRuns.get(key);
    const run = once(id, input);
    verifyRuns.set(key, run);
    return run.finally(() => verifyRuns.delete(key));
  }
  const findCard = async (id) => (await window.TaskBoard.list({ archived: true })).find((c) => c.id === id);
  const sessionById = (id) => [...host.columns(), ...(host.config.archived || [])].find((c) => c.id === id && !c.isMain);
  async function startReviewOnce(id, input) {
    if (!mainCol()) return { ignored: true };
    const s = state();
    const card = await findCard(id);
    const claim = card?.review_claim;
    if (!card || !claim || claim.key !== input.key || claim.delivered) return { ignored: true };
    const AV = window.AutoVerifyCore;
    const attempt = AV.reviewAttemptId(id, claim.round);
    // Somebody already has this round: a reviewer is bound, queued or opened, or the card moved on.
    if (card.status !== 'review' || card.review_round !== claim.round || card.review_session === true ||
      s.waitlist.some((w) => w.metadata?.boardId === id) || [...host.columns(), ...(host.config.archived || [])].some((c) => c.boardId === id && c.boardAttempt === attempt)) {
      await boardRequest('reviewDispatched', { id, key: input.key });
      return { card, ignored: true };
    }
    // A fresh Claude session of its own (user's rule of 2026-10-09): Opus 5.5, Sonnet 5.5 for a simple
    // card, on the first seat whose quota reading says there is room. Nothing usable: the card stays in
    // review with the reason and the Captain is told (reviewBlocked), never left waiting on a dead reviewer.
    const seats = await claudeSeatChoices();
    const picked = AV.pickReviewer({ card, receipt: card.exec_receipt, candidates: AV.CANDIDATES, seats, stanceOf: commandStance });
    const checked = picked.cmd ? M.checkCommand(picked.cmd) : null;
    if (!picked.cmd || checked.error) {
      await boardRequest('reviewBlocked', { id, key: input.key, reason: picked.reason || checked.error });
      return { card, blocked: true };
    }
    const refused = testRefusal(checked.cmd, '自动审查');
    if (refused) {
      await boardRequest('reviewBlocked', { id, key: input.key, reason: refused });
      return { card, blocked: true, refused };
    }
    const executor = sessionById(card.exec_receipt?.session_id);
    // the title says what really runs, not what the executor's card title was labelled
    const title = AV.reviewTitle(window.BoardCore.cleanText(card.title, 200), picked.candidate.label).replace(/\s+/g, ' ');
    const metadata = { project: card.project, reviews: executor ? [executor.id] : [], boardId: id, autoReviewRound: claim.round, cardTitle: card.title, ...seatMeta(picked.seat) };
    if (executor?.trustedCwd && executor.trustedCwd === executor.cwd) {
      metadata.trustedCwd = executor.trustedCwd;
      // Claude's "trust this folder" answer is recorded per seat: the executor's seat has it for this copy, the seat that
      // reviews may not. Record it for the chosen seat before the session opens, as the copy's own seat got it.
      if (picked.seat && window.deck.trustWorktree) {
        const trust = await window.deck.trustWorktree({ seatId: picked.seat.id, configDir: picked.seat.configDir, path: executor.cwd }).catch((error) => ({ ok: false, reason: error.message }));
        if (!trust?.ok) boardNotice(`卡片 ${id}「${card.title}」的审查会话在代码副本 ${executor.cwd} 里没能预先登记 Claude 的文件夹信任（${trust?.reason || '未知原因'}）。会话若停在「是否信任此文件夹」，用 answer --key down,enter 选第二项。`);
      }
    }
    let held = null;
    const placed = await withQueue(async () => {
      const current = await findCard(id);
      if (state() !== s || !current || current.review_claim?.key !== input.key || current.review_claim.delivered ||
        current.status !== 'review' || current.review_round !== claim.round || current.review_session === true ||
        s.waitlist.some((w) => w.metadata?.boardId === id) || [...host.columns(), ...(host.config.archived || [])].some((c) => c.boardId === id && c.boardAttempt === attempt)) return false;
      const result = await placeSession(title, checked.cmd, executor?.cwd || '', attempt, AV.reviewPrompt({ card, receipt: card.exec_receipt }), metadata);
      // queued on the quota (the reading changed between the pick and now): say so, do not wait unseen
      if (result.queued && result.plan?.action === 'queue') held = result.result;
      return true;
    });
    host.flushConfig?.();   // the queue entry is on disk before the claim is marked delivered
    await boardRequest('reviewDispatched', { id, key: input.key });
    if (held) boardNotice(`卡片 ${id}「${card.title}」的自动审查会话（${picked.candidate.label}）没能马上开：${held} 额度恢复前这一轮没有审查结论，额度回来会自动开；不想等或想换席位，下面这条命令会替换这条排队（模型写在 --command 里，可加 --seat）：${AV.manualReviewCommand({ card, receipt: card.exec_receipt, cli: M.boardCli(host.platform), platform: host.platform, executorId: executor?.id })}`);
    return placed ? { card, reviewer: picked.candidate.id, ...(picked.unverified ? { unverified: true } : {}) } : { card, ignored: true };
  }
  async function startReview(id, input) {
    try { return await runVerify('review', id, input, startReviewOnce); }
    catch (error) {
      // Transient board errors retry on the next heartbeat; a card that keeps failing goes to 队长.
      const count = (verifyFailures.get(input.key) || 0) + 1;
      verifyFailures.set(input.key, count);
      if (count >= 3) await boardRequest('reviewBlocked', { id, key: input.key, reason: '自动开审查会话连续失败：' + error.message }).catch(() => {});
      throw error;
    }
  }
  async function startReworkOnce(id, input) {
    if (!mainCol()) return { ignored: true };
    const card = await findCard(id);
    const reject = card?.review_reject;
    if (!card || !reject || reject.key !== input.key || reject.delivered) return { ignored: true };
    if (card.status !== 'doing' || card.flag !== 'failed') { await boardRequest('reworkDispatched', { id, key: input.key }); return { card, ignored: true }; }
    const execId = card.exec_receipt?.session_id;
    if (!execId || !findTarget(execId) && !archivedCrew(execId)) {
      boardNotice(`卡片 ${id}「${card.title}」验收不通过，但原执行会话（${execId || '未记录'}）已经找不到，不能自动返工，请队长安排。审查员的原话：\n${reject.findings}`);
      await boardRequest('reworkDispatched', { id, key: input.key });
      return { card, stranded: true };
    }
    const AV = window.AutoVerifyCore;
    try {
      await tellSession({ to: execId, message: AV.reworkMessage({ card, findings: reject.findings }), id: AV.reworkAttemptId(id, reject.round), reworkKey: reject.key });
    } catch (error) {
      // The card was moved after the check above: the rework is no longer wanted.
      // (through ipcRenderer.invoke the message reads "Error invoking remote method '…': Error: 自动返工…")
      if (!/自动返工已经不用发了/.test(error.message)) throw error;
      await boardRequest('reworkDispatched', { id, key: input.key });
      return { card, ignored: true };
    }
    host.flushConfig?.();
    await boardRequest('reworkDispatched', { id, key: input.key });
    return { card, reworked: execId };
  }
  const startRework = (id, input) => runVerify('rework', id, input, startReworkOnce);
  window.deck.onTaskReview((input) => {
    if (mainCol()) startReview(input.id, input).catch((error) => host.showToast('自动验收暂未开出审查会话：' + error.message));
  });
  const reworkToasted = new Set();
  window.deck.onTaskRework((input) => {
    // Retried on every heartbeat until it goes in (e.g. the executor sits on a prompt); say so once.
    if (mainCol()) startRework(input.id, input).catch((error) => { if (!reworkToasted.has(input.key)) { reworkToasted.add(input.key); host.showToast('验收不通过，自动返工暂未发出：' + error.message); } });
  });

  function normalize() {
    host.config.captainHistory = M.normalizeHistory(host.config.captainHistory);
    normalizeTodoInbox();
    const s = host.config.mainSession;
    if (!s || typeof s !== 'object' || typeof s.colId !== 'string') { host.config.mainSession = null; return; }
    s.gen = Number.isFinite(s.gen) ? s.gen : 1;
    s.cmd = typeof s.cmd === 'string' ? window.BoardCore.upgradeLegacyCommand(s.cmd) : '';
    const col = host.columns().find((c) => c.id === s.colId && c.isMain);
    if (col && col.cmd) s.cmd = col.cmd;
    s.pending = Array.isArray(s.pending) ? s.pending : [];
    s.inflight = Array.isArray(s.inflight) ? s.inflight : [];
    s.receiptsSeen = normalizeSeenIds(s.receiptsSeen);
    delete s.exceptionSeen; // Retire the old session-wide gate; new events must reach the Captain.
    s.implicitQuestions = Array.isArray(s.implicitQuestions) ? s.implicitQuestions.filter((key) => typeof key === 'string' && key.length <= 300).slice(-100) : [];
    // A turn open at shutdown cannot acknowledge legacy injection. Receipts the
    // background channel already returned stay read across relaunch. Items still
    // in pending were never taken, including ones that arrived while restarting.
    const seen = new Set(s.receiptsSeen);
    const lost = unconfirmedReceipts(s);
    if (lost.length) s.handoffCarry = { at: Date.now(), kind: 'restart', fromId: s.colId, items: [...(s.handoffCarry?.items || []), ...lost] };
    s.pending = [...requeued(unreadReceipts(s.inflight, seen)), ...s.pending];
    s.inflight = [];
    s.mobileMessages = Array.isArray(s.mobileMessages) ? s.mobileMessages.filter((m) => typeof m === 'string' ? m.trim() && m.length <= 8000 : mobileImages(m?.atts).length && typeof m.text === 'string' && m.text.length <= 8000) : [];
    s.fresh = !!s.fresh;
    s.legacyReceiptInjection = s.legacyReceiptInjection === true && !nativeCaptain(s.cmd);
    s.tasks = Array.isArray(s.tasks) ? trimTasks(s.tasks.filter((t) => t && typeof t.id === 'string' && typeof t.colId === 'string')) : [];
    s.tasks.forEach((t) => { delete t.boardRetrying; });
    s.waitlist = Array.isArray(s.waitlist) ? s.waitlist.filter((w) => w && typeof w.taskId === 'string' && typeof w.task === 'string' && s.tasks.some((t) => t.id === w.taskId && t.status === 'waiting')) : [];
    restoreTodoInbox();
    // A sub-captain's untaken receipts stay its own; one whose column is gone hands them to the Captain.
    const queues = s.subReceipts && typeof s.subReceipts === 'object' && !Array.isArray(s.subReceipts) ? s.subReceipts : {};
    s.subReceipts = {};
    for (const [id, items] of Object.entries(queues)) {
      if (!Array.isArray(items) || !items.length) continue;
      if (host.columns().some((c) => c.id === id && c.subCaptain === true && !c.isMain)) s.subReceipts[id] = items;
      else s.pending.push(...items);
    }
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
    $('mdCmd').value = host.config.captainRelayClaudeCommand || window.ClaudeSeatsCore.CLAUDE_COMMAND;
    $('mdCwd').value = '';
    d.showModal();
    setTimeout(() => $('mdCmd').focus(), 50);
  }
  function create(cmd, cwd) {
    if (mainCol()) { open(); return mainCol(); }
    const col = host.createMain({ cmd, cwd });
    host.config.mainSession = { colId: col.id, cmd, gen: 1, pending: [], inflight: [], tasks: [], fresh: false, crewMarked: true, waitlist: [] };
    restoreTodoInbox();
    save();
    window.Sidebar.render();
    brief(col);
    deliverWaitingDispatch();
    return col;
  }
  // The instructions go straight into the terminal; they are not a user bubble.
  // Receipts wait until the instructions are in: briefing is the column whose
  // brief has not gone out yet.
  let briefing = '';
  let seatChanging = false;
  function briefingText(note) {
    return M.instructions(host.platform, note, state()?.legacyReceiptInjection === true, host.config.concurrencyCap);
  }
  // s.briefed: the prompt this column's model context was given. Removed the moment
  // that context is cleared, so a restart in between briefs again.
  const briefedMark = (col, text) => ({ colId: col.id, mark: M.briefingMark(text) });
  const holdsBriefing = (col) => state()?.briefed?.colId === col.id && state().briefed.mark === M.briefingMark(briefingText());
  // kept: the app came back and this Captain's own conversation came back with it.
  // It still holds the prompt, so it gets the short restart notice instead.
  function brief(col, note, kept) {
    if (!col.cmd) return;   // a bare shell would run them as commands
    const id = col.id;
    briefing = id;
    const done = () => { if (briefing === id) briefing = ''; };
    const notice = !!kept && holdsBriefing(col);
    const text = notice ? M.restartNotice(host.platform, state()?.seatCheckpoint || '', state()?.legacyReceiptInjection === true) : briefingText(note);
    const sent = () => {
      restartWatch?.sent(id, Date.now(), text, !!host.terms.get(id)?.promptSettledAt);
      const s = state(), attempt = s?.relayStartup?.attempt?.colId === id;
      if (attempt) {
        s.relayStartup.attempt.promptSent = true;
        s.relayStartup.attempt.promptSentAt = Date.now();
      }
      const fresh = s && !notice && mainCol()?.id === id;
      if (fresh) s.briefed = briefedMark(col, text);
      if (attempt || fresh) save();
      done();
      // A terminal that reads lines gets the briefing typed. Through ConPTY the agent can
      // still be reading it while its screen looks idle, and a note sent then joins the
      // briefing as one prompt: the note waits until the agent has drawn something since.
      if (note && !notice) host.sendWhenReady(col, note, { silent: true, guardUserInput: true, outputSince: Date.now() });
    };
    host.sendWhenReady(col, text, {
      silent: true, onSent: sent, guardUserInput: true, inlineLimit: M.BRIEFING_LIMIT,
      onGiveUp: () => { done(); host.showToast('没发出去：队长的 agent 一直没准备好'); },
    });
  }
  // The Captain column that came back with the app. Whether its conversation came
  // back too is known only once its terminal has been reconnected or relaunched.
  let startupBrief = '';
  function captainRelaunched(col, kept) {
    if (!col?.isMain || startupBrief !== col.id) return;
    startupBrief = '';
    brief(col, state()?.seatCheckpoint ? M.restartNote(host.platform, state().seatCheckpoint) : '', kept);
  }
  // ---- battery mode: the live cap is the settings cap, lowered while on battery ----
  const Bat = () => window.BatteryCore;
  const batteryNow = () => Bat()?.shared.snapshot() || { onBattery: false, mode: 'auto', cap: 3, active: false };
  // baseCap is the settings cap; tests that set M.MAX_ACTIVE directly have no settings cap.
  const baseCap = () => Number.isInteger(host.config.concurrencyCap) ? host.config.concurrencyCap : M.MAX_ACTIVE;
  const capInfo = () => Bat() ? Bat().effectiveCap(baseCap(), batteryNow()) : { cap: M.MAX_ACTIVE, limited: false };
  // Power source, setting or cap changed: new live cap, refreshed queue cards, then fill any free slot.
  function syncEffectiveCap() {
    M.MAX_ACTIVE = capInfo().cap;
    syncBoost();
    refreshWaitingNotes();
    return pump();
  }
  // 临时拉满 (a boost over the battery limit) is kept in config.batteryBoost = { until } (until 0 = no end time) so a
  // restart keeps it; plugging in, 不限制 and the end time clear it. This runs on every change of the shared state.
  let boostTimer = 0;
  function syncBoost() {
    const snap = batteryNow();
    const saved = host.config.batteryBoost;
    if (snap.boost) {
      if (!saved || saved.until !== snap.boostUntil) { host.config.batteryBoost = { until: snap.boostUntil || 0 }; save(); }
    } else if (saved) { delete host.config.batteryBoost; save(); }
    if (typeof clearTimeout === 'function') clearTimeout(boostTimer);
    boostTimer = 0;
    if (snap.boost && snap.boostUntil > 0 && typeof setTimeout === 'function') {
      boostTimer = setTimeout(() => { if (!Bat().shared.expireBoost(Date.now())) syncBoost(); }, Math.min(2 ** 31 - 1, Math.max(1000, snap.boostUntil - Date.now())));
    }
    renderBoostRow(snap);
  }
  // The settings box shows the boost and takes it back with one click.
  function renderBoostRow(snap = batteryNow()) {
    const row = $('batteryBoostRow');
    if (!row || !Bat()) return;
    row.hidden = !snap.boost;
    if ($('batteryBoostText')) $('batteryBoostText').textContent = `已临时拉满（${Bat().boostUntilText(snap.boostUntil)}）：电池下也按正常上限同时开会话`;
  }
  // One line for ledger/quota while battery mode is on; plugged in or set to 不限制 they print exactly what they always did.
  function batteryLine() {
    if (!Bat()) return '';
    const s = state();
    const line = Bat().statusLine(batteryNow(), baseCap(), s ? M.activeCrew(s.tasks, crewIds()).size : undefined);
    return line ? '\n' + line : '';
  }
  // The setting as the phone hub and the Captain's `settings battery` see it; null when this build has no battery mode.
  function batteryReadout() {
    if (!Bat()) return null;
    Bat().shared.expireBoost(Date.now());
    const s = state();
    return Bat().readout(batteryNow(), baseCap(), s ? M.activeCrew(s.tasks, crewIds()).size : undefined);
  }
  // A remote change (phone, Captain): same effect as saving the settings box. The shared state notifies
  // syncEffectiveCap, which lifts or lowers the live cap and starts waiting work that now fits; the config is
  // written at once (not on the 150 ms timer) so the main process and a restart see it, and an open settings box shows it.
  function setBattery(input) {
    if (!Bat()) throw new Error('这个版本没有电池模式。');
    const parsed = Bat().parseChange(input);
    if (parsed.error) throw new Error(parsed.error);
    const { boost, boostMinutes } = parsed.change;
    if (boost === true) {
      const mode = parsed.change.mode !== undefined ? parsed.change.mode : batteryNow().mode;
      if (!Bat().isActive(mode, batteryNow().onBattery)) throw new Error(`现在不需要拉满：${mode === 'off' ? '电池模式已关' : '现在接着电源'}，本来就不限制。`);
    }
    if (parsed.change.mode !== undefined) host.config.batteryMode = parsed.change.mode;
    if (parsed.change.cap !== undefined) host.config.batteryConcurrency = parsed.change.cap;
    Bat().shared.set({ mode: host.config.batteryMode, cap: host.config.batteryConcurrency,
      ...(boost === undefined ? {} : { boost, boostUntil: boost === true && boostMinutes ? Date.now() + boostMinutes * 60000 : 0 }) });
    syncEffectiveCap();
    host.flushConfig();
    if ($('batteryMode')) {
      $('batteryMode').value = Bat().normalizeMode(host.config.batteryMode);
      $('batteryConcurrency').value = Bat().normalizeCap(host.config.batteryConcurrency);
      syncBatteryField();
    }
    return batteryReadout();
  }
  function initDialog() {
    const settings = $('notificationSettings');
    $('csEnabled').onchange = () => { $('csThreshold').disabled = !$('csEnabled').checked; };
    if ($('batteryMode')) $('batteryMode').onchange = syncBatteryField;
    // These few wait for 保存设置 (the switches above save on change), so the save bar says when they are edited.
    for (const id of ['csEnabled', 'csThreshold', 'handoffBudget', 'captainAutoCompact', 'concurrencyCap', 'batteryMode', 'batteryConcurrency', 'resumeOnRestart']) {
      $(id)?.addEventListener?.('input', () => { if ($('csDirty')) $('csDirty').textContent = '有改动还没保存'; });
    }
    if ($('batteryBoostCancel')) $('batteryBoostCancel').onclick = () => { try { setBattery({ boost: false }); } catch (error) { host.showToast(error.message); } };
    $('csSave').onclick = () => {
      if ($('csEnabled').checked && !$('csThreshold').reportValidity()) return;
      if (!$('concurrencyCap').reportValidity()) return;
      if ($('batteryConcurrency') && !$('batteryConcurrency').disabled && $('batteryConcurrency').reportValidity && !$('batteryConcurrency').reportValidity()) return;
      const budgetBox = $('handoffBudget');
      if (budgetBox?.reportValidity && !budgetBox.reportValidity()) return;
      if (budgetBox && budgetBox.value !== undefined) host.config.captainHandoffOverview = M.handoffBudget(budgetBox.value);
      // Empty or 0 saves 0 (the variable is not set); a number below Claude's own floor is saved as the floor.
      const compactBox = $('captainAutoCompact');
      if (compactBox && compactBox.value !== undefined) host.config.captainAutoCompactWindow = M.autoCompactWindow(compactBox.value);
      host.config.captainTokenSaver = M.tokenSaverSettings({ enabled: $('csEnabled').checked, threshold: Number($('csThreshold').value) * 1000 });
      host.config.resumeOnRestart = $('resumeOnRestart').checked;
      if (Bat() && $('batteryMode')) {
        host.config.batteryMode = Bat().normalizeMode($('batteryMode').value);
        // Greyed out under 不限制: keep the saved count rather than whatever the box holds.
        if (!$('batteryConcurrency').disabled) host.config.batteryConcurrency = Bat().normalizeCap($('batteryConcurrency').value);
        Bat().shared.set({ mode: host.config.batteryMode, cap: host.config.batteryConcurrency });
      }
      applyConcurrencyCap($('concurrencyCap').value);
      cancelTokenSaving();
      tokenSaverPaused = false;
      save();
      if ($('csDirty')) $('csDirty').textContent = '';
      settings.close();
    };
    settings.addEventListener('keydown', (e) => e.stopPropagation());
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

  // ---- automatic board checkpoint and in-process Claude /clear ----
  function openSettings() {
    const settings = M.tokenSaverSettings(host.config.captainTokenSaver);
    $('csEnabled').checked = settings.enabled;
    $('csThreshold').value = settings.threshold / 1000;
    $('csThreshold').disabled = !settings.enabled;
    $('concurrencyCap').value = M.concurrencyCap(host.config.concurrencyCap);
    if (Bat() && $('batteryMode')) {
      $('batteryMode').value = Bat().normalizeMode(host.config.batteryMode);
      $('batteryConcurrency').value = Bat().normalizeCap(host.config.batteryConcurrency);
      syncBatteryField();
      renderBoostRow();
    }
    if ($('handoffBudget')) $('handoffBudget').value = M.handoffBudget(host.config.captainHandoffOverview);
    if ($('captainAutoCompact')) $('captainAutoCompact').value = M.autoCompactWindow(host.config.captainAutoCompactWindow);
    const resumeBox = $('resumeOnRestart');
    if (resumeBox) resumeBox.checked = window.RestartResume.resumeEnabled(host.config);
    if ($('csDirty')) $('csDirty').textContent = '';
  }
  // 不限制: the battery count does not apply, so it is greyed out and not required (like the token-saver threshold).
  function syncBatteryField() {
    const off = $('batteryMode').value === 'off';
    $('batteryConcurrency').disabled = off;
    $('batteryConcurrency').required = !off;
  }
  function applyConcurrencyCap(raw) {
    const cap = M.concurrencyCap(raw);
    host.config.concurrencyCap = cap;
    syncEffectiveCap();
    host.onCapChanged?.();
  }

  function saverBanner(text) {
    const wrap = host.terms.get(state()?.colId)?.wrap;
    if (!wrap) return;
    let banner = wrap.querySelector('.captain-token-saving');
    if (!text) { banner?.remove(); return; }
    if (!banner) {
      banner = el('div', 'captain-token-saving');
      const label = el('span');
      label.setAttribute('role', 'status');
      const cancel = el('button', 'icon-btn');
      cancel.type = 'button'; cancel.innerHTML = host.ICONS.close;
      cancel.title = '取消后续自动步骤（已发送的命令无法撤回）';
      cancel.setAttribute('aria-label', '取消自动存档与清空');
      cancel.onclick = cancelTokenSaving;
      banner.append(label, cancel);
      wrap.querySelector('.col-head').after(banner);
    }
    banner.querySelector('span').textContent = text;
  }
  function cancelTokenSaving() {
    if (tokenSaving?.relay) {
      clearTimeout(tokenSaving.timer);
      tokenSaving.reject(new Error('Relay存档已取消'));
    }
    tokenSaving = null;
    tokenSaverPaused = true;
    saverBanner('');
  }

  async function checkpointForSeatSwitch(snapshot, options = {}) {
    cancelTokenSaving();
    const col = mainCol(), entry = host.terms.get(col?.id);
    const idle = entry?.alive && entry.state === 'done' && !briefing && !delivering &&
      !entry.sendingPrompt && !entry.injecting && !host.userComposing(col.id) &&
      !M.terminalActivity(entry.lastScreen, col?.cmd) && !window.ChatUI.turnsOf(col.id).some((t) => t.kind !== 'task' && !t.done);
    if (!options.local && idle && state().relayTargetId !== 'chatgpt' && window.AgentInfo.resolveAgentInfo(col, entry).provider === 'Claude') {
      await new Promise((resolve, reject) => {
        const op = { colId: col.id, entry, relay: true, resolve, reject };
        tokenSaving = op;
        op.timer = setTimeout(() => {
          if (tokenSaving === op) saverFailed('Relay未收到存档确认');
        }, 5 * 60_000);
        saverBanner('Relay正在存进度看板，等待「已存档」');
        saverSend(op, M.ARCHIVE_PROMPT, 'archiving', false, (turn) => { op.turnId = turn?.id; });
      });
    }
    // Busy/quota/exited/Codex Captains cannot be asked for another model turn.
    // Persist a fresh full snapshot in every path, before the old PTY is killed.
    if (mainCol() !== col || host.userComposing(col.id)) throw new Error('队长或输入已变更');
    return window.deck.captainCheckpoint({ ...snapshot, ...handoffSnapshot('relay', snapshot.relayMessage), chat: window.ChatUI.snapshotForHandoff(col.id) });
  }
  // ---- Relay handoff: one moment of this state, for the next 队长 ----
  // The main process adds the board cards and 队长's decisions file and writes the text.
  const carryItem = (p) => ({ receiptId: p.receiptId, taskId: p.taskId, colId: p.colId, title: String(p.title || '').slice(0, 120), ts: p.ts,
    ...Object.fromEntries(['question', 'waiting', 'failed', 'summary'].filter((k) => typeof p[k] === 'string' && p[k]).map((k) => [k, p[k].slice(0, 400)])) });
  // Receipts the background channel handed over, with no finished work by 队长
  // since. They are never sent again, so a Relay or restart has to name them.
  function unconfirmedReceipts(s) {
    const seen = new Set(normalizeSeenIds(s.receiptsSeen));
    return (Array.isArray(s.inflight) ? s.inflight : []).filter((p) => p && takenByChannel(p, seen) && !dealtWith(p, s)).map(carryItem);
  }
  // What an earlier Relay or restart already named. It stays open until 队长 has
  // finished a stretch of work that began after it was listed: a Captain that took
  // over and never got to work must pass it on, not drop it.
  function carriedReceipts(s) {
    const carry = s.handoffCarry;
    if (!carry || !Array.isArray(carry.items) || !carry.items.length) return null;
    return (Number.isFinite(s.captainSettledAt) ? s.captainSettledAt : 0) > carry.at ? null : carry;
  }
  function handoffSnapshot(reason, relayMessage) {
    const s = state(), col = mainCol();
    const cols = host.columns();
    const leaving = reason === 'relay' || reason === 'clear';
    const previousId = leaving ? col.id : (host.config.captainHistory || []).at(-1)?.id || '';
    const seen = new Set(normalizeSeenIds(s.receiptsSeen));
    const said = (id) => window.ChatUI.turnsOf(id).filter((t) => t.kind !== 'task' && t.kind !== 'notice' && String(t.user || '').trim())
      .map((t) => ({ ts: t.ts, text: String(t.user).slice(0, 4000), sourceId: id,
        ...(/（全文 \d+ 字，见附件）$/.test(t.user) && /prompt-[\w-]+\.txt$/.test(String((t.atts || []).at(-1) || '')) ? { longFile: t.atts.at(-1) } : {}) }));
    // The user's last words may be several Captains back (a night of automatic Relays).
    let userTurns = said(col.id);
    const earlier = [...(host.config.captainHistory || [])].reverse().filter((past) => past.id !== col.id);
    let looked = 0;
    for (const past of earlier.slice(0, 8)) {
      if (userTurns.length >= 8) break;
      userTurns = [...said(past.id), ...userTurns]; looked += 1;
    }
    // The excerpt is a window; the text says when there is more behind it.
    const userTurnsOlder = looked < earlier.length || userTurns.length > 12;
    const rotation = window.PerpetualCaptainCore ? window.PerpetualCaptainCore.normalizeSettings(host.config.perpetualCaptain) : null;
    return {
      colId: col.id, reason, now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, cli: M.boardCli(host.platform),
      budget: host.config.captainHandoffOverview, dispatchCap: MAX_TASKS, userTurnsOlder,
      captain: { previousId, gen: s.gen, ...(leaving ? { nextGen: s.gen + 1 } : {}), message: relayMessage || '', lastRelay: leaving ? null : s.relayRecord || null,
        rotation: rotation ? `永动机自动轮换${rotation.enabled ? '开' : '关'}，席位顺序 ${rotation.order.join(' → ')}，Claude 席位都用尽时交给 ${host.config.captainRelayCodex?.name || 'ChatGPT'}` : '' },
      // Instruction bodies stay where they are; the handoff never quotes them.
      tasks: s.tasks.map(({ instruction, ...task }) => task),
      sessions: ledgerRows().map((row) => ({ id: row.id, title: row.title, state: row.state, terminalState: row.terminalState, alive: !!host.terms.get(row.id)?.alive,
        crew: !!cols.find((c) => c.id === row.id)?.captainCrew, project: row.project, boardId: cols.find((c) => c.id === row.id)?.boardId || '', important: row.important })),
      archivedIds: (host.config.archived || []).map((a) => a.id),
      pending: s.pending, inflight: unreadReceipts(s.inflight, seen), unconfirmed: unconfirmedReceipts(s),
      waitlist: s.waitlist.map((w) => ({ taskId: w.taskId, title: w.title, project: w.project || '', important: isHigh(w), metadata: { boardId: w.metadata?.boardId || '' } })),
      carry: reason === 'relay' ? carriedReceipts(s) : s.handoffCarry || null, userTurns: userTurns.slice(-12),
    };
  }
  function saverFailed(message) {
    cancelTokenSaving();
    host.showToast(message + '；自动清理已暂停');
  }
  function saverSend(op, text, phase, silent, onSent) {
    op.phase = phase;
    op.since = Date.now();
    const col = mainCol();
    if (text === '/clear') op.snapshot = window.ChatUI.captainSnapshot(col.id);
    host.sendWhenReady(col, text, {
      silent, guardUserInput: true, requireIdle: true, timeout: 5 * 60_000, inlineLimit: M.BRIEFING_LIMIT,
      // A paste/Enter already in progress stays atomic; cancelling stops the
      // next step and never leaves AgentDeck's own paste stranded in the box.
      cancelled: () => tokenSaving !== op && !host.terms.get(op.colId)?.injecting,
      onSent: (turn) => {
        if (text === '/clear' && mainCol() === col && host.terms.get(col.id) === op.entry) {
          // /clear can create a new CLI session; never resume the pre-clear ID
          // on a later app launch, including when cancelled just after Enter.
          delete col.modelSessionId;
          col.cmd = M.freshCommand(col.cmd);
          state().cmd = col.cmd;
          state().fresh = true;
          delete state().briefed;
          save();
        }
        if (tokenSaving === op) { op.since = Date.now(); onSent(turn); }
      },
      onGiveUp: () => { if (tokenSaving === op) saverFailed('队长一直没准备好'); },
    });
  }
  function tokenSaverTick(entry) {
    const col = mainCol();
    const settings = M.tokenSaverSettings(host.config.captainTokenSaver);
    if (!settings.enabled || !entry.alive || (tokenSaving && (tokenSaving.colId !== col.id || tokenSaving.entry !== entry))) {
      if (tokenSaving) cancelTokenSaving();
      return;
    }
    // Read the actual footer, including soft-wrapped rows, in either view.
    const footer = window.ChatUI.readFooter(entry.term);
    const used = M.contextTokens((footer || []).map((row) => row.map((s) => s.text).join('')).join('\n'));
    const idle = !briefing && !delivering && !entry.sendingPrompt && entry.state === 'done' && !M.terminalActivity(entry.lastScreen, col?.cmd) &&
      Date.now() - (entry.lastOutputAt || 0) >= 3000 && !host.userComposing(col.id) &&
      !window.ChatUI.turnsOf(col.id).some((t) => t.kind !== 'task' && !t.done);
    if (!tokenSaving) {
      if (used !== null && used <= settings.threshold) tokenSaverPaused = false;
      if (tokenSaverPaused || used === null || used <= settings.threshold || !idle || window.AgentInfo.inferProvider(col.cmd, entry.lastScreen) !== 'Claude') return;
      tokenSaving = { colId: col.id, entry, used, phase: 'queued', since: Date.now() };
      saverBanner(`上下文 ${(used / 1000).toFixed(0)}k：准备存看板 → 清空 → 读看板继续`);
      return;
    }
    const op = tokenSaving;
    if (Date.now() - op.since > 5 * 60_000) { saverFailed(op.phase === 'cleared' ? '/clear 后未确认上下文下降，请手动检查队长' : '未收到存档确认或队长一直忙碌'); return; }
    if (!idle) return;
    if (op.phase === 'queued' && Date.now() - op.since >= 3000) {
      saverBanner('正在存进度看板，等待「已存档」');
      saverSend(op, M.ARCHIVE_PROMPT, 'archiving', false, (turn) => { op.turnId = turn?.id; });
    } else if (op.phase === 'archived') {
      saverBanner('看板已存档，正在发送 /clear');
      saverSend(op, '/clear', 'clearing', true, () => { op.phase = 'cleared'; });
    } else if (op.phase === 'cleared' && used !== null && used < op.used / 2) {
      archiveSnapshot(col, op.snapshot);
      saverBanner('上下文已清空，正在重发队长提示词');
      // The briefing already ends with AUTONOMOUS_CONTINUATION, so only the short
      // resume line follows it. Past M.BRIEFING_LIMIT the captain would only see
      // a file pointer and miss the "don't wait" closing.
      saverSend(op, briefingText() + M.SAVER_RESUME, 'briefing', true, () => {
        state().briefed = briefedMark(col, briefingText()); save();
        cancelTokenSaving();
        host.showToast('队长已存看板并清空上下文，正在读看板继续');
      });
    }
  }

  function footerText(entry, provider) {
    const footer = (window.ChatUI.readFooter(entry.term) || []).map((row) => row.map((s) => s.text).join('')).join('\n');
    return footer || (provider === 'Codex' ? M.codexContextFooter(host.dumpScreen(entry.term)) : '');
  }
  function archiveSnapshot(col, snapshot) {
    const retired = window.ChatUI.archiveCaptainSnapshot(col.id, snapshot);
    if (retired) host.config.captainHistory = M.normalizeHistory([...(host.config.captainHistory || []), { ...retired, clearedAt: Date.now() }]);
    const s = state();
    s.pending = [...requeued(s.inflight), ...s.pending];
    s.inflight = [];
    delete col.modelSessionId;
    col.cmd = M.freshCommand(col.cmd);
    s.cmd = col.cmd;
    s.fresh = true;
    delete s.briefed;
    save();
  }
  // Called before the submitted command can erase the TUI. Typing a slash,
  // Ctrl+L, quoted commands, worker commands and shell commands never arm it.
  function onContextCommand(col, text, submitted = true) {
    if (!isMain(col) || !col.cmd) return;
    const entry = host.terms.get(col.id);
    if (!entry?.alive || entry.state === 'working' || entry.state === 'input' || entry.state === 'quota' || M.terminalActivity(entry.lastScreen, col?.cmd)) return;
    const provider = window.AgentInfo.inferProvider(col.cmd, entry.lastScreen);
    if (!M.contextResetCommand(provider, text)) {
      if (contextReset && !contextReset.confirmed) contextReset = null;
      return;
    }
    cancelTokenSaving();
    contextReset = { col, entry, provider, before: footerText(entry, provider), output: '', since: Date.now(),
      snapshot: window.ChatUI.captainSnapshot(col.id), text, submitted, confirmed: false, sending: false };
  }
  function onContextCommandSent(col, text) {
    if (contextReset?.col === col && contextReset.text === text) {
      contextReset.submitted = true;
      contextReset.output = '';
      contextReset.since = Date.now();
    }
  }
  function onOutput(id, data) {
    if (contextReset?.col.id === id && contextReset.submitted && !contextReset.confirmed) contextReset.output = (contextReset.output + data).slice(-16000);
  }
  function contextResetTick(entry) {
    const op = contextReset;
    if (!op) return;
    if (mainCol() !== op.col || entry !== op.entry || !entry.alive) { contextReset = null; return; }
    if (!op.confirmed) {
      if (Date.now() - op.since > 60_000) { contextReset = null; return; }
      if (!op.submitted) return;
      if (M.contextResetEvidence(op.provider, op.before, footerText(entry, op.provider), op.output, host.platform)) {
        op.confirmed = true;
        archiveSnapshot(op.col, op.snapshot);
      } else return;
    }
    if (op.sending || briefing || delivering || entry.sendingPrompt || entry.state !== 'done' || M.terminalActivity(entry.lastScreen, op.col.cmd) ||
      Date.now() - (entry.lastOutputAt || 0) < 3000 || host.userComposing(op.col.id)) return;
    op.sending = true;
    host.sendWhenReady(op.col, briefingText(), {
      silent: true, guardUserInput: true, requireIdle: true, inlineLimit: M.BRIEFING_LIMIT,
      cancelled: () => contextReset !== op && !entry.injecting,
      onSent: () => { state().briefed = briefedMark(op.col, briefingText()); save(); if (contextReset === op) { contextReset = null; host.showToast('已重新发送队长提示词，先读账本和看板里的队长交接'); } },
      onGiveUp: () => { if (contextReset === op) { contextReset = null; host.showToast('队长提示词没发出去；可在队长终端运行 briefing 读取'); } },
    });
  }

  // ---- manual clear: only 队长's model context starts over ----
  // Its agent restarts fresh and is briefed again. Work out in other columns,
  // unread receipts and questions carry over to the new context; the old
  // conversation stays saved under the old column id for `read --id`.
  function clearContext(options) {
    const rotation = options && options.seatId && options.checkpointPath;
    const col = mainCol();
    const s = state();
    if (!col || !s) return;
    const entry = host.terms.get(col.id);
    const busy = !!entry && entry.alive && (entry.state === 'working' || entry.state === 'input');
    const kept = '\n\n派出去的活不会中断；没处理的回执和提问留给清空后的队长；之前的对话存在本机，不会删除，队长需要时按需读取。';
    if (!rotation && !options?.fromEdit && !confirm(busy
      ? '队长现在正在回复（或停在确认提示上）。清空会打断它这一轮，这一轮没说完的不会再有。\n确定现在清空队长的模型上下文吗？' + kept
      : '只清空队长的模型上下文：队长重新启动，重新读一遍默认说明。' + kept)) return;
    contextReset = null;
    cancelTokenSaving();
    // Receipts already returned on the background channel stay read when Relay
    // changes seats. Unread inflight (legacy injection) and anything still
    // pending go to the new seat, so a handoff neither resends nor drops them.
    const seen = new Set(normalizeSeenIds(s.receiptsSeen));
    // A manual clear sends everything in flight again, except what the background
    // channel handed over before 队长 last finished a stretch of work: the old
    // context dealt with those, and a second copy would be handled twice.
    const requeue = rotation ? unreadReceipts(s.inflight, seen) : s.inflight.filter((p) => !(takenByChannel(p, seen) && dealtWith(p, s)));
    const unconfirmed = rotation ? [...(carriedReceipts(s)?.items || []), ...unconfirmedReceipts(s)] : [];
    s.inflight = [];
    const oldId = col.id;
    if (rotation) s.handoffCarry = unconfirmed.length ? { at: Date.now(), kind: 'relay', fromId: oldId, items: unconfirmed } : null;
    const retired = window.ChatUI.retireChat(oldId, { interrupted: !!rotation });
    if (retired) {
      host.config.captainHistory = M.normalizeHistory([...(host.config.captainHistory || []), { id: oldId, ...retired, clearedAt: Date.now() }]);
    }
    // Whatever is still waiting was never handed over, whatever the id list says: it goes on.
    s.pending = [...requeued(requeue), ...s.pending];
    s.gen += 1;
    const waiting = new Set(s.pending.map((p) => p.taskId).filter(Boolean));
    const latest = new Map(s.tasks.map((t) => [t.colId, t]));
    const carried = s.tasks.filter((t) => !CLOSED.includes(t.status) || waiting.has(t.id) || (t.status === 'asking' && latest.get(t.colId) === t));
    carried.forEach((t) => { t.gen = s.gen; });
    // An acknowledged notification can still need a decision. Remind the new
    // context once, even if the old Captain already finished its own reply.
    // A sub-captain's children report to it, and its context was not cleared.
    carried.forEach((t) => {
      if (subCaptainOf(host.columns().find((c) => c.id === t.colId))) return;
      const waitingInput = t.status === 'input' || (t.status === 'queued' && t.blockedAsked && host.terms.get(t.colId)?.state === 'input');
      if (waitingInput && !s.pending.some((p) => p.colId === t.colId && p.waiting)) {
        push(t, { waiting: confirmationExcerpt(host.terms.get(t.colId)) });
      } else if (t.status === 'asking' && t.receipt?.question && !s.pending.some((p) => p.colId === t.colId && p.question)) {
        push(t, { question: t.receipt.question });
      }
    });
    col.cmd = M.freshCommand(options?.command || col.cmd);
    if (nativeCaptain(col.cmd)) s.legacyReceiptInjection = false;
    if (rotation) {
      col.claudeSeatId = options.seatId;
      delete col.claudeConfigDir; // Only the replacement Captain adopts the new seat.
      host.config.activeClaudeSeatId = options.seatId;
      s.seatCheckpoint = options.checkpointPath;
      s.relayTargetId = options.relayTargetId || options.seatId;
    }
    delete col.modelSessionId;
    s.cmd = col.cmd;
    if (rotation) { delete col.agentProvider; delete col.agentModel; delete col.agentEffort; }
    const fresh = host.respawnColumn(col, { freshChat: true });   // new id, new shell, new token
    s.colId = fresh.id;
    if (rotation && window.RelayStartupCore) {
      s.relayStartup = window.RelayStartupCore.begin(options.automatic ? s.relayStartup : {},
        { colId: fresh.id, targetId: s.relayTargetId, at: Date.now() });
    } else delete s.relayStartup;
    s.fresh = true;
    delete s.briefed;
    carried.forEach((t) => { if (!t.subCaptainId) window.ChatUI.addCard(s.colId, t); });
    save();
    window.Sidebar.render();
    brief(fresh, M.resetNote(retired ? oldId : '', carried.filter((t) => !CLOSED.includes(t.status)), rotation ? 'relay' : '')
      + (rotation ? '\n' + M.relayNote(host.platform, options.relayMessage, options.checkpointPath) : ''));
    host.showToast(rotation ? `已${host.config.captainRelayLabel || 'Relay'}；进度看板、队员和回执已保留` : '队长的模型上下文已清空；派出去的活、回执和之前的对话都还在');
    return fresh;
  }

  // Rotation waits for a finished turn or a quiet quota wait. The quota turn
  // stays open so Relay can preserve its interrupted output in the old chat.
  function relayIdle() {
    const col = mainCol(), entry = host.terms.get(col?.id);
    if (!col || !entry?.alive || briefing || delivering || tokenSaving || entry.sendingPrompt || entry.injecting ||
      host.userComposing(col.id) || window.ChatUI.hasDraft(col.id) ||
      !['done', 'quota'].includes(entry.state) || Date.now() - (entry.lastOutputAt || 0) < 3000) return false;
    const activity = M.terminalActivity(entry.lastScreen, col?.cmd);
    if (activity === 'working' || (activity === 'quota' && entry.state !== 'quota')) return false;
    return entry.state === 'quota' || !window.ChatUI.turnsOf(col.id).some((t) => !t.done);
  }
  function relayEffort() {
    const s = state();
    const activeTitles = new Set((s?.tasks || []).filter((t) => !CLOSED.includes(t.status)).map((t) => t.title));
    return s?.pending.some((r) => r.failed) || s?.tasks.some((t) => t.receipt?.failed && activeTitles.has(t.title)) ? 'xhigh' : 'high';
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
  // Past MAX_TASKS the oldest finished records drop off. One that is still out, or
  // whose result has not reached the board yet, never does: the handoff, the restart
  // resume and the receipt it is waiting for all read it.
  const STILL_OUT = ['waiting', 'queued', 'working', 'paused', 'quota', 'input', 'asking'];
  function trimTasks(tasks) {
    let extra = tasks.length - MAX_TASKS;
    if (extra <= 0) return tasks;
    return tasks.filter((t) => {
      if (extra <= 0 || STILL_OUT.includes(t.status) || t.pendingBoardEvent) return true;
      extra -= 1;
      return false;
    });
  }
  // col null: a 'waiting' card for work queued until a slot frees up.
  // A sub-captain's child's cards go in the sub-captain's conversation, not the Captain's.
  function addTask(col, title, subId = subCaptainOf(col)?.id || '') {
    const s = state();
    // 高优先级 without a card belongs to the piece of work. A mark waiting on the
    // session (a new `new --priority high` session, or one the user marked while
    // idle) moves onto this record. A further instruction to a session whose
    // marked work is still unfinished (running, failed, stopped) is part of that
    // work and keeps the mark; after that work is done, new work is ordinary.
    const prior = col ? s.tasks.findLast((t) => t.colId === col.id) : null;
    const marked = !!col && (col.important === true || (!!prior && prior.important === true && prior.status !== 'done'));
    if (col) delete col.important;
    const task = {
      id: 'k' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      colId: col ? col.id : '', title: String(title || host.columnLabel(col)).slice(0, 120), gen: s.gen,
      status: col ? 'queued' : 'waiting', sentAt: Date.now(), turnId: '', receipt: null,
      project: col ? col.project || '' : '', reviews: col ? col.reviews || [] : [],
      boardId: col?.boardId || '', boardAttempt: col?.boardAttempt || '',
      ...(marked ? { important: true } : {}),
      ...(subId ? { subCaptainId: subId } : {}),
    };
    s.tasks.push(task);
    if (s.tasks.length > MAX_TASKS) s.tasks.splice(0, s.tasks.length, ...trimTasks(s.tasks));
    window.ChatUI.addCard(subId || s.colId, task);
    save();
    return task;
  }
  // Web work bypasses terminal input and the CLI receipt suffix completely.
  function webTaskState(task) {
    if (!task) return 'plain';
    if (['working', 'queued'].includes(task.status)) return 'working';
    return task.status === 'asking' ? 'input' : task.status;
  }
  function startWebTask(col, immediate) {
    const tasks = state()?.tasks || [];
    if (tasks.some((t) => t.colId === col.id && t.status === 'working')) return;
    const task = immediate || tasks.find((t) => t.colId === col.id && t.status === 'queued');
    const entry = host.terms.get(col.id);
    if (!task || !entry?.alive || entry.webExecutorReady === false || entry.webExecutorStopping) return;
    task.instructionSent = true;
    task.status = 'working';
    task.startedAt = Date.now();
    task.progress = '排队中：等待 ChatGPT 网页';
    task.webPhase = 'queued';   // not on the page yet; the executor reports when it is
    entry.webQueued = true;
    entry.webExecutorState = 'working';
    entry.state = 'working';
    entry.hasWorked = true;
    update(task);
    autoBoardEvent(task, 'started');
    try { window.deck.saveConfigSync(host.config); } catch (_) {}
    Promise.resolve().then(() => {
      if (task.status !== 'working' || !host.columns().includes(col)) return;
      return window.deck.chatgptWebRun({ id: col.id, taskId: task.id, task: task.instruction, mode: col.webMode || 'chat' });
    }).catch(() => {
      if (task.status !== 'working') return;
      settle(task, { summary: '', files: [], images: [], failed: 'ChatGPT 网页执行器未能启动，请检查本机工具是否可用。', explicit: true, source: 'process' });
    });
  }
  // The 派给 picker in 队长's composer: the same checks and queue as
  // `new --agent chatgpt-web`. No seat and no launch command: it only ever
  // drives the ChatGPT page already signed in on this machine.
  function dispatchWeb(text, mode) {
    return withQueue(async () => {
      const s = state(), W = window.ChatGPTWebCore;
      if (!s) throw new Error('先创建队长，再派网页调研。');
      const task = window.BoardCore.cleanText(text, 2_000_000);
      const title = W.titleFor(task);
      if (!title) throw new Error('先写下要调研的问题。');
      W.validatePublicTask(task);
      if (!W.MODES.some((m) => m.id === mode)) throw new Error('网页模式只能是普通或 Deep Research。');
      const busy = W.busyCount(s.tasks, host.columns());
      const requestId = 'ui-web-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const placed = await placeSession(title, 'chatgpt-web', '', requestId, task, { project: '', reviews: [], boardId: '', executor: 'chatgpt-web', webMode: mode });
      return { queued: !!placed.queued || busy > 0, colId: placed.col?.id || '', result: placed.queued ? placed.result : W.dispatchResult(busy) };
    });
  }
  function dispatch(col, text, title, waiting, immediate = false) {
    if (col.executor === 'chatgpt-web') window.ChatGPTWebCore.validatePublicTask(text);
    const supplement = state().tasks.some((t) => t.colId === col.id && t.startedAt);
    const task = waiting || addTask(col, title);
    if (waiting) {
      delete col.important;   // the waiting record already carries the mark
      Object.assign(task, { colId: col.id, status: 'queued', sentAt: Date.now() });
      update(task);
    }
    task.instruction = text;
    task.instructionSent = false;
    task.supplement = supplement;
    if (col.executor === 'chatgpt-web') {
      update(task);
      startWebTask(col, immediate ? task : null);
      return task;
    }
    persistResumeEntry(col, task);
    try { window.deck.saveConfigSync(host.config); } catch (_) {}
    let batch = dispatches.get(col.id);
    if (batch && batch.items.every((i) => i.task.status !== 'queued')) { dispatches.delete(col.id); batch = null; }
    if (batch && !batch.sending) { batch.items.push({ task, text }); return task; }
    batch = { items: [{ task, text }], sending: false, cancelled: false };
    dispatches.set(col.id, batch);
    let sentItems = [];
    host.sendWhenReady(col, () => {
      batch.sending = true;
      sentItems = batch.items.filter((i) => i.task.status === 'queued');
      const joined = sentItems.map((i) => i.text).join('\n\n');
      return Bat() ? Bat().withTaskNote(joined, Bat().shared.active()) : joined;
    }, {
      cancelled: () => batch.cancelled || batch.items.every((i) => i.task.status === 'stopped' || i.task.status === 'failed'),
      suffix: M.RECEIPT_CONTRACT, force: true, guardUserInput: true, requireIdle: true, timeout: supplement ? SUPPLEMENT_NOTICE : 30 * 60_000, keepWaiting: true,
      onSent: (turn) => {
        if (dispatches.get(col.id) === batch) dispatches.delete(col.id);
        if (batch.cancelled || sentItems.every((i) => i.task.status === 'stopped' || i.task.status === 'failed')) return;
        const last = sentItems.at(-1)?.task;
        if (!last) return;
        supersede(last);
        sentItems.forEach(({ task: t }) => {
          t.instructionSent = true;
          t.status = t === last ? 'working' : 'done';
          if (t === last) { t.instruction = sentItems.map((i) => i.text).join('\n\n'); t.turnId = turn ? turn.id : ''; t.startedAt = Date.now(); }
          else { t.doneAt = Date.now(); t.receipt = { summary: '已合并到后面的补充指令，一起送达。', files: [], images: [], failed: '', explicit: true, source: 'merged' }; }
          update(t);
          if (t === last) { persistResumeEntry(col, t); autoBoardEvent(t, 'started'); }
        });
      },
      onGiveUp: (reason) => {
        if (dispatches.get(col.id) === batch) dispatches.delete(col.id);
        batch.items.forEach(({ task: t }) => settle(t, { summary: '', files: [], images: [], failed: reason || '这个会话已无法接收指令', explicit: true, source: 'process' }));
      },
      // The command line never came up: nothing was typed. Not a stopped task, not a finished one.
      onStartupFailed: (failed) => {
        if (dispatches.get(col.id) === batch) dispatches.delete(col.id);
        batch.items.forEach(({ task: t }) => settle(t, { summary: '', files: [], images: [], failed, explicit: true, source: 'startup' }));
      },
      onWaiting: (reason) => {
        const task = batch.items.find((i) => i.task.status === 'queued')?.task;
        if (!task) return;
        const summary = supplement
          ? `补充指令等了 ${SUPPLEMENT_NOTICE / 60_000} 分钟还没送到，仍在排队：${supplementWait(col, reason)}。它停下后会合并送达；急事用 tell --now。`
          : `补充指令等待超过 30 分钟，仍在排队：${reason || '会话还没准备好接收指令'}`;
        push(task, { summary, source: 'queue' }); save();
      },
      onDeferred: () => { batch.sending = false; },
    });
    return task;
  }
  // An addition waits for the worker's turn to end; after this long the Captain hears why, once.
  const SUPPLEMENT_NOTICE = 5 * 60_000;
  function supplementWait(col, reason) {
    const entry = host.terms.get(col.id);
    const why = reason || '会话还没准备好接收指令';
    if (!(entry && (M.workingForSend(entry) || M.terminalActivity(entry.lastScreen, col.cmd) === 'working'))) return why;
    const running = state().tasks.findLast((t) => t.colId === col.id && t.status === 'working' && t.startedAt);
    if (!running) return why + '，队员这一轮还在跑';
    const said = window.BoardCore.cleanText(running.progress, 200).replace(/\s+/g, ' ').trim();
    return `${why}，队员这一轮已跑 ${Math.max(1, Math.round((Date.now() - running.startedAt) / 60_000))} 分钟${said ? `，最后进度：${said}` : ''}`;
  }
  function cancelSupplement(colId) {
    const batch = dispatches.get(colId);
    if (batch) { batch.cancelled = true; dispatches.delete(colId); }
    state().tasks.forEach((t) => {
      if (t.colId !== colId || t.status !== 'queued') return;
      t.status = 'stopped'; t.doneAt = Date.now();
      t.receipt = { summary: '队长已取消这条尚未送达的补充指令。', files: [], images: [], failed: '', explicit: true, source: 'captain-cancel' };
      update(t);
    });
  }
  // A new instruction reached a column whose earlier card never got a receipt
  // (it carried on into the new work): close that card quietly. A receipt now
  // would be a false "stopped" for work that is still going.
  function supersede(task) {
    const s = state();
    s.tasks.forEach((t) => {
      if (t === task || t.colId !== task.colId || !['working', 'quota', 'input', 'asking'].includes(t.status)) return;
      t.receipt = { summary: '后来又给这个会话发了新指令，结果看后面的卡片。', files: [], images: [], failed: '', explicit: true, source: 'superseded' };
      t.status = 'done';
      t.doneAt = Date.now();
      update(t);
    });
  }
  // ---- background sessions: at most the settings cap at work, the rest wait ----
  const crewIds = () => new Set(host.columns().filter((c) => c.captainCrew && !c.isMain).map((c) => c.id));
  const freeSlots = () => M.MAX_ACTIVE - M.activeCrew(state().tasks, crewIds()).size;
  let memoryHold = false;
  async function readMemoryPressure() {
    try {
      const value = await window.deck.memoryPressure();
      const level = value && (value.level === 1 || value.level === 2 || value.level === 4) ? value.level : null;
      return { level, critical: level === 4 };
    } catch (_) {
      return { level: null, critical: false };
    }
  }
  function refreshWaitingNotes(changed = false) {
    const s = state();
    if (!s) return;
    const active = M.activeCrew(s.tasks, crewIds()).size;
    let ahead = 0;
    for (const w of s.waitlist) {
      const plan = openPlan(w.cmd, w.metadata?.claudeSeatId, w.metadata?.quotaExplicit, w.metadata);
      const task = s.tasks.find((t) => t.id === w.taskId && t.status === 'waiting');
      const reason = queueReason(plan, w.title, active, ahead) || '等待派发';
      if (task && task.waitReason !== reason) { task.waitReason = reason; update(task); changed = true; }
      if (plan.action !== 'queue') ahead++;
    }
    if (changed) window.Sidebar?.render?.();
  }
  function queueReason(plan, title, active, ahead) {
    return plan.action === 'queue' ? quotaQueueText(plan, title) : memoryHold
      ? `已排队：内存吃紧，稍后自动开新会话「${title}」。`
      : active >= M.MAX_ACTIVE && capInfo().limited ? Bat().queueReason(title, M.MAX_ACTIVE, active)
      : active >= M.MAX_ACTIVE ? `已排队：现在有 ${active} 个会话占用干活名额，上限 ${M.MAX_ACTIVE}；有空位时自动开新会话「${title}」。`
      : ahead ? `已排队：前面有 ${ahead} 条可执行任务，当前 ${active} 个会话占用干活名额；按顺序自动开新会话「${title}」。` : '';
  }
  async function openSession(title, cmd, cwd, requestId, text, waiting, metadata = {}) {
    if (metadata.worktreeRequest && !metadata.worktree) {
      if (typeof window.deck.prepareWorktree !== 'function') throw new Error('这台 AgentDeck 还不能创建代码副本。');
      // A Claude session asks to trust the new folder (default row: No, exit): the app records that answer
      // for this copy in the seat that will run it, so the question never appears.
      const seat = window.AgentInfo.inferProvider(cmd) === 'Claude' && window.ClaudeSeatsCore.bindColumn({ claudeSeatId: metadata.claudeSeatId, claudeConfigDir: metadata.claudeConfigDir }, host.config);
      const { trust, ...prepared } = await window.deck.prepareWorktree({ ...metadata.worktreeRequest, ...(seat?.configDir ? { seatId: seat.id, configDir: seat.configDir } : {}) });
      metadata.worktree = prepared;
      cwd = prepared.path;
      metadata.trustedCwd = cwd;
      if (trust && !trust.ok) boardNotice(`代码副本 ${prepared.path} 没能预先登记 Claude 的文件夹信任（${trust.reason}）。会话若停在「是否信任此文件夹」，用 answer --key down,enter 选第二项。`);
    }
    const id = 'c-board-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let col = null;
    try {
    if (metadata.autoReviewRound) {
      // An automatic reviewer that waited in the queue only starts if its round is still the open one.
      const card = (await window.TaskBoard.list({ archived: true })).find((c) => c.id === metadata.boardId);
      if (!card || card.status !== 'review' || card.review_round !== metadata.autoReviewRound || card.review_session === true) throw new Error('这张卡片已经不在这一轮待验收了，审查会话没有开。');
    }
    if (metadata.boardId) {
      await boardRequest('bind', { id: metadata.boardId, project: metadata.project, session_id: id, attempt_id: requestId,
        reviews: metadata.reviews, review_round: metadata.reviewRound ?? metadata.autoReviewRound, exec_receipt: metadata.reviewReceipt,
        ...(metadata.worktree ? { worktree: metadata.worktree } : {}),
        assignee: { agent: window.BoardCore.inferAgentType(cmd), model: cmd.match(/(?:--model|-m)(?:\s+|=)["']?([^\s"']+)/)?.[1] || 'default' } });
      // A tell took the card back to execution while this bind was on its way (tellSession).
      if (retiredSessions.delete(id)) throw new Error('卡片已回到执行，这个审查会话不再开。');
    }
    col = host.createSession({ ...metadata, taskPrompt: text, captainTaskPrompt: text, id, boardAttempt: requestId, title, cmd, cwd, createdByRequestId: requestId, displayTitle: title, manualTitle: true, captainCrew: true }, true);
    if (waiting) { waiting.boardId = metadata.boardId || ''; waiting.boardAttempt = requestId; }
    dispatch(col, text, title, waiting);
    return col;
    } catch (error) {
      if (!col && metadata.worktree && typeof window.deck.reclaimWorktree === 'function') {
        try { await window.deck.reclaimWorktree(metadata.worktree); } catch (_) {}
      }
      throw error;
    }
  }
  // Only unsent new-session requests are cancelled here; supplements have their own lifecycle.
  function cancelWaiting(matches, reason) {
    const s = state();
    if (!s) return 0;
    const removed = s.waitlist.filter(matches);
    s.waitlist = s.waitlist.filter((w) => !removed.includes(w));
    for (const w of removed) {
      const task = s.tasks.find((t) => t.id === w.taskId && t.status === 'waiting');
      if (!task) continue;
      task.status = 'stopped';
      task.doneAt = Date.now();
      task.receipt = { summary: reason, files: [], images: [], failed: '', explicit: true };
      update(task);
    }
    if (removed.length) { save(); host.flushConfig?.(); }
    return removed.length;
  }
  // What decides whether a queued card may still be started: where it sits and what it says. A
  // priority mark, a receipt or a session binding do not count.
  const cardGist = (c) => JSON.stringify([c.status, c.flag || null, !!c.archived, c.title, c.detail]);
  const CARD_WORDS = { todo: '待办', doing: '进行中', review: '待验收', needs_user: '需要你', done: '已完成' };
  // Why a request that waited for quota must not start now ('' when it may). The user put a card back,
  // marked it 需要你, archived or edited it (on this machine or the other one) while it waited: the
  // Captain's old order no longer stands, so nothing opens by itself.
  async function queuedCardProblem(w) {
    const id = w.metadata?.boardId;
    if (!id) return '';
    // the board could not be read when it was queued: what the card looked like then is unknown, so the Captain decides
    if (w.gistUnread) return '排队那一刻看板读不到，没法确认这张卡之后有没有被改动';
    if (!w.cardGist) return '';
    let card;
    try { card = await findCard(id); } catch (_) { return null; }   // null: cannot tell now, the request goes back (priority order kept) and is judged on the next turn
    if (!card) return '卡片已经不在看板上了';
    if (card.archived) return '卡片已归档';
    // only a card that was NOT on 需要你 when the Captain queued it and is now: a Captain order given on a card already
    // there (a dispatcher's finish puts cards there) stands
    let queuedStatus = '';
    try { queuedStatus = JSON.parse(w.cardGist)[0]; } catch (_) {}
    if (card.status === 'needs_user' && queuedStatus !== 'needs_user') return '卡片在排队期间被放到了「需要你」，等用户拿主意';
    if (['held', 'blocked'].includes(card.flag)) return '卡片现在是' + (card.flag === 'held' ? '已挂起' : '被前置任务挡住');
    if (cardGist(card) !== w.cardGist) return `卡片在排队期间被改动过（现在在${CARD_WORDS[card.status] || card.status}）`;
    return '';
  }
  // A queued request keeps its text in config.json; a long one goes to a file first.
  async function enqueue(title, cmd, cwd, requestId, text, metadata = {}, reason = '') {
    const s = state();
    let body = text;
    if (body.length > M.LONG_PROMPT && metadata.executor !== 'chatgpt-web') {
      const file = await window.deck.saveLongPrompt(body).catch(() => '');
      if (!file) throw new Error('任务太长，存文件失败，没有排上队。');
      body = `${body.slice(0, 300).replace(/\s+/g, ' ').trim()}…\n（这件活共 ${text.length} 字，完整内容已存成文件，请先完整读取再照做：${file}）`;
      if (state() !== s) throw new Error('队长已经关掉了，这件活没有排上队。');   // closed while the file was written
    }
    const task = addTask(null, title, metadata.subCaptainId || '');
    Object.assign(task, metadata);
    const held = openPlan(cmd, metadata.claudeSeatId, metadata.quotaExplicit, metadata);
    task.waitReason = held.action === 'queue' ? quotaQueueText(held, title) : reason;
    // The card as it was when the Captain queued it: if it has changed by the time quota returns, nobody asked for this any more.
    const wantGist = !!metadata.boardId && !metadata.reviews?.length && !metadata.autoReviewRound;
    const queuedCard = wantGist ? await findCard(metadata.boardId).catch(() => null) : null;
    s.waitlist.push({ taskId: task.id, title, cmd, cwd, requestId, task: body, project: metadata.project, reviews: metadata.reviews, metadata,
      ...(queuedCard ? { cardGist: cardGist(queuedCard) } : wantGist ? { gistUnread: true } : {}),
      order: s.waitlist.reduce((max, w) => Math.max(max, w.order || 0), 0) + 1 });
    s.waitlist = M.highFirst(s.waitlist, isHigh);   // 高优先级 waits ahead of ordinary work
    save();
  }
  // The one way in for a new session: past the limit, behind work already waiting,
  // at quota or under critical memory it queues, otherwise it opens at once.
  async function placeSession(title, cmd, cwd, requestId, task, metadata, replaced) {
    const s = state();
    const pressure = await readMemoryPressure();
    const wasHold = memoryHold;
    memoryHold = pressure.critical;
    const plan = openPlan(cmd, metadata.claudeSeatId, metadata.quotaExplicit, metadata);
    const active = M.activeCrew(s.tasks, crewIds()).size;
    // Quota-held requests do not block a different available provider, and
    // ordinary work waiting for a slot does not hold back a 高优先级 request.
    const high = isHigh({ metadata });
    const ahead = s.waitlist.filter((w) => w !== replaced && (!high || isHigh(w)) && openPlan(w.cmd, w.metadata?.claudeSeatId, w.metadata?.quotaExplicit, w.metadata).action !== 'queue').length;
    const reason = queueReason(plan, title, active, ahead);
    if (reason) {
      await enqueue(title, cmd, cwd, requestId, task, metadata, reason);
      refreshWaitingNotes(true);
      return { queued: true, plan, result: reason };
    }
    if (wasHold !== memoryHold) refreshWaitingNotes(true);
    const shown = plan.action === 'switch' ? notedTitle(title, plan.note) : title;
    const col = await openSession(shown, plan.cmd, cwd, requestId, task, null, launchMeta(metadata, plan));
    announceSwitch(col, shown, plan);
    return { col, plan, title: shown };
  }
  // Start waiting work as slots free up, oldest first. Critical memory pressure waits.
  let pumping = false;
  let pumpAgain = false;
  function pump() { return withQueue(pumpOnce); }
  async function pumpOnce() {
    const s = state();
    if (!s || !s.waitlist.length) return;
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      const pressure = await readMemoryPressure();
      if (state() !== s || !s.waitlist.length) return;
      const active = M.activeCrew(s.tasks, crewIds()).size;
      const deferred = new Set();   // requests put back this turn because the board could not be read
      await M.fillQueue({
        cap: M.MAX_ACTIVE, active, waiting: s.waitlist.length, level: pressure.level,
        take: () => {
          if (state() !== s) return null;
          const index = s.waitlist.findIndex((w) => !deferred.has(w) && openPlan(w.cmd, w.metadata?.claudeSeatId, w.metadata?.quotaExplicit, w.metadata).action !== 'queue');
          return index < 0 ? null : s.waitlist.splice(index, 1)[0];
        },
        open: async (w) => {
          const task = s.tasks.find((t) => t.id === w.taskId && t.status === 'waiting');
          if (!task || state() !== s) return;
          const plan = openPlan(w.cmd, w.metadata?.claudeSeatId, w.metadata?.quotaExplicit, w.metadata);
          if (plan.action === 'queue') {
            s.waitlist.unshift(w); s.waitlist = M.highFirst(s.waitlist, isHigh);   // back in its own place: ahead of ordinary work only when it is 高优先级
            task.waitReason = quotaQueueText(plan, w.title);
            update(task);
            return;
          }
          const problem = await queuedCardProblem(w);
          if (problem === null) {
            s.waitlist.unshift(w); deferred.add(w);   // the board could not be read: put back and judged again on the next turn
            s.waitlist = M.highFirst(s.waitlist, isHigh);   // not simply to the head: a 高优先级 request that waited ahead stays ahead
            return;
          }
          if (problem) {
            task.status = 'stopped'; task.doneAt = Date.now();
            task.receipt = { summary: `额度回来了，但没有自动派：${problem}。`, files: [], images: [], failed: '', explicit: true };
            update(task);
            boardNotice(`卡片 ${w.metadata.boardId}「${w.title}」排队等额度，额度回来后没有自动开：${problem}。要做就再 new --task-id ${w.metadata.boardId} 一次。`);
            save();
            return;
          }
          const title = plan.action === 'switch' ? notedTitle(w.title, plan.note) : w.title;
          if (plan.action === 'switch') task.title = title;
          try {
            const col = await openSession(title, plan.cmd, w.cwd, w.requestId, w.task, task, launchMeta(w.metadata || { project: w.project || '', reviews: w.reviews || [] }, plan));
            announceSwitch(col, title, plan);
          } catch (error) { settle(task, { failed: error.message, summary: '', files: [], explicit: true }); }
        },
      });
      const wasHold = memoryHold;
      memoryHold = pressure.level === 4 && s.waitlist.length > 0;
      refreshWaitingNotes(wasHold !== memoryHold);
      save();
    } finally {
      pumping = false;
      if (pumpAgain) { pumpAgain = false; pump(); }
    }
  }
  // Board cards, kept for the archive check of failed/stopped sessions: whether
  // the card got done or went to another session. Refreshed at most every 20 s.
  let cardCache = null, cardsAt = 0, cardsLoading = false;
  function refreshCards() {
    if (cardsLoading || Date.now() - cardsAt < 20_000) return;
    cardsLoading = true; cardsAt = Date.now();
    window.TaskBoard.list({ archived: true }).then((list) => {
      cardCache = Object.fromEntries((Array.isArray(list) ? list : []).map((c) => [c.id, { status: c.status, archived: !!c.archived, session_id: c.session_id || '' }]));
    }, () => {}).finally(() => { cardsLoading = false; });
  }
  // A finished background session is archived once 队长 has its receipt and
  // nothing happened for M.ARCHIVE_AFTER; never one you are looking at.
  // After a restart its terminal is a fresh one that never worked this run
  // (state 'plain'), which counts as finished too.
  function maybeArchive(col, entry) {
    const s = state();
    if (!col.captainCrew || !host.isBackstage(col) || host.focusedId() === col.id) return;
    // its children, live or still queued for a slot, report to it
    if (isSubCaptain(col) && (childrenOf(col).length || s.waitlist.some((w) => w.metadata?.subCaptainId === col.id))) return;
    if (entry && entry.alive && (!['done', 'plain'].includes(entry.state) || entry.sendingPrompt || entry.injecting || M.terminalActivity(entry.lastScreen, col?.cmd) || M.claudeBackgroundTasks(entry.lastScreen, col?.cmd))) return;
    // The status dot and lastScreen are a few seconds old: look at the terminal itself
    // once more before ending it.
    if (entry && entry.alive && entry.term && host.dumpScreen) {
      const live = host.dumpScreen(entry.term, 40);
      if (M.terminalActivity(live, col?.cmd) || M.claudeBackgroundTasks(live, col?.cmd)) return;
      if (host.screenState && !['done', 'plain'].includes(host.screenState(live, entry, col?.cmd))) return;
    }
    // a dot that reads idle is only a guess: any recent output also means it is not finished
    if (entry && entry.alive && Date.now() - (entry.lastOutputAt || 0) < Math.min(ACTIVE_OUTPUT_MS, M.ARCHIVE_AFTER)) return;
    if (M.needsCardCheck(s, col.id)) refreshCards();
    if (!M.archivable({ ...s, pending: allPending(s) }, col.id, host.lastTurnTs(col.id), Date.now(), M.ARCHIVE_AFTER, cardCache)) return;
    // The screen can miss a background command (a cut footer, a status row scrolled
    // away): a shell command Claude started still running in the terminal's process
    // tree keeps it. No answer yet is not idle; a listing that failed (null) leaves
    // the decision to the screen.
    if (entry && entry.alive && host.ptyBackgroundWork) {
      const work = host.ptyBackgroundWork(col);
      if (work === true || work === undefined) return;
    }
    host.archiveColumn(col, { quiet: true });
  }
  // `tell` to a background session that was archived brings it back first. A 小队长 (sub) also
  // finds its own archived children filed into a folder: still its children, as its ledger lists them.
  function archivedCrew(ref, sub = null) {
    const key = String(ref || '').trim();
    const list = (host.config.archived || []).filter((a) => a.captainCrew || (sub && a.subCaptainId === sub.id));
    const byId = list.find((a) => a.id === key);
    if (byId) return byId;
    const byTitle = list.filter((a) => host.columnLabel(a) === key);
    return byTitle.length === 1 ? byTitle[0] : null;
  }

  function update(task) {
    const s = state();
    if (s && task.gen === s.gen) window.ChatUI.updateCard(task.subCaptainId || s.colId, task);
    save();
  }
  // A receipt arrived: record it on the column (the ledger), show it, queue it for the model.
  const CLOSED = ['done', 'failed', 'stopped', 'asking'];
  const NO_RECEIPT = '已结束，未提交回执';   // the three-minute fallback's notice: provisional, never a receipt
  function settle(task, receipt, boardRecorded = false) {
    if (CLOSED.includes(task.status) || task.pendingInstall) return;
    watchSettled(task, receipt);
    if (receipt.failed) Promise.resolve(window.deck.seatAuthFailure?.({ colId: task.colId, message: receipt.failed })).catch(() => {});
    if (receipt.failed && task.instructionSent === false && task.instruction) {
      receipt = { ...receipt, undeliveredInstruction: task.instruction, undeliveredTaskId: task.id };
    }
    if (task.boardId && !boardRecorded) {
      const type = receipt.failed ? 'failed' : receipt.question ? 'ask' : receipt.source === 'fallback' ? 'fallback' : 'complete';
      autoBoardEvent(task, type, receipt.failed || receipt.question || receipt.summary, receipt.source || 'automatic');
    }
    // An automatic reviewer that could not run (quota, crash, never started) is not a verdict and not a
    // finding. The reading that picked it was wrong or has changed, so the Captain is told at once, with
    // the way out, rather than finding the card with no review.
    const reviewCol = receipt.failed && receipt.source !== 'command' && task.boardId ? host.columns().find((c) => c.id === task.colId) : null;
    if (reviewCol && window.AutoVerifyCore?.isReviewAttempt(reviewCol.boardAttempt)) {
      const AVC = window.AutoVerifyCore, why = String(receipt.failed).split('\n')[0].slice(0, 160), kind = receipt.source === 'quota' ? '额度用尽' : '会话出错或退出';
      // the card is read for the command (its model follows the same rule as the automatic pick); a board that cannot be read still gets the notice
      findCard(task.boardId).catch(() => null).then((found) => {
        // a card that cannot be read: its own title (kept on the session) and Opus, never a guess that it is simple
        const card = found || { id: task.boardId, project: reviewCol.project || '', title: reviewCol.cardTitle || AVC.stripModelMarks(String(reviewCol.displayTitle || reviewCol.title || '').replace(/^审查：/, '').replace(/（Claude [^（）]*）$/, '')), important: true };
        const command = AVC.manualReviewCommand({ card, receipt: card.exec_receipt, cli: M.boardCli(host.platform), platform: host.platform, executorId: card.exec_receipt?.session_id || reviewCol.reviews?.[0] });
        boardNotice(`卡片 ${task.boardId} 的自动审查会话「${reviewCol.displayTitle || reviewCol.title || reviewCol.id}」没能跑起来（${kind}）：${why}。这一轮审查没有结论。不用等它，另派一个 Claude 审查，旧会话可归档（模型和档位写在 --command 里，new 不认 --model / --effort / --verify；可加 --seat 换有额度的席位）：${command}`);
      });
    }
    const dispatcher = host.columns().find((c) => c.id === task.colId && c.dispatcherCardId);
    const delegatedQueue = dispatcher && state()?.waitlist.some((w) => w.metadata?.boardId === dispatcher.dispatcherCardId);
    if (dispatcher && !delegatedQueue) window.deck.taskBoard('dispatcherReceipt', { id: dispatcher.dispatcherCardId, session_id: dispatcher.id, failed: receipt.failed || '', question: receipt.question || '', source: receipt.source }).then((result) => {
      if (receipt.failed) {
        if (result.card?.flag === 'held' && !result.ignored) boardNotice(`卡片 ${dispatcher.dispatcherCardId} 连续失败 2 次，已挂起。`);
      } else for (const notice of result.notices || []) boardNotice(notice);
    }, (error) => host.showToast(error.message));
    task.receipt = receipt;
    task.status = receipt.question ? 'asking' : receipt.failed ? 'failed' : receipt.explicit ? 'done' : 'stopped';
    task.doneAt = Date.now();
    const col = host.columns().find((c) => c.id === task.colId);
    if (col && !receipt.question) col.lastReceipt = { ...receipt, ts: task.doneAt };
    push(task, receipt.question
      ? { question: receipt.question, source: receipt.source }
      : { summary: receipt.summary, files: receipt.files, failed: receipt.failed, source: receipt.source, ...(receipt.undeliveredTaskId ? { undeliveredTaskId: receipt.undeliveredTaskId } : {}) });
    update(task);
    if (col?.executor === 'chatgpt-web') {
      const entry = host.terms.get(col.id);
      if (entry) { entry.webExecutorState = webTaskState(task); entry.state = entry.webExecutorState; }
      startWebTask(col);
    }
  }
  // Queue something for 队长's background reader (or the legacy quiet-moment injection).
  function push(task, item) {
    const s = state();
    if (!s || task.gen !== s.gen) return;
    const anomaly = M.exceptionReason(item);
    // Input/exit/quota events are deduplicated by task status/blockedAsked.
    // Never suppress a new task's failure or a decision the new Captain needs.
    // A sub-captain's child reports to the sub-captain, wherever its instruction came from. A child
    // whose column is gone (closed) or never opened (queued) is known by its record's subCaptainId.
    const col = host.columns().find((c) => c.id === task.colId);
    const sub = col ? subCaptainOf(col) : subCaptainOf({ subCaptainId: task.subCaptainId });
    (sub ? subQueue(s, sub.id) : s.pending).push({ ...(anomaly ? { anomaly } : {}), taskId: task.id, colId: task.colId, title: task.title, ts: Date.now(), ...item });
    return true;
  }
  // Hand every pending receipt to 队长's model as text; they count as in
  // flight until its turn ends.
  const MAX_RECEIPTS_SEEN = 500;
  const LISTENER_ALIVE = 15_000;   // a `receipts --wait` polls every few seconds
  let listener = null;            // { id, seq, at, colId }: the one background listener
  let listenerSeq = 0;
  const listenerSeqById = new Map(); // first registration only; a repeat poll keeps that seq
  function normalizeSeenIds(list) {
    const out = [];
    const have = new Set();
    for (const id of Array.isArray(list) ? list : []) {
      if (typeof id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(id) || have.has(id)) continue;
      have.add(id);
      out.push(id);
    }
    return out.slice(-MAX_RECEIPTS_SEEN);
  }
  function ensureReceiptId(item) {
    const s = state();
    if (typeof item.receiptId === 'string' && /^[a-z0-9-]{1,100}$/.test(item.receiptId)) return item.receiptId;
    s.receiptSeq = (Number.isSafeInteger(s.receiptSeq) ? s.receiptSeq : 0) + 1;
    item.receiptId = 'r-' + Date.now().toString(36) + '-' + s.receiptSeq.toString(36);
    return item.receiptId;
  }
  function rememberReceiptsSeen(items) {
    const s = state();
    if (!s) return;
    s.receiptsSeen = normalizeSeenIds([...(Array.isArray(s.receiptsSeen) ? s.receiptsSeen : []), ...items.map(ensureReceiptId)]);
  }
  // Whether the background channel handed this receipt to 队长's CLI. The mark is on
  // the receipt; the id list only speaks for receipts taken before the mark existed.
  function takenByChannel(item, seen) {
    return item.viaChannel === true || (typeof item.receiptId === 'string' && seen.has(item.receiptId));
  }
  // Taken before 队长 began a stretch of work it then finished: the model had it in
  // front of it throughout. Without a time there is no such sign.
  function dealtWith(item, s) {
    return Number.isFinite(item.takenAt) && item.takenAt <= (Number.isFinite(s.captainSettledAt) ? s.captainSettledAt : 0);
  }
  function unreadReceipts(items, seen) {
    return (Array.isArray(items) ? items : []).filter((item) => item && !takenByChannel(item, seen));
  }
  // Back to waiting: it will be handed over afresh, so it is no longer a taken one.
  function requeued(items) {
    const ids = new Set(items.map((p) => p.receiptId).filter((id) => typeof id === 'string'));
    const s = state();
    if (ids.size && Array.isArray(s.receiptsSeen)) s.receiptsSeen = s.receiptsSeen.filter((id) => !ids.has(id));
    return items.map(({ viaChannel, takenAt, ...item }) => item);
  }
  function takePending(nextTurn = false, batch, viaChannel = false) {
    const s = state();
    const text = M.receiptsForModel(s.pending);
    const before = { pending: s.pending, inflight: s.inflight, seen: s.receiptsSeen,
      inbox: host.config.todoInbox, accepted: host.config.todoDeliveries };
    const turnId = nextTurn ? '' : (window.ChatUI.turnsOf(s.colId).findLast((t) => t.kind !== 'task' && !t.done)?.id || '');
    if (viaChannel) rememberReceiptsSeen(s.pending);
    const confirmedTodo = viaChannel && confirmTodoReceipts(s.pending);
    s.inflight = [...s.inflight, ...s.pending.map(({ viaChannel: old, ...p }) => ({ ...p, deliveryTurnId: turnId, takenAt: Date.now(), ...(batch ? { batch } : {}), ...(viaChannel ? { viaChannel: true } : {}) }))];
    s.pending = [];
    try { if (confirmedTodo) persistTodoInbox(); else save(); }
    catch (error) {
      s.pending = before.pending; s.inflight = before.inflight; s.receiptsSeen = before.seen;
      host.config.todoInbox = before.inbox; host.config.todoDeliveries = before.accepted;
      save(); throw error;
    }
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
    if (entry.state === 'working' || entry.state === 'quota' || entry.state === 'input' || M.terminalActivity(entry.lastScreen, col?.cmd)) return;
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
        const back = s.inflight.filter((p) => p.batch === batch).map(({ batch: b, deliveryTurnId, takenAt, ...item }) => item);
        s.inflight = s.inflight.filter((p) => p.batch !== batch);
        s.pending = [...back, ...s.pending];
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

  // Authenticated submissions bind to the most recent instruction actually
  // sent to this column, never to an unsent supplement or another worker.
  async function submit(message, caller) {
    const s = state();
    if (!s || isMain(caller)) return null;
    if (['complete', 'ask', 'progress'].includes(message.action) && !message.nativeWeb) restartWatch?.confirm(caller.id, Date.now());
    const task = s.tasks.findLast((t) => t.colId === caller.id && t.status !== 'waiting' && (t.startedAt || message.action === 'session-exit' && t.restartHold) && (caller.executor !== 'chatgpt-web' || !message.taskId || t.id === message.taskId));
    if (caller.executor === 'chatgpt-web' && (!message.taskId || !task || CLOSED.includes(task.status))) return { done: true, result: 'Submission ignored: web task is no longer active.' };
    const response = { done: true, result: 'Submission recorded.' };
    if (['complete', 'ask', 'progress'].includes(message.action) &&
        window.RestartResume?.bindSessionIdentity(caller, message.modelSessionIds, host.columns())) save();
    if (task?.pendingInstall && message.action !== 'progress') {
      if (message.action === 'session-exit') return response;
      throw new Error('安装待核对：只能由正式安装脚本的运行结果完成任务，不能提前 complete。');
    }
    if (message.action === 'session-exit') {
      if (!Number.isInteger(message.code)) throw new Error('Invalid agent exit code.');
      if (message.code !== 0 && task && fallbackResume(caller, task, `原对话启动失败（exit ${message.code}）`)) return response;
      // The agent can exit back into a live shell. Its unsent additions must
      // fail too, without attaching the old turn's exit to the newest addition.
      for (const queued of s.tasks) {
        if (queued.colId === caller.id && queued.status === 'queued' && !queued.restartHold) {
          settle(queued, { summary: '', files: [], images: [], failed: `agent 进程已退出（exit ${message.code}），补充指令未送达`, explicit: true, source: 'process' });
        }
      }
    }
    if (!task || task.status === 'stopped' && task.receipt?.source !== 'fallback') return message.action === 'session-exit' ? response : null;
    // A sub-captain reports in stages: every complete or ask it sends reaches the Captain, not only the first.
    if (isSubCaptain(caller) && ['complete', 'ask'].includes(message.action) && task.receipt?.source === 'command' && ['done', 'failed'].includes(task.status)) {
      task.status = 'working';
      task.gen = s.gen;
    }
    if (task.receipt?.source === 'command' && ['done', 'failed'].includes(task.status)) return response;
    if (message.action === 'session-exit') {
      if (task.status === 'stopped' && task.receipt?.source === 'fallback') {
        task.status = 'working';
        task.gen = s.gen; // closed under an earlier Captain: the exit receipt goes to this one
        dropReceipts(s, (p) => p.taskId === task.id && p.source === 'fallback');
      }
      if (!CLOSED.includes(task.status) || task.status === 'asking') {
        if (task.status === 'asking') task.status = 'working';
        const entry = host.terms.get(caller.id);
        // The exit command may beat the status tick; read the current terminal.
        const screen = entry?.term ? host.dumpScreen(entry.term, 40) : entry?.lastScreen;
        const receipt = { summary: '', files: [], images: [], failed: `agent 进程已退出（exit ${message.code}），未提交回执`, explicit: true, source: 'process', ...M.resourceReceipt(screen, caller.cmd), exited: true };
        await recordReceiptForBoard(task, receipt);
        settle(task, receipt, true);
      }
      return response;
    }
    if (message.action === 'progress') {
      if (typeof message.message !== 'string' || !message.message.trim()) throw new Error('progress requires --message.');
      if (message.installId !== undefined) {
        if (typeof message.installId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(message.installId) || typeof message.targetVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(message.targetVersion)) throw new Error('Invalid installation identity.');
        if (task.pendingInstall && (task.pendingInstall.id !== message.installId || task.pendingInstall.targetVersion !== message.targetVersion)) throw new Error('已有安装正在等待核对。');
        task.pendingInstall = { id: message.installId, targetVersion: message.targetVersion, createdAt: Date.now() };
        response.result = JSON.stringify({ taskId: task.id, columnId: caller.id });
      }
      task.progress = message.message;
      if (caller.executor === 'chatgpt-web') {
        task.webPhase = message.phase === 'running' ? 'running' : 'queued';
        const entry = host.terms.get(caller.id);
        if (entry) entry.webQueued = task.webPhase === 'queued';
      }
      caller.progress = message.message;
      task.endedAt = 0;
      persistResumeEntry(caller, task);
      update(task);
      if (message.installId) persistInstallation();
      return response;
    }
    const receipt = M.commandReceipt(message);
    delete task.progress; // this authenticated receipt is newer than prior progress
    task.resumeSubmission = true; // cancel delayed delivery before the asynchronous board write
    // A sub-captain's complete is a stage report for the Captain: only `complete --final`
    // finishes its board card (and opens a review round when the card asks for one).
    if (!(isSubCaptain(caller) && message.action === 'complete' && message.final !== true)) await recordReceiptForBoard(task, receipt);
    // A real submission may follow a question or the no-receipt notice. Replace
    // an unread automatic notice so the Captain sees the authoritative result.
    // A sub-captain reports in stages on this one record: what it said itself stays.
    if (['asking', 'stopped', 'failed'].includes(task.status)) {
      if (task.receipt?.source === 'command' && task.status !== 'asking') return response;
      const ownWords = isSubCaptain(caller);
      dropReceipts(s, (p) => p.taskId === task.id && !(ownWords && p.source === 'command'));
      task.status = 'working';
      task.gen = s.gen; // a closed task keeps its old Captain's generation; the real result must reach the current one
    }
    settle(task, receipt, true);
    return response;
  }

  // Only tasks present at renderer initialization belong to this cold-start
  // batch. New/tell/archive restoration use ordinary dispatch, never this queue.
  let resumeManifest = window.RestartResume ? window.RestartResume.emptyManifest() : { version: 1, claims: {}, entries: [] };
  const coldTasks = new Map();
  const resumeWaiting = new Map();
  const resumeOps = new Map();
  let resumeRun = '';
  let resumeInflight = 0;
  let resumeTimer = null;
  const RESUME_START_TIMEOUT = 30000;
  const RESUME_SEND_TIMEOUT = 45000;
  const INSTALL_OUTCOME_MS = 6 * 60 * 60 * 1000;
  function loadResumeManifest() {
    const R = window.RestartResume;
    if (!R) return;
    try { resumeManifest = R.parseManifest(JSON.stringify(window.deck.restartManifestLoad() || null)); }
    catch (_) { resumeManifest = R.emptyManifest(); }
    resumeRun = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    coldTasks.clear();
    const coldCrew = new Set(host.columns().filter((col) => col.captainCrew && !col.isMain && !col.archived).map((col) => col.id));
    for (const task of R.latestTasks(state()?.tasks).values()) {
      if (coldCrew.has(task.colId) && R.shouldResume(task)) coldTasks.set(task.colId, task.id);
      delete task.resumeSubmission;
      delete task.resumeFallback;
      delete task.resumeFailed;
      delete task.resumeDeadline;
    }
    beginRestartWatch();
  }
  function saveResumeManifest() {
    try { window.deck.restartManifestSave(resumeManifest); } catch (_) {}
  }
  function latestTask(colId) {
    return state()?.tasks.findLast((t) => t.colId === colId) || null;
  }
  function pendingInstruction(colId) {
    return (state()?.tasks || []).filter((t) => t.colId === colId && !t.instructionSent && window.RestartResume.shouldResume(t))
      .map((t) => t.instruction || '').filter(Boolean).join('\n\n');
  }
  function persistResumeEntry(col, task) {
    const R = window.RestartResume;
    if (!R || !col || !task || col.executor === 'chatgpt-web') return;
    const prior = resumeManifest.entries.find((e) => e.colId === col.id);
    // 已结束，未提交回执 (the fallback) is no receipt: the session's own progress, if any, is its last word.
    const receipt = task.progress || (task.receipt && !task.receipt.checkpoint && task.receipt.source !== 'fallback' ? task.receipt.summary || task.receipt.failed || task.receipt.question : '');
    const entry = R.manifestEntry({
      colId: col.id, cmd: col.cmd, cwd: col.cwd || '', sessionId: col.modelSessionId,
      title: task.title, detail: col.captainTaskPrompt || prior?.task || col.taskPrompt || task.instruction || '',
      receipt: receipt || prior?.receipt || col.lastReceipt?.summary || '', pendingText: pendingInstruction(col.id), task,
    });
    resumeManifest.entries = resumeManifest.entries.filter((e) => e.colId !== col.id);
    resumeManifest.entries.push(entry);
    saveResumeManifest();
  }
  function activeResume(col, task, op) {
    return host.columns().includes(col) && latestTask(col.id) === task && window.RestartResume.shouldResume(task) &&
      !task.resumeSubmission && (!op || resumeOps.get(col.id) === op);
  }
  function noteBoard(col, task, note) {
    if (!task.boardId && !col.boardId) return;
    boardWrites = boardWrites.catch(() => {}).then(() => {
      if (!activeResume(col, task)) return;
      return window.deck.taskBoard('resumeNote', {
        id: task.boardId || col.boardId, session_id: col.id, attempt_id: task.boardAttempt || col.boardAttempt || '', note,
      });
    }).catch(() => {});
  }
  function noteResumeFailure(col, task, reason) {
    if (!activeResume(col, task) || task.resumeFailed) return;
    task.resumeFailed = true;
    delete task.restartHold;
    delete task.resumeDeadline;
    resumeWaiting.delete(col.id);
    const failed = window.RestartResume.failureNote(reason);
    restartWatch?.fail(col.id, failed);
    resumeManifest.claims[col.id] = { phase: 'failed', runId: resumeRun, taskId: task.id, at: Date.now() };
    saveResumeManifest();
    settle(task, { summary: '', files: [], images: [], failed, explicit: true, source: 'resume' });
    host.showToast(failed);
  }
  function restartLaunch(col, isFresh) {
    const R = window.RestartResume;
    const task = col && latestTask(col.id);
    if (col?.executor === 'chatgpt-web') return { mode: 'leave' };
    // No task record (respawned under a new id, or old records pruned): nothing to resume.
    if (!R || !col || !task || !R.resumeEnabled(host.config) || !col.captainCrew || col.isMain ||
        coldTasks.get(col.id) !== task.id || (isFresh && !task.resumeFallback)) return { mode: 'leave' };
    const owner = col.modelSessionOwner === col.id && col.modelSessionCwd === (col.cwd || '') &&
      !host.columns().some((c) => c !== col && String(c.modelSessionId || '').toLowerCase() === String(col.modelSessionId || '').toLowerCase() && R.providerOf(c.cmd) === R.providerOf(col.cmd));
    return R.launchChoice({ cmd: col.cmd, sessionId: owner && !task.resumeFallback ? col.modelSessionId : null, task, enabled: true });
  }
  // Its Claude never started (ClaudeSeatsCore.launchBlock): work running in it or sent to it fails
  // with the seat named. Nothing is typed into its shell and it is never moved to another seat.
  function launchBlocked(col, reason) {
    const s = state();
    if (!s || !col || isMain(col)) return;
    for (const t of s.tasks) {
      if (t.colId === col.id && t.status !== 'waiting') settle(t, { summary: '', files: [], images: [], failed: reason, explicit: true, source: 'startup' });
    }
  }
  function notePtySurvived(col) {
    if (!col) return;
    captainRelaunched(col, true);
    if (!isMain(col)) restartWatch?.drop(col.id);
    coldTasks.delete(col.id);
    resumeWaiting.delete(col.id);
    const task = latestTask(col.id);
    if (task) delete task.restartHold;
    if (col.executor === 'chatgpt-web') {
      const entry = host.terms.get(col.id);
      if (entry) entry.webExecutorState = state()?.tasks.some((t) => t.colId === col.id && t.status === 'working') ? 'working' : webTaskState(task);
      Promise.resolve(window.deck.chatgptWebStatus(col.id)).then((status) => {
        const running = state()?.tasks.find((t) => t.colId === col.id && t.status === 'working');
        if (status?.active && running?.id === status.taskId) {
          running.progress = status.progress || running.progress;
          running.webPhase = status.phase === 'running' ? 'running' : 'queued';
          if (entry) entry.webQueued = running.webPhase === 'queued';
          update(running);
        } else if (running && status?.receipt && status.receipt.taskId === running.id) {
          submit({ action: 'complete', taskId: running.id, ...status.receipt }, col);
        } else if (running && !status?.active) {
          settle(running, { summary: '', files: [], images: [], failed: '网页执行器没有正在运行的任务；请检查已保存报告及保留请求页后再安排任务。', explicit: true, source: 'process' });
        } else startWebTask(col);
      }).catch(() => {});
    }
  }
  // resumed: the CLI was relaunched into the conversation it had before the app closed.
  function noteColdColumn(col, isFresh, resumed) {
    captainRelaunched(col, !!resumed);
    if (col?.executor === 'chatgpt-web') {
      if (!isFresh) for (const task of (state()?.tasks || []).filter((t) => t.colId === col.id && t.instructionSent && !CLOSED.includes(t.status))) {
        settle(task, { summary: '', files: [], images: [], failed: 'AgentDeck 已重启，网页任务已中断；请检查保留的请求页后再安排任务，系统不会自动重发。', explicit: true, source: 'process' });
      }
      startWebTask(col);
      return;
    }
    const R = window.RestartResume;
    const task = col && latestTask(col.id);
    if (!col || col.isMain || !col.captainCrew || !R || !R.resumeEnabled(host.config) ||
        coldTasks.get(col.id) !== task?.id || (isFresh && !task.resumeFallback) || !R.shouldResume(task) || task.resumeSubmission) return;
    if (resumeWaiting.has(col.id) || resumeOps.has(col.id)) return;
    const how = R.claimDisposition(resumeManifest.claims[col.id], task.id, resumeRun);
    if (how === 'skip') return;
    task.restartHold = true;
    task.resumeDeadline = Date.now() + RESUME_START_TIMEOUT;
    // Closed only by 已结束，未提交回执 (a quit that parked nothing): continued now, so that notice is not news.
    if (R.provisionalStop(task)) dropReceipts(state(), (p) => p.taskId === task.id && p.source === 'fallback');
    if (R.isCheckpointClosure(task) || R.provisionalStop(task)) { task.status = 'paused'; task.doneAt = 0; task.endedAt = 0; }
    resumeWaiting.set(col.id, how);
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(flushResume, 600);
  }
  async function resumeBody(col, task, stored) {
    const entry = {
      mode: col.restartMode === 'resume' && !task.resumeFallback ? 'resume' : 'resend',
      provider: window.RestartResume.providerOf(col.cmd) || '未知',
      title: task.title || stored.title || '', task: stored.task || task.instruction || col.taskPrompt || '',
      // its own progress is its last word; 已结束，未提交回执 is the app's, not a receipt
      receipt: stored.receipt || task.progress || '', pendingText: pendingInstruction(col.id) || stored.pendingText || '',
    };
    // It started an installation that ended the app: tell it so, and what it came to once that is known.
    if (task.pendingInstall) entry.install = { targetVersion: task.pendingInstall.targetVersion };
    else if (task.installOutcome && Date.now() - (task.installOutcome.at || 0) < INSTALL_OUTCOME_MS) entry.install = { targetVersion: task.installOutcome.targetVersion, summary: task.installOutcome.summary };
    const boardId = task.boardId || col.boardId;
    if (boardId) {
      try {
        const card = (await window.TaskBoard.list({ archived: true })).find((item) => item.id === boardId);
        if (card) {
          const reason = card.archived ? '卡片已归档' : card.attempt_closed ? '卡片本轮任务已关闭' :
            card.status === 'done' ? '卡片已完成' : card.status === 'review' && !card.review_session ? '卡片已进入待验收' :
            card.session_id && card.session_id !== col.id ? '卡片已转交会话 ' + card.session_id :
            card.attempt_id && task.boardAttempt && card.attempt_id !== task.boardAttempt ? '卡片已进入另一轮任务' : '';
          if (reason) return { blocked: `续派已停止：会话 ${col.id} 的任务 ${task.id} 停在卡片 ${boardId} 核验处，${reason}。未发送续接指令。` };
          entry.task = card.detail || entry.task;
          if (!entry.receipt && card.latest_receipt !== NO_RECEIPT) entry.receipt = card.latest_receipt || '';
        }
      } catch (_) {}
    }
    if (task.instruction && !entry.task.includes(task.instruction) && !entry.pendingText.includes(task.instruction)) entry.task += '\n最后送达的任务指令：\n' + task.instruction;
    if (!entry.receipt && task.receipt && !task.receipt.checkpoint && task.receipt.source !== 'fallback') entry.receipt = task.receipt.summary || task.receipt.failed || task.receipt.question || '';
    return entry;
  }
  function fallbackResume(col, task, reason) {
    if (!task.restartHold || !activeResume(col, task) || col.restartMode !== 'resume' || task.resumeFallback || !host.restartWorker) return false;
    task.resumeFallback = true;
    const op = resumeOps.get(col.id);
    if (op) op.release();
    resumeOps.delete(col.id);
    resumeWaiting.delete(col.id);
    delete resumeManifest.claims[col.id];
    col.restartMode = 'resend';
    delete col.modelSessionId;
    delete col.modelSessionOwner;
    delete col.modelSessionCwd;
    delete col.modelSessionSource;
    task.resumeDeadline = Date.now() + RESUME_START_TIMEOUT;
    task.status = 'paused';
    persistResumeEntry(col, task);
    host.showToast(reason + '；新开会话并重发同一卡片任务和最后回执');
    try { host.restartWorker(col); }
    catch (_) { noteResumeFailure(col, task, '新会话启动失败'); }
    return true;
  }
  function flushResume() {
    const R = window.RestartResume;
    if (!state() || !R) return;
    const ready = [];
    let waiting = false;
    for (const [id, how] of resumeWaiting) {
      const col = host.columns().find((c) => c.id === id && c.captainCrew && !c.isMain);
      const task = latestTask(id);
      if (!col || !task || !activeResume(col, task)) { resumeWaiting.delete(id); continue; }
      if (Date.now() > task.resumeDeadline) {
        resumeWaiting.delete(id);
        if (!fallbackResume(col, task, '续接启动等待超时')) noteResumeFailure(col, task, '启动或批次等待超过 30 秒');
        continue;
      }
      if (!host.terms.get(id)?.alive) {
        waiting = true;
        continue;
      }
      ready.push({ id, how });
    }
    for (const item of R.nextBatch(ready, resumeInflight, R.BATCH)) {
      resumeWaiting.delete(item.id);
      const col = host.columns().find((c) => c.id === item.id);
      const task = latestTask(item.id);
      resumeInflight += 1;
      let released = false;
      const op = { release() {
        if (released) return;
        released = true;
        clearTimeout(op.timer);
        if (resumeOps.get(col.id) === op) resumeOps.delete(col.id);
        resumeInflight -= 1;
        flushResume();
      } };
      resumeOps.set(col.id, op);
      const fail = () => {
        if (activeResume(col, task, op)) {
          if (!fallbackResume(col, task, '续接指令没有送进原对话')) noteResumeFailure(col, task, '新会话的重发指令也未能送达');
        }
        op.release();
      };
      task.resumeDeadline = Date.now() + RESUME_SEND_TIMEOUT;
      op.timer = setTimeout(fail, RESUME_SEND_TIMEOUT);
      const stored = resumeManifest.entries.find((e) => e.colId === col.id && e.taskId === task.id) || {};
      resumeBody(col, task, stored).then((entry) => {
        if (released) return;
        if (!entry || !activeResume(col, task, op)) { op.release(); return; }
        if (entry.blocked) {
          restartWatch?.drop(col.id);
          task.resumeSubmission = true;
          delete task.restartHold;
          delete task.resumeDeadline;
          resumeManifest.claims[col.id] = { phase: 'stopped', runId: resumeRun, taskId: task.id, at: Date.now() };
          resumeManifest.entries = resumeManifest.entries.filter((e) => e.colId !== col.id);
          saveResumeManifest();
          // The card was closed or reassigned elsewhere; only close our stale
          // local task and report the stop, never write a new card event.
          task.status = 'paused';
          settle(task, { summary: entry.blocked, files: [], images: [], failed: '', explicit: false, source: 'restart' }, true);
          op.release();
          return;
        }
        resumeManifest.entries = resumeManifest.entries.filter((e) => e.colId !== col.id);
        resumeManifest.entries.push(R.manifestEntry({ colId: col.id, cmd: col.cmd, cwd: col.cwd || '', sessionId: col.modelSessionId,
          task, title: entry.title, detail: entry.task, receipt: entry.receipt, pendingText: entry.pendingText }));
        resumeManifest.claims[col.id] = { phase: 'armed', runId: resumeRun, taskId: task.id, mode: entry.mode, at: Date.now() };
        saveResumeManifest();
        const resumeText = R.resumeMessage(entry);
        host.sendWhenReady(col, resumeText, {
          silent: true, force: true, guardUserInput: true, timeout: RESUME_SEND_TIMEOUT, suffix: M.RECEIPT_CONTRACT,
          cancelled: () => released || !activeResume(col, task, op),
          onSent: (turn) => {
            if (released || !activeResume(col, task, op)) { op.release(); return; }
            restartWatch?.sent(col.id, Date.now(), resumeText + M.RECEIPT_CONTRACT, !!host.terms.get(col.id)?.promptSettledAt);
            resumeManifest.claims[col.id] = { phase: 'sent', runId: resumeRun, taskId: task.id, mode: entry.mode, at: Date.now() };
            for (const t of state().tasks) {
              // only its unsent supplements went in with this message; an older task that ran and ended stays as it was
              if (t.colId !== col.id || !R.shouldResume(t) || R.provisionalStop(t) || t === task) continue;
              t.instructionSent = true;
              t.status = 'done';
              t.doneAt = Date.now();
              t.receipt = { summary: '已合并到后面的补充指令，一起送达。', files: [], failed: '', explicit: true, source: 'merged' };
              update(t);
            }
            if (entry.pendingText) task.instruction = entry.pendingText;
            if (entry.install?.summary) delete task.installOutcome;   // said once
            task.instructionSent = true;
            task.status = 'working';
            task.turnId = turn?.id || '';
            task.startedAt = Date.now();
            task.endedAt = 0;
            delete task.restartHold;
            delete task.resumeDeadline;
            delete task.processEnded;
            task.resumeGraceUntil = Date.now() + 20000;
            const summary = entry.mode === 'resume' ? R.trueResumeNote(entry.provider) : R.resendNote(entry.provider);
            task.receipt = { summary, files: [], images: [], failed: '', explicit: true, checkpoint: true, source: 'restart' };
            col.lastReceipt = { ...task.receipt, ts: Date.now() };
            persistResumeEntry(col, task);
            update(task);
            noteBoard(col, task, summary);
            op.release();
          },
          onGiveUp: fail,
        });
      }).catch(fail);
    }
    if (waiting || resumeWaiting.size) resumeTimer = setTimeout(flushResume, 400);
  }
  function parkForRestart(sessions) {
    const R = window.RestartResume;
    const s = state();
    if (!s || !R || !R.resumeEnabled(host.config)) return;
    if (sessions && typeof sessions === 'object') {
      for (const col of host.columns()) {
        if (!Object.prototype.hasOwnProperty.call(sessions, col.id)) continue;
        if (!['Cursor', 'Codex', 'Antigravity'].includes(R.providerOf(col.cmd))) continue;
        // The renderer may have captured an authenticated id more recently
        // than the debounced config read by the shutdown process.
        if (col.modelSessionSource === 'agent-env' && col.modelSessionOwner === col.id &&
            col.modelSessionCwd === (col.cwd || '') && R.validSessionId(col.modelSessionId)) continue;
        if (sessions[col.id] && col.modelSessionOwner === col.id) col.modelSessionId = sessions[col.id];
        else { delete col.modelSessionId; delete col.modelSessionOwner; delete col.modelSessionCwd; delete col.modelSessionSource; }
      }
    }
    const parking = [];
    for (const plan of R.planPark(host.columns(), s.tasks)) {
      const task = latestTask(plan.id);
      const col = host.columns().find((c) => c.id === plan.id);
      if (!task || !col || col.executor === 'chatgpt-web') continue;
      // Snapshot full queued bodies and the prior receipt BEFORE changing status.
      persistResumeEntry(col, task);
      // Closed only by 已结束，未提交回执: that notice is not what happened any more (the restart continues it).
      if (plan.idle) dropReceipts(s, (p) => p.taskId === task.id && p.source === 'fallback');
      const batch = dispatches.get(col.id);
      if (batch) batch.cancelled = true;
      task.status = 'paused';
      task.restartHold = true;
      task.doneAt = 0;
      task.endedAt = 0;
      task.receipt = { summary: R.checkpointSummary(), files: [], images: [], failed: '', explicit: true, checkpoint: true, source: 'restart' };
      col.lastReceipt = { ...task.receipt, ts: Date.now() };
      const term = host.terms.get(col.id);
      // An idle one already stopped where it is: a message now would only start a turn the quit cuts off.
      if (term?.alive && !plan.idle) {
        parking.push(new Promise((resolve) => {
          const timer = setTimeout(resolve, 800);
          const finish = () => { clearTimeout(timer); resolve(); };
          try { host.sendWhenReady(col, plan.message, { silent: true, guardUserInput: true, timeout: 800,
            cancelled: () => !activeResume(col, task), onSent: finish, onGiveUp: finish }); } catch (_) { finish(); }
        }));
      }
    }
    resumeManifest.entries = resumeManifest.entries.filter((e) => R.shouldResume(latestTask(e.colId)));
    // A completed send only belongs to this run, never the next reboot.
    resumeManifest.claims = {};
    saveResumeManifest();
    save();
    try { window.deck.saveConfigSync(host.config); } catch (_) {}
    return Promise.all(parking);
  }

  // ---- restart watch: after a start, is everyone back? ----
  // RestartResume.createRestartWatch keeps the clock: the 队长 within a minute of the start, each crew task this
  // run continues within 90 s of its message going in (three minutes when it never went in). Back means the
  // agent itself did something after its message: its screen showed it working, it ran an AgentDeck command,
  // its task settled, or (its prompt had settled before the send) it drew something new and our text is not
  // left in its box. On 10-09 none of that happened for four hours and nobody was told. What is not back is
  // reported once: an urgent 待我处理 item (the sidebar and the phone), the local alert and critical Bark
  // (main.js restart:alarm) and a toast; crew sessions also go to the 队长 as a notice. A recovery ticks it off.
  let restartWatch = null;
  let restartAlarms = [];     // { id: 待我处理 item, cols: column ids still out, resolved }
  let restartCheckedAt = 0;
  function beginRestartWatch() {
    const R = window.RestartResume;
    restartWatch = null;
    restartAlarms = [];
    if (!R?.createRestartWatch || !state()) return;
    const now = Date.now(), ms = host.restartWatchMs || 0;
    restartWatch = R.createRestartWatch({ startedAt: now, ...(ms ? { captainLimit: ms, crewLimit: ms, crewStartLimit: 2 * ms } : {}) });
    const cap = mainCol();
    // A Relay still starting a new 队长 has its own watchdog (relayStartup); a bare shell gets no prompt.
    if (cap?.cmd && !state().relayStartup?.attempt) restartWatch.expect(cap.id, 'captain', '队长', now);
    if (!R.resumeEnabled(host.config)) return;
    for (const [colId, taskId] of coldTasks) {
      const col = host.columns().find((c) => c.id === colId);
      if (!col || col.executor === 'chatgpt-web') continue;
      restartWatch.expect(colId, 'crew', state().tasks.find((t) => t.id === taskId)?.title || col.title || colId, now);
    }
  }
  function leftInBox(entry, text) {
    if (!entry?.term || !text || !window.ChatCore || !host.dumpScreen) return false;
    return window.ChatCore.promptLeftInBox(host.dumpScreen(entry.term, 80), text);
  }
  function restartEvidence(id, entry) {
    const it = restartWatch.item(id);
    if (!it?.sentAt || !entry?.alive) return;
    const now = Date.now();
    if (entry.state === 'working' && !entry.backgroundOnly) { restartWatch.confirm(id, now); return; }
    const col = host.columns().find((c) => c.id === id);
    if (!it.ready || !col || now - it.sentAt < 1500 || (entry.lastOutputAt || 0) <= it.sentAt) return;
    if (!M.agentPromptDrawn(entry.lastScreen, col.cmd) || leftInBox(entry, it.text)) return;
    restartWatch.confirm(id, now);
  }
  function watchSettled(task, receipt) {
    if (!restartWatch?.pending(task.colId)) return;
    if (receipt.source === 'restart') { restartWatch.drop(task.colId); return; }
    if (receipt.source === 'resume') return;   // noteResumeFailure has reported it
    if (receipt.failed && !restartWatch.item(task.colId)?.sentAt) { restartWatch.fail(task.colId, receipt.failed); return; }
    restartWatch.confirm(task.colId, Date.now());
  }
  function restartReason(d) {
    const col = host.columns().find((c) => c.id === d.id), entry = host.terms.get(d.id);
    const who = d.kind === 'captain' ? '队长' : '它', what = d.kind === 'captain' ? '重启提示' : '续接指令';
    if (d.reason) return d.reason;
    if (!col || !entry) return `${who}这一列没有起来`;
    if (!entry.alive) return `${who}的终端已经退出` + (entry.exitReason ? `（${entry.exitReason}）` : '');
    if (entry.seatBlock) return `${who}的席位不能用：${entry.seatBlock}`;
    const it = restartWatch.item(d.id);
    if (!it?.sentAt) return entry.state === 'input' ? `${who}停在一个确认提示上，${what}送不进去` : `${who}的界面一直没准备好，${what}还没送进去`;
    if (leftInBox(entry, it.text)) return `${what}停在${who}的输入框里没发出去`;
    return `${what}已送进去，但${who}一直没开始干活`;
  }
  function restartAlarm(list) {
    const s = state();
    const captain = list[0].kind === 'captain';
    const rows = list.map((d) => ({ ...d, why: restartReason(d) }));
    const span = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`);
    const title = captain ? '重启后队长没接上' : `重启后 ${rows.length} 个队员没接上`;
    const ask = captain
      ? `AgentDeck 启动已超过 ${span(restartWatch.limits.captain)}，队长还没开始干活：回执没人收，活都停着。请打开 AgentDeck 看队长那一列，输入框里有字就按回车，停在提示框就处理掉。`
      : '这些队员重启后没接上原来的活。请打开 AgentDeck 看一眼（输入框里有字就按回车），或让队长用 tell 叫醒它们。';
    const detail = rows.map((r) => `「${r.title}」（${r.id}）：${r.why}`).join('\n');
    const item = window.AttentionUI?.alarm({ title, ask, detail, session: rows[0].id, sessionTitle: rows[0].title });
    restartAlarms.push({ id: item?.id || '', cols: new Set(rows.map((r) => r.id)), resolved: false });
    const message = (title + '：' + rows.map((r) => `「${r.title}」${r.why}`).join('；')).slice(0, 1000);
    const key = 'restart-' + String(resumeRun).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) + '-' + restartAlarms.length;
    Promise.resolve(window.deck.restartAlarm?.(message, key))
      .then((r) => { if (r && r.ok === false) host.showToast('重启报警没能推到手机：' + (r.message || 'Bark 发送失败')); })
      .catch(() => host.showToast('重启报警没能推到手机，请检查 Bark 设置。'));
    host.showToast(message.slice(0, 300));
    // The 队长 (when it is back) can wake them itself.
    if (!captain && s) for (const r of rows) {
      const task = latestTask(r.id);
      if (task) push(task, { summary: `重启后续接没接上：${r.why}。用 tell 叫醒它，或 peek 看它停在哪。`, source: 'restart-watch' });
    }
    if (!captain) save();
  }
  function restartCheck() {
    const now = Date.now();
    if (now - restartCheckedAt < 1000) return;
    restartCheckedAt = now;
    // Not ours to report any more: a 队长 replaced since (a Relay, a cleared context) or one a Relay is still
    // starting (relayStartup has its own watchdog), a crew column that is gone.
    const s = state();
    const due = restartWatch.due(now).filter((d) => d.kind === 'captain'
      ? s?.colId === d.id && !!mainCol() && !s.relayStartup?.attempt
      : host.columns().some((c) => c.id === d.id));
    for (const kind of ['captain', 'crew']) {
      const list = due.filter((d) => d.kind === kind);
      if (list.length) restartAlarm(list);
    }
    const back = restartWatch.recovered().map((b) => b.id);
    if (!back.length) return;
    for (const alarm of restartAlarms) {
      for (const id of back) alarm.cols.delete(id);
      if (alarm.cols.size || alarm.resolved) continue;
      alarm.resolved = true;
      if (alarm.id) window.AttentionUI?.resolveAlarm(alarm.id, '已接上，自动勾掉');
    }
    host.showToast(back.includes(state()?.colId) ? '队长已接上' : `${back.length} 个队员已接上`);
  }

  // ---- heartbeat: called for every column on the 1.5s status loop ----
  // Same session and same question text are announced once. A later command
  // receipt can still replace the asking card. Separate from exceptionSeen on
  // feat/crew-exception-receipts, which dedups process/quota/silence anomalies.
  function rememberQuestion(colId, question) {
    const s = state();
    if (!s) return false;
    const key = colId + '\n' + question;
    s.implicitQuestions = Array.isArray(s.implicitQuestions) ? s.implicitQuestions : [];
    if (s.implicitQuestions.includes(key)) return false;
    s.implicitQuestions.push(key);
    if (s.implicitQuestions.length > 100) s.implicitQuestions.splice(0, s.implicitQuestions.length - 100);
    return true;
  }
  let captainBusySince = 0;   // when 队长 was first seen working in the stretch it has not finished yet
  function confirmationExcerpt(entry) {
    return String(entry?.lastScreen || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-8)
      .map((l) => l.slice(0, 140)).join('\n') || '（看不到提示内容）';
  }
  // The app sends only authenticated listener liveness, never terminal output.
  // A dead listener costs no model turns until unread work has waited three minutes.
  function remindMissingListener(entry) {
    const s = state(), col = mainCol();
    if (!s || !col || nativeCaptain(col.cmd) || s.legacyReceiptInjection || !listenerStatus ||
        listenerStatus.colId !== col.id || Date.now() - listenerStatus.at > 30_000) return;
    if (listenerStatus.alive || !s.pending.length) { listenerReminder = false; return; }
    if (listenerReminder || listenerReminderSending || Date.now() - Math.min(...s.pending.map((p) => p.ts || Date.now())) < 3 * 60_000 ||
        !entry.alive || entry.sendingPrompt || ['working', 'quota', 'input'].includes(entry.state) ||
        M.terminalActivity(entry.lastScreen, col.cmd) || briefing === col.id || host.userComposing(col.id)) return;
    listenerReminderSending = true;
    Promise.resolve(host.agentInForeground(col, false)).then((ok) => {
      if (!ok || mainCol() !== col || listenerStatus?.alive || !s.pending.length || !entry.alive ||
          entry.sendingPrompt || ['working', 'quota', 'input'].includes(entry.state) || host.userComposing(col.id)) return false;
      return window.ChatUI.sendPrompt(col, '', null, {
        prefix: '【AgentDeck 回执监听提醒】后台回执监听已退出，未读回执已等待三分钟。请立即读取 receipts 处理，再用 run_in_background: true 重挂恰好一个 receipts --wait 监听。',
        force: true, guardUserInput: true,
      });
    }).then((sent) => { if (sent && listenerStatus?.colId === col.id) listenerReminder = true; }, () => {}).finally(() => { listenerReminderSending = false; });
  }
  // A sub-captain's `receipts --wait` dies with a restart, and a model can forget to hang it
  // again. Its children's receipts then wait unread: after three minutes with no listener and
  // the sub-captain idle, it is reminded once in its own terminal (never over a draft); receipts
  // still untaken after ten minutes are reported to the Captain once. Both start over once it
  // has taken them.
  const SUB_REMIND_AFTER = 3 * 60_000, SUB_ESCALATE_AFTER = 10 * 60_000;
  const subListeners = new Map();   // sub-captain id -> { alive, at }, from main.js's listener status
  const subNudges = new Map();      // sub-captain id -> { reminded, sending, escalated } for the current pile
  function watchSubReceipts(col, entry) {
    const s = state();
    const queue = s?.subReceipts?.[col.id] || [];
    if (!queue.length) { subNudges.delete(col.id); return; }
    let nudge = subNudges.get(col.id);
    if (!nudge) subNudges.set(col.id, nudge = {});
    const waited = Date.now() - Math.min(...queue.map((p) => p.ts || Date.now()));
    if (!nudge.escalated && waited >= SUB_ESCALATE_AFTER) {
      nudge.escalated = true;
      const name = host.columnLabel(col);
      s.pending.push({ taskId: 'sub-captain-unread-' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), colId: col.id, title: name, ts: Date.now(), source: 'command',
        summary: `小队长「${name}」有 ${queue.length} 条子会话回执超过 ${Math.floor(waited / 60_000)} 分钟没取（它的 receipts --wait 监听不在，或它卡住了）。可以 tell 它先运行 receipts 处理、再重挂一个后台 receipts --wait；或 peek 看它卡在哪。` });
      save();
    }
    const listener = subListeners.get(col.id);
    if (nudge.reminded || nudge.sending || !listener || listener.alive || Date.now() - listener.at > 30_000 || waited < SUB_REMIND_AFTER) return;
    const busy = () => !entry.alive || entry.sendingPrompt || ['working', 'quota', 'input'].includes(entry.state) || M.terminalActivity(entry.lastScreen, col.cmd) || host.userComposing(col.id);
    if (busy()) return;
    nudge.sending = true;
    Promise.resolve(host.agentInForeground(col, false)).then((ok) => {
      if (!ok || !isSubCaptain(col) || subListeners.get(col.id)?.alive || !(state()?.subReceipts?.[col.id] || []).length || busy()) return false;
      return window.ChatUI.sendPrompt(col, '', null, {
        prefix: '【AgentDeck 子会话回执提醒】你的后台回执监听不在，子会话的回执已经等了三分钟。请立即运行 receipts 读取并处理，再用 Bash 的 run_in_background: true 重挂恰好一个 receipts --wait（不设超时）。',
        force: true, guardUserInput: true,
      });
    }).then((sent) => { if (sent) nudge.reminded = true; }, () => {}).finally(() => { nudge.sending = false; });
  }
  // The 额度用尽 receipt is provisional. Claude and Codex wait out the limit and
  // continue on their own ("Usage limit reset · continuing automatically"), but
  // the task was already closed as failed. Once the terminal has visibly worked
  // for QUOTA_RESUME_CONFIRM with no quota wait on screen, the receipt is void:
  // the task is working again, the ledger line, the unread notice and the card's
  // quota flag go away. A real receipt later settles it as usual. Not for a
  // process that exited, or an instruction that never went in.
  function quotaResumable(task) {
    return task?.status === 'failed' && task.receipt?.source === 'quota' && !task.receipt.exited &&
      !task.receipt.undeliveredTaskId && task.instructionSent !== false && !task.pendingInstall;
  }
  function reopenAfterQuota(col, entry) {
    const s = state();
    const task = s?.tasks.findLast((t) => t.colId === col.id);
    if (!quotaResumable(task)) return;
    if (!M.quotaResumed(entry, col.cmd)) { delete task.resumeSeenAt; return; }
    task.resumeSeenAt ||= Date.now();
    if (Date.now() - task.resumeSeenAt < QUOTA_RESUME_CONFIRM) return;
    delete task.receipt; delete task.doneAt; delete task.resumeSeenAt; delete task.processEnded;
    task.status = 'working'; task.endedAt = 0;
    task.gen = s.gen; // a closed task keeps its old Captain's generation, and its receipt would be dropped
    if (col.lastReceipt?.source === 'quota') delete col.lastReceipt;
    dropReceipts(s, (p) => p.taskId === task.id && p.source === 'quota');
    autoBoardEvent(task, 'started', '', 'resume-quota-' + Date.now());
    update(task);
  }
  // ---- cut short by sleep or a dropped network ----
  // Such a turn stops at the prompt with an API error. It is not "finished
  // without a receipt": once the machine is awake and online again the session
  // gets a short "carry on" (spaced out and capped; sleep-resume-core.js has the
  // rules), and only repeated failure reaches 队长, as one anomaly receipt.
  // A stopped, finished or interrupted task is never touched.
  const sleepSending = new Map(); // task id -> when a nudge began waiting for the prompt (never saved)
  function onPower(asleep, at) {
    const sr = window.SleepResume;
    if (!sr) return;
    const when = Number.isFinite(at) ? at : Date.now();
    if (asleep) {
      sr.clock.suspend();
      for (const task of state()?.tasks || []) if (task.status === 'working') task.sleptAt = when;
      save();
    } else sr.clock.resume(when);
  }
  function sleepResumeRecovered(task, entry) {
    const sr = window.SleepResume, rec = task.sleepResume;
    if (!sr || !rec || !rec.lastAt || sleepSending.has(task.id)) return;
    if (Date.now() - rec.lastAt >= sr.RECOVER_MS && !sr.interruption(entry.lastScreen)) { delete task.sleepResume; save(); }
  }
  function sendSleepNudge(col, task, rec, text = window.SleepResume.message(), extra = {}) {
    sleepSending.set(task.id, Date.now());
    const done = () => sleepSending.delete(task.id);
    host.sendWhenReady(col, text, {
      silent: true, guardUserInput: true, requireIdle: true, timeout: 90_000, ...extra,
      cancelled: () => { const gone = task.status !== 'working'; if (gone) done(); return gone; },
      onSent: () => {
        done();
        rec.attempts++; rec.lastAt = Date.now();
        task.sleepNudges = (task.sleepNudges || 0) + 1;
        if (rec.evidence === 'event') delete task.sleptAt;
        task.endedAt = 0;
        save();
      },
      onGiveUp: done,
    });
  }
  // true: this tick belongs to the sleep rules (waiting, nudging or giving up).
  function sleepResumeStep(col, entry, task) {
    const sr = window.SleepResume;
    if (!sr || !col || task.status !== 'working' || task.processEnded || task.pendingInstall || entry.state !== 'done') return false;
    const turn = task.turnId && window.ChatUI.turnsOf(task.colId).find((t) => t.id === task.turnId);
    if (turn?.interrupted) return false;
    const now = Date.now();
    const clock = sr.clock.snapshot();
    // Nothing finishes while the machine sleeps; a tick that slips in before the wake event is not a verdict.
    if (clock.asleep) return true;
    const why = sr.evidence({ screen: entry.lastScreen, sleptAt: task.sleptAt, now, clock });
    if (!why) return false;
    const rec = task.sleepResume ||= { firstSeenAt: now, attempts: 0, lastAt: 0, evidence: why };
    if (why === 'screen') rec.evidence = 'screen';
    const began = sleepSending.get(task.id);
    if (began && now - began < 3 * 60_000) return true;
    const online = sr.online(typeof navigator === 'undefined' ? null : navigator);
    const step = sr.decide(rec, { now, clock, online, lifetime: task.sleepNudges || 0 });
    if (step.action === 'wait') return true;
    if (step.action === 'send') { sendSleepNudge(col, task, rec); return true; }
    if (rec.evidence === 'screen') {
      settle(task, { summary: '', files: [], images: [], failed: sr.failure(rec), explicit: true, source: 'sleep' });
      return true;
    }
    // Only the sleep event suggested it and the nudge changed nothing: the ordinary rule decides.
    delete task.sleptAt; delete task.sleepResume;
    return false;
  }
  // ---- "Not logged in" on a seat whose login checks out ----
  // A credential blip (10-08 18:02-18:03: three US2 sessions within 40 s, one went on by itself).
  // Only for a working Claude task. The seat is checked once per episode, fresh. Signed in: the
  // sleep rules carry it as evidence 'login' (about a minute, then one 「接着做」); the same error
  // below that nudge is a failure receipt. Error rows above the nudge are history (MainCore), so
  // after it the session's turn ends, asks or goes quiet like any other. Not signed in, or no
  // answer: the ordinary 未登录 receipt.
  const loginChecks = new Map(); // task id -> 'pending' | true | false (never saved)
  function loginBlipStep(col, entry, task) {
    const sr = window.SleepResume;
    if (!sr || !col || task.status !== 'working' || task.processEnded || task.pendingInstall) return false;
    if (!window.ClaudeSeatsCore?.claudeLaunch(col.cmd) || M.resourceKind(entry.lastScreen, col.cmd) !== 'auth') return false;
    const blip = task.loginBlip;
    if (blip?.attempts) {
      // An error above the nudge no longer counts (MainCore reads only what follows it), so this one
      // is new. Until the nudge shows up on screen, the error is still the old one: give it a minute.
      if (!M.loginNudgeShown(entry.lastScreen) && Date.now() - blip.lastAt < 60_000) return true;
      settle(task, { summary: '', files: [], images: [], failed: M.resourceReceipt(entry.lastScreen, col.cmd).failed + '\n' + sr.failure(blip), explicit: true, source: 'quota' });
      return true;
    }
    const signedIn = loginChecks.get(task.id);
    if (signedIn === undefined) {
      loginChecks.set(task.id, 'pending');
      Promise.resolve(window.deck.claudeSeats?.(true)).then((infos) => {
        loginChecks.set(task.id, (infos || []).find((s) => s.id === col.claudeSeatId)?.loggedIn === true);
      }, () => loginChecks.set(task.id, false));
      return true;
    }
    if (signedIn === 'pending') return true;
    if (signedIn !== true) { loginChecks.delete(task.id); return false; }
    const now = Date.now();
    const rec = task.loginBlip ||= { firstSeenAt: now, attempts: 0, lastAt: 0, evidence: 'login' };
    const began = sleepSending.get(task.id);
    if (began && now - began < 3 * 60_000) return true;
    const online = sr.online(typeof navigator === 'undefined' ? null : navigator);
    const step = sr.decide(rec, { now, clock: sr.clock.snapshot(), online, lifetime: task.sleepNudges || 0 });
    if (step.action === 'wait') return true;
    if (step.action === 'send') { sendSleepNudge(col, task, rec, sr.message('login'), { requireIdle: false, overLoginError: true }); return true; }
    return false;   // no nudge left for this task: the ordinary receipt
  }
  function onTick(id, entry) {
    const s = state();
    if (!s) return;
    if (restartWatch) { restartEvidence(id, entry); restartCheck(); }
    if (id === s.colId) {
      const busy = entry.alive && (entry.state === 'working' || M.terminalActivity(entry.lastScreen, mainCol()?.cmd) === 'working');
      // Only a receipt taken before a stretch began was in front of the model for all of it.
      if (busy) captainBusySince ||= Date.now();
      else if (captainBusySince && entry.state === 'done') { s.captainSettledAt = Math.max(s.captainSettledAt || 0, captainBusySince); captainBusySince = 0; save(); }
      for (const [cardId, input] of quotaStarts) {
        // retry as soon as any dispatcher candidate (Gemini, or the Claude fallback) is no longer held back by quota
        if (dispatcherReady()) {
          quotaStarts.delete(cardId);
          startCard(cardId, input).catch((error) => host.showToast(error.message));
        }
      }
      remindMissingListener(entry);
      retryBoardWrites(s); if (!seatChanging) { contextResetTick(entry); if (!contextReset) tokenSaverTick(entry); if (!tokenSaving && !contextReset) { deliver(entry); deliverMobile(); } pump(); } return;
    }
    const col = host.columns().find((c) => c.id === id);
    window.SleepResume?.clock.beat();
    if (col) reopenAfterQuota(col, entry);
    if (col && isSubCaptain(col)) watchSubReceipts(col, entry);
    if (col?.executor === 'chatgpt-web') {
      startWebTask(col);
      if (col.captainCrew) maybeArchive(col, entry);
      return;
    }
    if (col && col.captainCrew) maybeArchive(col, entry);
    // The no-command notice is provisional. A live working session supersedes
    // it, including when it resumes the same instruction after a quiet gap.
    if (entry.alive && (entry.state === 'working' || M.terminalActivity(entry.lastScreen, col?.cmd) === 'working' || M.claudeBackgroundTasks(entry.lastScreen, col?.cmd))) {
      const stale = col?.lastReceipt?.source === 'fallback';
      if (stale) delete col.lastReceipt;
      const task = s.tasks.findLast((t) => t.colId === id);
      if (task?.status === 'stopped' && task.receipt?.source === 'fallback') {
        delete task.receipt;
        delete task.doneAt;
        delete task.processEnded;
        task.status = 'working'; task.endedAt = 0;
        task.gen = s.gen; // a closed task keeps its old Captain's generation, and its receipt would be dropped
        dropReceipts(s, (p) => p.taskId === task.id && p.source === 'fallback');
        autoBoardEvent(task, 'started', '', 'resume-fallback-' + Date.now());
        update(task);
      } else if (stale) {
        if (task?.status === 'working') autoBoardEvent(task, 'started', '', 'resume-fallback-' + Date.now());
        save();
      }
    }
    for (const task of s.tasks) {
      if (task.colId !== id || task.pendingInstall) continue;
      if (task.status === 'stopped' && task.receipt?.source === 'fallback' &&
          (!entry.alive || entry.state === 'quota' || M.terminalActivity(entry.lastScreen, col?.cmd) === 'quota')) {
        task.status = 'working';
        task.gen = s.gen;
        dropReceipts(s, (p) => p.taskId === task.id && p.source === 'fallback');
      }
      if (!['queued', 'working', 'paused', 'quota', 'input', 'asking'].includes(task.status)) continue;
      if (task.status === 'paused' || task.restartHold) {
        if (!entry.alive) {
          if (!task.resumeDeadline || Date.now() <= task.resumeDeadline) continue;
          if (!fallbackResume(col, task, '原终端未能启动')) noteResumeFailure(col, task, '终端没有在时限内起来');
          continue;
        }
        if (task.status === 'paused') continue;
      }
      if (!entry.alive) { if (task.status === 'asking') task.status = 'working'; settle(task, { summary: '', files: [], images: [], failed: entry.exitReason || '这个会话的终端已经退出', explicit: true, source: 'process', ...M.resourceReceipt(entry.lastScreen, col?.cmd), exited: true }); continue; }
      const activity = M.terminalActivity(entry.lastScreen, col?.cmd);
      if (entry.state === 'quota' || activity === 'quota') {
        if (window.RestartResume && window.RestartResume.ignoreQuota(task, Date.now())) continue;
        // Follow-ups queued after the failure still wait for the provider to
        // resume; a brand-new session exhausted at startup fails its first task.
        if (task.status === 'queued' && (task.supplement || col?.lastReceipt?.source === 'quota')) continue;
        if (loginBlipStep(col, entry, task)) continue;
        if (task.status === 'asking') task.status = 'working';
        settle(task, { summary: '', files: [], images: [], failed: '额度用尽，agent 无法继续当前任务', explicit: true, source: 'quota', ...M.resourceReceipt(entry.lastScreen, col?.cmd) });
        continue;
      }
      const quietSince = Math.max(entry.lastOutputAt || 0, task.startedAt || task.sentAt || 0);
      // A Claude turn that is over while its background shell or Monitor runs draws nothing (a static status
      // row; its cursor queries are not output): that wait is work, not silence, and is reported only when
      // it lasts hours.
      const backgroundWait = M.claudeBackgroundTasks(entry.lastScreen, col?.cmd);
      const quietLimit = M.silenceTimeout(col?.cmd, backgroundWait);
      if (quietSince && task.silenceNotifiedAt !== quietSince && Date.now() - quietSince >= quietLimit && entry.state !== 'input' &&
          (task.status === 'working' || task.status === 'queued' && !task.supplement)) {
        const summary = backgroundWait
          ? `在等后台命令，已经 ${Math.floor((Date.now() - quietSince) / 3600_000)} 小时没有输出，请检查会话；未自动中断或重派。`
          : `已连续 ${quietLimit / 60_000} 分钟没有任何终端输出，请检查会话；可能仍在深度思考，未自动中断或重派。`;
        if (push(task, { summary, source: 'watchdog' })) {
          task.silenceNotifiedAt = quietSince; // Fresh output or a new task rearms the watchdog.
          save();
        }
      }
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
      if (task.status === 'asking') continue;
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
      if (task.sleepResume && (entry.state === 'working' || activity === 'working')) sleepResumeRecovered(task, entry);
      if (task.loginBlip?.lastAt && (entry.state === 'working' || activity === 'working') && Date.now() - task.loginBlip.lastAt >= window.SleepResume.RECOVER_MS) {
        delete task.loginBlip; loginChecks.delete(task.id); save();   // it worked again: a later blip starts afresh
      }
      if (!task.processEnded && (entry.state === 'working' || activity === 'working' || M.claudeBackgroundTasks(entry.lastScreen, col?.cmd))) { task.endedAt = 0; continue; }
      if (sleepResumeStep(col, entry, task)) continue;
      // A finished turn that asked in prose, without `ask`, is a question receipt.
      // Formal 【回执】/【提问】 blocks on screen stay ignored. One question text
      // per session. feat/crew-exception-receipts does not do this; it reports
      // process, quota and silence anomalies instead.
      if (entry.state === 'done' && task.status === 'working') {
        const question = M.implicitCaptainQuestion(M.afterContract(entry.lastScreen));
        if (question && rememberQuestion(task.colId, question)) {
          settle(task, { summary: '', files: [], images: [], question, explicit: true, source: 'screen' });
          continue;
        }
      }
      // Never parse a screen for a completion receipt. A finished turn (or a real
      // zero process exit) gets a three-minute grace period for its command.
      // Cursor blink refreshes lastOutputAt after the turn is done; that must
      // not keep postponing the grace. agy, Cursor and Codex stay running at
      // the input box after a normal turn, so a live process is not itself a
      // reason to wait. Hold the grace only while the screen is still working
      // (a background command or a test-lock wait counts) or the Captain
      // interrupted this turn. A dead terminal is already settled above.
      const turn = task.turnId && window.ChatUI.turnsOf(task.colId).find((t) => t.id === task.turnId);
      if (!task.processEnded && entry.alive && turn?.interrupted) { task.endedAt = 0; continue; }
      const ended = task.endedAt || (turn?.done && !turn.interrupted && entry.state === 'done' ? (task.endedAt = Date.now()) : 0);
      if (!ended || turn && !turn.done && !task.processEnded) continue;
      // A command Claude started still running in the terminal's process tree (a Bash call waiting in the machine's
      // E2E queue, a long test run, a background shell) means the turn is not over, however still the screen is;
      // the three minutes count from when it is gone. No answer yet is no verdict; a listing that failed (null)
      // leaves it to the screen.
      const claude = /\bclaude\b/i.test(col?.cmd || '');
      const work = claude && !task.processEnded && entry.alive && host.ptyBackgroundWork ? host.ptyBackgroundWork(col) : null;
      if (work === true) { task.endedAt = 0; continue; }
      const anchor = entry.state === 'done' ? ended : Math.max(ended, entry.lastOutputAt || 0);
      if (Date.now() - anchor < STOP_QUIET) continue;
      if (work === undefined) continue;
      // Last look before calling a Claude turn over: its full-screen rows as they are, one per row (the status
      // light reads them with soft wraps joined). A spinner or a scrolled-up view there means it is still at it.
      // On Windows a PowerShell prompt at the bottom means Claude has exited (or crashed): whatever it drew
      // above the prompt is history, as for the status light, and must not hold the task open.
      if (claude && entry.term && host.dumpScreen && host.screenState) {
        let rows = host.dumpScreen(entry.term, 40);
        if (host.platform === 'win32' && M.isWindowsShellPrompt(rows)) rows = M.windowsAgentOutput(rows);
        if (host.screenState(rows, { ...entry, state: 'working' }, col.cmd) === 'working') {
          task.endedAt = 0;
          continue;
        }
      }
      // A progress is not a receipt, but the last one says why the worker stopped: it goes with the notice.
      const said = window.BoardCore.cleanText(task.progress, 300).replace(/\s+/g, ' ').trim();
      settle(task, { summary: NO_RECEIPT + (said ? `（最后进度：${said}）` : ''), files: [], images: [], failed: '', explicit: false, source: 'fallback' });
    }
  }
  function onTurnStarted(colId, turn) {
    const s = state();
    if (!s || colId !== s.colId) return;
    host.captainTurnStarted(colId, turn);
    if (tokenSaving && !(tokenSaving.phase === 'archiving' && turn.user === M.ARCHIVE_PROMPT)) cancelTokenSaving();
    s.inflight.forEach((p) => { if (!p.deliveryTurnId) p.deliveryTurnId = turn.id; });
    save();
  }
  function onTurnDone(colId, turn) {
    const s = state();
    if (!s) return;
    if (colId === s.colId) {
      host.captainTurnDone(colId, turn);
      if (s.relayStartup?.attempt?.colId === colId && turn.reply?.trim() && !turn.interrupted) {
        s.relayStartup.attempt.output = true; save();
      }
      if (tokenSaving?.phase === 'archiving' && turn.id === tokenSaving.turnId) {
        if (!turn.interrupted && String(turn.reply || '').trim() === '已存档') {
          if (tokenSaving.relay) {
            const op = tokenSaving;
            clearTimeout(op.timer); tokenSaving = null; saverBanner(''); op.resolve();
          } else { tokenSaving.phase = 'archived'; tokenSaving.since = Date.now(); }
        }
        else saverFailed('队长没有只回复「已存档」，未清空上下文');
      }
      if (!turn.interrupted && Number.isFinite(turn.ts)) s.captainSettledAt = Math.max(s.captainSettledAt || 0, turn.ts);
      if (s.inflight.length || s.fresh) {
        const inflight = s.inflight, pending = s.pending, fresh = s.fresh;
        const inbox = host.config.todoInbox, accepted = host.config.todoDeliveries;
        const taken = inflight.filter((p) => p.deliveryTurnId === turn.id);
        const confirmedTodo = !turn.interrupted && confirmTodoReceipts(taken);
        if (turn.interrupted) {
          const waiting = new Set(pending.map((p) => p.receiptId));
          const unread = taken.filter((p) => inbox?.[p.receiptId] && !waiting.has(p.receiptId));
          s.pending = [...unread.map(({ deliveryTurnId, takenAt, batch, ...item }) => item), ...pending];
        }
        s.inflight = inflight.filter((p) => p.deliveryTurnId !== turn.id);
        s.fresh = false;
        try { if (confirmedTodo) persistTodoInbox(); else save(); }
        catch (_) {
          s.inflight = inflight; s.pending = pending; s.fresh = fresh;
          host.config.todoInbox = inbox; host.config.todoDeliveries = accepted;
          save(); host.showToast('Todo 回执送达确认未能持久保存，已保留待重试。');
        }
      }
      return;
    }
    const task = s.tasks.find((t) => t.colId === colId && t.turnId === turn.id);
    if (!task || CLOSED.includes(task.status) || turn.interrupted) return;
    const entry = host.terms.get(colId);
    const col = host.columns().find((c) => c.id === colId);
    if (!entry || entry.state !== 'done' || M.terminalActivity(entry.lastScreen, col?.cmd) || M.claudeBackgroundTasks(entry.lastScreen, col?.cmd)) return;
    task.endedAt = Date.now();
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
  // Images sent from the phone travel as attachment paths, like a pasted screenshot.
  function mobileImages(atts) { return Array.isArray(atts) ? atts.filter((p) => typeof p === 'string' && p && p.length <= 2000).slice(0, 6) : []; }
  function sendMessage(message, images) {
    const col = mainCol();
    if (!col || !host.terms.get(col.id)?.alive) throw new Error('请先在 AgentDeck 创建并启动队长。');
    const atts = mobileImages(images);
    if (typeof message !== 'string' || !(message.trim() || atts.length) || message.length > 8000) throw new Error('消息须为 1–8000 个字符。');
    const s = state();
    s.mobileMessages ||= [];
    if (s.mobileMessages.length >= 20) throw new Error('队长已有 20 条消息等待送达，请稍后再发。');
    s.mobileMessages.push(atts.length ? { text: message, atts } : message);
    host.flushConfig();
    deliverMobile();
  }
  function deliverMobile() {
    const col = mainCol(), s = state();
    if (mobileDelivery || !col || !s?.mobileMessages?.length || briefing === col.id || seatChanging || tokenSaving || contextReset) return;
    const delivery = { col, s }, head = s.mobileMessages[0];
    mobileDelivery = delivery;
    host.sendWhenReady(col, typeof head === 'string' ? head : head.text, {
      atts: typeof head === 'string' ? null : mobileImages(head.atts),
      guardUserInput: true, requireIdle: true, userInitiated: true,
      cancelled: () => {
        const cancelled = mobileDelivery !== delivery || mainCol() !== col || state() !== s;
        if (cancelled && mobileDelivery === delivery) mobileDelivery = null;
        return cancelled;
      },
      onSent: () => {
        if (mobileDelivery !== delivery) return;
        s.mobileMessages.shift(); mobileDelivery = null; save();
      },
      // Keep accepted messages in config when busy/draft waits outlast a
      // delivery attempt. The next tick retries the same FIFO head.
      onGiveUp: () => { if (mobileDelivery === delivery) mobileDelivery = null; },
    });
  }
  function ledgerRows() {
    const folders = new Map((host.config.folders || []).map((f) => [f.id, f.name]));
    const latest = new Map((state()?.tasks || []).map((t) => [t.colId, t]));
    return host.columns().filter((c) => !c.isMain).map((c) => {
      const entry = host.terms.get(c.id);
      const terminalState = entry ? (entry.alive ? entry.state || 'plain' : 'exited') : 'plain';
      const task = c.executor === 'chatgpt-web' ? state()?.tasks.findLast((t) => t.colId === c.id && ['working', 'queued'].includes(t.status)) || latest.get(c.id) : latest.get(c.id);
      // A receipt completes the assignment; Cursor's session can still be
      // running tools or writing its final response after submitting it.
      const completed = task?.status === 'done' && task.receipt?.source === 'command';
      const cursorWorking = /\bcursor-agent\b/i.test(c.cmd || '') && entry?.alive &&
        (terminalState === 'working' || M.terminalActivity(entry.lastScreen, c.cmd) === 'working');
      const resumedState = window.RestartResume ? window.RestartResume.ledgerState(terminalState, !!(entry && entry.alive), task) : terminalState;
      // Which account a Claude session runs on (the seat's signed-in account, not the seat's name).
      const seat = window.AgentInfo?.resolveAgentInfo?.(c, entry)?.seat;
      return {
        // Account name and seat code together: 队长 dispatches by either.
        ...(seat && window.ClaudeSeats?.display ? { account: `${window.ClaudeSeats.display(seat.id)?.label || '未识别'}（${seat.id}）` } : {}),
        id: c.id, title: host.columnLabel(c), state: c.executor === 'chatgpt-web' ? webTaskState(task) : cursorWorking ? 'working' : completed ? 'done' : resumedState, terminalState,
        folder: folders.get(c.folderId) || '', receipt: c.lastReceipt || null,
        project: c.project || '', reviews: c.reviews || [], important: sessionHigh(c),
        ...(isSubCaptain(c) ? { subCaptain: true, children: childrenOf(c).length, unread: (state()?.subReceipts?.[c.id] || []).length } : {}),
        ...(subCaptainOf(c) ? { parent: c.subCaptainId } : {}),
      };
    });
  }
  // Send an instruction into an existing session, restoring it first when archived. A session
  // that belongs to a board card is rebound to the card (new attempt `message.id`) once its
  // earlier attempt has ended, so its next receipt counts. A restored session is rebound only
  // for a card sent back to 进行中 (rework); a follow-up on any other card goes in unbound as before.
  async function tellSession(message, caller) {
    const text = window.BoardCore.cleanText(message.message, 2_000_000);
    if (!text) throw new Error('tell 需要 --message。');
    let col = findTarget(message.to);
    let restored = false;
    let archived = null;
    if (!col) {
      const old = archivedCrew(message.to, isSubCaptain(caller) ? caller : null);
      if (old) {
        // Its copy was reclaimed when it was archived (cwd now the main checkout): it is not brought back to work there.
        const copy = old.worktree;
        if (copy && (copy.removed === true || (copy.repo && old.cwd === copy.repo))) {
          throw new Error(`「${host.columnLabel(old)}」的代码副本 ${copy.path || ''} 已在归档时回收，tell 不会把它恢复到主仓库 ${copy.repo || old.cwd}。请用 new --worktree ${copy.repo || old.cwd} 重新派这件活${copy.branch ? `（它原来的分支是 ${copy.branch}）` : ''}。`);
        }
        // Back on its own seat or not at all: a seat that is gone or signed out restores nothing.
        const blocked = window.ClaudeSeatsCore.launchBlock(old, host.config, await Promise.resolve(window.deck.claudeSeats?.()).catch(() => []));
        if (blocked) throw new Error(`「${host.columnLabel(old)}」没有恢复：${blocked}，不会换到别的席位。请用户先登录这个席位（席位设置里有复制登录命令的图标）再 tell；急的话用 new --task-id … --seat 另一个已登录席位 改派。`);
        // Restored once its card is bound: a bind the board refuses (a stale automatic rework) brings nothing back.
        col = old; archived = old;
      }
    }
    if (!col) throw new Error(`找不到会话：${String(message.to).slice(0, 80)}。先用 ledger 看 id。`);
    if (col.executor === 'chatgpt-web') window.ChatGPTWebCore.validatePublicTask(text);
    // Refuse before rebinding. bind() consumes a pending automatic rework, so a
    // prompt or a bare shell must not mark that rework delivered when nothing was sent.
    const entry = host.terms.get(col.id);
    if (!archived) {
      if (entry && entry.state === 'input' && !message.now) throw new Error(`「${host.columnLabel(col)}」停在确认提示上：有把握就用 answer 回答它，没把握就请用户去那一列处理。`);
      if (!col.cmd && !(await host.agentInForeground(col, false))) {
        throw new Error(`「${host.columnLabel(col)}」里只有 shell，没有在运行的 agent，不能把活发进去。请用 new 开一个新会话来做。`);
      }
    }
    let replaced = null;
    if (col.boardId) {
      const card = (await window.TaskBoard.list({ archived: true })).find((c) => c.id === col.boardId);
      // A tell is the Captain saying "carry on" (队长决定): the card goes back to execution on
      // this session. A done, archived or held card is moved back to doing, a card waiting for
      // review is not turned into a review by its own worker, and a reviewer still bound to it
      // is ended (bind names it). A tell to a reviewer is only more words for its review.
      const reviewer = !!(col.reviews && col.reviews.length) || (card?.review_session === true && card.session_id === col.id);
      const takeBack = !!card && !reviewer && (card.status === 'done' || card.archived || card.flag === 'held' || card.status === 'review' || card.review_session === true);
      if (card && (takeBack || (card.attempt_closed || !card.session_id) && (!archived || card.status === 'doing' && card.flag !== 'held'))) {
        const bound = await boardRequest('bind', { id: card.id, project: card.project, session_id: col.id, attempt_id: message.id, ...(reviewer ? {} : { tell: true }),
          ...(message.reworkKey ? { rework_key: message.reworkKey } : {}),
          assignee: { agent: window.BoardCore.inferAgentType(col.cmd), model: col.cmd.match(/(?:--model|-m)(?:\s+|=)["']?([^\s"']+)/)?.[1] || 'default' } });
        col.boardAttempt = message.id;
        // The card is already this session's: the instruction still goes in if ending fails.
        // A reviewer bound a moment ago may have no terminal yet: openSession then never makes one.
        if (bound?.replaced_session) {
          try { replaced = await endSession(bound.replaced_session, { archive: true, summary: '卡片回到执行，这个审查会话已结束并归档。' }); }
          catch (error) { replaced = { error, id: bound.replaced_session }; }
          if (!replaced && !(host.config.archived || []).some((a) => a.id === bound.replaced_session)) retiredSessions.add(bound.replaced_session);
        }
      }
    }
    // (restored by hand meanwhile: the live column takes it)
    if (archived) { col = host.restoreArchived(archived.id, false, true) || findTarget(archived.id); restored = true; }
    if (!col) throw new Error(`找不到会话：${String(message.to).slice(0, 80)}。先用 ledger 看 id。`);
    const endedNote = !replaced ? '' : replaced.error
      ? `旧审查会话 ${replaced.id} 没能结束（${replaced.error.message}），请用 archive --id ${replaced.id} 结束它；卡片已回到进行中。`
      : `旧审查会话「${host.columnLabel(replaced.col)}」(${replaced.col.id})已结束并归档，卡片回到进行中。`;
    if (restored) {
      dispatch(col, text, host.columnLabel(col));
      return { done: true, result: `「${host.columnLabel(col)}」已归档，已恢复它并把指令发过去，它准备好后会收到。${endedNote}` };
    }
    const busy = entry && (M.workingForSend(entry) || entry.state === 'quota');
    if (message.replace) cancelSupplement(col.id);
    if (message.now) {
      await handle({ action: 'main-stop', to: col.id, keepQueued: true }, caller);
    }
    dispatch(col, text, host.columnLabel(col), null, message.now);
    return { done: true, result: (message.now ? `已请求中断「${host.columnLabel(col)}」，新指令在输入框就绪后立即送达。` : busy ? `「${host.columnLabel(col)}」正在干活，指令先放着（待补充），等它停下合并发送。` : `已发给「${host.columnLabel(col)}」(${col.id})。`) + endedNote };
  }
  // `stop --id` (Esc) and `archive --id` (end the terminal and archive it), and a
  // reviewer replaced when its card went back to execution (tellSession). Null when
  // there is no such live column.
  async function endSession(id, { archive, keepQueued = false, summary = '' }) {
    const s = state();
    const col = host.columns().find((c) => c.id === id && !c.isMain);
    if (!col) return null;
    const entry = host.terms.get(id);
    if (!archive && (!entry || !entry.alive)) throw new Error('这个会话的终端已经退出。');
    if (!keepQueued) cancelSupplement(id);
    if (col.executor === 'chatgpt-web' && entry) entry.webExecutorStopping = true;
    // Close cards before Esc/PTY exit so no delayed dispatch or receipt can
    // revive work that the Captain explicitly cancelled.
    s.tasks.forEach((t) => {
      if (t.colId !== id || !['queued', 'working', 'quota', 'input', 'asking'].includes(t.status) || (keepQueued && t.status === 'queued')) return;
      t.status = 'stopped';
      t.doneAt = Date.now();
      t.receipt = { summary: summary || (archive ? '队长已结束终端并归档。' : '队长已请求中断当前操作。'), files: [], images: [], failed: '', explicit: true, source: archive ? 'captain-archive' : 'captain-stop' };
      update(t);
    });
    // Automatic notices about this session go; the worker's own complete/ask stays unread for the Captain.
    dropReceipts(s, (p) => p.colId === id && p.source !== 'command');
    if (col.executor === 'chatgpt-web') {
      try { await window.deck.chatgptWebCancel(id); }
      finally { if (entry) entry.webExecutorStopping = false; }
    }
    if (archive) host.archiveColumn(col, { captain: true, quiet: true, worktreeHandled: true });
    else if (col.executor !== 'chatgpt-web') window.deck.ptyInput(id, '\x1b');
    if (col.executor === 'chatgpt-web' && entry) { entry.webExecutorState = 'stopped'; entry.state = 'stopped'; }
    save();
    return { col, settled: archive && col.worktree ? await settleArchivedWorktree(col) : null };
  }
  function cardWorktree(record) {
    const out = { repo: record.repo, path: record.path, branch: record.branch, base: record.base, removed: record.removed === true };
    if (record.reason) out.reason = String(record.reason).slice(0, 500);
    return out;
  }
  // In-flight only. A saved settling flag must not survive tell, archive, or restart.
  const settlingIds = new Set();
  // Reviewers a tell replaced before openSession had made their terminal.
  const retiredSessions = new Set();
  // Archive already stopped the terminal. Remove the copy only when it is clean
  // and the branch is on the trunk or a remote; otherwise keep it and say why.
  async function settleArchivedWorktree(col) {
    const record = col?.worktree;
    if (!record || record.removed) return record || null;
    delete record.settling;
    if (!col.id || settlingIds.has(col.id)) return record;
    settlingIds.add(col.id);
    try {
      if (typeof window.deck.reclaimWorktree !== 'function') throw new Error('没有回收入口');
      const result = await window.deck.reclaimWorktree(record);
      record.removed = result?.removed === true;
      record.reason = String(result?.reason || '').slice(0, 500);
      if (record.removed && record.repo) col.cwd = record.repo;
    } catch (error) {
      record.removed = false;
      record.reason = ('副本保留：回收没有完成：' + (error.message || error)).slice(0, 500);
    } finally {
      settlingIds.delete(col.id);
      delete record.settling;
    }
    const archived = (host.config.archived || []).find((item) => item.id === col.id);
    if (archived) {
      archived.worktree = record;
      if (record.removed && record.repo) archived.cwd = record.repo;
    }
    if (col.boardId) {
      try { await boardRequest('noteWorktree', { id: col.boardId, worktree: cardWorktree(record) }); } catch (_) {}
    }
    save();
    host.flushConfig?.();
    return record;
  }
  // What a sub-captain's control token reaches; targeted ones only on its own children.
  const SUB_ACTIONS = ['create-child', 'main-receipts', 'main-ledger', 'main-tell', 'main-peek', 'main-read', 'main-answer', 'main-stop', 'main-archive', 'main-receipt-listener-status'];
  function ownChild(sub, ref) {
    const key = String(ref || '').trim();
    const target = findTarget(key) || archivedCrew(key, sub);
    if (target && target.subCaptainId === sub.id) return target;
    // read --id <task id> fetches an undelivered instruction of one of its children
    const mine = (id) => [...host.columns(), ...(host.config.archived || [])].some((c) => c.id === id && c.subCaptainId === sub.id);
    if (!target && state().tasks.some((t) => t.id === key && mine(t.colId))) return null;
    throw new Error(`「${key.slice(0, 80)}」不是你开的子会话：小队长只能管自己用 create-child 开的会话。先用 ledger 看你的子会话 id。`);
  }
  async function createChild(message, sub) {
    const s = state();
    const title = window.BoardCore.cleanText(message.title, 80).replace(/\s+/g, ' ');
    const task = window.BoardCore.cleanText(message.task, 2_000_000);
    if (!title || !task) throw new Error('create-child 需要 --title 和 --task。');
    const opened = (col) => `已开子会话 ${col.id}「${host.columnLabel(col)}」，任务会在它准备好后发过去；它的回执和提问只进你的 receipts。`;
    const existing = host.columns().find((c) => c.createdByRequestId === message.id);
    if (existing) return { done: true, result: opened(existing) };
    if (s.waitlist.some((w) => w.requestId === message.id)) return { done: true, result: `「${title}」已在排队。` };
    // Same model as the sub-captain unless it names another one.
    const agent = String(message.agent || '').trim().toLowerCase();
    // Any terminal preset `new` offers; a web executor cannot open or answer children.
    if (agent && (agent === 'chatgpt-web' || !Object.prototype.hasOwnProperty.call(window.BoardCore.AGENT_COMMANDS, agent))) throw new Error(`子会话不支持 --agent ${agent.slice(0, 40)}。可用 claude、agy、cursor、grok、codex，或用 --command 写完整启动命令。`);
    const custom = window.BoardCore.cleanText(message.command, 1000);
    const checked = M.checkCommand(custom || (agent ? window.BoardCore.commandForAgent(agent) : sub.cmd));
    if (checked.error) throw new Error(checked.error);
    const cwd = window.BoardCore.cleanText(message.cwd, 1000) || sub.cwd || '';
    const metadata = { project: sub.project || '', reviews: [], boardId: '', subCaptainId: sub.id, ...(custom ? { quotaExplicit: true } : {}) };
    // Its own folder was trusted for it; the same folder is for its children.
    if (sub.trustedCwd && sub.trustedCwd === sub.cwd && cwd === sub.cwd) metadata.trustedCwd = cwd;
    const placed = await placeSession(title, checked.cmd, cwd, message.id, task, metadata);
    if (placed.queued) return { done: true, result: `${placed.result} 开出来后它的回执和提问只进你的 receipts。` };
    return { done: true, result: opened(placed.col) };
  }
  // The sub-captain's column was archived or closed (the renderer calls this after it left
  // the deck). Its children keep running and report to the Captain from now on: their
  // untaken receipts go to the Captain, after one notice saying who was handed back.
  function releaseSubCrew(sub, how) {
    const s = state();
    if (!s || !sub || sub.subCaptain !== true) return 0;
    const kids = host.columns().filter((c) => c.subCaptainId === sub.id);
    [...kids, ...(host.config.archived || [])].forEach((c) => { if (c.subCaptainId === sub.id) delete c.subCaptainId; });
    s.waitlist.forEach((w) => { if (w.metadata?.subCaptainId === sub.id) delete w.metadata.subCaptainId; });
    // Their cards were in the sub-captain's conversation; unfinished ones show in the Captain's now.
    s.tasks.forEach((t) => {
      if (t.subCaptainId !== sub.id) return;
      delete t.subCaptainId;
      if (!CLOSED.includes(t.status) && t.gen === s.gen) window.ChatUI.addCard(s.colId, t);
    });
    const unread = s.subReceipts?.[sub.id] || [];
    if (s.subReceipts) delete s.subReceipts[sub.id];
    if (kids.length || unread.length) {
      const name = host.columnLabel(sub);
      s.pending.push({ taskId: 'sub-captain-' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), colId: sub.id, title: name, ts: Date.now(), source: 'command',
        summary: `小队长「${name}」已${how}。` + (kids.length ? `它开的 ${kids.length} 个子会话没有结束，已交回给你：${kids.map((c) => `「${host.columnLabel(c)}」(${c.id})`).join('、')}；之后它们的回执和提问直接给你。` : '')
          + (unread.length ? `它还有 ${unread.length} 条子会话回执没取，一并转给你，紧跟在这条后面。` : '') });
      s.pending.push(...unread);
    }
    save();
    host.flushConfig?.();
    return kids.length;
  }
  // The 编辑 dialog respawned a sub-captain's column with a new id (renderer respawnColumn): its
  // children, live, archived or queued, their dispatch records and its untaken receipts follow it.
  function subCaptainIdChanged(oldId, newId) {
    const s = state();
    if (!s || !oldId || !newId || oldId === newId) return;
    [...host.columns(), ...(host.config.archived || [])].forEach((c) => { if (c.subCaptainId === oldId) c.subCaptainId = newId; });
    s.waitlist.forEach((w) => { if (w.metadata?.subCaptainId === oldId) w.metadata.subCaptainId = newId; });
    s.tasks.forEach((t) => { if (t.subCaptainId === oldId) t.subCaptainId = newId; });
    if (s.subReceipts?.[oldId]) { subQueue(s, newId).push(...s.subReceipts[oldId]); delete s.subReceipts[oldId]; }
    subListeners.delete(oldId);
    subNudges.delete(oldId);
    save();
    host.flushConfig?.();
  }
  // Resolves to the response payload, or rejects with a message for the caller.
  function handle(message, caller) {
    return ['main-new', 'main-queue', 'main-task', 'create-child'].includes(message.action)
      ? withQueue(() => handleOnce(message, caller)) : handleOnce(message, caller);
  }
  // The CLI stops waiting at its deadline and reports a timeout. Running the
  // command after that would start work 队长 believes never started, and a retry
  // would then start it twice.
  function refuseLate(message) {
    if (['main-new', 'main-tell', 'main-stop', 'main-archive', 'main-answer', 'main-discuss-receipt'].includes(message.action) && Number.isFinite(message.deadline) && Date.now() > message.deadline) {
      throw new Error('这条命令等到超时才轮到，没有执行。先用 ledger 确认现状，需要的话再发一次。');
    }
  }
  async function handleOnce(message, caller) {
    refuseLate(message);
    const s = state();
    if (message.action === 'seat-auth-alert') {
      if (message.nativeSeatAuth !== true) throw new Error('席位异常只能由程序确认。');
      if (!s || !mainCol()) throw new Error('队长尚未就绪，席位异常等待送达。');
      if (typeof message.alertId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(message.alertId) ||
          !['Claude', 'Codex', 'Cursor', 'Antigravity'].includes(message.provider) ||
          typeof message.seatId !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(message.seatId) ||
          typeof message.message !== 'string' || !message.message.trim() || message.message.length > 4000) throw new Error('Invalid seat authentication alert.');
      s.seatAuthAlerts = Array.isArray(s.seatAuthAlerts) ? s.seatAuthAlerts : [];
      if (!s.seatAuthAlerts.includes(message.alertId)) {
        s.pending.push({ taskId: 'seat-auth-' + message.alertId, colId: s.colId, title: '席位掉登录', ts: Date.now(),
          alertId: message.alertId, provider: message.provider, seatId: message.seatId, question: message.message, source: 'seat-auth' });
        s.seatAuthAlerts.push(message.alertId);
        save();
        host.flushConfig?.();
      }
      return { done: true, result: 'Seat authentication alert recorded.', visible: host.captainColumnVisible(s.colId) };
    }
    const sub = s && isSubCaptain(caller) ? caller : null;
    if (sub) {
      if (!SUB_ACTIONS.includes(message.action)) throw new Error('小队长只能用 create-child、receipts、ledger、tell、peek、read、answer、stop、archive，以及 complete/ask/progress 向总队长汇报；其余命令只有队长能用。');
      if (['main-tell', 'main-peek', 'main-read', 'main-answer', 'main-stop', 'main-archive'].includes(message.action)) ownChild(sub, message.to);
    } else if (!s || !caller || (!isMain(caller) && !(message.action === 'main-new' && message.dispatcherCardId && message.dispatcherCardId === caller.dispatcherCardId && message.boardId === caller.dispatcherCardId))) throw new Error('只有队长可以用这个命令。');
    // Run from its own terminal (not one the program files on its behalf): it is back at work.
    if (!message.nativeWeb && !message.automation) restartWatch?.confirm(caller.id, Date.now());
    // Only the Captain's own work proves a Relay started: messages the program sends
    // in its name (listener heartbeats, install results, the Todo backend) do not.
    const programMade = ['main-receipt-listener-status', 'main-install-result', 'main-todo-delivery', 'main-todo-error', 'main-todo-change'].includes(message.action) ||
      (message.action === 'main-notify-user' && message.nativeWeb === true && /^todo-failures-/.test(String(message.id || '')));
    if (isMain(caller) && s.relayStartup?.attempt?.colId === caller.id && !programMade) {
      s.relayStartup.attempt.output = true; save();
    }
    switch (message.action) {
      case 'main-todo-delivery':
      case 'main-todo-error': {
        const key = message.action === 'main-todo-error' ? message.id : message.taskId;
        if (!message.nativeWeb || !todoReceiptKey(key) || typeof message.result !== 'string' ||
            (message.action === 'main-todo-error' && !key.startsWith('todo-error-'))) throw new Error('Invalid Todo delivery.');
        const accepted = host.config.todoDeliveries || {}, inbox = host.config.todoInbox || {}, pending = s.pending;
        if (!accepted[key]) {
          const receiptId = 'r-' + key;
          const notice = inbox[receiptId] || { receiptId, taskId: key, colId: s.colId,
            title: message.action === 'main-todo-error' ? 'Todo 后台异常' : 'Todo 新任务', ts: Date.now(), summary: message.result, source: 'command' };
          host.config.todoInbox = { ...inbox, [receiptId]: notice };
          if (![...s.pending, ...s.inflight].some((p) => p.receiptId === receiptId)) s.pending = [...s.pending, { ...notice, colId: s.colId }];
          try { persistTodoInbox(); }
          catch (error) { s.pending = pending; host.config.todoInbox = inbox; save(); throw error; }
        }
        return { done: true };
      }
      // The user edited, ticked off or deleted a 待办 handed to this 队长. A 新任务 notice for it
      // that 队长 has not read yet is taken back (it is out of date and nothing else is said);
      // one already read is followed by a short 待办有变 notice. Each change counts once (its id
      // stays in todoDeliveries, so the same change sent again after a restart is not repeated).
      case 'main-todo-change': {
        const key = message.id, card = message.taskId;
        if (!message.nativeWeb || !/^todo-change-[a-f0-9]{64}$/.test(String(key)) || !/^todo-[a-f0-9]{64}$/.test(String(card)) ||
            !['edit', 'stop'].includes(message.kind) || typeof message.result !== 'string' || message.result.length > 4000) throw new Error('Invalid Todo change.');
        const accepted = host.config.todoDeliveries || {}, inbox = host.config.todoInbox || {}, pending = s.pending;
        if (accepted[key] || inbox['r-' + key]) return { done: true };
        const unreadId = 'r-' + card;
        const unread = !!inbox[unreadId] && !s.inflight.some((p) => p.receiptId === unreadId);
        if (unread) {
          const left = { ...inbox }; delete left[unreadId];
          host.config.todoInbox = left;
          host.config.todoDeliveries = { ...accepted, [key]: true };
          s.pending = pending.filter((p) => p.receiptId !== unreadId);
        } else {
          const receiptId = 'r-' + key;
          const notice = { receiptId, taskId: key, colId: s.colId, title: '待办有变', ts: Date.now(), summary: message.result, source: 'command' };
          host.config.todoInbox = { ...inbox, [receiptId]: notice };
          if (![...pending, ...s.inflight].some((p) => p.receiptId === receiptId)) s.pending = [...pending, { ...notice, colId: s.colId }];
        }
        try { persistTodoInbox(); }
        catch (error) { s.pending = pending; host.config.todoInbox = inbox; host.config.todoDeliveries = accepted; save(); throw error; }
        return { done: true, result: unread ? 'Todo notice taken back.' : 'Todo change recorded.' };
      }
      case 'main-install-result': {
        const r = message.installResult;
        const task = s.tasks.find((t) => t.id === r.taskId && t.colId === r.columnId);
        if (!r.taskId && !r.columnId) {
          if (s.lastInstallResultId !== r.id) { boardNotice(message.result); s.lastInstallResultId = r.id; save(); persistInstallation(); }
          return { done: true, result: 'Installation notice recorded.' };
        }
        if (!task) throw new Error('安装任务不存在，结果保留待核对。');
        if (task.installResultId === r.id) { persistInstallation(); return { done: true, result: 'Installation result already recorded.' }; }
        if (task.pendingInstall?.id !== r.id || task.pendingInstall.targetVersion !== r.targetVersion) throw new Error('安装结果与待核对任务不匹配。');
        // Not this session's final receipt (10-10: that read as a finished card, so the restart did not
        // continue the installer and its post-install check had no one). The Captain gets it as a notice
        // and the card as a progress note; the session stays at work and can finish its own job.
        delete task.pendingInstall; delete task.progress;
        task.installResultId = r.id;
        task.installOutcome = { targetVersion: r.targetVersion, status: r.status, summary: message.result, at: Date.now() };
        boardNotice(message.result);
        const boardId = task.boardId || host.columns().find((c) => c.id === task.colId)?.boardId;
        if (boardId) {
          boardWrites = boardWrites.catch(() => {}).then(() => window.deck.taskBoard('resumeNote', {
            id: boardId, session_id: task.colId, attempt_id: task.boardAttempt || '', note: message.result,
          })).catch(() => {});
        }
        update(task);
        persistInstallation();
        return { done: true, result: 'Installation result recorded.' };
      }
      case 'main-receipt-listener-status':
        if (sub) {   // a sub-captain's listener is watched for its children's receipts (watchSubReceipts)
          if (typeof message.alive === 'boolean') subListeners.set(caller.id, { alive: message.alive, at: Date.now() });
          return { done: true };
        }
        if (!isMain(caller) || typeof message.alive !== 'boolean') throw new Error('无效回执监听状态');
        if (listenerStatus?.colId !== caller.id) listenerReminder = false;
        listenerStatus = { colId: caller.id, alive: message.alive, at: Date.now() };
        if (message.alive) listenerReminder = false;
        return { done: true };
      case 'main-inbox':
        if (!isMain(caller)) throw new Error('只有队长可以用这个命令。');
        return window.AttentionUI.captain(message, caller);
      case 'main-notify-user':
        if (!isMain(caller)) throw new Error('只有队长可以用这个命令。');
        // The user also finds it on 待我处理 when they come back.
        // A 待办's failure alert is not one: that item is already filed from the 待办 itself.
        if (!message.test && window.AttentionUI && !/^todo-failures-/.test(String(message.id || ''))) window.AttentionUI.fromNotify(message.message);
        return { done: true, visible: host.captainColumnVisible(caller.id),
          turnId: message.test ? message.id : host.terms.get(caller.id)?.captainTurnId || message.id };
      case 'main-discuss-receipt': {
        if (typeof message.receiptId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(message.receiptId) ||
            typeof message.result !== 'string' || !message.result.trim() || message.result.length > 4000) throw new Error('无效讨论回执');
        s.discussionReceipts ||= [];
        if (!s.discussionReceipts.includes(message.receiptId)) {
          s.pending.push({ taskId: message.receiptId, colId: s.colId, title: '讨论一下',
            ts: Date.now(), summary: message.result, source: 'command' });
          s.discussionReceipts.push(message.receiptId);
          save();
        }
        host.flushConfig?.();
        if (window.deck.saveConfigSync?.(host.config) === false) throw new Error('讨论回执未能落盘，执行器保留回执等待重新投递。');
        return { done: true, result: '讨论回执已收录。' };
      }
      case 'main-briefing':
        return { done: true, result: briefingText() };
      case 'main-quota':
        return { done: true, result: host.quotaText() + batteryLine() };
      case 'main-settings': {
        if (message.op !== 'battery') throw new Error('settings 目前只有 battery。');
        const changed = message.input && Object.keys(message.input).length > 0;
        const view = changed ? setBattery(message.input) : batteryReadout();
        if (!view) throw new Error('这个版本没有电池模式。');
        return { done: true, result: (changed ? '已生效并写入设置：\n' : '') + Bat().settingsText(view) };
      }
      case 'main-handoff': {
        const built = await window.deck.captainHandoff(handoffSnapshot('refresh'));
        // A later restart points 队长 at this file again.
        if (state() === s && built.path && s.seatCheckpoint !== built.path) { s.seatCheckpoint = built.path; save(); }
        return { done: true, result: built.text };
      }
      case 'main-queue': {
        if (message.op === 'list') {
          const wasHold = memoryHold;
          memoryHold = (await readMemoryPressure()).critical;
          refreshWaitingNotes(wasHold !== memoryHold);
          return { done: true, result: JSON.stringify(s.waitlist.map((w) => ({
            taskId: w.metadata?.boardId || w.taskId, queueId: w.taskId, title: w.title, command: w.cmd,
            seat: w.metadata?.claudeSeatId || '', reason: s.tasks.find((t) => t.id === w.taskId)?.waitReason || M.queueNote(M.MAX_ACTIVE, memoryHold, capInfo().limited),
            ...(isHigh(w) ? { priority: 'high' } : {}),
          })), null, 2) };
        }
        if (message.op !== 'cancel' || typeof message.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(message.taskId)) throw new Error('queue cancel 需要 --task-id 卡片或排队 id。');
        const count = cancelWaiting((w) => w.taskId === message.taskId || w.metadata?.boardId === message.taskId, '队长已取消排队。');
        return { done: true, result: count ? `已取消 ${count} 条排队：${message.taskId}。` : `没有这条排队：${message.taskId}。` };
      }
      case 'main-task': {
        if (!['add', 'list', 'move', 'archive', 'priority'].includes(message.op)) throw new Error('Invalid task operation.');
        if (message.op === 'priority') return { done: true, result: await setPriority(message.input?.id, message.input?.level) };
        const result = await boardRequest(message.op, { ...message.input, ...(message.op === 'move' ? { suppressDispatch: true } : {}) });
        if (message.op !== 'list') refreshPriority();
        // 高优先级 cards say so in plain words; an ordinary card has no such line.
        const tag = (c) => (c && c.important === true ? { ...c, priority: 'high' } : c);
        const shown = Array.isArray(result) ? result.map(tag)
          : { ...result, ...(result.card ? { card: tag(result.card) } : {}), ...(Array.isArray(result.cards) ? { cards: result.cards.map(tag) } : {}) };
        return { done: true, result: JSON.stringify(shown, null, 2) };
      }
      case 'main-stop':
      case 'main-archive': {
        const id = String(message.to || '').trim();
        const archive = message.action === 'main-archive';
        if (!host.columns().some((c) => c.id === id && !c.isMain)) {
          if (archive && (host.config.archived || []).some((c) => c.id === id && !c.isMain)) return { done: true, result: `会话 ${id} 已归档。` };
          throw new Error(`找不到可操作的会话：${id.slice(0, 80)}。先用 ledger 看 id；不能中断或归档队长。`);
        }
        const { col, settled } = await endSession(id, { archive, keepQueued: !!message.keepQueued });
        const note = settled?.reason ? ' ' + settled.reason : '';
        return { done: true, result: archive ? `已结束终端并归档「${host.columnLabel(col)}」(${id})。${note}` : `已向「${host.columnLabel(col)}」(${id})发送 Esc，请求中断当前操作。` };
      }
      case 'create-child':
        if (!sub) throw new Error('只有队长开的小队长（new --sub-captain）可以用 create-child；队长自己用 new。');
        return createChild(message, sub);
      case 'main-ledger': {
        if (sub) {
          // Its own children only: no 队长, no other sessions.
          const mine = new Set(childrenOf(sub).map((c) => c.id));
          const shelved = (host.config.archived || []).filter((a) => a.subCaptainId === sub.id).slice(0, 10).map((a) => `${a.id}「${host.columnLabel(a)}」`).join('、');
          const queued = s.waitlist.filter((w) => w.metadata?.subCaptainId === sub.id).map((w) => `「${w.title}」`).join('、');
          const rows = ledgerRows().filter((r) => mine.has(r.id)).map(({ parent, ...r }) => r);
          return { done: true, result: (rows.length ? M.ledgerText(rows) : '你还没有开子会话。') + (shelved ? `\n已归档的子会话（tell 会先自动恢复）：${shelved}` : '') + (queued ? `\n排队等空位：${queued}` : '') };
        }
        const archived = (host.config.archived || []).length;
        const history = M.historyText(host.config.captainHistory);
        const waiting = s.waitlist.map((w) => `${isHigh(w) ? M.PRIORITY_MARK : ''}「${w.title}」`).join('、');
        const crew = (host.config.archived || []).filter((a) => a.captainCrew).slice(0, 10)
          .map((a) => `${a.id}「${host.columnLabel(a)}」`).join('、');
        return { done: true, result: M.ledgerText(ledgerRows()) + (archived ? `\n（另有 ${archived} 个已归档的会话）` : '')
          + (crew ? `\n已归档的队员（tell 会先自动恢复）：${crew}` : '')
          + (waiting ? `\n排队等空位：${waiting}` : '') + batteryLine() + (history ? '\n' + history : '') };
      }
      case 'main-receipts-snapshot': {
        for (const item of s.pending) {
          if (!item.receiptId) {
            s.receiptSeq = (Number.isSafeInteger(s.receiptSeq) ? s.receiptSeq : 0) + 1;
            item.receiptId = 'r-' + Date.now().toString(36) + '-' + s.receiptSeq.toString(36);
          }
        }
        save();
        host.flushConfig?.();
        return { done: true, result: JSON.stringify({ receipts: s.pending.slice(0, 50) }) };
      }
      case 'main-receipts-ack': {
        if (!Array.isArray(message.receiptIds) || message.receiptIds.length > 50 || message.receiptIds.some((id) => typeof id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(id))) throw new Error('Invalid receipt ids.');
        const ids = new Set(message.receiptIds);
        const pending = s.pending, inbox = host.config.todoInbox, accepted = host.config.todoDeliveries;
        const confirmedTodo = confirmTodoReceipts(pending.filter((p) => ids.has(p.receiptId)));
        s.pending = pending.filter((p) => !ids.has(p.receiptId));
        try { if (confirmedTodo) persistTodoInbox(); else { save(); host.flushConfig?.(); } }
        catch (error) {
          s.pending = pending; host.config.todoInbox = inbox; host.config.todoDeliveries = accepted;
          save(); throw error;
        }
        return { done: true, result: JSON.stringify({ acknowledged: pending.length - s.pending.length }) };
      }
      case 'main-receipts': {
        // A short read belonging to a timed watcher must not consume anything
        // if it was queued while the renderer was unavailable and has expired.
        const expired = message.wait && message.expiresAt !== undefined && (!Number.isFinite(message.expiresAt) || Date.now() >= message.expiresAt);
        if (sub) {
          // The sub-captain's children's receipts: handed over once, like the Captain's.
          const queue = s.subReceipts?.[sub.id] || [];
          if (expired || !queue.length) return { done: true, result: message.wait ? '' : '没有新的回执。' };
          s.subReceipts[sub.id] = [];
          save();
          host.flushConfig?.();
          return { done: true, result: M.receiptsForModel(queue) };
        }
        if (nativeCaptain(mainCol()?.cmd)) throw new Error('Native Captain host owns receipt delivery; use snapshot/ack, not a consuming receipts listener.');
        if (expired) return { done: true, result: '' };
        // Exactly one listener. A second one in the same terminal (hung again after
        // /clear, or by mistake) takes over; the older one is told to leave on its
        // next poll. Who is newer is the order this process first saw each watcher,
        // not the client's clock: two started in the same millisecond, or one whose
        // clock moved backwards, still line up by registration. The same watcher
        // polling again keeps its sequence. One that stopped polling no longer counts.
        if (message.wait && typeof message.watcher === 'string' && Number.isFinite(message.watcherStartedAt)) {
          const now = Date.now();
          const current = listener && listener.colId === s.colId && now - listener.at < LISTENER_ALIVE ? listener : null;
          let seq = listenerSeqById.get(message.watcher);
          if (seq === undefined) listenerSeqById.set(message.watcher, seq = ++listenerSeq);
          if (current && current.id !== message.watcher && current.seq > seq) return { done: true, result: M.LISTENER_SUPERSEDED };
          listener = { id: message.watcher, seq, at: now, colId: s.colId };
        }
        if (!s.pending.length) return { done: true, result: message.wait ? '' : '没有新的回执。' };
        // The CLI has the text once this returns. Record that before the copy
        // into inflight so the same config save survives relaunch and Relay.
        const text = takePending(false, undefined, true);
        return { done: true, result: text || '没有新的回执。' };
      }
      case 'main-peek': {
        const col = host.columns().find((c) => c.id === message.to);
        if (!col) throw new Error('找不到运行中的会话；先用 ledger 看 id。peek 不会恢复已归档的会话。');
        const entry = host.terms.get(col.id);
        if (!entry || !entry.alive) throw new Error('这个会话的终端已退出，没有实时输出。');
        const lines = message.lines === undefined ? 40 : message.lines;
        if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Error('peek --lines 必须是 1–1000 的整数。');
        if (col.executor === 'chatgpt-web') {
          const task = s.tasks.findLast((t) => t.colId === col.id && t.status === 'working') || latestTask(col.id);
          return { done: true, result: task?.receipt ? M.receiptsForModel([{ title: task.title, colId: col.id, ...task.receipt }]) : task?.progress || 'ChatGPT 网页任务等待开始。' };
        }
        return { done: true, result: host.dumpScreen(entry.term, lines) };
      }
      case 'main-read': {
        const find = window.BoardCore.cleanText(message.find, 200);
        // Unsent prompts never became chat turns. Recover them by the task id
        // printed in the failure receipt, including after the worker is gone.
        const undelivered = s.tasks.find((t) => t.id === message.to && t.receipt?.undeliveredTaskId)?.receipt
          || [...window.ChatUI.turnsOf(s.colId), ...(window.ChatUI.captainArchives?.() || []).flatMap((chat) => chat.turns)]
            .find((t) => t.id === message.to && t.task?.receipt?.undeliveredTaskId)?.task.receipt;
        if (undelivered) return { done: true, result: undelivered.undeliveredInstruction };
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
        // An archived session keeps its saved chat (restoring it does not need the terminal).
        const shelved = !old && archivedCrew(key, sub);
        if (shelved) return { done: true, result: M.readText(`${host.columnLabel(shelved)}（已归档，tell 可恢复）`, window.ChatUI.turnsOf(shelved.id), message.turns, find) };
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
        const metadata = { project, reviews, boardId: typeof message.boardId === 'string' ? message.boardId : '' };
        if (message.priority !== undefined && (!['high', 'normal'].includes(message.priority) || !isMain(caller))) throw new Error('--priority 只能是 high 或 normal，且只有队长可以标。');
        if (message.subCaptain !== undefined) {
          if (message.subCaptain !== true || !isMain(caller)) throw new Error('--sub-captain 只有队长可以用。');
          if (!project) throw new Error('--sub-captain 需要 --project "项目名"：小队长按项目统筹一摊活。');
          metadata.subCaptain = true;
        }
        if (metadata.boardId && reviews.length) {
          const card = await findCard(metadata.boardId);
          if (!card) throw new Error('找不到卡片。');
          metadata.reviewRound = card.review_round || 0;
          if (card.exec_receipt && !reviews.includes(card.exec_receipt.session_id)) throw new Error('--reviews 必须包含这张卡片的原执行会话。');
          if (!card.exec_receipt) {
            const exec = sessions.find((c) => c.id === reviews[0]);
            if (exec.boardId !== metadata.boardId) throw new Error('--reviews 必须指向这张卡片的原执行会话。');
            metadata.reviewReceipt = { session_id: exec.id, attempt_id: exec.boardAttempt || '',
              text: exec.lastReceipt?.summary || '', files: exec.lastReceipt?.files || [],
              assignee: { agent: window.BoardCore.inferAgentType(exec.cmd || ''), model: exec.cmd?.match(/(?:--model|-m)(?:\s+|=)["']?([^\s"']+)/)?.[1] || 'default' } };
          }
        }
        let prior;
        // Same agent as 队长 unless it asks for another one; never a silent default.
        const agent = String(message.agent || '').trim().toLowerCase();
        if (agent && !['claude', 'agy', 'antigravity', 'cursor', 'cursor-agent', 'grok', 'codex', 'gemini', 'shell', 'chatgpt-web'].includes(agent)) throw new Error(`不认识的 --agent：${agent.slice(0, 40)}。可用 claude、agy、cursor、grok、codex、chatgpt-web，或用 --command 写完整启动命令。`);
        if (agent === 'chatgpt-web') {
          if (message.command || message.seatId !== undefined) throw new Error('chatgpt-web 不支持 --command 或 --seat；使用本机已登录的 ChatGPT 网页。');
          window.ChatGPTWebCore.validatePublicTask(title);
          window.ChatGPTWebCore.validatePublicTask(task);
          if (message.webMode !== undefined && !['chat', 'deep-research'].includes(message.webMode)) throw new Error('--web-mode 只支持 chat 或 deep-research。');
          metadata.executor = 'chatgpt-web';
          metadata.webMode = message.webMode || 'chat';
        } else if (message.webMode !== undefined) throw new Error('--web-mode 仅用于 chatgpt-web。');
        if (metadata.subCaptain && metadata.executor === 'chatgpt-web') throw new Error('小队长要在终端里开子会话、收回执，不能用 chatgpt-web。');
        const custom = window.BoardCore.cleanText(message.command, 1000);
        const explicitCommand = !!custom;
        if (explicitCommand) metadata.quotaExplicit = true;
        const checked = M.checkCommand(custom || (agent ? window.BoardCore.commandForAgent(agent) : nativeCaptain(s.cmd) ? window.BoardCore.commandForAgent('codex') : s.cmd));
        if (checked.error) throw new Error(checked.error);
        const cmd = checked.cmd;
        if (message.seatId !== undefined) {
          // An account name (or a seat code) is resolved against what each directory holds right now.
          const infos = await window.deck.claudeSeats();
          const found = window.ClaudeSeatsCore.resolveSeat(message.seatId, host.config.claudeSeats, infos);
          if (found.error) throw new Error(found.error);
          const seat = found.seat;
          const provider = window.AgentInfo.inferProvider(cmd);
          if (provider && provider !== 'Claude') throw new Error('--seat 仅用于 Claude 会话。');
          const info = infos.find((s) => s.id === seat.id);
          if (!info?.loggedIn) throw new Error(`${seat.name} 未登录，请先在此席位配置目录下登录。当前各目录登录的账号：${window.ClaudeSeatsCore.seatMapText(host.config.claudeSeats, infos)}。`);
          metadata.claudeSeatId = seat.id;
          metadata.claudeConfigDir = seat.configDir;
        }
        const cwd = window.BoardCore.cleanText(message.cwd, 1000);
        // An inherited/default cwd is not authorization. Only the Captain's
        // explicit --cwd or a copy we just created can receive startup trust.
        if (cwd && isMain(caller)) metadata.trustedCwd = cwd;
        if (typeof message.worktree === 'string' && message.worktree.trim()) {
          if (metadata.executor === 'chatgpt-web') throw new Error('--worktree 不能用于网页调研。');
          if (cwd) throw new Error('--worktree 会指定工作目录，不要同时传 --cwd。');
          metadata.worktreeRequest = {
            repo: message.worktree.trim(),
            base: typeof message.base === 'string' ? message.base.trim() : '',
            branch: typeof message.branch === 'string' ? message.branch.trim() : '',
            taskId: metadata.boardId || '',
          };
        } else if ((typeof message.base === 'string' && message.base.trim()) || (typeof message.branch === 'string' && message.branch.trim())) {
          throw new Error('--base 和 --branch 需要 --worktree。');
        }
        if (metadata.boardId) {
          const card = (await window.TaskBoard.list({ archived: true })).find((c) => c.id === metadata.boardId);
          if (!card) throw new Error('找不到卡片：' + metadata.boardId);
          if (metadata.project && metadata.project.trim().toLowerCase() !== String(card.project).trim().toLowerCase()) throw new Error('--project differs from the card project.');
          metadata.project = card.project;
          if (card.archived || card.flag === 'held' || card.flag === 'blocked' || card.status === 'done') throw new Error('卡片尚不可开始，请检查前置任务或显式移回待办。');
          // With a card, the card carries the mark; the session reads it from there.
          if (message.priority !== undefined) { await boardRequest('priority', { id: card.id, level: message.priority }); await refreshPriority(); }
          prior = s.waitlist.find((w) => w.metadata?.boardId === card.id && w.requestId !== message.id);
          if (prior) {
            if (!isMain(caller)) throw new Error('调度员已经派过这张卡片；只有队长可以替换排队。');
            const replacesAutoReview = !!prior.metadata?.autoReviewRound && reviews.length > 0;   // the notice's own command: the same command may take the place of the waiting automatic review
            if (!replacesAutoReview && prior.cmd === cmd && (prior.metadata?.claudeSeatId || '') === (metadata.claudeSeatId || '')) throw new Error('这张卡片已经在排队；换命令/模型可替换，或用 queue cancel --task-id 取消。');
          }
        }
        if (message.priority === 'high' && !metadata.boardId) metadata.important = true;
        if (s.waitlist.some((w) => w.requestId === message.id)) return { done: true, result: `「${title}」已在排队。` };
        // Past the limit, behind work already waiting, at quota, or under critical memory: queue it.
        // placeSession applies same-tier fallback unless the command was named with --command.
        refuseLate(message);   // the checks above wait on the board and the seat list
        // A sub-captain gets its rules with the task itself, so a restart resumes them too.
        const placed = await placeSession(title, cmd, cwd, message.id, metadata.subCaptain ? task + '\n\n' + M.subCaptainBrief(host.platform) : task, metadata, prior);
        if (prior) cancelWaiting((w) => w === prior, '队长已换命令/模型，替换旧排队。');
        if (placed.queued) {
          return { done: true, result: placed.result };
        }
        const opened = placed.title || title;
        const result = placed.plan?.action === 'switch'
          ? `已开新会话 ${placed.col.id}「${opened}」。${placed.plan.note}。`
          : `已开新会话 ${placed.col.id}「${title}」，任务会在它准备好后发过去。`;
        return { done: true, result };
      }
      case 'main-tell':
        return tellSession(message, caller);
      case 'main-answer': {
        const col = findTarget(message.to);
        if (!col) throw new Error(`找不到会话：${String(message.to).slice(0, 80)}。先用 ledger 看 id。`);
        if (col.executor === 'chatgpt-web') throw new Error('ChatGPT 网页会话不接受按键回答，请在网页处理需要用户操作的提示。');
        const entry = host.terms.get(col.id);
        if (!entry || entry.state !== 'input') throw new Error(`「${host.columnLabel(col)}」现在没有停在确认提示上；要给它指令用 tell。`);
        // The status tick can be seconds old, and an agent that exited leaves its last menu on screen above
        // the shell prompt: keys would go to the shell. Read the terminal again before pressing anything.
        if ((host.liveState && host.liveState(col) !== 'input') || (host.platform !== 'win32' && host.agentInForeground && !(await host.agentInForeground(col, false)))) {
          throw new Error(`「${host.columnLabel(col)}」已经不在确认提示上（agent 可能已退出、回到了 shell），一个键也没有按；先 peek 看看。`);
        }
        const key = String(message.key || '').trim().toLowerCase();
        const { keys, submit } = M.answerKeys(key, { appCursor: entry.term?.modes?.applicationCursorKeysMode === true });
        // One press at a time: a menu redraws between arrow keys, and keys that arrive together can be dropped.
        for (let i = 0; i < keys.length; i++) {
          if (i) await new Promise((resolve) => setTimeout(resolve, 60));
          if (host.terms.get(col.id) !== entry || !entry.alive) throw new Error(`「${host.columnLabel(col)}」在按键途中退出了，已按 ${i} 个键。`);
          window.deck.ptyInput(col.id, keys[i]);
        }
        if (submit) setTimeout(() => window.deck.ptyInput(col.id, '\r'), 60);
        s.tasks.forEach((t) => { if (t.colId === col.id && t.status === 'input') { t.status = 'working'; t.answeredAt = Date.now(); update(t); } });
        return { done: true, result: `已替「${host.columnLabel(col)}」按了 ${key}。` };
      }
      default:
        throw new Error('未知命令。');
    }
  }

  // ---- task cards in the main session's chat ----
  const STATUS_TEXT = { waiting: '等空位', queued: '待补充', working: '干活中', paused: '停在安全点', quota: '额度用尽/等待', input: '停在确认', asking: '在问队长', done: '已完成', failed: '没做成', stopped: '已停下' };
  function renderCard(task, colId) {
    // A web task behind another one is waiting its turn, not running: it shows and counts as 排队.
    const webQueued = window.ChatGPTWebCore.isQueued(task);
    const card = el('div', 'task-card st-' + (webQueued ? 'waiting web-queued' : task.status));
    const head = el('div', 'task-head');
    const target = host.columns().find((c) => c.id === task.colId);
    const name = el('button', 'task-title', task.title);
    name.type = 'button';
    name.title = target ? '打开这个会话' : task.status === 'waiting' ? M.queueTitle(M.MAX_ACTIVE, memoryHold, capInfo().limited) : '这个会话已经不在了';
    name.disabled = !target;
    name.addEventListener('click', () => { if (target) host.jumpToColumn(target); });
    head.append(el('span', 'task-arrow', '→'), name, el('span', 'task-status', webQueued ? '排队中' : STATUS_TEXT[task.status] || ''));
    card.appendChild(head);
    if (task.status === 'input') card.appendChild(el('div', 'task-note', '停在确认提示上，已交给队长判断；队长拿不准会来问你。'));
    if (task.status === 'queued') card.appendChild(el('div', 'task-note', '追加给还在忙的会话，等它空下来就发过去。'));
    if (task.status === 'waiting') card.appendChild(el('div', 'task-note', task.waitReason || M.queueNote(M.MAX_ACTIVE, memoryHold, capInfo().limited)));
    if (task.progress && !task.receipt) card.appendChild(el('div', 'task-summary', task.progress));
    const r = task.receipt;
    if (r && r.question) card.appendChild(el('div', 'task-summary', '提问：' + r.question));
    else if (r) {
      if (r.failed) card.appendChild(el('div', 'task-failed', r.failed));
      if (r.undeliveredTaskId) card.appendChild(el('div', 'task-note', `取回未送达指令原文：read --id ${r.undeliveredTaskId}`));
      if (r.summary) card.appendChild(el('div', 'task-summary', r.summary));
      if (!r.explicit && !r.failed) card.appendChild(el('div', 'task-note', '会话已结束，等待命令回执超过 3 分钟。'));
      if (r.files && r.files.length) card.appendChild(receiptFiles(task, r.files));
    }
    return card;
  }
  // The results the user looks at come first; scripts, tests, data and logs (the
  // 交付文件 panel's 从不算交付 types) fold behind one line until it is clicked.
  const openCode = new Set();    // task ids whose code files are unfolded
  function receiptFiles(task, list) {
    const D = window.DeliverablesCore;
    const { results, code } = D.splitReceiptFiles(list, D.normalizeRules(host.config.deliverableRules));
    const files = el('div', 'task-files');
    results.forEach((p) => files.appendChild(window.ChatUI.attachmentChip(p, task.colId)));
    if (!code.length) return files;
    const open = openCode.has(task.id);
    const toggle = el('button', 'task-code-toggle');
    toggle.type = 'button';
    toggle.title = '展开 / 收起代码文件';
    toggle.setAttribute('aria-expanded', String(open));
    const chev = el('span', 'ico proc-chev');
    chev.innerHTML = host.ICONS.chevRight;
    toggle.append(chev, el('span', null, (results.length ? '另有 ' : '') + code.length + ' 个代码文件'));
    const box = el('div', 'task-files task-code');
    box.hidden = !open;
    code.forEach((p) => box.appendChild(window.ChatUI.attachmentChip(p, task.colId)));
    toggle.addEventListener('click', () => {
      const now = !openCode.has(task.id);
      if (now) openCode.add(task.id); else openCode.delete(task.id);
      box.hidden = !now;
      toggle.setAttribute('aria-expanded', String(now));
    });
    files.append(toggle, box);
    return files;
  }

  function init(h) {
    host = h;
    normalize();
    const attempt = state()?.relayStartup?.attempt;
    if (attempt && attempt.colId === mainCol()?.id) {
      // A rebuilt PTY must prove it received the briefing and started work;
      // old-process output cannot satisfy its watchdog after a restart.
      attempt.promptSent = false; attempt.output = false; delete attempt.promptSentAt;
      save();
    }
    loadResumeManifest();
    initDialog();
    // A boost kept in the config comes back after a restart (not when plugged in, or past its end time).
    if (Bat() && host.config.batteryBoost && Number.isFinite(host.config.batteryBoost.until)) {
      Bat().shared.set({ boost: true, boostUntil: host.config.batteryBoost.until });
      Bat().shared.expireBoost(Date.now());
      syncEffectiveCap();
    }
    Bat()?.shared.onChange(syncEffectiveCap);
    window.deck.onTasksChanged?.(() => { refreshPriority(); deliverWaitingDispatch(); });
    refreshPriority();
    deliverWaitingDispatch();
    // Briefed (or only told the app restarted) once its terminal is back: captainRelaunched.
    if (mainCol()) { startupBrief = mainCol().id; if (mainCol().cmd) briefing = startupBrief; }
  }

  window.MainSession = {
    init, open, create, clearContext, openSettings, checkpointForSeatSwitch, handoffSnapshot, relayIdle, relayEffort, handle, submit, onTick, onPower, onTurnStarted, onTurnDone, onContextCommand, onContextCommandSent, onOutput, outgoingPrefix, renderCard, skipsResume,
    parkForRestart, noteColdColumn, notePtySurvived, restartLaunch, launchBlocked,
    isMain, isMainId, mainCol, state, sendMessage, settleArchivedWorktree, syncEffectiveCap, dispatchWeb, userNotice, automation, boardAction,
    // 小队长: the renderer calls releaseSubCrew(col, '归档'|'关掉') once a sub-captain's column left the deck
    releaseSubCrew,
    // ... and subCaptainIdChanged(oldId, newId) once respawnColumn gave a sub-captain's column a new id
    subCaptainIdChanged,
    batteryReadout, setBattery,
    // 高优先级: isPriority(session column), isHigh(queued request or dispatch record), setPriority(id, 'high'|'normal') from the user's click
    isPriority: sessionHigh, isHigh, setPriority: (id, level) => setPriority(id, level, true),

    history: () => host.config.captainHistory || [],
    queueNote: () => M.queueNote(M.MAX_ACTIVE, memoryHold, capInfo().limited),
    queueTitle: () => M.queueTitle(M.MAX_ACTIVE, memoryHold, capInfo().limited),
    memoryHeld: () => memoryHold,
    exists: () => !!mainCol(),
    pauseForSeatSwitch: (value) => { seatChanging = !!value; },
  };
})();
