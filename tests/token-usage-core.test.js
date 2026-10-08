const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../token-usage-core');

const sum = (r) => r.input + r.output + r.cacheRead + r.cacheWrite;

test('Claude lines: one record per assistant message; synthetic and non-assistant lines count nothing; an advisor is its own model', () => {
  const line = (extra = {}) => ({ type: 'assistant', timestamp: '2026-10-08T10:00:00Z', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } }, ...extra });
  const [r] = C.claudeRecords(line());
  assert.deepEqual({ ...r }, { key: 'msg_1', ts: Date.parse('2026-10-08T10:00:00Z'), model: 'claude-opus-5-5', input: 10, output: 20, cacheRead: 300, cacheWrite: 40 });
  assert.deepEqual(C.claudeRecords({ ...line(), type: 'user' }), []);
  assert.deepEqual(C.claudeRecords(line({ message: { id: 'm', model: '<synthetic>', usage: { input_tokens: 5 } } })), []);
  assert.deepEqual(C.claudeRecords(line({ timestamp: 'nope' })), []);
  const withAdvisor = line();
  withAdvisor.message.usage.iterations = [{ type: 'message', input_tokens: 10 }, { type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: 7, output_tokens: 3 }];
  const recs = C.claudeRecords(withAdvisor);
  assert.equal(recs.length, 2, 'an iteration restating the main message is not counted again');
  assert.equal(recs[1].model, 'claude-fable-5-1');
  assert.equal(sum(recs[1]), 10);
});

test('merging: a message streamed in parts and replayed into another session counts once, with its fullest usage and first time', () => {
  const base = { source: 'claude', key: 'msg_1', model: 'claude-opus-5-5', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  const merged = C.mergeRecords([
    { ...base, ts: 2000 },
    { ...base, ts: 1000, output: 50 },          // the complete version, written later in the file but stamped earlier
    { ...base, ts: 3000, output: 50 },          // replayed into a resumed session
    { ...base, source: 'deepseek', ts: 5000 },  // another CLI's message with the same id is its own
    { ...base, key: '', ts: 1 },                // no identity: dropped
  ]);
  assert.equal(merged.length, 2);
  const claude = merged.find((r) => r.source === 'claude');
  assert.equal(claude.output, 50);
  assert.equal(claude.ts, 1000);
});

test('Codex: per-response records with the model from turn_context; cached input is cache read, never input twice', () => {
  const st = C.codexState();
  assert.equal(C.codexLine(st, { type: 'turn_context', payload: { model: 'gpt-5.5' } }), null);
  const r = C.codexLine(st, { type: 'token_usage_record', timestamp: '2026-10-07T08:03:16Z', payload: { response_id: 'resp_1', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } } });
  assert.deepEqual({ ...r }, { key: 'resp_1', ts: Date.parse('2026-10-07T08:03:16Z'), model: 'gpt-5.5', input: 100, output: 50, cacheRead: 900, cacheWrite: 0 });
  // a file with records never counts its token_count events
  const ev = { type: 'event_msg', timestamp: '2026-10-07T08:03:17Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 }, last_token_usage: { input_tokens: 1000, output_tokens: 50 } } } };
  assert.equal(C.codexLine(st, ev), null);
});

test('Codex: a context compaction call is counted (Codex writes no token_count for it, which is why ccusage reads 0.4–1.4% lower)', () => {
  // Real shape from a 10-07 rollout: the last turn's token_count, then the
  // compaction's own token_usage_record, then the compacted line.
  const st = C.codexState();
  C.codexLine(st, { type: 'turn_context', payload: { model: 'gpt-5.5' } });
  const lines = [
    { type: 'token_usage_record', timestamp: '2026-10-07T08:03:00Z', payload: { response_id: 'resp_turn', usage: { input_tokens: 240000, cached_input_tokens: 239000, output_tokens: 300 } } },
    { type: 'event_msg', timestamp: '2026-10-07T08:03:00Z', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 240300 }, last_token_usage: { input_tokens: 240000, output_tokens: 300 } } } },
    { type: 'token_usage_record', timestamp: '2026-10-07T08:03:16Z', payload: { response_id: 'resp_compact', usage: { input_tokens: 242729, cached_input_tokens: 242432, output_tokens: 3884 } } },
    { type: 'compacted', timestamp: '2026-10-07T08:03:16Z', payload: { message: '' } },
  ];
  const recs = lines.map((l) => C.codexLine(st, l)).filter(Boolean);
  assert.deepEqual(recs.map((r) => r.key), ['resp_turn', 'resp_compact']);
  assert.equal(sum(recs[1]), 242729 + 3884);
});

