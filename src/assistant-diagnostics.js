/**
 * 小助手分诊：按症状收集不同材料。
 * 这里只做只读采集和脱敏，不启动、不停止任何服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';

import { HOME_DIR } from './paths.js';
import { getSettings } from './settings.js';
import { onlineSnapshot } from './online.js';
import { getRoomState } from './gameserver.js';
import { collectContext, redact } from './ai.js';

export const SYMPTOMS = {
  startup: '启动崩溃',
  online: '联机进不去',
  modpack: '整合包下载失败',
  download: '资源/版本下载失败',
  mod: 'mod 冲突',
  performance: '性能卡顿',
  unknown: '未判断出类别',
};

export const IMPLEMENTATION_NOTES = [
  '开房流程：房间先启动 Minecraft server，再启动 frp；SakuraFrp 隧道会把 local_port 改成 25565；停房时会还原原来的 local_port。',
  '开房时 frp 是跟随房间启动的，不是先单独点 frp；房间失败时要看 room.error 和 frpc 最近输出。',
  'server pack 缺失时的原文：这个包没有服务端文件，只能原版/兼容模式。',
  'server pack 有 id 但下载不到时的原文：这个包需要手动放服务端包……把 Server Pack 放到对应服务端目录的 server-pack.zip，再重新开房。',
  '手动兜底：server-pack.zip / cf-server-pack.zip / ServerFiles.zip 放到房间服务端目录即可。',
].join('\n');

const categoryRules = [
  ['online', /联机|frp|隧道|房间.*进|进.*房间|朋友.*连|端口|连接超时|服务器.*连不上|lan|局域网/i],
  ['modpack', /整合包|modpack|mrpack|server\s*pack|curseforge.*(下载|安装)|modrinth.*(下载|安装)/i],
  ['download', /资源.*下载|版本.*下载|下载失败|hash|校验|代理|下载卡|下载不动/i],
  ['mod', /mod.*(冲突|不兼容)|duplicate|missing depend|前置|incompatible|mixin/i],
  ['performance', /卡顿|掉帧|性能|lag|tps|帧数|很卡/i],
  ['startup', /启动|崩溃|闪退|进不去游戏|hs_err|crash|报错|打不开游戏/i],
];

export function detectSymptom(message) {
  const text = String(message || '').trim();
  if (!text) return 'unknown';
  for (const [id, re] of categoryRules) {
    if (re.test(text)) return id;
  }
  return 'unknown';
}

export function isTechnicalQuestion(message) {
  return /失败|不行|打不开|有问题|报错|错误|怎么办|怎么回事|连不上|卡住/i.test(String(message || ''));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function tailFile(file, maxBytes = 20000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, st.size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

function mods(gameDir, versionId) {
  try {
    return fs.readdirSync(path.join(gameDir, 'versions', versionId, 'mods'))
      .filter((n) => /\.jar$/i.test(n)).slice(0, 300).join('\n');
  } catch { return ''; }
}

function loaderInfo(gameDir, versionId) {
  const file = path.join(gameDir, 'versions', versionId, `${versionId}.json`);
  const data = readJson(file);
  if (!data) return '';
  return `id=${data.id ?? versionId} inheritsFrom=${data.inheritsFrom ?? ''} mainClass=${data.mainClass ?? ''} java=${data.javaVersion?.majorVersion ?? '?'}`;
}

function diskInfo(dir) {
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    return `${Math.round(free / 1024 / 1024)}M 可用`;
  } catch { return '读取失败'; }
}

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return '可写'; }
  catch { return '不可写或不存在'; }
}

function recentLines(lines, re, count = 40) {
  return (lines || []).map((x) => x?.line ?? x).filter((x) => typeof x === 'string' && re.test(x)).slice(-count);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) || 25565 });
    const done = (value) => { try { socket.destroy(); } catch { /* ignore */ } resolve(value); };
    socket.setTimeout(900);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function ownRoomLines(room) {
  return (room?.logs || []).slice(-60).join('\n');
}

async function onlineContext({ gameDir, versionId, state }) {
  const room = getRoomState();
  const online = onlineSnapshot();
  const selectedFrp = room?.frp || room?.requestedFrp || null;
  const provider = selectedFrp?.provider || '';
  const providerState = provider ? online[provider] : null;
  const open = await portOpen(25565);
  const parts = [
    `症状：联机进不去`,
    `当前 provider：${provider || '未选择'}`,
    `房间状态：${room?.status || 'idle'}；error=${room?.error || '无'}`,
    `房间端口：${room?.port || 25565}；本机 25565 监听：${open ? '有' : '没有'}`,
    `隧道：${selectedFrp ? JSON.stringify(selectedFrp) : '无'}`,
    `frp 会话：${providerState ? JSON.stringify({
      configured: providerState.configured,
      running: providerState.running,
      pid: providerState.pid,
      address: providerState.address,
      tunnelId: providerState.tunnelId,
      error: providerState.error,
      tunnels: providerState.tunnels,
    }) : '无'}`,
    `frpc 最近输出：\n${providerState?.lines?.slice(-20).join('\n') || '无'}`,
    `房间最近日志：\n${ownRoomLines(room) || '无'}`,
    `启动器联机相关日志：\n${recentLines(state?.logs, /frp|隧道|房间|连接|端口|online|provider/i).join('\n') || '无'}`,
    `客户端连接日志：\n${recentLines(state?.logs, /Connecting|Joined|Disconnected|Connection|连接|服务器/i).join('\n') || '无'}`,
    `防火墙：请确认 Windows 防火墙允许 java/javaw；启动器不会自动修改防火墙。`,
  ];
  return parts.join('\n\n');
}

