'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const M = require('../main-core');
const C = require('../chat-core');
const B = require('../board-core');

test('command receipts preserve Unicode, whitespace, long content and every file across saving', () => {
  const result = '  完成🙂\n' + '中文𠮷'.repeat(6000) + '\n结尾  ';
  const files = Array.from({ length: 12 }, (_, i) => '/tmp/' + 'long'.repeat(140) + i + '.png');
  const receipt = M.commandReceipt({ action: 'complete', result, files, failed: '  原因\n详情🙂  ' });
  assert.equal(receipt.summary, result);
  assert.equal(receipt.failed, '  原因\n详情🙂  ');
  const saved = C.normalizeChat({ turns: [{ id: 'card', user: '', kind: 'task', task: { receipt } }] }, 'captain').turns[0].task;
  assert.deepEqual(saved.receipt, receipt);
  const text = M.receiptsForModel([{ title: 'worker', colId: 'x', ...receipt }]);
  assert.ok(text.includes(result));
  assert.ok(text.includes(receipt.failed));
  assert.ok(text.includes(files.at(-1)));
  const question = '  哪个方案？\n' + '选择🙂'.repeat(6000);
  assert.equal(M.commandReceipt({ action: 'ask', question }).question, question);
  assert.ok(M.receiptsForModel([{ title: 'worker', ...M.commandReceipt({ action: 'ask', question }) }]).includes(question));
});

test('submission schema rejects invalid results and files instead of silently cutting or dropping them', () => {
  for (const message of [{ result: '' }, { result: true }, { result: 'ok', files: 'a' }, { result: 'ok', files: ['relative/file'] }, { result: 'ok', failed: true }, { action: 'ask', question: ' ' }]) {
    assert.throws(() => M.commandReceipt(message));
  }
  assert.deepEqual(M.commandReceipt({ result: 'ok', files: ['/tmp/a b', 'C:\\work\\a', '\\\\server\\share\\a', '~/a'] }).files, ['/tmp/a b', 'C:\\work\\a', '\\\\server\\share\\a', '~/a']);
  for (const command of ['complete --result', 'ask --question', 'progress --message']) assert.ok(M.RECEIPT_CONTRACT.includes(command));
  assert.ok(M.RECEIPT_CONTRACT.includes('$env:AGENTDECK_BOARD_CLI'));
  assert.match(M.RECEIPT_CONTRACT, /不要 unset、覆盖或清掉 AGENTDECK_/);
  assert.match(M.RECEIPT_CONTRACT, /只在子进程里清/);
  assert.match(M.RECEIPT_CONTRACT, /按当前终端认回自己的凭据/);
});

