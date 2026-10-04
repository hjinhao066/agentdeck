#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Share the brain, never the account, credential fallback, caches or locks.
const SHARED = ['CLAUDE.md', 'settings.json', 'settings.local.json', 'skills', 'hooks',
  'plugins', 'projects', 'memory', 'history.jsonl', 'file-history', 'transcripts',
  'commands', 'agents', 'rules', 'output-styles', 'statusline.sh'];
function setup(home = os.homedir()) {
  const cn = path.join(home, '.claude'), us = path.join(home, '.claude-us');
  if (!fs.statSync(cn).isDirectory()) throw new Error('CN配置目录不存在');
  if (fs.existsSync(us) && (fs.lstatSync(us).isSymbolicLink() || !fs.statSync(us).isDirectory())) throw new Error('US必须是独立目录');
  for (const name of ['.claude.json', '.credentials.json']) {
    try { if (fs.lstatSync(path.join(us, name)).isSymbolicLink()) throw new Error('US登录文件不能是符号链接'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  // Check everything before changing anything. Existing login files stay intact.
  for (const name of SHARED) {
    const target = path.join(us, name), source = path.join(cn, name);
    if (!fs.existsSync(source)) continue;
    try {
      const st = fs.lstatSync(target);
      if (!st.isSymbolicLink() || path.resolve(us, fs.readlinkSync(target)) !== source) throw new Error(`US已有独立 ${name}，请先人工处理`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  fs.mkdirSync(us, { recursive: true, mode: 0o700 });
  for (const name of SHARED) {
    const source = path.join(cn, name), target = path.join(us, name);
    if (fs.existsSync(source)) {
      try { fs.lstatSync(target); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        fs.symlinkSync(source, target, fs.statSync(source).isDirectory() ? 'junction' : 'file');
      }
    }
  }
  // .claude.json includes oauthAccount: linking/copying it whole breaks isolation.
  // Seed only project trust and local MCP definitions, without account metadata.
  const global = path.join(us, '.claude.json');
  if (!fs.existsSync(global)) {
    let original = {};
    try { original = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); } catch (_) {}
    const seed = {};
    for (const key of ['projects', 'mcpServers']) if (original[key]) seed[key] = original[key];
    fs.writeFileSync(global, JSON.stringify(seed, null, 2), { mode: 0o600, flag: 'wx' });
  }
  return { cn, us, shared: SHARED.filter((name) => fs.existsSync(path.join(cn, name))) };
}
if (require.main === module) {
  try { const result = setup(); console.log(`US目录已准备：${result.us}；共享 ${result.shared.length} 项；未读取或复制登录凭据。`); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { setup, SHARED };
