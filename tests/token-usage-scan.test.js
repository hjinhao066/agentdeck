const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../token-usage-core');
const { scan, readLines } = require('../token-usage-scan');
const { createTokenUsage, seatDirs, registerTokenUsageIpc } = require('../token-usage-main');

const NOW = new Date(2026, 9, 8, 15, 0).getTime();
const TODAY = '2026-10-08';
const at = (day, h) => new Date(C.dayStart(day) + h * 3600_000).toISOString();
const claudeLine = (id, model, day, size, h = 10) => JSON.stringify({ type: 'assistant', timestamp: at(day, h), message: { id, model, usage: { input_tokens: size, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const write = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.map((l) => l + '\n').join('')); };
const append = (file, lines) => fs.appendFileSync(file, lines.map((l) => l + '\n').join(''));
const totalOf = (result, day, key) => (result.days[day] && result.days[day][key] ? result.days[day][key].reduce((a, b) => a + b, 0) : 0);
function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-usage-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('scan: every source summed per local day and model; a linked seat directory read once; a replayed message counted once', async (t) => {
  const home = tmpHome(t);
  write(path.join(home, '.claude', 'projects', 'p', 's1.jsonl'), [claudeLine('m1', 'claude-opus-5-5', TODAY, 100), claudeLine('m2', 'claude-opus-5-5', '2026-10-07', 40), '{"type":"user","message":{"content":"secret prompt"}}', 'not json']);
  // ~/.claude-us is the same directory as ~/.claude: read once
  fs.mkdirSync(path.join(home, '.claude-us'));
  fs.symlinkSync(path.join(home, '.claude', 'projects'), path.join(home, '.claude-us', 'projects'), 'dir');
  // another seat replays m1 into a resumed session and has its own message
  write(path.join(home, '.claude-us2', 'projects', 'p', 's2.jsonl'), [claudeLine('m1', 'claude-opus-5-5', TODAY, 100, 11), claudeLine('m3', 'claude-sonnet-5-5', TODAY, 7)]);
  write(path.join(home, '.local', 'claude-deepseek', 'config', 'projects', 'p', 'd.jsonl'), [claudeLine('d1', 'deepseek-v4-pro', TODAY, 9)]);
  write(path.join(home, '.codex', 'sessions', '2026', '10', '08', 'rollout-a.jsonl'), [
    JSON.stringify({ type: 'turn_context', timestamp: at(TODAY, 9), payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ type: 'token_usage_record', timestamp: at(TODAY, 9), payload: { response_id: 'r1', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20 } } }),
    JSON.stringify({ type: 'event_msg', timestamp: at(TODAY, 9), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1020 }, last_token_usage: { input_tokens: 1000, output_tokens: 20 } } } }),
    JSON.stringify({ type: 'token_usage_record', timestamp: at(TODAY, 9), payload: { response_id: 'r2', usage: { input_tokens: 500, cached_input_tokens: 500, output_tokens: 30 } } }),
    JSON.stringify({ type: 'compacted', timestamp: at(TODAY, 9), payload: {} }),
  ]);
  write(path.join(home, 'Downloads', 'usage-events-2026-10-08.csv'), [
    'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    `"${at(TODAY, 8)}","Included","grok-4.7","No","0","10","20","5","35","Included"`,
    `"${at(TODAY, 8)}","Included","grok-4.7","No","0","10","20","5","35","Included"`,
    `"${at(TODAY, 8)}","Included","auto","No","","","","","","Included"`,
  ]);
  // the same export downloaded again: nothing more
  fs.copyFileSync(path.join(home, 'Downloads', 'usage-events-2026-10-08.csv'), path.join(home, 'Downloads', 'usage-events-2026-10-08 (1).csv'));
  write(path.join(home, '.gemini', 'tmp', 'proj', 'chats', 'session-1.json'), ['{}']);
  const cacheFile = path.join(home, 'cache', 'usage.json');
  const r = await scan({ home, cacheFile, now: NOW });
  assert.equal(r.today, TODAY);
  assert.equal(totalOf(r, TODAY, 'claude:claude-opus-5-5'), 100);
  assert.equal(totalOf(r, '2026-10-07', 'claude:claude-opus-5-5'), 40);
  assert.equal(totalOf(r, TODAY, 'claude:claude-sonnet-5-5'), 7);
  assert.equal(totalOf(r, TODAY, 'deepseek:deepseek-v4-pro'), 9);
  assert.equal(totalOf(r, TODAY, 'codex:gpt-5.5'), 1020 + 530, 'the compaction call counts');
  assert.deepEqual(r.days[TODAY]['codex:gpt-5.5'], [200, 50, 1300, 0]);
  assert.equal(totalOf(r, TODAY, 'cursor:grok-4.7'), 70, 'two identical requests in one export are two requests');
  const src = Object.fromEntries(r.sources.map((s) => [s.id, s]));
  assert.equal(src.claude.state, 'ok');
  assert.equal(src.claude.records, 3);
  assert.equal(src.codex.records, 2);
  assert.equal(src.cursor.missing, 1, 'a row without numbers in two copies of one export is one row');
  assert.equal(src.antigravity.state, 'none');
  assert.equal(src['gemini-cli'].state, 'unsupported');
  assert.equal(src['chatgpt-web'].state, 'none');
  // nothing from a prompt or reply is kept
  assert.doesNotMatch(fs.readFileSync(cacheFile, 'utf8'), /secret prompt/);
});

