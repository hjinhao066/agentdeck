// Pure helpers behind the Token 用量 view: reading one usage record out of each
// CLI's own log line (Claude Code JSONL, Codex rollout JSONL, an Antigravity
// step's protobuf metadata, a Cursor usage CSV row), merging the records so a
// message seen twice counts once, summing them per local day and model, and
// everything the chart needs (short number format, the per-day stack order,
// colours that follow a model, axis ticks, top-of-bar label placement).
// No DOM, no fs: runs in the page, in the scanner process and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenUsageCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Four buckets for every source. output includes thinking/reasoning tokens
  // (Claude and Codex already count them in output; Antigravity's total output
  // field is visible + thinking). input is fresh input only: cached input is
  // cacheRead, never counted twice.
  const BUCKETS = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const BUCKET_LABELS = { input: '输入', output: '输出', cacheRead: '缓存读', cacheWrite: '缓存写' };

  const SOURCES = {
    claude: { name: 'Claude Code', provider: 'anthropic' },
    codex: { name: 'Codex', provider: 'openai' },
    antigravity: { name: 'Antigravity', provider: 'google' },
    deepseek: { name: 'DeepSeek 兜底', provider: 'other' },
    cursor: { name: 'Cursor', provider: 'other' },
  };
  const PROVIDERS = [
    { key: 'anthropic', label: 'Anthropic' },
    { key: 'openai', label: 'OpenAI' },
    { key: 'google', label: 'Google' },
    { key: 'other', label: '其他' },
  ];
  const providerOf = (source) => (SOURCES[source] ? SOURCES[source].provider : 'other');

  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const pad2 = (n) => String(n).padStart(2, '0');

  // ---- days (the machine's local calendar) ----
  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function addDays(day, n) {
    const [y, m, d] = String(day).split('-').map(Number);
    return dayKey(new Date(y, m - 1, d + n, 12).getTime());
  }
  function dayStart(day) {
    const [y, m, d] = String(day).split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  // The last n days ending today, oldest first.
  function dayRange(today, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
    return out;
  }
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function dayParts(day) {
    const [y, m, d] = String(day).split('-').map(Number);
    return { y, m, d, week: WEEK[new Date(y, m - 1, d, 12).getDay()] };
  }
  // 「10月8日 周三」, plus 「· 今天」 for today.
  function dayTitle(day, today) {
    const p = dayParts(day);
    return `${p.m}月${p.d}日 ${p.week}${day === today ? ' · 今天' : ''}`;
  }
  // Axis label under a column: 今天 for today, 10/8 otherwise.
  function axisLabel(day, today) {
    if (day === today) return '今天';
    const p = dayParts(day);
    return `${p.m}/${p.d}`;
  }
  // Which columns carry a date under them: all of them while they fit, else
  // today and every 7th day before it (charts.md: never turn the text).
  function axisTicks(days, today, perLabel, colWidth) {
    if (colWidth >= perLabel) return days.map(() => true);
    const ti = days.indexOf(today);
    const end = ti >= 0 ? ti : days.length - 1;
    return days.map((_, i) => i <= end && (end - i) % 7 === 0);
  }

  // ---- Claude Code (and claude-ds on DeepSeek): one JSONL line ----
  // An assistant line carries message.usage; the same message is written again
  // for every content block and replayed into a resumed or forked session, so
  // the message id is the identity. iterations restate the main message except
  // an advisor_message, which is a second model's own usage.
  function claudeRecords(obj) {
    if (!obj || obj.type !== 'assistant') return [];
    const m = obj.message;
    const u = m && m.usage;
    if (!u || typeof u !== 'object' || !m.id || m.model === '<synthetic>') return [];
    const ts = Date.parse(obj.timestamp);
    if (!Number.isFinite(ts)) return [];
    const one = (key, model, v) => ({ key, ts, model: String(model || 'unknown'),
      input: num(v.input_tokens), output: num(v.output_tokens), cacheRead: num(v.cache_read_input_tokens), cacheWrite: num(v.cache_creation_input_tokens) });
    const out = [one(String(m.id), m.model, u)];
    if (Array.isArray(u.iterations)) {
      u.iterations.forEach((it, i) => {
        if (it && it.type === 'advisor_message') out.push(one(`${m.id}#advisor${i}`, it.model || 'advisor', it));
      });
    }
    return out;
  }
  // Cheap test before JSON.parse: only these lines can carry usage.
  const claudeMayCount = (line) => line.includes('"usage"') && line.includes('"assistant"');

  // ---- Codex: one rollout JSONL line, with per-file state ----
  // Newer logs write a token_usage_record per model response (response_id is
  // the identity). Older logs only have token_count events: each carries the
  // response's own last_token_usage plus a running total, and the same event can
  // be written twice (same running total), which is skipped. A file that has
  // records never counts its token_count events. input_tokens includes the
  // cached part; total = input_tokens + output_tokens.
  // A context compaction is a model call too: it has its own record (the line
  // right before `compacted`) but no token_count event, so tools that read only
  // token_count (ccusage 20.0.26) come out 0.4–1.4% lower than this. Checked on
  // 10-01..10-08: every extra record was a compaction (99% of the tokens) or a
  // turn's last response before the session stopped; no response id repeats.
  function codexBuckets(u) {
    const cached = num(u.cached_input_tokens), write = num(u.cache_write_input_tokens);
    return { input: Math.max(0, num(u.input_tokens) - cached - write), output: num(u.output_tokens), cacheRead: cached, cacheWrite: write };
  }
  function codexState() { return { model: '', records: false, lastTotal: -1, events: 0 }; }
  const codexMayCount = (line) => line.includes('token_usage_record') || line.includes('"token_count"') || line.includes('"turn_context"');
  // Returns a record, or null. A record from a token_count event has
  // fromEvent: true and no key (the caller names it by file and position).
  function codexLine(st, obj) {
    if (!obj || typeof obj !== 'object') return null;
    const p = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
    if (obj.type === 'turn_context') { if (typeof p.model === 'string' && p.model) st.model = p.model; return null; }
    const ts = Date.parse(obj.timestamp);
    if (obj.type === 'token_usage_record') {
      if (!p.usage || typeof p.usage !== 'object' || !Number.isFinite(ts)) return null;
      st.records = true;
      const id = p.response_id || `${p.turn_id || ''}/${ts}`;
      return { key: String(id), ts, model: st.model || 'unknown', ...codexBuckets(p.usage) };
    }
    if (obj.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info;
      if (!info || typeof info !== 'object' || !info.total_token_usage || !Number.isFinite(ts)) return null;
      const t = info.total_token_usage;
      const total = num(t.total_tokens) || num(t.input_tokens) + num(t.output_tokens);
      if (total === st.lastTotal) return null; // the same event written twice
      const prev = st.lastUsage;
      st.lastTotal = total;
      st.lastUsage = { input_tokens: num(t.input_tokens), cached_input_tokens: num(t.cached_input_tokens), cache_write_input_tokens: num(t.cache_write_input_tokens), output_tokens: num(t.output_tokens) };
      let u = info.last_token_usage;
      if (!u || typeof u !== 'object') {
        if (!prev) u = st.lastUsage;
        else {
          u = {};
          for (const k of Object.keys(st.lastUsage)) u[k] = Math.max(0, st.lastUsage[k] - prev[k]);
        }
      }
      if (st.records) return null;
      st.events++;
      return { fromEvent: true, ts, model: st.model || 'unknown', ...codexBuckets(u) };
    }
    return null;
  }

  // ---- Antigravity: protobuf in a conversation database ----
  function varint(b, i) {
    let r = 0, mul = 1, byte;
    do {
      if (i >= b.length || mul > 2 ** 63) return [0, -1];
      byte = b[i++];
      r += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte & 0x80);
    return [r, i];
  }
  // Top-level fields of one message: Map field -> [values]; a varint is a
  // number, a length-delimited field a byte view. null if it does not parse.
  function pbFields(bytes) {
    const out = new Map();
    let i = 0;
    while (i < bytes.length) {
      let key;
      [key, i] = varint(bytes, i);
      if (i < 0) return null;
      const field = Math.floor(key / 8), wire = key % 8;
      if (field === 0) return null;
      let v = null;
      if (wire === 0) { [v, i] = varint(bytes, i); if (i < 0) return null; }
      else if (wire === 2) {
        let len;
        [len, i] = varint(bytes, i);
        if (i < 0 || i + len > bytes.length) return null;
        v = bytes.subarray(i, i + len); i += len;
      } else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else return null;
      if (i > bytes.length) return null;
      if (!out.has(field)) out.set(field, []);
      out.get(field).push(v);
    }
    return out;
  }
  const first = (f, k) => (f && f.has(k) ? f.get(k)[0] : undefined);
  const firstNum = (f, k) => { const v = first(f, k); return typeof v === 'number' ? v : 0; };
  const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
  // The steps table's metadata: field 9 is the model call's usage {1 model,
  // 2 fresh input, 3 output incl. thinking, 5 cache read, 11 response id};
  // fields 7 / 8 / 1 are timestamps {1 seconds, 2 nanos}. Verified against the
  // ccusage 20.0.26 Antigravity adapter on this machine's logs.
  function antigravityStep(bytes) {
    const f = pbFields(bytes);
    const ub = first(f, 9);
    if (!(ub instanceof Uint8Array)) return null;
    const u = pbFields(ub);
    if (!u || !u.has(1)) return null;
    let ts = 0;
    for (const k of [7, 8, 1]) {
      const tb = first(f, k);
      if (!(tb instanceof Uint8Array)) continue;
      const t = pbFields(tb);
      const s = firstNum(t, 1);
      if (s > 0) { ts = s * 1000 + Math.floor(firstNum(t, 2) / 1e6); break; }
    }
    if (!ts) return null;
    const rid = first(u, 11);
    return {
      key: rid instanceof Uint8Array && decoder ? decoder.decode(rid) : '',
      ts, model: antigravityModel(firstNum(u, 1)),
      input: num(firstNum(u, 2)), output: num(firstNum(u, 3)), cacheRead: num(firstNum(u, 5)), cacheWrite: 0,
    };
  }
  // Antigravity names a model by number (1000 + placeholder id for the Gemini
  // previews). Names as ccusage 20.0.26 reports them.
  const ANTIGRAVITY_MODELS = {
    1318: 'gemini-3.8-flash-high', 1319: 'gemini-3.8-flash-medium', 1320: 'gemini-3.8-flash-low',
    1298: 'gemini-3.7-flash-high', 1299: 'gemini-3.7-flash-medium', 1300: 'gemini-3.7-flash-low',
    1071: 'gemini-3.6-flash-high', 1072: 'gemini-3.6-flash-medium', 1073: 'gemini-3.6-flash-low',
    1016: 'gemini-3.1-pro', 1026: 'claude-opus-4-6', 1035: 'claude-sonnet-4-6', 342: 'gpt-oss-120b-medium',
  };
  function antigravityModel(n) {
    if (ANTIGRAVITY_MODELS[n]) return ANTIGRAVITY_MODELS[n];
    return n > 1000 ? `antigravity-m${n - 1000}` : `antigravity-${n}`;
  }

  // ---- Cursor: the official usage-events CSV export ----
  function csvRow(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  }
  // Each row is one billed request. Its identity is the whole line plus which
  // occurrence of that line it is in the file (two identical requests in one
  // export are two requests), so the same export read twice, or two exports that
  // overlap, still count each request once. A row the bill gives no tokens for
  // is counted as missing, never as 0.
  function cursorCsv(text) {
    const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return { records: [], missing: 0, ok: false };
    const head = csvRow(lines[0]).map((h) => h.trim());
    const col = (name) => head.indexOf(name);
    const at = { date: col('Date'), model: col('Model'), write: col('Input (w/ Cache Write)'), input: col('Input (w/o Cache Write)'), read: col('Cache Read'), output: col('Output Tokens') };
    if (at.date < 0 || at.model < 0 || at.input < 0 || at.output < 0) return { records: [], missing: 0, ok: false };
    const records = [];
    let missing = 0;
    const missingKeys = [];
    const cell = (row, i) => (i >= 0 ? String(row[i] || '').trim() : '');
    const seen = new Map();
    for (const line of lines.slice(1)) {
      const row = csvRow(line);
      const ts = Date.parse(cell(row, at.date));
      if (!Number.isFinite(ts)) continue;
      const nth = (seen.get(line) || 0) + 1;
      seen.set(line, nth);
      const raw = [cell(row, at.input), cell(row, at.output), cell(row, at.read), cell(row, at.write)];
      if (raw.every((v) => v === '' || v === '-')) { missing++; missingKeys.push(`${line}#${nth}`); continue; }
      const n = (v) => num(Number(String(v).replace(/,/g, '')));
      records.push({ key: `${line}#${nth}`, ts, model: cell(row, at.model) || 'unknown', input: n(raw[0]), output: n(raw[1]), cacheRead: n(raw[2]), cacheWrite: n(raw[3]) });
    }
    return { records, missing, missingKeys, ok: true };
  }

  // ---- merging and daily sums ----
  const total = (r) => r.input + r.output + r.cacheRead + r.cacheWrite;
  // One record per (source, key). A message seen more than once (streamed in
  // parts, replayed in another session file) keeps its fullest usage and the
  // time it was first seen.
  function mergeRecords(records) {
    const best = new Map();
    for (const r of records) {
      if (!r || !r.key) continue;
      const id = r.source + '\u0000' + r.key;
      const had = best.get(id);
      if (!had) { best.set(id, { ...r }); continue; }
      const ts = Math.min(had.ts, r.ts);
      if (total(r) > total(had)) best.set(id, { ...r, ts }); else had.ts = ts;
    }
    return [...best.values()];
  }
  const seriesKey = (source, model) => `${source}:${model}`;
  // Daily sums for the days in [from, to] (inclusive): { day: { key: [input, output, cacheRead, cacheWrite] } }.
  function dailySums(records, from, to) {
    const days = {};
    for (const r of records) {
      const day = dayKey(r.ts);
      if (day < from || day > to) continue;
      const k = seriesKey(r.source, r.model);
      const d = days[day] || (days[day] = {});
      const v = d[k] || (d[k] = [0, 0, 0, 0]);
      v[0] += r.input; v[1] += r.output; v[2] += r.cacheRead; v[3] += r.cacheWrite;
    }
    return days;
  }

  // ---- names ----
  const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
  // claude-opus-5-5 -> Opus 5.5, gpt-6.1-sol -> GPT-6.1 Sol,
  // gemini-3.8-flash-high -> Gemini 3.8 Flash High, deepseek-v4-pro -> DeepSeek V4 Pro.
  function modelLabel(model) {
    const raw = String(model || '').trim();
    if (!raw || raw === 'unknown') return '未知模型';
    let m = raw.toLowerCase().replace(/-\d{8}$/, '');
    const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-(.+))?$/.exec(m);
    if (claude) return [cap(claude[1]) + ' ' + claude[2] + (claude[3] ? '.' + claude[3] : ''), ...(claude[4] ? claude[4].split('-').map(cap) : [])].join(' ');
    const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(m);
    if (gpt) return ['GPT-' + gpt[1], ...(gpt[2] ? gpt[2].split('-').map(cap) : [])].join(' ');
    const agm = /^antigravity-m(\d+)$/.exec(m);
    if (agm) return 'Antigravity M' + agm[1];
    const words = (w) => w.split('-').map((x) => (/^v\d/.test(x) || /^\d+b$/.test(x) ? x.toUpperCase() : cap(x)));
    if (m.startsWith('gpt-oss')) return ['GPT-OSS', ...words(m.slice(8)).filter(Boolean)].join(' ');
    return words(m.replace(/^deepseek/, 'DeepSeek')).join(' ');
  }
  function sourceName(source) { return SOURCES[source] ? SOURCES[source].name : source; }

  // ---- numbers ----
  // 3 significant digits: 856, 15.5K, 86.3M, 774M, 1.24B. A day is tens of
  // millions to over a billion tokens, so M carries the chart and B takes over
  // at 1000M; trailing zeros are dropped (1.2B, 50M).
  function formatShort(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n < 1000) return String(n);
    const units = [['K', 1e3], ['M', 1e6], ['B', 1e9], ['T', 1e12]];
    let u = 0;
    while (u < units.length - 1 && n >= units[u + 1][1]) u++;
    for (;;) {
      const x = n / units[u][1];
      const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
      if (Number(s) >= 1000 && u < units.length - 1) { u++; continue; }
      return (s.includes('.') ? s.replace(/\.?0+$/, '') : s) + units[u][0]; // 890M stays 890M; 1.20B is 1.2B
    }
  }
  function formatFull(n) { return Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US'); }
  function formatPct(part, whole) {
    if (!whole || !part) return '0%';
    const p = (part / whole) * 100;
    if (p < 0.1) return '<0.1%';
    return (p >= 99.95 && part < whole ? '>99.9' : p.toFixed(1).replace(/\.0$/, '')) + '%';
  }
  // Axis: 0 and a few round steps (1/2/2.5/5 × 10^k) up to at least max.
  function niceScale(max, count = 4) {
    if (!(max > 0)) return { max: 1e6, ticks: [0, 2.5e5, 5e5, 7.5e5, 1e6] };
    const raw = max / count;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
    const top = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v));
    return { max: top, ticks };
  }

  // ---- one day's stack ----
  const sumOf = (v) => v[0] + v[1] + v[2] + v[3];
  // Every model of a day, biggest first (ties by name, so the order is stable).
  function dayModels(dayMap) {
    return Object.entries(dayMap || {})
      .map(([key, v]) => ({ key, total: sumOf(v), buckets: { input: v[0], output: v[1], cacheRead: v[2], cacheWrite: v[3] } }))
      .filter((m) => m.total > 0)
      .sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
  }
  function dayTotal(dayMap) { return dayModels(dayMap).reduce((s, m) => s + m.total, 0); }
  function dayBuckets(dayMap) {
    const b = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const m of dayModels(dayMap)) for (const k of BUCKETS) b[k] += m.buckets[k];
    return b;
  }
  function providerTotals(dayMap) {
    const t = { anthropic: 0, openai: 0, google: 0, other: 0 };
    for (const m of dayModels(dayMap)) t[providerOf(m.key.split(':')[0])] += m.total;
    return t;
  }

  // ---- colours ----
  // Six colours that stay apart for every pair (any two models can end up next
  // to each other in some day's stack) under protanopia and deuteranopia, in
  // both themes (dataviz validate_palette.js --pairs all: CVD ΔE ≥ 8.5,
  // normal-vision ΔE ≥ 15.3). A seventh hue cannot pass, so the models after
  // the sixth share one grey 其他模型 segment; the tooltip and the table still
  // name each one. A colour belongs to the model, not to its rank on a day: the
  // biggest models of the last 30 days pick first, each provider preferring its
  // own family (Anthropic warm, OpenAI green, Google blue).
  const SLOTS = ['sky', 'deep', 'rust', 'amber', 'green', 'pink'];
  const PREFER = { anthropic: ['rust', 'amber', 'pink'], openai: ['green', 'pink', 'deep'], google: ['sky', 'deep', 'pink'], other: ['pink', 'amber', 'deep'] };
  const OTHER = 'other';
  function assignColors(totals) {
    const list = Object.entries(totals || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const free = new Set(SLOTS);
    const out = {};
    for (const [key] of list) {
      if (!free.size) { out[key] = OTHER; continue; }
      const prefer = PREFER[providerOf(key.split(':')[0])] || [];
      const slot = prefer.find((s) => free.has(s)) || SLOTS.find((s) => free.has(s));
      free.delete(slot);
      out[key] = slot;
    }
    return out;
  }
  // A day's bar from bottom to top: biggest first; models without a colour of
  // their own merge into one 其他模型 segment, placed by its size like the rest.
  function stack(dayMap, colors) {
    const segs = [];
    let other = null;
    for (const m of dayModels(dayMap)) {
      const slot = colors[m.key] || OTHER;
      if (slot !== OTHER) { segs.push({ key: m.key, slot, total: m.total }); continue; }
      if (!other) { other = { key: OTHER, slot: OTHER, total: 0, members: [] }; segs.push(other); }
      other.total += m.total;
      other.members.push(m.key);
    }
    return segs.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
  }

  // ---- labels on top of the bars ----
  // Each column's label starts just above its own bar; when it would touch a
  // label already placed or another column's bar, it moves up just above that.
  // Every label stays horizontal and whole. cols: [{ x (centre), top (bar top
  // y; the baseline is larger), w (label width) }]. Returns the label boxes'
  // bottom y and the most rows any label rose above its own bar.
  function placeLabels(cols, { barWidth, base, lineHeight = 13, pad = 3, gap = 2 }) {
    const placed = [];
    const bottoms = [];
    let rows = 0;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!c || !(c.w > 0)) { bottoms.push(null); continue; }
      const left = c.x - c.w / 2 - gap, right = c.x + c.w / 2 + gap;
      let bottom = c.top - pad;
      for (let guard = 0; guard < 200; guard++) {
        const top = bottom - lineHeight;
        let hit = null;
        for (const p of placed) if (p.left < right && p.right > left && p.top < bottom + pad && p.bottom > top - pad) { hit = Math.min(hit == null ? Infinity : hit, p.top); }
        for (let j = 0; j < cols.length; j++) {
          if (j === i || !cols[j]) continue;
          const b = cols[j], bl = b.x - barWidth / 2, br = b.x + barWidth / 2;
          if (b.top < base && bl < right && br > left && b.top < bottom + pad) hit = Math.min(hit == null ? Infinity : hit, b.top);
        }
        if (hit == null) break;
        bottom = hit - pad;
      }
      placed.push({ left, right, top: bottom - lineHeight, bottom });
      bottoms.push(bottom);
      rows = Math.max(rows, Math.round((c.top - pad - bottom) / lineHeight));
    }
    return { bottoms, rows };
  }

  return {
    BUCKETS, BUCKET_LABELS, SOURCES, PROVIDERS, SLOTS, OTHER, ANTIGRAVITY_MODELS, providerOf,
    dayKey, addDays, dayStart, dayRange, dayTitle, axisLabel, axisTicks,
    claudeRecords, claudeMayCount, codexState, codexMayCount, codexLine, pbFields, antigravityStep, antigravityModel, cursorCsv, csvRow,
    mergeRecords, dailySums, seriesKey, modelLabel, sourceName,
    formatShort, formatFull, formatPct, niceScale, dayModels, dayTotal, dayBuckets, providerTotals, assignColors, stack, placeLabels,
  };
});
