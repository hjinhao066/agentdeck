'use strict';
// Ctrl+V in a terminal: retry an empty clipboard read, fall back to Chromium's
// paste, say so when nothing worked, and never double-paste or reorder keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const PasteRetryCore = require('../paste-retry-core');

// A fake clock: timers run only when the test advances it. `reads` are what
// successive clipboard reads answer ('' for an empty read; an Error rejects).
function harness(reads, extra = {}) {
  let now = 0;
  const timers = [];
  const log = [];
  const reading = reads.slice();
  const ctrl = PasteRetryCore.create({
    readText: async () => {
      log.push(['read', now]);
      const next = reading.length ? reading.shift() : '';
      if (next instanceof Error) throw next;
      return next;
    },
    readImage: extra.readImage || (async () => { log.push(['image', now]); return false; }),
    pasteText: (t) => log.push(['paste', t]),
    pasteNative: extra.pasteNative || (async () => { log.push(['native', now]); return ''; }),
    onFail: () => log.push(['fail', now]),
    sendHeld: (d) => log.push(['key', d]),
    passes: extra.passes,
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  // Run every timer due within `ms` of fake time, letting promises settle between them.
  const advance = async (ms) => {
    const end = now + ms;
    await settle();
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift();
      now = t.at; t.fn(); await settle();
    }
    now = end;
  };
  const of = (kind) => log.filter((e) => e[0] === kind);
  return { ctrl, log, advance, settle, timers, of, pasted: () => of('paste') };
}

test('the first read has text: pasted at once, no timer, no second read', async () => {
  const h = harness(['hello']);
  const done = h.ctrl.press();
  await h.advance(0);
  assert.equal(await done, 'text');
  assert.deepEqual(h.log, [['read', 0], ['paste', 'hello']]);
  assert.equal(h.ctrl.pending, false);
  assert.equal(h.timers.length, 0);
});

test('an empty read is retried every 50 ms and the Nth read pastes', async () => {
  const h = harness(['', '', '', 'late text']);
  const done = h.ctrl.press();
  await h.advance(1000);
  assert.equal(await done, 'text');
  assert.deepEqual(h.of('read').map((e) => e[1]), [0, 50, 100, 150]);
  assert.deepEqual(h.pasted(), [['paste', 'late text']]);
  assert.equal(h.of('native').length + h.of('fail').length, 0);
  assert.equal(h.ctrl.pending, false);
});

test('an image on the clipboard ends the wait without more text reads', async () => {
  const h = harness(['', 'never read'], { readImage: async () => { h.log.push(['image']); return true; } });
  const done = h.ctrl.press();
  await h.advance(1000);
  assert.equal(await done, 'image');
  assert.deepEqual(h.log, [['read', 0], ['image']]);
  assert.equal(h.ctrl.pending, false);
});

test('always empty: reads for 500 ms, then Chromium pastes what it has', async () => {
  const h = harness([], { pasteNative: async () => { h.log.push(['native']); return 'from chromium'; } });
  const done = h.ctrl.press();
  await h.advance(2000);
  assert.equal(await done, 'native');
  const reads = h.of('read').map((e) => e[1]);
  assert.equal(reads.length, 11);
  assert.equal(reads[0], 0);
  assert.equal(reads[reads.length - 1], 500);
  assert.equal(h.of('native').length, 1);
  assert.deepEqual(h.pasted(), [['paste', 'from chromium']]);
  assert.equal(h.of('fail').length, 0);
});

test('Chromium paste delivers nothing either: the user is told, once', async () => {
  const h = harness([]);
  const done = h.ctrl.press();
  await h.advance(2000);
  assert.equal(await done, 'failed');
  assert.equal(h.of('native').length, 1);
  assert.deepEqual(h.of('fail'), [['fail', 500]]);
  assert.deepEqual(h.pasted(), []);
  assert.equal(h.ctrl.pending, false);
});

test('a clipboard read that fails (rejects, throws) counts as empty and the next try can paste', async () => {
  const h = harness([new Error('busy'), new Error('busy'), 'ok']);
  const done = h.ctrl.press();
  await h.advance(1000);
  assert.equal(await done, 'text');
  assert.deepEqual(h.pasted(), [['paste', 'ok']]);
  let thrown = 0;
  const ctrl = PasteRetryCore.create({
    readText: () => { if (thrown++ === 0) throw new Error('sync boom'); return 'again'; },
    readImage: async () => { throw new Error('image boom'); },
    pasteText: (t) => h.log.push(['paste2', t]),
    setTimer: (fn) => { fn(); return 0; }, clearTimer() {},
  });
  assert.equal(await ctrl.press(), 'text');
  assert.deepEqual(h.log.filter((e) => e[0] === 'paste2'), [['paste2', 'again']]);
});

test('Ctrl+V pressed again while one is running does not paste twice', async () => {
  const h = harness(['', '', 'once']);
  const first = h.ctrl.press();
  await h.advance(20);
  assert.equal(await h.ctrl.press(), 'ignored');
  assert.equal(await h.ctrl.press(), 'ignored');
  await h.advance(1000);
  assert.equal(await first, 'text');
  assert.deepEqual(h.pasted(), [['paste', 'once']]);
  assert.equal(h.of('read').length, 3);
});

test('a Ctrl+V after the paste finished is a new paste', async () => {
  const h = harness(['', 'first', 'second']);
  const first = h.ctrl.press();
  await h.advance(200);
  assert.equal(await first, 'text');
  const second = h.ctrl.press();
  await h.advance(0);
  assert.equal(await second, 'text');
  assert.deepEqual(h.pasted(), [['paste', 'first'], ['paste', 'second']]);
});

test('keys typed while waiting follow the paste, in order', async () => {
  const h = harness(['', '', 'PASTED']);
  const done = h.ctrl.press();
  assert.equal(h.ctrl.hold('a'), true);
  await h.advance(60);
  assert.equal(h.ctrl.hold('b'), true);
  await h.advance(1000);
  await done;
  assert.deepEqual(h.log.filter((e) => e[0] === 'paste' || e[0] === 'key'), [['paste', 'PASTED'], ['key', 'a'], ['key', 'b']]);
  // nothing waits once the paste is over
  assert.equal(h.ctrl.hold('c'), false);
});

test('keys typed while waiting are not lost when nothing could be pasted', async () => {
  const h = harness([]);
  const done = h.ctrl.press();
  h.ctrl.hold('x');
  await h.advance(2000);
  assert.equal(await done, 'failed');
  assert.deepEqual(h.log.filter((e) => e[0] === 'fail' || e[0] === 'key'), [['fail', 500], ['key', 'x']]);
});

test('terminal replies and the wheel never wait (passes)', async () => {
  const h = harness([''], { passes: (d) => d.startsWith('\x1b[') });
  h.ctrl.press();
  assert.equal(h.ctrl.hold('\x1b[I'), false);
  assert.equal(h.ctrl.hold('q'), true);
  await h.advance(2000);
});

test('cancel stops the retries and releases the held keys without pasting', async () => {
  const h = harness(['', '', 'never']);
  const done = h.ctrl.press();
  await h.advance(10);
  h.ctrl.hold('z');
  h.ctrl.cancel();
  await h.advance(1000);
  assert.equal(await done, 'cancelled');
  assert.deepEqual(h.log.filter((e) => e[0] === 'paste' || e[0] === 'key' || e[0] === 'fail'), [['key', 'z']]);
  assert.equal(h.ctrl.pending, false);
  assert.equal(h.timers.length, 0);
  // and a new press works afterwards
  const again = h.ctrl.press();
  await h.advance(1000);
  assert.equal(await again, 'text');
});

test('the 500 ms window is the clock, so slow failing reads leave fewer tries', async () => {
  let now = 0;
  const seen = { reads: 0, native: 0, fail: 0 };
  const ctrl = PasteRetryCore.create({
    now: () => now,
    readText: async () => { seen.reads++; now += 200; return ''; }, // a read that fails slowly
    readImage: async () => false,
    pasteNative: async () => { seen.native++; return ''; },
    onFail: () => seen.fail++,
    setTimer: (fn, ms) => { now += ms; fn(); return 0; }, clearTimer() {},
  });
  assert.equal(await ctrl.press(), 'failed');
  assert.deepEqual(seen, { reads: 3, native: 1, fail: 1 });
});
