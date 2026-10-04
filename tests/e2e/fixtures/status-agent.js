// Silent TUI stand-in: holds a busy indicator above a tall footer until the
// next explicit prompt completes it. Never starts a real agent or child test.
const readline = require('readline');
const markers = {
  codex: '◦ Working (11m 27s • esc to interrupt) · 1 background terminal',
  claude: '✻ Contemplating… (11m 27s · esc to interrupt · ↓ 1.2k tokens)',
  agy: 'Searching… (11m 27s · esc to cancel)',
  cursor: '⠋ Thinking…',
};
function draw(marker) {
  const bottom = Math.max(8, (process.stdout.rows || 24) - 4);
  process.stdout.write('\x1b[2J\x1b[H' + marker + '\r\n');
  process.stdout.write(`\x1b[${bottom};1H` + '─'.repeat(30) + '\r\n❯\r\n' + '─'.repeat(30) + '\r\nClaude Code');
}
let lines = [], timer;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  lines.push(line);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const text = lines.join('\n'); lines = [];
    const provider = /busy (codex|claude|agy|cursor)/.exec(text)?.[1];
    draw(provider ? markers[provider] : '⏺ Finished. Working indicator removed.');
  }, 250);
});
draw('Status stand-in ready');