test('scan: incremental — an appended log costs only its new lines, a half-written line waits, a deleted log still counts', async (t) => {
  const home = tmpHome(t);
  const file = path.join(home, '.claude', 'projects', 'p', 's.jsonl');
  const cacheFile = path.join(home, 'cache.json');
  write(file, [claudeLine('m1', 'claude-opus-5-5', TODAY, 100)]);
  let r = await scan({ home, cacheFile, now: NOW });
  assert.equal(totalOf(r, TODAY, 'claude:claude-opus-5-5'), 100);
  const offset = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).files[fs.realpathSync(file)].offset;
  assert.equal(offset, fs.statSync(file).size);
  // a line still being written is left for the next scan
  append(file, [claudeLine('m2', 'claude-opus-5-5', TODAY, 50)]);
  fs.appendFileSync(file, claudeLine('m3', 'claude-opus-5-5', TODAY, 7).slice(0, 30));
  r = await scan({ home, cacheFile, now: NOW });
  assert.equal(totalOf(r, TODAY, 'claude:claude-opus-5-5'), 150);
  fs.appendFileSync(file, claudeLine('m3', 'claude-opus-5-5', TODAY, 7).slice(30) + '\n');
  r = await scan({ home, cacheFile, now: NOW });
  assert.equal(totalOf(r, TODAY, 'claude:claude-opus-5-5'), 157);
  // Claude Code prunes old sessions: what the log held stays counted
  fs.rmSync(file);
  r = await scan({ home, cacheFile, now: NOW });
  assert.equal(totalOf(r, TODAY, 'claude:claude-opus-5-5'), 157);
  // a file replaced by a shorter one starts over
  write(file, [claudeLine('m9', 'claude-opus-5-5', TODAY, 1)]);
  r = await scan({ home, cacheFile, now: NOW });
  assert.equal(totalOf(r, TODAY, 'claude:claude-opus-5-5'), 158);
});

test('scan: logs older than the kept window are skipped; extra seat directories are read', async (t) => {
  const home = tmpHome(t);
  const old = path.join(home, '.claude', 'projects', 'p', 'old.jsonl');
  write(old, [claudeLine('o1', 'claude-opus-5-5', '2026-06-01', 999)]);
  const past = new Date(2026, 5, 1).getTime() / 1000;
  fs.utimesSync(old, past, past);
  write(path.join(home, 'seats', 'cn2', 'projects', 'p', 'x.jsonl'), [claudeLine('s1', 'claude-haiku-5-5', TODAY, 3)]);
  const r = await scan({ home, cacheFile: path.join(home, 'c.json'), now: NOW, extraClaude: [path.join(home, 'seats', 'cn2')] });
  assert.equal(r.sources.find((s) => s.id === 'claude').files, 1);
  assert.equal(totalOf(r, TODAY, 'claude:claude-haiku-5-5'), 3);
  assert.ok(!Object.keys(r.days).some((d) => d < r.from));
});

