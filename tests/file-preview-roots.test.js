'use strict';

// Folders beyond home and temp where a named file may be previewed (file-preview-core's
// `extra`, Settings' previewRoots; on Windows D:\aiproject\Playground and D:\aiproject\*\reports
// by default), the key files refused there, and the ways around the rules that must fail:
// links and junctions, `..`, letter case, 8.3 short names, \\?\ and UNC paths, NTFS data
// streams and mixed slashes. The desktop preview pane goes through the same refusals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { readPreview, localRefusal, secretPath, secretText, plainPath, cleanRoots, defaultExtraRoots } = require('../file-preview-core');
const { MobileWebServer } = require('../mobile-web');
const SideMain = require('../side-main');

const win = process.platform === 'win32';
const onlyWindows = !win && 'Windows path rules';

// A stand-in D:\aiproject inside a temp folder, with a home folder beside it.
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-roots-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, data = 'x') => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const at = (rel) => path.join(root, rel);
  put('home/notes.md', '家里的笔记');
  put('home/.ssh/config.md', 'Host x');
  put('aiproject/Playground/demo/report.md', '游乐场报告');
  put('aiproject/Playground/notes.txt', '游乐场笔记');
  put('aiproject/projectAlpha/reports/review.md', '项目报告');
  put('aiproject/projectAlpha/reports/sub/deep.md', '深一层的报告');
  put('aiproject/projectAlpha/notes.md', '项目根目录的笔记');
  put('aiproject/projectAlpha/src/code.md', '源码说明');
  put('aiproject/top.md', '项目上面一层');
  put('outside/private.md', '外面的私人文件');
  put('outside/projectBeta/reports/review.md', '外面的报告');
  const extra = [at('aiproject/Playground'), at('aiproject/*/reports')];
  const options = { home: at('home'), tmp: at('no-temp-here'), extra };
  const named = (...files) => [files.map((file) => `见 ${file}`).join('\n')];
  const read = (raw, more = {}) => readPreview(raw, { ...options, ...more });
  return { root, put, at, extra, options, named, read };
}

// The 8.3 short form of a path, or '' when the volume keeps none.
function shortPath(file) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$f = New-Object -ComObject Scripting.FileSystemObject; if (Test-Path -LiteralPath $env:SHORT_OF -PathType Container) { $f.GetFolder($env:SHORT_OF).ShortPath } else { $f.GetFile($env:SHORT_OF).ShortPath }'],
    { env: { ...process.env, SHORT_OF: file }, windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim();
    return out && out.toLowerCase() !== file.toLowerCase() ? out : '';
  } catch (_) { return ''; }
}

test('the default folders: two kinds on D: on Windows, none on a Mac', () => {
  assert.deepEqual(defaultExtraRoots('win32'), ['D:\\aiproject\\Playground', 'D:\\aiproject\\*\\reports']);
  assert.deepEqual(defaultExtraRoots('darwin'), []);
  assert.deepEqual(defaultExtraRoots('linux'), []);
  // the default list passes its own cleaning unchanged
  assert.deepEqual(cleanRoots(defaultExtraRoots('win32'), 'win32'), { roots: defaultExtraRoots('win32'), bad: [] });
});

test('Settings folders are cleaned: full paths at least two deep, * only as a whole folder, no network path', () => {
  const { roots, bad } = cleanRoots(['d:/aiproject/*/reports', 'D:\\aiproject\\Playground\\', 'D:\\AIPROJECT\\playground', '', '  ',
    'D:\\', 'D:\\*\\x', 'D:\\aiproject', '\\\\srv\\share\\x', '\\\\?\\D:\\a\\b', '//srv/share/x', 'D:\\a\\..\\b', 'D:\\a\\b*c', 'D:\\a\\**',
    'rel\\x', 'D:a\\b', 'D:\\a\\b:ads', 'D:\\a\\b.', 'D:\\a\\b?', 5, null], 'win32');
  assert.deepEqual(roots, ['D:\\aiproject\\*\\reports', 'D:\\aiproject\\Playground']);
  assert.equal(bad.length, 14);
  assert.deepEqual(cleanRoots(['/Users/me/work/reports', '/x', 'rel/x', '/Users/*/x', '/a/../b'], 'darwin'), { roots: ['/Users/me/work/reports', '/Users/*/x'], bad: ['/x', 'rel/x', '/a/../b'] });
  assert.equal(cleanRoots(Array.from({ length: 50 }, (_, i) => `D:\\a\\f${i}`), 'win32').roots.length, 20);
});

test('a named file is read from the Settings folders, and only there', async (t) => {
  const s = setup(t);
  const report = s.at('aiproject/Playground/demo/report.md'), review = s.at('aiproject/projectAlpha/reports/review.md');
  const deep = s.at('aiproject/projectAlpha/reports/sub/deep.md');
  assert.equal((await s.read(report, { texts: s.named(report) })).text, '游乐场报告');
  assert.equal((await s.read(review, { texts: s.named(review) })).text, '项目报告');
  assert.equal((await s.read(deep, { texts: s.named(deep) })).text, '深一层的报告');
  // still only what the conversation named
  assert.deepEqual(await s.read(report), { ok: false, code: 'denied' });
  assert.deepEqual(await s.read(s.at('aiproject/Playground/notes.txt'), { texts: s.named(report) }), { ok: false, code: 'denied' });
  // a named folder inside a Settings folder covers its files; the project folder above does not
  assert.equal((await s.read(deep, { texts: [`都在 ${s.at('aiproject/projectAlpha/reports')}\\ 里`] })).text, '深一层的报告');
  // naming Playground itself does not open all of it: a named folder has to be below it; a project's reports folder is its own
  assert.deepEqual(await s.read(s.at('aiproject/Playground/notes.txt'), { texts: [`见 ${s.at('aiproject/Playground')}/`] }), { ok: false, code: 'denied' });
  assert.equal((await s.read(s.at('aiproject/Playground/demo/report.md'), { texts: [`见 ${s.at('aiproject/Playground/demo')}/`] })).text, '游乐场报告');
  assert.equal((await s.read(s.at('aiproject/Playground/notes.txt'), { texts: s.named(s.at('aiproject/Playground/notes.txt')) })).text, '游乐场笔记');
  // the named Playground folder itself still lists
  assert.equal((await s.read(s.at('aiproject/Playground'), { texts: s.named(s.at('aiproject/Playground')) })).kind, 'dir');
  for (const folder of [s.at('aiproject'), s.at('aiproject/projectAlpha')]) assert.deepEqual(await s.read(deep, { texts: [`都在 ${folder}/ 里`] }), { ok: false, code: 'denied' }, folder);
  // outside the two kinds: the project's other folders, the level above, any other folder
  for (const file of [s.at('aiproject/projectAlpha/notes.md'), s.at('aiproject/projectAlpha/src/code.md'), s.at('aiproject/top.md'), s.at('outside/private.md'),
    s.at('outside/projectBeta/reports/review.md')]) assert.deepEqual(await s.read(file, { texts: s.named(file) }), { ok: false, code: 'denied' }, file);
  // the home folder keeps its rules: a named file there is read
  assert.equal((await s.read(s.at('home/notes.md'), { texts: s.named(s.at('home/notes.md')) })).text, '家里的笔记');
  // without the folders (a Mac, or Settings emptied) the same file is refused
  assert.deepEqual(await s.read(report, { texts: s.named(report), extra: [] }), { ok: false, code: 'denied' });
  // a listing of a named Settings folder
  const listing = await s.read(s.at('aiproject/projectAlpha/reports'), { texts: s.named(s.at('aiproject/projectAlpha/reports')) });
  assert.deepEqual(listing.entries.map((e) => e.name), ['sub', 'review.md']);
});

