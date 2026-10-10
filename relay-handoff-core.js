'use strict';
// The Captain's Relay handoff (交接). One snapshot goes in: board cards, the
// Captain's dispatch records, live sessions, unread receipts, the decisions the
// Captain wrote down. One text comes out. Every section is derived from that
// same snapshot, so the summary cannot disagree with the task list.
// Pure: no fs, no Electron, no clock of its own.
const AutoVerify = require('./auto-verify-core');
// How long the overview page may be, in characters (config.captainHandoffOverview).
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
const INFRA = ['quota', 'process', 'startup', 'resume', 'automatic', 'fallback', 'sleep'];
const INFRA_TEXT = /^(?:额度用尽|请求被限流|未登录|agent 进程异常退出|这个会话|启动失败|续接失败|30 分钟内一直发不出去)/;

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
  // "暂停时的现场" is a snapshot written at the moment of a pause, not the list of what is paused.
  if (/现场/.test(title)) return 'other';
  if (/暂停|取消|暂不|叫停/.test(title)) return 'paused';
  if (/目标/.test(title)) return 'goal';
  if (/授权|范围/.test(title)) return 'scope';
  if (/交付|安装|版本/.test(title)) return 'delivery';
  if (/等用户|用户决定|待决定|拍板/.test(title)) return 'user';
  if (/决定/.test(title)) return 'decisions';
  return 'other';
}
// Every bullet with the line it stands on in the file, so an older entry can be pointed at.
function parseDecisionEntries(text) {
  const out = { goal: [], scope: [], paused: [], decisions: [], delivery: [], user: [], other: [] };
  let key = 'other';
  // Comments are blanked, not removed, so the line numbers stay those of the file.
  const lines = String(text || '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, '')).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const heading = /^#{1,6}\s*(.+?)\s*$/.exec(raw);
    if (heading) { key = sectionKey(heading[1]); return; }
    const bullet = /^\s*[-*•]\s+(.*\S)\s*$/.exec(raw);
    if (!bullet || /^(?:无|暂无|（无）|\(无\)|none|n\/a)[。.]?$/i.test(bullet[1])) return;
    out[key].push({ text: bullet[1], line: i + 1 });
  });
  return out;
}
function parseDecisions(text) {
  return Object.fromEntries(Object.entries(parseDecisionEntries(text)).map(([key, list]) => [key, list.map((e) => e.text)]));
}
// "[10-06 12:15 …" at the start of an entry. Only used to order entries, so the
// year is the current one (the previous one if that would be in the future).
function stampOf(text, now) {
  const m = /^[*_\s]*[\[【(（](?:(\d{4})-)?(\d{1,2})-(\d{1,2})(?:[^\d\]】）)]{0,4}(\d{1,2}):(\d{2}))?/.exec(text);
  if (!m) return 0;
  const year = m[1] ? Number(m[1]) : new Date(now).getUTCFullYear();
  const at = (y) => Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  return !m[1] && at(year) > now + 36 * 3600_000 ? at(year - 1) : at(year);
}
// Newest first; entries with no time at the start go last, in file order.
const newest = (entries) => [...entries].sort((a, b) => b.ts - a.ts || a.line - b.line);
// The Captain marks an entry as lasting by saying so at its start: 【长期】, "长期有效".
const lasting = (entry) => /长期/.test(Array.from(entry.text).slice(0, 80).join(''));

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
    captain, discussions: list(s.discussions).filter((d) => /^[A-Za-z0-9_-]{1,160}$/.test(d.id) && !['complete', 'cancelled'].includes(d.status)), cards: list(s.cards), dispatches, byCard, bySession,
    sessions: new Map(list(s.sessions).filter((x) => typeof x.id === 'string').map((x) => [x.id, x])),
    archived: new Set((Array.isArray(s.archivedIds) ? s.archivedIds : []).filter((x) => typeof x === 'string')),
    // inflight: typed in but never acknowledged, so it is delivered again.
    // unconfirmed: taken by the background channel, no sign it was dealt with; never delivered again.
    pending: list(s.pending), inflight: list(s.inflight), unconfirmed: list(s.unconfirmed),
    waitlist: list(s.waitlist), carry: s.carry && typeof s.carry === 'object' ? s.carry : null, boardError: one(s.boardError, 200),
    userTurns: list(s.userTurns).filter((t) => typeof t.text === 'string' && t.text.trim()),
    decisions: s.decisions && typeof s.decisions === 'object' ? s.decisions : {},
    aboutUser: s.aboutUser && typeof s.aboutUser === 'object' ? { mtime: Number(s.aboutUser.mtime) } : null,
    paths: s.paths && typeof s.paths === 'object' ? s.paths : {},
    cli: typeof s.cli === 'string' && s.cli ? s.cli : 'node "$AGENTDECK_BOARD_CLI"',
    limit: budget(s.budget), dispatchCap: Number.isFinite(s.dispatchCap) ? s.dispatchCap : 0, userTurnsOlder: s.userTurnsOlder === true,
  };
}
const lastReal = (records) => (records || []).filter((t) => !bookkeeping(t)).at(-1) || (records || []).at(-1) || null;

