'use strict';
// Hub merge rule: the agent's own `complete` is authoritative over a guess another
// machine wrote meanwhile, and a finished card is not claimed again. The incident data
// is card t-6e1bb640 of 2026-10-09 (hermes-board), with names and texts made generic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SharedStore } = require('../shared-store');
const { startSyncServer } = require('../sync-server');
const { FleetClient } = require('../sync-client');
const { TaskStore } = require('../task-board');

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const event = (attempt, type, source, message) => `${attempt}:${type}:${source}:${hash(message)}`;

// What the two machines wrote on that card.
const ATTEMPT_A = '1791569024306-56576-2fb88cd6e6c7';   // Mac, the run that really finished
const ATTEMPT_B = '1791570939403-61804-d1d1498bbc30';   // Windows, started 31 minutes later
const COMPLETE_A = event(ATTEMPT_A, 'complete', 'command', 'result of the run');
const FALLBACK_B = event(ATTEMPT_B, 'fallback', 'fallback', '');
const RECEIPT_A = 'twelve cards: eight closed, two moving, two waiting for the user';
const CLAIM_B = { key: '41e3d91d-3fba-4116-a674-da7e3de669b7', owner: 'host-win', delivered: true, created: '2026-10-09T18:35:39.685Z' };
const CARD = 't-6e1bb640-1b9b-4c09-95db-2e7209dc012e';
const OPUS = { agent: 'Claude', model: 'claude-opus-5-5' };

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hub-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function hub(t) {
  const file = path.join(tmp(t), 'hub', 'store.json');
  let now = Date.parse('2026-10-09T18:03:25.000Z');
  const store = new SharedStore({ file, now: () => now });
  let n = 0;
  const push = (deviceId, expectedRevision, set, opId) => store.pushTask({ opId: opId || `op-${deviceId}-${++n}-${expectedRevision}`, cardId: CARD, expectedRevision, deviceId, set });
  return { store, file, push, advance: (ms) => { now += ms; }, reload: () => new SharedStore({ file, now: () => now }) };
}
// The card as both machines had it at revision 4: a run of attempt A is in progress on the Mac.
function running(h, attempt = ATTEMPT_A) {
  h.push('dev-mac', 0, { project: 'hermes-board', title: 'generic task', detail: 'handed over', status: 'todo', assignee: OPUS, important: true, created: '2026-10-09T18:03:25.844Z' });
  h.push('dev-mac', 1, { status: 'doing', dispatch_claim: { key: 'claim-a', owner: 'host-mac', delivered: false, created: '2026-10-09T18:03:30.000Z' } });
  h.push('dev-mac', 2, { session_id: 'c-board-a', attempt_id: attempt, session_host: 'host-mac', session_bound_at: 1791569024604, dispatch_claim: null });
  const card = h.push('dev-mac', 3, { last_event: event(attempt, 'started', '', 'start') }).body.card;
  assert.equal(card.revision, 4);
  return card;
}
const macComplete = (attempt, last = COMPLETE_A) => ({
  status: 'done', assignee: { agent: 'Claude', model: 'Opus 5.5' }, latest_receipt: RECEIPT_A, attempt_id: attempt, attempt_closed: true,
  last_event: last, session_bound_at: 1791569024604, dispatch_claim: null,
});
const winFallback = (attempt = ATTEMPT_B, last = FALLBACK_B) => ({
  status: 'needs_user', latest_receipt: '已结束，未提交回执', attempt_id: attempt, attempt_closed: true, last_event: last,
  dispatch_claim: CLAIM_B, session_bound_at: 1791570939688, dispatch_host: 'host-win', dispatch_session_id: 'c-board-b', dispatch_bound_at: 1791570939700,
});