test('key files are refused in the Settings folders, named or not', async (t) => {
  const s = setup(t);
  const dir = 'aiproject/projectAlpha/reports/';
  const secrets = ['.env', '.env.local', '.env.production', 'auth.json', 'server.key', 'cert.pem', 'store.p12', 'store.pfx', 'id_rsa', 'id_rsa.pub', 'id_rsa_backup',
    'id_ed25519', 'id_ed25519.pub', 'id_ed25519-old', 'token.json', 'my_token.txt', 'api-tokens.yaml', 'secretary.txt', 'aws-credential.ini', 'credentials.json',
    'bot-token.txt', 'oauth-secret.yaml', 'token-usage.env', 'token-usage.md.key',
    'secrets/a.md', '.secrets/plan.md', 'credentials/plan.md', '.ssh/plan.md', 'sub/secrets/deep/plan.md', 'secrets/token-usage.md'].map((rel) => s.put(dir + rel, 'SECRET'));
  for (const file of secrets) {
    assert.deepEqual(await s.read(file, { texts: s.named(file) }), { ok: false, code: 'denied' }, file);
    assert.deepEqual(await s.read(file), { ok: false, code: 'denied' }, file);
  }
  // delivered documents that only mention the word: reports, pages, PDFs and pictures open
  const documents = { 'token-usage.md': '用量报告', 'api-tokens-report.md': '报告', 'my-secret-plan.markdown': '计划', 'aws-credential-review.html': '<p>审查</p>',
    'token-usage.pdf': '%PDF-1.4', 'Token-Chart.PNG': 'png', 'design-tokens.md': '# 设计变量', 'github-auth.md': '# 登录流程', 'bot-token.md': '# 机器人令牌说明' };
  for (const [rel, data] of Object.entries(documents)) {
    const file = s.put(dir + rel, data);
    const read = await s.read(file, { texts: s.named(file) });
    assert.equal(read.ok, true, rel);
    // still only when named
    assert.deepEqual(await s.read(file), { ok: false, code: 'denied' }, rel);
  }
  assert.equal((await s.read(s.at(dir + 'token-usage.md'), { texts: s.named(s.at(dir + 'token-usage.md')) })).text, '用量报告');
  // a folder named after the word is a folder, not a key file
  const plain = s.put(dir + 'token-notes/summary.md', '总结');
  assert.equal((await s.read(plain, { texts: s.named(plain) })).text, '总结');
  // a listing leaves the key files out and keeps the documents
  const listing = await s.read(s.at(dir.slice(0, -1)), { texts: s.named(s.at(dir.slice(0, -1))) });
  assert.deepEqual(listing.entries.map((e) => e.name),
    ['sub', 'token-notes', 'api-tokens-report.md', 'aws-credential-review.html', 'bot-token.md', 'design-tokens.md', 'github-auth.md', 'my-secret-plan.markdown', 'review.md',
      'Token-Chart.PNG', 'token-usage.md', 'token-usage.pdf']);
  // the words anywhere in a name that is not a document, any case; a document whose name ends in the word
  for (const name of ['/Users/me/reports/Token.JSON', '/Users/me/reports/My_Token.TXT', '/Users/me/reports/SECRET.txt', '/Users/me/reports/x.CREDENTIALS.json', '/Users/me/x/ID_RSA2',
    '/Users/me/x/.ENV', '/Users/me/x/Credentials/a.md', '/Users/me/x/Secrets/token-usage.md', 'D:\\aiproject\\p\\reports\\Auth.JSON', 'D:\\aiproject\\p\\reports\\a.PFX',
    'D:\\aiproject\\p\\reports\\secrets\\a.md']) assert.equal(secretPath(name, { home: '/Users/me' }), true, name);
  for (const name of ['/Users/me/reports/Token-Usage.md', '/Users/me/reports/x.CREDENTIALS.md', '/Users/me/reports/secret-plan.HTML', '/Users/me/reports/credential-flow.svg', 'D:\\aiproject\\p\\reports\\token-usage.pdf'])
    assert.equal(secretPath(name, { home: '/Users/me' }), false, name);
  assert.equal(secretPath('/Users/me/reports/token-notes', { home: '/Users/me', dir: true }), false);
});

test('a junction or link out of a Settings folder is judged where it really leads', { skip: onlyWindows }, async (t) => {
  const s = setup(t);
  const junction = (target, rel) => { const at = s.at(rel); fs.symlinkSync(s.at(target), at, 'junction'); return at; };
  // Playground\out leads to a private folder: refused, named or not
  const out = path.join(junction('outside', 'aiproject/Playground/out'), 'private.md');
  assert.deepEqual(await s.read(out, { texts: s.named(out) }), { ok: false, code: 'denied' });
  assert.deepEqual(await s.read(path.dirname(out), { texts: s.named(path.dirname(out)) }), { ok: false, code: 'denied' });
  // a reports folder that leads to .ssh: refused for the .ssh on the real path
  const keys = path.join(junction('home/.ssh', 'aiproject/projectAlpha/reports/keys'), 'config.md');
  assert.deepEqual(await s.read(keys, { texts: s.named(keys) }), { ok: false, code: 'denied' });
  // a project folder that is itself a junction elsewhere: its reports are not under D:\aiproject\*\reports in truth
  const beta = path.join(junction('outside/projectBeta', 'aiproject/projectBeta'), 'reports', 'review.md');
  assert.deepEqual(await s.read(beta, { texts: s.named(beta) }), { ok: false, code: 'denied' });
  // the other way round: a junction outside that leads into a reports folder reads the real, allowed file
  const door = path.join(junction('aiproject/projectAlpha/reports', 'outside/door'), 'review.md');
  assert.equal((await s.read(door, { texts: s.named(door) })).text, '项目报告');
  // the desktop pane: the same real path rule for key folders
  assert.equal(localRefusal(keys, { home: s.at('home') }), 'secret');
  assert.equal(localRefusal(door, { home: s.at('home') }), '');
});

