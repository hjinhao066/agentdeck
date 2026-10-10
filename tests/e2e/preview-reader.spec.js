const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The side pane's reading tools, in the real app: the outline of a long note
// (jump to a section, the section being read is marked), a file that changes on
// disk shown again where the reader was, find in a note, a code file and a web
// page (⌘F, Ctrl+F off the Mac), a copy button and the language on every code
// block of a note, and a picture opened full screen to zoom and drag. Real files
// in a temporary profile. AGENTDECK_PREVIEW_SHOTS=<folder> saves the report's
// screenshots.
const ROOT = path.resolve(__dirname, '../..');
const Themes = require(path.join(ROOT, 'preview-themes.js'));
const SHOTS = process.env.AGENTDECK_PREVIEW_SHOTS || '';
const COL = 'pv-reader';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
// a real picture: bands of colour with a grid, written by hand so the test needs no image file
function makePng(width, height) {
  const zlib = require('zlib');
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const grid = x % 100 < 3 || y % 100 < 3;
      const band = [[56, 189, 248], [251, 191, 36], [74, 222, 128], [143, 166, 255]][Math.floor(x * 4 / width)];
      row.set(grid ? [11, 15, 30] : band.map((v) => Math.round(v * (0.55 + 0.45 * y / height))), 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(8 + body.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body) >>> 0, 4 + body.length); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
let application, page, profile, files;
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
const open = (file) => page.evaluate(([f, id]) => SidePane.openPreview(f, id), [file, COL]);
const pageView = (run) => application.evaluate(async ({ webContents }, source) => {
  const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('agentdeck-preview://'));
  if (!wc) return null;
  return { url: wc.getURL(), title: wc.getTitle(), result: source ? await wc.executeJavaScript(source) : null };
}, run || '');
async function shot(name, whole) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  fs.writeFileSync(path.join(SHOTS, name), whole ? await page.screenshot() : await page.locator('#sidePane').screenshot());
}
// the page's own view is not in the window's picture: captured on its own and laid where it sits
async function shotWithPage(name) {
  if (!SHOTS) return;
  const base = await page.locator('#sidePane').screenshot();
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
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(merged, 'base64'));
}

// A report long enough to scroll: nine sections, a sub-section every third, code, pictures, a folded callout.
function longNote(top = '', tail = '') {
  const out = ['---', 'title: 预览栏第二轮', 'tags: [AgentDeck]', '---', '', '# 预览栏第二轮', ''];
  if (top) out.push(top, '');
  out.push('这份报告用来试目录、刷新、查找、复制和看图。', '单个回车', '直接换行，和 Obsidian 一样。', '');
  for (let n = 1; n <= 9; n++) {
    out.push(`## 第 ${n} 节`, '');
    for (let k = 1; k <= 4; k++) out.push(`第 ${n} 节第 ${k} 段：AgentDeck 的预览栏要能读长报告。这里有足够多的字，让每一节都比屏幕高一截，好看滚动时目录跟着走，也好看文件变了以后位置还在不在原处。`, '');
    if (n === 2) out.push('```bash', 'npm run e2e -- tests/e2e/preview-reader.spec.js', 'echo "done"', '```', '', '```js', 'function setTheme(id) {', '  note.dataset.mdTheme = id;', '}', '```', '', '```', '没有写语言的一段', '```', '');
    if (n === 4) out.push('![整周的图](shots/wide.png)', '', '![[shots/small.png]]', '');
    if (n === 5) out.push('> [!faq]- 折起来的问答', '> 藏在里面的 AgentDeck 也找得到。', '');
    if (n % 3 === 0) out.push(`### ${n}.1 小节`, '', `第 ${n}.1 小节里的一段话。`, '');
  }
  if (tail) out.push(tail, '');
  return out.join('\n');
}
const codeFile = (head = '') => head + Array.from({ length: 200 }, (_, i) => `const line${i + 1} = setTheme('starlight'); // 第 ${i + 1} 行`).join('\n') + '\n';
const webPage = (word) => `<!doctype html><html><head><meta charset="utf-8"><title>${word}</title><style>body{font:15px/1.7 -apple-system,sans-serif;margin:24px;background:#0b0f1e;color:#e4e8f5}h1{color:#8fa6ff}</style></head><body><h1>${word}</h1>`
  + Array.from({ length: 30 }, (_, i) => `<p>第 ${i + 1} 段：预览栏里的网页也能查找。${i % 3 === 0 ? '这一段提到星光主题。' : ''}</p>`).join('') + '</body></html>';

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adrd-'));
  files = path.join(profile, 'f');
  fs.mkdirSync(P('report', 'shots'), { recursive: true });
  fs.writeFileSync(P('report', 'shots', 'wide.png'), makePng(1600, 900));
  fs.writeFileSync(P('report', 'shots', 'small.png'), makePng(120, 60));
  fs.writeFileSync(P('report', 'long.md'), longNote());
  fs.writeFileSync(P('report', 'short.md'), '# 只有一个标题\n\n正文。\n');
  fs.writeFileSync(P('report', 'code.js'), codeFile());
  fs.writeFileSync(P('report', 'page.html'), webPage('网页查找'));
  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 1, globalViewMode: 'term', perpetualCaptain: { enabled: false }, resumeOnRestart: false,
    chatDeliverablesOpen: false, side: { open: false, tab: 'preview', width: 720 },
    columns: [{ id: COL, title: '阅读', displayTitle: '阅读', manualTitle: true, cwd: profile, width: 700, role: 'manual', cmd: '', view: 'chat' }],
  }));
  await launch();
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

