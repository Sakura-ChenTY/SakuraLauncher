/**
 * 安装器：按官方清单把一个版本完整装到本地
 *
 * 顺序（每条都依赖上一条的结果）：
 *   1. 版本清单 version_manifest_v2 -> 找到目标版本的 metadata URL
 *   2. 拉版本 JSON -> 落盘 versions/<id>/<id>.json
 *   3. client.jar -> versions/<id>/<id>.jar
 *   4. libraries -> libraries/<path>
 *   5. logging 配置（log4j xml）-> assets/log_configs/
 *   6. assetIndex -> assets/indexes/<id>.json -> objects/*
 *
 * 关键认知：assets 有几千个小文件，是耗时主体；
 * libraries 有几十到上百个；client.jar 是单个大文件。
 * 因此分阶段下载并分别报告进度，比一把梭更好用。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { fetchJson, downloadFile, downloadMany, mkdirTracked, trackFile } from './download.js';
import { VERSION_MANIFEST_URL, RESOURCES_BASE, candidateUrls } from './sources.js';
import { allows, detectOs } from './rules.js';
import { mavenPath, isNativeLibrary, nativeClassifierKey, nativeLibraryRel } from './classpath.js';
import { extractNatives } from './zip.js';
import { ensureJava } from './javadl.js';
import { getSettings } from './settings.js';
import { JAVA_SCAN_CACHE, HOME_DIR, defaultGameDir } from './paths.js';

/** 可复用的其他 .minecraft 根目录（默认官启目录 + 最近记录 + 当前设置）。 */
function getReuseRoots(gameDir) {
  const current = path.resolve(gameDir);
  const roots = [];
  const seen = new Set([current.toLowerCase()]);
  const add = (value) => {
    if (!value || typeof value !== 'string') return;
    const abs = path.resolve(value);
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(abs);
  };
  add(defaultGameDir());
  try {
    add(getSettings().gameDir);
  } catch {
    /* 设置读取失败时只保留默认目录 */
  }
  try {
    const recent = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'recent-play.json'), 'utf8'));
    add(recent?.last?.gameDir);
  } catch {
    /* 没有最近记录就算了 */
  }
  return roots;
}

/** 拉取版本清单并缓存到本地 */
export async function getVersionManifest(manifestCachePath) {
  if (manifestCachePath && fs.existsSync(manifestCachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(manifestCachePath, 'utf8'));
      // 缓存 1 小时内有效，避免每次启动都打网络
      if (Date.now() - (cached.__fetchedAt ?? 0) < 3600_000 && cached.versions) {
        return cached;
      }
    } catch {
      /* 缓存坏了就重拉 */
    }
  }

  const data = await fetchJson(VERSION_MANIFEST_URL, { timeout: 30000 });
  data.__fetchedAt = Date.now();

  if (manifestCachePath) {
    await fsp.mkdir(path.dirname(manifestCachePath), { recursive: true });
    await fsp.writeFile(manifestCachePath, JSON.stringify(data), 'utf8');
  }
  return data;
}

/** 在清单里找某个版本 */
export function findVersionInManifest(manifest, versionId) {
  return (manifest.versions ?? []).find((v) => v.id === versionId) ?? null;
}

/** 列出清单里最新若干正式版 */
export function latestReleases(manifest, limit = 10) {
  return (manifest.versions ?? []).filter((v) => v.type === 'release').slice(0, limit);
}

/**
 * 安装（或补全）一个版本。
 * opts: { gameDir, versionId, concurrency, source, onStage, onProgress }
 *   source: 'official' | 'bmclapi' —— 由调用方先用 resolveSource() 决定好
 *   （也接受旧的 preferMirror 布尔值，等价于 bmclapi）
 * 返回各阶段统计
 */
