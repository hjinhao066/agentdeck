'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../schedule-feed-core');
const { createScheduleFeeds, pullScript, parsePull } = require('../schedule-feed');

// Everything runs on copies of tests/fixtures/schedule-feed in a temp folder:
// no real task folder, mirror or decisions file is ever read or written.
const FIXTURE = path.join(__dirname, 'fixtures', 'schedule-feed');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const json = (...p) => JSON.parse(read(...p));

function copyStore(to, dates) {
  fs.mkdirSync(path.join(to, 'reports'), { recursive: true });
  for (const name of fs.readdirSync(path.join(FIXTURE, 'reports'))) {
    if (!dates || dates.includes(name.slice(0, 10))) fs.copyFileSync(path.join(FIXTURE, 'reports', name), path.join(to, 'reports', name));
  }
  fs.copyFileSync(path.join(FIXTURE, 'decisions.json'), path.join(to, 'decisions.json'));
}
// Every file under a folder with its content: proof that nothing was touched.
function snapshot(dir) {
  const out = {};
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
  });
  walk(dir);
  return out;
}
function world(t, feed = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-feed-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const w = {
    tmp, root: path.join(tmp, 'root'), mirror: path.join(tmp, 'mirror'), flag: path.join(tmp, 'unreachable'),
    dir: path.join(tmp, 'home', '.agents', 'schedules'), userData: path.join(tmp, 'userdata'), clock: Date.parse('2026-10-05T18:00:00-07:00'),
  };
  copyStore(w.root);
  fs.copyFileSync(path.join(FIXTURE, 'jobs.json'), path.join(tmp, 'jobs.json'));
  fs.mkdirSync(w.dir, { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'radar.json'), JSON.stringify({
    id: 'radar', name: '竞品与灵感雷达', label: '雷达', about: '每天找类似的项目，出一份日报。', runner: 'Windows 上的 Hermes',
    when: { time: '20:30', timeZone: 'America/Los_Angeles' },
    source: { root: w.root }, job: { file: path.join(tmp, 'jobs.json'), id: 'radar01' },
    decide: [process.execPath, path.join(FIXTURE, 'decide.js'), w.root, w.flag, '--id', '{id}', '--decision', '{decision}', '--reason', '{reason}'],
    ...feed,
  }));
  w.open = (extra = {}) => {
    const feeds = createScheduleFeeds({ dir: w.dir, home: path.join(tmp, 'home'), userData: w.userData, now: () => w.clock, ...extra });
    t.after(() => feeds.dispose());
    return feeds;
  };
  w.journal = () => json(w.userData, 'schedule-feeds', 'radar', 'journal.json');
  return w;
}

// ---- reading a report ----
test('a report is cut into its lead, its suggestions and the rest', () => {
  const r = Core.parseReport(read(FIXTURE, 'reports', '2026-10-05.md'), json(FIXTURE, 'reports', '2026-10-05.json'));
  assert.equal(r.title, '竞品与灵感雷达 · 2026-10-05');
  assert.match(r.lead, /^今天新发现 \*\*5 个\*\*/);
  assert.match(r.lead, /建议补三处/);
  assert.doesNotMatch(r.lead, /deckhand/);                      // the long list is not part of the lead
  assert.match(r.detail, /^- \[deckhand\]\(https:\/\/example\.invalid\/acme\/deckhand\)/);
  assert.equal(r.itemsHeading, '建议做的 3 条');
  assert.deepEqual(r.items.map((it) => it.id), ['ADR-0002', 'ADR-0003', 'ADR-0004']);
  const first = r.items[0];
  assert.equal(first.title, '任务卡给出完成证据，并把审过、已合入、已交付分开');
  assert.deepEqual(first.source, { name: 'deckhand', url: 'https://example.invalid/acme/deckhand' });
  assert.match(first.change, /^在任务卡片详情里汇总/);
  assert.match(first.benefit, /不用翻队员的长对话/);
  assert.equal(first.effort, '中（约 3–5 个开发日）。');
  assert.equal(first.stance, '建议做');
  // the list of projects passed over stays Markdown, links and all, and the suggestions are not repeated in it
  assert.match(r.rest, /^## 看过但不建议/);
  assert.match(r.rest, /\| \[tasktrail\]\(https:\/\/example\.invalid\/acme\/tasktrail\) \|/);
  assert.match(r.rest, /今天实际搜索覆盖/);
  assert.doesNotMatch(r.rest, /ADR-0002/);
});

test('a report without a structured twin still yields its suggestions', () => {
  const r = Core.parseReport(read(FIXTURE, 'reports', '2026-10-04.md'), null);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 'ADR-0001');
  assert.equal(r.items[0].title, '侧边栏给每个会话显示最近一次输出的时间');
  assert.deepEqual(r.items[0].source, { name: 'paneforge', url: 'https://example.invalid/acme/paneforge' });
  assert.equal(r.items[0].change, '');
  assert.match(r.items[0].body, /^借鉴 \[paneforge\]/);
  assert.match(r.items[0].body, /队长建议：\*\*建议做\*\*/);
});

