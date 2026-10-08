'use strict';

// `board-cli.js automation ...`: a scheduled script with no terminal and no terminal token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AutomationCore = require('../automation-core');

const root = path.join(__dirname, '..');
// What a launchd or Task Scheduler job really has: no AgentDeck variable of any kind.
const bareEnv = { PATH: process.env.PATH, HOME: os.homedir(), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };

function run(cli, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A stand-in for the app: every request file goes through the real gate and is answered the way the page would.
function app(t, { keepToken = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-automation-cli-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  const state = keepToken ? AutomationCore.load(dir) : null;
  const seen = [];
  const timer = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((name) => name.endsWith('.json'))) {
      const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
      fs.unlinkSync(path.join(dir, 'requests', file));
      seen.push(request);
      const gate = AutomationCore.screen(state, request);
      const response = gate.kind === 'reject' ? { done: true, error: gate.error }
        : gate.kind === 'local' ? { done: true, result: gate.result }
          : gate.kind === 'forward' ? { done: true, result: `ok ${gate.command.action} ${gate.command.automation.label}` }
            : { done: true, error: 'Control request rejected: terminal is not conductor-managed.' };
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify(response));
    }
  }, 20);
  t.after(() => { clearInterval(timer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, seen, env: { ...bareEnv, AGENTDECK_CONTROL_DIR: dir } };
}

test('receipt: sent with the automation token alone, even where a terminal token is also around', async (t) => {
  const a = app(t);
  const result = await run(path.join(root, 'board-cli.js'), ['automation', 'receipt', '--source', 'nightly-bughunt', '--message', '今晚没找到'],
    { ...a.env, AGENTDECK_CONTROL_TOKEN: 'captain-token', AGENTDECK_RECEIPT_TOKEN: 'worker-token', AGENTDECK_TERMINAL_ID: 'captain' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'ok automation-receipt 自动任务：nightly-bughunt\n');
  assert.equal(a.seen.length, 1);
  const request = a.seen[0];
  assert.equal(request.token, a.state.token);
  assert.equal(request.action, 'automation-receipt');
  assert.deepEqual(Object.keys(request).sort(), ['action', 'createdAt', 'id', 'message', 'source', 'token']);
});

test('task-add and inbox-report carry only their own fields', async (t) => {
  const a = app(t);
  const card = await run(path.join(root, 'board-cli.js'), ['automation', 'task-add', '--source', 'nightly-bughunt', '--project', 'agentdeck', '--title', '夜间挖虫：找到 1 个', '--detail', '报告在 /r.md'], a.env);
  assert.equal(card.code, 0, card.stderr);
  assert.equal(card.stdout, 'ok automation-task-add 自动任务：nightly-bughunt\n');
  const report = await run(path.join(root, 'board-cli.js'), ['automation', 'inbox-report', '--source', 'nightly-bughunt', '--title', '找到 1 个', '--files', '/a.md, /b.md', '--project', 'agentdeck'], a.env);
  assert.equal(report.code, 0, report.stderr);
  const [cardRequest, reportRequest] = a.seen;
  assert.deepEqual(Object.keys(cardRequest).sort(), ['action', 'createdAt', 'detail', 'id', 'project', 'source', 'title', 'token']);
  assert.deepEqual(reportRequest.files, ['/a.md', '/b.md']);
  assert.equal(reportRequest.action, 'automation-inbox-report');
});

test('status says whether the door is open', async (t) => {
  const a = app(t);
  const result = await run(path.join(root, 'board-cli.js'), ['automation', 'status'], a.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '自动回执入口可用。\n');
});

test('run from the tools copy with nothing in its environment, as a scheduled job does', async (t) => {
  const a = app(t);
  const tools = path.join(a.dir, 'tools');
  fs.mkdirSync(tools);
  for (const file of ['board-cli.js', 'board-credentials.js', 'security.js', 'worktree-core.js', 'receipt-listener-core.js', 'automation-core.js']) fs.copyFileSync(path.join(root, file), path.join(tools, file));
  fs.copyFileSync(path.join(root, 'board-cli.js'), path.join(tools, 'agentdeck-board.js'));
  const result = await run(path.join(tools, 'agentdeck-board.js'), ['automation', 'receipt', '--source', '夜间挖虫', '--message', 'hi'], bareEnv);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'ok automation-receipt 自动任务：夜间挖虫\n');
  assert.equal(a.seen[0].token, a.state.token, 'the control folder was found from where the copy lives');
});

test('an AgentDeck without the door (older, or never started) gives a clear failure and files nothing', async (t) => {
  const a = app(t, { keepToken: false });
  const result = await run(path.join(root, 'board-cli.js'), ['automation', 'status'], a.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /没有自动回执入口/);
  assert.deepEqual(fs.readdirSync(path.join(a.dir, 'requests')), []);
  assert.deepEqual(a.seen, []);
});

test('a stopped door fails at once; a reset token is picked up on the next run', async (t) => {
  const a = app(t);
  AutomationCore.setEnabled(a.state, false);
  const stopped = await run(path.join(root, 'board-cli.js'), ['automation', 'status'], a.env);
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /停用/);
  assert.deepEqual(a.seen, []);
  AutomationCore.setEnabled(a.state, true);
  const old = a.state.token;
  AutomationCore.reset(a.state);
  const after = await run(path.join(root, 'board-cli.js'), ['automation', 'receipt', '--source', 's', '--message', 'm'], a.env);
  assert.equal(after.code, 0, after.stderr);
  assert.notEqual(a.seen[0].token, old);
  assert.equal(a.seen[0].token, a.state.token);
});

