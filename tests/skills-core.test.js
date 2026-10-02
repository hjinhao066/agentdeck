const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { discover, frontMatter, createSkillCatalog, MAX_SKILL_BYTES } = require('../skills-core');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-skills-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const home = path.join(tmp, 'home');
const outside = path.join(tmp, 'outside');
const h = (...p) => path.join(home, ...p);
function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
// Windows CI: directory junctions need no symlink privilege but an absolute target.
function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  if (process.platform === 'win32') fs.symlinkSync(path.resolve(path.dirname(at), target), at, 'junction');
  else fs.symlinkSync(target, at, 'dir');
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const ALPHA = '---\nname: alpha\ndescription: >\n  共享的技能\n  第二行\n---\n# Alpha\n';
put(h('.agents', 'skills', 'alpha', 'SKILL.md'), ALPHA);
put(h('.agents', 'skills', 'nuwa', 'SKILL.md'), '---\nname: nuwa\n---\n');
put(h('.agents', 'skills', 'nuwa', 'examples', 'feynman', 'SKILL.md'), '---\nname: feynman\n---\n');
link('..', h('.agents', 'skills', 'nuwa', 'loop'));
link('../../.agents/skills/alpha', h('.claude', 'skills', 'alpha'));
link(h('.agents', 'skills', 'nuwa'), h('.claude', 'skills', 'nuwa'));
put(h('.claude', 'skills', 'own', 'SKILL.md'), '---\nname: alpha\n---\nClaude only\n');
put(h('.codex', 'skills', 'alpha', 'SKILL.md'), ALPHA);
put(h('.codex', 'skills', '.system', 'sys', 'SKILL.md'), '---\nname: sys\n---\n');
put(h('.codex', 'skills', 'tool', 'node_modules', 'dep', 'SKILL.md'), 'ignored');
put(h('.codex', 'plugins', 'cache', 'market', 'plug', '1.0.0', 'skills', 'plugged', 'SKILL.md'), '---\nname: plugged\n---\n');
link('../../../.agents/skills/alpha', h('.gemini', 'antigravity', 'global_skills', 'alpha'));
put(path.join(outside, 'evil', 'SKILL.md'), 'outside\n');
put(path.join(outside, 'evil', 'deep', 'SKILL.md'), 'never crawled\n');
link(path.join(outside, 'evil'), h('.claude', 'skills', 'escape'));
put(h('.claude', 'plugins', 'cache', 'm', 'good', '1', 'skills', 'cp', 'SKILL.md'), '---\nname: cp\n---\n');
put(path.join(outside, 'plug', 'skills', 'bad', 'SKILL.md'), 'not installed here\n');
put(h('.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
  'good@m': [{ installPath: h('.claude', 'plugins', 'cache', 'm', 'good', '1') }],
  'bad@x': [{ installPath: path.join(outside, 'plug') }],
} }));

const byPath = (skills, ...p) => skills.find((s) => s.path === h(...p));

test('groups symlinked copies, keeps independent copies and finds nested and plugin skills', () => {
  const { skills } = discover(home);
  const alpha = byPath(skills, '.agents', 'skills', 'alpha', 'SKILL.md');
  assert.equal(alpha.category, 'shared');
  assert.equal(alpha.kind, 'canonical');
  assert.deepEqual(alpha.users, ['claude', 'antigravity']);
  assert.deepEqual(alpha.links.map((l) => l.path).sort(), [
    h('.claude', 'skills', 'alpha', 'SKILL.md'), h('.gemini', 'antigravity', 'global_skills', 'alpha', 'SKILL.md')].sort());
  assert.equal(alpha.description, '共享的技能 第二行');
  assert.equal(skills.filter((s) => s.path.endsWith(path.join('alpha', 'SKILL.md')) && s.category === 'shared').length, 1);

  const codexAlpha = byPath(skills, '.codex', 'skills', 'alpha', 'SKILL.md');
  assert.equal(codexAlpha.category, 'codex');
  assert.deepEqual(codexAlpha.users, ['codex']);
  assert.notEqual(codexAlpha.key, alpha.key);
  const own = byPath(skills, '.claude', 'skills', 'own', 'SKILL.md');
  assert.equal(own.category, 'claude');
  assert.equal(own.name, 'alpha');

  const feynman = byPath(skills, '.agents', 'skills', 'nuwa', 'examples', 'feynman', 'SKILL.md');
  assert.equal(feynman.nested, true);
  assert.equal(feynman.relDir, 'nuwa/examples/feynman');
  assert.deepEqual(feynman.users, ['claude']);
  assert.equal(byPath(skills, '.codex', 'skills', '.system', 'sys', 'SKILL.md').category, 'codex');
  assert.equal(skills.some((s) => s.path.includes('node_modules')), false);

  const plugged = byPath(skills, '.codex', 'plugins', 'cache', 'market', 'plug', '1.0.0', 'skills', 'plugged', 'SKILL.md');
  assert.equal(plugged.kind, 'plugin');
  assert.match(plugged.source, /market\/plug\/1\.0\.0/);
  assert.equal(byPath(skills, '.claude', 'plugins', 'cache', 'm', 'good', '1', 'skills', 'cp', 'SKILL.md').kind, 'plugin');
  assert.equal(skills.some((s) => s.path.startsWith(path.join(outside, 'plug'))), false);

  const escaped = skills.filter((s) => s.path.startsWith(outside));
  assert.deepEqual(escaped.map((s) => s.path), [path.join(outside, 'evil', 'SKILL.md')]);
  assert.match(escaped[0].blocked, /之外/);
});

