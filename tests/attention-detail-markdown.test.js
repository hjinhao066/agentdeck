'use strict';
// An item's details read differently on the computer and on the phone: the phone renders
// them with the one shared Markdown renderer (hub app.js markdownNode -> HubCore.renderMarkdown),
// the desktop put the same text in as plain text, so **bold**, lists and tables showed their
// raw markup. docs/mobile-hub.md: 「待我处理」 details use that one renderer on both ends.
// 队长 is told to put a card's receipt text into --detail (docs/captain/inbox.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const HubCore = require('../mobile-web/hub/core.js');
const AttentionCore = require('../attention-core.js');

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
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentElement = null; this.className = ''; this.dataset = {}; this.attrs = {}; this._text = ''; this.listeners = {}; this.classList = new ClassList(this); this.hidden = false; this.title = ''; this.id = ''; this.innerHTML = ''; this.style = {}; this.isConnected = true; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  click() { (this.listeners.click || []).forEach((f) => f({ stopPropagation() {}, preventDefault() {} })); }
  contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const cls = /^\.([\w-]+)$/.exec(sel);
    const out = []; const walk = (n) => n.children.forEach((c) => { if (cls ? c.classList.contains(cls[1]) : c.tagName === sel.toUpperCase()) out.push(c); walk(c); }); walk(this); return out;
  }
}
const page = new Node('div');
const document = { activeElement: null, hidden: false, createElement: (t) => new Node(t), getElementById: (id) => (id === 'pageView' ? page : null), addEventListener() {} };
let body = null;
const frame = () => { page.children = []; body = page.appendChild(new Node('div')); return body; };
const detail = '**结论**：验收通过\n\n- 单测 2313 条全过\n- 手机页已核对';
const store = AttentionCore.normalize({ version: 3, items: [{ id: 'at-k1-abcd', kind: 'report', title: '登录页修好了', detail, created: Date.now() - 60_000 }] });
const host = { ICONS: {}, config: { attention: store }, columns: () => [], archived: () => [], saveConfig() {}, showToast() {} };
const win = {
  AttentionCore, HubCore, CopyMark: require('../copy-mark'),
  Pages: { current: () => 'attention', render: () => win.AttentionUI.render(frame, host) },
};
const ctx = vm.createContext({ window: win, document, requestAnimationFrame: () => 0, setTimeout, clearTimeout, setInterval: () => 0, console, CSS: { escape: (s) => s } });
win.window = win;
const SRC = path.join(__dirname, '..', 'attention-ui.js');
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });

test('an item\'s details read as Markdown on the desktop, as they do on the phone', () => {
  win.AttentionUI.render(frame, host);
  body.querySelector('.at-more').click();   // 细节与证据
  const shown = body.querySelector('.at-text');
  assert.ok(shown, 'the details are open');
  // What the phone draws for the same text (markdownNode: tidyReply, then renderMarkdown).
  const phone = HubCore.renderMarkdown(HubCore.tidyReply(detail), { breaks: true, links: true });
  assert.match(phone, /<strong>结论<\/strong>/);
  assert.ok(!shown.textContent.includes('**'), 'the desktop shows the raw Markdown markup: ' + JSON.stringify(shown.textContent));
  assert.match(shown.innerHTML, /<strong>结论<\/strong>/);
  assert.match(shown.innerHTML, /<li>单测 2313 条全过<\/li>/);
});
