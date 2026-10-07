'use strict';
// Calendar titles are matched in memory. The private cache stores only time ranges.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { randomBytes } = require('crypto');
const Policy = require('./bark-policy');
const DAY_MS = 24 * 60 * 60_000;
const RETRY_MS = 15 * 60_000;
const MAX_BYTES = 1024 * 1024;
const MAX_PAGES = 10;
const DEFAULT_FILTERS = ['IMT 540', 'IMT 598 B'];

function settings(value = {}) {
  const list = (items, defaults, limit) => [...new Set((Array.isArray(items) ? items : defaults)
    .filter((item) => typeof item === 'string' && item.trim() && item.length <= 256 && !/[\r\n\0]/.test(item))
    .map((item) => item.trim()))].slice(0, limit);
  return { enabled: value.classesEnabled !== false,
    calendarIds: list(value.classCalendarIds, ['primary'], 8),
    filters: list(value.classFilters, DEFAULT_FILTERS, 20) };
}
function matchesClass(title, filters) {
  if (typeof title !== 'string') return false;
  const normalized = title.normalize('NFKC').toUpperCase();
  return filters.some((filter) => {
    const escaped = filter.normalize('NFKC').toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    return new RegExp(`(?:^|[^A-Z0-9])${escaped}(?=$|[^A-Z0-9])`).test(normalized);
  });
}
function eventRange(event, filters) {
  if (event?.status === 'cancelled' || event?.attendees?.some((person) => person.self && person.responseStatus === 'declined') ||
      !matchesClass(event?.summary, filters)) return null;
  const startText = event.start?.dateTime, endText = event.end?.dateTime;
  // All-day events and dates without an explicit timezone cannot identify a class period.
  const zoned = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
  if (typeof startText !== 'string' || typeof endText !== 'string' || !zoned.test(startText) || !zoned.test(endText)) return null;
  const start = Date.parse(startText), end = Date.parse(endText);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}
function createCalendarCache({ file, getSettings = () => ({}), now = Date.now, execFileImpl = execFile, env = process.env }) {
  let cache = null, pending = null;
  try {
    if (fs.statSync(file).size <= MAX_BYTES) {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value?.version === 1 && Number.isFinite(value.lastAttemptAt) && typeof value.settingsKey === 'string' &&
          ['ok', 'unavailable'].includes(value.state) && Array.isArray(value.ranges) && value.ranges.length <= 5000 &&
          value.ranges.every((range) => Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.end > range.start)) cache = value;
    }
  } catch (_) {}
  const config = () => settings(getSettings());
  const key = (value) => JSON.stringify(value);
  function usable(at, value = config()) {
    return value.enabled && cache?.settingsKey === key(value) && cache.state === 'ok' &&
      Number.isFinite(cache.fetchedAt) && at >= cache.fetchedAt && at - cache.fetchedAt < DAY_MS &&
      at >= cache.rangeStart && at < cache.rangeEnd;
  }
  function persist() {
    const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } catch (_) { try { fs.unlinkSync(temporary); } catch (_) {} }
  }
  function readPage(params) {
    return new Promise((resolve, reject) => {
      try {
        execFileImpl(process.platform === 'win32' ? 'gws.exe' : 'gws', ['calendar', 'events', 'list', '--params', JSON.stringify(params), '--format', 'json'],
          { windowsHide: true, shell: false, env, timeout: 10_000, maxBuffer: MAX_BYTES, encoding: 'utf8' }, (error, stdout) => {
            if (error) return reject(new Error('calendar-unavailable'));
            try {
              if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_BYTES) throw new Error('invalid-calendar');
              const value = JSON.parse(stdout);
              if (!value || typeof value !== 'object' || Array.isArray(value) || value.error ||
                  value.items != null && !Array.isArray(value.items) || value.nextPageToken != null && typeof value.nextPageToken !== 'string') throw new Error('invalid-calendar');
              resolve({ ...value, items: value.items || [] });
            } catch (_) { reject(new Error('calendar-unavailable')); }
          });
      } catch (_) { reject(new Error('calendar-unavailable')); }
    });
  }
  function refresh(force = false) {
    // Settings may change during an in-flight query. Wait for it, then check
    // the current calendar selection before callers decide whether to send.
    if (pending) return pending.then(() => refresh(force));
    const value = config(), at = now(), settingsKey = key(value);
    if (!value.enabled || !value.calendarIds.length || !value.filters.length) return Promise.resolve(status());
    const interval = cache?.state === 'ok' ? DAY_MS : RETRY_MS;
    if (!force && cache?.settingsKey === settingsKey && at >= cache.lastAttemptAt && at - cache.lastAttemptAt < interval) return Promise.resolve(status());
    pending = (async () => {
      const ranges = [], rangeEnd = at + 14 * DAY_MS;
      try {
        for (const calendarId of value.calendarIds) {
          let pageToken;
          for (let page = 0; page < MAX_PAGES; page++) {
            const result = await readPage({ calendarId, singleEvents: true, showDeleted: false,
              timeMin: new Date(at).toISOString(), timeMax: new Date(rangeEnd).toISOString(), maxResults: 250,
              orderBy: 'startTime', fields: 'items(status,summary,start,end,attendees(self,responseStatus)),nextPageToken',
              ...(pageToken ? { pageToken } : {}) });
            for (const event of result.items) {
              const range = eventRange(event, value.filters);
              if (range && range.end > at && range.start < rangeEnd) ranges.push(range);
              if (ranges.length > 5000) throw new Error('too-many-calendar-ranges');
            }
            if (!result.nextPageToken) break;
            if (result.nextPageToken === pageToken || page === MAX_PAGES - 1) throw new Error('incomplete-calendar');
            pageToken = result.nextPageToken;
          }
        }
        cache = { version: 1, settingsKey, lastAttemptAt: at, fetchedAt: at, rangeStart: at, rangeEnd,
          state: 'ok', ranges: [...new Map(ranges.map((range) => [`${range.start}:${range.end}`, range])).values()].sort((a, b) => a.start - b.start) };
      } catch (_) {
        // Failed or incomplete reads cannot become a false "no classes" answer.
        cache = { version: 1, settingsKey, lastAttemptAt: at, state: 'unavailable', ranges: [] };
      }
      persist();
      return status();
    })().finally(() => { pending = null; });
    return pending.then(() => refresh());
  }
  function status() {
    const at = now(), value = config();
    return { available: usable(at, value), state: !value.enabled ? 'disabled' : usable(at, value) ? 'ready' :
      cache?.settingsKey === key(value) && cache.state === 'ok' ? 'stale' : 'unavailable',
      fallback: value.enabled && !usable(at, value) && Policy.settings(getSettings()).weeklyClasses.length > 0,
      fetchedAt: cache?.fetchedAt || null, lastAttemptAt: cache?.lastAttemptAt || null };
  }
  return { refresh, ranges: (at = now()) => usable(at) ? cache.ranges.map((range) => ({ ...range })) : Policy.weeklyRanges(at, getSettings()), status };
}
module.exports = { DAY_MS, RETRY_MS, DEFAULT_FILTERS, matchesClass, eventRange, createCalendarCache };
