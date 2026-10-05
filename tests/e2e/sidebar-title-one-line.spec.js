const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated profile and stand-in PTYs only; no real Claude/Cursor/Codex process starts.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shortTitle = '调度卡片';
const sampleTitle = 'Windows AgentDeck 升到最新版';
const longTitle = 'Windows AgentDeck 升到最新版：侧边栏会话标题固定一行，放不下就在末尾用省略号截断，悬停显示完整标题';
const titles = [shortTitle, sampleTitle, longTitle];
const widths = [200, 252, 420];
let application, page, profile;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidebar-title-'));
  const now = Date.now();
  fs.mkdirSync(path.join(profile, 'chats'));
  titles.forEach((title, i) => {
    fs.writeFileSync(path.join(profile, 'chats', `worker-${i}.json`), JSON.stringify({
      v: 1, id: `worker-${i}`, turns: [{ id: `turn-${i}`, ts: now - (i + 2) * 60000, user: title, reply: 'stand-in reply', done: true, atts: [] }],
    }));
  });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, navWidth: 252,
    columns: [
      { id: 'captain', title: '队长', cmd: FAKE + ' --captain-statusline', cwd: profile, width: 460, role: 'manual', isMain: true },
      ...titles.map((title, i) => ({ id: `worker-${i}`, title, displayTitle: title, manualTitle: true,
        cmd: FAKE + ' --interruptible --sidebar-controls', cwd: profile, width: 460, role: 'manual', captainCrew: true })),
    ],
    mainSession: { colId: 'captain', cmd: FAKE + ' --captain-statusline', gen: 1, pending: [], inflight: [],
      fresh: false, crewMarked: true, waitlist: [], tasks: titles.map((title, i) => ({
        id: `task-${i}`, colId: `worker-${i}`, title, status: 'working', sentAt: now - (i + 2) * 60000, gen: 1,
      })) },
  }));
  const env = { ...process.env, AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`],
    env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(4);
  await page.evaluate(() => {
    const commands = ['cursor-agent --model grok-4.7-high-fast', 'codex --model gpt-6.1-sol', 'agy --model gemini-3.8-flash-high'];
    const models = ['grok-4.7-high-fast', 'gpt-6.1-sol', 'gemini-3.8-flash-high'];
    commands.forEach((cmd, i) => {
      columns.find((c) => c.id === `worker-${i}`).cmd = cmd;
      window.deck.ptyInput(`worker-${i}`, `/model ${models[i]}\r`);
    });
    config.crewOpen = true;
    Sidebar.render();
  });
  await expect(page.locator('.nav-crew .crew-model .agent-model-label', { hasText: 'Flash 3.8' })).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.nav-crew [data-col-id="worker-2"] .agent-model-label')).toHaveCount(0);
  await page.evaluate(() => [0, 1, 2].forEach((i) => window.deck.ptyInput(`worker-${i}`, 'keep working\r')));
  await expect(page.locator('.nav-crew [data-col-id="worker-2"] .cn-sub')).toHaveText('✻ Doing…', { timeout: 10000 });
});

test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a long session title stays one line, truncates, and keeps the full title on hover and for assistive tech', async ({}, testInfo) => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
  const shotDir = process.env.AGENTDECK_SCREENSHOT_DIR || testInfo.outputDir;
  fs.mkdirSync(shotDir, { recursive: true });
  const label = (id) => page.locator(`.nav-crew [data-col-id="${id}"] .cn-label`);

  for (const theme of ['dark', 'light']) {
    await page.evaluate((name) => applyTheme(name), theme);
    for (const width of widths) {
      await page.evaluate((w) => { config.navWidth = w; applyNavWidth(); }, width);
      await page.mouse.move(800, 40);
      await page.evaluate(() => { document.activeElement?.blur(); document.getElementById('navList').scrollTop = 0; });

      const layout = await page.evaluate(() => {
        const rowOf = (id) => document.querySelector(`.nav-crew [data-col-id="${id}"]`);
        const measure = (el) => {
          const cs = getComputedStyle(el);
          const lineHeight = parseFloat(cs.lineHeight);
          const fontSize = parseFloat(cs.fontSize);
          const height = el.getBoundingClientRect().height;
          return {
            height,
            lineHeight,
            fontSize,
            whiteSpace: cs.whiteSpace,
            overflow: cs.overflow,
            textOverflow: cs.textOverflow,
            text: el.textContent,
            title: el.getAttribute('title'),
            aria: el.getAttribute('aria-label'),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            right: el.getBoundingClientRect().right,
          };
        };
        const oneLine = (el) => {
          const box = measure(el);
          const limit = Number.isFinite(box.lineHeight) ? box.lineHeight + 1 : box.fontSize * 1.6;
          return box.whiteSpace === 'nowrap' && box.height <= limit;
        };
        const shortRow = rowOf('worker-0');
        const sampleRow = rowOf('worker-1');
        const longRow = rowOf('worker-2');
        const short = measure(shortRow.querySelector('.cn-label'));
        const sample = measure(sampleRow.querySelector('.cn-label'));
        const long = measure(longRow.querySelector('.cn-label'));
        const rowRight = longRow.getBoundingClientRect().right;
        return {
          short, sample, long, rowRight,
          modelOneLine: oneLine(document.querySelector('.nav-crew .crew-model .agent-model-label')),
          timeOneLine: oneLine(longRow.querySelector('.cn-meta')),
          outputHidden: getComputedStyle(longRow.querySelector('.cn-sub')).display === 'none',
          outputText: longRow.querySelector('.cn-sub').textContent,
          tip: longRow.getAttribute('title') || '',
          rowHeight: longRow.getBoundingClientRect().height,
        };
      });

      expect(layout.long.text, `theme=${theme} width=${width}`).toBe(longTitle);
      expect(layout.long.title.startsWith(longTitle), `theme=${theme} width=${width}`).toBe(true);
      expect(layout.long.title).toContain('✻ Doing…');
      expect(layout.long.aria).toBe(longTitle);
      expect(layout.sample.text).toBe(sampleTitle);
      expect(layout.sample.title.startsWith(sampleTitle), `theme=${theme} width=${width}`).toBe(true);
      expect(layout.sample.title).toContain('✻ Doing…');
      expect(layout.sample.aria).toBe(sampleTitle);
      expect(layout.long.whiteSpace).toBe('nowrap');
      expect(layout.long.overflow).toBe('hidden');
      expect(layout.long.textOverflow).toBe('ellipsis');
      expect(layout.long.scrollWidth).toBeGreaterThan(layout.long.clientWidth + 1);
      expect(layout.long.right).toBeLessThanOrEqual(layout.rowRight + 1);
      expect(Math.abs(layout.long.height - layout.short.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.sample.height - layout.short.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.long.height - layout.long.lineHeight)).toBeLessThanOrEqual(1);
      expect(layout.modelOneLine, `model row theme=${theme} width=${width}`).toBe(true);
      expect(layout.timeOneLine, `time row theme=${theme} width=${width}`).toBe(true);
      expect(layout.outputHidden, `output stays in the tooltip theme=${theme} width=${width}`).toBe(true);
      expect(layout.outputText).toBe('✻ Doing…');
      expect(layout.tip).toContain(longTitle);
      expect(layout.tip).toContain('✻ Doing…');
      expect(layout.rowHeight, `theme=${theme} width=${width}`).toBeLessThanOrEqual(36);
      if (width <= 252) expect(layout.sample.scrollWidth).toBeGreaterThan(layout.sample.clientWidth + 1);

      await expect(label('worker-2')).toHaveAttribute('title', new RegExp('^' + longTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await expect(label('worker-2')).toHaveAttribute('aria-label', longTitle);
      const shotName = width === 252 ? `sidebar-after-${theme}.png` : `sidebar-after-${theme}-${width}.png`;
      await page.locator('#colNav').screenshot({ path: path.join(shotDir, shotName) });
    }
  }
});
