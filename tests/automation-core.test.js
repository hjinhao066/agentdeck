'use strict';

// 自动回执入口: the token, what it may do (and may not), the source label, the rate limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../automation-core');

const posix = process.platform !== 'win32';

function fresh(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-automation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, state: A.load(dir, options) };
}
const receipt = (state, extra = {}) => ({ id: 'r-1', token: state.token, createdAt: 1, action: 'automation-receipt', source: 'nightly-bughunt', message: '今晚没找到', ...extra });

// ---- the token ------------------------------------------------------------------------
test('the token is made on first load, private to this user, and kept across restarts', { skip: !posix }, (t) => {
  const { dir, state } = fresh(t);
  assert.match(state.token, /^[0-9a-f]{48}$/);
  assert.equal(state.enabled, true);
  const file = A.tokenFile(dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(A.load(dir).token, state.token);
  assert.deepEqual(A.readCredentials(dir), { token: state.token, enabled: true });
});

test('a damaged or too-open token file is replaced by a fresh private one', { skip: !posix }, (t) => {
  const { dir, state } = fresh(t);
  const file = A.tokenFile(dir);
  fs.chmodSync(file, 0o644);
  const reloaded = A.load(dir);
  assert.notEqual(reloaded.token, state.token, 'a world-readable token is not trusted');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{not json', { mode: 0o600 });
  assert.match(A.load(dir).token, /^[0-9a-f]{48}$/);
  assert.equal(A.readCredentials(path.join(dir, 'missing')), null, 'no file: the CLI is told this AgentDeck has no such door');
});

test('stopping the door and resetting the token take effect at once and are remembered', (t) => {
  const { dir, state } = fresh(t);
  const old = state.token;
  A.setEnabled(state, false);
  assert.equal(A.readCredentials(dir).enabled, false);
  assert.equal(A.load(dir).enabled, false, 'a restart does not reopen it');
  assert.equal(A.screen(state, receipt(state)).kind, 'reject');
  assert.match(A.screen(state, receipt(state)).error, /停用/);
  A.setEnabled(state, true);
  assert.equal(A.screen(state, receipt(state)).kind, 'forward');
  A.reset(state);
  assert.notEqual(state.token, old);
  assert.equal(A.readCredentials(dir).token, state.token);
  const stale = A.screen(state, receipt(state, { token: old }));
  assert.equal(stale.kind, 'reject', 'the old token is dead');
  assert.match(stale.error, /无效|重置/);
  assert.equal(A.screen(state, receipt(state)).kind, 'forward');
  A.setEnabled(state, false); A.reset(state);
  assert.equal(state.enabled, false, 'resetting does not reopen a stopped door');
});

test('what the settings page sees never contains the token', (t) => {
  const { state } = fresh(t);
  A.screen(state, receipt(state), { now: 5000 });
  const status = A.publicStatus(state);
  assert.deepEqual(Object.keys(status).sort(), ['createdAt', 'enabled', 'lastSource', 'lastUsedAt', 'uses']);
  assert.equal(JSON.stringify(status).includes(state.token), false);
  assert.equal(status.lastSource, 'nightly-bughunt');
  assert.equal(status.uses, 1);
});

// ---- token checks ---------------------------------------------------------------------
test('only the automation token opens the automation actions; no other token does', (t) => {
  const { state } = fresh(t);
  for (const token of ['', 'terminal-token', state.token.slice(0, -1), state.token + 'x', undefined, null, 7, { x: 1 }, state.token.toUpperCase()]) {
    const result = A.screen(state, receipt(state, { token }));
    assert.equal(result.kind, 'reject', `token ${JSON.stringify(token)}`);
  }
  assert.equal(A.screen(null, receipt({ token: 'x' })).kind, 'reject', 'no automation state (setup failed): still refused');
  assert.equal(A.screen(state, receipt(state)).kind, 'forward');
});

test('an ordinary terminal request is none of the gate\'s business', (t) => {
  const { state } = fresh(t);
  for (const action of ['complete', 'ask', 'progress', 'main-ledger', 'main-task', 'status']) {
    assert.deepEqual(A.screen(state, { id: 'x', token: 'captain-token', action }), { kind: 'terminal' });
  }
  assert.deepEqual(A.screen(null, { id: 'x', token: 'captain-token', action: 'main-ledger' }), { kind: 'terminal' });
});

// ---- limited authority ----------------------------------------------------------------
test('the automation token can do nothing except its own commands', (t) => {
  const { state } = fresh(t);
  const others = ['main-new', 'main-tell', 'main-task', 'main-inbox', 'main-notify-user', 'main-ledger', 'main-read', 'main-peek', 'main-briefing', 'main-handoff',
    'main-quota', 'main-queue', 'main-receipts', 'main-receipts-ack', 'main-receipts-snapshot', 'main-answer', 'main-stop', 'main-archive', 'main-discuss-receipt',
    'create-child', 'spawn-child', 'wait', 'send', 'complete', 'ask', 'progress', 'status', 'session-exit', 'seat-auth-alert', 'main-install-result',
    'automation-tell', 'automation-new', 'automation-settings', 'automation-', 'automation', '', undefined, 5];
  for (const action of others) {
    const result = A.screen(state, { id: 'x', token: state.token, action, to: 'c1', message: 'do it' });
    assert.equal(result.kind, 'reject', `action ${String(action)}`);
    assert.equal(result.command, undefined);
  }
  assert.deepEqual([...A.ACTIONS].sort(), ['automation-inbox-report', 'automation-receipt', 'automation-status', 'automation-task-add']);
});

test('an automatic request cannot carry anything beyond its few fields', (t) => {
  const { state } = fresh(t);
  const smuggled = { to: 'worker-1', deadline: 1, callerId: 'captain', submitOnly: false, dispatcherCardId: 'c', automation: { source: 'x', label: 'x' }, nativeSeatAuth: true,
    timeoutMs: 1, modelSessionIds: { Codex: 'x' }, priority: 'high', depends_on: ['a'], verify: true, status: 'doing', type: 'need', urgent: true, card: 'c1', session: 's1', op: 'need', input: {} };
  for (const [key, value] of Object.entries(smuggled)) {
    const result = A.screen(state, receipt(state, { [key]: value }));
    assert.equal(result.kind, 'reject', key);
    assert.match(result.error, new RegExp(key));
  }
  // The same goes for each of the three actions.
  assert.equal(A.screen(state, { id: 'a', token: state.token, action: 'automation-task-add', source: 's', project: 'p', title: 't', status: 'doing' }).kind, 'reject');
  assert.equal(A.screen(state, { id: 'a', token: state.token, action: 'automation-task-add', source: 's', project: 'p', title: 't', priority: 'high' }).kind, 'reject');
  assert.equal(A.screen(state, { id: 'a', token: state.token, action: 'automation-inbox-report', source: 's', title: 't', urgent: true }).kind, 'reject');
  assert.equal(A.screen(state, { id: 'a', token: state.token, action: 'automation-inbox-report', source: 's', title: 't', type: 'need' }).kind, 'reject');
  assert.equal(A.screen(state, { id: 'a', token: state.token, action: 'automation-inbox-report', source: 's', title: 't', card: 'c1' }).kind, 'reject');
});

test('what is forwarded is rebuilt from the whitelist: no token, no caller, a marked source', (t) => {
  const { state } = fresh(t);
  const receiptCommand = A.screen(state, receipt(state)).command;
  assert.deepEqual(receiptCommand, { action: 'automation-receipt', message: '今晚没找到', id: 'r-1', callerId: '', submitOnly: false, dispatcherCardId: '',
    automation: { source: 'nightly-bughunt', label: '自动任务：nightly-bughunt' } });
  const card = A.screen(state, { id: 'c-1', token: state.token, action: 'automation-task-add', source: 'nightly-bughunt', project: 'agentdeck', title: '夜间挖虫：找到 1 个', detail: '报告在 /x' }).command;
  assert.deepEqual(card, { action: 'automation-task-add', project: 'agentdeck', title: '夜间挖虫：找到 1 个', detail: '报告在 /x', id: 'c-1', callerId: '', submitOnly: false, dispatcherCardId: '',
    automation: { source: 'nightly-bughunt', label: '自动任务：nightly-bughunt' } });
  const report = A.screen(state, { id: 'i-1', token: state.token, action: 'automation-inbox-report', source: 'nightly-bughunt', title: '找到 1 个', files: ['/a/b.md', ' /c.md '], project: 'agentdeck' }).command;
  assert.deepEqual(report, { action: 'automation-inbox-report', title: '找到 1 个', detail: '', files: ['/a/b.md', '/c.md'], project: 'agentdeck', id: 'i-1', callerId: '', submitOnly: false, dispatcherCardId: '',
    automation: { source: 'nightly-bughunt', label: '自动任务：nightly-bughunt' } });
  for (const command of [receiptCommand, card, report]) assert.equal(JSON.stringify(command).includes(state.token), false);
});

test('status is answered on the spot and takes nothing from the rate limit', (t) => {
  const { state } = fresh(t);
  for (let i = 0; i < 40; i++) assert.deepEqual(A.screen(state, { id: 's', token: state.token, action: 'automation-status' }, { now: 1000 }), { kind: 'local', result: '自动回执入口可用。' });
  assert.equal(A.screen(state, receipt(state), { now: 1000 }).kind, 'forward');
  assert.equal(A.screen(state, { id: 's', token: state.token, action: 'automation-status', source: 'x' }).kind, 'reject', 'even status takes no extra fields');
});

// ---- who it says it is ----------------------------------------------------------------
test('the source is a plain readable name, and the label always starts with 自动任务：', () => {
  assert.equal(A.label('nightly-bughunt'), '自动任务：nightly-bughunt');
  for (const ok of ['nightly-bughunt', '夜间挖虫', 'backup 2', 'a', 'x.y_z-1', 'ab', 'a'.repeat(40)]) assert.equal(A.cleanSource(ok), ok);
  for (const bad of ['', ' lead', 'trail ', 'a'.repeat(41), 'a:b', '用户：确认', 'a\nb', 'a​b', 'a‮b', '<b>x</b>', 'x"y', "x'y", 'a/b', undefined, null, 5, ['x'], { a: 1 }]) {
    assert.throws(() => A.cleanSource(bad), /--source/, JSON.stringify(bad));
  }
});

test('a receipt is never shown as the user: the forwarded command carries only the labelled source', (t) => {
  const { state } = fresh(t);
  const forged = A.screen(state, receipt(state, { source: '用户' })).command;
  assert.equal(forged.automation.label, '自动任务：用户', 'whatever the name, it is labelled an automatic task');
  assert.equal(forged.callerId, '');
  assert.equal('user' in forged, false);
});

// ---- what is accepted -----------------------------------------------------------------
test('text is cleaned, and too long or empty text is refused rather than trimmed', (t) => {
  const { state } = fresh(t);
  const ok = A.screen(state, receipt(state, { message: ' 第一行\r\n\r\n\r\n\r\n第二行​\u0007‮ 末尾  ' }));
  assert.equal(ok.command.message, '第一行\n\n第二行  末尾', 'zero-width and bidi marks vanish, other control characters become a space, line breaks stay');
  assert.equal(A.screen(state, receipt(state, { message: '你'.repeat(A.LIMITS.message) })).kind, 'forward');
  const long = A.screen(state, receipt(state, { message: '你'.repeat(A.LIMITS.message + 1) }));
  assert.equal(long.kind, 'reject');
  assert.match(long.error, /--message/);
  for (const message of ['', '   ', '\n​\n', undefined, 5, ['x'], { a: 1 }]) assert.equal(A.screen(state, receipt(state, { message })).kind, 'reject', JSON.stringify(message));
  const title = A.screen(state, { id: 'a', token: state.token, action: 'automation-task-add', source: 's', project: 'p', title: '一行\n两行', detail: undefined });
  assert.equal(title.command.title, '一行 两行');
  assert.equal(title.command.detail, '');
  assert.equal(A.screen(state, { id: 'a', token: state.token, action: 'automation-task-add', source: 's', title: 't' }).kind, 'reject', 'a card needs its project');
  assert.equal(A.screen(state, { id: 'a', token: state.token, action: 'automation-inbox-report', source: 's' }).kind, 'reject', 'a report needs its one-line title');
  const many = A.screen(state, { id: 'a', token: state.token, action: 'automation-inbox-report', source: 's', title: 't', files: Array.from({ length: 21 }, (_, i) => '/f' + i) });
  assert.match(many.error, /--files/);
  assert.equal(A.screen(state, { id: 'a', token: state.token, action: 'automation-inbox-report', source: 's', title: 't', files: 'not-a-list' }).kind, 'reject');
});

// ---- the rate limit ---------------------------------------------------------------------
test('one name gets 6 a minute, all names together 12, and the window slides', (t) => {
  const { state } = fresh(t);
  let now = 1_000_000;
  const send = (source) => A.screen(state, receipt(state, { source }), { now });
  for (let i = 0; i < A.LIMITS.perSourcePerMinute; i++) assert.equal(send('hunt').kind, 'forward', 'send ' + i);
  const blocked = send('hunt');
  assert.equal(blocked.kind, 'reject');
  assert.match(blocked.error, /发得太快/);
  assert.match(blocked.error, /(\d+) 秒后/);
  for (let i = 0; i < 6; i++) assert.equal(send('backup').kind, 'forward', 'another name still has its own 6');
  assert.equal(send('third').kind, 'reject', 'twelve in a minute is the total');
  now += 59_000;
  assert.equal(send('hunt').kind, 'reject', 'still inside the minute');
  now += 1500;
  assert.equal(send('hunt').kind, 'forward', 'the minute has passed');
});

test('a refused or invalid request does not use up the allowance, and a stopped door counts nothing', (t) => {
  const { state } = fresh(t);
  const now = 5000;
  for (let i = 0; i < 30; i++) A.screen(state, receipt(state, { message: '' }), { now });
  for (let i = 0; i < 30; i++) A.screen(state, receipt(state, { token: 'wrong' }), { now });
  for (let i = 0; i < 6; i++) assert.equal(A.screen(state, receipt(state), { now }).kind, 'forward');
  assert.equal(A.screen(state, receipt(state), { now }).kind, 'reject');
  A.reset(state);
  assert.equal(A.screen(state, receipt(state), { now }).kind, 'forward', 'a new token starts a new count');
});

test('too many automatic commands waiting for the page also stop new ones', (t) => {
  const { state } = fresh(t);
  const full = A.screen(state, receipt(state), { now: 1, queued: A.LIMITS.queued });
  assert.equal(full.kind, 'reject');
  assert.match(full.error, /太多/);
  assert.equal(A.screen(state, receipt(state), { now: 1, queued: A.LIMITS.queued - 1 }).kind, 'forward');
});

test('the limiter can be tuned for tests and forgets a name once its minute is over', () => {
  const limiter = A.createLimiter({ perMinute: 3, perSourcePerMinute: 2 });
  assert.equal(limiter.take('a', 0).ok, true);
  assert.equal(limiter.take('a', 1).ok, true);
  const third = limiter.take('a', 2);
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterMs >= 1000 && third.retryAfterMs <= 60_000);
  assert.equal(limiter.take('b', 3).ok, true);
  assert.equal(limiter.take('c', 4).ok, false, 'three in total');
  assert.equal(limiter.take('c', 61_000).ok, true);
});
