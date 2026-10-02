const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// E2E checks live identity badges in header + sidebar and full-width clipped footer.
// Tests ONLY fake-agent.js stand-in, never invoking real agent CLIs.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-badge-test-'));
  fs.mkdirSync(path.join(profile, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'sessions', 'col-replay.txt'), [
    '>_ OpenAI Codex (v0.160.0)',
    'permissions: YOLO mode',
    'GPT-6-Luna xhigh · ~',
    '← for agents · ? for shortcuts',
  ].join('\r\n'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [
      { id: 'col-agent', taskId: 'task-1', title: 'Agent Col', cmd: FAKE, cwd: profile, width: 460, role: 'manual' },
      { id: 'col-cursor', taskId: 'task-2', title: 'Cursor Col', cmd: FAKE, cwd: profile, width: 460, role: 'manual' },
      { id: 'col-shell', taskId: 'task-3', title: 'Shell Col', cmd: '', cwd: profile, width: 460, role: 'manual' },
      { id: 'col-cached', taskId: 'task-4', title: 'Restored Codex', cmd: '', cwd: profile, width: 460, role: 'manual', agentProvider: 'Codex', agentModel: 'gpt-6-luna', agentEffort: 'high' },
      { id: 'col-replay', taskId: 'task-5', title: 'Uncached Codex', cmd: '', cwd: profile, width: 460, role: 'manual' },
    ],
  }));
  const env = { ...process.env, AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md'), AGENTDECK_TEST_LONG_STATUS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(5);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => t.alive).length), { timeout: 20000 }).toBe(5);
});

test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('stand-in agent updates header and sidebar with provider icon and model label', async () => {
  // Wait for fake agent to draw welcome box and statusline
  await expect.poll(() => page.evaluate(() => terms.get('col-agent')?.lastScreen || ''), { timeout: 20000 }).toContain('Model: Fake');

  // Header badge on col-agent
  const col = page.locator('.column[data-col-id="col-agent"]');
  const badge = col.locator('.col-badge');
  await expect(badge).toBeVisible({ timeout: 10000 });
  await expect(badge).toHaveClass(/provider-claude/);
  await expect(badge.locator('.agent-provider-icon svg')).toBeVisible();
  await expect(badge.locator('.agent-model-label')).toHaveText('Fake');
  await expect(badge).toHaveAttribute('title', /Claude · Fake/);

  // Sidebar badge on col-agent
  const nav = page.locator('.colnav-item[data-col-id="col-agent"]');
  const navBadge = nav.locator('.cn-badge');
  await expect(navBadge).toBeVisible({ timeout: 10000 });
  await expect(navBadge).toHaveClass(/provider-claude/);
  await expect(navBadge.locator('.agent-provider-icon svg')).toBeVisible();
  await expect(navBadge.locator('.agent-model-label')).toHaveText('Fake');
});

test('plain shell column displays no fake model and keeps badge hidden', async () => {
  const shellCol = page.locator('.column[data-col-id="col-shell"]');
  await expect(shellCol.locator('.col-badge')).toBeHidden();

  const shellNav = page.locator('.colnav-item[data-col-id="col-shell"]');
  await expect(shellNav.locator('.cn-badge')).toBeHidden();
});

