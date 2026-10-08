'use strict';

// 自动回执入口: a narrow, local-only door for scheduled scripts on this computer
// (the nightly bug hunt, a backup job...). It has its own token, apart from every
// terminal's and from the phone page's, and it can do exactly three things:
//   automation-receipt       tell 队长 something, shown as 「自动任务：<名字>」
//   automation-task-add      add a board card (always 待办; it never starts work)
//   automation-inbox-report  file a 结果汇报 on the user's 待我处理 page
// plus automation-status (is the door open). It cannot hand out work, tell a
// session anything, read a conversation or change a setting, and what it says
// is never presented as the user's own words. Pure functions and a small token
// file; the main process applies `screen` to every request before anything else.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJsonPrivate, writeJsonPrivate } = require('./board-credentials');

const FILE = 'automation.json';
const PREFIX = '自动任务：';
const ACTIONS = Object.freeze(['automation-status', 'automation-receipt', 'automation-task-add', 'automation-inbox-report']);
// What each action may carry, besides the request envelope (id, token, createdAt, action).
const FIELDS = Object.freeze({
  'automation-status': [],
  'automation-receipt': ['source', 'message'],
  'automation-task-add': ['source', 'project', 'title', 'detail'],
  'automation-inbox-report': ['source', 'title', 'detail', 'files', 'project'],
});
const ENVELOPE = ['id', 'token', 'createdAt', 'action'];
const LIMITS = Object.freeze({
  perMinute: 12,          // all sources together
  perSourcePerMinute: 6,  // one name
  queued: 24,             // accepted but not yet answered by the page
  source: 40, message: 4000, title: 300, detail: 8000, project: 120, files: 20, path: 1024,
});
const WINDOW_MS = 60 * 1000;
// A name people can read: letters and digits (any language), inner spaces, . _ -
const SOURCE = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]{0,38}[\p{L}\p{N}._-])?$/u;

function matches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- what a request may say -----------------------------------------------------
// Control, format (zero-width, bidirectional) and line/paragraph separators go;
// line breaks stay only where `multiline`. Too long is refused, never trimmed.
function clean(value, name, max, { multiline = false, required = true } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new Error(`--${name} 需要一段文字。`);
  let text = value.replace(/\r\n?/g, '\n').replace(/[\p{Cf}\u2028\u2029]/gu, '');
  text = multiline
    ? text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n')
    : text.replace(/[\p{Cc}\s]+/gu, ' ');
  text = text.trim();
  if (!text) {
    if (required) throw new Error(`--${name} 不能为空。`);
    return '';
  }
  if ([...text].length > max) throw new Error(`--${name} 最多 ${max} 个字，写短一些；长内容写进文件再用 --files 给路径。`);
  return text;
}

function cleanSource(value) {
  if (typeof value !== 'string' || !SOURCE.test(value)) {
    throw new Error('--source 是这个脚本的名字（如 nightly-bughunt）：1–40 个字，只用字母、数字、空格和 . _ -。');
  }
  return value;
}

function label(source) { return PREFIX + source; }

// A request becomes a command made of nothing but whitelisted, cleaned fields.
// Anything else on it (a target session, a deadline, a nested object) is refused.
function validate(action, request) {
  if (!ACTIONS.includes(action)) throw new Error(`自动回执入口不支持 ${String(action).slice(0, 40)}。`);
  const allowed = new Set([...ENVELOPE, ...FIELDS[action]]);
  const extra = Object.keys(request || {}).find((key) => !allowed.has(key));
  if (extra) throw new Error(`自动回执入口的 ${action.slice('automation-'.length)} 不接受 ${extra.slice(0, 40)}。`);
  if (action === 'automation-status') return { action };
  const source = cleanSource(request.source);
  if (action === 'automation-receipt') {
    return { action, source, message: clean(request.message, 'message', LIMITS.message, { multiline: true }) };
  }
  if (action === 'automation-task-add') {
    return { action, source, project: clean(request.project, 'project', LIMITS.project),
      title: clean(request.title, 'title', LIMITS.title), detail: clean(request.detail, 'detail', LIMITS.detail, { multiline: true, required: false }) };
  }
  let files = [];
  if (request.files !== undefined) {
    if (!Array.isArray(request.files) || request.files.length > LIMITS.files) throw new Error(`--files 最多 ${LIMITS.files} 个路径。`);
    files = request.files.map((f) => clean(f, 'files', LIMITS.path));
  }
  return { action, source, title: clean(request.title, 'title', LIMITS.title), detail: clean(request.detail, 'detail', LIMITS.detail, { multiline: true, required: false }),
    files, project: clean(request.project, 'project', LIMITS.project, { required: false }) };
}

// ---- rate limit -----------------------------------------------------------------
function createLimiter(options = {}) {
  const perMinute = options.perMinute || LIMITS.perMinute;
  const perSource = options.perSourcePerMinute || LIMITS.perSourcePerMinute;
  const all = [];
  const bySource = new Map();
  const fresh = (list, now) => { while (list.length && now - list[0] >= WINDOW_MS) list.shift(); return list; };
  return {
    // Counts the request when it fits. retryAfterMs: when the oldest one leaves the window.
    take(source, now = Date.now()) {
      fresh(all, now);
      const own = fresh(bySource.get(source) || [], now);
      if (!own.length) bySource.delete(source);
      const blocked = own.length >= perSource ? own : all.length >= perMinute ? all : null;
      if (blocked) return { ok: false, retryAfterMs: Math.max(1000, WINDOW_MS - (now - blocked[0])) };
      all.push(now);
      own.push(now);
      bySource.set(source, own);
      return { ok: true, retryAfterMs: 0 };
    },
  };
}

