const { test, expect, _electron: electron } = require('@playwright/test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mockApi = require('./fixtures/mock-model-api');

// Opt-in probe, never part of an ordinary run: an instruction whose Enter was lost stays in the
// real Claude Code's input box, and AgentDeck's look 2.5 s later gives it its one more Enter, once.
//   AGENTDECK_REAL_CLI=claude npm run e2e -- tests/e2e/real-cli-submit-check.spec.js
// AgentDeck runs in a throwaway profile; the column runs the installed Claude Code with an empty
// config directory and a local stand-in API (fixtures/real-cli.js), so no login or quota is used.
// The lost Enter is made in the main process: the first Enter after the instruction never reaches
// the terminal, as when the TUI swallowed it while it was busy drawing.
const WANTED = (process.env.AGENTDECK_REAL_CLI || '').split(',').map((s) => s.trim()).filter(Boolean);
const ROOT = path.resolve(__dirname, '../..');
const COL = 'real-claude';
let application, page, profile, api;

const userTexts = (body) => (body?.messages || []).filter((m) => m.role === 'user')
  .flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).map((c) => c && c.text).filter((t) => typeof t === 'string')));
// How many times the model has been handed `text`, in the latest request (it carries the whole conversation).
const timesAsked = (text) => userTexts(api.requests.filter((r) => Array.isArray(r.body?.messages)).at(-1)?.body).filter((t) => t.includes(text)).length;
const screen = () => page.evaluate((id) => dumpScreen(terms.get(id).term, 40), COL);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The next Enter after a chunk carrying `marker` is dropped in the main process, once.
async function loseNextEnterAfter(marker) {
  await application.evaluate(({ ipcMain }, mark) => {
    const state = globalThis.__loseEnter || (globalThis.__loseEnter = { marker: '', armed: false, dropped: 0 });
    state.marker = mark; state.armed = false;
    if (!state.wrapped) {
      const original = ipcMain.listeners('pty:input');
      ipcMain.removeAllListeners('pty:input');
      ipcMain.on('pty:input', (event, payload) => {
        const data = String(payload?.data ?? '');
        if (state.marker && data.includes(state.marker)) state.armed = true;
        else if (state.armed && data === '\r') { state.armed = false; state.marker = ''; state.dropped++; return; }
        original.forEach((fn) => fn(event, payload));
      });
      state.wrapped = true;
    }
  }, marker);
}
const dropped = () => application.evaluate(() => globalThis.__loseEnter?.dropped || 0);
const send = (text) => page.evaluate(([id, t]) => ChatUI.sendPrompt(columns.find((c) => c.id === id), t, null, {}), [COL, text]);

test.afterEach(async () => {
  if (application) await application.close();
  application = null;
  if (api) await api.close();
  api = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
});

test('real claude: an instruction whose Enter was lost gets one more Enter and is asked once; a busy send is not doubled', async () => {
  test.skip(!WANTED.includes('claude'), 'set AGENTDECK_REAL_CLI=claude to run this against the installed Claude Code');
  test.setTimeout(300000);
  // A turn whose newest words carry SLOW<n>s keeps the model "thinking" n seconds.
  api = await mockApi.start({ delay: (body) => { const last = userTexts(body).at(-1) || ''; const m = /SLOW(\d+)s/.exec(last); return m ? Number(m[1]) * 1000 : 0; } });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-real-submit-'));
  const cmd = `node "${path.join(__dirname, 'fixtures', 'real-cli.js')}" claude ${api.port} "${path.join(profile, 'cli-config')}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false },
    theme: 'dark', fitWindow: true, fitCols: 1, columns: [{ id: COL, title: 'claude', role: 'manual', cmd, cwd: profile }] }));
  const env = { ...process.env, ZDOTDIR: profile };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await application.firstWindow();
  await page.waitForFunction((id) => typeof ChatUI !== 'undefined' && typeof terms !== 'undefined' && terms.get(id)?.alive, COL);
  // Claude Code's prompt is up: its input box between two rules.
  await expect.poll(async () => /^\s*[❯>]\s*$/m.test(await screen()), { timeout: 120000 }).toBe(true);
  await sleep(2000);
  const tag = crypto.randomBytes(3).toString('hex');

  // A: idle, the Enter is lost; AgentDeck's look gives it one more Enter and the model is asked once.
  const idle = `丢回车探针A-${tag}：只回复 ok`;
  await loseNextEnterAfter(idle);
  expect(await send(idle)).toBeTruthy();
  try {
    await expect.poll(() => timesAsked(idle), { timeout: 30000 }).toBe(1);
  } catch (error) {
    throw new Error(`A: the model was asked ${timesAsked(idle)} times, Enters dropped ${await dropped()}.\nScreen:\n${await screen()}`);
  }
  expect(await dropped()).toBe(1);
  await sleep(6000);
  expect(timesAsked(idle)).toBe(1);

  // B: a send while the model is thinking (12 s) goes in as Claude Code queues it; nothing doubles it.
  const slow = `慢回合B-${tag} SLOW12s：只回复 ok`, queued = `忙时补充B-${tag}：只回复 ok`;
  expect(await send(slow)).toBeTruthy();
  await expect.poll(() => timesAsked(slow), { timeout: 20000 }).toBe(1);
  await sleep(2000);
  await page.evaluate(([id, t]) => { const col = columns.find((c) => c.id === id); return ChatUI.sendPrompt(col, t, null, {}); }, [COL, queued]);
  await expect.poll(() => timesAsked(queued), { timeout: 60000 }).toBe(1);
  await sleep(20000);
  console.log(`[real-cli] B busy send: asked ${timesAsked(queued)} time(s)`);
  expect(timesAsked(queued)).toBe(1);

  // C: the Enter is lost while the model thinks (5 s); once the screen is quiet the one more Enter goes in.
  const busy = `慢回合C-${tag} SLOW5s：只回复 ok`, late = `丢回车探针C-${tag}：只回复 ok`;
  expect(await send(busy)).toBeTruthy();
  await expect.poll(() => timesAsked(busy), { timeout: 20000 }).toBe(1);
  await sleep(1000);
  await loseNextEnterAfter(late);
  await page.evaluate(([id, t]) => { const col = columns.find((c) => c.id === id); return ChatUI.sendPrompt(col, t, null, {}); }, [COL, late]);
  try {
    await expect.poll(() => timesAsked(late), { timeout: 40000 }).toBe(1);
  } catch (error) {
    throw new Error(`C: the model was asked ${timesAsked(late)} times, Enters dropped ${await dropped()}.\nScreen:\n${await screen()}`);
  }
  expect(await dropped()).toBe(2);
  await sleep(6000);
  expect(timesAsked(late)).toBe(1);
  console.log(`[real-cli] ${process.platform} lost Enter: idle and busy instructions each asked once after one more Enter; a busy send asked once`);
});
