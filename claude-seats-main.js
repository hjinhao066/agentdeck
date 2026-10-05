'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const S = require('./claude-seats-core');
const { validId } = require('./security');
const { saveChat } = require('./side-main');
const { accountIdentity } = require('./quota-codex');
const os = require('os');
const Handoff = require('./relay-handoff-core');

function directory(seat, home) {
  const raw = seat.configDir.replace(/^~(?=$|[\\/])/, home);
  if (!path.isAbsolute(raw)) throw new Error('席位配置目录必须是绝对路径或 ~/ 路径');
  const dir = path.resolve(raw).normalize('NFC');
  if (dir === path.resolve(home, '.claude')) return dir;
  // A directory or account-file link to CN would silently share login.
  for (const file of [dir, path.join(dir, '.claude.json'), path.join(dir, '.credentials.json')]) {
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('席位目录和登录文件不能是符号链接'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return dir;
}
function credentialLocation(seat, home) {
  const dir = directory(seat, home), isDefault = dir === path.resolve(home, '.claude');
  return { dir, isDefault, metadataPath: isDefault ? path.join(home, '.claude.json') : path.join(dir, '.claude.json'),
    credentialsPath: path.join(dir, '.credentials.json'), usagePath: path.join(dir, 'agentdeck-usage.json'),
    keychainService: 'Claude Code-credentials' + (isDefault ? '' : '-' + crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)) };
}
function onboardingComplete(seat, home) {
  try {
    const loc = credentialLocation(seat, home);
    return JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8')).hasCompletedOnboarding === true;
  } catch (_) { return false; }
}
function initializeOnboarding(seat, home, projectDir) {
  const loc = credentialLocation(seat, home);
  if (loc.isDefault) return onboardingComplete(seat, home);
  let account, existing, defaults;
  try {
    existing = JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8'));
    account = existing.oauthAccount;
  } catch (_) { return false; }
  if (!account || typeof account !== 'object') return false;
  try { defaults = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); }
  catch (_) { return existing.hasCompletedOnboarding === true; }
  let changed = false;
  if (existing.hasCompletedOnboarding === undefined && defaults.hasCompletedOnboarding === true) {
    existing.hasCompletedOnboarding = true;
    if (typeof defaults.lastOnboardingVersion === 'string') existing.lastOnboardingVersion = defaults.lastOnboardingVersion;
    changed = true;
  }
  const trusted = typeof projectDir === 'string' && path.isAbsolute(projectDir) &&
    defaults.projects?.[projectDir]?.hasTrustDialogAccepted === true;
  if (trusted && existing.projects?.[projectDir]?.hasTrustDialogAccepted !== true &&
      existing.projects?.[projectDir]?.hasTrustDialogAccepted !== false) {
    existing.projects ||= {};
    existing.projects[projectDir] ||= {};
    existing.projects[projectDir].hasTrustDialogAccepted = true;
    changed = true;
  }
  if (!changed) return existing.hasCompletedOnboarding === true;
  const temp = loc.metadataPath + `.agentdeck-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(existing, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, loc.metadataPath);
    return existing.hasCompletedOnboarding === true;
  } catch (_) {
    try { fs.unlinkSync(temp); } catch (_) {}
    return false;
  }
}
const AUTH_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_GATEWAY_LINEAGE'];
function seatEnvironment(env, seat, home) {
  const result = { ...env }, loc = credentialLocation(seat, home);
  for (const key of AUTH_ENV) delete result[key];
  if (loc.isDefault) delete result.CLAUDE_CONFIG_DIR;
  else result.CLAUDE_CONFIG_DIR = loc.dir;
  return result;
}
function credentialStatus(service, execFileImpl = execFile) {
  return new Promise((resolve) => execFileImpl('security', ['find-generic-password', '-s', service, '-w'],
    { timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve({ present: false, loginReason: error.code === 44 ? '此席位没有登录凭据' : '', authReason: '无法核实此席位钥匙串，请检查钥匙串访问权限' });
      try {
        const oauth = JSON.parse(stdout).claudeAiOauth;
        const access = typeof oauth?.accessToken === 'string' && !!oauth.accessToken;
        const refresh = typeof oauth?.refreshToken === 'string' && !!oauth.refreshToken;
        const expired = Number.isFinite(oauth?.expiresAt) && oauth.expiresAt <= Date.now();
        const valid = (access && !expired) || refresh;
        resolve({ present: valid, loginReason: valid ? '' : expired ? '此席位访问令牌已过期且没有刷新令牌' : '此席位没有可用的 OAuth 凭据' });
      } catch (_) { resolve({ present: false, loginReason: '此席位凭据格式无效' }); }
    }));
}
async function seatInfo(seat, home, platform = process.platform, keychain = credentialStatus) {
  const loc = credentialLocation(seat, home);
  let email = '', accountKey = '';
  try {
    if (fs.statSync(loc.metadataPath).size <= 8 * 1024 * 1024) email = S.maskEmail(JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8')).oauthAccount?.emailAddress);
    accountKey = usageAccountKey(loc) || '';
  } catch (_) {}
  const status = platform === 'darwin' ? await keychain(loc.keychainService) : fs.existsSync(loc.credentialsPath);
  const present = typeof status === 'object' ? status.present : !!status;
  return { ...seat, configDir: loc.dir, maskedEmail: email, accountKey, onboardingComplete: onboardingComplete(seat, home),
    credentialKey: crypto.createHash('sha256').update(loc.keychainService).digest('hex').slice(0, 16), loggedIn: !!present,
    loginReason: typeof status === 'object' ? status.loginReason ? `${seat.name}（${seat.id}）：${status.loginReason}` : '' : present ? '' : `${seat.name}（${seat.id}）：没有登录凭据`,
    authReason: typeof status === 'object' ? status.authReason ? `${seat.name}（${seat.id}）：${status.authReason}` : '' : '', usagePath: loc.usagePath };

}
const USAGE_SOURCES = ['Claude /usage', 'Claude 会话状态行'];
function sanitizeUsage(value) {
  if (!value || !Number.isFinite(value.at) || !Array.isArray(value.windows)) throw new Error('无效用量记录');
  const windows = value.windows.filter((w) => ['fiveHour', 'weekly'].includes(w?.key) && Number.isFinite(w.remaining) && w.remaining >= 0 && w.remaining <= 100)
    .slice(0, 2).map((w) => ({ key: w.key, remaining: w.remaining, resetText: String(w.resetText || '').slice(0, 100) }));
  if (!windows.length) throw new Error('没有实际用量数据');
  const source = value.source === 'Claude OAuth usage' || USAGE_SOURCES.includes(value.source) ? value.source : 'Claude /usage';
  return { at: value.at, source, windows };
}
function usageAccountKey(loc) {
  if (fs.statSync(loc.metadataPath).size > 2 * 1024 * 1024) throw new Error('账号元数据过大');
  const account = JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8')).oauthAccount;
  return typeof account?.accountUuid === 'string' && account.accountUuid
    ? crypto.createHash('sha256').update(account.accountUuid).digest('hex').slice(0, 16)
    : accountIdentity(account?.emailAddress).accountKey;
}
function writeUsage(seat, home, value, sourceColumnId) {
  const loc = credentialLocation(seat, home), file = loc.usagePath;
  const accountKey = usageAccountKey(loc);
  if (!accountKey) throw new Error('无法确认用量所属账号');
  if (value?.source === 'Claude OAuth usage' && (value.accountKey !== accountKey || value.configDir !== loc.dir)) throw new Error('OAuth 用量所属账号或目录已变更');
  if (sourceColumnId !== undefined && !validId(sourceColumnId)) throw new Error('无效用量来源会话');
  const safe = { ...sanitizeUsage(value), accountKey, configDir: loc.dir };
  if (sourceColumnId) safe.sourceColumnId = sourceColumnId;

  fs.writeFileSync(file + '.tmp', JSON.stringify(safe), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function readUsage(seat, home) {
  try {
    const loc = credentialLocation(seat, home), value = JSON.parse(fs.readFileSync(loc.usagePath, 'utf8'));
    if (!value.accountKey || value.accountKey !== usageAccountKey(loc) || value.configDir !== loc.dir) return null;
    return { ...sanitizeUsage(value), accountBound: true, accountKey: value.accountKey, configDir: seat.configDir,
      ...(validId(value.sourceColumnId) ? { sourceColumnId: value.sourceColumnId } : {}) };

  }
  catch (_) { return null; }
}
// The Relay handoff, written from one snapshot. The renderer supplies what it
// holds (dispatch records, live sessions, unread receipts); the board cards and
// the Captain's decisions file are read here. The decisions file belongs to the
// Captain and is only ever read; the handoff file belongs to the app.
function handoff(home, userData, payload, options = {}) {
  if (!validId(payload?.colId) || !Array.isArray(payload.tasks) || payload.tasks.length > 120) throw new Error('无效队长存档');
  const dir = path.join(home, '.agents', 'boards');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const board = path.join(dir, Handoff.HANDOFF_FILE), notes = path.join(dir, Handoff.DECISIONS_FILE);
  try { fs.writeFileSync(notes, Handoff.DECISIONS_TEMPLATE, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const decisions = { path: notes, text: '', mtime: 0 };
  try {
    const stat = fs.statSync(notes);
    if (stat.isFile() && stat.size <= 512 * 1024) { decisions.text = fs.readFileSync(notes, 'utf8'); decisions.mtime = stat.mtimeMs; }
  } catch (_) {}
  // An unreadable board is said out loud; the dispatch records alone still go out.
  let cards = [], boardError = '';
  try { cards = options.cards ? options.cards() : []; } catch (error) { boardError = error.message; }
  const cap = (value, max) => (Array.isArray(value) ? value.slice(-max) : []);
  const machine = options.machine || {};
  const built = Handoff.build({
    now: Number.isFinite(payload.now) ? payload.now : Date.now(), timeZone: payload.timeZone, reason: payload.reason, cli: payload.cli, budget: payload.budget,
    platform: machine.platform || process.platform, host: machine.hostname || os.hostname(), appVersion: machine.appVersion || '', boardVersion: options.boardVersion ? options.boardVersion() : '',
    captain: { ...(payload.captain && typeof payload.captain === 'object' ? payload.captain : { previousId: payload.colId, message: payload.relayMessage || '' }) },
    cards, boardError, dispatches: payload.tasks, sessions: cap(payload.sessions, 400), archivedIds: cap(payload.archivedIds, 5000),
    pending: cap(payload.pending, 200), inflight: cap(payload.inflight, 200), unconfirmed: cap(payload.unconfirmed, 200), waitlist: cap(payload.waitlist, 200),
    carry: payload.carry, userTurns: cap(payload.userTurns, 12), decisions,
    paths: { handoff: board, decisions: notes, chats: path.join(userData, 'chats'), tasks: options.tasksDir || path.join(dir, 'tasks') },
  });
  fs.writeFileSync(board + '.tmp', built.text, { mode: 0o600 });
  fs.renameSync(board + '.tmp', board);
  return { path: board, text: built.text, plan: built.state.plan, level: built.level, over: built.over };
}
function checkpoint(home, userData, payload, options) {
  if (!validId(payload?.colId) || !payload.chat || !Array.isArray(payload.tasks) || payload.tasks.length > 120) throw new Error('无效队长存档');
  // Save the full old chat, including interrupted output, before allowing kill.
  const activeChat = { ...payload.chat };
  delete activeChat.captainArchive; // A failed checkpoint must leave an active chat active.
  if (!saveChat(path.join(userData, 'chats'), payload.colId, activeChat)) throw new Error('队长对话保存失败，没有Relay');
  return handoff(home, userData, { ...payload, reason: 'relay' }, options).path;
}
function registerSeatsIpc({ handleMain, home, userData, getSeats, getCaptainId, getColumn, platform = process.platform, onUsageRecorded = () => {}, handoffOptions }) {

  const find = (id) => { const seat = S.normalize(getSeats()).find((s) => s.id === id); if (!seat) throw new Error('席位不存在'); return seat; };
  handleMain('seats:list', () => Promise.all(S.normalize(getSeats()).map((s) => seatInfo(s, home, platform))));
  handleMain('seats:validate', (_e, { seats }) => {
    const normalized = S.normalize(seats);
    if (!Array.isArray(seats) || normalized.length !== seats.length) throw new Error('席位列表无效');
    const dirs = normalized.map((s) => directory(s, home));
    if (new Set(dirs.map((d) => process.platform === 'win32' ? d.toLowerCase() : d)).size !== dirs.length) throw new Error('席位必须使用不同配置目录');
    return normalized;
  });
  handleMain('seats:checkpoint', (_e, payload) => {
    if (payload?.colId !== getCaptainId()) throw new Error('只能存档当前队长');
    return checkpoint(home, userData, payload, handoffOptions);
  });
  // The same handoff on demand (`handoff` command): nothing is saved or killed.
  handleMain('seats:handoff', (_e, payload) => {
    if (payload?.colId !== getCaptainId()) throw new Error('只能为当前队长生成交接');
    return handoff(home, userData, payload, handoffOptions);
  });
  handleMain('seats:usage', (_e, { seatId }) => readUsage(find(seatId), home));
  handleMain('seats:record-usage', (_e, { colId, seatId, configDir, usage }) => {
    const seat = find(seatId);
    if (configDir !== seat.configDir) throw new Error('会话席位目录已变更，不能归入新目录');
    const column = validId(colId) && getColumn?.(colId);
    if (!column || column.claudeSeatId !== seatId || column.claudeConfigDir !== configDir) throw new Error('用量来源会话与席位快照不匹配');
    writeUsage({ ...seat, configDir: column.claudeConfigDir }, home, usage, colId); onUsageRecorded(); return true;

  });
}
module.exports = { directory, credentialLocation, onboardingComplete, initializeOnboarding, seatEnvironment, credentialStatus, seatInfo, usageAccountKey, sanitizeUsage, writeUsage, readUsage, handoff, checkpoint, registerSeatsIpc };
