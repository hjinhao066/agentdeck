'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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
  assert.deepEqual(S.normalize().map((s) => s.id), ['cn', 'us', 'us2']);
  const config = { claudeSeats: S.normalize(), activeClaudeSeatId: 'us' };
  config.claudeSeats[1].name = '第二席';
  assert.equal(S.active(config).name, '第二席');
  assert.equal(S.active({ activeClaudeSeatId: 'gone' }).id, 'cn');
  assert.equal(S.normalize([{ id: '../../bad', configDir: 'x' }])[0].id, 'cn');
  assert.equal(S.normalize([...S.normalize(), S.normalize()[0]]).length, 3);
  assert.deepEqual(S.normalize().map((s) => s.icon), ['🇨🇳', '🇺🇸', '🇺🇸']);
  assert.match(S.CODEX_COMMAND, /--model gpt-6\.1-sol/);
  assert.match(S.CODEX_COMMAND, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(S.CODEX_COMMAND, /--no-daemon -c model_reasoning_effort=high/);
  assert.match(S.codexCommand('xhigh'), /model_reasoning_effort=xhigh/);
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
test('US2 startup initializes only the missing onboarding marker and preserves its independent login metadata', (t) => {
  const home = fixture(t), [cn, , us2] = S.normalize();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.289', oauthAccount: { emailAddress: 'cn@example.test' }, projects: { '/repo': { hasTrustDialogAccepted: true } } }));
  const loc = M.credentialLocation(us2, home);
  fs.mkdirSync(loc.dir, { recursive: true });
  const login = { oauthAccount: { emailAddress: 'us2@example.test', accountUuid: 'us2-private-id' }, localPreference: 'keep' };
  fs.writeFileSync(loc.metadataPath, JSON.stringify(login));
  assert.equal(M.onboardingComplete(us2, home), false);
  assert.equal(M.initializeOnboarding(us2, home, '/repo'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8')), {
    ...login, hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.289', projects: { '/repo': { hasTrustDialogAccepted: true } },
  });
  assert.equal(M.onboardingComplete(us2, home), true);
  fs.writeFileSync(loc.metadataPath, JSON.stringify({ ...login, hasCompletedOnboarding: false }));
  assert.equal(M.initializeOnboarding(us2, home), false);
  assert.equal(JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8')).hasCompletedOnboarding, false);
  assert.equal(M.initializeOnboarding(cn, home), true);
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
  assert.match(a.accountKey, /^[a-f0-9]{16}$/);
  assert.equal(a.credentialKey, crypto.createHash('sha256').update(M.credentialLocation(cn, home).keychainService).digest('hex').slice(0, 16));
  assert.equal(b.credentialKey, crypto.createHash('sha256').update(M.credentialLocation(us, home).keychainService).digest('hex').slice(0, 16));
  assert.notEqual(a.credentialKey, b.credentialKey);
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
    assert.equal(actual, seat.id === 'cn' ? 'unset' : S.configDir(seat, home, process.platform));
  }
  const tricky = { id: 'us', configDir: path.join(home, "seat's folder") };
  assert.equal(execFileSync('/bin/sh', ['-c', S.launchCommand(`"${bin}"`, tricky, home, 'darwin')], { encoding: 'utf8' }), tricky.configDir);
  assert.equal(S.launchCommand('codex --yolo', S.normalize()[1], home, 'darwin'), 'codex --yolo');
  assert.match(S.launchCommand('claude --model sonnet', tricky, 'C:\\Users\\test', 'win32'), /Remove-Item Env:CLAUDE_CONFIG_DIR/);
});
test('quota files are independent and contain only real native usage observations', (t) => {
  const home = fixture(t); setup(home);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test' } }));
  fs.writeFileSync(path.join(home, '.claude-us/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'us@example.test' } }));
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
  assert.match(fs.readFileSync(file, 'utf8'), /回复「队长已就绪」后立即自主接续/);
  assert.match(fs.readFileSync(file, 'utf8'), /存档后直接安装并重启/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'chats', 'captain-old.json'))).turns[0].interrupted, true);
  assert.throws(() => M.checkpoint(home, userData, { colId: '../unsafe', chat, tasks: [] }), /无效/);
});


