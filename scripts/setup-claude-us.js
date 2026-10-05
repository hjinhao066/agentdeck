#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../claude-seats-core');

// Share the brain, never the account, credential fallback, caches or locks.
const SHARED = ['CLAUDE.md', 'settings.json', 'settings.local.json', 'skills', 'hooks',
  'plugins', 'projects', 'memory', 'history.jsonl', 'file-history', 'transcripts',
  'commands', 'agents', 'rules', 'output-styles', 'statusline.sh'];
function setup(home = os.homedir(), seatId = 'us') {
  const seat = S.normalize().find((s) => s.id === seatId && s.id !== 'cn');
  if (!seat) throw new Error('请选择独立席位 us 或 us2');
  const cn = path.join(home, '.claude'), us = S.configDir(seat, home, process.platform);
  if (!fs.statSync(cn).isDirectory()) throw new Error('CN配置目录不存在');
  if (fs.existsSync(us) && (fs.lstatSync(us).isSymbolicLink() || !fs.statSync(us).isDirectory())) throw new Error(`${seat.name}必须是独立目录`);
  for (const name of ['.claude.json', '.credentials.json']) {
    try { if (fs.lstatSync(path.join(us, name)).isSymbolicLink()) throw new Error(`${seat.name}登录文件不能是符号链接`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  // Check everything before changing anything. Credential files and existing account fields stay intact.
  for (const name of SHARED) {
    const target = path.join(us, name), source = path.join(cn, name);
    if (!fs.existsSync(source)) continue;
    try {
      const st = fs.lstatSync(target);
      if (!st.isSymbolicLink() || path.resolve(us, fs.readlinkSync(target)) !== source) throw new Error(`${seat.name}已有独立 ${name}，请先人工处理`);
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
  // Seed project trust, local MCP definitions and UI onboarding, without account metadata.
  const global = path.join(us, '.claude.json');
  let original = {};
  try { original = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); } catch (_) {}
  if (!fs.existsSync(global)) {
    const seed = {};
    for (const key of ['projects', 'mcpServers', 'hasCompletedOnboarding', 'lastOnboardingVersion']) if (original[key]) seed[key] = original[key];
    fs.writeFileSync(global, JSON.stringify(seed, null, 2), { mode: 0o600, flag: 'wx' });
  } else {
    // auth status can succeed while a previously seeded profile still enters
    // the first-run login chooser. Carry only missing UI onboarding markers.
    const existing = JSON.parse(fs.readFileSync(global, 'utf8'));
    if (existing.oauthAccount && existing.hasCompletedOnboarding === undefined && original.hasCompletedOnboarding === true) {
      existing.hasCompletedOnboarding = true;
      if (typeof original.lastOnboardingVersion === 'string') existing.lastOnboardingVersion = original.lastOnboardingVersion;
      fs.writeFileSync(global + '.tmp', JSON.stringify(existing, null, 2), { mode: 0o600 });
      fs.renameSync(global + '.tmp', global);
    }
  }
  return { cn, us, seatId, name: seat.name, shared: SHARED.filter((name) => fs.existsSync(path.join(cn, name))) };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--seat')) throw new Error('用法：node scripts/setup-claude-us.js [--seat us|us2]');
    const result = setup(os.homedir(), args[1] || 'us');
    console.log(`${result.name}目录已准备：${result.us}；共享 ${result.shared.length} 项；未读取或复制登录凭据。`);
  }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { setup, SHARED };