test('incident replay: the Windows fallback reaches the hub first, the Mac completion later, and the completion wins', (t) => {
  const h = hub(t);
  running(h);
  const guess = h.push('dev-win', 4, winFallback());
  assert.equal(guess.status, 200);
  assert.equal(guess.body.card.status, 'needs_user');
  assert.deepEqual(guess.body.card.dispatch_claim, CLAIM_B);
  h.advance(25 * 60_000);
  const late = h.push('dev-mac', 4, macComplete(ATTEMPT_A));
  assert.equal(late.status, 409, 'the conflict is still recorded');
  const card = late.body.card;
  assert.equal(card.status, 'done');
  assert.equal(card.latest_receipt, RECEIPT_A);
  assert.equal(card.last_event, COMPLETE_A);
  assert.equal(card.attempt_id, ATTEMPT_A);
  assert.equal(card.dispatch_claim, null, 'the finished card is not left claimed');
  assert.equal(card.dispatch_session_id ?? null, null);
  assert.equal(card.dispatch_host ?? null, null);
  assert.equal(card.flag ?? null, null);
  // The losing guess stays on record: `kept` is what the card holds, `other` what was dropped.
  const record = card.conflicts.at(-1);
  assert.equal(record.fields.status.kept, 'done');
  assert.equal(record.fields.status.other, 'needs_user');
  assert.equal(record.fields.status.reason, 'complete-over-guess');
  assert.equal(record.fields.last_event.other, FALLBACK_B);
  assert.deepEqual(record.fields.dispatch_claim.other, CLAIM_B);
  assert.equal('sealed' in card || 'completeSeen' in card, false, 'hub bookkeeping never reaches a client');
  // Windows pushing the same guess again (its base is the revision it was given) changes nothing.
  const again = h.push('dev-win', guess.body.card.revision, winFallback());
  assert.equal(again.body.card.status, 'done');
  assert.equal(again.body.card.last_event, COMPLETE_A);
  assert.equal(again.body.card.dispatch_claim, null);
  // The rule survives a hub restart.
  const restored = h.reload().snapshot().cards.find((c) => c.id === CARD);
  assert.equal(restored.status, 'done');
  assert.equal(restored.last_event, COMPLETE_A);
  assert.equal('sealed' in restored, false);
});

test('the other arrival order: the Mac completion first, then the Windows guess and claim from an older base', (t) => {
  const h = hub(t);
  running(h);
  const done = h.push('dev-mac', 4, macComplete(ATTEMPT_A));
  assert.equal(done.status, 200);
  assert.equal(done.body.card.revision, 5);
  const stale = h.push('dev-win', 4, { ...winFallback(), title: 'renamed on Windows', important: false });
  assert.equal(stale.status, 409);
  const card = stale.body.card;
  assert.equal(card.status, 'done');
  assert.equal(card.last_event, COMPLETE_A);
  assert.equal(card.latest_receipt, RECEIPT_A);
  assert.equal(card.dispatch_claim, null);
  assert.equal(card.dispatch_session_id ?? null, null, 'a delivery that was never bound cannot appear on a finished card');
  assert.equal(card.dispatch_host ?? null, null);
  assert.equal(card.dispatch_bound_at ?? null, null);
  // What is not an attempt's business still merges.
  assert.equal(card.title, 'renamed on Windows');
  assert.equal(card.important, false);
  const reasons = Object.values(card.conflicts.at(-1).fields).map((field) => field.reason || 'plain');
  assert.ok(reasons.includes('stale-after-complete') || reasons.includes('claim-on-done'));
});

test('a legacy card completed before the hub kept its seal is protected the same way', (t) => {
  const h = hub(t);
  running(h);
  h.push('dev-mac', 4, macComplete(ATTEMPT_A));
  const data = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  delete data.cards[CARD].sealed;
  delete data.cards[CARD].completeSeen;
  fs.writeFileSync(h.file, JSON.stringify(data));
  const old = h.reload();
  const result = old.pushTask({ opId: 'op-legacy-stale', cardId: CARD, expectedRevision: 4, deviceId: 'dev-win', set: winFallback() });
  assert.equal(result.body.card.status, 'done');
  assert.equal(result.body.card.dispatch_claim, null);
  assert.equal(result.body.card.dispatch_session_id ?? null, null);
});

test('clock skew between the machines does not change who wins', (t) => {
  for (const skew of [-6 * 3_600_000, 0, 6 * 3_600_000]) {
    for (const macFirst of [false, true]) {
      const h = hub(t);
      // Attempt ids start with the clock of the machine that made them.
      const attemptA = String(1791569024306 + skew) + '-56576-2fb88cd6e6c7';
      const attemptB = String(1791570939403 - skew) + '-61804-d1d1498bbc30';
      const completeA = event(attemptA, 'complete', 'command', 'result of the run');
      const fallbackB = event(attemptB, 'fallback', 'fallback', '');
      running(h, attemptA);
      const mac = () => h.push('dev-mac', 4, macComplete(attemptA, completeA));
      const win = () => h.push('dev-win', 4, winFallback(attemptB, fallbackB));
      if (macFirst) { mac(); h.advance(-skew); win(); } else { win(); h.advance(skew); mac(); }
      const card = h.store.snapshot().cards.find((c) => c.id === CARD);
      const label = `skew ${skew / 3_600_000}h, ${macFirst ? 'Mac' : 'Windows'} first`;
      assert.equal(card.status, 'done', label);
      assert.equal(card.last_event, completeA, label);
      assert.equal(card.attempt_id, attemptA, label);
      assert.equal(card.dispatch_claim, null, label);
    }
  }
});

