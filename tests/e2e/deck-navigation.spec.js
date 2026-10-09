const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('column navigation preserves native center and nearest scrolling, including columns wider than the deck', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-deck-navigation-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    fitWindow: false,
    columns: ['before', 'target', 'after'].map((id) => ({ id, title: id, cmd: '', cwd: profile, width: 1200, role: 'manual' })),
  }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({
      executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
    });
    const page = await app.firstWindow();
    // Windows starts each ConPTY synchronously in the main process; on a cold machine three
    // of them can hold the page's first frames for several seconds.
    await expect(page.locator('.column')).toHaveCount(3, { timeout: 20000 });
    // Columns enter the DOM before their terminals mount on the next frame.
    await expect.poll(() => page.evaluate(() =>
      ['before', 'target', 'after'].every((id) => terms.get(id)?.wrap?.isConnected)
    ), { timeout: 20000 }).toBe(true);
    const cases = await page.evaluate(() => {
      isUserScrollingDeck = true;
      const target = terms.get('target').wrap;
      const viewport = deckEl.clientWidth;
      const scenarios = [
        ['narrow-left', viewport - 300, 100, false],
        ['narrow-right', viewport - 300, -400, false],
        ['wide-both', viewport + 300, 100, false],
        ['wide-left', viewport + 300, 400, false],
        ['wide-right', viewport + 300, -100, false],
        ['wide-center', viewport + 300, 100, true],
        ['narrow-center', viewport - 300, -400, true],
      ];
      return scenarios.map(([name, width, offset, center]) => {
        target.style.width = width + 'px';
        deckEl.scrollLeft = 0;
        const left = target.getBoundingClientRect().left - deckEl.getBoundingClientRect().left;
        const start = left + offset;
        deckEl.scrollLeft = start;
        target.scrollIntoView({ behavior: 'instant', inline: center ? 'center' : 'nearest', block: 'nearest' });
        const native = deckEl.scrollLeft;
        // Native scrolling may move hidden ancestors; the replacement must
        // match only the deck movement and leave the surrounding UI in place.
        document.scrollingElement.scrollLeft = 0;
        deckEl.scrollLeft = start;
        const sidebar = document.getElementById('colNav').getBoundingClientRect().left;
        scrollColumnInDeck(target, center);
        return { name, start, native, actual: deckEl.scrollLeft, sidebar, sidebarAfter: document.getElementById('colNav').getBoundingClientRect().left, documentLeft: document.scrollingElement.scrollLeft };
      });
    });
    for (const result of cases) {
      expect(result.actual, result.name).toBeCloseTo(result.native, 0);
      expect(result.sidebarAfter, result.name).toBe(result.sidebar);
      expect(result.documentLeft, result.name).toBe(0);
    }
    const covering = cases.find((result) => result.name === 'wide-both');
    expect(covering.actual).toBe(covering.start);
  } finally {
    if (app) await closeElectron(app);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
