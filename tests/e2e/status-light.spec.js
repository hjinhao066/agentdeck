const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');
const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}"`;
const statusAgent = `node "${path.join(__dirname, 'fixtures/status-agent.js')}"`;
let app, page, profile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-status-light-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, fitWindow: true, fitCols: 2, crewOpen: true,
    columns: [
      { id: 'captain', title: '队长', cmd: fake, cwd: profile, role: 'manual', isMain: true },
      { id: 'silent-worker', title: 'Quiet worker', cmd: statusAgent, cwd: profile, role: 'manual', captainCrew: true },
    ], mainSession: { colId: 'captain', cmd: fake, gen: 1, pending: [], inflight: [], fresh: false,
      crewMarked: true, waitlist: [], tasks: [] } }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect(page.locator('.column')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => {
    const entry = terms.get('silent-worker');
    return entry ? statusScreen(entry.term) : '';
  }), { timeout: 20000 }).toContain('Status stand-in ready');
  await expect.poll(() => page.evaluate(() => terms.get('captain')?.state)).not.toBe('working');
  await expect(page.locator('.nav-crew [data-col-id="silent-worker"]')).toBeVisible();
});
test.afterAll(async () => { if (app) await closeElectron(app); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });

for (const provider of ['codex', 'claude', 'agy', 'cursor']) {
  test(`${provider}: silent backstage work stays yellow without focus, then completion turns green`, async () => {
    await page.evaluate(([provider, cmd]) => {
      columns.find((c) => c.id === 'silent-worker').cmd = provider === 'cursor' ? 'cursor-agent --force' : cmd;
    }, [provider, statusAgent]);
    await page.evaluate(() => {
      // Reproduce a busy row more than 40 rows above the footer, including a
      // narrow Codex line wrapped by xterm. The real PTY receives this resize.
      terms.get('silent-worker').term.resize(45, 80);
    });
    await expect.poll(() => page.evaluate(() => [terms.get('silent-worker').term.cols, terms.get('silent-worker').term.rows])).toEqual([45, 80]);
    await page.evaluate((provider) => MainSession.handle({ action: 'main-tell', to: 'silent-worker', message: `busy ${provider} rows=80${provider === 'cursor' ? ' no-stop' : ''}` }, MainSession.mainCol()), provider);
    await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state), { timeout: 20000 }).toBe('working');
    await expect.poll(() => page.evaluate((provider) => {
      const entry = terms.get('silent-worker');
      const marker = { codex: '◦ Working', claude: '✻ Contemplating', agy: 'Searching…', cursor: '⠰⠳ Grepping' }[provider];
      return statusScreen(entry.term).includes(marker) && Date.now() - entry.lastOutputAt > 1000;
    }, provider)).toBe(true);
    const before = await page.evaluate(() => ({ focusedId, peekId, outputAt: terms.get('silent-worker').lastOutputAt }));
    expect(before.focusedId).not.toBe('silent-worker');
    expect(before.peekId).not.toBe('silent-worker');
    await expect(page.locator('.column[data-col-id="silent-worker"]')).toHaveClass(/backstage/);
    // Longer than both status debounce and ChatUI's six-second quiet fallback.
    await page.waitForTimeout(provider === 'cursor' ? 11000 : 7500);
    const quiet = await page.evaluate(() => {
      const entry = terms.get('silent-worker');
      return { state: entry.state, outputAt: entry.lastOutputAt, turnDone: ChatUI.turnsOf('silent-worker').at(-1)?.done,
        taskStatus: config.mainSession.tasks.at(-1)?.status, tail: dumpScreen(entry.term), live: statusScreen(entry.term),
        nav: navItems.get('silent-worker').dot.className };
    });
    expect(quiet.outputAt).toBe(before.outputAt);
    expect(quiet.state).toBe('working');
    expect(quiet.nav).toContain('working');
    expect(quiet.turnDone).toBe(false);
    expect(quiet.taskStatus).toBe('working');
    if (provider !== 'cursor') expect(quiet.tail).not.toMatch(/esc to interrupt|esc to cancel|Grepping/);
    expect(quiet.live).toMatch(provider === 'cursor' ? /Grepping/ : /esc to interrupt|esc to cancel/);
    await page.evaluate(() => window.deck.ptyInput('silent-worker', 'finish\r'));
    await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state), { timeout: 15000 }).toBe('done');
    await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('silent-worker').at(-1)?.done), { timeout: 15000 }).toBe(true);
    expect(await page.evaluate(() => navItems.get('silent-worker').dot.className)).toContain('done');
  });
}

