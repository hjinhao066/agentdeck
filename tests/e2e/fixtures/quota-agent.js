// Offline TUI stand-in. No real CLI, provider request or credential access.
const readline = require('readline');
const provider = process.argv[2];
const west = process.argv[3] === 'cn';
let westData = false, statusline = false;
let claudeRemaining = null;
process.stdout.write('\x1b[?1049h');
function draw(exhausted = false, suffix = '', otherModel = false) {
  process.stdout.write('\x1b[2J\x1b[H');
  const headings = { Claude: 'Claude Code', Codex: 'OpenAI Codex', Cursor: 'Cursor Agent', Antigravity: 'AGY CLI' };
  process.stdout.write(headings[provider] + '\n');
  if (exhausted) process.stdout.write((provider === 'Antigravity' ? 'Individual quota reached\nResets in 2h 30m' : 'Error: You have exceeded your usage limit. Resets in 1h') + '\n' + suffix);
  process.stdout.write('\n' + '─'.repeat(50) + '\n> \n' + '─'.repeat(50) + '\n');
  // Per-session statusline, rendered from this session own rate_limits.
  if (provider === 'Claude' && (statusline || claudeRemaining !== null)) process.stdout.write(`Opus 5.5 · high   5h剩余 ${claudeRemaining ?? 83}% · 7d剩余 ${claudeRemaining !== null ? 1 : 59}%\n`);
  if (provider === 'Claude' && claudeRemaining !== null) process.stdout.write(`Session: ${100 - claudeRemaining}% | Reset: 1h\nWeekly: 99% | Weekly Reset: 4d\n`);
  else if (provider === 'Claude' && (!west || westData)) process.stdout.write(west ? 'Session: 35% | Reset: 1h\nWeekly: 70% | Weekly Reset: 4d\n' : 'Context: 99% | Session: 81% | Reset: 2hr 10m\nWeekly: 9% | Weekly Reset: 3d\n');
  if (provider === 'Codex') process.stdout.write('5-hour limit: 8% left (resets 23:59)\nWeekly limit: 60% left (resets 2026-10-07T10:00:00Z)\n');
  const models = { Claude: 'claude-opus-5-5-high', Codex: 'gpt-6.1-sol', Cursor: 'grok-4.7-high-fast', Antigravity: 'gemini-3.8-flash-high' };
  process.stdout.write('Model: ' + (otherModel ? 'claude-opus-5-5-high' : models[provider]) + '\n' + headings[provider] + '\n');
}
draw();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'statusline') statusline = true;
  if (line === 'quota-data') westData = true;
  if (/^remaining:\d+$/.test(line)) claudeRemaining = Number(line.split(':')[1]);
  draw(line.startsWith('exhausted') || line === 'claude-exhausted', line === 'exhausted-redraw' ? 'unrelated redraw\n' : '', line === 'claude-exhausted');
});
