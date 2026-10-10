const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// The ChatGPT-style chat page: your message on the right in a bubble, the
// reply on the left, its work folded above it ("处理了 …"), web/changed-file
// cards under it and icon-only actions. Old saved turns (no end/steps) and new
// ones render side by side. Real renderer, isolated userData, stand-in TUI.
// Set AGENTDECK_CHAT_SHOTS to a folder to keep dark/light PNGs.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_CHAT_SHOTS;
const ID = 'cr-0';
let application, page, profile, note, image;
const errors = [];
test.describe.configure({ mode: 'serial' });

// A small gradient PNG for the attachment thumbnail (no image library needed).
function png(file, w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push(60 + Math.round(140 * x / w), 90 + Math.round(100 * y / h), 200);
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]));
}
async function screenshot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css' });
}
const col = () => page.locator(`.column[data-col-id="${ID}"]`);
const turnsOf = () => page.evaluate((i) => JSON.parse(JSON.stringify(ChatUI.turnsOf(i))), ID);

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-chat-redesign-'));
  note = path.join(profile, 'DESIGN-SPEC.md');
  fs.writeFileSync(note, '# Design spec\n\nwarm white background, beige groups\n');
  image = path.join(profile, 'settings-shot.png');
  png(image, 160, 110);
  const now = Date.now();
  const sent = now - 26 * 3600_000;
  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'chats', ID + '.json'), JSON.stringify({ v: 1, id: ID, turns: [
    // saved by an older AgentDeck: no end, no steps
    { id: 'old1', ts: now - 3 * 86400_000, user: '帮我看一下这张截图里的设置页，为什么在 Windows 上显得这么挤？', atts: [image], done: true,
      reply: '**结论：主要是间距和字体。** Windows 版用了系统默认字号，分组之间没有留白。\n\n> 先统一间距，再换字体，最后才动配色。\n\n```css\n.settings-group { padding: 16px 20px; gap: 12px; }\n```' },
    // saved by this version: finish time and the work before the reply
    { id: 'new1', ts: sent, end: sent + (18 * 60 + 43) * 1000, user: '按这个方向把设计包整理好，传到 Windows 那台电脑。', atts: [], done: true,
      steps: ['先读一下现有的设置页结构。', 'Read(settings.html) ⎿ Read 210 lines', 'Bash(ls design) ⎿ 6 files', '原图已经齐了，开始写规范。',
        'Write(' + note + ') ⎿ Wrote 140 lines to ' + note, 'Update(README.md) ⎿ Added 23 lines, removed 0 lines',
        'Bash(scp -r design win:/d/aiproject) ⎿ 24 files', 'Bash(sha256sum -c) ⎿ OK', '核对通过，整理回复。',
        'Update(prompt.md) ⎿ Added 96 lines, removed 0 lines'],
      reply: '**设计包已传到 Windows，24 个文件完整性核对通过。** 包含原图、样板、设计规范和执行提示词。\n\n方向：**暖白背景、米色分组、左侧导航、统一间距与小圆角**。\n\n规范在 ' + note + '，预览 https://example.com/design/preview' },
  ] }));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 1, globalViewMode: 'chat',
    columns: [{ id: ID, title: '设计对话', displayTitle: '设计对话', manualTitle: true, cmd: FAKE, cwd: profile, width: 760, role: 'manual', view: 'chat' }],
  }));
  const env = { ...process.env, AGENTDECK_DEMO_FILE: note };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST') && k !== 'AGENTDECK_DEMO_FILE') delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1180, height: 940 });
  await expect.poll(() => page.evaluate((i) => typeof terms !== 'undefined' && terms.has(i), ID), { timeout: 20000 }).toBe(true);
  await page.evaluate((i) => ChatUI.setMode(i, 'chat'), ID);
  await expect(col()).toHaveClass(/chat-mode/);
  await expect.poll(() => page.evaluate((i) => /Claude Code/.test(terms.get(i)?.lastScreen || ''), ID), { timeout: 20000 }).toBe(true);
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('your messages sit on the right in bubbles, replies on the left as text, each turn under its time', async () => {
  const turn = col().locator('.turn').first();
  await expect(turn.locator('.turn-time')).toHaveText(/^周.|^\d+月|^昨天/);
  await expect(turn.locator('.bubble-atts .att-thumb img')).toHaveAttribute('src', /^data:image\/png/);
  const g = await page.evaluate((i) => {
    const t = document.querySelector(`.column[data-col-id="${i}"] .turn`);
    const r = (s) => t.querySelector(s).getBoundingClientRect();
    const bubble = getComputedStyle(t.querySelector('.bubble'));
    return { bubble: r('.bubble'), thumb: r('.bubble-atts'), reply: r('.reply'), time: r('.turn-time'), scroll: t.getBoundingClientRect(),
      radius: parseFloat(bubble.borderTopLeftRadius), replyBg: getComputedStyle(t.querySelector('.reply')).backgroundColor };
  }, ID);
  expect(Math.abs(g.bubble.right - g.scroll.right)).toBeLessThanOrEqual(4);           // right-aligned
  expect(g.bubble.width).toBeLessThanOrEqual(g.scroll.width * 0.86);                 // capped width
  expect(g.bubble.x).toBeGreaterThan(g.reply.x + 40);
  expect(Math.abs(g.reply.x - g.scroll.x)).toBeLessThanOrEqual(4);                   // reply on the left
  expect(g.thumb.bottom).toBeLessThanOrEqual(g.bubble.y + 1);                        // image above the bubble
  expect(Math.abs((g.time.x + g.time.right) / 2 - (g.scroll.x + g.scroll.right) / 2)).toBeLessThanOrEqual(3);
  expect(g.radius).toBeGreaterThanOrEqual(14);
  expect(g.replyBg).toBe('rgba(0, 0, 0, 0)');                                          // no reply bubble
  // markdown: bold, quote, code with its language and a copy icon
  await expect(turn.locator('.reply strong').first()).toHaveText('结论：主要是间距和字体。');
  await expect(turn.locator('.reply blockquote')).toContainText('先统一间距');
  await expect(turn.locator('.code-block .code-lang')).toHaveText('css');
  await expect(turn.locator('.code-block .code-copy')).toHaveAttribute('aria-label', '复制代码');
});

