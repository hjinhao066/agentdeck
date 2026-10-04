const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);
let app, page, profile, captain, controlToken;
const worker = 'scroll-worker';
const col = (id) => page.locator(`.column[data-col-id="${id}"]`);
const input = (id, data) => page.evaluate(([id, data]) => window.deck.ptyInput(id, data), [id, data]);
const state = (id) => page.evaluate((id) => {
  const t = terms.get(id).term;
  return { top: t.buffer.active.viewportY, bottom: t.buffer.active.baseY, line: t.buffer.active.getLine(t.buffer.active.viewportY).translateToString(true) };
}, id);
async function request(action, to, lines, token) {
  // Exercise the real main-process capability check without
  // sending a command into (or changing the output of) the target terminal.
  const requestId = `${Date.now()}-test-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(path.join(profile, 'board-control', 'requests', requestId + '.json'), JSON.stringify({ id: requestId, token, action, to, lines }));
  const responseFile = path.join(profile, 'board-control', 'responses', requestId + '.json');
  await expect.poll(() => fs.existsSync(responseFile)).toBe(true);
  const result = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
  fs.unlinkSync(responseFile);
  return { ...result, requestId };
}
async function captainToken() {
  return controlToken;
}
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-scroll-peek-'));
  const cmd = `node "${path.join(__dirname, 'fixtures', 'scroll-agent.js')}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ fitWindow: true, fitCols: 2, columns: [{ id: worker, title: 'Scroll worker', cmd, cwd: profile, role: 'manual' }] }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect(col(worker)).toBeVisible();
  await expect.poll(() => page.evaluate((id) => terms.get(id)?.lastScreen || '', worker), { timeout: 20000 }).toContain('LIVE_ROW_0100');
  await page.locator('.nav-row[data-nav="captain"]').click();
  await page.locator('#mdCmd').fill('');
  await page.locator('#mdCwd').fill(profile);
  await page.locator('#mdCreate').click();
  captain = await page.evaluate(() => config.mainSession.colId);
  await expect.poll(() => page.evaluate((id) => !!terms.get(id), captain)).toBe(true);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), captain)).toBe(true);
  if (process.platform === 'win32') {
    await expect.poll(() => page.evaluate((id) => MainCore.isWindowsShellPrompt(dumpScreen(terms.get(id).term)), captain), { timeout: 15000 }).toBe(true);
  }
  const tokenFile = path.join(profile, 'test-token.json');
  await input(captain, `node -e "require('fs').writeFileSync(process.env.AGENTDECK_CONTROL_DIR+'/../test-token.json',JSON.stringify(process.env.AGENTDECK_CONTROL_TOKEN))"\r`);
  await expect.poll(() => fs.existsSync(tokenFile), { timeout: 15000 }).toBe(true);
  controlToken = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  expect(controlToken).toBeTruthy();
});
test.afterAll(async () => {
  if (app) await app.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('all raw terminals hold scrollback during output and input, then follow on click or bottom', async () => {
  for (const id of [worker, captain]) {
    await page.evaluate((id) => ChatUI.setMode(id, 'term'), id);
    // Real PTY output also in the Captain's shell, using only the stand-in.
    if (id === captain) {
      await input(id, `node "${path.join(__dirname, 'fixtures', 'scroll-agent.js')}"\r`);
      await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term), id)).toContain('LIVE_ROW_0100');
    }
    await page.evaluate((id) => terms.get(id).term.scrollLines(-20), id);
    const before = await state(id);
    expect(before.top).toBeLessThan(before.bottom);
    await expect(col(id).locator('.terminal-new-content')).toBeHidden();
    // Paste through xterm itself: its default scrollOnUserInput would yank
    // the view down even before the PTY emits anything.
    await page.evaluate((id) => terms.get(id).term.paste('emit 10\r'), id);
    await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term), id)).toContain('LIVE_ROW_0110');
    expect((await state(id)).top).toBe(before.top);
    expect((await state(id)).line).toBe(before.line);
    await expect(col(id).locator('.terminal-new-content')).toBeVisible();
    await col(id).locator('.terminal-new-content').click();
    await expect(col(id).locator('.terminal-new-content')).toBeHidden();
    await expect.poll(async () => { const s = await state(id); return s.bottom - s.top; }).toBe(0);
    await input(id, 'emit 5\r');
    await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term), id)).toContain('LIVE_ROW_0115');
    await expect.poll(async () => { const s = await state(id); return s.bottom - s.top; }).toBe(0);
    await page.evaluate((id) => terms.get(id).term.scrollLines(-10), id);
    await input(id, 'emit 5\r');
    await expect(col(id).locator('.terminal-new-content')).toBeVisible();
    await page.evaluate((id) => terms.get(id).term.scrollLines(10000), id);
    await expect(col(id).locator('.terminal-new-content')).toBeHidden();
    await input(id, 'emit 5\r');
    await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term), id)).toContain('LIVE_ROW_0125');
    await expect.poll(async () => { const s = await state(id); return s.bottom - s.top; }).toBe(0);
  }
});

