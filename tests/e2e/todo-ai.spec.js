const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { taskId } = require('../../todo-ai');

// Background transparent/unfocusable windows, stand-in agents and private stores. Inherited
// Captain/worker capabilities must never reach a test app or its CLI child.
function isolatedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

test('Todo AI goes through the Captain receipt channel and persists artifact/status results quietly', async () => {
  test.setTimeout(120000);
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-todo-ai-')));
  const controlFile = path.join(profile, 'control-env.json');
  const receiptDir = path.join(profile, 'receipt-env');
  fs.mkdirSync(receiptDir);
  const promptsFile = path.join(profile, 'prompts.jsonl');
  const keyFile = path.join(profile, 'bark-test-key');
  const fake = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
  fs.writeFileSync(keyFile, 'fake_todo_ai_test_key\n');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false }, barkKeyFile: keyFile,
    captainNotifications: { enabled: false, sound: false },
    columns: [{ id: 'todo-host', title: 'Stand-in', cmd: fake, cwd: profile, role: 'manual' }],
  }));
  const children = new Set();
  let application, foregroundTimer;
  const foregroundPids = [];
  const sampleForeground = () => {
    if (process.platform !== 'darwin') return;
    const front = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    const info = execFileSync('lsappinfo', ['info', '-only', 'pid', front], { encoding: 'utf8' });
    const pid = info.match(/\bpid"?\s*=\s*(\d+)/i);
    if (pid) foregroundPids.push(Number(pid[1]));
  };
  try {
    application = await electron.launch({
      args: [path.resolve(__dirname, '../..'), `--test-user-data=${profile}`],
      env: { ...isolatedEnv(), ZDOTDIR: profile, AGENTDECK_TEST_CONTROL_ENV_FILE: controlFile,
        AGENTDECK_TEST_PROMPTS_FILE: promptsFile, AGENTDECK_TEST_RECEIPT_ENV_DIR: receiptDir },
    });
    const page = await application.firstWindow();
    sampleForeground();
    foregroundTimer = setInterval(sampleForeground, 250);
    const items = () => page.evaluate(() => window.deck.todos('list').then((r) => r.items));
    const cards = () => page.evaluate(() => window.deck.taskBoard('list', { project: 'todo', archived: true }));
    const bark = () => application.evaluate(({ app }) => app.testCaptainAlerts.filter((e) => e.type === 'bark'));
    const captured = () => fs.existsSync(promptsFile)
      ? fs.readFileSync(promptsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    const cli = (args) => new Promise((resolve, reject) => {
      const credentials = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
      const child = spawn(process.execPath, [path.join(credentials.AGENTDECK_CONTROL_DIR, 'tools', 'agentdeck-board.js'), ...args], {
        env: { ...isolatedEnv(), ...credentials }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.once('error', reject);
      child.once('close', (code) => { children.delete(child); resolve({ code, stdout, stderr }); });
    });
    const status = (item, state, extra = []) => cli(['todo', 'status', '--id', item.id, '--task-id', item.ai.taskId, '--status', state, ...extra]);
    const rawRequest = async (command, token) => {
      const credentials = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
      const id = 'todo-security-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      const request = path.join(credentials.AGENTDECK_CONTROL_DIR, 'requests', id + '.json');
      const response = path.join(credentials.AGENTDECK_CONTROL_DIR, 'responses', id + '.json');
      fs.writeFileSync(request + '.tmp', JSON.stringify({ id, token, createdAt: Date.now(), ...command }));
      fs.renameSync(request + '.tmp', request);
      await expect.poll(() => fs.existsSync(response)).toBe(true);
      return JSON.parse(fs.readFileSync(response, 'utf8'));
    };
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible() || (w.getOpacity() === 0 && !w.isFocusable())))).toBe(true);
    await page.locator('#todoBtn').click();
    await page.locator('.todo-add-input').fill('自己去取快递');
    await page.locator('.todo-add-input').press('Enter');
    const original = '帮我@ai查一下Python3.12的文档';
    const taskBody = original;
    await page.locator('.todo-add-input').fill(original);
    await page.locator('.todo-add-input').press('Enter');
    await expect.poll(async () => (await cards()).length).toBe(1);
    const submitted = (await items()).find((i) => i.text === original);
    expect(submitted.ai).toMatchObject({ status: 'queued', taskId: taskId(submitted), deliveredAt: null });
    expect((await items()).find((i) => i.text === '自己去取快递').ai).toBe(null);
    expect((await cards())[0]).toMatchObject({ id: submitted.ai.taskId, project: 'todo', status: 'todo', title: taskBody });

    // A request recorded before a Captain exists stays in its durable outbox.
    await page.locator('.nav-row[data-nav="captain"]').click();
    await page.locator('#mdCmd').fill(fake);
    await page.locator('#mdCwd').fill(profile);
    await page.locator('#mdCreate').click();
    await expect.poll(() => fs.existsSync(controlFile), { timeout: 20000 }).toBe(true);
    let captainId = await page.evaluate(() => MainSession.mainCol().id);
    await expect.poll(async () => (await items()).find((i) => i.id === submitted.id).ai.deliveredAt).not.toBeNull();
    await expect.poll(() => page.evaluate(() => Object.keys(config.todoInbox).length)).toBe(1);
    // Acceptance into pending is still unread. Close the actual test Captain
    // column and create another: the durable queue must wake the new listener.
    await expect.poll(() => page.evaluate((id) => terms.get(id).sendingPrompt, captainId)).toBe(false);
    fs.unlinkSync(controlFile); // confirm the new stand-in has started by waiting for its credentials file
    await page.evaluate(() => {
      const col = MainSession.mainCol(), confirmBefore = window.confirm;
      window.confirm = () => true;
      try { removeCol(col); } finally { window.confirm = confirmBefore; }
      window.deck.saveConfigSync(config);
    });
    expect(await page.evaluate(() => config.mainSession)).toBeNull();
    expect(await page.evaluate(() => Object.keys(config.todoInbox).length)).toBe(1);
    await page.locator('.nav-row[data-nav="captain"]').click();
    await page.locator('#mdCmd').fill(fake);
    await page.locator('#mdCwd').fill(profile);
    await page.locator('#mdCreate').click();
    captainId = await page.evaluate(() => MainSession.mainCol().id);
    await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
    await expect.poll(() => page.evaluate(() => MainSession.state().pending.length)).toBe(1);
    await expect.poll(() => captured().join('\n'), { timeout: 20000 }).toContain('run_in_background: true');
    await expect.poll(() => page.evaluate((id) => terms.get(id).sendingPrompt, captainId)).toBe(false);
    await page.evaluate((id) => ChatUI.setMode(id, 'chat'), captainId);
    const composer = page.locator(`.column[data-col-id="${captainId}"] .composer textarea`);
    await composer.fill('我还没写完的草稿');
    const beforePrompts = captured().length;
    const receipt = await cli(['receipts', '--wait', '--timeout', '10']);
    expect(receipt.code).toBe(0);
    expect(receipt.stderr).toBe('');
    for (const text of ['【AgentDeck 新回执】', submitted.id, submitted.ai.taskId, taskBody,
      '拿到实物', 'PDF/EPUB', '等用户提供，不要自己猜、不要瞎编', '不得上传到任何在线服务']) expect(receipt.stdout).toContain(text);
    await expect(composer).toHaveValue('我还没写完的草稿');
    expect(captured().slice(beforePrompts).some((p) => p.includes('我还没写完的草稿') || p.includes(original))).toBe(false);
    expect((await cli(['todo', 'list'])).stdout).toContain(submitted.id);

    // Validate the main-process boundary even when a caller bypasses CLI parsing.
    const credentials = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    const expired = await rawRequest({ action: 'main-todo', op: 'status', deadline: Date.now() - 1,
      input: { id: submitted.id, taskId: submitted.ai.taskId, status: 'working' } }, credentials.AGENTDECK_CONTROL_TOKEN);
    expect(expired.error).toContain('超时');
    await expect.poll(() => fs.existsSync(path.join(receiptDir, 'todo-host.json'))).toBe(true);
    const worker = JSON.parse(fs.readFileSync(path.join(receiptDir, 'todo-host.json'), 'utf8'));
    expect(worker.control).toBe(false);
    expect(worker.AGENTDECK_RECEIPT_TOKEN).toBeTruthy();
    const deniedRead = await rawRequest({ action: 'main-todo', op: 'list' }, worker.AGENTDECK_RECEIPT_TOKEN);
    expect(deniedRead.error).toContain('Receipt capability allows only');
    const deniedWrite = await rawRequest({ action: 'main-todo', op: 'status', deadline: Date.now() + 10000,
      input: { id: submitted.id, taskId: submitted.ai.taskId, status: 'failed', message: 'unauthorized' } }, worker.AGENTDECK_RECEIPT_TOKEN);
    expect(deniedWrite.error).toContain('Receipt capability allows only');
    expect((await items()).find((i) => i.id === submitted.id).ai.status).toBe('queued');
    expect((await cards())[0].status).toBe('todo');
    expect(await bark()).toEqual([]);

    expect((await status(submitted, 'working')).code).toBe(0);
    expect((await status(submitted, 'needs_user', ['--message', '等你提供本机材料，不要上传'])).code).toBe(0);
    expect((await cards())[0]).toMatchObject({ status: 'needs_user', user_question: '等你提供本机材料，不要上传' });
    await page.waitForTimeout(2300); // The existing needs-user Bark observer coalesces for 2 s.
    expect(await bark()).toEqual([]);
    expect((await items()).find((i) => i.id === submitted.id).ai.status).toBe('needs_user');
    const absent = await status(submitted, 'done', ['--files', path.join(profile, 'missing.epub')]);
    expect(absent.code).not.toBe(0);
    expect(absent.stderr).toContain('已经落盘');
    const artifact = path.join(profile, 'public-book.epub');
    fs.writeFileSync(artifact, 'stand-in artifact');
    expect((await status(submitted, 'done', ['--files', artifact])).code).toBe(0);
    expect((await items()).find((i) => i.id === submitted.id).ai).toMatchObject({ status: 'done', files: [artifact] });
    expect((await cards())[0].status).toBe('done');
    expect(await bark()).toEqual([]);

    // Editing the original creates a fresh version; late old results are refused.
    await page.locator('#todoBtn').click();
    const row = page.locator('.todo-row', { hasText: original });
    await row.hover();
    await row.locator('button[title="编辑"]').click();
    const edited = '@ai 查另一份公开资料并存下来';
    await page.locator('.todo-edit').fill(edited);
    await page.locator('.todo-edit').press('Enter');
    await expect.poll(async () => (await cards()).length).toBe(2);
    const next = (await items()).find((i) => i.id === submitted.id);
    expect(next.ai.taskId).toBe(taskId(next));
    expect(next.ai.taskId).not.toBe(submitted.ai.taskId);
    const stale = await status(submitted, 'working');
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain('版本过期');
    expect((await status(next, 'failed', ['--message', '测试异常：没有找到资料'])).code).toBe(0);
    await expect.poll(async () => (await bark()).length).toBe(1);
    expect((await bark())[0]).toMatchObject({ body: 'Todo AI 有 1 条任务没办成或出错，请在 AgentDeck 查看详情。', level: 'timeSensitive' });
    expect((await bark())[0].volume).toBeUndefined();
    expect((await status(next, 'failed', ['--message', '测试异常：没有找到资料'])).code).toBe(0);
    expect(await bark()).toHaveLength(1);
    expect((await items()).find((i) => i.id === submitted.id).ai.status).toBe('failed');
    expect((await cards()).find((c) => c.id === next.ai.taskId)).toMatchObject({ status: 'needs_user', flag: 'failed' });
    await expect.poll(async () => (await items()).find((i) => i.id === submitted.id).ai.deliveredAt).not.toBeNull();
    const received = await cli(['receipts']);
    expect(received.stdout).toContain(edited);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!window.MainSession?.state())).toBe(true);
    expect(await cards()).toHaveLength(2);
    expect(await page.evaluate(() => Object.keys(config.todoDeliveries).length)).toBe(2);
    // Simulate a crash between the Captain's durable acceptance and the Todo
    // acknowledgement: the watcher retries, but the restored marker dedups it.
    const ownFile = fs.readdirSync(path.join(profile, 'todos')).find((file) => file.endsWith('.json'));
    const file = path.join(profile, 'todos', ownFile), doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pending = doc.items.find((i) => i.id === next.id);
    pending.ai.deliveredAt = null;
    pending.updated = new Date(Date.parse(pending.updated) + 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(doc));
    await expect.poll(async () => (await items()).find((i) => i.id === next.id).ai.deliveredAt).not.toBeNull();
    expect((await cli(['receipts'])).stdout).not.toContain(edited);
    expect(await bark()).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(config.todoDeliveries).length)).toBe(2);
    expect(await page.evaluate(() => Object.keys(config.todoInbox).length)).toBe(0);
    // Backend filesystem failures must reach the Captain, without leaking the
    // damaged data into the receipt or making success/waiting tasks ring.
    const healthy = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{broken-private-CT-material');
    await expect.poll(() => page.evaluate(() => MainSession.state().pending.some((p) => p.title === 'Todo 后台异常'))).toBe(true);
    const exception = await cli(['receipts']);
    expect(exception.stdout).toContain('TODO_STORE_CORRUPT');
    expect(exception.stdout).not.toContain('private-CT-material');
    fs.writeFileSync(file, healthy);
    await expect.poll(async () => (await items()).length).toBe(2);
    expect(await bark()).toHaveLength(1);
    if (process.platform === 'darwin') {
      expect(foregroundPids.length).toBeGreaterThan(0);
      expect(foregroundPids).not.toContain(application.process().pid);
    }
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible() || (w.getOpacity() === 0 && !w.isFocusable())))).toBe(true);
  } finally {
    clearInterval(foregroundTimer);
    for (const child of children) if (child.exitCode === null) child.kill();
    if (application) {
      const proc = application.process();
      await Promise.race([application.close(), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (proc.exitCode === null) try { process.kill(proc.pid, 'SIGKILL'); } catch (_) {}
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
