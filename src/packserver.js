/**
 * Modrinth 整合包服务端安装。
 *
 * 不把 .mrpack 当客户端包用：
 *   - dependencies 决定原版 + loader
 *   - files 按 env.server 过滤（unsupported 跳过，optional 装入并记日志）
 *   - overrides/ 先铺，server-overrides/ 后铺，client-overrides/ 不碰
 *
 * 服务端运行数据（world、server.properties、eula.txt 等）由 gameserver 管理，
 * 这里只准备启动文件和模组/配置。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { fetchJson, downloadFile, downloadMany } from './download.js';
import { listEntries, readEntry } from './zip.js';
import { findJava } from './launch.js';
import { getSettings } from './settings.js';
import { JAVA_SCAN_CACHE } from './paths.js';

const FABRIC_INSTALLER_URL = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar';
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

function requiredJavaForMc(gameVersion) {
  const p = String(gameVersion || '').split('.').map((x) => Number(x) || 0);
  if (p[0] >= 26) return 25;
  if (p[0] === 1 && (p[1] > 20 || (p[1] === 20 && p[2] >= 5))) return 21;
  if (p[0] === 1 && p[1] >= 18) return 17;
  if (p[0] === 1 && p[1] === 17) return 16;
  return 8;
}
const MANAGED_PATHS = [
  'world',
  'world_nether',
  'world_the_end',
  'server.properties',
  'eula.txt',
  'ops.json',
  'whitelist.json',
  'banned-ips.json',
  'banned-players.json',
  'logs',
  'crash-reports',
  'saves',
  'options.txt',
  'servers.dat',
  'screenshots',
  'resourcepacks',
  'shaderpacks',
];

function safeJoin(root, rel) {
  const base = path.resolve(root);
  const dest = path.resolve(base, String(rel || '').replace(/\\/g, '/'));
  if (dest !== base && !dest.startsWith(base + path.sep)) return null;
  return dest;
}

function isManagedPath(rel) {
  const first = String(rel || '').replace(/\\/g, '/').split('/')[0].toLowerCase();
  return MANAGED_PATHS.includes(first);
}

function stageText(onStage, message) {
  try { onStage?.(message); } catch { /* ignore */ }
}

function runProcess(exe, args, { cwd, onLine, timeout = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`安装进程超时（${Math.round(timeout / 1000)}s）`));
    }, timeout);
    const feed = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        out += `${line}\n`;
        if (out.length > 200_000) out = out.slice(-120_000);
        onLine?.(line);
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', (buf) => {
      const text = buf.toString('utf8');
      err += text;
      if (err.length > 80_000) err = err.slice(-50_000);
      feed(buf);
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`安装进程退出码 ${code}\n${(err || out).split(/\r?\n/).filter(Boolean).slice(-8).join('\n')}`));
    });
  });
}

async function readPack({ pack, serverDir, onStage }) {
  let zipPath = String(pack?.mrpackPath || '').trim();
  let local = Boolean(zipPath);
  if (!zipPath) {
    const url = String(pack?.mrpackUrl || '').trim();
    if (!url) throw new Error('Modrinth 整合包缺少 mrpackPath 或 mrpackUrl');
    await fsp.mkdir(serverDir, { recursive: true });
    zipPath = path.join(serverDir, '.mrpack-source.mrpack');
    stageText(onStage, '下载 Modrinth 整合包清单');
    await downloadFile(url, zipPath, {
      sha1: pack?.sha1 || undefined,
      retries: 3,
      timeout: 180000,
      source: getSettings().downloadSource === 'bmclapi' ? 'bmclapi' : 'official',
    });
    local = false;
  }
  if (!fs.existsSync(zipPath)) throw new Error(`找不到整合包文件：${zipPath}`);
  const buf = fs.readFileSync(zipPath);
  const entries = listEntries(buf);
  const idxEntry = entries.find((e) => e.name === 'modrinth.index.json');
  if (!idxEntry) throw new Error('不是有效的 Modrinth 整合包：缺少 modrinth.index.json');
  const index = JSON.parse(readEntry(buf, idxEntry).toString('utf8'));
  if (!Array.isArray(index.files)) throw new Error('Modrinth 清单格式异常：files 不是数组');
  return { zipPath, local, buf, entries, index };
}

