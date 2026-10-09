'use strict';
// board-cli.js refuses a flag the command does not take (it used to drop it silently:
// `new --model … --effort … --verify` ran a default model with no review).
// One legit invocation per flag of every command, plus an unknown flag per command.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const cli = path.join(__dirname, '..', 'board-cli.js');
const REJECTED = /不认识参数/;

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, AGENTDECK_RECEIPT_TOKEN: '', AGENTDECK_TERMINAL_ID: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A stand-in for the app: answers every board request at once and remembers what it was asked.
function fakeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-flags-cli-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  const requests = [];
  const timer = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((n) => n.endsWith('.json'))) {
      let request;
      try { request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8')); } catch (_) { continue; }
      fs.unlinkSync(path.join(dir, 'requests', file));
      requests.push(request);
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: 'ok', childId: 'c1', snapshot: {} }));
    }
  }, 15);
  return {
    env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token' },
    requests,
    close() { clearInterval(timer); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// command key -> the flags it takes (written out here on purpose: this is the contract).
const FLAGS = {
  'create-child': ['title', 'task', 'agent', 'command', 'cwd', 'relationship', 'timeout'],
  'spawn-child': ['title', 'task', 'agent', 'command', 'cwd', 'relationship', 'timeout'],
  wait: ['task', 'timeout'],
  send: ['task', 'message'],
  progress: ['message', 'install-id', 'target-version'],
  complete: ['result', 'files', 'failed'],
  ask: ['question'],
  'session-exit': ['code'],
  'notify-user': ['message', 'urgent', 'test'],
  'queue list': [],
  'queue cancel': ['task-id'],
  'task add': ['project', 'title', 'detail', 'id', 'depends', 'verify', 'priority'],
  'task list': ['project', 'status', 'priority'],
  'task move': ['id', 'status'],
  'task priority': ['id', 'level'],
  'task archive': ['done', 'project'],
  stop: ['id'],
  archive: ['id'],
  ledger: [],
  receipts: ['wait', 'timeout', 'snapshot', 'ack'],
  new: ['title', 'task', 'project', 'reviews', 'task-id', 'cwd', 'worktree', 'base', 'branch', 'priority', 'seat', 'agent', 'command', 'web-mode'],
  tell: ['to', 'message', 'replace', 'now'],
  answer: ['to', 'key'],
  peek: ['id', 'lines'],
  read: ['id', 'turns', 'find'],
  'settings battery': ['mode', 'cap', 'boost', 'for', 'until'],
  status: [],
  quota: [],
  briefing: [],
  handoff: [],
  'worktree clean': ['apply', 'path', 'root'],
  'discuss start': ['topic', 'topic-file', 'gemini', 'participants-file', 'summarizer', 'max-rounds'],
  'discuss status': ['id'],
  'discuss wait': ['id', 'timeout'],
  'discuss cancel': ['id'],
  'discuss resume': ['id', 'retry', 'accept-saved', 'metadata-file', 'job', 'result-file', 'model', 'tier', 'effort', 'confirmed-ended'],
  'discuss help': [],
};

// Each entry: [command key, argv that is valid on its own]. Together they use every flag above.
const TMP = os.tmpdir();
const LEGIT = [
  ['create-child', ['create-child', '--title', 't', '--task', 'x', '--agent', 'claude', '--command', 'claude --model m', '--cwd', TMP, '--relationship', 'r', '--timeout', '5']],
  ['spawn-child', ['spawn-child', '--title', 't', '--task', 'x', '--agent', 'claude', '--command', 'claude --model m', '--cwd', TMP, '--relationship', 'r', '--timeout', '5']],
  ['wait', ['wait', '--task', 'id1', '--timeout', '5']],
  ['send', ['send', '--task', 'id1', '--message', 'hi']],
  ['progress', ['progress', '--message', 'half way']],
  ['progress', ['progress', '--message', 'x', '--install-id', 'inst-1', '--target-version', '2.0.1']],
  ['complete', ['complete', '--result', 'done', '--files', '/a,/b', '--failed', 'why']],
  ['ask', ['ask', '--question', 'which?']],
  ['session-exit', ['session-exit', '--code', '0']],
  ['notify-user', ['notify-user', '--message', 'm', '--urgent']],
  ['notify-user', ['notify-user', '--test']],
  ['queue list', ['queue', 'list']],
  ['queue cancel', ['queue', 'cancel', '--task-id', 'card-1']],
  ['task add', ['task', 'add', '--project', 'p', '--title', 't', '--detail', 'd', '--id', 't-1', '--depends', 'a,b', '--verify', '--priority', 'high']],
  ['task list', ['task', 'list', '--project', 'p', '--status', 'todo', '--priority', 'high']],
  ['task move', ['task', 'move', '--id', 't-1', '--status', 'done']],
  ['task priority', ['task', 'priority', '--id', 't-1', '--level', 'high']],
  ['task archive', ['task', 'archive', '--done', '--project', 'p']],
  ['stop', ['stop', '--id', 's1']],
  ['archive', ['archive', '--id', 's1']],
  ['ledger', ['ledger']],
  ['receipts', ['receipts']],
  ['receipts', ['receipts', '--snapshot']],
  ['receipts', ['receipts', '--ack', '["r-1"]']],
  ['receipts', ['receipts', '--wait', '--timeout', '1']],
  ['new', ['new', '--title', 't', '--task', 'x', '--project', 'p', '--reviews', 'a,b', '--task-id', 'card-1', '--cwd', TMP, '--priority', 'high', '--seat', 'us2', '--agent', 'claude', '--command', 'claude --model claude-opus-5-5 --effort high']],
  ['new', ['new', '--title', 't', '--task', 'x', '--worktree', TMP, '--base', 'main', '--branch', 'feat/x', '--agent', 'codex']],
  ['new', ['new', '--title', 't', '--task', 'public question', '--agent', 'chatgpt-web', '--web-mode', 'deep-research']],
  ['tell', ['tell', '--to', 's1', '--message', 'm', '--replace', '--now']],
  ['answer', ['answer', '--to', 's1', '--key', 'y']],
  ['peek', ['peek', '--id', 's1', '--lines', '20']],
  ['read', ['read', '--id', 's1', '--turns', '2', '--find', 'word']],
  ['settings battery', ['settings', 'battery', '--boost', 'on', '--for', '2h', '--mode', 'auto', '--cap', '3']],
  ['settings battery', ['settings', 'battery', '--boost', 'on', '--until', '23:59']],
  ['status', ['status']],
  ['quota', ['quota']],
  ['briefing', ['briefing']],
  ['handoff', ['handoff']],
  ['worktree clean', ['worktree', 'clean', '--root', path.join(TMP, 'agentdeck-flags-none'), '--path', path.join(TMP, 'agentdeck-flags-none', 'x'), '--apply']],
  ['discuss start', ['discuss', 'start', '--topic', 'a', '--topic-file', '/nope', '--gemini', '--participants-file', '/nope', '--summarizer', 's', '--max-rounds', '2']],
  ['discuss status', ['discuss', 'status', '--id', 'd-nope']],
  ['discuss wait', ['discuss', 'wait', '--id', 'd-nope', '--timeout', '1']],
  ['discuss cancel', ['discuss', 'cancel', '--id', 'd-nope']],
  ['discuss resume', ['discuss', 'resume', '--id', 'd-nope', '--retry', 'j', '--accept-saved', '--metadata-file', '/nope', '--job', 'j', '--result-file', '/nope', '--model', 'm', '--tier', 't', '--effort', 'e', '--confirmed-ended', 'j']],
  ['discuss help', ['discuss', 'help']],
];

test('the test table covers every flag of every command', () => {
  const used = {};
  for (const [key, argv] of LEGIT) {
    used[key] = used[key] || new Set();
    for (const a of argv) if (a.startsWith('--')) used[key].add(a.slice(2));
  }
  for (const [key, flags] of Object.entries(FLAGS)) {
    assert.deepEqual([...(used[key] || [])].sort(), [...flags].sort(), key);
  }
});

for (const [key, argv] of LEGIT) {
  test(`legit flags are accepted: ${argv.join(' ').slice(0, 90)}`, async () => {
    const app = fakeApp();
    try {
      const result = await runCli(argv, app.env);
      assert.doesNotMatch(result.stderr, REJECTED, result.stderr);
      // Everything that does not go on to read files or wait on a long job must also succeed.
      // (receipts --wait needs a real agent process above it to own the listener.)
      if (!key.startsWith('discuss') && key !== 'worktree clean' && key !== 'new' && !argv.includes('--wait')) assert.equal(result.code, 0, result.stderr);
    } finally { app.close(); }
  });
}

for (const [key, flags] of Object.entries(FLAGS)) {
  test(`unknown flag is refused with the supported list: ${key}`, async () => {
    const entry = LEGIT.find(([k]) => k === key);
    // Valid arguments first, then the stray flag: the command is otherwise runnable.
    const argv = [...entry[1], '--bogus-flag', 'x'];
    const app = fakeApp();
    try {
      const result = await runCli(argv, app.env);
      assert.notEqual(result.code, 0, 'exit code must be non-zero');
      assert.match(result.stderr, /不认识参数 --bogus-flag/);
      for (const flag of flags) assert.ok(result.stderr.includes(`--${flag}`), `lists --${flag}: ${result.stderr}`);
      assert.equal(app.requests.length, 0, 'nothing may be sent to the app');
    } finally { app.close(); }
  });
}

test('an unknown flag is refused even before the terminal is checked', async () => {
  const result = await runCli(['new', '--title', 't', '--task', 'x', '--model', 'claude-opus-5-5'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /不认识参数 --model/);
});

test('the incident command: new --model --effort --verify is refused and nothing is dispatched', async () => {
  const app = fakeApp();
  try {
    for (const bad of ['model', 'effort', 'verify']) {
      const result = await runCli(['new', '--title', 't', '--task', 'x', '--agent', 'claude', `--${bad}`, 'v'], app.env);
      assert.notEqual(result.code, 0, bad);
      assert.match(result.stderr, new RegExp(`不认识参数 --${bad}`));
      assert.match(result.stderr, /模型和档位写在 --command 里，例如 --command "claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high"/);
      assert.match(result.stderr, /要验收先 task add --verify 再 new --task-id/);
    }
    assert.equal(app.requests.length, 0);
  } finally { app.close(); }
});

test('task move --priority still points at task priority', async () => {
  const result = await runCli(['task', 'move', '--id', 't-1', '--status', 'doing', '--priority', 'high'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /不认识参数 --priority/);
  assert.match(result.stderr, /Change a card with task priority --id <id> --level high\|normal/);
});

test('only new gets the model hint', async () => {
  const result = await runCli(['tell', '--to', 's1', '--message', 'm', '--model', 'x'], { AGENTDECK_CONTROL_DIR: '', AGENTDECK_CONTROL_TOKEN: '' });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr, /模型和档位写在 --command 里/);
});

test('new --agent claude without --command warns that the default model is used', async () => {
  const app = fakeApp();
  try {
    const warn = '未指定模型，将用本机默认模型';
    const bare = await runCli(['new', '--title', 't', '--task', 'x', '--agent', 'claude'], app.env);
    assert.equal(bare.code, 0, bare.stderr);
    assert.equal(bare.stderr.split(warn).length - 1, 1, 'one warning line');
    assert.equal(bare.stderr.trim().split('\n').filter((l) => l.includes(warn)).length, 1);
    assert.doesNotMatch(bare.stdout, /未指定模型/);
    const withCommand = await runCli(['new', '--title', 't', '--task', 'x', '--agent', 'claude', '--command', 'claude --model claude-opus-5-5'], app.env);
    assert.equal(withCommand.code, 0, withCommand.stderr);
    assert.doesNotMatch(withCommand.stderr, /未指定模型/);
    const codex = await runCli(['new', '--title', 't', '--task', 'x', '--agent', 'codex'], app.env);
    assert.equal(codex.code, 0, codex.stderr);
    assert.doesNotMatch(codex.stderr, /未指定模型/);
    assert.equal(app.requests.length, 3, 'the warning does not stop the dispatch');
  } finally { app.close(); }
});

test('inbox and automation keep refusing unknown flags', async () => {
  const app = fakeApp();
  try {
    const inbox = await runCli(['inbox', 'list', '--bogus-flag'], app.env);
    assert.notEqual(inbox.code, 0);
    assert.match(inbox.stderr, /--bogus-flag/);
    const automation = await runCli(['automation', 'status', '--bogus-flag'], app.env);
    assert.notEqual(automation.code, 0);
    assert.match(automation.stderr, /--bogus-flag/);
  } finally { app.close(); }
});
