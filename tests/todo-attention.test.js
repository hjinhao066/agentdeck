'use strict';
// 待办 @ai → 队长 → 待我处理: what 队长 writes back on a 待办 is filed on the
// 待我处理 page of the computer that handed it to AI, once per answer, and shows
// on the phone's 待办 list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../attention-core');
const Hub = require('../mobile-web/hub/core');
const { TodoStore, phoneView } = require('../todo-store');

const T0 = Date.UTC(2026, 9, 8, 4, 0, 0);
const DEV = 'dev-mac-0001', OTHER = 'dev-win-0002';
const TASK = 'todo-' + 'a'.repeat(64);
function todo(ai, extra = {}) {
  return { id: 'td-11111111-aaaa', text: '@ai 找一本《置身事内》的 EPUB', done: false, deleted: false, ...extra,
    ai: ai && { revision: 'a'.repeat(64), taskId: TASK, ownerDevice: DEV, deliveredAt: '2026-10-08T04:00:00.000Z', files: [], message: '', ...ai } };
}
const open = (s) => s.items.filter((i) => !i.done);

test('queued and working write nothing; needs_user files one 要你处理 question with the card', () => {
  const s = A.normalize({});
  assert.equal(A.syncTodos(s, [todo({ status: 'queued' }), todo({ status: 'working' }), todo(null)], DEV, T0), 0);
  assert.equal(s.items.length, 0);
  const asked = [todo({ status: 'needs_user', message: '等你提供病历和 CT 报告放在哪个文件夹' })];
  assert.equal(A.syncTodos(s, asked, DEV, T0), 1);
  const [need] = open(s);
  assert.equal(need.kind, 'need');
  assert.equal(need.type, 'question');
  assert.equal(need.source, 'todo');
  assert.equal(need.card, TASK);
  assert.equal(need.project, 'todo');
  assert.match(need.title, /^AI 在等你：@ai 找一本/);
  assert.equal(need.ask, '等你提供病历和 CT 报告放在哪个文件夹');
  assert.equal(A.counts(s).badge, 1);
  // The same answer is filed once, even after the user ticked it.
  assert.equal(A.syncTodos(s, asked, DEV, T0 + 1000), 0);
  A.resolve(s, need.id, 'user', '', T0 + 2000);
  assert.equal(A.syncTodos(s, asked, DEV, T0 + 3000), 0);
  assert.equal(s.items.length, 1);
  // The user's reply reaches 队长 with the card id and where it came from.
  const notice = A.replyNotice(need, '在 ~/Documents/病历');
  assert.match(notice, new RegExp(TASK));
  assert.match(notice, /来自待办（@ai）/);
});

test('done files a 结果汇报 with the files and settles the question; failed asks whether to retry', () => {
  const s = A.normalize({});
  A.syncTodos(s, [todo({ status: 'needs_user', message: '缺材料' })], DEV, T0);
  A.syncTodos(s, [todo({ status: 'working' })], DEV, T0 + 1000);
  assert.equal(open(s).length, 0, 'the AI went on: the question is settled');
  assert.equal(s.items[0].doneNote, 'AI 已接着办');
  const files = ['/Users/me/reports/book.epub', '/Users/me/reports/summary.md'];
  assert.equal(A.syncTodos(s, [todo({ status: 'done', files, message: '找到了正版 EPUB' })], DEV, T0 + 2000), 1);
  const [report] = open(s);
  assert.equal(report.kind, 'report');
  assert.match(report.title, /^AI 办完了：/);
  assert.deepEqual(report.files, files);
  assert.equal(report.detail, '找到了正版 EPUB');
  assert.equal(A.counts(s).badge, 0);
  assert.equal(A.counts(s).unreadReports, 1);

  const f = A.normalize({});
  A.syncTodos(f, [todo({ status: 'failed', message: '网上没有公开的电子版' })], DEV, T0);
  const [failed] = open(f);
  assert.equal(failed.kind, 'need');
  assert.equal(failed.type, 'decide');
  assert.deepEqual(failed.options, ['重试', '先放着']);
  assert.match(failed.ask, /网上没有公开的电子版 要重试还是先放着？/);
  // A second write of the same failure (the alert marker) changes nothing.
  assert.equal(A.syncTodos(f, [todo({ status: 'failed', message: '网上没有公开的电子版', exceptionNotifiedAt: 'x' })], DEV, T0 + 1), 0);
  // The 待办 was edited or deleted: the old question goes.
  A.syncTodos(f, [todo(null)], DEV, T0 + 2);
  assert.equal(open(f).length, 0);
  assert.equal(f.items[0].doneNote, '这条待办已改动或删除');
});

