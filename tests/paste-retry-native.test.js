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
    now: () => now,
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

// ---- a paste the user asks for while the guard is up goes through once; nothing else changes ----

const key = (extra) => ({ type: 'keydown', key: 'a', code: 'KeyA', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
// A late Chromium paste: the wait gave up at 300 ms, and the guard is up.
async function guarded() {
  const n = nativeHarness();
  const result = n.nativePaste();
  await n.advance(PasteRetryCore.NATIVE_WAIT_MS);
  assert.equal(await result, '');
  assert.equal(n.listeners.size, 1, 'a guard is up');
  return n;
}
const shiftInsert = () => key({ key: 'Insert', code: 'Insert', shiftKey: true });
const ctrlShiftV = () => key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true });
const cmdV = () => key({ key: 'v', code: 'KeyV', metaKey: true });
const leftClick = () => ({ type: 'mousedown', button: 0 });
const rightClick = () => ({ type: 'mousedown', button: 2 });

test('what is a paste chord: Shift+Insert, Ctrl+Shift+V, Cmd+V and a right-button press; nothing else', () => {
  const yes = (e) => assert.equal(PasteRetryCore.isPasteChord(e), true, JSON.stringify(e));
  const no = (e) => assert.equal(PasteRetryCore.isPasteChord(e), false, JSON.stringify(e));
  yes(shiftInsert());
  yes(ctrlShiftV());
  yes(key({ key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: true }));
  yes(cmdV());
  yes(rightClick());
  no(leftClick());
  no({ type: 'mousedown', button: 1 });
  no(key({ key: 'v', code: 'KeyV', ctrlKey: true })); // the plain Ctrl+V the hint asks for again
  no(key({ key: 'v', code: 'KeyV', ctrlKey: true, repeat: true }));
  no(key({ key: 'Insert', code: 'Insert' })); // Insert alone
  no(key({ key: 'Insert', code: 'Insert', ctrlKey: true })); // Ctrl+Insert is a copy
  no(key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, altKey: true }));
  no(key({ key: 'v', code: 'KeyV', metaKey: true, shiftKey: true }));
  no(key({ key: 'v', code: 'KeyV' }));
  for (const k of ['Control', 'Shift', 'Alt', 'Meta']) no(key({ key: k, ctrlKey: k === 'Control', shiftKey: k === 'Shift' }));
  no(key({ key: 'x' }));
  no(key({ key: 'Enter', code: 'Enter' }));
  no({ type: 'keyup', key: 'Insert', shiftKey: true });
  no({ type: 'mouseup', button: 2 });
  no(null);
});

test('Shift+Insert (the way Type4Me pastes on Windows) right after the hint is pasted once; Chromium\'s late one after it is still dropped', async () => {
  const n = await guarded();
  n.nativePaste.userInput(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }));
  n.nativePaste.userInput(shiftInsert());
  assert.equal(n.listeners.size, 1, 'the guard stays up');
  assert.equal(n.pasteEvent('spoken words'), false, 'the voice text reaches the terminal');
  assert.equal(n.pasteEvent('late text'), true, 'and only one paste is let through: the late one is taken');
  assert.deepEqual(n.log, [['xterm', 'spoken words'], ['taken', 'late text']]);
});

test('Ctrl+Shift+V and Cmd+V are pasted once each', async () => {
  for (const chord of [ctrlShiftV, cmdV]) {
    const n = await guarded();
    n.nativePaste.userInput(chord());
    assert.equal(n.pasteEvent('by hand'), false, chord.name);
    assert.equal(n.pasteEvent('late'), true, chord.name);
  }
});

test('a right-click paste is pasted once, however long the menu takes; the late paste is still dropped', async () => {
  const n = await guarded();
  n.nativePaste.userInput(rightClick());
  await n.advance(900);
  assert.equal(n.pasteEvent('from the context menu'), false);
  assert.equal(n.pasteEvent('late'), true);
});

