// Offline TUI stand-in. No real CLI, provider request or credential access.
const readline = require('readline');
const provider = process.argv[2];
process.stdout.write('\x1b[?1049h');
function draw(exhausted = false, suffix = '') {
  process.stdout.write('\x1b[2J\x1b[H');
  const headings = { Claude: 'Claude Code', Codex: 'OpenAI Codex', Cursor: 'Cursor Agent', Antigravity: 'AGY CLI' };
  process.stdout.write(headings[provider] + '\n');
  if (exhausted) process.stdout.write((provider === 'Antigravity' ? 'Individual quota reached\nResets in 2h 30m' : 'Error: You have exceeded your usage limit. Resets in 1h') + '\n' + suffix);
  process.stdout.write('\n' + '─'.repeat(50) + '\n> \n' + '─'.repeat(50) + '\n');
  if (provider === 'Claude') process.stdout.write('Context: 99% | Session: 81% | Reset: 2hr 10m\nWeekly: 9% | Weekly Reset: 3d\n');
  if (provider === 'Codex') process.stdout.write('5-hour limit: 8% left (resets 23:59)\nWeekly limit: 60% left (resets 2026-10-07T10:00:00Z)\n');
  process.stdout.write(headings[provider] + '\n');
}
draw();
readline.createInterface({ input: process.stdin }).on('line', (line) => draw(line.startsWith('exhausted'), line === 'exhausted-redraw' ? 'unrelated redraw\n' : ''));
