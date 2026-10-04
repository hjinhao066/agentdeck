#!/usr/bin/env node
'use strict';

// Provision the VPS/key first, then install this user-level SSH supervisor.
// No credentials belong in this script or its output.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin') throw new Error('This installer is for macOS.');
const home = os.homedir();
const directory = path.join(home, '.config', 'agentdeck-remote');
const config = JSON.parse(fs.readFileSync(path.join(directory, 'tunnel.json'), 'utf8'));
const origin = new URL(config.publicOrigin);
if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin || origin.username || origin.password) throw new Error('An HTTPS origin without a path is required.');
if (!/^[a-zA-Z0-9.-]+$/.test(config.host) || !/^[a-z_][a-z0-9_-]*$/.test(config.user)) throw new Error('Invalid SSH endpoint.');
for (const port of [config.localPort, config.remotePort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid forwarding port.');
for (const file of [config.identityFile, config.knownHostsFile]) {
  if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('Missing SSH identity or pinned host key.');
}
fs.chmodSync(config.identityFile, 0o600);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chmodSync(directory, 0o700);
fs.writeFileSync(path.join(directory, 'endpoint.json'), JSON.stringify({ publicOrigin: origin.origin }), { mode: 0o600 });
const label = 'com.jinhao.agentdeck-mobile-tunnel';
const args = ['/usr/bin/ssh', '-NT', '-i', config.identityFile,
  '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${config.knownHostsFile}`, '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
  '-o', 'LogLevel=ERROR', '-R', `127.0.0.1:${config.remotePort}:127.0.0.1:${config.localPort}`,
  `${config.user}@${config.host}`];
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plist = path.join(home, 'Library', 'LaunchAgents', label + '.plist');
fs.mkdirSync(path.dirname(plist), { recursive: true });
fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardErrorPath</key><string>${xml(path.join(directory, 'tunnel-error.log'))}</string>
</dict></plist>
`, { mode: 0o600 });
const domain = `gui/${process.getuid()}`;
try { execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' }); } catch (_) {}
execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'inherit' });
execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
console.log('Private SSH tunnel installed. AgentDeck itself was not launched or restarted.');
