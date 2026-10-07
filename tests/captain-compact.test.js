'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../main-core');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ready = (overrides = {}) => M.compactReady({ provider: 'Claude', used: 450000,
  settings: M.tokenSaverSettings(), idle: true, pending: false, inflight: false,
  questions: false, mobile: false, cooldownUntil: 0, failed: false, now: 10000, ...overrides });

test('compact defaults to 450k below the 600k clearing fallback and validates saved thresholds', () => {
  assert.deepEqual(M.tokenSaverSettings(), { enabled: true, threshold: 600000, compactThreshold: 450000 });
  for (const compactThreshold of [0, -1, NaN, Infinity, '450000']) {
    assert.equal(M.tokenSaverSettings({ compactThreshold }).compactThreshold, 450000);
  }
  assert.equal(M.tokenSaverSettings({ threshold: 350000 }).compactThreshold, 349999);
  assert.equal(M.tokenSaverSettings({ threshold: 600000, compactThreshold: 600000 }).compactThreshold, 599999);
  assert.equal(M.tokenSaverSettings({ threshold: 600000, compactThreshold: 900000 }).compactThreshold, 599999);
  assert.equal(M.tokenSaverSettings({ threshold: 600000, compactThreshold: 420000 }).compactThreshold, 420000);
});

test('compact starts at its threshold only for an idle Claude Captain without outstanding work', () => {
  assert.equal(ready(), true);
  assert.equal(ready({ used: 449999 }), false);
  for (const provider of ['Codex', 'Gemini', 'Shell', '']) assert.equal(ready({ provider }), false, provider);
  assert.equal(ready({ settings: M.tokenSaverSettings({ enabled: false }) }), false);
  for (const field of ['pending', 'inflight', 'questions', 'mobile', 'failed']) assert.equal(ready({ [field]: true }), false, field);
  assert.equal(ready({ idle: false }), false);
  for (const used of [null, NaN, Infinity, -1]) assert.equal(ready({ used }), false, String(used));
});

test('compact cooldown expires once and a failed attempt remains suppressed', () => {
  assert.equal(M.COMPACT_COOLDOWN, 30 * 60 * 1000);
  assert.equal(ready({ now: 10000, cooldownUntil: 10001 }), false);
  assert.equal(ready({ now: 10000, cooldownUntil: 10000 }), true);
  assert.equal(ready({ now: 10000, cooldownUntil: 0, failed: true }), false);
});

test('compact completes only after a meaningful fresh token reduction while idle', () => {
  const outcome = (overrides) => M.compactOutcome({ before: 450000, after: 80000, output: '', elapsed: 10000, idle: true, ...overrides });
  assert.equal(outcome(), 'complete');
  assert.equal(outcome({ idle: false }), 'waiting');
  assert.equal(outcome({ after: 450000 }), 'waiting');
  assert.equal(outcome({ after: 449000 }), 'waiting');
  assert.equal(outcome({ before: 10000, after: 9500 }), 'waiting');
  assert.equal(outcome({ after: null }), 'waiting');
  assert.equal(outcome({ after: 500000 }), 'waiting');
});

test('compact failure and timeout report fallback rather than repeatedly retrying', () => {
  assert.equal(M.COMPACT_TIMEOUT, 5 * 60 * 1000);
  const outcome = (overrides) => M.compactOutcome({ before: 450000, after: 450000, output: '', elapsed: 10000, idle: true, ...overrides });
  assert.equal(outcome({ output: 'Error: Compaction failed' }), 'failed');
  assert.equal(outcome({ elapsed: M.COMPACT_TIMEOUT }), 'failed');
  assert.equal(outcome({ elapsed: M.COMPACT_TIMEOUT - 1 }), 'waiting');
});

