const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 队长 (Captain, the main session). Its column runs a plain shell here, and the
// test types the real control commands into it, the same ones the agent would
// run. The columns it drives run a stand-in agent that submits command receipts.
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
  const env = { ...process.env, AGENTDECK_DEMO_FILE: demoFile, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'received-prompts.jsonl'), AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'received-columns.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).not.toHaveCount(0);
  await page.evaluate(() => columns.forEach((col) => ChatUI.setMode(col.id, 'chat')));
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
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('there is one Captain: the sidebar entry creates it first, then just returns to it', { tag: '@smoke' }, async () => {
  await page.locator('.nav-row[data-nav="captain"]').click();
  await expect(page.locator('#mainDialog')).toBeVisible();
  await page.locator('#mdCmd').fill('');           // a plain shell stands in for the agent
  await page.locator('#mdCwd').fill(profile);
  await page.locator('#mdCreate').click();
  await expect(page.locator('.column.is-main')).toHaveCount(1);
  mainId = await page.evaluate(() => config.mainSession.colId);
  expect(await page.evaluate(() => deckEl.querySelector('.column').dataset.colId)).toBe(mainId);
  // a protected row of its own, first in the session list, without archive/delete actions
  const row = page.locator(`.colnav-item.captain-item[data-col-id="${mainId}"]`);
  await expect(row).toHaveCount(1);
  expect(await page.evaluate(() => document.querySelector('#navList .colnav-item').dataset.colId)).toBe(mainId);
  await expect(row.locator('.cn-actions')).toHaveCount(0);
  await expect.poll(() => page.evaluate((i) => window.deck.ptyIsAlive(i), mainId)).toBe(true);
  await page.locator('.colnav-item[data-col-id="cap-y"]').click();
  await page.locator('.nav-row[data-nav="captain"]').click();
  await expect(page.locator('#mainDialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe(mainId);
  // the list row selects it too and opens the terminal by default
  await page.locator('.colnav-item[data-col-id="cap-y"]').click();
  await page.evaluate((i) => ChatUI.setMode(i, 'term'), mainId);
  await row.click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe(mainId);
  await expect(page.locator(`.column[data-col-id="${mainId}"]`)).not.toHaveClass(/chat-mode/);
  await expect(page.locator('#mainDialog')).toBeHidden();
  expect(await page.evaluate(() => columns.filter((c) => c.isMain).length)).toBe(1);
  await expect(page.locator('.colnav-item.captain-item')).toHaveCount(1);
});

// (moveSession refusing 队长 is covered by the sidebar-core unit test)
test('the Captain row cannot be dragged into a folder or onto the archive, nor archived', async () => {
  const folder = await page.evaluate(() => Sidebar.createFolder(false).id);
  const row = page.locator('.colnav-item.captain-item');
  const first = () => page.evaluate(() => ({ id: columns[0].id, folderId: columns[0].folderId || null, deck: deckEl.querySelector('.column').dataset.colId }));
  for (const target of [`.nav-folder-head[data-folder-id="${folder}"]`, '.nav-section[data-section="archived"]']) {
    const from = await row.boundingBox();
    const to = await page.locator(target).boundingBox();
    await page.mouse.move(from.x + 30, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    expect(await first()).toEqual({ id: mainId, folderId: null, deck: mainId });
  }
  await page.evaluate(() => archiveColumn(MainSession.mainCol()));
  expect(await page.evaluate(() => [columns.filter((c) => c.isMain).length, (config.archived || []).length])).toEqual([1, 0]);
  await expect(page.locator(`#navList .colnav-item.captain-item[data-col-id="${mainId}"]`)).toHaveCount(1);
});

test('new: a fresh column gets the task as its first message, and the receipt comes back', { tag: '@smoke' }, async () => {
  // --command keeps the new column on the stand-in, never a real agent
  await run(mainId, `node "${CLI}" new --title "写周报" --task "please write the report" --command "${FAKE.replace(/"/g, '')}"`);
  await expect.poll(() => page.evaluate(() => columns.some((c) => c.displayTitle === '写周报'))).toBe(true);
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === '写周报').id);
  // it runs in the background: counts and a folding arrow on the Captain row
  const head = page.locator('.captain-item .crew-counts');
  await expect(head).not.toContainText('后台');
  await expect(page.locator('.nav-crew .crew-head')).toHaveCount(0);
  await expect(page.locator('.captain-item .captain-fold')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator(`.nav-crew .colnav-item[data-col-id="${child}"]`)).toHaveCount(0);
  await expect(page.locator(`.column[data-col-id="${child}"]`)).toHaveClass(/backstage/);
  expect(await page.evaluate((i) => deckColumns().some((c) => c.id === i), child)).toBe(false);
  const card = page.locator(`.column[data-col-id="${mainId}"] .task-card`).first();
  await expect(card).toContainText('写周报');
  // the task is the child's first user message; the receipt contract rides along unseen
  await expect(page.locator(`.column[data-col-id="${child}"] .msg.user .bubble`).first()).toHaveText('please write the report', { timeout: 30000 });
  await expect(card).toHaveClass(/st-done/, { timeout: 30000 });
  await expect(card.locator('.task-summary')).toContainText('stand-in finished please write the report');
  await expect(card.locator('.att')).toHaveAttribute('title', demoFile);
  expect(await page.evaluate((i) => columns.find((c) => c.id === i).lastReceipt.files, child)).toEqual([demoFile]);
  await expect(head).toContainText('1 完成');
  // The terminal is the default view; open chat explicitly to use its card.
  await page.evaluate((id) => ChatUI.setMode(id, 'chat'), mainId);
  // clicking the card's title opens it right after the Captain
  await card.locator('.task-title').click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe(child);
  await expect(page.locator(`.column[data-col-id="${child}"]`)).not.toHaveClass(/backstage/);
  expect(await page.evaluate(() => deckColumns().slice(0, 2).map((c) => c.id))).toEqual([mainId, child]);
  // and it goes back once you move on
  await page.locator('.colnav-item[data-col-id="cap-y"]').click();
  await expect(page.locator(`.column[data-col-id="${child}"]`)).toHaveClass(/backstage/);
  await test.step('new allows verified agy legacy models without starting a real model', async () => {
    const commands = await page.evaluate(async () => {
      const createSession = deckHost.createSession, commands = [];
      // Exercise the real new gate, then intercept before any PTY starts.
      deckHost.createSession = (col) => { commands.push(col.cmd); throw new Error('smoke-intercept-session'); };
      try {
        for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
          try {
            await MainSession.handle({ action: 'main-new', id: `smoke-${model}`, title: model, task: 'stand-in only',
              command: `agy --model ${model} --effort high` }, MainSession.mainCol());
          } catch (error) { if (error.message !== 'smoke-intercept-session') throw error; }
        }
      } finally { deckHost.createSession = createSession; }
      return commands;
    });
    expect(commands).toEqual(['agy --model claude-sonnet-4-6', 'agy --model claude-opus-4-6-thinking']);
  });
});

