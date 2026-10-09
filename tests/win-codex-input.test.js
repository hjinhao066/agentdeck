'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ChatCore = require('../chat-core');
const MainCore = require('../main-core');
const BoardCore = require('../board-core');

// Codex on Windows: ConPTY turns plain text into console key events and loses the long dash, curly
// quotes and line breaks (docs/captain-briefing-checklist.md 6.3). The text goes out as key events
// instead (MainCore.winCodexKeys); a real Windows run is scripts/probe-codex-input.js.

// What a console reads from the key events: the characters of its key-down events, Shift+Enter as a line break.
function decode(data) {
  let out = '';
  for (const m of data.matchAll(/\x1b\[(\d+);(\d+);(\d+);(\d+);(\d+);(\d+)_/g)) {
    const [vk, , uc, down, state] = m.slice(1).map(Number);
    if (!down) continue;
    out += vk === 13 && state === 16 ? '\n' : String.fromCharCode(uc);
  }
  return out;
}

const awkward = '第一行：开头——测试\n\n## 标题——带长破折号\n- 条目 A — 英文短破折号\n- 条目 B ——— 三连\n包含 “引号”、‘单引号’、（括号）…… 和 emoji 🙂🙂 end\n最后一行：完。';

test('every character of a prompt arrives as a key event, long dashes, curly quotes, line breaks and emoji included', () => {
  const data = MainCore.winCodexKeys(awkward).join('');
  assert.equal(decode(data), awkward);
  assert.match(data, /^[\x00-\x7f]*$/, 'only ASCII is written, so nothing is left for the console to decode');
  assert.ok(!data.includes('\x1b[200~') && !/[\r\n]/.test(data), 'no paste marker, no raw line break or Enter');
});

test('a repeated character gets its key-up in between, or the console takes it for one held key', () => {
  const data = MainCore.winCodexKeys('——').join('');
  assert.equal(data, '\x1b[0;0;8212;1;0;1_\x1b[0;0;8212;0;0;1_\x1b[0;0;8212;1;0;1_\x1b[0;0;8212;0;0;1_');
});

test('an emoji is its two UTF-16 halves, key-down only; a lone half survives too', () => {
  assert.equal(MainCore.winCodexKeys('🙂').join(''), '\x1b[0;0;55357;1;0;1_\x1b[0;0;56898;1;0;1_');
  assert.equal(decode(MainCore.winCodexKeys('a\ud83dz').join('')), 'a\ud83dz');
});

test('line endings become Shift+Enter; tabs, escapes and other control characters never reach Codex as keys', () => {
  const data = MainCore.winCodexKeys('a\r\nb\rc\td\x1b[200~e\x03\x7f').join('');
  assert.equal(decode(data), 'a\nb\nc    d[200~e');
  assert.equal((data.match(/\x1b\[13;28;13;1;16;1_/g) || []).length, 2);
});

test('keys go out in small chunks of 40 characters, 8000 characters in 200 of them', () => {
  const text = '行——“引”\n'.repeat(1200).slice(0, 8000);
  const chunks = MainCore.winCodexKeys(text);
  assert.equal(chunks.length, 200);
  assert.ok(chunks.every((chunk) => decode(chunk).length === 40));
  assert.equal(chunks.map(decode).join(''), text);
  assert.deepEqual(MainCore.winCodexKeys(''), []);
});

const source = fs.readFileSync(path.join(__dirname, '../chat-ui.js'), 'utf8');
const body = source.slice(source.indexOf('  const PASTE_READ_MAX = 30_000;'), source.indexOf('  // A line submitted straight in the terminal'));

function harness({ platform, cmd, bracketed = false, screen = '' }) {
  const typed = [];
  const saved = [];
  const entry = { alive: true, state: 'done', term: { modes: { bracketedPasteMode: bracketed } }, lastOutputAt: 0, lastScreen: screen };
  const host = {
    platform, terms: new Map([['w', entry]]),
    dumpScreen: () => '› ', shellQuote: (p) => `'${p}'`, manualPromptSent() {}, userComposing: () => false, maybeAutoName() {}, showToast() {},
  };
  const context = vm.createContext({
    C: ChatCore, host, Date, setTimeout, Promise,
    window: {
      deck: {
        ptyInput: (id, data) => typed.push(data), notifyCancel() {},
        saveLongPrompt: async (text) => { saved.push(text); return 'C:\\long-prompts\\prompt-1.txt'; },
      },
      MainSession: null, MainCore, BoardCore,
    },
    beginTurn: (col, shown) => ({ id: 't', shown }),
  });
  vm.runInContext(body, context);
  return { context, typed, saved, col: { id: 'w', cmd } };
}
const keysOf = (typed) => decode(typed.slice(0, -1).join(''));

test('Codex on Windows: the prompt is typed as keys and submitted by one Enter after them', async () => {
  const { context, typed, saved, col } = harness({ platform: 'win32', cmd: 'codex --no-daemon' });
  assert.ok(await context.sendPrompt(col, awkward, null, {}));
  assert.equal(saved.length, 0);
  assert.equal(typed.at(-1), '\r');
  assert.equal(typed.filter((d) => d.includes('\r') || d.includes('\n')).length, 1, 'a single Enter, and no line break written as text');
  assert.equal(keysOf(typed), awkward);
  assert.ok(!typed.some((d) => d.includes('\x1b[200~')));
});

test('Codex on Windows: a long single line is typed whole, not turned into a file pointer', async () => {
  const { context, typed, saved, col } = harness({ platform: 'win32', cmd: 'codex' });
  const line = '这一行很长——'.repeat(300); // 1800 characters, 5400+ bytes: past the line-mode limit
  assert.ok(Buffer.byteLength(line) > ChatCore.LINE_MODE_BYTES);
  await context.sendPrompt(col, line, null, {});
  assert.equal(saved.length, 0);
  assert.equal(keysOf(typed), line);
});

test('Codex on Windows: a prompt past LONG_PROMPT still goes as a file, its pointer typed as keys', async () => {
  const { context, typed, saved, col } = harness({ platform: 'win32', cmd: 'codex' });
  await context.sendPrompt(col, '很长的任务——'.repeat(2000), null, {});
  assert.equal(saved.length, 1);
  const sent = keysOf(typed);
  assert.match(sent, /^很长的任务——很长的任务——/);
  assert.match(sent, /完整内容已存成文件，请先完整读取再照做：C:\\long-prompts\\prompt-1\.txt）/);
});

test('a shell column that shows Codex\'s screen on Windows is typed as keys too', async () => {
  const codexScreen = 'PS C:\\work> codex\n>_ OpenAI Codex (v0.161.0)\n› Ask Codex to do anything\n  100% context left';
  const { context, typed, col } = harness({ platform: 'win32', cmd: '', screen: codexScreen });
  await context.sendPrompt(col, '你好——世界', null, {});
  assert.equal(keysOf(typed), '你好——世界');
});

test('everything else is written as before: Codex on macOS, other agents and a bare shell on Windows', async () => {
  const prompt = '你好——世界\n第二行';
  for (const [platform, cmd, screen] of [['darwin', 'codex', ''], ['win32', 'claude', '› hi'], ['win32', '', 'PS C:\\work> ']]) {
    const { context, typed, col } = harness({ platform, cmd, bracketed: true, screen });
    await context.sendPrompt(col, prompt, null, {});
    assert.equal(typed[0], '\x1b[200~' + prompt + '\x1b[201~', `${platform} ${cmd || 'shell'}`);
    assert.equal(typed.length, 2);
  }
});