// Whether the session is running, has ended, or was interrupted. A terminal
// that still exists says nothing about whether its task is finished.
// host: the machine the card says the session runs on (session_host / dispatch_host). This machine
// sees only its own terminals, so a session on the other one is out of sight, not gone.
function sessionState(ctx, id, host) {
  if (!id) return { code: 'none', group: 'ended', label: '无' };
  const live = ctx.sessions.get(id);
  const last = lastReal(ctx.bySession.get(id));
  if (!live && host && ctx.host && String(host).toLowerCase() !== ctx.host.toLowerCase()) {
    return { code: 'remote', group: 'running', label: `在另一台机器 ${one(host, 40)} 上，本机看不到它的终端，待核实` };
  }
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
const holdsWork = (state) => ['working', 'input', 'asking', 'idle-open', 'resuming', 'remote'].includes(state.code);

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
  const boundState = sessionState(ctx, bound, card.session_host);
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
    roles.push({ role: name, id, state: sessionState(ctx, id, id === bound ? card.session_host : id === card.dispatch_session_id ? card.dispatch_host : ''), note: note || '' });
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
    else if (attemptOpen && boundState.code === 'remote') set('doing', 'doing', `执行中（${boundState.label}）`);
    else if (attemptOpen && holdsWork(boundState)) set('doing', card.rework_count > 0 ? 'rework' : 'doing', card.rework_count > 0 ? `返工（第 ${card.rework_count} 次返工执行中）` : '执行中');
    else if (queued || card.dispatch_wait) set('queued', 'doing', '执行中（排队等空位或额度）');
    else if (card.dispatch_session_id && holdsWork(sessionState(ctx, card.dispatch_session_id, card.dispatch_host))) set('dispatching', 'doing', '执行中（调度会话正在派活）');
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
  // 高优先级: the user named this card as urgent. The next Captain must know which ones.
  return { id: card.id, project: String(card.project || ''), title: String(card.title || ''), order: Number(card.order) || 0, archived: !!card.archived, important: card.important === true,
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
    out.push({ id, title: String(last.title || ''), project: String(last.project || ''), state, status: last.status, halted: stopped, reviewer: isReviewer(last), important: last.important === true || ctx.sessions.get(id)?.important === true,
      label: stopped ? '暂停（已被队长叫停）' : last.status === 'asking' ? '执行中（在等队长回答）' : last.status === 'failed' ? '返工（执行失败，没人处理）' : last.status === 'stopped' ? '暂停（会话结束，没交回执）' : state.code === 'resuming' ? '执行中（重启后程序自动续接中）' : '执行中',
      group: stopped || last.status === 'stopped' ? 'paused' : last.status === 'failed' ? 'rework' : 'doing',
      result: receiptText(last.receipt) || (last.progress ? '进度：' + last.progress : ''),
      next: stopped ? '已叫停，无新指令不重派' : last.status === 'asking' ? '用 tell 回答它' : last.status === 'failed' ? '队长决定重派或放弃' : last.status === 'stopped' ? '队长核实后决定' : state.code === 'resuming' ? '等自动续接，不重派' : '等回执，不另开',
      holds: open && holdsWork(state) });
  }
  for (const w of ctx.waitlist) if (!w.metadata?.boardId || !cardIds.has(w.metadata.boardId)) {
    out.push({ id: '', title: String(w.title || ''), project: String(w.project || w.metadata?.project || ''), state: { code: 'none', group: 'ended', label: '还没开' }, status: 'waiting', reviewer: false, important: w.important === true,
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
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || b.important - a.important || a.project.localeCompare(b.project) || a.order - b.order || a.id.localeCompare(b.id));
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
  const found = parseDecisionEntries(ctx.decisions.text);
  const entries = Object.fromEntries(Object.entries(found).map(([key, list]) => [key, list.map((e) => ({ ...e, ts: stampOf(e.text, ctx.now) }))]));
  const notes = Object.fromEntries(Object.entries(entries).map(([key, list]) => [key, list.map((e) => e.text)]));
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
    important: cards.filter((c) => c.important).length + loose.filter((l) => l.important).length,
    pending: ctx.pending.length + redeliver.length, unconfirmed: unconfirmed.length + carried.length, asks: asks.length, forUser: notes.user.length, conflicts: conflicts.length, strays: strays.length };
  // Authorized work that is under way or waiting on the Captain, as opposed to cards nobody has started.
  const active = ctx.discussions.length + stats.rework + stats.review + stats.doing + cards.filter((c) => ['held', 'needs_check', 'quota'].includes(c.code)).length + stats.pending + stats.unconfirmed + stats.asks;
  // A session at work with no record behind it is not "nothing to do": it is the first thing
  // to look at. Neither is a task that was stopped and is all that is left.
  const plan = notes.paused.length ? 'paused' : active ? 'resume' : strays.length ? 'verify' : stats.todo + stats.paused ? 'backlog' : 'ready';
  return { ctx, cards, loose, strays, pending: [...redeliver, ...ctx.pending], unconfirmed, carried, asks, notes, entries, recorded, mtime, latestUser, unsorted, forCaptain, conflicts, stats, plan };
}

// ---- text ----
// The handoff is one overview page and a few detail files beside it. The page
// has a hard length limit and lists, newest and most useful first, what the
// Captain has to know now. Everything else moves to a detail file and leaves a
// count and where to read it on the page, so squeezing never makes an
// unfinished task, a question or a pause impossible to find.
const PLATFORM = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };
const HIGH = '【高优先级】';
const REASON = { relay: '席位 Relay', clear: '清空队长上下文', 'token-saver': '自动存档并清空上下文', restart: 'AgentDeck 重启', refresh: '队长运行 handoff' };
const DAY = 86400000;
// The user's profile is only pointed at, with its age; "maybe stale" after this many days.
const ABOUT_USER_FILE = '~/.agents/memory/about-user.md', ABOUT_STALE_DAYS = 14;
// The detail files, in the order the overview lists them.
const DETAIL_FILES = [
  { key: 'tasks', name: 'tasks.md', title: '未完成任务全表', read: '要派活，或查某张卡的状态、下一步、旧轮次时' },
  { key: 'waiting', name: 'waiting.md', title: '待处理明细（未读回执、已取走未确认的回执、队员提问、等队长拍板）', read: '处理提问和回执之前' },
  { key: 'needsUser', name: 'needs-user.md', title: '等用户决定清单', read: '要向用户汇报，或有事想问用户之前' },
  { key: 'delivery', name: 'delivery.md', title: '交付状态', read: '谈到版本、合并、打包、安装之前' },
  { key: 'history', name: 'decisions-history.md', title: '历史决定（决定文件里总览没引用的条目，一条一行）', read: '拿不准某件事是否被授权、叫停或取代时' },
  { key: 'messages', name: 'user-messages.md', title: '更早的用户消息摘录', read: '总览里的原话不够，要追上下文时' },
  { key: 'playbook', name: 'playbook.md', title: '接手动作、核对顺序和证据索引', read: '刚接班照着核对一遍；找原始数据在哪时' },
];
const WORDS = [{ n: 8, old: 120, last: 400 }, { n: 5, old: 90, last: 300 }, { n: 3, old: 60, last: 200 }, { n: 2, old: 50, last: 120 }, { n: 1, old: 0, last: 80 }];
// What the overview shows when nothing is squeezed, and the order things are given up when it does not fit.
// The user's latest words go last: they are the one thing the next Captain cannot get anywhere else.
// What the user paused or stopped is never given up: `paused` is how short each of its lines is (0 = fullest), not how many there are.
const FIRST = { recent: 3, longTerm: 4, delivery: 1, sessions: 12, items: 8, high: 10, paused: 0, w: 0 };
const SQUEEZE = [['recent', 1], ['recent', 0], ['longTerm', 0], ['delivery', 0], ['sessions', 5], ['sessions', 0],
  ['items', 5], ['items', 2], ['items', 0], ['high', 5], ['high', 2], ['high', 0], ['paused', 1], ['paused', 2],
  ['w', 1], ['w', 2], ['w', 3], ['w', 4]];
