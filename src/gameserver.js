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
import { loadVersion, resolveJavaBin } from './launch.js';
import { getSettings } from './settings.js';
import { prepareModrinthServer, prepareCurseForgeServer } from './packserver.js';

export const ROOM_PORT = 25565;
const ROOM_MEMORY_MB = 2048;
const ROOM_MEMORY_MIN_MB = 256;
const ROOM_MEMORY_MAX_MB = 16384;

function roomMemoryMb(value, pack) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return pack?.kind === 'curseforge' ? 3072 : ROOM_MEMORY_MB;
  return Math.max(ROOM_MEMORY_MIN_MB, Math.min(ROOM_MEMORY_MAX_MB, Math.round(n)));
}

const WORLD_DEFAULTS = Object.freeze({
  keepInventory: false,
  difficulty: 'normal',
  onlineMode: true,
  maxPlayers: 20,
  viewDistance: 10,
  pvp: true,
  spawnProtection: 16,
});

function normalizeWorldSettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const difficulty = ['peaceful', 'easy', 'normal', 'hard'].includes(String(r.difficulty).toLowerCase())
    ? String(r.difficulty).toLowerCase() : WORLD_DEFAULTS.difficulty;
  const int = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
  };
  return {
    keepInventory: typeof r.keepInventory === 'boolean' ? r.keepInventory : WORLD_DEFAULTS.keepInventory,
    difficulty,
    onlineMode: typeof r.onlineMode === 'boolean' ? r.onlineMode : WORLD_DEFAULTS.onlineMode,
    maxPlayers: int(r.maxPlayers, WORLD_DEFAULTS.maxPlayers, 1, 100),
    viewDistance: int(r.viewDistance, WORLD_DEFAULTS.viewDistance, 2, 32),
    pvp: typeof r.pvp === 'boolean' ? r.pvp : WORLD_DEFAULTS.pvp,
    spawnProtection: int(r.spawnProtection, WORLD_DEFAULTS.spawnProtection, 0, 1000),
  };
}

function settingsFile(serverDir) {
  return path.join(serverDir, 'server-settings.json');
}

function readWorldSettingsFromDisk(serverDir) {
  try {
    const sidecar = settingsFile(serverDir);
    if (fs.existsSync(sidecar)) return normalizeWorldSettings(JSON.parse(fs.readFileSync(sidecar, 'utf8')));
  } catch { /* fall through to properties */ }
  const out = { ...WORLD_DEFAULTS };
  const file = path.join(serverDir, 'server.properties');
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k === 'difficulty') out.difficulty = v;
      else if (k === 'online-mode') out.onlineMode = v === 'true';
      else if (k === 'max-players') out.maxPlayers = Number(v) || out.maxPlayers;
      else if (k === 'view-distance') out.viewDistance = Number(v) || out.viewDistance;
      else if (k === 'pvp') out.pvp = v === 'true';
      else if (k === 'spawn-protection') out.spawnProtection = Number(v) || 0;
    }
  } catch { /* defaults */ }
  return normalizeWorldSettings(out);
}

export function getWorldSettings({ gameDir, versionId }) {
  if (!gameDir || !versionId) return { ...WORLD_DEFAULTS };
  try {
    const { serverDir } = resolveServerPaths(gameDir, versionId);
    return readWorldSettingsFromDisk(serverDir);
  } catch {
    return { ...WORLD_DEFAULTS };
  }
}

export function saveWorldSettings({ gameDir, versionId, settings, onLog }) {
  if (!gameDir || !versionId) throw new Error('缺少 gameDir/versionId');
  const { serverDir } = resolveServerPaths(gameDir, versionId);
  fs.mkdirSync(serverDir, { recursive: true });
  const value = normalizeWorldSettings(settings);
  fs.writeFileSync(settingsFile(serverDir), JSON.stringify(value, null, 2), 'utf8');
  writeServerProperties(path.join(serverDir, 'server.properties'), value);
  if (room.status === 'running' && room.versionId === versionId && child?.stdin?.writable) {
    sendCommand(`/difficulty ${value.difficulty}`);
    sendCommand(`gamerule ${keepInventoryRule(room.gameVersion || versionId)} ${value.keepInventory}`);
    return {
      settings: value,
      applied: ['difficulty', 'keepInventory'],
      restartRequired: ['onlineMode', 'maxPlayers', 'viewDistance', 'pvp', 'spawnProtection'],
    };
  }
  return { settings: value, applied: [], restartRequired: [] };
}