function session() {
  let now = 100000, used = 500000, composing = false;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const entry = { alive: true, state: 'done', lastOutputAt: 0, lastScreen: '', term: {} };
  const state = { colId: captain.id, cmd: 'claude', gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] };
  const config = { mainSession: state, captainTokenSaver: M.tokenSaverSettings(), captainHistory: [] };
  const turns = [], sends = [], notices = [], snapshots = [];
  const window = {
    MainCore: M, AgentInfo: { inferProvider: (cmd) => cmd === 'claude' ? 'Claude' : 'Codex' },
    ChatUI: { turnsOf: () => turns, readFooter: () => [[{ text: `Context: ${used}/1000000` }]], addNotice: (_id, text) => notices.push(text) },
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
      captainHandoff: (snapshot) => { snapshots.push(snapshot); return Promise.resolve(); } },
  };
  const host = { config, platform: 'darwin', terms: new Map([[captain.id, entry]]), columns: () => [captain],
    userComposing: () => composing, saveConfig() {}, captainTurnStarted() {}, showToast() {},
    sendWhenReady: (col, text, options) => sends.push({ col, text, options }) };
  // Inspect the real renderer functions without exposing them in production or
  // starting a real app, model, board store or background listener.
  const source = fs.readFileSync(path.join(__dirname, '../main-session.js'), 'utf8').replace('  window.MainSession = {', `
  window.__compactTest = {
    setHost: (h) => { host = h; }, tick: tokenSaverTick, idle: saverIdle,
    operation: () => tokenSaving, send: compactSend, step: compactTick,
    setOperation: (op) => { tokenSaving = op; },
    setBusy: (kind) => { briefing = kind === 'briefing'; delivering = kind === 'delivering';
      mobileDelivery = kind === 'mobile'; listenerReminderSending = kind === 'listener'; },
  };
  window.MainSession = {`);
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(source, { window, Date: Clock, Intl, document: {} });
  const api = window.__compactTest;
  api.setHost(host);
  return { api, window, host, state, config, captain, entry, turns, sends, notices, snapshots,
    advance: (ms) => { now += ms; }, setUsed: (n) => { used = n; }, compose: () => { composing = true; },
    tick: () => api.tick(entry), now: () => now,
    async begin() { api.tick(entry); now += 3001; api.tick(entry); await Promise.resolve(); },
  };
}

test('renderer compact gates reject output, tools, input drafts and every nonidle entry state', () => {
  const cases = {
    'recent output': (s) => { s.entry.lastOutputAt = s.now() - 2999; },
    'sending prompt': (s) => { s.entry.sendingPrompt = true; },
    'paste in progress': (s) => { s.entry.injecting = true; },
    'input draft or attachment': (s) => s.compose(),
    'unanswered user message': (s) => s.turns.push({ kind: 'user', done: false, user: 'latest instruction' }),
    'tool result still awaited': (s) => { s.entry.lastScreen = '✻ Doing…'; },
    'queued message still awaited': (s) => { s.entry.lastScreen = 'Press up to edit queued messages'; },
  };
  for (const state of ['working', 'input', 'quota', 'plain', 'exited']) cases[state] = (s) => { s.entry.state = state; };
  for (const kind of ['briefing', 'delivering', 'mobile', 'listener']) cases[kind] = (s) => s.api.setBusy(kind);
  for (const [name, block] of Object.entries(cases)) {
    const s = session(); block(s); s.tick();
    assert.equal(s.api.operation(), null, name);
    assert.equal(s.sends.length, 0, name);
  }
  const idle = session(); idle.tick();
  assert.equal(idle.api.operation().phase, 'compact-queued');
});

test('renderer waits for pending, unread, unconfirmed and carried receipts, questions and mobile messages', () => {
  const cases = {
    pending: (s) => s.state.pending.push({ summary: 'unread' }),
    'unread inflight': (s) => s.state.inflight.push({ summary: 'not delivered' }),
    'unconfirmed channel receipt': (s) => s.state.inflight.push({ summary: 'delivered but not processed', viaChannel: true, takenAt: s.now() }),
    'carried receipt': (s) => { s.state.handoffCarry = { at: s.now(), items: [{ summary: 'relay still outstanding' }] }; },
    question: (s) => s.state.tasks.push({ colId: 'worker', status: 'asking' }),
    confirmation: (s) => s.state.tasks.push({ colId: 'worker', status: 'input' }),
    mobile: (s) => { s.state.mobileMessages = ['fresh phone instruction']; },
  };
  for (const [name, block] of Object.entries(cases)) {
    const s = session(); block(s); s.tick();
    assert.equal(s.api.operation(), null, name);
    assert.equal(s.sends.length, 0, name);
  }
  const dealt = session(); dealt.state.captainSettledAt = dealt.now();
  dealt.state.inflight.push({ viaChannel: true, takenAt: dealt.now() - 1 });
  dealt.state.handoffCarry = { at: dealt.now() - 1, items: [{ summary: 'already processed' }] };
  dealt.tick(); assert.equal(dealt.api.operation().kind, 'compact');
});