export async function installVersion(opts) {
  const {
    gameDir,
    versionId,
    concurrency = 8,
    preferMirror = false,
    source,
    onStage = () => {},
    onProgress = () => {},
  } = opts;

  // 统一成一个变量往下传，避免每个下载点都写两套参数
  const dlSource = source ?? (preferMirror ? 'bmclapi' : 'official');

  const root = path.resolve(gameDir);
  const reuseRoots = getReuseRoots(root);
  const versionsDir = path.join(root, 'versions');
  const libsDir = path.join(root, 'libraries');
  const assetsDir = path.join(root, 'assets');
  const versionDir = path.join(versionsDir, versionId);

  const report = { versionId, stages: {} };

  // ---- 1. 清单 ----
  onStage({ stage: 'manifest', message: '获取版本清单' });
  const manifest = await getVersionManifest(path.join(root, 'version_manifest_v2.json'));

  // 已经装过就只读本地 json；否则从清单拉
  let versionJson = null;
  const localJson = path.join(versionDir, `${versionId}.json`);
  if (fs.existsSync(localJson)) {
    versionJson = JSON.parse(fs.readFileSync(localJson, 'utf8'));
  } else {
    const entry = findVersionInManifest(manifest, versionId);
    if (!entry) throw new Error(`版本清单里没有 ${versionId}`);
    onStage({ stage: 'json', message: `拉取 ${versionId} 的版本 JSON` });
    versionJson = await fetchJson(entry.url, { timeout: 30000 });
    // 用可跟踪的 mkdir + trackFile：取消时要能把这两样一起回滚掉，
    // 否则会留下「只有 json 没有 jar」的空实例目录。
    await mkdirTracked(versionDir);
    await fsp.writeFile(localJson, JSON.stringify(versionJson), 'utf8');
    trackFile(localJson);
  }

  // ---- 2. 父版本（如果有继承）----
  if (versionJson.inheritsFrom) {
    onStage({ stage: 'parent', message: `先装父版本 ${versionJson.inheritsFrom}` });
    await installVersion({
      ...opts,
      versionId: versionJson.inheritsFrom,
      onStage,
      onProgress,
    });
  }

  // ---- 3. client.jar ----
  const jarPath = path.join(versionDir, `${versionId}.jar`);
  const clientDl = versionJson.downloads?.client;
  if (clientDl) {
    onStage({ stage: 'client', message: '下载 client.jar' });
    try {
      const r = await downloadFile(clientDl.url, jarPath, {
        sha1: clientDl.sha1,
        size: clientDl.size,
        retries: 3,
        source: dlSource,
        gameDir: root,
        reuseRoots,
      });
      report.stages.client = r;
    } catch (e) {
      report.stages.client = 'error: ' + e.message;
      throw e;
    }
  }

  // ---- 4. libraries ----
  const ctx = { os: detectOs(), features: {} };
  const libItems = [];
  const nativeJars = [];
  const seenDests = new Set();

  for (const lib of versionJson.libraries ?? []) {
    if (!lib || !allows(lib.rules, ctx)) continue;

    const artifact = lib.downloads?.artifact;
    const artifactRel = artifact?.path ?? (lib.name ? mavenPath(lib.name) : null);
    const nativeKey = nativeClassifierKey(lib, ctx);
    const nativeRel = nativeLibraryRel(lib, ctx);
    const classifier = nativeKey ? lib.downloads?.classifiers?.[nativeKey] : null;

    const base = lib.url
      ? (lib.url.endsWith('/') ? lib.url : lib.url + '/')
      : null;

    const addItem = (rel, meta) => {
      if (!rel) return null;
      let url = meta?.url;
      if (!url && base) url = base + rel;
      if (!url) return null;

      const dest = path.join(libsDir, rel);
      if (seenDests.has(dest)) return dest;
      seenDests.add(dest);
      libItems.push({
        url,
        dest,
        sha1: meta?.sha1 ?? lib.sha1,
        size: meta?.size,
        name: rel,
      });
      return dest;
    };

    // 基础 jar：有 artifact 才下 artifact；纯 classifier 的旧 natives 库
    // （artifact: false）不能按无 classifier 的路径伪造下载。
    const hasArtifact = Boolean(artifact?.url || (artifact && base));
    let artifactDest = null;
    if (artifactRel && (hasArtifact || !isNativeLibrary(lib))) {
      artifactDest = addItem(artifactRel, artifact);
    }

    // natives：必须按 downloads.classifiers[key] 下载，1.12 的
    // lwjgl-platform / jinput-platform 真实文件都带 -natives-windows。
    if (nativeKey && nativeRel) {
      const nativeDest = addItem(nativeRel, classifier);
      if (nativeDest) nativeJars.push(nativeDest);
    } else if (!nativeKey && isNativeLibrary(lib) && artifactDest) {
      // 兼容少数把 natives 挂在 artifact 上的旧 JSON
      nativeJars.push(artifactDest);
    }
  }

  if (libItems.length) {
    onStage({ stage: 'libraries', message: `下载 ${libItems.length} 个库` });
    const r = await downloadMany(libItems, {
      concurrency,
      retries: 3,
      source: dlSource,
      gameDir: root,
      reuseRoots,
      onProgress: (p) => onProgress({ stage: 'libraries', ...p }),
    });
    report.stages.libraries = {
      total: r.total,
      skipped: r.skipped,
      downloaded: r.downloaded,
      failed: r.errors.length,
    };
    if (r.errors.length) {
      report.stages.libraryErrors = r.errors.map((e) => e.error).slice(0, 10);
    }
  }

  // ---- 5. logging 配置 ----
  const logCfg = versionJson.logging?.client?.file;
  if (logCfg?.url) {
    const dest = path.join(assetsDir, 'log_configs', logCfg.id);
    onStage({ stage: 'logconfig', message: '下载日志配置' });
    try {
      report.stages.logconfig = await downloadFile(logCfg.url, dest, {
        sha1: logCfg.sha1,
        size: logCfg.size,
        retries: 2,
        source: dlSource,
        gameDir: root,
        reuseRoots,
      });
    } catch (e) {
      report.stages.logconfig = 'error: ' + e.message;
    }
  }

  // ---- 6. assets ----
  const assetIdx = versionJson.assetIndex;
  if (assetIdx?.url) {
    onStage({ stage: 'assetsIndex', message: `获取资源索引 ${assetIdx.id}` });
    const idxPath = path.join(assetsDir, 'indexes', `${assetIdx.id}.json`);
    await mkdirTracked(path.dirname(idxPath));

    let indexJson;
    if (fs.existsSync(idxPath)) {
      indexJson = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    } else {
      indexJson = await fetchJson(assetIdx.url, { timeout: 60000 });
      await fsp.writeFile(idxPath, JSON.stringify(indexJson), 'utf8');
      // 索引是本任务新建的，取消时要一起回滚
      trackFile(idxPath);
    }

    const objects = indexJson.objects ?? {};
    const assetItems = [];
    for (const [, v] of Object.entries(objects)) {
      const hash = v.hash;
      if (!hash) continue;
      const sub = hash.slice(0, 2);
      assetItems.push({
        url: `${RESOURCES_BASE}/${sub}/${hash}`,
        dest: path.join(assetsDir, 'objects', sub, hash),
        sha1: hash,
        size: v.size,
        name: hash,
      });
    }

    onStage({ stage: 'assets', message: `下载 ${assetItems.length} 个资源对象` });
    const r = await downloadMany(assetItems, {
      concurrency: Math.max(concurrency, 12),
      retries: 3,
      source: dlSource,
      gameDir: root,
      reuseRoots,
      onProgress: (p) => onProgress({ stage: 'assets', ...p }),
    });
    report.stages.assets = {
      total: r.total,
      skipped: r.skipped,
      downloaded: r.downloaded,
      failed: r.errors.length,
    };
    if (r.errors.length) {
      report.stages.assetErrors = r.errors.map((e) => e.error).slice(0, 10);
    }
  }

  // ---- 7. natives 预解压到实例目录（供诊断，运行时仍会用临时目录）----
  if (nativeJars.length) {
    const nativesOut = path.join(versionDir, 'natives');
    onStage({ stage: 'natives', message: '解压 natives' });
    let count = 0;
    for (const jar of nativeJars) {
      if (!fs.existsSync(jar)) continue;
      try {
        count += extractNatives(jar, nativesOut).length;
      } catch (e) {
        report.stages.nativesError = e.message;
      }
    }
    report.stages.natives = count;
  }

  // ---- 8. 确保版本要求的 Java 存在 ----
  //     external 模式（默认，学 PCL）：只查本机，缺了就报错提醒，不下载
  //     auto 模式：缺了自动下载对应 JRE
  const requiredJava = versionJson.javaVersion?.majorVersion;
  if (requiredJava) {
    onStage({ stage: 'java', message: `检查 Java ${requiredJava}` });
    try {
      const r = await ensureJava(requiredJava, {
        cachePath: JAVA_SCAN_CACHE,
        onStage,
        onProgress,
        mode: getSettings().javaMode ?? 'external',
      });
      report.stages.java = {
        required: requiredJava,
        installed: r.installed,
        path: r.path,
        version: r.version,
      };
    } catch (e) {
      // Java 缺失不阻断安装：游戏文件装完了，只是还不能启动。
      // 错误文案已经是可操作的（告诉他装哪个、去哪儿装），直接透传。
      report.stages.java = { required: requiredJava, error: e.message };
    }
  }

  report.ok = !(
    (report.stages.libraries?.failed ?? 0) > 0 ||
    (report.stages.assets?.failed ?? 0) > 0 ||
    String(report.stages.client ?? '').startsWith('error') ||
    Boolean(report.stages.java?.error)
  );

  return report;
}
