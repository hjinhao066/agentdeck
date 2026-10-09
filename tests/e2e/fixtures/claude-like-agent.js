// Stand-in that drives its terminal the way Claude Code 2.1 does inside AgentDeck, for
// performance tests; no real agent. Measured on the real CLI (2026-10-09, 2.1.295, with
// --dangerously-skip-permissions and a terminal that answers as xterm.js): it switches to
// the alternate screen with mouse reporting on (?1000/?1002/?1003/?1006, so every wheel
// tick and mouse move goes to the program), scrolls its own transcript on a wheel report
// and redraws the whole screen (3-4 KB, about 2 ms after the report when idle), ignores
// plain mouse moves, asks for the cursor position (ESC[?6n) 5 times a second, and while
// working redraws its status rows about 10 times a second (~130 bytes a frame) and turns
// the window-title spinner twice a second.
//   CLAUDE_LIKE_LINES  transcript lines (default 3000)
//   CLAUDE_LIKE_WORK   1 = working, 0 = idle
// Row 1 always reads "VIEW_TOP <n>", the first transcript line shown, so a test can tell
// which wheel report a frame answers. CLAUDE_LIKE_LOG (a file) gets one line per input
// chunk, in arrival order: "wheel", "paste", "enter" or "key", never the text itself.
const lines = Number(process.env.CLAUDE_LIKE_LINES || 3000);
const working = process.env.CLAUDE_LIKE_WORK !== '0';
const out = (s) => process.stdout.write(s);
let rows = process.stdout.rows || 40, cols = process.stdout.columns || 100;
const text = (i) => i % 9 === 0 ? `\x1b[1;36m⏺\x1b[0m Bash(npm test -- --grep case-${i})`
  : i % 4 === 0 ? `  ⎿  读取 src/module-${i % 37}/index.js，改动 ${i % 13} 处`
    : `回复第 ${i} 行：${'这是一段较长的说明文字，'.repeat(1 + (i % 5))}`;
const FOOT = 6;   // status, blank, rule, ❯ row, rule, hint: the rows under the transcript
let top = Math.max(1, lines - (rows - FOOT - 1) + 1), n = 0;
const spin = ['✻', '✳', '✢', '·', '✶', '✽'];
function status() {
  return `\x1b[${rows - FOOT + 1};1H\x1b[38;2;215;119;87m${spin[n % spin.length]}\x1b[39m Working… \x1b[2m(${Math.floor(n / 10)}s · ↓ ${n * 3} tokens · esc to interrupt)\x1b[22m\x1b[K`;
}
function screen() {
  let f = `\x1b[?25l\x1b[1;1H\x1b[7mVIEW_TOP ${top}\x1b[27m\x1b[K`;
  for (let r = 2; r <= rows - FOOT; r++) {
    const i = top + r - 2;
    f += `\x1b[${r};1H${i <= lines ? text(i).slice(0, cols) : ''}\x1b[K`;
  }
  // Claude Code's input box: a rule, the ❯ row, a rule, then the hint row
  const rule = `\x1b[2m${'─'.repeat(cols)}\x1b[22m`;
  f += status() + `\x1b[${rows - 3};1H${rule}\x1b[${rows - 2};1H❯ \x1b[K\x1b[${rows - 1};1H${rule}\x1b[${rows};1H\x1b[2m  ⏵⏵ bypass permissions on\x1b[22m\x1b[K`;
  out(f + `\x1b[${rows - 2};3H\x1b[?25h`);
}
// raw first: a focus or mouse report the tty would otherwise echo into the box
if (process.stdin.isTTY) process.stdin.setRawMode(true);
out('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[2J');
screen();
process.stdout.on('resize', () => { rows = process.stdout.rows || rows; cols = process.stdout.columns || cols; screen(); });
let pending = '';
const log = (what) => { if (process.env.CLAUDE_LIKE_LOG) require('fs').appendFileSync(process.env.CLAUDE_LIKE_LOG, `${Date.now()} ${what}\n`); };
process.stdin.on('data', (d) => {
  const raw = d.toString('latin1');
  if (raw.includes('\x1b[200~')) log('paste');
  else if (raw === '\r') log('enter');
  else if (!/^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\??[\d;]*[Rc]|\x1b\[[IO])+$/.test(raw)) log('key');
  pending += raw;
  let m, moved = false;
  const re = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
  while ((m = re.exec(pending))) {
    const b = Number(m[1]);
    if (b === 64 || b === 65) log('wheel');
    if (b === 64) { top = Math.max(1, top - 3); moved = true; }
    else if (b === 65) { top = Math.min(Math.max(1, lines - 5), top + 3); moved = true; }
  }
  const last = pending.lastIndexOf('\x1b');
  pending = last >= 0 && !/[Mm]/.test(pending.slice(last)) ? pending.slice(last) : '';
  if (moved) screen();
});
if (working) {
  setInterval(() => { n++; out(`\x1b[?25l${status()}\x1b[${rows - 2};3H\x1b[?25h`); }, 100);
  setInterval(() => out(`\x1b]0;${n % 2 ? '◐' : '◑'} stand-in task\x07`), 500);
}
setInterval(() => out('\x1b[?6n'), 200);