// where a heading sits, in pixels from the top of the visible note
const headingTop = (text) => page.evaluate((t) => {
  const body = document.getElementById('pvBody');
  const h = [...body.querySelectorAll('.pv-md h1, .pv-md h2, .pv-md h3')].find((n) => n.textContent === t);
  return h ? Math.round(h.getBoundingClientRect().top - body.getBoundingClientRect().top) : null;
}, text);
const current = () => page.locator('#pvOutline .pv-ol-item[aria-current="location"]');

test('the outline lists the headings, jumps to one, and marks the section being read', async () => {
  await open(P('report', 'long.md'));
  const md = page.locator('#pvBody .pv-md');
  await expect(md.locator('h1')).toHaveText('预览栏第二轮');
  // single line breaks are kept
  await expect(md.locator('p').first()).toContainText('单个回车');
  expect(await md.locator('p', { hasText: '单个回车' }).evaluate((p) => p.querySelectorAll('br').length)).toBe(2);

  const btn = page.locator('#pvHead .pv-outline-btn');
  await expect(btn).toHaveAttribute('aria-label', '目录');
  await expect(btn).toHaveAttribute('title', '目录');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  expect(await btn.evaluate((b) => b.textContent.trim() === '' && !!b.querySelector('svg') && b.getBoundingClientRect().width >= 28 && b.getBoundingClientRect().height >= 28)).toBe(true);
  const outline = page.locator('#pvOutline');
  await expect(outline).toBeVisible();
  await expect(outline).toHaveAttribute('aria-label', '目录');
  const items = outline.locator('.pv-ol-item');
  const headings = ['预览栏第二轮', ...Array.from({ length: 9 }, (_, i) => [`第 ${i + 1} 节`, ...((i + 1) % 3 === 0 ? [`${i + 1}.1 小节`] : [])]).flat()];
  await expect(items).toHaveText(headings);
  expect(await items.evaluateAll((list) => list.map((i) => Number(i.dataset.depth)))).toEqual(headings.map((h) => (h === '预览栏第二轮' ? 0 : /小节/.test(h) ? 2 : 1)));
  // it sits beside the note, not over it
  const [ol, note] = await page.evaluate(() => [document.getElementById('pvOutline').getBoundingClientRect().right, document.getElementById('pvBody').getBoundingClientRect().left]);
  expect(note).toBeGreaterThanOrEqual(ol - 0.5);

  // a click jumps there and marks it
  await items.filter({ hasText: '第 6 节' }).click();
  await expect.poll(() => headingTop('第 6 节')).toBeLessThan(40);
  expect(await headingTop('第 6 节')).toBeGreaterThanOrEqual(0);
  await expect(current()).toHaveText('第 6 节');
  // reading on moves the mark
  await page.locator('#pvBody').evaluate((b) => { const h = [...b.querySelectorAll('.pv-md h2')].find((n) => n.textContent === '第 3 节'); b.scrollTop += h.getBoundingClientRect().top - b.getBoundingClientRect().top + 60; });
  await expect(current()).toHaveText('第 3 节');
  await page.locator('#pvBody').evaluate((b) => { b.scrollTop = b.scrollHeight; });
  await expect(current()).toHaveText('9.1 小节');          // the last section never reaches the top; at the end it is still the one read
  await page.locator('#pvBody').evaluate((b) => { b.scrollTop = 0; });
  await expect(current()).toHaveText('预览栏第二轮');
  await items.filter({ hasText: '第 4 节' }).click();
  await shot('reader-outline.png');

  // put away, remembered; a note with a single heading has no outline to offer
  await btn.click();
  await expect(outline).toBeHidden();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => config.side.outline)).toBe(false);
  await open(P('report', 'short.md'));
  await expect(page.locator('#pvHead .pv-outline-btn')).toHaveCount(0);
  await expect(outline).toBeHidden();
  await open(P('report', 'long.md'));
  await expect(outline).toBeHidden();
  await page.locator('#pvHead .pv-outline-btn').click();
  await expect(outline).toBeVisible();
  expect(await page.evaluate(() => config.side.outline)).toBe(true);
  // the source view has no outline
  await page.locator('#pvHead .pv-flip').click();
  await expect(outline).toBeHidden();
  await expect(page.locator('#pvHead .pv-outline-btn')).toHaveCount(0);
  await page.locator('#pvHead .pv-flip').click();
  await expect(outline).toBeVisible();
});

