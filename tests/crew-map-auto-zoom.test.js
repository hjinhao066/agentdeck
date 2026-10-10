'use strict';
// 架构图「回到自动大小」(bug hunt ④): since 2.0.4 a zoom the user sets is theirs (config.crewMap.zoom) and 智能一页 only
// rearranges at it. Nothing ever dropped it again: a click on the number between 缩小 and 放大 only pinned 100%. That click
// now opens a menu: 回到 100% as before, and 回到自动大小, the one way the zoom the user set goes, after which the map
// sizes itself for the window again. Nothing the map does by itself drops that zoom.
// The real crew-map.js runs here against the real toolbar markup (index.html's #boardView) on a small stand-in DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CORE = read('crew-map-core.js'), MAP = read('crew-map.js'), HTML = read('index.html');
const BASE = require('../crew-map-core').BASE_SCALE;

// ---- a stand-in DOM: just what crew-map.js touches ----
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'wbr']);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
function makeDom() {
  const doc = { listeners: [], activeElement: null };
  class El {
    constructor(tag) {
      this.localName = String(tag).toLowerCase(); this.tagName = this.localName.toUpperCase();
      this.children = []; this.parentNode = null; this.attrs = new Map(); this.own = []; this.text = ''; this.html = '';
      this.style = { setProperty(k, v) { this[k] = v; } };
      const self = this;
      this.dataset = new Proxy({}, {
        get: (_, k) => self.getAttribute('data-' + kebab(String(k))) ?? undefined,
        set: (_, k, v) => { self.setAttribute('data-' + kebab(String(k)), v); return true; },
        deleteProperty: (_, k) => { self.removeAttribute('data-' + kebab(String(k))); return true; },
      });
      this.classList = {
        contains: (c) => self.className.split(/\s+/).includes(c),
        add: (...cs) => cs.forEach((c) => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); }),
        remove: (...cs) => { self.className = self.className.split(/\s+/).filter((x) => x && !cs.includes(x)).join(' '); },
        toggle: (c, force) => { const on = force === undefined ? !self.classList.contains(c) : !!force; if (on) self.classList.add(c); else self.classList.remove(c); return on; },
      };
    }
    get childNodes() { return this.children; }
    get className() { return this.attrs.get('class') || ''; }
    set className(v) { this.attrs.set('class', String(v)); }
    get id() { return this.attrs.get('id') || ''; }
    get title() { return this.attrs.get('title') || ''; }
    set title(v) { this.attrs.set('title', String(v)); }
    get hidden() { return this.attrs.has('hidden'); }
    set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this.text = String(v); this.html = ''; }
    get innerHTML() { return this.html; }
    set innerHTML(v) { this.textContent = ''; this.html = String(v); }
    get offsetWidth() { return 0; }
    get offsetHeight() { return 0; }
    get scrollWidth() { return 0; }
    get clientWidth() { return this.size ? this.size.w : 0; }
    get clientHeight() { return this.size ? this.size.h : 0; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { this.attrs.delete(k); }
    hasAttribute(k) { return this.attrs.has(k); }
    appendChild(n) { return this.insertBefore(n, null); }
    insertBefore(n, ref) {
      if (n.parentNode) n.remove();
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(n); else this.children.splice(at, 0, n);
      n.parentNode = this;
      return n;
    }
    append(...ns) { ns.forEach((n) => (typeof n === 'string' ? this.appendChild(Object.assign(new El('span'), { text: n })) : this.appendChild(n))); }
    prepend(...ns) { ns.reverse().forEach((n) => this.insertBefore(typeof n === 'string' ? Object.assign(new El('span'), { text: n }) : n, this.children[0] || null)); }
    remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
    replaceWith(n) { const p = this.parentNode; if (!p) return; p.insertBefore(n, this); this.remove(); }
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
    addEventListener(type, fn, opts) { this.own.push({ type, fn, capture: opts === true || !!(opts && opts.capture) }); }
    removeEventListener() {}
    focus() { doc.activeElement = this; }
    animate() { return { cancel() {} }; }
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    all() { const out = []; const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); }); walk(this); return out; }
    querySelectorAll(sel) { return this.all().filter((n) => matches(n, sel, this)); }
    querySelector(sel) { return this.all().find((n) => matches(n, sel, this)) || null; }
    matches(sel) { return matches(this, sel, null); }
    closest(sel) { for (let n = this; n; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  }
  // selectors: compound parts (tag, .class, #id, [attr], [attr="v"]) joined by spaces or >, and lists of them
  const compound = (n, part) => {
    const tag = /^[a-z][\w-]*/i.exec(part);
    if (tag && n.localName !== tag[0].toLowerCase()) return false;
    for (const [, k, v] of part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) if (!n.hasAttribute(k) || (v !== undefined && n.getAttribute(k) !== v)) return false;
    const bare = part.replace(/\[[^\]]*\]/g, '');
    for (const [, c] of bare.matchAll(/\.([\w-]+)/g)) if (!n.classList.contains(c)) return false;
    for (const [, id] of bare.matchAll(/#([\w-]+)/g)) if (n.id !== id) return false;
    return true;
  };
  function matches(n, sel, scope) {
    return sel.split(',').some((one) => {
      const parts = one.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
      const up = (node, i) => {
        if (!compound(node, parts[i])) return false;
        if (i === 0) return true;
        const child = parts[i - 1] === '>';
        const j = child ? i - 2 : i - 1;
        for (let p = node.parentNode; p && p !== scope; p = child ? null : p.parentNode) if (up(p, j)) return true;
        return false;
      };
      return up(n, parts.length - 1);
    });
  }
  // the page's markup from `start` through the element it opens
  function parse(html, start) {
    const top = new El('#root'), stack = [top];
    const re = /<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
    re.lastIndex = html.indexOf(start);
    for (let m; (m = re.exec(html));) {
      if (m[1]) { stack.pop(); if (stack.length === 1) break; continue; }
      if (m[5] !== undefined) { if (m[5].trim()) stack[stack.length - 1].text += m[5].trim(); continue; }
      if (!m[2]) continue;
      const n = new El(m[2]);
      for (const [, k, a, b, c] of (m[3] || '').matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) n.setAttribute(k, (a ?? b ?? c ?? '').replace(/&amp;/g, '&'));
      stack[stack.length - 1].appendChild(n);
      if (!m[4] && !VOID.has(n.localName)) stack.push(n);
    }
    return top;
  }
  const page = parse(HTML, '<section id="boardView"');
  Object.assign(doc, {
    documentElement: new El('html'),
    getElementById: (id) => page.querySelector('#' + id),
    createElement: (tag) => new El(tag),
    createElementNS: (_, tag) => new El(tag),
    addEventListener(type, fn, opts) { doc.listeners.push({ type, fn, capture: opts === true || !!(opts && opts.capture) }); },
    querySelector: (sel) => page.querySelector(sel),
  });
  // an event from `target`: the document's capture listeners, then the target and up, then the document
  function fire(target, type, init = {}) {
    const e = { type, target, button: 0, pointerId: 1, ...init, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    const run = (list, capture) => { for (const l of list) if (l.type === type && l.capture === capture && !e.stopped) l.fn(e); };
    run(doc.listeners, true);
    for (let n = target; n && !e.stopped; n = n.parentNode) run(n.own, false);
    run(doc.listeners, false);
    return e;
  }
  return { doc, page, fire };
}

// ---- the map in a window: 队长 and working sessions in a few projects ----
const CREW = { agentdeck: 4, hermes: 2, health: 1 };
function mount({ w = 1440, h = 820, dpr = 2, crewMap } = {}) {
  const { doc, page, fire } = makeDom();
  const observers = [];
  const cols = Object.entries(CREW).flatMap(([p, n]) => Array.from({ length: n }, (_, i) => ({ id: p + i, title: `${p} ${i}`, project: p, captainCrew: true })));
  const main = { id: 'cap', title: '队长', isMain: true };
  const config = { crewMap: crewMap ? JSON.parse(JSON.stringify(crewMap)) : undefined, archived: [] };
  const host = {
    config, save() {}, visible: () => true,
    mainCol: () => main, mainState: () => ({ tasks: [] }),
    terms: new Map([[main.id, { alive: true, state: 'done' }], ...cols.map((c) => [c.id, { alive: true, state: 'working' }])]),
    agentInfo: () => ({ provider: 'Claude', shortModel: 'Opus 5.5' }),
    columns: () => [main, ...cols], columnLabel: (c) => c.title, activityLine: () => '',
    isPriority: () => false, isHigh: () => false, findColumn: () => null, renderBadge() {}, open() {},
    leaveCanvas() {}, enterCanvas() {},
  };
  const sandbox = {
    document: doc, devicePixelRatio: dpr, console,
    setTimeout: () => 0, clearTimeout() {},
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({ columnGap: '0px', paddingLeft: '0px', paddingRight: '0px' }),
    ResizeObserver: class { constructor(cb) { observers.push(cb); } observe() {} },
    CSS: { escape: (s) => String(s) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CORE, sandbox, { filename: 'crew-map-core.js' });
  vm.runInContext(MAP, sandbox, { filename: 'crew-map.js' });
  const root = page.querySelector('#crewMap'), vp = root.querySelector('.cm-viewport');
  vp.size = { w, h };
  doc.getElementById('boardView').hidden = false;
  const map = sandbox.CrewMap;
  map.init(host);
  const btn = (name) => root.querySelector(`[data-cm="${name}"]`);
  const menu = root.querySelector('.cm-zoom-menu');
  return {
    map, config, doc, fire, btn, menu, label: btn('reset'),
    click: (name) => fire(btn(name), 'click'),
    key: (key) => fire(doc.activeElement, 'keydown', { key }),
    // the window resized: the map's ResizeObserver hears it
    resize(w2, h2) { vp.size = { w: w2, h: h2 }; observers.forEach((cb) => cb()); },
    zoom: () => config.crewMap.zoom,
    scale: () => map.view().scale,
    outside: () => fire(root.querySelector('.cm-legend-keys'), 'pointerdown'),
  };
}
const pct = (scale) => Math.round(scale / BASE * 100) + '%';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('after a zoom by hand, 回到自动大小 (from a click on the number) drops it, and the map sizes itself for the window again', () => {
  // what the map shows untouched: its own zoom for this window
  const auto = mount().scale(), autoNarrow = mount({ w: 1100, h: 760 }).scale();
  assert.notEqual(pct(auto), pct(autoNarrow), 'the map sizes itself differently for the two windows');

  const m = mount();
  near(m.scale(), auto, 'untouched: the map picks its own zoom');
  assert.equal(m.zoom(), null);
  m.click('out'); m.click('out');
  const mine = m.scale();
  assert.notEqual(pct(mine), pct(auto));
  near(m.zoom(), mine, 'a zoom by hand is saved as the user\'s');

  // a click on the number: a menu, 回到 100% first and focused, 回到自动大小 open because a zoom was set
  m.click('reset');
  assert.equal(m.menu.hidden, false, 'the number opens its menu');
  assert.equal(m.label.getAttribute('aria-expanded'), 'true');
  assert.equal(m.label.getAttribute('aria-haspopup'), 'menu');
  assert.equal(m.doc.activeElement, m.btn('zoom-100'), 'the first choice has the focus');
  assert.equal(m.btn('zoom-100').textContent, '回到 100%');
  assert.equal(m.btn('zoom-auto').textContent, '回到自动大小');
  assert.equal(m.btn('zoom-auto').getAttribute('aria-disabled'), 'false');
  assert.match(m.btn('zoom-auto').title, new RegExp(`不再用你设的 ${pct(mine)}`));
  assert.equal(pct(m.scale()), pct(mine), 'opening the menu changes nothing');

  m.click('zoom-auto');
  assert.equal(m.menu.hidden, true, 'a choice closes the menu');
  assert.equal(m.label.getAttribute('aria-expanded'), 'false');
  assert.equal(m.doc.activeElement, m.label, 'the focus goes back to the number');
  assert.equal(m.zoom(), null, 'the zoom the user set is gone');
  near(m.scale(), auto, 'the map shows the zoom it picks for this window, as if never zoomed');
  assert.equal(m.label.textContent, pct(auto));
  assert.equal(m.map.userMoved(), false, 'the view is the map\'s own again');

  // and it goes on sizing itself: a narrower window, the zoom it picks there
  m.resize(1100, 760);
  near(m.scale(), autoNarrow, 'a resized window: sized for it, like a map never zoomed');
  assert.equal(m.zoom(), null);
  // a restart keeps it automatic
  near(mount({ w: 1100, h: 760, crewMap: m.config.crewMap }).scale(), autoNarrow, 'after a restart');
});

test('nothing else drops a zoom the user set: a resized window, 智能一页, 一键整理, closing the menu, 回到 100%, a restart', () => {
  const m = mount();
  m.click('in');
  const mine = m.zoom();
  assert.ok(mine > 0);
  const kept = (what) => { near(m.zoom(), mine, `${what}: the saved zoom`); near(m.scale(), mine, `${what}: the zoom shown`); };
  m.resize(1100, 760); kept('a resized window');
  m.click('fit'); kept('智能一页');
  assert.equal(m.map.userMoved(), false);
  m.resize(1500, 900); kept('a resized window after 智能一页 (the map places the view itself)');
  m.click('relayout'); kept('一键整理');
  // the menu opened and closed every way, without a choice
  m.click('reset'); m.key('Escape');
  assert.equal(m.menu.hidden, true, 'Esc closes the menu');
  assert.equal(m.doc.activeElement, m.label, 'Esc gives the focus back to the number');
  kept('Esc');
  m.click('reset'); m.outside();
  assert.equal(m.menu.hidden, true, 'a click elsewhere closes the menu'); kept('a click elsewhere');
  m.click('reset'); m.click('reset');
  assert.equal(m.menu.hidden, true, 'a second click on the number closes it'); kept('the number again');
  m.click('reset'); m.key('Tab');
  assert.equal(m.menu.hidden, true, 'Tab leaves the menu closed behind it'); kept('Tab');
  // a restart: the zoom is still theirs
  near(mount({ w: 1500, h: 900, crewMap: m.config.crewMap }).scale(), mine, 'after a restart');
  // 回到 100% does what the click on the number did: 100%, set by the user (智能一页 keeps it)
  m.click('reset'); m.click('zoom-100');
  assert.equal(m.menu.hidden, true);
  near(m.scale(), BASE, '回到 100%');
  near(m.zoom(), BASE, '100% is the user\'s zoom now');
  assert.equal(m.label.textContent, '100%');
  m.click('fit');
  near(m.scale(), BASE, '智能一页 keeps the 100% the user chose');
});

test('no zoom set: 回到自动大小 is in the menu but not open, and choosing it changes nothing; the arrow keys move between the two', () => {
  const m = mount();
  const auto = m.scale();
  m.click('reset');
  const item = m.btn('zoom-auto');
  assert.equal(item.getAttribute('aria-disabled'), 'true');
  assert.match(item.title, /现在就是自动大小/);
  m.key('ArrowDown');
  assert.equal(m.doc.activeElement, item, 'ArrowDown: the second choice');
  m.key('ArrowDown');
  assert.equal(m.doc.activeElement, m.btn('zoom-100'), 'and round to the first');
  m.key('ArrowUp');
  assert.equal(m.doc.activeElement, item, 'ArrowUp: back round');
  m.fire(item, 'click');
  assert.equal(m.zoom(), null, 'still no zoom of the user\'s');
  near(m.scale(), auto, 'the view is as it was');
  assert.equal(m.menu.hidden, false, 'a choice that is not open leaves the menu where it is');
  m.key('Escape');
  assert.equal(m.menu.hidden, true);
});
