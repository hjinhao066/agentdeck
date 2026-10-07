const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../../main-core');

// The Captain briefing is the one prompt allowed past the ordinary 8000-character
// cut. These tests send it through the real window, a real PTY (ConPTY on
// Windows) and a stand-in agent that writes down exactly what reached its stdin.
// Two stand-ins: one reads lines, one asks for bracketed paste like Claude Code
// and records its raw input. AgentDeck pastes when the terminal was asked to and
// types otherwise; each test prints which it did on this machine.
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const RECORDER = `node "${path.join(__dirname, 'fixtures', 'paste-recorder.js')}"`;
const CAPTAIN = 'paste-captain', LINES = 'paste-lines', PASTED = 'paste-bracketed', WORKER = 'paste-worker';
let application, page, profile, promptsFile, rawFile;

const received = (colId) => (fs.existsSync(promptsFile) ? fs.readFileSync(promptsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
  .filter((p) => p.colId === colId).map((p) => p.text);
// What the recorder's stdin got, as a TUI reads it: the paste between its two
// markers, the pty's line ends as newlines, the closing Enter left off.
function pasted(colId) {
  return (fs.existsSync(rawFile) ? fs.readFileSync(rawFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
    .filter((p) => p.colId === colId).map(({ raw }) => {
      const start = raw.indexOf('\x1b[200~'), end = raw.indexOf('\x1b[201~');
      return { markers: start >= 0 && end > start, cr: raw.split('\r').length - 1, lf: raw.split('\n').length - 1,
        text: (start >= 0 && end > start ? raw.slice(start + 6, end) : raw.replace(/\r\n?$/, '')).replace(/\r\n?/g, '\n') };
    });
}
const longFiles = () => { const dir = path.join(profile, 'long-prompts'); return fs.existsSync(dir) ? fs.readdirSync(dir) : []; };
// A briefing grown to `length` characters by more rule-sized lines, its closing
// paragraph still last. (The line-reading stand-in answers after 250 ms without
// a new line, so one multi-kilobyte line would be read as two prompts.)
function grown(brief, length) {
  const closing = M.AUTONOMOUS_CONTINUATION + M.SAVER_RESUME;
  const rules = brief.slice(0, brief.length - M.AUTONOMOUS_CONTINUATION.length);
  let more = '';
  for (let left = length - rules.length - closing.length; left > 0;) {
    const line = '规'.repeat(Math.min(300, left - 1)) + '\n';
    more += line; left -= line.length;
  }
  return rules + more + closing;
}
// The line the CI log keeps as evidence: which machine, which way in, how much arrived.
function evidence(what, way, sent, got, note = '') {
  console.log(`[briefing-paste] ${process.platform} ${os.release()} ${what} via ${way}: sent ${sent.length} chars, received ${got.length} chars, identical=${got === sent}${note}`);
}
const rawNote = (p) => ` (paste markers ${p.markers ? 'arrived' : 'missing'}; line ends on arrival: ${p.cr} CR, ${p.lf} LF)`;
async function launch(captain = FAKE) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-briefing-paste-'));
  promptsFile = path.join(profile, 'prompts.jsonl');
  rawFile = path.join(profile, 'raw-input.jsonl');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false },
    theme: 'dark', fitWindow: true, fitCols: 4,
    mainSession: { colId: CAPTAIN, cmd: captain, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [
      { id: CAPTAIN, title: '队长', isMain: true, cmd: captain, cwd: profile },
      { id: LINES, title: 'Lines', cmd: FAKE, cwd: profile, role: 'manual' },
      { id: PASTED, title: 'Bracketed', cmd: RECORDER, cwd: profile, role: 'manual' },
      { id: WORKER, title: 'Worker', cmd: FAKE, cwd: profile, role: 'manual' },
    ],
  }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPT_COLUMNS_FILE: promptsFile, AGENTDECK_TEST_RAW_INPUT_FILE: rawFile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await application.firstWindow();
  await page.waitForFunction((ids) => typeof ChatUI !== 'undefined' && typeof terms !== 'undefined' && ids.every((id) => terms.get(id)?.alive), [CAPTAIN, LINES, PASTED, WORKER]);
}
const briefing = () => page.evaluate(() => MainCore.instructions(env.platform, '', config.mainSession?.legacyReceiptInjection === true, config.concurrencyCap));
const way = (id) => page.evaluate((i) => (terms.get(i)?.term?.modes?.bracketedPasteMode ? 'bracketed paste' : 'typed keys'), id);
// The call main-session makes for each briefing send.
const sendAsBriefing = (id, text) => page.evaluate(([i, t]) => sendWhenReady(columns.find((c) => c.id === i), t, { silent: true, guardUserInput: true, inlineLimit: MainCore.BRIEFING_LIMIT }), [id, text]);
// ConPTY builds that do not pass the TUI's bracketed-paste request on to the terminal leave AgentDeck typing plain keys.
async function pasteModeOrSkip(id) {
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.state, id), { timeout: 20000 }).toBeTruthy();
  const on = await expect.poll(() => way(id), { timeout: 8000 }).toBe('bracketed paste').then(() => true, () => false);
  test.skip(!on, `this ${process.platform} ${os.release()} PTY did not hand the agent's bracketed-paste request to the terminal; AgentDeck types plain keys here (covered by the line-reading tests)`);
}

