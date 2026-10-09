'use strict';
// 随手记待办: the user's own short to-dos, shared by the desktop page, the
// phone hub and the Captain's AI-task backend.
//
// Storage is ~/.agents/boards/todos/, synced between Mac and Windows by the
// ~/.agents git job every 30 minutes. A git conflict there stops the whole
// sync, so each computer writes only its own file, <deviceId>.json, holding
// the complete list as that computer sees it. Reading merges every file. Each
// part of an item has its own clock, so a write that changes one part never
// covers a part changed elsewhere (a tick on a stale copy keeps the newer text,
// an AI answer never unticks or brings back a deleted item):
//   content   text + textUpdated (the content version), textDevice saved it
//   checkbox  done, doneAt, by doneUpdated
//   deletion  deleted, by deletedUpdated
//   AI        ai, by ai.updated, only from copies of the winning content version
// `updated` is the copy's last change of any kind. A deletion is kept as
// `deleted: true` so an older copy on the other computer cannot bring it back.
// The phone hub merges the computers' answers by the same rules (mergeTodos).
// Personal to-dos never live with the agents' task cards in boards/tasks/.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const VERSION = 1;
const TEXT_MAX = 500;
const ID = /^td-[A-Za-z0-9-]{8,64}$/;
const DEVICE = /^[A-Za-z0-9_-]{1,160}$/;
const SOURCE = /^[a-z][a-z-]{0,19}$/;
const FILE_MAX = 5 * 1024 * 1024;

function isTime(value) { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }
// One line of plain text: runs of whitespace (including line breaks) become
// one space; any other control character is refused rather than stored.
function cleanText(value) {
  if (typeof value !== 'string') throw new Error('待办内容必须是文字。');
  const text = value.replace(/\s+/gu, ' ').trim();
  if (!text) throw new Error('待办内容不能为空。');
  if ([...text].length > TEXT_MAX) throw new Error(`待办最多 ${TEXT_MAX} 个字。`);
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error('待办内容含有不支持的字符。');
  return text;
}
function todoId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid to-do id.');
  return value;
}
// A synced copy as found on disk, or null when it cannot be one of ours.
// Fields a later version adds are kept, so an older app that edits an item
// does not wipe them.
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || !isTime(raw.updated)) return null;
  const deleted = raw.deleted === true;
  let text;
  try { text = cleanText(raw.text); } catch (_) { if (!deleted) return null; text = ''; }
  const done = raw.done === true;
  const created = isTime(raw.created) ? raw.created : raw.updated;
  // A copy from an older build has no part clocks: its creation time stands in
  // for the content version, its last change for the checkbox and a deletion.
  const item = { ...raw, id: raw.id, text, done, doneAt: done && isTime(raw.doneAt) ? raw.doneAt : null,
    created, updated: raw.updated, deleted,
    source: typeof raw.source === 'string' && SOURCE.test(raw.source) ? raw.source : 'desktop',
    device: typeof raw.device === 'string' && DEVICE.test(raw.device) ? raw.device : '',
    textUpdated: isTime(raw.textUpdated) ? raw.textUpdated : created,
    textDevice: typeof raw.textDevice === 'string' && DEVICE.test(raw.textDevice) ? raw.textDevice : (typeof raw.device === 'string' && DEVICE.test(raw.device) ? raw.device : ''),
    doneUpdated: isTime(raw.doneUpdated) ? raw.doneUpdated : raw.updated,
    deletedUpdated: isTime(raw.deletedUpdated) ? raw.deletedUpdated : (deleted ? raw.updated : created),
    ai: raw.ai === undefined ? null : raw.ai };
  return item;
}
// Later `updated` wins; on an exact tie the result must not depend on which
// file was read first, so compare the serialized copies.
function newer(a, b) {
  const ta = Date.parse(a.updated), tb = Date.parse(b.updated);
  if (ta !== tb) return ta > tb;
  return JSON.stringify(a) > JSON.stringify(b);
}
// The copy whose clock for one part is latest; a tie goes to the copy changed
// last, so the result never depends on which file was read first.
function latest(copies, clock) {
  return copies.reduce((best, c) => {
    const a = Date.parse(clock(c)), b = Date.parse(clock(best));
    return a > b || (a === b && newer(c, best)) ? c : best;
  });
}
const NO_TIME = new Date(0).toISOString();
function combine(copies) {
  const whole = latest(copies, (c) => c.updated);
  const withText = copies.filter((c) => c.text);
  const content = latest(withText.length ? withText : copies, (c) => c.textUpdated);
  const version = copies.filter((c) => c.text === content.text && c.textUpdated === content.textUpdated);
  // A copy built from what the phone saw (`base`) does not know who saved the
  // text: any copy of the same version that does names the owner. Until one
  // arrives the item stays awaitingOrigin and nobody hands it to AI.
  const known = version.filter((c) => c.awaitingOrigin !== true);
  const origin = known.length ? latest(known, (c) => c.updated) : content;
  const check = latest(copies, (c) => c.doneUpdated);
  const removal = latest(copies, (c) => c.deletedUpdated);
  const ai = latest(version, (c) => (isTime(c.ai?.updated) ? c.ai.updated : NO_TIME)).ai;
  return { ...whole, text: content.text, textUpdated: content.textUpdated, textDevice: origin.textDevice, awaitingOrigin: origin.awaitingOrigin === true,
    done: check.done, doneAt: check.doneAt, doneUpdated: check.doneUpdated, deleted: removal.deleted, deletedUpdated: removal.deletedUpdated, ai };
}
function merge(lists) {
  const copies = new Map();
  for (const list of lists) for (const raw of Array.isArray(list) ? list : []) {
    const item = normalizeItem(raw);
    if (!item) continue;
    if (!copies.has(item.id)) copies.set(item.id, []);
    copies.get(item.id).push(item);
  }
  const byId = new Map();
  for (const [id, list] of copies) byId.set(id, combine(list));
  return byId;
}
// Open items newest first, then finished ones by when they were finished.
function sorted(items) {
  const open = items.filter((t) => !t.done).sort((a, b) => Date.parse(b.created) - Date.parse(a.created) || a.id.localeCompare(b.id));
  const done = items.filter((t) => t.done).sort((a, b) => Date.parse(b.doneAt || b.updated) - Date.parse(a.doneAt || a.updated) || a.id.localeCompare(b.id));
  return [...open, ...done];
}
// What the phone gets: live items plus bare deletion marks, so it can merge
// two computers' answers without showing an item one of them deleted.
// Each item carries its part clocks so the phone merges two answers as merge() does.
const PHONE_DONE_LIMIT = 200;
function phoneItem(t) {
  if (t.deleted) return { id: t.id, deleted: true, updated: t.updated, deletedUpdated: t.deletedUpdated };
  return { id: t.id, text: t.text, done: t.done, doneAt: t.doneAt, created: t.created, updated: t.updated,
    textUpdated: t.textUpdated, doneUpdated: t.doneUpdated, deletedUpdated: t.deletedUpdated, ...(t.ai ? { ai: t.ai } : {}) };
}
function phoneView(items) {
  const live = sorted(items.filter((t) => !t.deleted));
  const open = live.filter((t) => !t.done), done = live.filter((t) => t.done).slice(0, PHONE_DONE_LIMIT);
  return [...open, ...done, ...items.filter((t) => t.deleted)].map(phoneItem);
}

