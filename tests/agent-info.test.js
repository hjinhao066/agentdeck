const test = require('node:test');
const assert = require('node:assert/strict');
const AgentInfo = require('../agent-info.js');

test('statusline nonbreaking spaces preserve the model family and version', () => {
  assert.equal(AgentInfo.shortModelName('Gemini\u00a03.8\u00a0Flash\u00a0(High) [93/100 left]'), 'Flash 3.8');
  assert.equal(AgentInfo.shortModelName('Opus\u00a05.5'), 'Opus 5.5');
});

test('provider inference from launch command', () => {
  assert.equal(AgentInfo.inferProvider('cursor-agent --model claude-opus-5-5-high'), 'Cursor');
  assert.equal(AgentInfo.inferProvider('cursor-agent --model claude-sonnet-5-5-high'), 'Cursor');
  assert.equal(AgentInfo.inferProvider('cursor-agent --model grok-4.7-high-fast'), 'Cursor');
  assert.equal(AgentInfo.inferProvider('cursor-agent --model gemini-3.8-flash-high'), 'Cursor');
  assert.equal(AgentInfo.inferProvider('claude --dangerously-skip-permissions --effort high'), 'Claude');
  assert.equal(AgentInfo.inferProvider('claude'), 'Claude');
  assert.equal(AgentInfo.inferProvider('agy --model gemini-3.8-flash-high --effort high'), 'Antigravity');
  assert.equal(AgentInfo.inferProvider('antigravity'), 'Antigravity');
  assert.equal(AgentInfo.inferProvider('grok'), 'Grok');
  assert.equal(AgentInfo.inferProvider('codex --model gpt-5'), 'Codex');
  assert.equal(AgentInfo.inferProvider('chatgpt'), 'Codex');
  assert.equal(AgentInfo.inferProvider(''), null);
  assert.equal(AgentInfo.inferProvider('/bin/zsh'), null);
  assert.equal(AgentInfo.inferProvider('bash'), null);
});

test('Codex banner and model-change output identify OpenAI models', () => {
  const screen = [
    '>_ OpenAI Codex (v0.160.0)',
    'Model changed to gpt-6-luna high',
  ].join('\n');
  const col = { cmd: '' };
  const info = AgentInfo.resolveAgentInfo(col, null, screen);
  assert.equal(info.provider, 'Codex');
  assert.equal(info.rawModel, 'gpt-6-luna');
  assert.equal(info.shortModel, 'GPT-6 Luna');
  assert.equal(info.effort, 'high');
  assert.equal(AgentInfo.PROVIDER_ICONS.Grok.includes('<svg'), true);

  const footer = AgentInfo.resolveAgentInfo({ cmd: 'codex' }, null, '', ['GPT-6-Luna high · ~ · Respond to greeting']);
  assert.equal(footer.provider, 'Codex');
  assert.equal(footer.rawModel, 'GPT-6-Luna high');
  assert.equal(footer.shortModel, 'GPT-6 Luna');
  assert.equal(footer.effort, 'high');
});

test('Codex model is recovered from the restored terminal footer without footer rows', () => {
  const screen = [
    '>_ OpenAI Codex (v0.160.0)',
    'permissions: YOLO mode',
    'GPT-6-Luna xhigh · ~',
  ].join('\n');
  const info = AgentInfo.resolveAgentInfo({ cmd: '' }, null, screen);
  assert.equal(info.provider, 'Codex');
  assert.equal(info.rawModel, 'GPT-6-Luna xhigh');
  assert.equal(info.shortModel, 'GPT-6 Luna');
  assert.equal(info.effort, 'xhigh');
});

test('saved chat replies recover the last model when restored terminal is a shell', () => {
  const history = [
    '>_ OpenAI Codex (v0.160.0)\nModel changed to gpt-6-luna high\nGPT-6-Luna high · ~',
    '>_ OpenAI Codex (v0.160.0)\nGPT-6-Luna xhigh · ~',
    '>_ OpenAI Codex (v0.160.0)\nSelect Model and Effort',
  ];
  const info = AgentInfo.resolveAgentInfo({ cmd: '' }, null, 'jinhao@MacBook ~ %', null, history);
  assert.equal(info.provider, 'Codex');
  assert.equal(info.rawModel, 'GPT-6-Luna xhigh');
  assert.equal(info.shortModel, 'GPT-6 Luna');
  assert.equal(info.effort, 'xhigh');
});

