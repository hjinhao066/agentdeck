// Stand-in for an agent TUI (Claude Code shape): replies with a bullet, then
// redraws an input box between two rules with colored status lines below it.
// Lines arriving together (a multi-line prompt) are answered once. A prompt
// carrying the AgentDeck receipt contract gets a 【回执】 block back; "ask me"
// makes it stop at a y/n question like a permission prompt.
const readline = require('readline');
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
}
console.log('Welcome to Claude Code (test stand-in)');
box();
let lines = [];
let timer = null;
function answer() {
  const text = lines.join('\n');
  lines = [];
  // Test-only capture verifies delivery before ConPTY wraps/redraws the screen.
  if (process.env.AGENTDECK_TEST_PROMPTS_FILE) require('fs').appendFileSync(process.env.AGENTDECK_TEST_PROMPTS_FILE, JSON.stringify(text) + '\n');
  const first = (text.split('\n').find((l) => l.trim()) || '').trim();
  if (first.startsWith('/model ')) model = first.slice(7).trim();
  if (/ask me/.test(text)) { process.stdout.write('\nProceed with the change? (y/n) '); return; }
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write('> ' + first + '\n'); // keep the submitted prompt above its reply
  let out = '\n⏺ GOT ' + first.slice(-40) + '\n  wrote ' + process.env.AGENTDECK_DEMO_FILE + '\n';
  if (text.includes('AgentDeck 约定')) out += '\n  【回执】\n  摘要：stand-in finished ' + first.slice(0, 30) + '\n  文件：' + process.env.AGENTDECK_DEMO_FILE + '\n';
  process.stdout.write(out);
  box();
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim() && !lines.length) return;
  lines.push(line);
  clearTimeout(timer);
  timer = setTimeout(answer, 250);
});
