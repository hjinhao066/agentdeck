// Prints the lines of a JSON array file (argv[2]) into the terminal and stays
// open, like an agent that has just answered.
const lines = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
process.stdout.write(lines.join('\r\n') + '\r\n');
setInterval(() => {}, 60000);
