/**
 * Forge / NeoForge 安装
 *
 * 为什么不能像 Fabric 那样自己拼库：
 *   1.17 之后 Forge 必须跑 10 个 processor 做 SRG 重映射，手写等于重造官方安装器。
 *   所以这里直接用官方 installer.jar 跑 --installClient，这是唯一可靠的做法。
 *
 * 实测（2026-10-24，1.20.1-47.4.28）：
 *   - installer 会自己下载 vanilla client.jar 到 versions/1.20.1/1.20.1.jar
 *   - 但它**不写** 1.20.1.json，所以必须先跑 installVersion 装原版
 *   - 缺 launcher_profiles.json 会直接退出：
 *       "There is no Minecraft launcher profile in ... you need to run the launcher first!"
 *     补一个空 profiles 文件即可，实测 exit=0 + "Successfully installed client into launcher."
 *   - 装完产物是 versions/<mc>-forge-<ver>/<mc>-forge-<ver>.json，
 *     其中 inheritsFrom = <mc>，libraries 全部带 downloads.artifact.url（可直接下）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fetchJson, fetchText, downloadFile } from './download.js';
import { FORGE_MAVEN, NEOFORGE_MAVEN, NEOFORGE_MAVEN_MIRROR } from './sources.js';
import { listEntries, readEntry } from './zip.js';
import { installVersion } from './installer.js';
import { selectJava } from './java.js';
import { JAVA_SCAN_CACHE } from './paths.js';

const execFileAsync = promisify(execFile);

const PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';

/** "1.20.1" -> [1,20,1]，用于比较大小 */
function parseMc(v) {
  return String(v ?? '')
    .split(/[.\-]/)
    .map((x) => parseInt(x, 10))
    .filter((x) => !Number.isNaN(x));
}

/** 该 MC 版本该用哪个 Java 主版本（Forge 安装器自身也要能跑起来） */
export function javaMajorForMc(mc) {
  const p = parseMc(mc);
  const [a, b, c = 0] = p;
  if (a > 1) return 21;              // 26.x 之类的新版本号
  if (a === 1 && (b > 20 || (b === 20 && c >= 5))) return 21;
  if (a === 1 && b >= 18) return 17;
  if (a === 1 && b === 17) return 16;
  return 8;
}

/** 查某个 MC 版本推荐 / 最新的 Forge 版本 */
export async function resolveForgeVersion(gameVersion, { channel = 'recommended' } = {}) {
  const data = await fetchJson(PROMOTIONS, { timeout: 25000 });
  const promos = data?.promos ?? {};
  const rec = promos[`${gameVersion}-recommended`];
  const latest = promos[`${gameVersion}-latest`];
  const pick = channel === 'latest' ? latest ?? rec : rec ?? latest;
  if (!pick) return null;
  return String(pick);
}

/** 确保 launcher_profiles.json 存在 —— 缺了 Forge 安装器会直接拒绝工作 */
async function ensureLauncherProfiles(gameDir) {
  const p = path.join(gameDir, 'launcher_profiles.json');
  if (fs.existsSync(p)) return false;
  const skeleton = {
    profiles: {},
    settings: { enableSnapshots: false, keepLauncherOpen: false },
    version: 3,
  };
  await fsp.writeFile(p, JSON.stringify(skeleton, null, 2), 'utf8');
  return true;
}

/** 找可用的 java 可执行文件（优先选该 MC 版本要求的主版本） */
async function pickJava(gameVersion) {
  const requiredMajor = javaMajorForMc(gameVersion);
  const sel = await selectJava({ requiredMajor, cachePath: JAVA_SCAN_CACHE });
  if (!sel.path) {
    throw new Error(
      `安装 Forge 需要 Java ${requiredMajor}，但本机没找到可用的运行时。` +
        `请安装 JDK ${requiredMajor} 后重试。`
    );
  }
  return { path: sel.path, major: sel.major, requiredMajor, exact: sel.exact };
}

