'use strict';
// Pure rules: what counts as a sleep/network interruption and when to nudge.
// A fake clock stands in for the machine; nothing here sleeps for real.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../sleep-resume-core');

const prompt = '\n╭────────────╮\n│ >          │\n╰────────────╯\n  ? for shortcuts';

test('the screen signs seen on 2026-10-07 are read as interruptions', () => {
  const cases = [
    ['sleep', '⎿  API Error: Your computer went to sleep mid-response. Try again.'],
    ['network', '  ⎿  API Error: Connection lost mid-response'],
    ['network', '⎿  API Error: Unable to connect. Can\'t reach the API server (retried 10 times)'],
    ['network', 'There was a network issue connecting to the server.'],
    ['network', 'Error: write: broken pipe'],
  ];
  for (const [kind, line] of cases) assert.equal(S.interruption('earlier output\n' + line + prompt), kind, line);
});

test('the same words quoted, in code, in a diff or high up the screen are not an interruption', () => {
  const quoted = [
    '- expected "Connection lost mid-response" in the screen',
    '+ if (/Your computer went to sleep mid-response/.test(s)) {',
    '  const re = /write: broken pipe/;',
    '"There was a network issue connecting to the server" is what agy prints',
    '// Can\'t reach the API server',
    '| Connection lost mid-response | network |',
  ];
  for (const line of quoted) assert.equal(S.interruption('done\n' + line + prompt), '', line);
  const old = 'API Error: Connection lost mid-response\n' + Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n');
  assert.equal(S.interruption(old + prompt), '');
  assert.equal(S.interruption(''), '');
  assert.equal(S.interruption(undefined), '');
});

test('a sentence that only mentions the words late in a long line is not an interruption', () => {
  assert.equal(S.interruption('I tested what happens when the app prints write: broken pipe on screen' + prompt), '');
});

test('clock: suspend and resume, plus a long silence as an implicit wake', () => {
  let now = 1000;
  const clock = S.createClock(() => now);
  assert.deepEqual(clock.snapshot(), { asleep: false, wokeAt: 0 });
  clock.suspend();
  assert.equal(clock.snapshot().asleep, true);
  now = 500_000; clock.resume(now - 1000);
  assert.deepEqual(clock.snapshot(), { asleep: false, wokeAt: 499_000 });
  now += 2000; clock.beat();
  assert.equal(clock.snapshot().wokeAt, 499_000, 'ordinary ticks are not wakes');
  now += S.IMPLICIT_WAKE_GAP + 1; clock.beat();
  assert.equal(clock.snapshot().wokeAt, now, 'a missed resume event still shows up as a long gap');
  clock.suspend(); now += 2000; clock.beat();
  assert.equal(clock.snapshot().asleep, true, 'ticks right after a suspend event do not undo it');
  now += S.IMPLICIT_WAKE_GAP * 3; clock.beat();
  assert.deepEqual(clock.snapshot(), { asleep: false, wokeAt: now }, 'ticks coming back after a long silence mean it woke, even if its event is late');
});

test('evidence: the screen, or a sleep during the task that ended soon after waking', () => {
  const awake = { asleep: false, wokeAt: 100_000 };
  assert.equal(S.evidence({ screen: 'API Error: Connection lost mid-response', now: 101_000, clock: awake }), 'screen');
  assert.equal(S.evidence({ screen: 'ok', sleptAt: 90_000, now: 101_000, clock: awake }), 'event');
  assert.equal(S.evidence({ screen: 'ok', sleptAt: 90_000, now: 100_000 + S.EVENT_WINDOW, clock: awake }), '');
  assert.equal(S.evidence({ screen: 'ok', now: 101_000, clock: awake }), '');
  assert.equal(S.evidence({ screen: 'ok', sleptAt: 110_000, now: 120_000, clock: awake }), '', 'a sleep after the last wake has not been woken from');
  assert.equal(S.evidence({ screen: 'ok', sleptAt: 90_000, now: 101_000, clock: { asleep: true, wokeAt: 100_000 } }), '');
});

test('decide waits while asleep, offline, waking or still settling', () => {
  const sr = { firstSeenAt: 0, attempts: 0, lastAt: 0, evidence: 'screen' };
  const base = { now: 600_000, online: true, clock: { asleep: false, wokeAt: 0 } };
  assert.equal(S.decide(sr, { ...base, clock: { asleep: true, wokeAt: 0 } }).why, 'asleep');
  assert.equal(S.decide(sr, { ...base, online: false }).why, 'offline');
  assert.equal(S.decide(sr, { ...base, clock: { asleep: false, wokeAt: base.now - 1000 } }).why, 'waking');
  assert.equal(S.decide({ ...sr, firstSeenAt: base.now - 1000 }, base).why, 'settling');
  assert.deepEqual(S.decide(sr, base), { action: 'send', attempt: 1 });
  assert.deepEqual(S.decide(sr, { ...base, clock: { asleep: false, wokeAt: base.now - S.WAKE_MS } }), { action: 'send', attempt: 1 });
});

test('decide spaces the nudges out, stops at the cap, then gives up', () => {
  const sr = { firstSeenAt: 0, attempts: 0, lastAt: 0, evidence: 'screen' };
  const clock = { asleep: false, wokeAt: 0 };
  let now = 100_000, sent = 0;
  const log = [];
  for (let i = 0; i < 2000; i++) {
    const d = S.decide(sr, { now, clock, online: true, lifetime: 0 });
    if (d.action === 'send') { sr.attempts = d.attempt; sr.lastAt = now; sent++; log.push(now); }
    if (d.action === 'giveup') { log.push('giveup'); break; }
    now += 1000;
  }
  assert.equal(sent, S.MAX_SCREEN);
  assert.equal(log.at(-1), 'giveup');
  const gaps = log.slice(1, S.MAX_SCREEN).map((t, i) => t - log[i]);
  assert.deepEqual(gaps, S.GAPS.slice(1, S.MAX_SCREEN), 'each nudge waits its gap after the previous one');
});

test('decide: event-only evidence gets one nudge and the lifetime cap holds', () => {
  const ctx = { now: 1_000_000, clock: { asleep: false, wokeAt: 0 }, online: true };
  assert.equal(S.decide({ firstSeenAt: 0, attempts: 0, lastAt: 0, evidence: 'event' }, ctx).action, 'send');
  assert.equal(S.decide({ firstSeenAt: 0, attempts: S.MAX_EVENT, lastAt: 1, evidence: 'event' }, ctx).action, 'giveup');
  assert.equal(S.decide({ firstSeenAt: 0, attempts: 0, lastAt: 0, evidence: 'screen' }, { ...ctx, lifetime: S.LIFETIME }).why, 'lifetime');
});

test('a short, plain message that does not ask for a new task', () => {
  const text = S.message();
  assert.match(text, /^接着做/);
  assert.ok(text.length < 80);
  assert.match(text, /complete/);
});

test('the module ships the page\'s shared clock (the page reads SleepResume.clock)', () => {
  assert.equal(typeof S.clock.suspend, 'function');
  assert.equal(typeof S.clock.resume, 'function');
  assert.equal(typeof S.clock.beat, 'function');
  assert.deepEqual(Object.keys(S.clock.snapshot()).sort(), ['asleep', 'wokeAt']);
});
