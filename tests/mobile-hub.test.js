'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../mobile-web/hub/core');

const snapshot = { apiVersion: 2, machine: { id: 'win', label: 'Windows', platform: 'win32', hostname: 'OWENJH', appVersion: '1.2.0' }, now: 1, csrfToken: 'c',
  captain: { id: 'cap', title: '队长标题', status: 'working', turns: [{ user: '对话正文', reply: '回复正文' }] },
  sessions: [{ id: 'a', title: '会话标题', status: 'working', receipt: '回执正文' }, { id: 'b', title: 'b', status: 'idle' }], boardVersion: 'v' };

test('snapshot results map to the five machine states of the design table', () => {
  assert.equal(Core.classify({ status: 200, body: snapshot }).state, 'online');
  assert.equal(Core.classify({ status: 401, body: { error: 'Unauthorized.' } }).state, 'login');
  assert.equal(Core.classify({ status: 502, body: { offline: true } }).state, 'offline');
  assert.equal(Core.classify({ timedOut: true }).state, 'unresponsive');
  assert.equal(Core.classify({ status: 404, body: { error: 'Not found.' } }).state, 'upgrade');
  assert.deepEqual(Core.classify({ status: 429, body: {}, retryAfter: 120 }), { state: 'login', retryAfter: 120 });
  // An old server answering 200 without the v2 shape still needs an upgrade.
  assert.equal(Core.classify({ status: 200, body: { sessions: [] } }).state, 'upgrade');
});

test('api/info decides between a current build and one that needs an upgrade before any login', () => {
  const info = { app: 'agentdeck', apiVersion: 2, capabilities: ['snapshot', 'basePath'], machine: { id: 'win', label: 'Windows', platform: 'win32' }, appVersion: '1.2.0' };
  assert.deepEqual(Core.classifyInfo({ status: 200, body: info }), { current: true });
  // Old builds answer 401 (not logged in) or 404 (logged in) to the probe: never a login form.
  assert.deepEqual(Core.classifyInfo({ status: 401, body: { error: 'Unauthorized.' } }), { state: 'upgrade' });
  assert.deepEqual(Core.classifyInfo({ status: 404, body: { error: 'Not found.' } }), { state: 'upgrade' });
  assert.equal(Core.classifyInfo({ status: 200, body: { ...info, apiVersion: 1 } }).state, 'upgrade');
  assert.equal(Core.classifyInfo({ status: 200, body: { ...info, capabilities: ['basePath'] } }).state, 'upgrade');
  assert.equal(Core.classifyInfo({ status: 200, body: { ...info, app: 'other' } }).state, 'upgrade');
  assert.equal(Core.classifyInfo({ status: 200, body: null }).state, 'error');
  assert.equal(Core.classifyInfo({ status: 502, body: { offline: true } }).state, 'offline');
  assert.equal(Core.classifyInfo({ timedOut: true }).state, 'unresponsive');
  assert.equal(Core.classifyInfo({ failed: true }).state, 'error');
  assert.equal(Core.classifyInfo({ status: 500, body: {} }).state, 'error');
});

test('anything outside the contract is an error, never online or a guessed offline', () => {
  for (const result of [{ failed: true }, { status: 502, body: null }, { status: 502, body: { offline: false } }, { status: 500, body: {} }, { status: 200, body: null }, { status: 403, body: {} }]) {
    assert.equal(Core.classify(result).state, 'error');
  }
});

test('sending is blocked for every state but online with a running captain, and never offers another machine', () => {
  const machine = (state, snap, csrf = 'c') => ({ label: 'Windows', state, snap, csrf });
  assert.equal(Core.sendBlock(machine('online', snapshot)), '');
  for (const state of ['offline', 'unresponsive', 'login', 'upgrade', 'error', 'unknown']) {
    const reason = Core.sendBlock(machine(state, null));
    assert.match(reason, /^Windows /);
    assert.match(reason, /不会自动转给另一台电脑/);
  }
  assert.match(Core.sendBlock(machine('online', { ...snapshot, captain: { turns: [], status: 'unavailable' } })), /队长还没启动/);
  assert.match(Core.sendBlock(machine('online', snapshot, '')), /安全校验/);
  assert.match(Core.sendBlock(null), /请先选择/);
  assert.match(Core.sendFailure({ status: 502, body: { offline: true } }, 'Windows'), /没有转给另一台电脑/);
  assert.match(Core.sendFailure({ timedOut: true }, 'Windows'), /可能已经排队，也可能没有/);
});

