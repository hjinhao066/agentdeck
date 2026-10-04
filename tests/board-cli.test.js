'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const cli = path.join(__dirname, '..', 'board-cli.js');

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
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
  for (const options of [['--project'], ['--project='], ['--reviews'], ['--reviews='], ['--reviews', 'a,'], ['--reviews', '../a']]) {
    const result = await runCli(['new', '--title', 'Review', '--task', 'Inspect', ...options], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /new --(project|reviews) requires/);
  }
});


test('briefing sends a read-only Captain request and prints the full static instructions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-briefing-cli-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  const instructions = require('../main-core').instructions(process.platform);
  const requests = [];
  const server = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests'))) {
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
