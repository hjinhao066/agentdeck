const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../../token-usage-core');
const PRICES = require('../../token-prices.json');
const STAND_IN_CREDENTIAL = require('./fixtures/stand-in-credential');

// Token 用量: the 任务看板 page's fourth tab. Real renderer and a real scan in
// the utility process, over made-up CLI logs in <profile>/usage-home (a test
// profile never reads the real home). Set AGENTDECK_TOKEN_USAGE_SHOTS to a
// folder to keep PNGs of both themes.
const shots = process.env.AGENTDECK_TOKEN_USAGE_SHOTS;
// Each test starts its own Electron. With twenty agent sessions running (load
// average 400-500) the page alone takes ~15 s to load, so the 60 s default is too
// tight; the scan itself takes under 2 s.
test.describe.configure({ timeout: 120000 });
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
// Dollars too: costs[day][key] at the official prices (null: no official price),
// and each seat directory's dollars per day (the 订阅值不值 rows).
function seed(home) {
  const expected = {}, costs = {}, groups = { cn: {}, us2: {} }, tokens = { cn: {}, us2: {} };
  const add = (day, key, t) => { const d = expected[day] || (expected[day] = {}); d[key] = (d[key] || 0) + t; };
  const addCost = (day, key, r, group) => {
    const d = costs[day] || (costs[day] = {});
    const price = C.priceOf(r.model, PRICES);
    if (!price) { d[key] = null; return; }
    const c = C.recordCost(r, price);
    const v = d[key] || (d[key] = [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) v[i] += c[i];
    if (group) groups[group][day] = (groups[group][day] || 0) + c[0] + c[1] + c[2] + c[3];
  };
  let rnd = 7;
  const r = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const today = C.dayKey(Date.now());
  const claudeA = [], claudeB = [], ds = [];
  const codex = [];
  for (let back = 29; back >= 0; back--) {
    if (back === 3) continue;
    const day = C.addDays(today, -back);
    const at = (h) => new Date(C.dayStart(day) + h * 3600_000).toISOString();
    // a counted message: its tokens and its dollars (group: the seat directory it was written in)
    const claude = (file, id, model, h, size, source, group) => {
      const u = { input_tokens: Math.round(size * 0.002), output_tokens: Math.round(size * 0.01), cache_read_input_tokens: Math.round(size * 0.9), cache_creation_input_tokens: Math.round(size * 0.088) };
      file.push(JSON.stringify({ type: 'assistant', timestamp: at(h), message: { id, model, usage: u } }));
      if (!source) return;
      add(day, `${source}:${model}`, u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens);
      if (group) tokens[group][day] = (tokens[group][day] || 0) + u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
      addCost(day, `${source}:${model}`, { ts: Date.parse(at(h)), model, input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }, group);
    };
    const big = 1 + 0.8 * Math.sin(back / 3) ** 2;
    claude(claudeA, `msg_o_${back}`, 'claude-opus-5-5', 9, 320e6 * big * (0.6 + r()), 'claude', 'cn');
    // the same message streamed twice and replayed into a resumed session: counted once
    claude(claudeA, `msg_o_${back}`, 'claude-opus-5-5', 9, 1000);
    claude(claudeB, `msg_o_${back}`, 'claude-opus-5-5', 10, 1000);
    claude(claudeB, `msg_s_${back}`, 'claude-sonnet-5-5', 11, 70e6 * (0.5 + r()), 'claude', 'us2');
    if (back % 2 === 0) claude(claudeB, `msg_h_${back}`, 'claude-haiku-5-5', 12, 9e6 * (0.5 + r()), 'claude', 'us2');
    if (back % 5 === 1) claude(claudeA, `msg_f_${back}`, 'claude-fable-5-1', 13, 4e6 * (0.5 + r()), 'claude', 'cn');
    if (back % 3 !== 2) claude(ds, `msg_d_${back}`, 'deepseek-v4-pro', 14, 22e6 * (0.5 + r()), 'deepseek');
    for (const [model, size, h] of [['gpt-5.5', 160e6 * (0.4 + r()), 15], ['gpt-5.5-mini', back % 4 === 0 ? 6e6 * (0.5 + r()) : 0, 16]]) {
      if (!size) continue;
      const cached = Math.round(size * 0.93), input = Math.round(size * 0.985), output = Math.round(size - input);
      codex.push({ day, lines: [
        JSON.stringify({ type: 'turn_context', timestamp: at(h), payload: { model } }),
        JSON.stringify({ type: 'token_usage_record', timestamp: at(h), payload: { response_id: `resp_${model}_${back}`, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } }),
      ] });
      add(day, 'codex:' + model, input + output);
      addCost(day, 'codex:' + model, { ts: Date.parse(at(h)), model, input: input - cached, output, cacheRead: cached, cacheWrite: 0 });
    }
  }
  const write = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.join('\n') + '\n'); };
  write(path.join(home, '.claude', 'projects', 'demo', 'a.jsonl'), claudeA);
  write(path.join(home, '.claude-us2', 'projects', 'demo', 'b.jsonl'), claudeB);
  write(path.join(home, '.local', 'claude-deepseek', 'config', 'projects', 'demo', 'c.jsonl'), ds);
  codex.forEach((c, i) => write(path.join(home, '.codex', 'sessions', c.day.replace(/-/g, '/'), `rollout-${i}.jsonl`), c.lines));
  return { today, expected, costs, groups, tokens };
}
// Two signed-in Claude accounts in the test profile's seats: a Pro one on CN and a
// Max 20x one on US2, each with the day its subscription started.
function seedSeats(home, today) {
  const seat = (dir, metaFile, account) => {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), STAND_IN_CREDENTIAL);
    fs.writeFileSync(path.join(home, metaFile), JSON.stringify({ oauthAccount: account, hasCompletedOnboarding: true }));
  };
  seat('.claude', '.claude.json', { emailAddress: 'pro@example.test', organizationType: 'claude_pro', organizationRateLimitTier: 'default_claude_ai', subscriptionCreatedAt: C.addDays(today, -20) + 'T12:00:00Z' });
  seat('.claude-us2', path.join('.claude-us2', '.claude.json'), { emailAddress: 'max@example.test', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x', subscriptionCreatedAt: C.addDays(today, -10) + 'T12:00:00Z' });
}

let fixture;
async function launch(config = {}) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-token-usage-'));
  fixture = seed(path.join(profile, 'usage-home'));
  seedSeats(path.join(profile, 'seats-home'), fixture.today);
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', columns: [], ...config }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  // a busy machine (twenty agent sessions) can take well over 5 s to load the page
  await expect.poll(() => page.evaluate(() => typeof TaskBoardUI !== 'undefined' && typeof TokenUsageUI !== 'undefined'), { timeout: 30000 }).toBe(true);
}
// TaskBoardUI exists before the renderer has run its init; on a busy machine the first
// call can land in between, so it is retried until the board opens on Token 用量.
const openTokensTab = () => expect.poll(() => page.evaluate(() => { try { TaskBoardUI.open('tokens'); return TaskBoardUI.mode(); } catch (_) { return ''; } }), { timeout: 30000 }).toBe('tokens');
// Token 用量 open with its numbers drawn.
async function openTokens(days) {
  await openTokensTab();
  const view = page.locator('#taskBoardView');
  await expect(view.locator('.tu-hero-num')).toHaveText(C.formatShort(rangeTotal(days)), { timeout: 30000 });
  return view;
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  application = null;
});

