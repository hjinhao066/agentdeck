// Regression (2.0.3 bug hunt, install/upgrade): the first launch after an upgrade (and every
// relaunch) rebuilds each live column from config.json through a field whitelist in
// renderer.js. Fields the running app writes onto a column but the whitelist omitted were
// silently dropped: `worktree` (the copy made by `new --worktree`, reclaimed on archive)
// and `executor` / `webMode` (a ChatGPT web research column). Archived entries and
// restored columns kept them; only the load of live columns lost them.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
// The renderer's config section: from the top of renderer.js down to the battery block.
function loadRendererConfig(saved) {
  const src = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
  const end = src.indexOf('// Battery mode: the live cap');
  assert.ok(end > 0, 'renderer.js config section not found');
  const ctx = {
    navigator: { userAgent: 'Macintosh' },
    document: { body: { classList: { add() {} } } },
    console,
  };
  ctx.window = ctx;
  ctx.window.deck = { envInfo: () => ({ platform: 'darwin', home: '/Users/x', version: '2.0.3' }), loadConfig: () => saved };
  const mods = {
    NotificationPolicy: 'notification-policy', BoardCore: 'board-core', BarkPolicy: 'bark-policy', ClaudeSeatsCore: 'claude-seats-core',
    QuotaCore: 'quota-core', SidebarCore: 'sidebar-core', DeliverablesCore: 'deliverables-core', TodoShortcutCore: 'todo-shortcut-core',
    BatteryCore: 'battery-core', MainCore: 'main-core', RestartResume: 'restart-resume', PerpetualCaptainCore: 'perpetual-captain-core',
    QuotaWarmupCore: 'quota-warmup-core', CrewMapCore: 'crew-map-core',
  };
  for (const [name, file] of Object.entries(mods)) ctx[name] = require(path.join(ROOT, file));
  vm.createContext(ctx);
  vm.runInContext(src.slice(0, end) + '\nglobalThis.__config = config;', ctx, { filename: 'renderer.js' });
  return ctx.__config;
}

const base = { id: 'c-board-mgk1abcd12', title: 'fix', cwd: '/Users/x/agentdeck-worktrees/repo/t-1', cmd: 'claude', role: 'manual', captainCrew: true };

test('a live column opened with new --worktree keeps its worktree record across a relaunch', () => {
  const worktree = { repo: '/Users/x/repo', path: '/Users/x/agentdeck-worktrees/repo/t-1', branch: 'agentdeck/t-1', base: 'main' };
  const config = loadRendererConfig({ columns: [{ ...base, worktree }] });
  const col = config.columns.find((c) => c.id === base.id);
  // Without it, archiving this session after the relaunch never reclaims the copy
  // (MainSession.settleArchivedWorktree sees no record) and the card gets no worktree note.
  assert.deepEqual(col.worktree, worktree);
});

test('a live ChatGPT web column is still a web column after a relaunch', () => {
  const config = loadRendererConfig({ columns: [{ ...base, id: 'c-board-mgk1web123', cmd: 'chatgpt-web', executor: 'chatgpt-web', webMode: 'deep-research' }] });
  const col = config.columns.find((c) => c.id === 'c-board-mgk1web123');
  // Without it MainSession.noteColdColumn's web branch never runs after a restart, and the
  // column is spawned as a terminal whose launch command is the literal `chatgpt-web`.
  assert.equal(col.executor, 'chatgpt-web');
  assert.equal(col.webMode, 'deep-research');
});

test('control: archived entries already keep the same fields', () => {
  const worktree = { repo: '/Users/x/repo', path: '/Users/x/agentdeck-worktrees/repo/t-1', branch: 'agentdeck/t-1', base: 'main' };
  const config = loadRendererConfig({ columns: [{ id: 'c1', title: 'a', cmd: 'zsh' }], archived: [{ ...base, worktree, archivedAt: 1 }] });
  assert.deepEqual(config.archived.find((c) => c.id === base.id).worktree, worktree);
});
