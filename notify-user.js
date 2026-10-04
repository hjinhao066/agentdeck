'use strict';
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// Only authenticated board requests reach here; never accept a key from the CLI.
function createNotifyUser({ getConfig, notifications, fetchImpl = fetch }) {
  return async (command, visible, turnId = command.id) => {
    const config = getConfig();
    if (!(config.columns || []).some((c) => c.isMain && c.id === command.callerId)) {
      throw new Error('只有队长可以用这个命令。');
    }
    if (typeof command.message !== 'string' || !command.message.trim() || command.message.length > 4000 ||
        typeof command.urgent !== 'boolean') throw new Error('notify-user requires --message (1–4000 characters) and optional --urgent.');
    notifications.show({ id: command.callerId, turnId, state: 'input', reply: command.message, visible });
    const local = '已处理本机提醒（遵循通知/声音设置、前台静音及30秒间隔）。';
    if (!command.urgent) return local;
    let file = typeof config.barkKeyFile === 'string' ? config.barkKeyFile.trim() : '';
    if (!file) return local + '\nBark 已跳过：请在设置中配置本机密钥文件路径。';
    if (file.startsWith('~/')) file = path.join(os.homedir(), file.slice(2));
    let key;
    try {
      if (!path.isAbsolute(file)) throw new Error();
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 4096) throw new Error();
      key = (await fs.readFile(file, 'utf8')).trim();
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(key)) throw new Error();
    } catch (_) {
      return local + '\nBark 已跳过：密钥文件不可读或格式无效，请检查设置（文件仅含设备 key）。';
    }
    try {
      const response = await fetchImpl('https://api.day.app/push', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ device_key: key, title: '队长', body: command.message.trim(),
          level: 'critical', volume: 4, sound: 'minuet' }),
      });
      if (!response.ok || (await response.json()).code !== 200) throw new Error();
      return local + '\nBark 紧急提醒已发送。';
    } catch (_) {
      // Network/server errors can include secrets. Never return their text.
      return local + '\nBark 发送失败（网络、服务或设备 key 问题），请检查后重试。';
    }
  };
}
module.exports = { createNotifyUser };
