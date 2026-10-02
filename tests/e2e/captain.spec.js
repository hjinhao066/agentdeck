const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 队长 (Captain, the main session). Its column runs a plain shell here, and the
// test types the real control commands into it, the same ones the agent would
// run. The columns it drives run a stand-in agent that writes receipts.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const CLI = process.platform === 'win32' ? '$env:AGENTDECK_BOARD_CLI' : '$AGENTDECK_BOARD_CLI';
let application, page, profile, demoFile, mainId;
test.describe.configure({ mode: 'serial' });

const screen = (id) => page.evaluate((i) => dumpScreen(terms.get(i).term).replace(/\n/g, ''), id);
async function run(id, command) {
  await page.evaluate(([i, c]) => window.deck.ptyInput(i, c + '\r'), [id, command]);
}
async function waitForShell(id) {
  if (process.platform === 'win32') {
    await expect.poll(() => page.evaluate((i) => {
      const t = terms.get(i);
      return MainCore.isWindowsShellPrompt(t?.term ? dumpScreen(t.term) : (t?.lastScreen || ''));
    }, id), { timeout: 15000 }).toBe(true);
  } else {
    await expect.poll(() => page.evaluate((i) => window.deck.ptyForeground(i), id), { timeout: 15000 }).not.toBe('node');
  }
}

async function launch() {
  const env = { ...process.env, AGENTDECK_DEMO_FILE: demoFile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('dialog', (d) => d.accept());
}

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-captain-'));
  demoFile = path.join(profile, 'report.md');
  fs.writeFileSync(demoFile, '# Report\n');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: ['x', 'y'].map((k) => ({ id: `cap-${k}`, taskId: `task-${k}`, title: `Worker ${k}`, cmd: FAKE, cwd: profile, width: 460, role: 'manual' })),
  }));
  await launch();
  await expect(page.locator('.column.chat-mode')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(2);
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('there is one Captain: the sidebar entry creates it first, then just returns to it', async () => {
  await page.locator('.nav-row[data-nav="captain"]').click();
  await expect(page.locator('#mainDialog')).toBeVisible();
  await page.locator('#mdCmd').fill('');           // a plain shell stands in for the agent
  await page.locator('#mdCwd').fill(profile);
  await page.locator('#mdCreate').click();
  await expect(page.locator('.column.is-main')).toHaveCount(1);
  mainId = await page.evaluate(() => config.mainSession.colId);
  expect(await page.evaluate(() => deckEl.querySelector('.column').dataset.colId)).toBe(mainId);
  await expect(page.locator(`.colnav-item[data-col-id="${mainId}"]`)).toHaveCount(0);   // not a regular session
  await expect.poll(() => page.evaluate((i) => window.deck.ptyIsAlive(i), mainId)).toBe(true);
  await page.locator('.colnav-item[data-col-id="cap-y"]').click();
  await page.locator('.nav-row[data-nav="captain"]').click();
  await expect(page.locator('#mainDialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe(mainId);
  expect(await page.evaluate(() => columns.filter((c) => c.isMain).length)).toBe(1);
});

test('new: a fresh column gets the task as its first message, and the receipt comes back', async () => {
  // --command keeps the new column on the stand-in, never a real agent
  await run(mainId, `node "${CLI}" new --title "写周报" --task "please write the report" --command "${FAKE.replace(/"/g, '')}"`);
  await expect.poll(() => page.evaluate(() => columns.some((c) => c.displayTitle === '写周报'))).toBe(true);
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === '写周报').id);
  await expect(page.locator(`.colnav-item[data-col-id="${child}"]`)).toContainText('写周报');
  const card = page.locator(`.column[data-col-id="${mainId}"] .task-card`).first();
  await expect(card).toContainText('写周报');
  // the task is the child's first user message; the receipt contract rides along unseen
  await expect(page.locator(`.column[data-col-id="${child}"] .msg.user .bubble`).first()).toHaveText('please write the report', { timeout: 30000 });
  await expect(card).toHaveClass(/st-done/, { timeout: 30000 });
  await expect(card.locator('.task-summary')).toContainText('stand-in finished please write the report');
  await expect(card.locator('.att')).toHaveAttribute('title', demoFile);
  expect(await page.evaluate((i) => columns.find((c) => c.id === i).lastReceipt.files, child)).toEqual([demoFile]);
  // clicking the card's title jumps to that column
  await card.locator('.task-title').click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe(child);
});

test('tell, ledger and read from the Captain terminal; a worker stuck on a confirmation goes to the Captain', async () => {
  await run(mainId, `clear; node "${CLI}" tell --to cap-x --message "ask me first"`);
  const card = page.locator(`.column[data-col-id="${mainId}"] .task-card`, { hasText: 'Worker x' });
  await expect(card).toHaveClass(/st-input/, { timeout: 30000 });
  await expect(card).toContainText('停在确认');
  // the prompt's last lines are queued for the Captain, not for the user
  await expect.poll(() => page.evaluate(() => config.mainSession.pending.map((p) => p.waiting || '').join('\n'))).toContain('(y/n)');
  await run(mainId, `clear; node "${CLI}" tell --to cap-x --message "more"`);
  await expect.poll(() => screen(mainId), { timeout: 15000 }).toContain('用 answer 回答它');

  await run(mainId, `clear; node "${CLI}" ledger`);
  await expect.poll(() => screen(mainId), { timeout: 15000 }).toMatch(/cap-x\s+「Worker x」\s+等你回复/);
  await expect.poll(() => screen(mainId)).toContain('写周报');
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === '写周报').id);
  await run(mainId, `clear; node "${CLI}" read --id ${child}`);
  await expect.poll(() => screen(mainId), { timeout: 15000 }).toContain('用户：please write the report');

  // the Captain answers the confirmation itself and the worker carries on
  await run(mainId, `clear; node "${CLI}" answer --to cap-x --key y`);
  await expect.poll(() => screen(mainId), { timeout: 15000 }).toContain('按了 y');
  await expect.poll(() => screen('cap-x'), { timeout: 15000 }).toContain('GOT y');
  await expect(card).not.toHaveClass(/st-input/, { timeout: 15000 });
});

