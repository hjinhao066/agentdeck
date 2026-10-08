'use strict';
// The Captain's prompt is a short core plus rule files read on demand
// (docs/captain/<topic>.md, `briefing --topic <name>`). These tests hold the
// split together: the core keeps the red lines and says when to read what, every
// file it points at exists where the installed app looks for it, and nothing the
// program already enforces is spent on the core.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('../main-core');
const Rules = require('../captain-rules');
const { topic } = require('./fixtures/captain-rulebook');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const PLATFORMS = ['darwin', 'win32'];
const WIN_HOME = 'C:\\Users\\hjinh';
const WIN_TOOLS = 'C:\\Users\\hjinh\\AppData\\Roaming\\agentdeck\\board-control\\tools';

// The board CLI as a terminal runs it: no control token, its own home directory.
function cli(file, args, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  return spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8' });
}
// The tools folder the app fills at start (main.js), rebuilt from the same list.
function installed(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-captain-rules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tools = path.join(dir, 'tools'), home = path.join(dir, 'home');
  fs.mkdirSync(path.join(tools, 'captain'), { recursive: true }); fs.mkdirSync(home);
  const main = read('main.js');
  const list = /for \(const file of \[([^\]]+)\]\) fs\.copyFileSync\(path\.join\(__dirname, file\), path\.join\(toolsDir, file\)\);/.exec(main);
  assert.ok(list, 'main.js copies the CLI modules into the tools folder');
  for (const [, file] of list[1].matchAll(/'([^']+)'/g)) fs.copyFileSync(path.join(ROOT, file), path.join(tools, file));
  assert.match(main, /for \(const \[name\] of require\('\.\/main-core'\)\.BRIEFING_TOPICS\) fs\.copyFileSync\(path\.join\(__dirname, 'docs', 'captain', name \+ '\.md'\), path\.join\(toolsDir, 'captain', name \+ '\.md'\)\);/);
  for (const name of Rules.NAMES) fs.copyFileSync(path.join(ROOT, 'docs', 'captain', name + '.md'), path.join(tools, 'captain', name + '.md'));
  fs.copyFileSync(path.join(ROOT, 'board-cli.js'), path.join(tools, 'agentdeck-board.js'));
  return { tools, home, board: path.join(tools, 'agentdeck-board.js') };
}

test('the core is the identity, the red lines, one line per command, the trigger list and the closing paragraph', () => {
  for (const platform of PLATFORMS) for (const legacy of [false, true]) for (const cap of [5, 30, 50]) {
    const core = M.instructions(platform, '', legacy, cap);
    assert.ok((core + M.SAVER_RESUME).length <= M.CORE_LIMIT, `${platform}: ${core.length}`);
    assert.ok(core.startsWith('你是 AgentDeck 的「队长」：常驻的总负责人。'), platform);
    assert.ok(core.endsWith(M.AUTONOMOUS_CONTINUATION), platform);
    const lines = core.split('\n');
    const redLines = lines.slice(lines.indexOf('红线，每一轮都守：') + 1, lines.findIndex((line) => line.startsWith('命令，前面都加')) - 1);
    assert.equal(redLines.length, 7, platform);
    assert.ok(redLines.every((line) => line.startsWith('- ')), platform);
    assert.match(redLines[0], /不要在这一列里改文件、跑任务或写实现过程，实际工作和返工都交给别的会话/);
    assert.match(redLines[1], /删除数据、花钱、对外发布这类不可逆的事，或影响目标、范围、授权又查不出来的，才请用户决定，并说清要用户决定什么/);
    if (legacy) assert.match(redLines[2], /已显式开启旧回执注入回退[^\n]*不要再挂 receipts --wait 后台监听/);
    else assert.match(redLines[2], /run_in_background: true[^\n]*receipts --wait（不设超时），始终保持恰好一个后台监听/);
    assert.match(redLines[3], /派完马上用一两句话告诉用户交给了哪个会话、已启动还是在排队，不要等结果；命令没成功返回不说已启动/);
    assert.match(redLines[4], /先用 task add 记卡[^\n]*记了卡的活 new 必须带 --task-id 和 --project/);
    assert.match(redLines[5], new RegExp(`一个会话一次只派一件活[^\\n]*同一时间最多 ${cap} 个会话在干活`));
    assert.equal(redLines[6], '- 节省上下文：不读大文件正文，只看报告的结论段；查进度优先 peek。');
  }
});