test('`..` cannot climb out of a Settings folder', async (t) => {
  const s = setup(t);
  const sep = path.sep;
  const sneaky = [
    s.at('aiproject/Playground') + `${sep}..${sep}projectAlpha${sep}notes.md`,
    s.at('aiproject/projectAlpha/reports') + `${sep}..${sep}notes.md`,
    s.at('aiproject/projectAlpha/reports') + `/../src/code.md`,
    s.at('aiproject/Playground') + `${sep}..${sep}..${sep}outside${sep}private.md`,
    s.at('aiproject/projectAlpha/reports') + `${sep}..${sep}..${sep}..${sep}home${sep}.ssh${sep}config.md`,
  ];
  // even when the conversation printed exactly that path
  for (const raw of sneaky) assert.deepEqual(await s.read(raw, { texts: s.named(raw) }), { ok: false, code: 'denied' }, raw);
  // climbing out and back into an allowed folder is that folder
  const back = s.at('aiproject/projectAlpha/reports') + `${sep}..${sep}reports${sep}review.md`;
  assert.equal((await s.read(back, { texts: s.named(s.at('aiproject/projectAlpha/reports/review.md')) })).text, '项目报告');
});

test('letter case does not matter on Windows, in paths, Settings folders or key names', { skip: onlyWindows }, async (t) => {
  const s = setup(t);
  const report = s.at('aiproject/Playground/demo/report.md');
  // the phone asks in capitals for what the receipt named in lower case
  assert.equal((await s.read(report.toUpperCase(), { texts: s.named(report.toLowerCase()) })).text, '游乐场报告');
  // a Settings folder written in another case still matches
  const review = s.at('aiproject/projectAlpha/reports/review.md');
  assert.equal((await s.read(review, { texts: s.named(review), extra: [s.at('AIPROJECT/*/REPORTS').toLowerCase()] })).text, '项目报告');
  // capitals do not hide a key file or a key folder
  for (const rel of ['.ENV', 'Auth.Json', 'SERVER.KEY', 'ID_RSA', 'My-TOKEN.txt', 'SECRETS/a.md', '.SSH/a.md', 'Credentials/a.md']) {
    const file = s.put('aiproject/projectAlpha/reports/' + rel, 'SECRET');
    assert.deepEqual(await s.read(file, { texts: s.named(file) }), { ok: false, code: 'denied' }, rel);
    assert.deepEqual(await s.read(file.toLowerCase(), { texts: s.named(file.toUpperCase()) }), { ok: false, code: 'denied' }, rel);
  }
  // a lower-case spelling of the project's src folder is not its reports folder
  const code = s.at('aiproject/projectAlpha/src/code.md').toLowerCase();
  assert.deepEqual(await s.read(code, { texts: s.named(code) }), { ok: false, code: 'denied' });
});

test('8.3 short names are written out in full before anything is decided', { skip: onlyWindows }, async (t) => {
  const s = setup(t);
  const secret = s.put('aiproject/projectAlpha/reports/credentials-backup.txt', 'SECRET');
  const shortSecret = shortPath(secret);
  if (!shortSecret) return t.skip('this volume keeps no 8.3 names');
  // CREDEN~1.TXT does not carry the word, the real name does
  assert.doesNotMatch(path.basename(shortSecret).toLowerCase(), /credential/);
  assert.deepEqual(await s.read(shortSecret, { texts: s.named(shortSecret) }), { ok: false, code: 'denied' });
  assert.equal(localRefusal(shortSecret, { home: s.at('home') }), 'secret');
  // a short name through the * folder of an allowed file is that file
  const review = s.at('aiproject/projectAlpha/reports/review.md');
  const shortReview = shortPath(review);
  assert.match(shortReview, /~/);
  assert.equal((await s.read(shortReview, { texts: s.named(review) })).text, '项目报告');
  // a short name of a project file outside reports is still outside
  const notes = s.at('aiproject/projectAlpha/notes.md');
  const shortNotes = shortPath(notes);
  assert.deepEqual(await s.read(shortNotes, { texts: s.named(shortNotes) }), { ok: false, code: 'denied' });
  // a short name of a key folder
  const shortSsh = shortPath(s.put('aiproject/projectAlpha/reports/.secrets/plan.md', 'SECRET'));
  assert.deepEqual(await s.read(shortSsh, { texts: s.named(shortSsh) }), { ok: false, code: 'denied' });
});

test('\\\\?\\, \\\\.\\ and UNC paths are never read, named or not', { skip: onlyWindows }, async (t) => {
  const s = setup(t);
  const report = s.at('aiproject/Playground/demo/report.md');
  const drive = report.slice(0, 1);
  const forms = ['\\\\?\\' + report, '\\\\.\\' + report, '\\\\?\\UNC\\localhost\\' + drive + '$' + report.slice(2), '\\\\localhost\\' + drive + '$' + report.slice(2),
    '//localhost/' + drive + '$' + report.slice(2).replace(/\\/g, '/'), '\\\\127.0.0.1\\' + drive + '$' + report.slice(2), 'file://\\\\localhost\\' + drive + '$' + report.slice(2)];
  for (const raw of forms) {
    assert.deepEqual(await s.read(raw, { texts: [...s.named(report), `见 ${raw}`] }), { ok: false, code: 'invalid' }, raw);
    assert.equal(localRefusal(raw, { home: s.at('home') }), 'path', raw);
  }
  for (const raw of ['\\\\srv\\share\\a.md', '\\\\?\\C:\\a.md', '\\\\.\\PhysicalDrive0', '//srv/share/a.md']) assert.equal(plainPath(raw, 'win32'), false, raw);
  assert.equal(plainPath('C:\\a\\b.md', 'win32'), true);
  // a Mac has no such paths: plainPath leaves it to the rest
  assert.equal(plainPath('//Users/me/a.md', 'darwin'), true);
});

