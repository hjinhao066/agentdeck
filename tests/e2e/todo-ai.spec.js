const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { taskId } = require('../../todo-ai');

// AGENTDECK_TODO_AI_SHOTS=<dir> saves the 待办 row and 待我处理 screenshots.
async function shot(page, name) {
  const dir = process.env.AGENTDECK_TODO_AI_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}

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
    // A long prompt (the Captain briefing) is typed as a pointer to a file in the profile: read that too.
    const expand = (prompt) => {
      const file = /完整内容已存成文件，请先完整读取再照做：(\S+?\.txt)/.exec(prompt)?.[1];
      return file && fs.existsSync(file) ? prompt + '\n' + fs.readFileSync(file, 'utf8') : prompt;
    };
    const captured = () => fs.existsSync(promptsFile)
      ? fs.readFileSync(promptsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse).map(expand) : [];
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
    // 待我处理 items filed from the 待办 (the page also checks on its own every 30 s and on every change).
    const filed = () => page.evaluate(() => AttentionUI.refresh().then(() => config.attention.items.filter((i) => i.source === 'todo')
      .map((i) => ({ kind: i.kind, type: i.type, title: i.title, ask: i.ask, options: i.options, files: i.files, done: i.done, card: i.card }))));
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
    // The row says it went to AI; a plain 待办 says nothing.
    await expect(page.locator('.todo-row', { hasText: original }).locator('.todo-ai-chip')).toHaveText('已交给 AI · 等队长接收');
    await expect(page.locator('.todo-row', { hasText: '自己去取快递' }).locator('.todo-ai')).toHaveCount(0);
    expect(await filed()).toEqual([]);

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
    await expect.poll(() => fs.existsSync(controlFile), { timeout: 20000 }).toBe(true);
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
    // What 队长 wrote back is a question for the user on 待我处理, about this card.
    await expect.poll(filed).toEqual([{ kind: 'need', type: 'question', title: 'AI 在等你：' + original, ask: '等你提供本机材料，不要上传',
      options: [], files: [], done: false, card: submitted.ai.taskId }]);
    await expect(page.locator('#attentionBtn .nav-row-badge')).toHaveText('1');
    const absent = await status(submitted, 'done', ['--files', path.join(profile, 'missing.epub')]);
    expect(absent.code).not.toBe(0);
    expect(absent.stderr).toContain('已经落盘');
    const artifact = path.join(profile, 'public-book.epub');
    fs.writeFileSync(artifact, 'stand-in artifact');
    expect((await status(submitted, 'done', ['--files', artifact])).code).toBe(0);
    expect((await items()).find((i) => i.id === submitted.id).ai).toMatchObject({ status: 'done', files: [artifact] });
    expect((await cards())[0].status).toBe('done');
    expect(await bark()).toEqual([]);
    // The question is settled; the result is a report with the file, unread.
    await expect.poll(filed).toEqual([
      { kind: 'need', type: 'question', title: 'AI 在等你：' + original, ask: '等你提供本机材料，不要上传', options: [], files: [], done: true, card: submitted.ai.taskId },
      { kind: 'report', type: '', title: 'AI 办完了：' + original, ask: '', options: [], files: [artifact], done: false, card: submitted.ai.taskId },
    ]);
    await expect(page.locator('#attentionBtn .nav-row-badge')).toBeHidden();
    await expect(page.locator('#attentionBtn .nav-row-dot')).toBeVisible();
    // Under the 待办 itself: the state and the file, with icon tools.
    await page.locator('#todoBtn').click();
    const doneRow = page.locator('.todo-row', { hasText: original });
    await expect(doneRow.locator('.todo-ai.is-done .todo-ai-chip')).toHaveText('AI 办完了');
    await expect(doneRow.locator('.todo-ai-open')).toHaveText('public-book.epub');
    await expect(doneRow.locator('.todo-ai-open')).toHaveAttribute('title', artifact);
    const copyPath = doneRow.getByRole('button', { name: '复制路径' });
    await expect(copyPath).toHaveAttribute('title', '复制路径');
    await expect(doneRow.locator('.todo-ai-tool[aria-label^="在"][aria-label$="中显示"]')).toHaveCount(1);
    await copyPath.click();
    await expect(doneRow.getByRole('button', { name: '已复制' })).toHaveClass(/done/);
    await expect(doneRow.getByRole('button', { name: '复制路径' })).toBeVisible(); // back to the copy icon
    expect(await page.evaluate(() => window.deck.clipboardRead())).toBe(artifact); // a test profile's own clipboard
    await expect(doneRow).not.toHaveClass(/is-done/); // AI finishing never ticks the user's own 待办
    await shot(page, 'desktop-todo-ai-done');
    await page.locator('#attentionBtn').click();
    const report = page.locator('.at-card', { hasText: 'AI 办完了' });
    await expect(report.locator('.at-from')).toHaveText('来自待办');
    await shot(page, 'desktop-attention-ai-done');

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
    // The failure is one decision with quick answers, not a second generic alert item.
    // (The report above may already count as read: it was on screen.)
    await expect.poll(async () => (await filed()).filter((i) => i.kind === 'need' && !i.done)).toEqual([
      { kind: 'need', type: 'decide', title: 'AI 没办成：' + edited, ask: '测试异常：没有找到资料 要重试还是先放着？', options: ['重试', '先放着'], files: [], done: false, card: next.ai.taskId },
    ]);
    expect(await page.evaluate(() => config.attention.items.filter((i) => /没办成或出错/.test(i.title)).length)).toBe(0);
    await page.locator('#attentionBtn').click();
    const failed = page.locator('.at-card', { hasText: 'AI 没办成' });
    await expect(failed.locator('.at-quick button')).toHaveText(['重试', '先放着']);
    await shot(page, 'desktop-attention-ai-failed');
    await page.locator('#todoBtn').click();
    await expect(page.locator('.todo-row', { hasText: edited }).locator('.todo-ai.is-failed')).toContainText('AI 没办成测试异常：没有找到资料');
    await page.locator('#attentionBtn').click();
    // One tap answers: it reaches 队长 with the card, and the decision is ticked.
    await failed.locator('.at-quick button', { hasText: '重试' }).click();
    await expect.poll(async () => (await filed()).find((i) => i.kind === 'need' && i.card === next.ai.taskId).done).toBe(true);
    await expect.poll(async () => (await items()).find((i) => i.id === submitted.id).ai.deliveredAt).not.toBeNull();
    const received = await cli(['receipts']);
    expect(received.stdout).toContain(edited);
    expect(received.stdout).toContain('用户的回复：重试');
    expect(received.stdout).toContain(next.ai.taskId);
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
    // Let the app quit as every other spec does: killing it mid-close (a quit with a
    // Captain is slow on a busy machine) leaves the Playwright worker hanging.
    if (application) await application.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // the app may still be writing as it quits
  }
});