test('the trigger list names every rule file, and every rule file is on it', () => {
  const files = fs.readdirSync(path.join(ROOT, 'docs', 'captain')).sort();
  assert.deepEqual(files, Rules.NAMES.map((name) => name + '.md').sort());
  assert.deepEqual(Rules.NAMES, ['models', 'dispatch', 'review', 'inbox', 'sessions', 'capacity', 'release', 'handoff', 'commands']);
  for (const platform of PLATFORMS) {
    const core = M.instructions(platform);
    assert.match(core, /做下面的事之前先读对应规范：briefing --topic 名。这一轮上下文里读过的不用重读；--topic all 读全部。/);
    for (const [name, when] of M.BRIEFING_TOPICS) assert.ok(core.includes(`   - ${name}：${when}\n`), `${platform} ${name}`);
  }
  // the moments the Captain asked for, each pointing at its file
  const when = Object.fromEntries(M.BRIEFING_TOPICS);
  assert.match(when.models, /派活选模型、定档位、换模型或席位、用 DeepSeek 兜底/);
  assert.match(when.dispatch, /派活写任务正文[^\n]*界面类的活看其中第 5 条图标规则/);
  assert.match(when.review, /验收、审查、返工/);
  assert.match(when.inbox, /找用户、要用户介入、向用户汇报结论/);
  assert.match(when.release, /发版、打包、安装、重启 AgentDeck/);
  assert.match(when.capacity, /内存或额度吃紧/);
  // what the user says out loud is in the core, where it is seen every turn
  for (const phrase of ['「高优先级」', '「强度拉满」', '「你是队长」', '「讨论一下」']) assert.ok(M.instructions('darwin').includes(phrase), phrase);
});

test('every rule file is non-empty, packaged with the app and copied beside the board CLI', () => {
  const patterns = require('../package.json').build.files;
  assert.ok(patterns.includes('docs/captain/**'), 'the rule files are in the package');
  assert.ok(patterns.includes('captain-rules.js'), 'and so is their reader');
  for (const name of Rules.NAMES) {
    const text = topic(name);
    assert.ok(text.startsWith('# '), name + ' has a title');
    assert.ok(text.length > 100, name + ' has rules in it');
    assert.equal(Rules.builtinFile(name, ROOT), path.join(ROOT, 'docs', 'captain', name + '.md'), 'from the repository the files are read in docs/captain');
  }
  assert.match(read('main.js'), /'captain-rules\.js'\]\) fs\.copyFileSync\(path\.join\(__dirname, file\), path\.join\(toolsDir, file\)\)/);
});

test('every briefing --topic name written anywhere the Captain reads is a file that can be read', () => {
  const places = {
    core: PLATFORMS.map((p) => M.instructions(p)).join('\n'),
    ...Object.fromEntries(Rules.NAMES.map((name) => ['docs/captain/' + name + '.md', topic(name)])),
    notes: PLATFORMS.map((p) => M.relayNote(p, '', '/b/handoff.md') + M.restartNote(p, '/b/handoff.md') + M.restartNotice(p, '/b/handoff.md')).join('\n'),
    'relay-handoff-core.js': read('relay-handoff-core.js'), 'board-cli.js': read('board-cli.js'),
  };
  let seen = 0;
  for (const [place, text] of Object.entries(places)) {
    for (const [, name] of text.matchAll(/briefing --topic ([a-z]+)/g)) {
      seen += 1;
      assert.ok([...Rules.NAMES, 'all', 'list'].includes(name), `${place} points at briefing --topic ${name}`);
      assert.ok(Rules.briefing(name, { home: path.join(__dirname, 'fixtures', 'no-such-home') }).length > 0, name);
    }
  }
  assert.ok(seen >= 5, 'the rule files point at each other');
});