let room = emptyRoom();
let child = null;
let readyPromise = null;

function emptyRoom() {
  return {
    status: 'idle', // idle | starting | running | stopping | error
    versionId: '',
    gameVersion: '',
    memoryMb: ROOM_MEMORY_MB,
    pack: null,
    pid: null,
    port: ROOM_PORT,
    serverDir: '',
    worldDir: '',
    startedAt: null,
    stoppedAt: null,
    error: '',
    autoStopOnExit: true,
    settings: { ...WORLD_DEFAULTS },
    frp: null,
    requestedFrp: null,
    hostGamePid: null,
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

function writeServerProperties(file, settings = WORLD_DEFAULTS) {
  const s = normalizeWorldSettings(settings);
  const values = {
    'server-port': '25565',
    'motd': 'SakuraLauncher',
    'online-mode': String(s.onlineMode),
    'max-players': String(s.maxPlayers),
    'view-distance': String(s.viewDistance),
    'difficulty': s.difficulty,
    'pvp': String(s.pvp),
    'spawn-protection': String(s.spawnProtection),
    'enable-query': 'false',
    'enable-rcon': 'false',
  };
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const seen = new Set();
  const out = lines.map((line) => {
    const i = line.indexOf('=');
    if (i <= 0) return line;
    const key = line.slice(0, i).trim();
    if (!Object.prototype.hasOwnProperty.call(values, key)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  fs.writeFileSync(file, `${out.filter((x, i, a) => x !== '' || i < a.length - 1).join('\n')}\n`, 'utf8');
}

function keepInventoryRule(versionId) {
  // 26.x 的 gamerule 使用蛇形命名；老版本仍用 keepInventory。
  return /^26\./i.test(String(versionId)) ? 'keep_inventory' : 'keepInventory';
}
function sendCommand(command) {
  if (!child?.stdin?.writable) return false;
  try {
    child.stdin.write(`${command}\n`);
    return true;
  } catch {
    return false;
  }
}

function resolveServerPaths(gameDir, versionId) {
  if (!/^[\w.+-]+$/.test(String(versionId))) throw new Error('版本 id 不合法');
  const serverDir = path.join(gameDir, '.mclauncher', 'server', versionId);
  return { serverDir, worldDir: path.join(serverDir, 'world') };
}

async function prepareJar({ gameDir, versionId, settings, onStage, onLog }) {
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
  writeServerProperties(propertiesPath, settings);
  const java = await resolveJavaBin({
    java: getSettings().javaPath || undefined,
    onJavaStage: ({ message }) => onStage?.(message),
    onJavaProgress: ({ message }) => onLog?.(`[java] ${message}`),
  }, versionJson);
  return { serverDir, jarPath, javaBin: java.bin, javaMajor: java.major ?? null };
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

export async function startRoom({ versionId, gameDir, eulaAccepted = false, memoryMb = ROOM_MEMORY_MB, autoStopOnExit = true, settings = {}, pack = null, requestedFrp = null, onStage, onLog } = {}) {
  if (!versionId) throw new Error('缺少 versionId');
  if (!gameDir) throw new Error('缺少 gameDir');
  if (!eulaAccepted) throw new Error('需要先同意 Minecraft EULA');
  if (room.status === 'starting' || room.status === 'running' || room.status === 'stopping') {
    throw new Error(`房间正在${room.status === 'running' ? '运行' : '处理中'}`);
  }

  room = emptyRoom();
  room.status = 'starting';
  room.versionId = versionId;
  room.gameVersion = pack?.gameVersion || versionId;
  room.memoryMb = roomMemoryMb(memoryMb, pack);
  room.pack = pack && typeof pack === 'object' ? { ...pack } : null;
  room.autoStopOnExit = autoStopOnExit !== false;
  room.settings = normalizeWorldSettings(settings);
  room.error = '';
  room.requestedFrp = requestedFrp;
  try {
    const freeMb = Math.floor(os.freemem() / 1024 / 1024);
    if (room.memoryMb > freeMb) {
      const suggested = Math.max(ROOM_MEMORY_MIN_MB, Math.floor((freeMb * 0.8) / 512) * 512);
      throw new Error(`内存不足：房间需要 ${room.memoryMb} MB，系统当前可用约 ${freeMb} MB；请把内存调到约 ${suggested} MB，或先关闭其他程序。`);
    }
    await assertPortFree(ROOM_PORT);
    const serverPaths = resolveServerPaths(gameDir, versionId);
    let prepared;
    if (pack) {
      const kind = String(pack.kind || '');
      if (kind === 'modrinth') {
        prepared = await prepareModrinthServer({
          serverDir: serverPaths.serverDir,
          pack,
          onStage: (message) => onStage?.(message),
        });
      } else if (kind === 'curseforge') {
        prepared = await prepareCurseForgeServer({
          serverDir: serverPaths.serverDir,
          pack,
          onStage: (message) => onStage?.(message),
        });
      } else {
        throw new Error(`不支持的整合包类型：${kind || '未知'}`);
      }
      await fsp.writeFile(path.join(prepared.serverDir, 'eula.txt'), 'eula=true\n', 'utf8');
      writeServerProperties(path.join(prepared.serverDir, 'server.properties'), room.settings);
    } else {
      prepared = await prepareJar({ gameDir, versionId, settings: room.settings, onStage, onLog });
    }
    room.serverDir = prepared.serverDir;
    room.worldDir = path.join(prepared.serverDir, 'world');
    if (prepared.pack) {
      room.pack = { ...room.pack, ...prepared.pack };
      room.gameVersion = prepared.pack.gameVersion || prepared.gameVersion || room.gameVersion;
    }
    append(`启动 Java ${prepared.javaMajor ?? '?'}：${prepared.javaBin}`, onLog);
    append(`固定端口 ${ROOM_PORT}`, onLog);
    append(`服务端内存 ${room.memoryMb} MB`, onLog);

    child = spawn(prepared.javaBin, [
      `-Xms${Math.min(512, room.memoryMb)}M`,
      `-Xmx${room.memoryMb}M`,
      ...(prepared.args || ['-jar', prepared.jarPath, 'nogui']),
    ], {
      cwd: prepared.serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });    room.pid = child.pid;
    room.startedAt = Date.now();
    readyPromise = waitForReady(onLog);
    await readyPromise;
    if (room.status === 'starting') {
      room.status = 'running';
      sendCommand(`/difficulty ${room.settings.difficulty}`);
      sendCommand(`gamerule ${keepInventoryRule(room.gameVersion || room.versionId)} ${room.settings.keepInventory}`);
      append('server 已就绪', onLog);
    }
    return publicRoom();
  } catch (e) {
    room.status = 'error';
    room.error = e.message || String(e);
    append(`启动失败：${room.error}`, onLog);
    await stopRoom({ keepWorld: true }).catch(() => {});
    // stopRoom 会把状态复位为 idle；启动失败需要保留 error，卡片才能显示
    // 原因和“改用局域网/frp”的建议。
    room.status = 'error';
    room.error = e.message || String(e);
    room.pid = null;
    room.frp = null;
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
  room.frp = null;
  room.stoppedAt = Date.now();
  append('server 已停止', onLog);
  return publicRoom();
}

export function setRoomFrp(frp) {
  room.frp = frp && typeof frp === 'object' ? { ...frp } : null;
  return room.frp;
}

export function failRoom(error) {
  room.status = 'error';
  room.error = String(error || '房间启动失败');
  room.pid = null;
  room.frp = null;
  append(`房间错误：${room.error}`);
  return publicRoom();
}
export function attachHostGame(pid) {
  if (!pid) return false;
  if (room.status !== 'running' && room.status !== 'starting') return false;
  room.hostGamePid = Number(pid) || null;
  return true;
}

/** 房主客户端退出时由 server.js 调用；true 表示已经自动关房。 */
export async function onHostGameExit(pid) {
  if (!room.hostGamePid) return false;
  if (pid && Number(room.hostGamePid) !== Number(pid)) return false;
  if (!room.autoStopOnExit) return false;
  if (room.status !== 'running' && room.status !== 'starting') return false;
  await stopRoom({ keepWorld: true });
  return true;
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
