'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STATUSES = ['todo', 'doing', 'review', 'needs_user', 'done'];
function projectName(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(?:\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new Error('Invalid project name (must be a portable filename).');
  return value;
}
function idValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid task/session id.');
  return value;
}
function text(value, name, required = false) {
  if (typeof value !== 'string' || value.length > 2_000_000 || (required && !value.trim())) throw new Error(`Invalid ${name}.`);
  return value;
}
function sentence(value) { return String(value || '').trim().split(/(?<=[。！？.!?])(?:\s|$)|\r?\n/u)[0]; }
function touch(card) { card.updated = new Date(Math.max(Date.now(), (Date.parse(card.updated) || 0) + 1)).toISOString(); }
function newCard(input, now = new Date().toISOString()) {
  const project = projectName(input.project);
  if (input.verify !== undefined && typeof input.verify !== 'boolean') throw new Error('verify must be boolean.');
  if (input.important !== undefined && typeof input.important !== 'boolean') throw new Error('important must be boolean.');
  const depends = input.depends_on || [];
  if (!Array.isArray(depends)) throw new Error('depends_on must be an array.');
  return { id: input.id ? idValue(input.id) : 't-' + crypto.randomUUID(), project,
    title: text(input.title, 'title', true), detail: text(input.detail || '', 'detail'), status: 'todo', flag: null,
    order: 0, depends_on: [...new Set(depends.map(idValue))], assignee: null, session_id: null,
    latest_receipt: '', verify: !!input.verify, rework_count: 0, created: now, updated: now, archived: false,
    consecutive_failures: 0, important: input.important === true };
}