test('in a narrow pane the outline floats over the note when asked for, and a jump puts it away', async () => {
  await page.evaluate(() => { config.side.width = 460; SidePane.show('preview'); });
  await page.evaluate(() => { const pane = document.getElementById('sidePane'); pane.style.flex = '0 0 460px'; pane.style.width = '460px'; });
  const outline = page.locator('#pvOutline');
  await expect(outline).toBeHidden();
  const btn = page.locator('#pvHead .pv-outline-btn');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await expect(outline).toBeVisible();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  const [olLeft, bodyLeft] = await page.evaluate(() => [document.getElementById('pvOutline').getBoundingClientRect().left, document.getElementById('pvBody').getBoundingClientRect().left]);
  expect(Math.abs(olLeft - bodyLeft)).toBeLessThanOrEqual(1);      // over the note, not beside it
  await shot('reader-outline-narrow.png');
  await outline.locator('.pv-ol-item', { hasText: '第 7 节' }).click();
  await expect(outline).toBeHidden();
  await expect.poll(() => headingTop('第 7 节')).toBeLessThan(40);
  // Esc puts it away too; the docked choice is untouched
  await btn.click();
  await expect(outline).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(outline).toBeHidden();
  expect(await page.evaluate(() => config.side.outline)).toBe(true);
  await page.evaluate(() => { const pane = document.getElementById('sidePane'); pane.style.flex = '0 0 720px'; pane.style.width = '720px'; config.side.width = 720; });
  await expect(outline).toBeVisible();
});

