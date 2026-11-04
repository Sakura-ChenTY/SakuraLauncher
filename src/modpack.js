/**
 * .mrpack 整合包安装
 *
 * 格式（Modrinth 规范）：
 *   这是一个 zip，里面有两部分：
 *     modrinth.index.json  —— 清单，列出要下载的文件和依赖
 *     overrides/           —— 需要直接覆盖进实例的文件（配置、资源包等）
 *
 *   index.json 关键字段：
 *     dependencies: { "minecraft": "1.21.11", "fabric-loader": "0.17.2" }
 *     files: [{ path, hashes: {sha1, sha512}, downloads: [url], fileSize }]
 *
 * 为什么先装 loader 再装文件：
 *   整合包的 mod 是给特定 loader 写的，没有 loader 装了也跑不起来。
 *   dependencies 里写了 loader 版本，直接用它，不猜。
 *
 * 实测（2026-10-23）：Fabulously Optimized v15.0.0-beta.2 是 26.3 + fabric，
 *   mrpack 仅 170 KB —— 说明里面只有清单和少量覆盖文件，模组靠下载。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { fetchJson, downloadFile, downloadMany } from './download.js';
import { listEntries, readEntry } from './zip.js';
import { installFabric } from './fabric.js';
import { installForge, installNeoForge } from './forge.js';
import { installVersion } from './installer.js';
import { getSettings } from './settings.js';

function downloadConcurrency() {
  const n = Number(getSettings().concurrency);
  return Math.max(1, Math.min(128, Number.isFinite(n) ? Math.round(n) : 64));
}

/** 从 mrpack zip 里读出清单。
 *  preloaded 是已经读好的 { buf, entries }，用于复用 preview 阶段的整包读取。
 */
export function readMrpackIndex(zipPath, preloaded = null) {
  const buf = preloaded?.buf ?? fs.readFileSync(zipPath);
  const entries = preloaded?.entries ?? listEntries(buf);

  const idxEntry = entries.find((e) => e.name === 'modrinth.index.json');
  if (!idxEntry) {
    throw new Error('不是有效的整合包：缺少 modrinth.index.json');
  }

  const index = JSON.parse(readEntry(buf, idxEntry).toString('utf8'));
  if (!index.files || !Array.isArray(index.files)) {
    throw new Error('整合包清单格式异常：files 字段缺失');
  }

  return { index, entries, buf };
}

/**
 * 按文件头判断图片真实格式。
 *
 * 不能看 URL 后缀：Modrinth 的图标常是 xxx_96.webp，
 * 但有些项目其实返回 png（实测 5FFgwNNP 那条 _96.png 就是真 png）。
 * 反过来要是把 webp 存成 .png，浏览器会直接不渲染 —— 图标就“坏”了。
 */
function sniffImageExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length > 6 && buf.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  return null;
}

/**
 * 把整合包封面图存进实例目录，供启动器列表显示。
 *
 * 以前完全没有这一步：装完只剩 mods/config，图标只能回落成加载器默认图，
 * 于是除「自带 icon.png 的整合包」以外全都长一个样（实测只 Create-Delight-Remake 有图）。
 *
 * 任何失败都只记一行日志，不让下载图标把整个安装搞挂。
 */
