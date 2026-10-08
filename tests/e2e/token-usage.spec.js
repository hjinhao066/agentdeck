const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../../token-usage-core');

// Token 用量: the 任务看板 page's fourth tab. Real renderer and a real scan in
// the utility process, over made-up CLI logs in <profile>/usage-home (a test
// profile never reads the real home). Set AGENTDECK_TOKEN_USAGE_SHOTS to a
// folder to keep PNGs of both themes.
const shots = process.env.AGENTDECK_TOKEN_USAGE_SHOTS;
let application, page, profile;
const errors = [];

async function screenshot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css' });
}
async function resize(width, height) {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
}

// 30 days of logs: Claude Code (two seats, one message written twice and
// replayed into a second file), Codex rollouts, claude-ds on DeepSeek, and a
// day with nothing at all (3 days ago). Returns the expected sums per day and
// model, built the way the scanner must count them.
function seed(home) {
  const expected = {};
  const add = (day, key, t) => { const d = expected[day] || (expected[day] = {}); d[key] = (d[key] || 0) + t; };
  let rnd = 7;
  const r = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const today = C.dayKey(Date.now());
  const claudeA = [], claudeB = [], ds = [];
  const codex = [];
  for (let back = 29; back >= 0; back--) {
    if (back === 3) continue;
    const day = C.addDays(today, -back);
    const at = (h) => new Date(C.dayStart(day) + h * 3600_000).toISOString();
    const claude = (file, id, model, h, size) => {
      const u = { input_tokens: Math.round(size * 0.002), output_tokens: Math.round(size * 0.01), cache_read_input_tokens: Math.round(size * 0.9), cache_creation_input_tokens: Math.round(size * 0.088) };
      file.push(JSON.stringify({ type: 'assistant', timestamp: at(h), message: { id, model, usage: u } }));
      return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    };
    const big = 1 + 0.8 * Math.sin(back / 3) ** 2;
    add(day, 'claude:claude-opus-5-5', claude(claudeA, `msg_o_${back}`, 'claude-opus-5-5', 9, 320e6 * big * (0.6 + r())));
    // the same message streamed twice and replayed into a resumed session: counted once
    claude(claudeA, `msg_o_${back}`, 'claude-opus-5-5', 9, 1000);
    claude(claudeB, `msg_o_${back}`, 'claude-opus-5-5', 10, 1000);
    add(day, 'claude:claude-sonnet-5-5', claude(claudeB, `msg_s_${back}`, 'claude-sonnet-5-5', 11, 70e6 * (0.5 + r())));
    if (back % 2 === 0) add(day, 'claude:claude-haiku-5-5', claude(claudeB, `msg_h_${back}`, 'claude-haiku-5-5', 12, 9e6 * (0.5 + r())));
    if (back % 5 === 1) add(day, 'claude:claude-fable-5-1', claude(claudeA, `msg_f_${back}`, 'claude-fable-5-1', 13, 4e6 * (0.5 + r())));
    if (back % 3 !== 2) add(day, 'deepseek:deepseek-v4-pro', claude(ds, `msg_d_${back}`, 'deepseek-v4-pro', 14, 22e6 * (0.5 + r())));
    for (const [model, size, h] of [['gpt-5.5', 160e6 * (0.4 + r()), 15], ['gpt-5.5-mini', back % 4 === 0 ? 6e6 * (0.5 + r()) : 0, 16]]) {
      if (!size) continue;
      const cached = Math.round(size * 0.93), input = Math.round(size * 0.985), output = Math.round(size - input);
      codex.push({ day, lines: [
        JSON.stringify({ type: 'turn_context', timestamp: at(h), payload: { model } }),
        JSON.stringify({ type: 'token_usage_record', timestamp: at(h), payload: { response_id: `resp_${model}_${back}`, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } }),
      ] });
      add(day, 'codex:' + model, input + output);
    }
  }
  const write = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.join('\n') + '\n'); };
  write(path.join(home, '.claude', 'projects', 'demo', 'a.jsonl'), claudeA);
  write(path.join(home, '.claude-us2', 'projects', 'demo', 'b.jsonl'), claudeB);
  write(path.join(home, '.local', 'claude-deepseek', 'config', 'projects', 'demo', 'c.jsonl'), ds);
  codex.forEach((c, i) => write(path.join(home, '.codex', 'sessions', c.day.replace(/-/g, '/'), `rollout-${i}.jsonl`), c.lines));
  return { today, expected };
}

