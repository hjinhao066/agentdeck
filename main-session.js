// 队长 (Captain), internally the main session: one standing column that understands what you want, hands the work
// to other columns, and shows you short receipts. It never does the work in
// its own column. Its control channel is the existing capability-tokened board
// bridge: only this column's terminal holds a token that main-* commands
// accept; workers receive a separate submission-only capability.
(function () {
  'use strict';
  const M = window.MainCore;
  const nativeCaptain = (cmd) => /codex-captain-host\.js["']?(?:\s|$)/.test(cmd || '');
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
  // receiptsSeen: ids the background receipts channel already returned. Saved with
  // the rest of mainSession in config.json, so a relaunch or Relay does not
  // deliver them again. Legacy injection stays out of this set until its turn ends.
  // fresh: the context was cleared and 队长 has not finished a turn since.
  // crewMarked: sessions opened before captainCrew existed were marked once.
  // waitlist: `new` requests waiting for a free slot (settings cap, live on M.MAX_ACTIVE), oldest first;
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

  function boardNotice(message) {
    const s = state();
    if (!s) throw new Error('请先创建队长，再开始卡片。');
    s.pending.push({ taskId: 'board-' + Date.now(), colId: s.colId, title: '任务看板', ts: Date.now(), summary: message, source: 'command' });
    save();
  }
  async function boardRequest(op, input) {
    const result = await window.deck.taskBoard(op, input);
    if (op === 'move' && ['done', 'todo'].includes(result.card?.status)) cancelWaiting((w) => w.metadata?.boardId === result.card.id, '卡片已移到' + result.card.status + '，取消排队。');
    for (const notice of result.notices || []) boardNotice(notice);
    return result;
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
    if (metadata?.autoReviewRound) {
      return commandQuota(cmd, seatId)?.out
        ? { action: 'queue', cmd, reason: 'out', held: 'out', note: '' }
        : { action: 'open', cmd, note: '' };
    }
    return quotaPlan(cmd, seatId, explicit);
  }
  function quotaQueueText(plan, title, dispatch = false) {
    if (plan.reason === 'explicit') {
      const why = plan.held === 'low' ? '额度低于阈值' : '额度用尽';
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
    const cmd = window.BoardCore.commandForAgent('agy');
    const plan = quotaPlan(cmd);
    if (plan.action === 'queue') {
      const waiting = await boardRequest('dispatchWait', { id, key, message: quotaQueueText(plan, card.title, true) });
      if (!waiting.ignored) quotaStarts.set(id, { id, key });
      return { card: waiting.card, queued: true };
    }
    quotaStarts.delete(id);
    const sessionId = 'c-dispatch-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const reserved = await boardRequest('dispatch', { id, key, session_id: sessionId });
    if (reserved.ignored) return { card: reserved.card, ignored: true };
    const cli = M.boardCli(host.platform);
    const prompt = M.dispatcherInstructions(host.platform, card);
    const title = plan.action === 'switch' ? notedTitle('调度：' + card.title, plan.note) : '调度：' + card.title;
    const col = host.createSession({ id: sessionId, title, displayTitle: title, cmd: plan.cmd, captainCrew: true, project: card.project, dispatcherCardId: id }, true);
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
    const picked = AV.pickReviewer({ executor: card.exec_receipt?.assignee, candidates: AV.CANDIDATES,
      commandOf: (c) => c.command || window.BoardCore.commandForAgent(c.agent), quotaOut: (cmd) => !!commandQuota(cmd)?.out });
    const checked = picked.cmd ? M.checkCommand(picked.cmd) : null;
    if (!picked.cmd || checked.error) {
      await boardRequest('reviewBlocked', { id, key: input.key, reason: picked.reason || checked.error });
      return { card, blocked: true };
    }
    const executor = sessionById(card.exec_receipt?.session_id);
    const title = window.BoardCore.cleanText('审查：' + card.title, 80).replace(/\s+/g, ' ');
    const metadata = { project: card.project, reviews: executor ? [executor.id] : [], boardId: id, autoReviewRound: claim.round };
    const placed = await withQueue(async () => {
      const current = await findCard(id);
      if (state() !== s || !current || current.review_claim?.key !== input.key || current.review_claim.delivered ||
        current.status !== 'review' || current.review_round !== claim.round || current.review_session === true ||
        s.waitlist.some((w) => w.metadata?.boardId === id) || [...host.columns(), ...(host.config.archived || [])].some((c) => c.boardId === id && c.boardAttempt === attempt)) return false;
      await placeSession(title, checked.cmd, executor?.cwd || '', attempt, AV.reviewPrompt({ card, receipt: card.exec_receipt }), metadata);
      return true;
    });
    host.flushConfig?.();   // the queue entry is on disk before the claim is marked delivered
    await boardRequest('reviewDispatched', { id, key: input.key });
    return placed ? { card, reviewer: picked.candidate.id } : { card, ignored: true };
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
    await tellSession({ to: execId, message: AV.reworkMessage({ card, findings: reject.findings }), id: AV.reworkAttemptId(id, reject.round) });
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
    const s = host.config.mainSession;
    if (!s || typeof s !== 'object' || typeof s.colId !== 'string') { host.config.mainSession = null; return; }
    s.gen = Number.isFinite(s.gen) ? s.gen : 1;
    s.cmd = typeof s.cmd === 'string' ? window.BoardCore.upgradeLegacyCommand(s.cmd) : '';
    const col = host.columns().find((c) => c.id === s.colId && c.isMain);
    if (col && col.cmd) s.cmd = col.cmd;
    s.pending = Array.isArray(s.pending) ? s.pending : [];
    s.inflight = Array.isArray(s.inflight) ? s.inflight : [];
    s.receiptsSeen = normalizeSeenIds(s.receiptsSeen);
    s.exceptionSeen = Array.isArray(s.exceptionSeen) ? s.exceptionSeen.filter((key) => typeof key === 'string') : [];
    // A turn open at shutdown cannot acknowledge legacy injection. Receipts the
    // background channel already returned stay read across relaunch. Items still
    // in pending were never taken, including ones that arrived while restarting.
    const seen = new Set(s.receiptsSeen);
    s.pending = [...unreadReceipts(s.inflight, seen), ...s.pending];
    s.inflight = [];
    s.mobileMessages = Array.isArray(s.mobileMessages) ? s.mobileMessages.filter((m) => typeof m === 'string' ? m.trim() && m.length <= 8000 : mobileImages(m?.atts).length && typeof m.text === 'string' && m.text.length <= 8000) : [];
    s.fresh = !!s.fresh;
    s.legacyReceiptInjection = s.legacyReceiptInjection === true && !nativeCaptain(s.cmd);
    s.tasks = Array.isArray(s.tasks) ? s.tasks.filter((t) => t && typeof t.id === 'string' && typeof t.colId === 'string').slice(-MAX_TASKS) : [];
    s.tasks.forEach((t) => { delete t.boardRetrying; });
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
  let seatChanging = false;
  function briefingText(note) {
    return M.instructions(host.platform, note, state()?.legacyReceiptInjection === true, host.config.concurrencyCap);
  }
  function brief(col, note) {
    if (!col.cmd) return;   // a bare shell would run them as commands
    const id = col.id;
    briefing = id;
    const done = () => { if (briefing === id) briefing = ''; };
    const sent = () => {
      done();
      if (note) host.sendWhenReady(col, note, { silent: true, guardUserInput: true });
    };
    host.sendWhenReady(col, briefingText(note), {
      silent: true, onSent: sent, guardUserInput: true,
      onGiveUp: () => { done(); host.showToast('没发出去：队长的 agent 一直没准备好'); },
    });
  }
  function initDialog() {
    const settings = $('notificationSettings');
    $('csEnabled').onchange = () => { $('csThreshold').disabled = !$('csEnabled').checked; };
    $('csSave').onclick = () => {
      if ($('csEnabled').checked && !$('csThreshold').reportValidity()) return;
      if (!$('concurrencyCap').reportValidity()) return;
      host.config.captainTokenSaver = M.tokenSaverSettings({ enabled: $('csEnabled').checked, threshold: Number($('csThreshold').value) * 1000 });
      host.config.resumeOnRestart = $('resumeOnRestart').checked;
      applyConcurrencyCap($('concurrencyCap').value);
      cancelTokenSaving();
      tokenSaverPaused = false;
      save();
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
    const resumeBox = $('resumeOnRestart');
    if (resumeBox) resumeBox.checked = window.RestartResume.resumeEnabled(host.config);
  }
  function applyConcurrencyCap(raw) {
    const cap = M.concurrencyCap(raw);
    host.config.concurrencyCap = cap;
    M.MAX_ACTIVE = cap;
    refreshWaitingNotes();
    pump();
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
    return window.deck.captainCheckpoint({ ...snapshot, chat: window.ChatUI.snapshotForHandoff(col.id), tasks: state().tasks });
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
      silent, guardUserInput: true, requireIdle: true, timeout: 5 * 60_000,
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
      // The briefing already ends with AUTONOMOUS_CONTINUATION. Appending it
      // again exceeds the 8000-character inline limit, so the captain would
      // only see a file pointer and miss the "don't wait" closing.
      saverSend(op, briefingText() + '\n\n读看板继续。', 'briefing', true, () => {
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
    s.pending = [...s.inflight, ...s.pending];
    s.inflight = [];
    delete col.modelSessionId;
    col.cmd = M.freshCommand(col.cmd);
    s.cmd = col.cmd;
    s.fresh = true;
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
      silent: true, guardUserInput: true, requireIdle: true,
      cancelled: () => contextReset !== op && !entry.injecting,
      onSent: () => { if (contextReset === op) { contextReset = null; host.showToast('已重新发送队长提示词，先读账本和看板里的队长交接'); } },
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
    const requeue = rotation ? unreadReceipts(s.inflight, seen) : s.inflight.slice();
    s.inflight = [];
    const oldId = col.id;
    const retired = window.ChatUI.retireChat(oldId, { interrupted: !!rotation });
    if (retired) {
      host.config.captainHistory = M.normalizeHistory([...(host.config.captainHistory || []), { id: oldId, ...retired, clearedAt: Date.now() }]);
    }
    s.pending = [...requeue, ...(rotation ? unreadReceipts(s.pending, seen) : s.pending)];
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
    s.fresh = true;
    carried.forEach((t) => window.ChatUI.addCard(s.colId, t));
    save();
    window.Sidebar.render();
    brief(fresh, M.resetNote(retired ? oldId : '', carried.filter((t) => !CLOSED.includes(t.status)))
      + (rotation ? `\n${options.relayMessage || ''}\n先运行 ${M.boardCli(host.platform)} briefing，再读看板继续：${options.checkpointPath}。先确认旧监听已退出，然后重挂恰好一个后台 receipts --wait --timeout 300 监听。` : ''));
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
    const activity = M.terminalActivity(entry.lastScreen, col?.cmd) || (M.claudeBackgroundTasks(entry.lastScreen, col?.cmd) ? 'working' : '');
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
  // col null: a 'waiting' card for work queued until a slot frees up.
  function addTask(col, title) {
    const s = state();
    const task = {
      id: 'k' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      colId: col ? col.id : '', title: String(title || host.columnLabel(col)).slice(0, 120), gen: s.gen,
      status: col ? 'queued' : 'waiting', sentAt: Date.now(), turnId: '', receipt: null,
      project: col ? col.project || '' : '', reviews: col ? col.reviews || [] : [],
      boardId: col?.boardId || '', boardAttempt: col?.boardAttempt || '',
    };
    s.tasks.push(task);
    if (s.tasks.length > MAX_TASKS) s.tasks.splice(0, s.tasks.length - MAX_TASKS);
    window.ChatUI.addCard(s.colId, task);
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
    task.progress = '正在排队等待 ChatGPT 网页';
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
  function dispatch(col, text, title, waiting, immediate = false) {
    if (col.executor === 'chatgpt-web') window.ChatGPTWebCore.validatePublicTask(text);
    const supplement = state().tasks.some((t) => t.colId === col.id && t.startedAt);
    const task = waiting || addTask(col, title);
    if (waiting) {
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
      return sentItems.map((i) => i.text).join('\n\n');
    }, {
      cancelled: () => batch.cancelled || batch.items.every((i) => i.task.status === 'stopped' || i.task.status === 'failed'),
      suffix: M.RECEIPT_CONTRACT, force: true, guardUserInput: true, requireIdle: true, timeout: 30 * 60_000, keepWaiting: true,
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
          else { t.doneAt = Date.now(); t.receipt = { summary: '已合并到后面的补充指令，一起送达。', files: [], images: [], failed: '', explicit: true }; }
          update(t);
          if (t === last) { persistResumeEntry(col, t); autoBoardEvent(t, 'started'); }
        });
      },
      onGiveUp: (reason) => {
        if (dispatches.get(col.id) === batch) dispatches.delete(col.id);
        batch.items.forEach(({ task: t }) => settle(t, { summary: '', files: [], images: [], failed: reason || '这个会话已无法接收指令', explicit: true, source: 'process' }));
      },
      onWaiting: () => {
        const task = batch.items.find((i) => i.task.status === 'queued')?.task;
        if (task) { push(task, { summary: '补充指令等待超过 30 分钟，仍在排队；会话空闲后自动送达。', source: 'queue' }); save(); }
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
      if (t === task || t.colId !== task.colId || !['working', 'quota', 'input', 'asking'].includes(t.status)) return;
      t.receipt = { summary: '后来又给这个会话发了新指令，结果看后面的卡片。', files: [], images: [], failed: '', explicit: true };
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
      : active >= M.MAX_ACTIVE ? `已排队：现在有 ${active} 个会话占用干活名额，上限 ${M.MAX_ACTIVE}；有空位时自动开新会话「${title}」。`
      : ahead ? `已排队：前面有 ${ahead} 条可执行任务，当前 ${active} 个会话占用干活名额；按顺序自动开新会话「${title}」。` : '';
  }
  async function openSession(title, cmd, cwd, requestId, text, waiting, metadata = {}) {
    const id = 'c-board-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    if (metadata.autoReviewRound) {
      // An automatic reviewer that waited in the queue only starts if its round is still the open one.
      const card = (await window.TaskBoard.list({ archived: true })).find((c) => c.id === metadata.boardId);
      if (!card || card.status !== 'review' || card.review_round !== metadata.autoReviewRound || card.review_session === true) throw new Error('这张卡片已经不在这一轮待验收了，审查会话没有开。');
    }
    if (metadata.boardId) {
      await boardRequest('bind', { id: metadata.boardId, project: metadata.project, session_id: id, attempt_id: requestId,
        assignee: { agent: window.BoardCore.inferAgentType(cmd), model: cmd.match(/(?:--model|-m)(?:\s+|=)["']?([^\s"']+)/)?.[1] || 'default' } });
    }
    const col = host.createSession({ ...metadata, taskPrompt: text, captainTaskPrompt: text, id, boardAttempt: requestId, title, cmd, cwd, createdByRequestId: requestId, displayTitle: title, manualTitle: true, captainCrew: true }, true);
    if (waiting) { waiting.boardId = metadata.boardId || ''; waiting.boardAttempt = requestId; }
    dispatch(col, text, title, waiting);
    return col;
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
  // A queued request keeps its text in config.json; a long one goes to a file first.
  async function enqueue(title, cmd, cwd, requestId, text, metadata = {}, reason = '') {
    const s = state();
    let body = text;
    if (body.length > 8000 && metadata.executor !== 'chatgpt-web') {
      const file = await window.deck.saveLongPrompt(body).catch(() => '');
      if (!file) throw new Error('任务太长，存文件失败，没有排上队。');
      body = `${body.slice(0, 300).replace(/\s+/g, ' ').trim()}…\n（这件活共 ${text.length} 字，完整内容已存成文件，请先完整读取再照做：${file}）`;
      if (state() !== s) throw new Error('队长已经关掉了，这件活没有排上队。');   // closed while the file was written
    }
    const task = addTask(null, title);
    Object.assign(task, metadata);
    const held = openPlan(cmd, metadata.claudeSeatId, metadata.quotaExplicit, metadata);
    task.waitReason = held.action === 'queue' ? quotaQueueText(held, title) : reason;
    s.waitlist.push({ taskId: task.id, title, cmd, cwd, requestId, task: body, project: metadata.project, reviews: metadata.reviews, metadata });
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
    // Quota-held requests do not block a different available provider.
    const ahead = s.waitlist.filter((w) => w !== replaced && openPlan(w.cmd, w.metadata?.claudeSeatId, w.metadata?.quotaExplicit, w.metadata).action !== 'queue').length;
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
      await M.fillQueue({
        cap: M.MAX_ACTIVE, active, waiting: s.waitlist.length, level: pressure.level,
        take: () => {
          if (state() !== s) return null;
          const index = s.waitlist.findIndex((w) => openPlan(w.cmd, w.metadata?.claudeSeatId, w.metadata?.quotaExplicit, w.metadata).action !== 'queue');
          return index < 0 ? null : s.waitlist.splice(index, 1)[0];
        },
        open: async (w) => {
          const task = s.tasks.find((t) => t.id === w.taskId && t.status === 'waiting');
          if (!task || state() !== s) return;
          const plan = openPlan(w.cmd, w.metadata?.claudeSeatId, w.metadata?.quotaExplicit, w.metadata);
          if (plan.action === 'queue') {
            s.waitlist.unshift(w);
            task.waitReason = quotaQueueText(plan, w.title);
            update(task);
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
    if (entry && entry.alive && (!['done', 'plain'].includes(entry.state) || entry.sendingPrompt || entry.injecting || M.terminalActivity(entry.lastScreen, col?.cmd) || M.claudeBackgroundTasks(entry.lastScreen, col?.cmd))) return;
    // a dot that reads idle is only a guess: any recent output also means it is not finished
    if (entry && entry.alive && Date.now() - (entry.lastOutputAt || 0) < Math.min(ACTIVE_OUTPUT_MS, M.ARCHIVE_AFTER)) return;
    if (M.needsCardCheck(s, col.id)) refreshCards();
    if (M.archivable(s, col.id, host.lastTurnTs(col.id), Date.now(), M.ARCHIVE_AFTER, cardCache)) host.archiveColumn(col, { quiet: true });
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
  function settle(task, receipt, boardRecorded = false) {
    if (CLOSED.includes(task.status)) return;
    if (receipt.failed && task.instructionSent === false && task.instruction) {
      receipt = { ...receipt, undeliveredInstruction: task.instruction, undeliveredTaskId: task.id };
    }
    if (task.boardId && !boardRecorded) {
      const type = receipt.failed ? 'failed' : receipt.question ? 'ask' : receipt.source === 'fallback' ? 'fallback' : 'complete';
      autoBoardEvent(task, type, receipt.failed || receipt.question || receipt.summary, receipt.source || 'automatic');
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
    if (anomaly) {
      const key = task.colId + ':' + anomaly;
      s.exceptionSeen = Array.isArray(s.exceptionSeen) ? s.exceptionSeen : [];
      if (s.exceptionSeen.includes(key)) return false;
      s.exceptionSeen.push(key);
    }
    s.pending.push({ ...(anomaly ? { anomaly } : {}), taskId: task.id, colId: task.colId, title: task.title, ts: Date.now(), ...item });
    return true;
  }
  // Hand every pending receipt to 队长's model as text; they count as in
  // flight until its turn ends.
  const MAX_RECEIPTS_SEEN = 500;
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
  function unreadReceipts(items, seen) {
    return (Array.isArray(items) ? items : []).filter((item) => item && (typeof item.receiptId !== 'string' || !seen.has(item.receiptId)));
  }
  function takePending(nextTurn = false, batch) {
    const s = state();
    const text = M.receiptsForModel(s.pending);
    const turnId = nextTurn ? '' : (window.ChatUI.turnsOf(s.colId).findLast((t) => t.kind !== 'task' && !t.done)?.id || '');
    s.inflight = [...s.inflight, ...s.pending.map((p) => ({ ...p, deliveryTurnId: turnId, ...(batch ? { batch } : {}) }))];
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
        const back = s.inflight.filter((p) => p.batch === batch).map(({ batch: b, deliveryTurnId, ...item }) => item);
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
    const task = s.tasks.findLast((t) => t.colId === caller.id && t.status !== 'waiting' && (t.startedAt || message.action === 'session-exit' && t.restartHold) && (caller.executor !== 'chatgpt-web' || !message.taskId || t.id === message.taskId));
    if (caller.executor === 'chatgpt-web' && (!message.taskId || !task || CLOSED.includes(task.status))) return { done: true, result: 'Submission ignored: web task is no longer active.' };
    const response = { done: true, result: 'Submission recorded.' };
    if (['complete', 'ask', 'progress'].includes(message.action) &&
        window.RestartResume?.bindSessionIdentity(caller, message.modelSessionIds, host.columns())) save();
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
    if (task.receipt?.source === 'command' && ['done', 'failed'].includes(task.status)) return response;
    if (message.action === 'session-exit') {
      if (task.status === 'stopped' && task.receipt?.source === 'fallback') {
        task.status = 'working';
        s.pending = s.pending.filter((p) => p.taskId !== task.id || p.source !== 'fallback');
      }
      if (!CLOSED.includes(task.status) || task.status === 'asking') {
        if (task.status === 'asking') task.status = 'working';
        const entry = host.terms.get(caller.id);
        // The exit command may beat the status tick; read the current terminal.
        const screen = entry?.term ? host.dumpScreen(entry.term, 40) : entry?.lastScreen;
        const receipt = { summary: '', files: [], images: [], failed: `agent 进程已退出（exit ${message.code}），未提交回执`, explicit: true, source: 'process', ...M.resourceReceipt(screen, caller.cmd) };
        await recordReceiptForBoard(task, receipt);
        settle(task, receipt, true);
      }
      return response;
    }
    if (message.action === 'progress') {
      if (typeof message.message !== 'string' || !message.message.trim()) throw new Error('progress requires --message.');
      task.progress = message.message;
      caller.progress = message.message;
      task.endedAt = 0;
      persistResumeEntry(caller, task);
      update(task);
      return response;
    }
    const receipt = M.commandReceipt(message);
    delete task.progress; // this authenticated receipt is newer than prior progress
    task.resumeSubmission = true; // cancel delayed delivery before the asynchronous board write
    await recordReceiptForBoard(task, receipt);
    // A real submission may follow a question or the no-receipt notice. Replace
    // an unread automatic notice so the Captain sees the authoritative result.
    if (['asking', 'stopped', 'failed'].includes(task.status)) {
      if (task.receipt?.source === 'command' && task.status !== 'asking') return response;
      s.pending = s.pending.filter((p) => p.taskId !== task.id);
      task.status = 'working';
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
    const receipt = task.progress || (task.receipt && !task.receipt.checkpoint ? task.receipt.summary || task.receipt.failed || task.receipt.question : '');
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
    resumeManifest.claims[col.id] = { phase: 'failed', runId: resumeRun, taskId: task.id, at: Date.now() };
    saveResumeManifest();
    settle(task, { summary: '', files: [], images: [], failed, explicit: true, source: 'resume' });
    host.showToast(failed);
  }
  function restartLaunch(col, isFresh) {
    const R = window.RestartResume;
    const task = col && latestTask(col.id);
    if (col?.executor === 'chatgpt-web') return { mode: 'leave' };
    if (!R || !col || !R.resumeEnabled(host.config) || !col.captainCrew || col.isMain ||
        coldTasks.get(col.id) !== task?.id || (isFresh && !task.resumeFallback)) return { mode: 'leave' };
    const owner = col.modelSessionOwner === col.id && col.modelSessionCwd === (col.cwd || '') &&
      !host.columns().some((c) => c !== col && String(c.modelSessionId || '').toLowerCase() === String(col.modelSessionId || '').toLowerCase() && R.providerOf(c.cmd) === R.providerOf(col.cmd));
    return R.launchChoice({ cmd: col.cmd, sessionId: owner && !task.resumeFallback ? col.modelSessionId : null, task, enabled: true });
  }
  function notePtySurvived(col) {
    if (!col) return;
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
          update(running);
        } else if (running && status?.receipt && status.receipt.taskId === running.id) {
          submit({ action: 'complete', taskId: running.id, ...status.receipt }, col);
        } else if (running && !status?.active) {
          settle(running, { summary: '', files: [], images: [], failed: '网页执行器没有正在运行的任务；请检查已保存报告及保留请求页后再安排任务。', explicit: true, source: 'process' });
        } else startWebTask(col);
      }).catch(() => {});
    }
  }
  function noteColdColumn(col, isFresh) {
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
    if (R.isCheckpointClosure(task)) { task.status = 'paused'; task.doneAt = 0; task.endedAt = 0; }
    resumeWaiting.set(col.id, how);
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(flushResume, 600);
  }
  async function resumeBody(col, task, stored) {
    const entry = {
      mode: col.restartMode === 'resume' && !task.resumeFallback ? 'resume' : 'resend',
      provider: window.RestartResume.providerOf(col.cmd) || '未知',
      title: task.title || stored.title || '', task: stored.task || task.instruction || col.taskPrompt || '',
      receipt: stored.receipt || '', pendingText: pendingInstruction(col.id) || stored.pendingText || '',
    };
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
          if (!entry.receipt) entry.receipt = card.latest_receipt || '';
        }
      } catch (_) {}
    }
    if (task.instruction && !entry.task.includes(task.instruction) && !entry.pendingText.includes(task.instruction)) entry.task += '\n最后送达的任务指令：\n' + task.instruction;
    if (!entry.receipt && task.receipt && !task.receipt.checkpoint) entry.receipt = task.receipt.summary || task.receipt.failed || task.receipt.question || '';
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
        host.sendWhenReady(col, R.resumeMessage(entry), {
          silent: true, force: true, guardUserInput: true, timeout: RESUME_SEND_TIMEOUT, suffix: M.RECEIPT_CONTRACT,
          cancelled: () => released || !activeResume(col, task, op),
          onSent: (turn) => {
            if (released || !activeResume(col, task, op)) { op.release(); return; }
            resumeManifest.claims[col.id] = { phase: 'sent', runId: resumeRun, taskId: task.id, mode: entry.mode, at: Date.now() };
            for (const t of state().tasks) {
              if (t.colId !== col.id || !R.shouldResume(t) || t === task) continue;
              t.instructionSent = true;
              t.status = 'done';
              t.doneAt = Date.now();
              t.receipt = { summary: '已合并到后面的补充指令，一起送达。', files: [], failed: '', explicit: true };
              update(t);
            }
            if (entry.pendingText) task.instruction = entry.pendingText;
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
      const batch = dispatches.get(col.id);
      if (batch) batch.cancelled = true;
      task.status = 'paused';
      task.restartHold = true;
      task.doneAt = 0;
      task.endedAt = 0;
      task.receipt = { summary: R.checkpointSummary(), files: [], images: [], failed: '', explicit: true, checkpoint: true, source: 'restart' };
      col.lastReceipt = { ...task.receipt, ts: Date.now() };
      const term = host.terms.get(col.id);
      if (term?.alive) {
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

  // ---- heartbeat: called for every column on the 1.5s status loop ----
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
  function onTick(id, entry) {
    const s = state();
    if (!s) return;
    if (id === s.colId) {
      for (const [cardId, input] of quotaStarts) {
        if (quotaPlan(window.BoardCore.commandForAgent('agy')).action !== 'queue') {
          quotaStarts.delete(cardId);
          startCard(cardId, input).catch((error) => host.showToast(error.message));
        }
      }
      remindMissingListener(entry);
      retryBoardWrites(s); if (!seatChanging) { contextResetTick(entry); if (!contextReset) tokenSaverTick(entry); if (!tokenSaving && !contextReset) { deliver(entry); deliverMobile(); } pump(); } return;
    }
    const col = host.columns().find((c) => c.id === id);
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
        s.pending = s.pending.filter((p) => p.taskId !== task.id || p.source !== 'fallback');
        autoBoardEvent(task, 'started', '', 'resume-fallback-' + Date.now());
        update(task);
      } else if (stale) {
        if (task?.status === 'working') autoBoardEvent(task, 'started', '', 'resume-fallback-' + Date.now());
        save();
      }
    }
    for (const task of s.tasks) {
      if (task.colId !== id) continue;
      if (task.status === 'stopped' && task.receipt?.source === 'fallback' &&
          (!entry.alive || entry.state === 'quota' || M.terminalActivity(entry.lastScreen, col?.cmd) === 'quota')) {
        task.status = 'working';
        s.pending = s.pending.filter((p) => p.taskId !== task.id || p.source !== 'fallback');
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
      if (!entry.alive) { if (task.status === 'asking') task.status = 'working'; settle(task, { summary: '', files: [], images: [], failed: entry.exitReason || '这个会话的终端已经退出', explicit: true, source: 'process', ...M.resourceReceipt(entry.lastScreen, col?.cmd) }); continue; }
      const activity = M.terminalActivity(entry.lastScreen, col?.cmd);
      if (entry.state === 'quota' || activity === 'quota') {
        if (window.RestartResume && window.RestartResume.ignoreQuota(task, Date.now())) continue;
        // Follow-ups queued after the failure still wait for the provider to
        // resume; a brand-new session exhausted at startup fails its first task.
        if (task.status === 'queued' && (task.supplement || col?.lastReceipt?.source === 'quota')) continue;
        if (task.status === 'asking') task.status = 'working';
        settle(task, { summary: '', files: [], images: [], failed: '额度用尽，agent 无法继续当前任务', explicit: true, source: 'quota', ...M.resourceReceipt(entry.lastScreen, col?.cmd) });
        continue;
      }
      const quietSince = Math.max(entry.lastOutputAt || 0, task.startedAt || task.sentAt || 0);
      const quietLimit = M.silenceTimeout(col?.cmd);
      if (quietSince && Date.now() - quietSince >= quietLimit && entry.state !== 'input' &&
          (task.status === 'working' || task.status === 'queued' && !task.supplement)) {
        if (push(task, { summary: `已连续 ${quietLimit / 60_000} 分钟没有任何终端输出，请检查会话；可能仍在深度思考，未自动中断或重派。`, source: 'watchdog' })) save();
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
      if (!task.processEnded && (entry.state === 'working' || activity === 'working')) { task.endedAt = 0; continue; }
      // Never parse a screen/reply for receipts. Only a finished turn with
      // no foreground or background work starts the command grace period.
      const turn = task.turnId && window.ChatUI.turnsOf(task.colId).find((t) => t.id === task.turnId);
      const ended = task.endedAt || (turn?.done && !turn.interrupted && entry.state === 'done' ? (task.endedAt = Date.now()) : 0);
      if (!ended || turn && !turn.done && !task.processEnded) continue;
      if (Date.now() - Math.max(ended, entry.lastOutputAt || 0) < STOP_QUIET) continue;
      settle(task, { summary: '已结束，未提交回执', files: [], images: [], failed: '', explicit: false, source: 'fallback' });
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
      if (tokenSaving?.phase === 'archiving' && turn.id === tokenSaving.turnId) {
        if (!turn.interrupted && String(turn.reply || '').trim() === '已存档') {
          if (tokenSaving.relay) {
            const op = tokenSaving;
            clearTimeout(op.timer); tokenSaving = null; saverBanner(''); op.resolve();
          } else { tokenSaving.phase = 'archived'; tokenSaving.since = Date.now(); }
        }
        else saverFailed('队长没有只回复「已存档」，未清空上下文');
      }
      if (s.inflight.length || s.fresh) {
        s.inflight = s.inflight.filter((p) => p.deliveryTurnId !== turn.id);
        s.fresh = false;
        save();
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
      return {
        id: c.id, title: host.columnLabel(c), state: c.executor === 'chatgpt-web' ? webTaskState(task) : cursorWorking ? 'working' : completed ? 'done' : resumedState, terminalState,
        folder: folders.get(c.folderId) || '', receipt: c.lastReceipt || null,
        project: c.project || '', reviews: c.reviews || [],
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
    if (!col) {
      const old = archivedCrew(message.to);
      if (old) { col = host.restoreArchived(old.id, false, true); restored = true; }
    }
    if (!col) throw new Error(`找不到会话：${String(message.to).slice(0, 80)}。先用 ledger 看 id。`);
    if (col.executor === 'chatgpt-web') window.ChatGPTWebCore.validatePublicTask(text);
    // Refuse before rebinding. bind() consumes a pending automatic rework, so a
    // prompt or a bare shell must not mark that rework delivered when nothing was sent.
    const entry = host.terms.get(col.id);
    if (!restored) {
      if (entry && entry.state === 'input' && !message.now) throw new Error(`「${host.columnLabel(col)}」停在确认提示上：有把握就用 answer 回答它，没把握就请用户去那一列处理。`);
      if (!col.cmd && !(await host.agentInForeground(col, false))) {
        throw new Error(`「${host.columnLabel(col)}」里只有 shell，没有在运行的 agent，不能把活发进去。请用 new 开一个新会话来做。`);
      }
    }
    if (col.boardId) {
      const card = (await window.TaskBoard.list({ archived: true })).find((c) => c.id === col.boardId);
      if (card && (card.attempt_closed || !card.session_id) && (!restored || card.status === 'doing' && card.flag !== 'held')) {
        await boardRequest('bind', { id: card.id, project: card.project, session_id: col.id, attempt_id: message.id,
          assignee: { agent: window.BoardCore.inferAgentType(col.cmd), model: col.cmd.match(/(?:--model|-m)(?:\s+|=)["']?([^\s"']+)/)?.[1] || 'default' } });
        col.boardAttempt = message.id;
      }
    }
    if (restored) {
      dispatch(col, text, host.columnLabel(col));
      return { done: true, result: `「${host.columnLabel(col)}」已归档，已恢复它并把指令发过去，它准备好后会收到。` };
    }
    const busy = entry && (entry.state === 'working' || entry.state === 'quota');
    if (message.replace) cancelSupplement(col.id);
    if (message.now) {
      await handle({ action: 'main-stop', to: col.id, keepQueued: true }, caller);
    }
    dispatch(col, text, host.columnLabel(col), null, message.now);
    return { done: true, result: message.now ? `已请求中断「${host.columnLabel(col)}」，新指令在输入框就绪后立即送达。` : busy ? `「${host.columnLabel(col)}」正在干活，指令先放着（待补充），等它停下合并发送。` : `已发给「${host.columnLabel(col)}」(${col.id})。` };
  }
  // Resolves to the response payload, or rejects with a message for the caller.
  function handle(message, caller) {
    return ['main-new', 'main-queue', 'main-task'].includes(message.action)
      ? withQueue(() => handleOnce(message, caller)) : handleOnce(message, caller);
  }
  async function handleOnce(message, caller) {
    const s = state();
    if (!s || !caller || (!isMain(caller) && !(message.action === 'main-new' && message.dispatcherCardId && message.dispatcherCardId === caller.dispatcherCardId && message.boardId === caller.dispatcherCardId))) throw new Error('只有队长可以用这个命令。');
    switch (message.action) {
      case 'main-receipt-listener-status':
        if (!isMain(caller) || typeof message.alive !== 'boolean') throw new Error('无效回执监听状态');
        if (listenerStatus?.colId !== caller.id) listenerReminder = false;
        listenerStatus = { colId: caller.id, alive: message.alive, at: Date.now() };
        if (message.alive) listenerReminder = false;
        return { done: true };
      case 'main-notify-user':
        if (!isMain(caller)) throw new Error('只有队长可以用这个命令。');
        return { done: true, visible: host.captainColumnVisible(caller.id),
          turnId: message.test ? message.id : host.terms.get(caller.id)?.captainTurnId || message.id };
      case 'main-briefing':
        return { done: true, result: briefingText() };
      case 'main-quota':
        return { done: true, result: host.quotaText() };
      case 'main-queue': {
        if (message.op === 'list') {
          const wasHold = memoryHold;
          memoryHold = (await readMemoryPressure()).critical;
          refreshWaitingNotes(wasHold !== memoryHold);
          return { done: true, result: JSON.stringify(s.waitlist.map((w) => ({
            taskId: w.metadata?.boardId || w.taskId, queueId: w.taskId, title: w.title, command: w.cmd,
            seat: w.metadata?.claudeSeatId || '', reason: s.tasks.find((t) => t.id === w.taskId)?.waitReason || M.queueNote(M.MAX_ACTIVE, memoryHold),
          })), null, 2) };
        }
        if (message.op !== 'cancel' || typeof message.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(message.taskId)) throw new Error('queue cancel 需要 --task-id 卡片或排队 id。');
        const count = cancelWaiting((w) => w.taskId === message.taskId || w.metadata?.boardId === message.taskId, '队长已取消排队。');
        return { done: true, result: count ? `已取消 ${count} 条排队：${message.taskId}。` : `没有这条排队：${message.taskId}。` };
      }
      case 'main-task': {
        if (!['add', 'list', 'move', 'archive'].includes(message.op)) throw new Error('Invalid task operation.');
        const result = await boardRequest(message.op, { ...message.input, ...(message.op === 'move' ? { suppressDispatch: true } : {}) });
        return { done: true, result: JSON.stringify(result, null, 2) };
      }
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
        if (col.executor === 'chatgpt-web' && entry) entry.webExecutorStopping = true;
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
        if (col.executor === 'chatgpt-web') {
          try { await window.deck.chatgptWebCancel(id); }
          finally { if (entry) entry.webExecutorStopping = false; }
        }
        if (archive) host.archiveColumn(col, { captain: true, quiet: true });
        else if (col.executor !== 'chatgpt-web') window.deck.ptyInput(id, '\x1b');
        if (col.executor === 'chatgpt-web' && entry) { entry.webExecutorState = 'stopped'; entry.state = 'stopped'; }
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
        const count = s.pending.length;
        s.pending = s.pending.filter((p) => !ids.has(p.receiptId));
        save();
        host.flushConfig?.();
        return { done: true, result: JSON.stringify({ acknowledged: count - s.pending.length }) };
      }
      case 'main-receipts': {
        if (nativeCaptain(mainCol()?.cmd)) throw new Error('Native Captain host owns receipt delivery; use snapshot/ack, not a consuming receipts listener.');
        // A short read belonging to a timed watcher must not consume anything
        // if it was queued while the renderer was unavailable and has expired.
        if (message.wait && message.expiresAt !== undefined && (!Number.isFinite(message.expiresAt) || Date.now() >= message.expiresAt)) return { done: true, result: '' };
        if (!s.pending.length) return { done: true, result: message.wait ? '' : '没有新的回执。' };
        // The CLI has the text once this returns. Record that before the copy
        // into inflight so the same config save survives relaunch and Relay.
        rememberReceiptsSeen(s.pending);
        const text = takePending();
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
        const metadata = { project, reviews, boardId: typeof message.boardId === 'string' ? message.boardId : '' };
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
        const custom = window.BoardCore.cleanText(message.command, 1000);
        const explicitCommand = !!custom;
        if (explicitCommand) metadata.quotaExplicit = true;
        const checked = M.checkCommand(custom || (agent ? window.BoardCore.commandForAgent(agent) : nativeCaptain(s.cmd) ? window.BoardCore.commandForAgent('codex') : s.cmd));
        if (checked.error) throw new Error(checked.error);
        const cmd = checked.cmd;
        if (message.seatId !== undefined) {
          const seat = window.ClaudeSeatsCore.normalize(host.config.claudeSeats).find((s) => s.id === message.seatId);
          if (!seat) throw new Error('找不到 --seat 席位，请先查看席位设置。');
          const provider = window.AgentInfo.inferProvider(cmd);
          if (provider && provider !== 'Claude') throw new Error('--seat 仅用于 Claude 会话。');
          const info = (await window.deck.claudeSeats()).find((s) => s.id === seat.id);
          if (!info?.loggedIn) throw new Error(`${seat.name} 未登录，请先在此席位配置目录下登录。`);
          metadata.claudeSeatId = seat.id;
          metadata.claudeConfigDir = seat.configDir;
        }
        const cwd = window.BoardCore.cleanText(message.cwd, 1000);
        if (metadata.boardId) {
          const card = (await window.TaskBoard.list({ archived: true })).find((c) => c.id === metadata.boardId);
          if (!card) throw new Error('找不到卡片：' + metadata.boardId);
          if (metadata.project && metadata.project.trim().toLowerCase() !== String(card.project).trim().toLowerCase()) throw new Error('--project differs from the card project.');
          metadata.project = card.project;
          if (card.archived || card.flag === 'held' || card.flag === 'blocked' || card.status === 'done') throw new Error('卡片尚不可开始，请检查前置任务或显式移回待办。');
          prior = s.waitlist.find((w) => w.metadata?.boardId === card.id && w.requestId !== message.id);
          if (prior) {
            if (!isMain(caller)) throw new Error('调度员已经派过这张卡片；只有队长可以替换排队。');
            if (prior.cmd === cmd && (prior.metadata?.claudeSeatId || '') === (metadata.claudeSeatId || '')) throw new Error('这张卡片已经在排队；换命令/模型可替换，或用 queue cancel --task-id 取消。');
          }
        }
        if (s.waitlist.some((w) => w.requestId === message.id)) return { done: true, result: `「${title}」已在排队。` };
        // Past the limit, behind work already waiting, at quota, or under critical memory: queue it.
        // placeSession applies same-tier fallback unless the command was named with --command.
        const placed = await placeSession(title, cmd, cwd, message.id, task, metadata, prior);
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
  const STATUS_TEXT = { waiting: '等空位', queued: '待补充', working: '干活中', paused: '停在安全点', quota: '额度用尽/等待', input: '停在确认', asking: '在问队长', done: '已完成', failed: '没做成', stopped: '已停下' };
  function renderCard(task, colId) {
    const card = el('div', 'task-card st-' + task.status);
    const head = el('div', 'task-head');
    const target = host.columns().find((c) => c.id === task.colId);
    const name = el('button', 'task-title', task.title);
    name.type = 'button';
    name.title = target ? '打开这个会话' : task.status === 'waiting' ? M.queueTitle(M.MAX_ACTIVE, memoryHold) : '这个会话已经不在了';
    name.disabled = !target;
    name.addEventListener('click', () => { if (target) host.jumpToColumn(target); });
    head.append(el('span', 'task-arrow', '→'), name, el('span', 'task-status', STATUS_TEXT[task.status] || ''));
    card.appendChild(head);
    if (task.status === 'input') card.appendChild(el('div', 'task-note', '停在确认提示上，已交给队长判断；队长拿不准会来问你。'));
    if (task.status === 'queued') card.appendChild(el('div', 'task-note', '追加给还在忙的会话，等它空下来就发过去。'));
    if (task.status === 'waiting') card.appendChild(el('div', 'task-note', task.waitReason || M.queueNote(M.MAX_ACTIVE, memoryHold)));
    if (task.progress && !task.receipt) card.appendChild(el('div', 'task-summary', task.progress));
    const r = task.receipt;
    if (r && r.question) card.appendChild(el('div', 'task-summary', '提问：' + r.question));
    else if (r) {
      if (r.failed) card.appendChild(el('div', 'task-failed', r.failed));
      if (r.undeliveredTaskId) card.appendChild(el('div', 'task-note', `取回未送达指令原文：read --id ${r.undeliveredTaskId}`));
      if (r.summary) card.appendChild(el('div', 'task-summary', r.summary));
      if (!r.explicit && !r.failed) card.appendChild(el('div', 'task-note', '会话已结束，等待命令回执超过 3 分钟。'));
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
    loadResumeManifest();
    initDialog();
    if (mainCol()) brief(mainCol(), state()?.seatCheckpoint ? `读看板继续：${state().seatCheckpoint}` : '');
  }

  window.MainSession = {
    init, open, create, clearContext, openSettings, checkpointForSeatSwitch, relayIdle, relayEffort, handle, submit, onTick, onTurnStarted, onTurnDone, onContextCommand, onContextCommandSent, onOutput, outgoingPrefix, renderCard, skipsResume,
    parkForRestart, noteColdColumn, notePtySurvived, restartLaunch,
    isMain, isMainId, mainCol, state, sendMessage,

    history: () => host.config.captainHistory || [],
    queueNote: () => M.queueNote(M.MAX_ACTIVE, memoryHold),
    queueTitle: () => M.queueTitle(M.MAX_ACTIVE, memoryHold),
    memoryHeld: () => memoryHold,
    exists: () => !!mainCol(),
    pauseForSeatSwitch: (value) => { seatChanging = !!value; },
  };
})();
