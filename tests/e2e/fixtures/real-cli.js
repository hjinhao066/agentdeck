// Starts a real agent CLI for the opt-in probe (real-cli-briefing.spec.js):
//   node real-cli.js claude|codex <port of mock-model-api> <empty config directory>
// The CLI gets its own empty config directory and talks only to the local
// stand-in API, so no login, account or quota is touched.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [cli, port, dir] = process.argv.slice(2);
if (!['claude', 'codex'].includes(cli) || !/^\d+$/.test(port || '') || !dir) {
  console.error('usage: node real-cli.js claude|codex <port> <config directory>');
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });
// nothing of the owner's logins or endpoints rides along
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|OPENAI_|CODEX_)/i.test(key)));
const here = [...new Set([process.cwd(), fs.realpathSync(process.cwd())].flatMap((p) => [p, p.replace(/\\/g, '/')]))];
if (cli === 'claude') {
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    projects: Object.fromEntries(here.map((p) => [p, { hasTrustDialogAccepted: true }])),
  }));
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'probe-not-a-real-key', ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: 'claude-opus-5-5', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  });
} else {
  fs.writeFileSync(path.join(dir, 'config.toml'), [
    'model = "gpt-6.1-sol"', 'model_provider = "probe"', '',
    '[model_providers.probe]', 'name = "probe"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'env_key = "PROBE_KEY"', '',
    ...here.flatMap((p) => [`[projects.'${p}']`, 'trust_level = "trusted"', '']),
  ].join('\n'));
  Object.assign(env, { CODEX_HOME: dir, PROBE_KEY: 'probe-not-a-real-key' });
}
// The CLI takes over this terminal; npm's .cmd shims on Windows need the shell.
const child = spawn(cli, [], { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('error', (error) => { console.error(`${cli} did not start: ${error.message}`); process.exit(127); });
child.on('exit', (code) => process.exit(code == null ? 1 : code));
