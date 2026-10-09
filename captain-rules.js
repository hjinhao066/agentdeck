'use strict';
// The Captain's on-demand rule files, printed by `briefing --topic <name>`.
// Built in: docs/captain/<topic>.md in the repository, copied beside the board
// CLI as captain/<topic>.md when the app starts. The user's own additions:
// ~/.agents/captain/<topic>.md (C:\Users\<name>\.agents\captain\ on Windows),
// printed after the built-in text and winning where the two disagree. A built-in
// file is never replaced, so a rule added in a later version is always shown.

const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const { BRIEFING_TOPICS } = require('./main-core');

const NAMES = BRIEFING_TOPICS.map(([name]) => name);

function builtinFile(name, base = __dirname, path = nodePath, exists = fs.existsSync) {
  const installed = path.join(base, 'captain');
  return path.join(exists(installed) ? installed : path.join(base, 'docs', 'captain'), name + '.md');
}
function userFile(name, home = os.homedir(), path = nodePath) {
  return path.join(home, '.agents', 'captain', name + '.md');
}
function list() {
  return BRIEFING_TOPICS.map(([name, when]) => `${name}　${when}`).join('\n');
}
function topic(name, { base, home } = {}) {
  if (!NAMES.includes(name)) throw new Error(`briefing --topic 没有「${String(name).slice(0, 40)}」。可用：${NAMES.join('、')}；all 读全部，list 列出各自什么时候读。`);
  const text = fs.readFileSync(builtinFile(name, base), 'utf8').trimEnd();
  const extra = userFile(name, home);
  let added = '';
  try { added = fs.readFileSync(extra, 'utf8').trim(); } catch (_) {}
  return added ? `${text}\n\n## 用户补充（${extra}；和上面冲突时以这里为准）\n\n${added}` : text;
}
function briefing(name, options) {
  if (name === 'list') return list();
  if (name === 'all') return NAMES.map((n) => topic(n, options)).join('\n\n');
  return topic(name, options);
}

module.exports = { NAMES, builtinFile, userFile, list, topic, briefing };
