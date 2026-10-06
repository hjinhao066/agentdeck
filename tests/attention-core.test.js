'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../attention-core');

const T0 = Date.UTC(2026, 9, 6, 4, 0, 0);
let seq = 0;
const rnd = () => 'r' + (++seq);
const fresh = () => A.normalize({});

test('captain items: need and report, validated, newest first with needs ahead of reports', () => {
  const s = fresh();
  const report = A.add(s, { kind: 'report', title: '小福助手排查报告回来了，结论是完全正常', detail: '补查两件：\n1. 上传\n2. 识别', files: ['/tmp/a.md'], project: '小福助手' }, T0, rnd()).item;
  const need = A.add(s, { kind: 'need', type: 'login', title: '小红书要你登录一次', ask: '在 Mac 的 Chrome 里登录小红书', project: 'xhs' }, T0 + 1000, rnd()).item;
  const older = A.add(s, { kind: 'need', title: '磁盘清理清单里哪些删', ask: '看清单第二节，告诉队长删哪几项' }, T0 - 5000, rnd()).item;
  assert.match(report.id, A.ID);
  assert.equal(report.type, '');
  assert.equal(report.ask, '');
  assert.equal(need.type, 'login');
  assert.equal(older.type, 'other');
  const v = A.view(s);
  assert.deepEqual(v.needs.map((i) => i.id), [need.id, older.id]);
  assert.deepEqual(v.reports.map((i) => i.id), [report.id]);
  assert.deepEqual(v.counts, { need: 2, reports: 1, unreadReports: 1, unread: 3, badge: 3, open: 3 });
  assert.equal(A.label(need), '等你登录或授权');
  assert.equal(A.label(report), '结果汇报');
  assert.equal(report.detail, '补查两件：\n1. 上传\n2. 识别');

  assert.throws(() => A.add(s, { kind: 'need', title: '' }, T0, rnd()), /--title/);
  assert.throws(() => A.add(s, { kind: 'todo', title: 'x' }, T0, rnd()), /need/);
  assert.throws(() => A.add(s, { kind: 'need', title: 'x'.repeat(301) }, T0, rnd()), /最多 300 字/);
  assert.throws(() => A.add(s, { kind: 'need', title: 'x', type: 'boss' }, T0, rnd()), /--type/);
  assert.throws(() => A.add(s, { kind: 'need', title: 'x', card: '../etc' }, T0, rnd()), /--card/);
  assert.throws(() => A.add(s, { kind: 'report', title: 'x', detail: 'y'.repeat(8001) }, T0, rnd()), /--detail/);
});

test('the same open item filed twice (inbox need and notify-user) stays one', () => {
  const s = fresh();
  const a = A.add(s, { kind: 'need', title: '请亲自登录。', source: 'notify' }, T0, rnd());
  const b = A.add(s, { kind: 'need', title: '请亲自登录。' }, T0 + 10, rnd());
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.item.id, a.item.id);
  assert.match(A.addedText(b.item, false), /没有重复登记/);
  A.resolve(s, a.item.id, 'captain', '', T0 + 20);
  assert.equal(A.add(s, { kind: 'need', title: '请亲自登录。' }, T0 + 30, rnd()).created, true, 'a solved one does not block a new visit');
});

test('reading, ticking, reopening and 队长 resolving', () => {
  const s = fresh();
  const r = A.add(s, { kind: 'report', title: '登录改成 1 的会话卡在确认窗口，我已替它点了是' }, T0, rnd()).item;
  const n = A.add(s, { kind: 'need', type: 'decide', title: '1.5 先出四项还是等 Todo', ask: '回复「先出」或「等」' }, T0, rnd()).item;
  assert.equal(A.markRead(s, [r.id, 'at-missing'], T0 + 5), 1);
  assert.equal(A.counts(s).badge, 1, 'a read report no longer counts; an open need still does');
  A.resolve(s, r.id, 'user', '', T0 + 6);
  assert.equal(A.doneText(r), '你看过了');
  A.resolve(s, n.id, 'captain', '用户口头说了先出', T0 + 7);
  assert.equal(A.doneText(n), '队长标记已解决：用户口头说了先出');
  assert.equal(A.counts(s).open, 0);
  assert.deepEqual(A.view(s).done.map((i) => i.id), [n.id, r.id]);
  assert.equal(A.resolve(s, n.id, 'user', '', T0 + 8).changed, false);
  A.reopen(s, n.id, T0 + 9);
  assert.equal(n.done, false);
  assert.equal(n.doneBy, '');
  assert.equal(A.counts(s).need, 1);
  assert.throws(() => A.resolve(s, 'at-nope-1', 'user', '', T0), /inbox list/);
});

