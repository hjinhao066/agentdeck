// 队长 (Captain), internally the main session: one standing column that understands what you want, hands the work
// to other columns, and shows you short receipts. It never does the work in
// its own column. Its control channel is the existing capability-tokened board
// bridge: only this column's terminal holds a token that main-* commands
// accept; the columns it drives get no token and so no control of anything.
(function () {
  'use strict';
  const M = window.MainCore;
  const C = window.ChatCore;
  let host = null;
  const startedAt = Date.now();
  const MAX_TASKS = 120;            // cards kept in config.json; older ones drop off
  const FALLBACK_AFTER = 30_000;   // a finished column with no extracted turn gets a screen-based receipt

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // config.mainSession = { colId, cmd, gen, pending: [receipt], tasks: [task] }
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
    const s = host.config.mainSession;
    if (!s || typeof s !== 'object' || typeof s.colId !== 'string') { host.config.mainSession = null; return; }
    s.gen = Number.isFinite(s.gen) ? s.gen : 1;
    s.cmd = typeof s.cmd === 'string' ? s.cmd : '';
    s.pending = Array.isArray(s.pending) ? s.pending.slice(-50) : [];
    s.tasks = Array.isArray(s.tasks) ? s.tasks.filter((t) => t && typeof t.id === 'string' && typeof t.colId === 'string').slice(-MAX_TASKS) : [];
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
    $('mdCmd').value = 'claude --dangerously-skip-permissions';
    $('mdCwd').value = '';
    d.showModal();
    setTimeout(() => $('mdCmd').focus(), 50);
  }
  function create(cmd, cwd) {
    if (mainCol()) { open(); return mainCol(); }
    const col = host.createMain({ cmd, cwd });
    host.config.mainSession = { colId: col.id, cmd, gen: 1, pending: [], tasks: [] };
    save();
    window.Sidebar.render();
    brief(col);
    return col;
  }
  // The instructions go straight into the terminal; they are not a user bubble.
  function brief(col) {
    if (!col.cmd) return;   // a bare shell would run them as commands
    host.sendWhenReady(col, M.instructions(), { silent: true });
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

  // ---- clear context: the main column starts over, nothing else is touched ----
  function clearContext() {
    const col = mainCol();
    const s = state();
    if (!col || !s) return;
    if (!confirm('清空队长的上下文？队长的气泡和模型上下文会清掉，相当于这一列重新开始。\n其他会话不受影响，已经派出去的活继续进行。')) return;
    s.gen += 1;
    s.pending = [];
    window.ChatUI.clearChat(col.id);
    const fresh = host.respawnColumn(col);   // new id, new shell, new token
    s.colId = fresh.id;
    save();
    window.Sidebar.render();
    brief(fresh);
    host.showToast('队长的上下文已清空，重新开始');
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
  function addTask(col, title) {
    const s = state();
    const task = {
      id: 'k' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      colId: col.id, title: String(title || host.columnLabel(col)).slice(0, 120), gen: s.gen,
      status: 'queued', sentAt: Date.now(), turnId: '', receipt: null,
    };
    s.tasks.push(task);
    if (s.tasks.length > MAX_TASKS) s.tasks.splice(0, s.tasks.length - MAX_TASKS);
    window.ChatUI.addCard(s.colId, task);
    save();
    return task;
  }
  function dispatch(col, text, title) {
    const task = addTask(col, title);
    host.sendWhenReady(col, text, {
      suffix: M.RECEIPT_CONTRACT, force: true, timeout: 30 * 60_000,
      onSent: (turn) => {
        task.status = 'working';
        task.turnId = turn ? turn.id : '';
        task.startedAt = Date.now();
        update(task);
      },
      onGiveUp: () => settle(task, { summary: '', files: [], images: [], failed: '30 分钟内一直发不出去：那一列的 agent 一直在忙或没有运行', explicit: true }),
    });
    return task;
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
  // Queue something for 队长's model; it goes out on the next quiet moment.
  function push(task, item) {
    const s = state();
    if (!s || task.gen !== s.gen) return;
    s.pending.push({ colId: task.colId, title: task.title, ts: Date.now(), ...item });
    if (s.pending.length > 50) s.pending.splice(0, s.pending.length - 50);
  }
  // Receipts and questions reach 队长 by themselves: when its agent is idle,
  // they are typed in as one message (no user bubble) and its answer shows up
  // as a normal reply. Your own next message carries them too, if sooner.
  let delivering = false;
  function deliver(entry) {
    const s = state();
    const col = mainCol();
    closeOrphans();
    if (delivering || !s || !col || !col.cmd || !s.pending.length || !entry.alive) return;
    if (entry.state === 'working' || entry.state === 'input') return;
    if (Date.now() - (entry.lastOutputAt || 0) < 1500) return;   // let it settle first
    // only into 队长's agent, never into a shell it may have dropped back to
    delivering = true;
    host.agentInForeground(col, false).then((ok) => {
      delivering = false;
      if (!ok || !s.pending.length || mainCol() !== col) return;
      const text = M.receiptsForModel(s.pending);
      s.pending = [];
      save();
      window.ChatUI.sendPrompt(col, '', null, { prefix: text.trim(), force: true });
    }, () => { delivering = false; });
  }
  // Work handed to a column that was closed, archived or restarted since.
  function closeOrphans() {
    const s = state();
    if (!s) return;
    const ids = new Set(host.columns().map((c) => c.id));
    s.tasks.forEach((t) => {
      if (!CLOSED.includes(t.status) && !ids.has(t.colId)) {
        settle(t, { summary: '', files: [], images: [], failed: '这个会话已经关掉、归档或重启了', explicit: true });
      }
    });
  }

  // ---- heartbeat: called for every column on the 1.5s status loop ----
  function onTick(id, entry) {
    const s = state();
    if (!s) return;
    if (id === s.colId) { deliver(entry); return; }
    for (const task of s.tasks) {
      if (task.colId !== id || !['queued', 'working', 'input'].includes(task.status)) continue;
      if (!entry.alive) { settle(task, { summary: '', files: [], images: [], failed: '这个会话的终端已经退出', explicit: true }); continue; }
      if (task.status === 'queued') continue;
      if (entry.state === 'input') {
        // just answered: the old prompt can still be on screen for a moment
        if (task.status === 'input' || (task.answeredAt && Date.now() - task.answeredAt < 5000)) continue;
        task.status = 'input';
        // a confirmation or permission prompt goes to 队长 first, with only its last lines
        const excerpt = String(entry.lastScreen || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-8)
          .map((l) => l.slice(0, 140)).join('\n');
        push(task, { waiting: excerpt || '（看不到提示内容）' });
        update(task);
        continue;
      }
      // the prompt is gone (answered here or in the column): back to work
      if (task.status === 'input') { task.status = 'working'; update(task); }
      if (entry.state === 'working') { task.idleSince = 0; continue; }
      // The reply normally arrives through the chat turn (onTurnDone). If the
      // app restarted mid-task, or no turn was recorded, don't wait forever.
      if (entry.state === 'done' || entry.state === 'plain') {
        task.idleSince = task.idleSince || Date.now();
        if (Date.now() - task.idleSince < FALLBACK_AFTER) continue;
        if ((task.startedAt || task.sentAt) < startedAt) {
          settle(task, { summary: 'AgentDeck 重启过，没收到这件活的回执，去那一列看结果。', files: [], images: [], failed: '', explicit: false });
        } else {
          settle(task, M.parseReceipt(entry.lastScreen || '', filePaths));
        }
      } else {
        task.idleSince = 0;
      }
    }
  }
  function onTurnDone(colId, turn) {
    const s = state();
    if (!s) return;
    const task = s.tasks.find((t) => t.colId === colId && t.turnId === turn.id);
    if (task) settle(task, M.parseReceipt(turn.reply, filePaths));
  }
  function filePaths(text) {
    return String(text).split('\n').flatMap((line) => host.findLinks(line)).filter((m) => m.kind === 'file').map((m) => m.text.trim());
  }

  // New receipts ride along with your next message to the main session.
  function outgoingPrefix(col) {
    const s = state();
    if (!s || !isMain(col) || !s.pending.length) return '';
    const text = M.receiptsForModel(s.pending);
    s.pending = [];
    save();
    return text;
  }

  // ---- commands from the main session's terminal (board-cli) ----
  function ledgerRows() {
    const folders = new Map((host.config.folders || []).map((f) => [f.id, f.name]));
    return host.columns().filter((c) => !c.isMain).map((c) => {
      const entry = host.terms.get(c.id);
      return {
        id: c.id, title: host.columnLabel(c), state: entry ? (entry.alive ? entry.state || 'plain' : 'exited') : 'plain',
        folder: folders.get(c.folderId) || '', receipt: c.lastReceipt || null,
      };
    });
  }
  // Resolves to the response payload, or rejects with a message for the caller.
  async function handle(message, caller) {
    const s = state();
    if (!s || !caller || !isMain(caller)) throw new Error('只有队长可以用这个命令。');
    switch (message.action) {
      case 'main-ledger': {
        const archived = (host.config.archived || []).length;
        return { done: true, result: M.ledgerText(ledgerRows()) + (archived ? `\n（另有 ${archived} 个已归档的会话）` : '') };
      }
      case 'main-receipts': {
        const text = M.receiptsForModel(s.pending).trim();
        s.pending = [];
        save();
        return { done: true, result: text || '没有新的回执。' };
      }
      case 'main-read': {
        const col = findTarget(message.to);
        if (!col) throw new Error(`找不到会话：${String(message.to).slice(0, 80)}。先用 ledger 看 id。`);
        return { done: true, result: M.readText(host.columnLabel(col), window.ChatUI.turnsOf(col.id), message.turns) };
      }
      case 'main-new': {
        const title = window.BoardCore.cleanText(message.title, 80).replace(/\s+/g, ' ');
        const task = window.BoardCore.cleanText(message.task, 2_000_000);
        if (!title || !task) throw new Error('new 需要 --title 和 --task。');
        const existing = host.columns().find((c) => c.createdByRequestId === message.id);
        if (existing) return { done: true, result: `已开新会话 ${existing.id}「${host.columnLabel(existing)}」。` };
        // Same agent as 队长 unless it asks for another one; never a silent default.
        const agent = String(message.agent || '').trim().toLowerCase();
        if (agent && !['claude', 'agy', 'antigravity', 'grok', 'shell'].includes(agent)) throw new Error(`不认识的 --agent：${agent.slice(0, 40)}。可用 claude、agy、grok，或用 --command 写完整启动命令。`);
        const custom = window.BoardCore.cleanText(message.command, 1000);
        const cmd = custom || (agent ? window.BoardCore.commandForAgent(agent) : s.cmd);
        const col = host.createSession({ title, cmd, cwd: window.BoardCore.cleanText(message.cwd, 1000), createdByRequestId: message.id, displayTitle: title, manualTitle: true }, true);
        dispatch(col, task, title);
        return { done: true, result: `已开新会话 ${col.id}「${title}」，任务会在它准备好后发过去。` };
      }
      case 'main-tell': {
        const col = findTarget(message.to);
        if (!col) throw new Error(`找不到会话：${String(message.to).slice(0, 80)}。先用 ledger 看 id。`);
        const text = window.BoardCore.cleanText(message.message, 2_000_000);
        if (!text) throw new Error('tell 需要 --message。');
        const entry = host.terms.get(col.id);
        if (entry && entry.state === 'input') throw new Error(`「${host.columnLabel(col)}」停在确认提示上：有把握就用 answer 回答它，没把握就请用户去那一列处理。`);
        // a bare shell with no agent to start would run the text as commands
        if (!col.cmd && !(await host.agentInForeground(col, false))) {
          throw new Error(`「${host.columnLabel(col)}」里只有 shell，没有在运行的 agent，不能把活发进去。请用 new 开一个新会话来做。`);
        }
        const busy = entry && entry.state === 'working';
        dispatch(col, text, host.columnLabel(col));
        return { done: true, result: busy ? `「${host.columnLabel(col)}」正在干活，指令已排队，等它停下就发。` : `已发给「${host.columnLabel(col)}」(${col.id})。` };
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
  const STATUS_TEXT = { queued: '排队中', working: '干活中', input: '停在确认', asking: '在问队长', done: '已完成', failed: '没做成', stopped: '已停下' };
  function renderCard(task, colId) {
    const card = el('div', 'task-card st-' + task.status);
    const head = el('div', 'task-head');
    const target = host.columns().find((c) => c.id === task.colId);
    const name = el('button', 'task-title', task.title);
    name.type = 'button';
    name.title = target ? '跳到这个会话' : '这个会话已经不在了';
    name.disabled = !target;
    name.addEventListener('click', () => { if (target) host.jumpToColumn(target); });
    head.append(el('span', 'task-arrow', '→'), name, el('span', 'task-status', STATUS_TEXT[task.status] || ''));
    card.appendChild(head);
    if (task.status === 'input') card.appendChild(el('div', 'task-note', '停在确认提示上，已交给队长判断；队长拿不准会来问你。'));
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
  }

  window.MainSession = {
    init, open, create, clearContext, handle, onTick, onTurnDone, outgoingPrefix, renderCard,
    isMain, isMainId, mainCol, state,
    exists: () => !!mainCol(),
  };
})();
