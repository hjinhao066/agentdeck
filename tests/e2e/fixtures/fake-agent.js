// Stand-in for an agent TUI (Claude Code shape): replies with a bullet, then
// redraws an input box between two rules with colored status lines below it.
// Lines arriving together (a multi-line prompt) are answered once. A prompt
// carrying the AgentDeck receipt contract submits through board-cli; "ask me"
// makes it stop at a y/n question like a permission prompt.
const readline = require('readline');
const provider = process.argv.includes('--provider=codex') ? 'Codex CLI' : 'Claude Code';
if (process.env.AGENTDECK_TEST_SEATS_ENV_FILE) {
  require('fs').appendFileSync(process.env.AGENTDECK_TEST_SEATS_ENV_FILE, JSON.stringify({
    colId: process.env.AGENTDECK_COL_ID, configDir: process.env.CLAUDE_CONFIG_DIR || null,
    authOverridePresent: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'].some((key) => !!process.env[key]),
  }) + '\n');
}
if (process.env.AGENTDECK_TEST_RECEIPT_ENV_DIR) {
  require('fs').writeFileSync(require('path').join(process.env.AGENTDECK_TEST_RECEIPT_ENV_DIR, process.env.AGENTDECK_COL_ID + '.json'), JSON.stringify({
    AGENTDECK_TERMINAL_ID: process.env.AGENTDECK_TERMINAL_ID,
    AGENTDECK_RECEIPT_TOKEN: process.env.AGENTDECK_RECEIPT_TOKEN,
    AGENTDECK_CONTROL_DIR: process.env.AGENTDECK_CONTROL_DIR,
    AGENTDECK_BOARD_CLI: process.env.AGENTDECK_BOARD_CLI,
    control: !!process.env.AGENTDECK_CONTROL_TOKEN,
  }));
}
if (process.env.AGENTDECK_TEST_CONTROL_ENV_FILE && process.env.AGENTDECK_CONTROL_TOKEN) {
  require('fs').writeFileSync(process.env.AGENTDECK_TEST_CONTROL_ENV_FILE, JSON.stringify({
    AGENTDECK_CONTROL_DIR: process.env.AGENTDECK_CONTROL_DIR,
    AGENTDECK_CONTROL_TOKEN: process.env.AGENTDECK_CONTROL_TOKEN,
  }));
}
// One file per terminal that holds a control token (队长, 小队长), named by its column id.
if (process.env.AGENTDECK_TEST_CONTROL_ENV_DIR && process.env.AGENTDECK_CONTROL_TOKEN) {
  require('fs').writeFileSync(require('path').join(process.env.AGENTDECK_TEST_CONTROL_ENV_DIR, process.env.AGENTDECK_COL_ID + '.json'), JSON.stringify({
    AGENTDECK_CONTROL_DIR: process.env.AGENTDECK_CONTROL_DIR,
    AGENTDECK_CONTROL_TOKEN: process.env.AGENTDECK_CONTROL_TOKEN,
  }));
}
if (process.env.AGENTDECK_TEST_HISTORY_FLAGS_FILE) {
  require('fs').writeFileSync(process.env.AGENTDECK_TEST_HISTORY_FLAGS_FILE, JSON.stringify({
    child: Object.hasOwn(process.env, 'CLAUDE_CODE_CHILD_SESSION'),
    skip: Object.hasOwn(process.env, 'CLAUDE_CODE_SKIP_PROMPT_HISTORY'),
    statusWidth: process.env.CCSTATUSLINE_WIDTH,
  }));
}
// A TUI redraws the current screen; old prompts must not look like a live menu.
const delayedStart = process.argv.includes('--delayed-start');
if (!delayedStart) process.stdout.write('\x1b[?1049h');
process.on('exit', () => process.stdout.write('\x1b[?1049l'));
const captainStatusline = process.argv.includes('--captain-statusline');
let model = captainStatusline ? 'Opus 5.5' : 'Fake';
let contextUsed = 23000;
const codex = process.argv.includes('--codex-reset');
let resetMenu = false;
let suggestion = false;
let suggestionBlink = null;
function suggestionBox() {
  // New Claude Code idle screen: no ruled box, no "Claude Code" footer.
  // The gray suggestion is dim (SGR 2) on the ❯ row. Cursor blink keeps coming.
  process.stdout.write('接下来我打算读三份测试日志，有失败就修，然后提交回执。\n');
  process.stdout.write('要我继续，还是你想换个做法？\n\n');
  process.stdout.write('\x1b[38;2;153;153;153m✻ Churned for 16s\x1b[39m\n');
  process.stdout.write('❯\u00a0\x1b[2m继续，读测试日志然后提交回执\x1b[22m\n');
}
function armSuggestion() {
  suggestion = true;
  if (!suggestionBlink) suggestionBlink = setInterval(() => process.stdout.write('\x1b[?25l\x1b[?25h'), 400);
  suggestionBox();
}
function box() {
  if (suggestion) { suggestionBox(); return; }
  if (process.argv.includes('--onboarding-probe')) {
    let complete = false;
    try { complete = JSON.parse(require('fs').readFileSync(require('path').join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8')).hasCompletedOnboarding === true; } catch (_) {}
    if (!complete || process.argv.includes('--force-login-method')) {
      process.stdout.write('Claude Code\nSelect login method\n❯ 1. Claude account with subscription\n  2. Anthropic console\n');
      return;
    }
    process.stdout.write('Claude Code startup input ready\n');
  }
  if (process.argv.includes('--codex-completed')) {
    process.stdout.write('◦ Working (11m 27s • esc to interrupt)\n' +
      '─ Worked for 34m 29s • 12:52 ─\n› \x1b[2mAsk Codex to do anything\x1b[22m\n' +
      'GPT-6.1-Sol high · ~ · 修复僵尸调度会话派卡\n? for shortcuts  ⚠ 3 · f2\n');
    return;
  }
  if (codex) {
    process.stdout.write(`OpenAI Codex\n\n› \x1b[2mAsk Codex to do anything\x1b[22m\n\n  ⏎ send   ⌃J newline   ${100 - Math.round(contextUsed / 10000)}% context left\n`);
    return;
  }
  const w = Math.max(20, Math.min(60, (process.stdout.columns || 80) - 2));
  process.stdout.write('\n' + '─'.repeat(w) + '\n> \n' + '─'.repeat(w) + '\n');
  const extra = process.env.AGENTDECK_TEST_LONG_STATUS ? ' | Total: 211.5M | Cost: $35.33 | Weekly: 13.0% | LastField: complete' : '';
  const context = process.argv.includes('--token-saver') ? `${contextUsed / 1000}k/1000k` : '23%';
  process.stdout.write('\x1b[33mContext: ' + context + '\x1b[0m | \x1b[31mSession: 26.0%\x1b[0m' + extra + '\n');
  process.stdout.write('\x1b[36m' + (captainStatusline
    ? 'ヽ(=^･ω･^=)ﾉ ' + model + ' · xhigh · think 5h 13% · 7d 1%'
    : 'Model: ' + model + ' | Weekly Reset: 16hr') + '\x1b[0m\n');
  process.stdout.write('\x1b[35m⏵⏵ bypass permissions on\x1b[0m (shift+tab to cycle)\n');
  // Keep a recognizable provider footer after replies, like a real TUI. Narrow
  // ConPTY columns can wrap the longer permission line across several rows.
  process.stdout.write(provider + '\n');
  if (process.argv.includes('--sidebar-controls')) process.stdout.write('← for agents · ? for shortcuts ⚠…\nThinking: xhigh\n');
}
let lines = [];
let timer = null;
function answer() {
  const text = lines.join('\n');
  lines = [];
  // Test-only capture verifies delivery before ConPTY wraps/redraws the screen.
  if (process.env.AGENTDECK_TEST_PROMPTS_FILE) require('fs').appendFileSync(process.env.AGENTDECK_TEST_PROMPTS_FILE, JSON.stringify(text) + '\n');
  if (process.env.AGENTDECK_TEST_PROMPT_COLUMNS_FILE) require('fs').appendFileSync(process.env.AGENTDECK_TEST_PROMPT_COLUMNS_FILE, JSON.stringify({ colId: process.env.AGENTDECK_COL_ID, text }) + '\n');
  const first = (text.split('\n').find((l) => l.trim()) || '').trim();
  if (first === 'show login method') {
    process.stdout.write('\x1b[2J\x1b[HClaude Code\nSelect login method\n❯ 1. Claude account with subscription\n  2. Anthropic console\n');
    box(); return;
  }
  if (process.argv.includes('--board-probe') && (first.startsWith('BOARD ') || first.startsWith('BOARD-NO-ENV '))) {
    const fallback = first.startsWith('BOARD-NO-ENV ');
    const args = JSON.parse(first.slice(fallback ? 13 : 6));
    const env = { ...process.env };
    if (fallback) for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
    const result = require('child_process').spawnSync(process.execPath, [process.env.AGENTDECK_BOARD_CLI, ...args], { env, encoding: 'utf8', timeout: 15000 });
    if (process.env.AGENTDECK_TEST_BOARD_RESULTS_FILE) require('fs').appendFileSync(process.env.AGENTDECK_TEST_BOARD_RESULTS_FILE, JSON.stringify({ colId: process.env.AGENTDECK_COL_ID, args, stdout: result.stdout, stderr: result.stderr, code: result.status }) + '\n');
    process.stdout.write('\x1b[2J\x1b[H\n⏺ BOARD RESULT\n' + (result.stdout || result.stderr || 'no result') + '\n');
    box(); return;
  }
  if (resetMenu) {
    resetMenu = false;
    process.stdout.write('\x1b[2J\x1b[H');
    if (first === 'y') { contextUsed = 0; process.stdout.write('OpenAI Codex (v0.160.0)\n'); }
    else process.stdout.write('Cancelled\n');
    box(); return;
  }
  if (/^\/(?:clear|new|reset)(?:\s|$)/.test(first) && process.argv.includes('--manual-reset')) {
    process.stdout.write('\x1b[2J\x1b[H');
    if (process.argv.includes('--reset-redraw')) { process.stdout.write(codex ? 'OpenAI Codex (v0.160.0)\n' : 'Claude Code v2.1.0\n'); box(); return; }
    if (process.argv.includes('--reset-fail')) { process.stdout.write('Failed to start new session\n'); box(); return; }
    if (first === '/new' && process.argv.includes('--reset-menu')) {
      resetMenu = true; process.stdout.write('Do you trust the contents of this directory? (y/n)\n'); return;
    }
    contextUsed = codex ? 0 : 23000;
    process.stdout.write(codex ? 'OpenAI Codex (v0.160.0)\n' : process.argv.includes('--no-content-reset') ? '⏺ (no content)\n' : '⏺ Conversation cleared\n');
    box(); return;
  }
  if (first.startsWith('/model ')) model = first.slice(7).trim();
  if (first.startsWith('/context ')) contextUsed = Number(first.slice(9));
  if (first === '/clear' && !process.argv.includes('--clear-no-reset')) contextUsed = 23000;
  if (/ask me/.test(text)) {
    // Redraw the confirmation like the other TUI replies. Raw input has no
    // console echo to separate this turn from the previous input box/footer.
    process.stdout.write('\x1b[2J\x1b[H> ' + first + '\n\nProceed with the change? (y/n) ');
    return;
  }
  if (process.argv.includes('--sleep-error')) {
    // The task turn is cut short by a sleep; only a later "接着做" gets through and submits.
    process.stdout.write('\x1b[2J\x1b[H> ' + first + '\n');
    if (first.startsWith('接着做')) {
      process.stdout.write('\n⏺ GOT carry on\n');
      require('child_process').execFile(process.execPath, [process.env.AGENTDECK_BOARD_CLI, 'complete', '--result', 'resumed after sleep'], () => {});
    } else process.stdout.write('\n  ⎿  API Error: Your computer went to sleep mid-response. Try again.\n');
    box(); return;
  }
  if (first === 'gemini confirmation regression') {
    process.stdout.write('\x1b[2J\x1b[HThinking: waiting for confirmation\n⠋ Working\nAntigravity\n');
    setTimeout(() => {
      process.stdout.write('\x1b[2J\x1b[H> ' + first + '\n⏺ GOT ' + first + '\n');
      box();
    }, 4500);
    return;
  }
  if (process.argv.includes('--suggestion') && text.includes('AgentDeck 约定')) {
    // The first task has to look busy long enough for one status tick, or the
    // later idle screen never counts as a finished turn. Follow-ups stay on
    // the suggestion prompt so a tell can land while it is showing.
    if (suggestion) {
      process.stdout.write('\x1b[2J\x1b[H');
      suggestionBox();
      return;
    }
    process.stdout.write('\x1b[2J\x1b[H✻ Doing…\n');
    setTimeout(() => {
      process.stdout.write('\x1b[2J\x1b[H');
      armSuggestion();
    }, 2200);
    return;
  }
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write('> ' + first + '\n'); // keep the submitted prompt above its reply
  if (first === 'empty reply regression') { box(); return; }
  if ((process.argv.includes('--interruptible') || process.argv.includes('--quota-probe')) && /keep working|wait for quota/.test(first)) {
    process.stdout.write(first.includes('quota') ? "You've hit your limit · resets 5pm (America/Los_Angeles)\n" : '✻ Doing…\nPress up to edit queued messages\n');
    box();
    return;
  }
  if (process.argv.includes('--token-saver') && first.startsWith('把当前进度写进')) {
    if (process.env.AGENTDECK_TEST_BOARD_FILE && !process.argv.includes('--archive-fail')) require('fs').writeFileSync(process.env.AGENTDECK_TEST_BOARD_FILE, '# Test board\nProgress archived\n');
    process.stdout.write('\n⏺ ' + (process.argv.includes('--archive-fail') ? '存档失败' : '已存档') + '\n');
    box();
    return;
  }
  if (first.startsWith('work with tools')) {
    // Claude Code shape: tool calls and a note before the final markdown reply.
    const doc = process.env.AGENTDECK_DEMO_FILE || '/tmp/note.md';
    process.stdout.write('\n⏺ Reading the plan first.\n⏺ Update(notes/plan.md)\n  ⎿  Added 12 lines, removed 3 lines\n' +
      '⏺ Write(' + doc + ')\n  ⎿  Wrote 140 lines to ' + doc + '\n⏺ Bash(npm test)\n  ⎿  254 passing\n' +
      '⏺ **Done with tools.** Preview at https://example.com/docs/page and the notes in ' + doc + '\n\n  > quoted line\n\n  ```js\n  const answer = 42;\n  ```\n');
    box();
    return;
  }
  let out = '\n⏺ GOT ' + first.slice(-40) + '\n  wrote ' + process.env.AGENTDECK_DEMO_FILE + '\n';
  if (text.includes('AgentDeck 约定') && !process.argv.includes('--screen-only')) {
    const args = [process.env.AGENTDECK_BOARD_CLI, 'complete', '--result', 'stand-in finished ' + first.slice(0, 30)];
    if (process.env.AGENTDECK_DEMO_FILE) args.push('--files', process.env.AGENTDECK_DEMO_FILE);
    require('child_process').execFile(process.execPath, args, (error, stdout, stderr) => {
      if (process.env.AGENTDECK_TEST_RECEIPTS_FILE) require('fs').appendFileSync(process.env.AGENTDECK_TEST_RECEIPTS_FILE,
        JSON.stringify({ colId: process.env.AGENTDECK_COL_ID, code: error?.code || 0, stdout, stderr }) + '\n');
      if (error) process.stderr.write('Receipt submission failed\n');
    });
  }
  if (process.argv.includes('--screen-only')) out += '\n  【回执】\n  摘要：screen template must be ignored\n  文件：无\n';
  process.stdout.write(out);
  if (captainStatusline) process.stdout.write('Delegate report:\nGPT-6.1-Sol high · ~\nModel: gpt-6-luna\nModel: claude-sonnet-5-5\n');
  box();
  if (text.includes('AgentDeck 约定') && process.argv.includes('--exit-after-task')) setTimeout(() => process.exit(7), 500);
}
function listen() {
  // Raw PTY chunks can split a UTF-8 character; decode the stream across chunks.
  process.stdin.setEncoding('utf8');
  if (process.argv.includes('--interruptible')) {
    process.stdin.setRawMode(true);
    let incoming = '';
    process.stdin.on('data', (data) => {
      for (const ch of data.toString()) {
        if (ch === '\x1b') {
          incoming = ''; lines = []; clearTimeout(timer);
          process.stdout.write('\x1b[2J\x1b[HInterrupted by Esc\n');
          box();
        } else if (ch === '\x15') {
          incoming = '';
        } else if (ch === '\r' || ch === '\n') {
          if (!incoming && !lines.length) continue;
          lines.push(incoming); incoming = '';
          clearTimeout(timer); timer = setTimeout(answer, 250);
        } else incoming += ch;
      }
    });
  } else if (process.argv.includes('--slow-paste') || process.argv.includes('--image-paste')) {
    // Emulate Cursor's async paste handling: an early Enter is consumed by the
    // paste detector. No reply is emitted until a later Enter submits the buffer.
    // --image-paste is Claude Code reading a pasted image path: the footer says "Pasting…" and nothing
    // else is drawn for a while, then the attachment is ready. An Enter before that is dropped too.
    const imagePaste = process.argv.includes('--image-paste');
    process.stdout.write('\x1b[?2004h');
    process.stdin.setRawMode(true);
    let incoming = '';
    let pasted = '';
    let ready = false;
    process.stdin.on('data', (data) => {
      incoming += data.toString();
      const end = incoming.indexOf('\x1b[201~');
      if (end >= 0) {
        pasted = incoming.slice(incoming.indexOf('\x1b[200~') + 6, end);
        incoming = incoming.slice(end + 6);
        ready = false;
        if (imagePaste) process.stdout.write('\nPasting…');
        setTimeout(() => {
          ready = true;
          process.stdout.write(imagePaste ? '\r\x1b[2K[Image #1] attached\n' : '\nPaste ready\n');   // the footer is redrawn in place
        }, imagePaste ? 1800 : 450);
      }
      if (incoming.includes('\r')) {
        incoming = '';
        if (!ready) { process.stdout.write('\nEnter consumed by paste detector\n'); return; }
        lines = pasted.split('\n');
        pasted = '';
        ready = false;
        answer();
      }
      if (incoming.includes('\x03')) process.exit(0);
    });
  } else {
    // Real agent TUIs disable the console's cooked input/echo. In ConPTY the
    // cooked echo otherwise scrolls long Captain briefings through the screen
    // and leaves them in later replies even after the stand-in redraws.
    // No output stream: readline handles raw editing keys without echoing them.
    readline.createInterface({ input: process.stdin, terminal: true }).on('line', (line) => {
      if (!line.trim() && !lines.length) return;
      lines.push(line);
      clearTimeout(timer);
      timer = setTimeout(answer, 250);
    }).on('SIGINT', () => process.exit(0));
  }
}
function start() {
  if (delayedStart) process.stdout.write('\x1b[?1049h');
  console.log('Welcome to ' + (codex ? 'Codex' : provider) + ' (test stand-in)');
  if (process.argv.includes('--quota-on-start')) console.log("You've hit your usage limit · resets 5pm");
  box();
  listen();
}
// --claude-trust-menu: Claude Code's folder-trust menu. The cursor starts on "No, exit"; only arrow keys
// move it, Enter on the second row trusts, and Enter on the first row, a digit or y all end the session.
if (process.argv.includes('--claude-trust-menu')) {
  let row = 0;
  const draw = () => process.stdout.write('\x1b[2J\x1b[H Accessing workspace:\n\n Quick safety check: Is this a project you created or one you trust?\n\n ' +
    ['No, exit', 'Yes, I trust this folder'].map((label, i) => (i === row ? '❯ ' : '  ') + label).join('\n ') + '\n\n Enter to confirm · Esc to cancel\n');
  draw();
  process.stdin.setRawMode(true);
  // a PTY may deliver several keys in one chunk: take them one at a time
  const menuKey = (data) => {
    for (const key of String(data).match(/\x1b\[[AB]|\x1bO[AB]|[^]/g) || []) {
      if (key === '\x1b[B' || key === '\x1bOB') { row = 1; draw(); }
      else if (key === '\x1b[A' || key === '\x1bOA') { row = 0; draw(); }
      else if (key === '\r' && row === 1) {
        process.stdin.setRawMode(false); process.stdin.removeListener('data', menuKey); process.stdin.pause(); process.stdout.write('\x1b[2J\x1b[H'); start(); return;
      } else if (key === '\r' || /^[1-9yn]$/.test(key)) process.exit(1);
    }
  };
  process.stdin.on('data', menuKey);
} else if (process.argv.includes('--trust-dialog')) {
  // like Cursor in a folder it has not seen, a dialog comes first and nothing is accepted until Enter picks "Trust this workspace"
  process.stdout.write('Do you trust the contents of this directory?\n  ▶ [a] Trust this workspace\n    [q] Quit\n  Use arrow keys to navigate, Enter to select\n');
  process.stdin.setRawMode(true);
  const confirmTrust = (data) => {
    if (!data.includes('\r') && !data.includes('\n')) return;
    process.stdin.setRawMode(false); process.stdin.removeListener('data', confirmTrust); process.stdin.pause(); process.stdout.write('\x1b[2J\x1b[H'); start();
  };
  process.stdin.on('data', confirmTrust);
} else if (delayedStart) setTimeout(start, 6000);
else start();