test('an NTFS data stream is never read, and "a.md:12" on Windows is always a.md at line 12', { skip: onlyWindows }, async (t) => {
  const s = setup(t);
  const report = s.at('aiproject/Playground/demo/report.md');
  fs.writeFileSync(report + ':hidden', 'STREAM');
  fs.writeFileSync(report + ':12', 'STREAM NAMED 12');
  assert.equal(fs.readFileSync(report + ':hidden', 'utf8'), 'STREAM');
  for (const raw of [report + ':hidden', report + '::$DATA', report + ':hidden:$DATA', report + ':12:x', s.at('aiproject/Playground/demo') + ':s\\report.md']) {
    assert.deepEqual(await s.read(raw, { texts: [...s.named(report), `见 ${raw}`] }), { ok: false, code: 'invalid' }, raw);
    assert.equal(localRefusal(raw, { home: s.at('home') }), 'path', raw);
  }
  const line = await s.read(report + ':12', { texts: s.named(report) });
  assert.deepEqual([line.text, line.line], ['游乐场报告', 12]);
  const column = await s.read(report + ':12:3', { texts: s.named(report) });
  assert.deepEqual([column.text, column.line], ['游乐场报告', 12]);
  // a receipt that names a.md:40 names a.md
  assert.equal((await s.read(report + ':12', { texts: s.named(report + ':40') })).text, '游乐场报告');
  assert.equal((await s.read(report, { texts: s.named(report + ':40:2') })).text, '游乐场报告');
  // names Windows trims: ".env." would open .env
  s.put('aiproject/Playground/.env', 'SECRET');
  for (const raw of [s.at('aiproject/Playground/.env.'), report + '.', report + ' . ', s.at('aiproject/Playground.') + '\\demo\\report.md']) {
    assert.deepEqual(await s.read(raw, { texts: [...s.named(report), `见 ${raw}`] }), { ok: false, code: 'invalid' }, raw);
    assert.equal(localRefusal(raw, { home: s.at('home') }), 'path', raw);
  }
  // the phone's path loses a trailing space before the rules, and what is left is .env itself
  assert.deepEqual(await s.read(s.at('aiproject/Playground/.env '), { texts: s.named(s.at('aiproject/Playground/.env')) }), { ok: false, code: 'denied' });
  assert.equal(localRefusal(s.at('aiproject/Playground/.env '), { home: s.at('home') }), 'path');
});

test('mixed slashes are the same path, for files, Settings folders and key files', { skip: onlyWindows }, async (t) => {
  const s = setup(t);
  const report = s.at('aiproject/Playground/demo/report.md');
  const mixed = report.replace(/\\/g, (_, i) => (i % 2 ? '/' : '\\'));
  assert.notEqual(mixed, report);
  assert.equal((await s.read(mixed, { texts: s.named(report) })).text, '游乐场报告');
  assert.equal((await s.read(report.replace(/\\/g, '/'), { texts: s.named(report) })).text, '游乐场报告');
  assert.equal((await s.read(report, { texts: s.named(report.replace(/\\/g, '/')) })).text, '游乐场报告');
  // doubled separators
  assert.equal((await s.read(report.replace(/\\demo\\/, '\\\\demo//'), { texts: s.named(report) })).text, '游乐场报告');
  // a Settings folder written with forward slashes
  const review = s.at('aiproject/projectAlpha/reports/review.md');
  assert.equal((await s.read(review, { texts: s.named(review), extra: [s.at('aiproject').replace(/\\/g, '/') + '/*/reports'] })).text, '项目报告');
  // a key file behind mixed slashes
  const env = s.put('aiproject/projectAlpha/reports/.env', 'SECRET').replace(/\\/g, '/');
  assert.deepEqual(await s.read(env, { texts: s.named(env) }), { ok: false, code: 'denied' });
  const ssh = s.put('aiproject/projectAlpha/reports/.ssh/a.md', 'SECRET').replace(/\\reports\\/, '/reports/');
  assert.deepEqual(await s.read(ssh, { texts: s.named(ssh) }), { ok: false, code: 'denied' });
});

// ---- review round: keys and sign-in state that a D: project folder holds -------------------
// Each file is named in the conversation, so only the key rules can stop it.
// `roots`: open the folder as a report folder instead, for names with spaces the conversation's link finder stops at.
async function refusedEverywhere(s, files, roots) {
  for (const file of files) {
    assert.deepEqual(await s.read(file, roots ? { roots } : { texts: s.named(file) }), { ok: false, code: 'denied' }, file);
    assert.equal(localRefusal(file, { home: s.at('home') }), 'secret', file);
  }
}
async function readable(s, files, roots) {
  for (const file of files) {
    const read = await s.read(file, roots ? { roots } : { texts: s.named(file) });
    assert.equal(read.ok, true, file);
    assert.equal(localRefusal(file, { home: s.at('home') }), '', file);
  }
}

test('credential dotfiles are refused in any folder, not only in the home folder', async (t) => {
  const s = setup(t);
  const at = (name) => s.put('aiproject/Playground/proj/' + name, 'SECRET');
  await refusedEverywhere(s, ['.npmrc', '.netrc', '.pypirc', '.pgpass', '.my.cnf', '.boto', '.s3cfg', '.envrc', '.dockercfg', '.git-credentials', '.gitconfig', '.bashrc',
    '.zsh_history', '.claude.json', '.NPMRC', 'sub/deeper/.envrc'].map(at));
  await refusedEverywhere(s, ['.npmrc', '.envrc'].map((name) => s.put('aiproject/projectAlpha/reports/' + name, 'SECRET')));
  // documents about them are not them
  await readable(s, ['npmrc-guide.md', 'netrc.md', 'envrc-notes.txt', 'my.cnf.md'].map((name) => s.put('aiproject/Playground/proj/' + name, '说明')));
});

test('an agent CLI folder holds only documents and pictures for a preview, wherever it is', async (t) => {
  const s = setup(t);
  const at = (rel, data = 'SECRET') => s.put('aiproject/Playground/proj/' + rel, data);
  await refusedEverywhere(s, [at('.config/gh/hosts.yml'), at('.claude/settings.local.json'), at('.claude/settings.json'), at('.codex/config.toml'), at('.gemini/oauth_creds.json'),
    at('.claude-us2/.credentials.json'), at('.cursor/mcp.json'), at('tool-cache/.config/x-profiles/state.json'), s.put('aiproject/projectAlpha/reports/.config/app/config.ini', 'S')]);
  // the folder named on its own still shows; what reads as a document inside opens
  await readable(s, [at('.claude/CLAUDE.md', '# 说明'), at('.config/notes/readme.txt', '说明'), at('.codex/shot.png', 'png')]);
  // and outside such a folder the same kinds of file are ordinary
  await readable(s, [at('settings.json', '{}'), at('config.toml', 'a = 1'), at('hosts.yml', 'a: 1')]);
});