test('Cursor startup silence cannot finish a submitted turn', async () => {
  await page.evaluate(() => {
    // The process stays the stand-in; only its classification metadata changes.
    columns.find((c) => c.id === 'silent-worker').cmd = 'cursor-agent --force --model grok-4.7-high-fast';
  });
  try {
    await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'silent-worker', message: 'silent startup' }, MainSession.mainCol()));
    await expect.poll(() => page.evaluate(() => statusScreen(terms.get('silent-worker').term).trim())).toBe('');
    await page.evaluate(() => { terms.get('silent-worker').lastOutputAt = Date.now() - 120000; });
    await page.waitForTimeout(7500);
    expect(await page.evaluate(() => ({ state: terms.get('silent-worker').state,
      turnDone: ChatUI.turnsOf('silent-worker').at(-1)?.done,
      task: config.mainSession.tasks.at(-1)?.status }))).toEqual({ state: 'working', turnDone: false, task: 'working' });
    await page.evaluate(() => window.deck.ptyInput('silent-worker', 'finish\r'));
    await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state), { timeout: 15000 }).toBe('done');
    await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('silent-worker').at(-1)?.done), { timeout: 15000 }).toBe(true);
  } finally {
    await page.evaluate((cmd) => { columns.find((c) => c.id === 'silent-worker').cmd = cmd; }, statusAgent);
  }
});

test('ordinary resource words on a worker screen do not fail its assignment or hold its status at quota', async () => {
  await page.evaluate((cmd) => { columns.find((c) => c.id === 'silent-worker').cmd = cmd; }, statusAgent);
  await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'silent-worker', message: 'ordinary resource text' }, MainSession.mainCol()));
  await expect.poll(() => page.evaluate(() => statusScreen(terms.get('silent-worker').term)), { timeout: 15000 }).toContain('Unauthorized access test still failing');
  await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state), { timeout: 15000 }).toBe('done');
  expect(await page.evaluate(() => config.mainSession.tasks.at(-1).status)).toBe('working');
  expect(await page.evaluate(() => MainCore.resourceReceipt(statusScreen(terms.get('silent-worker').term)))).toBeNull();
});

test('Claude background shell and monitor footer keeps the turn open and protects completed cards from archive', async () => {
  await page.evaluate(() => { columns.find((c) => c.id === 'silent-worker').cmd = 'claude'; });
  try {
    await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'silent-worker', message: 'background claude rows=80' }, MainSession.mainCol()));
    await expect.poll(() => page.evaluate(() => statusScreen(terms.get('silent-worker').term))).toContain('1 shell, 1 monitor still running');
    await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state)).toBe('working');
    // Exercise the real status and ChatUI loops beyond the quiet-turn fallback.
    await page.waitForTimeout(7500);
    const active = await page.evaluate(() => {
      const entry = terms.get('silent-worker'), task = config.mainSession.tasks.at(-1);
      const old = Date.now() - 11 * 60000;
      entry.lastOutputAt = task.sentAt = task.startedAt = task.endedAt = old;
      MainSession.onTick('silent-worker', entry);
      return { state: entry.state, turnDone: ChatUI.turnsOf('silent-worker').at(-1)?.done,
        taskStatus: task.status, endedAt: task.endedAt, receipt: task.receipt || null,
        captainClassification: classify(statusScreen(entry.term), { hasWorked: true }, 'claude', true),
        nav: navItems.get('silent-worker').dot.className };
    });
    expect(active).toMatchObject({ state: 'working', turnDone: false, taskStatus: 'working', endedAt: 0, receipt: null, captainClassification: 'done' });
    expect(active.nav).toContain('working');

    await page.evaluate(() => MainSession.submit({ action: 'complete', result: 'completed card with background tools' }, columns.find((c) => c.id === 'silent-worker')));
    const protectedCard = await page.evaluate(() => {
      const col = columns.find((c) => c.id === 'silent-worker'), entry = terms.get(col.id);
      const task = config.mainSession.tasks.at(-1), turn = ChatUI.turnsOf(col.id).at(-1);
      task.doneAt = task.sentAt = turn.ts = Date.now() - 11 * 60000;
      // A completed historical turn must not independently protect this card:
      // the live background footer alone prevents automatic/quiet archive.
      turn.done = true;
      config.mainSession.pending = []; config.mainSession.inflight = [];
      entry.state = 'done'; entry.lastOutputAt = 1;
      const otherwiseArchivable = MainCore.archivable(config.mainSession, col.id, turn.ts, Date.now());
      MainSession.onTick(col.id, entry);
      archiveColumn(col, { quiet: true });
      return { otherwiseArchivable, present: columns.includes(col), archived: (config.archived || []).some((c) => c.id === col.id) };
    });
    expect(protectedCard).toEqual({ otherwiseArchivable: true, present: true, archived: false });
    await page.evaluate(() => window.deck.ptyInput('silent-worker', 'finish\r'));
    await expect.poll(() => page.evaluate(() => statusScreen(terms.get('silent-worker').term))).not.toContain('still running');
    await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state), { timeout: 15000 }).toBe('done');

    // A second assignment has no command receipt: only losing the background
    // footer starts its normal three-minute fallback grace period.
    await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'silent-worker', message: 'background claude rows=80' }, MainSession.mainCol()));
    await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state)).toBe('working');
    await expect.poll(() => page.evaluate(() => statusScreen(terms.get('silent-worker').term))).toContain('still running');
    await page.evaluate(() => window.deck.ptyInput('silent-worker', 'finish\r'));
    await expect.poll(() => page.evaluate(() => statusScreen(terms.get('silent-worker').term))).not.toContain('still running');
    await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state), { timeout: 15000 }).toBe('done');
    await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('silent-worker').at(-1)?.done), { timeout: 15000 }).toBe(true);
    expect(await page.evaluate(() => config.mainSession.tasks.at(-1).status)).toBe('working');
    const beforeDeadline = await page.evaluate(() => {
      const entry = terms.get('silent-worker'), task = config.mainSession.tasks.at(-1);
      task.endedAt = entry.lastOutputAt = Date.now() - 179000;
      MainSession.onTick('silent-worker', entry);
      return task.status;
    });
    // Past the deadline the fallback also asks the process table whether a command Claude started is still
    // running under the terminal; that answer comes back a moment later, so the ticks go on until it has.
    await expect.poll(() => page.evaluate(() => {
      const entry = terms.get('silent-worker'), task = config.mainSession.tasks.at(-1);
      if (task.status === 'working') { task.endedAt = entry.lastOutputAt = Date.now() - 181000; MainSession.onTick('silent-worker', entry); }
      return task.status;
    }), { timeout: 15000 }).toBe('stopped');
    const fallback = await page.evaluate(() => { const task = config.mainSession.tasks.at(-1); return { status: task.status, source: task.receipt?.source, summary: task.receipt?.summary }; });
    expect({ beforeDeadline, ...fallback }).toEqual({ beforeDeadline: 'working', status: 'stopped', source: 'fallback', summary: '已结束，未提交回执' });
  } finally {
    await page.evaluate((cmd) => { const col = columns.find((c) => c.id === 'silent-worker'); if (col) col.cmd = cmd; }, statusAgent);
  }
});

