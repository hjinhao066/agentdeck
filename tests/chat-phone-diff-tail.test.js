// A 队长 reply read from the middle of a file diff (its first row lost its indent to
// extractReply's trim) was cleaned on the desktop, which put that indent back before
// the shared rules ran; the phone ran the shared rules without that step and showed the
// stray diff row. AGENTS.md: one set of rules for both ends, in mobile-web/hub/core.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'chat-core.js'));
const Hub = require(path.join(ROOT, 'mobile-web/hub/core.js'));
const captain = require('./fixtures/captain-chat.js');

test('the phone and the desktop show the same words for a reply that begins inside a diff', () => {
  const t0 = 1_800_000_000_000;
  for (const reply of [captain.TABLE, '上），用户未反对\n    25\n    26 +- 一行改动\n\n收到。']) {
    const turns = [{ id: 'f-table', ts: t0, user: 'UI 那几件怎么样了？交接那边交给 Sonnet 吧。', reply, done: true, atts: [] }];
    const said = turns.map((t) => t.user).join('\n');
    const desktop = C.shownReply(reply, said, Hub.cleanReply, turns[0].user);
    const phone = Hub.groupTurns(turns)[0].reply;
    assert.doesNotMatch(desktop, /用户未反对/, 'the desktop drops the diff tail');
    assert.equal(phone, desktop, 'the phone shows what the desktop shows');
  }
});
