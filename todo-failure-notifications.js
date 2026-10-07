'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// No unified quiet-hours setting exists yet. The settings task will connect it
// here; keep the current local-time policy in one place (23:00–09:30).
const DEFAULT_QUIET_HOURS = Object.freeze({ start: 23 * 60, end: 9 * 60 + 30 });
const COALESCE_MS = 60 * 1000;

function nextAllowedTime(at) {
  const date = new Date(at), minute = date.getHours() * 60 + date.getMinutes();
  if (minute >= DEFAULT_QUIET_HOURS.end && minute < DEFAULT_QUIET_HOURS.start) return at;
  if (minute >= DEFAULT_QUIET_HOURS.start) date.setDate(date.getDate() + 1);
  date.setHours(Math.floor(DEFAULT_QUIET_HOURS.end / 60), DEFAULT_QUIET_HOURS.end % 60, 0, 0);
  return date.getTime();
}

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

// Only failure ids and queue times are stored, never private task text. This
// queue stays outside renderer config so delayed config saves cannot erase it.
class TodoFailureNotifications {
  constructor({ file, notify, onError = (stage) => console.error(`[Todo AI] ${stage} failed.`), now = Date.now, schedule = defaultSchedule, clear = clearTimeout, coalesceMs = COALESCE_MS }) {
    this.file = file; this.notify = notify; this.onError = onError;
    this.now = now; this.schedule = schedule; this.clear = clear; this.coalesceMs = coalesceMs;
    this.timer = null; this.stopped = false; this.sending = false;
    this.pending = {};
    this.attempted = new Set();
    if (fs.existsSync(file)) {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!state || !state.pending || typeof state.pending !== 'object' || Array.isArray(state.pending) ||
          Object.entries(state.pending).some(([id, at]) => !/^todo-error-[a-f0-9]{64}$/.test(id) || !Number.isFinite(at))) {
        throw new Error('Invalid Todo failure notification queue.');
      }
      this.pending = state.pending;
    }
  }
  save(pending) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify({ pending }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, this.file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    this.pending = pending;
  }
  start() { this.stopped = false; this.arm(); }
  stop() { this.stopped = true; if (this.timer !== null) this.clear(this.timer); this.timer = null; }
  enqueue({ id }) {
    if (typeof id !== 'string' || !/^todo-error-[a-f0-9]{64}$/.test(id)) throw new Error('Invalid Todo failure notification id.');
    if (!Object.hasOwn(this.pending, id)) this.save({ ...this.pending, [id]: this.now() });
    this.arm();
  }
  arm(retry = false) {
    if (this.stopped || this.sending || this.timer !== null || !Object.keys(this.pending).length) return;
    const now = this.now();
    const due = Math.max(now, Math.min(...Object.values(this.pending)) + this.coalesceMs,
      retry ? now + COALESCE_MS : now);
    this.timer = this.schedule(() => { this.timer = null; void this.flush(); }, nextAllowedTime(due) - now);
  }
  async flush() {
    if (this.stopped || this.sending || !Object.keys(this.pending).length) return false;
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null;
    // A delivered notification must not ring again when clearing its local
    // queue fails. Retry only the write in this process; new failures retain
    // their own coalescing window. Network delivery and disk writes cannot be
    // atomic across a process crash, so this latch is intentionally in memory.
    if (this.attempted.size) {
      try {
        const pending = { ...this.pending };
        for (const id of this.attempted) delete pending[id];
        this.save(pending);
        this.attempted.clear();
      } catch (error) {
        this.onError('todo-failure-notifications', error); this.arm(true); return false;
      }
      if (!Object.keys(this.pending).length) return true;
    }
    const now = this.now();
    if (nextAllowedTime(now) !== now || now < Math.min(...Object.values(this.pending)) + this.coalesceMs) {
      this.arm(); return false;
    }
    const ids = Object.keys(this.pending).sort();
    const command = {
      id: 'todo-failures-' + crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex'),
      message: `Todo AI 有 ${ids.length} 条任务没办成或出错，请在 AgentDeck 查看详情。`,
      urgent: true, nativeWeb: true, level: 'timeSensitive',
    };
    this.sending = true;
    let delivered = false;
    try {
      // false means no Captain is available yet; retain the durable batch.
      delivered = (await this.notify(command)) !== false;
      if (delivered) {
        for (const id of ids) this.attempted.add(id);
        const pending = { ...this.pending };
        for (const id of ids) delete pending[id];
        this.save(pending);
        for (const id of ids) this.attempted.delete(id);
      }
    } catch (error) { delivered = false; this.onError('todo-failure-notifications', error); }
    finally { this.sending = false; this.arm(!delivered); }
    return delivered;
  }
}
module.exports = { TodoFailureNotifications, DEFAULT_QUIET_HOURS, COALESCE_MS, nextAllowedTime };