test('a Chromium user-data folder (it has a "Local State" file) is closed, all of it; its sign-in files are refused by name too', async (t) => {
  const s = setup(t);
  // four automation profiles, as in the real Playground
  const profiles = ['aiproject/Playground/chrome-debug-profile', 'aiproject/Playground/tool-cache/.config/google-chrome-for-testing',
    'aiproject/Playground/tool-cache/.config/x-profiles/china-google', 'aiproject/Playground/ig-school-story-radar/data/debug-chrome-profile'];
  const files = [];
  for (const profile of profiles) {
    files.push(s.put(profile + '/Local State', '{"os_crypt":{"encrypted_key":"x"}}'));
    for (const rel of ['Preferences', 'Default/Preferences', 'Default/Secure Preferences', 'Default/Login Data', 'Default/Web Data', 'Default/History', 'Default/Cookies',
      'Default/Local Storage/leveldb/000003.log', 'Default/Sessions/Session_1', 'Default/Network/Cookies', 'Default/notes.md', 'Default/readme.txt', 'report.md'])
      files.push(s.put(`${profile}/${rel}`, 'PROFILE'));
  }
  await refusedEverywhere(s, files);
  // the folders themselves, named, and everything below a named Playground project
  for (const profile of profiles) for (const dir of [profile, profile + '/Default', profile + '/Default/Local Storage']) {
    assert.deepEqual(await s.read(s.at(dir), { texts: s.named(s.at(dir)) }), { ok: false, code: 'denied' }, dir);
    assert.equal(localRefusal(s.at(dir), { home: s.at('home') }), 'secret', dir);
  }
  const deep = s.at('aiproject/Playground/ig-school-story-radar/data/debug-chrome-profile/Default/notes.md');
  assert.deepEqual(await s.read(deep, { texts: [`见 ${s.at('aiproject/Playground/ig-school-story-radar')}/`] }), { ok: false, code: 'denied' });
  // the folder next to it is ordinary, and its listing leaves the profile out
  const data = s.at('aiproject/Playground/ig-school-story-radar/data');
  const report = s.put('aiproject/Playground/ig-school-story-radar/data/report.md', '雷达报告');
  assert.equal((await s.read(report, { texts: s.named(report) })).text, '雷达报告');
  assert.deepEqual((await s.read(data, { texts: s.named(data) })).entries.map((e) => e.name), ['report.md']);
  assert.deepEqual(SideMain.readPreview(data, data, s.at('home')).entries.map((e) => e.name), ['report.md']);
  // a profile's sign-in file copied somewhere else is still refused by its name; a document named History is not
  await refusedEverywhere(s, ['Local State', 'Preferences', 'Secure Preferences', 'Login Data For Account', 'Web Data-journal', 'History', 'logins.json', 'key4.db', 'cookies.sqlite']
    .map((name) => s.put('aiproject/Playground/loose/' + name, 'S')));
  // AgentDeck's own data folder carries Electron's "Local State" too: its uploads and reports still show (desktop pane, test
  // profile's phone), its own sign-in files do not, and another Electron app's folder stays closed
  const own = s.at('home/AppData/agentdeck');
  s.put('home/AppData/agentdeck/Local State', '{}');
  const upload = s.put('home/AppData/agentdeck/mobile-uploads/shot.png', 'png');
  const ownReport = s.put('home/AppData/agentdeck/reports/r.md', '测试报告');
  assert.equal(localRefusal(upload, { home: s.at('home'), own }), '');
  assert.equal(SideMain.readPreview(upload, upload, s.at('home'), own).kind, 'image');
  assert.equal((await s.read(ownReport, { own, roots: [s.at('home/AppData/agentdeck/reports')] })).text, '测试报告');
  assert.equal(localRefusal(upload, { home: s.at('home') }), 'secret');
  for (const rel of ['Local State', 'Preferences', 'Network/Cookies', 'Local Storage/leveldb/1.log']) {
    const file = s.put('home/AppData/agentdeck/' + rel, 'S');
    assert.equal(localRefusal(file, { home: s.at('home'), own }), 'secret', rel);
  }
  s.put('home/AppData/other-electron-app/Local State', '{}');
  const other = s.put('home/AppData/other-electron-app/notes.md', '别的应用');
  assert.equal(localRefusal(other, { home: s.at('home'), own }), 'secret');
  // (in another folder: the loose "Local State" above marks its own folder as a profile)
  await readable(s, ['History.md', 'preferences-notes.md', 'local-state.md'].map((name) => s.put('aiproject/Playground/docs/' + name, '文档')));
  // a named file that does not exist in a profile is refused, not reported missing
  assert.deepEqual(await s.read(s.at('aiproject/Playground/loose/notes.md'), { texts: s.named(s.at('aiproject/Playground/loose/notes.md')) }), { ok: false, code: 'denied' });
  assert.deepEqual(await s.read(s.at('aiproject/Playground/docs/gone.md'), { texts: s.named(s.at('aiproject/Playground/docs/gone.md')) }), { ok: false, code: 'missing' });
});

test('key.txt, *_key.txt, service accounts and Terraform state are refused; keyboard.md is not', async (t) => {
  const s = setup(t);
  const at = (name) => s.put('aiproject/projectAlpha/reports/' + name, 'SECRET');
  await refusedEverywhere(s, ['key.txt', 'Key.TXT', 'openai_key.txt', 'anthropic-key.txt', 'deploy.keys', 'keys.json', 'service-account.json', 'service_account_prod.json',
    'serviceAccount.json', 'service-account-key.json', 'terraform.tfstate', 'terraform.tfstate.backup', 'prod.tfstate.json', 'TERRAFORM.TFSTATE'].map(at));
  await readable(s, ['keyboard.md', 'monkey.txt', 'keynote-summary.md', 'key-findings.txt', 'hotkeys.txt', 'token-usage.md', 'service-account-setup.md', 'terraform-notes.md',
    'tfstate-migration.md'].map((name) => s.put('aiproject/projectAlpha/reports/' + name, '文档')));
});

// ---- review round 2: env files by any name, keys inside a text, backup copies ---------------
test('an env file is refused however it is named, and so is a .private or private folder', async (t) => {
  const s = setup(t);
  const at = (rel) => s.put('aiproject/Playground/agent-collaboration/' + rel, 'TOKEN=1');
  await refusedEverywhere(s, ['deploy.env', 'private-login.env', 'final-deploy.env', 'UI-TEST.ENV', 'app.env.prod', 'site.env.local', '.env', '.env.production',
    '.private/notes.md', '.private/deploy.env', 'private/readme.txt', 'x/.PRIVATE/a.md'].map(at));
  await readable(s, ['env.md', 'environment.md', 'envelope.txt', 'environment-setup.md', 'env-vars-guide.md', 'private-notes.md', 'privates.md'].map((rel) => s.put('aiproject/Playground/docs/' + rel, '说明')));
});

// Built at run time, so no key-shaped text sits in the repository.
const crypto = require('node:crypto');
const randomKey = (length) => crypto.randomBytes(length).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(length, '7').slice(0, length - 2) + '42';
const hexKey = (length) => crypto.randomBytes(length).toString('hex').slice(0, length);

