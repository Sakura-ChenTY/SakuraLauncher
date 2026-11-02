/**
 * Java 运行时自动获取
 *
 * 触发时机：安装某个 Minecraft 版本时，若本机没有该版本要求的 Java 主版本，
 * 就顺手把对应运行时下载下来，避免装完却打不开。
 *
 * 为什么选 JRE 不选 JDK：
 *   跑游戏只需要运行时，不需要编译器。Temurin 25 的 jre 包 55.8 MB，
 *   jdk 包 134.6 MB，差一倍多，没必要多下 80 MB。
 *
 * 为什么不用 download.js 的镜像改写：
 *   Adoptium 的包在 GitHub Release 上，下载会重定向到
 *   release-assets.githubusercontent.com，这不是 Mojang 域名，
 *   sources.js 的映射表管不到，所以这里显式维护候选 URL 列表。
 *
 * 实测候选（2026-10-23）：
 *   Adoptium API            200  523ms，给出 link/size/checksum(sha256)
 *   GitHub Release 跳转后   206  落到 release-assets.githubusercontent.com
 *   微软 aka.ms 直链        301→206  落到 download.visualstudio.microsoft.com
 *   清华镜像目录            200  有同名 zip
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { fetchJson, downloadFile } from './download.js';
import { extractAll } from './zip.js';
import { scanJavas } from './java.js';
import { RUNTIME_DIR } from './paths.js';

/** 运行时统一放用户目录（见 paths.js；不再硬编码 D 盘） */
export { RUNTIME_DIR };

const ADOPTIUM_API = (major, imageType) =>
  `https://api.adoptium.net/v3/assets/latest/${major}/hotspot` +
  `?architecture=x64&image_type=${imageType}&os=windows&vendor=eclipse`;

/** 微软提供的 OpenJDK 直链（作为第二兜底） */
const MS_JDK_URL = (major) => `https://aka.ms/download-jdk/microsoft-jdk-${major}-windows-x64.zip`;

/** 清华镜像（作为第三兜底，需要具体文件名） */
const TUNA_URL = (major, imageType, fileName) =>
  `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/${imageType}/x64/windows/${fileName}`;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 查询 Adoptium，拿到某个主版本的确切包信息。
 * 返回 { version, fileName, url, sha256, size }
 */
export async function resolveJavaPackage(major, { imageType = 'jre' } = {}) {
  const list = await fetchJson(ADOPTIUM_API(major, imageType), { timeout: 25000 });
  if (!Array.isArray(list) || !list.length) {
    throw new Error(`Adoptium 没有 Java ${major} 的 ${imageType} 包`);
  }

  const item = list[0];
  const pkg = item.binary?.package ?? {};
  if (!pkg.link) throw new Error(`Adoptium 返回的包信息缺少下载地址（Java ${major}）`);

  return {
    version: item.version?.semver ?? item.release_name ?? String(major),
    fileName: pkg.name ?? `jre-${major}.zip`,
    url: pkg.link,
    sha256: pkg.checksum ?? null,
    size: pkg.size ?? null,
    releaseName: item.release_name ?? null,
  };
}

/** 本机是否已有满足某主版本的运行时（force=true 忽略缓存） */
export async function hasJavaFor(major, { cachePath, force = false } = {}) {
  const list = await scanJavas(cachePath, { force });
  return list.find((j) => j.major === major) ?? null;
}

/**
 * 确保某主版本的 Java 可用；缺了就下载安装。
 * 返回 { installed: boolean, major, path, version }
 */
