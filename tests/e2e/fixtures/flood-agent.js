// Stand-in for a busy agent CLI, for terminal performance tests; no real agent.
// Prints FLOOD_LINES lines of agent-like output (colour, 中文, long rows that
// wrap, now and then a tool result thousands of characters long) as fast as the pty takes them, then keeps a status line ticking the way
// an agent's TUI does while it works (one redraw every FLOOD_TICK_MS). On a change of
// terminal size it redraws the visible screen the way Claude Code 2.1 does (home, erase
// every row, paint the rows again); FLOOD_REPRINT=full instead clears the scrollback and
// prints the whole transcript again, 0 does nothing. Every size it sees is logged to
// FLOOD_SIZES (a file) when set.
const lines = Number(process.env.FLOOD_LINES || 30000);
const tick = Number(process.env.FLOOD_TICK_MS || 100);
const words = ['Read', 'Edit', 'Bash', 'Grep', '读取文件', '修改代码', '运行测试', 'src/renderer/terminal-view.js:1204', 'https://example.com/docs/page'];
// a tool result printed as one long line (minified JSON with paths, dotted versions, a token)
const long = (i) => '{"files":[' + Array.from({ length: 60 }, (_, k) => `"src/mod${k}/file-${i}.v${k}.2.js:${k}"`).join(',') + '],"token":"' + 'eyJhbGciOi.'.repeat(300) + '"}';
function line(i) {
  if (i % 1000 === 500) return `${long(i)} FLOOD_${String(i).padStart(6, '0')}`;
  const w = words[i % words.length];
  const n = String(i).padStart(6, '0');
  if (i % 7 === 0) return `\x1b[1;36m⏺ ${w}\x1b[0m(\x1b[2m${'x'.repeat(40 + (i % 160))}\x1b[0m) FLOOD_${n}`;
  if (i % 5 === 0) return `  ⎿  \x1b[32m${w} 完成\x1b[0m，共 ${i % 97} 处改动 FLOOD_${n}`;
  return `\x1b[38;5;${16 + (i % 200)}m${w}\x1b[0m line FLOOD_${n} ${'·'.repeat(i % 60)}`;
}
const fs = require('fs');
let i = 0, s = 0, ticker = null, reprints = 0;
function pump() {
  let chunk = '';
  while (i < lines && chunk.length < 64 * 1024) chunk += line(++i) + '\r\n';
  const more = process.stdout.write(chunk);
  if (i < lines) { if (more) setImmediate(pump); else process.stdout.once('drain', pump); return; }
  process.stdout.write(`FLOOD_DONE${reprints ? ' ' + reprints : ''}\r\n`);
  ticker = ticker || setInterval(() => {
    s++;
    process.stdout.write(`\r\x1b[2K\x1b[33m✻ Working… (${s}s · esc to interrupt)\x1b[0m`);
  }, tick);
}
pump();
process.stdout.on('resize', () => {
  if (process.env.FLOOD_SIZES) fs.appendFileSync(process.env.FLOOD_SIZES, `${process.pid} ${process.stdout.columns}x${process.stdout.rows}\n`);
  if (process.env.FLOOD_REPRINT === '0') return;
  if (process.env.FLOOD_REPRINT !== 'full') {
    const rows = process.stdout.rows || 24;
    let out = '\x1b[H' + '\x1b[2K\x1b[1B'.repeat(rows) + '\x1b[H';
    for (let k = Math.max(1, i - rows + 2); k <= i; k++) out += line(k) + '\r\n';
    process.stdout.write(out + `\x1b[33m✻ Working… (${s}s · esc to interrupt)\x1b[0m`);
    return;
  }
  const wasDone = i >= lines;
  reprints++;
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  i = 0;
  if (wasDone) pump();   // a pump still running carries on from the top
});
process.stdin.resume();