test('a plain report has no suggestions and loses nothing', () => {
  const r = Core.parseReport('# 备份日报\r\n\r\n昨晚备份了 3 个仓库。\r\n\r\n## 明细\r\n\r\n- a\r\n- b\r\n', null);
  assert.deepEqual(r.items, []);
  assert.equal(r.title, '备份日报');
  assert.equal(r.lead, '昨晚备份了 3 个仓库。');
  assert.equal(r.rest, '## 明细\n\n- a\n- b');
  assert.deepEqual(Core.parseReport('', null), { title: '', lead: '', itemsHeading: '', items: [], rest: '', detail: '' });
});

// ---- a task's description ----
test('one description serves both machines, and unsafe ones are refused', () => {
  const raw = {
    id: 'radar', name: '雷达', when: { time: '8:05', timeZone: 'America/Los_Angeles' },
    job: { file: 'D:/hermes/cron/jobs.json', id: 'ac151589d15b' },
    platforms: {
      darwin: { source: { ssh: 'winpc', root: 'D:/state/radar' }, mirror: '~/radar-mirror', decide: ['python3', '~/radar-mirror/scripts/record_decision.py', '--id', '{id}'] },
      win32: { source: { root: 'D:/state/radar' } },
    },
  };
  const mac = Core.normalizeFeed(raw, 'darwin', '/Users/me');
  assert.deepEqual(mac.source, { root: 'D:/state/radar', ssh: 'winpc' });
  assert.equal(mac.mirror, '/Users/me/radar-mirror');
  assert.deepEqual(mac.decide, ['python3', '/Users/me/radar-mirror/scripts/record_decision.py', '--id', '{id}']);
  assert.deepEqual(mac.when, { time: '08:05', timeZone: 'America/Los_Angeles' });
  assert.equal(mac.label, '雷达');
  const win = Core.normalizeFeed(raw, 'win32', 'C:\\Users\\me');
  assert.deepEqual(win.source, { root: 'D:/state/radar', ssh: '' });
  assert.equal(win.decide, null);
  assert.equal(win.mirror, '');

  assert.equal(Core.normalizeFeed({ ...raw, id: '../x' }, 'darwin', '/h'), null);
  assert.equal(Core.normalizeFeed({ id: 'a', name: 'A' }, 'darwin', '/h'), null);                               // nowhere to read
  assert.equal(Core.normalizeFeed({ id: 'a', name: 'A', source: { root: '/r', ssh: '-oProxyCommand=evil' } }, 'darwin', '/h'), null);
  assert.equal(Core.normalizeFeed({ id: 'a', name: 'A', source: { root: '/r' }, when: { time: '25:00', timeZone: 'Mars/Olympus' } }, 'darwin', '/h').when, null);
  assert.equal(Core.normalizeFeed([], 'darwin', '/h'), null);
});

