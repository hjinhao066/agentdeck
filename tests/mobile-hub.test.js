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

test('a reply that opens with the end of the turn\'s own echoed message loses only that', () => {
  const asked = '先把安装脚本的死循环修掉，最多重试三次就停下来报告。另外换席位的时候暂时跳过已经用尽的那个，这两件事今天都要有结果。';
  const tail = '另外换席位的时候暂时跳过已经用尽的那个，这两件事今天都要有结果。';
  // one row, rows the terminal wrapped, and a blank row before the reply
  assert.equal(Core.cleanReply(tail + '\n\n两件事都派出去了。', asked, asked), '两件事都派出去了。');
  assert.equal(Core.cleanReply('  另外换席位的时候暂时跳过已经\n  用尽的那个，这两件事今天都要有结果。\n\nRan 2 shell commands\n\n两件事都派出去了。\n\n- 第一件', asked, asked), '两件事都派出去了。\n\n- 第一件');
  // the desktop saves one turn per prompt: the phone folds them with the same rule
  assert.equal(Core.groupTurns([{ id: 'u1', ts: 1, user: asked, reply: tail + '\n\n两件事都派出去了。', done: true }])[0].reply, '两件事都派出去了。');
  // it has to run to the very end of this turn's message, and be more than a few characters
  for (const reply of ['另外换席位的时候暂时跳过已经用尽的那个\n\n这条我记下了。', '都要有结果。\n\n会的。', '这两件事今天都要有结果。我已经派了。', '最多重试三次就停下来报告。\n\n好。'])
    assert.equal(Core.cleanReply(reply, asked, asked), reply);
  // another turn's words are not this turn's echo; an ❯ echo is still handled as before
  assert.equal(Core.cleanReply(tail + '\n\n收到。', asked, '别的话'), tail + '\n\n收到。');
  assert.equal(Core.cleanReply(tail + '\n\n收到。', asked), tail + '\n\n收到。');
  assert.equal(Core.cleanReply('❯ ' + asked + '\n\n收到。', asked, asked), '收到。');
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
  assert.deepEqual(stored.sort(), ['store(KEYS.machine', 'store(KEYS.machine', 'store(KEYS.meta', 'store(KEYS.theme', 'store(KEYS.view']);
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

test('neither phone page declares the same function twice (a later one would silently replace the earlier)', () => {
  for (const file of ['hub/app.js', 'app.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'mobile-web', file), 'utf8');
    const names = [...source.matchAll(/^ {2}(?:async )?function (\w+)\(/gm)].map((match) => match[1]);
    assert.ok(names.length > 20, file);
    assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], file);
  }
});

test('a sent message stays until the computer records it: one bubble, never matched to an older message with the same words', () => {
  const item = (text, state = 'sent', extra = {}) => ({ text, state, known: [], ...extra });
  const before = [{ id: 't1', user: '继续', reply: '好的', done: true }, { id: 'n1', kind: 'notice', user: '继续' }];
  const again = item('继续', 'sent', { known: Core.userTurnIds(before) });
  assert.deepEqual(Core.userTurnIds(before), ['t1']);
  // The Captain is busy: nothing new on the computer yet, the message stays shown.
  assert.deepEqual(Core.settleOutbox([again], before), [again]);
  // Its own record arrives (spacing differs after the terminal): the record takes over.
  assert.deepEqual(Core.settleOutbox([again], [...before, { id: 't2', user: ' 继续\n', reply: '' }]), []);
  // Two identical messages on their way: one record stands for one of them only.
  const a = item('重试'), b = item('重试');
  assert.deepEqual(Core.settleOutbox([a, b], [{ id: 't3', user: '重试' }]), [b]);
  assert.deepEqual(Core.settleOutbox([b], [{ id: 't3', user: '重试' }]), [b]);
  assert.deepEqual(Core.settleOutbox([b], [{ id: 't3', user: '重试' }, { id: 't4', user: '重试' }]), []);
  // Still on the way when the record shows up, and a very long message recorded clipped.
  assert.deepEqual(Core.settleOutbox([item('早', 'sending')], [{ id: 't5', user: '早' }]), []);
  const long = '长'.repeat(2500);
  assert.deepEqual(Core.settleOutbox([item(long)], [{ id: 't6', user: long.slice(0, 2000) + '\n…（全文 2500 字，见附件）' }]), []);
  assert.equal(Core.settleOutbox([item(long)], [{ id: 't6', user: '别的话'.repeat(10) + '\n…（全文 2500 字，见附件）' }]).length, 1);
  // Images are part of the message.
  assert.equal(Core.settleOutbox([item('', 'sent', { images: ['a.png'] })], [{ id: 't7', user: '', images: ['b.png'] }]).length, 1);
  assert.equal(Core.settleOutbox([item('', 'sent', { images: ['a.png'] })], [{ id: 't7', user: '', images: ['a.png'] }]).length, 0);
  // A failed message keeps its words, unless nobody knows whether it arrived and it then shows up.
  const failed = item('没发出', 'failed'), unsure = item('不确定', 'failed', { unsure: true });
  assert.deepEqual(Core.settleOutbox([failed, unsure], [{ id: 't8', user: '没发出' }, { id: 't9', user: '不确定' }]), [failed]);
});

test('the same words right after they went out are recognised as a repeat; different words, failures and old ones are not', () => {
  const now = 1_000_000, sent = (text, extra = {}) => ({ text, state: 'sent', at: now - 5000, ...extra });
  assert.equal(Core.repeatedSend([sent('修一下输入栏')], '修一下输入栏', now), true);
  assert.equal(Core.repeatedSend([sent('修一下输入栏')], ' 修一下输入栏\n', now), true);
  assert.equal(Core.repeatedSend([sent('修一下输入栏')], '修一下发送', now), false);
  assert.equal(Core.repeatedSend([sent('修一下输入栏', { state: 'failed' })], '修一下输入栏', now), false);
  // Still waiting for the Captain counts however long ago; once delivered, only for a minute.
  assert.equal(Core.repeatedSend([sent('继续', { at: now - 600000 })], '继续', now), true);
  assert.equal(Core.repeatedSend([sent('继续', { arrived: true, at: now - 30000 })], '继续', now), true);
  assert.equal(Core.repeatedSend([sent('继续', { arrived: true, at: now - 61000 })], '继续', now), false);
  assert.equal(Core.repeatedSend([sent('', { images: ['a.png'] })], '', now), false);
});

test('a drag moves the page only where nothing scrolls or the list is at that end', () => {
  const list = (scrollTop) => ({ scrollTop, clientHeight: 400, scrollHeight: 1000 });
  assert.equal(Core.dragMovesPage(null, -30), true);
  assert.equal(Core.dragMovesPage(list(300), -30), false);
  assert.equal(Core.dragMovesPage(list(300), 30), false);
  assert.equal(Core.dragMovesPage(list(0), 30), true);
  assert.equal(Core.dragMovesPage(list(0), -30), false);
  assert.equal(Core.dragMovesPage(list(600), -30), true);
  assert.equal(Core.dragMovesPage(list(600), 30), false);
});

test('a long file path is shown by its end, the file name always whole', () => {
  assert.equal(Core.shortPath('/private/tmp/demo-AVkB5K/jinhao/reports/agentdeck-1.8/review-20261008.md'), '…/agentdeck-1.8/review-20261008.md');
  assert.equal(Core.shortPath('~/reports/a.md'), '~/reports/a.md');
  assert.equal(Core.shortPath('C:\\Users\\hjinh\\reports\\agentdeck-1.8\\very-long-file-name-here.md'), '…/very-long-file-name-here.md');
  assert.equal(Core.shortPath('/Users/me/reports/' + 'x'.repeat(60) + '.md'), '…/' + 'x'.repeat(60) + '.md');
});

// ---- 设置 · 电池模式 ----
const batteryAnswer = (extra = {}) => ({ mode: 'auto', cap: 3, capMin: 1, capMax: 10, onBattery: true, active: true, boost: false, boostUntil: null, baseCap: 30, effectiveCap: 3, working: 2, ...extra });

test('cleanBattery keeps only the fields the phone may show and falls back to the defaults for junk', () => {
  assert.deepEqual(Core.cleanBattery(batteryAnswer({ command: 'claude --x', path: '/Users/me' })),
    { mode: 'auto', cap: 3, capMin: 1, capMax: 10, onBattery: true, active: true, boostSupported: true, boost: false, boostUntil: null, baseCap: 30, effectiveCap: 3, working: 2 });
  assert.deepEqual(Core.cleanBattery({ mode: 'weird', cap: 99, onBattery: 'yes', active: 1, baseCap: 0, effectiveCap: 'x', working: -4 }),
    { mode: 'auto', cap: 3, capMin: 1, capMax: 10, onBattery: false, active: false, boostSupported: false, boost: false, boostUntil: null, baseCap: 30, effectiveCap: 30, working: null });
  for (const bad of [null, undefined, 'x', 7, []]) assert.equal(Core.cleanBattery(bad), null);
  assert.equal(Core.cleanBattery(batteryAnswer({ mode: 'off' })).mode, 'off');
});

test('a tap the computer has not confirmed yet is laid over its answer, and what applies now follows', () => {
  const base = Core.cleanBattery(batteryAnswer());
  assert.equal(Core.batteryWith(null, { mode: 'off' }), null);
  assert.deepEqual(Core.batteryWith(base, null), base);
  const raised = Core.batteryWith(base, { cap: 6 });
  assert.deepEqual([raised.mode, raised.cap, raised.active, raised.effectiveCap], ['auto', 6, true, 6]);
  const off = Core.batteryWith(base, { mode: 'off' });
  assert.deepEqual([off.mode, off.cap, off.active, off.effectiveCap], ['off', 3, false, 30]);
  // On the mains nothing is limited whatever the number.
  const plugged = Core.batteryWith(Core.cleanBattery(batteryAnswer({ onBattery: false, active: false, effectiveCap: 30 })), { cap: 2 });
  assert.deepEqual([plugged.active, plugged.effectiveCap], [false, 30]);
  assert.equal(base.cap, 3);   // the confirmed answer is never edited in place
});

test('the one-line state says power, the limit and why, in plain words', () => {
  assert.equal(Core.batteryState(null), '');
  assert.equal(Core.batteryState(Core.cleanBattery(batteryAnswer())), '电池供电。同时最多开 3 个会话，多的新活排队，现在 2 个在干活。');
  assert.equal(Core.batteryState(Core.cleanBattery(batteryAnswer({ mode: 'off', active: false, effectiveCap: 30, working: null }))), '电池供电。电池模式已关，不限制。');
  assert.equal(Core.batteryState(Core.cleanBattery(batteryAnswer({ onBattery: false, active: false, effectiveCap: 30, cap: 5, working: 0 }))), '接着电源。现在不限制；改成电池供电后，同时最多开 5 个会话，现在 0 个在干活。');
});

test('a refused or failed change is explained, an old build says it is old', () => {
  assert.match(Core.batteryRefusal({ timedOut: true }, 'Mac'), /Mac 没有及时回应/);
  assert.match(Core.batteryRefusal({ failed: true }, 'Mac'), /连不上 Mac/);
  assert.match(Core.batteryRefusal({ status: 401 }, 'Mac'), /需要重新登录/);
  assert.match(Core.batteryRefusal({ status: 404 }, 'Mac'), /Mac 的 AgentDeck 是旧版/);
  assert.equal(Core.batteryRefusal({ status: 400, body: { error: 'cap 要是 1–10 的整数。\n' } }, 'Mac'), 'cap 要是 1–10 的整数。 ');
  assert.equal(Core.batteryRefusal({ status: 500, body: {} }, 'Mac'), 'Mac 没有改成。');
});

test('the settings sheet is wired for icon actions: gear to open, × to close, − and + for the limit, all named', () => {
  const html = fs.readFileSync(path.join(__dirname, '../mobile-web/hub/index.html'), 'utf8');
  assert.match(html, /<button id="settings-open" class="icon-button" type="button" title="设置" aria-label="设置" aria-haspopup="dialog">/);
  const app = fs.readFileSync(path.join(__dirname, '../mobile-web/hub/app.js'), 'utf8');
  assert.match(app, /\['settings-open', 'gear'\]/);
  assert.match(app, /iconButton\('minus', '减少电池并发上限', 'step'\), more = iconButton\('plus', '增加电池并发上限', 'step'\)/);
  assert.match(app, /const close = iconButton\('close', '关闭'\); close\.dataset\.action = 'close';[\s\S]{0,120}settings\.close\(\)/);
  assert.match(app, /setAttribute\('role', 'radiogroup'\)[\s\S]*setAttribute\('aria-checked'/);
  // An old computer (404) gets words, not controls.
  assert.match(app, /还是旧版，更新到新版后才能在这里调整电池模式/);
  assert.match(app, /request\(m, 'api\/battery'\)/);
  assert.match(app, /post\(m, 'api\/battery', sending\)/);
  // Tap targets: the stepper buttons are icon buttons (44px); the segments are at least 44px tall.
  const css = fs.readFileSync(path.join(__dirname, '../mobile-web/hub/style.css'), 'utf8');
  assert.match(css, /\.segment \{ min-height: 44px;/);
  assert.match(css, /\.icon-button \{[^}]*width: 44px; height: 44px;/);
});

test('boost on the phone: an older build shows no control, a tap is laid over the answer, the end time reads plainly', () => {
  assert.equal(Core.cleanBattery({ mode: 'auto', cap: 3, onBattery: true, active: true }).boostSupported, false);
  const base = Core.cleanBattery(batteryAnswer());
  assert.deepEqual([base.boostSupported, base.boost, base.boostUntil], [true, false, null]);
  const on = Core.batteryWith(base, { boost: true });
  assert.deepEqual([on.boost, on.boostUntil, on.effectiveCap], [true, null, 30]);
  const timed = Core.batteryWith(base, { boost: true, boostMinutes: 120 });
  assert.ok(timed.boostUntil > Date.now() + 119 * 60000 && timed.boostUntil <= Date.now() + 120 * 60000);
  assert.equal(Core.batteryWith(Core.cleanBattery(batteryAnswer({ boost: true, effectiveCap: 30 })), { boost: false }).effectiveCap, 3);
  // Nothing limits on the mains or with the mode off, so a boost shows as off there.
  assert.equal(Core.batteryWith(Core.cleanBattery(batteryAnswer({ boost: true })), { mode: 'off' }).boost, false);
  assert.equal(Core.batteryWith(Core.cleanBattery(batteryAnswer({ onBattery: false, active: false, boost: true })), null).boost, false);
  assert.match(Core.batteryState(Core.cleanBattery(batteryAnswer({ boost: true, effectiveCap: 30 }))), /^电池供电。已临时拉满：同时最多开 30 个会话，不受省电上限 3 限制，现在 2 个在干活。$/);
  assert.equal(Core.boostEndText(null), '直到取消或接电源');
  assert.equal(Core.boostEndText(new Date(2026, 9, 8, 23, 59).getTime()), '到 23:59');
  assert.equal(Core.minutesToEndOfDay(new Date(2026, 9, 8, 23, 0).getTime()), 59);
  assert.equal(Core.minutesToEndOfDay(new Date(2026, 9, 8, 23, 59, 30).getTime()), 1);
  const app = fs.readFileSync(path.join(__dirname, '../mobile-web/hub/app.js'), 'utf8');
  assert.match(app, /iconButton\('close', `取消 \$\{m\.label\} 的临时拉满`, 'boost-cancel'\)/);
  assert.match(app, /if \(view\.boostSupported\) block\.append\(boostBox\(m, view\)\)/);
});
