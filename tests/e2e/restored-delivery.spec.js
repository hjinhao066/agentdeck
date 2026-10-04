const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}"`;

test('restored work waits for a fresh TUI, then reaches the agent exactly once', async ({}, testInfo) => {
  test.setTimeout(90000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-restored-delivery-'));
  const captured = path.join(profile, 'prompts.jsonl');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ fitWindow: true, fitCols: 2,
    columns: [{ id: 'cap', title: '队长', cmd: FAKE, cwd: profile, isMain: true }],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, fresh: false, crewMarked: true,
      tasks: [], pending: [], inflight: [], waitlist: [] } }));
  const env = { ...process.env, AGENTDECK_TEST_PROMPT_COLUMNS_FILE: captured };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page, id;
  const received = () => fs.existsSync(captured) ? fs.readFileSync(captured, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(p => p.colId === id).map(p => p.text) : [];
  try {
    app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
    page = await app.firstWindow();
    await expect(page.locator('.column.is-main')).toBeVisible();
    await expect.poll(() => page.evaluate(() => terms.get('cap')?.lastScreen || ''), { timeout: 20000 }).toContain('Claude Code');
    await page.evaluate(([command, cwd]) => MainSession.handle({ action: 'main-new', id: 'restore-probe',
      title: 'Restore probe', task: 'initial task', command, cwd }, MainSession.mainCol()), [FAKE, profile]);
    id = await page.evaluate(() => columns.find(c => c.displayTitle === 'Restore probe').id);
    const status = () => page.evaluate(i => MainSession.state().tasks.filter(t => t.colId === i).at(-1)?.status, id);
    await expect.poll(status, { timeout: 20000 }).toBe('done');
    for (let n = 0; n < 3; n++) {
      await expect.poll(() => page.evaluate(i => terms.get(i)?.state, id), { timeout: 15000 }).toBe('done');
      await page.evaluate(async ([i, command]) => {
        await MainSession.handle({ action: 'main-archive', to: i }, MainSession.mainCol());
        config.archived.find(c => c.id === i).cmd = command + ' --delayed-start';
      }, [id, FAKE]);
      const message = `restore task ${n}`;
      await page.evaluate(([i, message]) => MainSession.handle({ action: 'main-tell', to: i, message }, MainSession.mainCol()), [id, message]);
      // The stand-in has not drawn its new TUI yet. Old idle replay must not
      // permit delivery or turn its old reply into a fresh completion.
      await page.waitForTimeout(2000);
      expect(await status()).toBe('queued');
      expect(received().filter(p => p.startsWith(message))).toHaveLength(0);
      await expect.poll(status, { timeout: 20000 }).toBe('done');
      expect(received().filter(p => p.startsWith(message))).toHaveLength(1);
    }
  } catch (error) {
    if (page && !page.isClosed()) {
      const state = await page.evaluate(i => {
        if (typeof terms === 'undefined') return { rendererReady: false };
        const e = terms.get(i);
        return { screen: e && dumpScreen(e.term), lastScreen: e?.lastScreen, state: e?.state,
          typing: e?.typing, sending: e?.sendingPrompt, injecting: e?.injecting,
          tasks: MainSession.state().tasks.filter(t => t.colId === i), turns: ChatUI.turnsOf(i) };
      }, id);
      await testInfo.attach('restore-state', { body: JSON.stringify({ state, received: received() }, null, 2), contentType: 'application/json' });
    }
    throw error;
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
