'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');

function world(saved) {
  let now = 10_000_000, composing = false, sent = true;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd: 'codex' };
  const columns = [captain, worker], prompts = [];
  const s = saved || { colId: 'captain', gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] };
  const terms = new Map([[worker.id, { alive: true, state: 'working', lastOutputAt: now, lastScreen: '' }]]);
  const window = { MainCore: M, BoardCore: B, ChatUI: {
    updateCard() {}, turnsOf: () => [], sendPrompt: async (...args) => { prompts.push(args); return sent; },
  } };
  const context = vm.createContext({ window, Date: class extends Date { static now() { return now; } } });
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8')
    .replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; }, remindMissingListener, normalize };\n  window.MainSession = {');
  vm.runInContext(source, context);
  window.__test.setHost({ config: { mainSession: s }, terms, columns: () => columns, saveConfig() {},
    columnLabel: (c) => c.id, userComposing: () => composing, agentInForeground: async () => true });
  const api = window.MainSession;
  function task(status = 'working') {
    const t = { id: 'task-' + s.tasks.length, colId: worker.id, gen: 1, status, title: 'probe', startedAt: now, sentAt: now };
    s.tasks.push(t); return t;
  }
  return { api, s, worker, captain, terms, prompts, task,
    relay() { s.colId = captain.id = 'captain-new'; },
    advance(ms) { now += ms; }, input(value) { composing = value; }, sent(value) { sent = value; },
    restore() { window.__test.normalize(); },
    tick() { api.onTick(worker.id, terms.get(worker.id)); },
    remind(entry = { alive: true, state: 'done', lastScreen: '' }) { window.__test.remindMissingListener(entry); },
  };
}

