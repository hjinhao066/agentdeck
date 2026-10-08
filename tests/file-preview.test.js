'use strict';

// What the phone page may read from this computer (file-preview-core.js): only
// paths the conversation named or files inside the report folders, decided on
// the real path, with key locations refused from everywhere and every read capped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { readPreview, secretPath, LIMITS } = require('../file-preview-core');
const { MobileWebServer } = require('../mobile-web');

// A stand-in home folder: reports and boards are the open folders, the rest is private.
function home(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-preview-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, data = 'x') => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  put('reports/review/review-20261008.md', '# 验收报告\n\n| 项 | 结果 |\n| --- | --- |\n| 单测 | 通过 |\n');
  put('reports/review/shot.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  put('reports/review/pack.zip', Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
  put('.agents/boards/agentdeck.md', '# 看板');
  put('Documents/tax.txt', '私人文件');
  put('Documents/plan/notes.md', '被点名的笔记');
  put('Documents/plan/more/deep.txt', '点名文件夹里的文件');
  put('.ssh/id_ed25519', 'KEY');
  put('.agents-vault-pass', 'PASS');
  put('.claude/.credentials.json', '{"token":"t"}');
  put('.config/agentdeck-remote/vps-access.json', '{"password":"p"}');
  put('project/.env', 'API_KEY=1');
  put('project/readme.md', '项目说明');
  put('reports/review/.env', 'API_KEY=2');
  put('reports/review/secrets/api-token.txt', 'T');
  put('userdata/config.json', '{"token":"1"}');
  const options = { home: root, tmp: path.join(root, 'no-temp-here'), denied: [path.join(root, 'userdata')] };
  return { root, put, options, read: (file, extra = {}) => readPreview(file, { ...options, ...extra }) };
}

test('a file inside the report folders is read, with its kind and size', async (t) => {
  const h = home(t);
  const md = await h.read(path.join(h.root, 'reports/review/review-20261008.md'));
  assert.equal(md.ok, true);
  assert.equal(md.kind, 'markdown');
  assert.equal(md.name, 'review-20261008.md');
  assert.match(md.text, /验收报告/);
  assert.equal(md.truncated, false);
  // ~/ is this computer's home folder
  assert.equal((await h.read('~/.agents/boards/agentdeck.md')).text, '# 看板');
  const image = await h.read(path.join(h.root, 'reports/review/shot.png'));
  assert.deepEqual([image.kind, image.mime, image.next], ['image', 'image/png', null]);
  assert.equal(Buffer.from(image.data, 'base64').length, 16);
  // a format with nothing to show: the name and the size, no bytes
  const zip = await h.read(path.join(h.root, 'reports/review/pack.zip'));
  assert.deepEqual([zip.kind, zip.size, zip.text, zip.data], ['other', 6, undefined, undefined]);
  // a folder lists what is in it, without the key files and hidden names
  const dir = await h.read(path.join(h.root, 'reports/review'));
  assert.equal(dir.kind, 'dir');
  assert.deepEqual(dir.entries.map((e) => e.name), ['pack.zip', 'review-20261008.md', 'shot.png']);
});

