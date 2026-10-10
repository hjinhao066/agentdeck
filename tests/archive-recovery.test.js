'use strict';
// Conversations that fell out of the archive come back. Before 2.0.4 the archive kept only
// its newest 500 sessions: an older one left config.archived at a launch and its saved
// output was deleted at the next, while userData/chats/<id>.json stayed on disk with nothing
// pointing at it (466 such conversations on the user's Mac on 2026-10-09). At launch
// ArchiveRecovery puts each of them back into config.archived, from the record an older copy
// of config.json still holds when there is one, otherwise from the chat file itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ArchiveRecovery = require('../archive-recovery.js');
const SC = require('../sidebar-core.js');

const turn = (user, ts, extra) => ({ id: 'u' + ts, ts, user, reply: 'done', done: true, atts: [], ...extra });
function profile(config, chats) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-archive-recovery-'));
  const configPath = path.join(dir, 'config.json');
  const chatDir = path.join(dir, 'chats');
  fs.mkdirSync(chatDir);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  for (const [name, chat] of Object.entries(chats)) {
    fs.writeFileSync(path.join(chatDir, name.includes('.') ? name : name + '.json'), typeof chat === 'string' ? chat : JSON.stringify({ v: 1, id: name, ...chat }));
  }
  return { dir, configPath, chatDir, read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
    // since the archive left config.json, the launch keeps it in archived.json beside it
    archive: () => JSON.parse(fs.readFileSync(path.join(dir, 'archived.json'), 'utf8')).archived, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const base = () => ({
  columns: [{ id: 'main', isMain: true, title: '队长' }, { id: 'c-live', title: 'open' }],
  archived: [{ id: 'c-kept', title: 'still archived', cmd: 'claude', archivedAt: 500 }],
  mainSession: { colId: 'main' },
  captainHistory: [{ id: 'c-captain-old', turns: 3 }],
  folders: [{ id: 'f1', name: 'Work' }],
  theme: 'dark',
});

test('a conversation that fell out of the archive is back in it after a launch', () => {
  const p = profile(base(), {
    'c-board-lost1': { turns: [turn('  修一下登录页的复制按钮\n第二行细节', 1000), turn('再跑一遍测试', 2000)] },
  });
  try {
    const before = fs.readFileSync(p.configPath, 'utf8');
    const result = ArchiveRecovery.recover({ configPath: p.configPath, chatDir: p.chatDir, backups: [], now: () => 9000 });
    assert.equal(result.added, 1);
    const after = p.read();
    const entry = after.archived.find((a) => a.id === 'c-board-lost1');
    assert.ok(entry, 'the lost conversation is listed in the archive again');
    assert.equal(entry.title, '修一下登录页的复制按钮', 'named after the first thing the user said');
    assert.equal(entry.archivedAt, 2000, 'dated by its last turn, so it sorts where it used to be');
    assert.equal(entry.recovered, true);
    assert.equal(entry.manualTitle, true, 'the name is not replaced by auto-naming after a restore');
    assert.equal(entry.isMain, undefined);
    // what the page loads at launch: the entry survives normalization and is restorable by id
    assert.ok(SC.normalizeArchived(after.archived).some((a) => a.id === 'c-board-lost1'));
    // nothing else in the config moved
    const { archived, ...rest } = after;
    const { archived: was, ...restWas } = JSON.parse(before);
    assert.deepEqual(rest, restWas);
    assert.deepEqual(archived.filter((a) => a.id !== 'c-board-lost1'), was);
    // the config as it was is kept next to it, byte for byte
    assert.ok(result.backup && path.dirname(result.backup) === p.dir && /config\.json\.before-archive-recovery-9000$/.test(result.backup));
    assert.equal(fs.readFileSync(result.backup, 'utf8'), before);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
      assert.equal(fs.statSync(p.configPath).mode & 0o777, 0o600);
    }
  } finally { p.done(); }
});

