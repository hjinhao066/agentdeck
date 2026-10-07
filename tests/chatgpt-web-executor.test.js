const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createExecutor, runCli } = require('../chatgpt-web-executor');
const { validatePublicTask, summary } = require('../chatgpt-web-core');

async function setup(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-web-unit-'));
  const events = [];
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  const executor = createExecutor({ reportsDir: dir, stateDir: path.join(dir, 'state'), cooldownMs: 0,
    emit: (event) => { events.push(event); if (event.action === 'complete') complete(event); }, ...overrides });
  t.after(async () => { executor.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, executor, events, done };
}
const task = (id = 'one', mode = 'chat') => ({ id, taskId: `task-${id}`, task: 'What is the capital of France?', mode });
async function success({ question, report, mode }) {
  assert.match(await fs.readFile(question, 'utf8'), /capital/);
  await fs.writeFile(report, '> 实际模型/档位：6 Pro\n\n# Answer\nParis is the capital of France.\n');
  await fs.writeFile(`${report}.meta.json`, JSON.stringify({ selectedModel: '6 Pro', selectedMode: mode }));
  return '';
}

// A stand-in for the CLI's post-export foreground guard; no browser/window APIs.
async function foregroundCli(t, { exitCode = 98, mode = 'chat', body = 'Paris is the capital of France.', meta = {}, diagnostic, malformedDiagnostic = false, missingReport = false, missingMeta = false } = {}) {
  const s = await setup(t, { runCli: (input) => runCli({ ...input, cliPath: path.join(s.dir, 'fake-guard-cli.js') }) });
  const metadata = { selectedModel: '6 Pro', selectedMode: mode, submitted: true, finishedAt: new Date().toISOString(),
    exportMethod: 'copy-markdown', ...(mode === 'deep-research' ? { researchEvidence: { complete: true } } : {}), ...meta };
  await fs.writeFile(path.join(s.dir, 'fake-guard-cli.js'), `
    const fs = require('fs');
    const report = process.argv[process.argv.indexOf('--out') + 1];
    if (!${missingReport}) fs.writeFileSync(report, ${JSON.stringify(body)});
    if (!${missingMeta}) fs.writeFileSync(report + '.meta.json', ${JSON.stringify(JSON.stringify(metadata))});
    ${diagnostic ? `fs.writeFileSync(report + '.error.json', ${JSON.stringify(JSON.stringify({ code: diagnostic, reason: 'private diagnostic' }))});` : ''}
    if (${malformedDiagnostic}) fs.writeFileSync(report + '.error.json', 'invalid');
    console.error('private foreground application/window details');
    process.exit(${exitCode});
  `);
  s.executor.submit(task('one', mode));
  return s;
}

for (const exitCode of [98, 97]) for (const mode of ['chat', 'deep-research']) {
  test(`foreground guard exit ${exitCode} delivers finalized ${mode} answer with a distinct self-check note`, async (t) => {
    const s = await foregroundCli(t, { exitCode, mode });
    const receipt = await s.done;
    assert.equal(receipt.failed, undefined);
    assert.match(receipt.result, /Paris is the capital/);
    assert.match(receipt.result, exitCode === 98 ? /无法判定，用户可能自行切换.*未确认工具抢占/ : /工具报告抢占了前台，违反后台运行约束/);
    assert.doesNotMatch(receipt.result, /private foreground/);
    assert.equal(receipt.files.length, 1);
    assert.equal(await fs.readFile(receipt.files[0], 'utf8'), 'Paris is the capital of France.');
  });
}

for (const exitCode of [98, 97]) for (const [name, incomplete] of [
  ['missing report', { missingReport: true }], ['missing metadata', { missingMeta: true }],
  ['empty report', { body: '' }], ['unsubmitted report', { meta: { submitted: false } }],
  ['sensitive report', { body: 'answer sk-' + 'x'.repeat(24) }],
  ['unfinished report', { meta: { finishedAt: null } }], ['invalid completion time', { meta: { finishedAt: 'invalid' } }],
  ['unexported report', { meta: { exportMethod: null } }], ['error metadata', { meta: { status: 'error' } }],
  ['unverified research', { mode: 'deep-research', meta: { researchEvidence: { complete: false } } }],
  ['wrong model', { meta: { selectedModel: 'Medium' } }], ['wrong mode', { meta: { selectedMode: 'deep-research' } }],
]) {
  test(`foreground guard exit ${exitCode} does not deliver ${name}`, async (t) => {
    const s = await foregroundCli(t, { exitCode, ...incomplete });
    const receipt = await s.done;
    assert.ok(receipt.failed);
    assert.deepEqual(receipt.files, []);
    assert.doesNotMatch(receipt.result, /Paris is the capital|private foreground/);
    assert.match(receipt.failed, exitCode === 98 ? /无法判定/ : /工具报告抢占了前台/);
  });
}

for (const diagnostic of ['TIMEOUT', 'FOREGROUND_VIOLATION', 'UNEXPECTED_ERROR']) {
  test(`real ${diagnostic} diagnostic takes precedence over foreground exit and saved artifacts`, async (t) => {
    const s = await foregroundCli(t, { exitCode: 97, diagnostic });
    const receipt = await s.done;
    assert.ok(receipt.failed);
    assert.deepEqual(receipt.files, []);
    assert.doesNotMatch(receipt.result, /Paris is the capital|private diagnostic/);
    if (diagnostic === 'FOREGROUND_VIOLATION') assert.match(receipt.failed, /Chrome 抢占了前台/);
  });
}

test('unrelated nonzero exit cannot recover a finalized answer', async (t) => {
  const s = await foregroundCli(t, { exitCode: 1 });
  assert.ok((await s.done).failed);
});

test('malformed error diagnostic cannot be treated as a guard-only failure', async (t) => {
  const s = await foregroundCli(t, { malformedDiagnostic: true });
  const receipt = await s.done;
  assert.ok(receipt.failed);
  assert.deepEqual(receipt.files, []);
});

test('cancellation takes precedence over a saved answer and indeterminate foreground check', async (t) => {
  const s = await setup(t, { runCli: async (input) => {
    await success(input);
    s.executor.cancel('one');
    return 'FRONT_UNSURE';
  } });
  s.executor.submit(task());
  const receipt = await s.done;
  assert.match(receipt.failed, /已取消/);
  assert.deepEqual(receipt.files, []);
});

test('successful fake webpage returns report excerpt and absolute report path; removes private input', async (t) => {
  const s = await setup(t, { runCli: success });
  assert.deepEqual(s.executor.submit(task()), { accepted: true });
  const receipt = await s.done;
  assert.match(receipt.result, /Paris is the capital/);
  assert.equal(receipt.failed, undefined);
  assert.equal(receipt.taskId, 'task-one');
  assert.equal(path.isAbsolute(receipt.files[0]), true);
  assert.match(await fs.readFile(receipt.files[0], 'utf8'), /Paris/);
  await assert.rejects(fs.access(path.join(path.dirname(receipt.files[0]), 'question.md')));
  assert.deepEqual(s.executor.status('one').receipt, receipt);
});

for (const [code, expected] of [['LOGIN_REQUIRED', /需要用户.*手动登录/], ['RATE_LIMITED', /额度上限/], ['COOLDOWN', /冷却中/],
  ['TIMEOUT', /超时/], ['PENDING_REQUEST', /上次请求页/], ['LOCKED', /占用/]]) {
  test(`fake webpage ${code} submits existing failed completion without retry`, async (t) => {
    let count = 0;
    const s = await setup(t, { runCli: async () => { count++; return code; } });
    s.executor.submit(task());
    const receipt = await s.done;
    assert.match(receipt.failed, expected);
    assert.equal(receipt.result, receipt.failed);
    assert.deepEqual(receipt.files, []);
    assert.equal(count, 1);
  });
}

test('two fake webpage tasks serialize and second observes cooldown without polling/retrying the CLI', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0, concurrent = 0, maxConcurrent = 0, firstEnd, secondStart;
  const receipts = [];
  const s = await setup(t, { cooldownMs: 40, runCli: async (input) => {
    calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (calls === 1) await gate; else secondStart = Date.now();
    const code = await success(input);
    concurrent--; if (calls === 1) firstEnd = Date.now();
    return code;
  }, emit: (event) => { if (event.action === 'complete') receipts.push(event); } });
  s.executor.submit(task()); s.executor.submit(task('two'));
  while (calls === 0) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1);
  assert.equal(s.executor.status('two').active, true);
  release();
  while (receipts.length < 2) await new Promise((r) => setTimeout(r, 5));
  assert.equal(maxConcurrent, 1); assert.equal(calls, 2);
  assert.ok(secondStart - firstEnd >= 40);
});