test('outside the report folders nothing is read unless the conversation named it', async (t) => {
  const h = home(t);
  const tax = path.join(h.root, 'Documents/tax.txt');
  assert.deepEqual(await h.read(tax), { ok: false, code: 'denied' });
  // an unnamed path answers the same whether or not it exists
  assert.deepEqual(await h.read(path.join(h.root, 'Documents/nothing.txt')), { ok: false, code: 'denied' });
  assert.deepEqual(await h.read('/etc/hosts'), { ok: false, code: 'denied' });
  // named by the Captain: that file, and nothing next to it
  const notes = path.join(h.root, 'Documents/plan/notes.md');
  const texts = [`报告写在 ${notes}，请看。`];
  assert.equal((await h.read(notes, { texts })).text, '被点名的笔记');
  assert.deepEqual(await h.read(tax, { texts }), { ok: false, code: 'denied' });
  // a named file that is gone says so
  assert.deepEqual(await h.read(path.join(h.root, 'Documents/gone.md'), { texts: [`见 ${path.join(h.root, 'Documents/gone.md')}`] }), { ok: false, code: 'missing' });
  assert.deepEqual(await h.read(path.join(h.root, 'reports/none.md')), { ok: false, code: 'missing' });
  // a named folder two levels down covers its files; the home folder itself or one level down does not
  const folder = path.join(h.root, 'Documents/plan');
  assert.equal((await h.read(path.join(folder, 'more/deep.txt'), { texts: [`截图在 ${folder}/`] })).text, '点名文件夹里的文件');
  assert.deepEqual(await h.read(tax, { texts: [`都在 ${path.join(h.root, 'Documents')}/ 里`] }), { ok: false, code: 'denied' });
  assert.deepEqual(await h.read(tax, { texts: [`都在 ${h.root}/ 里`] }), { ok: false, code: 'denied' });
  // a system file stays out even when named
  assert.deepEqual(await h.read('/etc/hosts', { texts: ['看 /etc/hosts'] }), { ok: false, code: 'denied' });
});

test('../ cannot climb out of a report folder', async (t) => {
  const h = home(t);
  for (const sneaky of [path.join(h.root, 'reports') + '/../Documents/tax.txt', path.join(h.root, 'reports/review') + '/../../.ssh/id_ed25519', '~/reports/../../../../etc/hosts',
    'reports/review/review-20261008.md', '../reports/review/review-20261008.md', '', 'a\u0000b', '/' + 'a'.repeat(2000)]) {
    const result = await h.read(sneaky);
    assert.equal(result.ok, false, sneaky);
    assert.ok(['denied', 'invalid'].includes(result.code), sneaky);
  }
  // an encoded slash is not decoded: it is just a name that does not exist in the report folder
  assert.deepEqual(await h.read('~/reports/review/..%2f..%2fDocuments/tax.txt'), { ok: false, code: 'missing' });
  // climbing and coming back down into the folder is still that folder
  assert.equal((await h.read(path.join(h.root, 'reports') + '/../reports/review/review-20261008.md')).ok, true);
});

test('a symbolic link cannot carry a read out of the report folders', { skip: process.platform === 'win32' && 'creating links needs a privilege on Windows' }, async (t) => {
  const h = home(t);
  const link = (target, rel) => { const at = path.join(h.root, rel); fs.symlinkSync(path.join(h.root, target), at); return at; };
  assert.deepEqual(await h.read(link('Documents/tax.txt', 'reports/review/innocent.md')), { ok: false, code: 'denied' });
  assert.deepEqual(await h.read(link('.ssh/id_ed25519', 'reports/review/key.md')), { ok: false, code: 'denied' });
  // a linked folder: neither listed nor read through
  const folder = link('Documents', 'reports/docs');
  assert.deepEqual(await h.read(folder), { ok: false, code: 'denied' });
  assert.deepEqual(await h.read(path.join(folder, 'tax.txt')), { ok: false, code: 'denied' });
  // even a named link never reaches a key or a system file
  const key = path.join(h.root, 'reports/review/key.md'), hosts = path.join(h.root, 'reports/review/hosts.md');
  fs.symlinkSync('/etc/hosts', hosts);
  assert.deepEqual(await h.read(key, { texts: [`看 ${key}`] }), { ok: false, code: 'denied' });
  assert.deepEqual(await h.read(hosts, { texts: [`看 ${hosts}`] }), { ok: false, code: 'denied' });
  // a link that stays inside the report folders is an ordinary file
  assert.equal((await h.read(link('reports/review/review-20261008.md', 'reports/latest.md'))).kind, 'markdown');
});

