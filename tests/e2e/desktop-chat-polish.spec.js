const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const captain = require('../fixtures/captain-chat');

// The desktop 队长 page reads like a chat: only what 队长 said to you (terminal
// residue taken out with the phone hub's rules), its titles, lists and tables
// set properly in a reading column, each reply under 队长's name, and the
// dispatch cards between two messages folded into one line. Real renderer,
// isolated userData, stand-in TUI; the conversation is tests/fixtures/captain-chat.js.
// Set AGENTDECK_CHAT_SHOTS to a folder to keep dark/light PNGs at 1920×1080 and 1440×900.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_CHAT_SHOTS;
const ID = 'captain', WORKER = 'polish-worker', SHELL = 'polish-shell';
let application, page, profile;
const errors = [];
test.describe.configure({ mode: 'serial' });

const col = (id = ID) => page.locator(`.column[data-col-id="${id}"]`);
const turn = (id) => col().locator(`.msg.assistant[data-turn="${id}"]`);
const shownText = () => col().locator('.chat-scroll').evaluate((s) => s.innerText);
// Playwright's pointer goes to a corner: nothing under it is left hovered.
const park = async () => { const size = page.viewportSize(); await page.mouse.move(size.width - 3, 3); };

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-chat-polish-'));
  const now = Date.now();
  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'chats', ID + '.json'), JSON.stringify({ v: 1, id: ID, turns: captain.turns(now) }));
  const residue = { id: 'w1', ts: now - 3600_000, end: now - 3590_000, user: '跑一下测试', done: true, atts: [],
    reply: '❯ 跑一下测试\n\nRan 2 shell commands\n\n测试都过了。\n\n小结\n\n- 单测 12 项\n  全部通过\n- 没有新的失败' };
  fs.writeFileSync(path.join(profile, 'chats', WORKER + '.json'), JSON.stringify({ v: 1, id: WORKER, turns: [residue] }));
  // a plain shell's output is not an agent's reply: nothing is taken out of it
  fs.writeFileSync(path.join(profile, 'chats', SHELL + '.json'), JSON.stringify({ v: 1, id: SHELL, turns: [{ ...residue, id: 's1', user: 'ls', reply: '❯ ls\nRan 2 shell commands' }] }));
  const column = (id, title, more) => ({ id, title, displayTitle: title, manualTitle: true, cwd: profile, width: 760, role: 'manual', view: 'chat', ...more });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, globalViewMode: 'chat', perpetualCaptain: { enabled: false }, resumeOnRestart: false,
    // the other two are 队长's background sessions: off the deck, so 队长's column has the whole width as it does in use
    columns: [column(ID, '队长', { cmd: FAKE + ' --captain-statusline', isMain: true }), column(WORKER, '队员', { cmd: FAKE, captainCrew: true }), column(SHELL, '终端', { cmd: '', captainCrew: true })],
    mainSession: { colId: ID, cmd: FAKE + ' --captain-statusline', gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks: [] },
  }));
  const env = { ...process.env, ZDOTDIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate((ids) => typeof terms !== 'undefined' && ids.every((i) => terms.has(i)), [ID, WORKER, SHELL]), { timeout: 30000 }).toBe(true);
  // jumping to a column shows its terminal (the default view): go there first, then open the chat
  await page.evaluate((i) => jumpToColumn(columns.find((c) => c.id === i)), ID);
  await page.evaluate(() => columns.forEach((c) => ChatUI.setMode(c.id, 'chat')));
  await expect(col().locator('.msg.assistant .reply.md').first()).toBeVisible();
  await park();
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('only what 队长 said is shown: no prompt echo, diff tail, tool summary, scroll hint or rating prompt', async () => {
  const text = await shownText();
  for (const gone of ['❯', '(click) ↓', 'Ran 1 shell command', 'Background command', 'How is Claude doing', '1: Bad', '卡在哪', '交付状态', '用户未反对', '+已归档', '本次处理已结束'])
    expect(text, gone).not.toContain(gone);
  // every reply still begins and ends with 队长's own sentences
  await expect(turn('f-why').locator('.reply')).toContainText('已按你说的换人');
  await expect(turn('f-why').locator('.reply li').last()).toHaveText('任务看板视觉重做：会话没交回执就结束了，要重派。');
  await expect(turn('f-bug').locator('.reply p').first()).toHaveText('你说得对，这是严重 bug，三件事都已经派出去了，现在 3 个会话在干活。');
  await expect(turn('f-steps').locator('.reply p').first()).toContainText('你说得对，不需要等你回家。');
  await expect(turn('f-table').locator('.reply p').first()).toHaveText('那边尤其靠它。按你说的交给 Sonnet 5.5：');
  // a receipt delivery that left only residue is not a turn to read
  await expect(col().locator('.turn[hidden]:not(.task-turn)')).toHaveCount(1);
  await expect(col().locator('.msg.assistant[data-turn="f-quiet"]')).toBeHidden();
  await expect(col().locator('.reply.quiet')).toHaveCount(1);                       // only inside that hidden turn
  // copy and share carry the same clean text; the saved reply is untouched
  const got = await page.evaluate((i) => {
    const out = [], original = deckHost.clipboardWrite;
    deckHost.clipboardWrite = (t) => out.push(t);
    try { document.querySelectorAll(`.column[data-col-id="${i}"] .msg.assistant[data-turn="f-steps"] > .msg-tools .msg-tool`).forEach((b, n) => { if (n < 2) b.click(); }); }
    finally { deckHost.clipboardWrite = original; }
    return { out, saved: ChatUI.turnsOf(i).find((t) => t.id === 'f-steps').reply };
  }, ID);
  expect(got.out[0]).toMatch(/^你说得对，不需要等你回家。[\s\S]*失败自动回滚。$/);
  expect(got.out[1]).toContain('**回复：**\n\n你说得对，不需要等你回家。');
  expect(got.out[1]).not.toContain('How is Claude doing');
  expect(got.saved).toBe(captain.STEPS);
});