test('the next run is counted in the task\'s own time zone', () => {
  const when = { time: '20:30', timeZone: 'America/Los_Angeles' };
  assert.equal(Core.nextRun(when, Date.parse('2026-10-05T18:00:00-07:00')), Date.parse('2026-10-05T20:30:00-07:00'));
  assert.equal(Core.nextRun(when, Date.parse('2026-10-05T20:30:00-07:00')), Date.parse('2026-10-06T20:30:00-07:00'));   // strictly after
  assert.equal(Core.nextRun(when, Date.parse('2026-10-31T21:00:00-07:00')), Date.parse('2026-11-01T20:30:00-08:00'));   // across the clock change
  assert.equal(Core.nextRun(null, 0), null);
  assert.equal(Core.whenLabel(when, 'America/Los_Angeles'), '每天 20:30');
  assert.equal(Core.whenLabel(when, 'Asia/Shanghai'), '每天 20:30（Los Angeles 时间）');
});

test('run status comes from the scheduler\'s own record, and an old copy never shows a past run as next', () => {
  const feed = { when: { time: '20:30', timeZone: 'America/Los_Angeles' } };
  const job = Core.pickJob(json(FIXTURE, 'jobs.json'), 'radar01');
  const now = Date.parse('2026-10-05T18:00:00-07:00');
  assert.deepEqual(Core.runStatus(feed, job, now), {
    lastRunAt: Date.parse('2026-10-05T00:44:37.987-07:00'), nextRunAt: Date.parse('2026-10-05T20:30:00-07:00'), lastStatus: 'ok', lastError: '', enabled: true,
  });
  // read two days later from a stale copy
  assert.equal(Core.runStatus(feed, job, Date.parse('2026-10-07T09:00:00-07:00')).nextRunAt, Date.parse('2026-10-07T20:30:00-07:00'));
  const failed = Core.runStatus(feed, { ...job, last_status: 'error', last_error: 'DeepSeek 429' }, now);
  assert.equal(failed.lastStatus, 'error');
  assert.equal(failed.lastError, 'DeepSeek 429');
  assert.equal(Core.runStatus(feed, { ...job, enabled: false }, now).nextRunAt, null);
  // nothing known about the job: only the timetable
  assert.deepEqual(Core.runStatus(feed, null, now), { lastRunAt: null, nextRunAt: Date.parse('2026-10-05T20:30:00-07:00'), lastStatus: '', lastError: '', enabled: true });
  assert.equal(Core.pickJob(json(FIXTURE, 'jobs.json'), 'missing'), null);
});

// ---- decisions ----
test('the latest word on a suggestion wins, wherever it was recorded', () => {
  const doc = { decisions: [
    { id: 'ADR-0001', decision: 'accepted', reason: '好', at: '2026-10-05T10:00:00Z' },
    { id: 'ADR-0001', decision: 'rejected', reason: '想了想不做', at: '2026-10-05T12:00:00Z' },
    { id: 'ADR-0002', decision: 'accepted', reason: '', at: '2026-10-05T10:00:00Z' },
    { id: 'ADR-0009', decision: 'maybe', at: '2026-10-05T10:00:00Z' },      // not a decision
    { id: 'nope', decision: 'accepted' },
  ] };
  const journal = [
    { itemId: 'ADR-0002', decision: 'rejected', reason: '先不做', at: Date.parse('2026-10-05T13:00:00Z'), synced: false },
    { itemId: 'ADR-0003', decision: 'accepted', reason: '', at: Date.parse('2026-10-05T13:00:00Z'), synced: true },
  ];
  const map = Core.decisionMap(doc, journal);
  assert.deepEqual([...map.keys()].sort(), ['ADR-0001', 'ADR-0002', 'ADR-0003']);
  assert.deepEqual(map.get('ADR-0001'), { decision: 'rejected', reason: '想了想不做', at: Date.parse('2026-10-05T12:00:00Z'), synced: true });
  assert.deepEqual(map.get('ADR-0002'), { decision: 'rejected', reason: '先不做', at: Date.parse('2026-10-05T13:00:00Z'), synced: false });
  const items = ['ADR-0001', 'ADR-0002', 'ADR-0003', 'ADR-0004', 'ADR-0005'].map((id) => ({ id }));
  assert.equal(Core.openCount(items, map), 2);
  assert.equal(Core.openCount(items, Core.decisionMap(null, null)), 5);
  assert.equal(Core.openCount([], map), 0);
});

