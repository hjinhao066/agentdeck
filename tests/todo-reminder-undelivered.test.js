'use strict';
// 挖虫④ #13：待办 AI「没办成」的手机提醒发不出去时，main.js 靠一句正则从提醒结果文字里认出
// 「没送到」，再给队长补一条脱敏的「Todo 后台异常（phone-reminder）」回执（docs/todo.md：
// 「网络失败/未配置密钥会给队长脱敏异常回执」）。这句正则写于 70dffc9，认的是旧文案
// 「Bark 已跳过」；两小时后 efcdf85 改了 Bark 队列的文案，「已跳过」从此不再出现。
// 结果：这台电脑没配手机提醒密钥（Windows 默认就没有）时，手机没响，队长也收不到异常回执。
process.env.TZ = 'America/Los_Angeles';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBarkDelivery } = require('../bark-delivery');
const { createNotifyUser } = require('../notify-user');

// The exact check main.js runs on the reminder result (board:response, main-notify-user, todoNotifyResolve).
function mainCheck() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const line = source.split('\n').find((l) => l.includes("Bark reminder not delivered"));
  const literal = /if \((\/.+\/)\.test\(result\)\)/.exec(line);
  assert.ok(literal, 'main.js still checks the reminder result with a regex');
  const [, body] = /^\/(.+)\/$/.exec(literal[1]);
  return new RegExp(body);
}

test('a Todo failure reminder that no phone key could send is recognised as not delivered', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh4-todo-bark-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let saved = {};
  const delivery = createBarkDelivery({ state: saved, saveState: (value) => { saved = structuredClone(value); },
    now: () => new Date(2026, 9, 7, 12).getTime(), getSettings: () => ({}), getClasses: () => [] });
  const notifications = { show() {} };
  // Blank Bark setting and no ~/.secrets/bark-key.txt: the Windows default.
  const notifyUser = createNotifyUser({ getConfig: () => ({ columns: [{ id: 'captain', isMain: true }] }), notifications, delivery, keyHome: home,
    fetchImpl: () => assert.fail('no key, nothing may be sent') });
  // What TodoFailureNotifications hands to main-notify-user.
  const result = await notifyUser({ id: 'todo-failures-' + 'a'.repeat(64), callerId: 'captain', nativeWeb: true,
    message: 'Todo AI 有 1 条任务没办成或出错，请在 AgentDeck 查看详情。', urgent: true, level: 'timeSensitive' }, false);
  assert.match(result, /没有配置手机提醒密钥/, 'the phone reminder was not sent');
  assert.match(result, mainCheck(), 'main.js must see this as「没送到」and file the phone-reminder receipt');
});