export async function savePackIcon(iconUrl, instanceDir, onStage = () => {}, instanceId = null) {
  // 实例里已有图（多见于 overrides 自带 icon.png）就不覆盖，作者原图优先。
  const existing = ['icon.png', 'icon.jpg', 'icon.jpeg', 'icon.webp', 'pack.png', 'logo.png'];
  for (const n of existing) {
    if (fs.existsSync(path.join(instanceDir, n))) return n;
  }

  // 前端没给图标时，按实例名当 slug 去 Modrinth 反查。
  // 本项目装整合包时实例名就用 slug，所以命中率不低；
  // 查不到（CurseForge 的包）就保持 null，不编造。
  if (!iconUrl && instanceId) {
    try {
      const r = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(instanceId)}`, {
        headers: { 'User-Agent': 'mclauncher/0.1 (local)' },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.icon_url) {
          iconUrl = j.icon_url;
          onStage({ stage: 'modpack', message: `按实例名匹配到封面：${j.title ?? instanceId}` });
        }
      }
    } catch {
      // 反查失败不是错误，继续保持占位图
    }
  }

  if (!iconUrl) return null;

  try {
    const res = await fetch(iconUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) throw new Error('图片过小，疑似无效');

    const ext =
      sniffImageExt(buf) ??
      (iconUrl.toLowerCase().endsWith('.webp') ? 'webp' : null) ??
      'png';

    const name = `icon.${ext}`;
    await fsp.writeFile(path.join(instanceDir, name), buf);
    onStage({ stage: 'modpack', message: `已保存整合包图标（${name}, ${Math.round(buf.length / 1024)}KB）` });
    return name;
  } catch (e) {
    onStage({ stage: 'modpack', message: `图标下载失败（不影响安装）：${e.message}` });
    return null;
  }
}

/** 把 overrides/ 里的文件铺进实例目录 */
async function extractOverrides(buf, entries, targetRoot, onProgress) {
  const prefix = 'overrides/';
  const items = entries.filter(
    (e) => e.name.startsWith(prefix) && !e.name.endsWith('/')
  );

  const root = path.resolve(targetRoot);
  let done = 0;
  let written = 0;

  for (const e of items) {
    const rel = e.name.slice(prefix.length);
    if (!rel) continue;

    const target = path.resolve(root, rel);
    // zip slip 防护
    if (target !== root && !target.startsWith(root + path.sep)) {
      done++;
      continue;
    }

    const data = readEntry(buf, e);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    written++;
    done++;

    if (onProgress && done % 50 === 0) {
      onProgress({ done, total: items.length, message: `覆盖文件 ${done}/${items.length}` });
    }
  }

  return { total: items.length, written };
}

/** 安全拼接整合包内的相对路径（防穿越） */
function safeJoin(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/**
 * 安装整合包。
 * opts: { gameDir, mrpackUrl, mrpackSha1, instanceName, onStage, onProgress }
 * 返回 { instanceId, gameVersion, loader, files, overrides }
 */
export async function installModpack(opts = {}) {
  const {
    gameDir,
    mrpackUrl,
    mrpackPath,
    mrpackSha1,
    onStage = () => {},
    onProgress = () => {},
    source,
    iconUrl,
  } = opts;

  if (!gameDir) throw new Error('缺少 gameDir');
  if (!mrpackUrl && !mrpackPath) throw new Error('缺少整合包下载地址或本地文件');

  const cacheDir = path.join(gameDir, 'mclauncher-cache');
  await fsp.mkdir(cacheDir, { recursive: true });

  // 1. 下载 mrpack；本地拖入的包直接用，不复制不删除
  const localZip = Boolean(mrpackPath);
  const zipName = localZip
    ? path.basename(mrpackPath)
    : (mrpackUrl.split('/').pop() ?? 'pack.mrpack').replace(/[^\w.+-]/g, '_');
  const zipPath = localZip ? mrpackPath : path.join(cacheDir, zipName);

  if (localZip) {
    if (!fs.existsSync(zipPath)) throw new Error('整合包文件不存在');
    onStage({ stage: 'modpack', message: `读取本地整合包 ${zipName}` });
  } else {
    onStage({ stage: 'modpack', message: '下载整合包清单' });
    await downloadFile(mrpackUrl, zipPath, { sha1: mrpackSha1 ?? undefined, retries: 3, timeout: 120000 });
  }

  // 2. 解析
  const { index, entries, buf } = readMrpackIndex(zipPath, opts.mrpackArchive ?? null);

  const deps = index.dependencies ?? {};
  const gameVersion = deps.minecraft;
  if (!gameVersion) throw new Error('整合包没有声明 Minecraft 版本');

  // 3. 实例名：优先用调用方给的，否则用包名（去掉非法字符）
  const rawName = opts.instanceName || index.name || path.parse(zipName).name;
  const instanceId = rawName.replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').trim().slice(0, 60) || 'modpack';

  onStage({
    stage: 'modpack',
    message: `整合包：${index.name ?? instanceId}（MC ${gameVersion}）`,
  });

  // 4. 先装 loader —— 有 loader 声明才装
  //    关键：任何 loader 都必须先把原版装好。
  //    Fabric 的 json 用 inheritsFrom 复用原版文件，原版不在就启动不了；
  //    Forge 安装器自己会补 client.jar，但也不写原版 json。
  let loaderInfo = null;
  const loaderKey = Object.keys(deps).find((k) => /fabric|forge|neoforge|quilt/i.test(k));

  if (loaderKey && /fabric/i.test(loaderKey)) {
    // Fabric 的 json 只有 inheritsFrom，原版不在就启动不了
    onStage({ stage: 'modpack', message: `先安装原版 Minecraft ${gameVersion}` });
    await installVersion({ gameDir, versionId: gameVersion, source, onStage, onProgress });

    onStage({ stage: 'modpack', message: `安装 Fabric ${deps[loaderKey]}` });
    loaderInfo = await installFabric({
      gameDir,
      gameVersion,
      skipVanilla: true,
      loaderVersion: deps[loaderKey],
      versionIdOverride: instanceId,
      source,
      onStage,
      onProgress,
    });
  } else if (loaderKey && /neoforge/i.test(loaderKey)) {
    // NeoForge 还没做，但必须抛错而不是假装成功
    await installNeoForge();
  } else if (loaderKey && /forge/i.test(loaderKey)) {
    onStage({ stage: 'modpack', message: `安装 Forge ${deps[loaderKey] ?? '（自动选推荐版）'}` });
    loaderInfo = await installForge({
      gameDir,
      gameVersion,
      loaderVersion: deps[loaderKey] || undefined,
      versionIdOverride: instanceId,
      source,
      onStage,
      onProgress,
    });
  } else if (loaderKey) {
    throw new Error(`不支持的加载器：${loaderKey}`);
  } else {
    // 纯原版整合包（少见但合法）：仍要把原版装好
    onStage({ stage: 'modpack', message: `安装原版 Minecraft ${gameVersion}` });
    await installVersion({ gameDir, versionId: gameVersion, source, onStage, onProgress });
  }

  const instanceDir = path.join(gameDir, 'versions', instanceId);
  await fsp.mkdir(instanceDir, { recursive: true });

  // 5. 下载 files（这些是模组/资源包等实体内容）
  const items = [];
  for (const f of index.files) {
    const rel = String(f.path ?? '');
    if (!rel) continue;

    // env 字段可以标记「客户端不需要」
    if (f.env && f.env.client === 'unsupported') continue;

    const dest = safeJoin(instanceDir, rel);
    if (!dest) continue;

    const url = Array.isArray(f.downloads) ? f.downloads[0] : null;
    if (!url) continue;

    items.push({
      url,
      dest,
      sha1: f.hashes?.sha1 ?? undefined,
      size: f.fileSize ?? undefined,
      name: rel,
    });
  }

  onStage({ stage: 'modpack', message: `下载 ${items.length} 个整合包文件` });

  const r = await downloadMany(items, {
    concurrency: downloadConcurrency(),
    retries: 3,
    onProgress: (p) =>
      onProgress({
        stage: 'modpack',
        done: p.done,
        total: p.total,
        downloaded: p.downloaded,
        errors: p.errors,
        message: `整合包文件 ${p.done}/${p.total}`,
      }),
  });

  if (r.errors.length) {
    const detail = r.errors.slice(0, 3).map((e) => `${e.item.name}: ${e.error}`).join('; ');
    onStage({
      stage: 'modpack',
      message: `有 ${r.errors.length} 个文件失败（${detail}）`,
    });
  }

  // 6. 铺 overrides
  onStage({ stage: 'modpack', message: '展开整合包覆盖文件' });
  const ov = await extractOverrides(buf, entries, instanceDir, onProgress);

  // 7. 封面图：放在 overrides 之后，这样包自带的 icon 优先
  await savePackIcon(iconUrl, instanceDir, onStage, instanceId);

  // 8. 缓存包留着没用（占用空间），删掉；本地拖入的文件不动
  if (!localZip) await fsp.rm(zipPath, { force: true });

  return {
    instanceId,
    packName: index.name ?? instanceId,
    gameVersion,
    loader: loaderKey ?? null,
    loaderInfo,
    files: {
      total: r.total,
      downloaded: r.downloaded,
      skipped: r.skipped,
      failed: r.errors.length,
    },
    overrides: ov,
    instanceDir,
  };
}

/**
 * 只解析不安装 —— 给界面预览用（选包前先看它要什么）。
 * 返回 { name, versionId, gameVersion, loader, fileCount, summary }
 */
export async function previewModpack(mrpackUrl, { sha1 } = {}) {
  const tmpDir = path.join(process.env.TEMP ?? '.', `mrpack-preview-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, 'pack.mrpack');

  try {
    await downloadFile(mrpackUrl, zipPath, { sha1: sha1 ?? undefined, retries: 2, timeout: 60000 });
    const { index } = readMrpackIndex(zipPath);
    const deps = index.dependencies ?? {};
    const loaderKey = Object.keys(deps).find((k) => /fabric|forge|neoforge|quilt/i.test(k));

    return {
      name: index.name,
      versionId: index.versionId,
      summary: index.summary,
      minecraft: deps.minecraft,
      loader: loaderKey ?? null,
      loaderVersion: loaderKey ? deps[loaderKey] : null,
      fileCount: index.files?.length ?? 0,
    };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}