/**
 * 把原版 client.jar 复制成实例自己的 <instanceId>.jar。
 *
 * 为什么必须这么做（实测 2026-10-24）：
 *   Forge 的 jvm 参数里有 -DignoreList=...,forge-,${version_name}.jar
 *   实例叫 zombie-invade-100-days 时，ignoreList 找的是
 *   zombie-invade-100-days.jar；但目录里只有继承来的 1.20.1.jar，
 *   于是原版 jar 被 ModuleFinder 当成模块 __1_20_1，
 *   和 minecraft 模块争同一包，启动直接挂在模块解析：
 *     ResolutionException: Modules _1._20._1 and minecraft export package ...
 *   复制一份同名 jar 之后实测正常进游戏（到 Setting user / LWJGL / 资源重载）。
 */
export async function ensureInstanceJar(gameDir, gameVersion, versionId) {
  const ownJar = path.join(gameDir, 'versions', versionId, `${versionId}.jar`);
  if (fs.existsSync(ownJar)) return { copied: false, path: ownJar };

  const sourceJar = path.join(gameDir, 'versions', gameVersion, `${gameVersion}.jar`);
  if (!fs.existsSync(sourceJar)) {
    throw new Error(`找不到原版 client.jar（${sourceJar}），无法为实例建立启动 jar`);
  }

  await fsp.mkdir(path.dirname(ownJar), { recursive: true });
  await fsp.copyFile(sourceJar, ownJar);
  return { copied: true, path: ownJar };
}

/**
 * 安装 Forge。
 * opts: { gameDir, gameVersion, loaderVersion?, versionIdOverride?, onStage, onProgress, source }
 * 返回 { versionId, loaderVersion, forgeVersionId, jsonPath, java }
 */