test('selected machines poll every 5s, others every 15s, unreachable ones back off to 30s', () => {
  assert.equal(Core.pollInterval('online', true), 5000);
  assert.equal(Core.pollInterval('online', false), 15000);
  for (const state of ['offline', 'unresponsive', 'upgrade', 'error']) assert.equal(Core.pollInterval(state, true), 30000);
});

test('remembered metadata holds counts and status only, no titles, receipts or turns', () => {
  const meta = Core.metaOf(snapshot, 1000);
  assert.deepEqual(meta, { lastOnline: 1000, sessionCount: 2, workingCount: 1, captainStatus: 'working', hostname: 'OWENJH', appVersion: '1.2.0' });
  assert.doesNotMatch(JSON.stringify(meta), /正文|标题/);
  assert.deepEqual(Core.cleanMeta({ ...meta, receipt: '回执正文', captainStatus: '<b>' }), { ...meta, captainStatus: 'unavailable' });
  assert.deepEqual(Core.cleanMeta('x'), {});
});

test('boards merge by card, newest update wins, and claims show the machine name', () => {
  const card = (id, updated, extra) => ({ id, project: 'p', title: id, status: 'todo', updated, ...extra });
  const merged = Core.mergeCards([
    { id: 'mac', cards: [card('a', '2026-10-04T02:00:00.000Z', { status: 'doing' }), card('b', '2026-10-04T01:00:00.000Z')] },
    { id: 'win', cards: [card('a', '2026-10-04T01:00:00.000Z'), card('c', '2026-10-04T01:00:00.000Z')] },
  ]);
  assert.deepEqual(merged.map((c) => [c.id, c.status, c.seenOn]), [['a', 'doing', 'mac'], ['b', 'todo', 'mac'], ['c', 'todo', 'win']]);
  const machines = [{ label: 'Mac', hostname: 'Jinhao-MacBook.local' }, { label: 'Windows', hostname: 'OWENJH' }];
  assert.equal(Core.ownerLabel({ dispatch_claim: { owner: 'owenjh' } }, machines), 'Windows');
  assert.equal(Core.ownerLabel({ dispatch_claim: { owner: 'jinhao-macbook' } }, machines), 'Mac');
  assert.equal(Core.ownerLabel({ dispatch_claim: { owner: 'other-host' } }, machines), 'other-host');
  assert.equal(Core.ownerLabel({ dispatch_claim: null }, machines), '');
});

test('machines.json lists Mac first as the default and only accepts id-matching prefixes', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mobile-web', 'hub', 'machines.json'), 'utf8'));
  assert.deepEqual(Core.machineList(file).map((m) => [m.id, m.label, m.basePath, m.default]), [['mac', 'Mac', '/mac/', true], ['win', 'Windows', '/win/', false]]);
  assert.deepEqual(Core.machineList({ machines: [{ id: 'mac', label: 'Mac', basePath: '/win/' }, { id: 'x', label: 'X', basePath: 'https://evil.example/x/' }, { id: 'mac', label: '', basePath: '/mac/' }] }), []);
  assert.equal(Core.ago(1000, 1000 + 3 * 3600000), '3 小时前');
  assert.equal(Core.ago(0, 5000), '');
});

test('the hub has no inline script or style, so it runs under the strict static CSP', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'mobile-web', 'hub', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i);
});

