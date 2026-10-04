'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const B = require('../board-core');
const S = require('../claude-seats-core');

function session({ tasks = [], pending = [] } = {}) {
  const col = { id: 'captain', isMain: true, cmd: '' };
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - 5000, lastScreen: '' };
  const elements = new Map();
  const window = { MainCore: require('../main-core'), BoardCore: B,
    ChatUI: { hasDraft: () => false, turnsOf: () => [] } };
  const context = vm.createContext({ window, document: {
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id); },
    querySelectorAll: () => [],
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({ config: { mainSession: { colId: col.id, tasks, pending } },
    columns: () => [col], terms: new Map([[col.id, entry]]), userComposing: () => false });
  return { api: window.MainSession, entry };
}
const task = (id, title, status, failed) => ({ id, colId: 'worker-' + id, title, status, receipt: failed ? { failed } : undefined });

test('normal handoff uses high; a pending failure uses xhigh', () => {
  assert.equal(session().api.relayEffort(), 'high');
  const failed = session({ pending: [{ taskId: 'retry', failed: 'Build failed' }] });
  assert.equal(failed.api.relayEffort(), 'xhigh');
  assert.match(S.relayCodexCommand('codex --model old --effort low', failed.api.relayEffort()), /model_reasoning_effort=xhigh/);
});

test('retrying the same task title uses xhigh without promoting an unrelated or completed failure', () => {
  const previous = task('old', 'Fix build', 'failed', 'Compilation failed');
  assert.equal(session({ tasks: [previous, task('retry', 'Fix build', 'working')] }).api.relayEffort(), 'xhigh');
  assert.equal(session({ tasks: [previous, task('other', 'Review docs', 'working')] }).api.relayEffort(), 'high');
  assert.equal(session({ tasks: [previous] }).api.relayEffort(), 'high');
});

test('relay waits for a live idle Captain and a quiet screen', () => {
  const { api, entry } = session();
  assert.equal(api.relayIdle(), true);
  entry.alive = false; assert.equal(api.relayIdle(), false);
  entry.alive = true; entry.state = 'working'; assert.equal(api.relayIdle(), false);
  entry.state = 'done'; entry.lastOutputAt = Date.now(); assert.equal(api.relayIdle(), false);
});

test('quoted and absolute Codex Relay commands keep their binary and use fixed Sol/high or xhigh', () => {
  for (const effort of ['high', 'xhigh']) {
    for (const program of ['codex', 'command codex', '"codex"', 'command "codex"',
      '/opt/bin/codex', '"C:\\Program Files\\codex.exe"']) {
      const launch = S.relayCodexCommand(program + ' --model gpt-6-luna --no-daemon -c model_reasoning_effort=low', effort);
      assert.ok(launch.startsWith(program + ' '), launch);
      assert.match(launch, /--model gpt-6\.1-sol/);
      assert.equal(launch.match(/--no-daemon/g).length, 1);
      assert.ok(launch.includes('model_reasoning_effort=' + effort));
      assert.ok(!launch.includes('gpt-6-luna'));
    }
  }
  const custom = 'node "fake-agent.js" --provider=codex';
  assert.equal(S.relayCodexCommand(custom, 'xhigh'), custom);
});

test('Codex Relay bypasses a real shell function for bare, quoted and absolute binaries', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-relay-codex-'));
  try {
    const binary = path.join(dir, 'codex');
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH };
    const wrapper = 'codex() { command codex --yolo "$@"; }\n';
    for (const program of ['codex', 'command codex', '"codex"', "'codex'", 'command "codex"', '"' + binary + '"']) {
      for (const effort of ['high', 'xhigh']) {
        const command = B.shellLaunchCommand(S.relayCodexCommand(program + ' --model old', effort), process.platform);
        const args = execFileSync('/bin/sh', ['-c', wrapper + command], { env, encoding: 'utf8' }).trim().split('\n');
        assert.deepEqual(args, ['--model', 'gpt-6.1-sol', '--no-daemon', '-c', 'model_reasoning_effort=' + effort,
          '--dangerously-bypass-approvals-and-sandbox'], command);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
