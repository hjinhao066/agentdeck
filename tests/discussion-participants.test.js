const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createParticipants, parseCli, seatEligibility, childEnvironment, DEADLINE_MS } = require('../discussion-participants');

const opus = { id: 'opus', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const web = { id: 'web', provider: 'chatgpt-web', model: '6 Pro', effort: 'Pro' };
const auth = { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' };
const job = (participant = opus, id = 'round1-opus') => ({ id, participant, prompt: '公开讨论题及本轮材料全文。' });
const output = (model = opus.model, extra = {}) => JSON.stringify({ type: 'system', subtype: 'init', model, effort: 'high', apiKeySource: 'oauth' }) + '\n'
  + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '独立回答：建议与依据。', modelUsage: { [model]: { inputTokens: 20, outputTokens: 10, provider: 'firstParty' } }, ...extra }) + '\n';
async function fixture(t, overrides = {}, script) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-discussion-adapters-'));
  const cli = path.join(runDir, 'fake-cli.cjs');
  await fs.writeFile(cli, script || `process.stdin.resume();process.stdin.on('end',()=>{console.log(${JSON.stringify(output())});});`);
  const options = { home: runDir, cliCommand: [process.execPath, cli], selectSeat: async () => ({ id: 'fake', configDir: path.join(runDir, 'seat') }), authStatus: async () => auth,
    cooldownMs: 0, webStateDir: path.join(runDir, 'state'), ...overrides };
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  return { runDir, options, adapter: createParticipants(options) };
}
async function webpage({ question, report, mode, timeout }) {
  assert.equal(mode, 'chat'); assert.equal(timeout, 30);
  assert.equal(await fs.readFile(question, 'utf8'), job(web).prompt);
  await fs.writeFile(report, '网页完整原稿：独立结论及充分依据。');
  await fs.writeFile(report + '.meta.json', JSON.stringify({ selectedModel: '6 Pro', selectedMode: 'chat' }));
  return '';
}

test('fake subscription CLI verifies native model and effort, archives full prompt and result', async (t) => {
  const s = await fixture(t);
  const result = await s.adapter.execute(job(), s);
  assert.equal(result.actualModel, opus.model);
  assert.equal(result.actualEffort, 'high'); assert.equal(result.effortEvidence, 'runtime');
  assert.equal(result.auth, 'subscription'); assert.equal(result.seatId, 'fake');
  assert.equal(await fs.readFile(result.files[0], 'utf8'), result.text);
  assert.equal(await fs.readFile(path.join(s.runDir, 'jobs', job().id, 'input.md'), 'utf8'), job().prompt);
  assert.equal(DEADLINE_MS, 30 * 60_000);
});

test('actual model downgrade, effort mismatch, API source and provider are refused', () => {
  assert.throws(() => parseCli(output('claude-sonnet-5-5'), opus), { code: 'MODEL_MISMATCH' });
  assert.throws(() => parseCli(output(opus.model, { effort: 'low' }), opus), { code: 'MODEL_MISMATCH' });
  assert.throws(() => parseCli(output().replace('oauth', 'ANTHROPIC_API_KEY'), opus), { code: 'AUTH' });
  assert.equal(parseCli(output().replace('oauth', 'none'), opus).actualModel, opus.model);
  assert.throws(() => parseCli(output().replace('firstParty', 'bedrock'), opus), { code: 'MODEL_MISMATCH' });
  assert.equal(parseCli(output('claude-opus-5-5-20261001'), opus).actualModel, opus.model);
  assert.equal(parseCli(output('claude-opus-5-5-20261001'), opus).observedModel, 'claude-opus-5-5-20261001');
  assert.throws(() => parseCli(output(opus.model, { api_error_status: 429, is_error: true }), opus), { code: 'QUOTA' });
});

test('authentication is checked before inference; paid API login never runs participant', async (t) => {
  const s = await fixture(t, { authStatus: async () => ({ ...auth, authMethod: 'apiKey' }) });
  await assert.rejects(s.adapter.execute(job(), s), { code: 'AUTH', mayHaveSent: false });
  await assert.rejects(fs.access(path.join(s.runDir, 'jobs', job().id, 'request.json')));
});