test('Cursor remains working in ledger after command completion until the live terminal finishes', async () => {
  await page.evaluate(() => { columns.find((c) => c.id === 'silent-worker').cmd = 'cursor-agent --force'; });
  await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'silent-worker', message: 'busy cursor rows=80' }, MainSession.mainCol()));
  await expect.poll(() => page.evaluate(() => MainCore.cursorActivity(statusScreen(terms.get('silent-worker').term)))).toBe('working');
  await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state)).toBe('working');
  await page.evaluate(() => MainSession.submit({ action: 'complete', result: 'stand-in assignment finished' }, columns.find((c) => c.id === 'silent-worker')));
  const ledger = await page.evaluate(() => MainSession.handle({ action: 'main-ledger' }, MainSession.mainCol()));
  expect(ledger.result).toMatch(/silent-worker[^\n]*干活中/);
  expect(await page.evaluate(() => config.mainSession.tasks.at(-1).receipt.source)).toBe('command');
  await page.evaluate(() => {
    const entry = terms.get('silent-worker'), task = config.mainSession.tasks.at(-1);
    task.doneAt = task.sentAt = Date.now() - 20 * 60000;
    ChatUI.turnsOf('silent-worker').at(-1).ts = Date.now() - 20 * 60000;
    config.mainSession.pending = []; config.mainSession.inflight = [];
    entry.state = 'done'; entry.lastOutputAt = 1;
    // Exercise the automatic path between status ticks with an erroneous green dot.
    MainSession.onTick('silent-worker', entry);
    archiveColumn(columns.find((c) => c.id === 'silent-worker'), { quiet: true });
  });
  expect(await page.evaluate(() => columns.some((c) => c.id === 'silent-worker'))).toBe(true);
  await page.evaluate(() => window.deck.ptyInput('silent-worker', 'finish\r'));
  await expect.poll(() => page.evaluate(() => statusScreen(terms.get('silent-worker').term))).toContain('Finished. Working indicator removed.');
  await expect.poll(() => page.evaluate(() => terms.get('silent-worker')?.state), { timeout: 15000 }).toBe('done');
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('silent-worker').at(-1)?.done), { timeout: 15000 }).toBe(true);
  await page.evaluate(() => { terms.get('silent-worker').lastOutputAt = Date.now() - 20 * 60000; });
  await expect.poll(() => page.evaluate(() => (config.archived || []).some((c) => c.id === 'silent-worker'))).toBe(true);
});
