(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BarkPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const validTime = (s) => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
  function settings(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    const start = validTime(value.sleepStart) ? value.sleepStart : '23:00';
    const end = validTime(value.sleepEnd) ? value.sleepEnd : '10:00';
    const strings = (list, defaults) => Array.isArray(list) && list.length && list.length <= 20 &&
      list.every((s) => typeof s === 'string' && s.trim() && s.length <= 200 && !/[\x00-\x1f]/.test(s)) ? list.map((s) => s.trim()) : defaults;
    return { criticalVolume: Number.isInteger(value.criticalVolume) && value.criticalVolume >= 0 && value.criticalVolume <= 10 ? value.criticalVolume : 4,
      sleepEnabled: value.sleepEnabled !== false, sleepStart: start === end ? '23:00' : start, sleepEnd: start === end ? '10:00' : end,
      classesEnabled: value.classesEnabled !== false, classCalendarIds: strings(value.classCalendarIds, ['primary']),
      classFilters: strings(value.classFilters, ['IMT 540', 'IMT 598 B']) };
  }
  function sleepEnd(at, options) {
    if (!options.sleepEnabled) return at;
    const [sh, sm] = options.sleepStart.split(':').map(Number), [eh, em] = options.sleepEnd.split(':').map(Number);
    const start = sh * 60 + sm, end = eh * 60 + em, d = new Date(at), minute = d.getHours() * 60 + d.getMinutes();
    const blocked = start > end ? minute >= start || minute < end : minute >= start && minute < end;
    if (!blocked) return at;
    if (start > end && minute >= start) d.setDate(d.getDate() + 1);
    d.setHours(eh, em, 0, 0); return d.getTime();
  }
  function blockedUntil(at, value, classes = []) {
    const options = settings(value);
    let end = at;
    // Overlapping sleep/classes can extend each other; touching end boundaries
    // are open, so a class ending at 12:20 releases reminders at 12:20.
    for (let i = 0; i <= 2 * classes.length + 2; i++) {
      let next = sleepEnd(end, options);
      if (options.classesEnabled) for (const range of classes) {
        if (Number.isFinite(range.start) && Number.isFinite(range.end) && range.start <= end && end < range.end) next = Math.max(next, range.end);
      }
      if (next === end) break;
      end = next;
    }
    return end > at ? end : null;
  }
  return { settings, blockedUntil };
});