test('an agent column is cleaned the same way; a plain shell is shown as it is', async () => {
  const worker = col(WORKER).locator('.msg.assistant .reply');
  await expect(worker.locator('p').first()).toHaveText('测试都过了。');
  await expect(worker.locator('h3')).toHaveText('小结');
  await expect(worker.locator('li')).toHaveText(['单测 12 项全部通过', '没有新的失败']);
  await expect(worker).not.toContainText('Ran 2 shell commands');
  await expect(col(WORKER).locator('.reply-who:not(.captain) .who-name')).toHaveText('node');
  await expect(col(SHELL).locator('.msg.assistant .reply')).toContainText('❯ ls');
  await expect(col(SHELL).locator('.msg.assistant .reply')).toContainText('Ran 2 shell commands');
  await expect(col(SHELL).locator('.reply-who .who-name')).toHaveText('终端');
});

test('every reply stands under 队长\'s name and crest, apart from your bubbles, inside one reading column', async () => {
  const who = turn('f-progress').locator('.reply-who.captain');
  await expect(who.locator('.who-name')).toHaveText('队长');
  await expect(who.locator('.who-mark svg')).toHaveCount(1);
  await expect(col().locator('.msg.assistant:not([data-turn="f-quiet"]) .reply-who.captain')).toHaveCount(6);
  await turn('f-progress').scrollIntoViewIfNeeded();
  const g = await page.evaluate((i) => {
    const c = document.querySelector(`.column[data-col-id="${i}"]`);
    const asst = c.querySelector('.msg.assistant[data-turn="f-progress"]'), t = asst.closest('.turn');
    const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
    const mark = getComputedStyle(asst.querySelector('.who-mark'));
    return { scroll: r(c.querySelector('.chat-scroll')), turn: r(t), who: r(asst.querySelector('.reply-who')), toggle: r(asst.querySelector('.proc-toggle')),
      reply: r(asst.querySelector('.reply')), bubble: r(t.querySelector('.bubble')), composer: r(c.querySelector('.composer-box')), footer: c.querySelector('.tui-footer'),
      markBg: mark.backgroundImage, replyBg: getComputedStyle(asst.querySelector('.reply')).backgroundColor, size: parseFloat(getComputedStyle(asst.querySelector('.reply')).fontSize) };
  }, ID);
  // the name and "处理了 …" share one line over the reply; the crest is 队长's purple
  expect(Math.abs((g.who.y + g.who.h / 2) - (g.toggle.y + g.toggle.h / 2))).toBeLessThanOrEqual(2);
  expect(g.toggle.x).toBeGreaterThanOrEqual(g.who.right);
  expect(g.who.bottom).toBeLessThanOrEqual(g.reply.y);
  expect(g.markBg).toContain('linear-gradient');
  // you on the right in a bubble, 队长 on the left as text
  expect(Math.abs(g.bubble.right - g.turn.right)).toBeLessThanOrEqual(4);
  expect(Math.abs(g.reply.x - g.turn.x)).toBeLessThanOrEqual(4);
  expect(g.replyBg).toBe('rgba(0, 0, 0, 0)');
  // a centred reading column: 50 to 62 full-width characters to a line, not the whole 1188px
  expect(g.turn.w / g.size).toBeGreaterThanOrEqual(50);
  expect(g.turn.w / g.size).toBeLessThanOrEqual(62);
  expect(Math.abs((g.turn.x - g.scroll.x) - (g.scroll.right - g.turn.right))).toBeLessThanOrEqual(12);     // the scrollbar's width
  // the composer box stands on the column's own two edges: the reply's left, your bubble's right
  expect(Math.abs(g.composer.x - g.reply.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(g.composer.right - g.bubble.right)).toBeLessThanOrEqual(1);
});

// The air beside the reading column. It depends on the pane's own width, whatever
// took the room (a slim window, the sidebar, the right pane): 20px in a slim pane,
// about twice what 1.2.4 left at the width 队长 is usually read at, 56px from there
// up, and the rest of a wide pane once the column has its measure.
test('the air beside the column grows with the pane, is the same on both sides, and never squeezes a slim one', async () => {
  const measure = async (width, pane) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((open) => { if (!config.navCollapsed) setNavCollapsed(true); if (SidePane.isOpen() !== open) SidePane.toggle(); }, pane);
    await park();
    await turn('f-late').scrollIntoViewIfNeeded();
    return page.evaluate((i) => {
      const c = document.querySelector(`.column[data-col-id="${i}"]`), box = c.querySelector('.chat').getBoundingClientRect();
      const r = (sel) => c.querySelector(sel).getBoundingClientRect();
      const reply = r('.msg.assistant[data-turn="f-late"] .reply'), bubble = r('.msg.user[data-turn="f-late"] .bubble'), composer = r('.composer-box'), status = r('.tui-footer .tf-row');
      return { pane: box.width, left: reply.x - box.x, right: box.right - bubble.right, text: reply.width, bubble: bubble.width,
        composer: [composer.x - box.x, box.right - composer.right], status: status.x - box.x };
    }, ID);
  };
  await expect(col().locator('.tui-footer .tf-row').first()).toBeVisible({ timeout: 15000 });      // read from the terminal on the status tick
  const side = await page.evaluate(() => { SidePane.show('preview'); const w = document.getElementById('sidePane').getBoundingClientRect().width; SidePane.hide(); return w; });
  const seen = {};
  for (const [name, width, pane] of [['wide', 1440, false], ['usual', 830, false], ['usual beside the right pane', 830 + side, true], ['slim', 600 + side, true], ['slimmest', 400 + side, true]]) {
    const g = seen[name] = await measure(width, pane);
    // one left edge for the reply, the composer box and the status lines; one right edge for your bubble and the box
    expect(Math.abs(g.left - g.right), name).toBeLessThanOrEqual(1.5);
    expect(Math.abs(g.composer[0] - g.left), name).toBeLessThanOrEqual(1);
    expect(Math.abs(g.composer[1] - g.right), name).toBeLessThanOrEqual(1);
    expect(Math.abs(g.status - g.left), name).toBeLessThanOrEqual(1);
    expect(g.left, name).toBeGreaterThanOrEqual(19.5);
    // the gutters never take more than 56px a side from the text unless the column already has its measure
    expect(g.text, name).toBeGreaterThanOrEqual(Math.min(780, g.pane - 2 * 56) - 1.5);
    expect(g.bubble, name).toBeLessThanOrEqual(g.text + 1);
  }
  expect(Math.abs(seen.wide.text - 780)).toBeLessThanOrEqual(1.5);
  expect(seen.wide.left).toBeGreaterThan(300);
  // 1.2.4 left 25px here
  expect(seen.usual.left).toBeGreaterThanOrEqual(48);
  expect(seen.usual.left).toBeLessThanOrEqual(56.5);
  expect(Math.abs(seen['usual beside the right pane'].left - seen.usual.left)).toBeLessThanOrEqual(1.5);
  expect(seen.slim.left).toBeGreaterThan(seen.slimmest.left);
  expect(seen.slim.left).toBeLessThan(seen.usual.left);
  expect(seen.slimmest.left).toBeLessThanOrEqual(21);
  // a slim pane keeps what it had: your bubble may take the whole column there
  expect(seen.slimmest.text).toBeGreaterThanOrEqual(seen.slimmest.pane - 42);
  expect(seen.wide.bubble).toBeLessThanOrEqual(600.5);
  await page.evaluate(() => { if (SidePane.isOpen()) SidePane.hide(); setNavCollapsed(false); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await park();
});

test('a message sent while 队长 was busy: the end of its echo is not shown as 队长\'s reply', async () => {
  const reply = turn('f-late').locator('.reply');
  await turn('f-late').scrollIntoViewIfNeeded();
  await expect(reply.locator('> :first-child')).toHaveText('先更正一处');
  await expect(reply).not.toContainText('印象里是有的');
  await expect(reply.locator('h3')).toHaveText(['先更正一处', '课程资料和课前预习', '发到阅读器']);
  // your own bubble still holds the whole message, and the saved reply is as it was read
  expect(await col().locator('.msg.user[data-turn="f-late"] .bubble').evaluate((b) => b.textContent)).toBe(captain.LATE);
  const got = await page.evaluate((i) => {
    const out = [], original = deckHost.clipboardWrite;
    deckHost.clipboardWrite = (t) => out.push(t);
    try { document.querySelector(`.column[data-col-id="${i}"] .msg.assistant[data-turn="f-late"] > .msg-tools .msg-tool`).click(); }
    finally { deckHost.clipboardWrite = original; }
    return { out, saved: ChatUI.turnsOf(i).find((t) => t.id === 'f-late').reply };
  }, ID);
  expect(got.out[0]).toMatch(/^先更正一处[\s\S]*格式定下来就派。$/);
  expect(got.saved.startsWith(captain.LATE_TAIL)).toBe(true);
});

test('titles, nested lists, numbered steps, tables and paths are set as what they are', async () => {
  const why = turn('f-why').locator('.reply');
  await expect(why.locator('h3')).toHaveText(['为什么一晚上没更新到 1.2', '昨晚 21:00 到凌晨 4:00 做完的活（约 55 张卡）', '没做成的']);
  await expect(why.locator('> ul > li > ul > li')).toHaveText(['重启后旧回执重发', '派活前看额度自动换模型', '看板拖到“进行中”自动开会话', '自动验收闭环']);
  const steps = turn('f-steps').locator('.reply ol > li');
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(1)).toContainText('Mac 先装带多机支持的新版');
  const progress = turn('f-progress').locator('.reply');
  await expect(progress.locator('th')).toHaveText(['版本', 'Mac', 'Windows', '手机网页', '主要内容']);
  await expect(progress.locator('tbody tr')).toHaveCount(3);
  await expect(progress.locator('tbody tr').nth(2).locator('td')).toHaveText(['1.2.2', '15:20 装上', '还没升', '已上线', 'Relay 交接重构、看板星图外观、“指令送不进去”修复']);
  await expect(turn('f-table').locator('.reply tbody tr')).toHaveCount(3);
  await expect(turn('f-table').locator('.reply .chat-link.path')).toHaveText('/Users/me/reports/agentdeck-ui-batch/report.md');
  await progress.scrollIntoViewIfNeeded();
  const g = await progress.evaluate((reply) => {
    const px = (e, k) => parseFloat(getComputedStyle(e)[k]);
    const [h1, h2] = reply.querySelectorAll('h3'), p = reply.querySelector('p'), li = reply.querySelector('li'), wrap = reply.querySelector('.md-table');
    const nested = document.querySelector('.msg.assistant[data-turn="f-why"] .reply li li');
    return { title: [px(h1, 'fontWeight'), px(h1, 'fontSize')], body: [px(p, 'fontWeight'), px(p, 'fontSize'), px(p, 'lineHeight')],
      above: px(h2, 'marginTop'), below: px(h2, 'marginBottom'), item: px(li, 'marginTop'), para: px(p, 'marginBottom'),
      table: [wrap.scrollWidth, wrap.clientWidth, wrap.getBoundingClientRect().right, reply.getBoundingClientRect().right],
      indent: nested.getBoundingClientRect().x - nested.parentElement.closest('li').getBoundingClientRect().x,
      mono: getComputedStyle(document.querySelector('.reply .chat-link.path')).fontFamily };
  });
  // a title is heavier than the text and has more air above it than under it
  expect(g.title[0]).toBeGreaterThanOrEqual(600);
  expect(g.title[1]).toBeGreaterThanOrEqual(g.body[1]);
  expect(g.above).toBeGreaterThanOrEqual(g.below * 2);
  // room between the lines, less between items than between paragraphs
  expect(g.body[2] / g.body[1]).toBeGreaterThanOrEqual(1.65);
  expect(g.item).toBeGreaterThan(0);
  expect(g.item).toBeLessThan(g.para);
  // the table fits the reading column without scrolling sideways; a nested list steps in
  expect(g.table[0]).toBeLessThanOrEqual(g.table[1] + 1);
  expect(g.table[2]).toBeLessThanOrEqual(g.table[3] + 1);
  expect(g.indent).toBeGreaterThanOrEqual(16);
  expect(g.mono).toMatch(/mono|Menlo|Consolas/i);
});

test('the dispatch cards between two messages fold into one line that says how they stand', async () => {
  const lines = col().locator('.chat-scroll > .task-run');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0)).toHaveText(/派活与回执\s*3 条\s*1 没做成\s*2 完成/);
  await expect(lines.nth(1)).toHaveText(/派活与回执\s*1 条\s*1 完成/);
  await expect(lines.nth(2)).toHaveText(/派活与回执\s*2 条\s*2 进行中/);
  // folded: the cards are there (still direct children of the list) but not shown
  await expect(col().locator('.chat-scroll > .turn.task-turn .task-card')).toHaveCount(6);
  await expect(col().locator('.task-card:visible')).toHaveCount(0);
  await expect(lines.nth(0)).toHaveAttribute('aria-expanded', 'false');
  await expect(lines.nth(0)).toHaveAttribute('title', '展开派活与回执');
  // keyboard: focus, Enter opens only this run
  await lines.nth(0).focus();
  expect(await lines.nth(0).evaluate((b) => b.matches(':focus-visible') ? getComputedStyle(b).outlineStyle : 'solid')).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(lines.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(lines.nth(0)).toBeFocused();
  await expect(col().locator('.task-card:visible')).toHaveCount(3);
  await expect(col().locator('.task-card:visible .task-summary').nth(1)).toHaveText('后来又给这个会话发了新指令，结果看后面的卡片。');
  await lines.nth(0).click();
  await expect(col().locator('.task-card:visible')).toHaveCount(0);
  // a receipt coming in and a new card change the line, folded or not
  await page.evaluate((i) => {
    ChatUI.updateCard(i, { id: 'k-radar', colId: 'gone', title: 'Schedule 里看竞品雷达结果并直接审核（Opus·US2）', status: 'done', sentAt: Date.now(),
      receipt: { summary: '做完了，截图在报告里。', files: [], images: [], failed: '', explicit: true, source: 'command' } });
    ChatUI.addCard(i, { id: 'k-new', colId: 'gone', title: '新派的一件事', status: 'working', sentAt: Date.now(), receipt: null });
  }, ID);
  await expect(lines.nth(2)).toHaveText(/派活与回执\s*3 条\s*2 进行中\s*1 完成/);
  await expect(col().locator('.task-card:visible')).toHaveCount(0);
  // a search hit on a folded card opens its run and shows the card
  await page.evaluate((i) => ChatUI.reveal(i, 'k-doc', 'user'), ID);
  await expect(col().locator('.task-card', { hasText: '双机说明文档' })).toBeVisible();
  await expect(lines.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await lines.nth(0).click();
});

test('a long message of yours is clipped with a fade and an icon button that opens the rest', async () => {
  const mine = col().locator('.msg.user[data-turn="f-bug"]');
  await mine.scrollIntoViewIfNeeded();
  await expect(mine).toHaveClass(/clipped/);
  const more = mine.locator('.bubble-more');
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute('aria-label', '展开全文');
  await expect(more).toHaveAttribute('title', '展开全文');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  expect(await more.evaluate((b) => [b.textContent.trim(), b.getBoundingClientRect().width >= 28, b.getBoundingClientRect().height >= 28])).toEqual(['', true, true]);
  const clipped = await mine.locator('.bubble').evaluate((b) => [b.scrollHeight > b.clientHeight, getComputedStyle(b).maskImage || getComputedStyle(b).webkitMaskImage]);
  expect(clipped[0]).toBe(true);
  expect(clipped[1]).toContain('linear-gradient');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(mine).toHaveClass(/expanded/);
  await expect(more).toHaveAttribute('aria-label', '收起');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  expect(await mine.locator('.bubble').evaluate((b) => getComputedStyle(b).maskImage || getComputedStyle(b).webkitMaskImage)).toBe('none');
  await more.click();
  await expect(mine).not.toHaveClass(/expanded/);
  // a short message has no such control
  await expect(col().locator('.msg.user[data-turn="f-progress"] .bubble-more')).toBeHidden();
});

// Text that does not fit wraps; nothing is cut with an ellipsis, spills out of
// the column or lands on top of its neighbour. Runs are opened so the cards count too.
async function layoutFaults() {
  return page.evaluate((i) => {
    const c = document.querySelector(`.column[data-col-id="${i}"]`), scroll = c.querySelector('.chat-scroll');
    const box = scroll.getBoundingClientRect(), faults = [];
    const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().replace(/\s+/g, '.') : '') + ' "' + e.textContent.trim().slice(0, 16) + '"';
    if (scroll.scrollWidth > scroll.clientWidth + 1) faults.push('the list scrolls sideways');
    for (const e of scroll.querySelectorAll('*')) {
      if (!e.getClientRects().length || e.closest('svg, pre') || e.closest('[hidden]')) continue;
      const style = getComputedStyle(e), r = e.getBoundingClientRect();
      if (style.textOverflow === 'ellipsis') faults.push('ellipsis: ' + name(e));
      // a table too wide for a narrow column scrolls inside its own frame; your own long message is clipped by height only
      const scrolls = e.classList.contains('md-table') || e.closest('.md-table table');
      if (!scrolls && style.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1) faults.push('cut: ' + name(e));
      if (!e.closest('.md-table') && (r.right > box.right + 1 || r.x < box.x - 1)) faults.push('outside the column: ' + name(e));
    }
    // neighbours on one line do not overlap
    for (const row of scroll.querySelectorAll('.reply-head, .task-run, .task-head, .msg-tools')) {
      if (!row.getClientRects().length) continue;
      const kids = [...row.children].filter((k) => k.getClientRects().length && getComputedStyle(k).display !== 'contents').flatMap((k) => k.classList.contains('proc') ? [...k.children] : [k]).map((k) => k.getBoundingClientRect());
      kids.forEach((a, n) => kids.slice(n + 1).forEach((b) => {
        if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) faults.push('overlap in ' + name(row));
      }));
    }
    return faults;
  }, ID);
}