test('tell, ledger and read from the Captain terminal; a worker stuck on a confirmation goes to the Captain', { tag: '@smoke' }, async () => {
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

test('a session the Captain only told something keeps its place; its own sessions leave and come back by drag', async () => {
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === '写周报').id);
  const crew = (id) => page.locator(`.nav-crew .colnav-item[data-col-id="${id}"]`);
  // the Captain arrow unfolds its crew
  await page.locator('.captain-item .captain-fold').click();
  await expect(crew(child)).toHaveCount(1);
  await expect(crew('cap-x')).toHaveCount(0);
  await expect(page.locator('.nav-group:not(.nav-crew) .colnav-item[data-col-id="cap-x"]')).toHaveCount(1);
  const drag = async (from, to) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await page.mouse.move(a.x + 30, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
  };
  await drag(crew(child), page.locator('.nav-section[data-section="loose"]'));
  await expect(crew(child)).toHaveCount(0);
  // out of the background: an ordinary session with its own deck column
  expect(await page.evaluate((i) => [columns.find((c) => c.id === i).captainCrew, deckColumns().some((c) => c.id === i)], child)).toEqual([false, true]);
  await page.locator('.colnav-item[data-col-id="cap-y"]').click();
  await expect(page.locator(`.column[data-col-id="${child}"]`)).not.toHaveClass(/backstage/);
  // With no crew, the disabled arrow must still let a drop reach the Captain row.
  await expect(page.locator('.captain-item .captain-fold')).toBeDisabled();
  await drag(page.locator(`.colnav-item[data-col-id="${child}"]`), page.locator('.colnav-item.captain-item'));
  await expect(crew(child)).toHaveCount(1);
  expect(await page.evaluate(() => [...deckEl.querySelectorAll('.column')][1].dataset.colId)).toBe(child);
  await expect(page.locator(`.column[data-col-id="${child}"]`)).toHaveClass(/backstage/);
});

test('new refuses unapproved old Claude models before any session starts, and says what to use', async () => {
  const before = await page.evaluate(() => columns.length);
  await run(mainId, `clear; node "${CLI}" new --title "旧模型" --task "x" --command "agy --model claude-sonnet-4-5-20250929"`);
  await expect.poll(() => screen(mainId), { timeout: 15000 }).toContain('用户不用 claude-sonnet-4-5-20250929');
  await expect.poll(() => screen(mainId)).toContain('gemini-3.8-flash-high');
  expect(await page.evaluate(() => columns.length)).toBe(before);
});

