'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ChatCore = require('../chat-core');
const BoardCore = require('../board-core');
const M = require('../main-core');
const Q = require('../quota-core');
const { rulebook, topic } = require('./fixtures/captain-rulebook');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const PLATFORMS = ['darwin', 'win32'];
const DEEPSEEK = '/Users/jinhao/.local/claude-deepseek/bin/claude-ds --dangerously-skip-permissions';
// what main-session passes with each briefing send
const BRIEFING = { silent: true, guardUserInput: true, inlineLimit: M.BRIEFING_LIMIT };

// ChatUI.sendPrompt and sendLong, cut out of chat-ui.js and run against a stand-in terminal.
const chatUi = read('chat-ui.js');
const sendSource = chatUi.slice(chatUi.indexOf('  const PASTE_READ_MAX = 30_000;'), chatUi.indexOf('  // A line submitted straight in the terminal'));

function terminal(cmd = 'claude') {
  const typed = [], saved = [];
  const entry = { alive: true, state: 'done', term: { modes: { bracketedPasteMode: true } }, lastOutputAt: 0 };
  const host = {
    terms: new Map([['col', entry]]), dumpScreen: () => '❯ \n────────\n  ⏵⏵ auto mode on',
    shellQuote: (p) => p, manualPromptSent() {}, userComposing: () => false, maybeAutoName() {}, showToast() {},
  };
  const context = vm.createContext({
    C: ChatCore, host, Date, setTimeout, Promise,
    window: {
      deck: { ptyInput: (id, data) => typed.push(data), notifyCancel() {}, saveLongPrompt: async (text) => { saved.push(text); return '/tmp/long-prompts/prompt.txt'; } },
      MainSession: null, MainCore: M, BoardCore,
    },
    beginTurn: () => ({ id: 't' }),
  });
  vm.runInContext(sendSource, context);
  return { entry, typed, saved, send: (text, opts) => context.sendPrompt({ id: 'col', cmd }, text, null, opts || { silent: true }) };
}
// A briefing that has grown to `length` characters; the closing paragraph and
// the token saver's resume line are still the last thing in it.
function grown(platform, length) {
  const brief = M.instructions(platform), closing = M.AUTONOMOUS_CONTINUATION + M.SAVER_RESUME;
  const rules = brief.slice(0, brief.length - M.AUTONOMOUS_CONTINUATION.length);
  return rules + '规'.repeat(length - rules.length - closing.length) + closing;
}

test('the Captain core prompt stays within 2500 characters; a briefing send may be 10000, every other prompt keeps the 8000 cut', () => {
  assert.equal(M.LONG_PROMPT, 8000);
  assert.equal(M.BRIEFING_LIMIT, 10000);
  assert.equal(M.CORE_LIMIT, 2500);
  for (const platform of PLATFORMS) for (const legacy of [false, true]) for (const cap of [5, 30, 50]) {
    const brief = M.instructions(platform, '', legacy, cap);
    assert.ok(brief.endsWith(M.AUTONOMOUS_CONTINUATION), platform);
    assert.ok((brief + M.SAVER_RESUME).length <= M.CORE_LIMIT,
      `${platform}${legacy ? ' legacy' : ''}：队长核心提示词 ${brief.length} 字，超出 ${M.CORE_LIMIT}。把不是每一轮都要守的规则挪进 docs/captain/ 的规范文件并在触发清单里加一行，不要删规则凑字数`);
  }
});

test('no briefing line passes the line-reading limit, so a terminal that takes plain keys still gets it whole', async () => {
  for (const platform of PLATFORMS) for (const legacy of [false, true]) for (const cap of [5, 30, 50]) {
    const longest = ChatCore.longestLineBytes(M.instructions(platform, '', legacy, cap));
    assert.ok(longest <= ChatCore.LINE_MODE_BYTES,
      `${platform}${legacy ? ' legacy' : ''}：队长提示词有一行 ${longest} 字节，超过行模式上限 ${ChatCore.LINE_MODE_BYTES}，会变成文件指针。把长规则拆成几行，不要删内容`);
    // and a terminal without bracketed paste is typed it whole, then one Enter
    const text = M.instructions(platform, '', legacy, cap) + M.SAVER_RESUME, t = terminal();
    t.entry.term.modes.bracketedPasteMode = false;
    assert.ok(await t.send(text, BRIEFING), platform);
    assert.deepEqual(t.saved, [], platform + ': nothing goes to a file');
    assert.deepEqual(t.typed, [text.replace(/\r?\n/g, '\r'), '\r'], platform);
  }
});

