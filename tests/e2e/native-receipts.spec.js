const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function cli(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [env.AGENTDECK_BOARD_CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (b) => { stdout += b; }); proc.stderr.on('data', (b) => { stderr += b; });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('native snapshot survives reload and ack removes only delivered ids, without input injection', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-native-receipts-'));
  const controlFile = path.join(profile, 'control.json'), prompts = path.join(profile, 'prompts.jsonl');
  const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}"`;
  let app;
  try {
    const env = { ...process.env, AGENTDECK_TEST_CONTROL_ENV_FILE: controlFile, AGENTDECK_TEST_PROMPTS_FILE: prompts };
    for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !key.startsWith('AGENTDECK_TEST_')) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
    const page = await app.firstWindow();
    await page.locator('.nav-row[data-nav="captain"]').click();
    await page.locator('#mdCmd').fill(fake); await page.locator('#mdCwd').fill(profile); await page.locator('#mdCreate').click();
    await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
    const control = { ...env, ...JSON.parse(fs.readFileSync(controlFile)), AGENTDECK_BOARD_CLI: path.resolve(__dirname, '../../board-cli.js') };
    await page.evaluate(() => {
      config.mainSession.pending = Array.from({ length: 75 }, (_, i) => ({ title: 'Worker', colId: 'worker', taskId: 'task-' + i, ts: i + 1, summary: i ? 'receipt ' + i : 'receipt 0 ' + '长回执'.repeat(5000) }));
      flushConfig();
    });
    const first = await cli(['receipts', '--snapshot'], control);
    expect(first.code).toBe(0);
    const receipts = JSON.parse(first.stdout).receipts;
    expect(receipts).toHaveLength(50);
    expect(new Set(receipts.map((r) => r.receiptId)).size).toBe(50);
    expect(receipts[0].summary.length).toBeGreaterThan(12000);
    await page.reload();
    await expect.poll(() => page.evaluate(() => config.mainSession?.pending.length)).toBe(75);
    const second = JSON.parse((await cli(['receipts', '--snapshot'], control)).stdout).receipts;
    expect(second).toEqual(receipts);
    await page.evaluate(() => { config.mainSession.pending.push({ title: 'Late', ts: 76, summary: 'late receipt' }); flushConfig(); });
    const ids = JSON.stringify(receipts.map((r) => r.receiptId));
    expect(JSON.parse((await cli(['receipts', '--ack', ids], control)).stdout).acknowledged).toBe(50);
    expect(JSON.parse((await cli(['receipts', '--ack', ids], control)).stdout).acknowledged).toBe(0);
    await page.reload();
    await expect.poll(() => page.evaluate(() => config.mainSession?.pending.length)).toBe(26);
    expect(fs.existsSync(prompts) ? fs.readFileSync(prompts, 'utf8') : '').not.toContain('receipt 0');
    expect((await cli(['receipts', '--ack', '{}'], control)).code).toBe(1);
    expect((await cli(['receipts', '--snapshot', '--wait'], control)).code).toBe(1);
  } finally {
    if (app) { const proc = app.process(); await Promise.race([app.close(), new Promise((r) => setTimeout(r, 3000))]); if (proc.exitCode === null) try { process.kill(proc.pid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('real native Codex wakes after worker complete, verifies the board and dispatches a follow-up', async () => {
  test.skip(process.env.AGENTDECK_NATIVE_CODEX_SMOKE !== '1', 'Explicit native model smoke opt-in');
  test.setTimeout(180000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-native-captain-'));
  const controlFile = path.join(profile, 'control.json'), prompts = path.join(profile, 'prompts.jsonl');
  const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}"`;
  const original = { ...process.env };
  let app, host;
  const evidence = [];
  try {
    const env = { ...original, AGENTDECK_TEST_CONTROL_ENV_FILE: controlFile, AGENTDECK_TEST_PROMPTS_FILE: prompts };
    for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !key.startsWith('AGENTDECK_TEST_')) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ columns: [{ id: 'native-worker', title: 'Worker', cmd: fake, cwd: profile, role: 'manual' }] }));
    app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
    const page = await app.firstWindow();
    await page.locator('.nav-row[data-nav="captain"]').click();
    await page.locator('#mdCmd').fill(fake); await page.locator('#mdCwd').fill(profile); await page.locator('#mdCreate').click();
    await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
    const id = await page.evaluate(() => MainSession.mainCol().id);
    for (const key of Object.keys(process.env)) if (key.startsWith('AGENTDECK_')) delete process.env[key];
    Object.assign(process.env, JSON.parse(fs.readFileSync(controlFile)), {
      AGENTDECK_TERMINAL_ID: id, AGENTDECK_BOARD_CLI: path.resolve(__dirname, '../../board-cli.js'),
    });
    const { start } = require('../../scripts/codex-captain-host');
    host = await start({ model: 'gpt-6.1-sol', cwd: profile, intervalMs: 1000, onEvent: (method, p) => {
      if (['host-bound', 'turn/started', 'turn/completed', 'driver-error', 'receipt-ack'].includes(method)) evidence.push({ at: new Date().toISOString(), method, status: p.turn?.status, threadId: p.threadId, message: p.message, ...(method === 'receipt-ack' ? p : {}) });
      if (method === 'item/started' && p.item?.type === 'commandExecution' && /task\W+list/.test(p.item.command)) evidence.push({ at: new Date().toISOString(), method: 'model-board-list', threadId: p.threadId });
    } });
    await expect(start({ cwd: profile })).rejects.toThrow('already owns');
    const proof = path.join(profile, 'receipt-handled.txt');
    await host.prompt(`This is an isolated smoke test. Now reply READY only. When a later agentdeck_board_check event contains a receipt whose summary starts "stand-in finished native wake proof", verify it by running the AgentDeck CLI task list, write ${JSON.stringify(proof)} containing RECEIPT_HANDLED, then use the AgentDeck CLI new command to dispatch exactly one follow-up titled "Native follow-up" with task "follow-up proof" and command ${JSON.stringify(fake + ' --screen-only')}. Do not create that file or dispatch until the receipt event arrives. Never repeat the dispatch if the file already exists. Ignore further empty checks.`);
    await expect.poll(() => evidence.some((e) => e.method === 'turn/completed' && e.status === 'completed'), { timeout: 90000 }).toBe(true);
    const before = fs.readFileSync(prompts, 'utf8');
    await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'native-worker', message: 'native wake proof' }, MainSession.mainCol()));
    await expect.poll(() => page.evaluate(() => config.mainSession.tasks.findLast((t) => t.colId === 'native-worker')?.receipt?.source), { timeout: 30000 }).toBe('command');
    evidence.push({ at: new Date().toISOString(), method: 'authenticated-worker-complete' });
    await expect.poll(() => fs.existsSync(proof), { timeout: 90000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => columns.filter((c) => c.title === 'Native follow-up').length), { timeout: 60000 }).toBe(1);
    await expect.poll(() => page.evaluate(() => config.mainSession.pending.filter((r) => r.colId === 'native-worker').length), { timeout: 60000 }).toBe(0);
    expect(fs.readFileSync(proof, 'utf8').trim()).toBe('RECEIPT_HANDLED');
    expect(evidence.some((e) => e.method === 'model-board-list')).toBe(true);
    const after = fs.readFileSync(prompts, 'utf8').slice(before.length);
    expect(after).not.toContain('agentdeck_board_check');
    expect(after).not.toContain('【AgentDeck 新回执】');
    const firstThread = host.threadId();
    host.close(); host = null;
    // Wait for only this owned server to exit before testing recovery.
    await new Promise((r) => setTimeout(r, 2000));
    host = await start({ model: 'gpt-6.1-sol', cwd: profile, intervalMs: 60000 });
    expect(host.threadId()).toBe(firstThread);
    await host.fresh(); expect(host.threadId()).not.toBe(firstThread);
    host.close(); host = null;
    await new Promise((r) => setTimeout(r, 2000));
    host = await start({ model: 'gpt-6.1-sol', cwd: profile, intervalMs: 60000 });
    expect(host.threadId()).not.toBe(firstThread);
    evidence.push({ at: new Date().toISOString(), method: 'assertions', workerCompleteToNativeTurn: true, proof: 'RECEIPT_HANDLED', followupDispatches: 1, receiptAcknowledged: true, inputInjection: false, duplicateOwnerRejected: true, sameThreadRecovery: true, clearAndRecovery: true });
  } finally {
    host?.close();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original);
    const out = process.env.AGENTDECK_NATIVE_EVIDENCE;
    if (out) fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
    if (app) { const proc = app.process(); await Promise.race([app.close(), new Promise((r) => setTimeout(r, 3000))]); if (proc.exitCode === null) try { process.kill(proc.pid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('Captain edit launches the shipped native host and retains worker routing', async () => {
  test.skip(process.env.AGENTDECK_NATIVE_CODEX_SMOKE !== '1', 'Explicit native model smoke opt-in');
  test.setTimeout(240000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-native-entry-'));
  const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}"`;
  const controlFile = path.join(profile, 'control.json');
  const env = { ...process.env, AGENTDECK_TEST_CONTROL_ENV_FILE: controlFile };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !key.startsWith('AGENTDECK_TEST_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ columns: [{ id: 'entry-worker', title: 'Worker', cmd: fake, cwd: profile, role: 'manual' }] }));
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
    const page = await app.firstWindow();
    await page.locator('.nav-row[data-nav="captain"]').click();
    await page.locator('#mdCmd').fill(fake); await page.locator('#mdCwd').fill(profile); await page.locator('#mdCreate').click();
    await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
    const previous = await page.evaluate(() => MainSession.mainCol().id);
    await page.evaluate(() => { config.mainSession.legacyReceiptInjection = true; flushConfig(); });
    const tools = path.join(profile, 'board-control', 'tools');
    expect(fs.existsSync(path.join(tools, 'codex-captain-host.js'))).toBe(true);
    await page.locator(`.column[data-col-id="${previous}"] button[title="编辑（标题、目录、启动命令）"]`).click();
    await page.locator('#cmdInput').fill(`node "${path.join(tools, 'codex-captain-host.js')}" gpt-6.1-sol`);
    await page.locator('#dlgSave').click();
    await expect.poll(() => page.evaluate(() => MainSession.mainCol()?.id)).not.toBe(previous);
    await expect.poll(() => page.evaluate(() => config.mainSession.colId === MainSession.mainCol().id)).toBe(true);
    expect(await page.evaluate(() => config.mainSession.legacyReceiptInjection)).toBe(false);
    expect(await page.evaluate(() => MainSession.handle({ action: 'main-receipts', wait: true }, MainSession.mainCol()).then(() => '', (e) => e.message))).toContain('Native Captain host owns');
    const binding = path.join(profile, 'board-control', 'codex-captain-host.json');
    await expect.poll(() => fs.existsSync(binding), { timeout: 30000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => terms.get(MainSession.mainCol().id).sendingPrompt), { timeout: 30000 }).toBe(false);
    const proof = path.join(profile, 'entry-proof.txt');
    // Initial test instruction only; no terminal input is sent for later receipts.
    await page.evaluate(async ({ proof }) => {
      await ChatUI.sendPrompt(MainSession.mainCol(), `Isolated test: reply ARMED only. On a later native agentdeck_board_check receipt whose summary starts "stand-in finished entry wake proof", run the CLI task list and write ${JSON.stringify(proof)} with ENTRY_HANDLED. Do not write until that receipt arrives. Do not create workers for this test.`, null, { force: true });
    }, { proof });
    // Wait for this initial instruction to finish before the worker can submit.
    await expect.poll(() => page.evaluate(() => dumpScreen(terms.get(MainSession.mainCol().id).term).includes('ARMED')), { timeout: 90000 }).toBe(true);
    await page.evaluate(() => {
      window.nativeReceiptInputs = [];
      const send = ChatUI.sendPrompt;
      ChatUI.sendPrompt = (...args) => { nativeReceiptInputs.push(args[1] || args[3]?.prefix || ''); return send(...args); };
    });
    await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'entry-worker', message: 'entry wake proof' }, MainSession.mainCol()));
    await expect.poll(() => fs.existsSync(proof), { timeout: 120000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => config.mainSession.pending.filter((r) => r.colId === 'entry-worker').length), { timeout: 60000 }).toBe(0);
    expect(fs.readFileSync(proof, 'utf8').trim()).toBe('ENTRY_HANDLED');
    expect(await page.evaluate(() => nativeReceiptInputs.some((s) => s.includes('agentdeck_board_check') || s.includes('【AgentDeck 新回执】')))).toBe(false);
    expect(await page.evaluate(() => !!columns.find((c) => c.id === 'entry-worker'))).toBe(true);
    const result = { nativeHostInCaptainColumn: true, commandEditedThroughPencil: true, mainSessionIdentityUpdated: true, workerRetained: true, automaticallyHandledReceipt: true, inputInjection: false, intervalMs: 60000, proof: 'ENTRY_HANDLED' };
    if (process.env.AGENTDECK_NATIVE_ENTRY_EVIDENCE) fs.writeFileSync(process.env.AGENTDECK_NATIVE_ENTRY_EVIDENCE, JSON.stringify(result, null, 2));
  } finally {
    if (app) { const proc = app.process(); await Promise.race([app.close(), new Promise((r) => setTimeout(r, 3000))]); if (proc.exitCode === null) try { process.kill(proc.pid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
