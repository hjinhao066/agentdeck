const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// File paths printed in a terminal and written in a chat reply are links that
// end where the path ends: at Chinese punctuation, a full-width character or
// the space before Chinese prose. Two paths on one line are two links, and a
// click opens the file it shows. Real files in a temporary folder (one under
// a folder whose name holds a space), the platform's own separators, isolated
// profile. Screenshots of the hovered terminal link and the chat replies are
// kept in the test's output folder.
const ROOT = path.resolve(__dirname, '../..');
const PRINT = path.join(__dirname, 'fixtures', 'print-lines.js');
const TERM = 'links-term', CHAT = 'links-chat';
let application, page, profile, files, LINES, WANT;

const col = (id) => page.locator(`.column[data-col-id="${id}"]`);
const park = async () => { const size = page.viewportSize(); await page.mouse.move(size.width - 3, 3); };

test.beforeAll(async () => {
  // short folder names: every line fits on one terminal row on both systems
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adpl-'));
  files = path.join(profile, 'f');
  const P = (...p) => path.join(files, ...p);
  fs.mkdirSync(P('Application Support', 'agentdeck'), { recursive: true });
  fs.mkdirSync(P('.claude'));
  for (const name of [path.join('.claude', 'settings.json'), path.join('.claude', 'settings.json.bak'), 'README.md', 'a.json', 'b.json'])
    fs.writeFileSync(P(name), name.endsWith('.md') ? '# 最急的两件\n' : '{"name":"' + path.basename(name) + '"}\n');
  fs.writeFileSync(P('Application Support', 'agentdeck', 'config.json'), '{"name":"config"}\n');
  fs.writeFileSync(P('Application Support', 'agentdeck', 'config.json.bak'), '{"name":"config.bak"}\n');
  // [line, the links it holds]
  const cases = [
    [`改好了：${P('.claude', 'settings.json')}；改前的备份在同目录的 settings.json.bak`, [P('.claude', 'settings.json')]],
    [`已改 ${P('.claude', 'settings.json')} 改前的备份在同目录的 settings.json.bak`, [P('.claude', 'settings.json')]],
    [`详见 ${P('README.md')}。最急的两件：`, [P('README.md')]],
    [`${P('README.md')} 里写了最急的两件`, [P('README.md')]],
    [`${P('a.json')} 和 ${P('b.json')}`, [P('a.json'), P('b.json')]],
    [`配置 ${P('Application Support', 'agentdeck', 'config.json')}；备份在同目录的 config.json.bak`, [P('Application Support', 'agentdeck', 'config.json')]],
    [`${P('README.md')}、${P('Application Support', 'agentdeck')} 两处`, [P('README.md'), P('Application Support', 'agentdeck')]],
  ];
  LINES = cases.map((c) => c[0]);
  WANT = cases.map((c) => c[1]);
  fs.writeFileSync(path.join(profile, 'lines.json'), JSON.stringify(LINES));
  const now = Date.now();
  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'chats', CHAT + '.json'), JSON.stringify({ v: 1, id: CHAT, turns: [
    { id: 't1', ts: now - 60000, end: now - 50000, user: '改完了吗', done: true, atts: [], reply: LINES.join('\n\n') }] }));
  const column = (id, title, more) => ({ id, title, displayTitle: title, manualTitle: true, cwd: profile, width: 900, role: 'manual', ...more });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 1, globalViewMode: 'term', perpetualCaptain: { enabled: false }, resumeOnRestart: false,
    chatDeliverablesOpen: false,
    columns: [column(TERM, '终端路径', { cmd: `node "${PRINT}" "${path.join(profile, 'lines.json')}"`, view: 'term' }),
      column(CHAT, '对话路径', { cmd: '', view: 'chat' })],
  }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate((ids) => typeof terms !== 'undefined' && ids.every((i) => terms.has(i)), [TERM, CHAT]), { timeout: 30000 }).toBe(true);
  await page.evaluate(() => document.fonts.ready);
});
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !page || page.isClosed()) return;
  // the terminal's rows ("~" marks a row that continues the one above), for the failure report
  const screen = await page.evaluate((id) => {
    const { term } = terms.get(id), buf = term.buffer.active, rows = [`cols ${term.cols}`];
    for (let r = 0; r < buf.length; r++) { const ln = buf.getLine(r); if (ln && ln.translateToString(true).trim()) rows.push((ln.isWrapped ? '~' : ' ') + ln.translateToString(true)); }
    return rows.join('\n');
  }, TERM).catch((e) => String(e));
  fs.writeFileSync(testInfo.outputPath('terminal-screen.txt'), screen + '\n\nLINES:\n' + LINES.join('\n') + '\n');
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

