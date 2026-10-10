'use strict';
// Who an automatic chooser starts a session on (the reviewer of a --verify card, the board's
// dispatcher), driven by fake quota state through the real QuotaCore: the same passive reading the
// `quota` command shows. No session, no model.
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../quota-core');
const AV = require('../auto-verify-core');

const now = Date.parse('2026-10-10T08:00:00Z');
const MIN = 60_000;
const SEATS = Q.claudeSeats([{ id: 'cn', configDir: '~/.claude' }, { id: 'us', configDir: '~/.claude-us' }, { id: 'us2', configDir: '~/.claude-us2' }]);
const CHOICES = SEATS.map((s) => ({ id: s.id, label: s.id, configDir: s.configDir }));
const GEMINI = 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high';

// An official Claude reading for one seat; `five`/`week` are what is left.
const claude = (seat, at, five, week, extra = {}) => ({ ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
  { key: 'fiveHour', remaining: five, resetText: new Date(now + 2 * 3600_000).toISOString() },
  { key: 'weekly', remaining: week, resetText: new Date(now + 3 * 86400_000).toISOString() }] }, at),
  seatId: seat, configDir: SEATS.find((s) => s.id === seat).configDir, accountBound: true, accountKey: `${seat}-account`, credentialKey: `${seat}-cred`, ...extra });
// A Gemini reading: what is left in the 5-hour and weekly windows, as a fraction.
const gemini = (at, five, week) => Q.cacheAntigravity({ model: 'gemini-3.8-flash-high', quota: {
  'gemini-5h': { remaining_fraction: five, reset_time: new Date(at + 3 * 3600_000).toISOString() },
  'gemini-weekly': { remaining_fraction: week, reset_time: new Date(at + 2 * 86400_000).toISOString() } } }, at);
function world(readings = []) {
  const store = {};
  for (const r of readings) Q.observe(store, r, now);
  // A time later than the readings lets them age without any new data arriving.
  const at = { t: now };
  const stanceOf = (cmd, seatId) => Q.commandStance(store, cmd, SEATS, seatId || 'cn', at.t);
  return { store, at, stanceOf,
    reviewer: (extra = {}) => AV.pickReviewer({ simple: false, seats: CHOICES, stanceOf, ...extra }),
    dispatcher: () => AV.pickDispatcher({ commandOf: (c) => c.command || GEMINI, seats: CHOICES, stanceOf }) };
}
const modelOf = (cmd) => /--model\s+(\S+)/.exec(cmd)[1];

test('the reading behind the choosers: ok, low, out, unknown and error come from the same passive data as quota', () => {
  const w = world([claude('cn', now, 80, 80), claude('us', now, 12, 70), claude('us2', now, 0, 50), gemini(now, 0.7, 0.6)]);
  assert.equal(w.stanceOf(AV.CANDIDATES[0].command, 'cn'), 'ok');
  assert.equal(w.stanceOf(AV.CANDIDATES[0].command, 'us'), 'low', '12% of the 5-hour window left');
  assert.equal(w.stanceOf(AV.CANDIDATES[0].command, 'us2'), 'out');
  assert.equal(w.stanceOf(GEMINI), 'ok');
  // no reading at all, or only "no error seen", is not room
  assert.equal(world().stanceOf(AV.CANDIDATES[0].command, 'cn'), 'unknown');
  assert.equal(world().stanceOf(GEMINI), 'unknown');
  // a seat whose login or credential is damaged
  const w2 = world([claude('cn', now, 80, 80)]);
  Q.observe(w2.store, { provider: 'Claude', scope: 'claude', seatId: 'us', configDir: '~/.claude-us', authOnly: true, authStatus: 'logged-out', at: now }, now);
  assert.equal(w2.stanceOf(AV.CANDIDATES[0].command, 'us'), 'out', 'signed out');
});

test('Gemini exhausted: the dispatcher is a Claude Haiku 5.5 session, and the reviewer is Claude whatever Gemini says', () => {
  const w = world([claude('cn', now, 80, 80), gemini(now, 0.5, 0)]);   // the weekly window is gone
  assert.equal(w.stanceOf(GEMINI), 'out');
  const d = w.dispatcher();
  assert.equal(d.candidate.id, 'claude-haiku'); assert.equal(d.seat.id, 'cn'); assert.equal(modelOf(d.cmd), 'claude-haiku-5-5');
  const r = w.reviewer();
  assert.equal(modelOf(r.cmd), 'claude-opus-5-5'); assert.equal(r.candidate.label, 'Claude Opus 5.5');
});

