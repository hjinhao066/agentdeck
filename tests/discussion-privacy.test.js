'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Privacy = require('../discussion-privacy');

test('redaction preserves times, ratios, dotted code identifiers and filenames', () => {
  const text = '时间10:30:45，比例3:2:1；console.log(user.profile.name); fs.readFileSync("discussion-core.test.js"); app.config.ts；版本1.2.3。';
  const result = Privacy.redact(text);
  assert.equal(result.text, text);
  assert.equal(result.blocked, false);
});

test('ordinary token, secret and key explanations keep their complete lines and do not block', () => {
  const text = '令牌桶 rate limiter，key: value 的比较。\ntoken:value；token: authentication；secret = example；key: value。\nconst token = value; const secret = placeholder;\npassword: string；secret=authentication；token=identifier；address: string；full name: example。\n{"key":"value", "password":"your_password", "api_key":"YOUR_API_KEY_HERE"}\nAuthorization: Bearer token\nCookie: name=value';
  const result = Privacy.redact(text);
  assert.equal(result.text, text);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.findings, []);
});

test('unexpanded environment and config references preserve technical prose but quoted actual values still block', () => {
  const text = 'const api_key = process.env.API_KEY;\ntoken=$TOKEN；secret=config.clientSecret；password=config.auth.password；client_secret: process.env.CLIENT_SECRET。';
  const result = Privacy.redact(text);
  assert.equal(result.text, text);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.findings, []);
  for (const value of ['api_key="config.clientSecret"', 'token="$ACTUAL_TOKEN"', 'api_key="actual-private-value-123"', 'api_key=sk_live_' + 'x'.repeat(24)]) {
    const actual = Privacy.redact(value);
    assert.equal(actual.blocked, true);
    assert.ok(!actual.text.includes(value));
  }
});

test('public citation links survive redaction and anonymization verbatim', () => {
  const citations = '[论文](https://arxiv.org/abs/2305.14325)；[官方](https://docs.anthropic.com/en/docs/overview?version=2026#models)；[实现](https://github.com/openai/openai-node/blob/main/src/client.ts)。';
  assert.equal(Privacy.redact(citations).text, citations);
  assert.equal(Privacy.redact(citations).blocked, false);
  assert.equal(Privacy.anonymize(citations), citations);
});

test('public URLs with explicit private path identities are replaced whole, including encoded paths', () => {
  const paths = [
    '/sessions/12345678-abcd-1234-5678-123456789abc', '/export/known-private-session',
    '/people/alice@example.org', '/Users/alice/project', '/home/bob/app', '/var/root/project',
    '/session_id/private123', '/username/alice',
  ];
  for (const path of paths) {
    for (const encoded of [path, encodeURIComponent(path), encodeURIComponent(encodeURIComponent(path))]) {
      const url = 'https://www.nist.gov' + (encoded.startsWith('/') ? encoded : '/' + encoded);
      const result = Privacy.redact('来源 ' + url + '；预算200元。', { sessionIds: ['known-private-session'] });
      assert.equal(result.text, '来源 [网址-1]；预算200元。', path);
      assert.equal(result.blocked, false);
      assert.deepEqual(result.findings, ['网址']);
    }
  }
});

test('encoded credentials in citation URLs hard-block before URL protection', () => {
  const key = 'sk_live_' + 'z'.repeat(24);
  const encodedKey = [...key].map((char) => '%' + char.charCodeAt(0).toString(16)).join('');
  const urls = [
    'https://www.nist.gov/export/' + encodedKey,
    'https://www.nist.gov/export/' + encodeURIComponent(encodedKey),
    'https://www.nist.gov/%ff/export/' + encodedKey,
    'https://www.nist.gov/token%3Dabc123def456',
    'https://www.nist.gov/?access%5Ftoken=abc123def456',
    'postgres://admin:p%77@database.internal:5432/app',
  ];
  for (const url of urls) {
    const result = Privacy.redact('来源 ' + url + '；预算200元。');
    assert.equal(result.blocked, true, url.slice(0, 35));
    assert.equal(result.text, '来源 [凭据-1]；预算200元。');
    assert.deepEqual(result.findings, ['凭据']);
  }
});

