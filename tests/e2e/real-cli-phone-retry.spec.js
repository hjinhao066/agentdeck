const { test, expect, _electron: electron } = require('@playwright/test');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const mockApi = require('./fixtures/mock-model-api');

// Opt-in probe, never part of an ordinary run: a phone message whose desktop answer came after
// main.js gave up (requestMobile's 5 s) is not given to the real Captain twice when the phone
// retries it with the same deduplicationKey.
//   AGENTDECK_REAL_CLI=claude npm run e2e -- tests/e2e/real-cli-phone-retry.spec.js
// AgentDeck runs in a throwaway profile; the Captain is the installed Claude Code with an empty
// config directory talking to a local stand-in API (fixtures/real-cli.js), so no login or quota
// is used. The renderer is held busy for 7 s while the phone's message arrives, as on a loaded
// machine: main answers the phone 500, the renderer still queues the message once it is free.
const WANTED = (process.env.AGENTDECK_REAL_CLI || '').split(',').map((s) => s.trim()).filter(Boolean);
const ROOT = path.resolve(__dirname, '../..');
const CAPTAIN = 'real-captain';
let application, page, profile, api;

function call(url, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url + route, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
// How many times the Captain's model has been handed `text` as the user, in the latest request
// (it carries the whole conversation so far).
const timesAsked = (text) => {
  const last = api.requests.filter((r) => Array.isArray(r.body?.messages)).at(-1);
  return (last?.body.messages || []).filter((m) => m.role === 'user')
    .flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).map((c) => c && c.text).filter((t) => typeof t === 'string')))
    .filter((t) => t.includes(text)).length;
};

test.afterEach(async () => {
  if (application) await application.close();
  application = null;
  if (api) await api.close();
  api = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
});

test('real claude Captain: a phone message the desktop queued after main gave up is not given to it again on retry', async () => {
  test.skip(!WANTED.includes('claude'), 'set AGENTDECK_REAL_CLI=claude to run this against the installed Claude Code');
  test.setTimeout(300000);
  api = await mockApi.start();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-real-phone-'));
  const cmd = `node "${path.join(__dirname, 'fixtures', 'real-cli.js')}" claude ${api.port} "${path.join(profile, 'cli-config')}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false },
    theme: 'dark', fitWindow: true, fitCols: 1, mobileWeb: { enabled: false, port: 0 },
    mainSession: { colId: CAPTAIN, cmd, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [{ id: CAPTAIN, title: '队长', isMain: true, cmd, cwd: profile }],
  }));
  const env = { ...process.env, ZDOTDIR: profile };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await application.firstWindow();
  await page.waitForFunction((id) => typeof ChatUI !== 'undefined' && typeof terms !== 'undefined' && terms.get(id)?.alive, CAPTAIN);
  // The real CLI takes its briefing and answers it; then it sits idle at its prompt.
  await expect.poll(() => api.userTexts().some((t) => t.startsWith('你是 AgentDeck')), { timeout: 120000 }).toBe(true);
  await expect.poll(() => page.evaluate((id) => terms.get(id)?.state, CAPTAIN), { timeout: 60000 }).toBe('done');

  const settings = await page.evaluate(() => deck.mobileWebSettings({ enabled: true }));
  expect(settings.enabled).toBe(true);
  const auth = { Authorization: `Bearer ${settings.token}` };
  auth['X-CSRF-Token'] = JSON.parse((await call(settings.url, '/api/auth', { headers: auth })).text).csrfToken;
  const words = '手机重试探针 ' + crypto.randomBytes(4).toString('hex') + '：只回复 ok';
  const key = 'k-' + crypto.randomBytes(16).toString('hex');
  const send = () => call(settings.url, '/api/captain', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: settings.url },
    body: JSON.stringify({ message: words, deduplicationKey: key }) });

  // The renderer is busy for 7 s (a loaded machine) while the message arrives: main gives up after 5 s.
  const busy = page.evaluate(() => { const end = Date.now() + 7000; while (Date.now() < end); });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const first = await send();
  expect(first.status, first.text).toBe(500);
  await busy;
  // The phone shows 没有接收 and its 重试: the same words, the same key.
  const retry = await send();
  expect(retry.status, retry.text).toBe(200);

  // The real Captain gets it; nothing more arrives in the next 20 s.
  await expect.poll(() => timesAsked(words), { timeout: 90000 }).toBeGreaterThanOrEqual(1);
  await new Promise((resolve) => setTimeout(resolve, 20000));
  const turns = await page.evaluate(([id, w]) => ChatUI.turnsOf(id).filter((t) => String(t.user || '').includes(w)).length, [CAPTAIN, words]);
  const queued = await page.evaluate(() => (config.mainSession.mobileMessages || []).length);
  console.log(`[real-cli] ${process.platform} phone retry after a 500: the Captain's model was asked ${timesAsked(words)} time(s), ${turns} turn(s) in its chat, ${queued} still queued`);
  expect(queued).toBe(0);
  expect(turns).toBe(1);
  expect(timesAsked(words)).toBe(1);
});