test('an old turn without saved work folds to 过程 and offers the terminal', async () => {
  const turn = col().locator('.turn').first();
  const toggle = turn.locator('.proc-toggle');
  await expect(toggle).toHaveText('过程');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(turn.locator('.proc-body')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(turn.locator('.proc-empty')).toContainText('没有保存');
  await turn.locator('.proc-empty .icon-btn').click();
  await expect(page.locator('#sidePane')).toBeVisible();
  await toggle.click();
  await expect(turn.locator('.proc-body')).toBeHidden();
});

test('a saved new turn shows how long it worked, its folded work, and its cards', async () => {
  const turn = col().locator('.turn').nth(1);
  const toggle = turn.locator('.proc-toggle');
  await expect(toggle).toHaveText('处理了 18分43秒');
  await expect(turn.locator('.reply')).toBeVisible();
  await expect(turn.locator('.step')).toHaveCount(0);                                  // folded by default
  await toggle.click();
  await expect(turn.locator('.proc-more')).toHaveText('前面 2 条消息');
  await expect(turn.locator('.step')).toHaveCount(8);
  await turn.locator('.proc-more').click();
  await expect(turn.locator('.step')).toHaveCount(10);
  await expect(turn.locator('.step.tool').first()).toContainText('Read(settings.html)');
  // web preview card and its Open-in menu
  const card = turn.locator('.link-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.lc-title')).toHaveText('example.com');
  // the menu's trigger is an icon button with a label, not a word
  expect(await card.locator('.lc-open').evaluate((b) => [b.getAttribute('aria-label'), b.title, b.textContent.trim()])).toEqual(['打开方式', '打开方式', '']);
  await card.locator('.lc-open').click();
  await expect(card.locator('.lc-menu .lc-item')).toHaveText(['侧栏打开', '系统浏览器打开', '复制链接']);
  await page.keyboard.press('Escape');
  await expect(card.locator('.lc-menu')).toHaveCount(0);
  // changed files: count, totals, and the list on demand
  const edits = turn.locator('.edit-card');
  await expect(edits.locator('.lc-title')).toHaveText('改了 3 个文件');
  await expect(edits.locator('.ec-head .ec-add')).toHaveText('+259');
  await expect(edits.locator('.ec-list')).toBeHidden();
  await edits.locator('.ec-head').click();
  await expect(edits.locator('.ec-file')).toHaveCount(3);
  await expect(edits.locator('.ec-file').first()).toContainText('DESIGN-SPEC.md');
  // a .md path in the reply previews in the side pane
  await turn.locator('.reply .chat-link', { hasText: 'DESIGN-SPEC.md' }).click();
  await expect(page.locator('#sidePane .pv-md h1')).toHaveText('Design spec');
});

