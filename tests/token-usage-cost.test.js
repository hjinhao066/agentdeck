const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../token-usage-core');
const PRICES = require('../token-prices.json');

const M = 1e6;
const usd = (cost) => cost.reduce((a, b) => a + b, 0);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} ≠ ${b}`);
const rec = (model, extra = {}) => ({ source: 'claude', key: 'k', ts: Date.UTC(2026, 9, 10, 12), model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...extra });

test('price file: every model names its vendor, an official source and the day it was read; every alias and plan resolves', () => {
  for (const [id, p] of Object.entries(PRICES.models)) {
    assert.match(p.source, /^https:\/\/(platform\.claude\.com|developers\.openai\.com|ai\.google\.dev|docs\.x\.ai|api-docs\.deepseek\.com)\//, id);
    assert.match(p.checked, /^\d{4}-\d{2}-\d{2}$/, id);
    assert.ok(p.vendor && p.name, id);
    for (const k of ['input', 'output']) assert.ok(p[k] > 0, `${id} ${k}`);
  }
  for (const [alias, id] of Object.entries(PRICES.aliases)) assert.ok(PRICES.models[id], alias);
  for (const [plan, p] of Object.entries(PRICES.plans)) { assert.ok(p.usd > 0, plan); assert.match(p.source, /^https:\/\/(claude\.com|support\.claude\.com)\//, plan); }
  // spot checks against the official pages read on 2026-10-09
  assert.deepEqual(['input', 'cacheWrite', 'cacheWrite1h', 'cacheRead', 'output'].map((k) => PRICES.models['claude-opus-5-5'][k]), [4, 5, 8, 0.2, 20]);
  assert.deepEqual(['input', 'cacheWrite', 'cacheWrite1h', 'cacheRead', 'output'].map((k) => PRICES.models['claude-sonnet-5-5'][k]), [2, 2.5, 4, 0.1, 10]);
  assert.equal(PRICES.plans['Max 20x'].usd, 200);
  assert.equal(PRICES.plans.Pro.usd, 20);
});

test('price lookup: dated, effort and alias names find their model; a model without an official price finds nothing', () => {
  const id = (m) => { const p = C.priceOf(m, PRICES); return p && p.name; };
  assert.equal(id('claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(id('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5');
  assert.equal(id('claude-opus-5-5-high'), 'Claude Opus 5.5', 'Cursor names the effort');
  assert.equal(id('gemini-3.8-flash-high'), 'Gemini 3.8 Flash', 'Antigravity names the thinking level');
  assert.equal(id('gemini-3.8-flash-medium'), 'Gemini 3.8 Flash');
  assert.equal(id('grok-4.7-high-fast'), 'Grok 4.7 Fast');
  assert.equal(id('GPT-6.1-Sol'), 'GPT-6.1 Sol');
  for (const none of ['auto', 'gpt-oss-120b-medium', 'cursor-grok-4.6-high-fast', 'antigravity-m322', 'unknown', '', null]) assert.equal(C.priceOf(none, PRICES), null, String(none));
});

test('cost: each kind of token at its own price; the 1-hour cache write apart from the 5-minute one; thinking is output', () => {
  const opus = C.priceOf('claude-opus-5-5', PRICES);
  const cost = C.recordCost(rec('claude-opus-5-5', { input: M, output: M, cacheRead: M, cacheWrite: M, cacheWrite1h: 0.4 * M }), opus);
  assert.equal(cost.length, 4);
  near(cost[0], 4, 'input');
  near(cost[1], 20, 'output');
  near(cost[2], 0.2, 'cache read');
  near(cost[3], 0.6 * 5 + 0.4 * 8, 'cache write: 5-minute and 1-hour');
  // without a split every write is a 5-minute write
  near(C.recordCost(rec('claude-opus-5-5', { cacheWrite: M }), opus)[3], 5);
  // fast mode and US-only inference
  near(usd(C.recordCost(rec('claude-opus-5-5', { input: M, output: M, cacheRead: M, cacheWrite: M, fast: true }), opus)), 8 + 40 + 0.4 + 10);
  near(usd(C.recordCost(rec('claude-opus-5-5', { input: M, geoUs: true }), opus)), 4.4);
  // a vendor without a cache-write or cache-read price charges input price for them
  const gpt55 = C.priceOf('gpt-5.5', PRICES);
  near(C.recordCost(rec('gpt-5.5', { cacheWrite: 1000 }), gpt55)[3], 0.005);
  near(C.recordCost(rec('deepseek-flash', { cacheWrite: M, ts: Date.UTC(2026, 9, 6, 2) }), C.priceOf('deepseek-flash', PRICES))[3], 0.3);
});

test('cost: a long prompt moves the whole request to the long-context price; DeepSeek is half price off-peak', () => {
  const haiku = C.priceOf('claude-haiku-5-5', PRICES);
  near(usd(C.recordCost(rec('claude-haiku-5-5', { input: 1000, cacheRead: 99000, output: M }), haiku)), 0.1 * 0.001 + 0.01 * 0.099 + 0.5, '100,000 is not over');
  near(usd(C.recordCost(rec('claude-haiku-5-5', { input: 1001, cacheRead: 99000, output: M }), haiku)), 0.5 * 0.001001 + 0.05 * 0.099 + 2.5, 'over 100,000: every token of the request');
  const sol = C.priceOf('gpt-6.1-sol', PRICES);
  near(usd(C.recordCost(rec('gpt-6.1-sol', { input: 272000, output: 0 }), sol)), 2 * 0.272);
  near(usd(C.recordCost(rec('gpt-6.1-sol', { input: 272001, output: 0 }), sol)), 4 * 0.272001);
  const ds = C.priceOf('deepseek-v4-pro', PRICES);
  const at = (d, h) => Date.UTC(2026, 9, d, h, 30);       // 2026-10-05 is a Monday
  near(usd(C.recordCost(rec('deepseek-v4-pro', { input: M, ts: at(5, 2) }), ds)), 1.32, 'Monday 02:30 UTC is peak');
  near(usd(C.recordCost(rec('deepseek-v4-pro', { input: M, ts: at(5, 4) }), ds)), 0.66, 'Monday 04:30 UTC is off-peak');
  near(usd(C.recordCost(rec('deepseek-v4-pro', { input: M, ts: at(5, 9) }), ds)), 1.32);
  near(usd(C.recordCost(rec('deepseek-v4-pro', { input: M, ts: at(4, 2) }), ds)), 0.66, 'Sunday is off-peak');
});

test('Claude lines carry the 1-hour cache write, fast mode and US-only inference only when the log says so', () => {
  const line = (usage) => ({ type: 'assistant', timestamp: '2026-10-08T10:00:00Z', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 40, ...usage } } });
  const [plain] = C.claudeRecords(line({}));
  assert.equal('cacheWrite1h' in plain, false);
  assert.equal('fast' in plain, false);
  const [r] = C.claudeRecords(line({ cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 }, speed: 'fast', inference_geo: 'us' }));
  assert.equal(r.cacheWrite, 40);
  assert.equal(r.cacheWrite1h, 30);
  assert.equal(r.fast, true);
  assert.equal(r.geoUs, true);
  const [g] = C.claudeRecords(line({ speed: 'standard', inference_geo: 'global', cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } }));
  assert.equal('fast' in g || 'geoUs' in g || 'cacheWrite1h' in g, false);
});

test('daily costs: per local day and model; a model without an official price is null, never 0', () => {
  const day = C.dayKey(Date.UTC(2026, 9, 8, 18));
  const records = [
    { ...rec('claude-opus-5-5', { input: M, ts: Date.UTC(2026, 9, 8, 18) }), key: 'a' },
    { ...rec('claude-opus-5-5', { output: M, ts: Date.UTC(2026, 9, 8, 19) }), key: 'b' },
    { ...rec('auto', { input: M, ts: Date.UTC(2026, 9, 8, 18) }), source: 'cursor', key: 'c' },
  ];
  const costs = C.dailyCosts(records, '2026-10-01', '2026-10-31', PRICES);
  assert.deepEqual(costs[day]['claude:claude-opus-5-5'].map((v) => +v.toFixed(6)), [4, 20, 0, 0]);
  assert.equal(costs[day]['cursor:auto'], null);
  assert.deepEqual(Object.keys(C.pricedDay(costs[day])), ['claude:claude-opus-5-5']);
  assert.deepEqual(C.unpricedKeys(costs[day]), ['cursor:auto']);
  assert.equal(C.dayTotal(C.pricedDay(costs[day])), 24, 'a priced day reads like a token day');
});

test('money format: dollars with thousands separators and two decimals', () => {
  assert.equal(C.formatUsd(1234.567), '$1,234.57');
  assert.equal(C.formatUsd(0), '$0.00');
  assert.equal(C.formatUsd(0.004), '$0.00');
  assert.equal(C.formatUsd(43398.2), '$43,398.20');
  assert.equal(C.formatUsd(1e6), '$1,000,000.00');
  assert.equal(C.formatTimes(10.849), '10.8 倍');
  assert.equal(C.formatTimes(217.4), '217 倍');
  assert.equal(C.formatTimes(0.42), '0.42 倍');
});

test('billing cycle: monthly from the subscription day, the end of a short month clamped', () => {
  assert.deepEqual(C.cycleOf('2026-06-11', '2026-10-09'), { start: '2026-09-11', end: '2026-10-11', days: 30 });
  assert.deepEqual(C.cycleOf('2026-06-11', '2026-10-11'), { start: '2026-10-11', end: '2026-11-11', days: 31 });
  assert.deepEqual(C.cycleOf('2026-10-08', '2026-10-09'), { start: '2026-10-08', end: '2026-11-08', days: 31 });
  assert.deepEqual(C.cycleOf('2026-01-31', '2026-02-15'), { start: '2026-01-31', end: '2026-02-28', days: 28 });
  assert.deepEqual(C.cycleOf('2026-01-31', '2026-03-05'), { start: '2026-02-28', end: '2026-03-31', days: 31 });
  assert.equal(C.cycleOf('', '2026-10-09'), null);
  assert.equal(C.cycleOf('2026-11-01', '2026-10-09'), null, 'a start in the future is no cycle');
});

test('subscription value: spent this cycle, times the price, per day so far, and the whole cycle at that pace', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  const v = C.subscriptionValue({ days: { '2026-10-07': 999, '2026-10-08': 1000, '2026-10-09': 500 }, cycle: { start: '2026-10-08', end: '2026-11-08', days: 31 }, now, price: 200 });
  assert.equal(v.spent, 1500, 'only days inside the cycle');
  near(v.elapsed, 1.5);
  near(v.perDay, 1000);
  near(v.projected, 31000);
  near(v.times, 7.5);
  near(v.projectedTimes, 155);
  // the first hours of a cycle are not stretched into a day
  const early = C.subscriptionValue({ days: { '2026-10-09': 10 }, cycle: { start: '2026-10-09', end: '2026-11-09', days: 31 }, now: new Date(2026, 9, 9, 2).getTime(), price: 20 });
  near(early.perDay, 10);
  // no known price: the value, no multiple
  const free = C.subscriptionValue({ days: { '2026-10-09': 10 }, cycle: { start: '2026-10-09', end: '2026-11-09', days: 31 }, now, price: 0 });
  assert.equal(free.times, null);
  assert.equal(free.projectedTimes, null);
});

test('value rows: one row per account; seats sharing a log directory share a row; the plan price comes from the price file', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  const seatCosts = [
    { seats: ['cn', 'us'], days: { '2026-10-08': 30, '2026-10-09': 10 } },
    { seats: ['us2'], days: { '2026-10-08': 1000, '2026-10-09': 500 } },
    { seats: ['old'], days: { '2026-10-01': 5 } },
  ];
  const infos = [
    { id: 'cn', name: 'CN', accountEmail: 'sub@example.com', plan: 'Pro', subscribedAt: '2026-10-05T01:00:13Z', loggedIn: true },
    { id: 'us', name: 'US', accountEmail: 'sub@example.com', plan: 'Pro', subscribedAt: '2026-10-05T01:00:13Z', loggedIn: false },
    { id: 'us2', name: 'US2', accountEmail: 'paid@example.com', plan: 'Max 20x', subscribedAt: '2026-06-11T21:50:13Z', loggedIn: true },
  ];
  const rows = C.valueRows({ seatCosts, infos, plans: PRICES.plans, starts: { paid: '2026-10-08' }, today: '2026-10-09', now });
  assert.deepEqual(rows.map((r) => r.key), ['paid', 'sub'], 'the biggest value first; a seat gone from the settings is left out');
  const [paid, sub] = rows;
  assert.equal(paid.plan, 'Max 20x');
  assert.equal(paid.price, 200);
  assert.deepEqual(paid.seats, ['us2']);
  assert.deepEqual(paid.cycle, { start: '2026-10-08', end: '2026-11-08', days: 31 }, 'the start the user set wins');
  assert.equal(paid.custom, true);
  assert.equal(paid.value.spent, 1500);
  near(paid.value.times, 7.5);
  assert.deepEqual(sub.seats, ['cn', 'us']);
  assert.equal(sub.price, 20, 'one account behind two seats pays once');
  assert.deepEqual(sub.cycle, { start: '2026-10-05', end: '2026-11-05', days: 31 }, 'from the subscription day by default');
  assert.equal(sub.custom, false);
  assert.equal(sub.value.spent, 40);
  // two accounts on one log directory: both plans, both names
  const shared = C.valueRows({ seatCosts: [seatCosts[0]], infos: [infos[0], { ...infos[1], accountEmail: 'other@example.com', plan: 'Max 5x' }], plans: PRICES.plans, starts: {}, today: '2026-10-09', now });
  assert.equal(shared.length, 1);
  assert.equal(shared[0].key, 'other+sub');
  assert.equal(shared[0].price, 120);
  // an unknown plan: no price, so no multiple
  const unknown = C.valueRows({ seatCosts: [seatCosts[1]], infos: [{ ...infos[2], plan: 'Team' }], plans: PRICES.plans, starts: {}, today: '2026-10-09', now });
  assert.equal(unknown[0].price, 0);
  assert.equal(unknown[0].value.times, null);
});

test('view settings: the range, Token or 金额, and the cycle starts the user set; anything else dropped', () => {
  assert.deepEqual(C.viewPrefs(undefined), { days: 7, unit: 'tokens', starts: {} });
  assert.deepEqual(C.viewPrefs({ days: 30, unit: 'usd', starts: { hjinhao066us: '2026-10-08', bad: '10/8', ['x'.repeat(300)]: '2026-10-08', other: 5 }, extra: 1 }),
    { days: 30, unit: 'usd', starts: { hjinhao066us: '2026-10-08' } });
  assert.deepEqual(C.viewPrefs({ days: 14, unit: 'eur', starts: [] }), { days: 7, unit: 'tokens', starts: {} });
  assert.equal(C.viewPrefs({ starts: { ['__proto__']: '2026-10-08' } }).starts.__proto__, Object.prototype, 'no prototype key');
});

test('the page helpers the 订阅值不值 card uses are exported', () => {
  for (const fn of ['dayParts', 'dayStart', 'valueRows', 'formatUsd', 'formatTimes', 'viewPrefs', 'pricedDay', 'unpricedKeys']) assert.equal(typeof C[fn], 'function', fn);
  assert.deepEqual(C.dayParts('2026-10-08'), { y: 2026, m: 10, d: 8, week: '周四' });
});

test('labels: a label may sit off its column centre (kept inside the chart) while bars still collide at the column', () => {
  // two columns 30px apart, 20px bars; the right label is pulled 10px left to stay inside the chart
  const cols = [{ x: 15, top: 100, w: 20 }, { x: 45, lx: 35, top: 100, w: 20 }];
  const { bottoms } = C.placeLabels(cols, { barWidth: 20, base: 200, lineHeight: 13, pad: 3, gap: 2 });
  assert.equal(bottoms[0], 97);
  assert.ok(bottoms[1] < bottoms[0] - 13, 'it overlaps the first label, so it steps up above it');
  // without lx the same label fits beside the first
  assert.equal(C.placeLabels([cols[0], { x: 45, top: 100, w: 20 }], { barWidth: 20, base: 200, lineHeight: 13, pad: 3, gap: 2 }).bottoms[1], 97);
});
