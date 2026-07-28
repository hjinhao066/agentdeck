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
