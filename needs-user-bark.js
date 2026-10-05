'use strict';

const KNOWN = {
  '已结束，未提交回执': '队员停下了，但没有交结果。',
  '调度已结束，尚未派出执行会话': '这件事还没有派给队员。',
};

function barkEnabled(config) { return !config || config.needsUserBark !== false; }
function barkReady(config) { return typeof config?.barkKeyFile === 'string' && !!config.barkKeyFile.trim(); }

function oneLine(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }

function decisionText(card) {
  const raw = String((card && (card.user_question || card.latest_receipt)) || '').trim();
  if (KNOWN[raw]) return KNOWN[raw];
  const parts = raw.split(/(?<=[。！？.!?])|\r?\n/u).map((part) => part.trim()).filter(Boolean);
  return parts.slice(0, 2).join(' ') || '请到看板决定下一步。';
}

function formatMessage(items) {
  const body = items.map((item) => `${item.project} · ${item.title}\n${item.decision}`).join('\n\n');
  return body.length > 4000 ? body.slice(0, 3999) + '…' : body;
}

function entryOf(card) {
  const value = card && card.needs_user_entry;
  return typeof value === 'string' && value.length >= 10 && value.length <= 40 ? value : '';
}

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// Persist the visit id before sending. A restart must not push the same visit
// again; leaving 需要你 and coming back gets a new id from the board.
function createNeedsUserBark({ state = {}, saveState, sendBark, onError = () => {}, coalesceMs = 2000, schedule = defaultSchedule, clear = clearTimeout, suppressInitial = false } = {}) {
  if (!state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) state.entries = {};
  let pending = [];
  let timer = null;
  let initial = true;
  function flush() {
    timer = null;
    const batch = pending;
    pending = [];
    if (!batch.length) return Promise.resolve(null);
    const payload = {
      title: batch.length > 1 ? `需要你 · ${batch.length}` : '需要你',
      message: formatMessage(batch),
      level: 'active',
    };
    return Promise.resolve().then(() => sendBark(payload)).then((result) => {
      if (result && result.ok === false && result.message) onError(result.message);
      return result;
    }).catch(() => { onError('需要你的手机提醒发送失败，请检查本机配置。'); return { ok: false }; });
  }
  function observe(cards, { enabled = true, ready = true } = {}) {
    const baseline = initial && suppressInitial;
    initial = false;
    if (enabled === false && timer) { clear(timer); timer = null; pending = []; }
    const entries = { ...state.entries };
    const fresh = [];
    const seen = new Set();
    let changed = false;
    for (const card of Array.isArray(cards) ? cards : []) {
      if (!card || card.status !== 'needs_user' || card.archived || typeof card.id !== 'string') continue;
      seen.add(card.id);
      const stamped = entryOf(card);
      const entry = stamped || `legacy:${card.id}`;
      if (entries[card.id] === entry) continue;
      // Old cards and a switched-off setting are remembered without a push.
      if (!stamped || enabled === false || baseline) { entries[card.id] = entry; changed = true; continue; }
      if (!ready) continue;
      entries[card.id] = entry;
      changed = true;
      fresh.push({
        project: oneLine(card.project, 120),
        title: oneLine(card.title, 200),
        decision: decisionText(card).slice(0, 500),
      });
    }
    for (const id of Object.keys(entries)) if (!seen.has(id)) { delete entries[id]; changed = true; }
    if (changed) saveState({ entries });
    state.entries = entries;
    if (!fresh.length) return Promise.resolve([]);
    pending.push(...fresh);
    if (coalesceMs <= 0) return flush().then(() => fresh);
    if (!timer) timer = schedule(() => flush(), coalesceMs);
    return Promise.resolve(fresh);
  }
  return observe;
}

module.exports = { createNeedsUserBark, decisionText, barkEnabled, barkReady };