test('new cards and receipts preserve the reading position in every chat including Captain', async () => {
  for (const id of [captain, worker]) {
    await page.evaluate((id) => {
      ChatUI.setMode(id, 'chat');
      for (let i = 0; i < 30; i++) ChatUI.addCard(id, { id: id + '-card-' + i, title: 'Task ' + i, colId: id, status: 'working' });
    }, id);
    const scroll = col(id).locator('.chat-scroll');
    await expect.poll(() => scroll.evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight)).toBeLessThan(3);
    await scroll.evaluate((s) => { s.scrollTop = 100; });
    await expect.poll(() => scroll.evaluate((s) => s.scrollTop)).toBe(100);
    // Wait for a frame so the browser delivers the actual scroll event.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate((id) => {
      ChatUI.addCard(id, { id: id + '-new', title: 'New task', colId: id, status: 'working' });
      ChatUI.updateCard(id, { id: id + '-new', title: 'New task', colId: id, status: 'done', receipt: { summary: 'A new receipt\n'.repeat(20), files: [] } });
    }, id);
    expect(await scroll.evaluate((s) => s.scrollTop)).toBe(100);
    await expect(col(id).locator('.chat-new-content')).toBeVisible();
    await col(id).locator('.chat-new-content').click();
    await expect(col(id).locator('.chat-new-content')).toBeHidden();
    await expect.poll(() => scroll.evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight)).toBeLessThan(3);
    await scroll.evaluate((s) => { s.scrollTop = 80; });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate((id) => ChatUI.addCard(id, { id: id + '-next', title: 'Next task', colId: id, status: 'working' }), id);
    await expect(col(id).locator('.chat-new-content')).toBeVisible();
    await scroll.evaluate((s) => { s.scrollTop = s.scrollHeight; });
    await expect(col(id).locator('.chat-new-content')).toBeHidden();
    await page.evaluate((id) => ChatUI.addCard(id, { id: id + '-following', title: 'Following task', colId: id, status: 'working' }), id);
    await expect.poll(() => scroll.evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight)).toBeLessThan(3);
  }
});