test.afterEach(async () => {
  if (application) await application.close();
  application = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('the Captain\'s first briefing, longer than an ordinary prompt may be, reaches a line-reading agent whole', async () => {
  await launch();
  const brief = await briefing();
  expect(brief.length).toBeGreaterThan(M.LONG_PROMPT);
  await expect.poll(() => received(CAPTAIN).length, { timeout: 30000 }).toBeGreaterThan(0);
  const got = received(CAPTAIN)[0];
  evidence('first briefing', await way(CAPTAIN), brief, got);
  expect(got).toBe(brief);
  expect(got.endsWith(M.AUTONOMOUS_CONTINUATION)).toBe(true);
  expect(longFiles()).toEqual([]);
});

test('the Captain\'s first briefing reaches a paste-taking agent whole, as one bracketed paste', async () => {
  await launch(RECORDER);
  await pasteModeOrSkip(CAPTAIN);
  const brief = await briefing();
  await expect.poll(() => pasted(CAPTAIN).length, { timeout: 30000 }).toBeGreaterThan(0);
  const got = pasted(CAPTAIN)[0];
  evidence('first briefing', 'bracketed paste', brief, got.text, rawNote(got));
  expect(got.markers).toBe(true);
  expect(got.text).toBe(brief);
  expect(longFiles()).toEqual([]);
});

test('a briefing of exactly 10000 characters reaches a line-reading agent whole; one more character goes out as a file', async () => {
  await launch();
  const full = grown(await briefing(), M.BRIEFING_LIMIT);
  expect(full.length).toBe(10000);
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.state, LINES), { timeout: 20000 }).toBeTruthy();
  const used = await way(LINES);
  await sendAsBriefing(LINES, full);
  await expect.poll(() => received(LINES).length, { timeout: 40000 }).toBe(1);
  evidence('10000-character briefing', used, full, received(LINES)[0]);
  expect(received(LINES)[0]).toBe(full);
  expect(received(LINES)[0].endsWith('读看板继续。')).toBe(true);
  expect(longFiles()).toEqual([]);

  const over = grown(await briefing(), M.BRIEFING_LIMIT + 1);
  await sendAsBriefing(LINES, over);
  await expect.poll(() => received(LINES).length, { timeout: 40000 }).toBe(2);
  const pointer = received(LINES)[1];
  expect(pointer).toContain('（这条消息共 10001 字，完整内容已存成文件，请先完整读取再照做：');
  expect(pointer).not.toContain('读看板继续');
  expect(longFiles()).toHaveLength(1);
  expect(fs.readFileSync(path.join(profile, 'long-prompts', longFiles()[0]), 'utf8')).toBe(over);
});

test('a briefing of exactly 10000 characters reaches a paste-taking agent whole, as one bracketed paste', async () => {
  await launch();
  await pasteModeOrSkip(PASTED);
  const full = grown(await briefing(), M.BRIEFING_LIMIT);
  await sendAsBriefing(PASTED, full);
  await expect.poll(() => pasted(PASTED).length, { timeout: 40000 }).toBe(1);
  const got = pasted(PASTED)[0];
  evidence('10000-character briefing', 'bracketed paste', full, got.text, rawNote(got));
  expect(got.markers).toBe(true);
  expect(got.text).toBe(full);
  expect(got.text.endsWith('读看板继续。')).toBe(true);
  expect(longFiles()).toEqual([]);
});

test('an ordinary prompt one character past 8000 still goes to a worker as a file', async () => {
  await launch();
  const inside = '活'.repeat(M.LONG_PROMPT), long = '活'.repeat(M.LONG_PROMPT + 1);
  await page.evaluate(([i, t]) => sendWhenReady(columns.find((c) => c.id === i), t, { silent: true }), [WORKER, inside]);
  await expect.poll(() => received(WORKER).length, { timeout: 40000 }).toBe(1);
  expect(received(WORKER)[0]).toBe(inside);
  expect(longFiles()).toEqual([]);
  await page.evaluate(([i, t]) => sendWhenReady(columns.find((c) => c.id === i), t, { silent: true }), [WORKER, long]);
  await expect.poll(() => received(WORKER).length, { timeout: 40000 }).toBe(2);
  expect(received(WORKER)[1]).toContain('（这条消息共 8001 字，完整内容已存成文件，请先完整读取再照做：');
  expect(fs.readFileSync(path.join(profile, 'long-prompts', longFiles()[0]), 'utf8')).toBe(long);
});
