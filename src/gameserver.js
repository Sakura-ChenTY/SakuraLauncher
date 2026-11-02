/**
 * 官方 Minecraft 服务端托管（联机「开房间」第一阶段）。
 *
 * 这一层只做原版 server.jar：
 *   - 从已安装版本的 version JSON 取 downloads.server
 *   - 固定 25565
 *   - 写 eula.txt / server.properties
 *   - 启动/停止 java -jar server.jar nogui
 *
 * 世界目录不在这里删除。停止只停进程，world 留在 serverDir 下。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

import { downloadFile } from './download.js';
import { loadVersion } from './launch.js';
import { findJava } from './launch.js';
import { getSettings } from './settings.js';
import { JAVA_SCAN_CACHE } from './paths.js';

export const ROOM_PORT = 25565;
const ROOM_MEMORY_MB = 2048;

let room = emptyRoom();
let child = null;
let readyPromise = null;

function emptyRoom() {
  return {
    status: 'idle', // idle | starting | running | stopping | error
    versionId: '',
    pid: null,
    port: ROOM_PORT,
    serverDir: '',
    worldDir: '',
    startedAt: null,
    stoppedAt: null,
    error: '',
    logs: [],
  };
}

function publicRoom() {
  return {
    ...room,
    logs: room.logs.slice(-120),
  };
}

function append(line, onLog) {
  const text = String(line ?? '').replace(/\r$/, '');
  if (!text) return;
  room.logs.push(text);
  if (room.logs.length > 300) room.logs.shift();
  try {
    onLog?.(text);
  } catch {
    /* 日志回调失败不能影响 server */
  }
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (e) => {
      if (e.code === 'EADDRINUSE') reject(new Error(`端口 ${port} 已被占用`));
      else reject(e);
    });
    srv.once('listening', () => srv.close(() => resolve()));
    srv.listen(port, '127.0.0.1');
  });
}

function writeServerProperties(file) {
  const defaults = [
    'server-port=25565',
    'motd=SakuraLauncher',
    'online-mode=true',
    'enable-query=false',
    'enable-rcon=false',
  ];
  const seen = new Set();
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  }
  for (const raw of lines) {
    const key = raw.split('=')[0]?.trim();
    if (!key) {
      lines[lines.indexOf(raw)] = raw;
      continue;
    }
    if (key === 'server-port') {
      lines[lines.indexOf(raw)] = 'server-port=25565';
      seen.add(key);
    }
  }
  for (const line of defaults) {
    const key = line.split('=')[0];
    if (!seen.has(key)) lines.push(line);
  }
  fs.writeFileSync(file, `${lines.filter((x, i, a) => x !== '' || i < a.length - 1).join('\n')}\n`, 'utf8');
}

function resolveServerPaths(gameDir, versionId) {
  if (!/^[\w.+-]+$/.test(String(versionId))) throw new Error('版本 id 不合法');
  const serverDir = path.join(gameDir, '.mclauncher', 'server', versionId);
  return { serverDir, worldDir: path.join(serverDir, 'world') };
}

async function prepareJar({ gameDir, versionId, onStage, onLog }) {
  const versionsDir = path.join(gameDir, 'versions');
  const { json: versionJson } = loadVersion(versionsDir, versionId);
  const server = versionJson?.downloads?.server;
  if (!server?.url) throw new Error('这个版本没有官方 server.jar（开房间第一阶段只支持原版）');

  const { serverDir } = resolveServerPaths(gameDir, versionId);
  await fsp.mkdir(serverDir, { recursive: true });
  const jarPath = path.join(serverDir, 'server.jar');
  if (!fs.existsSync(jarPath) || (server.size && fs.statSync(jarPath).size !== server.size)) {
    onStage?.(`下载官方 server.jar（${Math.round((server.size ?? 0) / 1024 / 1024)}MB）`);
    await downloadFile(server.url, jarPath, {
      sha1: server.sha1,
      size: server.size,
      retries: 3,
      timeout: 180000,
      source: getSettings().downloadSource === 'bmclapi' ? 'bmclapi' : 'official',
    });
    append(`server.jar 下载完成：${path.basename(jarPath)}`, onLog);
  } else {
    append('复用已缓存的 server.jar', onLog);
  }

  const eulaPath = path.join(serverDir, 'eula.txt');
  await fsp.writeFile(eulaPath, 'eula=true\n', 'utf8');
  const propertiesPath = path.join(serverDir, 'server.properties');
  writeServerProperties(propertiesPath);
  const requiredJava = versionJson.javaVersion?.majorVersion ?? null;
  const java = await findJava(getSettings().javaPath, requiredJava, JAVA_SCAN_CACHE);
  if (!java?.path) throw new Error(`找不到可用的 Java${requiredJava ? ` ${requiredJava}` : ''}`);
  return { serverDir, jarPath, javaBin: java.path, javaMajor: java.major ?? null };
}

