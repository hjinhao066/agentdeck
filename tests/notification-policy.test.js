const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { normalizeSettings, firstSentence } = require('../notification-policy');
const { createNotifications } = require('../notifications');

function harness(platform = 'darwin') {
  let clock = 0, focused = false, supported = true;
  const config = { columns: [{ id: 'captain', isMain: true }, { id: 'crew', captainCrew: true }] };
  const events = [], items = [];
  class Notification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; items.push(this); }
    show() { events.push({ type: 'show', ...this.options }); }
    close() { events.push({ type: 'close' }); }
  }
  const alerts = createNotifications({ Notification, getConfig: () => config, platform,
    getMainWindow: () => ({ isDestroyed: () => false, isFocused: () => focused, isMinimized: () => false }),
    now: () => clock, playSound: (tone) => events.push({ type: 'sound', tone }),
    focusColumn: (id) => events.push({ type: 'focus', id }) });
  return { alerts, config, events, items, time: (v) => { clock = v; },
    focus: (v) => { focused = v; }, supported: (v) => { supported = v; },
    show: (turnId, extra = {}) => alerts.show({ id: 'captain', turnId, state: 'done', reply: '已经完成。第二句。', visible: false, ...extra }) };
}
test('settings normalize safely and first sentence is limited by Unicode characters', () => {
  assert.deepEqual(normalizeSettings(), { enabled: true, sound: true, tone: 'Glass' });
  assert.deepEqual(normalizeSettings({ enabled: false, sound: false, tone: '../bad' }), { enabled: false, sound: false, tone: 'Glass' });
  assert.equal(firstSentence('# 已完成。后续说明'), '已完成。');
  assert.equal(firstSentence('Done. Next step.'), 'Done.');
  assert.equal(firstSentence('Version 0.9.9 is ready! Next.'), 'Version 0.9.9 is ready!');
  assert.equal(firstSentence('😀'.repeat(70)), '😀'.repeat(60));
  assert.equal(firstSentence(null), '');
});
test('only Captain alerts, including peeked/foreground workers and invalid payloads', () => {
  const h = harness();
  h.show('t1', { id: 'crew' });
  h.show('t1', { id: 'other' });
  h.show('t1', { state: 'working' });
  h.show('', {});
  assert.deepEqual(h.events, []);
  h.show('t1');
  assert.deepEqual(h.events, [{ type: 'show', title: '队长', body: '已经完成。', silent: true }, { type: 'sound', tone: 'Glass' }]);
});
test('input/completion share a turn; resume/cancel cannot cause a second alert; 30s sound cooldown', () => {
  const h = harness();
  h.show('t1', { state: 'input' });
  h.alerts.cancel('captain');
  h.time(20000); h.show('t1'); h.show('t2');
  assert.equal(h.events.filter((e) => e.type === 'show').length, 2);
  assert.equal(h.events.filter((e) => e.type === 'sound').length, 1);
  h.time(30000); h.show('t3');
  assert.equal(h.events.filter((e) => e.type === 'sound').length, 2);
});
test('foreground plus visible Captain mutes; hidden Captain or background app sounds', () => {
  const h = harness(); h.focus(true);
  h.show('t1', { visible: true });
  assert.equal(h.events.filter((e) => e.type === 'sound').length, 0);
  h.show('t2', { visible: false });
  assert.equal(h.events.filter((e) => e.type === 'sound').length, 1);
  h.time(30000); h.focus(false); h.show('t3', { visible: true });
  assert.equal(h.events.filter((e) => e.type === 'sound').length, 2);
});
test('preferences independently gate notifications and playback, with whitelisted tones', () => {
  const h = harness();
  h.config.captainNotifications = { enabled: false, sound: true, tone: 'Tink' }; h.show('t1');
  assert.deepEqual(h.events, [{ type: 'sound', tone: 'Tink' }]);
  h.config.captainNotifications = { enabled: true, sound: false }; h.show('t2');
  assert.equal(h.events.filter((e) => e.type === 'show').length, 1);
  assert.equal(h.events.filter((e) => e.type === 'sound').length, 1);
  h.config.captainNotifications = { enabled: false, sound: false }; h.show('t3');
  assert.equal(h.events.filter((e) => e.type === 'show').length, 1);
  assert.equal(h.events.filter((e) => e.type === 'sound').length, 1);
});
test('click targets Captain and stale cancelled native alerts never focus another session', () => {
  const h = harness(); h.show('t1');
  h.items[0].emit('click');
  assert.deepEqual(h.events.at(-1), { type: 'focus', id: 'captain' });
  h.show('t2'); h.alerts.cancel('captain'); h.items[1].emit('click');
  assert.equal(h.events.filter((e) => e.type === 'focus').length, 1);
});
test('Windows uses native default sound; unsupported notifications gracefully skip', () => {
  const h = harness('win32'); h.show('t1');
  assert.equal(h.events[0].silent, false);
  h.time(10000); h.show('t2'); assert.equal(h.events.at(-1).silent, true);
  assert.equal(h.events.filter((e) => e.type === 'sound').length, 0);
  const unavailable = harness('win32'); unavailable.supported(false); unavailable.show('t1');
  assert.deepEqual(unavailable.events, []);
});