test('every fetch in the hub refuses redirects, so a machine cannot send the hub to the other computer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'mobile-web', 'hub', 'app.js'), 'utf8');
  const calls = [...source.matchAll(/\bfetch\(/g)];
  assert.ok(calls.length >= 2, 'the hub fetches machines.json and every machine request');
  for (const call of calls) {
    // The options object of each call (up to the closing of the call on that statement) must carry redirect: 'error'.
    const statement = source.slice(call.index, source.indexOf(';', call.index));
    assert.match(statement, /redirect:\s*'error'/, `fetch without redirect: 'error': ${statement.slice(0, 80)}`);
  }
  // The machine request must not let a caller's options turn redirects back on.
  assert.match(source, /\.\.\.options,\s*redirect: 'error'/);
});

test('injected dispatch cards, notices and receipts fold into one round: one message, one Captain reply', () => {
  const t = 1_000_000;
  const groups = Core.groupTurns([
    { id: 'u1', ts: t, user: '看一下进度', reply: '', done: true },
    { id: 'k1', ts: t + 1000, kind: 'task', task: { title: '前端', summary: '' }, done: true },
    { id: 'k2', ts: t + 2000, kind: 'task', task: { title: '文档', summary: '后来又给这个会话发了新指令，结果看后面的卡片。', failed: false }, done: true },
    { id: 'n1', ts: t + 3000, kind: 'notice', reply: '回执已送达', done: true },
    { id: 'r1', ts: t + 4000, reply: '进度如下', steps: ['读看板'], done: true },
    { id: 'r2', ts: t + 5000, reply: '文档也好了', done: true },
    { id: 'u2', ts: t + 6000, user: '再查一次', reply: '', done: false },
  ]);
  // Only what was said: no task titles, receipts, notices or tool steps.
  assert.deepEqual(groups, [
    { id: 'u1', user: '看一下进度', images: [], reply: '进度如下\n\n文档也好了', pending: false, interrupted: false },
    { id: 'u2', user: '再查一次', images: [], reply: '', pending: true, interrupted: false },
  ]);
});

test('a round where the Captain only dispatched work shows nothing on its side', () => {
  const t = 1_000_000;
  const task = (id, ts) => ({ id, ts, kind: 'task', task: { title: '活', summary: '做完了' }, done: true });
  // After a message: the message alone. With no message at all: no round.
  assert.deepEqual(Core.groupTurns([{ id: 'u1', ts: t, user: '派一下', reply: '', done: true }, task('k1', t + 1000)]),
    [{ id: 'u1', user: '派一下', images: [], reply: '', pending: false, interrupted: false }]);
  assert.deepEqual(Core.groupTurns([task('k1', t), { id: 'n1', ts: t + 1000, kind: 'notice', reply: '已切换座位', done: true }]), []);
  // A reply that is nothing but terminal residue is no reply.
  assert.deepEqual(Core.groupTurns([{ id: 'r1', ts: t, reply: 'Ran 2 shell commands\n\nUpdate available! Run: brew upgrade claude-code@latest', done: true }]), []);
  // An interrupted turn is still told.
  assert.equal(Core.groupTurns([{ id: 'r1', ts: t, reply: '', done: false, interrupted: true }])[0].interrupted, true);
});

test('terminal residue is taken out of a reply and the Captain\'s words are kept', () => {
  const said = '昨晚那几件事做到哪了？给我一个总的进度，没做成的单独列出来。';
  const reply = [
    '❯ 昨晚那几件事做到哪了？给我一个总的进度，没做成', '的单独列出来。', '',
    'Read 1 file, listed 1 directory, ran 3 shell commands', '', 'Called Gmail, ran 1 shell command', '', 'Searched for 2 patterns', '',
    'Background command "Background listener for crew', '', 'receipts" completed (exit code 0)', '',
    'Background command "Wait for receipts" completed (exit code 0)', '',
    '三件事都有结果了。', '- 额度显示：已核对。', '  第二行缩进照旧。', '',
    'Update available! Run: brew upgrade claude-code@latest', '',
    '▐▛███▛█   Claude Code v2.1.0', '▝▜██████▀  Opus 5.5 with high effort', '*         ███▓░     ░░', '',
    'Worked for 2m 3s • 10:22', '3 new messages (click) ↓', '下一步等截图回来就验收。  Jump to bottom (click) ↓',
  ].join('\n');
  assert.equal(Core.cleanReply(reply, said), '三件事都有结果了。\n- 额度显示：已核对。\n  第二行缩进照旧。\n\n下一步等截图回来就验收。');
  // The tail of a file diff printed above the reply.
  assert.equal(Core.cleanReply('+已归档）；c-board-1 轮换\n        + t-de2b，报告在 reports/\n    144 +\n    145  ## 卡在哪\n         保留原席位\n    147\n\n你说得对，已经派了。'), '你说得对，已经派了。');
  // Prompts AgentDeck types itself are dropped with everything in their block.
  assert.equal(Core.cleanReply('已读。\n\n❯ 【AgentDeck 新回执】\n- 「对账」(c1)：做完了\n- 「巡检」(c2)：没有异常\n\n两份回执都看了。'), '已读。\n\n两份回执都看了。');
});

