// Stand-in for a watched task's own `decide` command (the radar's
// record_decision.py): appends the decision to <root>/decisions.json.
// While <flag> exists, or the folder is gone, it fails the way an unreachable
// machine does and writes nothing.
//   node decide.js <root> <flag> --id ADR-0001 --decision accepted --reason '…'
const fs = require('fs');
const path = require('path');
const [root, flag, ...rest] = process.argv.slice(2);
const arg = (name) => rest[rest.indexOf(name) + 1] || '';
if (fs.existsSync(flag) || !fs.existsSync(root)) {
  console.error('ssh: connect to host test-host port 22: Operation timed out');
  process.exit(255);
}
const file = path.join(root, 'decisions.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.decisions.push({ id: arg('--id'), decision: arg('--decision'), reason: arg('--reason'), at: new Date().toISOString(), recorded_by: 'captain' });
fs.writeFileSync(file, JSON.stringify(data, null, 2));
