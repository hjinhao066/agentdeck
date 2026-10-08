'use strict';
// 版本更新: release-notes.json and the rules that read it (mobile-web/hub/core.js).
// The first two tests are the release reminder: a version bump without its notes fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../mobile-web/hub/core.js');

const ROOT = path.join(__dirname, '..');
const notes = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-notes.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const valid = () => JSON.parse(JSON.stringify(notes));

test('release-notes.json follows every rule', () => {
  assert.deepEqual(H.releaseProblems(notes), []);
});

test('the newest release in release-notes.json is the version in package.json', () => {
  assert.ok(H.sameVersion(notes.released[0].version, pkg.version),
    `package.json 是 ${pkg.version}，release-notes.json 最新一版是 ${notes.released[0].version}：发版时在 released 最前面写上这一版`);
  assert.equal(H.releaseGap(notes, pkg.version), '');
});

test('the data file ships with the desktop app and the phone hub', () => {
  assert.ok(pkg.build.files.includes('release-notes.json'));
  assert.ok(pkg.build.files.includes('release-notes-ui.js'));
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/mobile-release.js'), 'utf8'), /'release-notes\.json'\]/);
  assert.match(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), /<script src="release-notes-ui\.js"><\/script>/);
  const hub = fs.readFileSync(path.join(ROOT, 'mobile-web/hub/index.html'), 'utf8');
  assert.match(hub, /id="releases-view"/);
  assert.match(hub, /id="releases-entry"/);
});

test('versions compare by number; 1.9 is 1.9.0 and a patch keeps its third number', () => {
  assert.ok(H.sameVersion('1.9', '1.9.0'));
  assert.ok(!H.sameVersion('1.9', '1.9.1'));
  assert.ok(H.compareVersions('1.10', '1.9.9') > 0);
  assert.equal(H.versionLabel('2.0.0'), '2.0');
  assert.equal(H.versionLabel('1.2.4'), '1.2.4');
  assert.equal(H.versionLabel('v1'), '');
  assert.equal(H.shortDate('2026-10-08'), '10-08');
  assert.equal(H.shortDate('2026-02-30'), '');
});

test('problems name what a release editor got wrong', () => {
  const late = valid();
  late.released.unshift({ ...late.released[0], version: '2.0', date: '2026-10-09' });
  assert.ok(H.releaseProblems(late).some((p) => /2\.0 已经发布了，从 upcoming 里删掉/.test(p)));
  const order = valid();
  [order.released[0], order.released[1]] = [order.released[1], order.released[0]];
  assert.ok(H.releaseProblems(order).some((p) => /从新到旧/.test(p)));
  const thin = valid();
  thin.released[0].items = ['只有一条'];
  assert.ok(H.releaseProblems(thin).some((p) => /要写 3–6 条/.test(p)));
  const decided = valid();
  decided.upcoming[0].items[0].state = 'decided';
  assert.ok(H.releaseProblems(decided).some((p) => /pending/.test(p)));
  const long = valid();
  long.released[0].items[0] = '字'.repeat(61);
  assert.ok(H.releaseProblems(long).some((p) => /最多 60 字/.test(p)));
  assert.match(H.releaseGap(valid(), '2.0.0'), /最新一版是 1\.9，还没写 2\.0 的更新内容/);
  assert.match(H.releaseGap(thin, pkg.version), /release-notes\.json 有问题/);
});

test('the page keeps well-formed entries and drops the rest instead of breaking', () => {
  const damaged = valid();
  damaged.released.push({ version: 'x', date: 'soon', title: '', items: [] });
  damaged.upcoming[0].items.push({ text: '<b>坏</b>', state: 'unknown' }, { text: 'a\u0007b', state: 'doing' });
  const clean = H.releaseNotes(damaged);
  assert.equal(clean.released.length, notes.released.length);
  assert.equal(clean.upcoming[0].items.length, notes.upcoming[0].items.length);
  assert.equal(H.releaseNotes(null), null);
  assert.equal(H.releaseNotes({ schema: 2, released: notes.released }), null);
  assert.equal(H.releaseNotes({ schema: 1, released: 'nope', upcoming: {} }), null);
});

test('copy text and the 待你定 count', () => {
  const clean = H.releaseNotes(notes);
  const released = H.releaseText(clean.released[0]).split('\n');
  assert.equal(released[0], `AgentDeck ${notes.released[0].version}（${notes.released[0].date}）${notes.released[0].title}`);
  assert.equal(released.length, notes.released[0].items.length + 1);
  const plan = H.releaseText({ version: '2.0', status: 'doing', title: 'T', note: 'N', items: [{ text: 'A', state: 'pending', suggestion: '建议做' }, { text: 'B', state: 'done', suggestion: '' }] });
  assert.equal(plan, 'AgentDeck 2.0（正在做）T\nN\n- [待你定] A（建议做）\n- [做完了] B');
  const pending = notes.upcoming.flatMap((e) => e.items).filter((i) => i.state === 'pending').length;
  assert.ok(pending > 0);
  assert.equal(H.pendingCount(clean), pending);
  assert.equal(H.pendingCount(null), 0);
});
