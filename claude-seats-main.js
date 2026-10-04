'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const S = require('./claude-seats-core');
const { validId } = require('./security');
const { saveChat } = require('./side-main');
const { accountIdentity } = require('./quota-codex');

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
const AUTH_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_GATEWAY_LINEAGE'];
function seatEnvironment(env, seat, home) {
  const result = { ...env }, loc = credentialLocation(seat, home);
  for (const key of AUTH_ENV) delete result[key];
  if (loc.isDefault) delete result.CLAUDE_CONFIG_DIR;
  else result.CLAUDE_CONFIG_DIR = loc.dir;
  return result;
}
function hasKeychain(service) {
  // No -w/-g: check metadata only, never fetch a password into the renderer.
  return new Promise((resolve) => execFile('security', ['find-generic-password', '-s', service],
    { timeout: 2000 }, (error) => resolve(!error)));
}
async function seatInfo(seat, home, platform = process.platform, keychain = hasKeychain) {
  const loc = credentialLocation(seat, home);
  let email = '';
  try {
    if (fs.statSync(loc.metadataPath).size <= 8 * 1024 * 1024) email = S.maskEmail(JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8')).oauthAccount?.emailAddress);
  } catch (_) {}
  const present = !!email && (fs.existsSync(loc.credentialsPath) || (platform === 'darwin' && await keychain(loc.keychainService)));
  return { ...seat, configDir: loc.dir, maskedEmail: email, loggedIn: !!email && !!present, usagePath: loc.usagePath };
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
function writeUsage(seat, home, value) {
  const loc = credentialLocation(seat, home), file = loc.usagePath;
  const accountKey = usageAccountKey(loc);
  if (!accountKey) throw new Error('无法确认用量所属账号');
  if (value?.source === 'Claude OAuth usage' && (value.accountKey !== accountKey || value.configDir !== loc.dir)) throw new Error('OAuth 用量所属账号或目录已变更');
  const safe = { ...sanitizeUsage(value), accountKey, configDir: loc.dir };
  fs.writeFileSync(file + '.tmp', JSON.stringify(safe), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function readUsage(seat, home) {
  try {
    const loc = credentialLocation(seat, home), value = JSON.parse(fs.readFileSync(loc.usagePath, 'utf8'));
    if (!value.accountKey || value.accountKey !== usageAccountKey(loc) || value.configDir !== loc.dir) return null;
    return { ...sanitizeUsage(value), accountKey: value.accountKey, configDir: value.configDir };
  }
  catch (_) { return null; }
}
function checkpoint(home, userData, payload) {
  if (!validId(payload?.colId) || !payload.chat || !Array.isArray(payload.tasks) || payload.tasks.length > 120) throw new Error('无效队长存档');
  // Save the full old chat, including interrupted output, before allowing kill.
  const activeChat = { ...payload.chat };
  delete activeChat.captainArchive; // A failed checkpoint must leave an active chat active.
  if (!saveChat(path.join(userData, 'chats'), payload.colId, activeChat)) throw new Error('队长对话保存失败，没有Relay');
  const board = path.join(home, '.agents', 'boards', 'agentdeck-captain-handoff.md');
  fs.mkdirSync(path.dirname(board), { recursive: true, mode: 0o700 });
  const line = (x) => String(x || '').replace(/[\r\n|]/g, ' ').slice(0, 600);
  const text = '# AgentDeck 队长Relay接续\n\n## 在做什么\n席位Relay；先读本看板，再按需读取上一任队长的完整对话。\n\n'
    + `上任会话：${payload.colId}\n完整对话：${path.join(userData, 'chats', payload.colId + '.json')}\n`
    + `使用 board-cli read --id ${payload.colId} 可读取之前的队长对话。\n\n`
    + '## 谁在做\n| 会话 | 事项 | 状态 | 回执/提问 |\n| --- | --- | --- | --- |\n'
    + payload.tasks.map((t) => `| ${line(t.colId)} | ${line(t.title)} | ${line(t.status)} | ${line(t.receipt?.question || t.receipt?.failed || t.receipt?.summary)} |`).join('\n')
    + '\n\n## 卡在哪\n未处理回执和提问在 AgentDeck 中保留；额度用尽的会话保持原席位。\n\n## 等用户拍板什么\n见任务表中的提问及队长待处理回执。\n\n## 下一步\n读看板继续；先运行 ledger 和 receipts，核对正在跑的队员，不重复派活。\n\n'
    + `## 指针\nAgentDeck 对话目录：${path.join(userData, 'chats')}\n\n## 最后更新时间与更新记录\n${new Date().toISOString()} AgentDeck：Relay前存档。\n`;
  fs.writeFileSync(board + '.tmp', text, { mode: 0o600 });
  fs.renameSync(board + '.tmp', board);
  return board;
}
function registerSeatsIpc({ handleMain, home, userData, getSeats, getCaptainId, onUsageRecorded = () => {} }) {
  const find = (id) => { const seat = S.normalize(getSeats()).find((s) => s.id === id); if (!seat) throw new Error('席位不存在'); return seat; };
  handleMain('seats:list', () => Promise.all(S.normalize(getSeats()).map((s) => seatInfo(s, home))));
  handleMain('seats:validate', (_e, { seats }) => {
    const normalized = S.normalize(seats);
    if (!Array.isArray(seats) || normalized.length !== seats.length) throw new Error('席位列表无效');
    const dirs = normalized.map((s) => directory(s, home));
    if (new Set(dirs.map((d) => process.platform === 'win32' ? d.toLowerCase() : d)).size !== dirs.length) throw new Error('席位必须使用不同配置目录');
    return normalized;
  });
  handleMain('seats:checkpoint', (_e, payload) => {
    if (payload?.colId !== getCaptainId()) throw new Error('只能存档当前队长');
    return checkpoint(home, userData, payload);
  });
  handleMain('seats:usage', (_e, { seatId }) => readUsage(find(seatId), home));
  handleMain('seats:record-usage', (_e, { seatId, configDir, usage }) => {
    const seat = find(seatId);
    if (configDir !== seat.configDir) throw new Error('会话席位目录已变更，不能归入新目录');
    writeUsage(seat, home, usage); onUsageRecorded(); return true;
  });
}
module.exports = { directory, credentialLocation, seatEnvironment, seatInfo, usageAccountKey, sanitizeUsage, writeUsage, readUsage, checkpoint, registerSeatsIpc };