// A pause entry reads "what｜how far it reaches｜pointer". Per level: how much of its first two parts the page keeps
// (the line number in the decisions file always stays, so the rest is one read away). A task's title: how much is shown.
const PAUSE_PARTS = [[160], [60, 40], [40, 24]];
const PAUSE_TITLE = [30, 16, 10];
// Paused task states that are never squeezed off the page (see renderOverview).
const PINNED = ['stopped', 'needs_check', 'held'];
const SQUEEZED = { recent: '最近的决定', longTerm: '长期有效的决定', delivery: '最新交付状态', sessions: '在跑会话的名单',
  items: '提问、回执、返工、矛盾的明细行', high: '高优先级任务的明细行', paused: '暂停/叫停项每条的说明文字（每条都还在）', w: '用户原话的条数和长度' };

const detailDir = (ctx) => (ctx.paths.handoff || HANDOFF_FILE).replace(/\.md$/i, '');
const sepOf = (p) => (/\\/.test(p) && !/\//.test(p) ? '\\' : '/');
const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const size = (text) => Array.from(text).length;

// The detail files: the full text, with no length limit. Nothing here is squeezed.
function renderDetails(state) {
  const { ctx, stats, notes, entries } = state;
  const cli = ctx.cli;
  const when = (ms) => (ms ? clock(ms, ctx.timeZone).short : '时间未知');
  const now = clock(ctx.now, ctx.timeZone);
  const prev = ctx.captain.previousId || '';
  const who = (r) => `${r.role} ${r.id}（${r.state.label}${r.note ? '，' + r.note : ''}）`;
  const file = ctx.decisions.path || ctx.paths.decisions || DECISIONS_FILE;
  const noteWhen = ctx.decisions.error ? ctx.decisions.error + '，下面各项待核实' : state.mtime ? '最后修改 ' + when(state.mtime) : '还没有这份文件';
  const at = (e) => `L${e.line}｜`;
  const parts = {};
  let out;
  const begin = (key, ...head) => { out = parts[key] = [...head]; };
  const cut = (line, max = 300) => one(line, max) + (Array.from(one(line)).length > max ? '（全文见决定文件）' : '');
  // Entries newest first, the first `full` in full and the rest as one titled line each (with its line in the file).
  const entryList = (list, full, empty) => {
    if (!list.length) { out.push('  - ' + empty); return; }
    const sorted = newest(list);
    sorted.slice(0, full).forEach((e) => out.push(`  - ${at(e)}${cut(e.text, 500)}`));
    const rest = sorted.slice(full);
    if (rest.length) {
      out.push(`  - 更早的 ${rest.length} 条，只列标题；原文在 ${file} 的对应行：`);
      rest.forEach((e) => out.push(`    - ${at(e)}${one(e.text, 80)}`));
    }
  };

  // ---- playbook: meta, then what to do first ----
  begin('playbook', '# 接手动作、核对顺序和证据索引', '', '## 交接元信息');
  const relay = ctx.captain.message ? one(ctx.captain.message, 200) : ctx.captain.lastRelay?.message ? `最近一次轮换（${when(ctx.captain.lastRelay.at)}）：${one(ctx.captain.lastRelay.message, 200)}` : '';
  out.push(`- 生成：${now.date} ${now.time}（${now.zone}${offset(ctx.now, now.zone) ? '，' + offset(ctx.now, now.zone) : ''}）；触发：${REASON[ctx.reason]}${relay ? '；' + relay : ''}`);
  if (/\d\s*%/.test(relay)) out.push('- 上面的额度百分比是轮换那一刻的采样（来源：永动机轮换判定），只说明为什么轮换；现在的额度用 quota 查，不要拿它推算');
  out.push(`- 上任会话：${prev || '无'}${prev ? `（read --id ${prev} 按需读）` : ''}`);
  out.push(`- 快照版本：队长代次 gen ${ctx.captain.gen ?? '待核实'}${ctx.captain.nextGen ? ' → ' + ctx.captain.nextGen : ''}${ctx.boardVersion ? '；看板版本 ' + ctx.boardVersion : ''}。各份文件都取自这一份快照，另标了时间的除外`);
  out.push(`- 摘要：未完成任务 ${stats.cards + stats.loose} 条（返工 ${stats.rework}｜待验收 ${stats.review}｜执行中 ${stats.doing}｜暂停 ${stats.paused}｜待执行 ${stats.todo}）；在跑的队员会话 ${stats.running.length} 个；未读回执 ${stats.pending} 条；已取走未确认 ${stats.unconfirmed} 条；队员在等回答 ${stats.asks} 条；等用户决定 ${stats.forUser} 条；矛盾 ${stats.conflicts} 条${stats.important ? `；用户点名高优先级 ${stats.important} 条（tasks.md 里标了【高优先级】，先办）` : ''}`);
  if (ctx.dispatchCap && ctx.dispatches.length >= ctx.dispatchCap) out.push(`- 派活记录：本快照有 ${ctx.dispatches.length} 条。未结束的全部保留；已结束的只留最近的，更早的旧轮次和只记在派活记录里的外部审查结论不在这里，以看板卡片为准，细节 read --id 会话id`);
  out.push(`- 命令：下文的 handoff、ledger、read 等都接在 ${cli} 后面运行`);
  if (ctx.captain.rotation) out.push(`- 队长轮换：${one(ctx.captain.rotation, 160)}。谁接任队长只看这项设置，和队员用什么模型无关；交接不改它`);

  if (ctx.discussions.length) {
    out.push('', '### 进行中的讨论（私有原稿不进入交接）');
    for (const d of ctx.discussions) out.push(`- ${d.id}：${one(d.status, 30)}，第 ${Number(d.round) || 1} 轮；discuss status --id ${d.id} 核对，wait 等结果；暂停先查原因，unknown 不自动重发，resume/cancel 只针对原 ID。`);
  }

  // ---- delivery ----
  begin('delivery', '# 交付状态');
  out.push(`- 本机：${PLATFORM[ctx.platform] || ctx.platform || '待核实'}${ctx.host ? ' ' + ctx.host : ''}，正在运行 AgentDeck ${ctx.appVersion || '待核实'}（程序自报，取自本快照）。其他机器：待核实，本机看不到`);
  out.push(`- 队长记录的交付状态（来源 ${file}，${noteWhen}；最新的在前，最近 10 条全文）：`);
  entryList(entries.delivery, 10, '无记录，待核实');
  const withRefs = state.cards.filter((c) => c.refs.commits.length || c.refs.branches.length || c.refs.files.length);
  if (!withRefs.length) out.push('- 未完成任务的回执和进度里提到的分支、提交、产物：无');
  else {
    out.push('- 未完成任务的回执和进度里提到的分支、提交、产物（队员自述，程序没有核实；提交、合并、打包、安装各到哪一步都按待核实处理）：');
    for (const c of withRefs) {
      const files = c.refs.files.slice(0, 4);
      out.push(`  - ${c.id}｜${[c.refs.branches.length ? '分支 ' + c.refs.branches.join('、') : '', c.refs.commits.length ? '提交 ' + c.refs.commits.join('、') : '', files.length ? '产物 ' + files.join('、') : ''].filter(Boolean).join('｜')}${c.refs.more || files.length < c.refs.files.length ? '｜还有没列出的，见回执原文' : ''}`);
    }
  }

  // ---- tasks ----
  begin('tasks', `# 未完成任务全表（${stats.cards + stats.loose} 条，每张卡一条当前记录）`);
  const started = state.cards.filter((c) => c.started || c.group !== 'todo');
  const fresh = state.cards.filter((c) => !started.includes(c));
  if (ctx.boardError) out.push(`- 任务看板读不出来（${ctx.boardError}）：下面只有队长自己的派活记录，卡片状态待核实；修好看板文件后再跑 handoff`);
  if (!state.cards.length && !state.loose.length) out.push('无');
  for (const c of started) {
    const roles = c.roles.length ? c.roles.map(who).join('；') : '无';
    const blocked = [...c.blockers, ...c.conflicts.map((x) => '矛盾：' + x)];
    out.push(`- 【${c.label}】${c.important ? HIGH : ''}${c.id}｜${c.project}｜${one(c.title, 60)}`, `  会话：${roles}｜验收：${c.verdict.label}`);
    out.push(`  结果：${one(c.result, 200) || '无'}`, `  阻塞：${blocked.length ? blocked.join('；') : '无'}`, `  下一步：${c.next}`);
    if (c.history.length) out.push(`  旧轮次：${c.history.map((h) => `${h.id}（${h.outcome}）`).join('、')}；细节 read --id 会话id`);
  }
  if (fresh.length) {
    out.push(`- 【待执行】还没启动的 ${fresh.length} 张（在总览「现行有效的决定」的授权范围内且没被暂停时再派：new --task-id 卡片id）：`);
    for (const c of fresh) out.push(`  - ${c.important ? HIGH : ''}${c.id}｜${c.project}｜${one(c.title, 60)}${c.blockers.length ? '｜' + c.blockers.join('；') : ''}`);
  }
  for (const l of state.loose) {
    out.push(`- 【${l.label}】${l.important ? HIGH : ''}没挂卡｜${l.project || '无项目'}｜${one(l.title, 60)}｜${l.id ? `${l.reviewer ? '审查' : '执行'} ${l.id}（${l.state.label}）` : '还没开会话'}${l.result ? '｜结果：' + one(l.result, 200) : ''}｜下一步：${l.next}`);
  }
  if (state.strays.length) out.push(`- 在跑、但没有对应未完成任务记录的会话：${state.strays.map((s) => `${s.id}「${one(s.title, 24)}」（${s.state.label}）`).join('、')}。用 peek 看它在做什么`);

  // ---- waiting ----
  begin('waiting', '# 待处理明细');
  const item = (p) => `  - ${pendingKind(p)}｜${p.colId || ''}｜「${one(p.title, 30)}」｜${one(pendingLine(p), 100)}`;
  // Every waiting receipt is named. Past the first 40 of a list the rest go by
  // session and title only, so a long list costs little and nobody's result is cut off.
  const receipts = (items) => {
    items.slice(0, 40).forEach((p) => out.push(item(p)));
    const rest = items.slice(40);
    if (!rest.length) return;
    const bySession = new Map();
    for (const p of rest) bySession.set(p.colId || '会话未知', [...(bySession.get(p.colId || '会话未知') || []), p]);
    out.push(`  - 其余 ${rest.length} 条只列会话和标题，内容用 read --id 会话id 查：${[...bySession].map(([id, ps]) => id + ps.map((p) => `${pendingKind(p) === '回执' ? '' : pendingKind(p)}「${one(p.title, 40)}」`).join('')).join('；')}`);
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
  if (!state.asks.length) out.push('- 队员在等队长回答：无');
  else {
    out.push(`- 队员在等队长回答 ${state.asks.length} 条（卡着后续动作，先处理：已有授权能定或有把握的直接 tell / answer 回答，涉及不可逆的事或拿不准的才请用户决定）：`);
    state.asks.forEach((a) => out.push(`  - ${a.kind}｜${a.id || '会话未知'}｜${a.cardId ? a.cardId + '｜' : ''}「${one(a.title, 30)}」${a.text ? '｜' + one(a.text, 100) : a.id ? `｜peek --id ${a.id}` : ''}${a.cardId ? '｜' + (a.blocks?.length ? '阻塞 ' + a.blocks.join('、') : '不阻塞其他卡') : ''}`));
  }
  if (!state.forCaptain.length) out.push('- 等队长拍板（已有授权能解决，不要转给用户）：无');
  else out.push(`- 等队长拍板 ${state.forCaptain.length} 条（已有授权能解决，不要转给用户）：${state.forCaptain.map((c) => `${c.id}（${c.label}）`).join('、')}`);

  // ---- needs the user: only what the Captain wrote down. A crew question is not one until the Captain says so ----
  begin('needsUser', '# 等用户决定清单', `来源：队长维护的 ${file}（${noteWhen}）。只列队长记下的；队员的提问先归队长判断，见 waiting.md。`);
  if (!notes.user.length) out.push('- 无（队长没有记录）');
  else entries.user.forEach((e) => out.push(`- ${at(e)}${cut(e.text, 500)}`));

  // ---- the user's words beyond the overview ----
  begin('messages', '# 更早的用户消息摘录', '原文指针，程序没有整理；全文用 read --id 会话id --find 关键词 查。');
  const olderTurns = ctx.userTurnsOlder ? '；更早的没有统计在内，read --id captain-history --find 关键词' : '';
  if (!ctx.userTurns.length) out.push('- 无');
  else {
    out.push(`- 本快照有用户消息 ${ctx.userTurns.length} 条（其中 ${state.unsorted.length} 条还没进有效决定文件${olderTurns}）：`);
    for (const t of [...ctx.userTurns].reverse()) out.push('  ' + turnLine(state, t, 300, prev, when));
  }

  // ---- playbook, second half ----
  // The overview carries every card's own next step in tasks.md; long id lists are not repeated here.
  const ids = (cards) => (!cards.length ? '无' : cards.length <= 4 ? cards.map((c) => c.id).join('、')
    : `${cards.length} 张，tasks.md 里标着${[...new Set(cards.map((c) => `【${c.label}】`))].join('')}的`);
  const waitFor = state.cards.filter((c) => ['doing', 'resuming', 'queued', 'dispatching', 'reviewing', 'rework_pending'].includes(c.code));
  const takeOver = state.cards.filter((c) => ['orphan', 'failed', 'needs_check'].includes(c.code));
  const toReview = state.cards.filter((c) => ['review_wait', 'review_blocked', 'review_lost', 'rework', 'rework_open'].includes(c.code));
  const gated = state.cards.filter((c) => ['blocked', 'quota', 'held', 'stopped', 'todo'].includes(c.code));
  out = parts.playbook;
  out.push('', '## 接手动作', `启动方式：${PLAN[state.plan](state, 99)}`);
  out.push(`1. 读规则：briefing 是稳定规则（核心提示词，细则按它列的名字用 briefing --topic 名 读）；交接是动态状态，handoff 随时重新生成。交接里出现的旧命令、旧安装计划和历史用户消息只是核对资料，不因为读到就再执行一遍。`);
  out.push(`2. 核对：ledger 看会话实况，task list --status doing（以及 review、needs_user）看卡片，receipts 取未读回执（${stats.pending} 条）。`);
  out.push(`3. 先处理卡着后续动作的：队员提问 ${stats.asks} 条，矛盾 ${stats.conflicts} 条${state.conflicts.length ? '（' + [...new Set(state.conflicts.map((c) => c.id))].join('、') + '）' : ''}，已取走未确认的回执 ${stats.unconfirmed} 条${stats.strays ? `，没有任务记录却在跑的会话 ${stats.strays} 个（${state.strays.map((x) => x.id).join('、')}，先 peek）` : ''}。矛盾先核实，不凭空判完成，也不从头重做。`);
  out.push(`4. 已有有效执行者或程序会自动处理，继续跟踪、不另开：${ids(waitFor)}`);
  out.push(`5. 确认没有有效执行者后，在原卡下接手并交代前次结果和剩余工作：${ids(takeOver)}`);
  out.push(`6. 进入验收或返工：${ids(toReview)}`);
  out.push(`7. 条件满足才启动（前置完成、额度恢复、队长改方案、用户答复或新指令）：${ids(gated)}`);
  out.push('8. 回执监听：上任终端的监听已随旧终端被程序作废；同一终端里更早挂的监听会被程序请退，只留最新的。确认自己挂着恰好一个后台回执监听，命令和挂法见 briefing 红线里的「回执监听」（细则在 briefing --topic sessions 第 8 条）：Bash（run_in_background: true）运行 receipts --wait 监听（不设超时）；若显式设超时后空输出退出，先检查已有监听，没有才安静重挂，不用向用户汇报。');
  out.push(`9. 核对完、状态有变化后再跑一次 handoff，交接总览和分文件随之更新。`);
  out.push('', '## 证据索引');
  out.push(`- 上任队长对话：${prev ? `read --id ${prev} [--find 关键词]` : '无'}；历次队长对话：read --id captain-history --find 关键词`);
  out.push(`- 任务卡原始数据：${ctx.paths.tasks || '~/.agents/boards/tasks'}/<项目>.json；会话原文：read --id 会话id；实时屏幕：peek --id 会话id`);
  out.push(`- 有效决定与交付状态：${file}；交接总览：${ctx.paths.handoff || HANDOFF_FILE}；分文件目录：${detailDir(ctx)}${ctx.paths.chats ? '；对话存档目录：' + ctx.paths.chats : ''}`);
  const files = [...new Set(state.cards.flatMap((c) => c.refs.files))];
  if (files.length) out.push(`- 未完成任务提到的报告和产物：${files.slice(0, 12).join('、')}${files.length > 12 ? ` 等 ${files.length} 个` : ''}`);

  // ---- history: every decision the overview does not quote ----
  begin('history', '# 历史决定', '');
  // Every entry the file has under these headings is one line here, with its line number: only how much of it is quoted
  // gets shorter. The count the contents page gives is the number of lines counted as they are written.
  let listed = 0;
  const section = (title, list, whole) => {
    if (!list.length) return;
    out.push('', `## ${title}（共 ${list.length} 条）`);
    newest(list).forEach((e) => out.push(`- ${at(e)}${whole ? one(e.text) : one(e.text, 80)}`));
    listed += list.length;
  };
  section('暂停/取消/暂不启动（生效中，全文）', entries.paused, true);
  section('当前目标', entries.goal);
  section('授权范围', entries.scope);
  section('有效决定', entries.decisions);
  section('其他记录', entries.other);
  parts.history[1] = `来源：队长维护的 ${file}（${noteWhen}），整份 ${num(size(ctx.decisions.text || ''))} 字。程序不改它。本文件逐条列出 ${listed} 条，一条不缺、不设条数上限（交付状态在 delivery.md，等用户决定在 needs-user.md）；总览引用过的条目这里也有；每条前面的 L 数字是它在原文件里的行号。`;
  return { parts, notes: { file, noteWhen, listed } };
}

// One line of the user's words: when, an excerpt, and the command that reads the whole.
function turnLine(state, t, max, prev, when) {
  const words = one(t.text).replace(/["\\`$]/g, '');
  const find = Array.from(words.split(' ')[0] || '').slice(0, 12).join('');
  const length = Array.from(t.text).length;
  return `- ${when(t.ts)}${state.unsorted.includes(t) ? ' 未整理' : ''}｜「${one(t.text, max)}」${length > max ? `（共 ${length} 字${t.longFile ? '，全文 ' + t.longFile : ''}）` : ''}｜read --id ${t.sourceId || prev || '上任会话'}${find ? ` --find "${find}"` : ''}`;
}

// What to do first, one line per case. `cap` is how many ids a line may name.
const PLAN = {
  paused: () => '「现行有效的决定」里有生效中的暂停或取消项：这些事项不续派、不重启，运行中的会话和旧的续活计划都不能推翻它。其余已授权任务照核对顺序核对后续接；范围拿不准先问用户。',
  resume: () => '有已授权待办：照 playbook.md 的顺序核对后主动续接，不用等用户说继续。',
  verify: (state, cap) => `有 ${state.stats.strays} 个会话还在跑、却没有对应的任务记录（${state.strays.slice(0, cap).map((x) => x.id).join('、')}${state.strays.length > cap ? ' 等' : ''}）：先 peek 核实它在做什么，再决定继续跟踪还是叫停；核实前不要报告就绪，也不要另派同样的活。`,
  backlog: (state) => `没有在跑、待验收或待处理的任务，有 ${state.stats.todo} 张待执行卡${state.stats.paused ? `、${state.stats.paused} 条暂停中的任务` : ''}：属于授权范围且没被暂停的${state.stats.paused ? '待执行卡' : ''}可以启动，范围不明先问；${state.stats.paused ? '暂停的没有新指令不重启，照 tasks.md 里各自的下一步处理；' : ''}不要为了凑数新立项目。`,
  ready: () => '没有待办：简短回复「队长已就绪」，等用户指令；不要自行立项或派新活。',
};

// The overview page. `p` says how much of each block is shown; `cuts` is what has been given up so far.
function renderOverview(state, details, p, cuts) {
  const { ctx, stats, notes, entries } = state;
  const when = (ms) => (ms ? clock(ms, ctx.timeZone).short : '时间未知');
  const now = clock(ctx.now, ctx.timeZone);
  const prev = ctx.captain.previousId || '';
  const dir = detailDir(ctx), sep = sepOf(dir);
  const file = details.notes.file;
  const out = [];
  const quoted = new Set();

  out.push('# AgentDeck 队长交接·总览', '');
  const relay = ctx.captain.message ? one(ctx.captain.message, 160) : ctx.captain.lastRelay?.message ? `最近一次轮换（${when(ctx.captain.lastRelay.at)}）：${one(ctx.captain.lastRelay.message, 160)}` : '';
  out.push(`生成 ${now.date} ${now.time}（${now.zone}）｜触发：${REASON[ctx.reason]}${relay ? '｜' + relay : ''}｜上任会话 ${prev || '无'}${prev ? `（read --id ${prev}）` : ''}｜队长代次 gen ${ctx.captain.gen ?? '待核实'}${ctx.captain.nextGen ? ' → ' + ctx.captain.nextGen : ''}`);
  out.push(`这页只是总览，最长 ${num(state.ctx.limit)} 字。细节拆在 ${dir}${sep} 下的分文件里，见最后一节「目录」，按需读，不用全读。命令都接在 ${ctx.cli} 后面运行。{{LENGTH}}`);

  if (ctx.discussions.length) {
    out.push('', '## 进行中的讨论（私有原稿不进入交接）');
    for (const d of ctx.discussions) out.push(`- ${d.id}：${one(d.status, 30)}，第 ${Number(d.round) || 1} 轮；discuss status --id ${d.id} 核对，wait 等结果；暂停先查原因，unknown 不自动重发，resume/cancel 只针对原 ID。`);
  }

  // 0 who you serve: a pointer only. The profile is read when it is needed, never on every handover.
  if (ctx.aboutUser) {
    const age = Number.isFinite(ctx.aboutUser.mtime) && ctx.aboutUser.mtime > 0 ? Math.floor((ctx.now - ctx.aboutUser.mtime) / DAY) : null;
    out.push('', `关于用户：${ABOUT_USER_FILE}（短档案）及 about-user/ 下按主题的详档，需要了解他的偏好、近况时再读｜${age == null ? '修改时间未知' : '最后修改 ' + when(ctx.aboutUser.mtime)}${age != null && age > ABOUT_STALE_DAYS ? `（可能过期：已 ${age} 天没更新）` : ''}`);
  }

  // 1 the user's latest words, newest first
  const W = WORDS[p.w];
  out.push('', '## 1. 用户最近的原话（最新的在最前，程序没有整理）');
  if (!ctx.userTurns.length) out.push('- 无（本快照里没有用户消息）');
  else {
    const turns = [...ctx.userTurns].reverse(), shown = turns.slice(0, W.n);
    out.push(`本快照有用户消息 ${ctx.userTurns.length} 条，其中 ${state.unsorted.length} 条还没进决定文件${ctx.userTurnsOlder ? '，更早的没有统计在内' : ''}：`);
    shown.forEach((t, i) => out.push(turnLine(state, t, i === 0 ? W.last : W.old, prev, when)));
    if (turns.length > shown.length) out.push(`- 另有 ${turns.length - shown.length} 条没摘录：user-messages.md（每条 300 字）；原文 read --id ${turns[shown.length].sourceId || prev || '上任会话'} --turns 10`);
    else if (ctx.userTurnsOlder) out.push('- 更早的：read --id captain-history --find 关键词');
  }

  // 2 running sessions and what waits for the Captain
  out.push('', '## 2. 在跑的会话，和等你处理的事');
  out.push(`- 数一数：未完成任务 ${stats.cards + stats.loose} 条（返工 ${stats.rework}｜待验收 ${stats.review}｜执行中 ${stats.doing}｜暂停 ${stats.paused}｜待执行 ${stats.todo}）→ tasks.md｜队员提问 ${stats.asks} 条｜未读回执 ${stats.pending} 条｜已取走未确认 ${stats.unconfirmed} 条｜矛盾 ${stats.conflicts} 条｜等队长拍板 ${state.forCaptain.length} 条 → waiting.md｜等用户决定 ${stats.forUser} 条 → needs-user.md`);
  const running = stats.running.map((id) => ({ id, title: String(ctx.sessions.get(id)?.title || '') }));
  if (!running.length) out.push('- 在跑的队员会话：0 个');
  else if (!p.sessions) out.push(`- 在跑的队员会话 ${running.length} 个：ledger 看实况，对应的任务在 tasks.md`);
  else out.push(`- 在跑的队员会话 ${running.length} 个：${running.slice(0, p.sessions).map((r) => r.id + (r.title && r.title !== r.id ? `「${one(r.title, 16)}」` : '')).join('、')}${running.length > p.sessions ? `，另 ${running.length - p.sessions} 个见 ledger` : ''}`);
  const lines = (title, list, line) => {
    if (!list.length || !p.items) return;
    out.push(`- ${title}：`);
    list.slice(0, p.items).forEach((x) => out.push('  - ' + line(x)));
    if (list.length > p.items) out.push(`  - 另 ${list.length - p.items} 条见 ${title.includes('回执') ? 'waiting.md' : 'tasks.md / waiting.md'}`);
  };
  lines(`队员提问 ${stats.asks} 条（先处理，已有授权能定的直接回答）`, state.asks, (a) => `${a.kind}｜${a.id || '会话未知'}｜${a.cardId ? a.cardId + '｜' : ''}「${one(a.title, 20)}」${a.text ? '｜' + one(a.text, 60) : ''}`);
  lines(`未读和未确认的回执 ${stats.pending + stats.unconfirmed} 条`, [...state.pending, ...state.unconfirmed], (r) => `${pendingKind(r)}｜${r.colId || ''}｜「${one(r.title, 20)}」｜${one(pendingLine(r), 50)}`);
  lines(`返工 ${stats.rework} 条`, state.cards.filter((c) => c.group === 'rework'), (c) => `${c.id}｜${c.label}｜${one(c.title, 24)}`);
  lines(`矛盾 ${stats.conflicts} 条（先核实）`, state.conflicts, (c) => `${c.id}｜${one(c.text, 70)}`);
  lines(`等队长拍板 ${state.forCaptain.length} 条（别转给用户）`, state.forCaptain, (c) => `${c.id}｜${c.label}｜${one(c.title, 24)}`);
  lines(`没有任务记录却在跑的会话 ${stats.strays} 个（先 peek）`, state.strays, (s) => `${s.id}｜${one(s.title, 24)}｜${s.state.label}`);
  out.push(`- 启动方式：${PLAN[state.plan](state, 5)}`);

  // 3 what the user named as urgent
  const high = [...state.cards.filter((c) => c.important).map((c) => `${c.label.split('（')[0]}｜${c.id}｜${c.project}｜${one(c.title, 30)}`), ...state.loose.filter((l) => l.important).map((l) => `${l.label.split('（')[0]}｜没挂卡｜${l.project || '无项目'}｜${one(l.title, 30)}`)];
  if (high.length) {
    out.push('', `## 3. 用户点名的高优先级（${high.length} 条，先办）`);
    high.slice(0, p.high).forEach((l) => out.push(`- ${HIGH}${l}`));
    if (high.length > p.high) out.push(`- ${p.high ? '另 ' + (high.length - p.high) + ' 条' : '全部'}见 tasks.md（标了${HIGH}）`);
  }

  // 4 decisions in force: pauses, then lasting ones, then the newest few; the rest by pointer
  out.push('', '## 4. 现行有效的决定（队长维护的决定文件，程序只读）');
  const stale = state.unsorted.length && state.recorded ? `；此后还有 ${ctx.userTurnsOlder && state.unsorted.length === ctx.userTurns.length ? '至少 ' : ''}${state.unsorted.length} 条用户消息没整理进来，以原文为准` : '';
  out.push(`来源 ${file}（${ctx.decisions.error ? ctx.decisions.error + '，下面各项待核实' : state.mtime ? '最后修改 ' + when(state.mtime) : '还没有这份文件'}${stale}）。给条目开头标「长期」，它就一直留在这页。`);
  const quote = (e, max = 160) => { quoted.add(e); return `L${e.line}｜${one(e.text, max)}${Array.from(one(e.text)).length > max ? '…' : ''}`; };
  // A pause is quoted whole while there is room, then as what it stops and how far it reaches, always with its line.
  const pauseLine = (e) => {
    if (!p.paused) return quote(e);
    quoted.add(e);
    const parts = one(e.text).split('｜'), [first, second] = PAUSE_PARTS[p.paused];
    const head = parts.length > 1 ? [one(parts[0], first), one(parts[1], second)] : [one(parts[0], first + second)];
    return `L${e.line}｜${head.join('｜')}${parts.length > 2 ? '｜…' : ''}`;
  };
  out.push(`- 暂停/取消/暂不启动 ${entries.paused.length} 条${entries.paused.length ? '（生效中：不续派、不重启，没有新指令不推翻；一条不省，全文见 decisions-history.md）：' : ''}`);
  newest(entries.paused).forEach((e) => out.push('  - ' + pauseLine(e)));
  // The paused tasks that wait on the Captain's call, every one named here whatever else is squeezed: stopped by the Captain
  // (stop or archive; the user's call), waiting for the Captain to check them, or hung after two failures. Each keeps its id,
  // project, the start of its title and where it is stuck (the label).
  const halted = [...state.cards.filter((c) => PINNED.includes(c.code)).map((c) => ({ id: c.id, label: c.label, tag: c.important ? HIGH : '', where: c.project, title: c.title })),
    ...state.loose.filter((l) => l.halted).map((l) => ({ id: `没挂卡 ${l.id}`, label: l.label, tag: l.important ? HIGH : '', where: l.project || '无项目', title: l.title }))];
  if (halted.length) {
    out.push(`- 暂停中的任务 ${halted.length} 条（被叫停的不重派、没有新指令不重启；待核实、连续失败挂起的等队长处理，别漏也别重复派；一条不省，各自的下一步在 tasks.md）：`);
    for (const h of halted) out.push('  - ' + [h.tag + h.id, h.label, h.where, one(h.title, PAUSE_TITLE[p.paused])].join('｜'));
  }
  const live = [...entries.goal, ...entries.scope, ...entries.decisions];
  const long = newest(live.filter(lasting)), recent = newest(live.filter((e) => !lasting(e) && e.ts));
  if (p.longTerm && long.length) { out.push(`- 长期有效 ${long.length} 条：`); long.slice(0, p.longTerm).forEach((e) => out.push('  - ' + quote(e))); }
  if (p.recent && recent.length) { out.push(`- 最近的目标、授权和决定（按时间，最新 ${Math.min(p.recent, recent.length)} 条）：`); recent.slice(0, p.recent).forEach((e) => out.push('  - ' + quote(e))); }
  if (p.delivery && entries.delivery.length) out.push(`- 最新交付状态：${quote(newest(entries.delivery)[0])}（更多见 delivery.md）`);
  const rest = Object.values(entries).flat().length - quoted.size - entries.user.length;
  out.push(`- 其余 ${Math.max(0, rest)} 条（目标、授权、决定、交付、其他记录里更早的）和 ${entries.user.length} 条等用户决定的事：只留标题和行号，在 decisions-history.md、delivery.md、needs-user.md；整份原文 ${num(size(ctx.decisions.text || ''))} 字`);

  // 5 the table of contents
  out.push('', '## 5. 目录（其余内容都在这些分文件里，按需读）');
  for (const f of DETAIL_FILES) out.push(`- ${f.name}｜${num(size(details.texts[f.key]))} 字｜${f.title.replace(/（.*）/, '')}，${details.counts[f.key]}｜${f.read}读`);
  out.push(`目录位置：${dir}${sep}`);
  const gone = [...new Set(cuts)].map((k) => SQUEEZED[k]);
  return out.join('\n') + '\n' + (gone.length ? `\n（为了放进 ${num(state.ctx.limit)} 字，缩短了：${gone.join('、')}。计数都还在上面，明细在对应分文件里。）\n` : '')
    + (p.over ? `\n（已超出预算：未完成任务、阻塞、限制和待决定事项一条没删，暂停/取消/叫停的事项也必须全部留在这页，所以这页超过了 ${num(state.ctx.limit)} 字。）\n` : '');
}

// The overview at its fullest, then squeezed step by step until it fits. The
// detail files are never squeezed.
function build(snapshot) {
  const state = derive(snapshot);
  const limit = state.ctx.limit;
  const { parts, notes } = renderDetails(state);
  const texts = Object.fromEntries(Object.entries(parts).map(([key, lines]) => [key, lines.join('\n') + '\n']));
  const counts = { tasks: `${state.stats.cards + state.stats.loose} 条`, waiting: `提问 ${state.stats.asks}、回执 ${state.stats.pending + state.stats.unconfirmed}`, needsUser: `${state.stats.forUser} 条`,
    delivery: `${state.notes.delivery.length} 条记录`, history: `逐条列出 ${notes.listed} 条（决定文件共 ${Object.values(state.notes).flat().length} 条，其余在 delivery.md、needs-user.md）`, messages: `${state.ctx.userTurns.length} 条`, playbook: '9 步' };
  const details = { notes, texts, counts };
  const p = { ...FIRST }, cuts = [];
  const draw = () => {
    const note = (n) => `本页 ${num(n)} 字（上限 ${num(limit)}）。`;
    const text = renderOverview(state, details, p, cuts);
    const fit = text.replace('{{LENGTH}}', note(limit)); // wide enough for the real number
    return text.replace('{{LENGTH}}', note(size(fit)));
  };
  let text = draw();
  for (const [key, value] of SQUEEZE) {
    if (size(text) <= limit) break;
    p[key] = value; cuts.push(key); text = draw();
  }
  // What the user paused or stopped stays on the page even when that alone is longer than the limit; the page says so.
  const over = size(text) > limit;
  if (over) { p.over = true; text = draw(); }
  const files = DETAIL_FILES.map((f) => ({ name: f.name, key: f.key, title: f.title, read: f.read, text: details.texts[f.key], length: size(details.texts[f.key]) }));
  return { text, length: size(text), limit, over, cuts: [...cuts], files, dir: detailDir(state.ctx), state };
}

module.exports = { budget, DECISIONS_FILE, HANDOFF_FILE, DECISIONS_TEMPLATE, DETAIL_FILES, SQUEEZE, ABOUT_USER_FILE, ABOUT_STALE_DAYS, GROUP_NAME,
  parseDecisions, parseDecisionEntries, refsIn, sessionState, deriveCard, derive, build, bookkeeping, captainStopped, isReviewer };