test('a chord whose paste never comes lets nothing else through after it expires', async () => {
  const n = await guarded();
  n.nativePaste.userInput(shiftInsert());
  await n.advance(PasteRetryCore.ALLOW_MS + 50);
  assert.equal(n.pasteEvent('late text'), true, 'the late paste is not mistaken for the user\'s');
});

test('a left click or an ordinary key does not lift the guard: the late paste is dropped, and Ctrl+V pressed again pastes once', async () => {
  for (const input of [leftClick(), key({ key: 'x' }), key({ key: 'Enter', code: 'Enter' }), key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), { type: 'mousemove' }, { type: 'keyup', key: 'v' }]) {
    const n = await guarded();
    n.nativePaste.userInput(input);
    assert.equal(n.listeners.size, 1, JSON.stringify(input));
    assert.equal(n.pasteEvent('late text'), true, `taken after ${JSON.stringify(input)}`);
    assert.deepEqual(n.log, [['taken', 'late text']]);
  }
});

test('pressing Ctrl+V again as the hint says (Ctrl, then V, V auto-repeating) leaves the guard up, so the late paste is not doubled', async () => {
  const n = await guarded();
  n.nativePaste.userInput(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }));
  n.nativePaste.userInput(key({ key: 'v', code: 'KeyV', ctrlKey: true }));
  n.nativePaste.userInput(key({ key: 'v', code: 'KeyV', ctrlKey: true, repeat: true }));
  assert.equal(n.listeners.size, 1, 'the guard is up');
  assert.equal(n.pasteEvent('late text'), true);
  // and the new press still gets exactly one paste: its request takes over from the guard
  const second = n.nativePaste();
  await n.advance(5);
  assert.equal(n.pasteEvent('fresh'), true);
  assert.equal(await second, 'fresh');
});

test('a click, a key and then Ctrl+V again, with Chromium\'s paste arriving late in between: still one paste', async () => {
  const n = await guarded();
  n.nativePaste.userInput(leftClick());
  n.nativePaste.userInput(key({ key: 'x' }));
  n.nativePaste.userInput(key({ key: 'v', code: 'KeyV', ctrlKey: true })); // the press the hint asks for
  assert.equal(n.pasteEvent('late text'), true, 'dropped');
  assert.deepEqual(n.log, [['taken', 'late text']]);
});

test('a chord pressed before a new request does not carry over to it, and chords with no guard are harmless', async () => {
  const n = await guarded();
  n.nativePaste.userInput(shiftInsert());
  const next = n.nativePaste(); // a new Ctrl+V takes over from the guard
  await n.advance(5);
  assert.equal(n.pasteEvent('fresh'), true, 'taken by the new request');
  assert.equal(await next, 'fresh');
  const m = nativeHarness();
  m.nativePaste.userInput(shiftInsert()); // no guard at all
  m.nativePaste.userInput(rightClick());
  const result = m.nativePaste();
  await m.advance(5);
  assert.equal(m.pasteEvent('hello'), true);
  assert.equal(await result, 'hello');
});

test('renderer.js hands every key and mouse press of the column to the guard, in the capture phase', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(src, /for \(const type of \['keydown', 'mousedown'\]\) termEl\.addEventListener\(type, nativePasteWhenFocused\.userInput, true\)/);
});

test('a picture the main process cannot read: files get their own words, anything else keeps "paste again"', () => {
  const files = PasteRetryCore.pictureFailureHint('other', '终端');
  assert.match(files, /剪贴板里是文件/);
  assert.match(files, /终端只能粘贴文字和截图/);
  assert.doesNotMatch(files, /再粘贴一次/, 'retrying will not help');
  for (const kind of ['none', 'image', 'text', undefined]) assert.equal(PasteRetryCore.pictureFailureHint(kind, '终端'), '剪贴板里的截图没读出来，请再粘贴一次');
});