test('ordinary citation paths keep years, hashes and token documentation without guessed identities', () => {
  const text = 'https://www.nist.gov/2026/10/07/' + 'a'.repeat(64) + '?version=2026；https://docs.anthropic.com/token/introduction；https://www.nist.gov/key/value；https://www.nist.gov/%74oken/introduction；https://www.nist.gov/?token=example；https://www.nist.gov/password/reset；https://www.nist.gov/api_key/overview';
  const result = Privacy.redact(text);
  assert.equal(result.text, text);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.findings, []);
});

test('private hosts and IP URLs are replaced while public references remain usable', () => {
  const text = '来源https://www.nist.gov/publications；内部http://intranet.corp/wiki；IPv4 http://192.0.2.1:3000/admin；IPv6 https://[2001:db8::1]/admin；内部域名: buildbox.company，预算200元。';
  const result = Privacy.redact(text);
  assert.match(result.text, /https:\/\/www\.nist\.gov\/publications/);
  assert.doesNotMatch(result.text, /intranet\.corp|192\.0\.2\.1|2001:db8|buildbox\.company/);
  assert.match(result.text, /预算200元/);
  assert.equal(result.blocked, false);
});

test('bare domains use known TLDs and never match a prefix of a source filename', () => {
  const text = 'example.com internal.example.com private.example.test；console.log fs.readFileSync user.profile.name discussion-core.test.js app.config.ts；工期两天。 host private.example.test.';
  const result = Privacy.redact(text);
  assert.doesNotMatch(result.text, /example\.com|private\.example\.test/);
  assert.match(result.text, /\[域名-\d+\]\.$/, 'sentence punctuation is retained without bypassing host redaction');
  for (const value of ['console.log', 'fs.readFileSync', 'user.profile.name', 'discussion-core.test.js', 'app.config.ts', '工期两天']) assert.ok(result.text.includes(value));
});

test('IPv6 is validated as a complete address rather than guessed from colon counts', () => {
  const result = Privacy.redact('10:30:45 3:2:1 2001:db8::1 ::1 fe80::1%en0 192.168.1.1 999.10.20.30 std::vector');
  assert.match(result.text, /10:30:45 3:2:1/);
  assert.match(result.text, /999\.10\.20\.30 std::vector/);
  assert.doesNotMatch(result.text, /2001:db8|::1|fe80:|192\.168\.1\.1/);
  assert.equal(result.blocked, false);
});

test('known credential formats are redacted and hard-blocked, including previously missed providers', () => {
  const credentials = [
    'sk-' + 'a'.repeat(24), 'sk_live_' + 'b'.repeat(24), 'xoxb-' + '12-'.repeat(8) + 'token',
    'ya29.' + 'c'.repeat(30), 'ghp_' + 'd'.repeat(30), 'AKIA' + 'A'.repeat(16),
    'AIza' + 'e'.repeat(30), 'eyJabc.def.ghi',
  ];
  for (const value of credentials) {
    const result = Privacy.redact('before ' + value + ' after');
    assert.equal(result.blocked, true, value.slice(0, 8));
    assert.ok(!result.text.includes(value));
    assert.match(result.text, /^before \[凭据-\d+\] after$/);
    assert.deepEqual(result.findings, ['凭据']);
  }
});

test('private keys and labelled credentials block without deleting surrounding topic text', () => {
  const values = [
    '-----BEGIN PRIVATE KEY-----\nfake material\n-----END PRIVATE KEY-----',
    'api_key=' + 'a'.repeat(32), 'TOKEN=supersecret', 'password="hunter2hunter2"',
    'aws_secret_access_key ' + 'b'.repeat(40), 'Authorization: Bearer ' + 'c'.repeat(32),
    'Cookie: session=ab12cd34',
  ];
  for (const value of values) {
    const result = Privacy.redact('建议先验证，' + value + '\n预算200元。');
    assert.equal(result.blocked, true);
    assert.match(result.text, /建议先验证/);
    assert.match(result.text, /预算200元/);
    assert.ok(!result.text.includes(value));
  }
});

