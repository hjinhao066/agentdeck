'use strict';
// Bug hunt ④ #19 (2.0.4 features, 对话文件 / 99+ 小标): since 2b7ac1b the number on 队长's 交付文件 button counts
// "the files that came in since the panel was last open" (README): items whose ts is newer than
// index.seen, and opening the panel sets seen to the newest ts it holds. A file 队长 names in a reply
// is dated by its turn's ts, which is when the turn was *sent*, not when the reply (and the file) came
// in. 队长's turns run for minutes while receipts (dated when they arrive) keep coming in, so: the user
// opens the panel during a long turn (seen = the newest receipt), closes it, and the turn then ends
// naming a new report. That report came in after the panel was last open, yet it is older than seen:
// the button shows nothing, and the panel's day grouping files it under the hour the user asked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../deliverables-core.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const findLinks = new Function('env', source.slice(source.indexOf('function trimTrail('), source.indexOf('function openLink(')) + '\nreturn findLinks;')({ platform: 'darwin' });
const rules = D.normalizeRules({});
const MIN = 60_000, T0 = Date.UTC(2026, 9, 9, 2, 0);

// what chat-deliverables.js collect() folds in, and sync() does while the panel is open
const collect = (index, turns, receipts) => D.mergeIndex(index, [
  ...D.fromReplies(turns, { findLinks, rules, colId: 'cap', chatId: 'cap' }),
  ...D.fromReceipts(receipts, rules),
], { home: '/Users/me', projects: [] });

test('a file named at the end of a long 队长 turn counts as new when the panel was opened during the turn', () => {
  // T0: the user asks 队长 something; the turn is still open
  const turn = { id: 'u1', ts: T0, user: '整理一下报告', reply: '', done: false };
  // T0+5: a worker's receipt comes in; the user opens the panel and sees it
  const receipts = [{ colId: 'w1', ts: T0 + 5 * MIN, files: ['/Users/me/reports/worker.md'] }];
  let index = collect(D.normalizeIndex(null, rules), [turn], receipts);
  index = D.markSeen(index);
  assert.equal(D.unseenCount(index), 0);
  // the panel is closed again; T0+12: 队长's reply ends, naming a new report
  const finished = { ...turn, reply: '写好了：/Users/me/reports/summary.md', done: true, end: T0 + 12 * MIN };
  index = collect(index, [finished], receipts);
  assert.ok(index.items.some((i) => i.path === '/Users/me/reports/summary.md'), 'the report is in the panel');
  assert.equal(D.unseenCount(index), 1, 'and the button counts it: it came in after the panel was last open');
});

test('control: a receipt that arrives after the panel was open is counted', () => {
  const receipts = [{ colId: 'w1', ts: T0 + 5 * MIN, files: ['/Users/me/reports/worker.md'] }];
  let index = D.markSeen(collect(D.normalizeIndex(null, rules), [], receipts));
  index = collect(index, [], [...receipts, { colId: 'w2', ts: T0 + 9 * MIN, files: ['/Users/me/reports/second.md'] }]);
  assert.equal(D.unseenCount(index), 1);
});

test('the same file named mid-turn and read again when the turn ends counts as new; its row keeps the turn\'s time', () => {
  // the reply already named the file while the turn ran (saved as it was read), then the turn ended
  const running = { id: 'u2', ts: T0, user: '再整理一份', reply: '在写 /Users/me/reports/draft.md', done: false };
  const receipts = [{ colId: 'w1', ts: T0 + 5 * MIN, files: ['/Users/me/reports/worker.md'] }];
  let index = D.markSeen(collect(D.normalizeIndex(null, rules), [running], receipts));
  assert.equal(D.unseenCount(index), 0);
  index = collect(index, [{ ...running, done: true, end: T0 + 12 * MIN, reply: '写好了：/Users/me/reports/draft.md' }], receipts);
  assert.equal(D.unseenCount(index), 1);
  // the row's time is still when the turn was asked (the panel shows and sorts by it)
  assert.equal(index.items.find((i) => i.path === '/Users/me/reports/draft.md').ts, T0);
  // kept across a save
  assert.equal(D.unseenCount(D.normalizeIndex(JSON.parse(JSON.stringify(index)), rules)), 1);
});