async function installFabricServer({ serverDir, gameVersion, loaderVersion, onStage }) {
  const launcher = path.join(serverDir, 'fabric-server-launch.jar');
  const vanillaJar = path.join(serverDir, 'server.jar');
  const metaFile = path.join(serverDir, 'server-pack.json');
  if (fs.existsSync(metaFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (old.gameVersion && String(old.gameVersion) !== String(gameVersion)) {
        throw new Error(`服务端目录已经是 Minecraft ${old.gameVersion}，和当前整合包 ${gameVersion} 不一致，请换一个实例目录`);
      }
      if (old.loaderVersion && loaderVersion && String(old.loaderVersion) !== String(loaderVersion)) {
        throw new Error(`服务端目录已经是 Fabric ${old.loaderVersion}，和当前整合包 ${loaderVersion} 不一致，请换一个实例目录`);
      }
    } catch (e) {
      if (e.message?.includes('服务端目录已经是')) throw e;
      /* 旧元数据损坏时继续按现有文件判断 */
    }
  }
  if (fs.existsSync(launcher) && fs.existsSync(vanillaJar)) {
    stageText(onStage, '复用已安装的 Fabric 服务端');
    return launcher;
  }

  const java = await findJava(getSettings().javaPath, 21, JAVA_SCAN_CACHE);
  if (!java?.path) throw new Error('找不到可用的 Java 21+，无法安装 Fabric 服务端');
  const cacheDir = path.join(serverDir, '.cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  const installer = path.join(cacheDir, 'fabric-installer.jar');
  if (!fs.existsSync(installer)) {
    stageText(onStage, '下载 Fabric 服务端安装器');
    await downloadFile(FABRIC_INSTALLER_URL, installer, { retries: 3, timeout: 120000 });
  }

  stageText(onStage, `安装 Fabric ${loaderVersion} 服务端（Minecraft ${gameVersion}）`);
  await runProcess(java.path, [
    '-jar', installer, 'server',
    '-mcversion', gameVersion,
    '-loader', loaderVersion,
    '-downloadMinecraft',
  ], {
    cwd: serverDir,
    onLine: (line) => stageText(onStage, line),
  });
  if (!fs.existsSync(path.join(serverDir, 'fabric-server-launch.jar'))) {
    throw new Error('Fabric 安装器结束，但没有生成 fabric-server-launch.jar');
  }
  if (!fs.existsSync(path.join(serverDir, 'server.jar'))) {
    throw new Error('Fabric 安装器结束，但没有生成 server.jar');
  }
  return path.join(serverDir, 'fabric-server-launch.jar');
}

async function installVanillaServer({ serverDir, gameVersion, onStage }) {
  const jar = path.join(serverDir, 'server.jar');
  if (fs.existsSync(jar)) return jar;
  stageText(onStage, `查询 Minecraft ${gameVersion} 服务端`);
  const manifest = await fetchJson(MOJANG_MANIFEST, { timeout: 30000 });
  const entry = (manifest.versions ?? []).find((v) => v.id === gameVersion);
  if (!entry?.url) throw new Error(`Mojang 清单里没有 ${gameVersion}`);
  const version = await fetchJson(entry.url, { timeout: 30000 });
  const server = version.downloads?.server;
  if (!server?.url) throw new Error(`${gameVersion} 没有官方 server.jar`);
  stageText(onStage, `下载官方 server.jar（${Math.round((server.size ?? 0) / 1024 / 1024)}MB）`);
  await downloadFile(server.url, jar, {
    sha1: server.sha1,
    size: server.size,
    retries: 3,
    timeout: 180000,
    source: getSettings().downloadSource === 'bmclapi' ? 'bmclapi' : 'official',
  });
  return jar;
}

async function applyPackFiles({ index, serverDir, onStage }) {
  const items = [];
  let skipped = 0;
  let optional = 0;
  for (const f of index.files) {
    const rel = String(f.path || '').replace(/\\/g, '/');
    if (!rel || isManagedPath(rel)) continue;
    const side = f.env?.server;
    if (side === 'unsupported') {
      skipped += 1;
      continue;
    }
    if (side === 'optional') optional += 1;
    const url = Array.isArray(f.downloads) ? f.downloads[0] : '';
    if (!url) {
      skipped += 1;
      continue;
    }
    const dest = safeJoin(serverDir, rel);
    if (!dest) {
      skipped += 1;
      continue;
    }
    items.push({
      url,
      dest,
      sha1: f.hashes?.sha1 || undefined,
      size: f.fileSize || undefined,
      name: rel,
    });
  }

  stageText(onStage, `服务端文件：${items.length} 个（跳过 ${skipped}，optional ${optional}）`);
  if (optional) stageText(onStage, `optional 服务端文件 ${optional} 个，已按服务端兼容项装入`);
  if (!items.length) return { downloaded: 0, skipped, optional };

  const r = await downloadMany(items, {
    concurrency: 8,
    retries: 3,
    source: getSettings().downloadSource === 'bmclapi' ? 'bmclapi' : 'official',
    onProgress: (p) => {
      if (p.done === p.total) stageText(onStage, `服务端文件下载完成 ${p.downloaded}/${p.total}`);
    },
  });
  if (r.errors?.length) {
    const detail = r.errors.slice(0, 3).map((e) => `${e.item.name}: ${e.error}`).join('; ');
    throw new Error(`服务端文件下载失败 ${r.errors.length} 个（${detail}）`);
  }
  return { downloaded: r.downloaded, skipped, optional, total: items.length };
}

async function applyOverrides({ buf, entries, serverDir, onStage }) {
  const dirs = ['overrides/', 'server-overrides/'];
  let written = 0;
  for (const dirName of dirs) {
    const prefix = dirName;
    const items = entries.filter((e) => e.name.startsWith(prefix) && !e.name.endsWith('/'));
    for (const e of items) {
      const rel = e.name.slice(prefix.length);
      if (!rel || isManagedPath(rel)) continue;
      const dest = safeJoin(serverDir, rel);
      if (!dest) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, readEntry(buf, e));
      written += 1;
    }
    stageText(onStage, `铺 ${dirName}：${items.length} 个文件`);
  }
  return written;
}

