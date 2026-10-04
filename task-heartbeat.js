'use strict';
const fs = require('fs');
const os = require('os');

// No model calls. The watcher catches local/sync edits; polling recovers missed
// rename events. The durable claim is made before notifying the renderer.
class TaskHeartbeat {
  constructor(store, { onStart, onChange = () => {}, log = () => {}, interval = 60_000 } = {}) {
    this.store = store; this.onStart = onStart; this.onChange = onChange; this.log = log; this.interval = interval;
    this.previous = new Map(); this.pending = new Map();
  }
  scan() {
    try {
      this.store.reconcile();
      const cards = this.store.list();
      const fingerprint = JSON.stringify(cards);
      if (fingerprint !== this.fingerprint) { this.fingerprint = fingerprint; this.onChange(); }
      for (const card of cards) {
        const previous = this.previous.get(card.id);
        const entered = card.status === 'doing' && previous && previous.status !== 'doing';
        if (card.status === 'doing' && !card.flag && !card.session_id && !card.dispatch_session_id) {
          if (card.dispatch_claim && !card.dispatch_claim.delivered && card.dispatch_claim.owner === os.hostname()) this.pending.set(card.id, card.dispatch_claim.key);
          else if (!card.dispatch_claim || entered && previous.claimKey === card.dispatch_claim.key) {
            const result = this.store.claim({ id: card.id, updated: card.updated, newEntry: !!entered });
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
      for (const [id, key] of this.pending) {
        const card = cards.find((c) => c.id === id);
        if (!card || card.dispatch_claim?.delivered || card.status !== 'doing') { this.pending.delete(id); continue; }
        if (!this.delivering?.has(key)) {
          if (!this.delivering) this.delivering = new Set();
          this.delivering.add(key);
          const delivered = this.onStart({ id, key });
          // Returning false leaves it available once a Captain exists.
          if (delivered === false) this.delivering.delete(key);
        }
      }
    } catch (error) {
      // Conflict markers remain untouched. One diagnostic per distinct error.
      if (this.lastError !== error.message) this.log('task-board heartbeat: ' + error.message);
      this.lastError = error.message;
    }
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
