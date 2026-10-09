const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../chat-core');
const D = require('../deliverables-core');

const rules = D.normalizeRules();
// The renderer's link finder, reduced to what these replies hold: absolute paths and URLs.
const findLinks = (line) => [...line.matchAll(/https?:\/\/\S+|(?:~\/|\/)[^\s，。]+/g)].map((m) => ({ kind: /^https?:/.test(m[0]) ? 'url' : 'file', text: m[0] }));
const HOME = '/Users/me';

test('result files pass, process files and anything under a skipped folder do not', () => {
  for (const p of ['/Users/me/reports/q3/summary.md', '/Users/me/reports/q3/summary.PDF', '/Users/me/docs/plan.docx', '/Users/me/docs/deck.pptx',
    '/Users/me/docs/budget.xlsx', '/Users/me/site/report.html', '/Users/me/shots/home-dark.png', '/Users/me/shots/a.jpeg',
    '/Users/me/video/demo.mp4', '/Users/me/video/demo.mov', '~/reports/notes.md', 'C:\\Users\\me\\reports\\weekly.md', '/Users/me/reports/a.md:12']) {
    assert.equal(D.isDeliverable(p, rules), true, p);
  }
  for (const p of ['/Users/me/proj/build.py', '/Users/me/proj/src/app.js', '/Users/me/proj/data/config.json', '/Users/me/proj/export/orders.csv',
    '/Users/me/proj/logs/run.log', '/Users/me/proj/db/cache.sqlite', '/Users/me/proj/run.sh', '/Users/me/proj/notes.txt', '/Users/me/proj/Makefile',
    // a result type in a process folder
    '/Users/me/proj/node_modules/pkg/README.md', '/Users/me/proj/.git/description.md', '/private/tmp/claude-501/x/scratchpad/notes.md',
    '/tmp/draft.md', '/private/var/folders/ab/xyz/T/shot.png', 'C:\\Users\\me\\AppData\\Local\\Temp\\report.md', '/Users/me/proj/.cache/thumb.png',
    '/Users/me/proj/__pycache__/x.md', '/Users/me/proj/test-results/run-1/shot.png', '/Users/me/Library/Caches/x/a.pdf',
    // not a file at all
    '/Users/me/reports/', 'report.md']) {
    assert.equal(D.isDeliverable(p, rules), false, p);
  }
  // folder names are whole names: "tmpl" and "templates" are not "tmp" / "temp"
  assert.equal(D.isDeliverable('/Users/me/tmpl/a.md', rules), true);
  assert.equal(D.isDeliverable('/Users/me/templates/a.md', rules), true);
  // "var/folders" is a run of two names, not each name alone
  assert.equal(D.isDeliverable('/Users/me/var/notes/a.md', rules), true);
});

test('a file a receipt hands in counts whatever its type, unless it is a process type or in a skipped folder', () => {
  const receipts = [{ colId: 'w', session: '报表导出', project: '报表服务', ts: 5,
    files: ['/Users/me/out/final-export.csv', '/Users/me/out/final-report.txt', '/Users/me/out/final-report.pdf', '/Users/me/out/screens/',
      '/Users/me/out/build.py', '/Users/me/out/run.log', '/Users/me/out/data.json', '/Users/me/out/cache.sqlite',
      '/Users/me/proj/node_modules/x/README.md', '/tmp/draft.csv'] }];
  assert.deepEqual(D.fromReceipts(receipts, rules).map((f) => f.path),
    ['/Users/me/out/final-export.csv', '/Users/me/out/final-report.txt', '/Users/me/out/final-report.pdf', '/Users/me/out/screens/']);
  // the same csv only mentioned by 队长 is not a result
  assert.equal(D.isDeliverable('/Users/me/out/final-export.csv', rules), false);
  assert.equal(D.isDeliverable('/Users/me/out/final-export.csv', rules, true), true);
  // a saved receipt item keeps its place when the index is loaded again
  const index = D.mergeIndex(D.normalizeIndex(null, rules), D.fromReceipts(receipts, rules));
  assert.equal(D.normalizeIndex(JSON.parse(JSON.stringify(index)), rules).items.length, 4);
  // the process list is the user's too
  const mine = D.normalizeRules({ process: ['csv'] });
  assert.deepEqual(D.fromReceipts(receipts, mine).map((f) => f.path).sort(),
    ['/Users/me/out/build.py', '/Users/me/out/cache.sqlite', '/Users/me/out/data.json', '/Users/me/out/final-report.pdf', '/Users/me/out/final-report.txt', '/Users/me/out/run.log', '/Users/me/out/screens/']);
});