test('past the limit new work waits for a slot; finished background sessions are archived and tell brings them back', async () => {
  const STAND_IN = FAKE.replace(/"/g, '');
  const col = (title) => page.evaluate((t) => columns.find((c) => c.displayTitle === t)?.id || null, title);
  const card = (title) => page.locator(`.column[data-col-id="${mainId}"] .task-card`, { hasText: title }).last();
  await page.evaluate(() => { MainCore.MAX_ACTIVE = 1; });
  try {
    // one at work (stopped on a question), so the next one waits
    await run(mainId, `clear; node "${CLI}" new --title "甲" --task "ask me first" --command "${STAND_IN}"`);
    await expect(card('甲')).toHaveClass(/st-input/, { timeout: 30000 });
    await run(mainId, `clear; node "${CLI}" new --title "乙" --task "second job" --command "${STAND_IN}"`);
    await expect.poll(() => screen(mainId), { timeout: 15000 }).toContain('已排队');
    await expect(card('乙')).toHaveClass(/st-waiting/);
    await expect(card('乙')).toContainText('等空位');
    expect(await col('乙')).toBe(null);
    await expect(page.locator('.captain-item .crew-counts')).toHaveAttribute('title', /1 排队/);
    // unfolded: work in progress on top, then what waits for a slot, finished ones below
    const a0 = await col('甲');
    const keep0 = await col('写周报');
    if (!(await page.evaluate(() => !!config.crewOpen))) await page.locator('.captain-item .captain-fold').click();
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.nav-crew > .colnav-item')]
      .map((r) => r.dataset.colId || 'waiting:' + r.querySelector('.cn-label').textContent)))
      .toEqual([a0, 'waiting:乙', keep0]);
    // a session that is working (here: stopped on a question) is never archived, and never asks
    const a = await col('甲');
    const asked = [];
    const spy = (d) => asked.push(d.message());
    page.on('dialog', spy);
    await page.evaluate((i) => archiveColumn(columns.find((c) => c.id === i)), a);
    await page.evaluate((i) => archiveColumn(columns.find((c) => c.id === i), { quiet: true }), a);
    page.off('dialog', spy);
    expect(asked).toEqual([]);
    expect(await page.evaluate((i) => columns.some((c) => c.id === i) && !(config.archived || []).some((x) => x.id === i), a)).toBe(true);
    // the slot frees up when it is closed: the waiting work gets its session and its receipt
    await page.evaluate((i) => removeCol(columns.find((c) => c.id === i)), a);
    await expect(card('乙')).toHaveClass(/st-done/, { timeout: 30000 });
    const b = await col('乙');
    expect(await page.evaluate((i) => columns.find((c) => c.id === i).captainCrew, b)).toBe(true);
    expect(await page.evaluate(() => config.mainSession.waitlist.length)).toBe(0);
  } finally {
    await page.evaluate(() => { MainCore.MAX_ACTIVE = 15; });
  }
  // finished and quiet: archived by itself, conversation kept (one you are looking at stays)
  const b = await col('乙');
  const keep = await col('写周报');
  await page.evaluate((i) => jumpToColumn(columns.find((c) => c.id === i)), keep);
  // a receipt 队长 has not read yet keeps it (this 队长 is a bare shell that never reads them)
  await page.evaluate(() => { MainCore.ARCHIVE_AFTER = 0; });
  await page.waitForTimeout(3500);
  expect(await page.evaluate((i) => columns.some((c) => c.id === i), b)).toBe(true);
  await page.evaluate(() => { config.mainSession.pending = []; config.mainSession.inflight = []; });
  try {
    await expect.poll(() => page.evaluate((i) => (config.archived || []).some((x) => x.id === i && x.captainCrew), b), { timeout: 15000 }).toBe(true);
  } finally {
    await page.evaluate(() => { MainCore.ARCHIVE_AFTER = 10 * 60_000; });
  }
  expect(await col('写周报')).toBe(keep);
  await run(mainId, `clear; node "${CLI}" ledger`);
  await expect.poll(() => screen(mainId), { timeout: 15000 }).toContain('已归档的队员');
  // tell brings it back and the work goes in
  await run(mainId, `clear; node "${CLI}" tell --to ${b} --message "one more thing"`);
  await expect.poll(() => screen(mainId), { timeout: 15000 }).toContain('已恢复');
  await expect.poll(() => col('乙'), { timeout: 15000 }).toBe(b);
  await expect(card('乙')).toHaveClass(/st-done/, { timeout: 30000 });
  await expect(card('乙').locator('.task-summary')).toContainText('stand-in finished one more thing');
});

