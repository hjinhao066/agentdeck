'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ChatCore = require('../chat-core');
const M = require('../main-core');
const Q = require('../quota-core');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const PLATFORMS = ['darwin', 'win32'];
const DEEPSEEK = '/Users/jinhao/.local/claude-deepseek/bin/claude-ds --dangerously-skip-permissions';

// ChatUI.sendPrompt and sendLong, cut out of chat-ui.js and run against a stand-in terminal.
const chatUi = read('chat-ui.js');
const sendSource = chatUi.slice(chatUi.indexOf('  const PASTE_READ_MAX = 30_000;'), chatUi.indexOf('  // A line submitted straight in the terminal'));

function terminal() {
  const typed = [], saved = [];
  const entry = { alive: true, state: 'done', term: { modes: { bracketedPasteMode: true } }, lastOutputAt: 0 };
  const host = {
    terms: new Map([['captain', entry]]), dumpScreen: () => '❯ \n────────\n  ⏵⏵ auto mode on',
    shellQuote: (p) => p, manualPromptSent() {}, userComposing: () => false, maybeAutoName() {}, showToast() {},
  };
  const context = vm.createContext({
    C: ChatCore, host, Date, setTimeout, Promise,
    window: {
      deck: { ptyInput: (id, data) => typed.push(data), notifyCancel() {}, saveLongPrompt: async (text) => { saved.push(text); return '/tmp/long-prompts/prompt.txt'; } },
      MainSession: null, MainCore: M, BoardCore: { inferAgentType: () => 'Claude' },
    },
    beginTurn: () => ({ id: 't' }),
  });
  vm.runInContext(sendSource, context);
  // the options the briefing goes out with
  return { typed, saved, send: (text) => context.sendPrompt({ id: 'captain', cmd: 'claude' }, text, null, { silent: true, guardUserInput: true }) };
}
// A briefing that has grown to `length` characters; the closing paragraph and
// the token saver's resume line are still the last thing in it.
function grown(platform, length) {
  const brief = M.instructions(platform), closing = M.AUTONOMOUS_CONTINUATION + M.SAVER_RESUME;
  const rules = brief.slice(0, brief.length - M.AUTONOMOUS_CONTINUATION.length);
  return rules + '规'.repeat(length - rules.length - closing.length) + closing;
}

test('one prompt may be 10000 characters, and every Captain briefing fits with the saver line', () => {
  assert.equal(M.LONG_PROMPT, 10000);
  for (const platform of PLATFORMS) for (const legacy of [false, true]) for (const cap of [5, 30, 50]) {
    const brief = M.instructions(platform, '', legacy, cap);
    assert.ok(brief.endsWith(M.AUTONOMOUS_CONTINUATION), platform);
    assert.ok((brief + M.SAVER_RESUME).length <= M.LONG_PROMPT,
      `${platform}${legacy ? ' legacy' : ''}：队长提示词超出一次粘贴上限 ${M.LONG_PROMPT}。调高 MainCore.LONG_PROMPT，不要删规则凑字数（docs/captain-briefing-checklist.md）`);
  }
});

test('the token saver resend reaches the Captain whole on Mac and Windows, closing and 读看板继续 included', async () => {
  await Promise.all(PLATFORMS.flatMap((platform) => [false, true].map(async (legacy) => {
    const text = M.instructions(platform, '', legacy) + M.SAVER_RESUME, t = terminal();
    assert.ok(await t.send(text), platform);
    assert.deepEqual(t.saved, [], platform + ': nothing goes to a file');
    assert.deepEqual(t.typed, ['\x1b[200~' + text + '\x1b[201~', '\r'], platform + ': one paste, one Enter');
    assert.ok(t.typed[0].endsWith(M.AUTONOMOUS_CONTINUATION + '\n\n读看板继续。\x1b[201~'), platform);
  })));
  // main-session sends exactly that text
  assert.ok(read('main-session.js').includes("saverSend(op, briefingText() + M.SAVER_RESUME, 'briefing', true"));
});

test('a briefing of exactly 10000 characters is still pasted whole; one more character becomes a file pointer', async () => {
  await Promise.all(PLATFORMS.map(async (platform) => {
    const full = grown(platform, M.LONG_PROMPT), t = terminal();
    assert.equal(full.length, 10000);
    assert.ok(await t.send(full), platform);
    assert.deepEqual(t.saved, [], platform);
    assert.deepEqual(t.typed, ['\x1b[200~' + full + '\x1b[201~', '\r'], platform);
    assert.ok(t.typed[0].endsWith('读看板继续。\x1b[201~'), platform);

    const over = grown(platform, M.LONG_PROMPT + 1), o = terminal();
    assert.ok(await o.send(over), platform);
    assert.deepEqual(o.saved, [over], platform + ': the whole text is in the file');
    assert.equal(o.typed.length, 2, platform);
    assert.match(o.typed[0], /（这条消息共 10001 字，完整内容已存成文件，请先完整读取再照做：\/tmp\/long-prompts\/prompt\.txt）/, platform);
    assert.ok(!o.typed[0].includes('读看板继续'), platform + ': past the limit the closing is only in the file');
  }));
});

test('ChatUI and the queue read the one limit; no second copy of the number', () => {
  assert.match(chatUi, /prompt\.length > window\.MainCore\.LONG_PROMPT\) return sendLong\(/);
  assert.doesNotMatch(chatUi, /LONG_PROMPT = /);
  const session = read('main-session.js');
  assert.match(session, /body\.length > M\.LONG_PROMPT && metadata\.executor !== 'chatgpt-web'/);
  assert.doesNotMatch(session, /body\.length > \d/);
});

test('the briefing explains the DeepSeek fallback: when, how, what for, and that it costs money on the Mac only', () => {
  for (const platform of PLATFORMS) {
    const text = M.instructions(platform);
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
    const text = M.instructions(platform);
    assert.match(text, /Claude Code 额度受限时，可改用 Cursor 里的同名模型（claude-opus-5-5-high、claude-sonnet-5-5-high）。/, platform);
    assert.match(text, /agy 第三方模型的剩余额度目前无法读取，遇到限流就换另一个已实测模型。/, platform);
    assert.match(text, /只对 Gemini Flash 写档位后缀：[^\n]*；其余模型必须使用上面列出的完整 ID。/, platform);
    assert.match(text, /quota {3}只读各家订阅额度；派活前可跑 quota，避开已用尽或快用尽的；未知不代表可用/, platform);
    assert.match(text, /额度轮换：quota 只读被动观测，未知不代表可用，不要因此换模型。/, platform);
    assert.match(text, /Opus 留给 UI、最关键的代码和终审；重要代码用 Sonnet。/, platform);
    for (let n = 1; n <= 17; n++) assert.match(text, new RegExp(`^${n}\\. `, 'm'), `${platform} rule ${n}`);
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