test('submission CLI uses its receipt token and transports exact text, files and failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-submit-unit-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  try {
    for (const [args, expected] of [
      [['complete', '--result', '  完成🙂\n第二行  ', '--files', '/tmp/a b,C:\\work\\b', '--failed', '  失败原因🙂  '], { action: 'complete', result: '  完成🙂\n第二行  ', files: ['/tmp/a b', 'C:\\work\\b'], failed: '  失败原因🙂  ' }],
      [['ask', '--question', '  选哪种？\n🙂  '], { action: 'ask', question: '  选哪种？\n🙂  ' }],
      [['progress', '--message', '  正在验收🙂  '], { action: 'progress', message: '  正在验收🙂  ' }],
    ]) {
      const child = spawn(process.execPath, [path.resolve(__dirname, '../board-cli.js'), ...args], {
        env: { ...process.env, AGENTDECK_CONTROL_DIR: dir, AGENTDECK_RECEIPT_TOKEN: 'receipt-token', AGENTDECK_CONTROL_TOKEN: 'control-token' }, stdio: 'ignore',
      });
      const closed = new Promise((resolve) => child.on('close', resolve));
      let request;
      for (let tries = 0; !request && tries < 200; tries++) {
        const file = fs.readdirSync(path.join(dir, 'requests')).find((name) => name.endsWith('.json'));
        if (file) {
          request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
          fs.unlinkSync(path.join(dir, 'requests', file));
          fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true }));
        } else await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(request);
      assert.equal(request.token, 'receipt-token');
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(request[key], value);
      assert.equal(await closed, 0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('launch exit reporting captures the actual exit code even when the shell survives', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-exit-unit-'));
  const cli = path.join(dir, 'capture.js');
  fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  try {
    for (const code of [0, 7, 137]) {
      const output = execFileSync('/bin/sh', ['-c', B.reportAgentExit(`sh -c 'exit ${code}'`, 'darwin')], {
        env: { ...process.env, AGENTDECK_BOARD_CLI: cli }, encoding: 'utf8',
      });
      assert.deepEqual(JSON.parse(output), ['session-exit', '--code', String(code)]);
    }
    assert.ok(B.reportAgentExit('agy', 'win32').includes('session-exit --code "$LASTEXITCODE"'));
    assert.ok(B.launchInput('codex', 'darwin', true).includes('command "codex"; node'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quota output is recognized for Claude, Codex, Cursor and Antigravity', () => {
  for (const line of ["You've hit your usage limit", 'Usage limit reached', 'Error: Quota exceeded', 'RESOURCE_EXHAUSTED: quota exhausted']) assert.equal(M.terminalActivity(line), 'quota', line);
  assert.equal(M.terminalActivity('I will test quota exceeded handling'), '');
});

test('Cursor monthly exhaustion creates a failure receipt with its native reason, including on exit', () => {
  const sample = fs.readFileSync(path.join(__dirname, 'fixtures/cursor-monthly-limit.txt'), 'utf8').trim();
  assert.equal(M.terminalActivity(sample, 'cursor-agent --model grok-4.7'), 'quota');
  const receipt = M.resourceReceipt(sample, 'cursor-agent --model grok-4.7');
  assert.equal(receipt.source, 'quota');
  assert.equal(receipt.failed, '额度用尽：' + sample);
  assert.equal(M.resourceFailure(receipt.failed, 'quota'), 'quota');
  assert.equal(M.resourceReceipt(sample + '\n→ Add a follow-up ctrl+c to stop', 'cursor-agent'), null);
});

test('internal exit reports queue durably without waiting on a quitting renderer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-exit-cli-'));
  try {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../board-cli.js'), 'session-exit', '--code', '7'], {
      env: { ...process.env, AGENTDECK_CONTROL_DIR: dir, AGENTDECK_RECEIPT_TOKEN: 'exit-token' }, stdio: 'ignore',
    });
    assert.equal(await new Promise((resolve) => child.on('close', resolve)), 0);
    const files = fs.readdirSync(path.join(dir, 'requests'));
    assert.equal(files.length, 1);
    const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', files[0]), 'utf8'));
    assert.equal(request.action, 'session-exit'); assert.equal(request.code, 7); assert.equal(request.token, 'exit-token');
    assert.equal(fs.existsSync(path.join(dir, 'responses')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quota/login/throttle failures are classified from errors, with ordinary defect counterexamples', () => {
  for (const [line, kind] of [['Error: Quota exceeded', 'quota'], ["You've hit your usage limit", 'quota'], ['API Error: 401 Unauthorized', 'auth'], ['Not logged in. Please run /login', 'auth'], ['Error: rate_limit_error', 'rate_limit'], ['请求被限流', 'rate_limit']]) {
    assert.equal(M.resourceFailure(line, 'automatic'), kind, line); assert.equal(M.terminalActivity(line), 'quota', line);
  }
  for (const line of ['Test failed: quota exceeded message was missing', 'I will test quota exceeded handling', 'Authentication test assertion failed', 'exit 7', 'Missing login button', 'Unexpected HTTP response']) assert.equal(M.resourceFailure(line, 'automatic'), '', line);
  assert.equal(M.resourceFailure('provider unavailable', 'quota'), 'quota');
  for (const source of ['command', '', 'review']) assert.equal(M.resourceFailure('401 Unauthorized\n429 Too many requests\nQuota exceeded', source), '', source);
  assert.equal(M.terminalActivity('Not logged in\n→ Working ctrl+c to stop'), 'working');
});

test('resource screen evidence survives a rapid process exit, but old errors followed by work do not mask crashes', () => {
  for (const [screen, label] of [['API Error: 401 Unauthorized', '未登录'], ['429 Too many requests', '请求被限流'], ['RESOURCE_EXHAUSTED: quota exhausted', '额度用尽']]) {
    const receipt = M.resourceReceipt(screen);
    assert.equal(receipt.source, 'quota'); assert.ok(receipt.failed.startsWith(label));
  }
  for (const screen of ['Assertion failed', 'Quota exceeded\n→ Running tests ctrl+c to stop', 'Not logged in\nusage limit reset']) assert.equal(M.resourceReceipt(screen), null);
});

test('ordinary leading resource words do not create quota state or automatic failure receipts', () => {
  const Q = require('../quota-core');
  for (const line of ['Rate limit handling test fails in api.js', 'Unauthorized access test still failing',
    'Limit reached check broken', 'Usage limit reached check broken', 'Quota exhausted handling test fails',
    'Rate limit reached check is broken', '401 Unauthorized access test still failing', '429 Too many requests test fails',
    'RATE_LIMITED\\|function resourceError', 'grep -n "RATE_LIMITED\\|function resourceError" quota-core.js']) {
    for (const decorated of [line, '⏺ ' + line, '│ ' + line]) {
      assert.equal(M.terminalActivity(decorated), '', decorated);
      assert.equal(M.resourceReceipt(decorated), null, decorated);
      assert.equal(M.resourceFailure(decorated, 'automatic'), '', decorated);
      assert.equal(Q.screen('Claude', decorated, []).exhausted, false, decorated);
    }
  }
});

test('native error codes, reset suffixes and login instructions retain automatic detection', () => {
  for (const [line, kind] of [
    ["You've hit your usage limit. To continue using Codex, upgrade your plan.", 'quota'],
    ['Usage limit reached. Resets in 3h', 'quota'], ['Rate limit reached. Resets in 1h', 'rate_limit'],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}', 'rate_limit'],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}', 'auth'],
    ['429 {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}', 'quota'],
    ['Not logged in. Please run /login', 'auth'], ['API Error: 401 Unauthorized', 'auth'],
    ['Not logged in · Please run /login', 'auth'], ["Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY.", 'auth'],
    ["You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:10 PM.", 'quota'],
    ["You've hit your usage limit. To get more access now, send a request to your admin or try again at 5pm.", 'quota'],
    ["You've hit your session limit · resets 9:20pm", 'quota'], ['Usage limit reached · limit resets 3:10pm', 'quota'],
  ]) {
    assert.equal(M.resourceFailure(line, 'automatic'), kind, line);
    assert.equal(M.terminalActivity(line), 'quota', line);
    const receipt = M.resourceReceipt(line);
    assert.equal(receipt.source, 'quota', line);
    assert.equal(M.resourceFailure(receipt.failed, receipt.source), kind, 'generated receipt: ' + line);
  }
});
