const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile;

test.describe.configure({ mode: 'serial' });

async function launchWithCols(colCount, fitCols = 3) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-layout-test-'));
  const demoFile = path.join(profile, 'demo.md');
  fs.writeFileSync(demoFile, '# demo\n');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols,
    columns: Array.from({ length: colCount }, (_, i) => ({
      id: `col-${i}`, taskId: `task-${i}`, title: `Session ${i + 1}`,
      cmd: FAKE, cwd: profile, width: 460, role: 'manual',
    })),
  }));

  const env = { ...process.env, AGENTDECK_DEMO_FILE: demoFile };
  delete env.ELECTRON_RUN_AS_NODE;

  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`],
    env,
  });

  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(colCount);
  // Wait for fake-agent readiness across all columns
  await expect.poll(
    () => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length),
    { timeout: 20000 }
  ).toBe(colCount);
}

async function closeApp() {
  if (application) {
    try { await application.close(); } catch (_) {}
    application = null;
  }
  if (profile) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    profile = null;
  }
}

// Samples geometry across multiple animation frames during active PTY rendering
async function sampleWidthsOverFrames(page, frameCount = 30) {
  return await page.evaluate((count) => {
    return new Promise((resolve) => {
      const samples = [];
      let framesLeft = count;
      function tick() {
        const deckW = deckEl.clientWidth;
        const colWidths = [...deckEl.querySelectorAll('.column')].map((c) => {
          return c.getBoundingClientRect().width;
        });
        samples.push({ deckW, colWidths });
        if (--framesLeft > 0) {
          requestAnimationFrame(tick);
        } else {
          resolve(samples);
        }
      }
      requestAnimationFrame(tick);
    });
  }, frameCount);
}

test.describe('Equal-split layout regression with active raw-terminal column', () => {
  test.afterEach(async () => {
    await closeApp();
  });

  for (const count of [3, 4]) {
    test(`equal ${count}-split layout remains balanced and bounded when a column runs raw terminal`, async () => {
      await launchWithCols(count, count);

      // Switch column 0 to raw terminal mode via ChatUI.setMode
      await page.evaluate(() => ChatUI.setMode('col-0', 'term'));
      const col0 = page.locator('.column[data-col-id="col-0"]');
      await expect(col0).not.toHaveClass(/chat-mode/);
      await expect(col0.locator('.term')).toBeVisible();

      // Trigger actual PTY output & redraws using /model requests on the fake-agent
      await page.evaluate(() => window.deck.ptyInput('col-0', '/model TestGrownModel\r'));
      await expect.poll(
        () => page.evaluate(() => terms.get('col-0')?.lastScreen || ''),
        { timeout: 15000 }
      ).toContain('Model: TestGrownModel');

      // Sample widths across many animation frames while the terminal is active
      const samples = await sampleWidthsOverFrames(page, 30);
      expect(samples.length).toBe(30);

      // Verify geometry on each sampled frame:
      // 1. Column widths must stay equal to within rounding (<= 2px delta between max and min)
      // 2. Each column must be bounded to deckWidth / count (<= 2px error)
      // 3. The raw-terminal column must not grow over time
      const firstCol0Width = samples[0].colWidths[0];
      for (let i = 0; i < samples.length; i++) {
        const { deckW, colWidths } = samples[i];
        const expectedWidth = deckW / count;
        const maxW = Math.max(...colWidths);
        const minW = Math.min(...colWidths);

        // Columns must remain equal
        expect(maxW - minW, `Frame ${i}: unequal column widths [${colWidths.map(w => w.toFixed(1)).join(', ')}] in ${count}-split (deck=${deckW})`).toBeLessThanOrEqual(2);

        // Bound to deckWidth / count
        for (let c = 0; c < count; c++) {
          expect(
            Math.abs(colWidths[c] - expectedWidth),
            `Frame ${i}: col ${c} width ${colWidths[c].toFixed(1)} differs from expected ${expectedWidth.toFixed(1)}`
          ).toBeLessThanOrEqual(2);
        }
      }

      // Final sample: col 0 must not have grown over time compared to initial
      const lastCol0Width = samples[samples.length - 1].colWidths[0];
      expect(Math.abs(lastCol0Width - firstCol0Width)).toBeLessThanOrEqual(2);
    });
  }

  for (const count of [2, 5]) {
    test(`compact test: equal ${count}-split layout geometry holds with raw terminal`, async () => {
      await launchWithCols(count, count);

      await page.evaluate(() => ChatUI.setMode('col-0', 'term'));
      await page.evaluate(() => window.deck.ptyInput('col-0', '/model CompactModel\r'));
      await expect.poll(
        () => page.evaluate(() => terms.get('col-0')?.lastScreen || ''),
        { timeout: 15000 }
      ).toContain('Model: CompactModel');

      const samples = await sampleWidthsOverFrames(page, 15);
      const last = samples[samples.length - 1];
      const expected = last.deckW / count;
      const maxW = Math.max(...last.colWidths);
      const minW = Math.min(...last.colWidths);

      expect(maxW - minW).toBeLessThanOrEqual(2);
      expect(Math.abs(last.colWidths[0] - expected)).toBeLessThanOrEqual(2);
    });
  }

  test('zoom and unzoom preserve equal geometry with raw terminal column', async () => {
    await launchWithCols(3, 3);
    await page.evaluate(() => ChatUI.setMode('col-0', 'term'));

    // Zoom column 0
    await page.evaluate(() => toggleZoom('col-0'));
    const zoomedSample = await sampleWidthsOverFrames(page, 5);
    const zLast = zoomedSample[zoomedSample.length - 1];
    // Zoomed column should take the full deck
    expect(Math.abs(zLast.colWidths[0] - zLast.deckW)).toBeLessThanOrEqual(2);

    // Unzoom column 0
    await page.evaluate(() => toggleZoom('col-0'));
    const unzoomedSamples = await sampleWidthsOverFrames(page, 15);
    const uLast = unzoomedSamples[unzoomedSamples.length - 1];
    const expected = uLast.deckW / 3;
    const maxW = Math.max(...uLast.colWidths);
    const minW = Math.min(...uLast.colWidths);

    expect(maxW - minW).toBeLessThanOrEqual(2);
    expect(Math.abs(uLast.colWidths[0] - expected)).toBeLessThanOrEqual(2);
  });

  test('n > split keeps fixed slice width and horizontal scroll', async () => {
    // 4 columns configured with fitCols=3
    await launchWithCols(4, 3);
    await page.evaluate(() => ChatUI.setMode('col-0', 'term'));

    const deckInfo = await page.evaluate(() => {
      const d = deckEl;
      const cols = [...d.querySelectorAll('.column')].map((c) => c.getBoundingClientRect().width);
      return {
        deckW: d.clientWidth,
        scrollW: d.scrollWidth,
        overflowX: d.style.overflowX,
        colWidths: cols,
      };
    });

    const expectedSlice = Math.floor(deckInfo.deckW / 3);
    expect(deckInfo.overflowX).toBe('scroll');
    expect(deckInfo.scrollW).toBeGreaterThan(deckInfo.deckW);
    for (let i = 0; i < deckInfo.colWidths.length; i++) {
      expect(Math.abs(deckInfo.colWidths[i] - expectedSlice)).toBeLessThanOrEqual(2);
    }
  });
});