test('a reply ticks the item and carries its context to 队长; seen once 队长 takes the receipt', () => {
  const s = fresh();
  const n = A.add(s, { kind: 'need', type: 'decide', title: '网页端登录改成 1 有风险', ask: '确认仍要设成 1，还是改成登录一次长期有效', project: 'agentdeck', card: 't-e041866b', session: 'c-board-x1', sessionTitle: '登录取证' }, T0, rnd()).item;
  const text = A.replyNotice(n, '改成登录一次长期有效');
  assert.match(text, /用户在「待我处理」回复了一条要用户处理的事（等你拍板）/);
  assert.match(text, new RegExp(`条目 ${n.id}`));
  assert.match(text, /项目：agentdeck，卡片 t-e041866b，会话 c-board-x1「登录取证」/);
  assert.match(text, /原条目：网页端登录改成 1 有风险/);
  assert.match(text, /当时请用户做的：确认仍要设成 1/);
  assert.match(text, /用户的回复：改成登录一次长期有效/);
  A.reply(s, n.id, '改成登录一次长期有效', 'phone', T0 + 100, 'attention-n1');
  assert.equal(n.done, true);
  assert.equal(n.doneBy, 'reply');
  assert.equal(A.doneText(n), '你已回复');
  assert.deepEqual(n.replies.map((r) => [r.text, r.from, r.seen]), [['改成登录一次长期有效', 'phone', false]]);
  assert.equal(A.markRepliesSeen(s, ['attention-n1']), 0, 'still waiting in the receipt channel');
  assert.equal(A.markRepliesSeen(s, []), 1);
  assert.equal(n.replies[0].seen, true);
  assert.throws(() => A.reply(s, n.id, '   ', 'desktop', T0), /先写下/);
  assert.match(A.doneNotice(n), /标为已处理.*如果有活在等这件事，现在可以继续/);
});

test('needs_user and held cards become items and tick themselves once the card moves on', () => {
  const s = fresh();
  const cards = [
    { id: 't-ask', project: 'agentdeck', title: '修复登录', status: 'needs_user', needs_user_entry: '2026-10-06T04:00:00.000Z', user_question: '要不要把旧数据一起迁移？', detail: '把登录改成 1' },
    { id: 't-held', project: 'muse', title: 'Muse 冒烟', status: 'doing', flag: 'held', rework_count: 2, latest_receipt: '不通过：报告缺来源', last_failure_attempt: 'a2' },
    { id: 't-fine', project: 'agentdeck', title: '正常', status: 'doing' },
    { id: 't-old', project: 'agentdeck', title: '旧问题', status: 'needs_user', archived: true },
  ];
  assert.equal(A.syncCards(s, cards, T0, rnd), 2);
  const [ask, held] = A.view(s).needs.sort((a, b) => (a.card < b.card ? -1 : 1));
  assert.equal(ask.title, '「修复登录」停下来等你回答');
  assert.equal(ask.ask, '要不要把旧数据一起迁移？');
  assert.equal(ask.type, 'question');
  assert.equal(ask.source, 'card');
  assert.match(ask.detail, /任务说明：把登录改成 1/);
  assert.equal(held.title, '「Muse 冒烟」验收没过 2 次，已经停下');
  assert.match(held.detail, /不通过：报告缺来源/);
  assert.equal(A.syncCards(s, cards, T0 + 1, rnd), 0, 'nothing new on a second look');

  // 队长 answered the worker: the card is back in doing; the hold was lifted.
  cards[0] = { ...cards[0], status: 'doing' };
  cards[1] = { ...cards[1], flag: null };
  assert.equal(A.syncCards(s, cards, T0 + 2, rnd), 2);
  assert.equal(ask.done, true);
  assert.equal(ask.doneBy, 'card');
  assert.equal(A.doneText(ask), '任务那边已解决：已经有人回答，任务继续在做');
  assert.equal(held.done, true);

  // Asked again later: a new visit is a new item.
  cards[0] = { ...cards[0], status: 'needs_user', needs_user_entry: '2026-10-06T05:00:00.000Z', user_question: null, latest_receipt: '已结束，未提交回执' };
  assert.equal(A.syncCards(s, cards, T0 + 3, rnd), 1);
  const again = A.view(s).needs[0];
  assert.notEqual(again.id, ask.id);
  assert.match(again.ask, /队员停下了，但没有交结果/);
  // The user ticks it here: the card is untouched and the item does not come back.
  A.resolve(s, again.id, 'user', '', T0 + 4);
  assert.equal(A.syncCards(s, cards, T0 + 5, rnd), 0);
  assert.equal(A.counts(s).open, 0);
  // The card disappears: its item says so.
  const s2 = fresh();
  A.syncCards(s2, [cards[0]], T0, rnd);
  A.syncCards(s2, [], T0 + 1, rnd);
  assert.equal(A.view(s2).done[0].doneNote, '卡片已不在看板上');
});