test('only the computer that handed it to AI files it; an unread list changes nothing', () => {
  const s = A.normalize({});
  const items = [todo({ status: 'done', files: ['/tmp/a.pdf'] })];
  assert.equal(A.syncTodos(s, items, OTHER, T0), 0);
  assert.equal(A.syncTodos(s, items, '', T0), 0);
  assert.equal(A.syncTodos(s, null, DEV, T0), 0);
  assert.equal(A.syncTodos(s, [todo({ status: 'done', files: ['/tmp/a.pdf'] }, { deleted: true })], DEV, T0), 0);
  assert.equal(s.items.length, 0);
});

test('what was filed survives a reload and pruning, so an old answer never comes back', () => {
  const s = A.normalize({});
  const items = [todo({ status: 'done', files: ['/tmp/a.pdf'] })];
  A.syncTodos(s, items, DEV, T0);
  A.markRead(s, [s.items[0].id], T0 + 1);
  A.prune(s, 0);
  assert.equal(s.items.length, 0);
  const again = A.normalize(JSON.parse(JSON.stringify(s)));
  assert.equal(again.todoFiled.length, 1);
  assert.equal(A.syncTodos(again, items, DEV, T0 + 2), 0);
  // A new answer (a new version of the 待办) is a new item.
  assert.equal(A.syncTodos(again, [todo({ status: 'done', files: ['/tmp/b.pdf'] })], DEV, T0 + 3), 1);
});

test('the phone shows the AI state and file names only, never the internal ids or folders', () => {
  const [item] = phoneView([{ ...todo({ status: 'done', files: ['/Users/me/r/book.epub'], message: '好了', updated: '2026-10-08T04:01:00.000Z' }),
    created: '2026-10-08T04:00:00.000Z', updated: '2026-10-08T04:01:00.000Z', doneAt: null }]);
  const [clean] = Hub.cleanTodos({ items: [item] });
  assert.deepEqual(clean.ai, { status: 'done', delivered: true, updated: '2026-10-08T04:01:00.000Z', message: '好了', files: ['book.epub'] });
  const [odd] = Hub.cleanTodos({ items: [{ ...item, ai: { status: 'guessed' } }] });
  assert.equal(odd.ai, undefined);
  const [plain] = Hub.cleanTodos({ items: [{ ...item, ai: null }] });
  assert.equal(plain.ai, undefined);
});

test('a copy built from what the phone saw waits for the original before anyone hands it to AI', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-todo-seen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-08T04:00:00.000Z');
  const mac = new TodoStore(dir, { deviceId: DEV, now: () => clock });
  const win = new TodoStore(dir, { deviceId: OTHER, now: () => clock });
  const item = mac.add({ text: '@ai 查一下周末的火车' });
  clock += 1000;
  // The Windows computer has an older copy of this id (written before the
  // edit) and the phone saw the edited text: it ticks it there.
  const macFile = path.join(dir, DEV + '.json');
  const saved = fs.readFileSync(macFile, 'utf8');
  fs.rmSync(macFile);
  win.update({ id: item.id, base: { text: item.text, done: false, created: item.created, updated: item.updated }, done: false, source: 'phone' });
  const own = JSON.parse(fs.readFileSync(path.join(dir, OTHER + '.json'), 'utf8')).items[0];
  assert.equal(own.awaitingOrigin, true);
  fs.writeFileSync(macFile, saved);
  const merged = win.list().find((i) => i.id === item.id);
  assert.equal(merged.awaitingOrigin, false);
  assert.equal(merged.textDevice, DEV, 'the computer that recorded it hands it to AI');
});