class TaskStore {
  constructor(dir = path.join(os.homedir(), '.agents', 'boards', 'tasks')) {
    this.dir = path.resolve(dir);
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
      if (ids.has(card.id) || card.project !== doc.project || !STATUSES.includes(card.status) || ![null, 'failed', 'blocked', 'held'].includes(card.flag) || !Array.isArray(card.depends_on)) throw new Error('Invalid or duplicate card in synced task boards.');
      if (typeof card.title !== 'string' || !card.title.trim() || typeof card.detail !== 'string' || typeof card.verify !== 'boolean' || typeof card.archived !== 'boolean' || !Number.isFinite(card.order) || card.order < 0 || !Number.isInteger(card.rework_count) || card.rework_count < 0 || typeof card.updated !== 'string') throw new Error('Invalid card fields in synced task boards.');
      ids.add(card.id);
    }
    return docs;
  }
  list(filter = {}) {
    if (filter.project !== undefined) projectName(filter.project);
    if (filter.status !== undefined && !STATUSES.includes(filter.status)) throw new Error('Invalid status.');
    const docs = this.read();
    this.dependencies(docs, false); // Also unlock dependencies changed by the other machine.
    const cards = [...docs.values()].flatMap(({ doc }) => doc.cards);
    return cards.filter((c) => (filter.archived === true || !c.archived) && (!filter.project || c.project === filter.project) && (!filter.status || c.status === filter.status))
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
    fs.writeFileSync(path.join(this.lock, 'owner.json'), JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));
    try {
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
    return this.mutate((docs) => {
      if ([...docs.values()].some(({ doc }) => doc.cards.some((c) => c.id === card.id))) throw new Error('Duplicate task id.');
      if ([...docs.keys()].some((p) => p !== card.project && p.normalize('NFC').toLowerCase() === card.project.normalize('NFC').toLowerCase())) throw new Error('Project filename conflicts on Windows/macOS.');
      if (!docs.has(card.project)) docs.set(card.project, { raw: null, doc: { version: 1, project: card.project, cards: [] } });
      const cards = docs.get(card.project).doc.cards;
      card.order = cards.reduce((max, c) => Math.max(max, c.order), -1) + 1;
      cards.push(card); return { card, notices: [] };
    });
  }
  failure(card, attempt, reason, rework) {
    if (card.last_failure_attempt === attempt) return;
    card.last_failure_attempt = attempt;
    card.consecutive_failures = (card.consecutive_failures || 0) + 1;
    if (rework) card.rework_count++;
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
        if (wasReview) this.failure(card, 'reject-' + (card.attempt_id || card.updated), '验收不通过，已打回返工', true);
        else { card.flag = null; if (wasHeld) card.consecutive_failures = 0; }
      } else card.flag = null;
      card.status = input.status;
      if (wasHeld && input.status === 'todo') card.consecutive_failures = 0;
      if (input.status === 'done') card.consecutive_failures = 0;
      card.session_id = null; card.attempt_id = null; card.dispatch_session_id = null; card.archived = false;
      if (input.status !== 'doing') card.dispatch_claim = null;
      touch(card);
      return { card, notices: card.flag === 'held' ? [`卡片 ${card.id} 连续失败 2 次，已挂起；请队长拍板。`] : [] };
    });
  }
  archive(input) {
    if (input.done !== true) throw new Error('archive requires --done.');
    if (input.project !== undefined) projectName(input.project);
    return this.mutate((docs) => {
      const cards = [...docs.values()].flatMap(({ doc }) => doc.cards).filter((c) => c.status === 'done' && !c.archived && (!input.project || c.project === input.project));
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
  bind(input) {
    idValue(input.session_id); idValue(input.attempt_id);
    return this.mutate((docs) => {
      const card = this.find(docs, input.id); this.ready(docs, card);
      if (input.project && input.project !== card.project) throw new Error('--project differs from the card project.');
      if (card.attempt_id === input.attempt_id) return { card, notices: [] };
      if (card.session_id && !card.attempt_closed) throw new Error('Card already has an active execution or verification session.');
      if (input.assignee === null || typeof input.assignee !== 'object' || typeof input.assignee.agent !== 'string' || typeof input.assignee.model !== 'string') throw new Error('assignee requires agent and model.');
      const review = card.status === 'review';
      Object.assign(card, { session_id: input.session_id, attempt_id: input.attempt_id, assignee: input.assignee,
        review_session: review, attempt_closed: false, last_event: null, dispatch_session_id: null });
      touch(card);
      return { card, notices: [] };
    });
  }
  event(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (card.session_id !== input.session_id || card.attempt_id !== input.attempt_id) return { card, ignored: true, notices: [] };
      if (!['started', 'ask', 'complete', 'failed', 'fallback'].includes(input.type)) throw new Error('Invalid task event.');
      const eventKey = input.attempt_id + ':' + input.type + ':' + (input.source || '') + ':' + crypto.createHash('sha256').update(input.message || '').digest('hex');
      if (card.last_event === eventKey || card.attempt_closed && !['complete', 'failed'].includes(input.type)) return { card, ignored: true, notices: [] };
      const authoritative = input.type === 'complete' && input.source === 'command' && /:failed:(?:quota|process|automatic):/.test(card.last_event || '');
      if (card.flag === 'held' && !authoritative) return { card, ignored: true, notices: [] };
      const notices = [];
      if (input.type === 'started') { card.status = card.review_session ? 'review' : 'doing'; card.flag = null; }
      if (input.type === 'ask') { card.status = 'needs_user'; card.latest_receipt = sentence(text(input.message, 'question', true)); }
      if (input.type === 'fallback') { card.status = 'needs_user'; card.latest_receipt = '已结束，未提交回执'; }
      if (input.type === 'complete') {
        card.latest_receipt = sentence(text(input.message, 'result', true));
        card.status = card.review_session || !card.verify ? 'done' : 'review';
        card.flag = null; card.attempt_closed = true;
        // Passing execution is not a passed verification; retain review failures.
        if (card.status === 'done') card.consecutive_failures = 0;
      }
      if (input.type === 'failed') {
        const reason = text(input.message, 'failure', true);
        this.failure(card, input.attempt_id, reason, card.review_session === true);
        card.attempt_closed = true;
        notices.push(`卡片 ${card.id} 失败：${reason}${card.flag === 'held' ? '；连续失败 2 次，已挂起，不再自动重试。' : ''}`);
      }
      card.last_event = eventKey; touch(card);
      return { card, notices };
    });
  }
  dispatch(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id); this.ready(docs, card);
      if (card.session_id && !card.attempt_closed || card.dispatch_session_id) throw new Error('Card is already being executed or dispatched.');
      if (input.session_id) card.dispatch_session_id = idValue(input.session_id);
      if (input.session_id) touch(card);
      return { card, captain: card.important === true || card.start_previous_status === 'needs_user' || card.flag === 'failed' || !card.detail.trim(), notices: [] };
    });
  }
  claim(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id); this.ready(docs, card);
      if (card.status === 'review') throw new Error('Card needs verification. Use new --task-id for a reviewer, or task move to doing to reject it.');
      if (card.session_id && !card.attempt_closed || card.dispatch_session_id) return { card, ignored: true, notices: [] };
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
  dispatcherReceipt(input) {
    return this.mutate((docs) => {
      const card = this.find(docs, input.id);
      if (card.dispatch_session_id !== input.session_id) return { card, ignored: true, notices: [] };
      const notices = [];
      if (input.failed) {
        this.failure(card, input.session_id, text(input.failed, 'dispatcher failure', true), false);
        notices.push(`卡片 ${card.id} 调度失败：${input.failed}${card.flag === 'held' ? '；连续失败 2 次，已挂起。' : ''}`);
      } else {
        card.status = 'needs_user';
        card.latest_receipt = sentence(input.question || '调度已结束，尚未派出执行会话');
        if (!input.question) notices.push(`卡片 ${card.id} 调度已结束，尚未派出执行会话，请队长安排。`);
      }
      card.dispatch_session_id = null; touch(card); return { card, notices };
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
module.exports = { TaskStore, STATUSES, projectName, newCard, sentence };
