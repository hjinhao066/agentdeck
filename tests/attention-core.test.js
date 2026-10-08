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
  assert.deepEqual(v.counts, { need: 2, reports: 1, unreadReports: 1, unread: 3, badge: 2, open: 3 }, 'the number is 要你处理 only');
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
  assert.deepEqual([r.done, r.doneBy, r.readAt], [true, 'seen', T0 + 5], 'a report seen on the page goes to 已读');
  assert.equal(A.resolve(s, r.id, 'user', '', T0 + 6).changed, false);
  assert.equal(A.doneText(r), '你看过了');
  // Reading a need only takes its dot away: it stays until it is answered or done.
  assert.equal(A.markRead(s, [n.id], T0 + 5), 1);
  assert.deepEqual([n.done, n.readAt, A.counts(s).need], [false, T0 + 5, 1]);
  assert.equal(A.markRead(s, [n.id], T0 + 6), 0);
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

test('a card that stops for the user is never filed by itself: 队长 decides and asks', () => {
  const s = fresh();
  const cards = [
    { id: 't-ask', project: 'xhs', title: '小红书面经库审计', status: 'needs_user', needs_user_entry: '2026-10-06T04:00:00.000Z', latest_receipt: '验收完成，判定【通过】。会话回执逐项核实均属实：入库46篇' },
    { id: 't-held', project: 'muse', title: 'Muse 冒烟', status: 'doing', flag: 'held', rework_count: 2, latest_receipt: '不通过：报告缺来源', last_failure_attempt: 'a2' },
    { id: 't-q', project: 'agentdeck', title: '修复登录', status: 'needs_user', user_question: '要不要把旧数据一起迁移？' },
  ];
  assert.equal(A.syncCards(s, cards, T0), 0);
  assert.equal(s.items.length, 0);
  assert.equal('cardNeeds' in A, false);
});

test('quick answers: a need may offer short options after one clear question', () => {
  const s = fresh();
  const n = A.add(s, { kind: 'need', type: 'decide', title: 'Muse 冒烟测试连续两次没过，已经停下', ask: '还要继续做吗？', options: ['换个做法再试', ' 先放着 ', '不做了', '先放着', ''], card: 't-held' }, T0, rnd()).item;
  assert.deepEqual(n.options, ['换个做法再试', '先放着', '不做了'], 'trimmed, empty and repeated ones dropped, order kept');
  assert.throws(() => A.add(s, { kind: 'need', title: 'x', options: ['好'] }, T0, rnd()), /--ask/);
  assert.throws(() => A.add(s, { kind: 'report', title: 'x', options: ['好'] }, T0, rnd()), /只用于 need/);
  assert.throws(() => A.add(s, { kind: 'need', title: 'x', ask: '选哪个？', options: ['1', '2', '3', '4', '5', '6', '7'] }, T0, rnd()), /最多 6 个/);
  assert.throws(() => A.add(s, { kind: 'need', title: 'x', ask: '选哪个？', options: ['很'.repeat(25)] }, T0, rnd()), /每个最多 24 字/);
  // The answer carries the choices it was picked from.
  assert.match(A.replyNotice(n, '先放着'), /当时请用户做的：还要继续做吗？\n当时给的选项：换个做法再试 \/ 先放着 \/ 不做了\n用户的回复：先放着/);
  assert.match(A.listText(s, false, T0 + 1), /可选回答：换个做法再试 \/ 先放着 \/ 不做了/);
  const phone = A.phoneItem(n);
  assert.deepEqual([phone.label, phone.options], ['等你拍板', ['换个做法再试', '先放着', '不做了']]);
  // Stored and read back; a stored option that is too long is not shown.
  const back = A.normalize(JSON.parse(JSON.stringify({ items: [{ ...n, options: [...n.options, '很'.repeat(25)] }] })));
  assert.deepEqual(back.items[0].options, n.options);
  assert.deepEqual(A.normalize({ items: [{ id: 'at-r-0001', kind: 'report', title: 'r', created: T0, options: ['a'] }] }).items[0].options, []);
});

