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
    { id: 'k2', ts: t + 2000, kind: 'task', task: { title: '文档', summary: '写好了', failed: false }, done: true },
    { id: 'n1', ts: t + 3000, kind: 'notice', reply: '回执已送达', done: true },
    { id: 'r1', ts: t + 4000, reply: '进度如下', steps: ['读看板'], done: true },
    { id: 'u2', ts: t + 5000, user: '再查一次', reply: '', done: false },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].user, '看一下进度');
  assert.deepEqual(groups[0].replies, ['进度如下']);
  assert.equal(groups[0].tasks.length, 2);
  assert.deepEqual(groups[0].steps, ['回执已送达', '读看板']);
  assert.equal(Core.processSummary(groups[0]), '过程：派了 2 件活，收到 1 份回执，2 步操作');
  assert.equal(groups[1].pending, true);
  assert.equal(Core.processSummary(groups[1]), '');
});

test('a reply that arrives long after the last message starts its own round, and odd turns are ignored', () => {
  const t = 1_000_000;
  const groups = Core.groupTurns([null, 'x', { id: 'u1', ts: t, user: '问', reply: '答', done: true }, { id: 'r2', ts: t + 31 * 60000, reply: '稍后的回执', done: true }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].user, '');
  assert.deepEqual(groups[1].replies, ['稍后的回执']);
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
