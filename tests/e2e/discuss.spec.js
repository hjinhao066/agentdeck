'use strict';

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Command-line integration only: neither Electron nor a browser is launched.
const ROOT = path.resolve(__dirname, '../..');
const DRIVER = path.join(__dirname, 'fixtures/fake-discussion-driver.js');
let profile, controlDir, env, server, requests, runs;

function isolatedEnv(extra = {}) {
  const result = { ...process.env };
  for (const key of Object.keys(result)) if (key.startsWith('AGENTDECK_')) delete result[key];
  delete result.ELECTRON_RUN_AS_NODE;
  return { ...result, ...extra };
}
function cli(args, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'board-cli.js'), 'discuss', ...args], {
      env: isolatedEnv({ ...env, ...overrides }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function command(args) {
  const result = await cli(args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}
function controls(value) { fs.writeFileSync(path.join(profile, 'fake-discussion-controls.json'), JSON.stringify(value)); }
function events() {
  const file = path.join(profile, 'fake-discussion-events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function state(run) { return JSON.parse(fs.readFileSync(path.join(run.directory, 'run.json'), 'utf8')); }
async function start(topic = '比较可靠性方案，要求依据证据决策并保留少数派。', extra = []) {
  const run = JSON.parse(await command(['start', '--topic', topic, ...extra]));
  expect(run.id).toBeTruthy();
  expect(path.isAbsolute(run.directory)).toBe(true);
  expect(run.directory.startsWith(profile + path.sep)).toBe(true);
  runs.push(run);
  return run;
}
async function waitState(run, status) {
  await expect.poll(() => state(run).status, { timeout: 15000 }).toBe(status);
  return state(run);
}

test.beforeEach(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-discuss-test-e2e-'));
  controlDir = path.join(profile, 'board-control');
  for (const child of ['requests', 'responses']) fs.mkdirSync(path.join(controlDir, child), { recursive: true });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ testProfile: true }));
  fs.writeFileSync(path.join(profile, 'test-profile.json'), '{}');
  env = { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: 'isolated-captain-token',
    AGENTDECK_DISCUSS_TEST_PROFILE: profile, AGENTDECK_DISCUSS_TEST_DRIVER: DRIVER };
  requests = []; runs = [];
  server = setInterval(() => {
    for (const file of fs.readdirSync(path.join(controlDir, 'requests')).filter((name) => name.endsWith('.json'))) {
      const request = JSON.parse(fs.readFileSync(path.join(controlDir, 'requests', file), 'utf8'));
      fs.unlinkSync(path.join(controlDir, 'requests', file));
      requests.push(request);
      const answer = request.token === env.AGENTDECK_CONTROL_TOKEN
        ? { done: true, result: request.action === 'main-ledger' ? 'captain 队长 空闲' : 'Discussion receipt recorded.' }
        : { done: true, error: 'Captain capability required.' };
      fs.writeFileSync(path.join(controlDir, 'responses', file), JSON.stringify(answer));
    }
  }, 15);
});
test.afterEach(async () => {
  for (const run of runs) {
    try { if (!['complete', 'cancelled'].includes(state(run).status)) await cli(['cancel', '--id', run.id]); } catch {}
    await expect.poll(() => fs.existsSync(path.join(run.directory, '.runner-lock')), { timeout: 15000 }).toBe(false);
  }
  clearInterval(server);
  fs.rmSync(profile, { recursive: true, force: true });
});

test('authenticated Captain completes independent answers, frozen anonymous review and summary with fake CLI and webpage', async () => {
  const run = await start();
  const complete = await waitState(run, 'complete');
  expect(complete.participants.map((p) => [p.provider, p.model])).toEqual([
    ['claude', 'claude-opus-5-5'], ['chatgpt-web', '6 Pro'],
  ]);
  expect(complete.rounds).toHaveLength(2);
  expect(complete.jobs).toHaveLength(5);
  expect(complete.jobs.every((job) => job.status === 'complete')).toBe(true);
  const calls = events();
  expect(calls.filter((event) => event.phase === 'independent')).toHaveLength(2);
  expect(calls.filter((event) => event.phase === 'review')).toHaveLength(2);
  expect(calls.filter((event) => event.phase === 'summary')).toHaveLength(1);
  const review = calls.filter((event) => event.phase === 'review');
  expect(review[0].input).toContain('### 方案 A');
  expect(review[0].input).toContain('### 方案 B');
  expect(review[0].input).not.toMatch(/claude-opus|ChatGPT|Claude Code/);
  expect(review[0].input).toBe(review[1].input);
  const final = fs.readFileSync(path.join(run.directory, 'final.md'), 'utf8');
  expect(final).toContain('少数派');
  expect(final).toContain('忠实性核对');
  expect(JSON.parse(fs.readFileSync(path.join(run.directory, 'final-meta.json'), 'utf8')).faithful).toBe(true);
  expect(await command(['status', '--id', run.id])).toContain(run.id);
  const waited = await command(['wait', '--id', run.id]);
  expect(waited).toContain(path.join(run.directory, 'final.md'));
  expect(await command(['status'])).toContain(run.id);
  expect(requests.some((request) => request.action === 'main-ledger')).toBe(true);
});

test('--gemini adds the configured third model and completes two rounds with seven calls', async () => {
  const run = await start('比较可靠性方案，三位成员分别独答并互评。', ['--gemini']);
  const complete = await waitState(run, 'complete');
  expect(complete.participants.map((participant) => [participant.id, participant.provider, participant.model])).toEqual([
    ['opus', 'claude', 'claude-opus-5-5'],
    ['chatgpt', 'chatgpt-web', '6 Pro'],
    ['gemini', 'agy', 'gemini-3.8-flash-high'],
  ]);
  expect(complete.rounds).toHaveLength(2);
  expect(complete.jobs).toHaveLength(7);
  const calls = events();
  expect(calls).toHaveLength(7);
  expect(calls.filter((event) => event.phase === 'independent')).toHaveLength(3);
  expect(calls.filter((event) => event.phase === 'review')).toHaveLength(3);
  expect(calls.find((event) => event.phase === 'summary').participantId).toBe('opus');
  for (const review of calls.filter((event) => event.phase === 'review')) {
    expect(review.input).toContain('### 方案 A');
    expect(review.input).toContain('### 方案 B');
    expect(review.input).toContain('### 方案 C');
  }
  expect(JSON.parse(fs.readFileSync(path.join(run.directory, 'final-meta.json'), 'utf8')).actualModels).toHaveLength(7);
});

test('a participant file controls ids and summarizer, and material disagreement adds only one third round', async () => {
  const participants = [
    { id: 'reasoner', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', tier: 'subscription' },
    { id: 'browser', provider: 'chatgpt-web', model: '6 Pro', effort: 'Pro', tier: 'Pro' },
  ];
  const file = path.join(profile, 'participants.json');
  fs.writeFileSync(file, JSON.stringify(participants));
  controls({ reasoner: 'disagree' });
  const run = await start('风险约束未核实，比较立即实施和分阶段实施的取舍。',
    ['--participants-file', file, '--summarizer', 'browser']);
  const complete = await waitState(run, 'complete');
  expect(complete.participants.map((participant) => participant.id)).toEqual(['reasoner', 'browser']);
  expect(complete.summarizer).toBe('browser');
  expect(complete.rounds).toHaveLength(3);
  expect(complete.plannedRounds).toBe(3);
  expect(complete.jobs).toHaveLength(7);
  expect(complete.finalModel).toBe('6 Pro');
  const calls = events();
  expect(calls).toHaveLength(7);
  expect(calls.filter((event) => event.phase === 'followup')).toHaveLength(2);
  expect(calls.find((event) => event.phase === 'summary').participantId).toBe('browser');
  for (const followup of calls.filter((event) => event.phase === 'followup')) {
    expect(followup.input).toContain('第一轮完整稿');
    expect(followup.input).toContain('第二轮完整稿');
    expect(followup.input).toContain('风险约束尚未核实');
  }
  expect(fs.readFileSync(path.join(run.directory, 'final.md'), 'utf8')).toContain('少数派');
});

test('web timeout pauses without skipping a member or resending on resume', async () => {
  controls({ chatgpt: 'timeout' });
  const run = await start();
  const paused = await waitState(run, 'paused');
  await expect.poll(() => fs.existsSync(path.join(run.directory, '.runner-lock'))).toBe(false);
  expect(paused.jobs.find((job) => job.participantId === 'opus').status).toBe('complete');
  expect(paused.jobs.find((job) => job.participantId === 'chatgpt').status).toBe('unknown');
  expect(paused.rounds).toHaveLength(0);
  const resumed = await cli(['resume', '--id', run.id]);
  expect(resumed.code === 0 ? resumed.stdout : resumed.stderr).toMatch(/unknown|possibly|已发|不明|确认|paused/i);
  expect(events().filter((event) => event.participantId === 'chatgpt')).toHaveLength(1);
  expect(fs.existsSync(path.join(run.directory, 'final.md'))).toBe(false);
});

test('restart recovers a completed webpage artifact without a second send, and a duplicate import leaves frozen results intact', async () => {
  controls({ chatgpt: 'recover-in-flight' });
  const run = await start();
  await expect.poll(() => events().filter((event) => event.participantId === 'chatgpt').length).toBe(1);
  await expect.poll(() => state(run).jobs.find((job) => job.participantId === 'opus').status).toBe('complete');
  const webpageJob = state(run).jobs.find((job) => job.participantId === 'chatgpt');
  await expect.poll(() => fs.existsSync(path.join(profile, 'fake-result-' + webpageJob.attemptId + '.json'))).toBe(true);
  process.kill(run.pid, 'SIGKILL');
  await expect.poll(() => require('../../discussion-runner').alive(run.pid)).toBe(false);
  controls({});
  await command(['resume', '--id', run.id]);
  const complete = await waitState(run, 'complete');
  await expect.poll(() => fs.existsSync(path.join(run.directory, '.runner-lock'))).toBe(false);
  expect(events().filter((event) => event.jobId === webpageJob.id)).toHaveLength(1);
  expect(complete.jobs.find((job) => job.id === webpageJob.id).attemptId).toBe(webpageJob.attemptId);
  const manifestFile = path.join(run.directory, 'round-01', 'frozen-manifest.json');
  const manifest = fs.readFileSync(manifestFile, 'utf8');
  const final = fs.readFileSync(path.join(run.directory, 'final.md'), 'utf8');
  const duplicateFile = path.join(profile, 'duplicate-answer.md');
  fs.writeFileSync(duplicateFile, '这份迟到重复稿不能覆盖已冻结答案，也不能使任何人再次提问。');
  await command(['resume', '--id', run.id, '--result-file', duplicateFile, '--job', webpageJob.id, '--model', '6 Pro', '--tier', 'Pro']);
  expect(fs.readFileSync(manifestFile, 'utf8')).toBe(manifest);
  expect(fs.readFileSync(path.join(run.directory, 'final.md'), 'utf8')).toBe(final);
  expect(events()).toHaveLength(5);
});

test('every outbound packet redacts private identifiers and saves exactly what the webpage received', async () => {
  const run = await start('User alice@example.test uses /Users/privateuser/project, Windows C:\\Users\\privateuser\\repo; session id 12345678-1234-4234-8234-123456789abc; server 192.0.2.1 at private.example.test. Token sk-proj-abcdefghijklmnopqrstuvwxyz123456.');
  const complete = await waitState(run, 'complete');
  const webpage = events().filter((event) => event.participantId === 'chatgpt');
  expect(webpage).toHaveLength(2);
  for (const sent of webpage) {
    expect(sent.input).not.toMatch(/alice@example|privateuser|192\.0\.2\.1|private\.example|12345678-1234|sk-proj-abcdefghijklmnopqrstuvwxyz/);
    const job = complete.jobs.find((candidate) => candidate.id === sent.jobId);
    const archive = path.join(run.directory, 'round-' + String(job.round).padStart(2, '0'), 'input', job.id + '-' + job.attemptId + '.md');
    expect(fs.readFileSync(archive, 'utf8')).toBe(sent.input);
  }
});

test('model mismatch pauses instead of accepting a weaker answer as completion', async () => {
  controls({ chatgpt: 'mismatch' });
  const run = await start();
  const paused = await waitState(run, 'paused');
  expect(paused.jobs.find((job) => job.participantId === 'chatgpt').failure).toMatch(/model/i);
  expect(paused.rounds).toHaveLength(0);
  expect(fs.existsSync(path.join(run.directory, 'final.md'))).toBe(false);
});

test('cancellation keeps completed work and prevents review or a final answer', async () => {
  controls({ chatgpt: 'hold' });
  const run = await start();
  await expect.poll(() => state(run).jobs.find((job) => job.participantId === 'opus').status).toBe('complete');
  await expect.poll(() => events().some((event) => event.participantId === 'chatgpt')).toBe(true);
  await command(['cancel', '--id', run.id]);
  await waitState(run, 'cancelled');
  fs.writeFileSync(path.join(profile, 'release-chatgpt'), 'release');
  expect(state(run).jobs.find((job) => job.participantId === 'opus').output).toContain('完整回答');
  expect((await cli(['resume', '--id', run.id])).code).not.toBe(0);
  expect(events().some((event) => event.phase === 'review')).toBe(false);
  expect(fs.existsSync(path.join(run.directory, 'final.md'))).toBe(false);
});

test('ordinary worker capability cannot start or read a discussion', async () => {
  for (const args of [['start', '--topic', 'A valid public discussion topic.'], ['status']]) {
    const result = await cli(args, { AGENTDECK_CONTROL_TOKEN: '', AGENTDECK_RECEIPT_TOKEN: 'isolated-worker-token' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Captain|队长|Only conductor-managed/);
  }
  expect(requests).toHaveLength(0);
});
