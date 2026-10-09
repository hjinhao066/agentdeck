'use strict';
// One 待办 on two computers and the phone, end to end through the real code:
// each computer has its own TodoStore folder (sync() is the 30-minute git job)
// and its own TodoAI writing 队长's answers; the phone gets what api/todos
// serves (phone(), phoneWrite() behind todoRequest) and joins it with the hub's
// cleanTodos / todoBase / mergeTodos. Every version and clock comes from a real
// write, none is made up. For the same files the phone and both desktops must
// show the same text, checkbox, AI state and files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TodoStore, merge } = require('../todo-store');
const { TodoAI, taskId } = require('../todo-ai');
const { TaskStore } = require('../task-board');
const { todoRequest, TODO_BASE_KEYS } = require('../mobile-web');
const Hub = require('../mobile-web/hub/core');

// An older phone page (or a computer on an older build) sends only these.
const OLD_BASE_KEYS = ['text', 'done', 'doneAt', 'created', 'updated'];

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-todo-phone-desktop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-10-08T08:00:00.000Z');
  const clock = () => now;
  const computer = (id) => {
    const todos = new TodoStore(path.join(root, id, 'todos'), { deviceId: 'dev-' + id, now: clock });
    const tasks = new TaskStore(path.join(root, id, 'tasks'));
    const deliveries = [];
    const ai = new TodoAI({ todos, tasks, deliver: (x) => deliveries.push(x), notify: async () => {} });
    return { id, todos, tasks, ai, deliveries };
  };
  const mac = computer('mac'), win = computer('win');
  const file = (m) => path.join(m.todos.dir, m.todos.deviceId + '.json');
  const send = (from, to) => {
    if (!fs.existsSync(file(from))) return;
    fs.mkdirSync(to.todos.dir, { recursive: true });
    fs.copyFileSync(file(from), path.join(to.todos.dir, path.basename(file(from))));
  };
  const sync = () => { send(mac, win); send(win, mac); };
  const later = (ms = 60_000) => { now += ms; };
  const product = (name) => { const p = path.join(root, name); fs.writeFileSync(p, 'x'); return p; };
  const find = (m, id) => m.todos.all().find((x) => x.id === id);
  // 队长 answers through the computer that handed it to AI, as `todo status` does.
  const answer = async (m, id, status, extra = {}) => {
    later(1000);
    const item = m.todos.list().find((x) => x.id === id);
    return m.ai.status({ id, taskId: taskId(item), status, ...extra });
  };

  // The phone: the last answer of each computer it can reach. A write's answer
  // replaces that computer's copy at once (app.js keepTodo), as JSON would.
  const answers = new Map();
  const wire = (value) => JSON.parse(JSON.stringify(value));
  const poll = (...machines) => { for (const m of machines) answers.set(m.id, Hub.cleanTodos(wire(m.todos.phone()))); };
  const phoneList = () => { const { open, done } = Hub.mergeTodos([...answers].map(([id, todos]) => ({ id, todos }))); return [...open, ...done]; };
  const phoneItem = (id) => phoneList().find((x) => x.id === id);
  const phoneTick = (writer, id, keys = TODO_BASE_KEYS) => {
    later(1000);
    const t = phoneItem(id);
    const input = todoRequest(wire({ op: 'update', id, done: !t.done, base: Hub.todoBase(t, keys) }));
    assert.ok(input, 'the server accepts what the phone sends');
    const item = wire(writer.todos.phoneWrite(input));
    const [clean] = Hub.cleanTodos({ items: [item] });
    const list = answers.get(writer.id) || [];
    const at = list.findIndex((x) => x.id === clean.id);
    if (at >= 0) list[at] = clean; else list.push(clean);
    answers.set(writer.id, list);
    return item;
  };

  // What a person sees: on the desktop the merged item, on the phone the hub's.
  const fromDesktop = (m, id) => {
    const x = m.todos.list().find((i) => i.id === id);
    return x && { text: x.text, done: x.done, ai: x.ai ? { status: x.ai.status, files: x.ai.files.map((f) => path.basename(f)) } : null };
  };
  const fromPhone = (id) => {
    const x = phoneItem(id);
    return x && { text: x.text, done: x.done, ai: x.ai ? { status: x.ai.status, files: x.ai.files } : null };
  };
  // After a full sync both desktops and the phone (polling both) agree.
  const settled = (id) => {
    sync(); poll(mac, win);
    const seen = fromDesktop(mac, id);
    assert.deepEqual(fromDesktop(win, id), seen, 'both desktops');
    assert.deepEqual(fromPhone(id), seen, 'phone and desktop');
    // File order never matters.
    const lists = [mac, win].map((m) => JSON.parse(fs.readFileSync(file(m), 'utf8')).items);
    assert.deepEqual(merge(lists).get(id), merge([...lists].reverse()).get(id));
    return seen;
  };
  return { mac, win, sync, send, later, product, find, answer, poll, phoneItem, phoneTick, fromDesktop, fromPhone, settled };
}