test('Captain stop interrupts a busy worker, cancels supplements; archive ends it without a dialog and keeps history', async () => {
  let dialogs = 0;
  const countDialog = () => { dialogs++; };
  page.on('dialog', countDialog);
  await run(mainId, `clear; node "${CLI}" new --title "中断归档" --task "keep working stop probe" --command "${FAKE.replace(/"/g, '')} --interruptible"`);
  const childOf = () => page.evaluate(() => columns.find((c) => c.displayTitle === '中断归档')?.id);
  await expect.poll(childOf).toBeTruthy();
  const child = await childOf();
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.state, child)).toBe('working');
  await run(mainId, `clear; node "${CLI}" tell --to ${child} --message "cancel this supplement"`);
  await expect.poll(() => page.evaluate((i) => config.mainSession.tasks.filter((t) => t.colId === i && t.status === 'queued').length, child)).toBe(1);
  await expect(page.locator('.captain-item .crew-counts')).toHaveAttribute('title', /1 待补充/);
  await run(mainId, `clear; node "${CLI}" stop --id ${child}`);
  await expect.poll(() => screen(child)).toContain('Interrupted by Esc');
  expect(await page.evaluate((i) => window.deck.ptyIsAlive(i), child)).toBe(true);
  await page.waitForTimeout(2000);
  expect(capturedPrompts().some((p) => p.startsWith('cancel this supplement'))).toBe(false);
  await run(mainId, `clear; node "${CLI}" tell --to ${child} --message "keep working archive probe"`);
  await expect.poll(() => screen(child)).toContain('Doing…');
  await run(mainId, `clear; node "${CLI}" archive --id ${child}`);
  await expect.poll(() => childOf()).toBeFalsy();
  expect(await page.evaluate((i) => window.deck.ptyIsAlive(i), child)).toBe(false);
  expect(await page.evaluate((i) => config.archived.some((c) => c.id === i), child)).toBe(true);
  expect(await page.evaluate((i) => ChatUI.turnsOf(i).some((t) => t.user.includes('keep working')), child)).toBe(true);
  expect(dialogs).toBe(0);
  page.off('dialog', countDialog);
  for (const action of ['main-stop', 'main-archive']) {
    const errors = await page.evaluate(async ([action, captain]) => {
      const invoke = async (caller, to) => { try { await MainSession.handle({ action, to }, caller); return ''; } catch (e) { return e.message; } };
      return [await invoke(columns.find((c) => c.id === 'cap-x'), 'cap-y'), await invoke(MainSession.mainCol(), captain), await invoke(MainSession.mainCol(), 'missing-id')];
    }, [action, mainId]);
    expect(errors[0]).toContain('只有队长'); expect(errors[1]).toContain('不能中断或归档队长'); expect(errors[2]).toContain('找不到');
  }
});

test('tell batches supplements once; replace drops older queued work; now interrupts then sends', async () => {
  await run(mainId, `clear; node "${CLI}" new --title "合并指令" --task "keep working merge probe" --command "${FAKE.replace(/"/g, '')} --interruptible"`);
  await expect.poll(() => page.evaluate(() => columns.find((c) => c.displayTitle === '合并指令')?.id)).toBeTruthy();
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === '合并指令').id);
  await expect.poll(() => screen(child)).toContain('Doing…');
  const queuedCount = () => page.evaluate((i) => config.mainSession.tasks.filter((t) => t.colId === i && t.status === 'queued').length, child);
  let queued = 0;
  for (const message of ['merge alpha', 'merge beta', 'merge gamma']) {
    await run(mainId, `clear; node "${CLI}" tell --to ${child} --message "${message}"`);
    await expect.poll(queuedCount).toBe(++queued);
    await waitForShell(mainId);
    await expect.poll(() => screen(mainId)).toContain('待补充');
  }
  // The stand-in finishes its current operation; the three additions arrive as one prompt.
  await page.evaluate((i) => window.deck.ptyInput(i, '\x1b'), child);
  await expect.poll(() => capturedPrompts().filter((p) => p.startsWith('merge alpha')).length).toBe(1);
  const merged = capturedPrompts().find((p) => p.startsWith('merge alpha'));
  expect(merged).toContain('merge alpha\n\nmerge beta\n\nmerge gamma');
  expect(merged.split('（AgentDeck 约定）')).toHaveLength(2);
  expect(capturedPrompts().some((p) => p.startsWith('merge beta') || p.startsWith('merge gamma'))).toBe(false);
  await expect.poll(() => page.evaluate((i) => config.mainSession.tasks.filter((t) => t.colId === i).at(-1)?.status, child), { timeout: 30000 }).toBe('done');
  await run(mainId, `clear; node "${CLI}" tell --to ${child} --now --message "keep working replace probe"`);
  await expect.poll(() => screen(child)).toContain('keep working replace probe');
  // A prompt can appear before the status loop has observed the busy screen.
  await expect.poll(() => page.evaluate((i) => {
    const entry = terms.get(i);
    return entry?.state === 'working' && MainCore.terminalActivity(entry.lastScreen) === 'working';
  }, child), { timeout: 15000 }).toBe(true);
  queued = 0;
  for (const message of ['discard alpha', 'discard beta']) {
    await run(mainId, `clear; node "${CLI}" tell --to ${child} --message "${message}"`);
    await expect.poll(queuedCount).toBe(++queued);
    await waitForShell(mainId);
    await expect.poll(() => screen(mainId)).toContain('待补充');
  }
  await run(mainId, `clear; node "${CLI}" tell --to ${child} --replace --message "replacement only"`);
  await expect.poll(() => page.evaluate((i) => config.mainSession.tasks.filter((t) => t.colId === i && t.status === 'queued').length, child)).toBe(1);
  await waitForShell(mainId);
  await page.evaluate((i) => window.deck.ptyInput(i, '\x1b'), child);
  await expect.poll(() => capturedPrompts().some((p) => p.startsWith('replacement only'))).toBe(true);
  expect(capturedPrompts().some((p) => /^(discard alpha|discard beta)/.test(p))).toBe(false);
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.state, child)).toBe('done');
  await run(mainId, `clear; node "${CLI}" tell --to ${child} --message "keep working now probe"`);
  await expect.poll(() => screen(child)).toContain('keep working now probe');
  // A prompt can appear before the status loop has observed the busy screen.
  await expect.poll(() => page.evaluate((i) => {
    const entry = terms.get(i);
    return entry?.state === 'working' && MainCore.terminalActivity(entry.lastScreen) === 'working';
  }, child), { timeout: 15000 }).toBe(true);
  await run(mainId, `clear; node "${CLI}" tell --to ${child} --message "discard with now"`);
  await expect.poll(queuedCount).toBe(1);
  await waitForShell(mainId);
  await expect.poll(() => screen(mainId)).toContain('待补充');
  await run(mainId, `clear; node "${CLI}" tell --to ${child} --replace --now --message "urgent replacement"`);
  await expect.poll(() => capturedPrompts().filter((p) => p.startsWith('urgent replacement')).length).toBe(1);
  expect(capturedPrompts().some((p) => p.startsWith('discard with now'))).toBe(false);
  expect(await page.evaluate((i) => window.deck.ptyIsAlive(i), child)).toBe(true);
  await run(mainId, `clear; node "${CLI}" archive --id ${child}`);
  await expect.poll(() => page.evaluate((i) => columns.some((c) => c.id === i), child)).toBe(false);
});

