'use strict';
const { acquire } = require('./e2e-lock');

module.exports = async () => {
  // Filters select a focused run. Unknown options conservatively retain the lock.
  const args = process.argv.slice(2);
  const takesValue = new Set(['--workers', '-j', '--reporter', '--timeout', '--retries', '--output', '--config', '-c', '--global-timeout', '--max-failures', '--trace', '--project', '--repeat-each']);
  let focused = false;
  for (let i = args[0] === 'test' ? 1 : 0; i < args.length; i++) {
    const arg = args[i];
    if (/^(--only-changed|--grep|--grep-invert|--last-failed|--test-list|--shard)(=|$)/.test(arg) || arg === '-g' || arg === '-G') focused = true;
    if (takesValue.has(arg)) { i++; continue; }
    if (!arg.startsWith('-')) focused = true;
  }
  if (focused) return;
  const release = await acquire(undefined, () => console.log('Full E2E queued: waiting for the other AgentDeck worktree.'));
  console.log(`Full E2E queue acquired (PID ${process.pid}).`);
  return release;
};