test('the phone is not sent a text that holds a key, whatever the file is called', async (t) => {
  const s = setup(t);
  const dir = 'aiproject/Playground/agent-collaboration/workbench/phase2b/';
  const texts = {
    'config.yaml': `model:\n  provider: openrouter\n  api_key: ${'sk' + '-or-v1-' + randomKey(64)}\n`,
    'after-migrate-raw-config.yaml': `gateway:\n  token: ${hexKey(72)}\n  port: 8080\n`,
    'settings.json': `{\n  "apiKey": "${randomKey(40)}",\n  "theme": "dark"\n}\n`,
    'deploy-notes.txt': `export GITHUB_TOKEN=${'ghp' + '_' + randomKey(36)}\n`,
    'handover.md': `# 交接\n\n临时密钥：${'sk' + '-ant-api03-' + randomKey(80)}\n`,
    'id.txt': `${'-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'}\nb3BlbnNzaC1rZXktdjEAAAAA\n${'-----END ' + 'OPENSSH PRIVATE KEY-----'}\n`,
    'aws.md': `访问密钥 ${'AKIA' + randomKey(16).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}\n`,
    'slack.ini': `[bot]\nslack = ${'xoxb' + '-' + hexKey(12) + '-' + randomKey(24)}\n`,
    'maps.js': `const key = '${'AIza' + randomKey(35)}';\n`,
    'db-example.txt': `DB_PASSWORD=${randomKey(28)}\n`,
    'client.json': `{"client_secret": "${randomKey(32)}"}`,
    // a Telegram bot token, as the Hermes configs hold it: the colon would end a field's value
    'telegram-config.yaml': `platforms:\n  telegram:\n    token: ${'81234' + '56789'}:${'AA' + randomKey(33)}\n`,
    'bot.md': `机器人：${'7012345' + '678'}:${'AA' + randomKey(33)}\n`,
  };
  for (const [name, text] of Object.entries(texts)) {
    const file = s.put(dir + name, text);
    assert.deepEqual(await s.read(file, { texts: s.named(file) }), { ok: false, code: 'denied' }, name);
  }
  // named through the folder too
  assert.deepEqual(await s.read(s.at(dir + 'config.yaml'), { texts: [`见 ${s.at(dir)}`] }), { ok: false, code: 'denied' });
  // placeholders, code and ordinary numbers are not keys
  const fine = {
    'setup.md': '# 配置\n\n```yaml\napi_key: sk-xxxxxxxxxxxxxxxxxxxxxxxx\ntoken: your-api-key-goes-here-1234\n```\n',
    'env.md': 'DB_PASSWORD=${DB_PASSWORD}\nAPI_KEY=<your key>\npassword: ********************\n',
    'code.js': 'const token = process.env.GITHUB_TOKEN_FOR_CI_2;\nconst secret = config.auth.clientSecret;\n',
    'aws-docs.md': '示例密钥 AKIAIOSFODNN7EXAMPLE，别用真的。\n',
    'token-usage.md': `| 日期 | token 用量 |\n| --- | --- |\n| 10-09 | 12345678901234567890 |\n\ncommit ${hexKey(40)}\n`,
    'report.md': '# 验收\n\nsk-learn 的版本是 1.5.2，task-1234567890-abcdefgh 已完成。\n',
    'times.md': '开始 2026-10-09 18:38:10，耗时 1234567890:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n',
  };
  for (const [name, text] of Object.entries(fine)) {
    const file = s.put(dir + 'ok/' + name, text);
    assert.equal((await s.read(file, { texts: s.named(file) })).text, text, name);
  }
  // the check reads only what would be sent, and a long blob without spaces costs one pass
  const blob = 'a1'.repeat(600 * 1024);
  const started = Date.now();
  assert.equal(secretText(blob), false);
  assert.equal(secretText('token' + '='.repeat(10) + blob), false);
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  // the desktop pane is the user's own screen: it still shows the file
  assert.equal(localRefusal(s.at(dir + 'config.yaml'), { home: s.at('home') }), '');
});

// ---- review round 3 ----------------------------------------------------------------------
test('a field is read with any alignment and with its value on the next line', async (t) => {
  const s = setup(t);
  const dir = 'aiproject/Playground/cfg/';
  const texts = {
    'aligned.yaml': `name: hermes\ntoken:          ${hexKey(40)}\n`,
    'aligned.env': `HOST=localhost\nAPI_KEY        = ${randomKey(32)}\n`,
    'next-line.yaml': `model:\n  api_key:\n    ${randomKey(40)}\n`,
    'block.yaml': `gateway:\n  token: |\n    ${randomKey(48)}\n`,
    'folded.yaml': `gateway:\n  token: >-\n    ${randomKey(48)}\n`,
    'next-line.json': `{\n  "token":\n    "${randomKey(36)}"\n}\n`,
    'crlf.yaml': `api_key:\r\n  ${randomKey(40)}\r\n`,
    'tabs.ini': `secret\t\t\t\t=\t\t${randomKey(30)}\n`,
  };
  for (const [name, text] of Object.entries(texts)) {
    const file = s.put(dir + name, text);
    assert.deepEqual(await s.read(file, { texts: s.named(file) }), { ok: false, code: 'denied' }, name);
  }
  // the next line holding the next key is not a value, nor is a count
  const fine = {
    'model-list.yaml': 'tokens:\n  model_name_2026_v1: 3\n  context_window_2026_v2: 8\nsecret_names:\n  projects_path_2026_v3: x\n',
    'counts.yaml': `token_count:          ${'1234567890'.repeat(3)}\npassword:\n  - short\n`,
  };
  for (const [name, text] of Object.entries(fine)) {
    const file = s.put(dir + 'ok/' + name, text);
    assert.equal((await s.read(file, { texts: s.named(file) })).text, text, name);
  }
  // still one pass over a page of empty fields
  const started = Date.now();
  assert.equal(secretText(('token:' + ' '.repeat(39) + '|\n' + ' '.repeat(79) + '\n').repeat(8000)), false);
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
});

test('a private key encoded once more in base64 is refused; a certificate is not', async (t) => {
  const s = setup(t);
  const pem = (kind) => `${'-----BEGIN ' + kind + '-----'}\n${crypto.randomBytes(120).toString('base64')}\n${'-----END ' + kind + '-----'}\n`;
  const b64 = (kind) => Buffer.from(pem(kind)).toString('base64');
  const dir = 'aiproject/Playground/kube/';
  for (const [name, text] of Object.entries({
    'kubeconfig-copy.yaml': `users:\n- name: admin\n  user:\n    client-certificate-data: ${b64('CERTIFICATE')}\n    client-key-data: ${b64('RSA PRIVATE KEY')}\n`,
    'deploy.txt': `SSH_KEY_B64=${b64('OPENSSH PRIVATE KEY')}\n`,
    'notes.md': `密钥：\n\n    ${b64('PRIVATE KEY')}\n`,
    'ec.json': `{"data": "${b64('EC PRIVATE KEY')}"}`,
  })) {
    const file = s.put(dir + name, text);
    assert.deepEqual(await s.read(file, { texts: s.named(file) }), { ok: false, code: 'denied' }, name);
  }
  const cert = s.put(dir + 'ok/ca.yaml', `clusters:\n- cluster:\n    certificate-authority-data: ${b64('CERTIFICATE')}\n`);
  assert.equal((await s.read(cert, { texts: s.named(cert) })).ok, true);
});

