const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../../main-core');

// AgentDeck restarts with a Captain in the deck. When the Captain's CLI comes back
// into the conversation it already had (`claude --resume <id>`), it still holds the
// prompt: it is only told the app restarted. A CLI that starts a new conversation
// is given the core prompt. Real window, real PTY, a stand-in `claude` that writes
// down how it was launched and every prompt that reached it.
const ROOT = path.resolve(__dirname, '../..');
const CAPTAIN = 'restart-captain';
const SESSION = '22222222-2222-4222-8222-222222222222';
let application, page, profile, captured, launches;

// The stand-in starts in the column's shell: the caller's own shell startup files must not decide whether it starts.
function isolateShell(env, dir) {
  if (process.platform === 'win32') return env;
  fs.writeFileSync(path.join(dir, '.zshrc'), '');
  env.ZDOTDIR = dir;
  if (fs.existsSync('/bin/zsh')) env.SHELL = '/bin/zsh';
  env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH || '');
  return env;
}
const rows = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const received = () => rows(captured).filter((p) => p.colId === CAPTAIN).map((p) => p.text);
const saved = () => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
const quiet = () => expect.poll(() => page.evaluate((id) => terms.get(id)?.state === 'done' && ChatUI.turnsOf(id).every((t) => t.done), CAPTAIN), { timeout: 20000 }).toBe(true);

async function start() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  env.AGENTDECK_TEST_PROMPT_COLUMNS_FILE = captured;
  delete env.ELECTRON_RUN_AS_NODE;
  isolateShell(env, profile);
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await application.firstWindow();
  await page.waitForFunction((id) => typeof ChatUI !== 'undefined' && typeof terms !== 'undefined' && terms.get(id)?.alive, CAPTAIN);
}
async function stop() {
  if (application) await application.close();
  application = null;
}

test.beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-restart-notice-'));
  captured = path.join(profile, 'prompts.jsonl');
  launches = path.join(profile, 'launches.jsonl');
  const script = path.join(profile, 'stand-in.cjs');
  const executable = path.join(profile, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(launches)}, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));
require(${JSON.stringify(path.join(__dirname, 'fixtures/fake-agent.js'))});`);
  fs.writeFileSync(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o700 });
  const cmd = `"${executable}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false },
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: [{ id: CAPTAIN, title: '队长', isMain: true, cmd, cwd: profile, modelSessionId: SESSION, modelSessionOwner: CAPTAIN, modelSessionCwd: profile }],
    mainSession: { colId: CAPTAIN, cmd, gen: 1, fresh: false, tasks: [], pending: [], inflight: [], waitlist: [] } }));
});
test.afterEach(async () => {
  await stop();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a restart does not paste the prompt again into a Captain that resumed its conversation; a new conversation gets the core prompt', async () => {
  test.setTimeout(180_000);   // three starts of the app
  const core = M.instructions(process.platform);
  expect(core.length).toBeLessThanOrEqual(M.CORE_LIMIT);

  // First start on this version: the conversation is resumed, but nothing says it ever got this prompt.
  await start();
  await expect.poll(() => received().length, { timeout: 30000 }).toBe(1);
  expect(rows(launches)[0]).toEqual(expect.arrayContaining(['--resume', SESSION]));
  expect(received()[0]).toBe(core);
  await quiet();
  await expect.poll(() => saved().mainSession.briefed, { timeout: 15000 }).toEqual({ colId: CAPTAIN, mark: M.briefingMark(core) });
  await stop();

  // Restart: the same conversation comes back. One short notice, not the prompt.
  await start();
  await expect.poll(() => received().length, { timeout: 30000 }).toBe(2);
  expect(rows(launches)[1]).toEqual(expect.arrayContaining(['--resume', SESSION]));
  const notice = received()[1];
  expect(notice).toBe(M.restartNotice(process.platform, ''));
  expect(notice.startsWith('你是 AgentDeck')).toBe(false);
  expect(notice.length).toBeLessThan(400);
  expect(notice).toContain('handoff'); expect(notice).toContain('briefing 重读，细则用 briefing --topic 名');
  console.log(`[restart-notice] ${process.platform} ${os.release()}: core prompt ${core.length} chars on the first start, restart notice ${notice.length} chars on the second`);
  await quiet();
  await page.waitForTimeout(3000);
  expect(received()).toHaveLength(2);
  await stop();

  // Restart after the context was cleared (no turn finished since): a new conversation, so the core prompt again.
  const config = saved();
  config.mainSession.fresh = true;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(config));
  await start();
  await expect.poll(() => received().length, { timeout: 30000 }).toBe(3);
  expect(rows(launches)[2]).toContain('--session-id');
  expect(rows(launches)[2]).not.toContain('--resume');
  expect(received()[2]).toBe(core);
});
