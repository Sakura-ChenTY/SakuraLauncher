import fs from 'node:fs';
import path from 'node:path';

function validPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function portFromText(text) {
  const patterns = [
    /Starting Minecraft server on\s+(?:[^\s:]+:)?(\d{2,5})\b/gi,
    /Local game hosted on port\s+(\d{2,5})\b/gi,
    /Started serving on\s+(?:[^\s:]+:)?(\d{2,5})\b/gi,
    /对局域网开放[^\n]*?(\d{2,5})/g,
  ];
  let latest = null;
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const port = validPort(m[1]);
      if (port) latest = port;
    }
  }
  return latest;
}

export function portFromServerProperties(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      if (line.slice(0, i).trim() !== 'server-port') continue;
      const port = validPort(line.slice(i + 1).trim());
      if (port) return port;
    }
  } catch {
    /* 文件不存在或不可读，继续探测日志 */
  }
  return null;
}

export function portFromLogFile(file, sinceMs = 0) {
  try {
    const st = fs.statSync(file);
    // 只接受本次启动之后有更新的日志，避免读到上一次会话残留端口。
    if (sinceMs && st.mtimeMs < sinceMs) return null;
    const fd = fs.openSync(file, 'r');
    const max = 256 * 1024;
    const start = Math.max(0, st.size - max);
    const buf = Buffer.alloc(Math.min(max, st.size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const port = portFromText(buf.toString('utf8'));
    return port ? { port, file } : null;
  } catch {
    return null;
  }
}

export function portFromRoomLogs(lines = []) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = String(lines[i] || '');
    const port = portFromText(text);
    if (port) return { port, line: text, index: i };
  }
  return null;
}

function portPaths({ gameDir, versionId, serverDir }) {
  const logFiles = [
    serverDir ? path.join(serverDir, 'logs', 'latest.log') : null,
    gameDir && versionId ? path.join(gameDir, 'versions', versionId, 'logs', 'latest.log') : null,
    gameDir ? path.join(gameDir, 'logs', 'latest.log') : null,
  ].filter(Boolean);
  const propFiles = [
    serverDir ? path.join(serverDir, 'server.properties') : null,
    gameDir && versionId ? path.join(gameDir, 'versions', versionId, 'server.properties') : null,
    gameDir ? path.join(gameDir, 'server.properties') : null,
  ].filter(Boolean);
  return { logFiles, propFiles };
}

/**
 * 解析房间实际监听端口；优先级：
 * 1. 游戏输出最新一条 Started serving / Local game hosted
 * 2. server.properties 的 server-port（专用服务器）
 * 3. 都没有就抛错，绝不静默使用 25565。
 */
function roomPortFromLogs({ gameDir, versionId, serverDir, roomLogs = [], sinceMs = 0 } = {}) {
  const { logFiles } = portPaths({ gameDir, versionId, serverDir });
  for (const file of logFiles) {
    const found = portFromLogFile(file, sinceMs);
    if (found) return { port: found.port, source: 'latest.log', file };
  }
  const fromRoom = portFromRoomLogs(roomLogs);
  if (fromRoom) return { port: fromRoom.port, source: 'room-log', line: fromRoom.line };
  return null;
}

function portFromProperties(opts = {}) {
  const { propFiles } = portPaths(opts);
  for (const file of propFiles) {
    const port = portFromServerProperties(file);
    if (port) return { port, source: 'server.properties', file };
  }
  return null;
}

function errorNoPort(opts = {}, reason = '') {
  const { logFiles, propFiles } = portPaths(opts);
  return new Error(
    `拿不到端口${reason ? `（${reason}）` : ''}：没有在 latest.log / room.log 找到 Started serving / Local game hosted，也没有可用的 server-port。` +
    `已检查：${[...logFiles, ...propFiles].join('；') || '无路径'}`
  );
}

/**
 * roomType:
 * - lan / singleplayer：只认本次启动后的日志，properties 不参与
 * - dedicated：只认 server.properties
 * - 其他/未知：日志优先，日志没有再用 properties
 */
export function resolveRoomPort(opts = {}) {
  const roomType = String(opts.roomType || '').toLowerCase();
  const logs = roomPortFromLogs(opts);
  const props = portFromProperties(opts);

  if (roomType === 'lan' || roomType === 'singleplayer' || roomType === 'local') {
    if (logs) return logs;
    throw errorNoPort(opts, '局域网房间必须从游戏输出拿到监听端口');
  }
  if (roomType === 'dedicated' || roomType === 'server') {
    if (props) return props;
    throw errorNoPort(opts, '专用服务器缺少 server-port');
  }

  if (logs) return logs;
  if (props) return props;
  throw errorNoPort(opts);
}

/** 先等游戏输出出现监听端口；超时后才允许回落到 server.properties。 */
export async function waitForRoomPort(opts = {}, timeoutMs = 30000) {
  const roomType = String(opts.roomType || '').toLowerCase();
  if (roomType === 'dedicated' || roomType === 'server') {
    return resolveRoomPort(opts);
  }
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 30000);
  while (Date.now() < deadline) {
    const fromLogs = roomPortFromLogs(opts);
    if (fromLogs) return fromLogs;
    await new Promise((r) => setTimeout(r, 500));
  }
  return resolveRoomPort(opts);
}
