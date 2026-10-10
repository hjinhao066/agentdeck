const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A screenshot on the clipboard, and copying out of a terminal, on Electron 44's asynchronous
// clipboard. A test profile has a private in-memory clipboard (text, plus app.testClipboardImage
// for a picture and app.testClipboardWriteFails to make copies fail): the machine's real
// clipboard is never read, written or cleared here.
//  - a picture alone pastes as the temp file's path, by Ctrl+V and by a paste event
//  - a picture next to text pastes the text only (one paste is one thing)
//  - a copy that could not be written shows no success, says so, and keeps the selection
// The program in the column writes down every byte it receives.
test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(__dirname, '../..');
const ID = 'clip';
const TEXT = 'CLIPBOARD-TEXT-5531';
const mac = process.platform === 'darwin';
const PASTE_DIR = path.join(os.tmpdir(), 'agentdeck-paste');
// the first bytes of a PNG: the file is saved as it came, never decoded
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('agentdeck-test-picture')]);
let app, page, profile, keyLog;

const received = () => (fs.existsSync(keyLog) ? Buffer.from(fs.readFileSync(keyLog, 'utf8').replace(/\s+/g, ''), 'hex').toString('latin1') : '');
const savedPictures = () => (fs.existsSync(PASTE_DIR) ? fs.readdirSync(PASTE_DIR).filter((f) => /^paste-\d+\.png$/.test(f)) : []);
const setClipboard = (text) => page.evaluate(async (t) => { await window.deck.clipboardWrite(t); }, text);
const setPicture = (on) => app.evaluate(({ app: electronApp }, bytes) => { electronApp.testClipboardImage = bytes ? Buffer.from(bytes, 'base64') : null; }, on ? PNG.toString('base64') : null);
const failCopies = (on) => app.evaluate(({ app: electronApp }, v) => { electronApp.testClipboardWriteFails = v; }, on);
const toast = () => page.evaluate(() => { const t = document.getElementById('toast'); return t && t.classList.contains('show') ? t.textContent : ''; });
const selectLine = () => page.evaluate((id) => {
  const { term } = terms.get(id);
  const b = term.buffer.active;
  for (let y = 0; y < b.length; y++) {
    const text = b.getLine(y)?.translateToString(true) || '';
    const at = text.indexOf('COPY-ME-4721');
    if (at >= 0) { term.select(at, y, 'COPY-ME-4721'.length); return term.getSelection(); }
  }
  return null;
}, ID);
// A paste event on the column's terminal input, as the OS paste would produce it.
const pasteEvent = ({ picture, text }) => page.evaluate(({ picture: withPicture, text: words }) => {
  const data = new DataTransfer();
  if (words) data.setData('text/plain', words);
  if (withPicture) data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }));
  document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, { picture, text });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-clipboard-terminal-'));
  keyLog = path.join(profile, 'keys.log');
  const cmd = `node "${path.join(__dirname, 'fixtures', 'key-recorder.js')}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, fitWindow: true, fitCols: 2, globalViewMode: 'term',
    columns: [{ id: ID, title: 'Key recorder', cmd, cwd: profile, role: 'manual', view: 'term' }] }));
  const env = { ...process.env, AGENTDECK_TEST_KEY_LOG: keyLog };
  for (const key of Object.keys(env)) if ((key.startsWith('AGENTDECK_') && key !== 'AGENTDECK_TEST_KEY_LOG') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
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
  await failCopies(false);
  await setPicture(false);
  await setClipboard('');
  await page.evaluate((id) => { const { term } = terms.get(id); term.clearSelection(); term.focus(); }, ID);
  fs.writeFileSync(keyLog, '');
});

test('Ctrl+V with a picture alone types the saved file\'s path', async () => {
  await setPicture(true);
  const before = new Set(savedPictures());
  await page.keyboard.press('Control+V');
  await expect.poll(() => savedPictures().filter((f) => !before.has(f)).length, { timeout: 10000 }).toBe(1);
  const file = savedPictures().find((f) => !before.has(f));
  expect(fs.readFileSync(path.join(PASTE_DIR, file))).toEqual(PNG);
  await expect.poll(received, { timeout: 5000 }).toContain(file);
  fs.rmSync(path.join(PASTE_DIR, file), { force: true });
});

test('Ctrl+V with a picture next to text pastes the text and saves no picture', async () => {
  await setPicture(true);
  await setClipboard(TEXT);
  const before = savedPictures().length;
  await page.keyboard.press('Control+V');
  await expect.poll(received, { timeout: 5000 }).toBe(TEXT);
  await page.waitForTimeout(600);
  expect(received()).toBe(TEXT);
  expect(savedPictures().length).toBe(before);
});

test('Ctrl+V with an empty clipboard and no picture saves nothing and says so', async () => {
  const before = savedPictures().length;
  await page.keyboard.press('Control+V');
  await expect.poll(() => page.evaluate((id) => { const h = terms.get(id).el.querySelector('.paste-hint'); return !!h && !h.hidden; }, ID), { timeout: 5000 }).toBe(true);
  expect(received()).toBe('');
  expect(savedPictures().length).toBe(before);
});

test('a paste event holding a picture alone types the saved file\'s path', async () => {
  await setPicture(true);
  const before = new Set(savedPictures());
  await pasteEvent({ picture: true });
  await expect.poll(() => savedPictures().filter((f) => !before.has(f)).length, { timeout: 10000 }).toBe(1);
  const file = savedPictures().find((f) => !before.has(f));
  await expect.poll(received, { timeout: 5000 }).toContain(file);
  fs.rmSync(path.join(PASTE_DIR, file), { force: true });
});

test('a paste event holding a picture and text pastes the text only', async () => {
  await setPicture(true);
  const before = savedPictures().length;
  await pasteEvent({ picture: true, text: TEXT });
  await expect.poll(received, { timeout: 5000 }).toBe(TEXT);
  await page.waitForTimeout(600);
  expect(received()).toBe(TEXT);
  expect(savedPictures().length).toBe(before);
});

test('a paste event whose picture cannot be read from the clipboard says so', async () => {
  const before = savedPictures().length;
  await pasteEvent({ picture: true }); // the page saw a picture, the clipboard has none
  await expect.poll(toast, { timeout: 5000 }).toContain('截图');
  expect(received()).toBe('');
  expect(savedPictures().length).toBe(before);
});

test('a paste event with a picture file while the clipboard holds files says it is files, not "paste again"', async () => {
  await app.evaluate(({ app: electronApp }) => { electronApp.testClipboardOther = true; }); // a test says the clipboard holds files
  try {
    const before = savedPictures().length;
    await pasteEvent({ picture: true }); // an image file copied in the file manager: the page sees a picture
    await expect.poll(toast, { timeout: 5000 }).toContain('剪贴板里是文件');
    expect(await toast()).toContain('终端只能粘贴文字和截图');
    expect(await toast()).not.toContain('再粘贴一次');
    expect(received()).toBe('');
    expect(savedPictures().length).toBe(before);
  } finally {
    await app.evaluate(({ app: electronApp }) => { electronApp.testClipboardOther = false; });
  }
});

test('copying a selection: a failed write says so and keeps the selection; the next try copies and lets go', async () => {
  expect(await selectLine()).toBe('COPY-ME-4721');
  await setClipboard('before');
  await failCopies(true);
  await page.keyboard.press(mac ? 'Meta+C' : 'Control+Shift+C');
  await expect.poll(toast, { timeout: 5000 }).toContain('复制失败');
  // Where Ctrl+C copies while text is selected, the hint says how to get the interrupt back.
  if (!mac) expect(await toast()).toContain('Ctrl+C 中断程序，先点一下终端取消选区');
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe('before');
  expect(await page.evaluate((id) => terms.get(id).term.hasSelection(), ID)).toBe(true);
  expect(received()).not.toContain('\x03');
  await failCopies(false);
  await page.keyboard.press(mac ? 'Meta+C' : 'Control+Shift+C');
  await expect.poll(() => page.evaluate(() => window.deck.clipboardRead()), { timeout: 5000 }).toBe('COPY-ME-4721');
  if (!mac) await expect.poll(() => page.evaluate((id) => terms.get(id).term.hasSelection(), ID)).toBe(false);
});

test('the clipboard item shape main reads (types, getType to a Blob) is what Electron 44 provides', async () => {
  // Built in memory: nothing is written to or read from the real clipboard.
  const shape = await app.evaluate(async ({ ClipboardItem }, bytes) => {
    const item = new ClipboardItem({ 'image/png': new Blob([Buffer.from(bytes, 'base64')], { type: 'image/png' }), 'text/plain': 'words' });
    const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
    return { types: [...item.types].sort(), png: png.toString('base64'), text: await (await item.getType('text/plain')).text() };
  }, PNG.toString('base64'));
  expect(shape.types).toEqual(['image/png', 'text/plain']);
  expect(Buffer.from(shape.png, 'base64')).toEqual(PNG);
  expect(shape.text).toBe('words');
});
