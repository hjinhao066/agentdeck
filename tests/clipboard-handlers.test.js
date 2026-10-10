'use strict';
// Electron 44's clipboard is asynchronous: writeText, readText, read and has return Promises,
// and readImage is gone. These tests run the real handlers out of main.js against a fake
// asynchronous clipboard with that shape. They never touch the machine's clipboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const between = (from, to) => {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `main.js still has ${from} ... ${to}`);
  return source.slice(a, b);
};
const clipboardBlock = between("  let testClipboard = '';", "  onMain('env-info-sync'");
const imageBlock = between('  // Pasted screenshots older than 24h',"\n  // Composer \"+\"");

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // the first bytes of a PNG: content is not parsed
const TEXT = 'copied words';

// The fake: every method answers late (a macrotask), as the real ones do. `held` makes writes
// and reads fail the way another program holding the clipboard open does.
function fakeClipboard(initial = {}) {
  const state = { text: initial.text || '', png: initial.png || null, other: initial.other || [], held: false, calls: [] };
  const later = (fn) => new Promise((resolve, reject) => setImmediate(() => { try { resolve(fn()); } catch (e) { reject(e); } }));
  const types = () => [state.text && 'text/plain', state.png && 'image/png', ...state.other].filter(Boolean);
  const clipboard = {
    async writeText(text) { state.calls.push('writeText'); return later(() => { if (state.held) throw new Error('OpenClipboard failed'); state.text = text; state.png = null; state.other = []; }); },
    async readText() { state.calls.push('readText'); return later(() => { if (state.held) throw new Error('OpenClipboard failed'); return state.text; }); },
    async has(type) { state.calls.push('has'); return later(() => types().includes(type)); },
    async read() {
      state.calls.push('read');
      return later(() => {
        if (state.held) throw new Error('OpenClipboard failed');
        if (!types().length) return [];
        return [{
          types: types(),
          async getType(type) {
            if (type === 'text/plain' && state.text) return new Blob([state.text], { type });
            if (type === 'image/png' && state.png) return new Blob([state.png], { type });
            throw new Error('not present');
          },
        }];
      });
    },
    async write() { throw new Error('not used'); },
    clear() { state.text = ''; state.png = null; state.other = []; },
    // readImage is not here on purpose: it does not exist in Electron 44.
  };
  return { clipboard, state };
}

function driver(t, { tud = false, clip = {}, testAppState = {}, seed } = {}) {
  const fake = fakeClipboard(clip);
  const pasteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-clipboard-handlers-'));
  t.after(() => fs.rmSync(pasteDir, { recursive: true, force: true }));
  if (seed) seed(pasteDir);
  const handlers = {}, syncHandlers = {}, logs = [];
  const context = vm.createContext({
    handleMain: (name, fn) => { handlers[name] = fn; },
    onMain: (name, fn) => { syncHandlers[name] = fn; },
    tudArg: tud ? '--test-user-data=/nowhere' : undefined,
    app: { ...testAppState },
    clipboard: fake.clipboard,
    nlog: (line) => logs.push(line),
    fs, path, Buffer, Date, PASTE_DIR: pasteDir,
  });
  vm.runInContext(clipboardBlock + imageBlock, context);
  return {
    ...fake, handlers, logs, pasteDir, app: context.app,
    write: (text) => handlers['clipboard:write'](null, text),
    readText: () => handlers['clipboard:read'](null),
    kind: () => handlers['clipboard:kind'](null),
    saveImage: () => handlers['paste-image:save'](null),
    readSync: () => { const e = {}; syncHandlers['clipboard:read-sync'](e); return e.returnValue; },
    saved: () => fs.readdirSync(pasteDir),
  };
}

// ---- 1. a copy reports success only when the write is done ----

test('a copy is true only after writeText has finished, and the clipboard then holds the text', async (t) => {
  const d = driver(t);
  let answered = false;
  const pending = d.write(TEXT).then((ok) => { answered = true; return ok; });
  assert.equal(answered, false, 'not answered in the same breath');
  assert.equal(d.state.text, '', 'the write has not landed yet either');
  assert.equal(await pending, true);
  assert.equal(d.state.text, TEXT);
  assert.deepEqual(d.state.calls, ['writeText']);
});