/**
 * 准备一个 Modrinth 服务端目录。
 * 返回 { serverDir, jarPath, args, javaBin, javaMajor, gameVersion, loader, loaderVersion, pack }
 */
export async function prepareModrinthServer({ serverDir, pack, onStage }) {
  if (!serverDir) throw new Error('缺少 serverDir');
  await fsp.mkdir(serverDir, { recursive: true });
  const metaFile = path.join(serverDir, 'server-pack.json');
  if (!fs.existsSync(metaFile) && (fs.existsSync(path.join(serverDir, 'server.jar')) || fs.existsSync(path.join(serverDir, 'world')))) {
    throw new Error('这个服务端目录已经被原版房间使用，整合包必须换一个独立实例');
  }
  const { zipPath, local, buf, entries, index } = await readPack({ pack, serverDir, onStage });
  const deps = index.dependencies || {};
  const gameVersion = String(deps.minecraft || pack?.gameVersion || '').trim();
  if (!gameVersion) throw new Error('整合包没有声明 minecraft 版本');

  const loaderKey = Object.keys(deps).find((k) => /fabric|forge|neoforge|quilt/i.test(k));
  const loaderVersion = loaderKey ? String(deps[loaderKey]) : '';
  let jarPath = '';
  let loader = 'vanilla';
  let args = [];

  const requiredJava = requiredJavaForMc(gameVersion);
  const java = await findJava(getSettings().javaPath, requiredJava, JAVA_SCAN_CACHE);
  if (!java?.path) throw new Error(`找不到可用的 Java ${requiredJava}+`);

  if (/fabric/i.test(loaderKey || '')) {
    loader = 'fabric';
    jarPath = await installFabricServer({ serverDir, gameVersion, loaderVersion, onStage });
    args = ['-jar', jarPath, 'nogui'];
  } else if (!loaderKey) {
    loader = 'vanilla';
    jarPath = await installVanillaServer({ serverDir, gameVersion, onStage });
    args = ['-jar', jarPath, 'nogui'];
  } else {
    throw new Error(`暂不支持 ${loaderKey} 的整合包服务端安装（当前先支持 Fabric/vanilla）`);
  }

  const fileStats = await applyPackFiles({ index, serverDir, onStage });
  const overrideCount = await applyOverrides({ buf, entries, serverDir, onStage });
  const info = {
    kind: 'modrinth',
    name: String(index.name || pack?.name || 'Modrinth Pack'),
    versionId: String(index.versionId || pack?.versionId || ''),
    gameVersion,
    loader,
    loaderVersion,
    files: fileStats,
    overrides: overrideCount,
    serverDir,
    installedAt: Date.now(),
  };
  await fsp.writeFile(path.join(serverDir, 'server-pack.json'), JSON.stringify(info, null, 2), 'utf8');
  if (!local) await fsp.rm(zipPath, { force: true }).catch(() => {});
  stageText(onStage, `整合包服务端准备完成：${info.name}（${loader}${loaderVersion ? ' ' + loaderVersion : ''}）`);
  return {
    serverDir,
    jarPath,
    args,
    javaBin: java.path,
    javaMajor: java.major ?? null,
    gameVersion,
    loader,
    loaderVersion,
    pack: info,
  };
}