test('scan: Antigravity conversation databases (steps.metadata protobuf), re-read when the database or its -wal changes', async (t) => {
  let Db;
  try { Db = require('node:sqlite').DatabaseSync; } catch (_) { t.skip('node:sqlite unavailable'); return; }
  const home = tmpHome(t);
  const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const varint = (n) => { const b = []; do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; b.push(x); } while (n); return b; };
  const msg = (fields) => Buffer.from(fields.flatMap(([f, v]) => (typeof v === 'number' ? [...varint(f * 8), ...varint(v)] : [...varint(f * 8 + 2), ...varint(v.length), ...v])));
  const step = (secs, input, id) => msg([[7, [...msg([[1, secs]])]], [9, [...msg([[1, 1318], [2, input], [3, 10], [5, 100], [11, [...Buffer.from(id)]]])]]]);
  // a step whose only usage is a retried request in field 28, without a model number
  const retryStep = (secs, input, id) => msg([[8, [...msg([[1, secs]])]], [28, [...msg([[2, [...msg([[2, input], [3, 10], [5, 100], [11, [...Buffer.from(id)]]])]]])]]]);
  const file = path.join(dir, 'c1.db');
  const db = new Db(file);
  db.exec('CREATE TABLE steps (idx INTEGER, metadata BLOB)');
  const secs = Math.floor(new Date(2026, 9, 8, 9).getTime() / 1000);
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(0, step(secs, 1000, 'a'));
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(1, null);
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(3, retryStep(secs + 30, 500, 'retry-1'));
  db.close();
  const cacheFile = path.join(home, 'c.json');
  let r = await scan({ home, cacheFile, now: NOW });
  assert.equal(totalOf(r, TODAY, 'antigravity:gemini-3.8-flash-high'), 1110 + 610, 'the retried request counts, under the conversation\'s model');
  const db2 = new Db(file);
  db2.prepare('INSERT INTO steps VALUES (?, ?)').run(2, step(secs + 60, 2000, 'b'));
  db2.close();
  const later = Date.now() / 1000 + 5;
  fs.utimesSync(file, later, later);
  r = await scan({ home, cacheFile, now: NOW });
  assert.equal(totalOf(r, TODAY, 'antigravity:gemini-3.8-flash-high'), 1110 + 610 + 2110);
  assert.equal(r.sources.find((s) => s.id === 'antigravity').state, 'ok');
});

test('scan: every day and model priced at its official price, a model without one null; costs per seat directory, linked seats together', async (t) => {
  const home = tmpHome(t);
  const opus = (id, day, h) => JSON.stringify({ type: 'assistant', timestamp: at(day, h), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } } } });
  write(path.join(home, '.claude', 'projects', 'p', 'a.jsonl'), [opus('m1', TODAY, 9), opus('m2', '2026-10-07', 9)]);
  fs.mkdirSync(path.join(home, '.claude-us'));
  fs.symlinkSync(path.join(home, '.claude', 'projects'), path.join(home, '.claude-us', 'projects'), 'dir');
  // m1 replayed into the other seat's session counts once, where it was first written
  write(path.join(home, '.claude-us2', 'projects', 'p', 'b.jsonl'), [opus('m1', TODAY, 11), claudeLine('m3', 'claude-sonnet-5-5', TODAY, 1e6)]);
  write(path.join(home, 'Downloads', 'usage-events-2026-10-08.csv'), [
    'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    `"${at(TODAY, 8)}","Included","auto","No","0","10","20","5","35","Included"`,
  ]);
  const seats = [{ id: 'cn', dir: path.join(home, '.claude') }, { id: 'us', dir: path.join(home, '.claude-us') }, { id: 'us2', dir: path.join(home, '.claude-us2') }, { id: 'gone', dir: path.join(home, '.claude-gone') }];
  const r = await scan({ home, cacheFile: path.join(home, 'c.json'), now: NOW, seats });
  assert.deepEqual(r.costs[TODAY]['claude:claude-opus-5-5'], [4, 0, 0, 8], '1M input at $4, 1M one-hour cache write at $8');
  assert.deepEqual(r.costs[TODAY]['claude:claude-sonnet-5-5'], [2, 0, 0, 0]);
  assert.equal(r.costs[TODAY]['cursor:auto'], null, 'no official price: null, never 0');
  assert.deepEqual(r.seatCosts, [
    { seats: ['cn', 'us'], days: { '2026-10-07': 12, [TODAY]: 12 } },
    { seats: ['us2'], days: { [TODAY]: 2 } },
  ]);
  assert.deepEqual(r.plans, { Pro: 20, 'Max 5x': 100, 'Max 20x': 200 });
  assert.equal(r.pricesChecked, '2026-10-09');
  // the page never gets a path
  assert.ok(!JSON.stringify(r).includes(home), 'no path reaches the page');
});

