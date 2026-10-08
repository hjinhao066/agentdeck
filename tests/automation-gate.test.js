'use strict';

// The real processBoardRequests from main.js, with the 自动回执入口 switched on:
// what a request file with the automation token (or any other token) ends up as.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const AutomationCore = require('../automation-core');

function app(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-automation-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'requests'));
  const automation = AutomationCore.load(dir);
  const pendingBoardCommands = new Map(), responses = new Map(), delivered = [];
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const context = vm.createContext({
    fs, path, boardControlDir: dir, receiptListeners: null, pendingBoardCommands, AutomationCore, automation,
    boardRendererReady: true, receiptSessions: new Map([['worker', 'worker-token']]), managedSessions: new Map([['captain', 'captain-token']]),
    taskStore: { list: () => [] },
    validId: (id) => /^[a-z0-9-]+$/.test(id),
    writeBoardResponse: (id, response) => responses.set(id, response),
    send: (channel, command) => delivered.push({ channel, command }),
  });
  vm.runInContext(source.slice(source.indexOf('let processingBoardRequests = false;'), source.indexOf('function setupBoardControl()')), context);
  let n = 0;
  return {
    automation, pendingBoardCommands, responses, delivered,
    // Files one request the way board-cli.js does, then lets the app take its pass.
    send(request) {
      const id = request.id || 'req-' + ++n;
      fs.writeFileSync(path.join(dir, 'requests', id + '.json'), JSON.stringify({ createdAt: 1, ...request, id }));
      context.processBoardRequests();
      return id;
    },
  };
}
const asAutomation = (a, fields) => ({ token: a.automation.token, action: 'automation-receipt', source: 'nightly-bughunt', message: '今晚没找到', ...fields });

test('an automatic receipt reaches the page as a command with no calling session and a labelled source', (t) => {
  const a = app(t);
  const id = a.send(asAutomation(a));
  assert.equal(a.responses.has(id), false, 'the page answers it, not the gate');
  assert.equal(a.pendingBoardCommands.size, 1);
  const command = a.pendingBoardCommands.get(id).command;
  assert.equal(command.callerId, '');
  assert.equal(command.submitOnly, false);
  assert.deepEqual(command.automation, { source: 'nightly-bughunt', label: '自动任务：nightly-bughunt' });
  assert.equal('token' in command, false);
  assert.deepEqual(a.delivered.map((d) => d.channel), ['board:command']);
  assert.equal(a.delivered[0].command.automation.label, '自动任务：nightly-bughunt');
});

test('with the automation token every other action is refused on the spot and reaches nobody', (t) => {
  const a = app(t);
  for (const action of ['main-ledger', 'main-tell', 'main-new', 'main-task', 'main-inbox', 'main-notify-user', 'main-read', 'main-briefing', 'complete', 'ask', 'status', 'create-child', 'session-exit']) {
    const id = a.send({ token: a.automation.token, action, to: 'worker', message: 'run this' });
    assert.match(a.responses.get(id).error, /自动回执令牌只能用/, action);
  }
  assert.equal(a.pendingBoardCommands.size, 0);
  assert.deepEqual(a.delivered, []);
});

test('a request with extra fields, a wrong or stale token, or a stopped door is refused', (t) => {
  const a = app(t);
  assert.match(a.responses.get(a.send(asAutomation(a, { to: 'worker' }))).error, /不接受 to/);
  assert.match(a.responses.get(a.send(asAutomation(a, { token: 'nope' }))).error, /令牌无效/);
  const old = a.automation.token;
  AutomationCore.reset(a.automation);
  assert.match(a.responses.get(a.send(asAutomation(a, { token: old }))).error, /令牌无效/);
  AutomationCore.setEnabled(a.automation, false);
  assert.match(a.responses.get(a.send(asAutomation(a))).error, /停用/);
  assert.equal(a.pendingBoardCommands.size, 0);
  AutomationCore.setEnabled(a.automation, true);
  a.send(asAutomation(a));
  assert.equal(a.pendingBoardCommands.size, 1);
});

test('no terminal token can use an automation action', (t) => {
  const a = app(t);
  for (const token of ['captain-token', 'worker-token']) {
    const id = a.send({ token, action: 'automation-receipt', source: 'captain', message: '自称自动任务' });
    assert.match(a.responses.get(id).error, /自动回执令牌无效/, token);
  }
  assert.equal(a.pendingBoardCommands.size, 0);
});

test('a terminal cannot dress its own request as an automatic one', (t) => {
  const a = app(t);
  const forged = { source: 'x', label: '自动任务：x' };
  const captain = a.send({ token: 'captain-token', action: 'main-ledger', automation: forged });
  const worker = a.send({ token: 'worker-token', action: 'complete', result: 'done', automation: forged });
  for (const [id, caller] of [[captain, 'captain'], [worker, 'worker']]) {
    const command = a.pendingBoardCommands.get(id).command;
    assert.equal(command.callerId, caller);
    assert.equal('automation' in command, false, 'the marker is dropped, so the page treats it as the terminal it is');
  }
});

test('the rate limit and the queue cap hold in the real request loop', (t) => {
  const a = app(t);
  const ids = [];
  for (let i = 0; i < AutomationCore.LIMITS.perSourcePerMinute; i++) ids.push(a.send(asAutomation(a, { message: 'm' + i })));
  assert.equal(a.pendingBoardCommands.size, AutomationCore.LIMITS.perSourcePerMinute);
  const blocked = a.send(asAutomation(a, { message: 'one too many' }));
  assert.match(a.responses.get(blocked).error, /发得太快/);
  assert.equal(a.pendingBoardCommands.size, AutomationCore.LIMITS.perSourcePerMinute);
  // Status is free; a terminal's own traffic is untouched by the automation limit.
  assert.match(a.responses.get(a.send({ token: a.automation.token, action: 'automation-status' })).result, /可用/);
  a.send({ token: 'captain-token', action: 'main-ledger' });
  assert.equal(a.pendingBoardCommands.size, AutomationCore.LIMITS.perSourcePerMinute + 1);

  const b = app(t);
  for (let i = 0; i < AutomationCore.LIMITS.queued; i++) b.pendingBoardCommands.set('queued-' + i, { command: { automation: { source: 's' } }, delivered: true });
  assert.match(b.responses.get(b.send(asAutomation(b))).error, /太多自动消息/);
});

test('main.js wires the gate before any terminal token is looked at, and hands the CLI and core to the tools folder', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const loop = source.slice(source.indexOf('let processingBoardRequests = false;'), source.indexOf('function setupBoardControl()'));
  assert.ok(loop.indexOf('AutomationCore.screen(') > 0);
  assert.ok(loop.indexOf('AutomationCore.screen(') < loop.indexOf('receiptSessions.entries()'), 'the gate runs first');
  assert.ok(loop.indexOf('delete request.automation') < loop.indexOf('receiptSessions.entries()'), 'a caller-supplied marker never survives');
  assert.match(source, /'automation-core\.js'/, 'copied to the tools folder next to board-credentials.js');
  assert.match(source, /automation = AutomationCore\.load\(boardControlDir\)/);
  assert.match(source, /handleMain\('automation:settings'/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /automationSettings: \(input\) => ipcRenderer\.invoke\('automation:settings', input\)/);
  const settings = source.slice(source.indexOf("handleMain('automation:settings'"), source.indexOf("onMain('mobile-web:response'"));
  assert.doesNotMatch(settings, /return\s+automation\s*;/, 'the state with the token is never returned');
  assert.match(settings, /return AutomationCore\.publicStatus\(automation\)/);
});