test('cleaning a reply never eats the Captain\'s own sentences', () => {
  // Words glued under an echo are kept unless they are the user's own text.
  assert.equal(Core.cleanReply('❯ 帮我查一下额度\n- 已派一个队员去查。\n- 查清后告诉你。', '帮我查一下额度'), '- 已派一个队员去查。\n- 查清后告诉你。');
  // English prose, numbered lists, indented lists and code-like lines are ordinary text.
  for (const text of ['Ran the tests and they pass.', 'Read more in docs/a.md', '1. 第一步\n2. 第二步\n    - 缩进的子项', '  3 件事都做完了', '完成 100%\n...', 'Background commands are listed below.',
    '> 引用用户的话', '进度：60%（3/5）', 'node scripts/release.js 1.2 --dry-run']) assert.equal(Core.cleanReply(text), text);
  assert.equal(Core.cleanReply('第一段\r\n\r\n\r\n第二段\n'), '第一段\n\n第二段');
  assert.equal(Core.cleanReply(undefined), '');
  assert.equal(Core.cleanReply(null), '');
});

test('a reply that arrives long after the last message starts its own round, and odd turns are ignored', () => {
  const t = 1_000_000;
  const groups = Core.groupTurns([null, 'x', { id: 'u1', ts: t, user: '问', reply: '答', done: true }, { id: 'r2', ts: t + 31 * 60000, reply: '稍后的回执', done: true }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].user, '');
  assert.equal(groups[1].reply, '稍后的回执');
  assert.deepEqual(Core.groupTurns(undefined), []);
  // An images-only message is still the user's message.
  assert.equal(Core.groupTurns([{ id: 'p', ts: t, user: '', images: ['a'.repeat(32) + '.png'], reply: '', done: true }])[0].images.length, 1);
});

test('quota rows keep display fields only and are never shown as usable when unrecognised', () => {
  const clean = Core.cleanQuota({ version: '1.2.0', rows: [
    { key: 'a', provider: 'Claude', name: 'Claude Max', short: 'Max', flag: '🇺🇸', captain: true, status: 'weird', cells: [{ key: '5h', remaining: 250, resetAt: 5 }, { key: 'x', remaining: 1 }, { key: '7d', remaining: 'n/a' }], token: 'secret', account: 'h***@example.com' },
    null, 'x'] });
  assert.equal(clean.rows.length, 1);
  assert.equal(clean.rows[0].status, 'unknown');
  assert.deepEqual(clean.rows[0].cells, [{ key: '5h', remaining: 100, out: false, resetAt: 5 }]);
  assert.equal('token' in clean.rows[0], false);
  assert.equal(clean.version, '1.2.0');
  assert.deepEqual(Core.cleanQuota(null), { rows: [], version: '' });
});

