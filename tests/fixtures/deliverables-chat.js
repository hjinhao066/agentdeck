// A 队长 conversation that handed over many files: replies that mention them,
// task cards with the crew's receipts, an older conversation from before a
// context clear, sessions' last receipts and 队长's task list. Result files
// (documents, pictures, videos) mix with process files (scripts, data, logs,
// node_modules, a scratch folder) the 交付文件 panel must leave out.
// files(out) lists every path; build(out, now) returns { config, chats }.
const path = require('path');

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// [relative path, made on disk?]
const RESULTS = [
  ['客户门户/周报-第41周.md', true], ['客户门户/登录流程说明.md', true], ['客户门户/shots/home-dark.png', true], ['客户门户/shots/home-light.png', true],
  ['客户门户/演示/walkthrough.mp4', true], ['客户门户/接口变更.md', true], ['客户门户/上线清单.md', true],
  ['报表服务/q3-summary.pdf', true], ['报表服务/budget-2027.xlsx', true], ['报表服务/经营分析.pptx', true], ['报表服务/需求说明.docx', true],
  ['报表服务/charts/trend.webp', true], ['报表服务/charts/trend.gif', true],
  ['reports/chat-deliverables/report.html', true], ['reports/chat-deliverables/before-wide.png', true], ['reports/chat-deliverables/after-wide.png', true],
  ['reports/chat-deliverables/demo.mov', true], ['reports/design-review.md', true], ['reports/old-plan.md', true], ['reports/brand/logo.svg', true],
  ['reports/brand/cover.jpg', true], ['reports/audio/voice-memo.m4a', true], ['reports/missing-summary.md', false], ['reports/release-notes.md', true],
];
const PROCESS = [
  'scripts/build.py', 'src/app.js', 'data/config.json', '报表服务/export/orders.csv', 'logs/run.log', 'db/cache.sqlite',
  'node_modules/pkg/README.md', 'scratchpad/notes.md', 'src/.cache/thumb.png', '客户门户/build/app.min.js', 'notes/todo.txt',
];
const TMP_FILE = '/tmp/agentdeck-deliverables-e2e/draft.md';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function files(out) {
  const f = (rel) => path.join(out, ...rel.split('/'));
  return { f, results: RESULTS.map(([rel, made]) => ({ rel, path: f(rel), made, name: rel.split('/').pop() })), process: [...PROCESS.map(f), TMP_FILE] };
}

function body(name) {
  if (/\.png$/.test(name)) return PNG;
  if (/\.md$/.test(name)) return `# ${name.replace(/\.md$/, '')}\n\n这是测试用的交付文件。\n\n- 第一条\n- 第二条\n`;
  return name + '\n';
}

