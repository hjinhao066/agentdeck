const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// The side pane's preview of a web page and of a Markdown note, in the real app.
// A web page is drawn by a separate view: its scripts run, and from inside it
// there is no Node, no deck bridge, no file outside its own folder, nothing on
// this machine's own network address. A note is shown in one of six colour
// themes, picked with one click and remembered across a restart; every piece
// of text is measured on screen (size and contrast) in the light and the dark
// deck. Real files in a temporary profile; the "local service" the page tries
// to reach is a server this test starts and counts requests on.
// AGENTDECK_PREVIEW_SHOTS=<folder> also saves the screenshots of the report.
const ROOT = path.resolve(__dirname, '../..');
const Themes = require(path.join(ROOT, 'preview-themes.js'));
const SHOTS = process.env.AGENTDECK_PREVIEW_SHOTS || '';
const COL = 'pv-chat';
// a real 96×48 picture: bands of colour, written by hand so the test needs no image file
function makePng(width, height) {
  const zlib = require('zlib');
  const rows = [];
  for (let y = 0; y < height; y++) { const row = Buffer.alloc(1 + width * 3); for (let x = 0; x < width; x++) row.set([[56, 189, 248], [251, 191, 36], [74, 222, 128]][Math.floor(x * 3 / width)].map((v) => Math.round(v * (0.55 + 0.45 * y / height))), 1 + x * 3); rows.push(row); }
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(8 + body.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body) >>> 0, 4 + body.length); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(96, 48);
let application, page, profile, files, server, hits = [], loose;

const P = (...p) => path.join(files, ...p);
const env = () => { const e = { ...process.env }; for (const key of Object.keys(e)) if (key.startsWith('AGENTDECK_') || key === 'ELECTRON_RUN_AS_NODE') delete e[key]; return e; };
async function launch() {
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env: env() });
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate((id) => typeof terms !== 'undefined' && terms.has(id), COL), { timeout: 30000 }).toBe(true);
  await page.evaluate(() => document.fonts.ready);
}
// The previewed page's own view, seen from the main process.
const pageView = (run) => application.evaluate(async ({ webContents, BrowserWindow }, source) => {
  const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('agentdeck-preview://'));
  if (!wc) return null;
  const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'AgentDeck');
  const view = win.contentView.children.find((v) => v.webContents === wc);
  const prefs = wc.getLastWebPreferences();
  return {
    url: wc.getURL(), title: wc.getTitle(), bounds: view ? view.getBounds() : null,
    prefs: { sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, preload: prefs.preload || '', webviewTag: prefs.webviewTag },
    ownSession: wc.session !== win.webContents.session, persistent: wc.session.isPersistent(),
    result: source ? await wc.executeJavaScript(source) : null,
  };
}, run || '');
async function shot(name, withPage) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const base = await page.locator('#sidePane').screenshot();
  if (!withPage) { fs.writeFileSync(path.join(SHOTS, name), base); return; }
  // the page's view is not part of the window's own picture: it is captured on its own and laid where it sits
  const over = await application.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('agentdeck-preview://'));
    return (await wc.capturePage()).toPNG().toString('base64');
  });
  const merged = await page.evaluate(async ({ base, over }) => {
    const load = (data) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = 'data:image/png;base64,' + data; });
    const [a, b] = await Promise.all([load(base), load(over)]);
    const pane = document.getElementById('sidePane').getBoundingClientRect(), web = document.querySelector('#pvBody .pv-web').getBoundingClientRect();
    const scale = a.width / pane.width;
    const canvas = document.createElement('canvas'); canvas.width = a.width; canvas.height = a.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(a, 0, 0);
    ctx.drawImage(b, (web.left - pane.left) * scale, (web.top - pane.top) * scale, web.width * scale, web.height * scale);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { base: base.toString('base64'), over });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(merged, 'base64'));
}