test('existing sessions keep their launch directory through Relay and seat edits; new sessions use the new seat', (t) => {
  const home = fixture(t), config = { claudeSeats: S.normalize(), activeClaudeSeatId: 'cn' };
  const worker = {}, original = S.bindColumn(worker, config);
  const envBefore = M.seatEnvironment({}, original, home);
  config.activeClaudeSeatId = 'us';
  config.claudeSeats[0].configDir = '~/.claude-reconfigured';
  assert.equal(S.bindColumn(worker, config).configDir, '~/.claude');
  assert.deepEqual(M.seatEnvironment({}, S.bindColumn(worker, config), home), envBefore);
  assert.equal(S.launchCommand('claude', S.bindColumn(worker, config), home, 'darwin').includes('.claude-reconfigured'), false);
  assert.equal(S.bindColumn({}, config).id, 'us');
  assert.equal(S.bindColumn({}, config).configDir, '~/.claude-us');
  config.claudeSeats = config.claudeSeats.filter(s => s.id !== 'cn');
  assert.equal(S.bindColumn(worker, config).configDir, '~/.claude');
  assert.equal(S.bindColumn({ claudeSeatId: 'removed' }, config).configDir, '');
});

test('usage IPC refuses to attribute an old session to a reconfigured seat', (t) => {
  const home = fixture(t), handlers = {};
  M.registerSeatsIpc({ handleMain: (name, handler) => { handlers[name] = handler; }, home, getSeats: () => [{ id: 'cn', configDir: '~/.claude-new' }] });
  assert.throws(() => handlers['seats:record-usage'](null, { seatId: 'cn', configDir: '~/.claude', usage: { at: Date.now(), windows: [{ key: 'fiveHour', remaining: 53 }] } }), /目录已变更/);
  assert.equal(fs.existsSync(path.join(home, '.claude-new')), false);
});

