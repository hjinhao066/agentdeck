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
const { loginCommand } = require('./seat-auth-alert');

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
// Claude Code asks "do you trust this folder" once per directory and keeps the answer in the seat's
// global file, projects[<dir>].hasTrustDialogAccepted. A linked git worktree is judged on its own
// path (trust for its repo or a parent folder does not carry over), and the menu's default row is
// "No, exit", so an unattended session dies on it. AgentDeck records the answer for the one copy it
// has just created, in the same file and shape Claude Code writes, before that seat's session starts.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function trustKeys(dir, platform) {
  let real = dir;
  try { real = fs.realpathSync.native(dir); } catch (_) {}
  return [...new Set([dir, real].map((value) => {
    const key = path.resolve(value).normalize('NFC');
    return platform === 'win32' ? key.replace(/^\\\\\?\\/, '').replace(/\\/g, '/') : key;
  }))];
}
// Same lock directory convention Claude Code uses on its own file, so a running session never
// reads a half-written file and we never overwrite its update. Stale after 10 s, like theirs.
async function withFileLock(file, work) {
  const lock = file + '.lock';
  const deadline = Date.now() + 4000;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmdirSync(lock); continue; } } catch (_) {}
      if (Date.now() > deadline) throw new Error('席位配置文件正被占用');
      await pause(25);
    }
  }
  try { return await work(); } finally { try { fs.rmdirSync(lock); } catch (_) {} }
}
// Never throws: a failed registration must not stop the task, only leave the dialog in place.
async function trustWorktree(seat, home, dir, { root, platform = process.platform } = {}) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || typeof root !== 'string' || !path.isAbsolute(root)) return { ok: false, reason: '副本路径无效' };
    const real = fs.realpathSync.native(dir), realRoot = fs.realpathSync.native(root);
    const rel = path.relative(realRoot, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: '目录不在 AgentDeck 的副本根目录里' };
    // A linked worktree has a .git file; a real repository or a plain folder is not ours to trust.
    if (!fs.lstatSync(path.join(real, '.git')).isFile()) return { ok: false, reason: '不是 git 副本' };
    const loc = credentialLocation(seat, home);
    const keys = trustKeys(dir, platform);   // the path as given and its real path, when they differ
    fs.mkdirSync(path.dirname(loc.metadataPath), { recursive: true });
    return await withFileLock(loc.metadataPath, () => {
      let existing = {}, mode = 0o600;
      try {
        const stat = fs.statSync(loc.metadataPath);
        if (stat.size > 8 * 1024 * 1024) return { ok: false, reason: '席位配置文件太大' };
        mode = stat.mode & 0o777;
        existing = JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) {
        if (e.code !== 'ENOENT') return { ok: false, reason: '席位配置文件读不了，没有改动' };   // damaged JSON is never overwritten
      }
      if (!existing || typeof existing !== 'object' || Array.isArray(existing) || (existing.projects != null && (typeof existing.projects !== 'object' || Array.isArray(existing.projects)))) return { ok: false, reason: '席位配置文件格式不对，没有改动' };
      const projects = existing.projects || (existing.projects = {});
      let changed = false;
      for (const key of keys) {
        if (projects[key] != null && (typeof projects[key] !== 'object' || Array.isArray(projects[key]))) return { ok: false, reason: '席位配置文件格式不对，没有改动' };
        if (projects[key]?.hasTrustDialogAccepted === true) continue;
        projects[key] = { ...projects[key], hasTrustDialogAccepted: true };
        changed = true;
      }
      if (!changed) return { ok: true, changed: false };
      const temp = loc.metadataPath + `.agentdeck-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(temp, JSON.stringify(existing, null, 2), { mode, flag: 'wx' });
        fs.renameSync(temp, loc.metadataPath);
      } catch (e) {
        try { fs.unlinkSync(temp); } catch (_) {}
        return { ok: false, reason: '写席位配置文件失败：' + e.code };
      }
      return { ok: true, changed: true };
    });
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e).slice(0, 200) };
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
// Who a seat directory is actually signed in to, as `claude auth status` reports it. Read only:
// the CLI exits 1 when signed out but still prints its JSON. Null when it cannot answer.
function readAuthStatus(seat, home, env, execFileImpl = execFile) {
  return new Promise((resolve) => {
    let childEnv;
    try {
      childEnv = seatEnvironment(env, seat, home);
      for (const key of Object.keys(childEnv)) if (key.startsWith('AGENTDECK_')) delete childEnv[key];
      for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete childEnv[key];
    } catch (_) { return resolve(null); }
    try {
      execFileImpl(process.platform === 'win32' ? 'claude.exe' : 'claude', ['auth', 'status', '--json'], {
        env: childEnv, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024,
      }, (_error, stdout) => {
        try {
          const value = JSON.parse(stdout);
          const plan = value?.loggedIn === true ? S.planName(value.subscriptionType) : '';
          resolve(typeof value?.loggedIn === 'boolean' ? { loggedIn: value.loggedIn, email: value.loggedIn ? S.cleanEmail(value.email) : '', ...(plan ? { plan } : {}) } : null);
        } catch (_) { resolve(null); }
      });
    } catch (_) { resolve(null); }
  });
}
// One CLI run per seat per ten minutes (or per sign-in change), shared by concurrent readers.
const AUTH_STATUS_MS = 10 * 60_000;
function authStatusCache(read, now = Date.now) {
  const cache = new Map();
  return (seat, key, fresh) => {
    const hit = cache.get(seat.id);
    if (hit && hit.key === key && !fresh && now() - hit.at < AUTH_STATUS_MS) return hit.value;
    const value = Promise.resolve(read(seat)).catch(() => null);
    cache.set(seat.id, { key, at: now(), value });
    return value;
  };
}
async function seatInfo(seat, home, platform = process.platform, keychain = credentialStatus, authStatus = null, fresh = false) {
  const loc = credentialLocation(seat, home);
  let email = '', rawEmail = '', accountKey = '', recordedPlan = '';
  try {
    if (fs.statSync(loc.metadataPath).size <= 8 * 1024 * 1024) {
      const account = JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8')).oauthAccount;
      rawEmail = S.cleanEmail(account?.emailAddress);
      recordedPlan = S.planName(account?.organizationType, account?.organizationRateLimitTier);
    }
    email = S.maskEmail(rawEmail);
    accountKey = usageAccountKey(loc) || '';
  } catch (_) {}
  const status = platform === 'darwin' ? await keychain(loc.keychainService) : fs.existsSync(loc.credentialsPath);
  const present = typeof status === 'object' ? status.present : !!status;
  // The CLI's answer wins; without it, the account recorded in the seat's own metadata.
  const auth = present && authStatus ? await authStatus(seat, [loc.dir, rawEmail, accountKey].join('|'), fresh) : null;
  const loginEmail = !present ? '' : auth ? auth.email : rawEmail;
  // The plan recorded beside the account, unless the CLI says another account is signed in here.
  const moved = !!auth?.email && auth.email.toLowerCase() !== rawEmail.toLowerCase();
  const plan = moved ? auth.plan || '' : recordedPlan || auth?.plan || '';
  // Credentials on disk do not make a seat signed in when the CLI itself says it is not.
  const signedOut = present && auth?.loggedIn === false;
  return { ...seat, configDir: loc.dir, maskedEmail: email, loginEmail, accountEmail: loginEmail || rawEmail, plan, accountKey, onboardingComplete: onboardingComplete(seat, home),
    // Without --email: the settings row adds the address typed there.
    loginBase: loginCommand('Claude', { ...seat, email: '' }, home, platform === 'test' ? process.platform : platform),
    credentialKey: crypto.createHash('sha256').update(loc.keychainService).digest('hex').slice(0, 16), loggedIn: !!present && !signedOut,
    loginReason: signedOut ? `${seat.name}（${seat.id}）：Claude 登录状态显示此席位未登录` : typeof status === 'object' ? status.loginReason ? `${seat.name}（${seat.id}）：${status.loginReason}` : '' : present ? '' : `${seat.name}（${seat.id}）：没有登录凭据`,
    authReason: typeof status === 'object' ? status.authReason ? `${seat.name}（${seat.id}）：${status.authReason}` : '' : '', usagePath: loc.usagePath };

}
// The address recorded in a seat directory's own account file; '' when there is none. Read only.
function recordedAccount(seat, home) {
  try {
    const loc = credentialLocation(seat, home);
    if (fs.statSync(loc.metadataPath).size > 8 * 1024 * 1024) return '';
    return S.cleanEmail(JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8')).oauthAccount?.emailAddress);
  } catch (_) { return ''; }
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
// Open dispatch records are never trimmed, so their number is not bounded by the renderer's
// cap on finished ones; the limit here only rejects a payload that cannot be real.
const MAX_HANDOFF_RECORDS = 5000;
function handoff(home, userData, payload, options = {}) {
  if (!validId(payload?.colId) || !Array.isArray(payload.tasks) || payload.tasks.length > MAX_HANDOFF_RECORDS) throw new Error('无效队长存档');
  const dir = path.join(home, '.agents', 'boards');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const board = path.join(dir, Handoff.HANDOFF_FILE), notes = path.join(dir, Handoff.DECISIONS_FILE);
  try { fs.writeFileSync(notes, Handoff.DECISIONS_TEMPLATE, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const decisions = { path: notes, text: '', mtime: 0 };
  try {
    const stat = fs.statSync(notes);
    if (stat.isFile() && stat.size <= 512 * 1024) { decisions.text = fs.readFileSync(notes, 'utf8'); decisions.mtime = stat.mtimeMs; }
    // Too big to be the one-line-per-decision file: said in the text, not read as "nothing recorded".
    else decisions.error = stat.isFile() ? '文件超过 512KB，没有读' : '不是普通文件，没有读';
  } catch (error) { if (error.code !== 'ENOENT') decisions.error = '读不出来：' + error.message; }
  // The user's profile belongs to someone else and is read on demand, not at every handover:
  // the overview only points at it, with its modification time. No file, no line.
  let aboutUser = null;
  const about = path.join(home, '.agents', 'memory', 'about-user.md');
  try {
    const stat = fs.statSync(about);
    if (stat.isFile()) aboutUser = { mtime: stat.mtimeMs };
  } catch (_) { /* no profile: the section is left out */ }
  // An unreadable board is said out loud; the dispatch records alone still go out.
  let cards = [], boardError = '';
  try { cards = options.cards ? options.cards() : []; } catch (error) { boardError = error.message; }
  // Receipts, queued work and sessions go in whole: the text names every one of them,
  // and a trimmed list would lose a result or call a live session gone.
  const all = (value) => (Array.isArray(value) ? value : []);
  const machine = options.machine || {};
  const discussionsRoot = options.discussionsRoot || path.join(home, '.agents-state', 'agentdeck', 'discussions');
  const discussions = require('./discussion-store').createStore({ root: discussionsRoot }).list().filter((d) => !['complete', 'cancelled'].includes(d.status));
  const built = Handoff.build({
    now: Number.isFinite(payload.now) ? payload.now : Date.now(), timeZone: payload.timeZone, reason: payload.reason, cli: payload.cli, budget: payload.budget,
    dispatchCap: payload.dispatchCap, userTurnsOlder: payload.userTurnsOlder === true || all(payload.userTurns).length > 12,
    platform: machine.platform || process.platform, host: machine.hostname || os.hostname(), appVersion: machine.appVersion || '', boardVersion: options.boardVersion ? options.boardVersion() : '',
    captain: { ...(payload.captain && typeof payload.captain === 'object' ? payload.captain : { previousId: payload.colId, message: payload.relayMessage || '' }) },
    discussions, cards, boardError, dispatches: payload.tasks, sessions: all(payload.sessions), archivedIds: all(payload.archivedIds),
    pending: all(payload.pending), inflight: all(payload.inflight), unconfirmed: all(payload.unconfirmed), waitlist: all(payload.waitlist),
    carry: payload.carry, userTurns: all(payload.userTurns).slice(-12), decisions, aboutUser,
    paths: { handoff: board, decisions: notes, chats: path.join(userData, 'chats'), tasks: options.tasksDir || path.join(dir, 'tasks') },
  });
  // The detail files go beside the overview, in a directory of their own; the overview is written last.
  fs.mkdirSync(built.dir, { recursive: true, mode: 0o700 });
  for (const f of built.files) {
    const target = path.join(built.dir, f.name);
    fs.writeFileSync(target + '.tmp', f.text, { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
  }
  fs.writeFileSync(board + '.tmp', built.text, { mode: 0o600 });
  fs.renameSync(board + '.tmp', board);
  return { path: board, dir: built.dir, text: built.text, plan: built.state.plan, cuts: built.cuts, over: built.over };
}
function checkpoint(home, userData, payload, options) {
  if (!validId(payload?.colId) || !payload.chat || !Array.isArray(payload.tasks) || payload.tasks.length > MAX_HANDOFF_RECORDS) throw new Error('无效队长存档');
  // Save the full old chat, including interrupted output, before allowing kill.
  const activeChat = { ...payload.chat };
  delete activeChat.captainArchive; // A failed checkpoint must leave an active chat active.
  if (!saveChat(path.join(userData, 'chats'), payload.colId, activeChat)) throw new Error('队长对话保存失败，没有Relay');
  return handoff(home, userData, { ...payload, reason: 'relay' }, options).path;
}
function registerSeatsIpc({ handleMain, home, userData, getSeats, getCaptainId, getColumn, platform = process.platform, env = null, onUsageRecorded = () => {}, handoffOptions }) {
  // A test profile never asks the real CLI: its default seat would read the real ~/.claude.
  const authStatus = env && platform !== 'test' ? authStatusCache((seat) => readAuthStatus(seat, home, env)) : null;
  const find = (id) => { const seat = S.normalize(getSeats()).find((s) => s.id === id); if (!seat) throw new Error('席位不存在'); return seat; };
  handleMain('seats:list', (_e, options) => Promise.all(S.normalize(getSeats()).map((s) => seatInfo(s, home, platform, credentialStatus, authStatus, options?.fresh === true))));
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
module.exports = { directory, credentialLocation, onboardingComplete, initializeOnboarding, trustWorktree, seatEnvironment, credentialStatus, readAuthStatus, authStatusCache, seatInfo, recordedAccount, usageAccountKey, sanitizeUsage, writeUsage, readUsage, handoff, checkpoint, registerSeatsIpc };