test('the token saver resend reaches the Captain whole on Mac and Windows, closing and 读看板继续 included', async () => {
  await Promise.all(PLATFORMS.flatMap((platform) => [false, true].map(async (legacy) => {
    const text = M.instructions(platform, '', legacy) + M.SAVER_RESUME, t = terminal();
    assert.ok(text.length <= M.CORE_LIMIT, 'the core is all that is pasted again');
    assert.ok(await t.send(text, BRIEFING), platform);
    assert.deepEqual(t.saved, [], platform + ': nothing goes to a file');
    assert.deepEqual(t.typed, ['\x1b[200~' + text + '\x1b[201~', '\r'], platform + ': one paste, one Enter');
    assert.ok(t.typed[0].endsWith(M.AUTONOMOUS_CONTINUATION + '\n\n读看板继续。\x1b[201~'), platform);
  })));
});

test('a briefing of exactly 10000 characters is still pasted whole; one more character becomes a file pointer', async () => {
  await Promise.all(PLATFORMS.map(async (platform) => {
    const full = grown(platform, M.BRIEFING_LIMIT), t = terminal();
    assert.equal(full.length, 10000);
    assert.ok(await t.send(full, BRIEFING), platform);
    assert.deepEqual(t.saved, [], platform);
    assert.deepEqual(t.typed, ['\x1b[200~' + full + '\x1b[201~', '\r'], platform);
    assert.ok(t.typed[0].endsWith('读看板继续。\x1b[201~'), platform);

    const over = grown(platform, M.BRIEFING_LIMIT + 1), o = terminal();
    assert.ok(await o.send(over, BRIEFING), platform);
    assert.deepEqual(o.saved, [over], platform + ': the whole text is in the file');
    assert.equal(o.typed.length, 2, platform);
    assert.match(o.typed[0], /（这条消息共 10001 字，完整内容已存成文件，请先完整读取再照做：\/tmp\/long-prompts\/prompt\.txt）/, platform);
    assert.ok(!o.typed[0].includes('读看板继续'), platform + ': past the limit the closing is only in the file');
  }));
});

// Raising the briefing's limit must not change what any agent gets as ordinary work.
test('an ordinary prompt is cut at 8000 for every agent, exactly as before', async () => {
  const commands = ['claude --model claude-opus-5-5', 'codex', 'cursor-agent --force --model grok-4.7-high-fast', 'agy --model gemini-3.8-flash-high', 'grok', DEEPSEEK];
  await Promise.all(commands.map(async (cmd) => {
    const inside = '活'.repeat(M.LONG_PROMPT), t = terminal(cmd);
    assert.ok(await t.send(inside), cmd);
    assert.deepEqual(t.saved, [], cmd + ': 8000 characters are pasted');
    assert.equal(t.typed[0], '\x1b[200~' + inside + '\x1b[201~', cmd);

    for (const length of [M.LONG_PROMPT + 1, 9618, M.BRIEFING_LIMIT]) {
      const long = '活'.repeat(length), o = terminal(cmd);
      assert.ok(await o.send(long), cmd);
      assert.deepEqual(o.saved, [long], `${cmd}: ${length} characters go to a file`);
      assert.match(o.typed[0], new RegExp(`（这条消息共 ${length} 字，完整内容已存成文件`), cmd);
    }
  }));
});