test('a note changed on disk is shown again in place, with the outline and a short "updated" mark', async () => {
  await open(P('report', 'long.md'));
  await page.locator('#pvOutline .pv-ol-item', { hasText: '第 6 节' }).click();
  await expect.poll(() => headingTop('第 6 节')).toBeLessThan(40);
  const before = await headingTop('第 6 节');
  // a teammate adds a paragraph above where the reader is, and a new section at the end
  fs.writeFileSync(P('report', 'long.md'), longNote('**队员补了一段**：放在最上面，把下面的内容都往下推了。\n\n再补一段，推得更多。', '## 第 10 节\n\n新加的一节。'));
  const md = page.locator('#pvBody .pv-md');
  await expect(md.locator('strong', { hasText: '队员补了一段' })).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#pvHead .pv-fresh')).toBeVisible();
  await expect(page.locator('#pvHead .pv-fresh')).toHaveText('已更新');
  expect(Math.abs((await headingTop('第 6 节')) - before)).toBeLessThanOrEqual(2);
  await expect(page.locator('#pvOutline .pv-ol-item').last()).toHaveText('第 10 节');
  await expect(current()).toHaveText('第 6 节');
  await shot('reader-refresh.png');
  await expect(page.locator('#pvHead .pv-fresh')).toHaveCount(0, { timeout: 6000 });

  // gone for a moment (an editor saving, a teammate moving it): the last text stays, with a note
  fs.rmSync(P('report', 'long.md'));
  await expect(page.locator('#pvHead .pv-gone')).toBeVisible({ timeout: 8000 });
  await expect(md.locator('h1')).toHaveText('预览栏第二轮');
  fs.writeFileSync(P('report', 'long.md'), longNote());
  await expect(page.locator('#pvHead .pv-gone')).toHaveCount(0, { timeout: 8000 });
  await expect(md.locator('strong', { hasText: '队员补了一段' })).toHaveCount(0);
});

test('a code file and a web page are refreshed too: the code keeps the line in view, the page reloads itself', async () => {
  await open(P('report', 'code.js'));
  const body = page.locator('#pvBody');
  await body.evaluate((b) => { b.scrollTop = 18 * 119; });
  const firstLine = () => body.evaluate((b) => b.querySelector('.pv-src').textContent.split('\n')[Math.round(b.scrollTop / 18)]);
  expect(await firstLine()).toContain('line120 ');
  fs.writeFileSync(P('report', 'code.js'), codeFile(Array.from({ length: 15 }, (_, i) => `// 新加在最上面的第 ${i + 1} 行`).join('\n') + '\n'));
  await expect(page.locator('#pvBody .pv-gutter')).toContainText('215', { timeout: 8000 });
  expect(await firstLine()).toContain('line120 ');

  await open(P('report', 'page.html'));
  await expect.poll(async () => (await pageView())?.title, { timeout: 20000 }).toBe('网页查找');
  fs.writeFileSync(P('report', 'page.html'), webPage('网页已改'));
  await expect.poll(async () => (await pageView())?.title, { timeout: 10000 }).toBe('网页已改');
});

// ---- find ----
const count = () => page.locator('#pvFind .pv-find-count');
const highlights = () => page.evaluate(() => [CSS.highlights.get('pv-find')?.size || 0, CSS.highlights.get('pv-find-now')?.size || 0]);

