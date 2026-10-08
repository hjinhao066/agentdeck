'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('the preload hands the page sleep and wake with main\'s own timestamp', () => {
  const exposed = {}, listeners = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { on: (ch, fn) => { listeners[ch] = fn; }, send() {}, invoke: async () => undefined, removeListener() {}, sendSync: () => ({}) },
    webUtils: { getPathForFile: () => '' },
  };
  const load = Module._load;
  Module._load = (request, ...rest) => request === 'electron' ? electron : load(request, ...rest);
  try { delete require.cache[require.resolve('../preload')]; require('../preload'); } finally { Module._load = load; }
  const seen = [];
  exposed.deck.onPowerSleep((asleep, at) => seen.push([asleep, at]));
  listeners['power:sleep']({}, { asleep: true, at: 1234 });
  listeners['power:sleep']({}, { asleep: false, at: 5678 });
  const before = Date.now();
  listeners['power:sleep']({}, undefined);
  assert.deepEqual(seen.slice(0, 2), [[true, 1234], [false, 5678]]);
  assert.equal(seen[2][0], false);
  assert.ok(seen[2][1] >= before, 'a malformed message falls back to now');
});