test('readLines: lines across chunk edges, the unfinished tail returned for later', (t) => {
  const home = tmpHome(t);
  const file = path.join(home, 'x.jsonl');
  fs.writeFileSync(file, 'a\nbb\n\nccc');
  const got = [];
  const end = readLines(file, 0, fs.statSync(file).size, (b) => got.push(b.toString()));
  assert.deepEqual(got, ['a', 'bb']);
  assert.equal(end, 6);
});

test('token-usage:get answers from the last scan while it is fresh, shares one scan between callers, and a failed scan is not kept', async () => {
  let clock = 0, runs = 0, fail = false;
  const usage = createTokenUsage({ now: () => clock, maxAge: 60_000, run: async () => { runs++; if (fail) throw new Error('boom'); return { n: runs }; } });
  const [a, b] = await Promise.all([usage.get(), usage.get()]);
  assert.equal(runs, 1);
  assert.equal(a, b);
  clock = 30_000;
  assert.equal((await usage.get()).n, 1);
  assert.equal((await usage.get({ fresh: true })).n, 2);
  clock = 200_000;
  fail = true;
  await assert.rejects(usage.get(), /boom/);
  fail = false;
  assert.equal((await usage.get()).n, 4, 'the next call scans again');
});

test('IPC: a test profile scans only its own usage-home and never the real seats; seat directories expand ~', async () => {
  const handlers = {};
  const calls = [];
  registerTokenUsageIpc({ handleMain: (ch, fn) => { handlers[ch] = fn; }, home: '/p/usage-home', userData: '/p', getSeats: () => [{ configDir: '~/.claude-cn2' }], test: true, run: async (input) => { calls.push(input); return { ok: 1 }; } });
  assert.deepEqual(await handlers['token-usage:get']({}, { fresh: true }), { ok: 1 });
  assert.deepEqual(calls[0], { home: '/p/usage-home', cacheFile: path.join('/p', 'token-usage-cache.json'), extraClaude: [], seats: [] });
  assert.deepEqual(seatDirs([{ configDir: '~/.claude-cn2' }, { configDir: 'relative' }, null, { configDir: '/abs/seat' }], '/home/me'), ['/home/me/.claude-cn2', '/abs/seat']);
  // seats by id for the 订阅值不值 rows: a test profile keeps only seats inside its usage-home
  calls.length = 0;
  registerTokenUsageIpc({ handleMain: (ch, fn) => { handlers[ch] = fn; }, home: '/p/usage-home', userData: '/p', getSeats: () => [{ id: 'cn', configDir: '~/.claude' }, { id: 'x', configDir: '/real/seat' }], test: true, run: async (input) => { calls.push(input); return {}; } });
  await handlers['token-usage:get']({}, { fresh: true });
  assert.deepEqual(calls[0].seats, [{ id: 'cn', dir: '/p/usage-home/.claude' }]);
  assert.deepEqual(calls[0].extraClaude, []);
  calls.length = 0;
  registerTokenUsageIpc({ handleMain: (ch, fn) => { handlers[ch] = fn; }, home: '/home/me', userData: '/p', getSeats: () => [{ id: 'cn', configDir: '~/.claude' }, { id: 'x', configDir: '/real/seat' }], run: async (input) => { calls.push(input); return {}; } });
  await handlers['token-usage:get']({}, { fresh: true });
  assert.deepEqual(calls[0].seats, [{ id: 'cn', dir: '/home/me/.claude' }, { id: 'x', dir: '/real/seat' }]);
});