test('⌘F finds a word in a note: every place is marked, Enter and Shift+Enter walk them, a folded answer opens, Esc ends it', async () => {
  await open(P('report', 'long.md'));
  const md = page.locator('#pvBody .pv-md');
  await expect(md.locator('h1')).toHaveText('预览栏第二轮');
  const total = await md.evaluate((n) => (n.textContent.match(/agentdeck/gi) || []).length);
  expect(total).toBeGreaterThan(30);
  await md.locator('h2').first().click();
  await page.keyboard.press(`${MOD}+f`);
  const find = page.locator('#pvFind');
  await expect(find).toBeVisible();
  const input = page.locator('#pvFind input');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-label', '在预览里查找');
  for (const [label, tip] of [['上一个', '上一个（Shift+Enter）'], ['下一个', '下一个（Enter）'], ['关闭查找', '关闭查找（Esc）']]) {
    const b = find.locator(`button[aria-label="${label}"]`);
    await expect(b).toHaveAttribute('title', tip);
    expect(await b.evaluate((n) => n.textContent.trim() === '' && !!n.querySelector('svg') && n.getBoundingClientRect().width >= 28)).toBe(true);
  }
  await input.fill('agentdeck');
  await expect(count()).toHaveText(`1/${total}`);
  expect(await highlights()).toEqual([total, 1]);
  await page.keyboard.press('Enter');
  await expect(count()).toHaveText(`2/${total}`);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  await expect(count()).toHaveText(`${total}/${total}`);       // wraps round to the last
  // the current one is on screen
  const onScreen = () => page.evaluate(() => {
    const r = [...CSS.highlights.get('pv-find-now')][0].getBoundingClientRect(), b = document.getElementById('pvBody').getBoundingClientRect();
    return r.height > 0 && r.top >= b.top && r.bottom <= b.bottom;
  });
  expect(await onScreen()).toBe(true);
  // the one inside the folded answer: walking to it opens it
  const folded = md.locator('details.md-callout');
  await expect(folded).not.toHaveAttribute('open', '');
  const inside = await page.evaluate(() => { const all = [...CSS.highlights.get('pv-find')]; return all.findIndex((r) => r.startContainer.parentElement.closest('details')); });
  expect(inside).toBeGreaterThan(0);
  for (let k = 0; k <= inside; k++) await page.keyboard.press('Enter');
  await expect(count()).toHaveText(`${inside + 1}/${total}`);
  await expect(folded).toHaveAttribute('open', '');
  expect(await onScreen()).toBe(true);
  await input.fill('星光');
  await expect(count()).toHaveText('没找到');
  expect(await highlights()).toEqual([0, 0]);
  await input.fill('第 5 节');
  await expect(count()).toHaveText(/^1\/\d+$/);
  await shot('reader-find-note.png');
  await page.keyboard.press('Escape');
  await expect(find).toBeHidden();
  expect(await highlights()).toEqual([0, 0]);
});

test('find in a code file and in a web page; ⌘F inside the page opens the bar; ⌘F in a conversation is still the conversation search', async () => {
  await open(P('report', 'code.js'));
  await page.locator('#pvBody .pv-src').click();
  await page.keyboard.press(`${MOD}+f`);
  const input = page.locator('#pvFind input');
  await expect(input).toBeFocused();
  // the box remembers the last words and selects them
  await input.fill('settheme(');
  await expect(count()).toHaveText('1/200');
  await page.keyboard.press('Shift+Enter');
  await expect(count()).toHaveText('200/200');
  const seen = await page.evaluate(() => {
    const r = [...CSS.highlights.get('pv-find-now')][0], b = document.getElementById('pvBody').getBoundingClientRect(), box = r.getBoundingClientRect();
    return { text: r.toString(), inView: box.top >= b.top && box.bottom <= b.bottom, line: r.startContainer.parentElement.closest('.pv-src') !== null };
  });
  expect(seen).toEqual({ text: 'setTheme(', inView: true, line: true });
  // the line numbers are not searched: "line200" and "第 200 行", not the gutter's 200
  await input.fill('200');
  await expect(count()).toHaveText('1/2');
  await shot('reader-find-code.png');
  await page.keyboard.press('Escape');

  await open(P('report', 'page.html'));
  await expect.poll(async () => (await pageView())?.title, { timeout: 20000 }).toMatch(/^网页/);
  await page.locator('#pvHead').click();
  await page.keyboard.press(`${MOD}+f`);
  await expect(input).toBeFocused();
  await input.fill('星光主题');
  await expect(count()).toHaveText('1/10', { timeout: 10000 });
  await page.keyboard.press('Enter');
  await expect(count()).toHaveText('2/10');
  await shotWithPage('reader-find-web.png');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pvFind')).toBeHidden();
  // the page's own view sits right under the head again
  await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('#pvBody .pv-web').getBoundingClientRect().top - document.getElementById('pvHead').getBoundingClientRect().bottom))).toBe(0);
  // ⌘F pressed while the page has the keyboard
  await application.evaluate(({ webContents }, mod) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('agentdeck-preview://'));
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: [mod] });
  }, MOD === 'Meta' ? 'meta' : 'control');
  await expect(page.locator('#pvFind')).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');

  // in the column, ⌘F is what it always was (here a terminal: its own search)
  if (MOD === 'Meta') {
    await page.locator(`.column[data-col-id="${COL}"] .xterm`).click();
    await page.keyboard.press('Meta+f');
    await expect(page.locator('#searchInput')).toBeFocused();
    await expect(page.locator('#pvFind')).toBeHidden();
    await page.keyboard.press('Escape');
  }
});