test('quota wording matches the single-machine page: percent, reset, level, missing windows and old data', () => {
  const now = new Date(2026, 9, 4, 12, 0).getTime();
  const row = { name: 'Claude Max', status: 'normal', failed: false, captain: true, cells: [{ key: '5h', remaining: 72, out: false, resetAt: now + 95 * 60000 }], recoveryAt: null, sampledAt: now - 60000 };
  assert.equal(Core.percentText({ remaining: 0.4 }), '<1%');
  assert.equal(Core.percentText({ remaining: 71.6 }), '72%');
  assert.equal(Core.percentText({ out: true }), '用尽');
  assert.equal(Core.shortReset(now + 95 * 60000, now), '13:35');
  assert.equal(Core.shortReset(now + 3 * 86400000, now), '周' + '日一二三四五六'[new Date(now + 3 * 86400000).getDay()]);
  assert.match(Core.longReset(now + 95 * 60000, now), /^13:35（1 小时 35 分后）$/);
  assert.deepEqual(Core.quotaCells(row).map((cell) => [cell.key, !!cell.missing]), [['5h', false], ['7d', true]]);
  assert.equal(Core.cellLevel(row, row.cells[0], false), 'ok');
  assert.equal(Core.cellLevel(row, { remaining: 8 }, false), 'danger');
  assert.equal(Core.cellLevel(row, { remaining: 15 }, false), 'low');
  assert.equal(Core.cellLevel(row, { remaining: 90 }, true), 'none');
  assert.equal(Core.cellLevel({ ...row, status: 'stale' }, { remaining: 90 }, false), 'none');
  assert.equal(Core.quotaLabel(row, now), 'Claude Max（队长在用）；5 小时剩余 72%，13:35（1 小时 35 分后）重置');
  assert.equal(Core.quotaNote({ ...row, status: 'stale', failed: true }, now), '查询失败 · 数据已旧 · 采样 11:59');
  // An account that only reported "used up" shows that under 5h.
  assert.deepEqual(Core.quotaCells({ status: 'out', cells: [], recoveryAt: now + 1 })[0], { key: '5h', out: true, resetAt: now + 1 });
});

test('the hub asks each computer for its own quota under its prefix and keeps none of it on the phone', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'mobile-web', 'hub', 'app.js'), 'utf8');
  assert.match(source, /request\(m, 'api\/quota'\)/);
  const stored = [...source.matchAll(/store\(KEYS\.\w+/g)].map((match) => match[0]);
  assert.deepEqual(stored.sort(), ['store(KEYS.machine', 'store(KEYS.machine', 'store(KEYS.meta', 'store(KEYS.theme']);
});

// ---- moving the Captain to another account ----
const relayAnswer = (extra = {}) => ({ captainId: 'cap', currentId: 'us', switching: false, job: null, seats: [
  { id: 'us', name: 'US', provider: 'Claude', account: 'u***@example.com', current: true, selectable: false, reason: 'current', cells: [{ key: '5h', remaining: 4, resetAt: 5 }, { key: '7d', remaining: 41 }] },
  { id: 'cn', name: 'CN', provider: 'Claude', account: 'c***@example.com', selectable: true, reason: '', cells: [{ key: '5h', remaining: 72 }] },
  { id: 'us2', name: 'US2', provider: 'Claude', selectable: true, reason: 'unknown', cells: [] },
  { id: 'eu', name: 'EU', provider: 'Claude', selectable: false, reason: 'exhausted', recoveryAt: Date.UTC(2026, 9, 3, 13), cells: [{ key: '5h', remaining: 0, out: true }] },
  { id: 'jp', name: 'JP', provider: 'Claude', selectable: false, reason: 'login', cells: [] },
  { id: 'chatgpt', name: 'ChatGPT', provider: 'Codex', selectable: true, reason: '', cells: [] }], ...extra });