// The links the terminal's link provider gives each printed line, with the cells they cover.
function terminalLinks(id, lines) {
  return page.evaluate(({ id, lines }) => {
    const { term } = terms.get(id);
    const buf = term.buffer.active, provider = term._core._linkProviderService.linkProviders[0];
    // a narrow column wraps the lines; where a wide character moved to the next row
    // the spacing at the wrap is not the line's own, so rows are matched without it
    const bare = (t) => t.replace(/\s+/g, '');
    const out = [];
    for (const line of lines) {
      let row = -1;
      for (let r = 0; r < buf.length && row < 0; r++) {
        const ln = buf.getLine(r);
        if (ln && !ln.isWrapped && bare(wrappedLineToCells(buf, r, term.cols).str) === bare(line)) row = r;
      }
      if (row < 0) { out.push(null); continue; }
      let links = [];
      provider.provideLinks(row + 1, (found) => { links = found || []; });
      out.push(links.map((l) => ({ text: l.text, range: l.range })));
    }
    return out;
  }, { id, lines });
}
// The middle of a cell, in page pixels (x, y are 1-based buffer cells).
function cellPoint(id, x, y) {
  return page.evaluate(({ id, x, y }) => {
    const { term, el } = terms.get(id);
    const cell = term._core._renderService.dimensions.css.cell, box = el.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: box.left + (x - 0.5) * cell.width, y: box.top + (y - 1 - term.buffer.active.viewportY + 0.5) * cell.height };
  }, { id, x, y });
}

test('terminal: each path is its own link, ending where the path ends, and a click opens that file', async () => {
  await page.evaluate((i) => jumpToColumn(columns.find((c) => c.id === i)), TERM);
  await expect.poll(() => terminalLinks(TERM, LINES).then((all) => all.every(Boolean)), { timeout: 20000 }).toBe(true);
  const found = await terminalLinks(TERM, LINES);
  // the hovered link on "…settings.json 改前的备份…": its underline is the evidence in the screenshot
  const hovered = found[1][0];
  const at = await cellPoint(TERM, hovered.range.start.x + 1, hovered.range.start.y);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(400);
  await col(TERM).screenshot({ path: test.info().outputPath(`terminal-${process.platform}.png`) });
  expect(found.map((links) => links.map((l) => l.text))).toEqual(WANT);
  // the second path of "a.json 和 b.json" is clickable on its own cells and opens b.json
  const second = found[4][1];
  const point = await cellPoint(TERM, second.range.start.x + 2, second.range.start.y);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(300);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#sidePane .pv-title strong')).toHaveText('b.json');
  await expect(page.locator('#pvBody')).toContainText('"b.json"');
  await park();
});

test('chat: the same lines in a reply link each path alone, and a click opens it', async () => {
  await page.evaluate((i) => jumpToColumn(columns.find((c) => c.id === i)), CHAT);
  await page.evaluate((i) => ChatUI.setMode(i, 'chat'), CHAT);
  const links = col(CHAT).locator('.reply .chat-link.path');
  await expect(links.first()).toBeVisible();
  await park();
  await col(CHAT).screenshot({ path: test.info().outputPath(`chat-${process.platform}.png`) });
  const paras = await col(CHAT).locator('.reply p').evaluateAll((ps) => ps.map((p) => [...p.querySelectorAll('.chat-link.path')].map((a) => a.textContent)));
  expect(paras).toEqual(WANT);
  await links.nth(5).click();
  await expect(page.locator('#sidePane .pv-title strong')).toHaveText('b.json');
  await links.nth(6).click();
  await expect(page.locator('#sidePane .pv-title strong')).toHaveText('config.json');
});
