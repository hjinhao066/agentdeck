'use strict';
// Read-only official RPCs. No login, model turn, credential output or stderr logs.
const { spawn } = require('child_process');
const { createHash } = require('crypto');
const Q = require('./quota-core');
function accountIdentity(email) {
  if (typeof email !== 'string' || !/^[^\s@]{1,100}@[^\s@]{1,100}\.[A-Za-z]{2,20}$/.test(email)) return {};
  const [user, domain] = email.toLowerCase().split('@');
  return { account: `${user.slice(0, 2)}***@${domain}`, accountKey: createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16) };
}
function readCodex(env = process.env, spawnImpl = spawn, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child, buffer = '', bytes = 0, identity = {}, done = false;
    const finish = (q = null) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (child && !child.killed) child.kill();
      resolve(q);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    const send = (id, method, params = {}) => {
      if (!done && child?.stdin.writable) child.stdin.write(JSON.stringify({ ...(id === null ? {} : { id }), method, params }) + '\n');
    };
    try {
      child = spawnImpl(process.platform === 'win32' ? 'codex.exe' : 'codex', ['app-server'], { env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      child.on('error', () => finish());
      child.on('exit', () => finish());
      child.stdin.on('error', () => finish());
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) return finish();
        buffer += chunk;
        while (!done && buffer.includes('\n')) {
          const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          let message;
          try { message = JSON.parse(line); } catch (_) { continue; }
          if (message.id === 1) {
            if (message.error) return finish();
            send(null, 'initialized');
            send(2, 'account/read', { refreshToken: false });
          } else if (message.id === 2) {
            // API-key accounts have no ChatGPT subscription quota.
            if (message.result?.account?.type !== 'chatgpt') return finish();
            identity = accountIdentity(message.result.account.email);
            send(3, 'account/rateLimits/read');
          } else if (message.id === 3) {
            const at = Date.now(), q = Q.codexServer(message.result, at);
            finish(q ? { ...q, ...identity } : Object.keys(identity).length ? { provider: 'Codex', scope: 'codex', at, ...identity, identityOnly: true } : null);
          }
        }
      });
      send(1, 'initialize', { clientInfo: { name: 'agentdeck-quota', title: 'AgentDeck Quota', version: '0.9.9' } });
    } catch (_) { finish(); }
  });
}
module.exports = { readCodex, accountIdentity };
