// Stand-in for a program in a terminal: prints one line to select and writes
// down every byte that reaches its stdin (hex, one record per chunk), so a test
// can tell a copy (nothing reaches it) from an interrupt (0x03 reaches it).
const fs = require('fs');

const out = process.env.AGENTDECK_TEST_KEY_LOG;
process.stdout.write('COPY-ME-4721 select this line\r\n> ');
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  if (out) fs.appendFileSync(out, data.toString('hex') + '\n');
});