class TodoStore {
  constructor(dir = path.join(os.homedir(), '.agents', 'boards', 'todos'), { deviceId = '', host = os.hostname(), now = () => Date.now() } = {}) {
    this.dir = path.resolve(dir);
    this.deviceId = deviceId;
    this.host = String(host || '').slice(0, 120);
    this.now = now;
  }
  ownFile() {
    if (!DEVICE.test(this.deviceId || '')) throw new Error('This computer has no device id yet.');
    return path.join(this.dir, this.deviceId + '.json');
  }
  // Every computer's file. A damaged or foreign file is skipped for reading;
  // our own damaged file stops writes so it is never overwritten.
  readFiles() {
    if (!fs.existsSync(this.dir)) return [];
    const files = [];
    for (const name of fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(this.dir, name);
      const own = this.deviceId && name === this.deviceId + '.json';
      let doc = null;
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.size <= FILE_MAX) {
          const value = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (value && value.version === VERSION && Array.isArray(value.items)) doc = value;
        }
      } catch (_) { doc = null; }
      files.push({ name, own, doc });
    }
    return files;
  }
  all() { return [...merge(this.readFiles().map((f) => f.doc ? f.doc.items : [])).values()]; }
  list() { return sorted(this.all().filter((t) => !t.deleted)); }
  phone() { return { items: phoneView(this.all()) }; }
  // The phone records and ticks; it never edits text or deletes. The answer is
  // the item as api/todos shows it, so the phone can put it straight into its list.
  phoneWrite(input) {
    const item = input.op === 'add' ? this.add({ text: input.text, source: 'phone' })
      : this.update({ id: input.id, done: input.done, ...(input.base ? { base: input.base } : {}), source: 'phone' });
    return phoneItem(item);
  }
  stamp(previous) {
    return new Date(Math.max(this.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
  }
  mutate(change) {
    const file = this.ownFile();
    const files = this.readFiles();
    const own = files.find((f) => f.own);
    if (own && !own.doc) throw Object.assign(new Error('这台电脑的待办文件损坏了，先修好再记。'), { file });
    const byId = merge(files.map((f) => f.doc ? f.doc.items : []));
    const item = change(byId);
    fs.mkdirSync(this.dir, { recursive: true });
    const doc = { version: VERSION, device: this.deviceId, host: this.host, updated: new Date(this.now()).toISOString(),
      items: sorted([...byId.values()].filter((t) => !t.deleted)).concat([...byId.values()].filter((t) => t.deleted)) };
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    return item;
  }
  add({ text, source = 'desktop' } = {}) {
    const clean = cleanText(text);
    if (!SOURCE.test(source)) throw new Error('Invalid source.');
    return this.mutate((byId) => {
      const at = this.stamp();
      const item = { id: 'td-' + crypto.randomUUID(), text: clean, done: false, doneAt: null, created: at, updated: at,
        deleted: false, source, device: this.deviceId, textUpdated: at, textDevice: this.deviceId, doneUpdated: at, deletedUpdated: at, ai: null };
      byId.set(item.id, item);
      return item;
    });
  }
  // `base` is the item as the phone saw it. It lets the phone change an item this
  // computer has not received yet, or has only an older copy of (written on the
  // other computer less than one git sync ago).
  update({ id, text, done, deleted, base, source = 'desktop' } = {}) {
    todoId(id);
    if (text !== undefined) text = cleanText(text);
    if (done !== undefined && typeof done !== 'boolean') throw new Error('done must be true or false.');
    if (deleted !== undefined && typeof deleted !== 'boolean') throw new Error('deleted must be true or false.');
    if (!SOURCE.test(source)) throw new Error('Invalid source.');
    return this.mutate((byId) => {
      let current = byId.get(id);
      if (base) {
        // Only the content version the phone saw is taken from it: its text and
        // textUpdated (an older phone page sends no textUpdated; the creation
        // time stands in, as for old data). It does not say who saved that text,
        // so the copy waits for the original file (merge) before anyone hands it
        // to AI, and it holds no AI state: merge takes that from the copies of
        // the same version by AI time.
        const b = typeof base === 'object' && !Array.isArray(base) ? base : {};
        const seen = normalizeItem({ id, text: b.text, textUpdated: b.textUpdated, created: b.created, updated: b.updated, deleted: false, source, ai: null, awaitingOrigin: true });
        if (!current && !seen) throw new Error('Invalid to-do.');
        if (!current) current = seen;
        // The other computer saved newer text less than one git sync ago. A
        // deleted copy here stays deleted; fields the phone never sees are kept.
        else if (seen && isTime(b.textUpdated) && !current.deleted && Date.parse(seen.textUpdated) > Date.parse(current.textUpdated)) {
          current = { ...current, text: seen.text, textUpdated: seen.textUpdated, awaitingOrigin: true, ai: null };
        }
      }
      if (!current) throw new Error('这条待办已经不在了，刷新一下。');
      const at = this.stamp(current.updated);
      const next = { ...current, updated: at, device: this.deviceId };
      if (text !== undefined && text !== current.text) Object.assign(next, { text, textUpdated: at, textDevice: this.deviceId, awaitingOrigin: false, ai: null });
      // A tick or untick is the user's latest word on the checkbox, even when
      // this computer's copy already shows it (the phone may have seen another
      // computer's newer untick), so it always gets a new clock. Same for delete.
      if (done !== undefined) Object.assign(next, { done, doneAt: done ? (current.done && current.doneAt) || at : null, doneUpdated: at });
      if (deleted !== undefined) Object.assign(next, { deleted, deletedUpdated: at });
      byId.set(id, next);
      return next;
    });
  }
  remove({ id } = {}) { return this.update({ id, deleted: true }); }
  // AI writes never change text ownership or the user's completion checkbox.
  writeAi(id, change) {
    todoId(id);
    return this.mutate((byId) => {
      const current = byId.get(id);
      if (!current || current.deleted) throw new Error('这条待办已经不在了。');
      const ai = change(current);
      const next = { ...current, ai, updated: this.stamp(current.updated) };
      byId.set(id, next);
      return next;
    });
  }
}

module.exports = { TodoStore, merge, normalizeItem, cleanText, sorted, phoneView, phoneItem, TEXT_MAX, VERSION };
