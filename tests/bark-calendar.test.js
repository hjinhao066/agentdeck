'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DAY_MS, matchesClass, eventRange, createCalendarCache } = require('../bark-calendar');
const at = Date.parse('2026-10-08T10:00:00-07:00');
const event = (overrides = {}) => ({ summary: 'IMT 540 A — Design Methods', status: 'confirmed',
  start: { dateTime: '2026-10-08T10:30:00-07:00' }, end: { dateTime: '2026-10-08T12:20:00-07:00' }, ...overrides });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-calendar-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'private-calendar.json');
}
function cli(handler, calls) {
  return (binary, args, options, callback) => {
    assert.match(binary, /^gws(?:\.exe)?$/);
    assert.deepEqual(args.slice(0, 4), ['calendar', 'events', 'list', '--params']);
    assert.deepEqual(args.slice(5), ['--format', 'json']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    const params = JSON.parse(args[4]); calls.push(params);
    queueMicrotask(() => {
      try { callback(null, JSON.stringify(handler(params))); }
      catch (error) { callback(error); }
    });
  };
}
test('class matching tolerates course-code spacing and keeps 598 B separate from 598 A', () => {
  const filters = ['IMT 540', 'IMT 598 B'];
  for (const title of ['IMT 540 A — Design Methods', 'imt540 seminar', 'IMT598B leadership', 'IMT 598 B']) assert.equal(matchesClass(title, filters), true, title);
  for (const title of ['IMT 598 A', 'IMT 598', 'IMT 5400', 'XIMT 540', 'Unrelated meeting']) assert.equal(matchesClass(title, filters), false, title);
  assert.equal(matchesClass('Course (A) meeting', ['Course (A)']), true);
});
test('a changed calendar selection during a pending query is refreshed before delivery can proceed', async (t) => {
  const file = fixture(t), calls = [], callbacks = [];
  let options = { classCalendarIds: ['old'] };
  const cache = createCalendarCache({ file, now: () => at, getSettings: () => options,
    execFileImpl: (_binary, args, _options, callback) => { calls.push(JSON.parse(args[4]).calendarId); callbacks.push(callback); } });
  const old = cache.refresh();
  options = { classCalendarIds: ['new'] };
  const latest = cache.refresh();
  callbacks.shift()(null, JSON.stringify({ items: [] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['old', 'new']);
  callbacks.shift()(null, JSON.stringify({ items: [event()] }));
  await Promise.all([old, latest]);
  assert.equal(cache.status().available, true); assert.equal(cache.ranges().length, 1);
});
test('an empty partial API response can omit items without being mistaken for a fetch failure', async (t) => {
  const cache = createCalendarCache({ file: fixture(t), now: () => at, execFileImpl: cli(() => ({}), []) });
  assert.equal((await cache.refresh()).available, true); assert.deepEqual(cache.ranges(), []);
});
test('cancelled, declined, all-day and timezone-less events do not create class periods', () => {
  const filters = ['IMT 540'];
  assert.deepEqual(eventRange(event(), filters), { start: Date.parse(event().start.dateTime), end: Date.parse(event().end.dateTime) });
  for (const value of [event({ status: 'cancelled' }), event({ attendees: [{ self: true, responseStatus: 'declined' }] }),
    event({ start: { date: '2026-10-08' }, end: { date: '2026-10-09' } }),
    event({ start: { dateTime: '2026-10-08T10:30:00' } }), event({ end: { dateTime: event().start.dateTime } }),
    event({ summary: 'Unrelated private appointment' })]) assert.equal(eventRange(value, filters), null);
  assert.ok(eventRange(event({ attendees: [{ self: false, responseStatus: 'declined' }] }), filters));
});
test('daily refresh expands recurring events, paginates, sanitizes its cache and coalesces callers', async (t) => {
  const file = fixture(t), calls = [];
  const cache = createCalendarCache({ file, now: () => at, execFileImpl: cli((params) => params.pageToken
    ? { items: [event({ summary: 'IMT 598 A — excluded' }), event()] }
    : { items: [event({ description: 'PRIVATE-BODY', location: 'PRIVATE-LOCATION' })], nextPageToken: 'second' }, calls) });
  assert.deepEqual(cache.ranges(), []);
  await Promise.all([cache.refresh(), cache.refresh()]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].calendarId, 'primary');
  assert.equal(calls[0].singleEvents, true);
  assert.equal(calls[0].showDeleted, false);
  assert.equal(calls[0].timeMin, new Date(at).toISOString());
  assert.equal(Date.parse(calls[0].timeMax) - at, 14 * DAY_MS);
  assert.equal(calls[1].pageToken, 'second');
  assert.deepEqual(cache.status(), { available: true, state: 'ready', fetchedAt: at, lastAttemptAt: at });
  assert.equal(cache.ranges().length, 1);
  cache.ranges()[0].start = 0;
  assert.notEqual(cache.ranges()[0].start, 0);
  await cache.refresh(); assert.equal(calls.length, 2);
  const stored = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(stored, /PRIVATE-|Design Methods|description|location|attendees/);
  const reloaded = createCalendarCache({ file, now: () => at + 1000, execFileImpl: () => { throw new Error('must not query fresh cache'); } });
  assert.equal(reloaded.ranges().length, 1);
  assert.equal((await reloaded.refresh()).available, true);
});
test('a fresh empty calendar succeeds; a stale cache or failed refresh falls back without class suppression', async (t) => {
  const file = fixture(t), calls = []; let time = at, fail = false;
  const cache = createCalendarCache({ file, now: () => time, execFileImpl: cli(() => {
    if (fail) throw new Error('PRIVATE-CREDENTIAL-ERROR');
    return { items: [event()] };
  }, calls) });
  await cache.refresh(); assert.equal(cache.ranges().length, 1);
  time += DAY_MS;
  assert.deepEqual(cache.ranges(), []);
  assert.equal(cache.status().state, 'stale');
  fail = true;
  const failure = await cache.refresh();
  assert.equal(failure.state, 'unavailable');
  assert.deepEqual(cache.ranges(), []);
  assert.doesNotMatch(JSON.stringify(failure) + fs.readFileSync(file, 'utf8'), /PRIVATE-CREDENTIAL-ERROR/);
  await cache.refresh(); assert.equal(calls.length, 2);
  const reloaded = createCalendarCache({ file, now: () => time + 1000, execFileImpl: () => { throw new Error('daily retry must stay gated after restart'); } });
  assert.equal((await reloaded.refresh()).state, 'unavailable');
  fail = false; time += DAY_MS;
  await cache.refresh(); assert.equal(cache.status().state, 'ready');
  const empty = createCalendarCache({ file: fixture(t), now: () => time, execFileImpl: cli(() => ({ items: [] }), []) });
  assert.equal((await empty.refresh()).available, true);
  assert.deepEqual(empty.ranges(), []);
});
test('partial pagination, a failed selected calendar, missing CLI and malformed output are unavailable, never false empty success', async (t) => {
  for (const read of [cli(() => ({ items: [event()], nextPageToken: 'repeated' }), []),
    cli((params) => { if (params.calendarId === 'second') throw new Error('private-error'); return { items: [event()] }; }, []),
    (_binary, _args, _options, callback) => callback({ code: 'ENOENT' }),
    (_binary, _args, _options, callback) => callback(null, '{'),
    (_binary, _args, _options, callback) => callback(null, '{"error":{"message":"PRIVATE"}}')]) {
    const cache = createCalendarCache({ file: fixture(t), now: () => at, getSettings: () => ({ classCalendarIds: ['primary', 'second'] }), execFileImpl: read });
    assert.equal((await cache.refresh()).state, 'unavailable');
    assert.deepEqual(cache.ranges(), []);
  }
});
test('settings changes invalidate old coverage and disabled class suppression never calls the CLI', async (t) => {
  const calls = []; let current = { classesEnabled: true, classCalendarIds: ['primary'], classFilters: ['IMT 540'] };
  const cache = createCalendarCache({ file: fixture(t), now: () => at, getSettings: () => current,
    execFileImpl: cli(() => ({ items: [event()] }), calls) });
  await cache.refresh(); assert.equal(cache.ranges().length, 1);
  current = { ...current, classFilters: ['IMT 598 B'] };
  assert.deepEqual(cache.ranges(), []);
  await cache.refresh(); assert.equal(calls.length, 2);
  current = { ...current, classesEnabled: false };
  assert.deepEqual(cache.ranges(), []);
  assert.equal((await cache.refresh()).state, 'disabled');
  assert.equal(calls.length, 2);
});