test('the lists are the user\'s to change; an untouched list keeps the defaults', () => {
  assert.deepEqual(D.parseList('md, .PDF  *.docx，key；md'), ['md', 'pdf', 'docx', 'key']);
  assert.deepEqual(D.parseList('/node_modules/ build\\out  var/folders', true), ['node_modules', 'build/out', 'var/folders']);
  assert.deepEqual(D.normalizeRules(undefined), { types: [...D.DEFAULT_RULES.types], skip: [...D.DEFAULT_RULES.skip], process: [...D.DEFAULT_RULES.process] });
  assert.equal(D.isDefault(D.normalizeRules({})), true);
  const mine = D.normalizeRules({ types: ['md', 'CSV'], skip: ['drafts'] });
  assert.deepEqual(mine, { types: ['md', 'csv'], skip: ['drafts'], process: [...D.DEFAULT_RULES.process] });
  assert.equal(D.isDefault(mine), false);
  assert.equal(D.isDeliverable('/Users/me/export/orders.csv', mine), true);
  assert.equal(D.isDeliverable('/Users/me/export/deck.pdf', mine), false);
  assert.equal(D.isDeliverable('/Users/me/drafts/plan.md', mine), false);
  assert.equal(D.isDeliverable('/Users/me/proj/node_modules/x/README.md', mine), true);
  // one list may be emptied on purpose: nothing passes
  assert.equal(D.isDeliverable('/Users/me/a.md', D.normalizeRules({ types: [] })), false);
});

test('replies give the files 队长 mentioned; receipts give the files the crew handed in', () => {
  const turns = [
    { id: 't1', ts: 100, user: '周报呢', reply: '周报在 /Users/me/reports/weekly.md，脚本是 /Users/me/proj/build.py\n截图 /Users/me/shots/home.png 和 https://example.com/x.pdf' },
    { id: 't2', ts: 200, kind: 'task', user: '派活', reply: '/Users/me/reports/should-not-count.md', task: {} },
    { id: 't3', ts: 300, user: '只说话', reply: '' },
  ];
  const found = D.fromReplies(turns, { findLinks, rules, colId: 'cap', chatId: 'cap' });
  assert.deepEqual(found.map((f) => [f.path, f.ts, f.from, f.turnId]), [
    ['/Users/me/reports/weekly.md', 100, 'reply', 't1'], ['/Users/me/shots/home.png', 100, 'reply', 't1']]);
  // what the chat view shows, not the raw screen text
  const shown = D.fromReplies(turns.slice(0, 1), { findLinks, rules, text: () => '只剩 /Users/me/reports/clean.md' });
  assert.deepEqual(shown.map((f) => f.path), ['/Users/me/reports/clean.md']);
  const receipts = C.deliveryReceipts({
    sessions: [{ id: 'w1', title: '报表导出', project: '报表服务', lastReceipt: { ts: 500, summary: '导好了', files: ['/Users/me/export/q3.pdf', '/Users/me/export/orders.csv', '/Users/me/export/export.log', 'relative.md'] } }],
  });
  // handed in on purpose: the csv counts, the log does not, a relative name is no path
  assert.deepEqual(D.fromReceipts(receipts, rules).map((f) => [f.path, f.from, f.session, f.project, f.ts]),
    [['/Users/me/export/q3.pdf', 'receipt', '报表导出', '报表服务', 500], ['/Users/me/export/orders.csv', 'receipt', '报表导出', '报表服务', 500]]);
});

