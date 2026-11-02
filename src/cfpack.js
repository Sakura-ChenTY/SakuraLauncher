/**
 * CurseForge 整合包安装
 *
 * CF 整合包和 Modrinth 的 .mrpack 是两种不同格式：
 *   Modrinth: modrinth.index.json + overrides/（清单里直接给 download URL）
 *   CF:       manifest.json + overrides/（清单里只有 projectID/fileID，要再查 URL）
 *
 * manifest.json 实测结构（RLCraft 2.9.3, 2026-10-24 下载验证）：
 *   {
 *     "name": "RLCraft", "version": "2.9.3", "author": "Shivaxi",
 *     "minecraft": { "version": "1.12.2",
 *                    "modLoaders": [ { "id": "forge-14.23.5.2860", "primary": true } ] },
 *     "manifestType": "minecraftModpack", "manifestVersion": 1,
 *     "files": [ { "projectID": 284754, "fileID": 2725062, "required": true }, ... ]
 *   }
 *   条目总数 3723，其中 overrides/ 占了绝大多数（配置、脚本）。
 *
 * 两个批量接口是关键（实测均 200）：
 *   POST /v1/mods/files  { fileIds: [...] }  -> 每条的 downloadUrl
 *   POST /v1/mods        { modIds: [...] }   -> 每条的 classId（决定落哪个文件夹）
 * 没有它们，187 个文件要发 187×2 次请求。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { downloadMany } from './download.js';
import { listEntries, readEntry } from './zip.js';
import { installVersion } from './installer.js';
import { installFabric } from './fabric.js';
import { installForge, installNeoForge } from './forge.js';
import { savePackIcon } from './modpack.js';
import { CF_MIRROR_BASE, CF_GAME_ID } from './curseforge.js';

const UA = 'mclauncher/0.1 (local)';

/** 批量接口一次最多 50 个 id，超了服务端会拒 */
const BATCH = 50;

/**
 * CF 的 classId -> 实例内目标文件夹。
 * 没列出的（如 4471 整合包自身、5 服务端插件）一律跳过，不往客户端塞。
 */
const CLASS_FOLDER = {
  6: 'mods',
  12: 'resourcepacks',
  13: 'saves',
  6552: 'shaderpacks',
};

async function postJson(p, body, timeout = 30000) {
  const res = await fetch(`${CF_MIRROR_BASE}${p}`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`镜像返回 ${res.status}`);
  return res.json();
}