test('队长 is told the decision, where it stands, and that it is not an order to start', () => {
  const feed = { label: '雷达', name: '竞品与灵感雷达' };
  const yes = Core.captainMessage(feed, { itemId: 'ADR-0001', decision: 'accepted', reason: '证据最缺', title: '任务卡给出完成证据', date: '2026-10-05', synced: true, previous: '' });
  assert.match(yes, /^雷达审核：做 ADR-0001「任务卡给出完成证据」，理由：证据最缺。/);
  assert.match(yes, /已经写进「竞品与灵感雷达」的决定文件/);
  assert.match(yes, /不要因此自动开卡或开工/);
  const no = Core.captainMessage(feed, { itemId: 'ADR-0003', decision: 'rejected', reason: '', title: '', date: '', synced: false, previous: 'accepted' });
  assert.match(no, /^雷达审核：改为不做 ADR-0003，没写理由。/);
  assert.match(no, /正本现在连不上，决定先记在这台电脑上/);
  assert.match(no, /不要因此自动开卡或开工/);
});

// ---- the task's folder on this disk ----
test('a watched task lists its schedule, last run and how many suggestions wait', async (t) => {
  const w = world(t);
  const feeds = w.open();
  const { feeds: [f] } = await feeds.list({ fresh: true });
  assert.equal(f.id, 'radar');
  assert.equal(f.source, 'live');
  assert.equal(f.offline, false);
  assert.equal(f.latest, '2026-10-05');
  assert.deepEqual(f.dates, ['2026-10-04', '2026-10-05']);
  assert.equal(f.openCount, 4);                                  // every issue counts, not only the newest
  assert.deepEqual(f.open, { '2026-10-04': 1, '2026-10-05': 3 });
  assert.equal(f.status.lastStatus, 'ok');
  assert.equal(f.status.nextRunAt, Date.parse('2026-10-05T20:30:00-07:00'));
  assert.equal(f.canDecide, true);
  assert.equal('report' in f, false);

  const d = await feeds.detail('radar', { fresh: true });
  assert.equal(d.report.date, '2026-10-05');
  assert.deepEqual(d.report.items.map((it) => [it.id, it.decided]), [['ADR-0002', null], ['ADR-0003', null], ['ADR-0004', null]]);
  const old = await feeds.detail('radar', { date: '2026-10-04' });
  assert.equal(old.report.date, '2026-10-04');
  assert.equal(old.report.items[0].id, 'ADR-0001');
  assert.equal((await feeds.detail('radar', { date: '2026-09-01' })).missing, '2026-09-01');
  assert.deepEqual(await feeds.detail('nope'), { ok: false, error: '没有这个任务' });
  assert.deepEqual(await feeds.detail('../radar'), { ok: false, error: '没有这个任务' });
});

test('a task that only leaves reports shows its latest result and asks for nothing', async (t) => {
  const w = world(t, { decide: undefined, job: undefined });
  const [f] = (await w.open().list({ fresh: true })).feeds;
  assert.equal(f.canDecide, false);
  assert.equal(f.openCount, 0);
  assert.equal(f.status.lastRunAt, null);
  assert.equal(f.latest, '2026-10-05');
  assert.deepEqual(await w.open().decide('radar', { itemId: 'ADR-0002', decision: 'accepted' }), { ok: false, error: '这个任务不收审核决定' });
});

