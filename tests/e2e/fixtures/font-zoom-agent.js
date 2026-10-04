// Full-screen stand-in. The footer is always on the PTY's last row, and the
// size file is the size the PTY actually received.
const fs = require('fs');
const path = require('path');

function draw() {
  const rows = process.stdout.rows, cols = process.stdout.columns;
  fs.writeFileSync(path.join(process.cwd(), `${process.env.AGENTDECK_COL_ID}.size.json`), JSON.stringify({ rows, cols }));
  let screen = '\x1b[?1049h\x1b[2J\x1b[HClaude Code (font zoom stand-in)';
  const fit = (line) => Array.from(line).slice(0, Math.max(1, cols)).join('');
  const lines = ['─'.repeat(Math.min(cols, 40)), '❯ ', '─'.repeat(Math.min(cols, 40)),
    'Opus 5.5', '16% 156k/1M', 'ROW-END'].map(fit);
  lines.forEach((line, i) => { screen += `\x1b[${rows - lines.length + i + 1};1H${line}`; });
  process.stdout.write(screen);
}
process.stdout.on('resize', draw);
process.stdin.on('data', draw);
draw();