test('existing skill cooldown waits before opening webpage, malformed state fails without clearing it', async (t) => {
  const s = await setup(t, { now: () => 1000, cooldownMs: 50, runCli: success });
  await fs.mkdir(path.join(s.dir, 'state'));
  await fs.writeFile(path.join(s.dir, 'state', 'cooldown.json'), JSON.stringify({ finishedAt: 1000 }));
  s.executor.submit(task());
  await s.done;
  assert.ok(s.events.some((e) => /冷却排队/.test(e.message || '')));
  await fs.writeFile(path.join(s.dir, 'state', 'cooldown.json'), 'broken');
  let result;
  const bad = createExecutor({ stateDir: path.join(s.dir, 'state'), emit: (e) => { if (e.failed) result = e; } });
  bad.submit(task('bad'));
  while (!result) await new Promise((r) => setTimeout(r, 5));
  assert.match(result.failed, /状态损坏/); bad.dispose();
  assert.equal(await fs.readFile(path.join(s.dir, 'state', 'cooldown.json'), 'utf8'), 'broken');
});

test('wrong actual model fails instead of claiming success; Deep Research is passed through', async (t) => {
  const s = await setup(t, { runCli: async (input) => {
    assert.equal(input.mode, 'deep-research'); assert.equal(input.timeout, 60);
    await success(input);
    await fs.writeFile(`${input.report}.meta.json`, JSON.stringify({ selectedModel: 'Medium', selectedMode: input.mode }));
    return '';
  } });
  s.executor.submit(task('research', 'deep-research'));
  assert.match((await s.done).failed, /没有降级模型/);
});