test('the app\'s refusal (rate limit) comes back as a failure with its reason', async (t) => {
  const a = app(t);
  for (let i = 0; i < AutomationCore.LIMITS.perSourcePerMinute; i++) {
    assert.equal((await run(path.join(root, 'board-cli.js'), ['automation', 'receipt', '--source', 'hunt', '--message', 'm' + i], a.env)).code, 0);
  }
  const blocked = await run(path.join(root, 'board-cli.js'), ['automation', 'receipt', '--source', 'hunt', '--message', 'one too many'], a.env);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /发得太快/);
});

test('bad use is refused before anything is filed, and nothing but the three commands exists', async (t) => {
  const a = app(t);
  const cli = path.join(root, 'board-cli.js');
  const bad = [
    ['automation', 'receipt', '--message', 'm'],                                                         // no source
    ['automation', 'receipt', '--source', 'nightly bughunt!', '--message', 'm'],
    ['automation', 'receipt', '--source', 's'],                                                          // no message
    ['automation', 'receipt', '--source', 's', '--message', 'm', '--to', 'worker-1'],                    // dispatching is not a thing
    ['automation', 'receipt', '--source', 's', '--message', 'm', '--urgent'],
    ['automation', 'receipt', '--source', 's', '--message', '你'.repeat(AutomationCore.LIMITS.message + 1)],
    ['automation', 'receipt', '--source', 's', '--message'],                                             // flag with no value
    ['automation', 'receipt', 'loose', 'words'],
    ['automation', 'task-add', '--source', 's', '--title', 't'],                                         // no project
    ['automation', 'task-add', '--source', 's', '--project', 'p', '--title', 't', '--priority', 'high'],
    ['automation', 'task-add', '--source', 's', '--project', 'p', '--title', 't', '--depends', 'x'],
    ['automation', 'inbox-report', '--source', 's'],
    ['automation', 'inbox-report', '--source', 's', '--title', 't', '--urgent'],
    ['automation', 'inbox-report', '--source', 's', '--title', 't', '--card', 'c1'],
    ['automation', 'tell', '--source', 's', '--to', 'x', '--message', 'm'],
    ['automation', 'new', '--source', 's', '--title', 't', '--task', 'x'],
    ['automation', 'status', '--source', 's'],
  ];
  for (const args of bad) {
    const result = await run(cli, args, a.env);
    assert.equal(result.code, 1, args.join(' '));
    assert.notEqual(result.stderr, '', args.join(' '));
  }
  assert.deepEqual(a.seen, [], 'none of them reached the app');
});

test('without a reachable app a script gives up on its own and leaves no request behind', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-automation-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  AutomationCore.load(dir);
  const started = Date.now();
  const result = await run(path.join(root, 'board-cli.js'), ['automation', 'status'], { ...bareEnv, AGENTDECK_CONTROL_DIR: dir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /没有回应/);
  assert.ok(Date.now() - started < 15_000, 'it does not wait for the old 30 seconds');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'requests')), [], 'a late AgentDeck will not act on it');
});

test('help shows the three commands and the limits, in the CLI help and in automation help', async () => {
  const top = await run(path.join(root, 'board-cli.js'), ['help'], bareEnv);
  assert.equal(top.code, 0);
  assert.match(top.stdout, /automation receipt --source/);
  assert.match(top.stdout, /automation task-add --source/);
  assert.match(top.stdout, /automation inbox-report --source/);
  const help = await run(path.join(root, 'board-cli.js'), ['automation', 'help'], bareEnv);
  assert.equal(help.code, 0);
  for (const phrase of ['不能派活', '不能 tell', '每分钟', '权限 600', '自动任务', '旧版 AgentDeck']) assert.ok(help.stdout.includes(phrase), phrase);
  assert.equal((await run(path.join(root, 'board-cli.js'), ['automation'], bareEnv)).stdout, help.stdout, 'bare `automation` shows the same help');
});
