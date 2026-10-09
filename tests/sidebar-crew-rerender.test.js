// Regression: with a renamed Claude seat (or a seat with a custom id), every status
// tick (Sidebar.refreshCrew) used to rebuild the whole sidebar and close any open
// context menu, because the tick's "did the list change?" key was built without the
// user's seat config while the list itself was built with it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = process.env.SIDEBAR_SRC || path.join(__dirname, '..', 'sidebar.js');

// ---- minimal fake DOM ----
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
}
const byId = { navTop: new Node('div'), navList: new Node('div') };
const body = new Node('body');
const document = {
  body,
  createElement: (t) => new Node(t),
  getElementById: (id) => byId[id] || null,
  addEventListener() {},
  createRange: () => ({ selectNodeContents() {} }),
};
class MutationObserver { constructor() {} observe() {} disconnect() {} }

// ---- app stubs ----
const defaultSeats = () => [
  { id: 'cn', name: 'CN', icon: '🇨🇳', configDir: '~/.claude' },
  { id: 'us', name: 'US', icon: '🇺🇸', configDir: '~/.claude-us' },
  { id: 'us2', name: 'US2', icon: '🇺🇸', configDir: '~/.claude-us2' },
];
const main = { id: 'main', isMain: true };
const worker = { id: 'w1', captainCrew: true };
let workerSeat = 'us';
let renders = 0;
const host = {
  ICONS: {}, navItems: new Map(), config: { crewOpen: true, claudeSeats: defaultSeats() },
  folders: () => [], columns: () => [main, worker], archived: () => [],
  columnLabel: (c) => c.id, lastTurnTs: () => 0,
  terms: new Map([['w1', { state: 'idle' }], ['main', { state: 'idle' }]]),
  saveConfig() {}, syncNav() { renders++; }, jumpToColumn() {}, togglePage() {}, toggleTaskBoard() {}, addAndFocusColumn() {},
};
const win = {
  MainSession: { mainCol: () => main, state: () => ({ waitlist: [], tasks: [] }), memoryHeld: () => false, isHigh: () => false, isPriority: () => false, queueTitle: () => '', open() {} },
  AgentInfo: {
    resolveAgentInfo: (col) => col.isMain ? { provider: 'Claude', shortModel: 'Opus' } : { provider: 'Claude', shortModel: 'Opus 5.5', seat: { id: workerSeat } },
    iconProviderFor: () => 'Claude', renderBadge() {}, PROVIDER_ICONS: {},
  },
  SidebarCore: require('../sidebar-core.js'),
  TodoUI: { shortcutLabel: () => '⌘⇧N' },
  addEventListener() {}, getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
};
const ctx = { window: win, document, MutationObserver, Element: Node, innerWidth: 1000, innerHeight: 800, confirm: () => false, setTimeout, console };
win.window = win;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });
const Sidebar = win.Sidebar;
Sidebar.init(host);

const menuOpen = () => body.children.some((n) => n.classList.contains('ctx-menu'));
const openMenu = () => {
  Sidebar.closeMenu();
  Sidebar.openMenu({ x: 10, y: 10 }, [{ label: '重命名', run() {} }]);
  assert.ok(menuOpen(), 'menu is open');
};
const idleTicks = (n = 3) => { renders = 0; for (let i = 0; i < n; i++) Sidebar.refreshCrew(); return renders; };
function setup(seats, seatId, cols = [main, worker]) {
  host.config.claudeSeats = seats;
  host.columns = () => cols;
  workerSeat = seatId;
  Sidebar.render();
}

test('a status tick with nothing changed does not rebuild the sidebar or close its menu (renamed seat)', () => {
  const seats = defaultSeats();
  seats[1] = { id: 'us', name: '工作号', icon: '💼', configDir: '~/.claude-us' }; // user renamed this seat in 席位设置
  setup(seats, 'us');
  // The crew list shows the seat the user named.
  assert.ok(byId.navList.textContent.includes('工作号'), 'crew group shows the renamed seat');
  openMenu();
  assert.strictEqual(idleTicks(), 0, 'status ticks with no change rebuilt the sidebar');
  assert.ok(menuOpen(), 'context menu was closed by an idle status tick');
});

test('a seat with a non-default id does not rebuild the sidebar on idle ticks', () => {
  const seats = [...defaultSeats(), { id: 'work-2', name: '备用号', icon: '🧰', configDir: '~/.claude-work2' }];
  setup(seats, 'work-2');
  assert.ok(byId.navList.textContent.includes('备用号'), 'crew group shows the custom seat');
  openMenu();
  assert.strictEqual(idleTicks(), 0, 'status ticks with no change rebuilt the sidebar');
  assert.ok(menuOpen(), 'context menu was closed by an idle status tick');
});

test('default seats keep behaving: idle ticks leave the sidebar alone', () => {
  setup(defaultSeats(), 'us');
  openMenu();
  assert.strictEqual(idleTicks(), 0);
  assert.ok(menuOpen());
});

test('real changes still refresh the sidebar: rename, icon, seat move, working state', () => {
  const seats = defaultSeats();
  setup(seats, 'us');
  assert.strictEqual(idleTicks(), 0);

  // The user renames the seat in 席位设置: the next tick redraws once, then goes quiet.
  host.config.claudeSeats = seats.map((s) => (s.id === 'us' ? { ...s, name: '新名字' } : s));
  renders = 0;
  Sidebar.refreshCrew();
  assert.ok(renders >= 1, 'a renamed seat must redraw the list');
  assert.ok(byId.navList.textContent.includes('新名字'), 'new name is shown');
  assert.strictEqual(idleTicks(), 0, 'quiet again after the rename was drawn');

  // ...and the same for a changed icon.
  host.config.claudeSeats = host.config.claudeSeats.map((s) => (s.id === 'us' ? { ...s, icon: '🔥' } : s));
  renders = 0;
  Sidebar.refreshCrew();
  assert.ok(renders >= 1, 'a changed seat icon must redraw the list');
  assert.ok(byId.navList.textContent.includes('🔥'), 'new icon is shown');
  assert.strictEqual(idleTicks(), 0);

  // A member moves to another seat: it lands in another group, so the tick redraws.
  workerSeat = 'cn';
  renders = 0;
  Sidebar.refreshCrew();
  assert.ok(renders >= 1, 'a member changing seat must redraw the list');
  assert.strictEqual(idleTicks(), 0);
  workerSeat = 'us';
  Sidebar.render();

  // A member starts working: the groups re-sort/recount, so the tick redraws.
  host.terms.get('w1').state = 'working';
  renders = 0;
  Sidebar.refreshCrew();
  assert.ok(renders >= 1, 'a working-state change must redraw the list');
  assert.strictEqual(idleTicks(), 0);
  host.terms.get('w1').state = 'idle';
});
