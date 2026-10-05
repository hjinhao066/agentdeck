'use strict';
// The Captain's Relay handoff (交接). One snapshot goes in: board cards, the
// Captain's dispatch records, live sessions, unread receipts, the decisions the
// Captain wrote down. One text comes out. Every section is derived from that
// same snapshot, so the summary cannot disagree with the task list.
// Pure: no fs, no Electron, no clock of its own.
const AutoVerify = require('./auto-verify-core');
// How long the handoff may be, in characters (config.captainHandoffBudget).
const { handoffBudget: budget } = require('./main-core');

// Written once for the Captain to fill in; AgentDeck only ever reads it.
const DECISIONS_FILE = 'agentdeck-captain-decisions.md';
const HANDOFF_FILE = 'agentdeck-captain-handoff.md';
const DECISIONS_TEMPLATE = [
  '# 队长有效决定与交付状态',
  '<!-- 这份文件由队长维护，AgentDeck 只读。交接（handoff）原样引用下面各节，并标注本文件的最后修改时间。',
  '一条一行，写结论，不贴原话；原话留指针（read --id 会话id --find "关键词"）。失效的条目直接删掉或改写，不要堆历史。 -->',
  '',
  '## 当前目标',
  '<!-- - 正在完成的目标，一两条 -->',
  '',
  '## 授权范围',
  '<!-- - [时间] 已授权做什么、做到哪一步为止｜来源指针 -->',
  '',
  '## 暂停/取消/暂不启动',
  '<!-- - [时间] 暂停什么｜适用范围（只这一阶段，还是一直）｜来源指针。恢复后删掉这一行 -->',
  '',
  '## 有效决定',
  '<!-- - [时间] 范围｜决定｜取代了哪条｜来源指针 -->',
  '',
  '## 交付状态',
  '<!-- - 仓库或版本｜分支｜提交｜已提交 是/否｜已合并 是/否｜已打包 是/否｜已安装 Mac：…；Windows：…（不确定写待核实） -->',
  '',
  '## 等用户决定',
  '<!-- - 具体问题｜是否阻塞其他工作 -->',
  '',
].join('\n');

const OPEN = ['waiting', 'queued', 'working', 'paused', 'quota', 'input', 'asking'];
const CLOSED = ['done', 'failed', 'stopped'];
// Receipts the app writes for its own bookkeeping. Older records carry no
// source, so the wording is matched as well.
const MERGED = ['已合并到后面的补充指令，一起送达。', '后来又给这个会话发了新指令，结果看后面的卡片。', '队长已取消这条尚未送达的补充指令。'];
const STOPPED = ['队长已请求中断当前操作。', '队长已结束终端并归档。'];
const bookkeeping = (t) => ['merged', 'superseded', 'captain-cancel'].includes(t.receipt?.source) || MERGED.includes(t.receipt?.summary);
const captainStopped = (t) => !!t && t.status === 'stopped' && (['captain-stop', 'captain-archive'].includes(t.receipt?.source) || STOPPED.includes(t.receipt?.summary));
const isReviewer = (t) => AutoVerify.isReviewAttempt(t.boardAttempt) || (Array.isArray(t.reviews) && t.reviews.length > 0);
// A crash or a quota stop of a reviewer is not a finding.
const INFRA = ['quota', 'process', 'resume', 'automatic', 'fallback'];
const INFRA_TEXT = /^(?:额度用尽|请求被限流|未登录|agent 进程异常退出|这个会话|续接失败|30 分钟内一直发不出去)/;

const one = (value, max) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return max && Array.from(text).length > max ? Array.from(text).slice(0, max).join('') + '…' : text;
};
const list = (value) => (Array.isArray(value) ? value.filter((x) => x && typeof x === 'object') : []);
const at = (t) => t.doneAt || t.startedAt || t.sentAt || 0;

function clock(ms, timeZone) {
  const parts = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).reduce((out, p) => ({ ...out, [p.type]: p.value }), {});
  let zone = timeZone, p;
  try { p = parts(zone); } catch (_) { zone = 'UTC'; p = parts(zone); }
  return { zone, date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, short: `${p.month}-${p.day} ${p.hour}:${p.minute}` };
}
function offset(ms, zone) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
    return name ? name.value.replace('GMT', 'UTC') : '';
  } catch (_) { return ''; }
}