test('a copy whose write fails is false, never true, and the log does not carry the text', async (t) => {
  const d = driver(t, { clip: { text: 'old' } });
  d.state.held = true;
  assert.equal(await d.write(TEXT), false);
  assert.equal(d.state.text, 'old', 'the old content is untouched');
  assert.equal(d.logs.length, 1);
  assert.doesNotMatch(d.logs[0], new RegExp(TEXT));
  d.state.held = false;
  assert.equal(await d.write(TEXT), true, 'the same copy works once the clipboard is free');
});

test('a copy of something that is not a string is refused without touching the clipboard', async (t) => {
  const d = driver(t);
  for (const bad of [undefined, null, 5, {}, ['x']]) assert.equal(await d.write(bad), false);
  assert.deepEqual(d.state.calls, []);
});

test('copy then read gives back what was copied (the paste right after a copy sees the new text)', async (t) => {
  const d = driver(t, { clip: { text: 'stale' } });
  assert.equal(await d.write(TEXT), true);
  assert.equal(await d.readText(), TEXT);
});

// ---- 2. reading ----

test('reading the text waits for the asynchronous read; a failed read is an empty string', async (t) => {
  const d = driver(t, { clip: { text: TEXT } });
  assert.equal(await d.readText(), TEXT);
  d.state.held = true;
  assert.equal(await d.readText(), '');
  assert.equal(d.readSync(), '', 'a synchronous reply cannot carry an asynchronous read');
});

// ---- 3. the picture: four clipboards ----

test('clipboard with a picture only: the picture is saved as a PNG file and its path comes back', async (t) => {
  const d = driver(t, { clip: { png: PNG } });
  const file = await d.saveImage();
  assert.ok(file && file.startsWith(d.pasteDir) && file.endsWith('.png'), String(file));
  assert.deepEqual(fs.readFileSync(file), PNG);
  assert.ok(!d.state.calls.includes('readImage'), 'readImage does not exist in Electron 44 and is not used');
});

test('clipboard with text only: no picture, nothing saved', async (t) => {
  const d = driver(t, { clip: { text: TEXT } });
  assert.equal(await d.saveImage(), null);
  assert.deepEqual(d.saved(), []);
});

test('clipboard with a picture AND text: only the text is pasted, the picture is not saved', async (t) => {
  const d = driver(t, { clip: { text: TEXT, png: PNG } });
  assert.equal(await d.readText(), TEXT, 'the text is there to paste');
  assert.equal(await d.saveImage(), null, 'and the picture is left alone');
  assert.deepEqual(d.saved(), []);
});

test('empty clipboard: nothing to paste, nothing saved', async (t) => {
  const d = driver(t);
  assert.equal(await d.readText(), '');
  assert.equal(await d.saveImage(), null);
  assert.deepEqual(d.saved(), []);
});

test('a clipboard that cannot be read answers null for the picture, never an error', async (t) => {
  const d = driver(t, { clip: { png: PNG } });
  d.state.held = true;
  assert.equal(await d.saveImage(), null);
  d.state.held = false;
  d.state.png = Buffer.alloc(0);
  assert.equal(await d.saveImage(), null, 'an empty picture is no picture');
});

test('a clipboard with other content only (files, rich data) has no picture to save', async (t) => {
  const d = driver(t, { clip: { other: ['text/uri-list'] } });
  assert.equal(await d.saveImage(), null);
});

// ---- 4. what a failed paste found ----

test('the kind of a clipboard without text: picture, other, or nothing; a held clipboard is nothing', async (t) => {
  assert.equal(await driver(t, { clip: { png: PNG } }).kind(), 'image');
  assert.equal(await driver(t, { clip: { other: ['text/uri-list'] } }).kind(), 'other');
  assert.equal(await driver(t, { clip: { text: TEXT } }).kind(), 'text');
  assert.equal(await driver(t).kind(), 'none');
  const held = driver(t, { clip: { other: ['text/uri-list'] } });
  held.state.held = true;
  assert.equal(await held.kind(), 'none');
});

test('the kind never returns content', async (t) => {
  const d = driver(t, { clip: { text: TEXT, png: PNG } });
  const kind = await d.kind();
  assert.equal(typeof kind, 'string');
  assert.ok(['text', 'image', 'other', 'none'].includes(kind));
});

