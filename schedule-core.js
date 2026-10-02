// Pure helpers behind Schedule: when a scheduled prompt runs next, whether it
// is due, and how to describe it. Runs only while AgentDeck is open; a run that
// was due while the app was closed is reported as missed instead of fired late.
// No DOM, no Electron: runs in the page and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScheduleCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SCHEDULES = 100;
  const MAX_PROMPT = 2_000_000;   // no practical limit: long prompts are sent as a file
  const MIN_EVERY = 5;               // minutes
  const MAX_EVERY = 7 * 24 * 60;
  const STARTUP_GRACE = 2 * 60_000;  // a run due this long before launch still fires
  const BUSY_LIMIT = 30 * 60_000;    // give up on a run whose session stays busy this long
  const KINDS = ['once', 'daily', 'interval'];
  const AGENTS = ['claude', 'agy', 'grok', 'shell'];
  const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/;
  const DAY = ['日', '一', '二', '三', '四', '五', '六'];

  const clean = (value, max) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const cleanPrompt = (value) => String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+$/, '').slice(0, MAX_PROMPT);
  const num = (value) => (Number.isFinite(value) ? value : null);

  function newScheduleId() { return 's' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36); }

  function parseTime(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    return h < 24 && min < 60 ? { h, min } : null;
  }

  function normalizeSchedule(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const kind = KINDS.includes(s.kind) ? s.kind : 'daily';
    const days = Array.from(new Set((Array.isArray(s.days) ? s.days : [0, 1, 2, 3, 4, 5, 6])
      .map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort();
    const every = Math.round(Number(s.every));
    return {
      id: typeof s.id === 'string' && ID_RE.test(s.id) ? s.id : newScheduleId(),
      name: clean(s.name, 80),
      prompt: cleanPrompt(s.prompt),
      // 'new' opens a fresh session each run; otherwise the id of an existing one
      target: s.target === 'new' ? 'new' : (typeof s.target === 'string' && ID_RE.test(s.target) ? s.target : 'new'),
      agent: AGENTS.includes(s.agent) ? s.agent : 'claude',
      cwd: clean(s.cwd, 1000),
      kind,
      at: num(s.at),
      time: parseTime(s.time) ? String(s.time).padStart(5, '0') : '09:00',
      days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
      every: Number.isFinite(every) ? Math.max(MIN_EVERY, Math.min(MAX_EVERY, every)) : 60,
      enabled: s.enabled !== false,
      createdAt: num(s.createdAt) || 0,
      nextAt: num(s.nextAt),
      lastRunAt: num(s.lastRunAt),
      lastStatus: ['ok', 'missed', 'skipped', 'error'].includes(s.lastStatus) ? s.lastStatus : '',
      lastNote: clean(s.lastNote, 200),
    };
  }

  function normalizeSchedules(raw) {
    const seen = new Set();
    return (Array.isArray(raw) ? raw : []).map(normalizeSchedule)
      .filter((s) => s.prompt && !seen.has(s.id) && seen.add(s.id)).slice(0, MAX_SCHEDULES);
  }

  // First run strictly after `after` (ms), or null when there is none.
  function computeNext(s, after) {
    if (s.kind === 'once') return s.at && s.at > after ? s.at : null;
    if (s.kind === 'interval') return after + s.every * 60_000;
    const t = parseTime(s.time);
    if (!t) return null;
    const base = new Date(after);
    for (let d = 0; d <= 7; d++) {
      const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, t.h, t.min, 0, 0);
      if (c.getTime() > after && s.days.includes(c.getDay())) return c.getTime();
    }
    return null;
  }

  // Problems that block saving, in plain words; '' when fine.
  function validate(s, now) {
    if (!s.prompt.trim()) return '请填写要发送的提示词';
    if (s.kind === 'once' && !(s.at > now)) return '这个时间已经过去了';
    if (s.kind === 'daily' && !s.days.length) return '至少选一天';
    return '';
  }

  // Save-time bookkeeping: the next run counts from now.
  function arm(s, now) {
    const next = s.enabled ? computeNext(s, now) : null;
    return { ...s, nextAt: next, enabled: s.enabled && next !== null };
  }

  // What the runner should do with a schedule at `now`.
  // startup: the app just opened, so anything well overdue was missed.
  function dueAction(s, now, startup) {
    if (!s.enabled || !s.nextAt || s.nextAt > now) return null;
    if (startup && now - s.nextAt > STARTUP_GRACE) return 'missed';
    return 'run';
  }

  function settle(s, now, status, note) {
    const next = s.kind === 'once' ? null : computeNext(s, now);
    return { ...s, lastRunAt: now, lastStatus: status, lastNote: clean(note, 200), nextAt: next, enabled: s.enabled && next !== null };
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function formatWhen(ts, now) {
    if (!ts) return '';
    const d = new Date(ts), n = new Date(now);
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86_400_000);
    if (dayDiff === 0) return '今天 ' + hm;
    if (dayDiff === 1) return '明天 ' + hm;
    if (dayDiff === -1) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function describe(s, now) {
    if (s.kind === 'once') return '一次 · ' + formatWhen(s.at, now || Date.now());
    if (s.kind === 'interval') return s.every % 60 === 0 ? `每 ${s.every / 60} 小时` : `每 ${s.every} 分钟`;
    const days = s.days.join(',');
    let label;
    if (days === '0,1,2,3,4,5,6') label = '每天';
    else if (days === '1,2,3,4,5') label = '工作日';
    else if (days === '0,6') label = '周末';
    else label = '每周' + s.days.map((d) => DAY[d]).join('、');
    return label + ' ' + s.time;
  }

  return {
    MAX_SCHEDULES, MIN_EVERY, STARTUP_GRACE, BUSY_LIMIT, AGENTS,
    newScheduleId, normalizeSchedule, normalizeSchedules, computeNext, validate, arm, dueAction, settle,
    formatWhen, describe,
  };
});
