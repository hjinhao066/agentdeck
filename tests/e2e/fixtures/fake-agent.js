// Stand-in for an agent TUI (Claude Code shape): replies with a bullet, then
// redraws an input box between two rules with colored status lines below it.
// Lines arriving together (a multi-line prompt) are answered once. A prompt
// carrying the AgentDeck receipt contract gets a 【回执】 block back; "ask me"
// makes it stop at a y/n question like a permission prompt.
const readline = require('readline');
const provider = process.argv.includes('--provider=codex') ? 'Codex CLI' : 'Claude Code';
if (process.env.AGENTDECK_TEST_SEATS_ENV_FILE) {
  require('fs').appendFileSync(process.env.AGENTDECK_TEST_SEATS_ENV_FILE, JSON.stringify({
    colId: process.env.AGENTDECK_COL_ID, configDir: process.env.CLAUDE_CONFIG_DIR || null,
    authOverridePresent: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'].some((key) => !!process.env[key]),
  }) + '\n');
}
if (process.env.AGENTDECK_TEST_CONTROL_ENV_FILE && process.env.AGENTDECK_CONTROL_TOKEN) {
  require('fs').writeFileSync(process.env.AGENTDECK_TEST_CONTROL_ENV_FILE, JSON.stringify({
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
process.stdout.write('\x1b[?1049h');
process.on('exit', () => process.stdout.write('\x1b[?1049l'));
let model = 'Fake';
function box() {
  const w = Math.max(20, Math.min(60, (process.stdout.columns || 80) - 2));
  process.stdout.write('\n' + '─'.repeat(w) + '\n> \n' + '─'.repeat(w) + '\n');
  const extra = process.env.AGENTDECK_TEST_LONG_STATUS ? ' | Total: 211.5M | Cost: $35.33 | Weekly: 13.0% | LastField: complete' : '';
  process.stdout.write('\x1b[33mContext: 23%\x1b[0m | \x1b[31mSession: 26.0%\x1b[0m' + extra + '\n');
  process.stdout.write('\x1b[36mModel: ' + model + ' | Weekly Reset: 16hr\x1b[0m\n');
  process.stdout.write('\x1b[35m⏵⏵ bypass permissions on\x1b[0m (shift+tab to cycle)\n');
  // Keep a recognizable provider footer after replies, like a real TUI. Narrow
  // ConPTY columns can wrap the longer permission line across several rows.
  process.stdout.write(provider + '\n');
}
let lines = [];
let timer = null;
function answer() {
  const text = lines.join('\n');
  lines = [];
  // Test-only capture verifies delivery before ConPTY wraps/redraws the screen.
  if (process.env.AGENTDECK_TEST_PROMPTS_FILE) require('fs').appendFileSync(process.env.AGENTDECK_TEST_PROMPTS_FILE, JSON.stringify(text) + '\n');
  const first = (text.split('\n').find((l) => l.trim()) || '').trim();
  if (process.argv.includes('--board-probe') && first.startsWith('BOARD ')) {
    const args = JSON.parse(first.slice(6));
    const result = require('child_process').spawnSync(process.execPath, [process.env.AGENTDECK_BOARD_CLI, ...args], { encoding: 'utf8', timeout: 15000 });
    process.stdout.write('\x1b[2J\x1b[H\n⏺ BOARD RESULT\n' + (result.stdout || result.stderr || 'no result') + '\n');
    box(); return;
  }
  if (first.startsWith('/model ')) model = first.slice(7).trim();
  if (/ask me/.test(text)) { process.stdout.write('\nProceed with the change? (y/n) '); return; }
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write('> ' + first + '\n'); // keep the submitted prompt above its reply
  if ((process.argv.includes('--interruptible') || process.argv.includes('--quota-probe')) && /keep working|wait for quota/.test(first)) {
    process.stdout.write(first.includes('quota') ? "You've hit your limit · resets 5pm (America/Los_Angeles)\n" : '✻ Doing…\nPress up to edit queued messages\n');
    box();
    return;
  }
  let out = '\n⏺ GOT ' + first.slice(-40) + '\n  wrote ' + process.env.AGENTDECK_DEMO_FILE + '\n';
  if (text.includes('AgentDeck 约定')) out += '\n  【回执】\n  摘要：stand-in finished ' + first.slice(0, 30) + '\n  文件：' + process.env.AGENTDECK_DEMO_FILE + '\n';
  process.stdout.write(out);
  box();
}
function listen() {
  if (process.argv.includes('--interruptible')) {
    process.stdin.setRawMode(true);
    let incoming = '';
    process.stdin.on('data', (data) => {
      for (const ch of data.toString()) {
        if (ch === '\x1b') {
          incoming = ''; lines = []; clearTimeout(timer);
          process.stdout.write('\x1b[2J\x1b[HInterrupted by Esc\n');
          box();
        } else if (ch === '\r' || ch === '\n') {
          if (!incoming && !lines.length) continue;
          lines.push(incoming); incoming = '';
          clearTimeout(timer); timer = setTimeout(answer, 250);
        } else incoming += ch;
      }
    });
  } else if (process.argv.includes('--slow-paste')) {
    // Emulate Cursor's async paste handling: an early Enter is consumed by the
    // paste detector. No reply is emitted until a later Enter submits the buffer.
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
        setTimeout(() => {
          ready = true;
          process.stdout.write('\nPaste ready\n');
        }, 450);
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
  } else readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim() && !lines.length) return;
    lines.push(line);
    clearTimeout(timer);
    timer = setTimeout(answer, 250);
  });
}
function start() {
  console.log('Welcome to ' + provider + ' (test stand-in)');
  box();
  listen();
}
// --trust-dialog: like Cursor in a folder it has not seen, a dialog comes first and
// nothing is accepted until Enter picks "Trust this workspace".
if (process.argv.includes('--trust-dialog')) {
  process.stdout.write('Do you trust the contents of this directory?\n  ▶ [a] Trust this workspace\n    [q] Quit\n  Use arrow keys to navigate, Enter to select\n');
  process.stdin.setRawMode(true);
  process.stdin.once('data', () => { process.stdin.setRawMode(false); process.stdin.removeAllListeners('data'); process.stdin.pause(); process.stdout.write('\x1b[2J\x1b[H'); start(); });
} else start();
