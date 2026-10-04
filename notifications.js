'use strict';
const { validId } = require('./security');
const { normalizeSettings, firstSentence, SOUND_COOLDOWN_MS } = require('./notification-policy');

// Native OS alerts only. The caller rechecks the current Captain and preferences.
function createNotifications({ Notification, getMainWindow, focusColumn, playSound,
  getConfig, now = Date.now, platform = process.platform }) {
  const items = new Map();
  const seen = new Set();
  let lastSoundAt = -Infinity;
  function cancel(id) {
    const item = items.get(id);
    items.delete(id);
    if (item) item.close();
  }
  return {
    show(payload) {
      if (!payload || !validId(payload.id) || typeof payload.turnId !== 'string' ||
          !payload.turnId || payload.turnId.length > 120 || !['input', 'done'].includes(payload.state)) return;
      const config = getConfig();
      const captain = (config.columns || []).find((c) => c.isMain && c.id === payload.id);
      if (!captain) return;
      const body = firstSentence(payload.reply);
      if (!body) return;
      const key = payload.id + ':' + payload.turnId;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 200) seen.delete(seen.values().next().value);
      const settings = normalizeSettings(config.captainNotifications);
      const win = getMainWindow();
      const visible = win && !win.isDestroyed() && win.isFocused() && !win.isMinimized() && payload.visible === true;
      const audible = settings.sound && !visible && now() - lastSoundAt >= SOUND_COOLDOWN_MS;
      cancel(payload.id);
      if (settings.enabled && Notification.isSupported()) {
        try {
          const item = new Notification({ title: '队长', body,
            // macOS playback is separate so volume stays gentle and predictable.
            silent: platform !== 'win32' || !audible });
          items.set(payload.id, item);
          item.on('click', () => { if (items.get(payload.id) === item) { cancel(payload.id); focusColumn(payload.id); } });
          item.on('failed', () => { if (items.get(payload.id) === item) items.delete(payload.id); });
          item.show();
          if (platform === 'win32' && audible) lastSoundAt = now();
        } catch (_) { /* Unsupported/unavailable OS notifications are optional. */ }
      }
      if (platform === 'darwin' && audible) {
        lastSoundAt = now();
        playSound(settings.tone);
      }
    },
    cancel,
    dispose() { for (const id of items.keys()) cancel(id); },
  };
}
module.exports = { createNotifications };