test('database userinfo and actual URL credentials are blocked before the public citation exception', () => {
  const values = [
    'postgres://admin:pw@database.internal:5432/app',
    'mongodb+srv://admin:pw@cluster.example.com/db',
    'https://docs.example.com/api?access_token=' + 'a'.repeat(32),
    'https://public.example.com/export/' + 'sk_live_' + 'b'.repeat(24),
  ];
  for (const value of values) {
    const result = Privacy.redact('来源 ' + value + '；预算200元。');
    assert.equal(result.blocked, true);
    assert.ok(!result.text.includes(value));
    assert.doesNotMatch(result.text, /admin:pw/);
    assert.match(result.text, /预算200元/);
  }
});

test('phone numbers, IDs, user paths and explicitly labelled Chinese personal details are redacted', () => {
  const text = '姓名：张三，地址：北京市朝阳区示例路1号；手机13800138000；电话+1 206-555-0123；+44 20 7946 0958；身份证11010519491231002X；/var/root/project /Users/alice/project C:\\Users\\alice\\repo /home/bob/app；预算100元。';
  const result = Privacy.redact(text);
  assert.doesNotMatch(result.text, /张三|北京市|13800138000|206-555|7946|11010519491231002X|\/var\/root|alice|\/home\/bob/);
  assert.match(result.text, /预算100元/);
  assert.equal(result.blocked, false);
});

test('known usernames are not blindly replaced in ordinary prose, while explicit usernames are private', () => {
  const text = 'root 是树根；node 是节点；alice 的公开方案。用户名: captain_alice，预算200元。 "username":"other_bob"; 工期两天。';
  const result = Privacy.redact(text, { usernames: ['root', 'node', 'alice'] });
  assert.match(result.text, /root 是树根；node 是节点；alice 的公开方案/);
  assert.doesNotMatch(result.text, /captain_alice|other_bob/);
  assert.match(result.text, /预算200元/);
  assert.match(result.text, /工期两天/);
});

test('unlabelled names, addresses and opaque hashes stay intact with explicit detection limitations', () => {
  const text = '张三说北京市朝阳区的公开案例很好。源码散列 ' + 'a'.repeat(64) + '；预算100元。';
  const result = Privacy.redact(text);
  assert.equal(result.text, text);
  assert.equal(result.blocked, false);
  assert.ok(result.limitations.some((value) => value.includes('未标注的中文姓名')));
  assert.ok(result.limitations.some((value) => value.includes('散列')));
});

test('redaction aliases remain stable across rounds and findings never contain secret text', () => {
  const mapping = {};
  const first = Privacy.redact('a@b.org again a@b.org', { mapping });
  assert.equal(first.text, '[邮箱-1] again [邮箱-1]');
  assert.equal(Privacy.redact('a@b.org', { mapping }).text, '[邮箱-1]');
  assert.equal(first.hash, Privacy.hash(first.text));
  const secret = 'sk_live_' + 'z'.repeat(24);
  const blocked = Privacy.redact(secret, { mapping });
  assert.equal(blocked.blocked, true);
  assert.ok(!JSON.stringify(blocked.findings).includes(secret));
});

test('explicit model authorship is anonymous while provider citation URLs stay checkable', () => {
  const text = '作者: Claude\nChatGPT 认为选Y；By Claude：需要保留证据；我是 Gemini，建议验证。\nProvider: OpenAI\n来源 https://www.anthropic.com/research。\nClaude Opus 5.5';
  const result = Privacy.anonymize(text);
  assert.doesNotMatch(result.replace(/https?:\/\/\S+/g, ''), /Claude|ChatGPT|Gemini|OpenAI/);
  assert.match(result, /https:\/\/www\.anthropic\.com\/research/);
});

test('anonymization preserves objective product and company comparisons rather than guessing the author', () => {
  const text = 'Claude Opus 5.5 与 OpenAI 的产品需要按实际延迟比较。Anthropic/OpenAI 的公开定价是待核实事实，ChatGPT 支持哪些功能应查来源。Gemini 与 Codex 的能力不是同一项指标。As OpenAI releases models, compare their documented limits. Claude Shannon 是论文引用的作者。';
  assert.equal(Privacy.anonymize(text), text);
});