test('at any width, in both themes, nothing is cut, overlapping or outside the column, and the text reads clearly', async () => {
  await page.evaluate((i) => document.querySelectorAll(`.column[data-col-id="${i}"] .task-run[aria-expanded="false"]`).forEach((b) => b.click()), ID);
  await expect(col().locator('.task-card:visible')).toHaveCount(7);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    for (const [width, height] of [[1920, 1080], [1440, 900], [1180, 800], [900, 700], [700, 700]]) {
      await page.setViewportSize({ width, height });
      await park();
      await expect.poll(layoutFaults, { timeout: 5000, message: `${theme} ${width}px` }).toEqual([]);
    }
    // contrast against the page: body text, a title, the quiet labels
    const ratios = await page.evaluate((i) => {
      const c = document.querySelector(`.column[data-col-id="${i}"]`);
      const rgb = (v) => v.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((s, x, n) => s + x * [0.2126, 0.7152, 0.0722][n], 0);
      const bg = lum(rgb(getComputedStyle(c.querySelector('.chat-scroll')).backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : getComputedStyle(c.querySelector('.chat-scroll')).backgroundColor));
      const ratio = (sel) => { const l = lum(rgb(getComputedStyle(c.querySelector(sel)).color)); return (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05); };
      return { text: ratio('.reply.md p'), title: ratio('.reply.md h3'), who: ratio('.reply-who .who-name'), quiet: ratio('.proc-toggle'), line: ratio('.task-run .run-count') };
    }, ID);
    expect(ratios.text, theme).toBeGreaterThanOrEqual(10);
    expect(ratios.title, theme).toBeGreaterThanOrEqual(10);
    expect(ratios.who, theme).toBeGreaterThanOrEqual(10);
    expect(ratios.quiet, theme).toBeGreaterThanOrEqual(4);
    expect(ratios.line, theme).toBeGreaterThanOrEqual(4);
  }
  await page.evaluate((i) => document.querySelectorAll(`.column[data-col-id="${i}"] .task-run[aria-expanded="true"]`).forEach((b) => b.click()), ID);
  await page.evaluate(() => applyTheme('dark'));
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(errors).toEqual([]);
});

test('screenshots: 1920×1080 and 1440×900, dark and light', async () => {
  test.skip(!shots, 'set AGENTDECK_CHAT_SHOTS to keep screenshots');
  fs.mkdirSync(shots, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    for (const [width, height] of [[1920, 1080], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      for (const id of ['f-why', 'f-bug', 'f-steps', 'f-table', 'f-progress']) {
        await page.evaluate(([i, t]) => {
          const s = document.querySelector(`.column[data-col-id="${i}"] .chat-scroll`);
          s.scrollTop += s.querySelector(`.msg.user[data-turn="${t}"]`).closest('.turn').getBoundingClientRect().top - s.getBoundingClientRect().top - 12;
        }, [ID, id]);
        await park();
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(shots, `fixture-${width}x${height}-${theme}-${id.slice(2)}.png`), animations: 'disabled', scale: 'css' });
      }
    }
  }
  await page.evaluate(() => applyTheme('dark'));
});
