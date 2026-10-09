'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ReceiptListener = require('../receipt-listener-core');

const cli = path.join(__dirname, '..', 'board-cli.js');

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, AGENTDECK_RECEIPT_TOKEN: '', AGENTDECK_TERMINAL_ID: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('manual terminal cannot access the control channel', async () => {
  const result = await runCli(['status'], {
    AGENTDECK_CONTROL_DIR: '',
    AGENTDECK_CONTROL_TOKEN: '',
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Only conductor-managed terminals/);
});

test('briefing sends a read-only Captain request and prints the full instructions and handoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-briefing-cli-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  const briefing = require('../main-core').instructions(process.platform) + '\n队长交接：继续当前任务，重挂回执监听。';
  const requests = [];
  const server = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((name) => name.endsWith('.json'))) {
      const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
      fs.unlinkSync(path.join(dir, 'requests', file));
      requests.push(request);
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: briefing }));
    }
  }, 20);
  try {
    const result = await runCli(['briefing'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token' });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, briefing + '\n');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, 'main-briefing');
    assert.equal(requests[0].token, 'test-token');
    assert.equal(requests[0].message, undefined);
    assert.equal(requests[0].task, undefined);
    const denied = await runCli(['briefing'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /Only conductor-managed terminals/);
  } finally { clearInterval(server); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quota uses one read-only Captain request and prints the four provider lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-quota-cli-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  const lines = 'Claude：19%\nCodex：8%\nCursor：正常\nAntigravity：已用尽';
  let requests = 0;
  const server = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((name) => name.endsWith('.json'))) {
      const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
      fs.unlinkSync(path.join(dir, 'requests', file));
      requests++;
      assert.equal(request.action, 'main-quota');
      assert.equal(request.message, undefined);
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: lines }));
    }
  }, 20);
  try {
    const result = await runCli(['quota'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token' });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, lines + '\n');
    assert.equal(requests, 1);
    const denied = await runCli(['quota'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /Only conductor-managed terminals/);
  } finally { clearInterval(server); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('receipts --wait validates seconds and still requires the Captain capability', async () => {
  for (const value of ['no', '-1', 'Infinity', '']) {
    const result = await runCli(['receipts', '--wait', `--timeout=${value}`], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /non-negative number of seconds/);
  }
  for (const args of [['receipts', '--wait'], ['receipts', '--wait', '--timeout', '0']]) {
    const result = await runCli(args, { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Only conductor-managed terminals/);
  }
});

test('receipts --wait remains silent on empty reads, prints a later question once, and exits empty on timeout', async () => {
  for (const timeout of [undefined, '3', '0.4']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-receipts-cli-'));
    ReceiptListener.initialize(dir);
    fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
    let reads = 0;
    const server = setInterval(() => {
      for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((name) => name.endsWith('.json'))) {
        const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
        fs.unlinkSync(path.join(dir, 'requests', file));
        assert.equal(request.action, 'main-receipts');
        assert.equal(request.wait, true);
        assert.equal(request.token, 'test-token');
        assert.ok(request.expiresAt <= request.createdAt + 5000);
        if (timeout !== undefined) assert.ok(request.expiresAt <= request.createdAt + Number(timeout) * 1000);
        const result = ++reads >= 2 && timeout !== '0.4' ? '【AgentDeck 新回执】\n向你提问：which database?' : '';
        fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result }));
      }
    }, 20);
    try {
      const started = Date.now();
      const result = await runCli(['receipts', '--wait', ...(timeout === undefined ? [] : ['--timeout', timeout])], {
        AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token',
      });
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      if (timeout === '0.4') {
        assert.equal(result.stdout, '');
        assert.ok(Date.now() - started >= 400);
      } else {
        assert.equal(result.stdout, '【AgentDeck 新回执】\n向你提问：which database?\n');
        assert.equal(reads, 2);
      }
    } finally { clearInterval(server); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('receipts --wait timeout succeeds even when the renderer has not taken the request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-receipts-timeout-'));
  ReceiptListener.initialize(dir);
  try {
    for (const timeout of ['0', '0.1']) {
      const result = await runCli(['receipts', '--wait', '--timeout', timeout], {
        AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token',
      });
      assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
      assert.deepEqual(fs.readdirSync(path.join(dir, 'requests')), []);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('managed CLI writes an authenticated request and consumes its response', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-board-cli-'));
  const requestDir = path.join(dir, 'requests');
  const responseDir = path.join(dir, 'responses');
  fs.mkdirSync(requestDir, { recursive: true });
  fs.mkdirSync(responseDir, { recursive: true });
  const token = 'test-capability-token';
  const running = runCli(['progress', '--message', 'tests passing'], {
    AGENTDECK_CONTROL_DIR: dir,
    AGENTDECK_CONTROL_TOKEN: token,
  });

  let request;
  const deadline = Date.now() + 3000;
  while (!request && Date.now() < deadline) {
    const files = fs.readdirSync(requestDir).filter((name) => name.endsWith('.json'));
    if (files.length) request = JSON.parse(fs.readFileSync(path.join(requestDir, files[0]), 'utf8'));
    if (!request) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(request);
  assert.equal(request.token, token);
  assert.equal(request.action, 'progress');
  assert.equal(request.message, 'tests passing');
  fs.writeFileSync(path.join(responseDir, `${request.id}.json`), JSON.stringify({ done: true }), 'utf8');

  const result = await running;
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Progress recorded/);
  assert.equal(fs.existsSync(path.join(responseDir, `${request.id}.json`)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('peek rejects missing ids and invalid row counts before creating a request', async () => {
  for (const args of [[], ['--id'], ['--id', 'x', '--lines'], ['--id', 'x', '--lines', '0'], ['--id', 'x', '--lines', '1.5'], ['--id', 'x', '--lines', '1001'], ['--id', 'x', '--lines', 'no']]) {
    const result = await runCli(['peek', ...args], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /peek (requires --id|--lines must be an integer)/);
  }
});

test('peek requires the same capability token as other Captain commands', async () => {
  const result = await runCli(['peek', '--id', 'worker'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Only conductor-managed terminals/);
});

test('peek sends the id and default or requested row count and prints only live output', async () => {
  for (const lines of [undefined, 2]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-peek-cli-'));
    fs.mkdirSync(path.join(dir, 'requests'));
    fs.mkdirSync(path.join(dir, 'responses'));
    try {
      const running = runCli(['peek', '--id', 'worker', ...(lines ? ['--lines', String(lines)] : [])], {
        AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token',
      });
      let request;
      const deadline = Date.now() + 3000;
      while (!request && Date.now() < deadline) {
        const file = fs.readdirSync(path.join(dir, 'requests')).find((name) => name.endsWith('.json'));
        if (file) request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(request);
      assert.equal(request.action, 'main-peek');
      assert.equal(request.to, 'worker');
      assert.equal(request.lines, lines || 40);
      assert.equal(request.token, 'test-token');
      fs.writeFileSync(path.join(dir, 'responses', request.id + '.json'), JSON.stringify({ done: true, result: 'live first\nlive second' }));
      const result = await running;
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'live first\nlive second\n');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('Captain stop/archive and tell flags use the authenticated request channel', async () => {
  for (const [args, expected] of [
    [['new', '--title', 'US2 task', '--task', 'Inspect', '--seat', 'us2'], { action: 'main-new', seatId: 'us2' }],
    [['new', '--title', 'Review', '--task', 'Inspect', '--project', '登录项目', '--reviews', 'worker-a, worker-b,worker-a'], { action: 'main-new', title: 'Review', task: 'Inspect', project: '登录项目', reviews: ['worker-a', 'worker-b'] }],
    [['stop', '--id', 'worker'], { action: 'main-stop', to: 'worker' }],
    [['archive', '--id', 'worker'], { action: 'main-archive', to: 'worker' }],
    [['tell', '--to', 'worker', '--message', 'new plan', '--replace', '--now'], { action: 'main-tell', to: 'worker', message: 'new plan', replace: true, now: true }],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-captain-cli-'));
    fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
    const running = runCli(args, { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token' });
    let request;
    for (const deadline = Date.now() + 3000; !request && Date.now() < deadline;) {
      const file = fs.readdirSync(path.join(dir, 'requests')).find((f) => f.endsWith('.json'));
      if (file) request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(request);
    assert.equal(request.token, 'test-token');
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(request[key], value);
    fs.writeFileSync(path.join(dir, 'responses', `${request.id}.json`), JSON.stringify({ done: true, result: 'done' }));
    assert.equal((await running).code, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const action of ['stop', 'archive']) {
    const r = await runCli([action, '--id'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /requires --id/);
  }
});

test('new rejects empty project names and malformed review declarations before requesting', async () => {
  for (const options of [['--project'], ['--project='], ['--reviews'], ['--reviews='], ['--reviews', 'a,'], ['--reviews', '../a'], ['--seat'], ['--seat', '../bad']]) {
    const result = await runCli(['new', '--title', 'Review', '--task', 'Inspect', ...options], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /new --(project|reviews|seat) requires/);
  }
});


test('briefing sends a read-only Captain request and prints the full static instructions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-briefing-cli-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  const instructions = require('../main-core').instructions(process.platform);
  const requests = [];
  const server = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((name) => name.endsWith('.json'))) {
      const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
      fs.unlinkSync(path.join(dir, 'requests', file));
      requests.push(request);
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: instructions }));
    }
  }, 20);
  try {
    const result = await runCli(['briefing'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' });
    assert.equal(result.code, 0); assert.equal(result.stdout, instructions + '\n');
    assert.equal(requests.length, 1); assert.equal(requests[0].action, 'main-briefing');
    assert.equal(requests[0].message, undefined);
    const denied = await runCli(['briefing'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: '', AGENTDECK_RECEIPT_TOKEN: 'worker-test' });
    assert.equal(denied.code, 1); assert.match(denied.stderr, /Only conductor-managed terminals/);
    assert.equal(requests.length, 1);
  } finally { clearInterval(server); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('notify-user validates arguments and requires the Captain capability', async () => {
  for (const args of [[], ['--message'], ['--message='], ['--message', 'a'.repeat(4001)],
    ['--message', 'hi', '--urgent=false'], ['--test=false'], ['--test', '--message', 'hi'], ['--test', '--urgent']]) {
    const r = await runCli(['notify-user', ...args], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.equal(r.code, 1); assert.match(r.stderr, /notify-user requires/);
  }
  for (const args of [['--test'], ['--message', 'hello'], ['--message', 'hello', '--urgent']]) {
    const r = await runCli(['notify-user', ...args], {
      AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '', AGENTDECK_RECEIPT_TOKEN: 'worker-test',
    });
    assert.equal(r.code, 1); assert.match(r.stderr, /Only conductor-managed terminals/);
  }
});

test('notify-user routes local, urgent and fixed test requests without key data', async () => {
  for (const [args, expected] of [
    [['--message', 'hello'], { message: 'hello', urgent: false, test: false }],
    [['--message', 'hello', '--urgent'], { message: 'hello', urgent: true, test: false }],
    [['--test'], { message: 'AgentDeck 加急通知测试', urgent: true, test: true }],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-notify-cli-'));
    fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
    fs.writeFileSync(path.join(dir, 'requests', 'unpublished.json.123.tmp'), '{');
    const requests = [];
    const server = setInterval(() => {
      for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((name) => name.endsWith('.json'))) {
        const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
        fs.unlinkSync(path.join(dir, 'requests', file)); requests.push(request);
        fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: 'sent' }));
      }
    }, 20);
    try {
      const r = await runCli(['notify-user', ...args], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' });
      assert.equal(r.code, 0); assert.equal(r.stdout, 'sent\n'); assert.equal(requests.length, 1);
      assert.equal(fs.readFileSync(path.join(dir, 'requests', 'unpublished.json.123.tmp'), 'utf8'), '{');
      const { id, token, createdAt, ...payload } = requests[0];
      assert.equal(token, 'captain-test'); assert.deepEqual(payload, { action: 'main-notify-user', ...expected });
    } finally { clearInterval(server); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('queue list/cancel send Captain requests, validate ids and document replacement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-queue-cli-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  const requests = [];
  const server = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests'))) {
      if (!file.endsWith('.json')) continue;
      const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
      fs.unlinkSync(path.join(dir, 'requests', file)); requests.push(request);
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: request.op === 'list' ? '[]' : 'cancelled' }));
    }
  }, 20);
  const env = { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token' };
  try {
    assert.equal((await runCli(['queue', 'list'], env)).stdout, '[]\n');
    assert.equal((await runCli(['queue', 'cancel', '--task-id', 'card-123'], env)).stdout, 'cancelled\n');
    assert.deepEqual(requests.map(({ action, op, taskId }) => ({ action, op, taskId })), [
      { action: 'main-queue', op: 'list', taskId: undefined }, { action: 'main-queue', op: 'cancel', taskId: 'card-123' },
    ]);
    for (const args of [['queue', 'cancel'], ['queue', 'cancel', '--task-id', '../bad'], ['queue', 'list', '--task-id', 'card'], ['queue', 'unknown']]) {
      assert.equal((await runCli(args, env)).code, 1);
    }
    assert.equal(requests.length, 2);
    const denied = await runCli(['queue', 'list'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.match(denied.stderr, /Only conductor-managed terminals/);
    const help = (await runCli(['help'], {})).stdout;
    assert.match(help, /queue cancel --task-id/); assert.match(help, /replaces a changed command\/model/);
    const prompt = require('../main-core').instructions('darwin');
    assert.match(prompt, /queue list；queue cancel --task-id/);
    assert.equal(prompt, require('../main-core').instructions('darwin', 'dynamic note must stay out'));
  } finally { clearInterval(server); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker receipts carry provider-injected UUIDs and never emit unrelated or malformed environment data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-session-env-cli-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  const requests = [];
  const server = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((name) => name.endsWith('.json'))) {
      const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
      fs.unlinkSync(path.join(dir, 'requests', file));
      requests.push(request);
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true }));
    }
  }, 10);
  const ids = { Codex: '11111111-1111-4111-8111-111111111111', Cursor: '22222222-2222-4222-8222-222222222222', Antigravity: '33333333-3333-4333-8333-333333333333' };
  const env = { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_RECEIPT_TOKEN: 'receipt-token',
    CODEX_THREAD_ID: ids.Codex, CURSOR_CONVERSATION_ID: ids.Cursor, ANTIGRAVITY_CONVERSATION_ID: ids.Antigravity, UNRELATED_SESSION_SECRET: 'must-not-leave-process' };
  try {
    for (const args of [['progress', '--message', 'working'], ['ask', '--question', 'which?'], ['complete', '--result', 'done']]) {
      const result = await runCli(args, env);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(requests.at(-1).modelSessionIds, ids);
      assert.equal(requests.at(-1).token, 'receipt-token');
      assert.ok(!JSON.stringify(requests.at(-1)).includes(env.UNRELATED_SESSION_SECRET));
    }
    // status is Captain-only; the receipt capability cannot request it.
    assert.equal((await runCli(['status'], { ...env, AGENTDECK_RECEIPT_TOKEN: '', AGENTDECK_CONTROL_TOKEN: 'captain-token' })).code, 0);
    assert.equal(requests.at(-1).modelSessionIds, undefined);
    assert.equal((await runCli(['progress', '--message', 'working'], { ...env, CODEX_THREAD_ID: 'bad', CURSOR_CONVERSATION_ID: '', ANTIGRAVITY_CONVERSATION_ID: 'bad' })).code, 0);
    assert.equal(requests.at(-1).modelSessionIds, undefined);
  } finally { clearInterval(server); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- Relay handoff: the command, the listener's identity, and the deadline on commands that change something ----
function controlDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  return dir;
}
function serve(dir, answer) {
  const requests = [];
  const timer = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((name) => name.endsWith('.json'))) {
      const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
      fs.unlinkSync(path.join(dir, 'requests', file));
      requests.push(request);
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify(answer(request, requests.length)));
    }
  }, 20);
  return { requests, stop() { clearInterval(timer); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('handoff asks the Captain channel for the live handoff and prints it whole, long or not', async () => {
  const dir = controlDir('agentdeck-handoff-cli-');
  const text = '# AgentDeck 队长交接\n\n## 1. 交接元信息\n' + '- 一张未完成的卡\n'.repeat(1500);
  assert.ok(text.length > 12000, 'longer than the cap ordinary results are cut to');
  const server = serve(dir, () => ({ done: true, result: text }));
  try {
    const result = await runCli(['handoff'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' });
    assert.equal(result.code, 0); assert.equal(result.stdout, text + '\n');
    assert.equal(server.requests.length, 1); assert.equal(server.requests[0].action, 'main-handoff');
    assert.equal(server.requests[0].deadline, undefined, 'a read is never refused for being late');
    // a worker's submission-only capability does not reach it
    const denied = await runCli(['handoff'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: '', AGENTDECK_RECEIPT_TOKEN: 'worker-test' });
    assert.equal(denied.code, 1); assert.match(denied.stderr, /Only conductor-managed terminals/);
    assert.equal(server.requests.length, 1);
    assert.match((await runCli(['help'], {})).stdout, /handoff\s+current Relay handoff from live state/);
  } finally { server.stop(); }
  // the bridge passes it through uncut, like the briefing
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /'main-briefing', 'main-handoff',/);
  assert.match(main, /const verbatim = action === 'main-briefing' \|\| action === 'main-handoff' \|\|/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), /captainHandoff: \(payload\) => ipcRenderer\.invoke\('seats:handoff', payload\)/);
  assert.ok(require('../package.json').build.files.includes('relay-handoff-core.js'), 'the packaged app ships the module main requires');
});

test('one receipts --wait process is one listener: every poll carries the same id and start time, and it leaves when told it was replaced', async () => {
  const dir = controlDir('agentdeck-listener-cli-');
  ReceiptListener.initialize(dir);
  const notice = require('../main-core').LISTENER_SUPERSEDED;
  const server = serve(dir, (_request, n) => ({ done: true, result: n >= 3 ? notice : '' }));
  try {
    const before = Date.now();
    const result = await runCli(['receipts', '--wait', '--timeout', '30'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' });
    assert.equal(result.code, 0); assert.equal(result.stdout, notice + '\n');
    assert.equal(server.requests.length, 3);
    const ids = new Set(server.requests.map((r) => r.watcher)), starts = new Set(server.requests.map((r) => r.watcherStartedAt));
    assert.equal(ids.size, 1); assert.match([...ids][0], /^\d+-[0-9a-f]{8}$/);
    assert.equal(starts.size, 1); assert.ok([...starts][0] >= before && [...starts][0] <= Date.now());
    // a second process is a different listener; a plain read is not a listener at all
    await runCli(['receipts', '--wait', '--timeout', '30'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' });
    assert.notEqual(server.requests.at(-1).watcher, [...ids][0]);
    await runCli(['receipts'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' });
    assert.equal(server.requests.at(-1).wait, undefined); assert.equal(server.requests.at(-1).watcher, undefined);
  } finally { server.stop(); }
});

test('commands that change something tell the app when their CLI stops waiting; reads and worker submissions do not', async () => {
  for (const [args, action, guarded] of [
    [['new', '--title', '查日志', '--task', '整理错误日志'], 'main-new', true],
    [['tell', '--to', 'c1', '--message', '补充'], 'main-tell', true],
    [['stop', '--id', 'c1'], 'main-stop', true],
    [['archive', '--id', 'c1'], 'main-archive', true],
    [['answer', '--to', 'c1', '--key', 'y'], 'main-answer', true],
    [['ledger'], 'main-ledger', false],
    [['complete', '--result', '做完了'], 'complete', false],
  ]) {
    const dir = controlDir('agentdeck-deadline-cli-');
    const server = serve(dir, () => ({ done: true, result: 'ok' }));
    try {
      const result = await runCli(args, { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' });
      assert.equal(result.code, 0, action);
      const request = server.requests[0];
      assert.equal(request.action, action);
      if (guarded) assert.ok(request.deadline >= request.createdAt + 29000 && request.deadline <= request.createdAt + 31000, action);
      else assert.equal(request.deadline, undefined, action);
    } finally { server.stop(); }
  }
  const cli = fs.readFileSync(path.join(__dirname, '..', 'board-cli.js'), 'utf8');
  assert.match(cli, /这条命令过期后不会再被执行；重发前先用 ledger 确认它是否刚好已经生效/);
});

test('new forwards --worktree only when asked, and worktree clean lists without deleting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-wt-cli-'));
  fs.mkdirSync(path.join(dir, 'requests'));
  fs.mkdirSync(path.join(dir, 'responses'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const plain = runCli(['new', '--title', 'Notes', '--task', 'Read'], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token' });
  let request;
  for (const deadline = Date.now() + 3000; !request && Date.now() < deadline;) {
    const file = fs.readdirSync(path.join(dir, 'requests')).find((name) => name.endsWith('.json'));
    if (file) request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
    else await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(request);
  assert.equal(request.worktree, undefined);
  assert.equal(request.base, undefined);
  assert.equal(request.branch, undefined);
  fs.writeFileSync(path.join(dir, 'responses', request.id + '.json'), JSON.stringify({ done: true, result: 'opened' }));
  assert.equal((await plain).code, 0);

  const rejected = await runCli(['new', '--title', 'Code', '--task', 'Edit', '--worktree', repo, '--cwd', repo], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /do not also pass --cwd/);
  const missing = await runCli(['new', '--title', 'Code', '--task', 'Edit', '--base', 'main'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.match(missing.stderr, /require --worktree/);
  const badBranch = await runCli(['new', '--title', 'Code', '--task', 'Edit', '--worktree', repo, '--branch', '../x'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.match(badBranch.stderr, /无效分支名/);

  const copies = path.join(dir, 'copies');
  const Worktree = require('../worktree-core');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init'], { cwd: repo });
  const created = Worktree.prepare({ repo, branch: 'agentdeck/cli', root: copies });
  const listed = await runCli(['worktree', 'clean', '--root', copies], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /没有删除/);
  assert.match(listed.stdout, /agentdeck\/cli/);
  assert.equal(fs.existsSync(created.path), true);
  const applied = await runCli(['worktree', 'clean', '--apply', '--root', copies], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /没有删除/);
  assert.equal(fs.existsSync(created.path), true);
  const confirmed = await runCli(['worktree', 'clean', '--apply', '--path', created.path, '--root', copies], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal(fs.existsSync(created.path), false);
  const outside = await runCli(['worktree', 'clean', '--root', os.homedir()], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.notEqual(outside.code, 0);
  assert.match(outside.stderr, /temp directory/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings battery: no flags reads, flags send a validated change, bad flags never reach the app', async () => {
  const dir = controlDir('agentdeck-settings-cli-');
  const server = serve(dir, () => ({ done: true, result: '电池模式：自动' }));
  const env = { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' };
  try {
    assert.equal((await runCli(['settings', 'battery'], env)).stdout, '电池模式：自动\n');
    assert.equal((await runCli(['settings', 'battery', '--mode', 'off'], env)).code, 0);
    assert.equal((await runCli(['settings', 'battery', '--cap', '10'], env)).code, 0);
    assert.equal((await runCli(['settings', 'battery', '--mode=auto', '--cap=1'], env)).code, 0);
    assert.deepEqual(server.requests.map(({ action, op, input }) => ({ action, op, input })), [
      { action: 'main-settings', op: 'battery', input: {} },
      { action: 'main-settings', op: 'battery', input: { mode: 'off' } },
      { action: 'main-settings', op: 'battery', input: { cap: 10 } },
      { action: 'main-settings', op: 'battery', input: { mode: 'auto', cap: 1 } },
    ]);
    for (const args of [['settings'], ['settings', 'sound'], ['settings', 'battery', 'off'], ['settings', 'battery', '--mode'], ['settings', 'battery', '--mode', 'on'],
      ['settings', 'battery', '--mode', 'OFF'], ['settings', 'battery', '--cap'], ['settings', 'battery', '--cap', '0'], ['settings', 'battery', '--cap', '11'],
      ['settings', 'battery', '--cap', '2.5'], ['settings', 'battery', '--cap', 'many'], ['settings', 'battery', '--cap', '-1'], ['settings', 'battery', '--limit', '3']]) {
      const result = await runCli(args, env);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, /settings/, args.join(' '));
    }
    assert.equal(server.requests.length, 4);
    const denied = await runCli(['settings', 'battery'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.match(denied.stderr, /Only conductor-managed terminals/);
    const help = (await runCli(['help'], {})).stdout;
    assert.match(help, /settings battery \[--boost on\|off \[--for 90m\|2h \| --until 23:59\]\] \[--mode off\|auto\] \[--cap 1-10\]/);
    assert.match(help, /临时拉满[\s\S]*用户说「强度拉满」/);
    assert.match(help, /no flags = read only; flags take effect at once and are saved/);
  } finally { server.stop(); }
});

test('settings battery --boost: on/off, with an optional length or clock time, checked before anything is requested', async () => {
  const dir = controlDir('agentdeck-boost-cli-');
  const server = serve(dir, () => ({ done: true, result: 'ok' }));
  const env = { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' };
  const inputs = () => server.requests.map((r) => r.input);
  try {
    assert.equal((await runCli(['settings', 'battery', '--boost', 'on'], env)).code, 0);
    assert.equal((await runCli(['settings', 'battery', '--boost', 'off'], env)).code, 0);
    assert.equal((await runCli(['settings', 'battery', '--boost', 'on', '--for', '90m'], env)).code, 0);
    assert.equal((await runCli(['settings', 'battery', '--boost', 'on', '--for', '2h'], env)).code, 0);
    assert.equal((await runCli(['settings', 'battery', '--boost', 'on', '--until', '23:59'], env)).code, 0);
    assert.deepEqual(inputs().slice(0, 4), [{ boost: true }, { boost: false }, { boost: true, boostMinutes: 90 }, { boost: true, boostMinutes: 120 }]);
    // 23:59 today (or tomorrow when it has passed): between 1 minute and 24 hours from now.
    const until = inputs()[4];
    assert.equal(until.boost, true);
    assert.ok(Number.isInteger(until.boostMinutes) && until.boostMinutes >= 1 && until.boostMinutes <= 1440, JSON.stringify(until));
    const now = new Date(), end = new Date(now); end.setHours(23, 59, 0, 0);
    if (end > now) assert.ok(Math.abs(until.boostMinutes - Math.ceil((end - now) / 60000)) <= 1);
    const sent = server.requests.length;
    for (const args of [['--boost'], ['--boost', 'yes'], ['--boost', 'ON'], ['--for', '2h'], ['--until', '23:59'], ['--boost', 'off', '--for', '2h'],
      ['--boost', 'on', '--for', '2h', '--until', '23:59'], ['--boost', 'on', '--for', '0m'], ['--boost', 'on', '--for', '49h'], ['--boost', 'on', '--for', '2d'],
      ['--boost', 'on', '--for', 'long'], ['--boost', 'on', '--until', '24:00'], ['--boost', 'on', '--until', '9am'], ['--boost', 'on', '--until', '12:60']]) {
      const result = await runCli(['settings', 'battery', ...args], env);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, /settings battery/, args.join(' '));
    }
    assert.equal(server.requests.length, sent);
  } finally { server.stop(); }
});

test('inbox help and the Captain briefing say a report is read once the user saw it in the chat', async () => {
  const help = await runCli(['inbox', 'help'], {});
  assert.equal(help.code, 0);
  assert.match(help.stdout, /汇报自动挂到你这一轮回复：用户在对话里看过这轮回复就算已读，不进「做完了你还没看」/);
  const M = require('../main-core');
  for (const platform of ['darwin', 'win32']) assert.match(M.instructions(platform, '', false, 30), /report（挂到本轮回复，用户在对话里看过即算已读，结论也要在回复里说）/);
});

// ---- 小队长 ----
test('new --sub-captain needs a project and reaches the app as subCaptain; create-child leaves the model to the app', async () => {
  const dir = controlDir('agentdeck-sub-captain-cli-');
  const server = serve(dir, (request) => ({ done: true, result: request.action === 'create-child' ? '已开子会话 c-board-kid「子会话」' : '已开新会话 c-board-sub「小队长」' }));
  const env = { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' };
  try {
    for (const args of [['--sub-captain'], ['--sub-captain', '--project', ''], ['--sub-captain=yes', '--project', '秋招']]) {
      const refused = await runCli(['new', '--title', '小队长', '--task', '统筹', ...args], env);
      assert.equal(refused.code, 1, args.join(' '));
      assert.match(refused.stderr, /--sub-captain|--project requires a value/);
    }
    assert.equal(server.requests.length, 0);
    const made = await runCli(['new', '--title', '小队长', '--task', '统筹', '--sub-captain', '--project', '秋招'], env);
    assert.equal(made.code, 0);
    assert.equal(server.requests[0].action, 'main-new');
    assert.equal(server.requests[0].subCaptain, true);
    assert.equal(server.requests[0].project, '秋招');
    // An ordinary new carries no subCaptain field at all.
    await runCli(['new', '--title', '散活', '--task', 'x'], env);
    assert.equal('subCaptain' in server.requests[1], false);
    // A 小队长's create-child returns at once; with no --agent the app picks its model.
    const child = await runCli(['create-child', '--title', '子会话', '--task', '做一件事'], env);
    assert.equal(child.code, 0);
    assert.match(child.stdout, /已开子会话 c-board-kid/);
    assert.equal(server.requests[2].action, 'create-child');
    assert.equal(server.requests[2].agent, '');
    await runCli(['create-child', '--title', '子会话', '--task', '做一件事', '--agent', 'codex'], env);
    assert.equal(server.requests[3].agent, 'codex');
    assert.match((await runCli(['help'], {})).stdout, /--sub-captain \(needs --project\)/);
    // A 小队长's final delivery is marked; any other complete carries no such field.
    await runCli(['complete', '--result', '阶段一'], env);
    assert.equal('final' in server.requests[4], false);
    await runCli(['complete', '--result', '最终交付', '--final'], env);
    assert.equal(server.requests[5].final, true);
    const odd = await runCli(['complete', '--result', 'x', '--final=yes'], env);
    assert.equal(odd.code, 1);
    assert.match(odd.stderr, /--final takes no value/);
  } finally { server.stop(); }
});