test('accounts are offered only when the computer says so in words the page knows', () => {
  const relay = Core.cleanRelay(relayAnswer());
  assert.deepEqual(relay.seats.map((s) => [s.id, s.selectable, s.reason]), [['us', false, 'current'], ['cn', true, ''], ['us2', true, 'unknown'], ['eu', false, 'exhausted'], ['jp', false, 'login'], ['chatgpt', true, '']]);
  assert.equal(Core.currentSeat(relay).id, 'us');
  assert.deepEqual(relay.seats.map(Core.seatLabel), ['Claude US', 'Claude CN', 'Claude US2', 'Claude EU', 'Claude JP', 'ChatGPT']);
  // Hostile or newer answers: a selectable flag next to a blocking or unknown reason, the seat in use, bad ids, extra fields.
  const odd = Core.cleanRelay({ currentId: '../x', captainId: 7, job: { id: 'BAD ID', status: 'done' }, seats: [
    { id: 'a', name: 'A', selectable: true, reason: 'exhausted' }, { id: 'b', name: 'B', selectable: true, reason: 'brand-new' }, { id: 'c', name: 'C', selectable: true, current: true, reason: '' },
    { id: 'bad id', name: 'x', selectable: true, reason: '' }, null, { id: 'd', name: 'D\n<b>', selectable: 'yes', reason: '', configDir: '/Users/x/.claude', cells: [{ key: '1d', remaining: 5 }, { key: '5h', remaining: 900 }] }] });
  assert.deepEqual(odd.seats.map((s) => [s.id, s.selectable, s.reason]), [['a', false, 'exhausted'], ['b', false, 'unknown'], ['c', false, ''], ['d', false, '']]);
  assert.deepEqual([odd.currentId, odd.captainId, odd.job], ['', '', null]);
  assert.equal(odd.seats[3].name, 'D <b>');
  assert.equal('configDir' in odd.seats[3], false);
  assert.deepEqual(odd.seats[3].cells, [{ key: '5h', remaining: 100, out: false, resetAt: null }]);
  assert.deepEqual(Core.cleanRelay(null), { captainId: '', currentId: '', switching: false, seats: [], job: null });
});

test('every account that cannot be picked says why in plain words, with no internal terms', () => {
  const now = Date.UTC(2026, 9, 3, 12), relay = Core.cleanRelay(relayAnswer());
  const by = Object.fromEntries(relay.seats.map((s) => [s.id, s]));
  assert.equal(Core.seatQuotaText(by.us), '5 小时剩 4% · 每周剩 41%');
  assert.equal(Core.seatQuotaText(by.eu), '5 小时已用完');
  assert.equal(Core.seatQuotaText(by.jp), '');
  assert.equal(Core.seatReason(by.cn, now), '');
  assert.equal(Core.seatReason(by.us, now), '队长现在就在用这个账号');
  assert.equal(Core.seatReason(by.jp, now), '还没登录。要回到电脑上登录后才能用');
  assert.match(Core.seatReason(by.eu, now), /^额度用完了，\d\d:00（1 小时后）恢复$/);
  assert.equal(Core.seatReason({ ...by.eu, recoveryAt: null, weekly: true }, now), '每周额度用完了，恢复时间还不知道');
  assert.equal(Core.seatReason({ ...by.eu, reason: 'low', recoveryAt: null }, now), '额度快用完了，恢复时间还不知道');
  assert.equal(Core.seatReason({ ...by.eu, reason: 'onboarding' }, now), '还停在第一次启动的引导页。要回到电脑上处理');
  assert.equal(Core.seatReason(by.us2, now), '额度还不清楚，可以换过去试试');
  assert.match(Core.seatSpoken(by.eu, now), /^Claude EU；5 小时已用完；额度用完了，.*恢复；现在不能选$/);
  assert.equal(Core.seatSpoken(by.cn, now), 'Claude CN；c***@example.com；5 小时剩 72%；点一下选它');
  for (const seat of relay.seats) assert.doesNotMatch(Core.seatSpoken(seat, now) + Core.seatReason(seat, now), /relay|seat|席位|Relay|onboarding|quota/i);
});