test('restored provider/model identity is a fallback, live model status wins', () => {
  const col = { cmd: '', agentProvider: 'Codex', agentModel: 'gpt-6-luna', agentEffort: 'high' };
  const restored = AgentInfo.resolveAgentInfo(col, null, 'jinhao@MacBook ~ %');
  assert.equal(restored.provider, 'Codex');
  assert.equal(restored.shortModel, 'GPT-6 Luna');
  assert.equal(restored.effort, 'high');

  const live = AgentInfo.resolveAgentInfo(col, null, 'Model changed to gpt-6.1-sol max');
  assert.equal(live.rawModel, 'gpt-6.1-sol');
  assert.equal(live.shortModel, 'GPT-6.1 Sol');
  assert.equal(live.effort, 'max');
});

test('Cursor provider stays Cursor even when switching model family to Claude/Grok/Gemini', () => {
  const col = { cmd: 'cursor-agent --model claude-opus-5-5-high' };
  
  // Initial resolution from command
  let info = AgentInfo.resolveAgentInfo(col, null, null);
  assert.equal(info.provider, 'Cursor');
  assert.equal(info.shortModel, 'Opus 5.5');
  assert.equal(info.effort, 'high');
  assert.match(info.tooltip, /Cursor · Claude Opus 5.5 \(high\)/);

  // Switch to Claude Sonnet in live terminal status
  const screenSonnet = [
    'Cursor CLI v2026.10',
    '────────────────────────────────────────',
    '> /model claude-sonnet-5-5-high',
    'Model: claude-sonnet-5-5-high | Weekly Reset: 12hr',
  ].join('\n');
  info = AgentInfo.resolveAgentInfo(col, null, screenSonnet);
  assert.equal(info.provider, 'Cursor');
  assert.equal(info.shortModel, 'Sonnet 5.5');
  assert.equal(info.effort, 'high');
  assert.match(info.tooltip, /Cursor · Claude Sonnet 5.5 \(high\)/);

  // Switch to Grok in live terminal status
  const screenGrok = [
    'Cursor CLI v2026.10',
    '────────────────────────────────────────',
    'Model: grok-4.7-high-fast | Weekly Reset: 12hr',
  ].join('\n');
  info = AgentInfo.resolveAgentInfo(col, null, screenGrok);
  assert.equal(info.provider, 'Cursor');
  assert.equal(info.shortModel, 'Grok 4.7');
  assert.match(info.tooltip, /Cursor · Grok 4.7/);

  // Switch to Gemini in live terminal status
  const screenGemini = [
    'Cursor CLI v2026.10',
    '────────────────────────────────────────',
    'Model: gemini-3.8-flash-high',
  ].join('\n');
  info = AgentInfo.resolveAgentInfo(col, null, screenGemini);
  assert.equal(info.provider, 'Cursor');
  assert.equal(info.shortModel, 'Flash 3.8');
  assert.match(info.tooltip, /Cursor · Gemini 3.8 Flash/);
});

