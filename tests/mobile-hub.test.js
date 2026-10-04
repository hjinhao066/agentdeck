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