test('the copied peek CLI returns fresh ANSI-free rows without moving or writing the target', async () => {
  await page.evaluate((id) => { ChatUI.setMode(id, 'term'); terms.get(id).term.scrollLines(-20); }, worker);
  const before = await state(worker);
  const token = await captainToken();
  const env = { ...process.env, AGENTDECK_CONTROL_DIR: path.join(profile, 'board-control'), AGENTDECK_CONTROL_TOKEN: token };
  const cli = path.join(profile, 'board-control', 'tools', 'agentdeck-board.js');
  const peek = (args) => execute(process.execPath, [cli, 'peek', '--id', worker, ...args], { env });
  const { stdout } = await peek(['--lines', '3']);
  expect(stdout.trim().split('\n')).toEqual(['LIVE_ROW_0123', 'LIVE_ROW_0124', 'LIVE_ROW_0125']);
  expect(stdout).not.toContain('\x1b');
  expect(await state(worker)).toEqual(before);
  const focused = await page.evaluate(() => focusedId);
  await input(worker, 'emit 2\r');
  await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term), worker)).toContain('LIVE_ROW_0127');
  const latest = await peek([]);
  expect(latest.stdout.trim().split('\n')).toHaveLength(40);
  expect(latest.stdout).toContain('LIVE_ROW_0127');
  expect((await state(worker)).top).toBe(before.top);
  expect(await page.evaluate(() => focusedId)).toBe(focused);
  const result = await request('main-peek', worker, 3, token);
  expect(result.result).toContain('LIVE_ROW_0127');
  expect(await page.evaluate((id) => config.boardResponses[id], result.requestId)).toBeUndefined();
  await input(worker, 'alt\r');
  await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term), worker)).toContain('ALTERNATE_LIVE_SCREEN');
  // ConPTY converts the child's alternate screen into screen redraws instead
  // of forwarding its buffer-switch sequence. Exercise xterm's alternate
  // buffer explicitly as well, so peek's live-buffer assertion stays universal.
  await page.evaluate((id) => new Promise((resolve) => terms.get(id).term.write('\x1b[?1049h\x1b[2J\x1b[HALTERNATE_LIVE_SCREEN\r\n', resolve)), worker);
  await expect.poll(() => page.evaluate((id) => terms.get(id).term.buffer.active.type, worker)).toBe('alternate');
  expect((await peek([])).stdout.trim()).toBe('ALTERNATE_LIVE_SCREEN');
  await input(worker, 'normal\r');
  await page.evaluate((id) => new Promise((resolve) => terms.get(id).term.write('\x1b[?1049l', resolve)), worker);
  await expect.poll(() => page.evaluate((id) => terms.get(id).term.buffer.active.type, worker)).toBe('normal');
  await input(worker, 'emit 900\r');
  await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term), worker)).toContain('LIVE_ROW_1027');
  const many = await peek(['--lines', '1000']);
  expect(many.stdout.trim().split('\n')).toHaveLength(1000);
  expect(many.stdout.length).toBeGreaterThan(12000);
  expect(many.stdout).toContain('LIVE_ROW_1027');
});

test('new prompts and completed replies leave older chat content in place', async () => {
  for (const id of [captain, worker]) {
    await page.evaluate((id) => ChatUI.setMode(id, 'chat'), id);
    const scroll = col(id).locator('.chat-scroll');
    await scroll.evaluate((s) => { s.scrollTop = 100; });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const turnId = await page.evaluate(async (id) => {
      const turn = await ChatUI.sendPrompt(columns.find((c) => c.id === id), 'emit 3');
      return turn.id;
    }, id);
    expect(await scroll.evaluate((s) => s.scrollTop)).toBe(100);
    await expect(col(id).locator('.chat-new-content')).toBeVisible();
    await expect.poll(() => page.evaluate(([id, turnId]) => ChatUI.turnsOf(id).find((t) => t.id === turnId)?.done, [id, turnId]), { timeout: 15000 }).toBe(true);
    expect(await scroll.evaluate((s) => s.scrollTop)).toBe(100);
    await expect(col(id).locator('.chat-new-content')).toBeVisible();
  }
});

test('peek rejects unauthenticated, non-Captain, unknown, archived, exited and malformed requests', async () => {
  const token = await captainToken();
  expect((await request('main-peek', worker, 40, 'bad-token')).error).toContain('rejected');
  const rejected = await page.evaluate(async (id) => {
    try { await MainSession.handle({ action: 'main-peek', to: id, lines: 40 }, columns.find((c) => c.id === id)); }
    catch (err) { return err.message; }
  }, worker);
  expect(rejected).toContain('只有队长');
  expect((await request('main-peek', 'missing', 40, token)).error).toContain('找不到');
  await page.evaluate(() => config.archived.push({ id: 'archived-peek', title: 'Archived', role: 'manual' }));
  expect((await request('main-peek', 'archived-peek', 40, token)).error).toContain('不会恢复');
  expect(await page.evaluate(() => terms.has('archived-peek'))).toBe(false);
  expect((await request('main-peek', worker, 0, token)).error).toContain('1–1000');
  await page.evaluate((id) => { terms.get(id).alive = false; }, worker);
  expect((await request('main-peek', worker, 40, token)).error).toContain('已退出');
  await page.evaluate((id) => { terms.get(id).alive = true; }, worker);
});