test('key and credential files are refused wherever they are, named or not', async (t) => {
  const h = home(t);
  const secrets = ['.ssh/id_ed25519', '.agents-vault-pass', '.claude/.credentials.json', '.config/agentdeck-remote/vps-access.json', 'project/.env',
    'reports/review/.env', 'reports/review/secrets/api-token.txt', 'userdata/config.json'].map((rel) => path.join(h.root, rel));
  const texts = [secrets.map((file) => `看 ${file}`).join('\n'), `整个文件夹 ${path.join(h.root, '.ssh')}/ 和 ${path.join(h.root, 'reports/review/secrets')}/`];
  for (const file of secrets) {
    assert.deepEqual(await h.read(file), { ok: false, code: 'denied' }, file);
    assert.deepEqual(await h.read(file, { texts }), { ok: false, code: 'denied' }, file);
  }
  assert.deepEqual(await h.read(path.join(h.root, '.ssh'), { texts }), { ok: false, code: 'denied' });
  // a named file next to a key file is still readable
  const readme = path.join(h.root, 'project/readme.md');
  assert.equal((await h.read(readme, { texts: [`看 ${readme}`] })).text, '项目说明');
  // names that mark a credential, and names that only mention the word
  const opts = { home: '/Users/me' };
  for (const name of ['/Users/me/.ssh/config', '/Users/me/x/.env.local', '/Users/me/x/id_rsa.pub', '/Users/me/x/server.pem', '/Users/me/x/credentials.json', '/Users/me/x/bot-token.txt',
    '/Users/me/.codex/auth.json', '/Users/me/.gemini/oauth_creds.json', '/Users/me/.claude.json', '/Users/me/.zshrc', '/Users/me/.netrc', '/Users/me/.config/gh/hosts.yml',
    '/Users/me/Library/Keychains/login.keychain-db', '/Users/me/repo/.git/config', '/Users/me/.aws/config', '/Users/me/.claude-us2/settings.json']) assert.equal(secretPath(name, opts), true, name);
  for (const name of ['/Users/me/reports/token-usage.md', '/Users/me/reports/captain-token-saver/review.md', '/Users/me/.claude-us2/CLAUDE.md', '/Users/me/.agents/boards/agentdeck.md',
    '/Users/me/reports/auth-flow.png', '/Users/me/agentdeck/README.md']) assert.equal(secretPath(name, opts), false, name);
});

test('reads are capped: long text is cut, big pictures and PDFs are not sent, a PDF comes in pieces', async (t) => {
  const h = home(t);
  const long = h.put('reports/long.txt', 'a'.repeat(LIMITS.text + 10));
  const text = await h.read(long);
  assert.deepEqual([text.kind, text.text.length, text.truncated, text.size], ['text', LIMITS.text, true, LIMITS.text + 10]);
  const pdf = h.put('reports/doc.pdf', Buffer.alloc(LIMITS.chunk + 100, 7));
  const first = await h.read(pdf);
  assert.deepEqual([first.kind, first.mime, first.offset, first.next], ['pdf', 'application/pdf', 0, LIMITS.chunk]);
  const rest = await h.read(pdf, { offset: first.next });
  assert.deepEqual([Buffer.from(rest.data, 'base64').length, rest.next], [100, null]);
  assert.equal((await h.read(pdf, { offset: LIMITS.chunk + 101 })).code, 'invalid');
  const big = path.join(h.root, 'reports/big.png');
  fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, LIMITS.image + 1);
  const refused = await h.read(big);
  assert.deepEqual([refused.kind, refused.size, refused.data], ['toolarge', LIMITS.image + 1, undefined]);
  // bytes that are not text are not shown as text
  const blob = h.put('reports/blob.dat', Buffer.from([1, 2, 0, 3]));
  assert.deepEqual([(await h.read(blob)).kind, (await h.read(blob)).text], ['other', undefined]);
});