test('the record an older copy of config.json still holds is used as it was', () => {
  const p = profile(base(), {
    'c-board-lost1': { turns: [turn('指令原文', 1000)] },
    'c-board-lost2': { turns: [turn('另一条指令', 3000)] },
    'c-board-lost3': { turns: [turn('第三条', 4000)] },
  });
  try {
    const record = {
      id: 'c-board-lost1', title: '修复制按钮', displayTitle: '修复制按钮', cmd: 'claude --model opus', cwd: '/Users/x/repo', captainCrew: true,
      role: 'manual', relationship: 'Independent manual terminal', boardId: 't-1', modelSessionId: 's-1', archivedAt: 1500,
      worktree: { repo: '/Users/x/repo', path: '/Users/x/agentdeck-worktrees/repo/t-1', branch: 'agentdeck/t-1' },
    };
    // an install backup (newer) and a copy left beside config.json (older, different title)
    const backups = path.join(p.dir, 'install-backups');
    fs.mkdirSync(path.join(backups, '1791-a', 'userData'), { recursive: true });
    fs.writeFileSync(path.join(backups, '1791-a', 'userData', 'config.json'), JSON.stringify({ archived: [record, { id: 'c-board-lost3', title: 'was captain', isMain: true, archivedAt: 1 }] }));
    const older = path.join(p.dir, 'config.json.bak-older');
    fs.writeFileSync(older, JSON.stringify({ archived: [{ ...record, title: 'stale name' }, { id: 'c-board-lost2', title: '第二个', cmd: 'codex', archivedAt: 3500 }] }));
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.writeFileSync(path.join(p.dir, 'config.json.bad'), '{ not json');
    fs.writeFileSync(path.join(p.dir, 'config.json.tmp'), JSON.stringify({ archived: [{ ...record, title: 'half-written' }] }));

    const result = ArchiveRecovery.recover({ configPath: p.configPath, chatDir: p.chatDir, backups: [backups], now: () => 9000 });
    assert.equal(result.added, 3);
    const archived = p.read().archived;
    assert.deepEqual(archived.find((a) => a.id === 'c-board-lost1'), { ...record, recovered: true }, 'the newest copy wins, kept whole (command, folder, worktree, card)');
    assert.deepEqual(archived.find((a) => a.id === 'c-board-lost2'), { id: 'c-board-lost2', title: '第二个', cmd: 'codex', archivedAt: 3500, recovered: true });
    // a record that claims to be 队长 is never taken: there is exactly one 队长 column
    const third = archived.find((a) => a.id === 'c-board-lost3');
    assert.equal(third.title, '第三条');
    assert.equal(third.isMain, undefined);
  } finally { p.done(); }
});

test('only conversations the user spoke in, and that nothing points at, are taken', () => {
  const p = profile(base(), {
    'c-live': { turns: [turn('open column', 100)] },
    'c-kept': { turns: [turn('already archived', 100)] },
    'main': { turns: [turn('队长', 100)] },
    'c-captain-old': { captainArchive: true, turns: [turn('cleared 队长 chat', 100)] },
    'c-captain-flagged': { captainArchive: true, turns: [turn('another cleared 队长 chat', 100)] },
    'c-empty': { turns: [] },
    'c-blank': { turns: [turn('   ', 100)] },
    'c-notices': { turns: [turn('永动机', 100, { kind: 'notice' }), turn('派活', 200, { kind: 'task', task: { title: 'x' } })] },
    'c-broken': '{ "turns": [',
    'bad id.json': { turns: [turn('junk name', 100)] },
    'notes.txt': 'not a chat',
  });
  try {
    const before = fs.readFileSync(p.configPath, 'utf8');
    const scan = ArchiveRecovery.scan({ config: p.read(), chatDir: p.chatDir, sources: [] });
    assert.deepEqual(scan.entries, []);
    assert.equal(scan.silent, 3, 'empty, blank and notice-only chats are counted, and left on disk');
    const result = ArchiveRecovery.recover({ configPath: p.configPath, chatDir: p.chatDir, backups: [], now: () => 9000 });
    assert.equal(result.added, 0);
    assert.equal(fs.readFileSync(p.configPath, 'utf8'), before, 'config.json is not rewritten when there is nothing to bring back');
    assert.deepEqual(fs.readdirSync(p.dir).sort(), ['chats', 'config.json'], 'and no backup copy is made');
    assert.equal(fs.readdirSync(p.chatDir).length, 11, 'no chat file is touched');
  } finally { p.done(); }
});