test('saved model identity is restored on a fresh shell in both header and sidebar', async () => {
  const col = page.locator('.column[data-col-id="col-cached"]');
  const badge = col.locator('.col-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/provider-codex/);
  await expect(badge.locator('.agent-model-label')).toHaveText('GPT-6 Luna');
  await expect(badge).toHaveAttribute('title', 'Codex · GPT-6 Luna (high)');

  const navBadge = page.locator('.colnav-item[data-col-id="col-cached"] .cn-badge');
  await expect(navBadge).toBeVisible();
  await expect(navBadge).toHaveClass(/provider-codex/);
  await expect(navBadge.locator('.agent-model-label')).toHaveText('GPT-6 Luna');
});

test('uncached Codex identity is recovered from terminal replay after restart', async () => {
  const col = page.locator('.column[data-col-id="col-replay"]');
  const badge = col.locator('.col-badge');
  await expect.poll(() => badge.locator('.agent-model-label').textContent(), { timeout: 15000 }).toBe('GPT-6 Luna');
  await expect(badge).toHaveClass(/provider-codex/);
  await expect(badge).toHaveAttribute('title', 'Codex · GPT-6 Luna (xhigh)');

  const navBadge = page.locator('.colnav-item[data-col-id="col-replay"] .cn-badge');
  await expect(navBadge).toHaveClass(/provider-codex/);
  await expect(navBadge.locator('.agent-model-label')).toHaveText('GPT-6 Luna');
  await expect.poll(() => {
    const config = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
    const column = config.columns.find((item) => item.id === 'col-replay');
    return column && `${column.agentProvider}:${column.agentModel}:${column.agentEffort}`;
  }).toBe('Codex:GPT-6-Luna xhigh:xhigh');
});

test('Cursor provider is preserved across model switches and updates header + sidebar', async () => {
  // Change only the identity metadata; the running process stays the stand-in.
  // Let it redraw model changes through the PTY: ConPTY can overwrite direct
  // xterm writes with its own screen snapshot when terminal view resizes it.
  await page.evaluate(() => {
    const c = columns.find((x) => x.id === 'col-cursor');
    if (c) c.cmd = 'cursor-agent --model claude-opus-5-5-high';
    window.deck.ptyInput('col-cursor', '/model claude-opus-5-5-high\r');
  });

  const cursorCol = page.locator('.column[data-col-id="col-cursor"]');
  const cursorBadge = cursorCol.locator('.col-badge');
  await expect.poll(() => cursorCol.locator('.col-badge .agent-model-label').textContent(), { timeout: 15000 }).toBe('Opus 5.5');
  await expect(cursorBadge).toHaveClass(/provider-cursor/);
  await expect(cursorBadge).toHaveAttribute('title', /Cursor · Claude Opus 5.5/);

  // Now simulate switching model in terminal to claude-sonnet-5-5-high
  await page.evaluate(() => {
    window.deck.ptyInput('col-cursor', '/model claude-sonnet-5-5-high\r');
  });

  // Verify header badge updates to Sonnet 5.5 while provider remains Cursor
  await expect.poll(() => cursorCol.locator('.col-badge .agent-model-label').textContent(), { timeout: 15000 }).toBe('Sonnet 5.5');
  await expect(cursorBadge).toHaveClass(/provider-cursor/);
  await expect(cursorBadge).toHaveAttribute('title', /Cursor · Claude Sonnet 5.5/);

  // Verify sidebar badge also updates to Sonnet 5.5 while provider remains Cursor
  const cursorNav = page.locator('.colnav-item[data-col-id="col-cursor"]');
  await expect.poll(() => cursorNav.locator('.cn-badge .agent-model-label').textContent(), { timeout: 15000 }).toBe('Sonnet 5.5');
  await expect(cursorNav.locator('.cn-badge')).toHaveClass(/provider-cursor/);

  // A switch in raw terminal view must override the earlier chat-view footer.
  await page.evaluate(() => {
    window.ChatUI.setMode('col-cursor', 'term');
    window.deck.ptyInput('col-cursor', '/model gemini-3.8-flash-high\r');
  });
  await expect(cursorBadge.locator('.agent-model-label')).toHaveText('Flash 3.8', { timeout: 15000 });
  await expect(cursorNav.locator('.agent-model-label')).toHaveText('Flash 3.8');
  await expect(cursorBadge).toHaveClass(/provider-cursor/);
  await page.evaluate(() => {
    window.deck.ptyInput('col-cursor', '/model grok-4.7-high-fast\r');
  });
  await expect(cursorBadge.locator('.agent-model-label')).toHaveText('Grok 4.7', { timeout: 15000 });
  await expect(cursorNav.locator('.agent-model-label')).toHaveText('Grok 4.7');
  await expect(cursorBadge).toHaveClass(/provider-cursor/);
  await page.evaluate(() => window.ChatUI.setMode('col-cursor', 'chat'));
});

test('status footer extends full width and clips overflow without CSS ellipsis', async () => {
  // The stand-in does not repaint on resize like a real TUI. Ask it to redraw
  // after the earlier terminal/chat switches so ConPTY has a complete screen.
  await page.evaluate(() => window.deck.ptyInput('col-agent', 'redraw footer\r'));
  const col = page.locator('.column[data-col-id="col-agent"]');
  const footer = col.locator('.tui-footer');
  await expect(footer).toBeVisible({ timeout: 15000 });
  await expect(footer.locator('.tf-row').first()).toContainText('LastField: complete');

  // Verify CSS properties: text-overflow is clip (NOT ellipsis), padding-right is 0
  const footerLine = footer.locator('.tf-row').first();
  const styles = await footerLine.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    const parentCs = window.getComputedStyle(el.parentElement);
    return {
      textOverflow: cs.textOverflow,
      overflow: cs.overflow,
      paddingRight: parentCs.paddingRight,
    };
  });
  expect(styles.textOverflow).toBe('clip');
  expect(styles.overflow).toBe('hidden');
  expect(styles.paddingRight).toBe('0px');

  // Verify layout: footer extends to right edge of chat container
  const layout = await footer.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const parentRect = el.parentElement.getBoundingClientRect();
    return { rightDiff: Math.abs(rect.right - parentRect.right) };
  });
  expect(layout.rightDiff).toBeLessThanOrEqual(1);
});


test('terminal model labels render as text rather than HTML', async () => {
  await page.evaluate(() => window.deck.ptyInput('col-cursor', '/model <img>\r'));
  const badge = page.locator('.column[data-col-id="col-cursor"] .col-badge');
  await expect(badge.locator('.agent-model-label')).toHaveText('<img>', { timeout: 15000 });
  await expect(badge.locator('img')).toHaveCount(0);
});