test('direct agents and manual unknown detection', () => {
  // Direct Claude
  const claudeCol = { cmd: 'claude --effort high' };
  const claudeInfo = AgentInfo.resolveAgentInfo(claudeCol, null, 'Model: Fake | Weekly Reset: 16hr');
  assert.equal(claudeInfo.provider, 'Claude');
  assert.equal(claudeInfo.shortModel, 'Fake');

  // Direct Antigravity
  const agyCol = { cmd: 'agy --model gemini-3.8-flash-high --effort high' };
  const agyInfo = AgentInfo.resolveAgentInfo(agyCol, null, null);
  assert.equal(agyInfo.provider, 'Antigravity');
  assert.equal(agyInfo.shortModel, 'Flash 3.8');
  assert.equal(agyInfo.effort, 'high');
  assert.match(agyInfo.tooltip, /Antigravity · Gemini 3.8 Flash \(high\)/);

  // Manual unknown: empty cmd and plain shell prompt
  const shellCol = { cmd: '' };
  const shellScreen = 'jinhao@MacBook ~ % ls -la\ntotal 0\ndrwxr-xr-x  2 jinhao  staff   64 Oct  1 23:00 .\n';
  const shellInfo = AgentInfo.resolveAgentInfo(shellCol, null, shellScreen);
  assert.equal(shellInfo.provider, null);
  assert.equal(shellInfo.model, null);
  assert.equal(shellInfo.isShell, true);
  assert.equal(shellInfo.tooltip, '');

  // Manual agent: empty cmd, but observed header in terminal
  const entryManual = {};
  const manualClaudeScreen = [
    'Welcome to Claude Code (test stand-in)',
    '────────────────────────────────────────',
    'Model: Opus 5.5 | Weekly Reset: 16hr',
  ].join('\n');
  const manualInfo = AgentInfo.resolveAgentInfo(shellCol, entryManual, manualClaudeScreen);
  assert.equal(manualInfo.provider, 'Claude');
  assert.equal(manualInfo.shortModel, 'Opus 5.5');
  assert.equal(entryManual.detectedProvider, 'Claude');

  // Manual agent: Cursor CLI header observed
  const entryCursor = {};
  const manualCursorScreen = [
    'Cursor Agent v2026.10',
    'Model: claude-sonnet-5-5-high',
  ].join('\n');
  const manualCursorInfo = AgentInfo.resolveAgentInfo(shellCol, entryCursor, manualCursorScreen);
  assert.equal(manualCursorInfo.provider, 'Cursor');
  assert.equal(manualCursorInfo.shortModel, 'Sonnet 5.5');
});

test('conversational prose containing model names does not produce false positives', () => {
  const col = { cmd: 'claude --effort high' };
  const conversationalScreen = [
    'Welcome to Claude Code (test stand-in)',
    '> Can we switch to claude-opus-5-5-high or try gemini-3.8-flash?',
    '⏺ Claude replies:',
    '  I recommend using claude-opus-5-5-high for complex tasks.',
    '  Alternatively, grok-4.7-high-fast or gpt-5 might also be relevant.',
    '  The model architecture is described in the paper.',
    '────────────────────────────────────────',
    '> ',
    '────────────────────────────────────────',
    'Context: 23% | Session: 26.0%',
    'Model: Fake | Weekly Reset: 16hr',
    '⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');

  // Should extract "Fake" from the dedicated metadata line, NOT claude-opus-5-5-high or gemini-3.8-flash from prose!
  const info = AgentInfo.resolveAgentInfo(col, null, conversationalScreen);
  assert.equal(info.provider, 'Claude');
  assert.equal(info.shortModel, 'Fake');
});

test('conversational prose without dedicated status line falls back to command model', () => {
  const col = { cmd: 'cursor-agent --model claude-sonnet-5-5-high' };
  const proseScreen = [
    'Here is the conversation:',
    'User: Which is better, claude-opus-5-5-high or gemini-3.8-flash-high?',
    'Assistant: claude-opus-5-5-high is stronger for complex reasoning.',
  ].join('\n');

  // Fallback to command model because prose has no dedicated "Model: ..." line
  const info = AgentInfo.resolveAgentInfo(col, null, proseScreen);
  assert.equal(info.provider, 'Cursor');
  assert.equal(info.shortModel, 'Sonnet 5.5');
});

test('newest authoritative metadata line overrides older lines and command', () => {
  const col = { cmd: 'cursor-agent --model claude-opus-5-5-high' };
  const multiUpdateScreen = [
    'Model: claude-opus-5-5-high | Weekly Reset: 10hr',
    '> /model claude-sonnet-5-5-high',
    'Switched model to claude-sonnet-5-5-high',
    'Model: claude-sonnet-5-5-high | Weekly Reset: 10hr',
  ].join('\n');

  // Newest line at bottom is claude-sonnet-5-5-high
  const info = AgentInfo.resolveAgentInfo(col, null, multiUpdateScreen);
  assert.equal(info.provider, 'Cursor');
  assert.equal(info.shortModel, 'Sonnet 5.5');
});