function waitForReady(onLog) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('server 启动超时（120 秒）'));
    }, 120000);
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    child.stdout?.on('data', (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        append(line, onLog);
        if (/Done \(|\bStarted server\b/i.test(line)) finish();
      }
    });
    child.stderr?.on('data', (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        append(line, onLog);
        if (/Done \(|\bStarted server\b/i.test(line)) finish();
      }
    });
    child.once('error', (e) => finish(e));
    child.once('close', (code) => {
      if (settled) return;
      finish(new Error(`server 启动失败，退出码 ${code}`));
    });
  });
}

export async function startRoom({ versionId, gameDir, eulaAccepted = false, memoryMb = ROOM_MEMORY_MB, onStage, onLog } = {}) {
  if (!versionId) throw new Error('缺少 versionId');
  if (!gameDir) throw new Error('缺少 gameDir');
  if (!eulaAccepted) throw new Error('需要先同意 Minecraft EULA');
  if (room.status === 'starting' || room.status === 'running' || room.status === 'stopping') {
    throw new Error(`房间正在${room.status === 'running' ? '运行' : '处理中'}`);
  }

  room = emptyRoom();
  room.status = 'starting';
  room.versionId = versionId;
  room.error = '';
  try {
    await assertPortFree(ROOM_PORT);
    const prepared = await prepareJar({ gameDir, versionId, onStage, onLog });
    room.serverDir = prepared.serverDir;
    room.worldDir = path.join(prepared.serverDir, 'world');
    append(`启动 Java ${prepared.javaMajor ?? '?'}：${prepared.javaBin}`, onLog);
    append(`固定端口 ${ROOM_PORT}`, onLog);

    child = spawn(prepared.javaBin, [
      `-Xms512M`,
      `-Xmx${Math.max(512, Number(memoryMb) || ROOM_MEMORY_MB)}M`,
      '-jar',
      prepared.jarPath,
      'nogui',
    ], {
      cwd: prepared.serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    room.pid = child.pid;
    room.startedAt = Date.now();
    readyPromise = waitForReady(onLog);
    await readyPromise;
    if (room.status === 'starting') {
      room.status = 'running';
      append('server 已就绪', onLog);
    }
    return publicRoom();
  } catch (e) {
    room.status = 'error';
    room.error = e.message || String(e);
    append(`启动失败：${room.error}`, onLog);
    await stopRoom({ keepWorld: true }).catch(() => {});
    throw e;
  }
}

export async function stopRoom({ keepWorld = true, onLog } = {}) {
  if (!child && room.status === 'idle') return publicRoom();
  if (room.status === 'stopping') return publicRoom();
  room.status = 'stopping';
  append(keepWorld ? '正在停止 server（保留 world）' : '正在停止 server', onLog);

  if (child) {
    try {
      child.stdin?.write('stop\n');
      child.stdin?.end();
    } catch { /* server 可能已经退出 */ }
    const closed = await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(true);
      };
      child.once('close', finish);
      setTimeout(() => {
        if (done) return;
        try {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch { /* ignore */ }
        finish();
      }, 15000);
    });
    if (!closed) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
    }
  }

  child = null;
  room.status = 'idle';
  room.pid = null;
  room.stoppedAt = Date.now();
  append('server 已停止', onLog);
  return publicRoom();
}

export function getRoomState() {
  return publicRoom();
}

// 应用退出时兜底，不删 world。
process.once('exit', () => {
  try {
    if (child?.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } catch { /* ignore */ }
});