test('receipts and questions reach an idle Captain agent by themselves, never a bare shell', async () => {
  // the Captain column is configured for an agent, but only its shell is in front:
  // nothing may be typed there, it would run each line as a command
  const queued = await page.evaluate(() => {
    MainSession.mainCol().cmd = 'stand-in';
    config.mainSession.pending.push({ colId: 'cap-y', title: 'Worker y', question: '用 SQLite 可以吗' });
    return config.mainSession.pending.length;
  });
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => config.mainSession.pending.length)).toBeGreaterThanOrEqual(queued);
  expect(await page.evaluate((i) => window.deck.ptyReplay(i), mainId)).not.toContain('用 SQLite 可以吗');
  // with an agent (the stand-in) in front, delivery happens by itself
  await run(mainId, `clear; ${FAKE}`);
  if (process.platform === 'win32') {
    // Automatic receipts can already have scrolled the welcome banner away.
    await expect.poll(() => page.evaluate((i) => agentInForeground(columns.find((c) => c.id === i), false), mainId), { timeout: 15000 }).toBe(true);
  } else {
    await expect.poll(() => page.evaluate((i) => window.deck.ptyForeground(i), mainId), { timeout: 15000 }).toBe('node');
  }
  await expect.poll(() => page.evaluate(() => config.mainSession.pending.length), { timeout: 15000 }).toBe(0);
  await expect.poll(() => page.evaluate((i) => window.deck.ptyReplay(i), mainId), { timeout: 15000 }).toContain('向你提问：用 SQLite 可以吗');
  // no prompt bubble of yours for an automatic delivery
  const turns = await page.evaluate((i) => ChatUI.turnsOf(i).filter((t) => t.kind !== 'task').map((t) => t.user), mainId);
  expect(turns[turns.length - 1]).toBe('');
  await page.evaluate((i) => window.deck.ptyInput(i, '\x03'), mainId);   // back to the shell for the next tests
  await waitForShell(mainId);
  await page.evaluate(() => { MainSession.mainCol().cmd = ''; config.mainSession.pending.push({ colId: 'cap-y', title: 'Worker y', summary: 'kept for your next message', files: [] }); });
});