test('migration: the board items 1.9 filed by itself go once, 队长 hears which cards they were', () => {
  const RECEIPT = '验收完成，判定【通过】。会话回执逐项核实均属实：入库46篇，真题 172→126';
  const raw = { version: 1, items: [
    { id: 'at-old-0001', kind: 'need', type: 'question', title: '「小红书面经库审计」停下来等你回答', ask: RECEIPT, project: 'xhs', card: 't-audit', cardTitle: '小红书面经库审计', source: 'card', key: 'needs:t-audit:e1', created: T0 },
    { id: 'at-old-0002', kind: 'need', type: 'review', title: '「Muse 冒烟」验收没过 2 次，已经停下', ask: '决定还做不做、要不要换个做法（回复会交给队长）。', card: 't-held', cardTitle: 'Muse 冒烟', source: 'card', key: 'held:t-held:a2', created: T0 },
    { id: 'at-old-0003', kind: 'need', type: 'question', title: '「旧卡」停下来等你回答', ask: '旧问题', card: 't-done', source: 'card', key: 'needs:t-done:e0', created: T0, done: true, doneAt: T0, doneBy: 'card' },
    { id: 'at-old-0004', kind: 'need', type: 'question', title: '「答过的卡」停下来等你回答', ask: '要不要一起踢下线？', detail: '任务说明：登录', card: 't-ans', source: 'card', key: 'needs:t-ans:e0', created: T0, done: true, doneAt: T0 + 5, doneBy: 'reply', replies: [{ text: '一起踢', at: T0 + 5 }] },
    { id: 'at-mine-001', kind: 'need', type: 'decide', title: '队长自己登记的', ask: '选 A 还是 B？', card: 't-audit', source: 'captain', created: T0 },
  ] };
  const s = A.normalize(raw);
  assert.equal(s.version, 3);
  const { changed, moved } = A.migrate(s, raw.version);
  assert.equal(changed, true);
  assert.deepEqual(moved.map((i) => i.id), ['at-old-0001', 'at-old-0002'], 'the open unanswered ones');
  assert.deepEqual(s.items.map((i) => i.id), ['at-old-0004', 'at-mine-001']);
  const answered = s.items[0];
  assert.equal(answered.ask, '', 'no pasted receipt as 要你做, even if put back');
  assert.equal(answered.detail, '当时贴出的原文：要不要一起踢下线？\n\n任务说明：登录');
  assert.match(s.toCaptain, /「待我处理」不再由程序自动登记停下来的卡片/);
  assert.match(s.toCaptain, /下面 2 条已从用户的待处理里撤下/);
  assert.match(s.toCaptain, /- 卡片 t-audit「小红书面经库审计」（项目 xhs）：原来贴出的是「验收完成，判定【通过】/);
  assert.match(s.toCaptain, /- 卡片 t-held「Muse 冒烟」：/);
  assert.match(s.toCaptain, /inbox need --card 卡片id --title "一句大白话说明" --ask "一句明确的问题" --options/);
  // The note survives a save until it is delivered; the migration never runs twice.
  const saved = A.normalize(JSON.parse(JSON.stringify(s)));
  assert.equal(saved.toCaptain, s.toCaptain);
  assert.deepEqual(A.migrate(saved, saved.version), { changed: false, moved: [] });
  // A store with nothing from the board: nothing to say.
  const clean = A.normalize({ version: 1, items: [raw.items[4]] });
  assert.deepEqual(A.migrate(clean, 1), { changed: false, moved: [] });
  assert.equal('toCaptain' in clean, false);
  assert.deepEqual(A.migrate(A.normalize(undefined), undefined), { changed: false, moved: [] });
});

