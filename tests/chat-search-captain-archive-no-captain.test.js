// 挖虫④ #20（挖虫③ #6 修复的回归）：侧栏搜索现在也搜清空前的队长对话，结果标「只读」。
// 但这些对话只能在队长那一列里显示；队长关掉了（或还没建）的时候，点这条结果什么都不发生：
// revealRetired 找不到队长列就静默返回，没有任何提示。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fixtures/chat-ui-page');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now() - 7 * 86400_000;
const turn = (id, user, reply, at) => ({ id, ts: at, end: at + 5000, user, reply, done: true, atts: [] });

test('没有队长时，点清空前队长对话的搜索结果：要么打开它，要么告诉用户为什么打不开', async () => {
  const h = load({
    cols: [{ id: 'w1', cmd: 'claude', title: '普通会话' }],
    saved: [
      { id: 'w1', turns: [turn('w', '随便问问', '好。', Date.now() - 60_000)] },
      { id: 'captain-mold1', captainArchive: true, turns: [turn('o1', '把部署密钥轮换的事记一下，下周做', '记下了。', t0)] },
    ],
  });
  const toasts = [];
  h.host.showToast = (text) => toasts.push(String(text));
  const ready = h.init();
  h.mount(h.columns[0]);
  await ready;
  const input = h.doc.getElementById('navSearch');
  input.value = '密钥轮换';
  input.dispatch('input');
  await wait(200);
  const items = h.doc.getElementById('navResults').querySelectorAll('.nr-item');
  const hit = items.find ? items.find((i) => i.textContent.includes('只读')) : [...items].find((i) => i.textContent.includes('只读'));
  if (!hit) { h.stop(); return; }   // 没列出来也算对：打不开就不该列
  hit.dispatch('click');
  await wait(50);
  const retired = h.doc.root.querySelectorAll('.retired-chat');
  const shown = retired.some((n) => n.textContent.includes('把部署密钥轮换的事记一下'));
  assert.ok(shown || toasts.length > 0, '点了没有任何反应：既没打开，也没提示');
  h.stop();
});