test('quota generates a failure receipt; queued work still waits for the quota screen to clear', async () => {
  await run(mainId, `clear; node "${CLI}" new --title "额度等待" --task "wait for quota probe" --command "${FAKE.replace(/"/g, '')} --interruptible"`);
  await expect.poll(() => page.evaluate(() => columns.find((c) => c.displayTitle === '额度等待')?.id)).toBeTruthy();
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === '额度等待').id);
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.state, child)).toBe('quota');
  const card = page.locator(`.column[data-col-id="${mainId}"] .task-card`, { hasText: '额度等待' }).last();
  await expect(card.locator('.task-status')).toHaveText('没做成');
  await expect(card.locator('.task-failed')).toContainText("You've hit your limit");
  await expect(page.locator('.captain-item .crew-counts')).toHaveAttribute('title', /额度用尽\/等待/);
  await run(mainId, `clear; node "${CLI}" ledger`);
  await expect.poll(() => screen(mainId)).toContain('额度用尽/等待');
  await run(mainId, `clear; node "${CLI}" tell --to ${child} --message "after quota"`);
  await expect.poll(() => screen(mainId)).toContain('待补充');
  const status = await page.evaluate((i) => {
    const entry = terms.get(i); const t = config.mainSession.tasks.find((t) => t.colId === i && t.status === 'failed');
    t.idleSince = Date.now() - 600000;
    MainSession.onTick(i, { ...entry, lastOutputAt: Date.now() - 600000 });
    return t.status;
  }, child);
  expect(status).toBe('failed');
  expect(capturedPrompts().some((p) => p.startsWith('after quota'))).toBe(false);
  await page.evaluate((i) => window.deck.ptyInput(i, '\x1b'), child);
  await expect.poll(() => capturedPrompts().filter((p) => p.startsWith('after quota')).length).toBe(1);
  await run(mainId, `clear; node "${CLI}" archive --id ${child}`);
  await expect.poll(() => page.evaluate((i) => columns.some((c) => c.id === i), child)).toBe(false);
});

test('a dispatched paste waits for the TUI before Enter and reaches the worker exactly once', async () => {
  await run(mainId, `clear; node "${CLI}" new --title "慢粘贴" --task "delayed paste task" --command "${FAKE.replace(/"/g, '')} --slow-paste"`);
  await expect.poll(() => page.evaluate(() => columns.find((c) => c.displayTitle === '慢粘贴')?.id), { timeout: 15000 }).toBeTruthy();
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === '慢粘贴').id);
  const card = page.locator(`.column[data-col-id="${mainId}"] .task-card`, { hasText: '慢粘贴' });
  await expect(card).toHaveClass(/st-done/, { timeout: 30000 });
  const replay = await page.evaluate((i) => window.deck.ptyReplay(i), child);
  expect(replay).not.toContain('Enter consumed by paste detector');
  expect(capturedPrompts().filter((p) => p.startsWith('delayed paste task'))).toHaveLength(1);
  await expect(card.locator('.task-summary')).toContainText('stand-in finished delayed paste task');
  await page.evaluate((i) => archiveColumn(columns.find((c) => c.id === i)), child);
});

