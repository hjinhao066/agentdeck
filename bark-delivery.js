'use strict';
const crypto = require('crypto');
const fs = require('fs');
const Policy = require('./bark-policy');

function digest(pending) {
  const stamp = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const lines = [`免打扰期间有 ${pending.length} 项提醒，请查看：`];
  let included = 0;
  for (const item of pending) {
    const line = `${stamp(item.createdAt)} ${item.title}：${item.message}`;
    // Keep a single bounded push; the existing local notifications carry the
    // full text. Never drop pending items before delivery succeeds.
    const short = line.length > 700 ? line.slice(0, 699) + '…' : line;
    if (lines.join('\n').length + short.length > 3700) break;
    lines.push(short); included++;
  }
  if (included < pending.length) lines.push(`另有 ${pending.length - included} 项，请在 AgentDeck 查看本机提醒。`);
  return { title: 'AgentDeck · 免打扰期间的提醒', message: lines.join('\n'),
    level: pending.some((p) => p.level === 'critical') ? 'critical' : 'active' };
}
function normalizeState(state) {
  return { pending: (Array.isArray(state?.pending) ? state.pending : []).filter((p) => p &&
    typeof p.key === 'string' && typeof p.message === 'string' && p.message.length <= 4000 &&
    typeof p.title === 'string' && ['active', 'critical'].includes(p.level) && Number.isFinite(p.createdAt)),
    retryAt: Number.isFinite(state?.retryAt) ? state.retryAt : 0 };
}
function createBarkDelivery({ state = {}, saveState, getSettings, getClasses = () => [], now = Date.now, sendNow,
  prepare = () => {}, readState, withLock = (work) => work() } = {}) {
  state = normalizeState(state);
  let serial = Promise.resolve();
  function serialized(work) {
    const result = serial.then(async () => {
      await prepare();
      return withLock(async () => { if (readState) state = normalizeState(readState()); return work(); });
    });
    serial = result.catch(() => {}); return result;
  }
  function persist(next) { saveState(next); state = next; }
  const quietUntil = () => Policy.blockedUntil(now(), getSettings(), getClasses(now()));
  function queue(payload) {
    const key = payload.dedupeKey || crypto.createHash('sha256').update(payload.title + '\n' + payload.message).digest('hex');
    const existing = state.pending.find((p) => p.key === key);
    const item = { key, title: payload.title, message: payload.message, level: existing?.level === 'critical' ? 'critical' : payload.level,
      createdAt: existing?.createdAt ?? now(), updatedAt: now() };
    persist({ ...state, pending: [...state.pending.filter((p) => p.key !== key), item] });
  }
  async function flush(transport = sendNow) {
    if (!state.pending.length) return { ok: true, sent: false };
    const until = quietUntil();
    if (until) return { ok: true, accepted: true, queued: true, sent: false, message: `Bark 已延后：免打扰结束后合并发送（${state.pending.length} 项）。` };
    if (state.retryAt > now()) return { ok: true, accepted: true, queued: true, sent: false, message: 'Bark 合并提醒待重试，已保留。' };
    let result;
    try { result = await transport(digest(state.pending)); }
    catch (_) { result = { ok: false, message: 'Bark 合并提醒发送失败，已保留待重试。' }; }
    if (result.ok) persist({ pending: [], retryAt: 0 });
    else persist({ ...state, retryAt: now() + 60_000 });
    return { ...result, accepted: true, queued: !result.ok, sent: !!result.ok };
  }
  return {
    send: (payload, transport = sendNow) => serialized(async () => {
      if (quietUntil() || state.pending.length) {
        queue(payload); return flush(transport);
      }
      return transport(payload);
    }),
    flush: () => serialized(() => flush()),
    status: () => ({ queuedCount: state.pending.length, blockedUntil: quietUntil() }),
  };
}
// Offline installer and the app share this outbox. Read under the same short
// lock before every mutation so neither can overwrite the other's reminders.
function createFileBarkDelivery({ file, ...options }) {
  const readState = () => {
    try {
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('Bark reminder queue too large');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || !Array.isArray(value.pending) ||
          normalizeState(value).pending.length !== value.pending.length || !Number.isFinite(value.retryAt)) {
        throw new Error('Invalid Bark reminder queue');
      }
      return value;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Bark reminder queue cannot be read'); }
  };
  const lock = file + '.lock';
  const withLock = async (work) => {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        await fs.promises.mkdir(lock);
        try { fs.writeFileSync(lock + '/owner', JSON.stringify({ pid: process.pid })); }
        catch (error) { await fs.promises.rmdir(lock); throw error; }
        break;
      }
      catch (error) {
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Bark reminder queue is busy');
        // A crash during transport must not leave the durable outbox locked.
        // Remove only a lock whose recorded process has definitely exited.
        try {
          const owner = JSON.parse(fs.readFileSync(lock + '/owner', 'utf8'));
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); }
            catch (dead) {
              if (dead.code === 'ESRCH') { fs.unlinkSync(lock + '/owner'); fs.rmdirSync(lock); continue; }
            }
          }
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try { return await work(); } finally { fs.unlinkSync(lock + '/owner'); await fs.promises.rmdir(lock); }
  };
  // Read inside an operation: a damaged outbox must not prevent app startup.
  return createBarkDelivery({ ...options, state: {}, readState, withLock,
    saveState: (state) => {
      const text = JSON.stringify(state);
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Bark reminder queue too large');
      fs.writeFileSync(file + '.tmp', text, { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } });
}
module.exports = { createBarkDelivery, createFileBarkDelivery, digest };
