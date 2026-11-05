/**
 * Fabric Loader 安装
 *
 * 为什么需要这个：Modrinth 上绝大多数 mod 都是 Fabric 版的，
 * 没有 loader 光把 jar 丢进 mods/ 是加载不了的。
 *
 * 关键技术点（实测 2026-10-23）：
 *   meta.fabricmc.net/v2/versions/loader/<游戏版本>   200 列出 255 个 loader
 *   meta.fabricmc.net/v2/versions/loader/<ver>/<loader>/profile/json   200
 *     返回的 libraries 只有 maven 坐标（name + url），**没有 downloads.artifact**，
 *     所以必须自己按 group/artifact/version 拼路径去 maven 取。
 *   拼接后 https://maven.fabricmc.net/org/ow2/asm/asm/9.8/asm-9.8.jar 实测 206 可取。
 *
 * 装法：把 profile/json 存成 versions/<id>/<id>.json，它自带
 *   inheritsFrom: <原版版本>
 * 我们的 loadVersion 已经支持继承合并，所以不需要复制原版文件。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { fetchJson, downloadMany } from './download.js';
import { installVersion } from './installer.js';

const META = 'https://meta.fabricmc.net/v2';

/** maven 坐标 name 形如 org.ow2.asm:asm:9.8 或 net.fabricmc:sponge-mixin:0.16.3+mixin.0.8.7 */
function mavenToRelPath(name) {
  const parts = String(name).split(':');
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return null;
  const dir = group.replace(/\./g, '/');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${dir}/${artifact}/${version}/${file}`;
}

/** 列出某游戏版本可用的 loader（新的在前） */
export async function listLoaders(gameVersion, { stableOnly = false } = {}) {
  const list = await fetchJson(`${META}/versions/loader/${encodeURIComponent(gameVersion)}`, {
    timeout: 25000,
  });
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => ({
      version: x.loader?.version,
      stable: Boolean(x.loader?.stable),
      build: x.loader?.build,
    }))
    .filter((x) => x.version && (!stableOnly || x.stable));
}

/**
 * 安装 Fabric loader。
 * opts: { gameDir, gameVersion, loaderVersion, onStage, onProgress }
 * loaderVersion 省略时自动取最新稳定版。
 * 返回 { versionId, loaderVersion, jsonPath }
 */
export async function installFabric(opts = {}) {
  const {
    gameDir,
    gameVersion,
    skipVanilla = false,
    onStage = () => {},
    onProgress = () => {},
    source,
  } = opts;

  if (!gameDir) throw new Error('缺少 gameDir');
  if (!gameVersion) throw new Error('缺少 gameVersion');

  // 1. 选 loader 版本
  let loaderVersion = opts.loaderVersion;
  if (!loaderVersion) {
    onStage({ stage: 'fabric', message: `查询 Fabric loader（${gameVersion}）` });
    const loaders = await listLoaders(gameVersion, { stableOnly: true });
    if (!loaders.length) {
      throw new Error(`Fabric 没有支持 ${gameVersion} 的稳定 loader`);
    }
    loaderVersion = loaders[0].version;
  }

  onStage({ stage: 'fabric', message: `使用 Fabric loader ${loaderVersion}` });

  // 根因：Fabric profile 只有 inheritsFrom，没有原版目录就永远起不来。
  // 四个加载器入口统一先补原版（version json / client.jar / libraries / assets），
  // 再写 loader profile；不能只写一个孤立 profile 就算装完。
  if (!skipVanilla) {
    onStage({ stage: 'fabric', message: `先安装原版 Minecraft ${gameVersion}` });
    await installVersion({
      gameDir,
      versionId: gameVersion,
      source,
      onStage,
      onProgress,
    });
  }

  // 2. 取 profile JSON
  const profileUrl =
    `${META}/versions/loader/${encodeURIComponent(gameVersion)}/` +
    `${encodeURIComponent(loaderVersion)}/profile/json`;
  const profile = await fetchJson(profileUrl, { timeout: 25000 });

  // 实例 ID 只保留一套：目录名、JSON 文件名、profile.id 全都用它。
  // 不要一边写 fabric-loader-...，一边让列表显示另一个名字。
  const versionId = String(
    opts.versionIdOverride || profile.id || `fabric-loader-${loaderVersion}-${gameVersion}`
  ).trim();
  if (!versionId || versionId === '.' || versionId === '..' || /[\\/]/.test(versionId)) {
    throw new Error('实例名不合法');
  }
  profile.id = versionId;

  // 3. 补下载地址（profile 里只有 maven 坐标）
  const librariesDir = path.join(gameDir, 'libraries');
  const items = [];
  const unresolved = [];

  for (const lib of profile.libraries ?? []) {
    const rel = mavenToRelPath(lib.name);
    if (!rel) {
      unresolved.push(lib.name);
      continue;
    }
    const base = lib.url ? (lib.url.endsWith('/') ? lib.url : lib.url + '/') : 'https://maven.fabricmc.net/';
    // 优先官方 maven，失败由 download.js 自行重试
    items.push({
      url: base + rel,
      dest: path.join(librariesDir, rel.replace(/\//g, path.sep)),
    });
  }

  onStage({ stage: 'fabric', message: `下载 ${items.length} 个 loader 依赖` });

  const r = await downloadMany(items, {
    concurrency: 8,
    retries: 3,
    source,
    onProgress: (p) => {
      onProgress({
        stage: 'fabric',
        done: p.done,
        total: p.total,
        downloaded: p.downloaded,
        errors: p.errors,
        message: `Fabric 依赖 ${p.done}/${p.total}`,
      });
    },
  });

  if (r.errors.length) {
    const detail = r.errors.slice(0, 3).map((e) => `${path.basename(e.item.dest)}: ${e.error}`).join('; ');
    throw new Error(`Fabric 依赖下载失败 ${r.errors.length} 个（${detail}）`);
  }

  // 4. 写入版本 JSON（带 inheritsFrom，靠继承复用原版文件）
  const versionDir = path.join(gameDir, 'versions', versionId);
  const jsonPath = path.join(versionDir, `${versionId}.json`);
  if (fs.existsSync(jsonPath)) {
    throw new Error(`实例 ${versionId} 已存在，先删除或换个实例名`);
  }
  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.writeFile(jsonPath, JSON.stringify(profile, null, 2), 'utf8');

  onStage({ stage: 'fabric', message: `Fabric ${loaderVersion} 安装完成：${versionId}` });

  return {
    versionId,
    loaderVersion,
    jsonPath,
    libraryCount: items.length,
    unresolved,
  };
}