test('work for a session stopped on a startup dialog (Cursor: trust this workspace) is not lost: the Captain is told and answers', async () => {
  const STAND_IN = FAKE.replace(/"/g, '');
  await run(mainId, `clear; node "${CLI}" new --title "要信任" --task "work after the trust dialog" --command "${STAND_IN} --trust-dialog"`);
  await expect.poll(() => page.evaluate(() => columns.find((c) => c.displayTitle === '要信任')?.id), { timeout: 15000 }).toBeTruthy();
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === '要信任').id);
  // the dialog is not an idle prompt: nothing is typed into it, and 队长 hears about it once
  await expect.poll(() => page.evaluate(() => config.mainSession.pending.map((p) => p.waiting || '').join('\n')), { timeout: 30000 }).toContain('Trust this workspace');
  await page.waitForTimeout(4000);
  expect(capturedPrompts().filter((p) => p.startsWith('work after the trust dialog'))).toHaveLength(0);
  expect(await page.evaluate((i) => config.mainSession.pending.filter((p) => p.colId === i && p.waiting).length, child)).toBe(1);
  // answered with Enter: the dialog goes away and the task goes in
  await run(mainId, `clear; node "${CLI}" answer --to ${child} --key enter`);
  const card = page.locator(`.column[data-col-id="${mainId}"] .task-card`, { hasText: '要信任' });
  await expect(card).toHaveClass(/st-done/, { timeout: 40000 });
  expect(capturedPrompts().filter((p) => p.startsWith('work after the trust dialog'))).toHaveLength(1);
  await page.evaluate((i) => { config.mainSession.pending = config.mainSession.pending.filter((p) => p.colId !== i); config.mainSession.inflight = config.mainSession.inflight.filter((p) => p.colId !== i); archiveColumn(columns.find((c) => c.id === i)); }, child);
});

