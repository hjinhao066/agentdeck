const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The modules Electron 44 hands a preload script. `clipboard` is not among
// them, so anything the preload takes from it is undefined at run time.
function loadPreload(sendSync, invoke = async () => undefined) {
  const exposed = {};
  const sent = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    crashReporter: {}, nativeImage: {}, webFrame: {},
    ipcRenderer: { on() {}, send() {}, invoke: async (channel) => { sent.push([channel]); return invoke(channel); }, removeListener() {},
      sendSync: (channel, payload) => { sent.push([channel, payload]); return sendSync(channel, payload); } },
    webUtils: { getPathForFile: () => '' },
  };
  const load = Module._load;
  Module._load = (request, ...rest) => request === 'electron' ? electron : load(request, ...rest);
  try {
    delete require.cache[require.resolve('../preload')];
    require('../preload');
  } finally { Module._load = load; }
  return { deck: exposed.deck, sent };
}

test('copy and paste go through main because a preload has no clipboard module', () => {
  let held = '';
  const { deck, sent } = loadPreload((channel, payload) => {
    if (channel === 'clipboard:write-sync') { held = payload; return true; }
    if (channel === 'clipboard:read-sync') return held;
    return null;
  });
  deck.clipboardWrite('login-token-value');
  assert.equal(held, 'login-token-value');
  assert.equal(deck.clipboardRead(), 'login-token-value');
  assert.deepEqual(sent, [['clipboard:write-sync', 'login-token-value'], ['clipboard:read-sync', undefined]]);
});

test('a rejected clipboard write throws instead of reporting a copy that did not happen', () => {
  const { deck } = loadPreload(() => null);
  assert.throws(() => deck.clipboardWrite('value'), /Clipboard write failed/);
  assert.equal(deck.clipboardRead(), '');
});

test('the real clipboard read is asynchronous and an unreadable clipboard is an empty string', async () => {
  const text = loadPreload(() => null, async (channel) => (channel === 'clipboard:read' ? 'from main' : undefined));
  assert.equal(await text.deck.clipboardReadText(), 'from main');
  assert.deepEqual(text.sent, [['clipboard:read']]);
  const none = loadPreload(() => null, async () => ({}));
  assert.equal(await none.deck.clipboardReadText(), '');
});

test('Chromium paste is requested through main and reports whether it ran', async () => {
  const ran = loadPreload(() => null, async (channel) => channel === 'clipboard:native-paste');
  assert.equal(await ran.deck.clipboardNativePaste(), true);
  const refused = loadPreload(() => null, async () => false);
  assert.equal(await refused.deck.clipboardNativePaste(), false);
});
