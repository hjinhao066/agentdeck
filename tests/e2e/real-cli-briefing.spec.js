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
    expect(brief.length).toBeGreaterThan(M.LONG_PROMPT);
    await arrives('first briefing', cli, brief);

    const full = grown(brief, M.BRIEFING_LIMIT);
    expect(full.length).toBe(10000);
    await page.evaluate(([id, text]) => sendWhenReady(columns.find((c) => c.id === id), text, { silent: true, guardUserInput: true, inlineLimit: MainCore.BRIEFING_LIMIT }), [CAPTAIN, full]);
    await arrives('10000-character briefing', cli, full);
    expect(longFiles()).toEqual([]);
  });
}
