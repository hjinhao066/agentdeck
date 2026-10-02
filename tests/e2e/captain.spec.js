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
  const env = { ...process.env, AGENTDECK_DEMO_FILE: demoFile, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'received-prompts.jsonl') };
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
  // ConPTY may wrap or redraw Chinese text in the replay. Check what the
  // stand-in actually received, rather than the terminal's rendering of it.
  await expect.poll(() => capturedPrompts().join('\n'), { timeout: 15000 }).toContain('向你提问：用 SQLite 可以吗');
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

// ---- clearing the Captain's context ----
let oldCaptainId;
const replay = (id) => page.evaluate((i) => window.deck.ptyReplay(i), id);
const taskOf = (colId, status) => page.evaluate(([c, s]) => config.mainSession.tasks.some((t) => t.colId === c && t.status === s), [colId, status]);
const capturedPrompts = () => {
  const file = path.join(profile, 'received-prompts.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch (_) { return []; } // a write may still be finishing
  }) : [];
};

test('a busy Captain is reset only after an explicit confirmation', async () => {
  const before = await page.evaluate(() => ({ id: config.mainSession.colId, gen: config.mainSession.gen }));
  page.removeAllListeners('dialog');
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  try {
    await page.evaluate(() => { terms.get(config.mainSession.colId).state = 'working'; MainSession.clearContext(); });
  } finally {
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => d.accept());
  }
  expect(asked).toContain('打断它这一轮');
  expect(asked).toContain('派出去的活不会中断');
  expect(await page.evaluate(() => ({ id: config.mainSession.colId, gen: config.mainSession.gen }))).toEqual(before);
});

test('clearing the Captain resets only its model context: work, receipts and questions carry over', async () => {
  oldCaptainId = mainId;
  const before = await page.evaluate(() => ({ gen: config.mainSession.gen, workers: columns.filter((c) => !c.isMain).map((c) => c.id) }));
  // One worker awaits confirmation, another is queued, and a question is unread.
  await run(oldCaptainId, `clear; node "${CLI}" tell --to cap-x --message "ask me before the reset"`);
  await expect.poll(() => taskOf('cap-x', 'input'), { timeout: 30000 }).toBe(true);
  await run(oldCaptainId, `clear; node "${CLI}" tell --to cap-y --message "finish after the clear"`);
  await expect.poll(() => taskOf('cap-y', 'queued'), { timeout: 15000 }).toBe(true);
  await page.evaluate(() => {
    config.mainSession.pending.push({ colId: 'cap-y', title: 'Worker y', question: '用 SQLite 可以吗', ts: Date.now() });
    config.mainSession.pending.push({ colId: 'cap-y', title: 'Worker y', summary: 'previously sent receipt not acknowledged', files: [] });
  });
  // The old model received these items, but is still waiting on a confirmation
  // and has not finished its turn. Clearing must redeliver them to the new one.
  await run(oldCaptainId, `clear; ${FAKE}`);
  await expect.poll(() => page.evaluate((i) => agentInForeground(columns.find((c) => c.id === i), false), oldCaptainId), { timeout: 15000 }).toBe(true);
  await page.evaluate((cmd) => {
    MainSession.mainCol().cmd = cmd;
    config.mainSession.cmd = cmd;
    const col = MainSession.mainCol();
    ChatUI.sendPrompt(col, 'ask me about this unfinished delivery', null, { prefix: MainSession.outgoingPrefix(col), force: true });
  }, FAKE);
  await expect.poll(() => page.evaluate((i) => terms.get(i).state, oldCaptainId), { timeout: 20000 }).toBe('input');
  expect(await page.evaluate(() => config.mainSession.inflight.length)).toBeGreaterThan(0);
  const captureStart = capturedPrompts().length;
  const messages = [];
  const spy = (d) => messages.push(d.message());
  page.on('dialog', spy);
  const col = page.locator(`.column[data-col-id="${oldCaptainId}"]`);
  await col.hover();
  await col.locator('.secondary .icon-btn').first().click();     // 清空上下文
  await expect.poll(() => page.evaluate(() => config.mainSession.gen)).toBe(before.gen + 1);
  page.off('dialog', spy);
  expect(messages.join('\n')).toContain('打断它这一轮');
  const fresh = await page.evaluate(() => config.mainSession.colId);
  expect(fresh).not.toBe(oldCaptainId);

  // workers untouched: same columns, same live terminals
  expect(await page.evaluate(() => columns.filter((c) => !c.isMain).map((c) => c.id))).toEqual(before.workers);
  for (const id of before.workers) expect(await page.evaluate((i) => window.deck.ptyIsAlive(i), id)).toBe(true);
  expect(await taskOf('cap-y', 'queued')).toBe(true);

  // the old conversation is kept on disk, listed, and not shown in the new chat
  expect(await page.evaluate(() => config.captainHistory.map((h) => h.id))).toContain(oldCaptainId);
  await expect.poll(() => fs.existsSync(path.join(profile, 'chats', `${oldCaptainId}.json`))).toBe(true);
  const freshChat = page.locator(`.column[data-col-id="${fresh}"] .chat-scroll`);
  await expect(freshChat).not.toContainText('status please');
  // unfinished work moved along as a card
  await expect(page.locator(`.column[data-col-id="${fresh}"] .task-card.st-queued`, { hasText: 'Worker y' })).toHaveCount(1);
  await expect(page.locator(`.column[data-col-id="${fresh}"] .task-card.st-input`, { hasText: 'Worker x' })).toHaveCount(1);

  // a fresh agent gets the default instructions again, plus where the old conversation is
  const received = () => capturedPrompts().slice(captureStart).join('\n');
  await expect.poll(received, { timeout: 30000 }).toContain('claude-opus-5-5-max');
  await expect.poll(received, { timeout: 15000 }).toContain(`read --id ${oldCaptainId}`);
  // then the question reaches it by itself
  await expect.poll(received, { timeout: 20000 }).toContain('向你提问：用 SQLite 可以吗');
  expect(received()).toContain('previously sent receipt not acknowledged');
  expect(received()).toContain('(y/n)');
  const text = received();
  expect(text.indexOf('claude-opus-5-5-max')).toBeLessThan(text.indexOf('向你提问：用 SQLite 可以吗'));

  // the task queued before the clear finishes now, and its receipt reaches the new Captain
  await run('cap-y', `clear; ${FAKE}`);
  const doneCard = page.locator(`.column[data-col-id="${fresh}"] .task-card`, { hasText: 'Worker y' });
  await expect(doneCard).toHaveClass(/st-done/, { timeout: 30000 });
  await expect(doneCard.locator('.task-summary')).toContainText('stand-in finished finish after the clear');
  await expect.poll(received, { timeout: 20000 }).toContain('stand-in finished finish after the clear');
});

