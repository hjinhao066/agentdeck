'use strict';
// 回执卡「代码文件」(bug hunt ④): a receipt card lists its results first and folds code behind 另有 N 个代码文件, by the
// 交付文件 panel's 从不算交付 types. Go, Rust, Java, C, Swift, SQL and patch files were listed as results. They fold now;
// .csv and .txt stay results. The 交付文件 panel goes by the same list, so they are no longer deliverables there either.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../deliverables-core');

const CODE = ['go', 'rs', 'java', 'c', 'swift', 'sql', 'patch'];

test('a receipt\'s Go, Rust, Java, C, Swift, SQL and patch files fold under 代码文件; .csv, .txt and the report stay results', () => {
  const files = ['/Users/me/proj/a.go', '/Users/me/proj/b.rs', '/Users/me/proj/C.java', '/Users/me/proj/d.c', '/Users/me/proj/e.swift',
    '/Users/me/proj/f.sql', '/Users/me/proj/g.patch', '/Users/me/out/data.csv', '/Users/me/out/notes.txt', '/Users/me/out/report.md'];
  const { results, code } = D.splitReceiptFiles(files, D.normalizeRules());
  assert.deepEqual(code, files.slice(0, 7));
  assert.deepEqual(results, ['/Users/me/out/data.csv', '/Users/me/out/notes.txt', '/Users/me/out/report.md']);
  // a Windows path and an upper-case extension are the same type
  assert.deepEqual(D.splitReceiptFiles(['C:\\Users\\me\\proj\\Main.GO', 'C:\\Users\\me\\proj\\Fix.PATCH'], D.normalizeRules()).results, []);
});

test('the seven are 从不算交付 by default: the 交付文件 panel leaves them out too; .csv and .txt a receipt hands in still count', () => {
  const rules = D.normalizeRules();
  for (const ext of CODE) {
    assert.ok(D.DEFAULT_RULES.process.includes(ext), ext);
    assert.equal(D.isDeliverable('/Users/me/proj/x.' + ext, rules, true), false, ext);
  }
  for (const ext of ['csv', 'txt']) {
    assert.ok(!D.DEFAULT_RULES.process.includes(ext), ext);
    assert.equal(D.isDeliverable('/Users/me/out/x.' + ext, rules, true), true, ext);
  }
  // left untouched in the form and saved, the new list is the default: nothing is written to config
  assert.equal(D.isDefault(D.normalizeRules({ types: [...D.DEFAULT_RULES.types], skip: [...D.DEFAULT_RULES.skip], process: [...D.DEFAULT_RULES.process] })), true);
});

test('the new default reads the conversations again once and drops the code files it had listed; a list the user saved is kept as it is', () => {
  const rules = D.normalizeRules();
  // an index found under the list before (the same list without the seven)
  const before = { ...rules, process: rules.process.filter((e) => !CODE.includes(e)) };
  const item = (name) => ({ key: '/out/' + name, path: '/Users/me/out/' + name, ts: 1, from: 'receipt' });
  const saved = { v: 1, rules: D.rulesKey(before), scanned: ['chat-1'], items: [item('a.go'), item('f.sql'), item('data.csv'), item('report.md')] };
  const index = D.normalizeIndex(saved, rules);
  assert.notEqual(index.rules, saved.rules, 'a new rules key');
  assert.deepEqual(index.scanned, [], 'every conversation is read again');
  assert.deepEqual(index.items.map((i) => i.path), ['/Users/me/out/data.csv', '/Users/me/out/report.md']);
  // the user's own 从不算交付 list (deliverableRules) is theirs: the seven are not added to it
  const mine = D.normalizeRules({ process: ['py', 'js'] });
  assert.deepEqual(mine.process, ['py', 'js']);
  assert.deepEqual(D.splitReceiptFiles(['/a/b.go', '/a/c.js'], mine), { results: ['/a/b.go'], code: ['/a/c.js'] });
});