test('a finished card is not claimed again, with a current base or an old one, and a retry changes nothing', (t) => {
  const h = hub(t);
  running(h);
  const done = h.push('dev-mac', 4, macComplete(ATTEMPT_A)).body.card;
  const claim = (key) => ({ key, owner: 'host-win', delivered: false, created: '2026-10-09T18:36:00.000Z' });
  for (const [i, base] of [[1, done.revision], [2, done.revision], [3, 1]]) {
    const result = h.push('dev-win', base, { dispatch_claim: claim('claim-' + i), dispatch_session_id: 'c-board-' + i, dispatch_host: 'host-win' }, 'op-claim-again-' + i);
    assert.equal(result.body.card.status, 'done', 'try ' + i);
    assert.equal(result.body.card.dispatch_claim, null, 'try ' + i);
    assert.equal(result.body.card.dispatch_session_id ?? null, null, 'try ' + i);
    assert.equal(result.status, 409, 'the refused claim is on record, try ' + i);
    const field = result.body.card.conflicts.at(-1).fields.dispatch_claim;
    assert.equal(field.kept, null, 'try ' + i);
    assert.equal(field.other.key, 'claim-' + i, 'try ' + i);
    // The first try meets the claim rule; later ones meet the field's own conflict, since the refusal is a revision too.
    if (i === 1) assert.equal(field.reason, 'claim-on-done');
  }
  // The same operation sent again is answered, not applied twice.
  const before = h.store.snapshot().cards[0].revision;
  const replay = h.push('dev-win', done.revision, { dispatch_claim: claim('claim-1') }, 'op-claim-again-1');
  assert.equal(replay.body.card.revision, before);
});

test('reopening a finished card on purpose still works, and the old completion cannot undo the reopening', (t) => {
  const h = hub(t);
  running(h);
  const done = h.push('dev-mac', 4, macComplete(ATTEMPT_A)).body.card;
  const reopened = h.push('dev-win', done.revision, { status: 'doing', attempt_closed: false, last_event: null, dispatch_claim: CLAIM_B });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.card.status, 'doing');
  assert.deepEqual(reopened.body.card.dispatch_claim, CLAIM_B);
  // The first completion arrives again from a retransmit with an old base: it was seen already.
  const replayed = h.push('dev-mac', 4, macComplete(ATTEMPT_A), 'op-complete-retransmit');
  assert.equal(replayed.body.card.status, 'doing');
  assert.deepEqual(replayed.body.card.dispatch_claim, CLAIM_B);
  assert.equal(replayed.body.card.last_event, null);
});

test('only a written complete is authoritative: automatic completes, written failures and equal verdicts take the old conflict path', (t) => {
  const automatic = event(ATTEMPT_A, 'complete', 'automatic', 'guess');
  const h = hub(t);
  running(h);
  h.push('dev-win', 4, winFallback());
  const weak = h.push('dev-mac', 4, macComplete(ATTEMPT_A, automatic));
  assert.equal(weak.body.card.status, 'needs_user', 'an automatic complete is no better than a fallback');
  assert.equal(weak.body.card.last_event, FALLBACK_B);

  const failedByCommand = event(ATTEMPT_B, 'failed', 'command', 'the reviewer found a defect');
  const k = hub(t);
  running(k);
  k.push('dev-win', 4, { ...winFallback(ATTEMPT_B, failedByCommand), status: 'todo', flag: 'failed' });
  const failed = k.push('dev-mac', 4, macComplete(ATTEMPT_A));
  assert.equal(failed.body.card.last_event, failedByCommand, 'a written failure is not overruled by a different attempt');
  assert.equal(failed.body.card.status, 'todo');

  const other = event(ATTEMPT_B, 'complete', 'command', 'second run');
  const m = hub(t);
  running(m);
  m.push('dev-win', 4, { ...winFallback(ATTEMPT_B, other), status: 'done', dispatch_claim: null });
  const second = m.push('dev-mac', 4, macComplete(ATTEMPT_A));
  assert.equal(second.body.card.last_event, other, 'two written completes keep the earlier arrival and record the other');
  assert.equal(second.body.card.conflicts.at(-1).fields.last_event.other, COMPLETE_A);
});

