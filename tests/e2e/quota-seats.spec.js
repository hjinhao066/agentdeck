const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '../..'), FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let app, page, profile, home;
const M = require('../../claude-seats-main');
function writeCache(id, remaining) {
  M.writeUsage({ id, configDir: id === 'us' ? '~/.claude' : '~/.claude-cn' }, home, { at: Date.now(), windows: [
    { key: 'fiveHour', remaining: remaining[0], resetText: 'in 1h' }, { key: 'weekly', remaining: remaining[1], resetText: 'in 4d' },
  ] });
}
const seat = id => page.locator(`#quotaBar [data-seat-id="${id}"]`);
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-quota-seats-'));
  home = path.join(profile, 'seats-home');
  for (const dir of ['.claude', '.claude-cn']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'us@example.com' } }));
  fs.writeFileSync(path.join(home, '.claude-cn/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.com' } }));
  writeCache('us', [19, 91]);
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    claudeSeats: [{ id: 'us', name: '🇺🇸 US', configDir: '~/.claude' }, { id: 'cn', name: '🇨🇳 CN', configDir: '~/.claude-cn' }],
    activeClaudeSeatId: 'us', mainSession: { colId: 'us-column', tasks: [], pending: [] },
    columns: ['us', 'cn'].map(id => ({ id: `${id}-column`, title: id === 'us' ? '🇺🇸 US模拟会话' : '🇨🇳 CN模拟会话', claudeSeatId: id, isMain: id === 'us', cmd: `node "${FAKE}" Claude ${id}`, cwd: profile, width: 600, role: 'manual' })),
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined, args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
});
test.afterAll(async () => {
  if (app) {
    const child = app.process(), force = setTimeout(() => {
      try {
        if (process.platform === 'win32') require('child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch (_) {}
    }, 10000);
    try { await app.close(); } finally { clearTimeout(force); }
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test('each Claude seat keeps its own windows and reset times, marks the real Captain seat and survives reload', async () => {
  await expect(seat('us').locator('[data-window="5h"] .quota-pct')).toHaveText('19%', { timeout: 20000 });
  await expect(seat('us')).toHaveAttribute('aria-label', /^🇺🇸 US（队长）：/);
  await expect(seat('cn')).toHaveAttribute('data-state', 'unknown');
  await expect(seat('cn')).toHaveAttribute('data-detail', /7d 无数据 ↻未知/);

  await page.evaluate(() => { config.activeClaudeSeatId = 'cn'; renderQuotaBar(); });
  await expect(seat('us')).toHaveAttribute('aria-label', /^🇺🇸 US（队长）：/); // Switching the next seat is not switching the running Captain.
  // The same shared footer cannot populate the other seat.
  await page.evaluate(() => window.deck.ptyInput('cn-column', 'quota-data\r'));
  await page.waitForTimeout(1800);
  await expect(seat('cn')).toHaveAttribute('data-state', 'unknown');
  writeCache('cn', [65, 30]);
  await page.evaluate(async () => { for (const q of await window.deck.quotaLocal()) QuotaCore.observe(config.quotas, q); renderQuotaBar(); });
  await expect(seat('cn').locator('[data-window="5h"] .quota-pct')).toHaveText('65%');
  await expect(seat('cn')).toHaveAttribute('data-detail', /5h 65% ↻.*7d 30% ↻/s);
  await expect(seat('us').locator('[data-window="5h"] .quota-pct')).toHaveText('19%');

  await page.evaluate(() => window.deck.ptyInput('cn-column', 'exhausted\r'));
  await expect(seat('cn')).toHaveAttribute('data-state', 'exhausted');
  await expect(seat('us')).toHaveAttribute('data-state', 'warning');
  await page.evaluate(() => flushConfig());
  // Hold the old replay snapshot so a real PTY redraw reaches the renderer
  // first. Reload must not paint this older snapshot over the new statusline.
  await app.evaluate(({ ipcMain, app }) => {
    const replay = ipcMain._invokeHandlers.get('pty:replay');
    ipcMain.removeHandler('pty:replay');
    ipcMain.handle('pty:replay', async (event, payload) => {
      const snapshot = await replay(event, payload);
      if (payload.id === 'us-column') await new Promise(resolve => { app.releaseQuotaReplay = resolve; });
      return snapshot;
    });
    app.restoreQuotaReplay = () => {
      ipcMain.removeHandler('pty:replay'); ipcMain.handle('pty:replay', replay);
    };
  });
  await page.reload();
  await expect(seat('us')).toHaveAttribute('aria-label', /^🇺🇸 US（队长）：/);
  await expect(seat('cn')).toHaveAttribute('data-state', 'exhausted');
  await expect(seat('us')).toHaveAttribute('data-detail', /us\*\*\*@example.com/);
  const text = await page.evaluate(async () => (await MainSession.handle({ action: 'main-quota' }, MainSession.mainCol())).result);
  expect(text).toMatch(/Claude \/ 🇨🇳 CN：已用尽[^\n]*上次采样：5h 65%/);
  expect(text).toMatch(/Claude \/ 🇺🇸 US：19%[^\n]*5h 19%/);
  // The Captain's own statusline is recorded under its seat's account only.
  await expect.poll(() => app.evaluate(({ app }) => typeof app.releaseQuotaReplay)).toBe('function');
  await page.evaluate(() => {
    window.quotaStatuslineArrived = false;
    window.deck.onPtyData((id, data) => {
      if (id === 'us-column' && data.includes('5h剩余 83%')) window.quotaStatuslineArrived = true;
    });
    window.deck.ptyInput('us-column', 'statusline-once\r');
  });
  await expect.poll(() => page.evaluate(() => window.quotaStatuslineArrived)).toBe(true);
  await app.evaluate(({ app }) => { app.releaseQuotaReplay(); app.restoreQuotaReplay(); });
  await expect.poll(() => page.evaluate(() => dumpScreen(terms.get('us-column').term))).toContain('5h剩余 83%');
  await expect.poll(async () => {
    await page.evaluate(async () => { for (const q of await window.deck.quotaLocal()) QuotaCore.observe(config.quotas, q); renderQuotaBar(); });
    return seat('us').locator('[data-window="5h"] .quota-pct').textContent();
  }, { timeout: 20000 }).toBe('83%');
  await expect(seat('us')).toHaveAttribute('data-detail', /会话状态行/);
  await expect(seat('cn')).toHaveAttribute('data-state', 'exhausted');
  const after = await page.evaluate(async () => (await MainSession.handle({ action: 'main-quota' }, MainSession.mainCol())).result);
  expect(after).toMatch(/Claude \/ 🇺🇸 US：59%[^\n]*5h 83%/);
  expect(after).toMatch(/Claude \/ 🇨🇳 CN：已用尽[^\n]*上次采样：5h 65%/);
  // Top bar tooltip, keyboard popover and board-cli quota share one summary.
  for (const id of ['us', 'cn']) {
    const title = await seat(id).getAttribute('data-detail');
    // The panel adds a status/sample-time header line above the shared summary.
    expect(title).toMatch(/^状态：(正常|快用完|已用尽|未知) · /);
    // Seat warmup lines follow the shared summary only in the panel tooltip.
    const summary = title.split('\n').slice(1).join(' · ');
    expect(after.split('\n').some((line) => line.startsWith('Claude / ') && summary.startsWith(line))).toBe(true);
    // The visible tooltip names source and confidence, but no config dir or model.
    await expect(seat(id).getByRole('tooltip', { includeHidden: true })).toContainText(/来源.*可信度/);
    await expect(seat(id).getByRole('tooltip', { includeHidden: true })).not.toContainText(/配置目录|模型/);
    await expect(seat(id)).not.toHaveAttribute('title');
  }

  await seat('us').focus();
  await expect(seat('us').getByRole('tooltip')).toBeVisible();
  await page.waitForTimeout(1800);
  await expect(seat('us').getByRole('tooltip')).toBeVisible();
  const shots = process.env.AGENTDECK_QUOTA_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'quota-claude-seats-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(shots, 'quota-claude-seats-light.png') });
  }
});
