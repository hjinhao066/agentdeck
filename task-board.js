'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { resourceFailure } = require('./main-core');
const AutoVerify = require('./auto-verify-core');
const Worktree = require('./worktree-core');

const STATUSES = ['todo', 'doing', 'review', 'needs_user', 'done'];
function projectName(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(?:\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new Error('Invalid project name (must be a portable filename).');
  return value;
}
// AgentDeck and agentdeck are one project (the stored name is never rewritten).
function sameProject(a, b) { return String(a).normalize('NFC').toLowerCase() === String(b).normalize('NFC').toLowerCase(); }
function idValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid task/session id.');
  return value;
}
function text(value, name, required = false) {
  if (typeof value !== 'string' || value.length > 2_000_000 || (required && !value.trim())) throw new Error(`Invalid ${name}.`);
  return value;
}
function sentence(value) { return String(value || '').trim().split(/(?<=[。！？.!?])(?:\s|$)|\r?\n/u)[0]; }
function brief(value, count = 2) {
  const parts = String(value || '').trim().split(/(?<=[。！？.!?])|\r?\n/u).map((part) => part.trim()).filter(Boolean);
  return parts.slice(0, count).join(' ').slice(0, 500);
}
function finishStatus(card) {
  touch(card);
  if (card.status !== 'needs_user') delete card.user_question;
}
function localSessions(config) {
  const tasks = config.mainSession?.tasks || [];
  const sessions = [...(config.columns || []).map((c) => {
    const status = tasks.findLast((t) => t.colId === c.id)?.status;
    return { ...c, active: ['queued', 'working', 'paused', 'quota', 'input', 'asking'].includes(status), failed: ['failed', 'stopped'].includes(status) };
  }), ...(config.archived || []).map((c) => ({ ...c, archived: true }))];
  const known = new Set(sessions.map((s) => s.id));
  // A local assignment record proves provenance even after its column is deleted.
  for (const task of tasks) if (task.colId && !known.has(task.colId)) {
    sessions.push({ id: task.colId, archived: true }); known.add(task.colId);
  }
  return sessions;
}
// 高优先级 is the card's `important` flag: the user named this card as urgent
// (start it now, ahead of ordinary work). One level above ordinary; a card
// without the field is ordinary.
const PRIORITIES = ['high', 'normal'];
function priorityOf(card) { return card && card.important === true ? 'high' : 'normal'; }
function priorityLevel(value) {
  if (!PRIORITIES.includes(value)) throw new Error('priority must be high or normal.');
  return value;
}
function touch(card) { card.updated = new Date(Math.max(Date.now(), (Date.parse(card.updated) || 0) + 1)).toISOString(); }
function newCard(input, now = new Date().toISOString()) {
  const project = projectName(input.project);
  if (input.verify !== undefined && typeof input.verify !== 'boolean') throw new Error('verify must be boolean.');
  if (input.important !== undefined && typeof input.important !== 'boolean') throw new Error('important must be boolean.');
  if (input.priority !== undefined) priorityLevel(input.priority);
  const depends = input.depends_on || [];
  if (!Array.isArray(depends)) throw new Error('depends_on must be an array.');
  return { id: input.id ? idValue(input.id) : 't-' + crypto.randomUUID(), project,
    title: text(input.title, 'title', true), detail: text(input.detail || '', 'detail'), status: 'todo', flag: null,
    order: 0, depends_on: [...new Set(depends.map(idValue))], assignee: null, session_id: null,
    latest_receipt: '', verify: !!input.verify, rework_count: 0, created: now, updated: now, archived: false,
    consecutive_failures: 0, important: input.priority !== undefined ? input.priority === 'high' : input.important === true };
}

