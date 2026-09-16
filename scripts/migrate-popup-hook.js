'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const file = path.join(os.homedir(), '.claude', 'hooks', 'claude-popup.ps1');
if (process.platform === 'win32' && fs.existsSync(file)) {
  const source = fs.readFileSync(file, 'utf8');
  const marker = 'if (-not $Show) {';
  if (!source.includes('AGENTDECK_NATIVE_NOTIFICATIONS') && source.includes(marker) && source.includes('Forced topmost popup')) {
    fs.copyFileSync(file, `${file}.agentdeck-${Date.now()}.bak`);
    const updated = source.replace(marker, `${marker}\n  # AgentDeck owns notifications only for its own child terminals.\n  if ($env:AGENTDECK_NATIVE_NOTIFICATIONS -eq '1') { exit 0 }`);
    fs.writeFileSync(file, updated, 'utf8');
    console.log('Added AgentDeck-only popup guard; original hook backed up.');
  } else console.log('Hook already guarded or unrecognized; left unchanged.');
} else console.log('No known Windows popup hook to migrate.');
