// Regression (bug hunt 5, Windows, Chinese and GBK): before a Codex column starts, codex-launch.js
// asks Windows PowerShell where `codex` really is (the npm shim) and reads the answer from stdout
// as UTF-8. Windows PowerShell 5.1 writes a pipe in the console's OEM code page (936 / GBK on a
// Chinese Windows) unless the script sets [Console]::OutputEncoding, so a path with Chinese in it,
// such as an npm prefix under a Chinese user name (C:\Users\张三\AppData\Roaming\npm\codex.ps1),
// came back as U+FFFD and the column launched `& 'C:\Users\����\…\codex.ps1'`, which does not
// exist. Checked on the live Windows PC (read only): the probe printing that path reached Node as
// "C:\\Users\\����\\AppData\\Roaming\\npm\\codex.ps1"; with the UTF-8 line first it arrived whole.
// The stand-in prints what PowerShell 5.1 prints: GBK bytes, or UTF-8 when the script asks for it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexLauncher, probeCommand } = require('../codex-launch');

const GBK = { '张': [0xd5, 0xc5], '三': [0xc8, 0xfd] };
const gbkBytes = (text) => Buffer.from([...text].flatMap((ch) => GBK[ch] || [...Buffer.from(ch, 'latin1')]));
const asksUtf8 = (script) => /^\s*\[Console\]::OutputEncoding\s*=\s*\[Text\.Encoding\]::UTF8\s*;/i.test(script);

test('a Codex npm shim under a Chinese user folder still launches on Windows', async () => {
  const program = 'C:\\Users\\张三\\AppData\\Roaming\\npm\\codex.ps1';
  const launcher = createCodexLauncher({ platform: 'win32', shell: 'powershell.exe', env: {}, run(file, args, options, cb) {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const line = 'AGENTDECK_CODEX_HELP=' + JSON.stringify({ program, help: 'Options:\n  --dangerously-bypass-approvals-and-sandbox\n' }) + '\r\n';
    const bytes = asksUtf8(script) ? Buffer.from(line, 'utf8') : gbkBytes(line);
    cb(null, !options.encoding || options.encoding === 'buffer' ? bytes : bytes.toString(options.encoding));
  } });
  const launch = await launcher.prepare('codex');
  assert.ok(launch.startsWith(`& '${program}'`), `Codex would be started as: ${launch}`);
});

test('the seat-occupancy process list keeps a Chinese folder in a process path', async () => {
  const { scanProcesses } = require('../quota-warmup-occupancy');
  const exe = 'C:\\Users\\张三\\.local\\bin\\claude.exe';
  const rows = await scanProcesses({ platform: 'win32', execFileImpl: (_command, args, options, callback) => {
    const out = JSON.stringify([{ ProcessId: 201, ParentProcessId: 100, Name: 'claude.exe', ExecutablePath: exe }]);
    const bytes = asksUtf8(args.at(-1)) ? Buffer.from(out, 'utf8') : gbkBytes(out);
    callback(null, bytes.toString(options.encoding));
  } });
  assert.equal(rows[0].comm, exe);
});

test('the probe asks for UTF-8 before anything prints; other systems are unchanged', () => {
  const script = Buffer.from(probeCommand('codex', 'win32').at(-1), 'base64').toString('utf16le');
  assert.ok(asksUtf8(script), script.slice(0, 80));
  assert.deepEqual(probeCommand('codex', 'darwin'), ['-l', '-c', "command 'codex' --help"]);
});