function syncedCard(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid synced card.');
  const card = {
    id: idValue(input.id), project: projectName(input.project),
    title: text(input.title, 'title', true), detail: text(input.detail || '', 'detail'),
    status: STATUSES.includes(input.status) ? input.status : 'todo',
    flag: [null, 'failed', 'blocked', 'held', 'quota'].includes(input.flag) ? input.flag : null,
    order: Number.isFinite(input.order) && input.order >= 0 ? input.order : 0,
    depends_on: Array.isArray(input.depends_on) ? [...new Set(input.depends_on.map(idValue))] : [],
    assignee: input.assignee && typeof input.assignee === 'object' && typeof input.assignee.agent === 'string' && typeof input.assignee.model === 'string' ? { agent: input.assignee.agent, model: input.assignee.model } : null,
    session_id: typeof input.session_id === 'string' && input.session_id ? idValue(input.session_id) : null,
    latest_receipt: typeof input.latest_receipt === 'string' ? input.latest_receipt : '',
    verify: input.verify === true, rework_count: Number.isInteger(input.rework_count) && input.rework_count >= 0 ? input.rework_count : 0,
    created: typeof input.created === 'string' ? input.created : new Date().toISOString(),
    updated: typeof input.updated === 'string' ? input.updated : new Date().toISOString(),
    archived: input.archived === true,
    consecutive_failures: Number.isInteger(input.consecutive_failures) && input.consecutive_failures >= 0 ? input.consecutive_failures : 0,
    important: input.important === true,
  };
  const device = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
  if (device(input.deviceId)) card.deviceId = input.deviceId;
  if (device(input.updatedByDevice)) card.updatedByDevice = input.updatedByDevice;
  if (Number.isInteger(input.revision) && input.revision >= 0) card.revision = input.revision;
  if (Array.isArray(input.conflicts)) card.conflicts = JSON.parse(JSON.stringify(input.conflicts));
  for (const key of ['attempt_id', 'dispatch_session_id']) if (typeof input[key] === 'string' && input[key]) card[key] = idValue(input[key]);
  if (typeof input.attempt_closed === 'boolean') card.attempt_closed = input.attempt_closed;
  if (typeof input.review_session === 'boolean') card.review_session = input.review_session;
  if (typeof input.review_verdict === 'boolean') card.review_verdict = input.review_verdict;
  if (typeof input.last_event === 'string' && input.last_event.length <= 500) card.last_event = input.last_event;
  if (typeof input.last_failure_attempt === 'string' && input.last_failure_attempt.length <= 200) card.last_failure_attempt = input.last_failure_attempt;
  if (input.worktree !== undefined) card.worktree = Worktree.normalizeRecord(input.worktree);
  if (typeof input.start_previous_status === 'string' && STATUSES.includes(input.start_previous_status)) card.start_previous_status = input.start_previous_status;
  if (input.dispatch_claim && typeof input.dispatch_claim === 'object' && typeof input.dispatch_claim.key === 'string') {
    card.dispatch_claim = { key: idValue(input.dispatch_claim.key), owner: text(String(input.dispatch_claim.owner || ''), 'owner').slice(0, 200), delivered: input.dispatch_claim.delivered === true, created: typeof input.dispatch_claim.created === 'string' ? input.dispatch_claim.created : card.updated };
  }
  for (const key of ['session_host', 'session_bound_at', 'dispatch_host', 'dispatch_bound_at', 'dispatch_wait', 'resource_failure', 'user_question', 'needs_user_entry', 'review_round', 'exec_receipt', 'review_claim', 'review_block', 'review_reject']) {
    if (input[key] !== undefined) card[key] = JSON.parse(JSON.stringify(input[key]));
  }
  return card;
}