test('briefing --topic prints a rule file from the installed tools folder, without the app and without a token', (t) => {
  const { board, home, tools } = installed(t);
  for (const name of Rules.NAMES) {
    const out = cli(board, ['briefing', '--topic', name], home);
    assert.equal(out.status, 0, name + ': ' + out.stderr);
    assert.equal(out.stdout, fs.readFileSync(path.join(tools, 'captain', name + '.md'), 'utf8').trimEnd() + '\n', name);
    assert.equal(out.stdout, topic(name) + '\n', name + ' is the file in the repository');
  }
  const list = cli(board, ['briefing', '--topic', 'list'], home);
  assert.equal(list.stdout, M.BRIEFING_TOPICS.map(([name, when]) => `${name}　${when}`).join('\n') + '\n');
  const all = cli(board, ['briefing', '--topic', 'all'], home);
  assert.equal(all.stdout, Rules.NAMES.map(topic).join('\n\n') + '\n');
  const unknown = cli(board, ['briefing', '--topic', 'ui'], home);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /briefing --topic 没有「ui」。可用：models、dispatch、review、inbox、sessions、capacity、release、handoff、commands；all 读全部/);
  // from the repository the same command reads docs/captain
  assert.equal(cli(path.join(ROOT, 'board-cli.js'), ['briefing', '--topic', 'release'], home).stdout, topic('release') + '\n');
  // without --topic it is still the Captain-only request to the running app
  const core = cli(board, ['briefing'], home);
  assert.notEqual(core.status, 0);
  assert.match(core.stderr, /Only conductor-managed terminals/);
});

test('the user\'s own additions are printed after the built-in rules and win over them; the built-in text is never hidden', (t) => {
  const { board, home, tools } = installed(t);
  const own = path.join(home, '.agents', 'captain', 'models.md');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, '\n- 这个月 Cursor 不用。\n');
  assert.equal(Rules.userFile('models', home), own);
  const out = cli(board, ['briefing', '--topic', 'models'], home).stdout;
  const builtin = fs.readFileSync(path.join(tools, 'captain', 'models.md'), 'utf8').trimEnd();
  assert.equal(out, `${builtin}\n\n## 用户补充（${own}；和上面冲突时以这里为准）\n\n- 这个月 Cursor 不用。\n`);
  // an empty file adds nothing; other topics are untouched
  fs.writeFileSync(own, ' \n');
  assert.equal(cli(board, ['briefing', '--topic', 'models'], home).stdout, builtin + '\n');
  assert.equal(cli(board, ['briefing', '--topic', 'release'], home).stdout, topic('release') + '\n');
});

