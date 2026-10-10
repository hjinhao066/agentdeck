// Loads the real chat-ui.js into a small fake page (no Electron, no real DOM library),
// with the real ChatCore, the phone hub rules and the renderer's own findLinks.
// Call order follows renderer.js: ChatUI.init, then the columns, then the saved chats.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const ChatCore = require(path.join(ROOT, 'chat-core.js'));
const HubCore = require(path.join(ROOT, 'mobile-web/hub/core.js'));

// ---- a minimal DOM ----
class ClassList {
  constructor(n) { this.n = n; }
  get set() { return new Set(String(this.n.className).split(/\s+/).filter(Boolean)); }
  add(...c) { const s = this.set; c.forEach((x) => s.add(x)); this.n.className = [...s].join(' '); }
  remove(...c) { const s = this.set; c.forEach((x) => s.delete(x)); this.n.className = [...s].join(' '); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { const s = this.set; if (on === undefined) on = !s.has(c); if (on) s.add(c); else s.delete(c); this.n.className = [...s].join(' '); return on; }
}
function makeDocument() {
  const doc = { listeners: {}, activeElement: null };
  class N {
    constructor(tag, type = 1) {
      this.nodeType = type; this.tagName = String(tag).toUpperCase(); this.childNodes = []; this.parentNode = null;
      this.className = ''; this.dataset = {}; this.attrs = {}; this.style = {}; this.hidden = false; this.listeners = {};
      this._text = ''; this._html = ''; this.classList = new ClassList(this); this.scrollTop = 0; this.value = ''; this.title = '';
      this.ownerDocument = doc;
    }
    get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
    get previousElementSibling() { const p = this.parentNode; if (!p) return null; const sib = p.children; return sib[sib.indexOf(this) - 1] || null; }
    get nodeValue() { return this._text; }
    set nodeValue(v) { this._text = String(v); }
    get textContent() { return this.nodeType === 3 ? this._text : this._text + this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; this._text = String(v); this._html = ''; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; this._html = String(v); this._text = ''; }
    get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return x === doc.root; }
    get scrollHeight() { return 1000; }
    get clientHeight() { return 500; }
    appendChild(c) {
      if (c.nodeType === 11) { [...c.childNodes].forEach((n) => this.appendChild(n)); return c; }
      if (c.parentNode) c.remove();
      c.parentNode = this; this.childNodes.push(c); return c;
    }
    append(...xs) { xs.forEach((x) => this.appendChild(typeof x === 'object' && x ? x : doc.createTextNode(x))); }
    prepend(x) { this.insertBefore(typeof x === 'object' ? x : doc.createTextNode(x), this.childNodes[0] || null); }
    insertBefore(c, ref) {
      if (c.nodeType === 11) { [...c.childNodes].forEach((n) => this.insertBefore(n, ref)); return c; }
      if (c.parentNode) c.remove();
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      c.parentNode = this;
      if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
      return c;
    }
    remove() { const p = this.parentNode; if (p) { p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; } }
    replaceWith(n) { const p = this.parentNode; if (!p) return; p.insertBefore(n, this); this.remove(); }
    after(n) { const p = this.parentNode; p.insertBefore(n, this.nextSibling); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
    dispatch(type, ev = {}) { const e = { type, target: this, preventDefault() {}, stopPropagation() {}, ...ev }; (this.listeners[type] || []).forEach((f) => f(e)); return e; }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = null; }
    select() {}
    setSelectionRange() {}
    scrollIntoView() {}
    matches(sel) { return sel.split(',').some((s) => matchChain(this, s.trim().split(/\s+/))); }
    closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.matches(sel)) return x; return null; }
    querySelectorAll(sel) { const out = []; const walk = (n) => n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); }); walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  function matchOne(n, simple) {
    if (!n || n.nodeType !== 1) return false;
    const m = /^([a-z]+)?((?:[.#][\w-]+|\[[\w-]+\])*)$/i.exec(simple);
    if (!m) return false;
    if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
    for (const part of m[2].match(/[.#][\w-]+|\[[\w-]+\]/g) || []) {
      if (part[0] === '.' && !n.classList.contains(part.slice(1))) return false;
      if (part[0] === '#' && n.id !== part.slice(1)) return false;
      if (part[0] === '[' && !(part.slice(1, -1) in n.attrs) && !(part.slice(1, -1).replace(/^data-/, '') in n.dataset)) return false;
    }
    return true;
  }
  function matchChain(n, chain) {
    if (!matchOne(n, chain[chain.length - 1])) return false;
    let rest = chain.slice(0, -1), x = n.parentNode;
    while (rest.length && x) { if (matchOne(x, rest[rest.length - 1])) rest = rest.slice(0, -1); x = x.parentNode; }
    return !rest.length;
  }
  doc.createElement = (tag) => new N(tag);
  doc.createTextNode = (text) => { const t = new N('#text', 3); t._text = String(text); return t; };
  doc.createDocumentFragment = () => new N('#fragment', 11);
  doc.root = new N('#document', 9);
  doc.body = doc.createElement('body');
  doc.root.appendChild(doc.body);
  doc.getElementById = (id) => { const walk = (n) => { for (const c of n.children) { if (c.id === id) return c; const f = walk(c); if (f) return f; } return null; }; return walk(doc.root); };
  doc.addEventListener = (t, f) => { (doc.listeners[t] ||= []).push(f); };
  doc.removeEventListener = () => {};
  doc.createTreeWalker = (root) => {
    const texts = [];
    const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType === 3) texts.push(c); else walk(c); });
    walk(root);
    let i = -1;
    return { get currentNode() { return texts[i]; }, nextNode() { i++; return i < texts.length; } };
  };
  return doc;
}

// The renderer's own link finder (renderer.js: trimTrail, relativeLinks, findLinks).
function rendererFindLinks() {
  const src = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
  const from = src.indexOf('function trimTrail(');
  const to = src.indexOf('\nfunction openLink(');
  if (from < 0 || to < 0) throw new Error('renderer.js: findLinks not found');
  const ctx = vm.createContext({ env: { platform: 'darwin' } });
  vm.runInContext(src.slice(from, to) + '\nthis.findLinks = findLinks;', ctx);
  return ctx.findLinks;
}

// cols: [{ id, cmd, isMain, ... }]; saved: raw chat objects as they are on disk.
function load({ cols, saved = [], renderCard } = {}) {
  const doc = makeDocument();
  const calls = { sidebarRender: 0, turnDone: [], manualTurnDone: [], saves: [], renderCard: [], pagesRefresh: 0, errors: [] };
  const navTop = doc.createElement('div'); navTop.id = 'navTop';
  const navList = doc.createElement('div'); navList.id = 'navList';
  doc.body.append(navTop, navList);
  const deck = doc.createElement('div');
  doc.body.appendChild(deck);
  const columns = cols.map((c) => ({ role: 'manual', ...c }));
  const terms = new Map();
  const timers = [];
  const ctx = {
    document: doc, console, Promise, Map, Set, WeakMap, JSON, Math, Date, String, Number, Array, Object, RegExp, Error,
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); timers.push(t); return t; }, clearTimeout,
    requestAnimationFrame: (f) => setTimeout(f, 0),
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    ResizeObserver: class { observe() {} disconnect() {} },
    getSelection: () => '',
    addEventListener: (t, f) => { (ctx.pageListeners[t] ||= []).push(f); },
    pageListeners: {},
    decodeURI, decodeURIComponent, encodeURIComponent,
  };
  ctx.window = ctx;
  ctx.ChatCore = ChatCore;
  ctx.HubCore = HubCore;
  ctx.AppShortcutsCore = require(path.join(ROOT, 'app-shortcuts-core.js'));
  ctx.BoardCore = { inferAgentType: (cmd) => (/claude/.test(cmd || '') ? 'Claude' : cmd ? 'Custom agent' : 'Shell'), LAUNCHERS: [] };
  ctx.AgentInfo = { PROVIDER_ICONS: {} };
  ctx.MainCore = { statusLabel: () => '', terminalActivity: () => false, workingForSend: () => false, LONG_PROMPT: 100000 };
  ctx.ChatGPTWebCore = { MODES: [], LABEL: '网页版 ChatGPT', PUBLIC_NOTICE: '', NO_SEAT_NOTE: '', modeLabel: () => '', busyCount: () => 0 };
  ctx.MainSession = {
    onTurnStarted() {}, onTurnDone: (id, turn) => calls.turnDone.push([id, turn.id]), history: () => [], outgoingPrefix: () => '',
    onContextCommand() {}, onContextCommandSent() {}, state: () => ({ tasks: [] }),
    renderCard: renderCard ? renderCard(doc, ctx) : ((task) => { calls.renderCard.push(task); const d = doc.createElement('div'); d.className = 'task-card st-' + task.status; return d; }),
  };
  ctx.SidePane = { holdsTerminalOf: () => false, restoreTerminal() {}, syncTerminal() {}, openLink() {}, openPreview() {}, show() {} };
  ctx.Sidebar = { render: () => { calls.sidebarRender++; }, touchTime() {} };
  ctx.Pages = { refresh: () => { calls.pagesRefresh++; } };
  ctx.ChatDeliverables = { mount() {}, refresh() {} };
  ctx.deck = {
    chatLoadAll: async () => saved.map((raw) => ChatCore.normalizeChat(JSON.parse(JSON.stringify(raw)), raw.id)),
    chatSave: (id, chat) => calls.saves.push([id, JSON.parse(JSON.stringify(chat))]),
    chatDelete() {}, ptyInput() {}, previewRead: async () => null, notifyCancel() {}, stateDebug() {}, pickFiles: async () => [],
  };
  const ICONS = new Proxy({}, { get: () => '<svg></svg>' });
  const host = {
    ICONS, config: { globalViewMode: 'chat' }, columns: () => columns, terms, archived: () => [], saveConfig() {}, layout() {},
    focusedId: () => null, setFocused() {}, findLinks: rendererFindLinks(), clipboardWrite() {}, showToast() {}, platform: 'darwin',
    agentInForeground: async () => true, lastActivityLine: () => '', userComposing: () => false, dumpScreen: () => '',
    manualPromptSent() {}, manualTurnDone: (id, turn) => calls.manualTurnDone.push([id, turn && turn.id]), maybeAutoName() {},
    shellQuote: (p) => p, columnLabel: (c) => c.title || c.id, restoreArchived: () => null, jumpToColumn() {},
    isNavCollapsed: () => false, setNavCollapsed() {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chat-ui.js'), 'utf8'), ctx, { filename: 'chat-ui.js' });
  const ChatUI = ctx.ChatUI;
  const mounted = new Map();
  function mount(col) {
    const wrap = doc.createElement('div'); wrap.className = 'col';
    const head = doc.createElement('div'); head.className = 'head';
    const secondary = doc.createElement('span'); secondary.className = 'secondary';
    head.appendChild(secondary);
    const termEl = doc.createElement('div'); termEl.className = 'term';
    wrap.append(head, termEl);
    deck.appendChild(wrap);
    ChatUI.mountColumn(col, wrap, head, termEl);
    mounted.set(col.id, wrap);
    return wrap;
  }
  // A terminal whose screen holds `lines` (one buffer row each).
  function terminal(id, lines) {
    const rows = { lines };
    const term = {
      cols: 100, rows: 40, modes: { bracketedPasteMode: true },
      registerMarker: () => ({ line: 0, isDisposed: false, dispose() {} }),
      focus() {},
      buffer: { active: { type: 'normal', baseY: 0, cursorY: 0, get length() { return rows.lines.length; }, getLine: (i) => (i < rows.lines.length ? { isWrapped: false, translateToString: () => rows.lines[i], length: rows.lines[i].length } : null) } },
    };
    const entry = { alive: true, state: 'done', term, lastOutputAt: Date.now(), screen: rows };
    terms.set(id, entry);
    return entry;
  }
  return {
    ctx, ChatUI, doc, host, calls, columns, mount, terminal,
    init: () => ChatUI.init(host),
    scroll: (id) => mounted.get(id).querySelector('.chat-scroll'),
    textarea: (id) => mounted.get(id).querySelector('textarea'),
    turnRows: (id) => mounted.get(id).querySelector('.chat-scroll').querySelectorAll('.turn'),
    stop: () => timers.forEach(clearTimeout),
  };
}

module.exports = { load, ChatCore, HubCore, ROOT };