test('credentials rejected before persistence; credential-like report never enters receipt', async () => {
  const secret = 'sk-' + 'x'.repeat(24);
  assert.throws(() => validatePublicTask(secret), /凭据/);
  assert.throws(() => summary(`answer ${secret}`), /凭据/);
  assert.throws(() => summary('answer ghp_' + 'x'.repeat(24)), /凭据/);
  assert.equal(summary('# Report\nIntro\n## Conclusion\nFinal finding.\n## Sources\nLinks'), '结论摘要（报告摘录）：Final finding.');
});

test('CLI subprocess strips AgentDeck credentials and does not expose arbitrary stderr in failures', async (t) => {
  const s = await setup(t);
  const cliPath = path.join(s.dir, 'fake-cli.js'), report = path.join(s.dir, 'out.md');
  await fs.writeFile(cliPath, `const fs=require('fs'); const out=process.argv[process.argv.indexOf('--out')+1]; if(Object.keys(process.env).some(k=>k.startsWith('AGENTDECK_')))process.exit(9); console.error('private diagnostic never propagated'); fs.writeFileSync(out+'.error.json',JSON.stringify({code:'LOGIN_REQUIRED',reason:'private diagnostic'})); process.exit(1);`);
  const code = await runCli({ cliPath, report, question: 'ignored', mode: 'chat', timeout: 30,
    env: { ...process.env, AGENTDECK_RECEIPT_TOKEN: 'fake-secret', AGENTDECK_CONTROL_TOKEN: 'fake-control' }, onChild() {} });
  assert.equal(code, 'LOGIN_REQUIRED');
});

test('cancel queued task submits failed receipt and never calls fake webpage', async (t) => {
  let calls = 0;
  const s = await setup(t, { runCli: async () => { calls++; return 'TIMEOUT'; } });
  s.executor.submit(task()); s.executor.cancel('one');
  assert.match((await s.done).failed, /已取消/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('stop followed immediately by a new question waits for the cancelled child to exit', async (t) => {
  let release, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const receipts = [];
  const s = await setup(t, { runCli: async (input) => {
    calls++;
    if (calls === 1) { await gate; return 'INTERRUPTED'; }
    return success(input);
  }, emit: (event) => { if (event.action === 'complete') receipts.push(event); } });
  s.executor.submit(task());
  while (calls === 0) await new Promise((r) => setTimeout(r, 5));
  s.executor.cancel('one');
  s.executor.submit({ ...task(), taskId: 'replacement' });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  release();
  while (receipts.length < 2) await new Promise((r) => setTimeout(r, 5));
  assert.match(receipts[0].failed, /已取消/);
  assert.equal(receipts[1].taskId, 'replacement');
  assert.equal(receipts[1].failed, undefined);
  assert.equal(s.executor.status('one').receipt.taskId, 'replacement');
});

test('a request behind another reports phase queued until the page is opened for it', async (t) => {
  let release, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [], receipts = [];
  const s = await setup(t, { runCli: async (input) => { if (++calls === 1) await gate; return success(input); },
    emit: (event) => { events.push(event); if (event.action === 'complete') receipts.push(event); } });
  s.executor.submit(task()); s.executor.submit(task('two'));
  while (calls === 0) await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.executor.status('one').phase, 'running');
  assert.equal(s.executor.status('two').phase, 'queued');
  const phases = (id) => events.filter((e) => e.action === 'progress' && e.callerId === id).map((e) => e.phase);
  assert.deepEqual(phases('one'), ['queued', 'running']);
  assert.deepEqual(phases('two'), ['queued']);
  release();
  while (receipts.length < 2) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(phases('two'), ['queued', 'running']);
});

test('cooldown before the page opens still counts as queued', async (t) => {
  const s = await setup(t, { cooldownMs: 60, runCli: success });
  await fs.mkdir(path.join(s.dir, 'state'), { recursive: true });
  await fs.writeFile(path.join(s.dir, 'state', 'cooldown.json'), JSON.stringify({ finishedAt: Date.now() }));
  s.executor.submit(task());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.executor.status('one').phase, 'queued');
  await s.done;
  assert.deepEqual(s.events.filter((e) => e.action === 'progress').map((e) => e.phase), ['queued', 'queued', 'running']);
});
