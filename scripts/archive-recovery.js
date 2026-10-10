#!/usr/bin/env node
'use strict';

// Conversations that fell out of the archive (it kept only 500 before 2.0.4): what AgentDeck
// would bring back at its next launch. Read-only unless --apply is given.
//   node scripts/archive-recovery.js                         # this machine's userData, counts only
//   node scripts/archive-recovery.js --list                  # also one line per conversation
//   node scripts/archive-recovery.js --user-data DIR [--backups DIR]
//   node scripts/archive-recovery.js --user-data COPY --apply
// --apply does what the app does at launch (archive-recovery.js): an archive still in config.json
// moves to archived.json (config.json copied to config.json.before-archive-split-<time>), then
// archived.json is copied to archived.json.before-archive-recovery-<time> and rewritten with the
// entries added. It needs
// an explicit --user-data and is meant for a copy: the running app rewrites config.json from
// memory, so never apply to the folder of an AgentDeck that is open. The app does it itself.
// The archive is read from archived.json (and from config.json while one is still there).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ArchiveRecovery = require('../archive-recovery');

function defaults() {
  const home = os.homedir();
  if (process.platform === 'darwin') return { userData: path.join(home, 'Library/Application Support/agentdeck'), backups: path.join(home, 'Library/Caches/AgentDeck-install-backups') };
  if (process.platform === 'win32') return { userData: path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), 'agentdeck'), backups: '' };
  return { userData: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agentdeck'), backups: '' };
}

function parse(argv) {
  const out = { list: false, apply: false, userData: '', backups: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--user-data' && argv[i + 1]) out.userData = path.resolve(argv[++i]);
    else if (a === '--backups' && argv[i + 1]) out.backups = path.resolve(argv[++i]);
    else throw new Error(`Unknown or incomplete option: ${a}`);
  }
  return out;
}

function main() {
  const args = parse(process.argv.slice(2));
  if (args.apply && !args.userData) throw new Error('--apply needs --user-data DIR (a copy; the app brings them back itself at launch).');
  const d = defaults();
  const userData = args.userData || d.userData;
  // an explicit folder reads only the backups it is told to
  const backups = args.backups !== undefined ? [args.backups] : (args.userData ? [] : [d.backups].filter(Boolean));
  const configPath = path.join(userData, 'config.json');
  const chatDir = path.join(userData, 'chats');
  const archivePath = ArchiveRecovery.archivePathFor(configPath);
  const config = ArchiveRecovery.withArchive(JSON.parse(fs.readFileSync(configPath, 'utf8')), archivePath);
  const sources = ArchiveRecovery.oldConfigs(configPath, backups);
  const found = ArchiveRecovery.scan({ config, chatDir, sources });
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  console.log(`userData: ${userData}`);
  console.log(`open columns: ${count(config.columns)}, archived: ${count(config.archived)}, older config copies read: ${sources.length}`);
  console.log(`conversations that fell out of the archive: ${found.lost.length} (${found.lost.reduce((n, l) => n + l.turns, 0)} turns)`);
  console.log(`  with their original record in an older config copy: ${found.withRecord}`);
  console.log(`  rebuilt from the chat file alone: ${found.lost.length - found.withRecord}`);
  console.log(`chat files nothing points at and nobody spoke in (left alone): ${found.silent}`);
  if (args.list) {
    const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '(no date)');
    for (const e of [...found.entries].sort((a, b) => a.archivedAt - b.archivedAt)) {
      console.log(`  ${day(e.archivedAt)}  ${e.id}  ${e.displayTitle || e.title || e.taskTitle || ''}`);
    }
  }
  if (!args.apply) { console.log('Read-only: nothing was written.'); return; }
  const moved = ArchiveRecovery.migrate({ configPath, archivePath });
  if (moved.backup) console.log(`moved the archive out of config.json into archived.json; config as it was: ${moved.backup}`);
  const result = ArchiveRecovery.recover({ configPath, archivePath, chatDir, backups });
  console.log(`applied: ${result.added} added to the archive${result.backup ? `; archive as it was: ${result.backup}` : ''}`);
}

try { main(); } catch (error) { console.error(error.message); process.exit(1); }
