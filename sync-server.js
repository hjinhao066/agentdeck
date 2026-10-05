'use strict';
// Small HTTP front for SharedStore. Bind it on the existing VPS WireGuard
// address when it is deployed; the default is loopback so a laptop does not
// listen on the public network by accident. The token is compared here and
// never written to the log.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { SharedStore } = require('./shared-store');

const MAX_BODY = 2_000_000;

function tokensEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (_) { reject(Object.assign(new Error('invalid json'), { status: 400 })); }
    });
    req.on('error', () => reject(Object.assign(new Error('unreadable body'), { status: 400 })));
  });
}

function startSyncServer({ store, token, host = '127.0.0.1', port = 0, log = () => {} } = {}) {
  if (!store) throw new Error('Sync server requires a store.');
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) throw new Error('Sync server requires a token.');
  const server = http.createServer(async (req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; } catch (_) {}
    const finish = (status, body) => {
      if (res.headersSent || res.writableEnded) return;
      try { log(`${req.method} ${pathname} ${status}`); } catch (_) {}
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      if (req.method === 'GET' && pathname === '/v1/health') return finish(200, { ok: true });
      const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const match = /^Bearer (\S+)$/.exec(header);
      if (!match || !tokensEqual(match[1], token)) return finish(401, { error: 'unauthorized' });
      if (req.method === 'GET' && pathname === '/v1/devices') return finish(200, { devices: store.devices() });
      if (req.method === 'GET' && pathname === '/v1/snapshot') return finish(200, store.snapshot());
      if (req.method === 'POST' && pathname === '/v1/heartbeat') return finish(200, store.heartbeat(await readBody(req)));
      if (req.method === 'POST' && pathname === '/v1/tasks') {
        const saved = store.pushTask(await readBody(req));
        return finish(saved.status, saved.body);
      }
      if (req.method === 'POST' && pathname === '/v1/history') {
        const saved = store.pushHistory(await readBody(req));
        return finish(saved.status, saved.body);
      }
      return finish(404, { error: 'not-found' });
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 500;
      finish(status, { error: status === 500 ? 'server-error' : String(err.message || 'bad-request') });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        url: `http://${host}:${addr.port}`,
        port: addr.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const index = args.indexOf('--' + name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const data = opt('data');
  const tokenFile = opt('token-file');
  const host = opt('host', '127.0.0.1');
  const port = Number(opt('port', '8787'));
  if (!data || !tokenFile || !Number.isInteger(port)) {
    console.error('Usage: node sync-server.js --data <dir> --token-file <path> [--host 127.0.0.1] [--port 8787]');
    process.exit(1);
  }
  let token;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch (_) { console.error('token file unreadable'); process.exit(1); }
  if (!token) { console.error('token file is empty'); process.exit(1); }
  const store = new SharedStore({ file: path.join(data, 'store.json') });
  startSyncServer({ store, token, host, port }).then((server) => {
    console.log('agentdeck sync listening ' + server.url);
  }).catch((err) => {
    console.error(err && err.code ? err.code : 'sync server failed');
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = { startSyncServer };
