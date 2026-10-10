const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Ctrl+V in a terminal column when the clipboard reads empty. Another program (clipboard
// history, Ditto, PixPin) has the clipboard open for a moment each time it changes, and a
// read made then comes back empty. A test profile keeps its own in-memory clipboard, so the
// busy moment is simulated where the read happens: the main process answers 'clipboard:read'
// with '' until a deadline. The key must read again for about half a second, then ask
// Chromium to paste, then say so. Chromium's paste is a stand-in that delivers TEXT as a paste
// event (the real one reads the user's clipboard, which a test never touches).
// The same ladder runs on a Mac (Ctrl+V there; Cmd+V is native and untouched).
// The program in the column writes down every byte it receives.
test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(__dirname, '../..');
const ID = 'paste';
const TEXT = 'PASTE-RETRY-8842';
let app, page, profile, keyLog;

const received = () => (fs.existsSync(keyLog) ? Buffer.from(fs.readFileSync(keyLog, 'utf8').replace(/\s+/g, ''), 'hex').toString('latin1') : '');
const count = (text) => received().split(text).length - 1;
const setClipboard = (text) => page.evaluate((t) => window.deck.clipboardWrite(t), text);
// The main-process stand-ins are installed by the first test that needs them, so the first test
// runs against the real handlers.
const installStandIns = () => app.evaluate(({ ipcMain }, text) => {
  if (globalThis.__standIns) return;
  globalThis.__standIns = true;
  globalThis.__clipBusyUntil = 0;
  globalThis.__clip = '';
  globalThis.__nativeCalls = 0;
  globalThis.__nativeWorks = false;
  ipcMain.removeHandler('clipboard:write');
  ipcMain.handle('clipboard:write', (e, t) => { if (typeof t !== 'string') return false; globalThis.__clip = t; return true; });
  globalThis.__nativeDelay = 0;
  ipcMain.removeHandler('clipboard:read');
  ipcMain.handle('clipboard:read', () => (Date.now() < globalThis.__clipBusyUntil ? '' : globalThis.__clip));
  ipcMain.removeHandler('clipboard:native-paste');
  ipcMain.handle('clipboard:native-paste', (e) => {
    globalThis.__nativeCalls++;
    if (!globalThis.__nativeWorks) return true; // Chromium ran, but the clipboard gave it nothing
    // The paste event can come late: __nativeDelay is how long after the request.
    e.sender.executeJavaScript(`setTimeout(() => {
      const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(text)});
      document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, ${Number(globalThis.__nativeDelay) || 0})`);
    return true;
  });
}, TEXT);
const busyFor = (ms) => app.evaluate((_, n) => { globalThis.__clipBusyUntil = Date.now() + n; }, ms);
const nativeWorks = (on) => app.evaluate((_, v) => { globalThis.__nativeWorks = v; globalThis.__nativeCalls = 0; }, on);
const nativeDelay = (ms) => app.evaluate((_, n) => { globalThis.__nativeDelay = n; }, ms);
// What the test profile's clipboard reports when it has no text ('other': files and the like).
const clipboardHolds = (kind) => app.evaluate(({ app: electronApp }, k) => { electronApp.testClipboardOther = k === 'other'; }, kind);
const nativeCalls = () => app.evaluate(() => globalThis.__nativeCalls);
const hintVisible = () => page.evaluate((id) => { const h = terms.get(id).el.querySelector('.paste-hint'); return !!h && !h.hidden && h.textContent; }, ID);
const ctrlVInPage = () => page.evaluate((id) => {
  terms.get(id).el.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }));
}, ID);

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-paste-retry-'));
  keyLog = path.join(profile, 'keys.log');
  const cmd = `node "${path.join(__dirname, 'fixtures', 'key-recorder.js')}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, fitWindow: true, fitCols: 2, globalViewMode: 'term',
    columns: [{ id: ID, title: 'Key recorder', cmd, cwd: profile, role: 'manual', view: 'term' }] }));
  const env = { ...process.env, AGENTDECK_TEST_KEY_LOG: keyLog };
  for (const key of Object.keys(env)) if ((key.startsWith('AGENTDECK_') && key !== 'AGENTDECK_TEST_KEY_LOG') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  // the recorder has drawn its first line: it is running and reading keys
  await expect.poll(() => page.evaluate((id) => {
    if (typeof terms === 'undefined' || !terms.get(id)) return false;
    const b = terms.get(id).term.buffer.active;
    for (let y = 0; y < b.length; y++) if ((b.getLine(y)?.translateToString(true) || '').includes('COPY-ME-4721')) return true;
    return false;
  }, ID), { timeout: 60000 }).toBe(true);
  await page.evaluate((id) => terms.get(id).term.focus(), ID);
  await expect.poll(async () => { await page.keyboard.press('x'); return received().includes('x'); }, { timeout: 15000 }).toBe(true);
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test.beforeEach(async () => {
  if (await app.evaluate(() => !!globalThis.__standIns)) { await busyFor(0); await nativeWorks(false); await nativeDelay(0); await clipboardHolds('none'); }
  await page.evaluate((id) => { const hint = terms.get(id).el.querySelector('.paste-hint'); if (hint) hint.hidden = true; terms.get(id).term.focus(); }, ID);
  fs.writeFileSync(keyLog, '');
});

test('the clipboard is free: Ctrl+V pastes the text once, with no second try', async () => {
  await setClipboard(TEXT);
  await page.keyboard.press('Control+V');
  await expect.poll(() => count(TEXT)).toBe(1);
  await page.waitForTimeout(800);
  expect(count(TEXT)).toBe(1);
  expect(await hintVisible()).toBe(false);
});

test('busy for a moment: the paste lands once, and a second Ctrl+V meanwhile adds nothing', async () => {
  await installStandIns();
  await setClipboard(TEXT);
  await busyFor(300);
  await page.keyboard.press('Control+V');
  await ctrlVInPage(); // pressed again while the first one still waits
  await expect.poll(() => count(TEXT), { timeout: 5000 }).toBe(1);
  await page.waitForTimeout(800);
  expect(count(TEXT)).toBe(1);
  expect(await nativeCalls()).toBe(0);
  expect(await hintVisible()).toBe(false);
});

test('a key typed while Ctrl+V waits follows the paste', async () => {
  await installStandIns();
  await setClipboard(TEXT);
  await busyFor(300);
  await page.keyboard.press('Control+V');
  await page.keyboard.type('qz');
  await expect.poll(() => received().length, { timeout: 5000 }).toBe(TEXT.length + 2);
  expect(received()).toBe(`${TEXT}qz`);
});

test('busy the whole time and Chromium pastes: the fallback pastes once', async () => {
  await installStandIns();
  await setClipboard(TEXT);
  await nativeWorks(true);
  await busyFor(60000);
  await page.keyboard.press('Control+V');
  await expect.poll(() => count(TEXT), { timeout: 5000 }).toBe(1);
  await page.waitForTimeout(800);
  expect(count(TEXT)).toBe(1);
  expect(await nativeCalls()).toBe(1);
  expect(await hintVisible()).toBe(false);
});

test('busy the whole time and Chromium cannot paste either: a hint in the column, typed keys kept', async () => {
  await installStandIns();
  await setClipboard(TEXT);
  await busyFor(60000);
  await page.keyboard.press('Control+V');
  await page.keyboard.type('k');
  await expect.poll(hintVisible, { timeout: 5000 }).toContain('粘贴失败');
  expect(await nativeCalls()).toBe(1);
  expect(received()).toBe('k');
  // the clipboard is free again: the next press pastes
  await busyFor(0);
  await page.keyboard.press('Control+V');
  await expect.poll(() => count(TEXT), { timeout: 5000 }).toBe(1);
});

test('an empty clipboard that stays empty ends in the same hint and no stray input', async () => {
  await installStandIns();
  await setClipboard('');
  await page.keyboard.press('Control+V');
  await expect.poll(hintVisible, { timeout: 5000 }).toContain('粘贴失败');
  await page.waitForTimeout(300);
  expect(received()).toBe('');
});

test('Chromium pastes too late (after the wait gave up): the late paste is dropped, so pressing again pastes once', async () => {
  await installStandIns();
  await setClipboard(TEXT);
  await nativeWorks(true);
  await nativeDelay(700); // after the 300 ms the page waits for it
  await busyFor(60000);
  await page.keyboard.press('Control+V');
  await expect.poll(hintVisible, { timeout: 5000 }).toContain('粘贴失败');
  await page.waitForTimeout(1000); // the late event arrives meanwhile
  expect(count(TEXT)).toBe(0);
  // the user presses again as the hint says; the clipboard is free this time
  await nativeWorks(false);
  await busyFor(0);
  await page.keyboard.press('Control+V');
  await expect.poll(() => count(TEXT), { timeout: 5000 }).toBe(1);
  await page.waitForTimeout(800);
  expect(count(TEXT)).toBe(1);
});

test('the user clicked somewhere else while it waited: Chromium is not asked and the focus stays where it is', async () => {
  await installStandIns();
  await setClipboard(TEXT);
  await busyFor(60000);
  await page.evaluate(() => {
    const other = document.createElement('input');
    other.id = 'elsewhere'; document.body.appendChild(other);
  });
  await page.keyboard.press('Control+V');
  await page.evaluate(() => document.getElementById('elsewhere').focus()); // the click lands outside the terminal
  await expect.poll(hintVisible, { timeout: 5000 }).toContain('粘贴失败');
  expect(await nativeCalls()).toBe(0);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('elsewhere');
  expect(received()).toBe('');
  await page.evaluate(() => document.getElementById('elsewhere').remove());
});

test('files on the clipboard: the hint says it is not text, not that the clipboard is busy', async () => {
  await installStandIns();
  await setClipboard('');
  await clipboardHolds('other');
  await page.keyboard.press('Control+V');
  await expect.poll(hintVisible, { timeout: 5000 }).toContain('粘贴不了');
  expect(await hintVisible()).not.toContain('占用');
  expect(received()).toBe('');
});

test('a paste that throws leaves no unhandled rejection and the typed key still arrives', async () => {
  await installStandIns();
  await setClipboard(TEXT);
  await page.evaluate((id) => {
    window.__rejections = [];
    window.addEventListener('unhandledrejection', (ev) => window.__rejections.push(String(ev.reason)));
    const { term } = terms.get(id);
    window.__realPaste = term.paste.bind(term);
    term.paste = () => { term.paste = window.__realPaste; throw new Error('paste failed'); };
  }, ID);
  await page.keyboard.press('Control+V');
  await page.keyboard.type('w');
  await expect.poll(received, { timeout: 5000 }).toBe('w');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__rejections)).toEqual([]);
  // and the next Ctrl+V works
  fs.writeFileSync(keyLog, '');
  await page.keyboard.press('Control+V');
  await expect.poll(() => count(TEXT), { timeout: 5000 }).toBe(1);
});

// ---- the failure hint's 1.5 seconds: Chromium's late paste is swallowed, the user's own is not ----
// A paste the user asks for (Shift+Insert, Ctrl+Shift+V, right click) goes through once and the guard
// stays up, so Chromium's late paste after it is still dropped; a left click or an ordinary key does
// not lift the guard, so pressing Ctrl+V again as the hint says never doubles.
// Keys are dispatched as page events, never as real Shift+Insert: a real one would make Chromium
// read the machine's clipboard, which a test never touches. The mouse press is a real one.
const USER = 'USER-OWN-PASTE-5531';
const keyInPage = (init) => page.evaluate(([id, k]) => {
  terms.get(id).el.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...k }));
}, [ID, init]);
const pasteEventInPage = (text) => page.evaluate(([id, t]) => {
  const data = new DataTransfer(); data.setData('text/plain', t);
  terms.get(id).el.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, [ID, text]);
// Ctrl+V fails (clipboard busy, Chromium delivers nothing) and the hint is up: the guard is up too.
const failCtrlV = async () => {
  await installStandIns();
  await setClipboard(TEXT);
  await nativeWorks(false);
  await busyFor(60000);
  await page.keyboard.press('Control+V');
  await expect.poll(hintVisible, { timeout: 5000 }).toContain('粘贴失败');
};

for (const way of [
  { name: 'a right-click paste', input: async () => {
    const at = await page.evaluate((id) => { const r = terms.get(id).el.querySelector('.xterm-screen').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; }, ID);
    await page.mouse.click(at.x, at.y, { button: 'right' });
  } },
  { name: 'Shift+Insert (as a voice tool such as Type4Me simulates it)', input: async () => {
    await keyInPage({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    await keyInPage({ key: 'Insert', code: 'Insert', shiftKey: true });
  } },
  { name: 'Ctrl+Shift+V', input: async () => {
    await keyInPage({ key: 'Control', code: 'ControlLeft', ctrlKey: true });
    await keyInPage({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true });
    await keyInPage({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true });
  } },
]) {
  test(`right after the failure hint, ${way.name} pastes once`, async () => {
    await failCtrlV();
    fs.writeFileSync(keyLog, '');
    await way.input();
    await pasteEventInPage(USER);
    await expect.poll(() => count(USER), { timeout: 5000 }).toBe(1);
    await pasteEventInPage('LATE-CHROMIUM-PASTE'); // Chromium's late one comes after it: still dropped
    await page.waitForTimeout(600);
    expect(count(USER)).toBe(1);
    expect(count('LATE-CHROMIUM-PASTE')).toBe(0);
  });
}

const leftClickTerminal = async () => {
  const at = await page.evaluate((id) => { const r = terms.get(id).el.querySelector('.xterm-screen').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; }, ID);
  await page.mouse.click(at.x, at.y);
};
for (const way of [
  { name: 'a left click', input: leftClickTerminal },
  { name: 'an ordinary key', input: () => keyInPage({ key: 'x', code: 'KeyX' }) },
  { name: 'a lone Shift', input: () => keyInPage({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }) },
]) {
  test(`${way.name} after the failure hint does not lift the guard: Chromium's late paste is dropped`, async () => {
    await failCtrlV();
    fs.writeFileSync(keyLog, '');
    await way.input();
    await pasteEventInPage(USER); // the late Chromium paste
    await page.waitForTimeout(600);
    expect(count(USER)).toBe(0);
  });
}

test('Chromium pastes late and the user presses Ctrl+V again at the same time: one paste, not two', async () => {
  await installStandIns();
  await setClipboard(TEXT);
  await nativeWorks(true);
  await nativeDelay(900); // the late event comes after the hint is up and the key is pressed again
  await busyFor(60000);
  await page.keyboard.press('Control+V');
  await expect.poll(hintVisible, { timeout: 5000 }).toContain('粘贴失败');
  await nativeWorks(false);
  await busyFor(0);
  await leftClickTerminal(); // the user clicks in the terminal and types something first
  await keyInPage({ key: 'x', code: 'KeyX' });
  await page.keyboard.press('Control+V'); // as the hint says; the clipboard is free this time
  await expect.poll(() => count(TEXT), { timeout: 5000 }).toBe(1);
  await page.waitForTimeout(1500); // the late event arrives meanwhile
  expect(count(TEXT)).toBe(1);
});