test('seat eligibility requires fresh account-bound official proof that paid Extra Usage is disabled', () => {
  const now = Date.now(), info = { loggedIn: true, accountKey: 'account-one', configDir: '/seat-one' };
  const official = { at: now, source: 'Claude OAuth usage', accountKey: info.accountKey, configDir: info.configDir,
    extraUsageEnabled: false, windows: [{ key: 'fiveHour', remaining: 50 }, { key: 'weekly', remaining: 60 }] };
  assert.deepEqual(seatEligibility(official, info, now), { available: true, remaining: 50 });
  for (const change of [{ extraUsageEnabled: true }, { extraUsageEnabled: null }, { extraUsageEnabled: undefined },
    { source: 'Claude /usage' }, { at: now - 5 * 60_000 - 1 }, { at: now + 60_001 },
    { accountKey: 'another-account' }, { configDir: '/another-seat' }]) {
    assert.deepEqual(seatEligibility({ ...official, ...change }, info, now), { available: false, reason: 'BILLING_UNVERIFIED' });
  }
  assert.deepEqual(seatEligibility(null, info, now), { available: false, reason: 'BILLING_UNVERIFIED' });
  assert.deepEqual(seatEligibility({ ...official, windows: [{ key: 'fiveHour', remaining: 0 }, { key: 'weekly', remaining: 60 }] }, info, now), { available: false, reason: 'QUOTA' });
});

test('child environment strips routing tokens, paid credentials and cloud inference routing without mutating parent', () => {
  const env = { PATH: 'path', AGENTDECK_CONTROL_TOKEN: 'private', ANTHROPIC_API_KEY: 'private', ANTHROPIC_BASE_URL: 'private',
    OPENAI_API_KEY: 'private', GEMINI_API_KEY: 'private', AGY_API_KEY: 'private', AGY_BASE_URL: 'private',
    GEMINI_BASE_URL: 'private', DEEPSEEK_API_KEY: 'private', GOOGLE_APPLICATION_CREDENTIALS: 'private', GOOGLE_CLOUD_PROJECT: 'private',
    AWS_BEARER_TOKEN_BEDROCK: 'private', AZURE_OPENAI_ENDPOINT: 'private', CLAUDE_CODE_API_BASE_URL: 'private', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1' };
  const clean = childEnvironment(env, { configDir: '~/.claude-us' }, '/fake');
  assert.equal(clean.PATH, 'path'); assert.equal(clean.CLAUDE_CONFIG_DIR, '/fake/.claude-us');
  for (const key of Object.keys(env).filter((key) => key !== 'PATH')) assert.equal(clean[key], undefined, key);
  assert.equal(env.AGENTDECK_CONTROL_TOKEN, 'private');
});

test('completed CLI draft survives restart and duplicate delivery without another invocation', async (t) => {
  const s = await fixture(t);
  const first = await s.adapter.execute(job(), s);
  await fs.unlink(path.join(s.runDir, 'jobs', job().id, 'result.json'));
  const fresh = createParticipants({ ...s.options, selectSeat: () => { throw new Error('must not start again'); } });
  const recovered = await fresh.execute(job(), s);
  assert.equal(recovered.text, first.text);
  assert.equal((await fresh.execute(job(), s)).actualModel, first.actualModel);
  await assert.rejects(fresh.execute({ ...job(), prompt: 'changed' }, s), { code: 'REQUEST_CHANGED' });
});

test('CLI timeout holds its attempt and restart never blindly resends', async (t) => {
  const s = await fixture(t, { timeoutMs: 50 }, 'process.stdin.resume();setTimeout(()=>{},10000);');
  await assert.rejects(s.adapter.execute(job(), s), { code: 'TIMEOUT', mayHaveSent: true });
  await assert.rejects(createParticipants(s.options).execute(job(), s), { code: 'TIMEOUT', mayHaveSent: true });
});

test('fake webpage gets full standalone input, saves actual model and recovers private report after restart', async (t) => {
  let calls = 0;
  const s = await fixture(t, { webRunCli: async (input) => { calls++; return webpage(input); } });
  const first = await s.adapter.execute(job(web), s);
  assert.equal(first.actualModel, '6 Pro'); assert.equal(first.actualEffort, 'Pro');
  assert.equal(first.effortEvidence, 'web-model-selector');
  assert.match(first.text, /充分依据/);
  await fs.unlink(path.join(s.runDir, 'jobs', job(web).id, 'result.json'));
  assert.equal((await createParticipants(s.options).execute(job(web), s)).text, first.text);
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(path.join(s.runDir, 'jobs', job(web).id, 'input.md'), 'utf8'), job(web).prompt);
});