test('a captain need tied to a card ticks when the card is done; a report about it never does', () => {
  const s = fresh();
  const need = A.add(s, { kind: 'need', title: '验收卡住：要你拍板', card: 't-1' }, T0, rnd()).item;
  const report = A.add(s, { kind: 'report', title: '卡片 1 做完了', card: 't-1' }, T0, rnd()).item;
  A.syncCards(s, [{ id: 't-1', title: '一号', status: 'review' }], T0 + 1, rnd);
  assert.equal(need.done, false);
  assert.equal(need.cardTitle, '一号', 'the card title is kept for the page');
  A.syncCards(s, [{ id: 't-1', title: '一号', status: 'done' }], T0 + 2, rnd);
  assert.equal(need.done, true);
  assert.equal(A.doneText(need), '任务那边已解决：对应任务已完成');
  assert.equal(report.done, false);
});

test('队长 filing about a card replaces the board item for that card instead of doubling it', () => {
  const s = fresh();
  const card = { id: 't-2', title: '二号', status: 'needs_user', needs_user_entry: 'e1', user_question: '选 A 还是 B？' };
  A.syncCards(s, [card], T0, rnd);
  const derived = A.view(s).needs[0];
  const mine = A.add(s, { kind: 'need', type: 'decide', title: '二号要你在 A、B 里选一个', ask: 'A 快，B 稳；回复 A 或 B', card: 't-2' }, T0 + 1, rnd()).item;
  assert.equal(derived.done, true);
  assert.equal(A.view(s).needs.length, 1);
  assert.equal(A.view(s).needs[0].id, mine.id);
  const fresh2 = A.normalize({});
  A.add(fresh2, { kind: 'need', title: '先登记', card: 't-2' }, T0, rnd());
  A.syncCards(fresh2, [card], T0 + 1, rnd);
  assert.equal(fresh2.items.length, 1, 'an open captain item about the card suppresses the board one');
  assert.equal(fresh2.items[0].cardTitle, '二号');
});

test('a session that was waiting on an answer ticks its item once answered', () => {
  const s = fresh();
  const n = A.add(s, { kind: 'need', title: '会话停在确认窗口', session: 'c-1', sessionWaiting: true }, T0, rnd()).item;
  const other = A.add(s, { kind: 'need', title: '会话需要你登录 Google', session: 'c-2', sessionWaiting: false }, T0, rnd()).item;
  const states = { 'c-1': true, 'c-2': false };
  assert.equal(A.syncSessions(s, (id) => states[id] ?? null, T0 + 1), 0);
  states['c-1'] = false;
  assert.equal(A.syncSessions(s, (id) => states[id] ?? null, T0 + 2), 1);
  assert.equal(n.done, true);
  assert.equal(A.doneText(n), '会话的问题已答复：会话的问题已经答复');
  assert.equal(other.done, false, 'a session that was not waiting when filed is never taken as an answer');
});