test('saves Chinese Markdown into the shared original without replacing links', () => {
  const file = h('.agents', 'skills', 'alpha', 'SKILL.md');
  fs.chmodSync(file, 0o640);
  const catalog = createSkillCatalog(home);
  const alpha = catalog.list().skills.find((s) => s.path === file);
  const doc = catalog.read(alpha.key);
  assert.equal(doc.ok, true);
  assert.equal(doc.text, ALPHA);
  assert.equal(doc.editable, true);
  const next = ALPHA + '\n## 用法\n中文内容 ✓ 保留全文\n\n';
  const r = catalog.save(alpha.key, next, doc.hash);
  assert.equal(r.ok, true);
  assert.equal(r.hash, sha(next));
  assert.equal(fs.readFileSync(file, 'utf8'), next);
  assert.equal(fs.readFileSync(h('.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'), next);
  assert.equal(fs.lstatSync(h('.claude', 'skills', 'alpha')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(h('.gemini', 'antigravity', 'global_skills', 'alpha')).isSymbolicLink(), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['SKILL.md']);
  assert.equal(catalog.read(alpha.key).hash, r.hash);
});

test('refuses to save over a file changed after it was opened', () => {
  const file = h('.codex', 'skills', 'alpha', 'SKILL.md');
  const catalog = createSkillCatalog(home);
  const item = catalog.list().skills.find((s) => s.path === file);
  const doc = catalog.read(item.key);
  fs.writeFileSync(file, 'someone else\n');
  const r = catalog.save(item.key, 'mine\n', doc.hash);
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'someone else\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['SKILL.md']);
});

test('rejects unknown keys, escaping links, swapped files and oversized content', () => {
  const catalog = createSkillCatalog(home);
  const { skills } = catalog.list();
  assert.equal(catalog.read('../../etc/passwd').ok, false);
  assert.equal(catalog.read('0'.repeat(24)).ok, false);
  assert.equal(catalog.save(h('.agents', 'skills', 'alpha', 'SKILL.md'), 'x', sha('x')).ok, false);

  const evil = skills.find((s) => s.blocked);
  const evilFile = path.join(outside, 'evil', 'SKILL.md');
  assert.equal(catalog.read(evil.key).ok, false);
  assert.equal(catalog.save(evil.key, 'pwned', sha('outside\n')).ok, false);
  assert.equal(fs.readFileSync(evilFile, 'utf8'), 'outside\n');

  const own = skills.find((s) => s.path === h('.claude', 'skills', 'own', 'SKILL.md'));
  const doc = catalog.read(own.key);
  assert.equal(catalog.save(own.key, 'x'.repeat(MAX_SKILL_BYTES + 1), doc.hash).ok, false);
  assert.equal(catalog.save(own.key, 'x', 'not-a-hash').ok, false);
  fs.rmSync(path.dirname(own.path), { recursive: true });
  link(path.join(outside, 'evil'), path.dirname(own.path));
  const swapped = catalog.save(own.key, 'pwned', sha('outside\n'));
  assert.equal(swapped.ok, false);
  assert.equal(fs.readFileSync(evilFile, 'utf8'), 'outside\n');
});

test('refuses to save over binary, non-UTF-8 and hard-linked files even with the read hash', () => {
  const bin = h('.grok', 'skills', 'bin', 'SKILL.md');
  const latin = h('.grok', 'skills', 'latin', 'SKILL.md');
  const hard = h('.grok', 'skills', 'hard', 'SKILL.md');
  const twin = path.join(outside, 'hard-twin.md');
  put(bin, Buffer.from([0x23, 0x20, 0x00, 0x41, 0x0a]));
  put(latin, Buffer.from([0x23, 0x20, 0xe9, 0x74, 0xe9, 0x0a]));
  put(hard, 'hard\n');
  fs.linkSync(hard, twin);
  const catalog = createSkillCatalog(home);
  const { skills } = catalog.list();
  for (const [file, reason] of [[bin, /二进制/], [latin, /UTF-8/], [hard, /硬链接/]]) {
    const before = fs.readFileSync(file);
    const item = skills.find((s) => s.path === file);
    const doc = catalog.read(item.key);
    assert.equal(doc.ok, true);
    const r = catalog.save(item.key, 'replaced\n', sha(before));
    assert.equal(r.ok, false);
    assert.match(r.error, reason);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['SKILL.md']);
  }
  assert.equal(catalog.read(skills.find((s) => s.path === bin).key).editable, false);
  assert.equal(catalog.read(skills.find((s) => s.path === latin).key).editable, false);
  assert.equal(fs.readFileSync(twin, 'utf8'), 'hard\n');
  assert.equal(fs.statSync(hard).nlink, 2);
});

test('re-checks the file just before the rename, after the temp file is written', () => {
  const file = h('.grok', 'skills', 'race', 'SKILL.md');
  const twin = path.join(outside, 'race-twin.md');
  put(file, 'race\n');
  const catalog = createSkillCatalog(home);
  const item = catalog.list().skills.find((s) => s.path === file);
  const doc = catalog.read(item.key);
  const fsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => { fs.fsyncSync = fsync; fsync(fd); fs.linkSync(file, twin); };
  let r;
  try { r = catalog.save(item.key, 'mine\n', doc.hash); } finally { fs.fsyncSync = fsync; }
  assert.equal(r.ok, false);
  assert.match(r.error, /硬链接/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'race\n');
  assert.equal(fs.readFileSync(twin, 'utf8'), 'race\n');
  assert.equal(fs.statSync(file).nlink, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['SKILL.md']);
});

test('reads front matter names and folded descriptions', () => {
  assert.deepEqual(frontMatter('---\nname: "x"\ndescription: |\n  a\n  b\nother: 1\n---\nbody'), { name: 'x', description: 'a b' });
  assert.deepEqual(frontMatter('# no front matter'), {});
});
