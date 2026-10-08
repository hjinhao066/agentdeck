// Stand-in for a TUI that asks for bracketed paste (as Claude Code and Codex
// do) and writes down every byte that reaches its stdin, untouched. One record
// per burst of input: the paste and the Enter that follows it. The screen is
// only what AgentDeck needs to see an idle agent.
const fs = require('fs');

const out = process.env.AGENTDECK_TEST_RAW_INPUT_FILE;
const prompt = () => process.stdout.write('\n────────\n❯ \n────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\nClaude Code\n');
process.stdout.write('\x1b[?2004h');
console.log('Welcome to Claude Code (paste recorder)');
prompt();
process.stdin.setRawMode(true);
let chunks = [], timer = null;
process.stdin.on('data', (data) => {
  if (data.includes(3)) process.exit(0);   // Ctrl+C
  chunks.push(data);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const raw = Buffer.concat(chunks).toString('utf8');
    chunks = [];
    if (out) fs.appendFileSync(out, JSON.stringify({ colId: process.env.AGENTDECK_COL_ID, raw }) + '\n');
    process.stdout.write(`\n⏺ recorded ${raw.length} characters\n`);
    prompt();
  }, 1500);
});