test('Windows copy names are judged by the name they were copied from', async (t) => {
  const s = setup(t);
  // the folder is opened as a report folder: these names hold spaces, and only the key rules may refuse them
  const roots = [s.at('aiproject/projectAlpha/reports')];
  const at = (name) => s.put('aiproject/projectAlpha/reports/' + name, 'S');
  await refusedEverywhere(s, ['.env - 副本', '.env - Copy', '.env (1)', '.env_bak', '.env-backup', 'auth - 副本.json', 'auth - Copy.json', 'auth - 副本 (2).json',
    'auth (1).json', 'auth_old.json', 'auth-backup.json', 'auth.bak.json', 'auth.json.bak1', 'auth.json.2026-10-09', 'Copy of auth.json', 'key - 副本.txt', 'key (2).txt',
    'id_rsa - 副本', 'deploy - Copy.env', 'credentials (3).json'].map(at), roots);
  await readable(s, ['report - 副本.md', 'review (1).md', 'notes_old.md', 'plan-backup.md', 'monkey (2).txt', 'env - 副本.md', 'auth-flow (1).png', 'Copy of report.md',
    'keyboard - Copy.md'].map((name) => s.put('aiproject/projectAlpha/reports/' + name, '文档')), roots);
});

test('SK hynix in a market report is not an sk- key', async (t) => {
  const s = setup(t);
  const dir = 'aiproject/Playground/market-intelligence/';
  const fine = {
    'post-market/2026-07-28_us_postmarket_review.md': '# 盘后\n\n- 来源：https://news.example.com/sk-hynix-hbm4-mass-production-2026-05-02\n- 研究包：sk-hynix-q1-2026-earnings-call-20260502.md\n',
    'Analysis-Report/_archive/thesis.md': 'SK hynix 个股 Thesis，见 [链接](https://www.example.com/en/sk-hynix-reports-record-quarterly-results-2026-04-24/)。\n',
    '研究包/search-results.json': '{"results": [{"url": "https://x.example.com/memory/sk-hynix-hbm-share-2026", "title": "SK hynix"}]}',
    'handover.md': '交接：memory-sk-hynix-capex-plan-2026-v2 这份要更新。\n',
    // after "/" or "-" it is part of a longer name, however random: a hashed file in a link
    'sources.md': `图：https://cdn.example.com/assets/sk-${hexKey(32)}.png 和 chart-sk-${hexKey(32)}.svg\n`,
  };
  for (const [name, text] of Object.entries(fine)) {
    const file = s.put(dir + name, text);
    assert.equal((await s.read(file, { texts: s.named(file) })).text, text, name);
  }
  // real ones still are: one long random run between the dashes, after a space, "=" or a quote
  for (const [name, text] of Object.entries({
    'a.md': `用这个：${'sk' + '-proj-' + randomKey(100)}\n`,
    'b.txt': `OPENAI=${'sk' + '-' + randomKey(48)}\n`,
    'c.json': `{"k": "${'sk' + '-or-v1-' + hexKey(64)}"}`,
  })) {
    const file = s.put(dir + 'keys/' + name, text);
    assert.deepEqual(await s.read(file, { texts: s.named(file) }), { ok: false, code: 'denied' }, name);
  }
});

test('more providers by prefix, when the key is a long random run', () => {
  const keys = { hf: 'hf' + '_' + randomKey(34), groq: 'gsk' + '_' + randomKey(52), gitlab: 'glpat' + '-' + randomKey(20), xai: 'xai' + '-' + randomKey(80),
    stripe: 'sk' + '_live_' + randomKey(24), npm: 'npm' + '_' + randomKey(36), pypi: 'pypi' + '-' + randomKey(60), tavily: 'tvly' + '-' + randomKey(32),
    replicate: 'r8' + '_' + randomKey(37), awsTemp: 'ASIA' + randomKey(16).toUpperCase().replace(/[^A-Z0-9]/g, 'Q') };
  for (const [name, key] of Object.entries(keys)) assert.equal(secretText(`见 ${key} 。\n`), true, name);
  for (const text of ['npm_config_cache_dir_2026_v2 在 CI 里设置', 'hf_hub_download(repo_id="org/model-2026")', 'ASIA-PACIFIC 2026 Q1 报告', 'xai-grok-4-fast-reasoning-2026',
    'r8_model_version_2026_v12', 'pypi-release-notes-2026-10-09']) assert.equal(secretText(text), false, text);
});

test('a UTF-16 file is decoded before it is read for keys', async (t) => {
  const s = setup(t);
  const utf16 = (text, big) => {
    const le = Buffer.from(text, 'utf16le');
    return big ? Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16()]) : Buffer.concat([Buffer.from([0xff, 0xfe]), le]);
  };
  const dir = 'aiproject/Playground/ps/';
  const key = `api_key: ${'sk' + '-ant-api03-' + randomKey(80)}\r\n`;
  for (const big of [false, true]) {
    const file = s.put(dir + (big ? 'be' : 'le') + '-config.yaml', utf16(key, big));
    assert.deepEqual(await s.read(file, { texts: s.named(file) }), { ok: false, code: 'denied' }, big ? 'UTF-16BE' : 'UTF-16LE');
    const report = '# PowerShell 写出的报告\r\n\r\n一切正常。\r\n';
    const plain = s.put(dir + (big ? 'be' : 'le') + '-report.md', utf16(report, big));
    assert.equal((await s.read(plain, { texts: s.named(plain) })).text, report, big ? 'UTF-16BE' : 'UTF-16LE');
  }
});

test('a backup copy is judged by the name it was copied from', async (t) => {
  const s = setup(t);
  const at = (name) => s.put('aiproject/projectAlpha/reports/' + name, 'S');
  await refusedEverywhere(s, ['auth.json.bak', 'auth.json.old', 'AUTH.JSON.BAK', 'key.txt.bak', '.env.orig', 'deploy.env~', 'credentials.json.1', 'service-account.json.backup',
    'token.json.save', 'terraform.tfstate.tmp', 'id_rsa~', 'server.pem.bak.2', '.npmrc.bak', 'Local State.old'].map(at));
  await readable(s, ['backup-notes.md', 'old-plan.md', 'review.md.bak', 'report.md.old', 'notes.txt.1', 'tmp-results.md'].map((name) => s.put('aiproject/projectAlpha/reports/' + name, '文档')));
});