test('ANSI escape codes and TUI footer segments are handled cleanly', () => {
  const col = { cmd: 'claude' };
  const ansiScreen = [
    '\x1b[1;32mWelcome to Claude Code\x1b[0m',
    '─'.repeat(40),
    '\x1b[36mModel: Fake | Weekly Reset: 16hr\x1b[0m',
  ].join('\n');

  const info = AgentInfo.resolveAgentInfo(col, null, ansiScreen);
  assert.equal(info.shortModel, 'Fake');

  // Test passing dedicated footerRows array directly
  const footerRows = [
    '\x1b[33mContext: 23%\x1b[0m | \x1b[31mSession: 26.0%\x1b[0m',
    '\x1b[36mModel: claude-opus-5-5-high | Weekly Reset: 16hr\x1b[0m',
  ];
  const footerInfo = AgentInfo.resolveAgentInfo(col, null, '', footerRows);
  assert.equal(footerInfo.shortModel, 'Opus 5.5');
  assert.equal(footerInfo.effort, 'high');
});

test('short model names format accurately', () => {
  assert.equal(AgentInfo.shortModelName('claude-opus-5-5-high'), 'Opus 5.5');
  assert.equal(AgentInfo.shortModelName('claude-opus-5-5-xhigh'), 'Opus 5.5');
  assert.equal(AgentInfo.shortModelName('claude-opus-5-5-max'), 'Opus 5.5');
  assert.equal(AgentInfo.shortModelName('claude-sonnet-5-5-high'), 'Sonnet 5.5');
  assert.equal(AgentInfo.shortModelName('claude-opus-4-6-thinking'), 'Opus 4.6');
  assert.equal(AgentInfo.shortModelName('claude-3-7-sonnet'), 'Sonnet 3.7');
  assert.equal(AgentInfo.shortModelName('claude-3.5-sonnet'), 'Sonnet 3.5');
  assert.equal(AgentInfo.shortModelName('gemini-3.8-flash-high'), 'Flash 3.8');
  assert.equal(AgentInfo.shortModelName('gemini-3.1-pro-high'), 'Pro 3.1');
  assert.equal(AgentInfo.shortModelName('grok-4.7-high-fast'), 'Grok 4.7');
  assert.equal(AgentInfo.shortModelName('gpt-5'), 'GPT-5');
  assert.equal(AgentInfo.shortModelName('o3-mini'), 'o3-mini');
  assert.equal(AgentInfo.shortModelName('o1'), 'o1');
  assert.equal(AgentInfo.shortModelName('Fake'), 'Fake');
});