test('web timeout and unknown submitted request stay paused across restart, never submitted twice', async (t) => {
  let calls = 0;
  const s = await fixture(t, { webRunCli: async () => { calls++; return 'TIMEOUT'; } });
  await assert.rejects(s.adapter.execute(job(web), s), { code: 'PENDING_REQUEST', mayHaveSent: true });
  await assert.rejects(createParticipants(s.options).execute(job(web), s), { code: 'PENDING_REQUEST', mayHaveSent: true });
  assert.equal(calls, 1);
});

test('fake webpage wrong actual model never counts as participant completion', async (t) => {
  const s = await fixture(t, { webRunCli: async (input) => {
    await webpage(input);
    await fs.writeFile(input.report + '.meta.json', JSON.stringify({ selectedModel: '6 Thinking', selectedMode: 'chat' }));
    return '';
  } });
  await assert.rejects(s.adapter.execute(job(web), s));
  await assert.rejects(s.adapter.recover(job(web), s), { code: 'MODEL_MISMATCH' });
});

test('pre-aborted task sends nothing; active CLI cancellation kills only its child and persists hold', async (t) => {
  const s = await fixture(t, {}, 'process.stdin.resume();setTimeout(()=>{},10000);');
  const signal = new AbortController(); signal.abort();
  await assert.rejects(s.adapter.execute(job(), { ...s, signal: signal.signal }), { code: 'CANCELLED' });
  const active = new AbortController();
  const done = s.adapter.execute(job(), { ...s, signal: active.signal, onProgress: () => setTimeout(() => active.abort(), 20) });
  await assert.rejects(done, { code: 'CANCELLED' });
  await assert.rejects(createParticipants(s.options).execute(job(), s), { code: 'CANCELLED' });
});

test('simultaneous duplicate web submission claims only one send', async (t) => {
  let calls = 0;
  const s = await fixture(t, { webRunCli: async (input) => { calls++; await new Promise((resolve) => setTimeout(resolve, 30)); return webpage(input); } });
  const results = await Promise.allSettled([s.adapter.execute(job(web), s), s.adapter.execute(job(web), s)]);
  assert.equal(calls, 1);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  assert.ok(results.every((result) => result.status === 'fulfilled' || result.reason.code === 'PENDING_REQUEST'));
});

test('optional Antigravity is subscription-only, passes full high model id without --effort', async (t) => {
  const gemini = { id: 'gemini', provider: 'antigravity', model: 'gemini-3.8-flash-high', effort: 'high' };
  const s = await fixture(t, { agyStatus: async () => ({ product: 'antigravity', plan_tier: 'Google AI Pro', quota: { 'gemini-5h': { remaining_fraction: 0.8 }, 'gemini-weekly': { remaining_fraction: 0.8 } } }) });
  const fake = path.join(s.runDir, 'fake-agy.cjs');
  await fs.writeFile(fake, `if(process.argv.includes('--effort')) process.exit(8);process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(output(gemini.model))}));`);
  const adapter = createParticipants({ ...s.options, agyCommand: [process.execPath, fake] });
  assert.equal((await adapter.execute(job(gemini, 'round1-gemini'), s)).actualModel, gemini.model);
  const noSubscription = createParticipants({ ...s.options, agyStatus: async () => ({ product: 'antigravity', plan_tier: 'API' }) });
  await assert.rejects(noSubscription.execute(job(gemini, 'round2-gemini'), s), { code: 'AUTH' });
});