function build(out, now, { CAPTAIN, OLD, LOGIN, EXPORT, FAKE }) {
  const { f } = files(out);
  // today's turns are spread over the morning, so "今天" holds them however late the test runs
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const morning = Math.max(today.getTime() + MIN, Math.min(now - 2 * HOUR, today.getTime() + 9 * HOUR));
  let ts = morning;
  const at = (m) => (ts += m * MIN);
  const said = (id, user, reply) => { const t = at(7); return { id, ts: t, end: t + 41_000, user, reply, done: true, atts: [] }; };
  const card = (id, title, colId, project, receipt, when) => ({ id, ts: when || at(2), kind: 'task', user: title, reply: receipt.summary, done: true, atts: [],
    task: { colId, title, status: 'done', project, doneAt: (when || ts) + 5 * MIN, receipt: { failed: '', question: '', images: [], explicit: true, source: 'command', ...receipt } } });

  const live = [
    said('l-1', '把客户门户这周的进展整理一下发我。', [
      '这周客户门户的进展整理好了，周报在这里：',
      '',
      f('客户门户/周报-第41周.md'),
      '',
      '要点',
      '',
      '- 登录流程改成先验证手机号再发会话，说明文档已更新。',
      '- 首页深浅色截图都重拍了，和设计稿逐项对过。',
      '- 演示视频录好了：' + f('客户门户/演示/walkthrough.mp4'),
      '',
      '构建脚本 ' + f('scripts/build.py') + ' 和数据 ' + f('data/config.json') + ' 只是过程文件，不用看。',
    ].join('\n')),
    card('k-login', '登录流程说明和深浅色截图', LOGIN, '客户门户', { summary: '说明文档和两张截图都更新了，回归通过。',
      files: [f('客户门户/登录流程说明.md'), f('客户门户/shots/home-dark.png'), f('客户门户/shots/home-light.png'), f('src/app.js'), f('logs/run.log')] }),
    said('l-2', '设计评审的结论呢？', [
      '设计评审开完了，结论记在 ' + f('reports/design-review.md') + '。',
      '',
      '1. 对话页回复列整体左移，左边留白约为原来的 0.618 倍。',
      '2. 右侧加交付文件栏，可以收起。',
      '3. 宽窄窗、深浅色都要截图验收。',
      '',
      '临时稿 ' + TMP_FILE + ' 和 ' + f('scratchpad/notes.md') + ' 是草稿，不算交付。',
    ].join('\n')),
    card('k-export', '第三季度报表和预算', EXPORT, '报表服务', { summary: '季度汇总 PDF、明年预算和趋势图都导出了。',
      files: [f('报表服务/q3-summary.pdf'), f('报表服务/budget-2027.xlsx'), f('报表服务/charts/trend.webp'), f('报表服务/charts/trend.gif'), f('报表服务/export/orders.csv'), f('db/cache.sqlite')] }),
    said('l-3', '这次的验收材料都放哪了？', [
      '验收材料都在一个文件夹里：',
      '',
      '| 内容 | 文件 |',
      '| --- | --- |',
      '| 报告 | ' + f('reports/chat-deliverables/report.html') + ' |',
      '| 改前截图 | ' + f('reports/chat-deliverables/before-wide.png') + ' |',
      '| 改后截图 | ' + f('reports/chat-deliverables/after-wide.png') + ' |',
      '| 操作录屏 | ' + f('reports/chat-deliverables/demo.mov') + ' |',
      '',
      '依赖里的 ' + f('node_modules/pkg/README.md') + ' 不用管。',
    ].join('\n')),
    card('k-brand', '品牌素材', 'gone-brand', '', { summary: '标志和封面图交付了，录音备忘也附上。',
      files: [f('reports/brand/logo.svg'), f('reports/brand/cover.jpg'), f('reports/audio/voice-memo.m4a'), f('src/.cache/thumb.png')] }),
    said('l-4', '上线前还差什么？', [
      '还差两件事：',
      '',
      '- 上线清单 ' + f('客户门户/上线清单.md') + ' 里最后三项要你确认。',
      '- 接口变更 ' + f('客户门户/接口变更.md') + ' 已经同步给报表服务。',
      '',
      '设计评审的结论没变，还是看 ' + f('reports/design-review.md') + '。发版说明草稿在 ' + f('reports/release-notes.md') + '。',
    ].join('\n')),
    said('l-5', '好，那先这样。', '好的。有新的交付我会在回复里给出路径，右侧交付文件栏也会自动收进去。'),
  ];

  // before the context was cleared: three days ago
  const old = new Date(now - 3 * DAY); old.setHours(10, 0, 0, 0);
  let ots = old.getTime();
  const oat = (m) => (ots += m * MIN);
  const oldTurns = [
    { id: 'o-1', ts: oat(0), end: ots + 30_000, user: '先出一版计划。', reply: '计划写好了：' + f('reports/old-plan.md') + '\n\n设计评审初稿：' + f('reports/design-review.md'), done: true, atts: [] },
    { id: 'o-2', ts: oat(20), end: ots + 30_000, user: '日志呢？', reply: '日志在 ' + f('logs/run.log') + '，备忘在 ' + f('notes/todo.txt') + '。', done: true, atts: [] },
  ];

  const yesterday = new Date(now - DAY); yesterday.setHours(16, 30, 0, 0);
  const yts = yesterday.getTime();
  const column = (id, title, project, more) => ({ id, title, displayTitle: title, manualTitle: true, project, cmd: FAKE, cwd: out, width: 760, role: 'manual', view: 'chat', ...more });
  const config = {
    theme: 'dark', fitWindow: true, fitCols: 2, globalViewMode: 'chat', perpetualCaptain: { enabled: false }, resumeOnRestart: false,
    columns: [
      column(CAPTAIN, '队长', '', { isMain: true, cmd: FAKE + ' --captain-statusline' }),
      column(LOGIN, '登录与权限', '客户门户', { captainCrew: true, lastReceipt: { summary: '说明文档和两张截图都更新了，回归通过。', files: [f('客户门户/登录流程说明.md')], explicit: true, source: 'command', ts: live[1].ts + 5 * MIN } }),
      column(EXPORT, '报表导出', '报表服务', { captainCrew: true, lastReceipt: { summary: '需求说明写好了。', files: [f('报表服务/需求说明.docx'), f('报表服务/export/orders.csv')], explicit: true, source: 'command', ts: yts } }),
    ],
    mainSession: { colId: CAPTAIN, cmd: FAKE + ' --captain-statusline', gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks: [
      { id: 'k-analysis', colId: EXPORT, title: '经营分析幻灯片', project: '报表服务', gen: 1, status: 'done', sentAt: yts - 2 * HOUR, doneAt: yts - HOUR, turnId: '',
        receipt: { summary: '经营分析幻灯片做好了；汇总稿找不到了。', files: [f('报表服务/经营分析.pptx'), f('reports/missing-summary.md')], explicit: true, source: 'command' } },
    ] },
    captainHistory: [{ id: OLD, from: oldTurns[0].ts, to: oldTurns.at(-1).ts, turns: oldTurns.length, clearedAt: oldTurns.at(-1).ts + HOUR }],
    // the test profile lives in the system temp folder (var/folders, Windows' Temp): keep the other defaults
    deliverableRules: { skip: ['node_modules', '.git', 'scratchpad', 'tmp', '.cache', 'caches', '__pycache__', '.venv', 'venv', 'site-packages', 'test-results', 'playwright-report', '.next', 'dist'] },
  };
  return { config, chats: { [CAPTAIN]: { v: 1, id: CAPTAIN, turns: live }, [OLD]: { v: 1, id: OLD, captainArchive: true, turns: oldTurns } } };
}

module.exports = { files, body, build, RESULTS, PROCESS, TMP_FILE };
