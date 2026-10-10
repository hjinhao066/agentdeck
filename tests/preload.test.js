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
    ipcRenderer: { on() {}, send() {}, invoke: async (channel, payload) => { sent.push(payload === undefined ? [channel] : [channel, payload]); return invoke(channel, payload); }, removeListener() {},
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

test('copy goes through main and resolves only once main says the text is on the clipboard', async () => {
  let held = '';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { deck, sent } = loadPreload((channel) => (channel === 'clipboard:read-sync' ? held : null), async (channel, payload) => {
    if (channel === 'clipboard:write') { await gate; held = payload; return true; }
    return undefined;
  });
  let settled = false;
  const copy = deck.clipboardWrite('login-token-value').then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the copy is not reported before main answered');
  release();
  await copy;
  assert.equal(held, 'login-token-value');
  assert.equal(deck.clipboardRead(), 'login-token-value');
  assert.deepEqual(sent.map((m) => m[0]), ['clipboard:write', 'clipboard:read-sync']);
});

test('a clipboard write main refused or could not make rejects instead of reporting a copy that did not happen', async () => {
  for (const answer of [false, undefined, null, 'true', {}]) {
    const { deck } = loadPreload(() => null, async () => answer);
    await assert.rejects(() => deck.clipboardWrite('value'), /Clipboard write failed/);
  }
  const broken = loadPreload(() => null, async () => { throw new Error('Rejected IPC'); });
  await assert.rejects(() => broken.deck.clipboardWrite('value'));
  assert.equal(broken.deck.clipboardRead(), '');
});

test('what a failed paste found on the clipboard comes back as a kind, never as content', async () => {
  const other = loadPreload(() => null, async (channel) => (channel === 'clipboard:kind' ? 'other' : undefined));
  assert.equal(await other.deck.clipboardKind(), 'other');
  const garbage = loadPreload(() => null, async () => ({ text: 'secret' }));
  assert.equal(await garbage.deck.clipboardKind(), 'none');
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
