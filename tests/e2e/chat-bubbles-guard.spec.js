const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Guard for the ChatGPT-style chat page surviving later merges: in the 队长
// column AND an ordinary 队员 column, your message must sit on the right
// edge in a bubble and the agent's reply on the left edge, in dark and light.
// Reached through the real global toggle button, like the user does.
// Set AGENTDECK_CHAT_SHOTS to a folder to keep the PNGs.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_CHAT_SHOTS;
const COLS = [{ id: 'cb-cap', title: '队长', isMain: true }, { id: 'cb-crew', title: '队员 · 对话页修复' }];
let application, page, profile;
const errors = [];
test.describe.configure({ mode: 'serial' });

const LONG = '请把对话页修好：我发的消息要靠右、带一个气泡，AI 的回复要靠左、不要气泡。' +
  '这一条故意写得很长，用来确认长消息在气泡里依然能读：换行不会把气泡撑出列外，' +
  '点一下可以展开，再点一下收起。'.repeat(5);

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-chat-bubbles-'));
  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  const now = Date.now();
  for (const c of COLS) {
    fs.writeFileSync(path.join(profile, 'chats', c.id + '.json'), JSON.stringify({ v: 1, id: c.id, turns: [
      { id: c.id + '-1', ts: now - 3600_000, end: now - 3500_000, user: LONG, atts: [], done: true,
        reply: '收到，先说结论：**两边都靠 `.msg.user` 的 `align-self: flex-end` 对齐**。\n\n1. 我的消息一个气泡，靠右。\n2. 回复不带气泡，靠左，整段可选中。\n3. 每一轮顶上居中显示时间。\n\n> 之后任何合并冲突都不能把这几条覆盖掉。' },
      { id: c.id + '-2', ts: now - 600_000, end: now - 540_000, user: '再确认一下浅色主题。', atts: [], done: true,
        reply: '浅色主题下气泡是浅灰底，回复仍是纯文字。\n\n两种主题都已核对，对齐位置一致。' },
    ] }));
  }
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: COLS.map((c) => ({ ...c, cmd: FAKE, cwd: profile, width: 640, role: 'manual' })),
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 900 });
  await expect.poll(() => page.evaluate((ids) => typeof terms !== 'undefined' && ids.every((i) => terms.has(i)), COLS.map((c) => c.id)), { timeout: 20000 }).toBe(true);
  await page.evaluate(() => { if (!document.getElementById('sidePane').hidden) SidePane.toggle(); });
  await page.locator('#globalViewToggle').click();
  for (const c of COLS) await expect(page.locator(`.column[data-col-id="${c.id}"]`)).toHaveClass(/chat-mode/);
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const geometry = (id) => page.evaluate((i) => {
  const scroll = document.querySelector(`.column[data-col-id="${i}"] .chat-scroll`);
  const turn = scroll.querySelector('.turn');
  const box = (s) => { const r = turn.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width }; };
  const s = scroll.getBoundingClientRect();
  return { scroll: { l: s.left, r: s.right }, bubble: box('.msg.user .bubble'), reply: box('.reply'), time: box('.turn-time'),
    bubbleBg: getComputedStyle(turn.querySelector('.bubble')).backgroundColor, replyBg: getComputedStyle(turn.querySelector('.reply')).backgroundColor,
    page: getComputedStyle(document.body).backgroundColor };
}, id);

for (const theme of ['dark', 'light']) {
  for (const c of COLS) {
    test(`${c.title}: your message is on the right in a bubble, the reply on the left (${theme})`, async () => {
      await page.evaluate((t) => applyTheme(t), theme);
      const g = await geometry(c.id);
      // the bubble hugs the right edge, the reply starts at the left edge
      expect(g.scroll.r - g.bubble.r).toBeLessThan(40);
      expect(g.reply.l - g.scroll.l).toBeLessThan(40);
      expect(g.bubble.l).toBeGreaterThan(g.reply.l + 60);
      expect(g.bubble.w).toBeLessThan(g.reply.w);
      // a long message wraps inside the bubble instead of widening it past the column
      expect(g.bubble.r).toBeLessThanOrEqual(g.scroll.r);
      expect(g.bubble.w).toBeLessThanOrEqual(640);
      // only the user's message is a bubble
      expect(g.bubbleBg).not.toBe(g.page);
      expect(g.replyBg).toBe('rgba(0, 0, 0, 0)');
      // each turn shows its time above, centred
      await expect(page.locator(`.column[data-col-id="${c.id}"] .turn-time`).first()).toBeVisible();
      expect(Math.abs((g.time.l + g.time.r) / 2 - (g.scroll.l + g.scroll.r) / 2)).toBeLessThan(20);
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `chat-${theme}.png`), animations: 'disabled' });
      }
    });
  }
}

test('no page errors', () => { expect(errors).toEqual([]); });
