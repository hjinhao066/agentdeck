'use strict';
// 挖虫④ #11 预览栏：一个网页没能打开（超过 64 MB，或文件名以 . 开头 / 带冒号），主进程静默返回。
// 之前打开的网页还留在预览栏里，标题却已换成新文件；没开过网页时是一片空白、没有任何提示。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerSideIpc } = require('../side-main');
const Core = require('../preview-html-core');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bh4-pvbig-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, 'home');
const report = path.join(home, 'reports', 'weekly');
fs.mkdirSync(report, { recursive: true });
fs.writeFileSync(path.join(report, 'index.html'), '<p>旧网页</p>');
// 稀疏文件：不占磁盘，大小超过 64 MB
const big = path.join(report, 'big.html');
fs.writeFileSync(big, '<p>大</p>'); fs.truncateSync(big, Core.MAX_ASSET_BYTES + 1024);
const dotted = path.join(report, '.draft.html');
fs.writeFileSync(dotted, '<p>草稿</p>');

function standIn() {
  const calls = { handlers: {}, sent: [], views: [] };
  const sessions = new Map();
  const session = { fromPartition: (name) => { if (!sessions.has(name)) sessions.set(name, { name, protocol: { handle: () => {} }, webRequest: { onBeforeRequest: () => {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }); return sessions.get(name); } };
  class WebContentsView {
    constructor() {
      const wc = this.webContents = { closed: false, loaded: [], on() {}, loadURL: (u) => { wc.loaded.push(u); return Promise.resolve(); }, setWindowOpenHandler() {}, setWebRTCIPHandlingPolicy() {},
        isDestroyed: () => wc.closed, close: () => { wc.closed = true; }, getURL: () => wc.loaded[wc.loaded.length - 1] || '' };
      calls.views.push(this);
    }
    setBounds() {} setVisible(v) { this.visible = v; }
  }
  const win = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1 }, contentView: { addChildView() {}, removeChildView() {} } };
  registerSideIpc({ onMain: (c, fn) => { calls.handlers[c] = fn; }, handleMain: () => {}, send: (c, m) => calls.sent.push([c, m]), getWindow: () => win, session, WebContentsView,
    resolveClick: (msg) => (fs.existsSync(msg.raw) ? { target: msg.raw } : null), chatDir: () => path.join(tmp, 'chats'), home, tmp: path.join(tmp, 'tmp') });
  return calls;
}

for (const [name, file, why] of [['超过 64 MB 的网页', big, 'big'], ['文件名以 . 开头的网页', dotted, 'name']]) {
  test(name + '打不开时：旧网页不能顶着新标题留在预览栏，预览栏要说明原因', () => {
    const calls = standIn();
    calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
    const view = calls.views[0];
    calls.sent.length = 0;
    calls.handlers['side:preview-html']({}, { raw: file });   // 预览栏标题此时已经换成新文件
    assert.equal(view.webContents.closed, true, '旧网页仍在显示');
    assert.deepEqual(calls.sent, [['side:preview-state', { refused: why, path: file }]], '没开成也该告诉预览栏（否则是一片空白）');
    // 没开过网页时同样要说明
    const fresh = standIn();
    fresh.handlers['side:preview-html']({}, { raw: file });
    assert.deepEqual(fresh.sent, [['side:preview-state', { refused: why, path: file }]]);
  });
}