class TaskStore {
  constructor(dir = path.join(os.homedir(), '.agents', 'boards', 'tasks'), { sessions = () => [], deviceId = null } = {}) {
    this.dir = path.resolve(dir);
    this.sessions = sessions;
    this.deviceId = deviceId;
    // A local cross-process lock lives outside the synced repository.
    this.lock = path.join(os.tmpdir(), 'agentdeck-tasks-' + crypto.createHash('sha256').update(this.dir).digest('hex') + '.lock');
  }
  read() {
    if (!fs.existsSync(this.dir)) return new Map();
    const docs = new Map();
    for (const name of fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).sort()) {
      const project = projectName(name.slice(0, -5));
      const file = path.join(this.dir, name);
      if (!fs.lstatSync(file).isFile()) throw new Error(`Refusing non-file task board: ${name}`);
      const raw = fs.readFileSync(file, 'utf8');
      let doc;
      try { doc = JSON.parse(raw); } catch (_) { throw new Error(`Task board has invalid JSON or a sync conflict: ${name}. Resolve it before writing.`); }
      if (doc.version !== 1 || doc.project !== project || !Array.isArray(doc.cards)) throw new Error(`Invalid task board schema: ${name}`);
      docs.set(project, { raw, doc });
    }
    const ids = new Set();
    for (const { doc } of docs.values()) for (const card of doc.cards) {
      idValue(card.id);
      if (ids.has(card.id) || card.project !== doc.project || !STATUSES.includes(card.status) || ![null, 'failed', 'blocked', 'held', 'quota'].includes(card.flag) || !Array.isArray(card.depends_on)) throw new Error('Invalid or duplicate card in synced task boards.');
      if (typeof card.title !== 'string' || !card.title.trim() || typeof card.detail !== 'string' || typeof card.verify !== 'boolean' || typeof card.archived !== 'boolean' || !Number.isFinite(card.order) || card.order < 0 || !Number.isInteger(card.rework_count) || card.rework_count < 0 || typeof card.updated !== 'string') throw new Error('Invalid card fields in synced task boards.');
      ids.add(card.id);
    }
    return docs;
  }
  list(filter = {}) {
    if (filter.project !== undefined) projectName(filter.project);
    if (filter.status !== undefined && !STATUSES.includes(filter.status)) throw new Error('Invalid status.');
    if (filter.priority !== undefined) priorityLevel(filter.priority);
    const docs = this.read();
    this.dependencies(docs, false); // Also unlock dependencies changed by the other machine.
    const cards = [...docs.values()].flatMap(({ doc }) => doc.cards);
    return cards.filter((c) => (filter.archived === true || !c.archived) && (!filter.project || sameProject(c.project, filter.project)) && (!filter.status || c.status === filter.status) && (!filter.priority || priorityOf(c) === filter.priority))
      .sort((a, b) => a.project.localeCompare(b.project) || a.order - b.order || a.id.localeCompare(b.id));
  }
  write(project, doc, raw) {
    const file = path.join(this.dir, project + '.json');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current !== raw) throw new Error('TASK_SYNC_RETRY');
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(doc, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) !== raw) throw new Error('TASK_SYNC_RETRY');
      fs.renameSync(tmp, file);
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  mutate(run) {
    fs.mkdirSync(this.dir, { recursive: true });
    try { fs.mkdirSync(this.lock); } catch (err) { if (err.code === 'EEXIST') throw new Error('Task board is being written by another local process. Retry shortly; stale locks can be removed only after that process exits.'); throw err; }
    try {
      // Inside the try: a failed owner record must not leave the lock behind for good.
      fs.writeFileSync(path.join(this.lock, 'owner.json'), JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));
      for (let retry = 0; retry < 3; retry++) {
        const docs = this.read();
        const result = run(docs);
        this.dependencies(docs);
        try {
          for (const [project, { raw }] of docs) {
            const file = path.join(this.dir, project + '.json');
            if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) !== raw) throw new Error('TASK_SYNC_RETRY');
          }
          for (const [project, { doc, raw }] of docs) {
            const drop = doc._drop === true;
            delete doc._drop;
            if (drop) {
              const file = path.join(this.dir, project + '.json');
              if (fs.existsSync(file)) fs.unlinkSync(file);
              continue;
            }
            if (JSON.stringify(doc) !== (raw === null ? '' : JSON.stringify(JSON.parse(raw)))) this.write(project, doc, raw);
          }
          return result;
        } catch (err) { if (err.message !== 'TASK_SYNC_RETRY' || retry === 2) throw err; }
      }
    } finally { fs.rmSync(this.lock, { recursive: true, force: true }); }
  }
  dependencies(docs, updateTime = true) {
    const cards = [...docs.values()].flatMap(({ doc }) => doc.cards);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const visiting = new Set(), visited = new Set();
    const visit = (card) => {
      if (visiting.has(card.id)) throw new Error('Task dependency cycle.');
      if (visited.has(card.id)) return;
      visiting.add(card.id);
      for (const id of card.depends_on) { idValue(id); if (!byId.has(id)) throw new Error(`Unknown dependency: ${id}`); visit(byId.get(id)); }
      visiting.delete(card.id); visited.add(card.id);
    };
    for (const card of cards) {
      visit(card);
      if (card.status === 'todo' && [null, 'blocked'].includes(card.flag)) {
        const flag = card.depends_on.some((id) => byId.get(id).status !== 'done') ? 'blocked' : null;
        if (flag !== card.flag) { card.flag = flag; if (updateTime) touch(card); }
      }
    }
  }
  find(docs, id) {
    idValue(id);
    const card = [...docs.values()].flatMap(({ doc }) => doc.cards).find((c) => c.id === id);
    if (!card) throw new Error(`Unknown task: ${id}`);
    return card;
  }
  reconcile() {
    const docs = this.read();
    const cards = [...docs.values()].flatMap(({ doc }) => doc.cards);
    const flags = cards.map((c) => c.flag);
    this.dependencies(docs, false);
    if (cards.some((c, i) => c.flag !== flags[i])) this.mutate(() => ({}));
  }
  ready(docs, card) {
    if (card.archived || card.flag === 'held' || card.status === 'done') throw new Error('Card is archived, held or done; move it explicitly before starting.');
    if (card.depends_on.some((id) => this.find(docs, id).status !== 'done')) throw new Error('Predecessor cards are not all done.');
  }
  add(input) {
    const card = newCard(input);
    if (this.deviceId) { card.deviceId = this.deviceId; card.updatedByDevice = this.deviceId; }
    return this.mutate((docs) => {
      if ([...docs.values()].some(({ doc }) => doc.cards.some((c) => c.id === card.id))) throw new Error('Duplicate task id.');
      if ([...docs.keys()].some((p) => p !== card.project && p.normalize('NFC').toLowerCase() === card.project.normalize('NFC').toLowerCase())) throw new Error('Project filename conflicts on Windows/macOS.');
      if (!docs.has(card.project)) docs.set(card.project, { raw: null, doc: { version: 1, project: card.project, cards: [] } });
      const cards = docs.get(card.project).doc.cards;
      card.order = cards.reduce((max, c) => Math.max(max, c.order), -1) + 1;
      cards.push(card); return { card, notices: [] };
    });
  }
  // Internal Todo backend only; not an additional renderer operation.
  todoStatus({ id, status, message }) {
    return this.mutate((docs) => {
      const card = this.find(docs, id);
      if (card.project !== 'todo' || !card.id.startsWith('todo-')) throw new Error('Not a Todo task.');
      const previous = card.status;
      card.status = { working: 'doing', needs_user: 'needs_user', done: 'done', failed: 'needs_user' }[status];
      if (!card.status) throw new Error('Invalid Todo status.');
      card.flag = status === 'failed' ? 'failed' : null;
      card.latest_receipt = text(message, 'message');
      finishStatus(card, previous);
      if (status === 'needs_user' || status === 'failed') card.user_question = message;
      if (status === 'working') card.dispatch_claim = { key: crypto.randomUUID(), owner: os.hostname(), delivered: true, created: card.updated };
      return { card, notices: [] };
    });
  }
  sessionOpen(id, attemptClosed = false, sessions = this.sessions(), host, reservedAt = 0) {
    if (!id) return false;
    const session = sessions.find((s) => s.id === id);
    // Give a fresh bind time to spawn and persist its local column. A started
    // attempt, or a local deletion record, has no such reservation.
    return session ? !session.archived : !attemptClosed && (!host || host !== os.hostname() || Date.now() - reservedAt < 15_000);
  }
  occupied(card, sessions = this.sessions()) {
    return this.sessionOpen(card.session_id, card.attempt_closed, sessions, card.session_host, card.last_event ? 0 : card.session_bound_at) || this.sessionOpen(card.dispatch_session_id, false, sessions, card.dispatch_host, card.dispatch_bound_at) ||
      sessions.some((s) => !s.archived && (s.boardId === card.id || s.dispatcherCardId === card.id));
  }
  activeAttempt(card) {
    const sessions = this.sessions();
    const session = sessions.find((s) => s.id === card.session_id);
    return (card.session_id && this.sessionOpen(card.session_id, card.attempt_closed, sessions, card.session_host, card.last_event ? 0 : card.session_bound_at) && !card.attempt_closed &&
      !session?.failed && !(session?.lastReceipt?.failed && !session.active) &&
      !['failed', 'quota', 'held'].includes(card.flag) && !/:failed:/.test(card.last_event || '')) ||
      sessions.some((s) => !s.archived && s.active && s.boardId === card.id && s.id !== card.session_id && AutoVerify.reviewAttemptRound(card.id, s.boardAttempt) >= (card.review_round || 0));
  }
  failure(card, attempt, reason, rework, source = '') {
    const duplicate = card.last_failure_attempt === attempt;
    card.resource_failure = resourceFailure(reason, source) || null;
    if (card.resource_failure) {
      card.status = 'doing'; card.flag = 'quota'; card.latest_receipt = sentence(reason);
      return;
    }
    card.last_failure_attempt = attempt;
    if (!duplicate) {
      card.consecutive_failures = (card.consecutive_failures || 0) + 1;
      if (rework) card.rework_count++;
    }
    card.status = 'doing';
    card.flag = card.consecutive_failures >= 2 ? 'held' : 'failed';
    card.latest_receipt = sentence(reason);
  }
  move(input) {
    if (!STATUSES.includes(input.status)) throw new Error('Invalid status.');
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (input.updated !== undefined && input.updated !== card.updated) throw new Error('Card changed since it was read. Reload before editing.');
      const wasReview = card.status === 'review';
      const wasHeld = card.flag === 'held';
      if (input.status === 'doing') {
        if (card.depends_on.some((id) => this.find(docs, id).status !== 'done')) throw new Error('Predecessor cards are not all done.');
        if (wasReview) this.failure(card, card.review_round && card.exec_receipt ? AutoVerify.reviewAttemptId(card.id, card.review_round) : 'reject-' + (card.attempt_id || card.updated), '验收不通过，已打回返工', true);
        else { card.flag = null; if (wasHeld) card.consecutive_failures = 0; }
      } else card.flag = null;
      card.status = input.status;
      if (wasHeld && input.status === 'todo') card.consecutive_failures = 0;
      if (input.status === 'done') card.consecutive_failures = 0;
      // Keep unarchived sessions as an occupancy fence, including a finished
      // worker which the Captain may tell to rework. A reviewer rejection ends
      // its old attempt, so late receipts cannot undo the rejection.
      const sessions = this.sessions();
      if (input.status !== 'doing' || !this.sessionOpen(card.session_id, card.attempt_closed, sessions, card.session_host, card.last_event ? 0 : card.session_bound_at)) { card.session_id = null; card.attempt_id = null; card.session_host = null; card.session_bound_at = null; }
      if (input.status !== 'doing' || !this.sessionOpen(card.dispatch_session_id, false, sessions, card.dispatch_host, card.dispatch_bound_at)) { card.dispatch_session_id = null; card.dispatch_host = null; card.dispatch_bound_at = null; }
      if (wasReview && input.status === 'doing') { card.attempt_id = null; card.attempt_closed = true; }
      card.archived = false; card.resource_failure = null; card.dispatch_wait = null;
      if (input.status !== 'doing') card.dispatch_claim = null;
      // A move is a Captain/user decision: it replaces any pending automatic rework or block.
      if (card.review_block) card.review_block = null;
      if (card.review_reject) card.review_reject.delivered = true;
      // CLI moves are Captain decisions, not requests for an automatic model.
      if (input.suppressDispatch && input.status === 'doing') card.dispatch_claim = { key: crypto.randomUUID(), owner: os.hostname(), delivered: true, created: new Date().toISOString() };
      finishStatus(card);
      return { card, notices: card.flag === 'held' ? [`卡片 ${card.id} 连续失败 2 次，已挂起；请队长拍板。`] : [] };
    });
  }
  noteWorktree(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      card.worktree = Worktree.normalizeRecord(input.worktree);
      touch(card);
      return { card, notices: [] };
    });
  }
  archive(input) {
    if (input.done !== true) throw new Error('archive requires --done.');
    if (input.project !== undefined) projectName(input.project);
    return this.mutate((docs) => {
      const cards = [...docs.values()].flatMap(({ doc }) => doc.cards).filter((c) => c.status === 'done' && !c.archived && (!input.project || sameProject(c.project, input.project)));
      cards.forEach((c) => { c.archived = true; touch(c); });
      return { cards, notices: [] };
    });
  }
  update(input) {
    const allowed = ['title', 'detail', 'order', 'depends_on', 'verify', 'important'];
    if (!input.patch || typeof input.patch !== 'object' || Object.keys(input.patch).some((k) => !allowed.includes(k))) throw new Error('Invalid card edit fields.');
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (input.updated !== card.updated) throw new Error('Card changed since it was read. Reload before editing.');
      for (const [key, value] of Object.entries(input.patch)) {
        if (key === 'title' || key === 'detail') text(value, key, key === 'title');
        if (key === 'order' && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid order.');
        if (['verify', 'important'].includes(key) && typeof value !== 'boolean') throw new Error('Invalid boolean field.');
        if (key === 'depends_on') { if (!Array.isArray(value)) throw new Error('Invalid dependencies.'); value.forEach(idValue); }
        card[key] = value;
      }
      touch(card); return { card, notices: [] };
    });
  }
  // Mark a card 高优先级 or ordinary again. No `updated` check: it only flips
  // the one flag, so it cannot overwrite somebody else's edit.
  priority(input) {
    const important = priorityLevel(input.level) === 'high';
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if ((card.important === true) !== important) { card.important = important; touch(card); }
      return { card, notices: [] };
    });
  }
  // Drag-to-reorder: put a card right before/after another card of the same
  // project (no anchor = end of the project). Only `order` changes; a midpoint
  // keeps every other card untouched, and the project is renumbered only when
  // no number fits between the two neighbours.
  reorder(input) {
    if (input.before != null && input.after != null) throw new Error('Use either before or after.');
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      const anchorId = input.before != null ? input.before : input.after;
      const anchor = anchorId != null ? this.find(docs, anchorId) : null;
      if (anchor && (anchor === card || anchor.project !== card.project)) throw new Error('Cards can only be reordered inside their own project.');
      const byOrder = (a, b) => a.order - b.order || a.id.localeCompare(b.id);
      const all = docs.get(card.project).doc.cards.slice().sort(byOrder);
      const rest = all.filter((c) => c !== card);
      const index = anchor ? rest.indexOf(anchor) + (input.before != null ? 0 : 1) : rest.length;
      if (all.indexOf(card) === index) return { card, notices: [] };
      const prev = rest[index - 1], next = rest[index];
      const order = !next ? prev.order + 1 : !prev ? next.order / 2 : (prev.order + next.order) / 2;
      rest.splice(index, 0, card);
      if ((!prev || order > prev.order) && (!next || order < next.order)) { card.order = order; touch(card); }
      else rest.forEach((c, i) => { if (c.order !== i) { c.order = i; touch(c); } });
      return { card, notices: [] };
    });
  }
  bind(input) {
    idValue(input.session_id); idValue(input.attempt_id);
    return this.mutate((docs) => {
      const card = this.find(docs, input.id); this.ready(docs, card);
      if (input.project && !sameProject(input.project, card.project)) throw new Error('--project differs from the card project.');
      if (card.attempt_id === input.attempt_id) {
        if (input.worktree) { card.worktree = Worktree.normalizeRecord(input.worktree); touch(card); }
        return { card, notices: [] };
      }
      if (this.activeAttempt(card)) throw new Error('Card already has an active execution or verification session.');
      if (input.assignee === null || typeof input.assignee !== 'object' || typeof input.assignee.agent !== 'string' || typeof input.assignee.model !== 'string') throw new Error('assignee requires agent and model.');
      const explicitReview = Array.isArray(input.reviews) && input.reviews.length > 0;
      if (explicitReview && input.review_round !== (card.review_round || 0)) throw new Error('这张卡片已经不在这一轮待验收了，审查会话没有开。');
      if (explicitReview && card.exec_receipt && !input.reviews.includes(card.exec_receipt.session_id)) throw new Error('--reviews must include the original execution session.');
      // The executor told to do more while its receipt waits for (or is with) a reviewer:
      // that round is void, and the executor is working on the card again, not reviewing it.
      const execResume = !explicitReview && card.status === 'review' && card.verify === true && card.exec_receipt?.session_id === input.session_id;
      const review = !execResume && (explicitReview || card.status === 'review');
      if (execResume) card.status = 'doing';
      if (explicitReview) {
        if (!card.exec_receipt) {
          if (!input.exec_receipt || !input.reviews.includes(input.exec_receipt.session_id)) throw new Error('Review requires the original execution receipt.');
          card.exec_receipt = input.exec_receipt;
        }
        card.review_round = card.review_round || 1;
        card.status = 'review';
      }
      if (/:fallback:/.test(card.last_event || '')) card.latest_receipt = '';
      if (card.dispatch_wait && card.latest_receipt === card.dispatch_wait) card.latest_receipt = '';
      if (input.worktree) card.worktree = Worktree.normalizeRecord(input.worktree);
      Object.assign(card, { session_id: input.session_id, session_host: os.hostname(), session_bound_at: Date.now(), attempt_id: input.attempt_id, assignee: input.assignee,
        review_session: review, review_verdict: explicitReview, attempt_closed: false, last_event: null, dispatch_session_id: null, dispatch_host: null, dispatch_bound_at: null, dispatch_wait: null, resource_failure: null });
      card.flag = null;
      if (card.dispatch_claim) card.dispatch_claim.delivered = true;
      if ((review || execResume) && card.review_claim) card.review_claim.delivered = true;
      // Someone (the Captain, or the automatic rework itself) took the card on.
      if (card.review_block) card.review_block = null;
      if (card.review_reject) card.review_reject.delivered = true;
      touch(card);
      return { card, notices: [] };
    });
  }
  event(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (this.supersedesReview(card, input)) {
        // The executor was told more and handed in a new receipt while a reviewer holds
        // the card: the review of the old receipt is void. The executor takes the card
        // back (the old reviewer's later words are then ignored) and the receipt below
        // starts the next round, which is due its own reviewer.
        Object.assign(card, { session_id: input.session_id, attempt_id: input.attempt_id, session_host: os.hostname(), session_bound_at: Date.now(), assignee: card.exec_receipt.assignee || card.assignee,
          review_session: false, review_verdict: false, attempt_closed: false, last_event: null, flag: null, resource_failure: null });
      }
      if (card.session_id !== input.session_id || card.attempt_id !== input.attempt_id) return { card, ignored: true, notices: [] };
      if (!['started', 'ask', 'complete', 'failed', 'fallback'].includes(input.type)) throw new Error('Invalid task event.');
      // A resource stop is already final for runtime failures from this attempt.
      // A later written command verdict may still report a real defect.
      if (card.attempt_closed && card.resource_failure && input.type === 'failed' && input.source !== 'command') return { card, ignored: true, notices: [] };
      const eventKey = input.attempt_id + ':' + input.type + ':' + (input.source || '') + ':' + crypto.createHash('sha256').update(input.message || '').digest('hex');
      // The agent waited out its quota and carried on by itself: that stop was not final.
      const resumed = input.type === 'started' && input.source?.startsWith('resume-quota-') && card.attempt_closed && !!card.resource_failure;
      if (card.last_event === eventKey || card.attempt_closed && !resumed && !['complete', 'failed'].includes(input.type)) return { card, ignored: true, notices: [] };
      const authoritative = input.type === 'complete' && input.source === 'command' && /:failed:(?:quota|process|automatic):/.test(card.last_event || '');
      if (card.flag === 'held' && !authoritative) return { card, ignored: true, notices: [] };
      const notices = [];
      // Automatic and explicitly declared reviewers use the same verdict flow: a plain failure,
      // or a "不通过" complete, is a rejection; a complete with no clear verdict is
      // never taken as a pass.
      const autoReview = card.review_session === true && (card.review_verdict === true || AutoVerify.isReviewAttempt(input.attempt_id));
      const verdict = autoReview && input.type === 'complete' ? AutoVerify.verdict(input.message) : null;
      // A reviewer the Captain opened by hand is not held to that wording, but its
      // session ending is not a pass either: a receipt that opens with "不通过" sends
      // the card back instead of marking it done.
      const rejected = verdict === 'fail' || (card.review_session === true && input.type === 'complete' && AutoVerify.verdict(input.message) === 'fail');
      const type = rejected ? 'failed' : input.type;
      if (type === 'started') {
        if (/:fallback:/.test(card.last_event || '') ||
          (input.source?.startsWith('resume-fallback-') && /:started:/.test(card.last_event || '') && card.latest_receipt === '已结束，未提交回执')) card.latest_receipt = '';
        card.status = card.review_session ? 'review' : 'doing'; card.flag = null;
        if (resumed) { card.attempt_closed = false; card.resource_failure = null; card.latest_receipt = ''; }
      }
      if (type === 'ask') {
        const question = text(input.message, 'question', true);
        card.status = 'needs_user'; card.latest_receipt = sentence(question); card.user_question = brief(question);
      }
      if (type === 'fallback') { card.status = 'needs_user'; card.latest_receipt = '已结束，未提交回执'; delete card.user_question; }
      if (type === 'complete') {
        card.latest_receipt = sentence(text(input.message, 'result', true));
        card.status = card.review_session || !card.verify ? 'done' : 'review';
        card.flag = null; card.resource_failure = null; card.attempt_closed = true;
        // Passing execution is not a passed verification; retain review failures.
        if (card.status === 'review' && card.verify) {
          // A new round of verification: a fresh number, so each round gets exactly one
          // reviewer. The full receipt and who ran it are kept because the reviewer
          // session replaces session_id/assignee on the card.
          card.review_round = (card.review_round || 0) + 1;
          card.review_block = null;
          card.exec_receipt = { text: input.message, files: Array.isArray(input.files) ? input.files.filter((f) => typeof f === 'string') : [],
            session_id: input.session_id, attempt_id: input.attempt_id, assignee: card.assignee || null };
        }
        if (verdict === 'unclear') {
          card.status = 'review';
          card.review_block = { round: card.review_round || 0, reason: '审查会话的回执没有以「通过」或「不通过」开头，结论不明确', at: new Date().toISOString() };
          notices.push(`卡片 ${card.id} 的审查结论不明确，已留在待验收，请队长查看审查会话的回执后处理。`);
        }
        // An unclear verdict is put back into review above; it is not a pass, so it
        // must not wipe the failures that still count toward holding the card.
        if (card.status === 'done') card.consecutive_failures = 0;
      }
      if (type === 'failed') {
        const reason = text(input.message, 'failure', true);
        const failureAttempt = autoReview ? AutoVerify.reviewAttemptId(card.id, card.review_round) : input.attempt_id;
        this.failure(card, failureAttempt, reason, card.review_session === true, input.source);
        // Only a reviewer's own written verdict goes back to the executor, once. A crash or
        // quota failure of the reviewer is not a finding.
        if (autoReview && input.source === 'command' && card.review_reject?.attempt_id !== input.attempt_id && !card.resource_failure) {
          card.review_reject = { round: card.review_round || 0, attempt_id: input.attempt_id, findings: reason, key: crypto.randomUUID(), owner: os.hostname(), delivered: card.flag !== 'failed', created: new Date().toISOString() };
        }
        card.attempt_closed = true;
        notices.push(`卡片 ${card.id} 失败：${reason}${card.flag === 'held' ? '；连续失败 2 次，已挂起，不再自动重试。' : ''}`);
      }
      card.last_event = eventKey; finishStatus(card);
      return { card, notices };
    });
  }
  dispatch(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      // A move or a Captain bind may consume the claim while a start is awaiting IPC.
      if (input.key !== undefined && (card.status !== 'doing' || card.dispatch_claim?.key !== input.key || card.dispatch_claim.delivered)) return { card, ignored: true, notices: [] };
      this.ready(docs, card);
      if (this.occupied(card)) return { card, ignored: true, notices: [] };
      if (input.session_id) {
        if (card.dispatch_wait && card.latest_receipt === card.dispatch_wait) card.latest_receipt = '';
        card.dispatch_session_id = idValue(input.session_id); card.dispatch_host = os.hostname(); card.dispatch_bound_at = Date.now(); card.dispatch_wait = null;
      }
      if (input.session_id) touch(card);
      return { card, captain: card.important === true || card.start_previous_status === 'needs_user' || card.flag === 'failed' || !card.detail.trim(), notices: [] };
    });
  }
  claim(input, sessions = this.sessions()) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id); this.ready(docs, card);
      if (card.status === 'review') throw new Error('Card needs verification. Use new --task-id for a reviewer, or task move to doing to reject it.');
      if (this.occupied(card, sessions)) return { card, ignored: true, occupied: true, notices: [] };
      if (card.dispatch_claim && !input.newEntry) return { card, ignored: true, notices: [] };
      if (input.updated && input.updated !== card.updated) return { card, ignored: true, notices: [] };
      card.dispatch_claim = { key: crypto.randomUUID(), owner: os.hostname(), delivered: false, created: new Date().toISOString() };
      card.start_previous_status = card.status;
      card.status = 'doing'; touch(card);
      return { card, notices: [] };
    });
  }
  dispatched(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (card.dispatch_claim?.key === input.key) card.dispatch_claim.delivered = true;
      return { card, notices: [] };
    });
  }
  dispatchWait(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (card.dispatch_claim?.key !== input.key || card.dispatch_claim.delivered || this.occupied(card)) return { card, ignored: true, notices: [] };
      const message = text(input.message, 'dispatch wait', true);
      if (card.dispatch_wait !== message) { card.dispatch_wait = message; card.latest_receipt = message; touch(card); }
      return { card, notices: [] };
    });
  }
  dispatcherReceipt(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (card.dispatch_session_id !== input.session_id) return { card, ignored: true, notices: [] };
      const notices = [];
      if (input.failed) {
        this.failure(card, input.session_id, text(input.failed, 'dispatcher failure', true), false, input.source);
        notices.push(`卡片 ${card.id} 调度失败：${input.failed}${card.flag === 'held' ? '；连续失败 2 次，已挂起。' : ''}`);
      } else {
        const question = typeof input.question === 'string' ? input.question : '';
        card.status = 'needs_user';
        card.latest_receipt = sentence(question || '调度已结束，尚未派出执行会话');
        if (question.trim()) card.user_question = brief(question);
        else delete card.user_question;
        if (!question.trim()) notices.push(`卡片 ${card.id} 调度已结束，尚未派出执行会话，请队长安排。`);
      }
      card.dispatch_session_id = null; card.dispatch_host = null; card.dispatch_bound_at = null; finishStatus(card); return { card, notices };
    });
  }
  // A restart continues the same card. It does not close the attempt, archive
  // the card, or bind a second session while one is still open.
  resumeNote(input) {
    if (!input || typeof input.note !== 'string' || !input.note.trim()) throw new Error('resume note required.');
    idValue(input.session_id);
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (card.archived) return { card, ignored: true, notices: [] };
      if (card.attempt_closed || card.status === 'done' || (card.status === 'review' && !card.review_session)) return { card, ignored: true, notices: [] };
      const sessions = this.sessions();
      const open = card.session_id && card.session_id !== input.session_id && !card.attempt_closed &&
        this.sessionOpen(card.session_id, card.attempt_closed, sessions, card.session_host, card.last_event ? 0 : card.session_bound_at);
      if (open) return { card, ignored: true, notices: [] };
      if (card.session_id !== input.session_id) {
        card.session_id = input.session_id;
        card.session_host = os.hostname();
        card.session_bound_at = Date.now();
        if (input.attempt_id) card.attempt_id = idValue(input.attempt_id);
      }
      if (card.status !== 'review') card.status = 'doing';
      card.attempt_closed = false;
      card.flag = null;
      card.latest_receipt = sentence(input.note);
      touch(card);
      return { card, notices: [] };
    });
  }
  // ---- automatic verification ----
  // A written receipt from the original executor that differs from the one under
  // review, while a reviewer (automatic or manual) holds the card in review.
  supersedesReview(card, input) {
    const exec = card.exec_receipt;
    return input.type === 'complete' && input.source === 'command' && card.verify === true && card.status === 'review' && card.review_session === true && !card.archived && !card.flag &&
      !!exec && exec.session_id === input.session_id && card.session_id !== input.session_id && !(exec.attempt_id === input.attempt_id && exec.text === input.message);
  }
  // A card is due a reviewer once per round: verify card, in review through the
  // execution's own complete (it has a round number and receipt), nobody has
  // taken the review, and this round has no claim or block yet.
  reviewDue(card) {
    return card.verify === true && card.status === 'review' && !card.archived && !card.flag && card.review_round > 0 && !!card.exec_receipt &&
      card.review_session !== true && card.review_claim?.round !== card.review_round && card.review_block?.round !== card.review_round;
  }
  // Claimed on this machine and not yet handed to the renderer.
  reviewPending(card) {
    const claim = card.review_claim;
    return card.verify === true && card.status === 'review' && !card.archived && !card.flag && card.review_session !== true && card.review_block?.round !== card.review_round &&
      !!claim && claim.round === card.review_round && !claim.delivered && claim.owner === os.hostname();
  }
  reworkPending(card) {
    const reject = card.review_reject;
    return card.status === 'doing' && card.flag === 'failed' && !card.archived && !!reject && !reject.delivered && reject.round === card.review_round && reject.owner === os.hostname();
  }
  claimReview(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (!this.reviewDue(card) || this.activeAttempt(card)) return { card, ignored: true, notices: [] };
      card.review_claim = { round: card.review_round, key: crypto.randomUUID(), owner: os.hostname(), delivered: false, created: new Date().toISOString() };
      touch(card);
      return { card, notices: [] };
    });
  }
  reviewDispatched(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (card.review_claim?.key === input.key && !card.review_claim.delivered) { card.review_claim.delivered = true; touch(card); }
      return { card, notices: [] };
    });
  }
  // No acceptable reviewer: the card stays in review with the reason on it, for the Captain.
  reviewBlocked(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      const claim = card.review_claim;
      if (claim?.key !== input.key || claim.delivered || card.status !== 'review') return { card, ignored: true, notices: [] };
      const reason = text(input.reason, 'reason', true);
      claim.delivered = true;
      card.review_block = { round: claim.round, reason, at: new Date().toISOString() };
      touch(card);
      return { card, notices: [`卡片 ${card.id}「${card.title}」待验收，但不能自动开审查会话：${reason}。请队长处理。`] };
    });
  }
  reworkDispatched(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (card.review_reject?.key === input.key && !card.review_reject.delivered) { card.review_reject.delivered = true; touch(card); }
      return { card, notices: [] };
    });
  }
  identity(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (card.session_id !== input.session_id || card.attempt_id !== input.attempt_id) return { card, ignored: true, notices: [] };
      const assignee = { agent: text(input.agent, 'agent', true), model: text(input.model, 'model', true) };
      if (JSON.stringify(assignee) !== JSON.stringify(card.assignee)) { card.assignee = assignee; touch(card); }
      return { card, notices: [] };
    });
  }
  // One card from the fleet server. Other projects stay put.
  upsertSynced(card) {
    const next = syncedCard(card);
    return this.mutate((docs) => {
      for (const [project, { doc }] of [...docs.entries()]) {
        const index = doc.cards.findIndex((item) => item.id === next.id);
        if (index < 0) continue;
        if (project === next.project) doc.cards[index] = next;
        else doc.cards.splice(index, 1);
      }
      if (![...docs.values()].some(({ doc }) => doc.cards.some((item) => item.id === next.id))) {
        if (!docs.has(next.project)) docs.set(next.project, { raw: null, doc: { version: 1, project: next.project, cards: [] } });
        docs.get(next.project).doc.cards.push(next);
      }
      for (const [, { doc }] of docs) if (!doc.cards.length) doc._drop = true;
      return { card: next };
    });
  }
  // Full server snapshot. keepIds are local edits still waiting to upload;
  // dropping them here would lose the offline copy.
  replaceSynced(cards, keepIds = []) {
    const keep = new Set(keepIds);
    const incoming = [];
    const seen = new Set();
    for (const raw of cards) {
      const card = syncedCard(raw);
      if (seen.has(card.id) || keep.has(card.id)) continue;
      seen.add(card.id);
      incoming.push(card);
    }
    return this.mutate((docs) => {
      const kept = [];
      for (const { doc } of docs.values()) for (const card of doc.cards) if (keep.has(card.id)) kept.push(card);
      for (const entry of docs.values()) { entry.doc.cards = []; entry.doc._drop = true; }
      for (const card of [...incoming, ...kept]) {
        if (!docs.has(card.project)) docs.set(card.project, { raw: null, doc: { version: 1, project: card.project, cards: [] } });
        const entry = docs.get(card.project);
        entry.doc._drop = false;
        entry.doc.cards.push(card);
      }
      return { count: incoming.length + kept.length };
    });
  }
  import(project, cards) {
    projectName(project);
    return this.mutate((docs) => {
      // Initial migration never rewrites an existing shared project board.
      if (docs.has(project)) return { imported: 0, skipped: true };
      docs.set(project, { raw: null, doc: { version: 1, project, cards } });
      return { imported: cards.length };
    });
  }
}
module.exports = { TaskStore, STATUSES, PRIORITIES, priorityOf, projectName, sameProject, newCard, sentence, localSessions, syncedCard };
