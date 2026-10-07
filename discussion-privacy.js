'use strict';
const crypto = require('crypto');
const { isIP } = require('net');

function hash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const LIMITATIONS = [
  '未标注的中文姓名、地址和私人背景组合无法可靠识别；请只提供可外发材料。',
  '无法把无上下文的任意字符串、散列或示例代码可靠区分为密钥；凭据字段及已知密钥格式会硬拦。',
  '公开引用链接保留；未标注的私人公网域名及链接路径中的私人背景需要人工检查。',
];
const EXAMPLE = /^(?:value|example|sample|placeholder|string|number|boolean|identifier|hash|authentication|credentials|name|bucket|token|secret|key|password|passwd|pass|username|user|your(?:[_-](?:api|access))?[_-]?(?:token|key|secret|password)(?:[_-]?(?:here|value))?|not[_-]a[_-]secret|redacted|hidden|none|null|undefined|\*+|<[^>]+>|\$\{[^}]+\})$/i;
const KEY_FORMAT = /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|ya29\.[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/;
function credentialValue(value, field = '', assignment = false) {
  const quoted = /^["']/.test(value);
  // Unexpanded code references contain no credential value. Quoted strings
  // and known key formats still go through the credential checks.
  if (!quoted && !KEY_FORMAT.test(value) && /^(?:process\.env\.[A-Z][A-Z\d_]*|\$[A-Z][A-Z\d_]*|config(?:\.[A-Za-z_$][\w$]*)+)$/.test(value)) return false;
  value = value.replace(/^["']|["']$/g, '');
  if (!value || EXAMPLE.test(value)) return false;
  if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|aws_secret_access_key|password|passwd)$/i.test(field)) return value.length >= 4;
  return value.length >= 8 && (!/^[a-z]+$/i.test(value) || value.length >= 24 || assignment || quoted);
}
function privateHost(host) {
  return !!isIP(host.replace(/^\[|\]$/g, '')) || /^(?:localhost|internal\.|private\.|intranet\.)/i.test(host) || /\.(?:internal|local|localhost|lan|corp|intranet|test|example)$/i.test(host);
}
function decodedUrl(value) {
  // Decode common nested escapes for scanning only; never rewrite citations.
  for (let pass = 0; pass < 3; pass += 1) {
    let decoded;
    try { decoded = decodeURIComponent(value); } catch {
      // A malformed escape elsewhere must not hide an ASCII credential.
      decoded = value.replace(/%([0-7][a-f\d])/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (decoded === value) break;
    value = decoded;
  }
  return value;
}
function privateUrlIdentity(value, options) {
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value) || /(?:\/(?:Users|home)\/[^/\s]+|[A-Z]:[\\/]Users[\\/][^/\\\s]+|\/var\/root(?:\/|\b))/i.test(value)) return true;
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(value) || /(?:^|[/?&#])(?:session[ _-]?id|conversation[ _-]?id|thread[ _-]?id|username|email)(?:[:=/])/i.test(value)) return true;
  return (options.sessionIds || []).some((id) => typeof id === 'string' && id.length >= 2 && new RegExp(`(?<![\\p{L}\\p{N}_])${escape(id)}(?![\\p{L}\\p{N}_])`, 'iu').test(value));
}
// Every outbound packet (including new model prose) passes here. Mappings stay
// in the private run, never in the outbound text or the event log.
// Public citations remain checkable, as required by design-v2's anonymous packet.
function redact(text, options = {}) {
  if (typeof text !== 'string') throw new Error('Discussion input must be text.');
  const mapping = options.mapping || {};
  const findings = [];
  let blocked = false;
  function alias(value, category) {
    const key = `${category}:${value}`;
    if (!mapping[key]) mapping[key] = `[${category}-${Object.keys(mapping).filter((k) => k.startsWith(`${category}:`)).length + 1}]`;
    findings.push(category);
    if (category === '凭据') blocked = true;
    return mapping[key];
  }
  function replace(pattern, category) { text = text.replace(pattern, (value) => alias(value, category)); }
  replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/g, '凭据');
  // Claim URLs before standalone scans, so a public citation is not mistaken
  // for code, an email address or a bare private hostname.
  const publicUrls = [];
  text = text.replace(/\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s<>()"'`，；。;]+/gi, (raw) => {
    const value = raw.replace(/[),.;，；。]+$/, '');
    const suffix = raw.slice(value.length);
    let url;
    try { url = new URL(value); } catch { return raw; }
    const decoded = decodedUrl(value);
    if (KEY_FORMAT.test(decoded) || ((url.username || url.password) && !(EXAMPLE.test(decodedUrl(url.username)) && EXAMPLE.test(decodedUrl(url.password))))) return alias(value, '凭据') + suffix;
    for (const [field, content] of url.searchParams) {
      if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|password|auth|signature)$/i.test(decodedUrl(field)) && credentialValue(decodedUrl(content), decodedUrl(field), true)) return alias(value, '凭据') + suffix;
    }
    const labelled = /(?:^|[/?&#])(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|aws_secret_access_key|token|key|secret|password|auth|signature)([:=/])([^/?&#\s]+)/gi;
    for (const match of decoded.matchAll(labelled)) {
      // Documentation routes like /password/reset are not assignments.
      if (match[2] === '/' && !(/^[A-Za-z\d+/_=-]{16,}$/.test(match[3]) && /[A-Za-z]/.test(match[3]) && /\d/.test(match[3]))) continue;
      if (credentialValue(match[3], match[1], match[2] !== '/')) return alias(value, '凭据') + suffix;
    }
    if (privateHost(url.hostname) || privateUrlIdentity(decoded, options) || [...url.searchParams.keys()].some((field) => /^(?:email|username|session[_-]?id|conversation[_-]?id|thread[_-]?id)$/i.test(decodedUrl(field)))) return alias(value, '网址') + suffix;
    if (!/^https?:$/.test(url.protocol)) return raw;
    const marker = `\uE000${publicUrls.length}\uE001`;
    publicUrls.push(value);
    return marker + suffix;
  });
  replace(new RegExp(KEY_FORMAT.source, 'g'), '凭据');
  text = text.replace(/\bBearer\s+([A-Za-z0-9._~+/-]+=*)/gi, (value, token) => credentialValue(token, '', true) ? alias(value, '凭据') : value);
  text = text.replace(/\bAuthorization\s*:\s*Basic\s+[A-Za-z\d+/]{12,}={0,2}/gi, (value) => alias(value, '凭据'));
  text = text.replace(/\bCookie\s*:\s*([^\r\n]+)/gi, (value, cookie) => /\w+=[^;\s]+/.test(cookie) && !/^\s*name=value\s*$/i.test(cookie) ? alias(value, '凭据') : value);
  text = text.replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|aws_secret_access_key|client[_-]?secret|token|password|passwd|secret|key)["']?\s*[:=]\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；。]+)/gi,
    (value, field, content) => credentialValue(content, field, /^[^:=]*=/.test(value)) ? alias(value, '凭据') : value);
  text = text.replace(/\baws_secret_access_key\s+([A-Za-z0-9/+=]{20,})/gi, (value) => alias(value, '凭据'));
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '邮箱');
  replace(/(?:\/(?:Users|home)\/[^\s/\\,;，；。]+|[A-Z]:[\\/]Users[\\/][^\s/\\,;，；。]+|\/var\/root(?=\/|\b))/gi, '用户目录');
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (value) => isIP(value) === 4 ? alias(value, 'IP') : value);
  text = text.replace(/(?<![\w:])(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*(?:%[\w-]+)?(?![\w:])/gi,
    (value) => value !== '::' && isIP(value) === 6 ? alias(value, 'IP') : value);
  // An allowlist of real, common TLDs avoids turning console.log or *.test.js
  // into hosts. Explicit internal-host labels cover other private hostnames.
  replace(/\b(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+(?:com|org|net|io|ai|dev|app|cn|edu|gov|co|uk|de|fr|jp|us|ca|au|info|biz|xyz|me|cloud|internal|local|localhost|lan|corp|intranet|test|example)(?::\d+)?(?![\w-]|\.[\w-])/gi, '域名');
  text = text.replace(/((?:内部域名|内网地址|内部主机|private\s+host|internal\s+(?:domain|host))\s*[:=：]\s*)([^\s,;，；。]+)/gi, (value, label, host) => label + alias(host, '域名'));
  replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '会话');
  replace(/\b(?:session[ _-]?id|conversation[ _-]?id|thread[ _-]?id|会话\s*id)\s*["']?\s*[:=]\s*["']?[^\s,"';，；。]+/gi, '会话');
  text = text.replace(/((?:\b(?:user[ _-]?name|login[ _-]?name)|用户名)\s*["']?\s*[:=：]\s*["']?)([^\s,"';，；。]+)/gi, (value, label, name) => label + alias(name, '身份'));
  replace(/用户\s+[A-Za-z][\w.-]*/g, '身份');
  replace(/(?<![\d.])(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/g, '电话');
  replace(/(?<!\d)(?:\+1[ -]?)?\(?[2-9]\d{2}\)?[ -]\d{3}[ -]\d{4}(?!\d)/g, '电话');
  replace(/(?<![\w\d])\+[1-9]\d{0,2}(?:[ ()-]*\d){7,12}(?!\d)/g, '电话');
  text = text.replace(/((?:手机号|手机|电话|phone|mobile)\s*[:=：]\s*)(\+?\d[\d ()-]{6,24})/gi, (value, label, phone) => label + alias(phone.trim(), '电话') + phone.slice(phone.trimEnd().length));
  replace(/(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, '身份证');
  text = text.replace(/((?:姓名|真实姓名|联系人(?:姓名)?|full\s+name)\s*[:=：]\s*["']?)([\p{Script=Han}·]{2,8}|[A-Za-z]+(?:[ -][A-Za-z]+){0,3})/giu, (value, label, name) => EXAMPLE.test(name.trim()) ? value : label + alias(name, '姓名'));
  text = text.replace(/((?:家庭地址|联系地址|邮寄地址|居住地址|住址|地址|address)\s*[:=：]\s*["']?)([^\r\n,"';，；。]{2,160})/gi, (value, label, address) => EXAMPLE.test(address.trim()) ? value : label + alias(address, '地址'));
  for (const value of [...new Set(options.sessionIds || [])]) {
    if (typeof value === 'string' && value.length >= 2) replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(value)}(?![\\p{L}\\p{N}_])`, 'giu'), '会话');
  }
  text = text.replace(/\uE000(\d+)\uE001/g, (value, index) => publicUrls[Number(index)]);
  return { text, hash: hash(text), mapping, findings: [...new Set(findings)], blocked, limitations: [...LIMITATIONS] };
}
function anonymize(text) {
  // Hide explicit authorship, not objective company/model facts in the answer.
  // This is label anonymity; unlabelled identity hints can remain in prose.
  return text.split(/(https?:\/\/[^\s<>()"'`，；。;]+)/gi).map((part, index) => index % 2 ? part : part
    .replace(/^\s*(?:>\s*)?(?:实际模型\/档位|模型(?:签名)?|Model|作者|Author|Provider)\s*[:：].*(?:\r?\n|$)/gim, '')
    .replace(/^\s*(?:(?:By|[-—])\s+)?(?:Claude(?:\s+(?:Code|Opus))?|ChatGPT|Gemini|Codex|OpenAI|Anthropic|Opus)(?:\s+\d+(?:\.\d+)*)?\s*$/gim, '')
    .replace(/(?:我是|我作为|I am|I'm|我的(?:模型|供应商|作者身份)(?:是|为|[:：]))\s*(?:Claude(?:\s+(?:Code|Opus))?|ChatGPT|Gemini|Codex|OpenAI|Anthropic|Opus)(?:\s+\d+(?:\.\d+)*)?[,，。:]?/gi, '作为参与者')
    .replace(/\b(?:As|By)\s+(?:Claude(?:\s+(?:Code|Opus))?|ChatGPT|Gemini|Codex|Opus)(?:\s+\d+(?:\.\d+)*)?(?=\s*[,.;，；。:：\r\n]|$)/gi, '作为参与者')
    .replace(/\b(?:Claude(?:\s+(?:Code|Opus))?|ChatGPT|Gemini|Codex|Opus)(?:\s+\d+(?:\.\d+)*)?\s*(?=认为|建议|主张|提议|反驳|在本轮)/gi, '某参与者'))
    .join('');
}
module.exports = { redact, anonymize, hash };
