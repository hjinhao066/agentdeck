'use strict';
// The check on a copy button belongs to the button's key, not to the node that was clicked: the
// write is asynchronous, the list redraws meanwhile, and the new button must show the check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CopyMark = require('../copy-mark');

// A page stand-in: nodes carrying a key, a clock and timers that run when the clock passes them.
function page() {
  let now = 1000;
  const timers = [];
  const nodes = []; // what the page shows now
  const shown = (n) => n.checked;
  const mark = CopyMark.create({
    find: (key) => nodes.filter((n) => n.key === key),
    show: (n) => { n.checked = true; },
    hide: (n) => { n.checked = false; },
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const build = (key) => { const n = { key, checked: false }; mark.adopt(key, n); nodes.push(n); return n; };
  const drop = (n) => nodes.splice(nodes.indexOf(n), 1);
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift(); now = t.at; t.fn();
    }
    now = end;
  };
  return { mark, build, drop, advance, shown, nodes, timers };
}

test('the clicked button gets the check and loses it after 1.2 seconds', () => {
  const p = page();
  const b = p.build('aicopy:t1:0');
  p.mark.done('aicopy:t1:0');
  assert.equal(p.shown(b), true);
  p.advance(1199);
  assert.equal(p.shown(b), true);
  p.advance(2);
  assert.equal(p.shown(b), false);
});

test('the list was redrawn while the write ran: the check goes on the new button, not the vanished one', () => {
  const p = page();
  const old = p.build('aicopy:t1:0');
  p.drop(old);                         // the redraw
  const fresh = p.build('aicopy:t1:0');
  p.mark.done('aicopy:t1:0');          // the write finishes now
  assert.equal(p.shown(fresh), true, 'the user sees the check');
  p.advance(1300);
  assert.equal(p.shown(fresh), false);
});

test('the list is redrawn after the check shows: the new button is born checked and ends on time', () => {
  const p = page();
  const first = p.build('copy:i9');
  p.mark.done('copy:i9');
  p.advance(500);
  p.drop(first);
  const fresh = p.build('copy:i9');
  assert.equal(p.shown(fresh), true, 'a redraw no longer wipes the check');
  p.advance(699);
  assert.equal(p.shown(fresh), true);
  p.advance(2);
  assert.equal(p.shown(fresh), false, 'about 1.2 seconds after the copy, not 1.2 after the redraw');
});

test('a button for another key, or one built after the check ended, is plain', () => {
  const p = page();
  p.build('a'); p.mark.done('a');
  assert.equal(p.shown(p.build('b')), false);
  p.advance(1300);
  assert.equal(p.shown(p.build('a')), false);
  assert.equal(p.mark.marked('a'), false);
});

test('a second copy while the check shows extends it, and the first timer does not cut it short', () => {
  const p = page();
  const b = p.build('k');
  p.mark.done('k');
  p.advance(800);
  p.mark.done('k');
  p.advance(800); // 1600 after the first, 800 after the second
  assert.equal(p.shown(b), true);
  p.advance(500);
  assert.equal(p.shown(b), false);
});

test('every button carrying the key gets it (the same row drawn twice)', () => {
  const p = page();
  const a = p.build('k'), b = p.build('k');
  p.mark.done('k');
  assert.equal(p.shown(a) && p.shown(b), true);
});

test('the pages that matter most draw their copy buttons through it, and index.html loads it first', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['todo-ui.js', 'attention-ui.js', 'task-board-ui.js']) {
    const src = read(f);
    assert.match(src, /CopyMark\.create/, f);
    assert.match(src, /copied\.done\(/, f);
    assert.match(src, /copied\.adopt\(/, f);
    assert.doesNotMatch(src, /checkTimer = setTimeout/, `${f} does not time the check on the clicked node`);
  }
  const html = read('index.html');
  const at = html.indexOf('copy-mark.js');
  assert.ok(at > 0 && at < html.indexOf('attention-ui.js') && at < html.indexOf('todo-ui.js') && at < html.indexOf('task-board-ui.js'));
});

test('one wording for a copy that failed, in every module that writes the clipboard', () => {
  const files = ['attention-ui.js', 'chat-deliverables.js', 'chat-ui.js', 'pages.js', 'release-notes-ui.js', 'renderer.js', 'side-pane.js', 'task-board-ui.js', 'todo-ui.js'];
  let seen = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const m of src.matchAll(/showToast\('(没能复制[^']*)'\)/g)) { seen++; assert.equal(m[1], '没能复制到剪贴板，请再试一次', f); }
  }
  assert.ok(seen >= 8, `found ${seen} failure toasts`);
});