// ---- the token and its state -------------------------------------------------------
function tokenFile(controlDir) { return path.join(controlDir, FILE); }

function newToken() { return crypto.randomBytes(24).toString('hex'); }

function persist(state) {
  writeJsonPrivate(tokenFile(state.controlDir), { version: 1, enabled: state.enabled, token: state.token, createdAt: state.createdAt });
}

// On by default: the token exists from the first launch, readable only by this user
// (mode 600), and the settings page can stop the door or change the token.
function load(controlDir, options = {}) {
  const now = options.now || Date.now;
  const saved = readJsonPrivate(tokenFile(controlDir));
  const valid = saved && typeof saved.token === 'string' && /^[0-9a-f]{48}$/.test(saved.token);
  const state = { controlDir, enabled: valid ? saved.enabled !== false : true, token: valid ? saved.token : newToken(),
    createdAt: valid && Number.isSafeInteger(saved.createdAt) ? saved.createdAt : now(),
    limiter: createLimiter(options), lastUsedAt: 0, lastSource: '', uses: 0 };
  // Missing, damaged or too-open files are rewritten private, with a new token.
  if (!valid) persist(state);
  return state;
}

function setEnabled(state, enabled) {
  state.enabled = enabled === true;
  persist(state);
  return state;
}

// The old token stops working at once. The limiter starts over with it.
function reset(state, now = Date.now()) {
  state.token = newToken();
  state.createdAt = now;
  state.limiter = createLimiter();
  persist(state);
  return state;
}

// What the settings page may see. Never the token.
function publicStatus(state) {
  return { enabled: state.enabled, createdAt: state.createdAt, lastUsedAt: state.lastUsedAt, lastSource: state.lastSource, uses: state.uses };
}

// For the CLI: the token and whether the door is open, or null when this AgentDeck has none.
function readCredentials(controlDir) {
  if (!controlDir) return null;
  const saved = readJsonPrivate(tokenFile(controlDir));
  if (!saved || typeof saved.token !== 'string' || !/^[0-9a-f]{48}$/.test(saved.token)) return null;
  return { token: saved.token, enabled: saved.enabled !== false };
}

// ---- the gate ---------------------------------------------------------------------
// Decides what to do with one request file the main process just read.
//   { kind: 'terminal' }          not ours: the ordinary terminal flow continues
//   { kind: 'reject', error }     ours (or claiming to be), and refused
//   { kind: 'local', result }     answered here, nothing for the page to do
//   { kind: 'forward', command }  clean command for the page; callerId is empty on purpose
function screen(state, request, context = {}) {
  const now = context.now === undefined ? Date.now() : context.now;
  const action = typeof request.action === 'string' ? request.action : '';
  const claims = action.startsWith('automation-');
  if (!state || !matches(request.token, state.token)) {
    // Another token never reaches an automation action, and a stale one is told so.
    return claims ? { kind: 'reject', error: '自动回执令牌无效，或已在设置里重置；到 AgentDeck 设置查看。' } : { kind: 'terminal' };
  }
  if (!state.enabled) return { kind: 'reject', error: '自动回执入口已在 AgentDeck 设置里停用。' };
  if (!claims || !ACTIONS.includes(action)) {
    return { kind: 'reject', error: `自动回执令牌只能用：${ACTIONS.map((a) => a.slice('automation-'.length)).join('、')}，不能执行 ${action.slice(0, 40) || '空命令'}。` };
  }
  let command;
  try { command = validate(action, request); } catch (error) { return { kind: 'reject', error: error.message }; }
  if (action === 'automation-status') return { kind: 'local', result: '自动回执入口可用。' };
  const turn = state.limiter.take(command.source, now);
  if (!turn.ok) return { kind: 'reject', error: `发得太快了：自动回执每分钟最多 ${LIMITS.perMinute} 条（同一个名字最多 ${LIMITS.perSourcePerMinute} 条）。${Math.ceil(turn.retryAfterMs / 1000)} 秒后再试。` };
  if ((context.queued || 0) >= LIMITS.queued) return { kind: 'reject', error: '还有太多自动消息在等 AgentDeck 处理，稍后再发。' };
  state.lastUsedAt = now;
  state.lastSource = command.source;
  state.uses += 1;
  const { source, ...rest } = command;
  return { kind: 'forward', command: { ...rest, id: request.id, callerId: '', submitOnly: false, dispatcherCardId: '', automation: { source, label: label(source) } } };
}

module.exports = {
  FILE, PREFIX, ACTIONS, FIELDS, LIMITS, SOURCE, matches, clean, cleanSource, label, validate, createLimiter,
  tokenFile, load, setEnabled, reset, publicStatus, readCredentials, screen,
};