// ---- code blocks ----
test('every code block in a note shows its language and a copy button that copies it and turns into a tick', async () => {
  await open(P('report', 'long.md'));
  const md = page.locator('#pvBody .pv-md');
  await md.locator('.md-pre').first().scrollIntoViewIfNeeded();
  await expect(md.locator('.md-pre')).toHaveCount(3);
  await expect(md.locator('.md-code-lang')).toHaveText(['bash', 'js', '']);
  const copy = md.locator('.md-copy');
  await expect(copy).toHaveCount(3);
  for (const b of await copy.all()) {
    await expect(b).toHaveAttribute('aria-label', '复制代码');
    await expect(b).toHaveAttribute('title', '复制代码');
    expect(await b.evaluate((n) => n.textContent.trim() === '' && !!n.querySelector('svg') && n.getBoundingClientRect().width >= 28 && n.getBoundingClientRect().height >= 28)).toBe(true);
  }
  // a test profile has a clipboard of its own (the machine's is left alone)
  const clip = () => page.evaluate(() => window.deck.clipboardRead());
  await page.evaluate(() => window.deck.clipboardWrite('before'));
  await copy.first().click();
  await expect.poll(clip).toBe('npm run e2e -- tests/e2e/preview-reader.spec.js\necho "done"');
  await expect(copy.first()).toHaveAttribute('aria-label', '已复制');
  await expect(copy.first()).toHaveClass(/done/);
  await shot('reader-code-copy.png');
  await expect(copy.first()).toHaveAttribute('aria-label', '复制代码', { timeout: 4000 });
  await expect(copy.first()).not.toHaveClass(/done/);
  // by keyboard too
  await copy.nth(1).focus();
  await page.keyboard.press('Enter');
  await expect.poll(clip).toBe('function setTheme(id) {\n  note.dataset.mdTheme = id;\n}');
});