test('Codex, older logs: token_count events count their own response once; the same event written twice is skipped', () => {
  const st = C.codexState();
  const ev = (total, last, ts = '2026-09-01T10:00:00Z') => ({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total }, ...(last ? { last_token_usage: { input_tokens: last, output_tokens: 0 } } : {}) } } });
  const a = C.codexLine(st, ev(100, 100));
  const dup = C.codexLine(st, ev(100, 100));
  const b = C.codexLine(st, ev(250, 150));
  const c = C.codexLine(st, ev(400));             // no last_token_usage: the difference of the running totals
  assert.equal(dup, null);
  assert.deepEqual([a, b, c].map((r) => r.input), [100, 150, 150]);
  assert.ok(a.fromEvent && !a.key);
  assert.equal(st.events, 3);
});

// A minimal protobuf writer for the Antigravity step metadata.
function pb(fields) {
  const out = [];
  const varint = (n) => { const b = []; do { let byte = n % 128; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; b.push(byte); } while (n > 0); return b; };
  for (const [field, value] of fields) {
    if (typeof value === 'number') out.push(...varint(field * 8), ...varint(value));
    else { const bytes = typeof value === 'string' ? [...Buffer.from(value)] : [...value]; out.push(...varint(field * 8 + 2), ...varint(bytes.length), ...bytes); }
  }
  return Uint8Array.from(out);
}

test('Antigravity: a step\'s usage (field 9) with its time (field 7) and model number; a step without usage is not a record', () => {
  const t = 1759900000;
  const meta = pb([[7, pb([[1, t], [2, 250e6]])], [9, pb([[1, 1318], [2, 1200], [3, 340], [5, 56000], [11, 'resp-ag-1']])]]);
  const r = C.antigravityStep(meta);
  assert.deepEqual({ ...r }, { key: 'resp-ag-1', ts: t * 1000 + 250, model: 'gemini-3.8-flash-high', input: 1200, output: 340, cacheRead: 56000, cacheWrite: 0 });
  assert.equal(C.antigravityStep(pb([[7, pb([[1, t]])]])), null);
  assert.equal(C.antigravityStep(Uint8Array.from([0xff, 0xff])), null, 'bytes that do not parse are skipped');
  assert.equal(C.antigravityModel(1999), 'antigravity-m999');
});

test('Cursor CSV: one record per billed row; quoted commas; a row with no token numbers is missing, not 0', () => {
  const csv = [
    'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    '"2026-10-07T18:00:00.000Z","Included","grok-4.7","No","0","1,200","30,000","500","31,700","Included"',
    '"2026-10-07T19:00:00.000Z","Included","auto","No","","","","","","Included"',
    'not a date,x,y,z,1,1,1,1,1,1',
  ].join('\r\n');
  const r = C.cursorCsv(csv);
  assert.equal(r.ok, true);
  assert.equal(r.missing, 1);
  assert.equal(r.records.length, 1);
  assert.deepEqual([r.records[0].model, r.records[0].input, r.records[0].cacheRead, r.records[0].output], ['grok-4.7', 1200, 30000, 500]);
  assert.equal(C.cursorCsv('a,b\n1,2').ok, false);
});

