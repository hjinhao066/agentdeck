// 待我处理: what the AI hands back to the user. Two kinds of item:
//   need   要你处理: something only the user can do (decide, log in, pay, answer)
//   report 结果汇报: the short conclusion 队长 would otherwise only say in its chat
// Items come from 队长 (`inbox need|report`, and every `notify-user`) and from
// the task board itself (a card waiting in 需要你, a card held after two failed
// rounds). They live in this computer's config.json (`config.attention`), next
// to the conversations they summarize; nothing here is ever sent to git.
//
// An item leaves 待处理 and is ticked into 已完成 when:
//   - the user ticks it (已处理 / 知道了) or replies to it (the reply goes to 队长);
//   - 队长 resolves it (`inbox resolve`);
//   - the card it names is done or archived (need items only: a report is
//     usually about a card that just finished);
//   - a card-derived item's card is no longer waiting on the user;
//   - the session it names was waiting on an answer when it was filed and no
//     longer is.
// Pure functions, no DOM: runs in the page, the main process and tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AttentionCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const KINDS = ['need', 'report'];
  // What a need item asks of the user, in the words the page shows.
  const TYPES = {
    decide: '等你拍板',
    login: '等你登录或授权',
    pay: '等你付款',
    question: '等你回答',
    review: '验收卡住了',
    other: '要你处理',
  };
  const REPORT_LABEL = '结果汇报';
  const LIMITS = { title: 300, ask: 1000, detail: 8000, note: 500, reply: 4000, files: 20, path: 1024, project: 120 };
  const KEEP_DONE = 200;
  const ID = /^at-[a-z0-9-]{4,40}$/;
  const REF = /^[A-Za-z0-9_-]{1,160}$/;
  const DONE_BY = ['user', 'reply', 'captain', 'card', 'session'];
  const SOURCES = ['captain', 'notify', 'card'];

  const isTime = (v) => Number.isSafeInteger(v) && v > 0;
  // One line: runs of whitespace (line breaks too) become one space.
  const line = (v) => String(v == null ? '' : v).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  // A block keeps its line breaks; other control characters go.
  const block = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const clip = (s, max) => ([...s].length > max ? [...s].slice(0, max - 1).join('') + '…' : s);

  // ---- store -------------------------------------------------------------
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID.test(raw.id) || !KINDS.includes(raw.kind)) return null;
    const title = clip(line(raw.title), LIMITS.title);
    if (!title || !isTime(raw.created)) return null;
    const item = {
      id: raw.id, kind: raw.kind,
      type: raw.kind === 'need' ? (Object.prototype.hasOwnProperty.call(TYPES, raw.type) ? raw.type : 'other') : '',
      title,
      ask: raw.kind === 'need' ? clip(line(raw.ask), LIMITS.ask) : '',
      detail: clip(block(raw.detail), LIMITS.detail),
      files: (Array.isArray(raw.files) ? raw.files : []).map((f) => line(f)).filter((f) => f && f.length <= LIMITS.path).slice(0, LIMITS.files),
      project: clip(line(raw.project), LIMITS.project),
      card: typeof raw.card === 'string' && REF.test(raw.card) ? raw.card : '',
      cardTitle: clip(line(raw.cardTitle), LIMITS.title),
      session: typeof raw.session === 'string' && REF.test(raw.session) ? raw.session : '',
      sessionTitle: clip(line(raw.sessionTitle), LIMITS.title),
      sessionWaiting: raw.sessionWaiting === true,
      source: SOURCES.includes(raw.source) ? raw.source : 'captain',
      key: typeof raw.key === 'string' ? raw.key.slice(0, 400) : '',
      created: raw.created,
      updated: isTime(raw.updated) ? raw.updated : raw.created,
      readAt: isTime(raw.readAt) ? raw.readAt : 0,
      done: raw.done === true,
      doneAt: raw.done === true && isTime(raw.doneAt) ? raw.doneAt : 0,
      doneBy: raw.done === true && DONE_BY.includes(raw.doneBy) ? raw.doneBy : '',
      doneNote: raw.done === true ? clip(line(raw.doneNote), LIMITS.note) : '',
      replies: (Array.isArray(raw.replies) ? raw.replies : []).filter((r) => r && typeof r.text === 'string' && isTime(r.at))
        .map((r) => ({ text: clip(block(r.text), LIMITS.reply), at: r.at, from: r.from === 'phone' ? 'phone' : 'desktop', notice: typeof r.notice === 'string' ? r.notice.slice(0, 120) : '', seen: r.seen === true })).slice(-20),
    };
    return item;
  }
  // The stored shape: { version, items }. Whatever cannot be one of ours is dropped.
  function normalize(raw) {
    const seen = new Set();
    const items = [];
    for (const value of (raw && Array.isArray(raw.items) ? raw.items : [])) {
      const item = normalizeItem(value);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return { version: VERSION, items };
  }
  function newId(now, random) {
    const rand = String(random || Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9]/g, '').slice(0, 8) || 'x';
    return 'at-' + now.toString(36) + '-' + rand;
  }
  const byId = (store, id) => store.items.find((item) => item.id === id) || null;

  // A new item from 队长 (or from the board). Refuses rather than trims what
  // 队长 wrote: the CLI tells it to say it shorter. The same open need/report
  // filed twice (say `inbox need` and `notify-user` for one login) is one item.
  function add(store, input, now, random) {
    const kind = input && input.kind;
    if (!KINDS.includes(kind)) throw new Error('条目类型只能是 need（要用户处理）或 report（结果汇报）。');
    const title = line(input.title);
    if (!title) throw new Error('需要 --title：一句话结论。');
    if ([...title].length > LIMITS.title) throw new Error(`--title 最多 ${LIMITS.title} 字，只写一句话结论；细节放 --detail。`);
    const ask = kind === 'need' ? line(input.ask) : '';
    if ([...ask].length > LIMITS.ask) throw new Error(`--ask 最多 ${LIMITS.ask} 字。`);
    const detail = block(input.detail);
    if ([...detail].length > LIMITS.detail) throw new Error(`--detail 最多 ${LIMITS.detail} 字，长内容写进文件再用 --files 给路径。`);
    const files = (Array.isArray(input.files) ? input.files : []).map((f) => line(f)).filter(Boolean);
    if (files.length > LIMITS.files || files.some((f) => f.length > LIMITS.path)) throw new Error(`--files 最多 ${LIMITS.files} 个路径。`);
    const type = kind === 'need' ? (input.type || 'other') : '';
    if (kind === 'need' && !Object.prototype.hasOwnProperty.call(TYPES, type)) throw new Error('--type 只能是 ' + Object.keys(TYPES).join('|') + '。');
    for (const key of ['card', 'session']) {
      if (input[key] && !(typeof input[key] === 'string' && REF.test(input[key]))) throw new Error(`--${key} 不是有效的 id。`);
    }
    const project = line(input.project);
    if ([...project].length > LIMITS.project) throw new Error('--project 太长。');
    const same = store.items.find((item) => !item.done && item.kind === kind && item.title === title && item.ask === ask && (item.card || '') === (input.card || ''));
    if (same) return { item: same, created: false };
    const item = normalizeItem({
      id: newId(now, random), kind, type, title, ask, detail, files, project,
      card: input.card || '', cardTitle: input.cardTitle, session: input.session || '', sessionTitle: input.sessionTitle,
      sessionWaiting: input.sessionWaiting === true, source: SOURCES.includes(input.source) ? input.source : 'captain', key: input.key || '',
      created: now, updated: now,
    });
    store.items.push(item);
    // 队长's own words about a card replace what the board would say about it.
    if (item.kind === 'need' && item.card && item.source !== 'card') {
      for (const other of store.items) {
        if (!other.done && other.source === 'card' && other.card === item.card) finish(other, 'captain', '队长改登记成了新的一条', now);
      }
    }
    return { item, created: true };
  }

  function finish(item, by, note, now) {
    item.done = true; item.doneAt = now; item.doneBy = by; item.doneNote = clip(line(note), LIMITS.note); item.updated = now;
    if (!item.readAt) item.readAt = now;
  }
  function resolve(store, id, by, note, now) {
    const item = byId(store, id);
    if (!item) throw new Error('没有这一条：' + String(id).slice(0, 60) + '。用 inbox list 看现有条目。');
    if (!DONE_BY.includes(by)) throw new Error('Invalid resolver.');
    if (item.done) return { item, changed: false };
    finish(item, by, note, now);
    return { item, changed: true };
  }
  // Back to 待处理 from 已完成; it counts as read, the user just looked at it.
  function reopen(store, id, now) {
    const item = byId(store, id);
    if (!item) throw new Error('这一条已经不在了。');
    if (!item.done) return { item, changed: false };
    item.done = false; item.doneAt = 0; item.doneBy = ''; item.doneNote = ''; item.updated = now;
    item.readAt = item.readAt || now;
    return { item, changed: true };
  }
  function markRead(store, ids, now) {
    let changed = 0;
    for (const id of ids || []) {
      const item = byId(store, id);
      if (item && !item.readAt) { item.readAt = now; changed++; }
    }
    return changed;
  }
  // The user's own words on an item. It is ticked at once: what they asked for
  // (「我回复了，它就打勾归到已完成」). `notice` is the receipt that carries it to 队长.
  function reply(store, id, text, from, now, notice) {
    const item = byId(store, id);
    if (!item) throw new Error('这一条已经不在了，刷新一下再看。');
    const body = block(text);
    if (!body) throw new Error('先写下你的回复。');
    if ([...body].length > LIMITS.reply) throw new Error(`回复最多 ${LIMITS.reply} 字。`);
    item.replies.push({ text: body, at: now, from: from === 'phone' ? 'phone' : 'desktop', notice: notice || '', seen: false });
    if (item.replies.length > 20) item.replies = item.replies.slice(-20);
    if (!item.done) finish(item, 'reply', '你已回复，交给队长了', now);
    else item.updated = now;
    if (!item.readAt) item.readAt = now;
    return { item };
  }
  // Replies whose receipt 队长 has taken off the channel: it has read them.
  function markRepliesSeen(store, pendingIds) {
    let changed = 0;
    const waiting = new Set(pendingIds || []);
    for (const item of store.items) for (const r of item.replies) {
      if (r.notice && !r.seen && !waiting.has(r.notice)) { r.seen = true; changed++; }
    }
    return changed;
  }
  // Oldest finished items go first; nothing still open is ever dropped.
  function prune(store, keep = KEEP_DONE) {
    const done = store.items.filter((i) => i.done).sort((a, b) => b.doneAt - a.doneAt);
    if (done.length <= keep) return 0;
    const drop = new Set(done.slice(keep).map((i) => i.id));
    store.items = store.items.filter((i) => !drop.has(i.id));
    return drop.size;
  }

  // `notify-user --message` files a need item too: whatever 队长 alerts the user
  // about is something only the user can do. The first sentence is the title.
  function notifyItem(message) {
    const text = block(message);
    const first = line(text.split(/(?<=[。！？!?])|\n/u).map((p) => p.trim()).find(Boolean) || text);
    const title = clip(first, LIMITS.title);
    const type = /付款|支付|充值|续费|付费|余额/.test(text) ? 'pay' : /登录|登陆|授权|验证码|扫码|密码|Touch ID|权限/i.test(text) ? 'login' : 'other';
    return { kind: 'need', type, title, detail: line(text) === title ? '' : clip(text, LIMITS.detail), source: 'notify' };
  }

  // ---- the board's own items --------------------------------------------
  const NOT_A_QUESTION = { '已结束，未提交回执': '队员停下了，但没有交结果。看看要不要重派，或者告诉队长怎么办。', '调度已结束，尚未派出执行会话': '这件事还没派给队员，告诉队长要不要开始。' };
  function cardQuestion(card) {
    const raw = line(card.user_question || card.latest_receipt);
    return NOT_A_QUESTION[raw] || raw || '队员在等一个决定，详情见任务看板。';
  }
  // What on a card is waiting on the user right now, as { key, item fields }.
  // A visit has its own key: leaving 需要你 and coming back is a new item.
  function cardNeeds(card) {
    if (!card || card.archived || typeof card.id !== 'string' || !REF.test(card.id)) return [];
    const out = [];
    const title = line(card.title) || card.id;
    const base = { kind: 'need', project: line(card.project), card: card.id, cardTitle: title, source: 'card' };
    if (card.status === 'needs_user') {
      out.push({ ...base, key: `needs:${card.id}:${card.needs_user_entry || 'legacy'}`, type: 'question',
        title: `「${title}」停下来等你回答`, ask: cardQuestion(card),
        detail: line(card.detail) ? '任务说明：' + clip(block(card.detail), 2000) : '' });
    }
    if (card.flag === 'held' && card.status !== 'done') {
      const tries = card.rework_count > 0 ? `验收没过 ${card.rework_count} 次` : '连续两次没做成';
      out.push({ ...base, key: `held:${card.id}:${card.last_failure_attempt || card.attempt_id || 'x'}`, type: 'review',
        title: `「${title}」${tries}，已经停下`, ask: '决定还做不做、要不要换个做法（回复会交给队长）。',
        detail: line(card.latest_receipt) ? '最近一次结果：' + clip(block(card.latest_receipt), 2000) : '' });
    }
    return out;
  }
  function cardStatusNote(card) {
    if (!card) return '卡片已不在看板上';
    if (card.archived || card.status === 'done') return '对应任务已完成';
    if (card.status === 'doing') return '已经有人回答，任务继续在做';
    if (card.status === 'review') return '任务已交回，正在验收';
    if (card.status === 'todo') return '任务放回了待办';
    return '这张卡已不再等你';
  }
  // Brings the store up to date with the cards: files what newly waits on the
  // user, ticks what no longer does. `cards` must include archived ones.
  function syncCards(store, cards, now, random) {
    const list = Array.isArray(cards) ? cards : [];
    const byCard = new Map(list.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
    const live = new Map();
    for (const card of list) for (const need of cardNeeds(card)) live.set(need.key, need);
    let changed = 0;
    const known = new Set(store.items.map((i) => i.key).filter(Boolean));
    const told = new Set(store.items.filter((i) => !i.done && i.kind === 'need' && i.card && i.source !== 'card').map((i) => i.card));
    for (const [key, need] of live) {
      if (known.has(key) || told.has(need.card)) continue;
      const { item } = add(store, need, now, random ? random() : undefined);
      if (item.key !== key) continue; // an identical open captain item already says it
      changed++;
    }
    for (const item of store.items) {
      if (item.done || !item.card) continue;
      const card = byCard.get(item.card);
      if (item.source === 'card') {
        if (!live.has(item.key)) { finish(item, 'card', cardStatusNote(card), now); changed++; }
      } else if (item.kind === 'need' && card && (card.archived || card.status === 'done')) {
        finish(item, 'card', '对应任务已完成', now); changed++;
      }
      if (!item.done && card && card.title && item.cardTitle !== line(card.title)) { item.cardTitle = clip(line(card.title), LIMITS.title); changed++; }
    }
    return changed;
  }
  // waiting(sessionId): true while it waits on an answer, false once it does
  // not, null when this computer does not know the session.
  function syncSessions(store, waiting, now) {
    let changed = 0;
    for (const item of store.items) {
      if (item.done || item.kind !== 'need' || !item.session || !item.sessionWaiting) continue;
      if (waiting(item.session) === false) { finish(item, 'session', '会话的问题已经答复', now); changed++; }
    }
    return changed;
  }

  // ---- what the page shows ------------------------------------------------
  const label = (item) => (item.kind === 'report' ? REPORT_LABEL : TYPES[item.type] || TYPES.other);
  // 要你处理 first, then 结果汇报; newest first inside each.
  function sorted(items) {
    const rank = (i) => (i.kind === 'need' ? 0 : 1);
    return items.slice().sort((a, b) => rank(a) - rank(b) || b.created - a.created || (a.id < b.id ? -1 : 1));
  }
  function counts(store) {
    const open = store.items.filter((i) => !i.done);
    const need = open.filter((i) => i.kind === 'need').length;
    const reports = open.filter((i) => i.kind === 'report').length;
    const unreadReports = open.filter((i) => i.kind === 'report' && !i.readAt).length;
    const unread = open.filter((i) => !i.readAt).length;
    return { need, reports, unreadReports, unread, badge: need + unreadReports, open: open.length };
  }
  function badgeTitle(c) {
    if (!c.badge) return '待我处理：没有要你处理的事';
    return '待我处理：' + [c.need && `${c.need} 件要你处理`, c.unreadReports && `${c.unreadReports} 条新汇报`].filter(Boolean).join('，');
  }
  function view(store) {
    const open = sorted(store.items.filter((i) => !i.done));
    return {
      needs: open.filter((i) => i.kind === 'need'),
      reports: open.filter((i) => i.kind === 'report'),
      done: store.items.filter((i) => i.done).sort((a, b) => b.doneAt - a.doneAt || (a.id < b.id ? -1 : 1)),
      counts: counts(store),
    };
  }
  const DONE_TEXT = { user: '你标记已处理', reply: '你已回复', captain: '队长标记已解决', card: '任务那边已解决', session: '会话的问题已答复' };
  function doneText(item) {
    const who = item.kind === 'report' && item.doneBy === 'user' ? '你看过了' : DONE_TEXT[item.doneBy] || '已完成';
    return item.doneNote && item.doneNote !== who && item.doneBy !== 'reply' && item.doneBy !== 'user' ? `${who}：${item.doneNote}` : who;
  }
  function when(ts, now) {
    if (!ts) return '';
    const s = Math.max(0, (now - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    const d = new Date(ts), n = new Date(now);
    const pad = (x) => String(x).padStart(2, '0');
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
    if (days === 0) return '今天 ' + hm;
    if (days === 1) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  // ---- what 队长 is told ---------------------------------------------------
  function refs(item) {
    return [item.project && '项目：' + item.project, item.card && `卡片 ${item.card}${item.cardTitle ? '「' + item.cardTitle + '」' : ''}`,
      item.session && `会话 ${item.session}${item.sessionTitle ? '「' + item.sessionTitle + '」' : ''}`].filter(Boolean).join('，');
  }
  // The user's reply, with the item it answers, as one receipt for 队长.
  function replyNotice(item, text) {
    const where = refs(item);
    return [
      `用户在「待我处理」回复了一条${item.kind === 'report' ? '结果汇报' : '要用户处理的事（' + label(item) + '）'}（条目 ${item.id}${where ? '，' + where : ''}，登记于 ${new Date(item.created).toLocaleString('zh-CN', { hour12: false })}）。`,
      '原条目：' + item.title,
      item.ask ? '当时请用户做的：' + item.ask : '',
      '用户的回复：' + block(text),
      '请按用户的回复处理，需要派活就派；这一条已经打勾。要用户再介入或有新结论，用 inbox need / inbox report 另登记一条。',
    ].filter(Boolean).join('\n');
  }
  // The user ticked a need item without writing anything: whatever waited on it can go on.
  function doneNotice(item) {
    const where = refs(item);
    return `用户在「待我处理」把一件要用户处理的事标为已处理（条目 ${item.id}${where ? '，' + where : ''}）：${item.title}${item.ask ? '（当时请用户做的：' + item.ask + '）' : ''}。如果有活在等这件事，现在可以继续。`;
  }
  // `inbox list`: what is open, with ids 队长 can resolve; --all adds the latest finished ones.
  function listText(store, all, now) {
    const v = view(store);
    const open = [...v.needs, ...v.reports];
    const row = (i) => {
      const meta = [i.project && '项目 ' + i.project, i.card && '卡片 ' + i.card, i.session && '会话 ' + i.session, when(i.created, now), !i.done && !i.readAt ? '用户未读' : ''].filter(Boolean).join('，');
      const lines = [`- ${i.id}【${i.kind === 'need' ? '要你处理·' : ''}${label(i)}】${i.title}（${meta}）`];
      if (i.ask) lines.push('  要用户做：' + i.ask);
      if (i.done) lines.push('  ' + doneText(i) + '（' + when(i.doneAt, now) + '）');
      const last = i.replies[i.replies.length - 1];
      if (last) lines.push('  用户回复：' + clip(line(last.text), 200));
      return lines.join('\n');
    };
    const out = [open.length ? `待我处理：${v.needs.length} 件要用户处理，${v.reports.length} 条结果汇报。` : '待我处理：没有未解决的条目。'];
    open.forEach((i) => out.push(row(i)));
    if (all && v.done.length) {
      out.push('', `最近解决的 ${Math.min(30, v.done.length)} 条：`);
      v.done.slice(0, 30).forEach((i) => out.push(row(i)));
    }
    return out.join('\n');
  }
  function addedText(item, created) {
    const what = item.kind === 'need' ? `要用户处理（${label(item)}）` : '结果汇报';
    return created ? `已登记到「待我处理」：${item.id}，${what}。解决后 inbox resolve --id ${item.id}。`
      : `「待我处理」里已有同样一条未解决的：${item.id}，没有重复登记。`;
  }

  // ---- the phone ----------------------------------------------------------
  // Display fields only; no captain notice ids.
  function phoneItem(item) {
    return {
      id: item.id, kind: item.kind, label: label(item), title: item.title, ask: item.ask, detail: clip(item.detail, 4000),
      files: item.files.slice(0, 10), project: item.project, cardTitle: item.cardTitle, sessionTitle: item.sessionTitle,
      source: item.source, created: item.created, readAt: item.readAt, done: item.done, doneAt: item.doneAt,
      doneText: item.done ? doneText(item) : '',
      replies: item.replies.slice(-3).map((r) => ({ text: clip(r.text, 1000), at: r.at, from: r.from, seen: r.seen })),
    };
  }
  function phoneView(store, doneLimit = 60) {
    const v = view(store);
    return { items: [...v.needs, ...v.reports, ...v.done.slice(0, doneLimit)].map(phoneItem), counts: v.counts };
  }

  return { VERSION, KINDS, TYPES, REPORT_LABEL, LIMITS, KEEP_DONE, ID, normalize, normalizeItem, newId, add, resolve, reopen, markRead, reply, markRepliesSeen, prune,
    notifyItem, cardNeeds, cardQuestion, syncCards, syncSessions, label, sorted, counts, badgeTitle, view, doneText, when, refs, replyNotice, doneNotice, listText, addedText, phoneItem, phoneView };
});