let fixture;
async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-token-usage-'));
  fixture = seed(path.join(profile, 'usage-home'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', columns: [] }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => page.evaluate(() => typeof TaskBoardUI !== 'undefined' && typeof TokenUsageUI !== 'undefined')).toBe(true);
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  application = null;
});

const dayTotal = (day) => Object.values(fixture.expected[day] || {}).reduce((a, b) => a + b, 0);
const rangeTotal = (n) => C.dayRange(fixture.today, n).reduce((s, d) => s + dayTotal(d), 0);
// Every total label's box and every column's box, in page pixels.
const geometry = () => page.evaluate(() => [...document.querySelectorAll('.tu-col')].map((g) => {
  const box = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
  const segs = [...g.querySelectorAll('.tu-seg')];
  const label = g.querySelector('.tu-total');
  return {
    day: g.dataset.day,
    label: label ? { text: label.textContent, ...box(label), transform: getComputedStyle(label).transform, rotate: label.getAttribute('transform') } : null,
    segs: segs.map((s) => ({ key: s.dataset.key, ...box(s) })),
    stub: !!g.querySelector('.tu-stub'),
  };
}));

test('Token 用量 tab: totals, biggest model at the bottom, horizontal labels, hover, day table, range, sources, both themes', async () => {
  await launch();
  await resize(1440, 900);
  await page.locator('#navTop .nav-row[data-nav="tasks"]').click();
  const view = page.locator('#taskBoardView');
  await expect(view).toBeVisible();
  const tab = view.locator('.board-mode button[data-view="tokens"]');
  await expect(tab).toHaveText('Token 用量');
  await tab.click();
  await expect(view).toHaveAttribute('data-mode', 'tokens');
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('.tbv-heading h1')).toHaveText('Token 用量');
  await expect(view.locator('.tbv-body')).toBeHidden();
  await expect(view.locator('.tbv-filters')).toBeHidden();

  // the range total on top, the provider split beside it
  await expect(view.locator('.tu-hero-num')).toHaveText(C.formatShort(rangeTotal(7)), { timeout: 30000 });
  const providers = { anthropic: 0, openai: 0, google: 0, other: 0 };
  for (const d of C.dayRange(fixture.today, 7)) for (const [k, v] of Object.entries(fixture.expected[d] || {})) providers[C.providerOf(k.split(':')[0])] += v;
  for (const p of C.PROVIDERS) await expect(view.locator(`.tu-provider[data-provider="${p.key}"] .tu-provider-num`)).toHaveText(C.formatShort(providers[p.key]));

  // one column per day; each cap carries its day's total; the empty day keeps a stub and no number
  await expect(view.locator('.tu-col')).toHaveCount(7);
  const empty = C.addDays(fixture.today, -3);
  let cols = await geometry();
  for (const c of cols) {
    if (c.day === empty) { expect(c.stub).toBe(true); expect(c.label).toBeNull(); continue; }
    expect(c.label.text, c.day).toBe(C.formatShort(dayTotal(c.day)));
    // biggest model at the bottom, then smaller and smaller towards the top (drawn bottom-up)
    const order = Object.entries(fixture.expected[c.day]).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const keys = c.segs.map((s) => s.key);
    expect(keys[0], c.day).toBe(order[0]);
    const heights = c.segs.map((s) => s.b - s.t);
    for (let i = 1; i < heights.length; i++) expect(heights[i], `${c.day} segment ${i}`).toBeLessThanOrEqual(heights[i - 1] + 0.5);
    for (let i = 1; i < c.segs.length; i++) expect(c.segs[i].b, 'stacked upwards with a gap').toBeLessThan(c.segs[i - 1].t + 0.01);
    // the label sits above its own column
    expect(c.label.b).toBeLessThanOrEqual(c.segs[c.segs.length - 1].t + 0.5);
  }
  // the duplicated message counted once: the scan matches the fixture to the token
  const scanned = await page.evaluate(() => window.deck.tokenUsage(false));
  for (const d of C.dayRange(fixture.today, 30)) expect(C.dayTotal(scanned.days[d]), d).toBe(dayTotal(d));
  // only six models get a colour of their own; the rest share 其他模型
  await expect(view.locator('.tu-legend-item')).toHaveCount(7);
  await expect(view.locator('.tu-legend-item').last()).toContainText('其他模型');
  await expect(view.locator('.tu-legend-item').first()).toContainText('Opus 5.5');

  // hover a column: its models, biggest first, in a tooltip that stays inside the chart
  const chart = view.locator('.tu-chart');
  const target = C.addDays(fixture.today, -1);
  const col = view.locator(`.tu-col[data-day="${target}"] .tu-hit`);
  await col.hover({ position: { x: 4, y: 12 } });
  const tip = view.locator('.tu-tip');
  await expect(tip).toBeVisible();
  await expect(tip.locator('.tu-tip-day')).toHaveText(C.dayTitle(target, fixture.today));
  await expect(tip.locator('.tu-tip-total')).toHaveText(C.formatShort(dayTotal(target)));
  await expect(tip.locator('.tu-tip-list li')).toHaveCount(Object.keys(fixture.expected[target]).length);
  await expect(tip.locator('.tu-tip-name').first()).toHaveText('Opus 5.5');
  const [tb, cb] = await Promise.all([tip.boundingBox(), chart.boundingBox()]);
  expect(tb.x).toBeGreaterThanOrEqual(cb.x - 0.5);
  expect(tb.x + tb.width).toBeLessThanOrEqual(cb.x + cb.width + 0.5);
  await screenshot('after-dark-1440-hover');

  // a click picks the day for the table: one row per model with exact numbers
  await col.click({ position: { x: 4, y: 12 } });
  await expect(view.locator('.tu-table-day')).toHaveText(C.dayTitle(target, fixture.today));
  await expect(view.locator('.tu-table tbody tr')).toHaveCount(Object.keys(fixture.expected[target]).length);
  await expect(view.locator('.tu-table-total')).toHaveText('合计 ' + C.formatFull(dayTotal(target)));
  // the keyboard walks the days too
  await chart.focus();
  await page.keyboard.press('ArrowRight');
  await expect(view.locator('.tu-table-day')).toHaveText(C.dayTitle(fixture.today, fixture.today));
  await page.mouse.move(5, 5);

  // where the numbers come from
  await expect(view.locator('.tu-source[data-source="claude"]')).toHaveClass(/ok/);
  await expect(view.locator('.tu-source[data-source="codex"]')).toHaveClass(/ok/);
  await expect(view.locator('.tu-source[data-source="chatgpt-web"] .tu-source-state')).toHaveText('无数据');
  // tool actions are icon buttons with a tooltip and an accessible name
  const refresh = view.locator('.tu-refresh');
  await expect(refresh).toHaveAttribute('aria-label', '重新读取用量');
  await expect(refresh).toHaveAttribute('title', '重新读取用量');
  expect((await refresh.innerText()).trim()).toBe('');
  await refresh.click();
  await expect(refresh).not.toHaveClass(/busy/, { timeout: 30000 });
  await screenshot('after-dark-1440');
  await page.evaluate(() => applyTheme('light'));
  await page.waitForTimeout(400);
  await screenshot('after-light-1440');

  // 30 days: every number stays horizontal and whole, none overlaps another or a column
  await view.locator('.tu-range button[data-days="30"]').click();
  await expect(view.locator('.tu-col')).toHaveCount(30);
  await expect(view.locator('.tu-hero-num')).toHaveText(C.formatShort(rangeTotal(30)));
  await expect.poll(() => page.evaluate(() => config.tokenUsageView && config.tokenUsageView.days)).toBe(30);
  for (const [w, h] of [[1440, 900], [1024, 760], [720, 760]]) {
    await resize(w, h);
    await page.waitForTimeout(150);
    cols = await geometry();
    const labels = cols.filter((c) => c.label);
    for (const c of labels) { expect(c.label.transform).toBe('none'); expect(c.label.rotate).toBeNull(); }
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i].label, b = labels[j].label;
        const hit = a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
        expect(hit, `${w}px: ${labels[i].day} and ${labels[j].day} labels overlap`).toBe(false);
      }
      for (const c of cols) {
        if (c === labels[i]) continue;
        for (const s of c.segs) {
          const a = labels[i].label;
          const hit = a.l < s.r && a.r > s.l && a.t < s.b && a.b > s.t;
          expect(hit, `${w}px: ${labels[i].day} label covers ${c.day}'s column`).toBe(false);
        }
      }
    }
    if (w === 1440) { await screenshot('after-light-1440-30d'); await page.evaluate(() => applyTheme('dark')); await page.waitForTimeout(300); await screenshot('after-dark-1440-30d'); await page.evaluate(() => applyTheme('light')); }
    // nothing in the toolbar is cut: the title stays whole or, too narrow for it, gives way to the lit tab
    const cut = await page.evaluate(() => [...document.querySelectorAll('#taskBoardView .tbv-heading h1, #taskBoardView .board-mode button, .tu-range button, .tu-legend-name')]
      .filter((n) => n.getClientRects().length && n.scrollWidth > n.clientWidth + 0.5).map((n) => n.textContent));
    expect(cut, `${w}px`).toEqual([]);
    if (w === 720) await screenshot('after-light-720-30d');
  }
  // too narrow for 30 columns: the chart scrolls inside its box, opened at today
  const scroll = await chart.evaluate((n) => ({ sw: n.scrollWidth, cw: n.clientWidth, left: n.scrollLeft }));
  expect(scroll.sw).toBeGreaterThan(scroll.cw);
  expect(scroll.left + scroll.cw).toBeGreaterThanOrEqual(scroll.sw - 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await resize(1440, 900);

  // back to the board in place; the sidebar entry also brings the board back from Token 用量
  await view.locator('.board-mode button[data-view="tasks"]').click();
  await expect(view).toHaveAttribute('data-mode', 'tasks');
  await expect(view.locator('.tbv-body')).toBeVisible();
  await expect(view.locator('.tu-view')).toBeHidden();
  await tab.click();
  await page.locator('#navTop .nav-row[data-nav="tasks"]').click();
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute('data-mode', 'tasks');
  // the crew map's own tab opens Token 用量 straight away
  await view.locator('.board-mode button[data-view="crew"]').click();
  await expect(view).toBeHidden();
  await page.locator('#boardTokensTab').click();
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute('data-mode', 'tokens');
  await expect(view.locator('.tu-range button[data-days="30"]')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('Token 用量 with no logs at all: zero, stubs for every day, every source says 无数据', async () => {
  await launch();
  fs.rmSync(path.join(profile, 'usage-home'), { recursive: true, force: true });
  await resize(1280, 820);
  await page.evaluate(() => TaskBoardUI.open('tokens'));
  const view = page.locator('#taskBoardView');
  await expect(view.locator('.tu-hero-num')).toHaveText('0', { timeout: 30000 });
  await expect(view.locator('.tu-col')).toHaveCount(await page.evaluate(() => (config.tokenUsageView && config.tokenUsageView.days) || 7));
  await expect(view.locator('.tu-stub')).toHaveCount(7);
  await expect(view.locator('.tu-total')).toHaveCount(0);
  await expect(view.locator('.tu-empty')).toBeVisible();
  await expect(view.locator('.tu-table-empty')).toBeVisible();
  for (const id of ['claude', 'codex', 'antigravity', 'chatgpt-web']) await expect(view.locator(`.tu-source[data-source="${id}"] .tu-source-state`)).toHaveText('无数据');
  await screenshot('after-dark-1280-empty');
  expect(errors).toEqual([]);
});