export async function installForge(opts = {}) {
  const {
    gameDir,
    gameVersion,
    onStage = () => {},
    onProgress = () => {},
    source,
  } = opts;

  if (!gameDir) throw new Error('缺少 gameDir');
  if (!gameVersion) throw new Error('缺少 gameVersion');

  // 1. 决定 Forge 版本
  let loaderVersion = opts.loaderVersion;
  if (!loaderVersion) {
    onStage({ stage: 'forge', message: `查询 Forge 版本（${gameVersion}）` });
    loaderVersion = await resolveForgeVersion(gameVersion);
    if (!loaderVersion) {
      throw new Error(`Forge 没有发布支持 Minecraft ${gameVersion} 的版本`);
    }
  }
  onStage({ stage: 'forge', message: `使用 Forge ${loaderVersion}` });

  // 2. 必须先装原版：安装器只补 client.jar，不会写 1.20.1.json
  onStage({ stage: 'forge', message: `先安装原版 Minecraft ${gameVersion}` });
  await installVersion({
    gameDir,
    versionId: gameVersion,
    source,
    onStage,
    onProgress,
  });

  // 3. 下载 installer.jar
  const full = `${gameVersion}-${loaderVersion}`;
  const url = `${FORGE_MAVEN}net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  const cacheDir = path.join(gameDir, 'mclauncher-cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  const installerPath = path.join(cacheDir, `forge-${full}-installer.jar`);

  onStage({ stage: 'forge', message: `下载 Forge 安装器 ${loaderVersion}` });
  try {
    await downloadFile(url, installerPath, { retries: 3, timeout: 180000 });
  } catch (e) {
    throw new Error(`Forge 安装器下载失败（${loaderVersion}）：${e.message}`);
  }

  // 4. 缺 profile 会 exit 1，补一个空壳
  if (await ensureLauncherProfiles(gameDir)) {
    onStage({ stage: 'forge', message: '补齐 launcher_profiles.json' });
  }

  // 5. 找 java 并跑安装器
  const java = await pickJava(gameVersion);
  onStage({
    stage: 'forge',
    message: `运行 Forge 安装器（Java ${java.major}）… 这一步要下几百 MB 并做重映射，慢是正常的`,
  });

  try {
    const { stdout, stderr } = await execFileAsync(
      java.path,
      ['-Xmx512M', '-jar', installerPath, '--installClient', gameDir],
      { timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }
    );
    // 安装器把成功/失败都打在 stdout，必须核对，不能只看 exit code
    const out = `${stdout}\n${stderr}`;
    if (!/Successfully installed client into launcher/i.test(out)) {
      const tail = out.split('\n').filter(Boolean).slice(-6).join('\n');
      throw new Error(`Forge 安装器未报告成功：\n${tail}`);
    }
  } catch (e) {
    if (e.message?.startsWith('Forge 安装器未报告成功')) throw e;
    const detail = (e.stderr || e.stdout || '').toString().split('\n').filter(Boolean).slice(-6).join('\n');
    throw new Error(`Forge 安装器执行失败：${e.message}${detail ? `\n${detail}` : ''}`);
  }

  // 6. 定位安装器写出的版本 JSON
  const forgeVersionId = `${gameVersion}-forge-${loaderVersion}`;
  const forgeJsonPath = path.join(gameDir, 'versions', forgeVersionId, `${forgeVersionId}.json`);
  if (!fs.existsSync(forgeJsonPath)) {
    throw new Error(`Forge 安装器没有生成版本 JSON（期望 ${forgeJsonPath}）`);
  }

  // 7. 整合包要独立实例：把 json 复制成 <instanceId>.json，id 改成实例名
  //    inheritsFrom 保持指向原版，我们的 loadVersion 会递归合并
  let versionId = forgeVersionId;
  let jsonPath = forgeJsonPath;

  if (opts.versionIdOverride && opts.versionIdOverride !== forgeVersionId) {
    versionId = opts.versionIdOverride;
    const dir = path.join(gameDir, 'versions', versionId);
    await fsp.mkdir(dir, { recursive: true });

    const raw = JSON.parse(await fsp.readFile(forgeJsonPath, 'utf8'));
    raw.id = versionId;
    jsonPath = path.join(dir, `${versionId}.json`);
    await fsp.writeFile(jsonPath, JSON.stringify(raw, null, 2), 'utf8');

    // 实例必须有同名 jar，否则 Forge 的 ignoreList 匹配不上，
    // 原版 jar 会被当成模块，启动挂在模块解析。
    onStage({ stage: 'forge', message: '为实例建立启动 jar' });
    await ensureInstanceJar(gameDir, gameVersion, versionId);
  }

  onStage({ stage: 'forge', message: `Forge ${loaderVersion} 安装完成：${versionId}` });

  return {
    versionId,
    loaderVersion,
    forgeVersionId,
    jsonPath,
    java: { path: java.path, major: java.major, requiredMajor: java.requiredMajor },
  };
}

/**
 * NeoForge 安装
 *
 * 背景（实测 2026-10-24）：
 *   1. 官方 maven（maven.neoforged.net）在国内直连三次全 UND_ERR_CONNECT_TIMEOUT；
 *      BMCLAPI 镜像可用（1846 个版本，installer 6.9MB 正常下载）→ 优先镜像，官方兜底。
 *   2. NeoForge 的 installer Main-Class 与 Forge **完全同一个类**：
 *      net.minecraftforge.installer.SimpleInstaller
 *      参数也同一套：--installClient <dir> / --installServer / --skip-hash-check。
 *      所以这里不另写安装流程，复用 Forge 的调用方式。
 *   3. 但版本命名规则不同，artifactId 还分两代：
 *        MC 1.20.1        -> net/neoforged/forge    版本 1.20.1-47.1.106
 *        MC 1.20.2+       -> net/neoforged/neoforge 版本 = MC 去掉 "1." 前缀 + 补丁号
 *                            1.21.1 -> 21.1.264
 *      安装器产出的版本 id：
 *        1.20.1 -> "1.20.1-forge-47.1.106"（带 MC 前缀）
 *        1.21.1 -> "neoforge-21.1.264"（不带）
 *      所以实例 id **不能拼**，必须从 installer 里的 version.json 读真实 id。
 */

/** 从 maven-metadata.xml 里挖出所有版本号 */
function parseMavenVersions(xml) {
  return [...String(xml ?? '').matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
}

/**
 * MC 版本 -> NeoForge 的 artifact 坐标。
 * 返回 { group, prefix } 或 null。
 *
 * 1.20.1 是唯一走旧 artifact（net/neoforged/forge）的版本，
 * 因为那会儿 NeoForge 还以 Forge 分支形式发版。
 */
export function neoForgeCoords(gameVersion) {
  const p = parseMc(gameVersion);
  const [a, b, c = 0] = p;
  if (!p.length) return null;

  // NeoForge 从 MC 1.20.1 才开始存在（那会儿是 Forge 分支）。
  // 1.16.5 / 1.19.2 这类根本没有 NeoForge，必须返回 null，
  // 否则会拼出 16.5. 这种不存在的坐标去查镜像。
  if (a === 1 && b < 20) return null;
  if (a !== 1 && a < 20) return null;

  // 1.20.1 旧 artifact（NeoForge 当时以 Forge 分支发布）
  if (a === 1 && b === 20 && c === 1) {
    return { group: 'net/neoforged/forge', prefix: '1.20.1-47.', legacy: true };
  }

  // 1.20.2 起：新 artifact，前缀 = MC 版本去掉 "1."
  // 1.20.2 -> 20.2 / 1.21.1 -> 21.1 / 1.21.10 -> 21.10
  if (a === 1) {
    return { group: 'net/neoforged/neoforge', prefix: `${b}.${c}.`, legacy: false };
  }

  // MC 26.x 起改成两段式版本号，NeoForge 跟着用 26.x
  return { group: 'net/neoforged/neoforge', prefix: `${a}.${b}.`, legacy: false };
}

/**
 * 查某个 MC 版本可用的 NeoForge 版本。
 * 优先取稳定版（不含 -beta），没有稳定版再退 beta。
 */
export async function resolveNeoForgeVersion(gameVersion) {
  const coords = neoForgeCoords(gameVersion);
  if (!coords) return null;

  const metaUrl = `${NEOFORGE_MAVEN_MIRROR}${coords.group}/maven-metadata.xml`;
  let xml = null;
  try {
    xml = await fetchText(metaUrl, { timeout: 25000 });
  } catch {
    // 镜像挂了再试官方
    try {
      xml = await fetchText(`${NEOFORGE_MAVEN}${coords.group}/maven-metadata.xml`, { timeout: 25000 });
    } catch {
      return null;
    }
  }

  const all = parseMavenVersions(xml).filter((v) => v.startsWith(coords.prefix));
  if (!all.length) return null;

  const stable = all.filter((v) => !/-(beta|alpha|pre)/i.test(v));
  const pick = stable.at(-1) ?? all.at(-1);

  return {
    version: pick,
    group: coords.group,
    legacy: coords.legacy,
  };
}

/** 从 installer jar 里读 version.json 的真实 id */
function readInstallerVersionId(jarPath) {
  const buf = fs.readFileSync(jarPath);
  const entries = listEntries(buf);
  const e = entries.find((x) => x.name === 'version.json');
  if (!e) return null;
  try {
    const v = JSON.parse(readEntry(buf, e).toString('utf8'));
    return { id: v.id ?? null, inheritsFrom: v.inheritsFrom ?? null };
  } catch {
    return null;
  }
}

/**
 * 预填 installer 需要的库文件。
 *
 * 为什么必须这么做（实测 2026-10-24）：
 *   NeoForge installer 内部用硬编码的下载器去取 install_profile.json 里列的 70 个库。
 *   官方 maven（maven.neoforged.net）在本机连续 UND_ERR_CONNECT_TIMEOUT，
 *   于是 51 条指向它的库全部下载失败。
 *
 *   installer 自带 `--mirror` 参数，但实测**只对部分库生效**：
 *   `net.neoforged:neoforge:<ver>:universal` 这一条仍然写死官方地址，
 *   加了 --mirror 照样报 “These libraries failed to download”。
 *
 *   所以改成：自己把缺的库从 BMCLAPI 镜像下到 libraries/ 里。
 *   installer 按 path 判断本地是否已有文件，有就跳过下载。
 *   实测只缺 1 个文件（universal.jar 3.5MB）。
 */
async function prefillInstallerLibraries(installerPath, gameDir, onStage = () => {}) {
  const buf = fs.readFileSync(installerPath);
  const entries = listEntries(buf);
  const pe = entries.find((x) => x.name === 'install_profile.json');
  if (!pe) return { total: 0, filled: 0 };

  let profile;
  try {
    profile = JSON.parse(readEntry(buf, pe).toString('utf8'));
  } catch {
    return { total: 0, filled: 0 };
  }

  const libs = Array.isArray(profile.libraries) ? profile.libraries : [];
  const libRoot = path.join(gameDir, 'libraries');

  // 只处理带 downloads.artifact.path 的；没有 path 的（如 processor 的 maven 坐标）留给 installer
  const missing = [];
  for (const l of libs) {
    const dl = l.downloads?.artifact;
    if (!dl?.path) continue;
    const dest = path.join(libRoot, dl.path.split('/').join(path.sep));
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    missing.push({ name: l.name, dest, url: dl.url, sha1: dl.sha1 ?? null });
  }

  if (!missing.length) return { total: libs.length, filled: 0 };

  onStage({
    stage: 'neoforge',
    message: `预补 ${missing.length} 个缺失库（官方 maven 超时，走镜像）`,
  });

  const failed = [];
  let filled = 0;
  let lastErr = null;

  for (const m of missing) {
    // 官方 host -> BMCLAPI 镜像；镜像优先，官方兜底
    const candidates = [];
    if (m.url?.includes('maven.neoforged.net')) {
      candidates.push(m.url.replace('https://maven.neoforged.net/releases/', NEOFORGE_MAVEN_MIRROR));
    }
    if (m.url?.includes('libraries.minecraft.net')) {
      candidates.push(m.url.replace('https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/maven/'));
    }
    if (m.url) candidates.push(m.url);

    let ok = false;
    for (const u of candidates) {
      try {
        await fsp.mkdir(path.dirname(m.dest), { recursive: true });
        await downloadFile(u, m.dest, {
          retries: 1,
          timeout: 180000,
          sha1: m.sha1 ?? undefined,
        });
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
        await fsp.rm(m.dest, { force: true }).catch(() => {});
      }
    }

    if (ok) {
      filled++;
    } else {
      failed.push({ name: m.name, error: lastErr?.message ?? '下载失败' });
    }
  }

  if (failed.length) {
    const names = failed.slice(0, 3).map((f) => f.name).join('; ');
    throw new Error(`有 ${failed.length} 个库补不下来（镜像与官方都失败）：${names}`);
  }

  return { total: libs.length, filled };
}

/**
 * 安装 NeoForge。
 * opts: { gameDir, gameVersion, loaderVersion?, versionIdOverride?, onStage, onProgress, source }
 * 返回 { versionId, loaderVersion, neoVersionId, jsonPath, java }
 */
export async function installNeoForge(opts = {}) {
  const {
    gameDir,
    gameVersion,
    onStage = () => {},
    onProgress = () => {},
    source,
  } = opts;

  if (!gameDir) throw new Error('缺少 gameDir');
  if (!gameVersion) throw new Error('缺少 gameVersion');

  const coords = neoForgeCoords(gameVersion);
  if (!coords) {
    throw new Error(`NeoForge 不支持 Minecraft ${gameVersion}`);
  }

  // 1. 决定版本
  let loaderVersion = opts.loaderVersion;
  if (!loaderVersion) {
    onStage({ stage: 'neoforge', message: `查询 NeoForge 版本（${gameVersion}）` });
    const r = await resolveNeoForgeVersion(gameVersion);
    if (!r) {
      throw new Error(`查不到支持 Minecraft ${gameVersion} 的 NeoForge 版本（镜像与官方都不可用）`);
    }
    loaderVersion = r.version;
  }
  onStage({ stage: 'neoforge', message: `使用 NeoForge ${loaderVersion}` });

  // 2. 先装原版：安装器只补 client.jar，不写原版 json
  onStage({ stage: 'neoforge', message: `先安装原版 Minecraft ${gameVersion}` });
  await installVersion({ gameDir, versionId: gameVersion, source, onStage, onProgress });

  // 3. 下载 installer（镜像优先，官方兜底）
  const artifact = coords.legacy ? 'forge' : 'neoforge';
  const jarName = `${artifact}-${loaderVersion}-installer.jar`;
  const relPath = `${coords.group}/${loaderVersion}/${jarName}`;
  const urls = [`${NEOFORGE_MAVEN_MIRROR}${relPath}`, `${NEOFORGE_MAVEN}${relPath}`];

  const cacheDir = path.join(gameDir, 'mclauncher-cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  const installerPath = path.join(cacheDir, `neoforge-${loaderVersion}-installer.jar`);

  onStage({ stage: 'neoforge', message: `下载 NeoForge 安装器 ${loaderVersion}` });
  let lastErr = null;
  let downloaded = false;
  for (const u of urls) {
    try {
      await downloadFile(u, installerPath, { retries: 1, timeout: 240000 });
      downloaded = true;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!downloaded) {
    throw new Error(`NeoForge 安装器下载失败（${loaderVersion}）：${lastErr?.message ?? '未知错误'}`);
  }

  // 4. 从 installer 读真实版本 id（两种命名规则都覆盖）
  const meta = readInstallerVersionId(installerPath);
  const neoVersionId = meta?.id ?? `neoforge-${loaderVersion}`;
  onStage({ stage: 'neoforge', message: `安装器产出的版本：${neoVersionId}` });

  // 5. 补 launcher_profiles.json（Forge 系安装器缺了就拒工）
  if (await ensureLauncherProfiles(gameDir)) {
    onStage({ stage: 'neoforge', message: '补齐 launcher_profiles.json' });
  }

  // 6. 预补库文件 —— 官方 maven 连不上，installer 的 --mirror 对 universal 那条无效
  const prefill = await prefillInstallerLibraries(installerPath, gameDir, onStage);
  if (prefill.filled) {
    onStage({ stage: 'neoforge', message: `已预补 ${prefill.filled} 个库（共 ${prefill.total} 个）` });
  }

  // 7. 跑安装器（与 Forge 同一套参数）
  const java = await pickJava(gameVersion);
  onStage({
    stage: 'neoforge',
    message: `运行 NeoForge 安装器（Java ${java.major}）… 要下依赖并做重映射，慢是正常的`,
  });

  try {
    const { stdout, stderr } = await execFileAsync(
      java.path,
      ['-Xmx512M', '-jar', installerPath, '--installClient', gameDir],
      { timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }
    );
    const out = `${stdout}\n${stderr}`;
    if (!/Successfully installed client into launcher/i.test(out)) {
      const tail = out.split('\n').filter(Boolean).slice(-6).join('\n');
      throw new Error(`NeoForge 安装器未报告成功：\n${tail}`);
    }
  } catch (e) {
    if (e.message?.startsWith('NeoForge 安装器未报告成功')) throw e;
    const detail = (e.stderr || e.stdout || '').toString().split('\n').filter(Boolean).slice(-6).join('\n');
    throw new Error(`NeoForge 安装器执行失败：${e.message}${detail ? `\n${detail}` : ''}`);
  }

  // 7. 定位安装器写出的 JSON
  const neoJsonPath = path.join(gameDir, 'versions', neoVersionId, `${neoVersionId}.json`);
  if (!fs.existsSync(neoJsonPath)) {
    throw new Error(`NeoForge 安装器没有生成版本 JSON（期望 ${neoJsonPath}）`);
  }

  // 8. 整合包要独立实例：复制成 <instanceId>.json 并改 id
  let versionId = neoVersionId;
  let jsonPath = neoJsonPath;

  if (opts.versionIdOverride && opts.versionIdOverride !== neoVersionId) {
    versionId = opts.versionIdOverride;
    const dir = path.join(gameDir, 'versions', versionId);
    await fsp.mkdir(dir, { recursive: true });

    const raw = JSON.parse(await fsp.readFile(neoJsonPath, 'utf8'));
    raw.id = versionId;
    jsonPath = path.join(dir, `${versionId}.json`);
    await fsp.writeFile(jsonPath, JSON.stringify(raw, null, 2), 'utf8');

    // 同 Forge：实例必须有同名 jar，否则 ignoreList 匹配不上，
    // 原版 jar 会被 ModuleFinder 当成模块，启动挂在模块解析。
    onStage({ stage: 'neoforge', message: '为实例建立启动 jar' });
    await ensureInstanceJar(gameDir, gameVersion, versionId);
  }

  onStage({ stage: 'neoforge', message: `NeoForge ${loaderVersion} 安装完成：${versionId}` });

  return {
    versionId,
    loaderVersion,
    neoVersionId,
    jsonPath,
    java: { path: java.path, major: java.major, requiredMajor: java.requiredMajor },
  };
}