// ---- the Captain's own notes ----
function sectionKey(title) {
  if (/暂停|取消|暂不|叫停/.test(title)) return 'paused';
  if (/目标/.test(title)) return 'goal';
  if (/授权|范围/.test(title)) return 'scope';
  if (/交付|安装|版本/.test(title)) return 'delivery';
  if (/等用户|用户决定|待决定|拍板/.test(title)) return 'user';
  if (/决定/.test(title)) return 'decisions';
  return 'other';
}
function parseDecisions(text) {
  const out = { goal: [], scope: [], paused: [], decisions: [], delivery: [], user: [], other: [] };
  let key = 'other';
  for (const raw of String(text || '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const heading = /^#{1,6}\s*(.+?)\s*$/.exec(raw);
    if (heading) { key = sectionKey(heading[1]); continue; }
    const bullet = /^\s*[-*•]\s+(.*\S)\s*$/.exec(raw);
    if (!bullet || /^(?:无|暂无|（无）|\(无\)|none|n\/a)[。.]?$/i.test(bullet[1])) continue;
    out[key].push(bullet[1]);
  }
  return out;
}

// Branches, commits and files a receipt mentions. Claims, not facts.
function refsIn(text, files) {
  const body = String(text || '');
  const commits = [...new Set((body.match(/(?<![\w-])[0-9a-f]{7,40}(?![\w-])/gi) || []).filter((h) => /[a-f]/i.test(h) && /\d/.test(h) && !/^c\d{13,}$/i.test(h)))];
  const branches = [...new Set(body.match(/(?<![\w/.-])(?:feat|fix|release|prep|hotfix|chore|docs|test)\/[\w.\-/]*\w/g) || [])];
  const paths = [...new Set((Array.isArray(files) ? files : []).filter((f) => typeof f === 'string'))];
  return { commits: commits.slice(0, 6), branches: branches.slice(0, 6), files: paths.slice(0, 12), more: commits.length > 6 || branches.length > 6 || paths.length > 12 };
}

// ---- state ----
function index(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const dispatches = list(s.dispatches).map((t, order) => ({ ...t, order }));
  const byCard = new Map(), bySession = new Map();
  for (const t of dispatches) {
    if (t.boardId) byCard.set(t.boardId, [...(byCard.get(t.boardId) || []), t]);
    if (t.colId) bySession.set(t.colId, [...(bySession.get(t.colId) || []), t]);
  }
  const captain = s.captain && typeof s.captain === 'object' ? s.captain : {};
  return {
    now: Number.isFinite(s.now) ? s.now : 0, timeZone: typeof s.timeZone === 'string' && s.timeZone ? s.timeZone : 'UTC',
    reason: ['relay', 'clear', 'token-saver', 'restart', 'refresh'].includes(s.reason) ? s.reason : 'refresh',
    platform: String(s.platform || ''), host: one(s.host, 80), appVersion: one(s.appVersion, 40), boardVersion: one(s.boardVersion, 40),
    captain, cards: list(s.cards), dispatches, byCard, bySession,
    sessions: new Map(list(s.sessions).filter((x) => typeof x.id === 'string').map((x) => [x.id, x])),
    archived: new Set((Array.isArray(s.archivedIds) ? s.archivedIds : []).filter((x) => typeof x === 'string')),
    // inflight: typed in but never acknowledged, so it is delivered again.
    // unconfirmed: taken by the background channel, no sign it was dealt with; never delivered again.
    pending: list(s.pending), inflight: list(s.inflight), unconfirmed: list(s.unconfirmed),
    waitlist: list(s.waitlist), carry: s.carry && typeof s.carry === 'object' ? s.carry : null, boardError: one(s.boardError, 200),
    userTurns: list(s.userTurns).filter((t) => typeof t.text === 'string' && t.text.trim()),
    decisions: s.decisions && typeof s.decisions === 'object' ? s.decisions : {},
    paths: s.paths && typeof s.paths === 'object' ? s.paths : {},
    cli: typeof s.cli === 'string' && s.cli ? s.cli : 'node "$AGENTDECK_BOARD_CLI"',
    budget: budget(s.budget), dispatchCap: Number.isFinite(s.dispatchCap) ? s.dispatchCap : 0, userTurnsOlder: s.userTurnsOlder === true,
  };
}
const lastReal = (records) => (records || []).filter((t) => !bookkeeping(t)).at(-1) || (records || []).at(-1) || null;

// Whether the session is running, has ended, or was interrupted. A terminal
// that still exists says nothing about whether its task is finished.
function sessionState(ctx, id) {
  if (!id) return { code: 'none', group: 'ended', label: '无' };
  const live = ctx.sessions.get(id);
  const last = lastReal(ctx.bySession.get(id));
  if (!live) {
    if (!ctx.archived.has(id)) return { code: 'gone', group: 'ended', label: '已结束·会话已不存在' };
    return captainStopped(last) ? { code: 'archived', group: 'interrupted', label: '被中断·队长叫停并归档' } : { code: 'archived', group: 'ended', label: '已结束·已归档，tell 可恢复' };
  }
  if (!live.alive) return { code: 'exited', group: 'ended', label: '已结束·终端已退出' };
  if (last && last.status === 'paused') return { code: 'resuming', group: 'interrupted', label: '被中断·重启后程序自动续接中' };
  if (live.state === 'working') return { code: 'working', group: 'running', label: '运行中' };
  if (live.state === 'input') return { code: 'input', group: 'running', label: '运行中·停在确认提示' };
  if (live.state === 'quota') return { code: 'quota', group: 'interrupted', label: '被中断·额度用尽，等待中' };
  if (live.state === 'paused') return { code: 'resuming', group: 'interrupted', label: '被中断·重启后程序自动续接中' };
  if (captainStopped(last)) return { code: 'stopped', group: 'interrupted', label: '被中断·队长叫停，终端还在' };
  if (last && last.status === 'asking') return { code: 'asking', group: 'running', label: '运行中·在等队长回答' };
  if (last && OPEN.includes(last.status) && last.status !== 'waiting') return { code: 'idle-open', group: 'running', label: '运行中·终端空闲，回执未到' };
  return { code: 'idle', group: 'ended', label: '已结束·终端空闲' };
}
// Someone is on it right now: nobody else should be started on the same work.
const holdsWork = (state) => ['working', 'input', 'asking', 'idle-open', 'resuming'].includes(state.code);

function receiptText(receipt) {
  if (!receipt) return '';
  if (receipt.question) return '提问：' + receipt.question;
  return receipt.failed ? '没做成：' + receipt.failed + (receipt.summary ? '；' + receipt.summary : '') : receipt.summary || '';
}
// A reviewer's conclusion is read from what it wrote, never from its session ending.
function reviewOf(t, kind) {
  const closed = CLOSED.includes(t.status);
  const r = t.receipt || {};
  let verdict = 'pending';
  if (closed) {
    if (t.status === 'stopped' || INFRA.includes(r.source) || INFRA_TEXT.test(r.failed || '') || !(r.failed || r.summary)) verdict = 'none';
    else if (r.failed) verdict = 'fail';
    else verdict = AutoVerify.verdict(r.summary);
  }
  return { task: t, id: t.colId, kind, at: at(t), closed, verdict, text: r.failed || r.summary || '' };
}
// The card a session was executing when a review of it started.
function cardOf(ctx, sessionId, when) {
  const runs = (ctx.bySession.get(sessionId) || []).filter((t) => t.boardId && !isReviewer(t));
  const before = runs.filter((t) => (t.sentAt || 0) <= when).at(-1);
  return (before || runs[0])?.boardId || ctx.sessions.get(sessionId)?.boardId || '';
}
function reviewsOf(card, ctx) {
  const own = ctx.byCard.get(card.id) || [];
  const executors = new Set(own.filter((t) => !isReviewer(t)).map((t) => t.colId).filter(Boolean));
  if (card.exec_receipt?.session_id) executors.add(card.exec_receipt.session_id);
  const found = new Map();
  for (const t of ctx.dispatches) {
    if (bookkeeping(t) || !isReviewer(t) || !t.colId) continue;
    const bound = t.boardId === card.id && (AutoVerify.isReviewAttempt(t.boardAttempt) || !t.reviews?.length || t.reviews.some((id) => executors.has(id)));
    const external = t.boardId !== card.id && (t.reviews || []).some((id) => executors.has(id) && cardOf(ctx, id, t.sentAt || 0) === card.id);
    if (bound || external) found.set(t.order, reviewOf(t, bound ? 'bound' : 'external'));
  }
  return [...found.values()].sort((a, b) => a.at - b.at || a.task.order - b.task.order);
}

const VERDICT = { na: '未验收（卡片未要求验收）', none: '未验收', pending: '未验收（审查中）', pass: '通过', fail: '不通过', unclear: '结论不明确' };
const GROUPS = ['rework', 'review', 'doing', 'paused', 'todo'];
const GROUP_NAME = { rework: '返工', review: '待验收', doing: '执行中', paused: '暂停', todo: '待执行', done: '完成' };

function deriveCard(card, ctx) {
  const own = ctx.byCard.get(card.id) || [];
  const runs = own.filter((t) => !isReviewer(t) && !bookkeeping(t));
  const reviews = reviewsOf(card, ctx);
  const round = card.review_round || 0;
  const bound = card.session_id || '';
  const boundState = sessionState(ctx, bound);
  const attemptOpen = !!bound && !card.attempt_closed;
  const current = bound ? lastReal(own.filter((t) => t.colId === bound && (!card.attempt_id || !t.boardAttempt || t.boardAttempt === card.attempt_id))) : null;
  const queued = ctx.waitlist.find((w) => w.metadata?.boardId === card.id);
  // A reviewer bound with new --task-id --reviews while the card was not in review:
  // the board files it as the executor, its dispatch record says whom it reviews.
  const misfiled = attemptOpen && card.review_session !== true && !!current && isReviewer(current);
  const reviewing = card.review_session === true || misfiled;
  const executorId = reviewing ? card.exec_receipt?.session_id || lastReal(runs)?.colId || '' : bound || card.exec_receipt?.session_id || lastReal(runs)?.colId || '';
  const deps = (Array.isArray(card.depends_on) ? card.depends_on : []).map((id) => ctx.cards.find((c) => c.id === id)).filter((c) => c && c.status !== 'done');
  const blockers = [], conflicts = [], roles = [];
  const role = (name, id, note) => {
    if (!id) return;
    const known = roles.find((r) => r.id === id);
    if (known) { if (note && !known.note) known.note = note; return; }
    roles.push({ role: name, id, state: sessionState(ctx, id), note: note || '' });
  };

  // ---- verdict: board facts first, then reviews the board never saw ----
  let verdict = { code: card.verify ? 'none' : 'na', label: VERDICT[card.verify ? 'none' : 'na'] };
  const reject = card.review_reject && card.review_reject.round === round ? card.review_reject : null;
  const reviewerLost = card.review_session === true && card.status === 'doing' && card.flag === 'failed' && !reject && /:failed:(?:process|automatic|resume):/.test(card.last_event || '');
  if (reviewerLost) verdict = { code: 'none', label: `未验收（第 ${round} 轮审查会话异常退出，没有结论）` };
  else if (card.status === 'review') {
    const block = card.review_block && card.review_block.round === round ? card.review_block : null;
    verdict = block ? { code: 'unclear', label: `未验收（第 ${round} 轮：${one(block.reason, 80)}）` }
      : { code: 'pending', label: card.review_session === true ? `未验收（第 ${round} 轮审查中）` : `未验收（第 ${round} 轮，等审查会话）` };
  } else if (card.status === 'doing' && (reject || card.rework_count > 0)) {
    verdict = { code: 'fail', label: `不通过（${round ? `第 ${round} 轮，` : ''}已打回 ${card.rework_count || 1} 次）` };
  } else if (card.status === 'done' && card.verify) {
    verdict = /^auto-review-[^:]*:complete:/.test(card.last_event || '') || card.review_session === true
      ? { code: 'pass', label: `通过（第 ${round || 1} 轮）` } : { code: 'none', label: '未验收（置完成时没有审查记录）' };
  }
  const settled = reviews.filter((r) => r.closed && r.verdict !== 'none');
  const lastReview = settled.at(-1) || null;
  const openReview = reviews.filter((r) => !r.closed).at(-1) || null;
  const after = lastReview ? runs.filter((t) => (t.sentAt || 0) > lastReview.at) : [];
  // The board already recorded this rejection (flag, or a newer bound attempt).
  const recorded = lastReview && !reviewerLost && (['failed', 'held'].includes(card.flag) || (card.status === 'doing' && (reject || card.rework_count > 0)));
  let unresolved = false;
  if (openReview && card.status !== 'review') verdict = { code: 'pending', label: `未验收（${openReview.id} 审查中）` };
  else if (lastReview && !recorded) {
    if (lastReview.verdict === 'fail') {
      if (!after.length) { unresolved = true; verdict = { code: 'fail', label: `不通过（审查会话 ${lastReview.id}）` }; }
      else if (after.some((t) => OPEN.includes(t.status))) verdict = { code: 'fail', label: `不通过（审查会话 ${lastReview.id}），返工中` };
      else verdict = { code: 'none', label: `未验收（上一轮不通过，返工已交回，还没复验）` };
    } else if (lastReview.verdict === 'pass' && lastReview.kind === 'external') verdict = { code: 'pass', label: `通过（审查会话 ${lastReview.id}）` };
    else if (lastReview.verdict === 'unclear' && card.status !== 'review') verdict = { code: 'unclear', label: `结论不明确（审查会话 ${lastReview.id}，回执没有以通过或不通过开头）` };
  }

  // ---- task state ----
  let code = 'todo', group = 'todo', label = '待执行';
  const set = (c, g, l) => { code = c; group = g; label = l; };
  if (card.status === 'done') set('done', 'done', '完成');
  else if (card.status === 'needs_user') {
    if (card.user_question) set('needs_user', 'paused', '暂停（队员提问，等回答）');
    else set('needs_check', 'paused', '暂停（待队长核实）');
  } else if (card.status === 'review') {
    if (verdict.code === 'unclear') set('review_blocked', 'review', '待验收（不能自动开审查或结论不明）');
    else if (card.review_session === true) set('reviewing', 'review', '待验收（审查中）');
    else set('review_wait', 'review', '待验收（等审查会话）');
  } else if (card.status === 'doing') {
    if (card.flag === 'held') set('held', 'paused', '暂停（连续失败 2 次，已挂起）');
    else if (card.flag === 'quota') set('quota', 'paused', '暂停（额度或资源不足）');
    else if (card.flag === 'failed') {
      if (reviewerLost) set('review_lost', 'review', '待验收（审查会话异常退出，没有结论）');
      else if (reject && !reject.delivered) set('rework_pending', 'rework', '返工（验收不通过，审查意见待自动发回）');
      else if (reject || card.rework_count > 0 && card.review_round) set('rework', 'rework', '返工（验收不通过，待把意见发回原执行会话）');
      else set('failed', 'rework', '返工（上一轮执行失败，待重派）');
    } else if (attemptOpen && captainStopped(current)) set('stopped', 'paused', '暂停（已被队长叫停）');
    else if (misfiled && holdsWork(boundState)) set('reviewing', 'review', '待验收（审查中）');
    else if (attemptOpen && boundState.code === 'resuming') set('resuming', 'doing', '执行中（重启后程序自动续接中）');
    else if (attemptOpen && holdsWork(boundState)) set('doing', card.rework_count > 0 ? 'rework' : 'doing', card.rework_count > 0 ? `返工（第 ${card.rework_count} 次返工执行中）` : '执行中');
    else if (queued || card.dispatch_wait) set('queued', 'doing', '执行中（排队等空位或额度）');
    else if (card.dispatch_session_id && holdsWork(sessionState(ctx, card.dispatch_session_id))) set('dispatching', 'doing', '执行中（调度会话正在派活）');
    else set('orphan', 'doing', '执行中（没有有效执行者）');
  } else if (card.flag === 'blocked' || deps.length) set('blocked', 'todo', '待执行（等前置卡）');
  // A rejection nobody acted on outranks whatever the card says.
  if (unresolved && !['rework', 'rework_pending', 'held'].includes(code)) {
    if (card.status === 'done') conflicts.push(`看板记为完成，但审查会话 ${lastReview.id} 的结论是不通过，之后没有返工记录`);
    set('rework_open', 'rework', card.status === 'done' ? '返工（矛盾：看板记完成，验收不通过）' : '返工（验收不通过，意见还没发回）');
  }

  // ---- who is on it ----
  if (bound) role(reviewing ? '审查' : '执行', bound);
  if (reviewing && executorId) role('原执行', executorId);
  if (misfiled) conflicts.push(`看板把审查会话 ${bound} 记成了执行会话，它的回执会被当成执行回执；结论以它回执的开头为准`);
  if (card.dispatch_session_id) role('调度', card.dispatch_session_id);
  for (const r of reviews) if (!r.closed || r === lastReview) role(r.kind === 'external' ? '外部审查' : '审查', r.id, r.closed ? '结论' + (r.verdict === 'none' ? '没有给出' : VERDICT[r.verdict]) : '');
  for (const t of runs) if (OPEN.includes(t.status) && t.colId && holdsWork(sessionState(ctx, t.colId))) role('执行', t.colId);
  for (const [id, live] of ctx.sessions) if (live.boardId === card.id && holdsWork(sessionState(ctx, id))) role('关联', id);
  const executors = roles.filter((r) => r.role === '执行' && holdsWork(r.state));
  if (executors.length > 1) conflicts.push(`同一张卡有 ${executors.length} 个执行会话在跑：${executors.map((r) => r.id).join('、')}`);
  if (code === 'orphan') {
    if (bound && attemptOpen) conflicts.push(`卡片仍绑定 ${bound}，但它${boundState.label}`);
    else if (!executors.length) conflicts.push('卡片在进行中，却没有绑定任何执行会话');
  }
  if (code === 'reviewing' && !holdsWork(boundState)) conflicts.push(`审查会话 ${bound} ${boundState.label}，结论没有交回`);
  if (own.some((t) => t.pendingBoardEvent)) conflicts.push('有回执已收到但还没写进看板，卡片状态可能滞后');

  // ---- result, blockers ----
  // The card keeps its last receipt across a rebind. Until the round that is open
  // now reports something, that text belongs to an earlier round and is labelled so.
  const receipt = current?.receipt && !current.receipt.checkpoint ? receiptText(current.receipt) : '';
  const earlier = attemptOpen && (!card.last_event || /^[^:]*:started:/.test(card.last_event));
  const onCardText = card.latest_receipt ? (earlier ? '上一轮：' : '') + card.latest_receipt : '';
  const result = reject ? '审查意见：' + reject.findings : unresolved ? '审查意见：' + lastReview.text
    : receipt || (current?.progress ? '进度：' + current.progress : '') || onCardText;
  if (deps.length) blockers.push('前置卡未完成：' + deps.map((c) => `${c.id}「${one(c.title, 20)}」`).join('、'));
  if (card.dispatch_wait) blockers.push(one(card.dispatch_wait, 80));
  if (queued && !card.dispatch_wait) blockers.push('排队等空位');
  if (code === 'needs_user') blockers.push('队员提问：' + one(card.user_question, 160));
  if (code === 'review_blocked') blockers.push(one(card.review_block?.reason || verdict.label, 120));
  if (code === 'quota') blockers.push('额度或资源：' + one(card.latest_receipt, 80));
  if (code === 'held') blockers.push('连续失败 2 次，等队长拍板');

  // ---- what to do next, and when ----
  const exec = executorId || '原执行会话';
  // The card id alone is enough for the CLI (it takes the project from the card) and is safe to paste into a shell.
  const onCard = `new --task-id ${card.id}`;
  const NEXT = {
    doing: [`等 ${bound} 的回执；回执后程序自动${card.verify ? '转待验收并开审查' : '置完成'}。不要另开执行者，补充用 tell`, `等 ${bound} 回执`],
    resuming: [`程序正在自动续接（真续接或重发），约 1 分钟后用 ledger 确认；不要重派`, '等自动续接，不重派'],
    queued: ['有空位或额度恢复后程序自动开会话；不要重派', '等程序自动开'],
    dispatching: [`等调度会话 ${card.dispatch_session_id} 派出执行会话`, '等调度'],
    orphan: [`先核实：ledger${!bound ? '' : boundState.code === 'gone' ? `（${bound} 应该已经不在）` : `，再 peek ${bound}`}。确认没人在做，再在原卡下接手：${onCard}，任务里写清前次结果和剩余工作`, '核实后在原卡下接手'],
    stopped: [`已被队长叫停：没有用户或队长的新指令不要重派。要恢复就 tell ${bound}，或确认后在原卡下新开`, '已叫停，无新指令不重派'],
    review_wait: ['程序会自动开一个不同提供方的审查会话，不要自己开；几分钟后仍没开就看卡片上的原因', '等程序开审查'],
    reviewing: [misfiled
      ? `等审查会话 ${bound} 的结论，按它回执的开头判断通过与否；看板会把这份回执当成执行回执，结论出来后用 task move --id ${card.id} 把卡片改到对应状态`
      : `等审查会话 ${bound} 的结论：通过则完成，不通过则程序把原话发回原执行会话返工`, `等 ${bound} 结论`],
    review_lost: [`审查会话没给出结论就退出了：task move --id ${card.id} --status review，再用 ${onCard} 指定一个审查者重审；不要当成不通过打回`, '重新指定审查者'],
    review_blocked: [`队长处理：用 ${onCard} 指定一个审查者，或 task move --id ${card.id} --status doing 打回、--status done 通过`, '队长指定审查者或手动判定'],
    rework_pending: [`程序会把审查意见自动发回 ${exec}（已归档会自动恢复），不要另开`, '等程序发回返工'],
    rework: [`把审查意见 tell 给 ${exec}（已归档会自动恢复），不要另开执行者；最多返工 2 轮`, `tell ${exec} 返工`],
    rework_open: [card.status === 'done'
      ? `先核实：read --id ${lastReview?.id}。属实就 task move --id ${card.id} --status doing，再把意见 tell 给 ${exec}`
      : `把审查意见 tell 给 ${exec}（已归档会自动恢复），不要另开执行者`, card.status === 'done' ? '核实后打回返工' : `tell ${exec} 返工`],
    failed: [`上一轮执行失败。在原卡下重派（${onCard}，可换模型或提高档位）；再失败会挂起`, '在原卡下重派'],
    held: [`不再自动重试：换模型或改方案后 task move --id ${card.id} --status todo 再在原卡下派；仍不行才找用户`, '队长改方案后重派'],
    quota: [`quota 确认恢复后在原卡下重派，或换同级模型`, '额度恢复后重派'],
    needs_user: [`先看清问题：已有授权能定或有把握就 tell ${bound || exec} 回答，卡片随之回到进行中；涉及不可逆的事或拿不准才请用户决定。用户也可能直接在看板回答，程序会通知你`, '能定就 tell 回答，否则请用户定'],
    needs_check: [`队长核实：read 或 peek ${bound || exec} 看实际做到哪，再决定在原卡下重派还是置完成`, '队长核实'],
    todo: [`还没启动。在第 2 节的授权范围内且没被暂停时再派：${onCard}`, '授权范围内再派'],
    blocked: ['前置卡完成后程序自动解锁', '等前置卡'],
    done: ['', ''],
  }[code] || ['', ''];

  // ---- earlier rounds: one word each, the rest stays where it is ----
  const shown = new Set(roles.map((r) => r.id));
  const history = [];
  for (const id of [...new Set(own.map((t) => t.colId).filter(Boolean))]) {
    if (shown.has(id)) continue;
    const last = lastReal(own.filter((t) => t.colId === id));
    history.push({ id, outcome: !last ? '' : last.status === 'done' ? '已交回' : last.status === 'failed' ? '失败' : captainStopped(last) ? '叫停' : last.status === 'stopped' ? '未交回执' : '未结束' });
  }
  // A running task has no receipt yet: its progress line is the only word on where the work is.
  const refs = refsIn([card.exec_receipt?.text, card.latest_receipt, ...own.map((t) => receiptText(t.receipt)), ...own.filter((t) => OPEN.includes(t.status)).map((t) => t.progress)].join('\n'),
    [...(card.exec_receipt?.files || []), ...own.flatMap((t) => t.receipt?.files || [])]);
  return { id: card.id, project: String(card.project || ''), title: String(card.title || ''), order: Number(card.order) || 0, archived: !!card.archived,
    code, group, label, verdict, roles, executor: executors[0]?.id || '', asker: bound || executorId, question: code === 'needs_user' ? one(card.user_question, 200) : '', result, blockers, conflicts, next: NEXT[0], nextShort: NEXT[1], history, refs,
    started: own.length > 0 || !!bound || card.status !== 'todo', holders: roles.filter((r) => holdsWork(r.state)).map((r) => r.id) };
}

// Work handed out without a card: only what is still open, one line per session.
function deriveLoose(ctx, cardIds) {
  const out = [];
  for (const [id, records] of ctx.bySession) {
    const mine = records.filter((t) => !t.boardId || !cardIds.has(t.boardId));
    const last = lastReal(mine);
    if (!last || last !== lastReal(records)) continue;
    const state = sessionState(ctx, id);
    const open = OPEN.includes(last.status);
    const unhandled = ['failed', 'stopped'].includes(last.status) && ctx.sessions.has(id) && !bookkeeping(last);
    if (!open && !unhandled) continue;
    const stopped = captainStopped(last);
    out.push({ id, title: String(last.title || ''), project: String(last.project || ''), state, status: last.status, reviewer: isReviewer(last),
      label: stopped ? '暂停（已被队长叫停）' : last.status === 'asking' ? '执行中（在等队长回答）' : last.status === 'failed' ? '返工（执行失败，没人处理）' : last.status === 'stopped' ? '暂停（会话结束，没交回执）' : state.code === 'resuming' ? '执行中（重启后程序自动续接中）' : '执行中',
      group: stopped || last.status === 'stopped' ? 'paused' : last.status === 'failed' ? 'rework' : 'doing',
      result: receiptText(last.receipt) || (last.progress ? '进度：' + last.progress : ''),
      next: stopped ? '已叫停，无新指令不重派' : last.status === 'asking' ? '用 tell 回答它' : last.status === 'failed' ? '队长决定重派或放弃' : last.status === 'stopped' ? '队长核实后决定' : state.code === 'resuming' ? '等自动续接，不重派' : '等回执，不另开',
      holds: open && holdsWork(state) });
  }
  for (const w of ctx.waitlist) if (!w.metadata?.boardId || !cardIds.has(w.metadata.boardId)) {
    out.push({ id: '', title: String(w.title || ''), project: String(w.project || w.metadata?.project || ''), state: { code: 'none', group: 'ended', label: '还没开' }, status: 'waiting', reviewer: false,
      label: '执行中（排队等空位或额度）', group: 'doing', result: '', next: '等程序自动开，不重派', holds: false });
  }
  return out;
}

function pendingKind(item) {
  if (item.question) return '提问';
  if (item.waiting) return '确认提示';
  if (String(item.taskId || '').startsWith('board-')) return '看板通知';
  return item.failed ? '失败回执' : '回执';
}
const pendingLine = (item) => item.question || item.waiting || (item.failed ? '没做成：' + item.failed : item.summary) || '';

function derive(snapshot) {
  const ctx = index(snapshot);
  const all = ctx.cards.map((card) => deriveCard(card, ctx));
  // Done cards leave the list unless a rejection is still open on them.
  const cards = all.filter((c) => c.group !== 'done' && !(c.archived && !c.conflicts.length))
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.project.localeCompare(b.project) || a.order - b.order || a.id.localeCompare(b.id));
  const cardIds = new Set(ctx.cards.map((c) => c.id));
  const loose = deriveLoose(ctx, cardIds);
  // Every running background session shows up somewhere, card or not.
  const named = new Set([...cards.flatMap((c) => c.roles.map((r) => r.id)), ...loose.map((l) => l.id)]);
  const strays = [...ctx.sessions.values()].filter((s) => s.crew !== false && !named.has(s.id) && sessionState(ctx, s.id).group === 'running')
    .map((s) => ({ id: s.id, title: String(s.title || ''), state: sessionState(ctx, s.id) }));

  const unconfirmed = ctx.unconfirmed, redeliver = ctx.inflight;
  const carried = ctx.carry && Array.isArray(ctx.carry.items) ? list(ctx.carry.items) : [];
  const asks = [];
  for (const [id, records] of ctx.bySession) {
    const last = lastReal(records);
    if (last && (last.status === 'asking' || last.status === 'input')) asks.push({ id, cardId: last.boardId && cardIds.has(last.boardId) ? last.boardId : '', title: String(last.title || ''), kind: last.status === 'asking' ? '提问' : '确认提示', text: last.receipt?.question || '' });
  }
  const notes = parseDecisions(ctx.decisions.text);
  const dependents = (id) => ctx.cards.filter((c) => c.status !== 'done' && (c.depends_on || []).includes(id)).map((c) => c.id);
  // A question on a card (the 需要你 column) went to the Captain as well: the same
  // question, listed once, with what waits on it. Whether the user has to decide
  // it is the Captain's call, so it is not filed under the user.
  for (const c of cards.filter((c) => c.code === 'needs_user')) {
    const known = asks.find((a) => a.cardId === c.id);
    if (known) Object.assign(known, { title: c.title, text: known.text || c.question, blocks: dependents(c.id) });
    else asks.push({ id: c.asker, cardId: c.id, title: c.title, kind: '提问', text: c.question, blocks: dependents(c.id) });
  }
  const forCaptain = cards.filter((c) => ['held', 'review_blocked', 'review_lost', 'needs_check', 'rework_open', 'orphan', 'failed'].includes(c.code));
  const conflicts = cards.flatMap((c) => c.conflicts.map((text) => ({ id: c.id, text })));

  const latestUser = ctx.userTurns.reduce((max, t) => Math.max(max, t.ts || 0), 0);
  const mtime = Number.isFinite(ctx.decisions.mtime) ? ctx.decisions.mtime : 0;
  const recorded = notes.goal.length + notes.scope.length + notes.paused.length + notes.decisions.length + notes.delivery.length + notes.user.length > 0;
  const unsorted = ctx.userTurns.filter((t) => (t.ts || 0) > mtime || !recorded);

  const count = (group) => cards.filter((c) => c.group === group).length + loose.filter((l) => l.group === group).length;
  const stats = { cards: cards.length, loose: loose.length, rework: count('rework'), review: count('review'), doing: count('doing'), paused: count('paused'), todo: count('todo'),
    running: [...new Set([...cards.flatMap((c) => c.holders), ...loose.filter((l) => l.holds).map((l) => l.id), ...strays.map((s) => s.id)])],
    pending: ctx.pending.length + redeliver.length, unconfirmed: unconfirmed.length + carried.length, asks: asks.length, forUser: notes.user.length, conflicts: conflicts.length, strays: strays.length };
  // Authorized work that is under way or waiting on the Captain, as opposed to cards nobody has started.
  const active = stats.rework + stats.review + stats.doing + cards.filter((c) => ['held', 'needs_check', 'quota'].includes(c.code)).length + stats.pending + stats.unconfirmed + stats.asks;
  // A session at work with no record behind it is not "nothing to do": it is the first thing
  // to look at. Neither is a task that was stopped and is all that is left.
  const plan = notes.paused.length ? 'paused' : active ? 'resume' : strays.length ? 'verify' : stats.todo + stats.paused ? 'backlog' : 'ready';
  return { ctx, cards, loose, strays, pending: [...redeliver, ...ctx.pending], unconfirmed, carried, asks, notes, recorded, mtime, latestUser, unsorted, forCaptain, conflicts, stats, plan };
}