// The review's case: Mac recorded 「@ai 找第一本书」, Windows still holds that
// version queued; Mac changed it to 「@ai 找第二本书」 and 队长 finished it with
// book.epub; the phone ticks the new text through Windows, which has not synced.
for (const [label, keys] of [['current phone page', TODO_BASE_KEYS], ['older phone page', OLD_BASE_KEYS]]) {
  test(`phone tick through a stale computer after the text changed and AI finished (${label})`, async (t) => {
    const w = world(t);
    const { mac, win } = w;
    const { id } = mac.todos.add({ text: '@ai 找第一本书' });
    mac.ai.scan();
    w.sync();
    assert.equal(w.find(win, id).ai.status, 'queued');
    w.later();
    mac.todos.update({ id, text: '@ai 找第二本书' });
    mac.ai.scan();
    await w.answer(mac, id, 'working');
    await w.answer(mac, id, 'done', { files: [w.product('book.epub')] });
    const v2 = w.find(mac, id);

    w.poll(mac, win);
    assert.deepEqual(w.fromPhone(id), { text: '@ai 找第二本书', done: false, ai: { status: 'done', files: ['book.epub'] } });
    const written = w.phoneTick(win, id, keys);
    assert.equal(written.done, true);
    if (keys === TODO_BASE_KEYS) {
      // Windows takes the whole content version the phone saw, without the AI
      // state of the old text; it waits for Mac's file to learn who owns it.
      assert.deepEqual([written.text, written.textUpdated, written.ai], ['@ai 找第二本书', v2.textUpdated, undefined]);
      assert.equal(w.find(win, id).awaitingOrigin, true);
    } else {
      // Without the version Windows keeps its own (older) text and its queued
      // state for it: the newer text from Mac still wins on the phone.
      assert.equal(written.text, '@ai 找第一本书');
    }
    // The phone right after the tick, and after polling Windows again.
    const expected = { text: '@ai 找第二本书', done: true, ai: { status: 'done', files: ['book.epub'] } };
    assert.deepEqual(w.fromPhone(id), expected);
    w.poll(win);
    assert.deepEqual(w.fromPhone(id), expected);
    // Windows never hands Mac's text to AI.
    win.ai.scan();
    assert.equal(win.tasks.list({ archived: true }).length, 0);
    assert.equal(win.deliveries.length, 0);

    assert.deepEqual(w.settled(id), expected);
    assert.equal(w.find(win, id).textDevice, 'dev-mac');
    assert.equal(w.find(win, id).awaitingOrigin, false);
    mac.ai.scan(); win.ai.scan();
    assert.equal(mac.tasks.list({ archived: true }).length, 2, 'one card per text version, none added by the tick');
    assert.equal(win.tasks.list({ archived: true }).length, 0);
    // Unticking from the phone, through either computer, keeps it all.
    w.phoneTick(win, id, keys);
    assert.deepEqual(w.settled(id), { ...expected, done: false });
    w.phoneTick(mac, id, keys);
    assert.deepEqual(w.settled(id), expected);
  });
}

test('a stale copy ticked and unticked after AI finished never rolls back the result, on the desktop or through the phone', async (t) => {
  const w = world(t);
  const { mac, win } = w;
  const { id } = mac.todos.add({ text: '@ai 找《置身事内》EPUB' });
  mac.ai.scan();
  w.sync();
  await w.answer(mac, id, 'working');
  await w.answer(mac, id, 'done', { files: [w.product('zhishen.epub')] });
  const finished = { text: '@ai 找《置身事内》EPUB', done: false, ai: { status: 'done', files: ['zhishen.epub'] } };

  // On the Windows desktop, which only has the queued copy.
  w.later();
  win.todos.update({ id, done: true });
  w.poll(mac, win);
  assert.deepEqual(w.fromPhone(id), { ...finished, done: true });
  w.later();
  win.todos.update({ id, done: false });
  w.poll(win);
  assert.deepEqual(w.fromPhone(id), finished);
  assert.deepEqual(w.fromDesktop(win, id), { ...finished, ai: { status: 'queued', files: [] } }, 'Windows itself learns the result at the next sync');
  assert.deepEqual(w.settled(id), finished);

  // Through the phone, while Windows is stale again (Mac answered once more).
  await w.answer(mac, id, 'done', { files: [w.product('zhishen.epub'), w.product('summary.md')] });
  const twoFiles = { ...finished, ai: { status: 'done', files: ['zhishen.epub', 'summary.md'] } };
  w.poll(mac, win);
  w.phoneTick(win, id);
  assert.deepEqual(w.fromPhone(id), { ...twoFiles, done: true });
  w.phoneTick(win, id);
  assert.deepEqual(w.fromPhone(id), twoFiles);
  assert.deepEqual(w.settled(id), twoFiles);
});