test('a decision is journalled, written by the task\'s own command, and can be changed', async (t) => {
  const w = world(t);
  const feeds = w.open();
  const r = await feeds.decide('radar', { itemId: 'ADR-0002', decision: 'accepted', reason: '  证据\n最缺  ', date: '2026-10-05' });
  assert.equal(r.ok, true);
  assert.equal(r.entry.reason, '证据 最缺');
  assert.equal(r.entry.title, '任务卡给出完成证据，并把审过、已合入、已交付分开');
  assert.equal(r.entry.previous, '');
  // on this machine before the command has even run
  assert.equal(w.journal().entries[0].itemId, 'ADR-0002');
  assert.deepEqual(await feeds.settle('radar'), { ok: true, unsynced: 0, syncError: '' });
  const written = json(w.root, 'decisions.json').decisions;
  assert.equal(written.length, 1);
  assert.deepEqual([written[0].id, written[0].decision, written[0].reason], ['ADR-0002', 'accepted', '证据 最缺']);

  let d = await feeds.detail('radar', { fresh: true });
  assert.equal(d.openCount, 3);
  assert.equal(d.unsynced, 0);
  const item = d.report.items.find((it) => it.id === 'ADR-0002');
  assert.equal(item.decided.decision, 'accepted');
  assert.equal(item.decided.synced, true);
  assert.deepEqual(d.notes.map((n) => [n.itemId, n.decision, n.synced]), [['ADR-0002', 'accepted', true]]);
  assert.deepEqual(feeds.notified('radar', [r.entry.seq]), { ok: true });
  assert.deepEqual((await feeds.detail('radar')).notes, []);

  // a change of mind is a new decision on top, never an edit of the old one
  w.clock += 60_000;
  const again = await feeds.decide('radar', { itemId: 'ADR-0002', decision: 'rejected', reason: '先缓一缓', date: '2026-10-05' });
  assert.equal(again.entry.previous, 'accepted');
  await feeds.settle('radar');
  assert.deepEqual(json(w.root, 'decisions.json').decisions.map((x) => x.decision), ['accepted', 'rejected']);
  d = await feeds.detail('radar', { fresh: true });
  assert.equal(d.report.items[0].decided.decision, 'rejected');
  assert.equal(d.report.items[0].decided.reason, '先缓一缓');
  assert.equal(d.openCount, 3);
});

test('a decision that makes no sense is refused and nothing is written', async (t) => {
  const w = world(t);
  const feeds = w.open();
  const before = snapshot(w.root);
  assert.equal((await feeds.decide('radar', { itemId: 'ADR-0002', decision: 'maybe', date: '2026-10-05' })).error, '无效的决定');
  assert.equal((await feeds.decide('radar', { itemId: 'ADR-0002; rm -rf /', decision: 'accepted' })).error, '无效的决定');
  assert.equal((await feeds.decide('radar', { itemId: 'ADR-0999', decision: 'accepted', date: '2026-10-05' })).error, '在这一期里找不到这条建议');
  assert.equal((await feeds.decide('radar', { itemId: 'ADR-0001', decision: 'accepted', date: '2026-10-05' })).error, '在这一期里找不到这条建议');
  assert.equal((await feeds.decide('nope', { itemId: 'ADR-0002', decision: 'accepted' })).error, '没有这个任务');
  assert.equal(fs.existsSync(path.join(w.userData, 'schedule-feeds', 'radar', 'journal.json')), false);
  assert.deepEqual(snapshot(w.root), before);
});