test('a captain need tied to a card ticks when the card is done; a report about it never does', () => {
  const s = fresh();
  const need = A.add(s, { kind: 'need', title: '验收卡住：要你拍板', card: 't-1' }, T0, rnd()).item;
  const report = A.add(s, { kind: 'report', title: '卡片 1 做完了', card: 't-1' }, T0, rnd()).item;
  A.syncCards(s, [{ id: 't-1', title: '一号', status: 'review' }], T0 + 1);
  assert.equal(need.done, false);
  assert.equal(need.cardTitle, '一号', 'the card title is kept for the page');
  A.syncCards(s, [{ id: 't-1', title: '一号', status: 'done' }], T0 + 2);
  assert.equal(need.done, true);
  assert.equal(A.doneText(need), '任务那边已解决：对应任务已完成');
  assert.equal(report.done, false);
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
  assert.match(text, /待我处理：1 件要用户处理，0 条结果汇报用户还没看。/);
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

test('two columns: a report filed with its 队长 turn is read when that reply is seen; 要你处理 never is', () => {
  const s = fresh();
  const said = A.add(s, { kind: 'report', title: '迁移预检通过', turn: 'tq1abc' }, T0, rnd()).item;
  const away = A.add(s, { kind: 'report', title: '夜里跑完的回归', turn: 'tq2def' }, T0 + 1, rnd()).item;
  const loose = A.add(s, { kind: 'report', title: '没有对应回复的汇报' }, T0 + 2, rnd()).item;
  const need = A.add(s, { kind: 'need', title: '要你拍板', ask: '迁移还是保留？', turn: 'tq1abc' }, T0 + 3, rnd()).item;
  assert.equal(need.turn, '', 'only a report is tied to a reply');
  assert.equal(A.add(s, { kind: 'report', title: 'x', turn: '../bad' }, T0, rnd()).item.turn, '');
  A.resolve(s, s.items[s.items.length - 1].id, 'captain', '', T0 + 4);
  assert.deepEqual([...A.unseenByTurn(s)], [['tq1abc', [said.id]], ['tq2def', [away.id]]]);
  assert.deepEqual(A.counts(s), { need: 1, reports: 3, unreadReports: 3, unread: 4, badge: 1, open: 4 });
  assert.equal(A.badgeTitle(A.counts(s)), '待我处理：1 件要你处理，3 条汇报你还没看');
  // The user saw the reply the first report was said in: it goes to 已读, not to 没看.
  assert.equal(A.markRead(s, A.unseenByTurn(s).get('tq1abc'), T0 + 10, 'chat'), 1);
  assert.deepEqual([said.done, said.doneBy, A.doneText(said)], [true, 'chat', '你在队长对话里看过了']);
  assert.deepEqual(A.view(s).reports.map((i) => i.id), [loose.id, away.id]);
  assert.equal(A.markRead(s, [need.id], T0 + 11, 'chat'), 1);
  assert.equal(need.done, false, 'reading never ticks what needs the user');
  assert.equal(A.badgeTitle(A.counts(s)), '待我处理：1 件要你处理，2 条汇报你还没看');
  // Put back: a report returns to 没看.
  A.reopen(s, said.id, T0 + 12);
  assert.deepEqual([said.done, said.readAt], [false, 0]);
  A.resolve(s, need.id, 'user', '', T0 + 13);
  assert.equal(A.badgeTitle(A.counts(s)), '待我处理：没有要你处理的事，3 条汇报你还没看');
  // What the phone gets: the turn, and how a finished item was finished.
  A.markRead(s, [away.id], T0 + 14);
  const phone = A.phoneView(s).items;
  assert.equal(phone.find((i) => i.id === said.id).turn, 'tq1abc');
  assert.equal(phone.find((i) => i.id === away.id).doneBy, 'seen');
  // Answering a report already seen: the record says the user replied.
  A.reply(s, away.id, '再跑一次', 'phone', T0 + 15, 'attention-y');
  assert.deepEqual([away.doneBy, A.doneText(away)], ['reply', '你已回复']);
  // Saved and read back, the link survives.
  assert.equal(A.normalize(JSON.parse(JSON.stringify(s))).items.find((i) => i.id === said.id).turn, 'tq1abc');
});

test('migration to version 3: a report already read leaves 没看; unread ones and needs stay', () => {
  const raw = { version: 2, items: [
    { id: 'at-v2-read', kind: 'report', title: '读过没点知道了', created: T0, readAt: T0 + 5 },
    { id: 'at-v2-new1', kind: 'report', title: '还没看', created: T0 + 1 },
    { id: 'at-v2-need', kind: 'need', title: '读过的要你处理', created: T0, readAt: T0 + 5 },
  ] };
  const s = A.normalize(raw);
  assert.deepEqual(A.migrate(s, raw.version).changed, true);
  assert.deepEqual(s.items.map((i) => [i.id, i.done, i.doneBy]), [['at-v2-read', true, 'seen'], ['at-v2-new1', false, ''], ['at-v2-need', false, '']]);
  assert.equal(s.items[0].doneAt, T0 + 5);
  assert.deepEqual(A.migrate(s, 3), { changed: false, moved: [] });
  assert.equal(A.migrate(A.normalize({ version: 2, items: [raw.items[1]] }), 2).changed, false);
});

test('times read the way the page shows them', () => {
  const now = new Date(2026, 9, 6, 12, 30).getTime();
  assert.equal(A.when(now - 10_000, now), '刚刚');
  assert.equal(A.when(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(A.when(new Date(2026, 9, 6, 9, 5).getTime(), now), '今天 09:05');
  assert.equal(A.when(new Date(2026, 9, 5, 22, 0).getTime(), now), '昨天 22:00');
  assert.equal(A.when(new Date(2026, 9, 1, 8, 0).getTime(), now), '10/1 08:00');
});

test('the phone hears 队长的问题 and quick answers under the item title, never the detail', () => {
  assert.deepEqual(A.phonePush({ title: '确认密码策略', ask: '选 8 位还是 12 位？', options: ['8 位', '12 位', '8 位', ''], detail: '验收完成，判定【通过】' }),
    { title: '确认密码策略', message: '选 8 位还是 12 位？\n可选回答：8 位 / 12 位' });
  assert.deepEqual(A.phonePush({ title: '去登录 Claude' }), { title: '去登录 Claude', message: '去登录 Claude' });
  assert.equal(A.phonePush({ title: 'x'.repeat(150) }).title.length, 100);
  assert.equal(A.phonePush({ title: '  多行\n标题  ', ask: '问\n题' }).message, '问 题');
});
