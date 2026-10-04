// Silent TUI stand-in: holds a busy indicator above a tall footer until the
// next explicit prompt completes it. Never starts a real agent or child test.
const readline = require('readline');
// ConPTY must deliver input without cooked-mode echo/redraws obscuring the TUI.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const markers = {
  codex: '◦ Working (11m 27s • esc to interrupt) · 1 background terminal',
  claude: '✻ Contemplating… (11m 27s · esc to interrupt · ↓ 1.2k tokens)',
  agy: 'Searching… (11m 27s · esc to cancel)',
  cursor: '⠋ Thinking…',
};
function draw(marker, rows = process.stdout.rows || 24) {
  const bottom = Math.max(8, rows - 4);
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
    // Windows Node may retain the original stdout.rows after a PTY resize.
    // The test supplies the intended height for its tall-screen scenario.
    const rows = /\brows=(\d+)\b/.exec(text)?.[1];
    draw(provider ? markers[provider] : '⏺ Finished. Working indicator removed.', rows ? Number(rows) : undefined);
  }, 250);
});
draw('Status stand-in ready');
