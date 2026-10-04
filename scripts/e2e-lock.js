'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const queueDir = path.join(os.tmpdir(), `agentdeck-e2e-queue-${os.userInfo().username}`);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

// Unique tickets avoid stale-lock unlink races; all worktrees use the same queue.
async function acquire(dir = queueDir, onWait = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const ticket = path.join(dir, `${Date.now()}-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(ticket + '.tmp', JSON.stringify({ pid: process.pid, cwd: process.cwd() }), { mode: 0o600 });
  fs.renameSync(ticket + '.tmp', ticket);
  const release = () => { fs.rmSync(ticket, { force: true }); };
  process.once('exit', release);
  let announced = false;
  try {
    while (true) {
      const tickets = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
      let first;
      for (const name of tickets) {
        const file = path.join(dir, name);
        let owner;
        try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        if (!alive(owner.pid)) { fs.rmSync(file, { force: true }); continue; }
        first = file;
        break;
      }
      if (first === ticket) return () => { process.removeListener('exit', release); release(); };
      if (!announced) { onWait(); announced = true; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) { process.removeListener('exit', release); release(); throw error; }
}

module.exports = { acquire };