export async function ensureJava(major, opts = {}) {
  const {
    runtimeDir = RUNTIME_DIR,
    cachePath,
    onStage = () => {},
    onProgress = () => {},
    force = false,
    mode = 'external',
  } = opts;

  if (!major) throw new Error('缺少 Java 主版本号');

  // 1. 先看本机有没有
  const existing = await hasJavaFor(major, { cachePath, force });
  if (existing) {
    onStage({ stage: 'java', message: `本机已有 Java ${major}，跳过下载` });
    return { installed: false, major, path: existing.path, version: existing.raw };
  }

  // 1.5 external 模式：只认本机已有的 Java，不下载。
  //     这是 PCL 的做法 —— 启动器不带运行时，体积小；代价是缺了要用户自己装。
  //     错误信息里给出可执行的名字，而不是一个 404 一样的失败。
  if (mode === 'external') {
    const list = await scanJavas(cachePath, { force });
    const avail = list.map((j) => j.major).sort((a, b) => a - b);
    throw new Error(
      `缺少 Java ${major}。当前是「只用外部 Java」模式，不会自动下载。\n` +
        `本机已有：${avail.length ? avail.map((m) => 'Java ' + m).join('、') : '无'}\n` +
        `装一个 Temurin ${major} 后重启启动器即可（https://adoptium.net）。\n` +
        `或在设置里把 Java 模式改成「自动下载」。`
    );
  }

  // 2. 查包信息
  onStage({ stage: 'java', message: `查询 Java ${major} 下载地址` });
  let pkg;
  try {
    pkg = await resolveJavaPackage(major);
  } catch (e) {
    // Adoptium 查询失败时退回微软直链，此时没有 checksum 可校验
    pkg = {
      version: String(major),
      fileName: `microsoft-jdk-${major}-windows-x64.zip`,
      url: MS_JDK_URL(major),
      sha256: null,
      size: null,
    };
    onStage({ stage: 'java', message: `Adoptium 查询失败，改用微软直链（${e.message}）` });
  }

  const downloadsDir = path.join(runtimeDir, 'downloads');
  await fsp.mkdir(downloadsDir, { recursive: true });
  const zipPath = path.join(downloadsDir, pkg.fileName);

  // 3. 下载（多个候选源依次尝试）
  const candidates = [
    pkg.url,
    MS_JDK_URL(major),
    TUNA_URL(major, 'jre', pkg.fileName),
  ].filter(Boolean);

  onStage({
    stage: 'java',
    message: `下载 Java ${major}（${pkg.size ? (pkg.size / 1024 / 1024).toFixed(1) + ' MB' : '大小未知'}）`,
  });

  let ok = false;
  const errors = [];
  for (let i = 0; i < candidates.length && !ok; i++) {
    try {
      await downloadFile(candidates[i], zipPath, {
        size: pkg.size ?? undefined,
        retries: 2,
        timeout: 180000,
        onProgress: null,
      });

      // 有校验和就核对，坏包立即删掉换源
      if (pkg.sha256) {
        const actual = await sha256File(zipPath);
        if (actual.toLowerCase() !== pkg.sha256.toLowerCase()) {
          await fsp.rm(zipPath, { force: true });
          throw new Error(`SHA256 不匹配（期望 ${pkg.sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）`);
        }
      }
      ok = true;
    } catch (e) {
      errors.push(`源${i + 1}: ${e.message}`);
      await fsp.rm(zipPath, { force: true });
    }
  }

  if (!ok) {
    throw new Error(`Java ${major} 下载失败：\n  ${errors.join('\n  ')}`);
  }

  // 4. 解压到临时目录再改名，避免半成品被当成可用运行时
  const targetDir = path.join(runtimeDir, String(major));
  const tmpDir = path.join(runtimeDir, `.tmp-${major}-${crypto.randomBytes(3).toString('hex')}`);

  onStage({ stage: 'java', message: `解压 Java ${major}` });
  try {
    const count = extractAll(zipPath, tmpDir, {
      stripTopLevel: true,
      onProgress: (n, total) => {
        onProgress({ stage: 'java', done: n, total, message: `解压 Java ${major}（${n}/${total}）` });
      },
    });

    // 5. 必须在解压结果里找到 bin/java.exe 才算成功
    const javaExe = path.join(tmpDir, 'bin', 'java.exe');
    if (!fs.existsSync(javaExe)) {
      throw new Error(`解压完成但没找到 bin/java.exe（解出 ${count} 个文件），包结构可能变了`);
    }

    await fsp.rm(targetDir, { recursive: true, force: true });
    await fsp.rename(tmpDir, targetDir);
  } catch (e) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    throw e;
  } finally {
    // 安装包留着没用，删掉省空间
    await fsp.rm(zipPath, { force: true });
  }

  const installedExe = path.join(targetDir, 'bin', 'java.exe');

  // 6. 让 java.js 的缓存失效，否则新装的运行时扫不到
  if (cachePath) {
    try {
      await fsp.rm(cachePath, { force: true });
    } catch {
      /* 删不掉就靠 force 扫描兜底 */
    }
  }

  // 7. 真跑一次 -version 确认能启动
  const check = await scanJavas(cachePath, { force: true });
  const found = check.find((j) => j.path.replace(/\\/g, '/') === installedExe.replace(/\\/g, '/'));
  if (!found) {
    throw new Error(`Java ${major} 已解压到 ${targetDir}，但无法执行 java -version，运行库可能不完整`);
  }
  if (found.major !== major) {
    throw new Error(`下载的运行时主版本是 ${found.major}，与要求的 ${major} 不符`);
  }

  onStage({ stage: 'java', message: `Java ${major} 就绪：${targetDir}` });
  return { installed: true, major, path: installedExe, version: found.raw };
}
