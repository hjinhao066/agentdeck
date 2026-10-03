// Plain, deterministic PTY output for scroll/peek tests; no real agent CLI.
const readline = require('readline');
let row = 0;
function emit(count) {
  for (let i = 0; i < count; i++) process.stdout.write(`\x1b[32mLIVE_ROW_${String(++row).padStart(4, '0')}\x1b[0m\r\n`);
}
emit(100);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'alt') {
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[HALTERNATE_LIVE_SCREEN\r\n');
  } else if (line === 'normal') {
    process.stdout.write('\x1b[?1049l');
  } else if (/^emit \d+$/.test(line)) emit(Number(line.slice(5)));
});
