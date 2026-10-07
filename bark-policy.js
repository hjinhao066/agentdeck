(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BarkPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const validTime = (s) => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
  const defaultClasses = [{ day: 2, start: '10:30', end: '12:20' }, { day: 4, start: '10:30', end: '12:20' },
    { day: 2, start: '15:30', end: '17:20' }];
  function settings(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    const start = validTime(value.sleepStart) ? value.sleepStart : '23:00';
    const end = validTime(value.sleepEnd) ? value.sleepEnd : '10:00';
    const strings = (list, defaults) => Array.isArray(list) && list.length && list.length <= 20 &&
      list.every((s) => typeof s === 'string' && s.trim() && s.length <= 200 && !/[\x00-\x1f]/.test(s)) ? list.map((s) => s.trim()) : defaults;
    return { criticalVolume: Number.isInteger(value.criticalVolume) && value.criticalVolume >= 0 && value.criticalVolume <= 10 ? value.criticalVolume : 4,
      sleepEnabled: value.sleepEnabled !== false, sleepStart: start === end ? '23:00' : start, sleepEnd: start === end ? '10:00' : end,
      classesEnabled: value.classesEnabled !== false, classCalendarIds: strings(value.classCalendarIds, ['primary']),
      classFilters: strings(value.classFilters, ['IMT 540', 'IMT 598 B']),
      weeklyClasses: (Array.isArray(value.weeklyClasses) ? value.weeklyClasses : defaultClasses)
        .filter((p) => Number.isInteger(p?.day) && p.day >= 0 && p.day <= 6 && validTime(p.start) && validTime(p.end) && p.start < p.end)
        .slice(0, 35).map(({ day, start, end }) => ({ day, start, end })) };
  }
  const zone = 'America/Los_Angeles';
  const clock = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function wall(at) {
    const parts = Object.fromEntries(clock.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
    return { date: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)), hour: parts.hour, minute: parts.minute };
  }
  function epoch(date, hour, minute) {
    const target = date.getTime() + (hour * 60 + minute) * 60_000;
    let at = target;
    // Convert a Seattle wall time back to an instant, including DST offsets.
    for (let i = 0; i < 3; i++) {
      const shown = wall(at), difference = target - (shown.date.getTime() + (shown.hour * 60 + shown.minute) * 60_000);
      at += difference;
      if (!difference) break;
    }
    return at;
  }
  function weeklyRanges(at, value) {
    const options = settings(value);
    if (!options.classesEnabled) return [];
    const ranges = [], today = wall(at).date;
    for (let offset = -1; offset <= 14; offset++) {
      const date = new Date(today); date.setUTCDate(date.getUTCDate() + offset);
      for (const period of options.weeklyClasses) if (date.getUTCDay() === period.day) {
        ranges.push({ start: epoch(date, ...period.start.split(':').map(Number)), end: epoch(date, ...period.end.split(':').map(Number)) });
      }
    }
    return ranges;
  }
  function sleepEnd(at, options) {
    if (!options.sleepEnabled) return at;
    const [sh, sm] = options.sleepStart.split(':').map(Number), [eh, em] = options.sleepEnd.split(':').map(Number);
    const start = sh * 60 + sm, end = eh * 60 + em, shown = wall(at), minute = shown.hour * 60 + shown.minute;
    const blocked = start > end ? minute >= start || minute < end : minute >= start && minute < end;
    if (!blocked) return at;
    if (start > end && minute >= start) shown.date.setUTCDate(shown.date.getUTCDate() + 1);
    return epoch(shown.date, eh, em);
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
  return { settings, blockedUntil, weeklyRanges, timeZone: zone };
});