test('a receipt or a new user turn cancels a queued compact before snapshot and input', () => {
  for (const incoming of ['receipt', 'user']) {
    const s = session(); s.tick();
    if (incoming === 'receipt') s.state.pending.push({ summary: 'arrived after threshold' });
    else s.turns.push({ user: 'fresh instruction', done: false });
    s.advance(3001); s.tick();
    assert.equal(s.api.operation(), null, incoming);
    assert.equal(s.snapshots.length, 0, incoming);
    assert.equal(s.sends.length, 0, incoming);
  }
});

test('compact send rechecks idle and receipts after async readiness while preserving an atomic paste', async () => {
  for (const incoming of ['receipt', 'draft', 'tool']) {
    const s = session(); await s.begin();
    assert.equal(s.snapshots.length, 1);
    const sent = s.sends.at(-1);
    assert.equal(sent.options.requireIdle, true);
    assert.equal(sent.options.guardUserInput, true);
    assert.equal(sent.options.cancelled(), false);
    if (incoming === 'receipt') s.state.pending.push({ summary: 'late receipt' });
    if (incoming === 'draft') s.compose();
    if (incoming === 'tool') s.entry.lastScreen = '✻ Doing…';
    assert.equal(sent.options.cancelled(), true, incoming);
    assert.equal(s.api.operation(), null, incoming);
  }
  const paste = session(); await paste.begin(); paste.entry.injecting = true; paste.compose();
  assert.equal(paste.sends.at(-1).options.cancelled(), false, 'an already-started AgentDeck paste stays atomic');
});

test('renderer records successful compact, verifies one listener and respects persisted cooldown', async () => {
  const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
  s.setUsed(80000); s.tick();
  assert.equal(s.api.operation().phase, 'compact-check-queued');
  assert.match(s.notices.find((notice) => notice.includes('完成')), /500k → 80k/);
  s.tick();
  assert.match(s.sends.at(-1).text, /^【AgentDeck 压缩后核对】/);
  assert.match(s.sends.at(-1).text, /没有才立即重挂，已有不要重复启动/);
  s.sends.at(-1).options.onSent();
  await s.window.MainSession.handle({ action: 'main-receipt-listener-status', alive: true }, s.captain);
  s.tick(); assert.equal(s.api.operation(), null);
  assert.equal(s.state.compact.cooldownUntil, s.now() + M.COMPACT_COOLDOWN);
  s.setUsed(500000); s.tick(); assert.equal(s.api.operation(), null);
  s.advance(M.COMPACT_COOLDOWN); s.tick(); assert.equal(s.api.operation().kind, 'compact');
});

test('renderer compact errors and unchanged-token timeout each queue exactly one original clearing fallback', async () => {
  for (const failure of ['error', 'timeout']) {
    const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
    if (failure === 'error') s.window.MainSession.onOutput('captain', 'Error: Compaction failed');
    else s.advance(M.COMPACT_TIMEOUT);
    s.tick(); assert.equal(s.api.operation(), null, failure);
    assert.equal(s.state.compact.failed, true, failure);
    assert.equal(s.state.compact.fallback, true, failure);
    assert.equal(s.notices.filter((notice) => notice.includes('失败')).length, 1, failure);
    s.tick(); assert.equal(s.api.operation().phase, 'queued', failure);
    assert.equal(s.api.operation().kind, undefined, failure);
    s.advance(3001); s.tick();
    assert.equal(s.sends.filter((send) => send.text.startsWith('/compact ')).length, 1, failure);
    assert.equal(s.sends.filter((send) => send.text === M.ARCHIVE_PROMPT).length, 1, failure);
  }
});