test('the new Captain reads the old conversation on demand, through its own token', async () => {
  const fresh = await page.evaluate(() => config.mainSession.colId);
  await page.evaluate((i) => window.deck.ptyInput(i, '\x03'), fresh);    // to the shell, to type the commands
  await waitForShell(fresh);
  await run(fresh, `clear; node "${CLI}" answer --to cap-x --key y`);
  await expect.poll(() => screen(fresh), { timeout: 15000 }).toContain('按了 y');
  await expect(page.locator(`.column[data-col-id="${fresh}"] .task-card`, { hasText: 'Worker x' }).last()).not.toHaveClass(/st-input/, { timeout: 15000 });
  await run(fresh, `clear; node "${CLI}" ledger`);
  await expect.poll(() => screen(fresh), { timeout: 15000 }).toContain('清空上下文前的队长对话');
  expect(await screen(fresh)).toContain(oldCaptainId);
  await run(fresh, `clear; node "${CLI}" read --id ${oldCaptainId} --find "status please" --turns 1`);
  await expect.poll(() => screen(fresh), { timeout: 15000 }).toContain('用户：status please');
  await run(fresh, `clear; node "${CLI}" read --id captain-history --find "status please" --turns 1`);
  await expect.poll(() => screen(fresh), { timeout: 15000 }).toContain(`记录：${oldCaptainId}`);
  expect(await screen(fresh)).toContain('用户：status please');
  // other columns hold no token and are refused, like every 队长 command
  const refused = await page.evaluate((old) => MainSession.handle({ action: 'main-read', to: old }, columns.find((c) => c.id === 'cap-x'))
    .then(() => 'allowed', (e) => e.message), oldCaptainId);
  expect(refused).toContain('只有队长');
});


test('a restored Captain gets the current provider and effort instructions', async () => {
  const id = await page.evaluate(() => config.mainSession.colId);
  const captureStart = capturedPrompts().length;
  await page.evaluate(({ id, cmd }) => {
    columns.find((c) => c.id === id).cmd = cmd;
    config.mainSession.cmd = cmd;
    flushConfig();
  }, { id, cmd: FAKE });
  await application.close();
  application = null;
  await launch();
  await expect.poll(() => capturedPrompts().slice(captureStart).join('\n'), { timeout: 30000 }).toContain('claude-opus-5-5-max');
  await expect.poll(() => capturedPrompts().slice(captureStart).join('\n'), { timeout: 15000 }).toContain('gemini-3.8-flash-high');
});

test('after a restart the conversation from before the clear is still listed and readable', async () => {
  const id = await page.evaluate(() => config.mainSession.colId);
  expect(await page.evaluate(() => config.captainHistory.map((h) => h.id))).toContain(oldCaptainId);
  expect(fs.existsSync(path.join(profile, 'chats', `${oldCaptainId}.json`))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(profile, 'chats', `${oldCaptainId}.json`), 'utf8')).captainArchive).toBe(true);
  // the cards that moved to the new Captain kept their receipts
  await expect(page.locator(`.column[data-col-id="${id}"] .task-card.st-done`, { hasText: 'Worker y' })).toHaveCount(1);
  // let the restarted stand-in finish taking its receipts before leaving it for the shell
  await expect.poll(() => page.evaluate(() => config.mainSession.pending.length), { timeout: 20000 }).toBe(0);
  await expect.poll(() => page.evaluate((i) => ChatUI.turnsOf(i).every((t) => t.done), id), { timeout: 20000 }).toBe(true);
  await page.evaluate((i) => window.deck.ptyInput(i, '\x03'), id);
  await waitForShell(id);
  await run(id, `clear; node "${CLI}" read --id ${oldCaptainId} --find "status please" --turns 1`);
  await expect.poll(() => screen(id), { timeout: 15000 }).toContain('用户：status please');
  // Old files remain searchable even after their compact ledger metadata drops
  // out of the list. This runs after loading the chats from disk again.
  await page.evaluate(() => { config.captainHistory = []; });
  await run(id, `clear; node "${CLI}" read --id captain-history --find "status please" --turns 1`);
  await expect.poll(() => screen(id), { timeout: 15000 }).toContain(`记录：${oldCaptainId}`);
  expect(await screen(id)).toContain('用户：status please');
});
