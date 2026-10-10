'use strict';
// Ctrl+V follow-ups to the retry ladder (paste-retry-core.js):
//  - Ctrl+V is the same on every platform; Cmd+V is never touched
//  - press() never rejects (a throwing paste, hint or key sender)
//  - the hint says what is on the clipboard when it is not text
//  - Chromium's paste that arrives after the wait gave up is swallowed, so pressing again
//    as the hint says pastes once
const test = require('node:test');
const assert = require('node:assert/strict');
const PasteRetryCore = require('../paste-retry-core');

const immediate = (fn, ms) => { if (ms === undefined || ms >= 0) fn(); return 0; };
const ticking = () => { let t = 0; return () => (t += 100); }; // every look at the clock is 100 ms later
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// ---- Cmd+V stays native; Ctrl+V is one path ----

test('only a plain Ctrl+V is taken: Cmd+V, Ctrl+Shift+V, Alt and key-up are left alone', () => {
  const key = (extra) => ({ type: 'keydown', key: 'v', code: 'KeyV', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
  assert.equal(PasteRetryCore.isCtrlV(key({ ctrlKey: true })), true);
  assert.equal(PasteRetryCore.isCtrlV(key({ ctrlKey: true, key: 'V' })), true);
  assert.equal(PasteRetryCore.isCtrlV(key({ ctrlKey: true, key: 'Process' })), true, 'an IME key name still has the V code');
  assert.equal(PasteRetryCore.isCtrlV(key({ metaKey: true })), false, 'Cmd+V on a Mac pastes natively');
  assert.equal(PasteRetryCore.isCtrlV(key({ ctrlKey: true, metaKey: true })), false);
  assert.equal(PasteRetryCore.isCtrlV(key({ ctrlKey: true, shiftKey: true })), false);
  assert.equal(PasteRetryCore.isCtrlV(key({ ctrlKey: true, altKey: true })), false);
  assert.equal(PasteRetryCore.isCtrlV(key({ ctrlKey: true, type: 'keyup' })), false);
  assert.equal(PasteRetryCore.isCtrlV(key({ ctrlKey: true, key: 'c', code: 'KeyC' })), false);
  assert.equal(PasteRetryCore.isCtrlV(null), false);
});

test('renderer.js sends every Ctrl+V through the async ladder: no platform branch, no synchronous read', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const at = src.indexOf('PasteRetryCore.isCtrlV(e)');
  assert.ok(at > 0, 'the key handler asks the core');
  const handler = src.slice(at, src.indexOf('return true;', at)).replace(/\/\/.*$/gm, '');
  assert.match(handler, /ctrlV\.press\(\)/);
  assert.doesNotMatch(handler, /platform|darwin|clipboardRead\(/);
  assert.doesNotMatch(src, /window\.deck\.clipboardRead\(/, 'the page never reads the clipboard synchronously');
});

// ---- d: press() never rejects ----

test('a paste that throws ends as failed, not as an unhandled rejection, and the held keys still go', async () => {
  const keys = [];
  const ctrl = PasteRetryCore.create({
    readText: async () => 'boom',
    pasteText: () => { throw new Error('term.paste failed'); },
    sendHeld: (d) => keys.push(d),
    setTimer: immediate, clearTimer() {},
  });
  const done = ctrl.press();
  assert.equal(ctrl.hold('a'), true);
  assert.equal(ctrl.hold('b'), true);
  assert.equal(await done, 'failed');
  assert.deepEqual(keys, ['a', 'b']);
  assert.equal(ctrl.pending, false);
  assert.equal(await ctrl.press(), 'failed', 'the next press runs and is not stuck as ignored');
});

test('a hint or a key sender that throws neither rejects nor loses the other keys', async () => {
  const sent = [];
  const ctrl = PasteRetryCore.create({
    readText: async () => '', pasteNative: async () => '',
    onFail: () => { throw new Error('hint failed'); },
    sendHeld: (d) => { sent.push(d); if (d === 'a') throw new Error('terminal gone'); },
    now: ticking(), windowMs: 1, intervalMs: 1,
    setTimer: immediate, clearTimer() {},
  });
  const done = ctrl.press();
  ctrl.hold('a'); ctrl.hold('b');
  assert.equal(await done, 'failed');
  assert.deepEqual(sent, ['a', 'b']);
});

test('a press whose every step throws still settles', async () => {
  const ctrl = PasteRetryCore.create({
    readText: () => { throw new Error('x'); }, readImage: () => { throw new Error('y'); },
    pasteNative: () => { throw new Error('z'); }, readKind: () => { throw new Error('k'); },
    now: ticking(), setTimer: immediate, clearTimer() {},
  });
  assert.equal(await ctrl.press(), 'failed');
  assert.equal(ctrl.pending, false);
});

// ---- c: the hint depends on what is on the clipboard ----

test('files on the clipboard get their own hint; nothing readable keeps the busy-or-not-text one', async () => {
  const seen = [];
  const make = (kind) => PasteRetryCore.create({
    readText: async () => '', pasteNative: async () => '', readKind: async () => kind,
    onFail: (k) => seen.push(k), now: ticking(), setTimer: immediate, clearTimer() {},
  });
  assert.equal(await make('other').press(), 'failed');
  assert.equal(await make('none').press(), 'failed');
  assert.equal(await make('weird').press(), 'failed');
  assert.deepEqual(seen, ['other', 'none', 'none']);
  const other = PasteRetryCore.failureHint('other');
  const none = PasteRetryCore.failureHint('none');
  assert.notEqual(other, none);
  assert.match(other, /不是文字/);
  assert.doesNotMatch(other, /占用/, 'a file on the clipboard is not a clipboard held by another program');
  assert.match(none, /文字/);
  assert.match(none, /占用/);
  assert.match(none, /Ctrl\+V/);
});

test('the kind is looked up only after every try failed, and a cancel in between drops it', async () => {
  const calls = [];
  const pasted = PasteRetryCore.create({
    readText: async () => 'text', readKind: async () => { calls.push('kind'); return 'other'; },
    pasteText: () => {}, now: ticking(), setTimer: immediate, clearTimer() {},
  });
  assert.equal(await pasted.press(), 'text');
  assert.deepEqual(calls, [], 'a paste that worked never asks');
  let release;
  const slow = PasteRetryCore.create({
    readText: async () => '', pasteNative: async () => '',
    readKind: () => new Promise((resolve) => { release = () => resolve('other'); }),
    onFail: () => calls.push('hint'), now: ticking(), setTimer: immediate, clearTimer() {},
  });
  const done = slow.press();
  await settle();
  slow.cancel();
  release();
  assert.equal(await done, 'cancelled');
  assert.deepEqual(calls, [], 'a cancelled press tells nobody');
});

// ---- a: a paste event that comes after the wait gave up ----

// A page stand-in: paste events go to every listener; the first that takes one stops it.
function nativeHarness(extra = {}) {
  let now = 0;
  const timers = [];
  const listeners = new Set();
  const log = [];
  const nativePaste = PasteRetryCore.createNativePaste({
    listen: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    request: extra.request || (async () => true),
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = async (ms) => {
    const end = now + ms;
    await settle();
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift(); now = t.at; t.fn(); await settle();
    }
    now = end;
  };
  // What a paste event does in the page: true when somebody took it (xterm never sees it).
  const pasteEvent = (text) => {
    for (const fn of [...listeners]) if (fn(text)) { log.push(['taken', text]); return true; }
    log.push(['xterm', text]);
    return false;
  };
  return { nativePaste, advance, pasteEvent, log, listeners, timers };
}

test('Chromium delivers in time: the text comes back once and the event is taken', async () => {
  const n = nativeHarness();
  const result = n.nativePaste();
  await n.advance(5);
  assert.equal(n.pasteEvent('hello'), true);
  assert.equal(await result, 'hello');
  assert.equal(n.listeners.size, 0, 'nothing is left listening');
  assert.equal(n.timers.length, 0);
  assert.equal(n.pasteEvent('again'), false, 'the next paste event is an ordinary one');
});

test('Chromium is late (after 300 ms): the late paste is swallowed, so pressing again as the hint says pastes once', async () => {
  const n = nativeHarness();
  const result = n.nativePaste();
  await n.advance(PasteRetryCore.NATIVE_WAIT_MS);
  assert.equal(await result, '', 'the wait gave up: the caller shows the failure hint');
  await n.advance(400); // the event arrives at 700 ms
  assert.equal(n.pasteEvent('late text'), true, 'taken, so xterm does not paste it');
  assert.deepEqual(n.log, [['taken', 'late text']]);
  // The user presses Ctrl+V again, as the hint says; this time the clipboard is free.
  const second = n.nativePaste();
  await n.advance(5);
  assert.equal(n.pasteEvent('late text'), true);
  assert.equal(await second, 'late text', 'one paste for the second press, none for the first');
});

test('the swallowing ends after the grace time, so a later real paste is not eaten', async () => {
  const n = nativeHarness();
  const result = n.nativePaste();
  await n.advance(PasteRetryCore.NATIVE_WAIT_MS);
  await result;
  assert.equal(n.listeners.size, 1, 'a guard is up');
  await n.advance(PasteRetryCore.NATIVE_GRACE_MS - 1);
  assert.equal(n.listeners.size, 1);
  await n.advance(2);
  assert.equal(n.listeners.size, 0, 'the guard is gone');
  assert.equal(n.pasteEvent('pasted by hand'), false);
});

test('Chromium refused to run or failed: no guard is left, because nothing will arrive', async () => {
  for (const request of [async () => false, async () => { throw new Error('gone'); }, () => { throw new Error('sync'); }]) {
    const n = nativeHarness({ request });
    assert.equal(await n.nativePaste(), '');
    assert.equal(n.listeners.size, 0);
    assert.equal(n.timers.length, 0);
  }
});

test('a paste event without text is not taken (an image or empty clipboard is left to its own handler)', async () => {
  const n = nativeHarness();
  const result = n.nativePaste();
  await n.advance(5);
  assert.equal(n.pasteEvent(''), false);
  await n.advance(PasteRetryCore.NATIVE_WAIT_MS);
  assert.equal(await result, '');
});
