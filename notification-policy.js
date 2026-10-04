(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotificationPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const QUIET_MS = 12000;
  const SOUND_COOLDOWN_MS = 30000;
  function isManualColumn(col) {
    return !!col && !col.isMain && !col.captainCrew && !col.parentTaskId && (col.role || 'manual') === 'manual';
  }
  function normalizeSettings(value) {
    const s = value || {};
    return { enabled: s.enabled !== false, sound: s.sound !== false,
      tone: ['Glass', 'Tink'].includes(s.tone) ? s.tone : 'Glass' };
  }
  function firstSentence(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim().replace(/^[#>*\-•⏺\s]+/, '').replace(/[ \t]+/g, ' ');
    const sentence = text.match(/^.*?(?:[。！？!?]|\.(?=\s|$)|\n|$)/u)?.[0] || '';
    return Array.from(sentence.trim()).slice(0, 60).join('');
  }
  return { QUIET_MS, SOUND_COOLDOWN_MS, isManualColumn, normalizeSettings, firstSentence };
});