async function getJson(p, timeout = 30000) {
  const res = await fetch(`${CF_MIRROR_BASE}${p}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`镜像返回 ${res.status}`);
  return res.json();
}

/** 数组切块 */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** 防目录穿越：相对路径必须落在 root 里 */
function safeJoin(root, rel) {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null;
  const dest = path.resolve(root, clean);
  const base = path.resolve(root);
  if (dest !== base && !dest.startsWith(base + path.sep)) return null;
  return dest;
}

/**
 * 解析 manifest 里的加载器声明。
 * "forge-14.23.5.2860"        -> { kind:'forge', version:'14.23.5.2860' }
 * "fabric-0.15.11"            -> { kind:'fabric', version:'0.15.11' }
 * "neoforge-21.1.0"           -> { kind:'neoforge', version:'21.1.0' }
 * "forge-1.12.2-14.23.5.2860" -> forge，版本取最后一段（老包会带 MC 版本前缀）
 */
export function parseLoader(modLoaders = []) {
  const primary = modLoaders.find((m) => m.primary) ?? modLoaders[0];
  const id = String(primary?.id ?? '');
  if (!id) return null;

  const dash = id.indexOf('-');
  if (dash < 0) return null;
  const kind = id.slice(0, dash).toLowerCase();
  let version = id.slice(dash + 1);

  // 老 Forge 写成 1.12.2-14.23.5.2860，去掉前缀的 MC 版本
  if (/^\d+\.\d+(\.\d+)?-/.test(version)) {
    version = version.slice(version.indexOf('-') + 1);
  }
  return { kind, version };
}

/** 从整合包 zip 里读 manifest.json */
function readManifest(buf, entries) {
  const mf = entries.find((e) => e.name === 'manifest.json');
  if (!mf) throw new Error('不是有效的 CurseForge 整合包：缺少 manifest.json');

  const manifest = JSON.parse(readEntry(buf, mf).toString('utf8'));
  if (!Array.isArray(manifest.files)) {
    throw new Error('manifest.json 格式异常：files 字段缺失');
  }
  return manifest;
}

/** 把 overrides/ 铺进实例目录 */
async function extractOverrides(buf, entries, targetRoot, dirName, onProgress) {
  const prefix = dirName.endsWith('/') ? dirName : `${dirName}/`;
  const items = entries.filter((e) => e.name.startsWith(prefix) && !e.name.endsWith('/'));

  let done = 0;
  for (const e of items) {
    const rel = e.name.slice(prefix.length);
    if (!rel) continue;
    const dest = safeJoin(targetRoot, rel);
    if (!dest) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, readEntry(buf, e));
    done++;
    if (done % 200 === 0) {
      onProgress?.({ stage: 'cfpack', message: `展开配置 ${done}/${items.length}` });
    }
  }
  return items.length;
}

/**
 * 只解析不安装：给界面确认「这包要什么、多大、多少个文件」。
 * 不下载整包 —— 只读 manifest 需要整包，所以这里下载后立即删。
 */
export async function previewCurseForgePack({ modId, fileId, onStage = () => {} }) {
  if (!modId) throw new Error('缺少 modId');

  let file;
  if (fileId) {
    file = (await getJson(`/mods/${modId}/files/${fileId}`)).data;
  } else {
    const list = (await getJson(`/mods/${modId}/files?pageSize=50`)).data ?? [];
    file = list.find((f) => f.downloadUrl);
  }
  if (!file) throw new Error('这个整合包没有可下载的文件');
  if (!file.downloadUrl) throw new Error('作者关闭了这个文件的第三方分发，只能去官网手动下载');

  const tmpDir = path.join(process.env.TEMP ?? '.', `cfpack-${Date.now()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, 'pack.zip');

  try {
    onStage({ stage: 'cfpack', message: '下载整合包清单' });
    const res = await fetch(file.downloadUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(600000),
    });
    if (!res.ok) throw new Error(`下载整合包失败：HTTP ${res.status}`);
    await fsp.writeFile(zipPath, Buffer.from(await res.arrayBuffer()));

    const buf = fs.readFileSync(zipPath);
    const entries = listEntries(buf);
    const manifest = readManifest(buf, entries);
    const loader = parseLoader(manifest.minecraft?.modLoaders);

    return {
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      minecraft: manifest.minecraft?.version ?? null,
      loader: loader?.kind ?? null,
      loaderVersion: loader?.version ?? null,
      fileCount: manifest.files.length,
      packSize: file.fileLength ?? 0,
      overridesDir: manifest.overrides ?? 'overrides',
      // 只统计 required，非必需项通常可以不装
      requiredCount: manifest.files.filter((f) => f.required !== false).length,
    };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 安装 CurseForge 整合包。
 *
 * 流程：
 *   1. 查文件 → 下载整合包 zip
 *   2. 读 manifest → 确定 MC 版本 + 加载器
 *   3. 先装原版 + 加载器（顺序不能反，加载器依赖原版）
 *   4. 批量查 downloadUrl + classId → 并发下载模组
 *   5. 铺 overrides
 *   6. 存封面
 */
export async function installCurseForgePack(opts = {}) {
  const {
    gameDir,
    modId,
    fileId,
    instanceName,
    iconUrl,
    source,
    onStage = () => {},
    onProgress = () => {},
  } = opts;

  if (!gameDir) throw new Error('缺少 gameDir');
  if (!modId) throw new Error('缺少 modId');

  const cacheDir = path.join(gameDir, 'mclauncher-cache');
  await fsp.mkdir(cacheDir, { recursive: true });

  // ---- 1. 找到要装的整合包文件 ----
  onStage({ stage: 'cfpack', message: '查询整合包文件' });
  let file;
  if (fileId) {
    file = (await getJson(`/mods/${modId}/files/${fileId}`)).data;
  } else {
    const list = (await getJson(`/mods/${modId}/files?pageSize=50`)).data ?? [];
    file = list.find((f) => f.downloadUrl);
  }
  if (!file) throw new Error('这个整合包没有可下载的文件');
  if (!file.downloadUrl) {
    throw new Error('作者关闭了这个文件的第三方分发（downloadUrl 为空），只能去官网手动下载');
  }

  const zipName = String(file.fileName ?? 'pack.zip').replace(/[^\w.\- ]/g, '_');
  const zipPath = path.join(cacheDir, zipName);

  // ---- 2. 下载整合包 ----
  onStage({ stage: 'cfpack', message: `下载整合包（${(file.fileLength / 1024 / 1024).toFixed(1)}MB）` });
  {
    const res = await fetch(file.downloadUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(900000),
    });
    if (!res.ok) throw new Error(`下载整合包失败：HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const chunks = [];
    let got = 0;
    for await (const c of res.body) {
      chunks.push(c);
      got += c.length;
      if (total) {
        onProgress({
          stage: 'cfpack',
          done: got,
          total,
          message: `整合包 ${(got / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)}MB`,
        });
      }
    }
    await fsp.writeFile(zipPath, Buffer.concat(chunks));
  }

  // ---- 3. 解析 manifest ----
  const buf = fs.readFileSync(zipPath);
  const entries = listEntries(buf);
  const manifest = readManifest(buf, entries);

  const gameVersion = manifest.minecraft?.version;
  if (!gameVersion) throw new Error('整合包没有声明 Minecraft 版本');

  const loader = parseLoader(manifest.minecraft?.modLoaders);
  const rawName = instanceName || manifest.name || path.parse(zipName).name;
  const instanceId = rawName.replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').trim().slice(0, 60) || 'cfpack';

  onStage({
    stage: 'cfpack',
    message: `整合包：${manifest.name ?? instanceId}（MC ${gameVersion}${loader ? ' / ' + loader.kind + ' ' + loader.version : ''}）`,
  });

  // ---- 4. 先装原版 + 加载器 ----
  if (loader?.kind === 'fabric') {
    onStage({ stage: 'cfpack', message: `先安装原版 Minecraft ${gameVersion}` });
    await installVersion({ gameDir, versionId: gameVersion, source, onStage, onProgress });

    onStage({ stage: 'cfpack', message: `安装 Fabric ${loader.version}` });
    await installFabric({
      gameDir,
      gameVersion,
      loaderVersion: loader.version,
      versionIdOverride: instanceId,
      source,
      onStage,
      onProgress,
    });
  } else if (loader?.kind === 'neoforge') {
    onStage({ stage: 'cfpack', message: `安装 NeoForge ${loader.version}` });
    await installNeoForge({
      gameDir,
      gameVersion,
      loaderVersion: loader.version,
      versionIdOverride: instanceId,
      source,
      onStage,
      onProgress,
    });
  } else if (loader?.kind === 'forge') {
    onStage({ stage: 'cfpack', message: `安装 Forge ${loader.version}` });
    await installForge({
      gameDir,
      gameVersion,
      loaderVersion: loader.version,
      versionIdOverride: instanceId,
      source,
      onStage,
      onProgress,
    });
  } else {
    onStage({ stage: 'cfpack', message: `安装原版 Minecraft ${gameVersion}` });
    await installVersion({ gameDir, versionId: gameVersion, source, onStage, onProgress });
  }

  const instanceDir = path.join(gameDir, 'versions', instanceId);
  await fsp.mkdir(instanceDir, { recursive: true });

  // ---- 5. 解析每个文件的下载地址与落点 ----
  const wanted = manifest.files.filter((f) => f.required !== false);
  onStage({ stage: 'cfpack', message: `查询 ${wanted.length} 个文件的下载地址` });

  const fileMeta = [];
  for (const part of chunk([...new Set(wanted.map((f) => f.fileID))], BATCH)) {
    const r = await postJson('/mods/files', { fileIds: part });
    for (const f of r?.data ?? []) fileMeta.push(f);
  }
  const byFileId = new Map(fileMeta.map((f) => [f.id, f]));

  // classId 决定放 mods/ 还是 resourcepacks/
  const modIds = [...new Set(wanted.map((f) => f.projectID))];
  const classOf = new Map();
  for (const part of chunk(modIds, BATCH)) {
    const r = await postJson('/mods', { modIds: part });
    for (const m of r?.data ?? []) classOf.set(m.id, m.classId);
  }

  const items = [];
  const skipped = [];
  for (const f of wanted) {
    const meta = byFileId.get(f.fileID);
    if (!meta) {
      skipped.push({ id: f.fileID, reason: '镜像查不到这个文件' });
      continue;
    }
    if (!meta.downloadUrl) {
      skipped.push({ id: f.fileID, name: meta.fileName, reason: '作者关闭了第三方分发' });
      continue;
    }

    const folder = CLASS_FOLDER[classOf.get(f.projectID)];
    if (!folder) {
      skipped.push({ id: f.fileID, name: meta.fileName, reason: `类型 ${classOf.get(f.projectID) ?? '?'} 不属于客户端文件` });
      continue;
    }

    const dest = safeJoin(instanceDir, path.join(folder, meta.fileName));
    if (!dest) {
      skipped.push({ id: f.fileID, name: meta.fileName, reason: '文件名不安全，已跳过' });
      continue;
    }

    // CF 的 hashes: algo 1=sha1, 2=md5
    const sha1 = (meta.hashes ?? []).find((h) => h.algo === 1)?.value ?? undefined;

    items.push({
      url: meta.downloadUrl,
      dest,
      sha1,
      size: meta.fileLength ?? undefined,
      name: meta.fileName,
    });
  }

  onStage({
    stage: 'cfpack',
    message: `下载 ${items.length} 个文件${skipped.length ? `（${skipped.length} 个跳过）` : ''}`,
  });

  const r = await downloadMany(items, {
    concurrency: 12,
    retries: 3,
    source,
    onProgress: (p) =>
      onProgress({
        stage: 'cfpack',
        done: p.done,
        total: p.total,
        downloaded: p.downloaded,
        errors: p.errors,
        message: `整合包文件 ${p.done}/${p.total}`,
      }),
  });

  // ---- 6. 铺 overrides ----
  onStage({ stage: 'cfpack', message: '展开整合包覆盖文件' });
  const ovCount = await extractOverrides(
    buf,
    entries,
    instanceDir,
    manifest.overrides ?? 'overrides',
    onProgress
  );

  // ---- 7. 封面 ----
  await savePackIcon(iconUrl, instanceDir, onStage, instanceId);

  // ---- 8. 清理 ----
  await fsp.rm(zipPath, { force: true });

  return {
    source: 'curseforge',
    instanceId,
    packName: manifest.name ?? instanceId,
    gameVersion,
    loader: loader?.kind ?? null,
    loaderVersion: loader?.version ?? null,
    files: {
      total: r.total,
      downloaded: r.downloaded,
      skipped: r.skipped,
      failed: r.errors.length,
      notDistributable: skipped.length,
    },
    skipped: skipped.slice(0, 20),
    overrides: ovCount,
    instanceDir,
  };
}
