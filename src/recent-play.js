/**
 * 最近游玩记录。
 *
 * 只存恢复启动所需要的路径和房间元数据，不存 token、密码或账号凭据。
 * 文件位置：~/.mclauncher/recent-play.json（可用 MCLAUNCHER_HOME 覆盖）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { RECENT_FILE, ensureHome } from './paths.js';

const SCHEMA = 1;

export function readRecent() {
  try {
    if (!fs.existsSync(RECENT_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    if (!data || data.schema !== SCHEMA || !data.last || typeof data.last !== 'object') return null;
    return data.last;
  } catch {
    return null;
  }
}

export function clearRecent() {
  try {
    fs.rmSync(RECENT_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

export function saveRecent(record) {
  ensureHome();
  const payload = {
    schema: SCHEMA,
    last: {
      ...record,
      updatedAt: Date.now(),
    },
  };
  const tmp = `${RECENT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, RECENT_FILE);
  return payload.last;
}

export function validateRecent(record, gameDir) {
  if (!record?.versionId) return { valid: false, reason: '没有版本信息' };
  if (!gameDir) return { valid: false, reason: '没有游戏目录' };
  const instanceDir = path.join(gameDir, 'versions', String(record.versionId));
  if (!fs.existsSync(instanceDir)) return { valid: false, reason: '实例已删除' };

  if (record.mode === 'single') {
    if (record.savePath && !fs.existsSync(record.savePath)) {
      return { valid: false, reason: '存档目录已不存在' };
    }
  } else if (record.mode === 'multiplayer') {
    if (!record.role) return { valid: false, reason: '缺少房间角色' };
    if (record.role === 'host') {
      if (!record.serverWorldPath || !fs.existsSync(record.serverWorldPath)) {
        return { valid: false, reason: '服务端 world 已不存在' };
      }
      if (!record.room?.provider) return { valid: false, reason: '缺少 frp 配置' };
    }
    if (record.role === 'guest' && !/^[^\s:]+:\d{1,5}$/.test(String(record.joinAddress || ''))) {
      return { valid: false, reason: '加入地址无效' };
    }
  } else {
    return { valid: false, reason: '未知启动模式' };
  }

  return { valid: true, reason: '' };
}