test('per-session statusline numbers are recorded under the session account; shared statusline formats are not', (t) => {
  const home = fixture(t); setup(home);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test', accountUuid: 'cn-id' } }));
  fs.writeFileSync(path.join(home, '.claude-us/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'us@example.test', accountUuid: 'us-id' } }));
  const footer = S.footerUsage(['ʕ•ᴥ•ʔ  Opus 5.5 · high   5h剩余 83% · 7d剩余 59%', '██░░ 20%  ⎇ main'], 1234);
  assert.deepEqual(footer.windows.map((w) => [w.key, w.remaining]), [['fiveHour', 83], ['weekly', 59]]);
  assert.deepEqual(S.footerUsage(['Opus 5.5  5h剩 7% 7d剩 0%']).windows.map((w) => w.remaining), [7, 0]);
  // ccstatusline (machine-wide cache) and used-percent footers are never attributed to a seat.
  assert.equal(S.footerUsage(['Session: 47% | Weekly: 45%']), null);
  assert.equal(S.footerUsage(['Opus 5.5 · context 20%   5h 17% · 7d 2%']), null);
  M.writeUsage(S.normalize()[1], home, footer);
  const saved = JSON.parse(fs.readFileSync(M.credentialLocation(S.normalize()[1], home).usagePath, 'utf8'));
  assert.equal(saved.source, 'Claude 会话状态行');
  assert.equal(saved.configDir, path.join(home, '.claude-us'));
  assert.equal(M.readUsage(S.normalize()[1], home).windows[0].remaining, 83);
  assert.equal(M.readUsage(S.normalize()[0], home), null);
  assert.equal(M.sanitizeUsage({ ...footer, source: 'forged' }).source, 'Claude /usage');
});

test('the seat flag follows a Captain Relay immediately while workers keep their own seat', () => {
  const AgentInfo = require('../agent-info');
  const config = { claudeSeats: S.normalize(), activeClaudeSeatId: 'cn' };
  const captain = { isMain: true, cmd: 'claude --model claude-opus-5-5' }, worker = { cmd: 'claude --model claude-opus-5-5' };
  S.bindColumn(captain, config); S.bindColumn(worker, config);
  assert.deepEqual(AgentInfo.resolveAgentInfo(captain, null).seat, { id: 'cn', configDir: '~/.claude' });
  // MainSession.clearContext on Relay: only the replacement Captain adopts the new seat.
  captain.claudeSeatId = 'us'; delete captain.claudeConfigDir; config.activeClaudeSeatId = 'us';
  S.bindColumn(captain, config);
  assert.deepEqual(AgentInfo.resolveAgentInfo(captain, null).seat, { id: 'us', configDir: '~/.claude-us' });
  assert.deepEqual(AgentInfo.resolveAgentInfo(worker, null).seat, { id: 'cn', configDir: '~/.claude' });
});


test('recording owned usage invalidates quota cache only after a successful write', (t) => {
  const home = fixture(t); setup(home);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'offline-cn' } }));
  const handlers = {}; let invalidated = 0;
  M.registerSeatsIpc({ handleMain: (name, handler) => { handlers[name] = handler; }, home,
    getSeats: () => S.normalize(), getColumn: () => ({ id: 'cache-column', claudeSeatId: 'cn', claudeConfigDir: '~/.claude' }), onUsageRecorded: () => { invalidated++; } });
  const input = { colId: 'cache-column', seatId: 'cn', configDir: '~/.claude', usage: { at: Date.now(), windows: [{ key: 'fiveHour', remaining: 2 }] } };
  assert.equal(handlers['seats:record-usage'](null, input), true);
  assert.equal(invalidated, 1);
  assert.throws(() => handlers['seats:record-usage'](null, { ...input, configDir: '~/.wrong' }));
  assert.equal(invalidated, 1);
});

test('valid keychain credentials do not require profile email; failures name the exact seat', async (t) => {
  const home = fixture(t), us = S.normalize()[1];
  const valid = await M.seatInfo(us, home, 'darwin', async () => ({ present: true, loginReason: '' }));
  assert.equal(valid.loggedIn, true);
  assert.equal(valid.maskedEmail, '');
  const unavailable = await M.seatInfo(us, home, 'darwin', async () => ({ present: false, authReason: '无法核实钥匙串' }));
  assert.equal(unavailable.loginReason, '');
  assert.equal(unavailable.authReason, 'US（us）：无法核实钥匙串');
  const expired = await M.seatInfo(us, home, 'darwin', async () => ({ present: false, loginReason: '访问令牌已过期且没有刷新令牌' }));
  assert.equal(expired.id, 'us');
  assert.match(expired.loginReason, /US（us）.*没有刷新令牌/);
});
test('credential checks allow Claude to refresh expired access; no login prompt for access denial', async () => {
  const read = (oauth, error) => M.credentialStatus('seat-service', (file, args, options, cb) => {
    assert.equal(file, 'security');
    assert.deepEqual(args, ['find-generic-password', '-s', 'seat-service', '-w']);
    cb(error, JSON.stringify({ claudeAiOauth: oauth }));
  });
  const refreshed = await read({ accessToken: 'fake-access', expiresAt: Date.now() - 1, refreshToken: 'fake-refresh' });
  assert.equal(refreshed.present, true);
  assert.equal(refreshed.loginReason, '');
  const expired = await read({ accessToken: 'fake-access', expiresAt: Date.now() - 1 });
  assert.equal(expired.present, false); assert.match(expired.loginReason, /过期/);
  const locked = await read({}, { code: 1 });
  assert.equal(locked.loginReason, ''); assert.match(locked.authReason, /钥匙串访问权限/);
  assert.match((await read({}, { code: 44 })).loginReason, /没有登录凭据/);
  assert.doesNotMatch(JSON.stringify(refreshed), /fake-access|fake-refresh/);
});

