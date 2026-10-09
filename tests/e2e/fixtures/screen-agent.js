// Stand-in for an agent TUI that draws one fixed screen per column and then idles: the column's
// rows come from a JSON file (argv[2]) keyed by AGENTDECK_COL_ID, shaped like Claude Code (or
// Codex): a heading, the prompt, the rows, the ruled input box and the status lines under it.
// Used where a test needs a terminal to show something particular, such as a CLI update notice.
const fs = require('fs');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[process.env.AGENTDECK_COL_ID] || {};
const codex = spec.provider === 'Codex';
process.stdout.write('\x1b[?1049h');
process.on('exit', () => process.stdout.write('\x1b[?1049l'));
function draw() {
  process.stdout.write('\x1b[2J\x1b[H' + (codex ? 'OpenAI Codex (v0.160.0)' : 'Claude Code v2.1.0') + '\n\n');
  if (spec.title) process.stdout.write('> ' + spec.title + '\n\n');
  for (const row of spec.screen || []) process.stdout.write(row + '\n');
  const w = Math.max(20, Math.min(60, (process.stdout.columns || 80) - 2));
  process.stdout.write('\n' + '─'.repeat(w) + '\n> \n' + '─'.repeat(w) + '\n');
  process.stdout.write('\x1b[33mContext: 23%\x1b[0m | \x1b[31mSession: 26.0%\x1b[0m\n');
  process.stdout.write('\x1b[36mModel: ' + (spec.model || 'Opus 5.5') + ' | Weekly Reset: 16hr\x1b[0m\n');
  process.stdout.write('\x1b[35m⏵⏵ bypass permissions on\x1b[0m (shift+tab to cycle)\n');
  process.stdout.write((codex ? 'OpenAI Codex' : 'Claude Code') + '\n');
}
draw();
process.stdout.on('resize', draw);
process.stdin.resume();
process.stdin.on('data', () => {});