test('OAuth, Firebase admin, Playwright sign-in, kubeconfig, rclone, WireGuard and DPAPI files are refused by name', async (t) => {
  const s = setup(t);
  const at = (name) => s.put('aiproject/Playground/tool/' + name, '{}');
  await refusedEverywhere(s, ['oauth-client.json', 'oauth_tokens.json', 'OAuth2.json', 'storage_state.json', 'storageState.json', 'storage-state-admin.json',
    'my-app-firebase-adminsdk-ab12c.json', 'kubeconfig', 'kubeconfig.yaml', 'rclone.conf', 'wg0.conf', 'wg-home.conf', 'master.dpapi', 'mykey.txt', 'openaikey.txt',
    'deepseekkey.txt'].map(at));
  await readable(s, ['monkey.txt', 'turkey.md', 'hockey-notes.txt', 'kube-notes.md', 'wget.conf', 'oauth-flow.md', 'storage-notes.json', 'adminsdk-guide.md', 'keyboard.md']
    .map((name) => s.put('aiproject/Playground/tool/' + name, '说明')));
});

test('a file with a second name (a hard link) is not sent to the phone', async (t) => {
  const s = setup(t);
  const key = s.put('home/.ssh/config.md', 'Host secret');
  const alias = s.at('aiproject/Playground/demo/innocent.md');
  fs.linkSync(key, alias);
  assert.deepEqual(await s.read(alias, { texts: s.named(alias) }), { ok: false, code: 'denied' });
  // an ordinary file with two names, too: the name it is reached by says nothing about it
  const twin = s.at('aiproject/Playground/demo/twin.md');
  fs.linkSync(s.at('aiproject/Playground/demo/report.md'), twin);
  assert.deepEqual(await s.read(twin, { texts: s.named(twin) }), { ok: false, code: 'denied' });
  fs.rmSync(twin);
  const report = s.at('aiproject/Playground/demo/report.md');
  assert.equal((await s.read(report, { texts: s.named(report) })).text, '游乐场报告');
});

test('the desktop preview pane refuses what the phone refuses, and shows other clicked files', async (t) => {
  const s = setup(t);
  const home = s.at('home');
  // any folder is fine on the desktop: the user clicked it on this computer
  assert.equal(localRefusal(s.at('outside/private.md'), { home }), '');
  assert.equal(SideMain.readPreview(s.at('outside/private.md'), s.at('outside/private.md'), home).text, '外面的私人文件');
  for (const rel of ['outside/.env', 'outside/auth.json', 'outside/a.key', 'outside/id_rsa_old', 'outside/my_token.txt', 'outside/token.json', 'outside/secrets/a.md', 'outside/credentials/a.md']) {
    const file = s.put(rel, 'SECRET');
    assert.equal(localRefusal(file, { home }), 'secret', rel);
    const shown = SideMain.readPreview(file, file, home);
    assert.equal(shown.ok, false, rel);
    assert.equal(shown.text, undefined, rel);
  }
  assert.equal(localRefusal(s.at('outside/none.md'), { home }), 'missing');
  // a report that only mentions the word is shown
  const usage = s.put('outside/token-usage.md', '# 用量');
  assert.equal(localRefusal(usage, { home }), '');
  assert.equal(SideMain.readPreview(usage, usage, home).text, '# 用量');
  fs.rmSync(usage);
  // a folder listing leaves key files out
  const listing = SideMain.readPreview(s.at('outside'), s.at('outside'), home);
  assert.deepEqual(listing.entries.map((e) => e.name), ['projectBeta', 'private.md']);
});

// ---- through the phone route and the setting -----------------------------------
test('the phone route uses the Settings folders, the default until Settings holds a list, and keeps the list', async (t) => {
  const s = setup(t);
  const report = s.at('aiproject/Playground/demo/report.md');
  const saved = [];
  const captain = { id: 'captain', title: '队长', status: 'idle', turns: [{ id: 't1', user: '', reply: `报告在 ${report}`, done: true }] };
  const server = new MobileWebServer({ getSessions: () => [], getTasks: () => [], getCaptain: () => captain, getAttention: () => ({ items: [] }), getOutput: () => null,
    sendCaptain: () => {}, saveSettings: (value) => saved.push(value), preview: { home: s.at('home'), tmp: s.at('no-temp-here'), defaultExtra: s.extra } });
  t.after(() => server.close());
  let status = await server.configure({ enabled: true, port: 0 });
  assert.deepEqual([status.previewRoots, status.previewRootsDefault], [s.extra, true]);
  const call = (body, headers) => new Promise((resolve, reject) => {
    const req = http.request(status.url + '/api/file', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: status.url, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  const login = async () => {
    const auth = { Authorization: `Bearer ${status.token}` };
    const csrf = await new Promise((resolve, reject) => http.get(status.url + '/api/auth', { headers: auth }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).csrfToken));
    }).on('error', reject));
    return { ...auth, 'X-CSRF-Token': csrf };
  };
  let auth = await login();
  assert.equal((await call({ path: report }, auth)).body.text, '游乐场报告');
  // Settings emptied: refused, and the empty list is what is kept
  status = await server.configure({ previewRoots: [] });
  assert.deepEqual([status.previewRoots, status.previewRootsDefault, saved.at(-1).previewRoots], [[], false, []]);
  auth = await login();
  assert.deepEqual([(await call({ path: report }, auth)).status], [403]);
  // a hand-edited list keeps only the folders that are allowed
  status = await server.configure({ previewRoots: [s.at('aiproject/Playground'), '\\\\srv\\share\\x', 'D:\\'] });
  assert.deepEqual(status.previewRoots, [s.at('aiproject/Playground')]);
  auth = await login();
  assert.equal((await call({ path: report }, auth)).body.text, '游乐场报告');
  // null goes back to the default
  status = await server.configure({ previewRoots: null });
  assert.deepEqual([status.previewRoots, status.previewRootsDefault, 'previewRoots' in saved.at(-1)], [s.extra, true, false]);
});

test('a Mac temp path under /private is not a .private folder; a private folder anywhere below still is', () => {
  for (const name of ['/private/tmp/agentdeck/report.md', '/private/var/folders/l8/x/T/agentdeck-preview-1/reports/review.md',
    '/private/var/folders/l8/x/T/TemporaryItems/NSIRD_screencaptureui_a1/Screenshot.png'])
    assert.equal(secretPath(name, { home: '/Users/me', platform: 'darwin' }), false, name);
  for (const name of ['/private/tmp/p/.private/login.md', '/private/tmp/p/private/notes.md', '/Users/me/p/private/notes.md'])
    assert.equal(secretPath(name, { home: '/Users/me', platform: 'darwin' }), true, name);
  assert.equal(secretPath('/private/notes.md', { home: '/home/me', platform: 'linux' }), true);
});
