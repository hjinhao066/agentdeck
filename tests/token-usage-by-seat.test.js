// Token 用量 by seat directory (decided 2026-10-09): the Token view lists the Claude tokens of each seat
// directory over the chosen range. Attribution is by directory: a directory whose account changed keeps
// all of it, and the page says so. Seats on one log directory share a row, a replayed message counts once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../token-usage-core');
const { scan } = require('../token-usage-scan');

const NOW = new Date(2026, 9, 8, 15, 0).getTime();
const TODAY = '2026-10-08';
const at = (day, h) => new Date(C.dayStart(day) + h * 3600_000).toISOString();
const line = (id, day, input, output = 0, h = 10) => JSON.stringify({ type: 'assistant', timestamp: at(day, h),
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } } });
const write = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.map((l) => l + '\n').join('')); };

test('scan: tokens per seat directory and day, linked seats together, a replayed message once', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-usage-seat-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  write(path.join(home, '.claude', 'projects', 'p', 'a.jsonl'), [line('m1', TODAY, 100, 10), line('m2', '2026-10-07', 40)]);
  fs.mkdirSync(path.join(home, '.claude-us'));
  fs.symlinkSync(path.join(home, '.claude', 'projects'), path.join(home, '.claude-us', 'projects'), 'dir');
  write(path.join(home, '.claude-us2', 'projects', 'p', 'b.jsonl'), [line('m1', TODAY, 100, 10, 11), line('m3', TODAY, 7)]);
  const seats = [{ id: 'cn', dir: path.join(home, '.claude') }, { id: 'us', dir: path.join(home, '.claude-us') },
    { id: 'us2', dir: path.join(home, '.claude-us2') }, { id: 'gone', dir: path.join(home, '.claude-gone') }];
  const r = await scan({ home, cacheFile: path.join(home, 'c.json'), now: NOW, seats });
  // input + output + cache read + cache write, as the page's totals
  assert.deepEqual(r.seatTokens, [
    { seats: ['cn', 'us'], days: { '2026-10-07': 46, [TODAY]: 116 } },
    { seats: ['us2'], days: { [TODAY]: 13 } },
  ]);
  assert.ok(!JSON.stringify(r.seatTokens).includes(home), 'no path reaches the page');
});

test('seatTokenRows: the range\'s days summed per directory, known seats only, largest first', () => {
  const seatTokens = [
    { seats: ['cn', 'us'], days: { '2026-10-07': 46, '2026-10-08': 116, '2026-09-01': 9999 } },
    { seats: ['us2'], days: { '2026-10-08': 500 } },
    { seats: ['old'], days: { '2026-10-08': 7 } },
  ];
  // named by the account signed in now (as the sidebar names seats), the seat's name when nobody is
  const infos = [{ id: 'cn', name: 'CN', accountEmail: 'pro@example.test' }, { id: 'us', name: 'US', accountEmail: 'pro@example.test' }, { id: 'us2', name: 'US2' }];
  assert.deepEqual(C.seatTokenRows({ seatTokens, infos, days: ['2026-10-07', '2026-10-08'] }), [
    { seats: ['us2'], names: ['US2'], total: 500 },
    { seats: ['cn', 'us'], names: ['pro'], total: 162 },
  ]);
  assert.deepEqual(C.seatTokenRows({ seatTokens, infos: [], days: ['2026-10-08'] }), []);
});

test('the Token view shows 按席位目录 with its note; 金额 keeps 订阅值不值 instead', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'token-usage-ui.js'), 'utf8');
  assert.match(ui, /按席位目录/);
  assert.match(ui, /按目录统计，目录换过号会算到当时的目录/);
  assert.match(ui, /!m\.money && seats && data\.seatTokens/);
});

test('按席位目录 counts this machine even while the chart shows the other one', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'token-usage-ui.js'), 'utf8');
  // the rows read this machine's seatTokens, so they are drawn on this machine's days and unit
  const calls = ui.match(/renderSeats\(([^)]*)\)/g).filter((c) => c !== 'renderSeats(m)');
  assert.deepEqual(calls, ['renderSeats(ownModel || model)', 'renderSeats(own)']);
});