test('reply actions are icon buttons with labels, focus rings and room to click; copy turns into a check', async () => {
  const tools = col().locator('.turn').nth(1).locator('.msg.assistant > .msg-tools .msg-tool');
  await expect(tools).toHaveCount(3);
  const labels = await tools.evaluateAll((bs) => bs.map((b) => [b.getAttribute('aria-label'), b.title, b.textContent.trim(), b.getBoundingClientRect().width, b.getBoundingClientRect().height]));
  for (const [aria, title, text, w, h] of labels) {
    expect(aria).toBeTruthy();
    expect(title).toBe(aria);
    expect(text).toBe('');                                                             // icon only
    expect(w).toBeGreaterThanOrEqual(28); expect(h).toBeGreaterThanOrEqual(28);
  }
  expect(labels.map((l) => l[0])).toEqual(['复制回复', '分享：把这一轮的问与答复制成 Markdown', '在终端里查看']);
  // keyboard focus (Tab) shows the ring
  await tools.nth(1).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(tools.first()).toBeFocused();
  expect(await tools.first().evaluate((b) => getComputedStyle(b).outlineStyle)).toBe('solid');
  // copy and share go to an in-page spy, never the real clipboard
  const result = await page.evaluate((i) => {
    const got = [];
    const original = deckHost.clipboardWrite;
    deckHost.clipboardWrite = (t) => got.push(t);
    try {
      const bs = document.querySelectorAll(`.column[data-col-id="${i}"] .turn:nth-child(2) .msg.assistant > .msg-tools .msg-tool`);
      bs[0].click(); bs[1].click();
      return { got };
    } finally { deckHost.clipboardWrite = original; }
  }, ID);
  // the check shows once the write is confirmed (an asynchronous copy), not at the click
  await expect.poll(() => tools.first().evaluate((b) => b.querySelector('polyline')?.getAttribute('points') === '20 6 9 17 4 12' && b.classList.contains('done')), { timeout: 3000 }).toBe(true);
  expect(result.got[0]).toContain('设计包已传到 Windows');
  expect(result.got[1]).toMatch(/^\*\*我：\*\*\n\n按这个方向/);
  await expect.poll(() => tools.first().evaluate((b) => b.classList.contains('done')), { timeout: 3000 }).toBe(false);
});

test('a live turn records its finish time and work, then renders the same way', async () => {
  await col().locator('.composer textarea').click();
  await page.keyboard.type('work with tools please');
  await page.keyboard.press('Enter');
  const turn = col().locator('.turn').last();
  await expect(turn.locator('.msg.user .bubble')).toHaveText('work with tools please');
  await expect(turn.locator('.reply')).toContainText('Done with tools.', { timeout: 20000 });
  await expect(turn.locator('.reply.pending')).toHaveCount(0);
  const last = (await turnsOf()).at(-1);
  expect(last.end).toBeGreaterThanOrEqual(last.ts);
  expect(last.steps).toEqual(expect.arrayContaining(['Reading the plan first.', 'Update(notes/plan.md) ⎿ Added 12 lines, removed 3 lines', 'Bash(npm test) ⎿ 254 passing']));
  expect(last.reply).not.toContain('Bash(npm test)');
  await expect(turn.locator('.proc-toggle')).toHaveText(/^处理了 \d+秒$/);
  await expect(turn.locator('.code-block .code-lang')).toHaveText('js');
  await expect(turn.locator('.reply blockquote')).toHaveText('quoted line');
  await expect(turn.locator('.edit-card .lc-title')).toHaveText('改了 2 个文件');
  await expect(turn.locator('.link-card .lc-sub')).toHaveText('/docs/page');
  // written to disk with the new optional fields
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(path.join(profile, 'chats', ID + '.json'), 'utf8')).turns.at(-1).steps?.length || 0; } catch (_) { return 0; }
  }, { timeout: 10000 }).toBeGreaterThan(2);
  expect(errors).toEqual([]);
});

test('dark and light themes', async () => {
  await page.evaluate(() => { if (!document.getElementById('sidePane').hidden) SidePane.toggle(); });
  await expect(page.locator('#sidePane')).toBeHidden();
  const saved = col().locator('.turn').nth(1);
  const scrollTo = (n) => page.evaluate(([i, k]) => {
    const s = document.querySelector(`.column[data-col-id="${i}"] .chat-scroll`);
    s.scrollTop = k < 0 ? 0 : s.querySelectorAll('.turn')[k].offsetTop - s.offsetTop - 8;
  }, [ID, n]);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    const colors = await page.evaluate((i) => {
      const t = document.querySelectorAll(`.column[data-col-id="${i}"] .turn`)[1];
      return { bubble: getComputedStyle(t.querySelector('.bubble')).backgroundColor, text: getComputedStyle(t.querySelector('.reply')).color, page: getComputedStyle(document.body).backgroundColor };
    }, ID);
    expect(colors.bubble).not.toBe(colors.page);
    expect(colors.text).not.toBe(colors.page);
    // overview: the work folded, only the replies showing
    if (await saved.locator('.proc-body').isVisible()) await saved.locator('.proc-toggle').click();
    if (await saved.locator('.ec-list').isVisible()) await saved.locator('.ec-head').click();
    await scrollTo(-1);
    await screenshot(`chat-redesign-${theme}`);
    // the same turn with its work and changed files opened
    await saved.locator('.proc-toggle').click();
    await saved.locator('.ec-head').click();
    await scrollTo(1);
    await screenshot(`chat-redesign-${theme}-expanded`);
  }
  await page.evaluate(() => applyTheme('dark'));
});