const dayTotal = (day) => Object.values(fixture.expected[day] || {}).reduce((a, b) => a + b, 0);
const usdOf = (v) => (v ? v.reduce((a, b) => a + b, 0) : 0);
const dayCost = (day) => Object.values(fixture.costs[day] || {}).reduce((a, v) => a + usdOf(v), 0);
const rangeCost = (n) => C.dayRange(fixture.today, n).reduce((s, d) => s + dayCost(d), 0);
const groupSince = (group, start) => Object.entries(fixture.groups[group]).filter(([d]) => d >= start).reduce((a, [, v]) => a + v, 0);
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

test('7 days: totals, biggest model on top, totals on the caps, hover, day table, sources, refresh icon, both themes', async () => {
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
  const cols = await geometry();
  for (const c of cols) {
    if (c.day === empty) { expect(c.stub).toBe(true); expect(c.label).toBeNull(); continue; }
    expect(c.label.text, c.day).toBe(C.formatShort(dayTotal(c.day)));
    // biggest model on top (the legend and the tooltip list it first), smaller and smaller
    // towards the bottom (drawn bottom-up, so the biggest is the last segment)
    const order = Object.entries(fixture.expected[c.day]).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const keys = c.segs.map((s) => s.key);
    expect(keys[keys.length - 1], c.day).toBe(order[0]);
    const heights = c.segs.map((s) => s.b - s.t);
    for (let i = 1; i < heights.length; i++) expect(heights[i], `${c.day} segment ${i}`).toBeGreaterThanOrEqual(heights[i - 1] - 2.5); // each upper segment gives up a 2px gap
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
  // 按席位目录: each seat directory's Claude tokens over the range, the larger first, with what it does not tell
  const seatCard = view.locator('.tu-seats');
  await expect(seatCard).toBeVisible({ timeout: 30000 });
  await expect(seatCard.locator('.tu-value-note')).toHaveText('按目录统计，目录换过号会算到当时的目录');
  const seatRows = seatCard.locator('.tu-seat-row');
  await expect(seatRows).toHaveCount(2);
  // named by the account signed in there now (pro on CN, max on US2), as the sidebar names seats
  const account = { cn: 'pro', us2: 'max' };
  const bySeat = Object.entries(fixture.tokens).map(([g, days]) => [account[g], C.dayRange(fixture.today, 7).reduce((s, d) => s + (days[d] || 0), 0)]).sort((a, b) => b[1] - a[1]);
  for (const [i, [name, total]] of bySeat.entries()) {
    await expect(seatRows.nth(i).locator('.tu-value-name')).toHaveText(name);
    await expect(seatRows.nth(i).locator('.tu-seat-num')).toHaveText(C.formatShort(total));
  }
  await screenshot('after-dark-1440');
  await page.evaluate(() => applyTheme('light'));
  await page.waitForTimeout(400);
  await screenshot('after-light-1440');
  expect(errors).toEqual([]);
});

// Every label overlapping another label or another day's column, and every turned label.
const labelProblems = (cols, w) => {
  const out = [];
  const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const labels = cols.filter((c) => c.label);
  for (const c of labels) if (c.label.transform !== 'none' || c.label.rotate !== null) out.push(`${w}px: ${c.day} label is turned`);
  labels.forEach((x, i) => {
    labels.slice(i + 1).forEach((y) => { if (hit(x.label, y.label)) out.push(`${w}px: ${x.day} and ${y.day} labels overlap`); });
    for (const c of cols) if (c !== x && c.segs.some((s) => hit(x.label, s))) out.push(`${w}px: ${x.day} label covers ${c.day}'s column`);
  });
  return out;
};

test('30 days: every total horizontal and whole at three widths, none over another; too narrow, the chart scrolls inside its box at today', async () => {
  await launch();
  await resize(1440, 900);
  const view = await openTokens(7);
  const chart = view.locator('.tu-chart');
  await view.locator('.tu-range button[data-days="30"]').click();
  await expect(view.locator('.tu-col')).toHaveCount(30);
  await expect(view.locator('.tu-hero-num')).toHaveText(C.formatShort(rangeTotal(30)));
  await expect.poll(() => page.evaluate(() => config.tokenUsageView && config.tokenUsageView.days)).toBe(30);
  for (const [w, h] of [[1440, 900], [1024, 760], [720, 760]]) {
    await resize(w, h);
    // the chart is redrawn for the new width before it is measured
    await expect.poll(() => chart.evaluate((n) => Math.abs(Number(n.querySelector('svg').getAttribute('width')) - Math.max(n.clientWidth, 22 * 30 + 12)) <= 2)).toBe(true);
    const cols = await geometry();
    expect(cols.filter((c) => c.label).length).toBe(29);
    expect(labelProblems(cols, w)).toEqual([]);
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
  expect(errors).toEqual([]);
});

test('tabs: 任务看板 and Token 用量 switch in place, the sidebar entry brings the board back, the crew map opens Token 用量 with its range remembered', async () => {
  await launch({ tokenUsageView: { days: 30 } });
  await resize(1440, 900);
  await page.locator('#navTop .nav-row[data-nav="tasks"]').click();
  const view = page.locator('#taskBoardView');
  const tab = view.locator('.board-mode button[data-view="tokens"]');
  await tab.click();
  await expect(view).toHaveAttribute('data-mode', 'tokens');
  await expect(view.locator('.tu-hero-num')).toHaveText(C.formatShort(rangeTotal(30)), { timeout: 30000 });
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

test('金额: dollars on every cap, in the tiles, the legend and the table; 无官方价 never counted as $0; 订阅值不值 per account, its cycle set with the pencil', async () => {
  await launch();
  await resize(1440, 900);
  const view = await openTokens(7);
  const usd = view.locator('.tu-unit button[data-unit="usd"]');
  await expect(usd).toHaveText('金额');
  await expect(view.locator('.tu-unit button[data-unit="tokens"]')).toHaveAttribute('aria-pressed', 'true');
  // the 订阅值不值 card is there in both units
  await expect(view.locator('.tu-value')).toBeVisible({ timeout: 30000 });
  await usd.click();
  await expect(usd).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('.tu-seats')).toBeHidden();
  await expect(view.locator('.tu-hero-num')).toHaveText(C.formatUsd(rangeCost(7)));
  await expect(view.locator('.tu-hero-cap')).toHaveText('按官方 API 价折算');
  await expect.poll(() => page.evaluate(() => config.tokenUsageView && config.tokenUsageView.unit)).toBe('usd');
  const providers = { anthropic: 0, openai: 0, google: 0, other: 0 };
  for (const d of C.dayRange(fixture.today, 7)) for (const [k, v] of Object.entries(fixture.costs[d] || {})) providers[C.providerOf(k.split(':')[0])] += usdOf(v);
  for (const p of C.PROVIDERS) await expect(view.locator(`.tu-provider[data-provider="${p.key}"] .tu-provider-num`)).toHaveText(C.formatUsd(providers[p.key]));

  // every cap carries its day's dollars; the biggest model by dollars on top; nothing turned or overlapping
  const cols = await geometry();
  for (const c of cols) {
    if (!dayCost(c.day)) { expect(c.label).toBeNull(); continue; }
    expect(c.label.text, c.day).toBe(C.formatUsd(dayCost(c.day)));
    const order = Object.entries(fixture.costs[c.day]).filter(([, v]) => v).sort((a, b) => usdOf(b[1]) - usdOf(a[1])).map(([k]) => k);
    expect(c.segs[c.segs.length - 1].key, c.day).toBe(order[0]);
  }
  expect(labelProblems(cols, 1440)).toEqual([]);
  // a model without an official price: 无官方价 in the legend, the tooltip and the table, never $0
  const mini = view.locator('.tu-legend-item', { hasText: 'GPT-5.5 Mini' });
  await expect(mini.locator('.tu-legend-num')).toHaveText('无官方价');
  const miniDay = C.dayRange(fixture.today, 7).reverse().find((d) => fixture.costs[d] && fixture.costs[d]['codex:gpt-5.5-mini'] === null);
  const col = view.locator(`.tu-col[data-day="${miniDay}"] .tu-hit`);
  await col.hover({ position: { x: 4, y: 12 } });
  const tip = view.locator('.tu-tip');
  await expect(tip.locator('.tu-tip-total')).toHaveText(C.formatUsd(dayCost(miniDay)));
  await expect(tip.locator('.tu-tip-list li', { hasText: 'GPT-5.5 Mini' }).locator('.tu-tip-num')).toHaveText('无官方价');
  await expect(tip.locator('.tu-tip-foot')).toContainText('缓存读 $');
  await col.click({ position: { x: 4, y: 12 } });
  await expect(view.locator('.tu-table-total')).toHaveText('合计 ' + C.formatUsd(dayCost(miniDay)));
  await expect(view.locator('.tu-table tbody tr', { hasText: 'GPT-5.5 Mini' }).locator('td.strong')).toHaveText('无官方价');
  const opusRow = view.locator('.tu-table tbody tr', { hasText: 'Opus 5.5' });
  await expect(opusRow.locator('td.strong')).toHaveText(C.formatUsd(usdOf(fixture.costs[miniDay]['claude:claude-opus-5-5'])));
  await page.mouse.move(5, 5);

  // 订阅值不值: one row per account against its plan's price, this billing cycle; the dearest
  // plan leads, large, even though the Pro account here has spent more
  const card = view.locator('.tu-value');
  await expect(card).toBeVisible();
  const rows = card.locator('.tu-value-row');
  await expect(rows).toHaveCount(2, { timeout: 30000 });
  const max = rows.nth(0), pro = rows.nth(1);
  await expect(max).toHaveClass(/lead/);
  await expect(pro).not.toHaveClass(/lead/);
  const size = (row) => row.locator('.tu-value-times').evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
  expect(await size(max)).toBeGreaterThan(await size(pro) * 1.5);
  await expect(pro.locator('.tu-value-name')).toHaveText('pro');
  await expect(pro.locator('.tu-value-plan')).toHaveText('Pro');
  const proSpent = groupSince('cn', C.addDays(fixture.today, -20));
  await expect(pro.locator('.tu-value-spent')).toContainText(C.formatUsd(proSpent));
  await expect(pro.locator('.tu-value-times')).toHaveText(C.formatTimes(proSpent / 20));
  await expect(max.locator('.tu-value-name')).toHaveText('max');
  await expect(max.locator('.tu-value-plan')).toHaveText('Max 20x');
  await expect(max.locator('.tu-value-spent')).toContainText(C.formatUsd(groupSince('us2', C.addDays(fixture.today, -10))));
  await expect(card).toContainText('只算本机日志');
  await screenshot('usd-dark-1440');
  // the pencil sets where this account's cycle starts; it is remembered
  const edit = max.locator('.tu-value-edit');
  await expect(edit).toHaveAttribute('aria-label', '改周期起点');
  await expect(edit).toHaveAttribute('title', '改周期起点');
  expect((await edit.innerText()).trim()).toBe('');
  await edit.click();
  const start = C.addDays(fixture.today, -2);
  const input = max.locator('input[type="date"]');
  await expect(input).toBeFocused();
  await input.fill(start);
  await input.press('Enter');
  const spent = groupSince('us2', start);
  await expect(max.locator('.tu-value-spent')).toContainText(C.formatUsd(spent));
  await expect(max.locator('.tu-value-times')).toHaveText(C.formatTimes(spent / 200));
  await expect.poll(() => page.evaluate(() => config.tokenUsageView.starts)).toEqual({ max: start });
  // Esc leaves it as it was
  await edit.click();
  await max.locator('input[type="date"]').fill(C.addDays(fixture.today, -5));
  await max.locator('input[type="date"]').press('Escape');
  await expect(max.locator('input[type="date"]')).toHaveCount(0);
  await expect(max.locator('.tu-value-spent')).toContainText(C.formatUsd(spent));
  expect(await page.evaluate(() => config.tokenUsageView.starts)).toEqual({ max: start });
  await page.evaluate(() => applyTheme('light'));
  await page.waitForTimeout(400);
  await screenshot('usd-light-1440');
  // 30 days: every dollar label horizontal and whole, none over another
  await view.locator('.tu-range button[data-days="30"]').click();
  await expect(view.locator('.tu-hero-num')).toHaveText(C.formatUsd(rangeCost(30)));
  for (const [w, h] of [[1440, 900], [1024, 760]]) {
    await resize(w, h);
    await expect.poll(() => view.locator('.tu-chart').evaluate((n) => Math.abs(Number(n.querySelector('svg').getAttribute('width')) - Math.max(n.clientWidth, 22 * 30 + 12)) <= 2)).toBe(true);
    const cols = await geometry();
    expect(labelProblems(cols, w)).toEqual([]);
    // a wide dollar label over the first or last day stays inside the chart, never cut at its edge
    const svgBox = await view.locator('.tu-svg').boundingBox();
    const outside = cols.filter((c) => c.label && (c.label.l < svgBox.x - 0.5 || c.label.r > svgBox.x + svgBox.width + 0.5)).map((c) => c.day);
    expect(outside, `${w}px`).toEqual([]);
    const cut = await page.evaluate(() => [...document.querySelectorAll('.tu-hero-num, .tu-provider-num, .tu-value-row *, .tu-unit button, .tu-range button')]
      .filter((n) => n.getClientRects().length && n.children.length === 0 && n.scrollWidth > n.clientWidth + 0.5).map((n) => n.className + ' ' + n.textContent));
    expect(cut, `${w}px`).toEqual([]);
    // the line under the total (range, per day, today) wraps between its parts, never cut
    expect(await view.locator('.tu-hero-sub').evaluate((n) => n.scrollWidth <= n.clientWidth + 0.5), `${w}px`).toBe(true);
    await expect(view.locator('.tu-hero-sub')).toContainText('今天 ' + C.formatUsd(dayCost(fixture.today)));
    await screenshot(`usd-light-${w}-30d`);
  }
  // back to Token: tokens again; the 订阅值不值 card stays
  await view.locator('.tu-unit button[data-unit="tokens"]').click();
  await expect(view.locator('.tu-hero-num')).toHaveText(C.formatShort(rangeTotal(30)));
  await expect(view.locator('.tu-value-row.lead .tu-value-name')).toHaveText('max');
  expect(errors).toEqual([]);
});

test('Token 用量 with no logs at all: zero, stubs for every day, every source says 无数据', async () => {
  await launch();
  fs.rmSync(path.join(profile, 'usage-home'), { recursive: true, force: true });
  await resize(1280, 820);
  await openTokensTab();
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