for (const [screen, reason] of [
  ["You've hit your usage limit", 'quota'], ['API Error: 401 Unauthorized', 'auth'], ['429 Too many requests', 'rate_limit'],
]) test(reason + ' is an immediate distinct abnormal receipt, deduplicated across tasks and restored state', async () => {
  const w = world(), t = w.task();
  Object.assign(w.terms.get('worker'), { state: 'quota', lastScreen: screen });
  w.tick(); w.tick();
  assert.equal(t.status, 'failed');
  assert.equal(w.s.pending.length, 1); assert.equal(w.s.pending[0].anomaly, reason);
  const read = await w.api.handle({ action: 'main-receipts', wait: true }, w.captain);
  assert.match(read.result, /异常回执/); assert.match(read.result, new RegExp(screen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const restored = world(JSON.parse(JSON.stringify(w.s)));
  restored.restore();
  Object.assign(restored.terms.get('worker'), { state: 'quota', lastScreen: screen });
  const next = restored.task(); restored.tick();
  assert.equal(next.status, 'failed'); assert.equal(restored.s.pending.length, 0);
});

for (const code of [0, 7, 137]) test('exit ' + code + ' before receipt immediately reports failure even with a surviving shell', async () => {
  const w = world(), t = w.task();
  await w.api.submit({ action: 'session-exit', code }, w.worker);
  assert.equal(t.status, 'failed'); assert.match(t.receipt.failed, new RegExp('exit ' + code));
  assert.equal(w.s.pending[0].anomaly, 'process');
  await w.api.submit({ action: 'session-exit', code }, w.worker);
  assert.equal(w.s.pending.length, 1);
});

test('PTY death reports once; a completed task does not acquire an exit failure', async () => {
  const w = world(), t = w.task();
  Object.assign(w.terms.get('worker'), { alive: false, exitReason: 'PTY exit 9' });
  w.tick(); w.tick();
  assert.equal(t.status, 'failed'); assert.equal(w.s.pending.length, 1);
  const next = w.task();
  await w.api.submit({ action: 'complete', result: 'finished' }, w.worker);
  await w.api.submit({ action: 'session-exit', code: 0 }, w.worker);
  assert.equal(next.status, 'done'); assert.equal(next.receipt.summary, 'finished');
});

for (const status of ['queued', 'working']) test(status + ' confirmation/permission prompt is once per session, including after answer and repeat', () => {
  const w = world(), t = w.task(status);
  Object.assign(w.terms.get('worker'), { state: 'input', lastScreen: 'Allow tool? [y/n]' });
  w.tick(); w.tick();
  assert.equal(w.s.pending.length, 1); assert.equal(w.s.pending[0].anomaly, 'input');
  assert.match(M.receiptsForModel(w.s.pending), /确认\/权限提示/);
  w.terms.get('worker').state = 'working'; w.tick();
  w.terms.get('worker').state = 'input'; w.tick();
  assert.equal(w.s.pending.length, 1); assert.notEqual(t.status, 'failed');
});

test('silence thresholds vary by agent, all exceed ten minutes; no output is provisional and deduplicated', () => {
  for (const cmd of ['claude', 'codex', 'agy', 'gemini', 'cursor-agent', 'unknown']) assert.ok(M.silenceTimeout(cmd) > 10 * 60_000);
  assert.equal(M.silenceTimeout('cursor-agent --model claude-opus-5-5'), 15 * 60_000);
  assert.equal(M.silenceTimeout('agy --model claude-sonnet-5-5'), 15 * 60_000);
  assert.notEqual(M.silenceTimeout('codex'), M.silenceTimeout('cursor-agent'));
  const w = world(), t = w.task(), limit = M.silenceTimeout(w.worker.cmd);
  w.advance(limit - 1); w.tick(); assert.equal(w.s.pending.length, 0);
  w.advance(1); w.tick();
  assert.equal(w.s.pending.length, 1); assert.equal(w.s.pending[0].anomaly, 'no_output');
  assert.equal(t.status, 'working'); assert.equal(t.receipt, undefined);
  w.tick(); w.advance(limit); w.tick(); assert.equal(w.s.pending.length, 1);
});

test('fresh output postpones the silence deadline, input/asking/paused and finished tasks do not warn', () => {
  const w = world(); w.task(); w.advance(29 * 60_000);
  w.terms.get('worker').lastOutputAt += 29 * 60_000;
  w.advance(60_000); w.tick(); assert.equal(w.s.pending.length, 0);
  for (const status of ['input', 'asking', 'paused', 'done']) {
    const q = world(); q.task(status); q.advance(60 * 60_000);
    if (status === 'input') q.terms.get('worker').state = 'input';
    q.tick(); assert.equal(q.s.pending.filter((p) => p.anomaly === 'no_output').length, 0);
  }
});

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
test('missing listener wakes once only after three minutes of unread receipts and never sends a user draft', async () => {
  const w = world();
  w.s.pending.push({ ts: 10_000_000, summary: 'PRIVATE RECEIPT' });
  await w.api.handle({ action: 'main-receipt-listener-status', alive: false }, w.captain);
  w.advance(179_000);
  await w.api.handle({ action: 'main-receipt-listener-status', alive: false }, w.captain);
  w.remind(); await flush(); assert.equal(w.prompts.length, 0);
  w.advance(1000); w.input(true); w.remind(); await flush(); assert.equal(w.prompts.length, 0);
  w.input(false); w.remind(); await flush(); w.remind(); await flush();
  assert.equal(w.prompts.length, 1); assert.equal(w.prompts[0][3].guardUserInput, true);
  assert.ok(!w.prompts[0][3].prefix.includes('PRIVATE RECEIPT'));
  await w.api.handle({ action: 'main-receipt-listener-status', alive: true }, w.captain);
  w.remind(); await flush(); assert.equal(w.prompts.length, 1);
  await w.api.handle({ action: 'main-receipt-listener-status', alive: false }, w.captain);
  w.remind(); await flush(); assert.equal(w.prompts.length, 2);
});

test('listener watchdog waits while captain is busy, and retries a declined guarded send', async () => {
  const w = world(); w.s.pending.push({ ts: 1, summary: 'pending' });
  await w.api.handle({ action: 'main-receipt-listener-status', alive: false }, w.captain);
  w.remind({ alive: true, state: 'working' }); await flush(); assert.equal(w.prompts.length, 0);
  w.sent(false); w.remind(); await flush();
  w.sent(true); w.remind(); await flush();
  assert.equal(w.prompts.length, 2);
  w.remind(); await flush(); assert.equal(w.prompts.length, 2);
});

for (const kind of ['command-exit', 'PTY-death', 'quota']) test('a prior no-command fallback cannot hide later ' + kind, async () => {
  const w = world(), t = w.task('stopped');
  t.receipt = { source: 'fallback', summary: '已结束，未提交回执' };
  w.s.pending.push({ taskId: t.id, source: 'fallback', summary: t.receipt.summary });
  if (kind === 'command-exit') await w.api.submit({ action: 'session-exit', code: 0 }, w.worker);
  else {
    Object.assign(w.terms.get('worker'), kind === 'PTY-death' ? { alive: false } : { state: 'quota', lastScreen: 'API Error: 401 Unauthorized' });
    w.tick();
  }
  assert.equal(t.status, 'failed'); assert.equal(w.s.pending.length, 1);
  assert.equal(w.s.pending[0].anomaly, kind === 'quota' ? 'auth' : 'process');
});

test('a new Captain with unread receipts gets its own missing-listener reminder after Relay', async () => {
  const w = world(); w.s.pending.push({ ts: 1, summary: 'pending' });
  await w.api.handle({ action: 'main-receipt-listener-status', alive: false }, w.captain);
  w.remind(); await flush(); assert.equal(w.prompts.length, 1);
  w.relay();
  await w.api.handle({ action: 'main-receipt-listener-status', alive: false }, w.captain);
  w.remind(); await flush(); assert.equal(w.prompts.length, 2);
});
