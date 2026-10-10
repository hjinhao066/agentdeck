'use strict';
// 挖虫④ #10 预览栏（只在 Windows 上）：文件夹里的 api_token.txt 按原名被拒，按 8.3 短名 API_TO~1.TXT 却能读到。
// 2026-10-10 在 winpc（C: 盘开着短名）实测：原名 false，短名 true。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const Core = require('../preview-html-core');

test('Windows 短文件名不能绕开密钥名拦截', { skip: process.platform !== 'win32' && 'Windows only' }, (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bh4-83-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'report');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>x</p>');
  fs.writeFileSync(path.join(dir, 'api_token.txt'), 'SECRET');
  fs.writeFileSync(path.join(dir, '.notes.txt'), 'hidden');
  const listing = execSync('dir /x /a', { cwd: dir, encoding: 'utf8' });
  const shorts = Object.fromEntries([...listing.matchAll(/\s(\S+~\d+\.[A-Z0-9]{1,3})\s+(\S+)\s*$/gm)].map((m) => [m[2], m[1]]));
  if (!shorts['api_token.txt']) { t.skip('这个盘没开 8.3 短名'); return; }
  const scope = Core.scopeFor(path.join(dir, 'index.html'), { home: os.homedir(), tmp: os.tmpdir(), platform: 'win32' });
  assert.equal(Core.resolveAsset(scope, '/api_token.txt', { platform: 'win32' }).ok, false);
  assert.equal(Core.resolveAsset(scope, '/' + shorts['api_token.txt'], { platform: 'win32' }).ok, false, shorts['api_token.txt']);
  if (shorts['.notes.txt']) assert.equal(Core.resolveAsset(scope, '/' + shorts['.notes.txt'], { platform: 'win32' }).ok, false, '隐藏文件的短名 ' + shorts['.notes.txt']);
});