test('the outcome of a switch comes from that computer: its job record, or after a restart the account the Captain is on', () => {
  const job = { id: 'j1', targetId: 'cn' };
  const state = (extra) => Core.cleanRelay(relayAnswer(extra));
  assert.deepEqual(Core.relayOutcome(job, null), { phase: 'switching', error: '' });
  assert.deepEqual(Core.relayOutcome(job, state({ job: { id: 'j1', status: 'switching', targetId: 'cn' } })), { phase: 'switching', error: '' });
  assert.deepEqual(Core.relayOutcome(job, state({ job: { id: 'j1', status: 'done', targetId: 'cn' }, currentId: 'cn' })), { phase: 'done', error: '' });
  assert.deepEqual(Core.relayOutcome(job, state({ job: { id: 'j1', status: 'failed', targetId: 'cn', error: '存进度或启动新队长没成功' } })), { phase: 'failed', error: '存进度或启动新队长没成功' });
  assert.deepEqual(Core.relayOutcome(job, state({ job: { id: 'j1', status: 'failed', targetId: 'cn' } })), { phase: 'failed', error: '电脑没有完成切换。' });
  // Someone else's later switch, or none at all: this one's record is gone.
  assert.deepEqual(Core.relayOutcome(job, state({ job: null, currentId: 'cn' })), { phase: 'done', error: '' });
  assert.deepEqual(Core.relayOutcome(job, state({ job: { id: 'other', status: 'done', targetId: 'us2' }, currentId: 'us2' })), { phase: 'failed', error: '电脑上的 AgentDeck 中途重启了，切换没有完成。' });
  assert.deepEqual(Core.relayOutcome(job, state({ job: null })), { phase: 'failed', error: '电脑上的 AgentDeck 中途重启了，切换没有完成。' });
  // Before the computer confirmed the request there is no id to compare: keep waiting.
  assert.deepEqual(Core.relayOutcome({ id: '', targetId: 'cn' }, state({ job: null })), { phase: 'switching', error: '' });
});

test('a refused switch names the computer and says nothing changed; the computer\'s own reason is passed on', () => {
  assert.equal(Core.relayRefusal({ status: 409, body: { started: false, error: '这个账号的额度已经用完' } }, 'Mac'), '这个账号的额度已经用完');
  assert.equal(Core.relayRefusal({ status: 409, body: {} }, 'Mac'), 'Mac 没有接受这次切换（HTTP 409）。');
  assert.equal(Core.relayRefusal({ status: 502, body: { offline: true } }, 'Windows'), 'Windows 离线，没有切换。');
  assert.equal(Core.relayRefusal({ status: 404 }, 'Windows'), 'Windows 的 AgentDeck 版本太旧，还不能在手机上切换队长。');
  assert.equal(Core.relayRefusal({ status: 401 }, 'Mac'), 'Mac 的登录已失效，没有切换。');
  assert.equal(Core.relayRefusal({ status: 403 }, 'Mac'), 'Mac 的安全校验已过期，没有切换。刷新后再试。');
  assert.equal(Core.relayRefusal({ failed: true }, 'Mac'), '手机连不上入口，切换的请求没有发出去。');
  assert.match(Core.relayRefusal({ timedOut: true }, 'Mac'), /^没有收到 Mac 的确认/);
  assert.equal(Core.elapsedText(65_400), '1:05');
});

test('both phone pages switch through each computer\'s own api/relay, and only the confirm step starts a switch', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'mobile-web', file), 'utf8');
  const hub = read('hub/app.js'), single = read('app.js');
  // The hub names the computer in every call; nothing switches without a machine.
  assert.match(hub, /request\(m, 'api\/relay'\)/);
  assert.match(hub, /post\(m, 'api\/relay', \{ seatId: seat\.id/);
  assert.equal([...hub.matchAll(/api\/relay/g)].length, 2);
  assert.match(single, /api\('\/api\/relay', \{ method: 'POST'/);
  for (const source of [hub, single]) {
    // One place starts a switch, and only the confirm step calls it.
    assert.equal([...source.matchAll(/startSwitch\(/g)].length, 2);
    assert.match(source, /action\('primary', '确认切换', 'confirm', \(\) => startSwitch\(/);
  }
  // New wording never calls an account a "席位"; the older quota chip label is the only place it stays.
  assert.equal([...single.matchAll(/席位/g)].length, 1);
  assert.equal([...hub.matchAll(/席位/g)].length, 0);
});
