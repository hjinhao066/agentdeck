// A full-screen stand-in whose footer is always on the PTY's final row.
const fs = require('fs');
const path = require('path');

let previousSize, activeOutput, enteredAlternate = false;
function size() {
  if (process.platform !== 'win32') return process.stdout;
  // Open the active buffer once after entering the alternate screen. Keep the
  // handle alive; repeatedly closing tty streams can crash Windows conhost.
  if (!previousSize) return process.stdout;
  activeOutput ||= new (require('tty').WriteStream)(fs.openSync('\\\\.\\CONOUT$', 'r+'));
  activeOutput._refreshSize();
  return activeOutput;
}
function draw(current = size()) {
  const rows = current.rows, cols = current.columns;
  previousSize = { rows, columns: cols };
  fs.writeFileSync(path.join(process.cwd(), `${process.env.AGENTDECK_COL_ID}.size.json`), JSON.stringify({ rows, cols }));
  // Windows replaces the alternate buffer on every 1049h; enter it once,
  // then repaint it without invalidating the active console handle.
  let screen = (process.platform === 'win32' && enteredAlternate ? '' : '\x1b[?1049h')
    + '\x1b[2J\x1b[HClaude Code (terminal geometry stand-in)';
  enteredAlternate = true;
  const lines = ['─'.repeat(Math.min(cols, 65)), '❯ ', '─'.repeat(Math.min(cols, 65)),
    'Opus 5.5 · high · think · 5h 90% · 7d 90%', '16% 156k/1M',
    '⏵⏵ bypass permissions on (shift+tab to cycle)'];
  lines.forEach((line, i) => { screen += `\x1b[${rows - lines.length + i + 1};1H${line}`; });
  process.stdout.write(screen);
}
process.stdout.on('resize', () => draw());
// Poll the active ConPTY screen buffer on Windows; Node does not receive
// SIGWINCH there and stdout can retain the inactive buffer dimensions.
if (process.platform === 'win32') setInterval(() => {
  const current = size();
  if (current.rows !== previousSize.rows || current.columns !== previousSize.columns) draw(current);
}, 100);
process.stdin.on('data', () => draw());
draw();