test('receipts ride along with the next message to the Captain, not in its bubble', async () => {
  expect(await page.evaluate(() => config.mainSession.pending.length)).toBeGreaterThan(0);
  const box = page.locator(`.column[data-col-id="${mainId}"] .composer textarea`);
  await box.click();
  await page.keyboard.type('status please');
  await page.keyboard.press('Enter');
  await expect(page.locator(`.column[data-col-id="${mainId}"] .msg.user .bubble`).last()).toHaveText('status please');
  await expect.poll(() => page.evaluate((i) => window.deck.ptyReplay(i), mainId), { timeout: 15000 }).toContain('AgentDeck 新回执');
  expect(await page.evaluate(() => config.mainSession.pending.length)).toBe(0);
});

test('only the Captain holds control: other columns get no token and are refused', async () => {
  await run('cap-y', 'ask nothing');   // wakes the stand-in; harmless
  await page.evaluate(() => window.deck.ptyInput('cap-y', '\x03'));    // leave the stand-in
  await waitForShell('cap-y');
  await run('cap-y', 'clear; node -e "console.log(\'TOKEN=\' + (process.env.AGENTDECK_CONTROL_TOKEN || \'none\'))"');
  await expect.poll(() => screen('cap-y'), { timeout: 15000 }).toContain('TOKEN=none');
  const refused = await page.evaluate(() => MainSession.handle({ action: 'main-ledger' }, columns.find((c) => c.id === 'cap-x'))
    .then(() => 'allowed', (e) => e.message));
  expect(refused).toContain('只有队长');
});

test('clearing the Captain restarts only its own column', async () => {
  const before = await page.evaluate(() => ({ gen: config.mainSession.gen, workers: columns.filter((c) => !c.isMain).map((c) => c.id) }));
  const col = page.locator(`.column[data-col-id="${mainId}"]`);
  await col.hover();
  await col.locator('.secondary .icon-btn').first().click();     // 清空上下文
  await expect.poll(() => page.evaluate(() => config.mainSession.gen)).toBe(before.gen + 1);
  const fresh = await page.evaluate(() => config.mainSession.colId);
  expect(fresh).not.toBe(mainId);
  await expect(page.locator(`.column[data-col-id="${fresh}"] .task-card`)).toHaveCount(0);
  await expect(page.locator(`.column[data-col-id="${fresh}"] .msg`)).toHaveCount(0);
  expect(await page.evaluate(() => config.mainSession.pending.length)).toBe(0);
  expect(await page.evaluate(() => columns.filter((c) => !c.isMain).map((c) => c.id))).toEqual(before.workers);
  for (const id of before.workers) expect(await page.evaluate((i) => window.deck.ptyIsAlive(i), id)).toBe(true);
  // still in control after the restart
  await expect.poll(() => page.evaluate((i) => window.deck.ptyIsAlive(i), fresh)).toBe(true);
  await run(fresh, `node "${CLI}" ledger`);
  await expect.poll(() => screen(fresh), { timeout: 15000 }).toContain('写周报');
});


test('a restored Captain gets the current provider and effort instructions', async () => {
  const id = await page.evaluate(() => config.mainSession.colId);
  await page.evaluate(({ id, cmd }) => {
    columns.find((c) => c.id === id).cmd = cmd;
    config.mainSession.cmd = cmd;
    flushConfig();
  }, { id, cmd: FAKE });
  await application.close();
  application = null;
  await launch();
  await expect.poll(() => page.evaluate((i) => window.deck.ptyReplay(i), id), { timeout: 30000 }).toContain('claude-opus-5-5-max');
  await expect.poll(() => page.evaluate((i) => window.deck.ptyReplay(i), id), { timeout: 15000 }).toContain('gemini-3.8-flash-high');
});