test('legacy injection opt-in: receipts and questions reach an idle Captain, never a bare shell', async () => {
  await page.evaluate(() => { config.mainSession.legacyReceiptInjection = true; });
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
  // A user can start submitting while the async foreground check is in flight.
  // That check must not drain new receipts when sendPrompt would refuse them.
  const concurrent = await page.evaluate(async (i) => {
    const entry = terms.get(i);
    config.mainSession.pending.push({ colId: 'cap-y', title: 'Worker y', summary: 'queued during submission', files: [] });
    const before = config.mainSession.pending.length;
    entry.state = 'plain'; entry.lastOutputAt = 0;
    MainSession.onTick(i, entry);
    entry.sendingPrompt = true;
    try {
      await window.deck.ptyForeground(i);    // let the earlier async check finish
      return { before, after: config.mainSession.pending.length };
    } finally { entry.sendingPrompt = false; entry.lastOutputAt = Date.now(); }
  }, mainId);
  expect(concurrent.after).toBe(concurrent.before);
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

test('a receipt never goes through an input box the user is typing in, and arrives once it is empty', async () => {
  // ASCII, so what the stand-in captured compares the same on every platform
  const half = 'my half written sentence';
  const first = capturedPrompts().length;
  const receipt = 'receipt that waits for the user';
  // nothing else may be waiting: the receipt left from the previous test would be delivered while the box is still empty
  await page.evaluate(() => { config.mainSession.pending = []; MainSession.mainCol().cmd = 'stand-in'; });
  await run(mainId, `clear; ${FAKE}`);
  if (process.platform === 'win32') {
    await expect.poll(() => page.evaluate((i) => agentInForeground(columns.find((c) => c.id === i), false), mainId), { timeout: 15000 }).toBe(true);
  } else {
    await expect.poll(() => page.evaluate((i) => window.deck.ptyForeground(i), mainId), { timeout: 15000 }).toBe('node');
  }
  // typing in the terminal view, like a person: half a message, no Enter. ConPTY
  // drops keys typed in the first moments after a console program starts reading.
  await page.waitForTimeout(2500);
  await page.evaluate((i) => { ChatUI.setMode(i, 'term'); focusColumnInput(i); }, mainId);
  await page.keyboard.type(half);
  await expect.poll(() => page.evaluate((i) => terms.get(i).typing.draft, mainId)).toBe(half);
  await page.evaluate((text) => {
    config.mainSession.pending.push({ colId: 'cap-y', title: 'Worker y', summary: text, files: [] });
  }, receipt);
  // well past the quiet period and several status ticks: nothing was typed or sent
  await page.waitForTimeout(8000);
  expect(await page.evaluate(() => config.mainSession.pending.some((p) => p.summary === 'receipt that waits for the user'))).toBe(true);
  expect(await page.evaluate(() => config.mainSession.inflight.length)).toBe(0);
  expect(capturedPrompts().slice(first)).toEqual([]);
  // still hers/his after a long wait too: the draft alone blocks, not only recent keys
  await page.evaluate((i) => { terms.get(i).typing.lastKeyAt = 0; }, mainId);
  await page.waitForTimeout(4000);
  expect(capturedPrompts().slice(first)).toEqual([]);
  // the user's own Enter sends the user's words alone, no receipt rides on it
  await page.keyboard.press('Enter');
  await expect.poll(() => capturedPrompts().slice(first).join('\n'), { timeout: 15000 }).toContain(half);
  expect(capturedPrompts().slice(first).join('\n')).not.toContain(receipt);
  // box empty and quiet: now the receipt is delivered, as its own message
  await expect.poll(() => capturedPrompts().slice(first).some((p) => p.includes(receipt)), { timeout: 30000 }).toBe(true);
  const sent = capturedPrompts().slice(first);
  expect(sent.find((p) => p.includes(receipt))).not.toContain(half);
  expect(await page.evaluate(() => config.mainSession.pending.length)).toBe(0);
  // Ctrl+U clears the draft, so that blocks nothing either
  await page.keyboard.type('another unfinished thought');
  await page.keyboard.press('Control+u');
  expect(await page.evaluate((i) => terms.get(i).typing.draft, mainId)).toBe('');
  await page.evaluate((i) => { ChatUI.setMode(i, 'chat'); }, mainId);
  await page.evaluate((i) => window.deck.ptyInput(i, '\x03'), mainId);   // back to the shell for the next tests
  await waitForShell(mainId);
  await page.evaluate(() => { MainSession.mainCol().cmd = ''; config.mainSession.pending.push({ colId: 'cap-y', title: 'Worker y', summary: 'kept for your next message', files: [] }); });
});

test('keys typed while a receipt is being entered are held and follow it; the box on screen counts too', async () => {
  const state = await page.evaluate(() => {
    const entry = terms.get('cap-y');
    entry.injecting = true;
    entry.term.input('held', true);
    const during = entry.typing.draft;
    entry.injecting = false;
    entry.flushHeld();
    const after = entry.typing.draft;
    entry.term.input('\x15', true);
    return { during, after, cleared: entry.typing.draft };
  });
  expect(state).toEqual({ during: '', after: 'held', cleared: '' });
  // a box with text on screen blocks even when the tracker saw nothing (the agent restored it itself)
  const read = (screenText) => page.evaluate(async (text) => {
    const entry = terms.get('cap-y');
    entry.typing.lastKeyAt = 0; entry.typing.unknown = false; entry.typing.draft = '';
    entry.term.reset();
    await new Promise((resolve) => entry.term.write(text, resolve));
    return userComposing('cap-y');
  }, screenText);
  const rule = '─'.repeat(30);
  expect(await read(`⏺ done\r\n${rule}\r\n> half a sentence\r\n${rule}\r\n`)).toBe(true);
  expect(await read(`⏺ done\r\n${rule}\r\n> \x1b[2mTry "fix the bug"\x1b[0m\r\n${rule}\r\n`)).toBe(false);
  expect(await read(`⏺ done\r\n${rule}\r\n> \r\n${rule}\r\n`)).toBe(false);
  // a history recall (Up arrow) cannot be followed by the tracker; an empty box on screen settles it
  expect(await page.evaluate(() => {
    const entry = terms.get('cap-y');
    entry.term.input('\x1b[A', true);
    return entry.typing.unknown;
  })).toBe(true);
  await page.evaluate(() => { terms.get('cap-y').typing.lastKeyAt = 0; });
  expect(await page.evaluate(() => userComposing('cap-y'))).toBe(false);
  await page.evaluate(() => terms.get('cap-y').term.reset());
});

test('screen receipts and questions never settle tasks; only ended turns get a three-minute fallback', async () => {
  const before = await page.evaluate(() => ({ pending: config.mainSession.pending.length, tasks: config.mainSession.tasks.length }));
  const probe = await page.evaluate(() => {
    const s = config.mainSession;
    const mk = (id, turn) => { const t = { id, colId: 'probe-col', title: 'Probe', gen: s.gen, status: 'working', sentAt: Date.now(), startedAt: Date.now(), turnId: turn, receipt: null }; s.tasks.push(t); return t; };
    const out = {};
    const quiet = (extra) => ({ alive: true, state: 'done', lastOutputAt: Date.now(), lastScreen: '', ...extra });
    // the turn ended between two instructions: no receipt in the reply
    const a = mk('probe-a', 'ta');
    MainSession.onTurnDone('probe-col', { id: 'ta', reply: '先看了一下目录，接着改。' });
    out.afterEarlyTurnEnd = a.status;
    MainSession.onTick('probe-col', quiet({}));
    out.afterShortQuiet = a.status;
    // A later screen-only receipt is still ignored, even after 10 seconds quiet.
    a.idleSince = Date.now() - 10_000;
    MainSession.onTick('probe-col', quiet({ lastOutputAt: Date.now() - 10_000, lastScreen: `${'─'.repeat(20)}\n  【回执】\n  摘要：后来才做完\n  文件：无\n` }));
    out.screenReceipt = [a.status, a.receipt && a.receipt.summary, a.receipt && a.receipt.explicit];
    // Screen-only questions and failures cannot end it either.
    const b = mk('probe-b', 'tb');
    MainSession.onTurnDone('probe-col', { id: 'tb', reply: '【提问】\n问题：用哪个库？' });
    out.question = b.status;
    const c = mk('probe-c', 'tc');
    MainSession.onTurnDone('probe-col', { id: 'tc', reply: '【回执】\n摘要：没成\n文件：无\n失败：没有权限' });
    out.failure = c.status;
    // An ended turn with no command receipt gets only the no-receipt notice.
    const d = mk('probe-d', 'td');
    d.endedAt = Date.now() - 10 * 60_000;
    MainSession.onTick('probe-col', quiet({ lastOutputAt: Date.now() - 10 * 60_000 }));
    out.longQuiet = [d.status, d.receipt && d.receipt.explicit];
    // still printing: never
    const e = mk('probe-e', 'te');
    e.idleSince = Date.now() - 10 * 60_000;
    MainSession.onTick('probe-col', quiet({ lastOutputAt: Date.now() - 30_000 }));
    out.stillPrinting = e.status;
    const f = mk('probe-f', 'tf');
    f.idleSince = Date.now() - 10 * 60_000;
    MainSession.onTick('probe-col', quiet({ lastOutputAt: Date.now() - 10 * 60_000, lastScreen: '✻ Doing…\nPress up to edit queued messages\nClaude Code' }));
    out.stillDoing = f.status;
    const g = mk('probe-g', 'tg');
    MainSession.onTurnDone('probe-col', { id: 'tg', reply: '【提问】\n问题：一两句话说清要队长决定什么' });
    out.contractQuestion = g.status;
    return out;
  });
  expect(probe.afterEarlyTurnEnd).toBe('working');
  expect(probe.afterShortQuiet).toBe('working');
  expect(probe.screenReceipt).toEqual(['working', null, null]);
  expect(probe.question).toBe('working');
  expect(probe.failure).toBe('working');
  expect(probe.longQuiet).toEqual(['stopped', false]);
  expect(probe.stillPrinting).toBe('working');
  expect(probe.stillDoing).toBe('working');
  expect(probe.contractQuestion).toBe('working');
  // the false "已停下，没有写回执" never reached 队长 for the pause
  const texts = await page.evaluate(() => config.mainSession.pending.map((p) => p.summary || p.question || p.failed || ''));
  expect(texts.join('\n')).not.toContain('先看了一下目录');
  await page.evaluate(() => {
    const s = config.mainSession;
    s.tasks = s.tasks.filter((t) => !t.id.startsWith('probe-'));
    s.pending = s.pending.filter((p) => !p.taskId?.startsWith('probe-'));
  });
  expect(await page.evaluate(() => ({ pending: config.mainSession.pending.length, tasks: config.mainSession.tasks.length }))).toEqual(before);
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
  const received = () => fs.readFileSync(path.join(profile, 'received-columns.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((p) => p.colId === fresh).map((p) => p.text).join('\n');
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
  await closeElectron(application);
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

test('after a restart the Captain row is still pinned and shows its saved conversation, older ones read-only', async () => {
  const id = await page.evaluate(() => config.mainSession.colId);
  const row = page.locator('.colnav-item.captain-item');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-col-id', id);
  expect(await page.evaluate(() => [columns.filter((c) => c.isMain).length, deckEl.querySelector('.column').dataset.colId])).toEqual([1, id]);
  // the sessions it opened are still in its background
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === '写周报').id);
  await expect(page.locator('.captain-item .crew-counts')).toHaveCount(1);
  await expect(page.locator(`.column[data-col-id="${child}"]`)).toHaveClass(/backstage/);
  await page.locator('.colnav-item[data-col-id="cap-y"]').click();
  await page.evaluate((i) => ChatUI.setMode(i, 'term'), id);
  await row.click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe(id);
  const col = page.locator(`.column[data-col-id="${id}"]`);
  await expect(col).not.toHaveClass(/chat-mode/);
  await expect(col.locator('.chat-scroll > .turn .task-card.st-done', { hasText: 'Worker y' })).toHaveCount(1);
  // the conversation from before the clear, from its saved file, read-only
  const turnsBefore = await page.evaluate((i) => ChatUI.turnsOf(i).length, id);
  await col.locator('.retired-toggle').click();
  const seg = col.locator(`.retired-chat[data-chat-id="${oldCaptainId}"]`);
  await seg.locator('summary').click();
  await expect(seg.locator('.msg.user .bubble', { hasText: 'status please' })).toBeVisible();
  expect(await page.evaluate((i) => ChatUI.turnsOf(i).length, id)).toBe(turnsBefore);
  expect(await page.evaluate((i) => window.deck.ptyIsAlive(i), id)).toBe(true);
});
