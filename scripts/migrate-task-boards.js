'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { TaskStore, newCard } = require('../task-board');

// These are the three explicitly authorized legacy boards, not a recursive
// Markdown import. Completed historical updates are deliberately excluded.
function initialCards(project, markdown) {
  const cards = [];
  const add = (title, pattern, status = 'todo', session = null, agent = '', model = '', important = false) => {
    const match = markdown.match(pattern);
    if (!match) return;
    const id = 'legacy-' + crypto.createHash('sha256').update(project + ':' + title).digest('hex').slice(0, 20);
    const card = newCard({ id, project, title, detail: match[0], verify: important, important });
    card.order = cards.length; card.status = status; card.session_id = session;
    card.assignee = agent ? { agent, model } : null;
    card.migration_source = project + '.md';
    // The migration records existing work; it must not start it a second time.
    if (status === 'doing') card.dispatch_claim = { key: 'migration-' + id, owner: 'legacy', delivered: true, created: card.created };
    cards.push(card);
  };
  if (project === 'agentdeck') {
    add('任务看板数据、命令及流转层', /^.*同一会话.*任务看板数据\+流转层.*$/m, 'doing', 'c1791071297267380', 'codex', 'gpt-6.1-sol', true);
    add('任务看板界面', /^.*任务看板.*以看为主.*$/m, 'todo', null, '', '', true);
    add('架构图重排版', /^.*架构图.*派 Claude Opus 重做排版.*$/m, 'doing', null, 'claude', 'claude-opus-5-5', true);
    add('两个 Claude 账号一键轮值', /^- 谁在做：Codex.*feat\/claude-seats.*$/m, 'doing', null, 'codex', 'gpt-6.1-sol', true);
    add('Windows AgentDeck 同步升级', /^- 拟拆任务：.*$/m);
    add('任意 agent 当队长及额度轮换', /^- 手机上换队长模型：.*$/m, 'todo', null, '', '', true);
    add('手机网页端', /^- 已定方案：.*$/m, 'todo', null, '', '', true);
    add('VPS 反代及手机登录保护', /^- 已定方案：.*$/m, 'todo', null, '', '', true);
    add('两机在线状态及共享数据', /^- 手机上可选控制哪台电脑：.*$/m);
    const data = cards.find((c) => c.title === '任务看板数据、命令及流转层');
    const ui = cards.find((c) => c.title === '任务看板界面');
    if (data && ui) ui.depends_on = [data.id];
  } else if (project === 'hermes-savings-v2') {
    add('主邮箱 Gmail 重连后核对扣款日', /^1\. .*$/m, 'needs_user');
    add('验证明早每日产出自动上站', /待验证：[^\n]*?真实证明。/m);
    add('每日页重复内容改链接', /待办（未派）：[^\n]*/m);
    add('补充卡诗洗发水系列及规格', /^4\. .*$/m, 'needs_user');
  } else if (project === 'type4me-windows') {
    add('Windows 设置界面落地及输入统计验收', /^\| 设置界面落地 \+ 输入统计.*$/m, 'doing', null, 'codex', 'gpt-6.1-sol', true);
    add('Windows 设置分页性能修复', /用户说 Windows 新设置界面 UI 好了很多[^\n]*?150ms 内）/m, 'doing', null, 'codex', 'gpt-6.1-sol');
    add('Mac 历史页增加近七日、近三十日字数统计', /已派 Codex（会话「Type4Me Mac[^\n]*/m, 'doing', null, 'codex', 'gpt-6.1-sol');
  } else throw new Error('Unsupported migration source.');
  return cards;
}
function migrate(boardsDir = path.join(os.homedir(), '.agents', 'boards'), target = new TaskStore(path.join(boardsDir, 'tasks'))) {
  return ['agentdeck', 'hermes-savings-v2', 'type4me-windows'].map((project) => {
    const file = path.join(boardsDir, project + '.md');
    return { project, ...target.import(project, initialCards(project, fs.readFileSync(file, 'utf8'))) };
  });
}
if (require.main === module) process.stdout.write(JSON.stringify(migrate(), null, 2) + '\n');
module.exports = { initialCards, migrate };