test('compact remaining above the clearing threshold and missing listener both fall back even after tokens shrink', async () => {
  for (const failure of ['high', 'listener']) {
    const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
    if (failure === 'high') { s.config.captainTokenSaver.threshold = 400000; s.setUsed(420000); }
    else {
      s.setUsed(80000); s.tick(); s.tick(); s.sends.at(-1).options.onSent();
      s.advance(M.COMPACT_TIMEOUT);
    }
    s.tick(); assert.equal(s.state.compact.fallback, true, failure);
    s.tick(); assert.equal(s.api.operation().phase, 'queued', failure);
    assert.equal(s.api.operation().kind, undefined, failure);
  }
});

test('a postcompact receipt releases ordinary delivery and keeps a durable listener check for the next idle gap', async () => {
  const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
  assert.equal(s.state.compact.needsCheck, true);
  s.setUsed(80000); s.tick();
  s.state.pending.push({ summary: 'receipt arrived during compact' });
  s.tick();
  assert.equal(s.api.operation(), null);
  assert.equal(s.state.compact.needsCheck, true);
  s.tick(); assert.equal(s.api.operation(), null, 'pending work wins over listener checks');
  s.state.pending = [];
  s.tick(); assert.equal(s.api.operation().phase, 'compact-check-queued');
  s.tick(); assert.match(s.sends.at(-1).text, /^【AgentDeck 压缩后核对】/);
  assert.equal(s.sends.filter((send) => send.text.startsWith('/compact ')).length, 1);
});

test('a user turn cancelling compact recovery retains the durable check and does not resend compact', async () => {
  const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
  s.setUsed(80000); s.tick();
  s.window.MainSession.onTurnStarted('captain', { id: 'fresh-user', user: 'fresh instruction', ts: s.now() });
  assert.equal(s.api.operation(), null);
  assert.equal(s.state.compact.needsCheck, true);
  s.tick(); assert.equal(s.api.operation().phase, 'compact-check-queued');
  s.tick(); assert.match(s.sends.at(-1).text, /^【AgentDeck 压缩后核对】/);
  assert.equal(s.sends.filter((send) => send.text.startsWith('/compact ')).length, 1);
});

test('legacy receipt injection skips early compact quietly and retains its original clearing fallback', () => {
  const s = session(); s.state.legacyReceiptInjection = true;
  s.tick(); assert.equal(s.api.operation(), null);
  s.state.compact = { needsCheck: true, cooldownUntil: 0, before: 500000 };
  s.tick(); assert.equal(s.state.compact.needsCheck, false);
  assert.equal(s.api.operation(), null);
  s.setUsed(650000); s.tick();
  assert.equal(s.api.operation().phase, 'queued');
  assert.equal(s.api.operation().kind, undefined);
  assert.equal(s.sends.length, 0);
});

test('a canceled in-flight compact preserves its original timeout and falls back if usage never drops', async () => {
  const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
  const sentAt = s.state.compact.sentAt;
  s.window.MainSession.onTurnStarted('captain', { id: 'fresh-user', user: 'new instruction', ts: s.now() });
  assert.equal(s.api.operation(), null);
  assert.equal(s.state.compact.needsOutcome, true);
  s.advance(M.COMPACT_TIMEOUT);
  s.tick();
  assert.equal(s.api.operation().phase, 'compacting');
  assert.equal(s.api.operation().since, sentAt, 'resuming does not restart the five-minute timeout');
  s.tick();
  assert.equal(s.api.operation(), null);
  assert.equal(s.state.compact.fallback, true);
  s.tick(); assert.equal(s.api.operation().phase, 'queued');
  assert.equal(s.sends.filter((send) => send.text.startsWith('/compact ')).length, 1);
  assert.equal(s.sends.filter((send) => send.text.startsWith('【AgentDeck 压缩后核对】')).length, 0);
});

test('a canceled in-flight compact validates its eventual token drop before checking the listener', async () => {
  const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
  s.window.MainSession.onTurnStarted('captain', { id: 'fresh-user', user: 'new instruction', ts: s.now() });
  s.setUsed(80000);
  s.tick(); assert.equal(s.api.operation().phase, 'compacting');
  assert.equal(s.state.compact.needsOutcome, true);
  s.tick(); assert.equal(s.api.operation().phase, 'compact-check-queued');
  assert.equal(s.state.compact.needsOutcome, false);
  assert.match(s.notices.find((notice) => notice.includes('完成')), /500k → 80k/);
  s.tick(); assert.match(s.sends.at(-1).text, /^【AgentDeck 压缩后核对】/);
  assert.equal(s.sends.filter((send) => send.text.startsWith('/compact ')).length, 1);
});