const NOTE = `---
title: 预览栏改版周报
tags: [AgentDeck, 周报]
date: 2026-10-09
---

# 预览栏改版周报

这一周把右侧预览栏做成了**真正能读**的样子：网页直接渲染，笔记有了*多套主题*，行内代码如 \`renderMarkdown()\` 也有自己的颜色。==最要紧的一条==：切换只要点一下，~~不用重开文件~~。详见 [[设计说明]]、[Obsidian 主题库](https://obsidian.md/themes) 和 #预览栏/主题 。结论有出处[^1]。

## 一、做了什么

### 1. 网页预览

- 网页在隔离的视图里渲染，脚本照常运行
  - 读不到自己文件夹以外的文件
  - 连不到本机和局域网
- 一键切回源码

### 2. 阅读主题

1. 六套主题，深浅各一套
2. 所有文字对比度不低于 4.5:1
3. 最小字号 11.5px

#### 待办

- [x] 高亮、删除线、任务框
- [x] 提示框和属性表
- [ ] 目录大纲（等你挑）

> 好的工具让人忘了工具本身，只记得内容。
> **引用里**也可以有*强调*和[链接](https://example.com)。

> [!tip] 小技巧
> 调色板按钮点开后不会自己收起，可以一套一套点着比。

> [!warning] 注意
> 放在「下载」「桌面」里的网页只加载它自己。

## 二、数据

| 主题 | 风格 | 标题颜色 | 对比度 |
| :--- | :---: | :---: | ---: |
| Obsidian 默认 | 中性灰 + 紫 | 3 种 | 4.6 以上 |
| Catppuccin | 柔和粉彩 | 6 种 | 4.6 以上 |
| Blue Topaz | 通体蓝调 | 5 种 | 4.6 以上 |

\`\`\`js
// 切换主题：只改一个属性，颜色全部跟着变
function setTheme(id) {
  note.dataset.mdTheme = id;   // "catppuccin"
  return save({ mdTheme: id, at: 20261009 });
}
\`\`\`

![本周截图](shots/chart.png)

---

##### 五级标题
###### 六级标题

[^1]: 对比度按 WCAG 2.1 的公式逐对计算。
`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end('local service'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adpv-'));
  files = path.join(profile, 'f');
  fs.mkdirSync(P('report', 'shots'), { recursive: true });
  fs.writeFileSync(P('secret.txt'), 'outside the report folder');
  fs.writeFileSync(P('report', '.env'), 'KEY=1');
  fs.writeFileSync(P('report', 'data.json'), '{"done":7,"left":2}');
  fs.writeFileSync(P('report', 'shots', 'chart.png'), PNG);
  fs.writeFileSync(P('report', 'style.css'), 'body{font:15px/1.6 -apple-system,"Segoe UI",sans-serif;margin:24px;background:#0f172a;color:#e2e8f0}h1{color:#38bdf8}.bar{height:18px;margin:6px 0;border-radius:4px;background:#38bdf8}a{color:#fbbf24}.ok{color:#4ade80}');
  fs.writeFileSync(P('report', 'app.js'), 'window.__external = true;\n');
  fs.writeFileSync(P('report', 'detail.html'), '<!doctype html><meta charset="utf-8"><title>明细页</title><link rel="stylesheet" href="style.css"><h1>明细</h1><a id="back" href="index.html">返回</a>');
  const probe = `
    (async () => {
      const get = async (url) => { try { return (await fetch(url)).status; } catch (e) { return 'blocked'; } };
      const picture = (url) => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('loaded'); i.onerror = () => resolve('blocked'); i.src = url; });
      const out = { inline: true, external: window.__external === true };
      out.node = [typeof require, typeof process, typeof module, typeof window.deck, typeof window.electron].join();
      out.alone = window.top === window && window.parent === window && window.opener === null;
      out.own = await get('data.json');
      out.data = await fetch('data.json').then((r) => r.json()).catch(() => null);
      out.up = await get('../secret.txt');
      out.up2 = await get('/%2e%2e/secret.txt');
      out.hidden = await get('.env');
      out.file = await get(${JSON.stringify(pathToFileURL(P('secret.txt')).href)});
      out.fileImg = await picture(${JSON.stringify(pathToFileURL(P('report', 'shots', 'chart.png')).href)});
      out.local = await get('http://127.0.0.1:${port}/fetch');
      out.localName = await get('http://localhost:${port}/fetch-name');
      out.localImg = await picture('http://127.0.0.1:${port}/pixel.png');
      out.popup = window.open(${JSON.stringify(pathToFileURL(P('secret.txt')).href)}) === null;
      out.ownImg = await picture('shots/chart.png');
      try { localStorage.setItem('k', 'v'); out.storage = localStorage.getItem('k'); } catch (e) { out.storage = 'error'; }
      out.css = getComputedStyle(document.querySelector('h1')).color;
      const bars = document.getElementById('bars');
      for (const [name, share] of [['网页预览', 100], ['阅读主题', 100], ['目录大纲', 20]]) { const row = document.createElement('div'); row.textContent = name; const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = share + '%'; bars.append(row, bar); }
      document.getElementById('sum').textContent = '脚本已运行：完成 ' + (out.data ? out.data.done : '?') + ' 项，剩 ' + (out.data ? out.data.left : '?') + ' 项';
      window.__probe = out; document.title = 'probe-done';
    })();`;
  fs.writeFileSync(P('report', 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>周报</title><link rel="stylesheet" href="style.css"></head>
<body><h1>本周进度</h1><p id="sum">脚本还没运行</p><div id="bars"></div><img src="shots/chart.png" alt="本周截图" width="192" height="96">
<p><a id="next" href="detail.html">明细</a> · <a id="web" href="https://example.invalid/docs">外部文档</a></p>
<script src="app.js"></script><script>${probe}</script></body></html>`);
  fs.writeFileSync(P('report', 'notes.md'), NOTE);
  fs.writeFileSync(P('report', '设计说明.md'), '# 设计说明\n\n从周报点过来的。\n');
  // a page lying loose in the temporary folder itself: a catch-all place
  loose = path.join(os.tmpdir(), `adpv-loose-${process.pid}.html`);
  fs.writeFileSync(loose.replace(/\.html$/, '.txt'), 'next to the loose page');
  fs.writeFileSync(loose, `<!doctype html><meta charset="utf-8"><title>loose</title><p>散放的网页</p><script>fetch(${JSON.stringify(path.basename(loose).replace(/\.html$/, '.txt'))}).then((r) => r.status, () => 'blocked').then((s) => { document.title = 'loose-' + s; });</script>`);

  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 1, globalViewMode: 'term', perpetualCaptain: { enabled: false }, resumeOnRestart: false,
    chatDeliverablesOpen: false, side: { open: false, tab: 'preview', width: 640 },
    columns: [{ id: COL, title: '预览', displayTitle: '预览', manualTitle: true, cwd: profile, width: 900, role: 'manual', cmd: '', view: 'chat' }],
  }));
  await launch();
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  if (loose) for (const f of [loose, loose.replace(/\.html$/, '.txt')]) fs.rmSync(f, { force: true });
});

test('a web page is drawn as the page, its scripts run, and it reaches nothing but its own folder', async () => {
  await page.evaluate(([file, id]) => SidePane.openPreview(file, id), [P('report', 'index.html'), COL]);
  await expect(page.locator('#pvBody .pv-web')).toBeVisible();
  await expect(page.locator('#pvBody .pv-web-note')).toBeHidden();
  await expect.poll(async () => (await pageView())?.title, { timeout: 20000 }).toBe('probe-done');
  const view = await pageView('JSON.stringify(window.__probe)');
  const probe = JSON.parse(view.result);

  // the page works: its own script file, its inline script, its data, its picture, its style sheet, storage of its own
  expect(probe).toMatchObject({ inline: true, external: true, own: 200, data: { done: 7, left: 2 }, ownImg: 'loaded', storage: 'v', css: 'rgb(56, 189, 248)' });
  // it is alone: no Node, no bridge, no frame above it
  expect(probe.node).toBe('undefined,undefined,undefined,undefined,undefined');
  expect(probe.alone).toBe(true);
  // nothing outside its folder, nothing hidden, no file address, nothing on this machine
  expect(probe).toMatchObject({ up: 404, up2: 404, hidden: 404, file: 'blocked', fileImg: 'blocked', local: 'blocked', localName: 'blocked', localImg: 'blocked', popup: true });
  expect(hits).toEqual([]);

  // how the view is built, read back from the running app
  expect(view.url).toMatch(/^agentdeck-preview:\/\/[a-f0-9]{32}\/index\.html$/);
  expect(view.prefs).toEqual({ sandbox: true, nodeIntegration: false, contextIsolation: true, preload: '', webviewTag: false });
  expect(view.ownSession).toBe(true);
  expect(view.persistent).toBe(false);
  // the deck's own page still has its bridge and knows nothing of the page's storage
  expect(await page.evaluate(() => [typeof window.deck.previewRead, localStorage.getItem('k')])).toEqual(['function', null]);
  // it sits exactly on its placeholder in the pane
  const want = await page.evaluate(() => { const r = document.querySelector('#pvBody .pv-web').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); });
  await expect.poll(async () => { const b = (await pageView()).bounds; return Math.max(...[b.x, b.y, b.width, b.height].map((v, i) => Math.abs(v - want[i]))); }).toBeLessThanOrEqual(1);
  expect(want[2]).toBeGreaterThan(300);
  await shot('html-rendered.png', true);
});

test('one button switches between the page and its source, and back', async () => {
  const flip = page.locator('#pvHead .pv-flip');
  await expect(flip).toHaveAttribute('aria-label', '看源码');
  await expect(flip).toHaveAttribute('title', '看源码');
  expect(await flip.evaluate((b) => b.textContent.trim() === '' && !!b.querySelector('svg') && b.getBoundingClientRect().width >= 28 && b.getBoundingClientRect().height >= 28)).toBe(true);
  await flip.click();
  await expect(page.locator('#pvBody .pv-code .pv-src')).toContainText('<title>周报</title>');
  await expect(page.locator('#pvBody .pv-web')).toHaveCount(0);
  await expect(page.locator('#pvHead .pv-flip')).toHaveAttribute('aria-label', '看网页');
  // the page is not left running behind the source
  await expect.poll(pageView).toBeNull();
  await shot('html-source.png');
  await page.locator('#pvHead .pv-flip').click();
  await expect(page.locator('#pvBody .pv-web')).toBeVisible();
  await expect.poll(async () => (await pageView())?.title, { timeout: 20000 }).toBe('probe-done');
});

test('reload shows the file as it is now; its own links work; a web link goes to the browser tab; other addresses go nowhere', async () => {
  fs.writeFileSync(P('report', 'app.js'), 'window.__external = true; document.querySelector("h1").textContent = "本周进度（已更新）";\n');
  await page.locator('#pvHead button[aria-label="重新加载网页"]').click();
  await expect.poll(async () => (await pageView('document.querySelector("h1").textContent'))?.result, { timeout: 20000 }).toBe('本周进度（已更新）');

  await pageView('document.getElementById("next").click()');
  await expect.poll(async () => (await pageView())?.title).toBe('明细页');
  await pageView('location.href = ' + JSON.stringify(pathToFileURL(P('secret.txt')).href));
  await pageView('location.href = "http://127.0.0.1:' + server.address().port + '/navigate"');
  await page.waitForTimeout(600);
  expect((await pageView()).url).toMatch(/^agentdeck-preview:\/\/[a-f0-9]{32}\/detail\.html$/);
  // … and an address on this machine is not handed to the browser tab either
  await expect(page.locator('#sideTabs .side-tab.active')).toHaveAttribute('data-tab', 'preview');
  expect(hits).toEqual([]);
  await pageView('document.getElementById("back").click()');
  await expect.poll(async () => (await pageView())?.url).toMatch(/index\.html$/);

  await pageView('document.getElementById("web").click()');
  await expect(page.locator('#sideTabs .side-tab.active')).toHaveAttribute('data-tab', 'browser');
  await expect(page.locator('#sbUrl')).toHaveValue(/^https:\/\/example\.invalid\/docs/);
  expect((await pageView()).url).toMatch(/index\.html$/);
  await page.locator('#sideTabs .side-tab[data-tab="preview"]').click();
});

test('a page lying in a catch-all folder is shown alone, and the pane says so', async () => {
  await page.evaluate(([file, id]) => SidePane.openPreview(file, id), [loose, COL]);
  await expect(page.locator('#pvBody .pv-web-note')).toBeVisible();
  await expect(page.locator('#pvBody .pv-web-note')).toContainText('只加载了它自己');
  await expect.poll(async () => (await pageView())?.title, { timeout: 20000 }).toBe('loose-404');
  // the note takes its own row: the page's view starts below it
  const [noteBottom, viewTop] = await page.evaluate(() => [document.querySelector('.pv-web-note').getBoundingClientRect().bottom, document.querySelector('.pv-web').getBoundingClientRect().top]);
  expect(viewTop).toBeGreaterThanOrEqual(noteBottom - 0.5);
  await expect.poll(async () => Math.abs((await pageView()).bounds.y - Math.round(viewTop))).toBeLessThanOrEqual(1);
});

// Every text node inside the note: the smallest font size, and the lowest contrast against what is drawn behind it.
const measure = () => page.evaluate(() => {
  const md = document.querySelector('#pvBody .pv-md');
  const rgb = (value) => { const m = /rgba?\(([^)]+)\)/.exec(value); const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const behind = (node) => { for (let n = node; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.a === 1) return c; if (c.a > 0) throw new Error('see-through background on ' + n.tagName); if (n === md) break; } throw new Error('no background'); };
  const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
  let size = Infinity, ratio = Infinity, small = '', low = '', count = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue.trim()) continue;
    const el = node.parentElement, style = getComputedStyle(el);
    count++;
    const px = parseFloat(style.fontSize);
    if (px < size) { size = px; small = el.tagName + '.' + el.className; }
    const a = lum(rgb(style.color)), b = lum(behind(el));
    const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (r < ratio) { ratio = r; low = el.tagName + '.' + el.className + ' ' + style.color; }
  }
  const colour = (sel) => getComputedStyle(md.querySelector(sel)).color;
  return { size, small, ratio: Math.round(ratio * 100) / 100, low, count, theme: md.dataset.mdTheme, bg: getComputedStyle(md).backgroundColor,
    h: [colour('h1'), colour('h2'), colour('h3')], body: colour('p'), parts: [colour('strong'), colour('em'), colour('p code'), colour('a[data-ext]')], mark: getComputedStyle(md.querySelector('mark')).backgroundColor };
});
const asRgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

test('a note is laid out like an Obsidian note: properties, highlight, tasks, callouts, tags, footnotes, pictures, links to other notes', async () => {
  await page.evaluate(([file, id]) => SidePane.openPreview(file, id), [P('report', 'notes.md'), COL]);
  const md = page.locator('#pvBody .pv-md');
  await expect(md.locator('h1')).toHaveText('预览栏改版周报');
  await expect.poll(pageView).toBeNull();       // the web page before it is gone
  await expect(md).toHaveAttribute('data-md-theme', 'obsidian');
  await expect(md.locator('.md-props tr')).toHaveCount(3);
  await expect(md.locator('.md-props .md-tag')).toHaveText(['AgentDeck', '周报']);
  await expect(md.locator('mark')).toHaveText('最要紧的一条');
  await expect(md.locator('li.md-task')).toHaveCount(3);
  await expect(md.locator('li.md-task.done')).toHaveCount(2);
  await expect(md.locator('.md-callout[data-kind="tip"] .md-callout-title')).toHaveText('小技巧');
  await expect(md.locator('.md-callout[data-kind="warn"]')).toContainText('只加载它自己');
  await expect(md.locator('p .md-tag')).toHaveText('#预览栏/主题');
  await expect(md.locator('.md-footnotes li')).toHaveText('对比度按 WCAG 2.1 的公式逐对计算。');
  await expect(md.locator('.md-table th')).toHaveCount(4);
  // the picture next to the note is shown
  await expect.poll(() => md.locator('img.md-img').evaluate((img) => img.naturalWidth)).toBe(96);
  // the task box is drawn, not typed
  expect(await md.locator('li.md-task.done .md-box').first().evaluate((box) => { const r = box.getBoundingClientRect(); return r.width >= 12 && r.height >= 12 && getComputedStyle(box).backgroundColor !== 'rgba(0, 0, 0, 0)'; })).toBe(true);
  // a [[link]] opens the note beside this one, a web link the browser tab
  await md.locator('a.md-wiki').click();
  await expect(page.locator('#pvBody .pv-md h1')).toHaveText('设计说明');
  await page.evaluate(([file, id]) => SidePane.openPreview(file, id), [P('report', 'notes.md'), COL]);
  await expect(page.locator('#pvBody .pv-md h1')).toHaveText('预览栏改版周报');
  // the source view is one click away, as before
  await page.locator('#pvHead .pv-flip').click();
  await expect(page.locator('#pvBody .pv-code .pv-src')).toContainText('==最要紧的一条==');
  await expect(page.locator('#pvHead .pv-theme')).toHaveCount(0);
  await page.locator('#pvHead .pv-flip').click();
  await expect(page.locator('#pvBody .pv-md h1')).toHaveText('预览栏改版周报');
});

test('six themes, one click each: every one colours headings and text its own way, readable in the light and the dark deck', async () => {
  const btn = page.locator('#pvHead .pv-theme-btn');
  await expect(btn).toHaveAttribute('aria-label', '换阅读主题');
  await expect(btn).toHaveAttribute('title', '换阅读主题');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  expect(await btn.evaluate((b) => b.textContent.trim() === '' && !!b.querySelector('svg') && b.getBoundingClientRect().width >= 28 && b.getBoundingClientRect().height >= 28)).toBe(true);
  // tall enough to see the whole note in the report's screenshots
  if (SHOTS) await page.setViewportSize({ width: 1440, height: 1740 });
  const seen = new Set();
  for (const mode of ['dark', 'light']) {
    await page.evaluate((m) => applyTheme(m), mode);
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    const items = page.locator('.pv-theme-menu .pv-theme-item');
    await expect(items).toHaveCount(Themes.THEMES.length);
    await expect(items.locator('.pv-theme-name')).toHaveText(Themes.THEMES.map((t) => t.name));
    for (const theme of Themes.THEMES) {
      // one click; the list stays open for the next one
      await page.locator(`.pv-theme-item[data-theme="${theme.id}"]`).click();
      await expect(page.locator(`.pv-theme-item[data-theme="${theme.id}"]`)).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator('.pv-theme-item[aria-checked="true"]')).toHaveCount(1);
      const m = await measure();
      const c = theme[mode];
      expect(m.theme).toBe(theme.id);
      expect(m.bg).toBe(asRgb(c.bg));
      expect(m.h).toEqual([asRgb(c.h1), asRgb(c.h2), asRgb(c.h3)]);
      expect(m.parts).toEqual([asRgb(c.strong), asRgb(c.em), asRgb(c.code), asRgb(c.link)]);
      expect(m.mark).toBe(asRgb(c.markBg));
      if (!theme.quiet) expect(new Set([...m.h, m.body]).size).toBe(4);
      expect(m.count).toBeGreaterThan(60);
      expect(m.size, `${theme.id} ${mode}: smallest text ${m.small}`).toBeGreaterThanOrEqual(11.5);
      expect(m.ratio, `${theme.id} ${mode}: lowest contrast ${m.low}`).toBeGreaterThanOrEqual(4.5);
      seen.add(m.bg + m.h.join());
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.pv-theme-menu')).toHaveCount(0);
    await expect(btn).toBeFocused();
    if (SHOTS) for (const theme of Themes.THEMES) {
      await page.evaluate((id) => { document.activeElement.blur(); document.querySelector('#pvBody .pv-md').dataset.mdTheme = id; }, theme.id);
      await page.locator('#pvBody').evaluate((n) => { n.scrollTop = 0; });
      await shot(`theme-${theme.id}-${mode}.png`);
    }
  }
  expect(seen.size).toBe(Themes.THEMES.length * 2);     // twelve different looks
  if (SHOTS) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#pvHead .pv-theme-btn').click();
    await page.locator('#pvBody').evaluate((n) => { n.scrollTop = 0; });
    await shot('theme-picker.png');
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => applyTheme('dark'));
});

test('the keyboard picks a theme too, and the choice is still there after a restart', async () => {
  const btn = page.locator('#pvHead .pv-theme-btn');
  await btn.focus();
  await page.keyboard.press('Enter');
  const last = Themes.THEMES[Themes.THEMES.length - 1].id, first = Themes.THEMES[0].id;
  await expect(page.locator(`.pv-theme-item[data-theme="${last}"]`)).toBeFocused();    // opens on the one in use
  await page.keyboard.press('ArrowDown');                                              // wraps to the first
  await expect(page.locator(`.pv-theme-item[data-theme="${first}"]`)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const picked = Themes.THEMES[1].id;
  await expect(page.locator('#pvBody .pv-md')).toHaveAttribute('data-md-theme', picked);
  // a click elsewhere closes the list
  await page.locator('#pvBody .pv-md h1').click();
  await expect(page.locator('.pv-theme-menu')).toHaveCount(0);
  expect(await page.evaluate(() => config.side.mdTheme)).toBe(picked);
  await page.evaluate(() => flushConfig());
  await expect.poll(() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).side.mdTheme; } catch (_) { return null; } }).toBe(picked);

  await closeElectron(application);
  await launch();
  await page.evaluate(([file, id]) => SidePane.openPreview(file, id), [P('report', 'notes.md'), COL]);
  await expect(page.locator('#pvBody .pv-md')).toHaveAttribute('data-md-theme', picked);
  expect((await measure()).bg).toBe(asRgb(Themes.THEMES[1].dark.bg));
});
