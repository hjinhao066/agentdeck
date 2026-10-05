// Silent TUI stand-in: holds a busy indicator above a tall footer until the
// next explicit prompt completes it. Never starts a real agent or child test.
process.stdout.write('\x1b[?2004h');
// ConPTY must deliver input without cooked-mode echo/redraws obscuring the TUI.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const markers = {
  codex: '◦ Working (11m 27s • esc to interrupt) · 1 background terminal',
  claude: '✻ Contemplating… (11m 27s · esc to interrupt · ↓ 1.2k tokens)',
  agy: 'Searching… (11m 27s · esc to cancel)',
  cursor: '⠰⠳ Grepping  32.91k tokens',
};
let lastProvider = '';
function draw(marker, rows = process.stdout.rows || 24, cursorBusy = false) {
  const bottom = Math.max(8, rows - 4);
  process.stdout.write('\x1b[2J\x1b[H' + marker + '\r\n');
  const prompt = lastProvider === 'cursor' ? '→ Add a follow-up' + (cursorBusy ? '              ctrl+c to stop' : '') : '❯';
  process.stdout.write(`\x1b[${bottom};1H` + '─'.repeat(30) + '\r\n' + prompt + '\r\n' + '─'.repeat(30) + '\r\n' + (lastProvider === 'cursor' ? 'Composer' : 'Claude Code'));
}
let incoming = '', pasted = '', lines = [], timer;
process.stdin.on('data', (data) => {
  incoming += data.toString();
  const start = incoming.indexOf('\x1b[200~');
  if (start >= 0) {
    const end = incoming.indexOf('\x1b[201~', start);
    if (end < 0) return;
    pasted = incoming.slice(start + 6, end);
    incoming = incoming.slice(end + 6);
  }
  if (!/[\r\n]/.test(incoming)) return;
  const rows = incoming.split(/\r\n|[\r\n]/);
  incoming = rows.pop();
  lines.push(pasted || rows.join('\n')); pasted = '';
  if (!lines.some((line) => line.trim())) { lines = []; return; }
  clearTimeout(timer);
  timer = setTimeout(() => {
    const text = lines.join('\n'); lines = [];
    const provider = /busy (codex|claude|agy|cursor)/.exec(text)?.[1];
    if (/ordinary resource text/.test(text)) {
      lastProvider = '';
      draw('Rate limit handling test fails in api.js\r\nUnauthorized access test still failing\r\nLimit reached check broken');
      return;
    }
    if (/silent startup/.test(text)) { process.stdout.write('\x1b[2J\x1b[H'); return; }
    if (provider) lastProvider = provider;
    // Windows Node may retain the original stdout.rows after a PTY resize.
    // The test supplies the intended height for its tall-screen scenario.
    const rows = /\brows=(\d+)\b/.exec(text)?.[1];
    draw(provider ? markers[provider] : '⏺ Finished. Working indicator removed.', rows ? Number(rows) : undefined, provider === 'cursor' && !/\bno-stop\b/.test(text));
  }, 250);
});
draw('Status stand-in ready');