test('one item per path: the latest mention wins, a receipt wins a tie and lends its project', () => {
  let index = D.normalizeIndex(undefined, rules);
  index = D.mergeIndex(index, [
    { path: '/Users/me/reports/a.md', ts: 100, from: 'reply', turnId: 'r1' },
    { path: '/Users/me/reports/a.md', ts: 300, from: 'receipt', session: '写报告', project: '客户门户', task: '写周报' },
    { path: '/Users/me/reports/b.md', ts: 200, from: 'reply' },
    { path: '/Users/me/reports/b.md', ts: 200, from: 'receipt', session: 'B', project: '报表服务' },
    { path: '~/reports/c.md', ts: 50, from: 'receipt', project: '客户门户' },
    { path: 'C:\\Users\\me\\Reports\\W.md', ts: 10, from: 'reply' },
    { path: 'c:/users/me/reports/w.md', ts: 20, from: 'reply' },
  ], { home: HOME });
  assert.deepEqual(index.items.map((i) => [i.path, i.ts, i.from, i.project]), [
    ['/Users/me/reports/a.md', 300, 'receipt', '客户门户'],
    ['/Users/me/reports/b.md', 200, 'receipt', '报表服务'],
    ['~/reports/c.md', 50, 'receipt', '客户门户'],
    ['c:/users/me/reports/w.md', 20, 'reply', ''],
  ]);
  // a later mention by 队长 replaces the receipt, keeps its project
  index = D.mergeIndex(index, [{ path: '/Users/me/reports/c.md', ts: 900, from: 'reply', turnId: 'r9' }], { home: HOME });
  assert.deepEqual(index.items.map((i) => [i.path, i.ts, i.from, i.project]).slice(0, 1), [['/Users/me/reports/c.md', 900, 'reply', '客户门户']]);
  assert.equal(index.items.length, 4);
  // an older mention changes nothing
  const again = D.mergeIndex(index, [{ path: '/Users/me/reports/a.md', ts: 1, from: 'reply' }], { home: HOME });
  assert.deepEqual(again.items, index.items);
});

test('a file 队长 mentioned takes the project whose name is one of its folders', () => {
  const projects = ['agentdeck', '客户门户', 'Hermes'];
  assert.equal(D.guessProject('/Users/me/reports/agentdeck-chat-deliverables/after.png', projects), 'agentdeck');
  assert.equal(D.guessProject('/Users/me/客户门户/周报.md', projects), '客户门户');
  assert.equal(D.guessProject('/Users/me/HERMES/site/index.html', projects), 'Hermes');
  assert.equal(D.guessProject('/Users/me/agentdecks/x.md', projects), '');
  assert.equal(D.guessProject('/Users/me/reports/x.md', projects), '');
  // the file's own name is not a folder
  assert.equal(D.guessProject('/Users/me/reports/agentdeck.md', projects), '');
  const index = D.mergeIndex(D.normalizeIndex(null, rules), [{ path: '/Users/me/reports/agentdeck-ui/a.png', ts: 1, from: 'reply' }], { projects });
  assert.equal(index.items[0].project, 'agentdeck');
});

test('a path that runs on into the sentence is cut where the file ends', () => {
  assert.equal(D.trimProse('/Users/me/客户门户/上线清单.md 里最后三项要你确认', rules), '/Users/me/客户门户/上线清单.md');
  assert.equal(D.trimProse('/Users/me/My Project/plan.md', rules), '/Users/me/My Project/plan.md');
  assert.equal(D.trimProse('/Users/me/My Project/plan.md 和 notes.md 都改了', rules), '/Users/me/My Project/plan.md');
  assert.equal(D.trimProse('/Users/me/proj/build.py 跑过了', rules), '');
  const turns = [{ id: 't', ts: 1, reply: 'x' }];
  const found = D.fromReplies(turns, { rules, findLinks: () => [{ kind: 'file', text: '/Users/me/a/接口变更.md 已经同步' }] });
  assert.deepEqual(found.map((f) => f.path), ['/Users/me/a/接口变更.md']);
});

