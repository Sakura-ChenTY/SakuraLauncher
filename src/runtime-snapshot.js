/**
 * 小助手运行时快照。
 *
 * 只读：不启动/停止进程，不改实例，不跑测速。
 * server.js 在开关打开时收集，作为一次 chat 的实时上下文传入。
 */
import fs from 'node:fs';
import path from 'node:path';

import { portFromServerProperties, portFromRoomLogs } from './room-port.js';

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function latestFile(dir, ext) {
  let best = null;
  for (const ent of safeReadDir(dir)) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith(ext)) continue;
    const file = path.join(dir, ent.name);
    try {
      const st = fs.statSync(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: file, mtimeMs: st.mtimeMs };
    } catch { /* ignore */ }
  }
  return best?.path ?? null;
}

function logsText(state, room, online) {
  const lines = [
    ...(Array.isArray(state?.logs) ? state.logs : []),
    ...(Array.isArray(room?.logs) ? room.logs : []),
  ].map((x) => String(x?.line ?? x ?? ''));
  for (const s of Object.values(online ?? {})) {
    if (Array.isArray(s?.lines)) lines.push(...s.lines.map((x) => String(x)));
  }
  return lines;
}

function lastTunnelEvent(lines, pattern) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!/\[隧道\]|frp|tunnel|local=|remote=/i.test(line)) continue;
    if (pattern.test(line)) return line;
  }
  return null;
}

function javaVersionFrom(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /使用\s*Java\s*([^\s：:]+)/i.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

function heapFromCommand(command) {
  const text = String(command || '');
  const m = /(?:^|\s)-Xmx(\d+)([mMgG])(?:\s|$)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'g' ? n * 1024 : n;
}

function countMods(instanceDir) {
  return safeReadDir(path.join(instanceDir, 'mods'))
    .filter((x) => x.isFile() && x.name.toLowerCase().endsWith('.jar')).length;
}

function latestCrash(instanceDir, gameDir) {
  const dirs = [
    path.join(instanceDir, 'crash-reports'),
    path.join(gameDir, 'crash-reports'),
  ];
  let best = null;
  for (const dir of dirs) {
    const file = latestFile(dir, '.txt');
    if (!file) continue;
    try {
      const st = fs.statSync(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: file, mtimeMs: st.mtimeMs };
    } catch { /* ignore */ }
  }
  return best?.path ?? null;
}

export function collectRuntimeSnapshot({ state = {}, room = null, online = null } = {}) {
  const gameDir = String(state.gameDir || '');
  const versionId =
    String(state.running?.versionId || state.lastLaunch?.versionId || state.lastFailure?.versionId || room?.versionId || '');
  const instanceDir = versionId ? path.join(gameDir, 'versions', versionId) : gameDir;
  const lines = logsText(state, room, online);

  const pid = Number(state.running?.pid || 0) || null;
  let alive = false;
  if (pid) {
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  }

  const propertyPaths = [
    room?.serverDir ? path.join(room.serverDir, 'server.properties') : null,
    instanceDir ? path.join(instanceDir, 'server.properties') : null,
    gameDir ? path.join(gameDir, 'server.properties') : null,
  ].filter(Boolean);
  let serverPropertiesPort = null;
  let serverPropertiesFile = null;
  for (const file of propertyPaths) {
    const port = portFromServerProperties(file);
    if (port) { serverPropertiesPort = port; serverPropertiesFile = file; break; }
  }

  const logPort = portFromRoomLogs([
    ...(Array.isArray(state.logs) ? state.logs : []),
    ...(Array.isArray(room?.logs) ? room.logs : []),
  ].map((x) => String(x?.line ?? x)))?.port ?? null;
  const actualPort = logPort ?? (Number(state.lanPort?.port) || null);
  const portSource = logPort ? 'room-log' : (actualPort ? 'lan-port' : null);

  const frp = room?.frp && typeof room.frp === 'object' ? room.frp : null;
  const provider = String(frp?.provider || '');
  const session = provider && online?.[provider] ? online[provider] : null;
  const tunnelList = Array.isArray(session?.tunnels) ? session.tunnels : [];
  const tunnel = tunnelList.find((x) => String(x.id) === String(frp?.tunnelId)) || null;
  const tunnelLocalPort = Number(frp?.localPort ?? tunnel?.localPort ?? 0) || null;
  const remoteAddress = String(frp?.address || session?.address || tunnel?.address || '');
  const tunnelStatus = session?.running
    ? 'running'
    : (room?.status === 'running' || room?.status === 'starting' ? 'room-active' : 'idle');

  const snapshot = {
    ts: new Date().toISOString(),
    java: {
      alive,
      pid,
      startedAt: state.running?.startedAt ?? null,
      version: javaVersionFrom(lines),
      source: state.running?.versionId ? 'running' : 'last-launch',
    },
    ports: {
      serverProperties: serverPropertiesPort,
      actual: actualPort,
      serverPropertiesFile,
      source: portSource,
      mismatch: Boolean(serverPropertiesPort && actualPort && serverPropertiesPort !== actualPort),
    },
    tunnel: {
      provider: provider || null,
      tunnelId: frp?.tunnelId ?? session?.tunnelId ?? null,
      localPort: tunnelLocalPort,
      remoteAddress: remoteAddress || '',
      status: tunnelStatus,
      lastSuccess: lastTunnelEvent(lines, /成功|success|started|online|已启动/i),
      lastFailure: lastTunnelEvent(lines, /失败|fail|error|错误/i),
      lastRetry: lastTunnelEvent(lines, /重试|retry/i),
    },
    launcher: {
      instanceName: versionId || null,
      heapMb: heapFromCommand(state.lastLaunch?.command),
      modCount: versionId ? countMods(instanceDir) : 0,
      lastExitCode: state.lastExit?.code ?? state.lastFailure?.code ?? null,
      crashReport: latestCrash(instanceDir, gameDir),
    },
  };
  const tunnelMismatch = Boolean(actualPort && tunnelLocalPort && Number(actualPort) !== Number(tunnelLocalPort));
  snapshot.ports.tunnelMismatch = tunnelMismatch;
  snapshot.ports.mismatch = Boolean(snapshot.ports.mismatch || tunnelMismatch);
  return snapshot;
}