test('normalize drops foreign data and keeps open items when pruning', () => {
  const s = A.normalize({ items: [
    { id: 'at-ok-1', kind: 'report', title: ' 一句\n话 ', created: T0 },
    { id: 'bad', kind: 'report', title: 'x', created: T0 },
    { id: 'at-ok-2', kind: 'need', type: 'nope', title: 'y', created: T0, done: true, doneBy: 'hacker', doneAt: T0 },
    { id: 'at-ok-1', kind: 'report', title: 'dup', created: T0 },
    { id: 'at-ok-3', kind: 'report', title: '', created: T0 },
  ] });
  assert.deepEqual(s.items.map((i) => i.id), ['at-ok-1', 'at-ok-2']);
  assert.equal(s.items[0].title, '一句 话');
  assert.equal(s.items[1].type, 'other');
  assert.equal(s.items[1].doneBy, '');
  const big = fresh();
  for (let i = 0; i < 210; i++) A.resolve(big, A.add(big, { kind: 'report', title: 'r' + i }, T0 + i, rnd()).item.id, 'user', '', T0 + i);
  A.add(big, { kind: 'need', title: '还开着' }, T0, rnd());
  assert.equal(A.prune(big), 10);
  assert.equal(big.items.length, 201);
  assert.ok(big.items.some((i) => !i.done));
  assert.ok(!big.items.some((i) => i.title === 'r0'), 'the oldest finished go first');
});

test('list text for 队长 and the phone view', () => {
  const s = fresh();
  const n = A.add(s, { kind: 'need', type: 'pay', title: 'DeepSeek 余额剩 ¥10', ask: '充值或告诉队长停用兜底', project: 'agentdeck', card: 't-9' }, T0, rnd()).item;
  const r = A.add(s, { kind: 'report', title: '额度兜底调研回来了', files: ['/Users/x/report.md'] }, T0 - 60_000, rnd()).item;
  A.reply(s, r.id, '看过了，按推荐的来', 'desktop', T0 + 1, 'attention-x');
  const text = A.listText(s, false, T0 + 2);
  assert.match(text, /待我处理：1 件要用户处理，0 条结果汇报。/);
  assert.match(text, new RegExp(`- ${n.id}【要你处理·等你付款】DeepSeek 余额剩 ¥10（项目 agentdeck，卡片 t-9，刚刚，用户未读）`));
  assert.match(text, /要用户做：充值或告诉队长停用兜底/);
  assert.doesNotMatch(text, /额度兜底调研/);
  const all = A.listText(s, true, T0 + 2);
  assert.match(all, /最近解决的 1 条：/);
  assert.match(all, /用户回复：看过了，按推荐的来/);
  const phone = A.phoneView(s);
  assert.deepEqual(phone.items.map((i) => i.id), [n.id, r.id]);
  assert.equal(phone.items[0].label, '等你付款');
  assert.equal(phone.items[1].doneText, '你已回复');
  assert.equal(phone.items[1].replies[0].text, '看过了，按推荐的来');
  assert.equal('notice' in phone.items[1].replies[0], false);
  assert.equal(phone.counts.badge, 1);
  assert.equal(A.badgeTitle(phone.counts), '待我处理：1 件要你处理');
});

test('times read the way the page shows them', () => {
  const now = new Date(2026, 9, 6, 12, 30).getTime();
  assert.equal(A.when(now - 10_000, now), '刚刚');
  assert.equal(A.when(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(A.when(new Date(2026, 9, 6, 9, 5).getTime(), now), '今天 09:05');
  assert.equal(A.when(new Date(2026, 9, 5, 22, 0).getTime(), now), '昨天 22:00');
  assert.equal(A.when(new Date(2026, 9, 1, 8, 0).getTime(), now), '10/1 08:00');
});