test('a second launch adds nothing, and a missing or unreadable config is left alone', () => {
  const p = profile(base(), { 'c-board-lost1': { turns: [turn('第一条', 1000)] } });
  try {
    assert.equal(ArchiveRecovery.recover({ configPath: p.configPath, chatDir: p.chatDir, backups: [], now: () => 9000 }).added, 1);
    const once = fs.readFileSync(p.configPath, 'utf8');
    assert.equal(ArchiveRecovery.recover({ configPath: p.configPath, chatDir: p.chatDir, backups: [], now: () => 9500 }).added, 0);
    assert.equal(fs.readFileSync(p.configPath, 'utf8'), once);
    assert.equal(fs.readdirSync(p.dir).filter((f) => f.includes('before-archive-recovery')).length, 1);

    fs.writeFileSync(p.configPath, '{ broken');
    assert.equal(ArchiveRecovery.recover({ configPath: p.configPath, chatDir: p.chatDir, backups: [], now: () => 9600 }).added, 0);
    assert.equal(fs.readFileSync(p.configPath, 'utf8'), '{ broken');
    fs.rmSync(p.configPath);
    assert.equal(ArchiveRecovery.recover({ configPath: p.configPath, chatDir: p.chatDir, backups: [], now: () => 9700 }).added, 0);
    assert.equal(fs.existsSync(p.configPath), false, 'a first launch gets no config written for it');
  } finally { p.done(); }
});

// main.js at launch, taken from the source so the test follows it: recovery first, then the prune.
function launchStep() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const begin = source.indexOf('  // Conversations that fell out of the archive');
  const prune = source.indexOf('  // Prune replays for columns that no longer exist in the saved layout.');
  assert.ok(begin >= 0 && prune > begin, 'main.js brings lost conversations back before it prunes saved replays');
  const end = source.indexOf('  } catch (_) {}\n', prune) + '  } catch (_) {}\n'.length;
  return new Function('fs', 'path', 'configPath', 'SESS_DIR', 'CHAT_DIR', 'ArchiveRecovery', 'tudArg', 'HOME', source.slice(begin, end) + '\nreturn archiveRecovery;');
}

test('at launch a lost conversation is listed again before the prune, so a replay still on disk is kept', () => {
  const p = profile(base(), { 'c-board-lost1': { turns: [turn('第一条', 1000)] } });
  try {
    const SESS_DIR = path.join(p.dir, 'sessions');
    fs.mkdirSync(SESS_DIR);
    for (const id of ['c-board-lost1', 'c-kept', 'c-gone']) fs.writeFileSync(path.join(SESS_DIR, id + '.txt'), 'output of ' + id);
    // A test profile reads nothing outside itself: HOME holds a backup that must not be used.
    const home = path.join(p.dir, 'home');
    const outside = path.join(home, 'Library/Caches/AgentDeck-install-backups/1791-a/userData');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'config.json'), JSON.stringify({ archived: [{ id: 'c-board-lost1', title: 'from the real machine', archivedAt: 7 }] }));

    const result = launchStep()(fs, path, p.configPath, SESS_DIR, p.chatDir, ArchiveRecovery, '--test-user-data=' + p.dir, home);
    assert.equal(result.added, 1);
    assert.equal(p.archive().find((a) => a.id === 'c-board-lost1').title, '第一条');
    assert.equal(p.read().archived, undefined, 'the launch moved the archive out of config.json');
    assert.deepEqual(fs.readdirSync(SESS_DIR).sort(), ['c-board-lost1.txt', 'c-kept.txt'], 'its replay stays; a session that is really gone still loses its replay');
  } finally { p.done(); }
});

test('outside a test profile the install backups under the home folder are read', () => {
  const p = profile(base(), { 'c-board-lost1': { turns: [turn('第一条', 1000)] } });
  try {
    const SESS_DIR = path.join(p.dir, 'sessions');
    fs.mkdirSync(SESS_DIR);
    const home = path.join(p.dir, 'home');
    const outside = path.join(home, 'Library/Caches/AgentDeck-install-backups/1791-a/userData');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'config.json'), JSON.stringify({ archived: [{ id: 'c-board-lost1', title: '原来的名字', cmd: 'claude', archivedAt: 7 }] }));
    launchStep()(fs, path, p.configPath, SESS_DIR, p.chatDir, ArchiveRecovery, undefined, home);
    assert.deepEqual(p.archive().find((a) => a.id === 'c-board-lost1'), { id: 'c-board-lost1', title: '原来的名字', cmd: 'claude', archivedAt: 7, recovered: true });
  } finally { p.done(); }
});