// ---- the task's folder out of reach ----
test('out of reach: the mirror is shown with its age, and a decision waits on this machine', async (t) => {
  const w = world(t, {});
  copyStore(w.mirror, ['2026-10-04']);                            // an older copy
  fs.writeFileSync(path.join(w.dir, 'radar.json'), JSON.stringify({ ...json(w.dir, 'radar.json'), mirror: w.mirror }));
  const stamp = new Date('2026-10-04T08:00:00Z');
  fs.utimesSync(path.join(w.mirror, 'reports', '2026-10-04.md'), stamp, stamp);
  fs.utimesSync(path.join(w.mirror, 'decisions.json'), stamp, stamp);
  fs.renameSync(w.root, w.root + '.away');                        // the machine is off
  fs.writeFileSync(w.flag, '');
  const mirrorBefore = snapshot(w.mirror);
  const awayBefore = snapshot(w.root + '.away');

  let feeds = w.open({ retryEvery: 3_600_000 });
  const d = await feeds.detail('radar', { fresh: true });
  assert.equal(d.offline, true);
  assert.equal(d.source, 'mirror');
  assert.equal(d.asOf, stamp.getTime());
  assert.deepEqual(d.dates, ['2026-10-04']);
  assert.equal(d.report.items[0].id, 'ADR-0001');
  assert.equal(d.openCount, 1);
  assert.equal(d.status.lastStatus, '');                          // the mirror knows nothing of the last run
  assert.equal(d.status.nextRunAt, Date.parse('2026-10-05T20:30:00-07:00'));

  const r = await feeds.decide('radar', { itemId: 'ADR-0001', decision: 'rejected', reason: '不急', date: '2026-10-04' });
  assert.equal(r.ok, true);
  const waiting = await feeds.settle('radar');
  assert.equal(waiting.unsynced, 1);
  assert.match(waiting.syncError, /Operation timed out/);
  let off = await feeds.detail('radar', { fresh: true });
  assert.equal(off.report.items[0].decided.decision, 'rejected');
  assert.equal(off.report.items[0].decided.synced, false);
  assert.equal(off.unsynced, 1);
  assert.equal(off.openCount, 0);
  assert.deepEqual(off.notes.map((n) => [n.itemId, n.synced]), [['ADR-0001', false]]);
  // neither the mirror nor the task's own folder was written by the page
  assert.deepEqual(snapshot(w.mirror), mirrorBefore);
  assert.deepEqual(snapshot(w.root + '.away'), awayBefore);

  // AgentDeck is restarted while the machine is still off: the decision is still there
  await feeds.settle('radar');
  feeds.dispose();
  feeds = w.open({ retryEvery: 3_600_000 });
  off = await feeds.detail('radar', { fresh: true });
  assert.equal(off.report.items[0].decided.decision, 'rejected');
  assert.equal(off.unsynced, 1);
  assert.equal((await feeds.list({})).feeds[0].unsynced, 1);
  assert.equal((await feeds.settle('radar')).unsynced, 1);

  // the machine is back: the next visit writes it, in the task's own file
  fs.renameSync(w.root + '.away', w.root);
  fs.rmSync(w.flag);
  await feeds.detail('radar', { fresh: true });
  assert.deepEqual(await feeds.settle('radar'), { ok: true, unsynced: 0, syncError: '' });
  const written = json(w.root, 'decisions.json').decisions;
  assert.deepEqual(written.map((x) => [x.id, x.decision, x.reason]), [['ADR-0001', 'rejected', '不急']]);
  const back = await feeds.detail('radar', { fresh: true, date: '2026-10-04' });
  assert.equal(back.offline, false);
  assert.equal(back.source, 'live');
  assert.equal(back.unsynced, 0);
  assert.equal(back.report.items[0].decided.synced, true);
  assert.equal(back.openCount, 3);                                 // the newer issue is visible again
  assert.deepEqual(snapshot(w.mirror), mirrorBefore);
});

test('out of reach with nothing kept: the page is told so instead of failing', async (t) => {
  const w = world(t);
  fs.renameSync(w.root, w.root + '.away');
  const d = await w.open().detail('radar', { fresh: true });
  assert.equal(d.ok, true);
  assert.equal(d.offline, true);
  assert.equal(d.source, 'none');
  assert.equal(d.report, null);
  assert.deepEqual(d.dates, []);
  assert.equal(d.openCount, 0);
});

test('decisions made while out of reach are written in the order they were made', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.flag, '');
  const feeds = w.open({ retryEvery: 3_600_000 });
  await feeds.decide('radar', { itemId: 'ADR-0002', decision: 'accepted', reason: '一', date: '2026-10-05' });
  w.clock += 1000;
  await feeds.decide('radar', { itemId: 'ADR-0002', decision: 'rejected', reason: '二', date: '2026-10-05' });
  w.clock += 1000;
  await feeds.decide('radar', { itemId: 'ADR-0004', decision: 'accepted', reason: '三', date: '2026-10-05' });
  assert.equal((await feeds.settle('radar')).unsynced, 3);
  assert.deepEqual(json(w.root, 'decisions.json').decisions, []);
  fs.rmSync(w.flag);
  assert.equal((await feeds.settle('radar')).unsynced, 0);
  assert.deepEqual(json(w.root, 'decisions.json').decisions.map((x) => x.id + ' ' + x.decision + ' ' + x.reason),
    ['ADR-0002 accepted 一', 'ADR-0002 rejected 二', 'ADR-0004 accepted 三']);
  const d = await feeds.detail('radar', { fresh: true });
  assert.equal(d.report.items[0].decided.decision, 'rejected');
  assert.equal(d.openCount, 2);
});