test('Windows: the prefix, the installed folder and the user\'s folder are spelled the way Windows reads them', () => {
  const core = M.instructions('win32');
  assert.ok(core.includes('命令，前面都加 node "$env:AGENTDECK_BOARD_CLI"：\n'));
  // the Bash tool reads POSIX variables on Windows too: only the listener line is written that way
  assert.equal(core.split('\n').filter((line) => line.includes('"$AGENTDECK_BOARD_CLI"')).length, 1);
  assert.match(core, /- 回执监听：[^\n]*Bash 工具[^\n]*node "\$AGENTDECK_BOARD_CLI" receipts --wait/);
  assert.match(M.restartNotice('win32', 'C:\\b\\handoff.md'), /先运行 node "\$env:AGENTDECK_BOARD_CLI" handoff 取当前交接快照（同时写在 C:\\b\\handoff\.md）/);
  assert.ok(!M.restartNotice('win32', '').includes('"$AGENTDECK_BOARD_CLI"'));
  // rule files are the same on both machines, so they give both spellings once
  for (const name of ['commands', 'inbox']) {
    assert.ok(topic(name).includes('node "$AGENTDECK_BOARD_CLI"'), name);
    assert.ok(topic(name).includes('Windows PowerShell'), name);
    assert.ok(topic(name).includes('node "$env:AGENTDECK_BOARD_CLI"'), name);
  }
  assert.equal(Rules.builtinFile('models', WIN_TOOLS, path.win32, () => true), WIN_TOOLS + '\\captain\\models.md');
  assert.equal(Rules.builtinFile('models', 'D:\\aiproject\\agentdeck', path.win32, () => false), 'D:\\aiproject\\agentdeck\\docs\\captain\\models.md');
  assert.equal(Rules.userFile('models', WIN_HOME, path.win32), WIN_HOME + '\\.agents\\captain\\models.md');
  assert.equal(Rules.userFile('models', '/Users/jinhao', path.posix), '/Users/jinhao/.agents/captain/models.md');
  // nothing in the reader or the CLI joins these paths by hand
  assert.doesNotMatch(read('captain-rules.js'), /['"`][^'"`\n]*\/captain\//);
  assert.match(read('board-cli.js'), /require\('\.\/captain-rules'\)\.briefing\(args\.topic\)/);
});

test('the models rule file carries the same lines the cheap dispatcher is given', () => {
  const models = topic('models');
  const card = { id: 't-1', project: 'p', title: 't', detail: 'd' };
  const dispatcher = M.dispatcherInstructions('darwin', card);
  assert.equal(M.PROVIDERS.length, 7); assert.equal(M.ROUTING.length, 9);
  for (const line of [...M.PROVIDERS, ...M.ROUTING]) {
    assert.ok(models.includes('- ' + line + '\n'), line.slice(0, 30));
    assert.ok(dispatcher.includes(line), 'dispatcher: ' + line.slice(0, 30));
  }
  for (const e of M.EFFORT) assert.ok(models.includes(`- ${e.when}：${e.tier}\n`), e.tier);
  assert.ok(models.includes(`Cursor 把档位写在模型名最后，只用这些名字：${M.CURSOR_MODELS.join('、')}。`));
});

test('what the program already refuses is not spent on the core: one sentence in the models rule file', () => {
  for (const platform of PLATFORMS) for (const legacy of [false, true]) {
    const core = M.instructions(platform, '', legacy);
    assert.doesNotMatch(core, /Claude 4\.x|Haiku 4|--effort|--dangerously|agy|claude-(?:opus|sonnet|haiku)|gemini-|grok-/, platform);
  }
  const models = topic('models');
  assert.match(models, /程序硬拦的两件事，不用自己记：禁用的旧模型 new 会直接拒绝并提示可用模型；给 agy 写的 --effort 会被程序去掉（Gemini 改写成档位后缀）。/);
  // and the program really does both
  assert.match(M.checkCommand('claude --dangerously-skip-permissions --model claude-opus-4-1').error, /用户不用 claude-opus-4-1/);
  assert.match(M.checkCommand('cursor-agent --force --model claude-haiku-4-5').error, /用户不用 claude-haiku-4-5/);
  assert.deepEqual(M.checkCommand('agy --model gemini-3.8-flash-high --effort medium'), { cmd: 'agy --model gemini-3.8-flash-medium' });
  assert.deepEqual(M.checkCommand('agy --model claude-sonnet-4-6 --effort high'), { cmd: 'agy --model claude-sonnet-4-6' });
});

test('the mark of a prompt changes with any change to it, and the restart notice is short and says where the rules are', () => {
  const mac = M.instructions('darwin'), win = M.instructions('win32');
  assert.equal(M.briefingMark(mac), M.briefingMark(M.instructions('darwin')));
  assert.notEqual(M.briefingMark(mac), M.briefingMark(win));
  assert.notEqual(M.briefingMark(mac), M.briefingMark(M.instructions('darwin', '', false, 12)));
  assert.notEqual(M.briefingMark(mac), M.briefingMark(M.instructions('darwin', '', true)));
  assert.notEqual(M.briefingMark(mac), M.briefingMark(mac.replace('红线', '底线')), 'same length, different words');
  for (const platform of PLATFORMS) {
    const notice = M.restartNotice(platform, '/b/agentdeck-captain-handoff.md');
    assert.ok(notice.length < 400, String(notice.length));
    assert.match(notice, /^AgentDeck 刚重启，你还是原来的队长，上下文还在，所以不再重发提示词。/);
    assert.match(notice, /在跑的队员由程序自动续接，不要重派；先运行 node "\$(?:env:)?AGENTDECK_BOARD_CLI" handoff 取当前交接快照（同时写在 \/b\/agentdeck-captain-handoff\.md），核对后读看板继续。/);
    assert.match(notice, /回执监听先检查，没有才重挂恰好一个后台 receipts --wait。/);
    assert.match(notice, /上下文里找不到队长规则，或记不清时，运行 node "\$(?:env:)?AGENTDECK_BOARD_CLI" briefing 重读，细则用 briefing --topic 名。$/);
    assert.ok(!notice.includes('红线'), 'not the prompt');
    assert.ok(!M.restartNotice(platform, '').includes('同时写在'));
  }
});