test('model identity does not trust command arguments, typed model requests or prose', () => {
  assert.equal(AgentInfo.inferProvider('node tool.js --note "claude"'), null);
  assert.equal(AgentInfo.inferProvider('gemini --yolo'), 'Antigravity');
  assert.equal(AgentInfo.inferProvider('', 'I used Claude Code to solve this.'), null);
  assert.equal(AgentInfo.extractModel('> /model gemini-3.8-flash-high', 'cursor-agent --model claude-opus-5-5-high'), 'claude-opus-5-5-high');
  assert.equal(AgentInfo.shortModelName('gpt-5.5-high'), 'GPT-5.5');
  assert.equal(AgentInfo.shortModelName('gpt-6.1-high'), 'GPT-6.1');
  assert.equal(AgentInfo.shortModelName('gpt-6-luna-high'), 'GPT-6 Luna');
  assert.equal(AgentInfo.shortModelName('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(AgentInfo.shortModelName('meta/muse-spark'), 'Muse Spark');
  assert.equal(AgentInfo.shortModelName('meta-muse'), 'Muse');
  assert.equal(AgentInfo.extractEffort('grok-4.7-high-fast', '', ''), 'high');
  assert.equal(AgentInfo.extractEffort('Opus 5.5', 'claude --effort high', 'Thinking: xhigh'), 'xhigh');
});

test('Claude Captain uses its own statusline instead of delegated Codex output or poisoned cache', () => {
  const col = { cmd: 'claude --dangerously-skip-permissions --effort high', agentProvider: 'Claude', agentModel: 'GPT-6.1-Sol high' };
  const footer = ['ヽ(=^･ω･^=)ﾉ Opus 5.5 · xhigh · think 5h 13% · 7d 1%'];
  const screen = 'GPT-6.1-Sol high · ~\nModel: gpt-6-luna\n' + footer[0];
  const info = AgentInfo.resolveAgentInfo(col, null, screen, footer, ['Model: gpt-6.1-sol']);
  assert.equal(info.provider, 'Claude');
  assert.equal(info.shortModel, 'Opus 5.5');
  assert.equal(info.effort, 'xhigh');
  const entry = { footerLines: [[{ text: footer[0].slice(0, 14) }, { text: footer[0].slice(14) }]] };
  assert.equal(AgentInfo.resolveAgentInfo(col, entry, screen, entry.footerLines).shortModel, 'Opus 5.5');
  assert.equal(AgentInfo.resolveAgentInfo(col, null, screen).shortModel, 'Opus 5.5');
  assert.equal(AgentInfo.resolveAgentInfo(col, null, 'Model: gpt-6.1-sol').rawModel, null);
});

test('launch model beats conversation metadata and mismatched saved session identity', () => {
  for (const cmd of ['claude --model claude-opus-5-5', 'claude --model="claude-opus-5-5"', "claude -m 'claude-opus-5-5'"]) {
    const col = { cmd, agentProvider: 'Codex', agentModel: 'gpt-6.1-sol', agentEffort: 'max' };
    const info = AgentInfo.resolveAgentInfo(col, null, 'Model: gpt-6-luna', ['Context: 23%'], ['Model: claude-sonnet-5-5']);
    assert.equal(info.provider, 'Claude');
    assert.equal(info.shortModel, 'Opus 5.5');
    assert.equal(info.effort, null);
  }
});

test('actual footer wins over model examples in the reply and allows Claude model switching', () => {
  const col = { cmd: 'claude --model claude-opus-5-5' };
  const screen = 'Model: claude-sonnet-5-5\nGPT-6.1-Sol high · ~';
  assert.equal(AgentInfo.resolveAgentInfo(col, null, screen, ['Context: 23%']).shortModel, 'Opus 5.5');
  assert.equal(AgentInfo.resolveAgentInfo(col, null, screen, ['Opus 5.5 · high · Claude Max']).shortModel, 'Opus 5.5');
  const switched = AgentInfo.resolveAgentInfo(col, null, screen, ['Model: claude-sonnet-5-5 | Weekly Reset: 16hr']);
  assert.equal(switched.shortModel, 'Sonnet 5.5');
});

test('single-provider tools reject foreign models, Cursor and Antigravity support multiple model families', () => {
  for (const cmd of ['claude --model claude-opus-5-5', 'grok --model grok-4.7']) {
    const fallback = AgentInfo.resolveAgentInfo({ cmd }, null, 'Model: gpt-6.1-sol', ['GPT-6.1-Sol high · ~']);
    assert.equal(fallback.shortModel, AgentInfo.shortModelName(AgentInfo.extractModel('', cmd)));
  }
  assert.equal(AgentInfo.resolveAgentInfo({ cmd: 'codex --model gpt-6-luna' }, null, 'Model: claude-opus-5-5').shortModel, 'GPT-6 Luna');
  assert.equal(AgentInfo.resolveAgentInfo({ cmd: 'cursor-agent --model claude-opus-5-5-high' }, null, 'Model: gpt-6.1-sol').shortModel, 'GPT-6.1 Sol');
  assert.equal(AgentInfo.resolveAgentInfo({ cmd: 'agy --model gemini-3.8-flash-high' }, null, 'Model: claude-sonnet-4-6').shortModel, 'Sonnet 4.6');
});


test('Claude sidebar identity carries the pinned seat; Cursor Opus remains Cursor and has no Claude seat label', () => {
  const col = { cmd: 'claude --model claude-opus-5-5', claudeSeatId: 'cn', claudeConfigDir: '~/.claude' };
  const cn = AgentInfo.resolveAgentInfo(col, null);
  assert.deepEqual(cn.seat, { id: 'cn', configDir: '~/.claude' });
  const us = AgentInfo.resolveAgentInfo({ ...col, claudeSeatId: 'us', claudeConfigDir: '~/.claude-us' }, null);
  assert.notEqual(cn.key, us.key);
  const cursor = AgentInfo.resolveAgentInfo({ ...col, cmd: 'cursor-agent --model claude-opus-5-5-high' }, null, "Claude Code\nYou've hit your session limit");
  assert.equal(cursor.provider, 'Cursor');
  assert.equal(cursor.seat, null);
  const Q = require('../quota-core');
  assert.equal(Q.screen(cursor.provider, "You've hit your session limit · resets 9:20pm", ['Model: claude-opus-5-5-high'], Date.now(), cursor.rawModel), null);
  assert.equal(AgentInfo.iconProviderFor('Opus 5.5', 'Cursor'), 'Claude');
  assert.equal(AgentInfo.iconProviderFor('Grok 4.7', 'Cursor'), 'Grok');
  assert.equal(AgentInfo.iconProviderFor('GPT-6.1 Sol', 'Cursor'), 'Codex');
  assert.equal(AgentInfo.iconProviderFor('Flash 3.8', 'Cursor'), 'Antigravity');
  assert.equal(AgentInfo.iconProviderFor('Fake', 'Claude'), 'Claude');
});

test('environment launch prefixes identify providers and preserve complete model versions', () => {
  for (const [program, provider, model, label] of [
    ['claude', 'Claude', 'claude-sonnet-5-5', 'Sonnet 5.5'],
    ['cursor-agent', 'Cursor', 'claude-opus-5-5', 'Opus 5.5'],
    ['agy', 'Antigravity', 'gemini-3.8-flash-high', 'Flash 3.8'],
    ['codex', 'Codex', 'gpt-6.1-sol', 'GPT-6.1 Sol'],
  ]) {
    for (const prefix of ['env FOO="two words" ', 'FOO=value ', 'env -u TOKEN FOO=value command ']) {
      const info = AgentInfo.resolveAgentInfo({ cmd: `${prefix}${program} --model=${model}` }, null);
      assert.equal(info.provider, provider);
      assert.equal(info.shortModel, label);
    }
  }
});

test('family-only live and cached Claude labels retain the launch version', () => {
  const col = { cmd: 'env CLAUDE_CONFIG_DIR=/Users/jinhao/.claude-us claude --model claude-sonnet-5-5',
    agentProvider: 'Claude', agentModel: 'Sonnet', claudeSeatId: 'cn', claudeConfigDir: '~/.claude' };
  const info = AgentInfo.resolveAgentInfo(col, null, 'Claude Code\nModel: Sonnet', ['Model: Sonnet']);
  assert.equal(info.shortModel, 'Sonnet 5.5');
  assert.deepEqual(info.seat, { id: 'us', configDir: '/Users/jinhao/.claude-us' });
  assert.equal(AgentInfo.resolveAgentInfo(col, null).shortModel, 'Sonnet 5.5');
  assert.equal(AgentInfo.resolveAgentInfo(col, null, '', ['Model: Sonnet 4.6']).shortModel, 'Sonnet 4.6');
});

test('unrecognized launch displays the program and exact model rather than a shell badge', () => {
  const info = AgentInfo.resolveAgentInfo({ cmd: 'env FOO=bar /opt/bin/my-agent --model vendor/very-long-model-v7' }, null);
  assert.equal(info.provider, 'my-agent');
  assert.equal(info.shortModel, 'vendor/very-long-model-v7');
  assert.equal(info.isShell, false);
});

test('Claude resume flags are placed after the executable with an environment prefix', () => {
  assert.equal(AgentInfo.prepareAgentCommand('env CLAUDE_CONFIG_DIR="/tmp/us seat" claude --model claude-opus-5-5', 'Claude', 'uuid', true),
    'env CLAUDE_CONFIG_DIR="/tmp/us seat" claude --resume uuid --model claude-opus-5-5');
});
