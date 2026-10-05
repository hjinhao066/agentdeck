'use strict';
const fs = require('fs');
const os = require('os');

// No model calls. The watcher catches local/sync edits; polling recovers missed
// rename events. The durable claim is made before notifying the renderer.
class TaskHeartbeat {
  // onReview/onRework: automatic verification (a reviewer for each review round,
  // and the rejected findings back to the executor). Both only deliver durable,
  // already-written claims; `autoVerify()` is the on/off switch.
  constructor(store, { onStart, onChange = () => {}, log = () => {}, interval = 60_000, onReview, onRework, autoVerify = () => true } = {}) {
    this.store = store; this.onStart = onStart; this.onChange = onChange; this.log = log; this.interval = interval;
    this.onReview = onReview; this.onRework = onRework; this.autoVerify = autoVerify;
    this.previous = new Map(); this.pending = new Map(); this.pendingReview = new Map(); this.pendingRework = new Map();
  }
  scan() {
    try {
      this.store.reconcile();
      const cards = this.store.list();
      const sessions = this.store.sessions();
      const fingerprint = JSON.stringify(cards);
      if (fingerprint !== this.fingerprint) { this.fingerprint = fingerprint; this.onChange(); }
      const verifying = !!(this.onReview && this.onRework) && this.autoVerify();
      for (const card of cards) {
        if (verifying) this.collectVerify(card);
        const previous = this.previous.get(card.id);
        const entered = card.status === 'doing' && previous && previous.status !== 'doing';
        if (card.status === 'doing' && !card.flag && !card.session_id && !card.dispatch_session_id) {
          if (card.dispatch_claim && !card.dispatch_claim.delivered && card.dispatch_claim.owner === os.hostname()) this.pending.set(card.id, card.dispatch_claim.key);
          else if (!card.dispatch_claim || entered && previous.claimKey === card.dispatch_claim.key) {
            const result = this.store.claim({ id: card.id, updated: card.updated, newEntry: !!entered }, sessions);
            if (!result.ignored) {
              this.pending.set(card.id, result.card.dispatch_claim.key);
              this.log(`task-board start claimed id=${card.id} project=${card.project} key=${result.card.dispatch_claim.key}`);
            }
          }
        }
        this.previous.set(card.id, { status: card.status, claimKey: card.dispatch_claim?.key });
      }
      const ids = new Set(cards.map((c) => c.id));
      for (const id of this.previous.keys()) if (!ids.has(id)) this.previous.delete(id);
      const current = this.pending.size ? this.store.list() : cards;
      for (const [id, key] of this.pending) {
        const card = current.find((c) => c.id === id);
        if (!card || card.dispatch_claim?.key !== key || card.dispatch_claim.delivered || card.status !== 'doing' || card.flag || this.store.occupied(card, sessions)) { this.pending.delete(id); continue; }
        if (!this.delivering?.has(key)) {
          if (!this.delivering) this.delivering = new Set();
          this.delivering.add(key);
          const delivered = this.onStart({ id, key });
          // Returning false leaves it available once a Captain exists.
          if (delivered === false) this.delivering.delete(key);
        }
      }
      if (verifying) this.deliverVerify(cards);
      else { this.pendingReview.clear(); this.pendingRework.clear(); }
    } catch (error) {
      // Conflict markers remain untouched. One diagnostic per distinct error.
      if (this.lastError !== error.message) this.log('task-board heartbeat: ' + error.message);
      this.lastError = error.message;
    }
  }
  // A review round is claimed once, durably, before the renderer hears of it;
  // an unfinished claim or rejection from an earlier run is simply delivered again.
  collectVerify(card) {
    if (this.store.reviewDue(card)) {
      const result = this.store.claimReview({ id: card.id });
      if (!result.ignored) {
        this.pendingReview.set(card.id, result.card.review_claim.key);
        this.log(`task-board review claimed id=${card.id} round=${result.card.review_claim.round}`);
      }
    } else if (this.store.reviewPending(card)) this.pendingReview.set(card.id, card.review_claim.key);
    if (this.store.reworkPending(card)) this.pendingRework.set(card.id, card.review_reject.key);
  }
  deliverVerify(cards) {
    const current = this.pendingReview.size || this.pendingRework.size ? this.store.list() : cards;
    if (!this.sent) this.sent = new Set();
    const run = (pending, valid, deliver, keyOf) => {
      for (const [id, key] of pending) {
        const card = current.find((c) => c.id === id);
        if (!card || !valid(card) || keyOf(card) !== key) { pending.delete(id); continue; }
        if (this.sent.has(key)) continue;
        this.sent.add(key);
        // Returning false leaves it available until the renderer marks it delivered.
        if (deliver({ id, key }) === false) this.sent.delete(key);
      }
    };
    run(this.pendingReview, (c) => this.store.reviewPending(c), this.onReview, (c) => c.review_claim.key);
    run(this.pendingRework, (c) => this.store.reworkPending(c), this.onRework, (c) => c.review_reject.key);
  }
  start() {
    fs.mkdirSync(this.store.dir, { recursive: true });
    this.watch = fs.watch(this.store.dir, () => {
      // Coalesce a burst without postponing scans indefinitely during writes.
      if (!this.debounce) this.debounce = setTimeout(() => { this.debounce = null; this.scan(); }, 100);
    });
    this.watch.on('error', (error) => this.log('task-board watcher: ' + error.message));
    this.watch.unref();
    this.timer = setInterval(() => this.scan(), this.interval);
    this.timer.unref();
    this.scan();
  }
  close() { this.watch?.close(); clearInterval(this.timer); clearTimeout(this.debounce); }
}
module.exports = { TaskHeartbeat };