test('text changed on the other computer, then ticked: the new text, its owner and its AI state stand everywhere', async (t) => {
  const w = world(t);
  const { mac, win } = w;
  const { id } = mac.todos.add({ text: '买牛奶' });
  w.sync();
  // Windows makes it an AI task; Mac has not received that.
  w.later();
  win.todos.update({ id, text: '@ai 查周末去杭州的火车' });
  win.ai.scan();
  await w.answer(win, id, 'needs_user', { message: '等你说几点出发' });
  w.poll(mac, win);
  const asked = { text: '@ai 查周末去杭州的火车', done: false, ai: { status: 'needs_user', files: [] } };
  assert.deepEqual(w.fromPhone(id), asked);

  // The phone ticks through Mac (the default computer).
  w.phoneTick(mac, id);
  assert.deepEqual(w.fromPhone(id), { ...asked, done: true });
  assert.equal(w.find(mac, id).text, '@ai 查周末去杭州的火车');
  assert.equal(w.find(mac, id).awaitingOrigin, true);
  w.later();
  // Mac unticks it on its own desktop before any sync: it is open again and
  // Mac still does not hand Windows' text to AI.
  mac.todos.update({ id, done: false });
  mac.ai.scan();
  assert.equal(mac.tasks.list({ archived: true }).length, 0);
  assert.deepEqual(w.settled(id), asked);
  assert.equal(w.find(mac, id).textDevice, 'dev-win');
  mac.ai.scan();
  assert.equal(mac.tasks.list({ archived: true }).length, 0);

  // A stale Mac copy ticked on the Mac desktop: the newer text from Windows
  // is not covered by Mac's older text.
  w.later();
  win.todos.update({ id, text: '@ai 查周六上午去杭州的火车' });
  win.ai.scan();
  w.later();
  mac.todos.update({ id, done: true });
  assert.deepEqual(w.settled(id), { text: '@ai 查周六上午去杭州的火车', done: true, ai: { status: 'queued', files: [] } });
});

test('a computer that was offline arrives late: its ticks and deletions keep their own time, the others keep theirs', async (t) => {
  const w = world(t);
  const { mac, win } = w;
  const a = mac.todos.add({ text: '@ai 找第一本书' }).id;
  const b = mac.todos.add({ text: '@ai 整理体检报告' }).id;
  const c = mac.todos.add({ text: '退快递' }).id;
  mac.ai.scan();
  w.sync();

  // Windows goes offline. There the user ticks a and c and deletes b.
  w.later();
  win.todos.update({ id: a, done: true });
  win.todos.update({ id: c, done: true });
  win.todos.remove({ id: b });

  // Meanwhile on the Mac: a is changed and finished, b keeps being worked on,
  // c is ticked and then unticked again.
  w.later();
  mac.todos.update({ id: a, text: '@ai 找第二本书' });
  mac.ai.scan();
  await w.answer(mac, a, 'working');
  await w.answer(mac, a, 'done', { files: [w.product('second.epub')] });
  await w.answer(mac, b, 'working');
  await w.answer(mac, b, 'done', { files: [w.product('report.pdf')] });
  mac.todos.update({ id: c, done: true });
  w.later();
  mac.todos.update({ id: c, done: false });

  // The phone reaches only the Mac.
  w.poll(mac);
  assert.deepEqual(w.fromPhone(a), { text: '@ai 找第二本书', done: false, ai: { status: 'done', files: ['second.epub'] } });
  assert.ok(w.phoneItem(b));

  // Windows comes back.
  assert.deepEqual(w.settled(a), { text: '@ai 找第二本书', done: true, ai: { status: 'done', files: ['second.epub'] } },
    'the late tick still counts; the text changed after it, and the result of that text, stand');
  assert.equal(w.settled(b), undefined, 'an AI answer written later never brings back what the user deleted');
  assert.equal(w.find(mac, b).deleted, true);
  assert.deepEqual(w.settled(c), { text: '退快递', done: false, ai: null }, 'the untick made after the late tick wins');
  // Late arrival the other way round: the phone ticked a through Mac while
  // Windows was offline again; Windows' older copy does not undo it.
  w.later();
  w.phoneTick(mac, a);
  assert.deepEqual(w.fromPhone(a).done, false);
  w.send(win, mac);
  w.later();
  w.send(mac, win);
  assert.deepEqual(w.settled(a), { text: '@ai 找第二本书', done: false, ai: { status: 'done', files: ['second.epub'] } });
});
