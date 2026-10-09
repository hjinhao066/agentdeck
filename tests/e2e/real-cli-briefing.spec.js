const { test, expect, _electron: electron } = require('@playwright/test');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../../main-core');
const mockApi = require('./fixtures/mock-model-api');

// Opt-in probe, never part of an ordinary run: does the real agent CLI, as the
// Captain, take the whole briefing in and hand all of it to its model?
//   AGENTDECK_REAL_CLI=claude,codex npx playwright test tests/e2e/real-cli-briefing.spec.js
// AgentDeck runs in a throwaway profile and sends the briefing itself, through a
// real PTY. The CLI gets an empty config directory and a local stand-in for its
// model API (fixtures/real-cli.js), so no login or quota is used. What the CLI
// then asks its "model" is compared with what AgentDeck sent, character by character.
// Cursor and agy cannot be pointed at a stand-in, so AGENTDECK_REAL_CLI=cursor,agy
// uses the installed CLI's own login and a little of its quota, read-only (no
// --force or permission-skipping flag). They get a neutral 10000-character text
// with ten codes from its first line to its last, and must answer with all ten in
// lower case: the codes only reach the model if the whole text did.
const WANTED = (process.env.AGENTDECK_REAL_CLI || '').split(',').map((s) => s.trim()).filter(Boolean);
const ROOT = path.resolve(__dirname, '../..');
const CAPTAIN = 'real-captain';
let application, page, profile, api;

