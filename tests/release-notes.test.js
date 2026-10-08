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
  const next = late.upcoming.find((e) => e.version).version;
  late.released.unshift({ ...late.released[0], version: next, date: '2099-01-01' });
  assert.ok(H.releaseProblems(late).some((p) => p.includes(`${next} 已经发布了，从 upcoming 里删掉`)));
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
  assert.ok(H.releaseGap(valid(), '99.1.0').includes(`最新一版是 ${notes.released[0].version}，还没写 99.1 的更新内容`));
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

// 每日进展: the daily-progress tool's JSON, reduced to counts, short lines and each card's words (tests/daily-progress.test.js has the cards).
const sampleDay = (date, done, extra = {}) => ({ date, partial: false, summary: { projects: 2, done, created: 3, sessions: 4, reject: 1, rework: 2, needs_user: 1, deliveries: 1 },
  projects: [{ project: 'small', done: [{ id: 't-1', title: '秘密标题', result: '结果' }], created: [], doing: [], sessions: 1, reject: 0, rework: 0, needs_user: [] },
    { project: 'agentdeck', done: [{}, {}, {}], created: [{}], doing: [], sessions: 3, reject: 1, rework: 2, needs_user: [] }],
  deliveries: [{ time: '22:33', text: 'AgentDeck 1.8 全部交付完成', versions: ['1.8'] }], ...extra });

test('a progress day keeps counts, project names, delivery lines and card words, never card ids', () => {
  const day = H.progressDay(sampleDay('2026-10-07', 4));
  assert.deepEqual(day.summary, { projects: 2, done: 4, created: 3, sessions: 4, reject: 1, rework: 2, needsUser: 1, deliveries: 1 });
  assert.deepEqual(day.projects.map((p) => [p.name, p.done, p.created, p.sessions]), [['agentdeck', 3, 1, 3], ['small', 1, 0, 1]]);
  assert.deepEqual(day.deliveries, ['AgentDeck 1.8 全部交付完成']);
  assert.deepEqual(day.items, [{ project: 'small', title: '秘密标题', result: '结果', state: 'done' }]);
  assert.ok(!JSON.stringify(day).includes('t-1'));
  assert.equal(H.progressDay({ date: '2026-02-30', summary: {} }), null);
  assert.equal(H.progressDay({ date: '2026-10-07' }), null);
  assert.equal(H.progressDay(sampleDay('2026-10-07', -1)).summary.done, 0);
  assert.deepEqual(H.progressDay(day), day);
});

test('progress days are newest first, one per date, two weeks at most; labels say 今天 / 昨天', () => {
  const list = [sampleDay('2026-10-05', 1), sampleDay('2026-10-07', 3), sampleDay('2026-10-07', 9), null, { date: 'x' },
    ...Array.from({ length: 20 }, (_, k) => sampleDay(`2026-09-${String(k + 1).padStart(2, '0')}`, k))];
  const days = H.progressDays(list);
  assert.equal(days.length, 14);
  assert.deepEqual(days.slice(0, 2).map((d) => [d.date, d.summary.done]), [['2026-10-07', 3], ['2026-10-05', 1]]);
  const now = new Date(2026, 9, 8, 13, 0);
  assert.equal(H.progressLabel('2026-10-08', now), '10-08 今天');
  assert.equal(H.progressLabel('2026-10-07', now), '10-07 昨天');
  assert.equal(H.progressLabel('2026-10-05', now), '10-05 周一');
  assert.equal(H.progressLabel('nope', now), '');
});

test('the shared panel script ships to the hub and loads on both pages', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/mobile-release.js'), 'utf8'), /'releases\.js'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'mobile-web/hub/index.html'), 'utf8'), /<script src="releases\.js" defer><\/script>/);
  assert.match(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), /<script src="mobile-web\/hub\/releases\.js"><\/script>/);
  const view = require('../mobile-web/hub/releases.js');
  assert.equal(typeof view.render, 'function');
  assert.match(view.PROGRESS_EMPTY.old[0], /旧版/);
});