// ---- text ----
// What each level keeps. Unfinished tasks, blockers, limits and open decisions
// are never dropped at any level; only explanations, excerpts and evidence shrink.
const LEVELS = [
  { name: '完整', result: 200, title: 60, history: 'full', excerpts: 8, excerpt: 100, files: 12, refs: true, long: true, line: 100, note: 300, items: 40 },
  { name: '压缩历史说明和证据', result: 110, title: 48, history: 'count', excerpts: 5, excerpt: 60, files: 6, refs: true, long: true, line: 70, note: 300, items: 20 },
  { name: '再压缩结果摘要和原文摘录', result: 60, title: 36, history: 'none', excerpts: 3, excerpt: 40, files: 3, refs: false, long: false, line: 50, note: 200, items: 10 },
  { name: '只留必留项', result: 0, title: 24, history: 'none', excerpts: 0, excerpt: 0, files: 0, refs: false, long: false, line: 30, note: 160, items: 5 },
];
const PLATFORM = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };
const REASON = { relay: '席位 Relay', clear: '清空队长上下文', 'token-saver': '自动存档并清空上下文', restart: 'AgentDeck 重启', refresh: '队长运行 handoff' };

function render(state, level) {
  const L = LEVELS[level];
  const { ctx, stats, notes } = state;
  const cli = ctx.cli;
  const when = (ms) => (ms ? clock(ms, ctx.timeZone).short : '时间未知');
  const now = clock(ctx.now, ctx.timeZone);
  const omitted = [];
  const out = [];
  const prev = ctx.captain.previousId || '';
  const who = (r) => `${r.role} ${r.id}（${r.state.label}${r.note ? '，' + r.note : ''}）`;

  // 1
  out.push('# AgentDeck 队长交接', '', '## 1. 交接元信息');
  const relay = ctx.captain.message ? one(ctx.captain.message, 200) : ctx.captain.lastRelay?.message ? `最近一次轮换（${when(ctx.captain.lastRelay.at)}）：${one(ctx.captain.lastRelay.message, 200)}` : '';
  out.push(`- 生成：${now.date} ${now.time}（${now.zone}${offset(ctx.now, now.zone) ? '，' + offset(ctx.now, now.zone) : ''}）；触发：${REASON[ctx.reason]}${relay ? '；' + relay : ''}`);
  if (/\d\s*%/.test(relay)) out.push('- 上面的额度百分比是轮换那一刻的采样（来源：永动机轮换判定），只说明为什么轮换；现在的额度用 quota 查，不要拿它推算');
  out.push(`- 上任会话：${prev || '无'}${prev ? `（read --id ${prev} 按需读）` : ''}`);
  out.push(`- 快照版本：队长代次 gen ${ctx.captain.gen ?? '待核实'}${ctx.captain.nextGen ? ' → ' + ctx.captain.nextGen : ''}${ctx.boardVersion ? '；看板版本 ' + ctx.boardVersion : ''}。下面各节都取自这一份快照，另标了时间的除外`);
  out.push(`- 摘要：未完成任务 ${stats.cards + stats.loose} 条（返工 ${stats.rework}｜待验收 ${stats.review}｜执行中 ${stats.doing}｜暂停 ${stats.paused}｜待执行 ${stats.todo}）；在跑的队员会话 ${stats.running.length} 个；未读回执 ${stats.pending} 条；已取走未确认 ${stats.unconfirmed} 条；队员在等回答 ${stats.asks} 条；等用户决定 ${stats.forUser} 条；矛盾 ${stats.conflicts} 条`);
  if (ctx.dispatchCap && ctx.dispatches.length >= ctx.dispatchCap) out.push(`- 派活记录：本快照有 ${ctx.dispatches.length} 条。未结束的全部保留；已结束的只留最近的，更早的旧轮次和只记在派活记录里的外部审查结论不在这里，以看板卡片为准，细节 read --id 会话id`);
  out.push('- 长度：{{LENGTH}}');
  out.push(`- 命令：下文的 handoff、ledger、read 等都接在 ${cli} 后面运行`);
  if (ctx.captain.rotation) out.push(`- 队长轮换：${one(ctx.captain.rotation, 160)}。谁接任队长只看这项设置，和队员用什么模型无关；交接不改它`);

  // 2
  const file = ctx.decisions.path || ctx.paths.decisions || DECISIONS_FILE;
  const atLeast = ctx.userTurnsOlder && state.unsorted.length === ctx.userTurns.length ? '至少 ' : '';
  const stale = state.unsorted.length && state.recorded ? `；此后还有 ${atLeast}${state.unsorted.length} 条用户消息没整理进来，以原文为准` : '';
  out.push('', '## 2. 当前目标和有效决定');
  out.push(`来源：队长维护的 ${file}（${ctx.decisions.error ? ctx.decisions.error + '，下面各项待核实' : state.mtime ? '最后修改 ' + when(state.mtime) : '还没有这份文件'}${stale}）。程序原样引用，不判断语义。`);
  const cut = (line) => one(line, L.note) + (Array.from(one(line)).length > L.note ? '（全文见文件）' : '');
  const block = (title, lines, empty) => {
    if (!lines.length) { out.push(`- ${title}：${empty}`); return; }
    if (lines.length === 1) { out.push(`- ${title}：${cut(lines[0])}`); return; }
    out.push(`- ${title}：`); lines.forEach((line) => out.push('  - ' + cut(line)));
  };
  block('当前目标', notes.goal, '无记录，待核实');
  block('已授权范围', notes.scope, '无记录，待核实');
  block('暂停、取消、暂不启动', notes.paused, '无');
  block('仍有效的用户决定', notes.decisions, '无记录，待核实');
  if (notes.other.length) block('其他记录', notes.other, '无');
  const olderTurns = ctx.userTurnsOlder ? '；更早的没有统计在内，read --id captain-history --find 关键词' : '';
  if (!ctx.userTurns.length) out.push('- 最近用户消息：无');
  else {
    const turns = L.excerpts ? ctx.userTurns.slice(-L.excerpts) : [];
    const hidden = ctx.userTurns.length - turns.length;
    out.push(`- 最近用户消息 ${ctx.userTurns.length} 条（原文指针，程序没有整理；其中 ${state.unsorted.length} 条还没进有效决定文件${olderTurns}）：`);
    for (const t of turns) {
      const words = one(t.text).replace(/["\\`$]/g, '');
      const find = Array.from(words.split(' ')[0] || '').slice(0, 12).join('');
      const size = Array.from(t.text).length;
      out.push(`  - ${when(t.ts)}${state.unsorted.includes(t) ? ' 未整理' : ''}｜「${one(t.text, L.excerpt)}」${size > L.excerpt ? `（共 ${size} 字${t.longFile ? '，全文 ' + t.longFile : ''}）` : ''}｜read --id ${t.sourceId || prev || '上任会话'}${find ? ` --find "${find}"` : ''}`);
    }
    if (hidden > 0) {
      const rest = ctx.userTurns.slice(0, hidden);
      const late = rest.filter((t) => state.unsorted.includes(t));
      const where = [...new Set(rest.map((t) => t.sourceId || prev).filter(Boolean))];
      out.push(`  - 另有 ${hidden} 条没摘录${late.length ? `，其中未整理的在 ${late.map((t) => when(t.ts)).join('、')}` : ''}：read --id ${where[0] || '上任会话'} --turns 10${where.length > 1 ? `（另见 ${where.slice(1).join('、')}）` : ''}`);
      omitted.push(`用户消息摘录 ${hidden} 条`);
    }
  }

  // 3
  out.push('', '## 3. 当前项目与交付状态');
  out.push(`- 本机：${PLATFORM[ctx.platform] || ctx.platform || '待核实'}${ctx.host ? ' ' + ctx.host : ''}，正在运行 AgentDeck ${ctx.appVersion || '待核实'}（程序自报，取自本快照）。其他机器：待核实，本机看不到`);
  block(`队长记录的交付状态（${state.mtime ? when(state.mtime) + ' 的记录' : '无文件'}）`, notes.delivery, '无记录，待核实');
  const withRefs = state.cards.filter((c) => c.refs.commits.length || c.refs.branches.length || c.refs.files.length);
  if (!withRefs.length) out.push('- 未完成任务的回执和进度里提到的分支、提交、产物：无');
  else if (!L.refs) { out.push(`- 未完成任务的回执和进度里提到分支、提交或产物的有 ${withRefs.length} 张卡，这里不展开：task list --status doing`); omitted.push(`回执和进度里的分支、提交、产物 ${withRefs.length} 张卡`); }
  else {
    out.push('- 未完成任务的回执和进度里提到的分支、提交、产物（队员自述，程序没有核实；提交、合并、打包、安装各到哪一步都按待核实处理）：');
    for (const c of withRefs) {
      const files = c.refs.files.slice(0, Math.max(1, Math.floor(L.files / 3)));
      out.push(`  - ${c.id}｜${[c.refs.branches.length ? '分支 ' + c.refs.branches.join('、') : '', c.refs.commits.length ? '提交 ' + c.refs.commits.join('、') : '', files.length ? '产物 ' + files.join('、') : ''].filter(Boolean).join('｜')}${c.refs.more || files.length < c.refs.files.length ? '｜还有没列出的，见回执原文' : ''}`);
    }
  }

  // 4
  out.push('', `## 4. 未完成任务（${stats.cards + stats.loose} 条，每张卡一条当前记录）`);
  const started = state.cards.filter((c) => c.started || c.group !== 'todo');
  const fresh = state.cards.filter((c) => !started.includes(c));
  if (ctx.boardError) out.push(`- 任务看板读不出来（${ctx.boardError}）：下面只有队长自己的派活记录，卡片状态待核实；修好看板文件后再跑 handoff`);
  if (!state.cards.length && !state.loose.length) out.push('无');
  for (const c of started) {
    const roles = c.roles.length ? c.roles.map(who).join('；') : '无';
    const head = `- 【${c.label}】${c.id}｜${c.project}｜${one(c.title, L.title)}`;
    const blocked = [...c.blockers, ...c.conflicts.map((x) => '矛盾：' + x)];
    if (L.long) {
      out.push(head, `  会话：${roles}｜验收：${c.verdict.label}`);
      out.push(`  结果：${one(c.result, L.result) || '无'}`);
      out.push(`  阻塞：${blocked.length ? blocked.join('；') : '无'}`);
      out.push(`  下一步：${c.next}`);
      if (c.history.length && L.history === 'full') out.push(`  旧轮次：${c.history.map((h) => `${h.id}（${h.outcome}）`).join('、')}；细节 read --id 会话id`);
      else if (c.history.length) out.push(`  旧轮次：${c.history.length} 个会话，细节 read --id 会话id`);
    } else {
      out.push(`${head}｜${c.roles.length ? roles : '无会话'}｜验收：${c.verdict.label}${L.result && c.result ? '｜结果：' + one(c.result, L.result) : ''}｜阻塞：${blocked.length ? blocked.join('；') : '无'}｜下一步：${c.nextShort}`);
    }
  }
  if (!L.long) omitted.push('任务的完整下一步说明和旧轮次');
  else if (L.history === 'count' && started.some((c) => c.history.length)) omitted.push('旧轮次明细');
  if (!L.result && started.some((c) => c.result)) omitted.push(`结果摘要（ledger 或 task list 查）`);
  if (fresh.length) {
    out.push(`- 【待执行】还没启动的 ${fresh.length} 张（在第 2 节授权范围内且没被暂停时再派：new --task-id 卡片id）：`);
    for (const c of fresh) out.push(`  - ${c.id}｜${c.project}｜${one(c.title, L.title)}${c.blockers.length ? '｜' + c.blockers.join('；') : ''}`);
  }
  for (const l of state.loose) {
    out.push(`- 【${l.label}】没挂卡｜${l.project || '无项目'}｜${one(l.title, L.title)}｜${l.id ? `${l.reviewer ? '审查' : '执行'} ${l.id}（${l.state.label}）` : '还没开会话'}${L.result && l.result ? '｜结果：' + one(l.result, L.result) : ''}｜下一步：${l.next}`);
  }
  if (state.strays.length) out.push(`- 在跑、但没有对应未完成任务记录的会话：${state.strays.map((s) => `${s.id}「${one(s.title, 24)}」（${s.state.label}）`).join('、')}。用 peek 看它在做什么`);

  // 5
  out.push('', '## 5. 待处理事项');
  const item = (p) => `  - ${pendingKind(p)}｜${p.colId || ''}｜「${one(p.title, 30)}」｜${one(pendingLine(p), L.line)}`;
  // Every waiting receipt is named. Past the first L.items of a list the rest go by
  // session and title only, so a long list costs little and nobody's result is cut off.
  let titlesOnly = 0;
  const receipts = (items) => {
    items.slice(0, L.items).forEach((p) => out.push(item(p)));
    const rest = items.slice(L.items);
    if (!rest.length) return;
    const bySession = new Map();
    for (const p of rest) bySession.set(p.colId || '会话未知', [...(bySession.get(p.colId || '会话未知') || []), p]);
    out.push(`  - 其余 ${rest.length} 条只列会话和标题，内容用 read --id 会话id 查：${[...bySession].map(([id, ps]) => id + ps.map((p) => `${pendingKind(p) === '回执' ? '' : pendingKind(p)}「${one(p.title, 40)}」`).join('')).join('；')}`);
    titlesOnly += rest.length;
  };
  if (!state.pending.length) out.push('- 未读回执和提问：无');
  else { out.push(`- 未读回执和提问 ${state.pending.length} 条（会经 receipts 通道送达，到时再处理，不要照这里重复派活）：`); receipts(state.pending); }
  if (state.unconfirmed.length) {
    out.push(`- ${ctx.reason === 'refresh' ? '你已取走、还没处理完' : '上任已取走、可能没处理完'}的回执 ${state.unconfirmed.length} 条（不会再经通道送达，逐条核对是否已处理）：`);
    receipts(state.unconfirmed);
  }
  if (state.carried.length) {
    const since = ctx.carry.kind === 'restart' ? `重启前（${when(ctx.carry.at)}）` : `Relay（${when(ctx.carry.at)}，${ctx.reason === 'relay' ? '当时的' : ''}上任 ${ctx.carry.fromId || '未知'}）`;
    // At a Relay these come from before the Captain that is leaving, which never finished a turn on them.
    out.push(ctx.reason === 'relay'
      ? `- 更早一次${ctx.carry.kind === 'restart' ? '' : ' '}${since}已取走、之后也没人处理完的回执 ${state.carried.length} 条（不会再经通道送达，逐条核对是否已处理）：`
      : `- ${ctx.carry.kind === 'restart' ? since : '上次 ' + since + '时'}已取走、可能没处理完的回执 ${state.carried.length} 条（不会再经通道送达；核对过就不用再看）：`);
    receipts(state.carried);
  }
  if (!state.unconfirmed.length && !state.carried.length) out.push('- 已取走、可能没处理完的回执：无');
  if (titlesOnly) omitted.push(`回执内容 ${titlesOnly} 条（只列了会话和标题）`);
  if (!state.asks.length) out.push('- 队员在等队长回答：无');
  else {
    out.push(`- 队员在等队长回答 ${state.asks.length} 条（卡着后续动作，先处理：已有授权能定或有把握的直接 tell / answer 回答，涉及不可逆的事或拿不准的才请用户决定）：`);
    state.asks.forEach((a) => out.push(`  - ${a.kind}｜${a.id || '会话未知'}｜${a.cardId ? a.cardId + '｜' : ''}「${one(a.title, 30)}」${a.text ? '｜' + one(a.text, Math.max(L.line, 60)) : a.id ? `｜peek --id ${a.id}` : ''}${a.cardId ? '｜' + (a.blocks?.length ? '阻塞 ' + a.blocks.join('、') : '不阻塞其他卡') : ''}`));
  }
  // Only what the Captain wrote down as waiting for the user. A crew question is not one until the Captain says so.
  if (!notes.user.length) out.push('- 必须由用户决定：无（队长没有记录）');
  else { out.push(`- 必须由用户决定 ${notes.user.length} 条（队长记录）：`); notes.user.forEach((line) => out.push('  - ' + cut(line))); }
  if (!state.forCaptain.length) out.push('- 等队长拍板（已有授权能解决，不要转给用户）：无');
  else out.push(`- 等队长拍板 ${state.forCaptain.length} 条（已有授权能解决，不要转给用户）：${state.forCaptain.map((c) => `${c.id}（${c.label}）`).join('、')}`);

  // 6
  // Section 4 already carries every card's own next step; long id lists are not repeated here.
  const ids = (cards) => (!cards.length ? '无' : cards.length <= 4 ? cards.map((c) => c.id).join('、')
    : `${cards.length} 张，第 4 节里标着${[...new Set(cards.map((c) => `【${c.label}】`))].join('')}的`);
  const waitFor = state.cards.filter((c) => ['doing', 'resuming', 'queued', 'dispatching', 'reviewing', 'rework_pending'].includes(c.code));
  const takeOver = state.cards.filter((c) => ['orphan', 'failed', 'needs_check'].includes(c.code));
  const toReview = state.cards.filter((c) => ['review_wait', 'review_blocked', 'review_lost', 'rework', 'rework_open'].includes(c.code));
  const gated = state.cards.filter((c) => ['blocked', 'quota', 'held', 'stopped', 'todo'].includes(c.code));
  const PLAN = {
    paused: '第 2 节有生效中的暂停或取消项：这些事项不续派、不重启，运行中的会话和旧的续活计划都不能推翻它。其余已授权任务照下面的顺序核对后续接；范围拿不准先问用户。',
    resume: '有已授权待办：照下面的顺序核对后主动续接，不用等用户说继续。',
    verify: `有 ${stats.strays} 个会话还在跑、却没有对应的任务记录（${state.strays.map((x) => x.id).join('、')}）：先 peek 核实它在做什么，再决定继续跟踪还是叫停；核实前不要报告就绪，也不要另派同样的活。`,
    backlog: `没有在跑、待验收或待处理的任务，有 ${stats.todo} 张待执行卡${stats.paused ? `、${stats.paused} 条暂停中的任务` : ''}：属于第 2 节授权范围且没被暂停的${stats.paused ? '待执行卡' : ''}可以启动，范围不明先问；${stats.paused ? '暂停的没有新指令不重启，照第 4 节各自的下一步处理；' : ''}不要为了凑数新立项目。`,
    ready: '没有待办：简短回复「队长已就绪」，等用户指令；不要自行立项或派新活。',
  };
  out.push('', '## 6. 接手动作和证据索引', `启动方式：${PLAN[state.plan]}`);
  out.push(`1. 读规则：briefing 是稳定规则；本交接是动态状态，handoff 随时重新生成。交接里出现的旧命令、旧安装计划和历史用户消息只是核对资料，不因为读到就再执行一遍。`);
  out.push(`2. 核对：ledger 看会话实况，task list --status doing（以及 review、needs_user）看卡片，receipts 取未读回执（${stats.pending} 条）。`);
  out.push(`3. 先处理卡着后续动作的：队员提问 ${stats.asks} 条，矛盾 ${stats.conflicts} 条${state.conflicts.length ? '（' + [...new Set(state.conflicts.map((c) => c.id))].join('、') + '）' : ''}，已取走未确认的回执 ${stats.unconfirmed} 条${stats.strays ? `，没有任务记录却在跑的会话 ${stats.strays} 个（${state.strays.map((x) => x.id).join('、')}，先 peek）` : ''}。矛盾先核实，不凭空判完成，也不从头重做。`);
  out.push(`4. 已有有效执行者或程序会自动处理，继续跟踪、不另开：${ids(waitFor)}`);
  out.push(`5. 确认没有有效执行者后，在原卡下接手并交代前次结果和剩余工作：${ids(takeOver)}`);
  out.push(`6. 进入验收或返工：${ids(toReview)}`);
  out.push(`7. 条件满足才启动（前置完成、额度恢复、队长改方案、用户答复或新指令）：${ids(gated)}`);
  out.push('8. 回执监听：上任终端的监听已随旧终端被程序作废；同一终端里更早挂的监听会被程序请退，只留最新的。确认自己挂着恰好一个后台回执监听，命令和挂法见 briefing 第 8 条。');
  out.push(`9. 核对完、状态有变化后再跑一次 handoff，交接文件随之更新。`);
  out.push('证据索引：');
  out.push(`- 上任队长对话：${prev ? `read --id ${prev} [--find 关键词]` : '无'}；历次队长对话：read --id captain-history --find 关键词`);
  out.push(`- 任务卡原始数据：${ctx.paths.tasks || '~/.agents/boards/tasks'}/<项目>.json；会话原文：read --id 会话id；实时屏幕：peek --id 会话id`);
  out.push(`- 有效决定与交付状态：${file}；本交接文件：${ctx.paths.handoff || HANDOFF_FILE}${ctx.paths.chats ? '；对话存档目录：' + ctx.paths.chats : ''}`);
  const files = [...new Set(state.cards.flatMap((c) => c.refs.files))];
  if (files.length && L.files) out.push(`- 未完成任务提到的报告和产物：${files.slice(0, L.files).join('、')}${files.length > L.files ? ` 等 ${files.length} 个` : ''}`);
  if (files.length > L.files) omitted.push(`报告和产物路径 ${files.length - L.files} 个`);
  return { text: out.join('\n') + '\n', omitted };
}

// The shortest level that fits. Past the last level nothing more may go, so
// the text says it is over budget instead of losing a task.
function build(snapshot) {
  const state = derive(snapshot);
  const limit = state.ctx.budget;
  const size = (text) => Array.from(text).length;
  const fill = (drawn, level, over) => {
    const note = (length) => `预算 ${limit} 字，实际约 ${length} 字，压缩级别 ${level}（${LEVELS[level].name}）`
      + (drawn.omitted.length ? `；压掉了：${[...new Set(drawn.omitted)].join('、')}，都留了查询入口` : '；没有压掉内容')
      + (over ? '；已超出预算：未完成任务、阻塞、限制和待决定事项一条没删，要更短就归档已完成的卡或调大预算' : '');
    return drawn.text.replace('{{LENGTH}}', note(size(drawn.text.replace('{{LENGTH}}', note(limit)))));
  };
  let level = 0, drawn = render(state, 0), text = fill(drawn, 0, false);
  while (size(text) > limit && level < LEVELS.length - 1) { level += 1; drawn = render(state, level); text = fill(drawn, level, false); }
  const over = size(text) > limit;
  if (over) text = fill(drawn, level, true);
  return { text, level, budget: limit, length: size(text), over, omitted: [...new Set(drawn.omitted)], state };
}

module.exports = { budget, DECISIONS_FILE, HANDOFF_FILE, DECISIONS_TEMPLATE, LEVELS, GROUP_NAME,
  parseDecisions, refsIn, sessionState, deriveCard, derive, render, build, bookkeeping, captainStopped, isReviewer };