test('phone merge: a later tick on a stale copy keeps the AI state of the same version, as the desktop does', () => {
  const { merge } = require('../todo-store');
  const version = { id: 'td-ai-phone-merge-1', text: '@ai 找书', created: '2026-10-08T08:00:00.000Z', textUpdated: '2026-10-08T08:00:00.000Z', textDevice: DEV, done: false, doneAt: null };
  const queued = { revision: 'a'.repeat(64), taskId: TASK, ownerDevice: DEV, status: 'queued', updated: '2026-10-08T08:00:30.000Z', deliveredAt: null, files: [], message: '' };
  const mac = { ...version, updated: '2026-10-08T08:02:00.000Z', ai: { ...queued, status: 'done', round: 1, updated: '2026-10-08T08:02:00.000Z', deliveredAt: '2026-10-08T08:01:00.000Z', files: ['/Users/me/reports/book.epub'] } };
  const tick = { ...version, done: true, doneAt: '2026-10-08T08:03:00.000Z', updated: '2026-10-08T08:03:00.000Z', ai: queued };
  const untick = { ...version, updated: '2026-10-08T08:04:00.000Z', ai: queued };
  for (const stale of [tick, untick]) {
    const desktop = merge([[mac], [stale]]).get(version.id);
    for (const order of [[mac, stale], [stale, mac]]) {
      const sources = order.map((item, i) => ({ id: i ? 'win' : 'mac', todos: Hub.cleanTodos({ items: phoneView([item]) }) }));
      const { open, done } = Hub.mergeTodos(sources);
      const [phone] = [...open, ...done];
      assert.equal(phone.done, stale.done, 'the later tick still wins');
      assert.equal(phone.ai.status, desktop.ai.status);
      assert.equal(phone.ai.status, 'done');
      assert.deepEqual(phone.ai.files, ['book.epub']);
    }
  }
  // The answer to a phone tick (no textUpdated, no ai) is the same version by its text.
  const answer = { id: version.id, text: version.text, done: true, doneAt: '2026-10-08T08:07:00.000Z', created: version.created, updated: '2026-10-08T08:07:00.000Z' };
  const ticked = Hub.mergeTodos([{ id: 'mac', todos: Hub.cleanTodos({ items: phoneView([mac]) }) }, { id: 'win', todos: Hub.cleanTodos({ items: [answer] }) }]).done[0];
  assert.equal(ticked.done, true);
  assert.equal(ticked.ai.status, 'done');
  // A different content version never inherits the old AI state.
  const edited = { ...version, text: '@ai 找另一本书', textUpdated: '2026-10-08T08:05:00.000Z', updated: '2026-10-08T08:05:00.000Z', ai: null };
  const sources = [mac, edited].map((item, i) => ({ id: i ? 'win' : 'mac', todos: Hub.cleanTodos({ items: phoneView([item]) }) }));
  const [phone] = Hub.mergeTodos(sources).open;
  assert.equal(phone.text, '@ai 找另一本书');
  assert.equal(phone.ai, undefined);
  // The same text written again later is a new version too.
  const rewritten = { ...version, textUpdated: '2026-10-08T08:06:00.000Z', updated: '2026-10-08T08:06:00.000Z', ai: null };
  const again = [mac, rewritten].map((item, i) => ({ id: i ? 'win' : 'mac', todos: Hub.cleanTodos({ items: phoneView([item]) }) }));
  assert.equal(Hub.mergeTodos(again).open[0].ai, undefined);
});

test('rounds: waiting or failing again after the AI went back to work is filed again; a refresh or same-state retry is not', async (t) => {
  const { TaskStore } = require('../task-board');
  const { TodoAI, taskId } = require('../todo-ai');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-todo-rounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const todos = new TodoStore(path.join(root, 'todos'), { deviceId: DEV });
  const ai = new TodoAI({ todos, tasks: new TaskStore(path.join(root, 'tasks')), deliver: () => {}, notify: async () => {} });
  const s = A.normalize({});
  let clock = T0;
  const sync = () => A.syncTodos(s, todos.list(), DEV, (clock += 1000));
  const needs = () => open(s).filter((i) => i.kind === 'need');
  for (const [state, message] of [['failed', '网络错误'], ['needs_user', '等你提供体检报告']]) {
    const item = todos.add({ text: `@ai ${state} 轮次` });
    ai.scan();
    const set = (status, msg = '') => ai.status({ id: item.id, taskId: taskId(item), status, message: msg });
    await set(state, message);
    assert.equal(sync(), 1);
    assert.equal(sync(), 0, 'a refresh files nothing');
    await set(state, message);
    assert.equal(sync(), 0, 'a same-state retry with the same answer is the same item');
    const [first] = needs();
    A.reply(s, first.id, '重试', 'desktop', clock, 'r-1');
    assert.equal(needs().length, 0);
    await set('working');
    sync();
    await set(state, message);
    assert.equal(sync(), 1, 'the second ' + state + ' is a new round');
    assert.equal(needs().length, 1);
    assert.notEqual(needs()[0].id, first.id);
    assert.equal(needs()[0].ask.startsWith(message), true);
    // Missing the working state in between (no refresh then) still counts:
    // the open one of the earlier round is settled, the new round filed.
    const second = needs()[0];
    await set('working');
    await set(state, message);
    assert.equal(sync(), 2);
    assert.equal(needs().length, 1);
    assert.notEqual(needs()[0].id, second.id);
    assert.equal(s.items.find((i) => i.id === second.id).doneNote, 'AI 已接着办');
    A.resolve(s, needs()[0].id, 'user', '', clock);
  }
});
