'use strict';

// This stand-in implements the skill CLI's file contract without a browser.
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const input = option('--file');
const output = option('--out');
const eventsDir = process.env.CHATGPT_WEB_TEST_EVENTS_DIR;
const question = fs.readFileSync(input, 'utf8');
const scenario = question.match(/\[(FIRST|SECOND|LOGIN_REQUIRED|RATE_LIMITED|TIMEOUT)\]/)?.[1] || 'SUCCESS';
const startedAt = Date.now();
const record = (event) => {
  if (!eventsDir) return;
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.appendFileSync(path.join(eventsDir, 'events.jsonl'), JSON.stringify({ event, scenario, at: Date.now() }) + '\n');
};

async function main() {
  record('begin');
  if (eventsDir && ['FIRST', 'SECOND'].includes(scenario)) {
    const gate = path.join(eventsDir, 'release-' + scenario);
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(gate) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!fs.existsSync(gate)) throw new Error('The E2E did not release its fake request.');
  }
  const reasons = {
    LOGIN_REQUIRED: 'ChatGPT 未登录，请用户在专用 Chrome 窗口登录；本次未发送。',
    RATE_LIMITED: 'ChatGPT 网页额度已达上限，请等待页面提示的恢复时间；不要重发。',
    TIMEOUT: '网页等待超时，没有确认完整结束；请用户检查保留的请求页，不要自动重发。',
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (reasons[scenario]) {
    fs.writeFileSync(output + '.error.json', JSON.stringify({ status: 'error', code: scenario, reason: reasons[scenario], submitted: scenario !== 'LOGIN_REQUIRED' }));
    record('end');
    process.stderr.write(scenario + ': ' + reasons[scenario] + '\n');
    process.exitCode = 1;
    return;
  }
  const mode = option('--mode') || 'chat';
  const model = option('--model') || '6 Pro';
  fs.writeFileSync(output, '> 实际模型/档位：' + model + '\n\n# Public research result\n\nWater freezes at 0 °C under standard atmospheric pressure.\n\nSource: [NIST](https://www.nist.gov/)\n');
  fs.writeFileSync(output + '.meta.json', JSON.stringify({
    requestedModel: model, selectedModel: model, requestedMode: mode, selectedMode: mode,
    submitted: true, clarificationCount: 0, startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(), elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    exportMethod: 'clipboard',
  }));
  record('end');
  process.stdout.write('回答已保存：' + output + '\n');
}

main().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
