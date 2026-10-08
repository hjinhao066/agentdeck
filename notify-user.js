'use strict';
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const Policy = require('./bark-policy');

// Only authenticated board requests reach here; never accept a key from the CLI.
function createNotifyUser({ getConfig, notifications, fetchImpl = fetch, delivery, keyHome }) {
  const sendBark = createBarkSender({ getConfig, fetchImpl, delivery, keyHome });
  return async (command, visible, turnId = command.id, structured = false) => {
    const config = getConfig();
    if (!(config.columns || []).some((c) => c.isMain && c.id === command.callerId)) {
      throw new Error('只有队长可以用这个命令。');
    }
    if (typeof command.message !== 'string' || !command.message.trim() || command.message.length > 4000 ||
        typeof command.urgent !== 'boolean' || (command.test !== undefined && typeof command.test !== 'boolean') ||
        (command.test && !command.urgent)) throw new Error('notify-user requires --message (1–4000 characters) and optional --urgent.');
    notifications.show({ id: command.callerId, turnId, state: 'input', reply: command.message, visible });
    const local = '已处理本机提醒（遵循通知/声音设置、前台静音及30秒间隔）。';
    // `bark` is a phone push with its own title and level (待我处理 items); without it only --urgent reaches the phone.
    if (!command.urgent && !command.bark) return local;
    const result = await sendBark(command.test
      ? { message: `AgentDeck 加急通知测试，音量 ${Policy.settings(config.barkNotifications).criticalVolume}`, title: '【测试】', level: 'critical' }
      : command.bark || { message: command.message, level: 'critical', dedupeKey: command.dedupeKey });

    const message = local + '\n' + result.message;
    return structured ? { ...result, message } : message;
  };
}
// Shared sender extracted from origin/feat/captain-notify (0a850e0).
// Fixed endpoint, private key-file lookup and redacted errors stay in one place.
function createBarkSender({ getConfig, fetchImpl = fetch, delivery, keyHome }) {
  const transport = async ({ message, title = '队长', level = 'active' }) => {
    if (typeof message !== 'string' || !message.trim() || message.length > 4000 ||
        !['active', 'critical'].includes(level)) throw new Error('Invalid Bark message or notification level.');
    const config = getConfig();
    const volume = Policy.settings(config.barkNotifications).criticalVolume;
    let file = typeof config.barkKeyFile === 'string' ? config.barkKeyFile.trim() : '';
    // Same private device-key file used by the Captain on this machine. An
    // explicit path wins; never silently change devices when that path fails.
    if (!file) file = '~/.secrets/bark-key.txt';
    if (file.startsWith('~/')) file = path.join(keyHome || os.homedir(), file.slice(2));
    const blank = !(typeof config.barkKeyFile === 'string' && config.barkKeyFile.trim());
    let key;
    try {
      if (!path.isAbsolute(file)) throw new Error();
      const stat = await fs.stat(file).catch((error) => {
        // No setting and no default file: this machine was never set up for the
        // phone (the default file exists on the Mac only). Nothing to retry.
        throw Object.assign(new Error(), { unconfigured: blank && error.code === 'ENOENT' });
      });
      if (!stat.isFile() || stat.size > 4096) throw new Error();
      key = (await fs.readFile(file, 'utf8')).trim();
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(key)) throw new Error();
    } catch (error) {
      return { ok: false, ...(error.unconfigured ? { unconfigured: true } : {}), message: 'Bark 密钥文件不可读或格式无效，请检查设置中的本机密钥文件路径（留空默认 ~/.secrets/bark-key.txt，文件仅含设备 key）。' };
    }
    try {
      const response = await fetchImpl('https://api.day.app/push', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ device_key: key, title, body: message.trim(),
          level, ...(level === 'critical' ? { volume } : {}), sound: 'minuet' }),

      });
      const code = (await response.json()).code;
      return { ok: response.ok && code === 200, httpStatus: response.status,
        apiCode: typeof code === 'number' ? code : null,
        message: response.ok && code === 200 ? (level === 'critical' ? 'Bark 紧急提醒已发送。' : 'Bark 提醒已发送。') : 'Bark 发送失败（网络、服务或设备 key 问题），请检查后重试。' };

    } catch (_) {
      // Network/server errors can include secrets. Never return their text.
      return { ok: false, message: 'Bark 发送失败（网络、服务或设备 key 问题），请检查后重试。' };
    }
  };
  return async ({ message, title = '队长', level = 'active', dedupeKey }) => {
    if (typeof message !== 'string' || !message.trim() || message.length > 4000 ||
        typeof title !== 'string' || title.length > 200 || !['active', 'critical'].includes(level)) throw new Error('Invalid Bark message or notification level.');
    const payload = { message: message.trim(), title, level, ...(typeof dedupeKey === 'string' && dedupeKey.length <= 200 ? { dedupeKey } : {}) };
    return delivery ? delivery.send(payload, transport) : transport(payload);
  };
}
module.exports = { createNotifyUser, createBarkSender };