// ---- the task's folder on a Windows machine, over ssh ----
// The stand-in answers the way the PowerShell script does, from a local folder.
function fakeSsh(w, state) {
  return async (file, args) => {
    state.calls.push({ file, args });
    if (file !== 'ssh') return { ok: false, stdout: '', stderr: '', error: 'unexpected command ' + file };
    if (state.down) return { ok: false, stdout: '', stderr: 'ssh: connect to host winpc port 22: Operation timed out', error: 'exit 255' };
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
    state.scripts.push(script);
    const list = (name) => (new RegExp('\\$' + name + "=@\\(([^)]*)\\)").exec(script)[1].match(/\d{4}-\d{2}-\d{2}/g) || []);
    const have = list('have'), want = list('want');
    const b = (s) => Buffer.from(s).toString('base64');
    const names = fs.readdirSync(path.join(w.root, 'reports')).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)).sort();
    const get = [...new Set([...names.filter((n) => !have.includes(n)).slice(-10), names[names.length - 1], ...want.filter((n) => names.includes(n))])];
    const lines = ['D ' + b(names.join(','))];
    for (const d of get) for (const ext of ['md', 'json']) {
      const p = path.join(w.root, 'reports', `${d}.${ext}`);
      if (fs.existsSync(p)) lines.push(`F ${b(`reports/${d}.${ext}`)} ${b(fs.readFileSync(p))}`);
    }
    lines.push(`F ${b('decisions.json')} ${b(fs.readFileSync(path.join(w.root, 'decisions.json')))}`);
    lines.push(`F ${b('@job')} ${b(fs.readFileSync(path.join(w.tmp, 'jobs.json')))}`);
    lines.push(`F ${b('../../evil.txt')} ${b('x')}`);                // a path outside the layout is ignored
    if (!state.cut) lines.push('OK');
    return { ok: true, stdout: lines.join('\r\n') + '\r\n', stderr: '#< CLIXML noise', error: '' };
  };
}