test('the index keeps history: it survives a save, remembers which old conversations it read, and is capped', () => {
  let index = D.normalizeIndex(undefined, rules);
  index = D.mergeIndex(index, [{ path: '/Users/me/reports/old.md', ts: 5, from: 'reply', chatId: 'captain-x', old: true, turnId: 'o1' }]);
  index.scanned.push('captain-x');
  const saved = JSON.parse(JSON.stringify(index));
  const back = D.normalizeIndex(saved, rules);
  assert.deepEqual(back.scanned, ['captain-x']);
  assert.deepEqual(back.items, index.items);
  assert.equal(back.items[0].old, true);
  // junk in a hand-edited config is dropped, not trusted
  const junk = D.normalizeIndex({ rules: back.rules, scanned: ['ok', 5, 'x'.repeat(400)], items: [null, { path: 1 }, { key: 'k', path: '/Users/me/a.md', ts: 'soon', from: 'evil', project: 'p'.repeat(500) }] }, rules);
  assert.deepEqual(junk.scanned, ['ok']);
  assert.equal(junk.items.length, 1);
  assert.equal(junk.items[0].ts, 0);
  assert.equal(junk.items[0].from, 'reply');
  assert.ok(junk.items[0].project.length <= 120);
  // changed rules: items the new rules leave out go, and every conversation is read again
  const narrow = D.normalizeRules({ types: ['pdf'] });
  const after = D.normalizeIndex(saved, narrow);
  assert.deepEqual(after.items, []);
  assert.deepEqual(after.scanned, []);
});

test('nothing is dropped for room: thousands of files, the oldest from a conversation read once, all stay', () => {
  // an old conversation from before a clear mentions 1501 files; it is read once and marked read
  const many = Array.from({ length: 1501 }, (_, i) => ({ path: `/Users/me/r/${i}.md`, ts: i + 1, from: 'reply', chatId: 'captain-old', old: true }));
  let index = D.mergeIndex(D.normalizeIndex(null, rules), many);
  index.scanned.push('captain-old');
  // saved, loaded, and grown by later receipts and replies
  for (let round = 0; round < 3; round++) {
    index = D.normalizeIndex(JSON.parse(JSON.stringify(index)), rules);
    index = D.mergeIndex(index, Array.from({ length: 400 }, (_, i) => ({ path: `/Users/me/new/${round}-${i}.pdf`, ts: 10_000 + round * 1000 + i, from: 'receipt' })));
  }
  index = D.normalizeIndex(JSON.parse(JSON.stringify(index)), rules);
  assert.equal(index.items.length, 1501 + 1200);
  assert.deepEqual(index.scanned, ['captain-old']);
  // the very first file of the old conversation is still there, last in line
  assert.equal(index.items.at(-1).path, '/Users/me/r/0.md');
  assert.equal(index.items.at(-1).old, true);
});

test('grouped by day, newest first: 今天, 昨天, then the date', () => {
  const now = new Date(2026, 9, 8, 15, 0).getTime();
  const at = (d, h) => new Date(2026, 9, d, h, 0).getTime();
  const items = [{ ts: at(8, 14) }, { ts: at(8, 9) }, { ts: at(7, 23) }, { ts: at(6, 10) }, { ts: new Date(2025, 11, 31, 9).getTime() }, { ts: 0 }];
  const groups = D.byDay(items, now);
  assert.deepEqual(groups.map((g) => [g.label, g.items.length]), [['今天', 2], ['昨天', 1], ['10月6日 周二', 1], ['2025年12月31日 周三', 1], ['时间未知', 1]]);
});
