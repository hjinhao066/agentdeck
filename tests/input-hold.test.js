const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../chat-core');

// While AgentDeck types a receipt or a task into a terminal, what the user does
// there waits until its Enter is out. Only input that can put text in the box or
// act on it waits; the wheel, pointer moves, focus and the terminal's own answers
// go through, or a full-screen agent (Claude Code 2.1 takes the mouse) cannot be
// scrolled for the whole delivery (up to 3 s, measured 1.9 s median).
test('wheel, pointer moves, focus and terminal replies are not held during an automatic send', () => {
  for (const d of [
    '\x1b[<64;20;10M', '\x1b[<65;20;10M',          // wheel up / down (SGR)
    '\x1b[<66;3;4M', '\x1b[<67;3;4M',              // wheel left / right
    '\x1b[<68;20;10M', '\x1b[<80;20;10M',          // wheel with shift / ctrl held
    '\x1b[<35;12;7M', '\x1b[<43;12;7M',            // pointer moved, no button (any-event tracking ?1003)
    '\x1b[<64;20;10M\x1b[<64;20;11M',              // two reports in one chunk
    '\x1b[I', '\x1b[O',                            // focus in / out (?1004)
    '\x1b[?12;40R', '\x1b[12;40R', '\x1b[?12;40;1R', // cursor position replies (CPR / DECXCPR)
    '\x1b[?1;2c', '\x1b[>0;276;0c',                // device attributes replies
    '\x1b[?2026;2$y',                              // mode report reply
    '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\', '\x1b]10;rgb:d4d4/d4d4/d4d4\x07', // colour replies
    '\x1bP>|xterm.js(5.5.0)\x1b\\', '\x1bP1$r0m\x1b\\',                   // XTVERSION / DECRQSS replies
  ]) assert.equal(C.passesInputHold(d), true, JSON.stringify(d));
});

test('keys, pastes, clicks and drags still wait for the automatic Enter', () => {
  for (const d of [
    'a', 'hello', '中文', '\r', '\x7f', '\x03', '\t', ' ',
    '\x1b', '\x1bb', '\x1b[A', '\x1b[B', '\x1bOA', '\x1b[1;5C', '\x1b[3~', '\x1b[Z', '\x1b[15~',
    '\x1b[200~pasted\x1b[201~',
    '\x1b[<0;20;10M', '\x1b[<0;20;10m', '\x1b[<2;5;5M',   // clicks: press / release
    '\x1b[<32;21;10M',                                    // drag with the left button held
    '\x1b[32;20;10M',                                     // urxvt left press
    '\x1b[<64;20;10Mx',                                   // a key glued to a report still waits
    '\x1b[?12;40Rhello',
    '',
  ]) assert.equal(C.passesInputHold(d), false, JSON.stringify(d));
});
