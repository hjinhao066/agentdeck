// A full-screen stand-in whose footer is always on the PTY's final row.
const fs = require('fs');
const path = require('path');

function draw() {
  const rows = process.stdout.rows, cols = process.stdout.columns;
  fs.writeFileSync(path.join(process.cwd(), `${process.env.AGENTDECK_COL_ID}.size.json`), JSON.stringify({ rows, cols }));
  let screen = '\x1b[?1049h\x1b[2J\x1b[HClaude Code (terminal geometry stand-in)';
  const lines = ['─'.repeat(Math.min(cols, 65)), '❯ ', '─'.repeat(Math.min(cols, 65)),
    'Opus 5.5 · high · think · 5h 90% · 7d 90%', '16% 156k/1M',
    '⏵⏵ bypass permissions on (shift+tab to cycle)'];
  lines.forEach((line, i) => { screen += `\x1b[${rows - lines.length + i + 1};1H${line}`; });
  process.stdout.write(screen);
}
process.stdout.on('resize', draw);
// Node on Windows does not receive SIGWINCH; refresh the actual ConPTY size
// so the existing resize event redraws the stand-in after a native resize.
if (process.platform === 'win32') setInterval(() => process.stdout._refreshSize(), 100);
process.stdin.on('data', draw);
draw();