// ---- pictures ----
test('a picture opens full screen: fitted, zoomed by wheel and buttons around the pointer, dragged, back with Esc', async () => {
  const md = page.locator('#pvBody .pv-md');
  const wide = md.locator('img.md-img[alt="整周的图"]');
  await wide.scrollIntoViewIfNeeded();
  await expect.poll(() => wide.evaluate((img) => img.naturalWidth)).toBe(1600);
  await expect(wide).toHaveAttribute('role', 'button');
  await expect(wide).toHaveAttribute('aria-label', '放大查看：整周的图');
  await wide.click();
  const box = page.locator('dialog.pv-lightbox');
  await expect(box).toHaveAttribute('open', '');
  const img = box.locator('.pv-lb-img');
  const rect = () => img.evaluate((n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  let r = await rect();
  expect(r.w).toBeLessThanOrEqual(view.w);
  expect(r.h).toBeLessThanOrEqual(view.h);
  expect(r.w).toBeGreaterThan(view.w * 0.6);                     // fitted, not left small
  const zoom = box.locator('.pv-lb-zoom');
  await expect(zoom).toHaveText(Math.round(r.w / 16) + '%');
  for (const [label, tip] of [['缩小', '缩小（-）'], ['放大', '放大（+）'], ['适合屏幕', '适合屏幕（0）'], ['原始大小', '原始大小（1）'], ['关闭', '关闭（Esc）']]) {
    const b = box.locator(`button[aria-label="${label}"]`);
    await expect(b).toHaveAttribute('title', tip);
    expect(await b.evaluate((n) => n.textContent.trim() === '' && !!n.querySelector('svg') && n.getBoundingClientRect().width >= 28)).toBe(true);
  }
  await shot('reader-lightbox.png', true);

  // the wheel zooms about the pointer: the picture point under it stays under it
  const at = { x: r.x + r.w * 0.3, y: r.y + r.h * 0.4 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await rect()).w).toBeGreaterThan(r.w * 1.2);
  const z = await rect();
  expect(Math.abs((at.x - z.x) / z.w - 0.3)).toBeLessThan(0.01);
  expect(Math.abs((at.y - z.y) / z.h - 0.4)).toBeLessThan(0.01);
  // dragged
  await page.mouse.down();
  await page.mouse.move(at.x - 150, at.y - 90, { steps: 5 });
  await page.mouse.up();
  const d = await rect();
  expect(Math.round(d.x - z.x)).toBe(-150);
  expect(Math.round(d.y - z.y)).toBe(-90);
  // buttons and keys
  await box.locator('button[aria-label="原始大小"]').click();
  await expect(zoom).toHaveText('100%');
  expect(Math.round((await rect()).w)).toBe(1600);
  await page.keyboard.press('0');
  await expect.poll(async () => Math.round((await rect()).w)).toBe(Math.round(r.w));
  await box.locator('button[aria-label="放大"]').click();
  await expect.poll(async () => (await rect()).w).toBeGreaterThan(r.w * 1.1);
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  await expect.poll(async () => (await rect()).w).toBeLessThan(r.w);
  // a double click goes to the picture's own size and back
  await img.dblclick();
  await expect(zoom).toHaveText('100%');
  await img.dblclick();
  await expect.poll(async () => Math.round((await rect()).w)).toBe(Math.round(r.w));
  await page.keyboard.press('Escape');
  await expect(box).not.toHaveAttribute('open', '');
  await expect(wide).toBeFocused();
  // the keyboard opens it as well; a small picture opens at its own size
  const small = md.locator('img.md-img[alt="shots/small.png"]');
  await small.focus();
  await page.keyboard.press('Enter');
  await expect(box).toHaveAttribute('open', '');
  await expect(zoom).toHaveText('100%');
  await box.locator('button[aria-label="关闭"]').click();
  await expect(box).not.toHaveAttribute('open', '');
  // a picture previewed on its own opens the same way
  await open(P('report', 'shots', 'wide.png'));
  await page.locator('#pvBody .pv-image').click();
  await expect(box).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
});

// ---- the new pieces in every theme ----
test('the outline, the code block bars and the picture viewer read clearly in every theme, light and dark', async () => {
  await open(P('report', 'long.md'));
  await expect(page.locator('#pvOutline')).toBeVisible();
  const measure = (selector) => page.evaluate((sel) => {
    const rgb = (value) => { const m = /rgba?\(([^)]+)\)/.exec(value); const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const behind = (node) => { for (let n = node; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.a === 1) return c; if (c.a > 0) throw new Error('see-through background on ' + n.tagName + '.' + n.className); } throw new Error('no background'); };
    let size = Infinity, ratio = Infinity, low = '', count = 0;
    for (const root of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue.trim()) continue;
        const el = node.parentElement, style = getComputedStyle(el);
        count++;
        size = Math.min(size, parseFloat(style.fontSize));
        const a = lum(rgb(style.color)), b = lum(behind(el));
        const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (r < ratio) { ratio = r; low = el.tagName + '.' + el.className + ' ' + style.color; }
      }
    }
    return { size, ratio: Math.round(ratio * 100) / 100, low, count };
  }, selector);
  for (const mode of ['dark', 'light']) {
    await page.evaluate((m) => applyTheme(m), mode);
    for (const theme of Themes.THEMES) {
      await page.evaluate((id) => SidePane.setTheme(id), theme.id);
      for (const sel of ['#pvOutline', '#pvBody .md-code-bar']) {
        const m = await measure(sel);
        expect(m.count, sel).toBeGreaterThan(1);
        expect(m.size, `${theme.id} ${mode} ${sel}`).toBeGreaterThanOrEqual(11.5);
        expect(m.ratio, `${theme.id} ${mode} ${sel}: ${m.low}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
  await page.evaluate(() => { applyTheme('dark'); SidePane.setTheme('starlight'); });
});
