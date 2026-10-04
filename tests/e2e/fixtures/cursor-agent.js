// Stand-in for the Cursor CLI TUI: enables bracketed paste, then shows its idle
// screen word-wrapped to the terminal width, the way the real one does (a
// 30-column terminal splits "Plan, search, build anything" over two rows).
// With --busy a spinner row sits above the prompt and nothing may be sent.
// A pasted message followed by Enter is answered with "GOT: <message>".
const wrap = (text, width) => {
  const rows = [];
  let row = '';
  for (const word of text.split(' ')) {
    if (row && row.length + 1 + word.length > width) { rows.push(row); row = word; }
    else row = row ? row + ' ' + word : word;
  }
  return rows.concat(row);
};
const width = Math.max(10, (process.stdout.columns || 80) - 4);
const indent = (rows) => rows.map((r) => '  ' + r).join('\n');
process.stdout.write('\x1b[?2004h');
process.stdout.write('\n' + indent(['Cursor Agent', 'v0.0.0-test']) + '\n\n');
// --busy: a tool is running above the (wrapped) prompt
if (process.argv.includes('--busy')) process.stdout.write('  \u280b Reading\u2026\n\n');
// the real prompt row continues two columns further in, under the text after the arrow
process.stdout.write(indent(wrap('→ Plan, search, build anything', width)).replace(/\n  (?=\S)/g, '\n    ') + '\n\n');
process.stdout.write(indent(wrap('Claude Opus 5.5 300K High   Run Everything', width)) + '\n  ~\n');
let pasted = '';
let inPaste = false;
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  let data = String(chunk);
  if (data.includes('\x1b[200~')) { inPaste = true; data = data.replace('\x1b[200~', ''); }
  if (inPaste) {
    const end = data.indexOf('\x1b[201~');
    pasted += end < 0 ? data : data.slice(0, end);
    if (end >= 0) inPaste = false;
    return;
  }
  if (data.includes('\r') && pasted) {
    process.stdout.write('\nGOT: ' + pasted.replace(/\s+/g, ' ').slice(0, 60) + '\n');
    pasted = '';
  }
});
setInterval(() => {}, 1 << 30);
