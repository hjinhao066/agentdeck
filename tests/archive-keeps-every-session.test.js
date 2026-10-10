'use strict';
// Regression (2.0.3 bug hunt, sidebar): the archive kept only the newest 500
// sessions. Every launch SidebarCore.normalizeArchived silently dropped the rest
// from config.archived, and the launch after that main.js deleted their saved
// terminal output because their ids were no longer in config.json. The chat file
// stayed on disk but no list reached it: it could not be restored, opened from a
// task card, or found by 队长. AGENTS.md: column ids (and so chat files) survive
// archive, restore and relaunch; the startup prune must keep archived ids.
// On 2026-10-09 the installed app's config.json held 513 archived sessions
// (about 130 a day with 队长) and 466 conversations had already fallen out.
// Nothing is cut now: the sidebar shows the archive a page at a time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const SC = require('../sidebar-core.js');

const archivedSessions = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'c-board-' + String(i).padStart(4, '0'), title: 'job ' + i, cmd: 'claude', cwd: '/tmp',
  captainCrew: true, archivedAt: 1_760_000_000_000 + i * 60_000,
}));

test('every archived session survives a relaunch (513 archived, as in the installed config today)', () => {
  const saved = archivedSessions(513);
  const kept = SC.normalizeArchived(saved);
  const lost = saved.filter((a) => !kept.some((k) => k.id === a.id)).map((a) => a.id);
  assert.deepEqual(lost, [], `${lost.length} archived sessions vanished from the sidebar archive at launch`);
});

// main.js's startup prune, taken from the source so the test follows it.
function startupPrune() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const begin = source.indexOf('  // Prune replays for columns that no longer exist in the saved layout.');
  assert.ok(begin >= 0, 'main.js still prunes saved replays at startup');
  const end = source.indexOf('  } catch (_) {}\n', begin) + '  } catch (_) {}\n'.length;
  return new Function('fs', 'path', 'configPath', 'SESS_DIR', source.slice(begin, end));
}

test('the saved output of an archived session is still there two launches later', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-archive-cap-'));
  try {
    const configPath = path.join(dir, 'config.json');
    const SESS_DIR = path.join(dir, 'sessions');
    fs.mkdirSync(SESS_DIR);
    const archived = archivedSessions(501);
    const oldest = archived[0].id;
    fs.writeFileSync(configPath, JSON.stringify({ columns: [{ id: 'main', isMain: true }], archived }));
    for (const a of archived) fs.writeFileSync(path.join(SESS_DIR, a.id + '.txt'), 'output of ' + a.id);
    const prune = startupPrune();

    // Launch 1: main prunes against the file on disk, then the page loads the
    // archive the way renderer.js does and writes config.json back.
    prune(fs, path, configPath, SESS_DIR);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    saved.archived = SC.normalizeArchived(saved.archived);
    fs.writeFileSync(configPath, JSON.stringify(saved));
    // Launch 2.
    prune(fs, path, configPath, SESS_DIR);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Both facts at once: still listed in the archive, and its saved output still on disk.
    assert.deepEqual({
      inArchive: after.archived.some((a) => a.id === oldest),
      savedOutputKept: fs.existsSync(path.join(SESS_DIR, oldest + '.txt')),
    }, { inArchive: true, savedOutputKept: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the sidebar shows a long archive a page at a time, and every row can be reached ----
// minimal fake DOM (the one tests/sidebar-crew-rerender.test.js uses)
class ClassList {
  constructor(n) { this.n = n; }
  get set() { return new Set(this.n.className.split(/\s+/).filter(Boolean)); }
  add(...c) { const s = this.set; c.forEach((x) => s.add(x)); this.n.className = [...s].join(' '); }
  remove(...c) { const s = this.set; c.forEach((x) => s.delete(x)); this.n.className = [...s].join(' '); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { const s = this.set; if (on === undefined) on = !s.has(c); on ? s.add(c) : s.delete(c); this.n.className = [...s].join(' '); return on; }
}
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.parentElement = null; this.className = ''; this.dataset = {}; this.attrs = {}; this._text = ''; this.listeners = {}; this.classList = new ClassList(this); this.hidden = false; this.title = ''; this.id = ''; this.innerHTML = ''; this.style = {}; }
  set textContent(v) { this.children.forEach((c) => { c.parentElement = null; }); this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  appendChild(c) { if (c.parentElement) c.remove(); c.parentElement = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  insertBefore(c, ref) { if (c.parentElement) c.remove(); const i = ref ? this.children.indexOf(ref) : -1; c.parentElement = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener() {}
  contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
  get contentEditable() { return this.attrs.contenteditable || 'inherit'; }
  set contentEditable(v) { this.attrs.contenteditable = v; }
  get isContentEditable() { return this.attrs.contenteditable === 'true'; }
  get offsetWidth() { return 100; }
  get offsetHeight() { return 100; }
  getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0 }; }
  matches(sel) {
    let m;
    if ((m = /^\.([\w-]+)$/.exec(sel))) return this.classList.contains(m[1]);
    if ((m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel))) return this.attrs[m[1]] === m[2];
    throw new Error('unsupported selector ' + sel);
  }
  querySelectorAll(sel) { const out = []; const walk = (n) => n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); }); walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  click() { (this.listeners.click || []).forEach((f) => f({ stopPropagation() {}, preventDefault() {} })); }
  all(cls) { return this.querySelectorAll('.' + cls); }
}

test('the sidebar pages a long archive: the newest 100, then 显示更早的 down to the oldest', () => {
  const byId = { navTop: new Node('div'), navList: new Node('div') };
  const archived = SC.normalizeArchived(archivedSessions(513));
  const host = {
    ICONS: {}, navItems: new Map(), config: { navArchivedOpen: true },
    folders: () => [], columns: () => [], archived: () => archived,
    columnLabel: (c) => c.title, lastTurnTs: () => 0, terms: new Map(),
    saveConfig() {}, syncNav() {}, restoreArchived() {}, deleteArchived() {},
  };
  const win = { SidebarCore: SC, TodoUI: { shortcutLabel: () => '' }, addEventListener() {} };
  win.window = win;
  const document = { body: new Node('body'), createElement: (t) => new Node(t), getElementById: (id) => byId[id] || null, addEventListener() {} };
  class MutationObserver { observe() {} disconnect() {} }
  const ctx = { window: win, document, MutationObserver, Element: Node, innerWidth: 1000, innerHeight: 800, confirm: () => false, setTimeout, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sidebar.js'), 'utf8'), ctx, { filename: 'sidebar.js' });
  win.Sidebar.init(host);
  win.Sidebar.render();

  const rows = () => byId.navList.all('nav-archived-item').map((n) => n.dataset.archivedId);
  const more = () => byId.navList.all('nav-archived-more')[0];
  assert.equal(byId.navList.all('nav-section-count').at(-1).textContent, '513', 'the section head counts the whole archive');
  assert.deepEqual(rows(), archived.slice(0, 100).map((a) => a.id), 'the newest 100 first');
  assert.equal(more().textContent, '显示更早的 100 个（还有 413 个）');
  more().click();
  assert.equal(rows().length, 200);
  for (let i = 0; i < 4; i++) more().click();
  assert.deepEqual(rows(), archived.map((a) => a.id), 'every archived session has a row, oldest last');
  assert.equal(more(), undefined, 'nothing left to show');
  // An archive that fits one page has no extra row.
  archived.length = 100;
  win.Sidebar.render();
  assert.equal(rows().length, 100);
  assert.equal(more(), undefined);
});
