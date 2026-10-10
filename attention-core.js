// 待我处理: what the AI hands back to the user. Two kinds of item, in two columns:
//   need   要你处理: something only the user can do (decide, log in, pay, answer);
//          it stays until it is answered or done, reading it changes nothing.
//   report 做完了你还没看: a short conclusion 队长 reported. It is filed with
//          the 队长 turn it was said in; once the user has seen it (that turn's
//          reply in the 队长 chat, or the item itself, on screen for a moment,
//          desktop or phone) it is read and leaves the column (`markRead`).
// Items come from 队长 (`inbox need|report`, and every `notify-user`), and from
// what 队长 writes back on a 待办 handed to AI with `@ai` (`syncTodos`).
// A card that stops for the user (需要你, held after two failed rounds) is not
// filed here by the program: 队长 hears about it on the receipt channel, judges
// whether the user is really needed, and files one plain question with the
// answers to pick from (`--options`). Version 1 filed those cards by itself,
// pasting the card's last receipt as 要你做; `migrate` takes those away once.
// Items live in this computer's config.json (`config.attention`), next to the
// conversations they summarize; nothing here is ever sent to git.
//
// An item leaves 待处理 and is ticked into 已完成 when:
//   - the user ticks it (已处理 / 知道了) or replies to it (the reply goes to 队长);
//   - a report: the user has seen it (in the chat or on the page);
//   - 队长 resolves it (`inbox resolve`);
//   - the card it names is done or archived (need items only: a report is
//     usually about a card that just finished);
//   - the session it names was waiting on an answer when it was filed and no
//     longer is.
// Pure functions, no DOM: runs in the page, the main process and tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AttentionCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 3;
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
  const LIMITS = { title: 300, ask: 1000, detail: 8000, note: 500, reply: 4000, files: 20, path: 1024, project: 120, options: 6, option: 24, toCaptain: 8000 };
  const KEEP_DONE = 200;
  // Every answer a live 待办 still shows has to stay remembered (or it is filed again): room for many.
  const TODO_FILED_KEEP = 5000;
  const ID = /^at-[a-z0-9-]{4,40}$/;
  const REF = /^[A-Za-z0-9_-]{1,160}$/;
  const DONE_BY = ['user', 'reply', 'captain', 'card', 'session', 'seen', 'chat', 'todo'];
  const SOURCES = ['captain', 'notify', 'card', 'automation', 'todo'];

  const isTime = (v) => Number.isSafeInteger(v) && v > 0;
  // One line: runs of whitespace (line breaks too) become one space.
  const line = (v) => String(v == null ? '' : v).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  // A block keeps its line breaks; other control characters go.
  const block = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const clip = (s, max) => ([...s].length > max ? [...s].slice(0, max - 1).join('') + '…' : s);
  // Quick answers: short one-line choices, each once, in the order given.
  const optionList = (v) => [...new Set((Array.isArray(v) ? v : []).map((o) => line(o)).filter(Boolean))];

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
      options: raw.kind === 'need' ? optionList(raw.options).filter((o) => [...o].length <= LIMITS.option).slice(0, LIMITS.options) : [],
      detail: clip(block(raw.detail), LIMITS.detail),
      files: (Array.isArray(raw.files) ? raw.files : []).map((f) => line(f)).filter((f) => f && f.length <= LIMITS.path).slice(0, LIMITS.files),
      project: clip(line(raw.project), LIMITS.project),
      card: typeof raw.card === 'string' && REF.test(raw.card) ? raw.card : '',
      cardTitle: clip(line(raw.cardTitle), LIMITS.title),
      session: typeof raw.session === 'string' && REF.test(raw.session) ? raw.session : '',
      sessionTitle: clip(line(raw.sessionTitle), LIMITS.title),
      sessionWaiting: raw.sessionWaiting === true,
      // The 队长 chat turn a report was said in: seeing that reply reads it.
      turn: raw.kind === 'report' && typeof raw.turn === 'string' && REF.test(raw.turn) ? raw.turn : '',
      source: SOURCES.includes(raw.source) ? raw.source : 'captain',
      automation: raw.source === 'automation' ? clip(line(raw.automation), 40) : '',
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
    const out = { version: VERSION, items };
    // What syncTodos already filed, so an item pruned from 已完成 is never filed again.
    const filed = Array.isArray(raw?.todoFiled) ? raw.todoFiled.filter((k) => typeof k === 'string' && k.length <= 400).slice(-TODO_FILED_KEEP) : [];
    if (filed.length) out.todoFiled = filed;
    // A note waiting to reach 队长 (see migrate): kept until it is delivered.
    const toCaptain = typeof raw?.toCaptain === 'string' ? clip(block(raw.toCaptain), LIMITS.toCaptain) : '';
    if (toCaptain) out.toCaptain = toCaptain;
    return out;
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
    const options = optionList(input.options);
    if (options.length && kind !== 'need') throw new Error('--options 只用于 need。');
    if (options.length && !ask) throw new Error('有 --options 就要有 --ask：先用一句话问清楚，再给可选的回答。');
    if (options.length > LIMITS.options) throw new Error(`--options 最多 ${LIMITS.options} 个。`);
    if (options.some((o) => [...o].length > LIMITS.option)) throw new Error(`--options 每个最多 ${LIMITS.option} 字，写成用户点一下就能回的短答案。`);
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
      id: newId(now, random), kind, type, title, ask, options, detail, files, project,
      card: input.card || '', cardTitle: input.cardTitle, session: input.session || '', sessionTitle: input.sessionTitle,
      sessionWaiting: input.sessionWaiting === true, turn: input.turn, source: SOURCES.includes(input.source) ? input.source : 'captain', automation: input.automation, key: input.key || '',
      created: now, updated: now,
    });
    store.items.push(item);
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
  // Back to 待处理 from 已完成. A need counts as read, the user just looked at
  // it; a report goes back to 没看, which is what putting one back means.
  function reopen(store, id, now) {
    const item = byId(store, id);
    if (!item) throw new Error('这一条已经不在了。');
    if (!item.done) return { item, changed: false };
    item.done = false; item.doneAt = 0; item.doneBy = ''; item.doneNote = ''; item.updated = now;
    item.readAt = item.kind === 'report' ? 0 : item.readAt || now;
    return { item, changed: true };
  }
  // Seen on screen. A report is then read and leaves 没看 (`via` 'chat': its
  // 队长 reply was seen, otherwise the item itself); a need only loses its dot.
  function markRead(store, ids, now, via) {
    let changed = 0;
    for (const id of ids || []) {
      const item = byId(store, id);
      if (!item || item.done) continue;
      if (item.kind === 'report') { finish(item, via === 'chat' ? 'chat' : 'seen', '', now); changed++; }
      else if (!item.readAt) { item.readAt = now; changed++; }
    }
    return changed;
  }
  // Unread reports by the 队长 turn they were said in: what a seen reply reads.
  function unseenByTurn(store) {
    const out = new Map();
    for (const item of store.items) {
      if (item.done || item.kind !== 'report' || !item.turn) continue;
      if (!out.has(item.turn)) out.set(item.turn, []);
      out.get(item.turn).push(item.id);
    }
    return out;
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
    // A report only seen so far is answered now: the reply is what the record says.
    if (!item.done || item.doneBy === 'seen' || item.doneBy === 'chat') finish(item, 'reply', '你已回复，交给队长了', now);
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

  // ---- cards ------------------------------------------------------------
  // Keeps 队长's items in step with the cards they name: a need is ticked once
  // its card is done or archived, and follows the card's title. Nothing is
  // filed from a card. `cards` must include archived ones.
  function syncCards(store, cards, now) {
    const byCard = new Map((Array.isArray(cards) ? cards : []).filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
    let changed = 0;
    for (const item of store.items) {
      if (item.done || !item.card) continue;
      const card = byCard.get(item.card);
      if (!card) continue;
      if (item.kind === 'need' && (card.archived || card.status === 'done')) { finish(item, 'card', '对应任务已完成', now); changed++; }
      if (!item.done && card.title && item.cardTitle !== line(card.title)) { item.cardTitle = clip(line(card.title), LIMITS.title); changed++; }
    }
    return changed;
  }
  // ---- 待办 handed to AI ----------------------------------------------------
  // A 待办 with `@ai` becomes a card for 队长 (todo-ai.js). What 队长 writes back
  // (`todo status`) is filed here by the program, once per state and content:
  //   needs_user → 要你处理 (等你回答): the user's reply goes to 队长 with the card;
  //   failed     → 要你处理 (等你拍板): retry or leave it;
  //   done       → 结果汇报 with the files.
  // Once per round (`ai.round`, counted by todo-ai.js each time the state is
  // entered) and answer: a refresh files nothing new, but waiting or failing
  // again after the AI went back to work is a new item.
  // Only on the computer that handed the item to AI (`ai.ownerDevice`): the phone
  // hub merges both computers' pages, and the other desktop shows the state on
  // its 待办 page. A need is ticked once the AI state moves on (or the card is
  // done, syncCards). `todos` is the merged 待办 list; null when it could not be read.
  function todoKey(ai) {
    // FNV-1a over what was written back: the same answer filed twice is one item.
    let h = 0x811c9dc5;
    for (const ch of [ai.status, line(ai.message), ...(Array.isArray(ai.files) ? ai.files : [])].join('\n')) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
    const round = Number.isSafeInteger(ai.round) ? ai.round : 0;
    return `todo:${ai.taskId}:${ai.status}:${round}:${h.toString(36)}`;
  }
  const TODO_STATES = ['needs_user', 'failed', 'done'];
  function syncTodos(store, todos, device, now) {
    if (!Array.isArray(todos) || typeof device !== 'string' || !device) return 0;
    const live = new Map();
    for (const t of todos) {
      const ai = t && !t.deleted && t.ai;
      if (ai && typeof ai.taskId === 'string' && REF.test(ai.taskId) && ai.ownerDevice === device) live.set(ai.taskId, { t, ai });
    }
    let changed = 0;
    // A question or a failure the AI has moved past is settled. One whose 待办 the user
    // ticked off is settled too, a report as well: the user is done with it.
    for (const item of store.items) {
      if (item.done || item.source !== 'todo' || !item.card) continue;
      const cur = live.get(item.card);
      if (cur && cur.t.done) { finish(item, 'todo', '', now); changed++; continue; }
      if (item.kind !== 'need') continue;
      if (cur && TODO_STATES.includes(cur.ai.status) && todoKey(cur.ai) === item.key) continue;
      finish(item, 'card', cur ? 'AI 已接着办' : '这条待办已改动或删除', now);
      changed++;
    }
    const filed = new Set(store.todoFiled || []), current = new Set();
    for (const { t, ai } of live.values()) {
      if (!TODO_STATES.includes(ai.status)) continue;
      const key = todoKey(ai);
      current.add(key);
      if (filed.has(key) || t.done) continue;   // a ticked-off 待办 files nothing new (it would close at once)
      const what = clip(line(t.text), 80), message = clip(line(ai.message), LIMITS.ask - 20);
      const input = ai.status === 'needs_user' ? { kind: 'need', type: 'question', title: 'AI 在等你：' + what, ask: message || '缺材料，回复里告诉 AI 在哪。' }
        : ai.status === 'failed' ? { kind: 'need', type: 'decide', title: 'AI 没办成：' + what, ask: (message ? message + ' ' : '') + '要重试还是先放着？', options: ['重试', '先放着'] }
          : { kind: 'report', title: 'AI 办完了：' + what, detail: block(ai.message), files: (Array.isArray(ai.files) ? ai.files : []).slice(0, LIMITS.files) };
      try { add(store, { ...input, project: 'todo', card: ai.taskId, cardTitle: t.text, source: 'todo', key }, now); }
      catch (_) { continue; /* never block the other items */ }
      filed.add(key);
      changed++;
    }
    if (changed) {
      // Over the cap, answers no longer on a live 待办 go first: one still standing is never
      // dropped (it would be filed again). One missing from this read only (a damaged or
      // half-synced file) is kept while there is room.
      const all = [...filed];
      store.todoFiled = all.length <= TODO_FILED_KEEP ? all
        : all.filter((key) => !current.has(key)).concat(all.filter((key) => current.has(key))).slice(-TODO_FILED_KEEP);
    }
    return changed;
  }

  // Version 1 filed every card that stopped for the user by itself, with the
  // card's last receipt as 要你做 (「XX 停下来等你回答」, 「验收卡住了」). Those go,
  // once: an open one nobody answered leaves the page and 队长 is told which
  // cards they were (`toCaptain`), so it can ask the user properly where it
  // must; one the user answered stays in 已完成 as the record of that answer,
  // its pasted receipt moved into the details.
  // Version 2 kept a read report open until 知道了; version 3 files it as read.
  function migrate(store, fromVersion) {
    if (Number(fromVersion) >= 3) return { changed: false, moved: [] };
    const moved = [];
    let changed = false;
    for (const item of store.items) {
      if (item.kind === 'report' && !item.done && item.readAt) { finish(item, 'seen', '', item.readAt); changed = true; }
    }
    if (Number(fromVersion) >= 2) return { changed, moved };
    store.items = store.items.filter((item) => {
      if (item.source !== 'card') return true;
      changed = true;
      if (!item.replies.length) { if (!item.done) moved.push(item); return false; }
      if (item.ask) {
        item.detail = clip(block(['当时贴出的原文：' + item.ask, item.detail].filter(Boolean).join('\n\n')), LIMITS.detail);
        item.ask = '';
      }
      return true;
    });
    if (moved.length) store.toCaptain = clip(block([store.toCaptain, migratedNotice(moved)].filter(Boolean).join('\n\n')), LIMITS.toCaptain);
    return { changed, moved };
  }
  function migratedNotice(moved) {
    return [
      `「待我处理」不再由程序自动登记停下来的卡片（以前直接把卡片最近一条回执当成「要你做」，用户看不懂要回答什么）。下面 ${moved.length} 条已从用户的待处理里撤下：`,
      ...moved.map((i) => `- 卡片 ${i.card}${i.cardTitle ? '「' + i.cardTitle + '」' : ''}${i.project ? '（项目 ' + i.project + '）' : ''}：原来贴出的是「${clip(i.ask, 160)}」`),
      '请逐张看：卡片还停着、确实只有用户能定的，用 inbox need --card 卡片id --title "一句大白话说明" --ask "一句明确的问题" --options "回答1|回答2|回答3" 重新问用户；不需要用户的你直接处理。',
    ].join('\n');
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
  // 要你处理 first, then 没看的汇报; newest first inside each.
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
    // The badge's number is 要你处理 only; unread reports are a separate dot.
    return { need, reports, unreadReports, unread, badge: need, open: open.length };
  }
  function badgeTitle(c) {
    if (!c.need && !c.unreadReports) return '待我处理：没有要你处理的事';
    return '待我处理：' + [c.need ? `${c.need} 件要你处理` : '没有要你处理的事', c.unreadReports && `${c.unreadReports} 条汇报你还没看`].filter(Boolean).join('，');
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
  const DONE_TEXT = { user: '你标记已处理', reply: '你已回复', captain: '队长标记已解决', card: '任务那边已解决', session: '会话的问题已答复', seen: '你看过了', chat: '你在队长对话里看过了', todo: '你勾掉了这条待办' };
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
    return [item.source === 'automation' && item.automation && '来自自动任务：' + item.automation, item.source === 'todo' && '来自待办（@ai）', item.project && '项目：' + item.project, item.card && `卡片 ${item.card}${item.cardTitle ? '「' + item.cardTitle + '」' : ''}`,
      item.session && `会话 ${item.session}${item.sessionTitle ? '「' + item.sessionTitle + '」' : ''}`].filter(Boolean).join('，');
  }
  // The user's reply, with the item it answers, as one receipt for 队长.
  function replyNotice(item, text) {
    const where = refs(item);
    return [
      `用户在「待我处理」回复了一条${item.kind === 'report' ? '结果汇报' : '要用户处理的事（' + label(item) + '）'}（条目 ${item.id}${where ? '，' + where : ''}，登记于 ${new Date(item.created).toLocaleString('zh-CN', { hour12: false })}）。`,
      '原条目：' + item.title,
      item.ask ? '当时请用户做的：' + item.ask : '',
      item.options.length ? '当时给的选项：' + item.options.join(' / ') : '',
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
      const meta = [i.source === 'automation' && i.automation && '来自自动任务：' + i.automation, i.project && '项目 ' + i.project, i.card && '卡片 ' + i.card, i.session && '会话 ' + i.session, when(i.created, now), !i.done && !i.readAt && i.kind === 'need' ? '用户未读' : ''].filter(Boolean).join('，');
      const lines = [`- ${i.id}【${i.kind === 'need' ? '要你处理·' : ''}${label(i)}】${i.title}（${meta}）`];
      if (i.ask) lines.push('  要用户做：' + i.ask);
      if (i.options.length) lines.push('  可选回答：' + i.options.join(' / '));
      if (i.done) lines.push('  ' + doneText(i) + '（' + when(i.doneAt, now) + '）');
      const last = i.replies[i.replies.length - 1];
      if (last) lines.push('  用户回复：' + clip(line(last.text), 200));
      return lines.join('\n');
    };
    const out = [open.length ? `待我处理：${v.needs.length} 件要用户处理，${v.reports.length} 条结果汇报用户还没看。` : '待我处理：没有未解决的条目。'];
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
  // What a phone push says about a new need: 队长's own question and its quick
  // answers, under the item's title. Never the card's receipt or the detail.
  function phonePush(input) {
    const title = clip(line(input && input.title), 100);
    const ask = clip(line(input && input.ask), LIMITS.ask);
    const options = optionList(input && input.options);
    const message = [ask || title, options.length ? '可选回答：' + options.join(' / ') : ''].filter(Boolean).join('\n');
    return { title, message };
  }
  // Display fields only; no captain notice ids.
  function phoneItem(item) {
    return {
      id: item.id, kind: item.kind, label: label(item), title: item.title, ask: item.ask, options: item.options.slice(),
      detail: clip(item.detail, 4000),
      files: item.files.slice(0, 10), project: item.project, cardTitle: item.cardTitle, sessionTitle: item.sessionTitle,
      source: item.source, automation: item.automation, turn: item.turn, created: item.created, readAt: item.readAt, done: item.done, doneAt: item.doneAt, doneBy: item.doneBy,
      doneText: item.done ? doneText(item) : '',
      replies: item.replies.slice(-3).map((r) => ({ text: clip(r.text, 1000), at: r.at, from: r.from, seen: r.seen })),
    };
  }
  function phoneView(store, doneLimit = 60) {
    const v = view(store);
    return { items: [...v.needs, ...v.reports, ...v.done.slice(0, doneLimit)].map(phoneItem), counts: v.counts };
  }

  return { VERSION, KINDS, TYPES, REPORT_LABEL, LIMITS, KEEP_DONE, ID, normalize, normalizeItem, newId, add, resolve, reopen, markRead, unseenByTurn, reply, markRepliesSeen, prune,
    notifyItem, syncCards, syncTodos, todoKey, migrate, syncSessions, label, sorted, counts, badgeTitle, view, doneText, when, refs, replyNotice, doneNotice, listText, addedText, phonePush, phoneItem, phoneView };
});