test('background receipt processing settles through the real heartbeat before postcompact recovery resumes', async () => {
  const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
  s.setUsed(80000); s.tick();
  s.state.pending.push({ colId: 'worker', summary: 'background result', ts: s.now() });
  const heartbeat = () => s.window.MainSession.onTick('captain', s.entry);
  heartbeat(); assert.equal(s.api.operation(), null);
  assert.equal(s.state.compact.needsCheck, true);
  const result = await s.window.MainSession.handle({ action: 'main-receipts', wait: true }, s.captain);
  assert.match(result.result, /background result/);
  assert.equal(s.state.pending.length, 0);
  assert.equal(s.state.inflight.length, 1);
  const takenAt = s.state.inflight[0].takenAt;
  s.advance(1); s.entry.state = 'working'; heartbeat();
  assert.equal(s.api.operation(), null, 'an unconfirmed receipt still blocks recovery');
  s.advance(5000); s.entry.state = 'done'; heartbeat();
  assert.ok(s.state.captainSettledAt > takenAt, 'a background tool turn settles without a recorded user turn');
  assert.equal(s.turns.length, 0);
  assert.equal(s.api.operation().phase, 'compact-check-queued');
  heartbeat(); assert.match(s.sends.at(-1).text, /^【AgentDeck 压缩后核对】/);
  assert.equal(s.sends.filter((send) => send.text.startsWith('/compact ')).length, 1);
});

test('a canceled compact validates its outcome with pending receipts, then waits for actual background processing', async () => {
  const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
  s.window.MainSession.onTurnStarted('captain', { id: 'new-user', user: 'new instruction', ts: s.now() });
  s.state.pending.push({ colId: 'worker', summary: 'arrived during interrupted compact', ts: s.now() });
  s.setUsed(80000);
  const heartbeat = () => s.window.MainSession.onTick('captain', s.entry);
  heartbeat(); assert.equal(s.api.operation().phase, 'compacting');
  heartbeat(); assert.equal(s.state.compact.needsOutcome, false);
  assert.equal(s.api.operation().phase, 'compact-check-queued');
  heartbeat(); assert.equal(s.api.operation(), null);
  assert.equal(s.state.compact.needsCheck, true);
  assert.equal(s.sends.filter((send) => send.text.startsWith('【AgentDeck 压缩后核对】')).length, 0);
  await s.window.MainSession.handle({ action: 'main-receipts', wait: true }, s.captain);
  s.advance(1); s.entry.state = 'working'; heartbeat();
  s.advance(5000); s.entry.state = 'done'; heartbeat();
  assert.ok(s.state.captainSettledAt > s.state.inflight[0].takenAt);
  assert.equal(s.api.operation().phase, 'compact-check-queued');
  heartbeat(); assert.match(s.sends.at(-1).text, /^【AgentDeck 压缩后核对】/);
  assert.equal(s.sends.filter((send) => send.text.startsWith('/compact ')).length, 1);
});

test('a missing compact footer times out and clears using its saved precompact size', async () => {
  const s = session(); await s.begin(); s.sends.at(-1).options.onSent();
  s.setUsed(null); s.advance(M.COMPACT_TIMEOUT); s.tick();
  assert.equal(s.state.compact.fallback, true);
  assert.match(s.notices.at(-1), /500k → 未知/);
  s.tick();
  assert.equal(s.api.operation().phase, 'queued');
  assert.equal(s.api.operation().used, 500000);
  s.advance(3001); s.tick();
  assert.equal(s.sends.at(-1).text, M.ARCHIVE_PROMPT);
});

test('canceling an unsent compact does not immediately retry below the clear threshold', () => {
  const s = session(); s.setUsed(450000); s.tick();
  s.window.MainSession.onTurnStarted('captain', { id: 'new-user', user: 'new instruction', ts: s.now() });
  s.tick(); assert.equal(s.api.operation(), null);
  s.setUsed(440000); s.tick();
  s.setUsed(500000); s.tick();
  assert.equal(s.api.operation().phase, 'compact-queued');
});