test('Cursor CSV: two identical requests in one export are two requests; reading the export again, or an overlapping one, adds nothing', () => {
  const head = 'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost';
  const row = '"2026-10-06T18:00:00.000Z","Included","auto","No","0","100","0","10","110","Included"';
  const other = '"2026-10-06T19:00:00.000Z","Included","auto","No","0","5","0","5","10","Included"';
  const recs = (text) => C.cursorCsv(text).records.map((r) => ({ ...r, source: 'cursor' }));
  const total = (list) => C.mergeRecords(list).reduce((s, r) => s + sum(r), 0);
  const twice = [head, row, row].join('\n');
  assert.equal(total(recs(twice)), 220, 'the review case: 110 + 110');
  assert.equal(total([...recs(twice), ...recs(twice)]), 220, 'the same export read twice');
  // a later export repeats the first one's rows and adds a new one
  assert.equal(total([...recs(twice), ...recs([head, row, row, other].join('\n'))]), 230);
  // an export that holds the row once overlaps the first occurrence only
  assert.equal(total([...recs(twice), ...recs([head, row].join('\n'))]), 220);
});

test('days: local calendar keys, ranges ending today, axis labels and every-7th-day ticks when columns are narrow', () => {
  assert.equal(C.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(C.addDays('2026-11-02', -2), '2026-10-31');
  assert.equal(C.addDays('2026-03-08', 1), '2026-03-09', 'a daylight-saving change never skips or repeats a day');
  assert.deepEqual(C.dayRange('2026-10-08', 3), ['2026-10-06', '2026-10-07', '2026-10-08']);
  assert.equal(C.dayKey(new Date(2026, 9, 8, 23, 59).getTime()), '2026-10-08');
  assert.equal(C.dayTitle('2026-10-08', '2026-10-08'), '10月8日 周四 · 今天');
  assert.equal(C.axisLabel('2026-10-07', '2026-10-08'), '10/7');
  assert.equal(C.axisLabel('2026-10-08', '2026-10-08'), '今天');
  const days = C.dayRange('2026-10-08', 30);
  assert.ok(C.axisTicks(days, '2026-10-08', 40, 50).every(Boolean));
  const ticks = C.axisTicks(days, '2026-10-08', 40, 20);
  assert.deepEqual(days.filter((_, i) => ticks[i]), ['2026-09-10', '2026-09-17', '2026-09-24', '2026-10-01', '2026-10-08']);
});

test('numbers: three significant digits with K/M/B, full numbers with commas, shares', () => {
  const cases = [[0, '0'], [856, '856'], [15500, '15.5K'], [86_300_000, '86.3M'], [774_000_000, '774M'], [1_240_000_000, '1.24B'], [999_950, '1M'], [50_000_000, '50M'], [1_200_000_000, '1.2B'], [-5, '0'],
    // whole numbers keep their zeros (a real 889,602,667 once showed as 89M)
    [889_602_667, '890M'], [100_000_000, '100M'], [200_000, '200K'], [10_000_000_000, '10B'], [2_000_000_000, '2B']];
  for (const [n, s] of cases) assert.equal(C.formatShort(n), s, String(n));
  assert.equal(C.formatFull(1234567), '1,234,567');
  assert.equal(C.formatPct(1, 3), '33.3%');
  assert.equal(C.formatPct(0, 3), '0%');
  assert.equal(C.formatPct(1, 100000), '<0.1%');
  assert.equal(C.formatPct(99999, 100000), '>99.9%');
  assert.equal(C.formatPct(5, 5), '100%');
});

test('names: model ids read as people say them', () => {
  const cases = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-5.5', 'GPT-5.5'],
    ['gemini-3.8-flash-high', 'Gemini 3.8 Flash High'], ['deepseek-v4-pro', 'DeepSeek V4 Pro'], ['gpt-oss-120b-medium', 'GPT-OSS 120B Medium'], ['unknown', '未知模型'], ['antigravity-m77', 'Antigravity M77']];
  for (const [id, label] of cases) assert.equal(C.modelLabel(id), label, id);
  assert.equal(C.sourceName('deepseek'), 'DeepSeek 兜底');
  assert.equal(C.providerOf('codex'), 'openai');
});