// ---- 5. Chromium's own paste ----

test("Chromium's paste runs on the asking page; a gone page or a test profile does nothing", async (t) => {
  const d = driver(t);
  let pasted = 0;
  assert.equal(await d.handlers['clipboard:native-paste']({ sender: { isDestroyed: () => false, paste: () => pasted++ } }), true);
  assert.equal(pasted, 1);
  assert.equal(await d.handlers['clipboard:native-paste']({ sender: { isDestroyed: () => true, paste: () => pasted++ } }), false);
  assert.equal(await d.handlers['clipboard:native-paste']({}), false);
  assert.equal(pasted, 1);
  const test = driver(t, { tud: true });
  assert.equal(await test.handlers['clipboard:native-paste']({ sender: { isDestroyed: () => false, paste: () => pasted++ } }), false);
  assert.equal(pasted, 1);
});

// ---- 6. a test profile never touches the real clipboard ----

test('a test profile has its own in-memory clipboard and never calls the real one', async (t) => {
  const d = driver(t, { tud: true, clip: { text: 'THE USERS REAL CLIPBOARD' } });
  assert.equal(await d.write('private'), true);
  assert.equal(await d.readText(), 'private');
  assert.equal(d.readSync(), 'private');
  assert.equal(await d.kind(), 'text');
  assert.equal(await driver(t, { tud: true }).kind(), 'none');
  assert.equal(await d.saveImage(), null);
  assert.deepEqual(d.state.calls, [], 'not one call reached the clipboard');
  assert.equal(d.state.text, 'THE USERS REAL CLIPBOARD');
});

test('a test profile can hold a picture and can make copies fail', async (t) => {
  const d = driver(t, { tud: true, testAppState: { testClipboardImage: PNG } });
  const file = await d.saveImage();
  assert.deepEqual(fs.readFileSync(file), PNG);
  await d.write('words');
  assert.equal(await d.saveImage(), null, 'text next to the picture: text wins in a test profile too');
  d.app.testClipboardWriteFails = true;
  assert.equal(await d.write('more'), false);
  assert.equal(await d.readText(), 'words', 'a failed copy changed nothing');
  assert.deepEqual(d.state.calls, []);
});

// ---- 4. the temp folder of pasted pictures is swept on every save, not only at launch ----

const aged = (dir, name, hours) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, PNG);
  const when = new Date(Date.now() - hours * 3_600_000);
  fs.utimesSync(file, when, when);
  return name;
};

test('saving a picture removes pasted pictures older than 24 hours and keeps the newer ones', async (t) => {
  let fresh, stale;
  // The app has been open for days: these were left by earlier pastes. The launch sweep runs
  // first, so they are put in place after the handlers exist.
  const d = driver(t, { clip: { png: PNG } });
  stale = [aged(d.pasteDir, 'paste-1.png', 25), aged(d.pasteDir, 'paste-2.png', 100)];
  fresh = [aged(d.pasteDir, 'paste-3.png', 23), aged(d.pasteDir, 'paste-4.png', 0.01)];
  assert.equal(d.saved().length, 4);
  const file = await d.saveImage();
  const left = d.saved();
  for (const name of stale) assert.ok(!left.includes(name), `${name} is gone`);
  for (const name of fresh) assert.ok(left.includes(name), `${name} stays`);
  assert.ok(left.includes(path.basename(file)), 'and the picture just saved is there');
});

test('the launch sweep still runs, and a file that cannot be removed does not stop the rest', (t) => {
  const d = driver(t, { seed: (dir) => { aged(dir, 'paste-old.png', 30); aged(dir, 'paste-new.png', 1); fs.mkdirSync(path.join(dir, 'locked')); } });
  assert.deepEqual(d.saved().sort(), ['locked', 'paste-new.png'], 'a directory (unlink fails) is left, the old picture went');
});

test('a clipboard with no picture saves nothing and sweeps nothing', async (t) => {
  const d = driver(t, { clip: { text: TEXT } });
  aged(d.pasteDir, 'paste-old.png', 30);
  assert.equal(await d.saveImage(), null);
  assert.deepEqual(d.saved(), ['paste-old.png']);
});