// A briefing grown to `length` characters by more rule-sized lines, its closing paragraph still last.
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
const longFiles = () => { const dir = path.join(profile, 'long-prompts'); return fs.existsSync(dir) ? fs.readdirSync(dir) : []; };
// The CLI's own request must carry the text as one piece, unchanged.
async function arrives(what, cli, sent) {
  const head = sent.slice(0, 40);
  try {
    await expect.poll(() => api.userTexts().some((t) => t === sent), { timeout: 90000 }).toBe(true);
  } catch (_) {
    // Say what the CLI did instead: what it sent, and the screen it is sitting on (a throwaway profile, nothing of the owner's).
    const screen = await page.evaluate((id) => dumpScreen(terms.get(id).term, 30), CAPTAIN).catch(() => '');
    throw new Error(`${cli} never asked its model with the ${what} whole. Requests: ${api.requests.length}; texts starting like it: ${JSON.stringify(api.userTexts().filter((t) => t.includes(head)).map((t) => t.length))} characters.\nCaptain screen:\n${screen}`);
  }
  console.log(`[real-cli] ${process.platform} ${os.release()} ${version(cli)} ${what}: AgentDeck sent ${sent.length} chars, the CLI's model request carries ${sent.length} chars, identical=true`);
}
function version(cli) {
  try { return execSync(`${cli} --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch (_) { return cli; }
}

test.afterEach(async () => {
  if (application) await application.close();
  application = null;
  if (api) await api.close();
  api = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
});

for (const cli of ['claude', 'codex']) {
  test(`real ${cli}: the first briefing and a 10000-character briefing reach its model whole`, async () => {
    test.skip(!WANTED.includes(cli), `set AGENTDECK_REAL_CLI=${cli} to run this against the installed CLI`);
    test.setTimeout(300000);
    api = await mockApi.start();
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-real-cli-'));
    const cmd = `node "${path.join(__dirname, 'fixtures', 'real-cli.js')}" ${cli} ${api.port} "${path.join(profile, 'cli-config')}"`;
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false },
      theme: 'dark', fitWindow: true, fitCols: 1,
      mainSession: { colId: CAPTAIN, cmd, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
      columns: [{ id: CAPTAIN, title: '队长', isMain: true, cmd, cwd: profile }],
    }));
    const env = { ...process.env, ZDOTDIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
    page = await application.firstWindow();
    await page.waitForFunction((id) => typeof ChatUI !== 'undefined' && typeof terms !== 'undefined' && terms.get(id)?.alive, CAPTAIN);

    // AgentDeck briefs the Captain by itself once the CLI is ready.
    const brief = await page.evaluate(() => MainCore.instructions(env.platform, '', config.mainSession?.legacyReceiptInjection === true, config.concurrencyCap));
    expect(brief.length).toBeLessThanOrEqual(M.CORE_LIMIT);
    await arrives('first briefing', cli, brief);

    const full = grown(brief, M.BRIEFING_LIMIT);
    expect(full.length).toBe(10000);
    await page.evaluate(([id, text]) => sendWhenReady(columns.find((c) => c.id === id), text, { silent: true, guardUserInput: true, inlineLimit: MainCore.BRIEFING_LIMIT }), [CAPTAIN, full]);
    await arrives('10000-character briefing', cli, full);
    expect(longFiles()).toEqual([]);
  });
}

// A neutral text of exactly `length` characters: ten capital-letter codes from
// the first line to the last, then the question. Never the briefing itself.
function coded(length) {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const codes = Array.from({ length: 10 }, () => Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join(''));
  const head = '这是一段长度测试文字，不是任务：不要执行任何命令，不要读写文件。文中有 10 个写在【】里的四个大写字母代码。\n';
  const ask = '\n请按出现顺序，把这 10 个代码全部改成小写字母，每个代码单独一行回复，除此之外什么都不要写。';
  const body = length - head.length - ask.length - codes.length * 6;
  const piece = (n) => { let t = ''; while (t.length < n) t += '这是一行用来凑长度的文字，没有别的意思。'.repeat(8) + '\n'; return t.slice(0, n); };
  const text = head + codes.map((c, i) => (i ? piece(Math.floor(body / 9)) : '') + `【${c}】`).join('') + piece(body - 9 * Math.floor(body / 9)) + ask;
  return { text, codes };
}

for (const [cli, cmd] of [['cursor', 'cursor-agent --trust --model auto'], ['agy', 'agy --model gemini-3.8-flash-high']]) {
  test(`real ${cli} (its own login): a 10000-character prompt reaches its model whole`, async () => {
    test.skip(!WANTED.includes(cli), `set AGENTDECK_REAL_CLI=${cli} to run this with the installed, logged-in CLI (uses a little of its quota)`);
    test.setTimeout(420000);
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-real-cli-'));
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false },
      theme: 'dark', fitWindow: true, fitCols: 1, columns: [{ id: CAPTAIN, title: cli, role: 'manual', cmd, cwd: profile }] }));
    const env = { ...process.env, ZDOTDIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
    page = await application.firstWindow();
    await page.waitForFunction((id) => typeof terms !== 'undefined' && terms.get(id)?.alive, CAPTAIN);
    const { text, codes } = coded(M.BRIEFING_LIMIT);
    expect(text.length).toBe(10000);
    // agy asks whether to trust a new folder, the cursor already on "Yes"; Enter until the question is gone.
    if (cli === 'agy') {
      const asking = async () => /Do you trust the contents/.test(await page.evaluate((id) => dumpScreen(terms.get(id).term, 30), CAPTAIN));
      await expect.poll(asking, { timeout: 120000 }).toBe(true);
      await expect.poll(async () => { if (await asking()) await page.evaluate((id) => window.deck.ptyInput(id, '\r'), CAPTAIN); return asking(); },
        { timeout: 60000, intervals: [3000] }).toBe(false);
    }
    // The way a briefing goes out: the larger limit, through the real composer path.
    await page.evaluate(([id, t]) => sendWhenReady(columns.find((c) => c.id === id), t, { silent: true, guardUserInput: true, inlineLimit: MainCore.BRIEFING_LIMIT, timeout: 240000 }), [CAPTAIN, text]);
    const screen = () => page.evaluate((id) => dumpScreen(terms.get(id).term, 80), CAPTAIN);
    const answered = async () => { const s = await screen(); return codes.filter((c) => s.includes(c.toLowerCase())).length; };
    try {
      await expect.poll(answered, { timeout: 300000, intervals: [2000] }).toBe(codes.length);
    } catch (_) {
      throw new Error(`${cli} answered ${await answered()} of ${codes.length} codes.\nScreen:\n${await screen()}`);
    }
    expect(longFiles()).toEqual([]);
    console.log(`[real-cli] ${process.platform} ${os.release()} ${version(cli === 'cursor' ? 'cursor-agent' : cli)} 10000-character prompt: its model answered all ${codes.length} codes from first line to last`);
  });
}
