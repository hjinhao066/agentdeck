'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../claude-seats-core');
const M = require('../claude-seats-main');
const { setup, SHARED } = require('../scripts/setup-claude-us');

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-seats-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}
test('seat config has one source for names and survives normalization', () => {
  assert.deepEqual(S.normalize().map((s) => s.id), ['cn', 'us']);
  const config = { claudeSeats: S.normalize(), activeClaudeSeatId: 'us' };
  config.claudeSeats[1].name = '第二席';
  assert.equal(S.active(config).name, '第二席');
  assert.equal(S.active({ activeClaudeSeatId: 'gone' }).id, 'cn');
  assert.equal(S.normalize([{ id: '../../bad', configDir: 'x' }])[0].id, 'cn');
  assert.equal(S.normalize([...S.normalize(), S.normalize()[0]]).length, 2);
  assert.deepEqual(S.normalize().map((s) => s.icon), ['🇨🇳', '🇺🇸']);
  assert.match(S.CODEX_COMMAND, /--model gpt-6\.1-sol/);
  assert.match(S.CODEX_COMMAND, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(S.CLAUDE_COMMAND, /--model claude-opus-5-5/);
});
test('us setup shares brain files, never credentials/account/caches; repeat is safe', (t) => {
  const home = fixture(t), cn = path.join(home, '.claude');
  fs.writeFileSync(path.join(cn, 'settings.json'), '{}');
  fs.mkdirSync(path.join(cn, 'skills'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test' }, projects: { '/repo': { hasTrustDialogAccepted: true } }, mcpServers: { local: { command: 'node' } } }));
  const result = setup(home);
  assert.equal(fs.realpathSync(path.join(result.us, 'projects')), path.join(cn, 'projects'));
  assert.equal(fs.realpathSync(path.join(result.us, 'settings.json')), path.join(cn, 'settings.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.us, '.claude.json'))).oauthAccount, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.us, '.claude.json'))).mcpServers.local.command, 'node');
  for (const name of ['.credentials.json', '.claude.json', 'stats-cache.json', 'cache', 'session-env', 'scheduled_tasks.lock']) assert.ok(!SHARED.includes(name));
  fs.writeFileSync(path.join(result.us, '.claude.json'), '{"oauthAccount":{"emailAddress":"us@example.test"}}');
  setup(home);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.us, '.claude.json'))).oauthAccount.emailAddress, 'us@example.test');
});
test('setup refuses conflicts without replacing files or existing login', (t) => {
  const home = fixture(t), us = path.join(home, '.claude-us');
  fs.mkdirSync(us); fs.writeFileSync(path.join(us, 'projects'), 'keep');
  assert.throws(() => setup(home), /已有独立/);
  assert.equal(fs.readFileSync(path.join(us, 'projects'), 'utf8'), 'keep');
  assert.ok(!fs.existsSync(path.join(us, '.claude.json')));
});
test('setup carries onboarding for an authenticated US profile without copying CN identity or permissions', (t) => {
  const home = fixture(t);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.288', oauthAccount: { emailAddress: 'cn@example.test' }, bypassPermissionsModeAccepted: true }));
  const { us } = setup(home), file = path.join(us, '.claude.json');
  const initial = JSON.parse(fs.readFileSync(file));
  assert.equal(initial.hasCompletedOnboarding, true);
  assert.equal(initial.oauthAccount, undefined);
  assert.equal(initial.bypassPermissionsModeAccepted, undefined);
  const loggedIn = { oauthAccount: { emailAddress: 'us@example.test' }, keep: 'local' };
  fs.writeFileSync(file, JSON.stringify(loggedIn));
  setup(home);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...loggedIn, hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.288' });
  fs.writeFileSync(file, JSON.stringify({ ...loggedIn, hasCompletedOnboarding: false }));
  setup(home);
  assert.equal(JSON.parse(fs.readFileSync(file)).hasCompletedOnboarding, false);
});
test('default cn leaves config env unset, us uses its own service and removes overrides', (t) => {
  const home = fixture(t), [cn, us] = S.normalize();
  const before = { CLAUDE_CONFIG_DIR: '/elsewhere', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/other', CLAUDE_CODE_OAUTH_TOKEN: 'test-override', ANTHROPIC_API_KEY: 'test-override', ANTHROPIC_AUTH_TOKEN: 'test-override', AGENTDECK_COL_ID: 'col', PATH: '/bin' };
  const a = M.seatEnvironment(before, cn, home), b = M.seatEnvironment(before, us, home);
  assert.equal(a.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(b.CLAUDE_CONFIG_DIR, path.join(home, '.claude-us'));
  for (const key of ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) assert.ok(!(key in b));
  assert.equal(b.AGENTDECK_COL_ID, 'col');
  assert.equal(before.CLAUDE_CONFIG_DIR, '/elsewhere');
  assert.equal(M.credentialLocation(cn, home).keychainService, 'Claude Code-credentials');
  assert.match(M.credentialLocation(us, home).keychainService, /^Claude Code-credentials-[a-f0-9]{8}$/);
  assert.equal(M.credentialLocation({ ...cn, configDir: path.join(home, '.claude') }, home).keychainService, 'Claude Code-credentials');
});
test('account links and relative config dirs are rejected before launch', (t) => {
  const home = fixture(t), us = setup(home).us;
  assert.throws(() => M.directory({ configDir: '../somewhere' }, home), /绝对/);
  fs.symlinkSync(path.join(home, '.claude.json'), path.join(us, '.credentials.json'));
  assert.throws(() => M.seatEnvironment({}, S.normalize()[1], home), /符号链接/);
  assert.throws(() => setup(home), /登录文件不能是符号链接/);
});
test('metadata yields only a masked email and no credential material', async (t) => {
  const home = fixture(t), [cn, us] = S.normalize(); setup(home);
  fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"cn@example.test"}}');
  fs.writeFileSync(path.join(home, '.claude-us', '.claude.json'), '{"oauthAccount":{"emailAddress":"us@example.test"}}');
  const queried = [];
  const keychain = async (service) => { queried.push(service); return service === 'Claude Code-credentials'; };
  const a = await M.seatInfo(cn, home, 'darwin', keychain), b = await M.seatInfo(us, home, 'darwin', keychain);
  assert.equal(a.maskedEmail, 'c***@example.test'); assert.equal(a.loggedIn, true); assert.equal(b.loggedIn, false);
  assert.equal(S.maskEmail('broken'), '');
  assert.ok(!JSON.stringify(a).includes('cn@example.test'));
  assert.equal(queried.length, 2);
});
test('launch reasserts the seat after shell overrides and handles spaces/quotes', (t) => {
  if (process.platform === 'win32') return;
  const home = fixture(t), bin = path.join(home, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s" "${CLAUDE_CONFIG_DIR-unset}"\n', { mode: 0o700 });
  for (const seat of S.normalize()) {
    const command = S.launchCommand(`"${bin}" --model sonnet`, seat, home, 'darwin');
    const actual = execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, CLAUDE_CONFIG_DIR: '/wrong', ANTHROPIC_API_KEY: 'fake' }, encoding: 'utf8' });
    assert.equal(actual, seat.id === 'cn' ? 'unset' : path.join(home, '.claude-us'));
  }
  const tricky = { id: 'us', configDir: path.join(home, "seat's folder") };
  assert.equal(execFileSync('/bin/sh', ['-c', S.launchCommand(`"${bin}"`, tricky, home, 'darwin')], { encoding: 'utf8' }), tricky.configDir);
  assert.equal(S.launchCommand('codex --yolo', S.normalize()[1], home, 'darwin'), 'codex --yolo');
  assert.match(S.launchCommand('claude --model sonnet', tricky, 'C:\\Users\\test', 'win32'), /Remove-Item Env:CLAUDE_CONFIG_DIR/);
});
test('quota files are independent and contain only real native usage observations', (t) => {
  const home = fixture(t); setup(home);
  assert.equal(S.usage('Context: 23% | Session: 26% | Weekly: 13%'), null);
  const a = S.usage('Current session\n  30% used\n  Resets 5pm\nCurrent week (all models)\n  80% used\n  Resets Oct 8\n', 1234);
  assert.deepEqual(a.windows.map((w) => w.remaining), [70, 20]);
  M.writeUsage(S.normalize()[0], home, { ...a, accessToken: 'not-a-real-token' });
  M.writeUsage(S.normalize()[1], home, { ...a, windows: [{ key: 'fiveHour', remaining: 99 }] });
  assert.equal(M.readUsage(S.normalize()[0], home).windows[0].remaining, 70);
  assert.equal(M.readUsage(S.normalize()[1], home).windows[0].remaining, 99);
  assert.ok(!fs.readFileSync(M.credentialLocation(S.normalize()[0], home).usagePath, 'utf8').includes('accessToken'));
  assert.equal(S.usage('Current session\n  130% used\n'), null);
});
test('durable checkpoint saves full interrupted history and compact board before returning', (t) => {
  const home = fixture(t), userData = path.join(home, 'deck');
  const chat = { turns: [{ id: 'turn', user: 'continue work', reply: 'partly done', interrupted: true, ts: Date.now() }] };
  const file = M.checkpoint(home, userData, { colId: 'captain-old', chat, tasks: [{ colId: 'worker', title: 'Work', status: 'asking', receipt: { question: 'Which branch?' } }] });
  assert.match(fs.readFileSync(file, 'utf8'), /Which branch\?/);
  assert.match(fs.readFileSync(file, 'utf8'), /read --id captain-old/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'chats', 'captain-old.json'))).turns[0].interrupted, true);
  assert.throws(() => M.checkpoint(home, userData, { colId: '../unsafe', chat, tasks: [] }), /无效/);
});