test('daily sums and a day\'s stack: biggest model at the bottom, models without a colour merged into one 其他模型 segment placed by size', () => {
  const ts = new Date(2026, 9, 8, 12).getTime();
  const rec = (source, model, input) => ({ source, model, ts, input, output: 0, cacheRead: 0, cacheWrite: 0 });
  const days = C.dailySums([rec('claude', 'a', 10), rec('claude', 'a', 5), rec('codex', 'b', 40), rec('claude', 'c', 3), rec('claude', 'd', 2), { ...rec('claude', 'old', 9), ts: ts - 30 * 86400000 }], '2026-10-01', '2026-10-08');
  assert.deepEqual(Object.keys(days), ['2026-10-08']);
  const day = days['2026-10-08'];
  assert.deepEqual(C.dayModels(day).map((m) => [m.key, m.total]), [['codex:b', 40], ['claude:a', 15], ['claude:c', 3], ['claude:d', 2]]);
  assert.equal(C.dayTotal(day), 60);
  assert.deepEqual(C.providerTotals(day), { anthropic: 20, openai: 40, google: 0, other: 0 });
  const segs = C.stack(day, { 'codex:b': 'green', 'claude:a': 'rust' });
  assert.deepEqual(segs.map((s) => [s.key, s.total]), [['codex:b', 40], ['claude:a', 15], ['other', 5]]);
  assert.deepEqual(segs[2].members, ['claude:c', 'claude:d']);
  // a merged 其他模型 bigger than a coloured model sits below it
  const big = C.stack(day, { 'codex:b': 'green', 'claude:d': 'sky' });
  assert.deepEqual(big.map((s) => s.key), ['codex:b', 'other', 'claude:d']);
});

test('colours: six models get their own, picked by size with each provider preferring its family; the rest are 其他模型; a colour follows its model', () => {
  const totals = { 'claude:opus': 900, 'codex:gpt': 800, 'antigravity:flash': 700, 'claude:sonnet': 600, 'deepseek:ds': 500, 'claude:haiku': 400, 'codex:mini': 300, 'claude:zero': 0 };
  const c = C.assignColors(totals);
  assert.deepEqual(c, { 'claude:opus': 'rust', 'codex:gpt': 'green', 'antigravity:flash': 'sky', 'claude:sonnet': 'amber', 'deepseek:ds': 'pink', 'claude:haiku': 'deep', 'codex:mini': 'other' });
  assert.equal(new Set(Object.values(c).filter((s) => s !== 'other')).size, 6);
  // a smaller model joining later never takes a bigger model's colour
  assert.equal(C.assignColors({ ...totals, 'cursor:x': 1 })['claude:opus'], 'rust');
});

test('labels on the caps: 500 random months, at any column width, never overlap each other or another column', () => {
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let round = 0; round < 500; round++) {
    const n = rnd() < 0.5 ? 7 : 30;
    const colW = 14 + rnd() * 60;
    const barW = Math.max(6, Math.min(colW * 0.62, 46));
    const base = 280;
    const cols = [];
    for (let i = 0; i < n; i++) {
      if (rnd() < 0.1) { cols.push(null); continue; }
      cols.push({ x: 6 + colW * i + colW / 2, top: base - 20 - rnd() * 230, w: 26 + rnd() * 12 });
    }
    const { bottoms, rows } = C.placeLabels(cols, { barWidth: barW, base, lineHeight: 14, pad: 3, gap: 3 });
    const boxes = cols.map((c, i) => (c ? { l: c.x - c.w / 2, r: c.x + c.w / 2, t: bottoms[i] - 14, b: bottoms[i] } : null));
    for (let i = 0; i < n; i++) {
      const a = boxes[i];
      if (!a) continue;
      assert.ok(a.b <= cols[i].top, 'a label sits above its own column');
      for (let j = 0; j < n; j++) {
        if (i === j || !cols[j]) continue;
        const b = boxes[j];
        assert.ok(!(a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t), `round ${round}: labels ${i} and ${j} overlap`);
        const bar = { l: cols[j].x - barW / 2, r: cols[j].x + barW / 2, t: cols[j].top };
        assert.ok(!(a.l < bar.r && a.r > bar.l && a.b > bar.t), `round ${round}: label ${i} covers column ${j}`);
      }
    }
    assert.ok(rows >= 0);
  }
});
