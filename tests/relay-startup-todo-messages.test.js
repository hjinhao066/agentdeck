'use strict';
// 挖虫④ #5：Relay 换上新队长后，程序要在 3 分钟内看到「新队长自己干了活」（回复或自己发的命令），
// 否则判定启动失败、换席位重试。待办 @ai 后台替队长投递的「Todo 新任务」「Todo 后台异常」
// 和待办失败提醒，都是程序自己以队长名义发的，却被算成了新队长的输出，
// 一个卡死的新队长因此被判成「健康」，不再重试。
// 同类先例：6ffc5be 已把回执监听心跳和安装结果排除在外。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const R = require('../relay-startup-core');

function session(relayStartup) {
  const col = { id: 'captain', isMain: true, cmd: 'claude' };
  const config = { todoInbox: {}, todoDeliveries: {}, mainSession: { colId: col.id, cmd: col.cmd, tasks: [], pending: [], relayStartup } };
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - 5000, lastScreen: '' };
  const elements = new Map();
  const window = { deck: { saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {} }, MainCore: require('../main-core'), BoardCore: B,
    ChatUI: { hasDraft: () => false, turnsOf: () => [] } };
  const context = vm.createContext({ window, document: {
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id); },
    querySelectorAll: () => [],
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({ config, platform: 'darwin', columns: () => [col], terms: new Map([[col.id, entry]]),
    userComposing: () => false, sendWhenReady() {}, saveConfig() {}, flushConfig() {},
    captainColumnVisible: () => false });
  return { api: window.MainSession, col };
}

test('Todo deliveries made by the program never prove that a relayed Captain started work', async () => {
  const at = Date.now() - 60_000;
  const { api, col } = session(R.begin({}, { colId: 'captain', targetId: 'seat-b', at }));
  const key = 'todo-' + 'a'.repeat(64);
  // main.js builds these itself (deliverTodo / TodoBackendErrors / TodoFailureNotifications), callerId = the Captain.
  await api.handle({ id: 'todo-delivery-' + 'a'.repeat(64), action: 'main-todo-delivery', nativeWeb: true, callerId: col.id,
    todoId: 'td-11111111-aaaa', taskId: key, result: '来自 Todo 随手记的新任务……' }, col);
  assert.equal(api.state().pending.length, 1, 'the notice itself is queued for the Captain');
  assert.equal(api.state().relayStartup.attempt.output, false, 'main-todo-delivery is not the new Captain\'s output');
  await api.handle({ id: 'todo-error-' + 'b'.repeat(64), action: 'main-todo-error', nativeWeb: true, callerId: col.id,
    result: 'Todo 后台异常（scan，ERROR）' }, col);
  assert.equal(api.state().relayStartup.attempt.output, false, 'main-todo-error is not the new Captain\'s output');
  // So the watchdog still sees a silent Captain at the deadline and retries another seat.
  const verdict = R.check(api.state().relayStartup, { colId: col.id, promptSent: true, now: at + R.STARTUP_MS });
  assert.equal(verdict.action, 'retry');
  assert.equal(verdict.state.reason, 'no-output');
});

test('the Todo failure reminder (program-made notify-user) is not Captain output either', async () => {
  const at = Date.now() - 60_000;
  const { api, col } = session(R.begin({}, { colId: 'captain', targetId: 'seat-b', at }));
  await api.handle({ id: 'todo-failures-' + 'c'.repeat(64), action: 'main-notify-user', nativeWeb: true, callerId: col.id,
    message: 'Todo AI 有 1 条任务没办成或出错，请在 AgentDeck 查看详情。', urgent: true, level: 'timeSensitive' }, col);
  assert.equal(api.state().relayStartup.attempt.output, false);
});
