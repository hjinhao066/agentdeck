const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startHub } = require('../fixtures/hub-proxy');
const { deploy, rollback } = require('../../scripts/mobile-release');

test('one browser reload loads the independently deployed commit and its JS; receipt rollback restores the first build', async ({ browser }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-mobile-release-e2e-'));
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote');
  const source = path.join(repo, 'mobile-web/hub');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  let hub, context;
  try {
    fs.mkdirSync(repo); fs.mkdirSync(remote);
    fs.cpSync(path.join(__dirname, '../../mobile-web/hub'), source, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"version":"1.2.0"}');
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.hooksPath', path.join(root, 'no-hooks')); git('config', 'commit.gpgsign', 'false');
    fs.appendFileSync(path.join(source, 'app.js'), '\nwindow.mobileBuildProbe = "first";\n');
    git('add', '.'); git('commit', '-qm', 'first reviewed phone build');
    const firstCommit = git('rev-parse', 'HEAD');
    const initial = 'agentdeck-hub-releases/initial';
    fs.cpSync(source, path.join(remote, initial), { recursive: true });
    fs.symlinkSync(initial, path.join(remote, 'agentdeck-hub'));
    hub = await startHub({ directory: path.join(remote, 'agentdeck-hub') });
    const config = { target: remote, origin: hub.url };
    await deploy(repo, path.join(root, 'first-output'), config);
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(), problems = [], assets = [];
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('request', (request) => { if (/\/(core|app)\.js\?v=/.test(request.url())) assets.push(request.url()); });
    await page.goto(hub.url);
    await expect.poll(() => page.evaluate(() => window.mobileBuildProbe)).toBe('first');
    await expect(page.locator('meta[name="agentdeck-commit"]')).toHaveAttribute('content', firstCommit);
    await expect(page.getByRole('article', { name: 'Mac', exact: true })).toContainText('需要登录');

    git('checkout', '-qb', 'reviewed-phone-only');
    fs.appendFileSync(path.join(source, 'app.js'), '\nwindow.mobileBuildProbe = "second";\n');
    git('add', '.'); git('commit', '-qm', 'second reviewed phone build');
    const secondCommit = git('rev-parse', 'HEAD'), secondOutput = path.join(root, 'second-output');
    await deploy(repo, secondOutput, config, { ref: 'reviewed-phone-only' });
    // The open page keeps its first JS until the browser reloads.
    expect(await page.evaluate(() => window.mobileBuildProbe)).toBe('first');
    const answer = await page.reload();
    expect(answer.headers()['cache-control']).toContain('no-store');
    await expect.poll(() => page.evaluate(() => window.mobileBuildProbe)).toBe('second');
    await expect(page.locator('meta[name="agentdeck-commit"]')).toHaveAttribute('content', secondCommit);
    expect(assets.some((url) => url.endsWith('app.js?v=' + firstCommit))).toBe(true);
    expect(assets.some((url) => url.endsWith('app.js?v=' + secondCommit))).toBe(true);
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    expect(problems).toEqual([]);

    await rollback(path.join(secondOutput, 'mobile-deploy-result.json'), config);
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.mobileBuildProbe)).toBe('first');
    await expect(page.locator('meta[name="agentdeck-commit"]')).toHaveAttribute('content', firstCommit);
    expect(problems).toEqual([]);
  } finally {
    if (context) await context.close();
    if (hub) await hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