// ---- the route: POST api/file ---------------------------------------------
async function serve(t, h, { turns = [], sessions = [], attention = { items: [] }, cards = [] } = {}) {
  const captain = { id: 'captain', title: '队长', status: 'idle', turns };
  const server = new MobileWebServer({ getSessions: () => sessions, getTasks: () => cards, getCaptain: () => captain, getAttention: () => attention, getOutput: () => null,
    sendCaptain: () => {}, saveSettings: () => {}, preview: h ? h.options : null });
  t.after(() => server.close());
  const status = await server.configure({ enabled: true, port: 0 });
  const call = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(status.url + route, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, type: res.headers['content-type'], body: text ? JSON.parse(text) : null }); });
    });
    req.on('error', reject);
    req.end(body);
  });
  const auth = { Authorization: `Bearer ${status.token}` };
  auth['X-CSRF-Token'] = (await call('/api/auth', { headers: auth })).body.csrfToken;
  const file = (body, headers = auth) => call('/api/file', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: status.url, ...headers }, body: JSON.stringify(body) });
  return { server, status, call, file, auth, captain };
}

test('POST api/file needs the login and the CSRF token, and answers in JSON only', async (t) => {
  const h = home(t);
  const s = await serve(t, h);
  const report = path.join(h.root, 'reports/review/review-20261008.md');
  const ok = await s.file({ path: report });
  assert.equal(ok.status, 200);
  assert.match(ok.type, /^application\/json/);
  assert.equal(ok.body.kind, 'markdown');
  assert.equal((await s.file({ path: report }, {})).status, 401);
  assert.equal((await s.file({ path: report }, { Authorization: s.auth.Authorization })).status, 403);
  assert.equal((await s.file({ path: report }, { ...s.auth, Origin: 'https://evil.example' })).status, 403);
  // a path in the URL is not a way in
  assert.equal((await s.call('/api/file?path=' + encodeURIComponent(report), { headers: s.auth })).status, 404);
  for (const body of [{}, { path: 5 }, { path: report, offset: -1 }, { path: report, offset: 1.5 }, { path: report, raw: true }]) assert.equal((await s.file(body)).status, 400);
  const info = await s.call('/api/info');
  assert.ok(info.body.capabilities.includes('files'));
  // a server set up without previews has no such route
  const bare = await serve(t, null);
  assert.equal((await bare.file({ path: report })).status, 404);
  assert.ok(!(await bare.call('/api/info')).body.capabilities.includes('files'));
});

test('through the route: only what the Captain, a receipt or 待我处理 named is read; what the phone typed is not', async (t) => {
  const h = home(t);
  const notes = path.join(h.root, 'Documents/plan/notes.md'), tax = path.join(h.root, 'Documents/tax.txt'), deep = path.join(h.root, 'Documents/plan/more/deep.txt');
  const key = path.join(h.root, '.ssh/id_ed25519');
  const s = await serve(t, h, {
    turns: [{ id: 't1', user: `帮我看 ${tax} 和 ${key}`, reply: `笔记在 ${notes}\n密钥在 ${key}`, done: true }],
    sessions: [{ id: 'w', title: '队员', status: 'idle', isMain: false, receipt: `做完了，见 ${path.join(h.root, 'project/readme.md')}` }],
    attention: { items: [{ id: 'at-1234', kind: 'report', title: '验收', detail: '细节', files: [deep], created: 1 }] },
  });
  assert.equal((await s.file({ path: notes })).body.text, '被点名的笔记');
  assert.equal((await s.file({ path: path.join(h.root, 'project/readme.md') })).body.text, '项目说明');
  assert.equal((await s.file({ path: deep })).body.text, '点名文件夹里的文件');
  // the user's own message named it: that opens nothing
  const refused = await s.file({ path: tax });
  assert.deepEqual([refused.status, refused.body.code], [403, 'denied']);
  // the Captain named a key file: still refused
  assert.deepEqual([(await s.file({ path: key })).status, (await s.file({ path: key })).body.code], [403, 'denied']);
  assert.deepEqual([(await s.file({ path: path.join(h.root, 'reports/none.md') })).status], [404]);
  assert.equal((await s.file({ path: '~/reports/../Documents/tax.txt' })).status, 403);
});
