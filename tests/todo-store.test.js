'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TodoStore, merge, cleanText, phoneView, TEXT_MAX } = require('../todo-store');

function fixture(t, deviceId = 'dev-mac', clock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-todos-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'todos');
  const make = (id, now) => new TodoStore(dir, { deviceId: id, host: id + '-host', ...(now ? { now } : {}) });
  return { dir, store: make(deviceId, clock), make };
}

test('add stores one line in this computer\'s own file, newest first, with the reserved AI flag', (t) => {
  const { dir, store } = fixture(t);
  const one = store.add({ text: '  退货包裹\n放门口  ' });
  const two = store.add({ text: '买书' });
  assert.match(one.id, /^td-/);
  assert.equal(one.text, '退货包裹 放门口');
  assert.equal(one.ai, null);
  assert.equal(one.source, 'desktop');
  assert.deepEqual(store.list().map((x) => x.id), [two.id, one.id]);
  assert.deepEqual(fs.readdirSync(dir), ['dev-mac.json']);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'dev-mac.json'), 'utf8'));
  assert.equal(doc.version, 1);
  assert.equal(doc.device, 'dev-mac');
  assert.equal(doc.items.length, 2);
  assert.ok(doc.items.every((x) => x.ai === null));
});

test('text is checked: empty, too long and control characters are refused', () => {
  assert.throws(() => cleanText('   '), /不能为空/);
  assert.throws(() => cleanText('x'.repeat(TEXT_MAX + 1)), /最多/);
  assert.equal(cleanText('字'.repeat(TEXT_MAX)).length, TEXT_MAX);
  assert.throws(() => cleanText('a\u0007b'), /不支持/);
  assert.throws(() => cleanText(42), /文字/);
});

test('tick, untick, edit, delete and undo; finished items go after open ones', (t) => {
  const { store } = fixture(t);
  const a = store.add({ text: 'A' }), b = store.add({ text: 'B' });
  const done = store.update({ id: a.id, done: true });
  assert.equal(done.done, true);
  assert.equal(done.doneAt, done.updated);
  assert.deepEqual(store.list().map((x) => [x.text, x.done]), [['B', false], ['A', true]]);
  assert.equal(store.update({ id: a.id, done: false }).doneAt, null);
  assert.equal(store.update({ id: b.id, text: 'B2' }).text, 'B2');
  store.remove({ id: b.id });
  assert.deepEqual(store.list().map((x) => x.text), ['A']);
  // The deletion keeps the text so 撤销 can bring it back.
  assert.equal(store.update({ id: b.id, deleted: false }).text, 'B2');
  assert.deepEqual(store.list().map((x) => x.text).sort(), ['A', 'B2']);
  assert.throws(() => store.update({ id: 'td-missing-0000', done: true }), /不在了/);
  assert.throws(() => store.update({ id: '../x', done: true }), /Invalid/);
  assert.throws(() => store.update({ id: a.id, done: 'yes' }), /true or false/);
});