test('a folder on another machine is read over ssh, kept, and shown with its age when that machine is off', async (t) => {
  const w = world(t, { source: { ssh: 'winpc', root: 'D:/state/it\'s radar' }, job: { file: 'D:/hermes/cron/jobs.json', id: 'radar01' }, decide: undefined });
  const state = { calls: [], scripts: [], down: false, cut: false };
  const feeds = w.open({ run: fakeSsh(w, state) });

  // before anything was read: nothing to show, and no waiting on the network
  const first = await feeds.detail('radar', {});
  assert.equal(first.checking, true);
  assert.equal(first.offline, false);
  assert.equal(first.source, 'none');
  assert.equal(state.calls.length, 0);

  const live = await feeds.detail('radar', { fresh: true });
  assert.equal(live.source, 'live');
  assert.equal(live.offline, false);
  assert.equal(live.asOf, w.clock);
  assert.deepEqual(live.dates, ['2026-10-04', '2026-10-05']);
  assert.equal(live.report.items.length, 3);
  assert.equal(live.status.lastStatus, 'ok');
  assert.equal(live.status.lastRunAt, Date.parse('2026-10-05T00:44:37.987-07:00'));
  const { args } = state.calls[0];
  assert.deepEqual(args.slice(0, 9), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'winpc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.match(state.scripts[0], /\$root='D:\/state\/it''s radar'/);        // quoted, never spliced into a shell
  assert.match(state.scripts[0], /F '@job' 'D:\/hermes\/cron\/jobs\.json'/);
  // only the one job is kept from the scheduler's file, and nothing outside the layout
  const cache = path.join(w.userData, 'schedule-feeds', 'radar');
  assert.equal(json(cache, 'job.json').id, 'radar01');
  assert.deepEqual(Object.keys(snapshot(cache)).sort(), ['decisions.json', 'job.json', 'meta.json',
    path.join('reports', '2026-10-04.md'), path.join('reports', '2026-10-05.json'), path.join('reports', '2026-10-05.md')]);
  assert.equal(fs.existsSync(path.join(w.userData, 'evil.txt')), false);

  // a visit moments later does not go over the network again; a forced refresh does
  await feeds.detail('radar', { fresh: true });
  assert.equal(state.calls.length, 1);
  await feeds.detail('radar', { fresh: true, force: true });
  assert.equal(state.calls.length, 2);
  assert.match(state.scripts[1], /\$have=@\('2026-10-04','2026-10-05'\)/);   // only what is missing is fetched again

  // a new issue appears; then the machine goes off
  fs.writeFileSync(path.join(w.root, 'reports', '2026-10-06.md'), '# 竞品与灵感雷达 · 2026-10-06\n\n今天没有新发现。\n');
  w.clock += 5 * 60_000;
  const next = await feeds.detail('radar', { fresh: true });
  assert.equal(next.report.date, '2026-10-06');
  assert.deepEqual(next.report.items, []);
  const fetchedAt = w.clock;
  state.down = true;
  w.clock += 3 * 3_600_000;
  const off = await feeds.detail('radar', { fresh: true });
  assert.equal(off.offline, true);
  assert.equal(off.source, 'cache');
  assert.equal(off.asOf, fetchedAt);                               // 数据截至: when it was last read
  assert.equal(off.report.date, '2026-10-06');
  assert.equal(off.openCount, 0);                                  // this task takes no decisions
  const quick = await feeds.detail('radar', { date: '2026-10-05' });
  assert.equal(quick.checking, true);
  assert.equal(quick.offline, true);                               // it did not answer a moment ago: still said so
  const calls = state.calls.length;
  await feeds.detail('radar', { fresh: true });                    // a second glance does not hang on the network again
  assert.equal(state.calls.length, calls);
  await feeds.detail('radar', { fresh: true, force: true });       // the refresh button does ask
  assert.equal(state.calls.length, calls + 1);
  assert.equal(quick.report.items.length, 3);

  // an answer cut off half way is not taken for the whole thing
  state.down = false; state.cut = true;
  w.clock += 60_000;
  assert.equal((await feeds.detail('radar', { fresh: true })).offline, true);
  assert.equal(json(cache, 'meta.json').fetchedAt, fetchedAt);
});

test('when both a kept copy and a mirror exist, the one with the newer report is shown', async (t) => {
  const w = world(t, { source: { ssh: 'winpc', root: 'D:/state/radar' }, decide: undefined, job: undefined });
  copyStore(w.mirror);
  fs.writeFileSync(path.join(w.dir, 'radar.json'), JSON.stringify({ ...json(w.dir, 'radar.json'), mirror: w.mirror }));
  const state = { calls: [], scripts: [], down: false, cut: false };
  const feeds = w.open({ run: fakeSsh(w, state) });
  assert.equal((await feeds.detail('radar', {})).source, 'mirror');   // nothing kept yet
  await feeds.detail('radar', { fresh: true });
  state.down = true;
  w.clock += 120_000;
  assert.equal((await feeds.detail('radar', { fresh: true })).source, 'cache');
  fs.writeFileSync(path.join(w.mirror, 'reports', '2026-10-07.md'), '# 新的一期\n');
  const d = await feeds.detail('radar', { fresh: true });
  assert.equal(d.source, 'mirror');
  assert.equal(d.report.date, '2026-10-07');
});

test('the remote script only ever carries well-formed dates and quoted paths', () => {
  const feed = { source: { root: "D:/a'b", ssh: 'winpc' }, job: null };
  const script = pullScript(feed, ['2026-10-05', "x'; Remove-Item -Recurse C:/ #", '2026-13-99'], ['2026-10-01', '$(evil)']);
  assert.match(script, /\$root='D:\/a''b'/);
  assert.match(script, /\$have=@\('2026-10-05','2026-13-99'\); \$want=@\('2026-10-01'\)/);
  assert.doesNotMatch(script, /Remove-Item|evil|@job/);
  const b = (s) => Buffer.from(s).toString('base64');
  const got = parsePull(`D ${b('2026-10-05,nope,2026-10-04')}\r\nF ${b('reports/2026-10-05.md')} ${b('# 标题')}\r\nF ${b('reports/../x.md')} ${b('x')}\r\nE root\r\n`);
  assert.deepEqual(got.dates, ['2026-10-04', '2026-10-05']);
  assert.deepEqual([...got.files], [['reports/2026-10-05.md', '# 标题']]);
  assert.equal(got.complete, false);
});