function modpackContext({ gameDir, versionId, state }) {
  const room = getRoomState();
  const settings = getSettings();
  const dir = room?.serverDir || path.join(gameDir, '.mclauncher', 'server', room?.versionId || versionId || '');
  const pack = room?.pack || null;
  const serverPackMeta = readJson(path.join(dir, 'server-pack.json'));
  const candidates = ['server-pack.zip', 'cf-server-pack.zip', 'ServerFiles.zip']
    .map((n) => path.join(dir, n)).filter((f) => fs.existsSync(f));
  return [
    '症状：整合包下载/安装失败',
    `请求的整合包：${JSON.stringify(pack || '无')}`,
    `project/file：${pack?.modId || pack?.projectId || '?'} / ${pack?.fileId ?? pack?.versionId ?? '?'}`,
    `来源：${pack?.kind || '未知'}；下载源设置：${settings.downloadSource || 'auto'}`,
    `房间状态：${room?.status || 'idle'}；error=${room?.error || '无'}`,
    `服务端目录：${dir || '无'}`,
    `目录权限：${writable(dir)}；磁盘：${diskInfo(dir)}`,
    `serverPackFileId：${pack?.serverPackFileId ?? serverPackMeta?.serverPackFileId ?? '无'}`,
    `server-pack.zip 兜底：${candidates.length ? candidates.join('、') : '未找到'}`,
    `server-pack.json：${serverPackMeta ? JSON.stringify(serverPackMeta) : '无'}`,
    `房间日志：\n${ownRoomLines(room) || '无'}`,
    `启动器下载日志：\n${recentLines(state?.logs, /CurseForge|Modrinth|server pack|下载|hash|校验|HTTP|返回|失败/i).join('\n') || '无'}`,
  ].join('\n\n');
}

function downloadContext({ gameDir, versionId, state }) {
  const settings = getSettings();
  const last = state?.lastFailure;
  return [
    '症状：资源/版本下载失败',
    `实例：${versionId || '未选择'}；安装状态：${state?.installing ? JSON.stringify(state.installing) : '无'}`,
    `最近失败：${last ? JSON.stringify(last) : '无'}`,
    `下载源：${settings.downloadSource || 'auto'}；并发：${settings.concurrency || '?'}`,
    `启动器设置里的 Java：${settings.javaPath || '自动'}`,
    `最近下载日志：\n${recentLines(state?.logs, /下载|download|HTTP|URL|状态码|retry|重试|hash|校验|代理|失败/i).join('\n') || '无'}`,
    `代理环境：HTTP_PROXY=${process.env.HTTP_PROXY || '未设置'}，HTTPS_PROXY=${process.env.HTTPS_PROXY || '未设置'}`,
    `游戏目录：${gameDir}；磁盘：${diskInfo(gameDir)}`,
  ].join('\n\n');
}

function modContext({ gameDir, versionId, state }) {
  return [
    '症状：mod 冲突',
    `实例：${versionId || '未选择'}`,
    `加载器：${loaderInfo(gameDir, versionId) || '未读到版本 JSON'}`,
    `mods 列表：\n${mods(gameDir, versionId) || '无'}`,
    `相关日志：\n${recentLines(state?.logs, /duplicate|missing depend|Incompatible|Mixin|mod conflict|NoClassDefFoundError|前置/i).join('\n') || '无'}`,
    `游戏 latest.log 相关行：\n${tailFile(path.join(gameDir, 'versions', versionId, 'logs', 'latest.log'), 30000).split(/\r?\n/).filter((l) => /duplicate|missing depend|Incompatible|Mixin|mod conflict|NoClassDefFoundError|前置/i.test(l)).slice(-30).join('\n') || '无'}`,
  ].join('\n\n');
}

function performanceContext({ gameDir, versionId, state }) {
  return [
    '症状：性能卡顿',
    `实例：${versionId || '未选择'}；运行状态：${state?.running ? JSON.stringify(state.running) : '未运行'}`,
    `系统内存：共 ${Math.round(os.totalmem() / 1024 / 1024)}M，可用 ${Math.round(os.freemem() / 1024 / 1024)}M`,
    `最近启动命令：${state?.lastLaunch?.command ? JSON.stringify(state.lastLaunch.command) : '无'}`,
    `启动器日志：\n${recentLines(state?.logs, /GC|lag|tps|卡|内存|性能|Can't keep up/i).join('\n') || '无'}`,
    `游戏 latest.log 相关行：\n${tailFile(path.join(gameDir, 'versions', versionId, 'logs', 'latest.log'), 30000).split(/\r?\n/).filter((l) => /GC|lag|tps|Can't keep up|内存/i.test(l)).slice(-30).join('\n') || '无'}`,
  ].join('\n\n');
}

export async function collectSymptomContext(category, { gameDir, versionId, state }) {
  let text = '';
  try {
    if (category === 'online') text = await onlineContext({ gameDir, versionId, state });
    else if (category === 'modpack') text = modpackContext({ gameDir, versionId, state });
    else if (category === 'download') text = downloadContext({ gameDir, versionId, state });
    else if (category === 'mod') text = modContext({ gameDir, versionId, state });
    else if (category === 'performance') text = performanceContext({ gameDir, versionId, state });
    else text = collectContext({
      gameDir,
      versionId,
      lastFailure: state?.lastFailure,
      logs: state?.logs,
      launchCommand: state?.lastLaunch?.command,
    });
  } catch (e) {
    text = `上下文收集失败：${e.message}`;
  }
  return redact(`${text}\n\n---\n我们的实现：\n${IMPLEMENTATION_NOTES}`).slice(0, 40000);
}
