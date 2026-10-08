'use strict';
const crypto = require('crypto');
const fs = require('fs');
const Policy = require('./bark-policy');

// A send holds the outbox lock and gives up after 8 s, so an older "sending"
// record was interrupted even when its process id is alive again (reused).
const INFLIGHT_MS = 60_000;
// Reminders that could not go out for a day are stale news: never deliver them late.
const EXPIRE_MS = 24 * 60 * 60_000;
function interrupted(inflight, at) {
  if (!(Math.abs(at - inflight.startedAt) <= INFLIGHT_MS)) return true;
  try { process.kill(inflight.ownerPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

function digest(pending) {
  const stamp = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const lines = [`有 ${pending.length} 项提醒待补发，请查看：`];
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
  return { title: 'AgentDeck · 待补发提醒', message: lines.join('\n'),
    level: pending.some((p) => p.level === 'critical') ? 'critical' : pending.some((p) => p.level === 'timeSensitive') ? 'timeSensitive' : 'active' };
}
function normalizeState(state) {
  return { pending: (Array.isArray(state?.pending) ? state.pending : []).filter((p) => p &&
    typeof p.key === 'string' && typeof p.message === 'string' && p.message.length <= 4000 &&
    typeof p.title === 'string' && ['active', 'timeSensitive', 'critical'].includes(p.level) && Number.isFinite(p.createdAt)),
    retryAt: Number.isFinite(state?.retryAt) ? state.retryAt : 0,
    lastError: typeof state?.lastError === 'string' ? state.lastError : '',
    inflight: state?.inflight || null, uncertain: state?.uncertain === true };
}
function createBarkDelivery({ state = {}, saveState, getSettings, getClasses = () => [], now = Date.now, sendNow,
  prepare = () => {}, readState, withLock = (work) => work(), onFailure = () => {} } = {}) {
  state = normalizeState(state);
  let serial = Promise.resolve(), settled = null, volatileError = '', reportedError = '';
  function failure(message, retained = true) {
    volatileError = message;
    const signature = JSON.stringify([message, state.pending.map((p) => p.key)]);
    if (signature === reportedError) return;
    reportedError = signature;
    try { onFailure({ message, keys: state.pending.map((p) => p.key), retained }); } catch (_) {}
  }
  function persist(next) { saveState(next); state = next; volatileError = ''; }
  function settledState() {
    const owned = state.inflight?.batchId === settled.batchId;
    return { ...state, ...(owned ? { inflight: null, uncertain: false, retryAt: settled.retryAt, lastError: settled.message } : {}),
      pending: settled.ok ? state.pending.filter((p) => !settled.items.has(JSON.stringify(p))) : state.pending };
  }
  function serialized(work) {
    const result = serial.then(async () => {
      await prepare();
      return withLock(async () => {
        if (readState) state = normalizeState(readState());
        // A transport response is known even if clearing the outbox failed.
        // Retry that write, never the network. The durable inflight marker also
        // prevents another process from resending this still-owned batch.
        if (settled) {
          try { persist(settledState()); settled = null; }
          catch (_) {
            const message = settled.sent ? 'Bark 已送达，但队列记录未能保存；正在重试保存，不会重复发送。' : 'Bark 发送失败，队列记录未能保存；已保留，正在重试保存。';
            failure(message); return { ok: false, accepted: true, queued: !settled.sent, sent: settled.sent, message };
          }
        }
        return work();
      });
    }).catch((error) => {
      failure('Bark 提醒队列无法读写或正忙，请检查本机通知设置；本机提醒仍保留。', state.pending.length > 0);
      throw error;
    });
    serial = result.catch(() => {}); return result;
  }
  const quietUntil = () => Policy.blockedUntil(now(), getSettings(), getClasses(now()));
  function queue(payload) {
    const key = payload.dedupeKey || crypto.createHash('sha256').update(payload.title + '\n' + payload.message).digest('hex');
    const existing = state.pending.find((p) => p.key === key);
    const item = { key, title: payload.title, message: payload.message, level: existing?.level === 'critical' ? 'critical' : payload.level,
      createdAt: existing?.createdAt ?? now(), updatedAt: now() };
    persist({ ...state, pending: [...state.pending.filter((p) => p.key !== key), item] });
  }
  async function flush(transport = sendNow, immediate) {
    const fresh = state.pending.filter((p) => now() - p.createdAt <= EXPIRE_MS);
    if (fresh.length !== state.pending.length) {
      const keys = new Set(fresh.map((p) => p.key)), inflightKeys = state.inflight?.keys?.filter((k) => keys.has(k));
      const cleared = !fresh.length || inflightKeys?.length === 0;
      persist({ ...state, pending: fresh, ...(cleared ? { inflight: null, uncertain: false, retryAt: 0, lastError: '' } :
        inflightKeys ? { inflight: { ...state.inflight, keys: inflightKeys } } : {}) });
    }
    if (!state.pending.length) return { ok: true, sent: false };
    if (state.uncertain) return { ok: false, accepted: true, queued: true, sent: false, message: state.lastError };
    if (state.inflight) {
      if (!interrupted(state.inflight, now())) return { ok: true, accepted: true, queued: true, sent: false, message: 'Bark 提醒正在发送或等待保存送达记录。' };
      const message = 'Bark 上次发送中断，送达结果不明，已暂停自动补发。请检查手机后用设置中的刷新按钮重试。';
      persist({ ...state, uncertain: true, lastError: message }); failure(message);
    }
    if (state.uncertain) return { ok: false, accepted: true, queued: true, sent: false, message: state.lastError };
    if (quietUntil()) return { ok: true, accepted: true, queued: true, sent: false, message: `Bark 已延后：免打扰结束后合并发送（${state.pending.length} 项）。` };
    if (state.retryAt > now()) return { ok: true, accepted: true, queued: true, sent: false, message: 'Bark 发送失败，待重试，已保留。' };
    // Save before sending so a crash/failed cleanup cannot cause another app or
    // installer to blindly repeat an already delivered batch.
    const batchId = crypto.randomUUID();
    persist({ ...state, inflight: { ownerPid: process.pid, batchId, startedAt: now(), keys: state.pending.map((p) => p.key) }, lastError: '' });
    let result;
    try { result = await transport(immediate || digest(state.pending)); }
    catch (_) { result = { ok: false, message: 'Bark 发送失败，已保留待重试。' }; }
    // Nothing to wait for on a machine with no phone key: drop instead of piling up.
    const dropped = !result.ok && result.unconfigured === true;
    const message = result.ok ? result.message : dropped ? '这台电脑还没有配置手机提醒密钥，这条手机提醒没有发出，也不会补发；本机提醒不受影响。要发到手机，请在设置里填写密钥文件路径。' :
      'Bark 发送失败，已保留；60 秒后重试，请检查网络和本机密钥文件。';
    settled = { ok: !!result.ok || dropped, sent: !!result.ok, batchId, items: new Set(state.pending.map((p) => JSON.stringify(p))),
      retryAt: result.ok || dropped ? 0 : now() + 60_000, message: result.ok ? '' : message };
    try { persist(settledState()); settled = null; }
    catch (_) {
      const warning = result.ok ? 'Bark 已送达，但队列记录未能保存；正在重试保存，不会重复发送。' : 'Bark 发送失败，队列记录未能保存；已保留，正在重试保存。';
      failure(warning); return { ok: false, accepted: true, queued: !result.ok, sent: !!result.ok, message: warning };
    }
    if (!result.ok) failure(message, !dropped);
    else reportedError = '';
    return { ...result, message, accepted: true, queued: !result.ok && !dropped, sent: !!result.ok };
  }
  return {
    send: (payload, transport = sendNow) => serialized(async () => {
      const immediate = !quietUntil() && !state.pending.length ? payload : null;
      queue(payload); return flush(transport, immediate);
    }),
    flush: () => serialized(() => flush()),
    cancel: (key, stillRecovered = () => true) => serialized(() => {
      if (!stillRecovered()) return { ok: true, cancelled: true };
      const pending = state.pending.filter((p) => p.key !== key);
      const keys = state.inflight?.keys?.filter((k) => k !== key);
      const cleared = !pending.length || keys?.length === 0;
      if (pending.length !== state.pending.length) persist({ ...state, pending,
        ...(cleared ? { inflight: null, uncertain: false, retryAt: 0, lastError: '' } :
          keys ? { inflight: { ...state.inflight, keys } } : {}) });
      return { ok: true, cancelled: state.pending.every((p) => p.key !== key) };
    }),
    retry: () => serialized(() => {
      if (!state.inflight || interrupted(state.inflight, now())) persist({ ...state, inflight: null, uncertain: false, retryAt: 0, lastError: '' });
      return flush();
    }),
    status: () => ({ queuedCount: state.pending.length, blockedUntil: quietUntil(), retryAt: state.retryAt,
      lastError: volatileError || state.lastError, uncertain: state.uncertain }),
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
          normalizeState(value).pending.length !== value.pending.length || !Number.isFinite(value.retryAt) ||
          value.inflight != null && (!Number.isInteger(value.inflight.ownerPid) || value.inflight.ownerPid <= 0)) {
        throw new Error('Invalid Bark reminder queue');
      }
      return value;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Bark reminder queue cannot be read'); }
  };
  const lock = file + '.lock';
  const withLock = async (work) => {
    const deadline = Date.now() + 15000;
    const ownerFile = `${lock}-owner-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    // Link a fully written owner file atomically: there is no ownerless-lock gap.
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    try {
      for (;;) {
        try { fs.linkSync(ownerFile, lock); break; }
        catch (error) {
          if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Bark reminder queue is busy');
          const reclaim = lock + '.reclaim';
          let claimed = false;
          try {
            // Serialize stale-owner recovery too. Each winner re-reads the
            // current lock, so a second waiter cannot unlink a newly acquired
            // live lock using the first waiter's stale PID snapshot.
            fs.linkSync(ownerFile, reclaim); claimed = true;
            const stat = fs.statSync(lock), legacy = stat.isDirectory();
            const ownerPath = legacy ? lock + '/owner' : lock;
            let owner;
            try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')); }
            catch (missing) {
              if (legacy && missing.code === 'ENOENT' && Date.now() - stat.mtimeMs > 30000 && fs.readdirSync(lock).length === 0) {
                fs.rmdirSync(lock);
              }
            }
            if (Number.isInteger(owner?.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); }
              catch (dead) { if (dead.code === 'ESRCH') {
                fs.unlinkSync(ownerPath); if (legacy) fs.rmdirSync(lock);
              } }
            }
          } catch (_) {}
          finally { if (claimed) fs.unlinkSync(reclaim); }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      try { return await work(); } finally { fs.unlinkSync(lock); }
    } finally { fs.unlinkSync(ownerFile); }
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