test('usage IPC binds native panel observations to the saved source column and seat snapshot', (t) => {
  const home = fixture(t), handlers = {}, seat = S.normalize()[0], colId = 'captain-cn';
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test', accountUuid: 'cn-fixture-account' } }));
  const column = { id: colId, claudeSeatId: 'cn', claudeConfigDir: '~/.claude' };
  M.registerSeatsIpc({ handleMain: (name, handler) => { handlers[name] = handler; }, home,
    getSeats: () => [seat], getColumn: (id) => id === column.id ? column : null });
  const payload = { colId, seatId: 'cn', configDir: '~/.claude', usage: { at: Date.now(), windows: [{ key: 'fiveHour', remaining: 2 }] } };
  assert.throws(() => handlers['seats:record-usage'](null, { ...payload, colId: 'missing-column' }), /来源会话/);
  assert.throws(() => handlers['seats:record-usage'](null, { ...payload, colId: undefined }), /来源会话/);
  assert.equal(handlers['seats:record-usage'](null, payload), true);
  const value = handlers['seats:usage'](null, { seatId: 'cn' });
  assert.equal(value.accountBound, true);
  assert.match(value.accountKey, /^[a-f0-9]{16}$/);
  assert.equal(value.sourceColumnId, colId);
  assert.equal(value.configDir, seat.configDir);
  assert.equal(value.windows[0].remaining, 2);
  column.claudeConfigDir = '~/.claude-other';
  assert.throws(() => handlers['seats:record-usage'](null, payload), /快照不匹配/);

});

test('saved CN/US profiles gain US2 without changing names, directories or column bindings', () => {
  const legacy = S.normalize().slice(0, 2);
  legacy[1].name = 'My US'; legacy[0].configDir = '/custom/cn';
  const migrated = S.normalize(legacy);
  assert.deepEqual(migrated.slice(0, 2), legacy);
  assert.deepEqual(migrated[2], { id: 'us2', name: 'US2', icon: '🇺🇸', configDir: '~/.claude-us2' });
  assert.deepEqual(S.normalize(migrated), migrated);
  const col = { claudeSeatId: 'us', claudeConfigDir: '/pinned/us' };
  S.bindColumn(col, { claudeSeats: migrated, activeClaudeSeatId: 'us2' });
  assert.deepEqual(col, { claudeSeatId: 'us', claudeConfigDir: '/pinned/us' });
  assert.equal(S.normalize(Array.from({ length: 9 }, (_, i) => ({ id: `custom${i}`, configDir: `/seat/${i}` }))).length, 8);
});
test('US2 setup shares only brain files and its missing login stays isolated', async (t) => {
  const home = fixture(t);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  const original = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
  const us = setup(home).us;
  fs.writeFileSync(path.join(us, '.credentials.json'), 'stand-in-do-not-touch');
  const result = setup(home, 'us2');
  const seat = S.normalize()[2];
  assert.equal(result.us, path.join(home, '.claude-us2'));
  assert.equal(fs.realpathSync(path.join(result.us, 'settings.json')), path.join(home, '.claude', 'settings.json'));
  assert.equal(fs.existsSync(path.join(result.us, '.credentials.json')), false);
  assert.equal((await M.seatInfo(seat, home, 'win32')).loggedIn, false);
  assert.notEqual(M.credentialLocation(seat, home).keychainService, M.credentialLocation(S.normalize()[1], home).keychainService);
  assert.equal(M.seatEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: 'fake' }, seat, home).CLAUDE_CONFIG_DIR, result.us);
  assert.equal(fs.readFileSync(path.join(us, '.credentials.json'), 'utf8'), 'stand-in-do-not-touch');
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), original);
  assert.throws(() => setup(home, 'cn'), /独立席位/);
});