test('only the three briefing sends carry the larger limit; the queue keeps the ordinary one', () => {
  assert.match(chatUi, /prompt\.length > \(o\.inlineLimit \|\| window\.MainCore\.LONG_PROMPT\)\) return sendLong\(/);
  assert.doesNotMatch(chatUi, /LONG_PROMPT = /);
  const session = read('main-session.js');
  // the first briefing, the rebrief after a context reset, and the token saver's steps
  assert.equal(session.split('inlineLimit: M.BRIEFING_LIMIT').length - 1, 3);
  assert.match(session, /host\.sendWhenReady\(col, text, \{\n\s+silent: true, onSent: sent, guardUserInput: true, inlineLimit: M\.BRIEFING_LIMIT,/);
  assert.match(session, /host\.sendWhenReady\(op\.col, briefingText\(\), \{\n\s+silent: true, guardUserInput: true, requireIdle: true, inlineLimit: M\.BRIEFING_LIMIT,/);
  assert.ok(session.includes("saverSend(op, briefingText() + M.SAVER_RESUME, 'briefing', true"));
  for (const file of ['main-session.js', 'renderer.js', 'chat-ui.js', 'task-board-ui.js', 'schedule-core.js']) {
    assert.doesNotMatch(read(file).replace(/inlineLimit: M\.BRIEFING_LIMIT/g, ''), /inlineLimit\s*:/, file + ' gives no other prompt a larger limit');
  }
  assert.match(session, /body\.length > M\.LONG_PROMPT && metadata\.executor !== 'chatgpt-web'/);
  assert.doesNotMatch(session, /body\.length > \d/);
});

test('the briefing explains the DeepSeek fallback: when, how, what for, and that it costs money on the Mac only', () => {
  for (const platform of PLATFORMS) {
    assert.match(M.instructions(platform), /models：[^\n]*用 DeepSeek 兜底/, platform + ': the core says when to read it');
    const text = topic('models');
    const agents = text.slice(text.indexOf('可用 agent：'), text.indexOf('模型分工（用户点名优先）：'));
    const routing = text.slice(text.indexOf('模型分工（用户点名优先）：'), text.indexOf('用多大的档位（effort）：'));
    assert.ok(agents.includes(`DeepSeek 兜底（仅 Mac，按量扣费，用户已同意启用）：new --command "${DEEPSEEK}"，必须写绝对路径`), platform);
    assert.match(agents, /复杂一点的活在命令里加 --model opus。参数以共享记忆 ~\/\.agents\/memory\/deepseek-fallback-enabled\.md 为准/);
    assert.match(agents, /它不是 Claude 席位，不套用上面 Claude 小弟的 --model claude-…／--effort 写法/);
    assert.match(routing, /- DeepSeek 兜底：Claude 各席位、Codex、Cursor、Gemini 都用尽或低于阈值而活不能停时才用，还有订阅额度就不用。/);
    assert.match(routing, /只派简单到中等的代码、测试、整理；UI 设计、最关键代码、最终审核不派，等订阅额度恢复。/);
    assert.match(routing, /标题和回执写明「DeepSeek 兜底」，派出的活必须带独立审查。/);
  }
});

// These four went missing once, when a rewrite made room under the old limit.
test('qualifiers a shorter briefing once dropped are still there', () => {
  for (const platform of PLATFORMS) {
    const text = rulebook(platform);
    assert.match(text, /Claude Code 额度受限时，可改用 Cursor 里的同名模型（claude-opus-5-5-high、claude-sonnet-5-5-high）。/, platform);
    assert.match(text, /agy 第三方模型的剩余额度目前无法读取，遇到限流就换另一个已实测模型。/, platform);
    assert.match(text, /只对 Gemini Flash 写档位后缀：[^\n]*；其余模型必须使用上面列出的完整 ID。/, platform);
    assert.match(text, /quota {3}只读各家订阅额度；派活前可跑 quota，避开已用尽或快用尽的；未知不代表可用/, platform);
    assert.match(text, /额度轮换：quota 只读被动观测，未知不代表可用，不要因此换模型。/, platform);
    assert.match(text, /Opus 留给 UI、最关键的代码和终审；重要代码用 Sonnet。/, platform);
    // Rule 1 is the core's first red line; rules 2–17 keep their numbers in the rule files.
    assert.match(M.instructions(platform), /^- 不要在这一列里改文件、跑任务或写实现过程，实际工作和返工都交给别的会话。你自己只做：读写进度看板和有效决定文件，以及 capacity 规范里的只读 sysctl。例外：各家都没额度而你还有额度时可以亲自动手，活不能停。$/m, platform);
    for (let n = 2; n <= 17; n++) assert.match(text, new RegExp(`^${n}\\. `, 'm'), `${platform} rule ${n}`);
  }
});

test('the DeepSeek command opens while every subscription is exhausted, and passes the model check', () => {
  const now = Date.parse('2026-10-06T18:00:00Z');
  const blocked = { at: now, resetAt: now + 3_600_000 };
  const store = { Claude: { scope: 'claude', blocked }, Codex: { scope: 'codex', blocked }, Antigravity: { scope: 'gemini', blocked } };
  const opus = 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high';
  assert.equal(Q.quotaFallback(store, opus, null, null, now, { explicit: true }).action, 'queue', 'the store really is exhausted');
  for (const cmd of [DEEPSEEK, DEEPSEEK + ' --model opus']) {
    for (const explicit of [true, false]) {
      const plan = Q.quotaFallback(store, cmd, null, null, now, { explicit });
      assert.deepEqual([plan.action, plan.reason, plan.cmd], ['open', 'unmetered', cmd], cmd);
    }
    assert.deepEqual(M.checkCommand(cmd), { cmd });
  }
});

// Exact baseline wording from main-core.js at 64043df. New discussion commands
// must fit alongside these rules rather than silently rewriting their meaning.
test('discussion instructions preserve rules 3, 4, 5 and 9 verbatim from the main baseline', () => {
  const baseline = {
    3: '3. 目标清楚就派活：目标、范围和验收要求明确且已获授权，直接拆开派下去；缺的信息能靠检查项目、产物或历史弄清的先派人检查，影响目标、范围、授权或关键结果又查不出来的才问用户。已有授权不因 Relay、重启或清空而重新确认，也不因此扩大。技术细节（模型、实现、拆法）自己决定，不拿去问用户。',
    4: '4. 派活单步原则：一个会话一次只派一件活，忙碌时不要连着追加。互不依赖的事拆开并行。补充用 tell 发回原会话，只转发新指令，不要再贴文件正文；改方向用 tell --replace --now，明确要停才用 stop。',
    5: '5. 界面类的活要写明图标规则：任务正文里必须写明——复制、删除、编辑等常见工具动作用图标按钮（复制=两个重叠方框、删除=垃圾桶、编辑=铅笔），配 tooltip 和无障碍名称，不用「复制」这类文字按钮。不写，别的模型会做成文字按钮。',
    9: '9. 队员向你提问、或停在确认/权限提示时，你来拿主意：先看清它问的是什么，不盲按 y 或 enter；有把握就用 tell 或 answer 回复它；没把握，或者涉及删除数据、花钱、对外发布这类不可逆的事，再请用户决定，并说清要用户决定什么。',
  };
  for (const platform of PLATFORMS) for (const legacy of [false, true]) {
    const lines = rulebook(platform, '', legacy).split('\n');
    for (const [number, expected] of Object.entries(baseline)) {
      assert.equal(lines.find((line) => line.startsWith(number + '. ')), expected, `${platform} rule ${number}`);
    }
  }
});

test('the briefing keeps Chinese and English discussion triggers plus discovery, help and safe recovery under the paste limit', () => {
  for (const platform of PLATFORMS) for (const legacy of [false, true]) for (const cap of [5, 30, 50]) {
    const text = M.instructions(platform, '', legacy, cap);
    // the phrases that start one are in the core, pasted every time; discovery and recovery are in the commands rule file
    const core = text.split('\n').find((value) => value.includes('discuss start --topic'));
    assert.ok(core, platform + ': a Captain can start a discussion');
    for (const trigger of ['讨论一下', 'group discussion', 'do a group discussion', 'group chat', 'discuss help']) assert.ok(core.includes(trigger), `${platform} core: ${trigger}`);
    const line = topic('commands').split('\n').find((value) => value.includes('discuss start --topic'));
    for (const trigger of ['讨论一下', 'group discussion', 'do a group discussion', 'group chat']) assert.ok(line.includes(trigger), `${platform}: ${trigger}`);
    assert.match(line, /status 查全部/, platform + ': a new Captain can discover existing discussion IDs');
    assert.match(line, /status\/wait\/resume\/cancel --id ID/, platform);
    assert.match(line, /discuss help/, platform + ': installed Captains have a readable usage entry');
    assert.match(line, /unknown.*核对旧请求.*确认结束.*resume --retry JOB --confirmed-ended JOB/, platform);
    assert.ok((text + M.SAVER_RESUME).length <= M.CORE_LIMIT, `${platform}: discussion commands and the red lines still fit in the core`);
  }
});
