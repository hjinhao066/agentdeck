// Stand-in for an agent TUI (Claude Code shape): replies with a bullet, then
// redraws an input box between two rules with colored status lines below it.
// Lines arriving together (a multi-line prompt) are answered once. A prompt
// carrying the AgentDeck receipt contract gets a 【回执】 block back; "ask me"
// makes it stop at a y/n question like a permission prompt.
const readline = require('readline');
function box() {
  const w = Math.max(20, Math.min(60, (process.stdout.columns || 80) - 2));
  process.stdout.write('\n' + '─'.repeat(w) + '\n> \n' + '─'.repeat(w) + '\n');
  process.stdout.write('\x1b[33mContext: 23%\x1b[0m | \x1b[31mSession: 26.0%\x1b[0m\n');
  process.stdout.write('\x1b[36mModel: Fake | Weekly Reset: 16hr\x1b[0m\n');
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
  if (/ask me/.test(text)) { process.stdout.write('\nProceed with the change? (y/n) '); return; }
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
