'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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
    [['--test'], { message: '【测试】AgentDeck Bark 通知（critical，音量 3）。', urgent: true, test: true }],
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