test('a card a person moved by hand is not taken back by a late completion', (t) => {
  const h = hub(t);
  running(h);
  // The captain moves the card back to todo on Windows: no run event is written.
  const moved = h.push('dev-win', 4, { status: 'todo', session_id: null, attempt_id: null, session_host: null, session_bound_at: null });
  assert.equal(moved.status, 200);
  const late = h.push('dev-mac', 4, macComplete(ATTEMPT_A));
  assert.equal(late.status, 409);
  assert.equal(late.body.card.status, 'todo', 'the decision of the person stays');
  assert.equal(late.body.card.attempt_id, null);
  assert.equal(late.body.card.conflicts.at(-1).fields.status.other, 'done');
});

test('a legacy done card keeps its completion revision after its first edit, so a later reopen from that base works', (t) => {
  const h = hub(t);
  running(h);
  h.push('dev-mac', 4, macComplete(ATTEMPT_A));   // completed at revision 5
  const data = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  delete data.cards[CARD].sealed;
  delete data.cards[CARD].completeSeen;
  fs.writeFileSync(h.file, JSON.stringify(data));
  const old = h.reload();
  const push = (device, base, set, opId) => old.pushTask({ opId, cardId: CARD, expectedRevision: base, deviceId: device, set });
  const renamed = push('dev-mac', 5, { title: 'renamed after the completion' }, 'op-legacy-rename');
  assert.equal(renamed.body.card.revision, 6);
  // The user's machine saw revision 5 (the completion) and reopens the card.
  const reopened = push('dev-win', 5, { status: 'doing', attempt_closed: false, last_event: null }, 'op-legacy-reopen');
  assert.equal(reopened.body.card.status, 'doing', 'not refused as stale-after-complete');
  assert.equal(reopened.body.card.conflicts.length, 0);
});

test('two machines over HTTP: the completion reaches Windows, which drops its claim', async (t) => {
  const root = tmp(t);
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  const server = await startSyncServer({ store, token: 'fleet-secret-token-value' });
  t.after(() => server.close());
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, 'fleet-secret-token-value\n', { mode: 0o600 });
  const side = (name, id, platform) => {
    const tasks = new TaskStore(path.join(root, name, 'tasks'), { deviceId: id });
    const client = new FleetClient({
      baseUrl: server.url, tokenFile, device: { id, name, platform }, taskStore: tasks,
      historyDir: path.join(root, name, 'history'), stateFile: path.join(root, name, 'state.json'),
      sessions: () => [], version: '1.2.0', syncMs: 40,
    });
    t.after(() => client.stop());
    return { tasks, client };
  };
  const mac = side('mac', 'dev-mac', 'darwin');
  const win = side('win', 'dev-win', 'win32');
  const card = mac.tasks.add({ project: 'agentdeck', title: 'generic task' }).card;
  mac.client.noteCard(card);
  await mac.client.syncOnce();
  await win.client.syncOnce();
  // Both machines now hold the card; the Mac runs attempt A and Windows (not yet told) starts B.
  const write = (side, fields) => {
    const current = side.tasks.list()[0];
    const next = { ...current, ...fields };
    side.tasks.upsertSynced(next);
    side.client.noteCard(next);
  };
  write(mac, { status: 'doing', session_id: 'c-board-a', attempt_id: ATTEMPT_A, session_bound_at: 1791569024604 });
  await mac.client.syncOnce();
  await win.client.syncOnce();
  write(win, { ...winFallback(), session_id: null });
  write(mac, macComplete(ATTEMPT_A));
  await win.client.syncOnce();   // the guess is first at the hub
  await mac.client.syncOnce();   // the completion comes later, from an older base
  await win.client.syncOnce();
  await mac.client.syncOnce();
  for (const [name, side] of [['mac', mac], ['win', win]]) {
    const got = side.tasks.list()[0];
    assert.equal(got.status, 'done', name);
    assert.equal(got.last_event, COMPLETE_A, name);
    assert.equal(got.latest_receipt, RECEIPT_A, name);
    assert.equal(got.dispatch_claim ?? null, null, name);
  }
});