test('two computers never write the same file and the newest change wins', (t) => {
  let now = Date.parse('2026-10-06T10:00:00Z');
  const clock = () => now;
  const { dir, make } = fixture(t);
  const mac = make('dev-mac', clock), win = make('dev-win', clock);
  const item = mac.add({ text: '体检前整理报告' });
  now += 1000;
  // Windows has received the Mac file through git and ticks it off.
  win.update({ id: item.id, done: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['dev-mac.json', 'dev-win.json']);
  assert.equal(mac.list()[0].done, true);
  now += 1000;
  mac.update({ id: item.id, text: '体检前整理既往报告' });
  const seen = win.list()[0];
  assert.equal(seen.text, '体检前整理既往报告');
  assert.equal(seen.done, true, 'the edit started from the merged copy, so the tick is kept');
  // A deletion on one computer is not undone by the other computer's older copy.
  now += 1000;
  win.remove({ id: item.id });
  assert.deepEqual(mac.list(), []);
  const macDoc = JSON.parse(fs.readFileSync(path.join(dir, 'dev-mac.json'), 'utf8'));
  assert.equal(macDoc.items[0].deleted, false, 'the Mac file still holds its older live copy');
});

test('a clock behind the last change still moves the item forward', (t) => {
  let now = Date.parse('2026-10-06T10:00:00Z');
  const { make } = fixture(t);
  const ahead = make('dev-a', () => now + 60_000), behind = make('dev-b', () => now);
  const item = ahead.add({ text: 'x' });
  const after = behind.update({ id: item.id, done: true });
  assert.ok(Date.parse(after.updated) > Date.parse(item.updated));
  assert.equal(ahead.list()[0].done, true);
});

test('the phone can tick an item this computer has not synced yet, but only with known fields', (t) => {
  const { make } = fixture(t);
  const mac = make('dev-mac');
  const base = { text: '在 Windows 上记的', done: false, created: '2026-10-06T09:00:00.000Z', updated: '2026-10-06T09:00:00.000Z', ai: { state: 'approved' }, evil: 1 };
  const item = mac.update({ id: 'td-from-windows-1', done: true, base, source: 'phone' });
  assert.equal(item.text, '在 Windows 上记的');
  assert.equal(item.done, true);
  assert.equal(item.ai, null);
  assert.equal(item.evil, undefined);
  assert.equal(item.source, 'phone');
  assert.throws(() => mac.update({ id: 'td-from-windows-2', done: true, base: { text: '', updated: base.updated } }), /Invalid to-do/);
});

// Mac and Windows each have their own folder here; sync() is the 30-minute git job.
function twoComputers(t, clock) {
  const mac = fixture(t, 'dev-mac', clock), win = fixture(t, 'dev-win', clock);
  const copy = (from, to, name) => {
    if (!fs.existsSync(path.join(from.dir, name))) return;
    fs.mkdirSync(to.dir, { recursive: true });
    fs.copyFileSync(path.join(from.dir, name), path.join(to.dir, name));
  };
  const sync = () => { copy(mac, win, 'dev-mac.json'); copy(win, mac, 'dev-win.json'); };
  return { mac: mac.store, win: win.store, sync };
}
const baseOf = (item) => ({ text: item.text, done: item.done, doneAt: item.doneAt, created: item.created, updated: item.updated });

test('the phone ticks an item the other computer just edited: the new text survives the next sync', (t) => {
  let now = Date.parse('2026-10-06T10:00:00Z');
  const { mac, win, sync } = twoComputers(t, () => now);
  const item = mac.add({ text: '买牛奶' });
  sync();
  now += 60_000;
  // Windows edits the text; the Mac has not received it yet, but the phone has seen it.
  const edited = win.update({ id: item.id, text: '买牛奶和鸡蛋' });
  now += 60_000;
  const ticked = mac.update({ id: item.id, done: true, base: baseOf(edited), source: 'phone' });
  assert.equal(ticked.text, '买牛奶和鸡蛋', 'the phone saw the newer text, so the tick is applied to it');
  assert.equal(ticked.done, true);
  assert.ok(Date.parse(ticked.updated) > Date.parse(edited.updated));
  now += 60_000;
  sync();
  for (const side of [mac, win]) assert.deepEqual(side.list().map((x) => [x.text, x.done]), [['买牛奶和鸡蛋', true]]);
});

test('a base that is older than, or the same as, this computer\'s copy changes nothing but the tick', (t) => {
  let now = Date.parse('2026-10-06T10:00:00Z');
  const { mac } = twoComputers(t, () => now);
  const item = mac.add({ text: '旧字' });
  now += 60_000;
  const edited = mac.update({ id: item.id, text: '这台电脑刚改的新字' });
  now += 60_000;
  const stale = mac.update({ id: item.id, done: true, base: baseOf(item), source: 'phone' });
  assert.equal(stale.text, '这台电脑刚改的新字', 'a stale phone view must not bring old text back');
  now += 60_000;
  const same = mac.update({ id: item.id, done: false, base: baseOf(stale), source: 'phone' });
  assert.equal(same.text, '这台电脑刚改的新字');
  now += 60_000;
  // A base that cannot be a real item is ignored when this computer has the item.
  const junk = mac.update({ id: item.id, done: true, base: { text: '', updated: 'later' }, source: 'phone' });
  assert.equal(junk.text, '这台电脑刚改的新字');
  assert.equal(junk.done, true);
  assert.ok(edited.updated < junk.updated);
});

test('a deletion on this computer is not undone by a newer base from the phone', (t) => {
  let now = Date.parse('2026-10-06T10:00:00Z');
  const { mac, win, sync } = twoComputers(t, () => now);
  const item = mac.add({ text: '已经删掉的' });
  sync();
  now += 60_000;
  mac.remove({ id: item.id });
  now += 60_000;
  const edited = win.update({ id: item.id, text: '另一台又改了字' });
  now += 60_000;
  const after = mac.update({ id: item.id, done: true, base: baseOf(edited), source: 'phone' });
  assert.equal(after.deleted, true, 'only an explicit undo brings a deleted item back');
  assert.equal(after.text, '已经删掉的');
  assert.deepEqual(mac.list(), []);
  sync();
  assert.deepEqual(win.list(), []);
});

test('a newer base keeps what this computer stored that the phone never sees, and still takes only known fields', (t) => {
  let now = Date.parse('2026-10-06T10:00:00Z');
  const { dir, make } = fixture(t, 'dev-mac', () => now);
  fs.mkdirSync(dir, { recursive: true });
  const created = '2026-10-06T08:00:00.000Z';
  fs.writeFileSync(path.join(dir, 'dev-mac.json'), JSON.stringify({ version: 1, device: 'dev-mac', items: [
    { id: 'td-keep-extras-1', text: '旧', done: false, created, updated: created, remindAt: '2026-10-07T01:00:00.000Z', ai: { state: 'requested' } },
  ] }));
  const base = { text: '新', done: true, doneAt: '2026-10-06T09:30:00.000Z', created: '2000-01-01T00:00:00.000Z', updated: '2026-10-06T09:30:00.000Z', ai: { state: 'approved' }, evil: 1 };
  const item = make('dev-mac', () => now).update({ id: 'td-keep-extras-1', done: false, base, source: 'phone' });
  assert.equal(item.text, '新');
  assert.equal(item.done, false);
  assert.equal(item.doneAt, null);
  assert.equal(item.created, created, 'the item keeps the creation time this computer recorded');
  assert.equal(item.remindAt, '2026-10-07T01:00:00.000Z');
  assert.deepEqual(item.ai, { state: 'requested' });
  assert.equal(item.evil, undefined);
});

test('a damaged file from the other computer is skipped; our own damaged file is never overwritten', (t) => {
  const { dir, store } = fixture(t);
  store.add({ text: 'ok' });
  fs.writeFileSync(path.join(dir, 'dev-win.json'), '<<<<<<< conflict');
  assert.equal(store.list().length, 1);
  fs.writeFileSync(path.join(dir, 'dev-mac.json'), '{ broken');
  assert.throws(() => store.add({ text: 'more' }), /损坏/);
  assert.equal(fs.readFileSync(path.join(dir, 'dev-mac.json'), 'utf8'), '{ broken');
});

test('unknown fields written by a later version survive an edit', (t) => {
  const { dir, store } = fixture(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dev-next.json'), JSON.stringify({ version: 1, device: 'dev-next', items: [
    { id: 'td-later-version-1', text: '带提醒', done: false, created: '2026-10-06T08:00:00.000Z', updated: '2026-10-06T08:00:00.000Z', remindAt: '2026-10-07T01:00:00.000Z', ai: { state: 'requested' } },
  ] }));
  const item = store.update({ id: 'td-later-version-1', done: true });
  assert.equal(item.remindAt, '2026-10-07T01:00:00.000Z');
  assert.deepEqual(item.ai, { state: 'requested' });
});

test('merge and the phone view: deletions travel as bare marks, ties do not depend on file order', () => {
  const a = { id: 'td-same-time-1', text: 'A', updated: '2026-10-06T08:00:00.000Z' };
  const b = { ...a, text: 'B' };
  assert.equal(merge([[a], [b]]).get(a.id).text, merge([[b], [a]]).get(a.id).text);
  const items = [...merge([[
    { id: 'td-open-item-1', text: 'open', done: false, created: '2026-10-06T08:00:00.000Z', updated: '2026-10-06T08:00:00.000Z' },
    { id: 'td-gone-item-1', text: 'secret-ish', deleted: true, updated: '2026-10-06T08:00:00.000Z' },
  ]]).values()];
  const view = phoneView(items);
  assert.deepEqual(view.find((x) => x.id === 'td-gone-item-1'), { id: 'td-gone-item-1', deleted: true, updated: '2026-10-06T08:00:00.000Z' });
  assert.deepEqual(Object.keys(view.find((x) => x.id === 'td-open-item-1')).sort(), ['created', 'done', 'doneAt', 'id', 'text', 'updated']);
});