test('Gemini data gone stale: never taken for having room (the 10-10 00:29 dispatcher opened on exactly this)', () => {
  const w = world([claude('cn', now, 80, 80), gemini(now, 0.9, 0.9)]);
  assert.equal(w.dispatcher().candidate.id, 'gemini-flash', 'fresh and roomy: Gemini, which spends no Claude quota');
  w.at.t = now + 20 * MIN;   // 15 minutes is as long as a Gemini reading counts
  assert.equal(w.stanceOf(GEMINI), 'unknown');
  const d = w.dispatcher();
  assert.equal(d.candidate.id, 'claude-haiku'); assert.equal(d.stance, 'ok');
  // and no reading ever seen
  assert.equal(world([claude('cn', now, 80, 80)]).dispatcher().candidate.id, 'claude-haiku');
});

test('one Claude seat exhausted: the next seat with room is taken, for the reviewer and for the dispatcher', () => {
  const w = world([claude('cn', now, 0, 40), claude('us', now, 60, 60), claude('us2', now, 90, 90)]);
  const r = w.reviewer();
  assert.equal(r.seat.id, 'us'); assert.equal(r.stance, 'ok');
  assert.equal(w.dispatcher().seat.id, 'us');
  // the leading seat recovers: it leads again
  const w2 = world([claude('cn', now, 70, 70), claude('us', now, 60, 60)]);
  assert.equal(w2.reviewer().seat.id, 'cn');
});

test('every Claude seat exhausted: no reviewer, a reason that names each seat, and the dispatcher falls back to Claude (the ordinary queue holds it)', () => {
  const w = world([claude('cn', now, 0, 40), claude('us', now, 0, 0), claude('us2', now, 10, 0), gemini(now, 0, 0)]);
  const r = w.reviewer();
  assert.equal(r.cmd, undefined); assert.match(r.reason, /^没有可用的审查者/);
  for (const seat of ['cn', 'us', 'us2']) assert.match(r.reason, new RegExp(`（${seat}）：额度用尽`.replace(/[()]/g, '\\$&')), seat);
  const d = w.dispatcher();
  assert.equal(d.cmd, undefined); assert.match(d.reason, /Gemini 3\.8 Flash（Antigravity）：额度用尽/);
});

test('old or failing readings are not room: an unverified Claude seat is only the last resort', () => {
  const w = world([claude('cn', now, 80, 80), claude('us', now, 80, 80)]);
  // the readings are 31 minutes old (an official Claude reading counts for 30): both unknown
  w.at.t = now + 31 * MIN;
  assert.equal(w.stanceOf(AV.CANDIDATES[0].command, 'cn'), 'unknown');
  const weak = w.reviewer();
  assert.equal(weak.unverified, true); assert.equal(weak.seat.id, 'cn'); assert.match(weak.cmd, /^claude /);
  // a fresh seat beats an old one even when it is listed later
  Q.observe(w.store, claude('us2', w.at.t, 70, 70), w.at.t);
  const strong = w.reviewer();
  assert.equal(strong.seat.id, 'us2'); assert.ok(!strong.unverified);
  // three failed queries in a row make a retained reading stale; one failure alone still counts as doubt
  const f = world([claude('cn', now, 80, 80)]);
  Q.observe(f.store, { provider: 'Claude', scope: 'claude', seatId: 'cn', configDir: '~/.claude', failureOnly: true, at: now, checkedAt: now, failures: 1, failure: 'network down' }, now);
  assert.equal(f.stanceOf(AV.CANDIDATES[0].command, 'cn'), 'unknown');
});

test('the title carries the provider and model that really run, for every pick', () => {
  const cases = [
    [world([claude('cn', now, 80, 80)]), { simple: false }, 'Claude Opus 5.5', 'claude-opus-5-5'],
    [world([claude('cn', now, 80, 80)]), { simple: true }, 'Claude Sonnet 5.5', 'claude-sonnet-5-5'],
    [world([claude('cn', now, 0, 0), claude('us', now, 80, 80)]), { simple: true }, 'Claude Sonnet 5.5', 'claude-sonnet-5-5'],
    [world([]), { simple: false }, 'Claude Opus 5.5', 'claude-opus-5-5'],   // nothing readable: last resort, still what it says
  ];
  for (const [w, extra, label, model] of cases) {
    const r = w.reviewer(extra);
    assert.equal(r.candidate.label, label); assert.equal(modelOf(r.cmd), model);
    const title = AV.reviewTitle('修登录（Opus 5.5 high·066us）', r.candidate.label);
    assert.equal(title, `审查：修登录（${label}）`, 'the executor\'s own mark is gone');
    assert.doesNotMatch(title, /Gemini|agy|Antigravity/);
  }
  // the dispatcher's title is built the same way and names Haiku when that is what runs
  const d = world([claude('cn', now, 80, 80)]).dispatcher();
  assert.equal(AV.reviewTitle('画图：全景图（Opus 5.5）', d.candidate.label, 120, '调度：'), '调度：画图：全景图（Claude Haiku 5.5）');
});
