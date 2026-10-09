'use strict';
// A turn's reply is read off the terminal when the turn ends, on the page's
// own thread. Soft-wrapped rows are joined, so a long single-line output (a
// minified JSON from curl in a plain shell, a base64 blob, a long paragraph of
// Chinese with no spaces) arrives as one line of tens of thousands of
// characters. Trailing-space and shell-prompt checks written as backtracking
// regexes took time proportional to the square of that line: 20,000
// characters cost about 1.5 s, 100,000 about half a minute of frozen window.

const test = require('node:test');
const assert = require('node:assert/strict');
const ChatCore = require('../chat-core');
const HubCore = require('../mobile-web/hub/core.js');

const BUDGET_MS = 1000;   // linear code needs a few ms; the old checks needed seconds
function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('a 60,000-character one-line output (minified JSON) is read in linear time', () => {
  const json = '{"items":[' + Array.from({ length: 6000 }, (_, i) => `{"id":${i}}`).join(',') + ']}';
  assert.ok(json.length > 60000);
  const { value, ms } = timed(() => ChatCore.extractReply(['$ curl -s https://example.test/items', json, 'user@host ~ %'], 'curl -s https://example.test/items', 120));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`);
  assert.equal(value, json.slice(0, 20000), 'the reply is the output, cut at the usual 20,000 characters');
});

test('a long paragraph of Chinese without spaces is read in linear time', () => {
  const text = '这是一段没有空格的很长的中文回复'.repeat(3000);
  const { value, ms } = timed(() => ChatCore.extractReply(['⏺ ' + text], 'question', 120));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`);
  assert.equal(value, text.slice(0, 20000));
});

test('a line with a long run of spaces inside it is read in linear time', () => {
  const line = 'left' + ' '.repeat(40000) + 'right';
  const { value, ms } = timed(() => ChatCore.extractReply(['⏺ ' + line], 'question', 120));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`);
  assert.equal(value, line.slice(0, 20000));
  const echo = timed(() => ChatCore.extractReply(['> question' + ' '.repeat(40000) + '│x', '⏺ answer'], 'question', 120));
  assert.ok(echo.ms < BUDGET_MS, `prompt echo took ${echo.ms.toFixed(0)} ms`);
});

test('cleanReply on a long run of spaces is linear and trims exactly as before', () => {
  const text = '\n\nfirst' + ' '.repeat(40000) + 'second  \n \t';
  const { value, ms } = timed(() => HubCore.cleanReply(text, '', ''));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`);
  assert.equal(value, 'first' + ' '.repeat(40000) + 'second');
});

test('the usual short cases are unchanged', () => {
  // A bare shell prompt left on the last row is still not part of the reply.
  assert.equal(ChatCore.extractReply(['$ ls', 'a.txt  b.txt', 'jinhao@mac ~ %'], 'ls', 80), 'a.txt  b.txt');
  // A row that is not shaped like "<host> <%|$|#|>" is output and stays.
  assert.equal(ChatCore.extractReply(['$ ls', 'a.txt', 'PS C:\\Users\\me>'], 'ls', 80), 'a.txt\nPS C:\\Users\\me>');
  // bash prints its prompt straight after output that has no final newline: that row is output too.
  assert.equal(ChatCore.extractReply(['$ cat f', 'contents user@host:~$'], 'cat f', 80), 'contents user@host:~$');
  // Trailing blanks and box edges around an echoed prompt are still ignored.
  assert.equal(ChatCore.extractReply(['│ > hello world   │  ', '⏺ hi there   '], 'hello world', 80), 'hi there');
  assert.equal(HubCore.cleanReply('\n\nanswer\n\n', '', ''), 'answer');
  assert.equal(HubCore.cleanReply('  \n', '', ''), '');
});
