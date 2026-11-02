/**
 * 库解析与 classpath 构建
 *
 * 两条来源要分别处理：
 *   1. downloads.artifact —— 官方库，JSON 里直接给了相对路径
 *   2. 只有 Maven 坐标（Fabric 系常见）—— 需要按 group:artifact:version[:classifier] 自己拼路径
 *
 * 同时要把 natives 条目挑出来，它们不能进 classpath，而是解压到 natives 目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { allows } from './rules.js';

/** 从 Maven 坐标拼出相对路径 */
export function mavenPath(name) {
  // group:artifact:version[:classifier]
  const parts = name.split(':');
  if (parts.length < 3) return null;
  const [group, artifact, version, classifier] = parts;
  const groupPath = group.replace(/\./g, '/');
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return `${groupPath}/${artifact}/${version}/${fileName}`;
}

/** 判断某个库是否是 natives 包（按坐标里的 classifier） */
export function isNativeLibrary(lib) {
  const name = lib?.name ?? '';
  if (/:(natives-[\w.-]+)$/.test(name)) return true;
  if (lib?.natives) return true;
  return false;
}

/**
 * natives 的 classifier key。
 * 1.12 / 1.13 的 JSON 里常见 `natives: { windows: "natives-windows" }`；
 * 少数旧包写成 `natives-windows-${arch}`，这里把 ${arch} 换成当前架构。
 * 也兼容 name 自身带 `:natives-...` 的库。
 */
export function nativeClassifierKey(lib, ctx) {
  let raw = lib?.natives?.[ctx?.os?.name];
  if (!raw && typeof lib?.name === 'string') {
    const m = /:(natives-[\w.-]+)$/.exec(lib.name);
    if (m) raw = m[1];
  }
  if (!raw) return null;

  if (!raw.includes('${arch}')) return raw;

  const variants = new Set(
    [
      ctx?.os?.arch,
      String(ctx?.os?.arch ?? '').replace('x86_64', '64'),
      process.arch,
    ].filter(Boolean)
  );
  for (const arch of variants) {
    const key = raw.replaceAll('${arch}', arch);
    if (lib?.downloads?.classifiers?.[key]) return key;
  }
  return raw.replaceAll('${arch}', ctx?.os?.arch ?? process.arch);
}

/** natives jar 的相对路径：优先 downloads.classifiers，其次按 Maven 坐标补 classifier */
export function nativeLibraryRel(lib, ctx) {
  const key = nativeClassifierKey(lib, ctx);
  if (!key) return null;
  const fromJson = lib?.downloads?.classifiers?.[key]?.path;
  if (fromJson) return fromJson;
  if (lib?.name) return mavenPath(`${lib.name}:${key}`);
  return null;
}

/** 旧版 Forge 的 classpath 里可能同时出现同一 artifact 的两个版本（如 log4j 2.8.1/2.15.0）。 */
function versionParts(v) {
  return String(v)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
}

function compareVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 解析全部库，返回 { classpath: string[], natives: [{ jarPath }], missing: [] }
 *
 * 关键：classpath 要 artifact（基础 jar 不能丢），natives 要 classifier
 * （1.12 的 lwjgl-platform / jinput-platform 只有 classifiers 没有 artifact）。
 * 过去只读 artifact，导致这两类旧库永远误报缺失，natives 也进不了目录。
 */
export function resolveLibraries(versionJson, librariesDir, ctx) {
  let classpath = [];
  const natives = [];
  const missing = [];
  const seen = new Set();

  const addClasspath = (jarPath) => {
    if (!jarPath || seen.has(jarPath)) return;
    seen.add(jarPath);
    classpath.push(jarPath);
  };

  for (const lib of versionJson.libraries ?? []) {
    if (!lib) continue;
    if (!allows(lib.rules, ctx)) continue;

    const artifactRel = lib.downloads?.artifact?.path ?? (lib.name ? mavenPath(lib.name) : null);
    const nativeRel = nativeLibraryRel(lib, ctx);
    const nativeKey = nativeClassifierKey(lib, ctx);
    const isNative = isNativeLibrary(lib);

    const artifactPath = artifactRel ? path.join(librariesDir, artifactRel) : null;
    const nativePath = nativeRel ? path.join(librariesDir, nativeRel) : null;
    const artifactExists = artifactPath ? fs.existsSync(artifactPath) : false;
    const nativeExists = nativePath ? fs.existsSync(nativePath) : false;

    // 基础 jar 和 natives jar 都可能需要进 classpath：
    // 新版 LWJGL 会从 classpath 上的 natives jar 里自己抽 dll。
    if (artifactExists) addClasspath(artifactPath);
    if (nativeExists) addClasspath(nativePath);

    if (isNative) {
      if (nativeExists) {
        natives.push({ name: lib.name, jarPath: nativePath });
      } else if (nativeKey) {
        // 只有 classifier 真正缺失才报；artifact 路径常常是伪造的，不能拿它报假缺。
        missing.push({
          name: `${lib.name}:${nativeKey}`,
          expected: nativePath,
          url: lib.downloads?.classifiers?.[nativeKey]?.url ?? lib.url,
          kind: 'native',
        });
      } else if (artifactExists) {
        natives.push({ name: lib.name, jarPath: artifactPath });
      } else if (artifactPath) {
        missing.push({ name: lib.name, expected: artifactPath, url: lib.url, kind: 'artifact' });
      }
      continue;
    }

    if (!artifactExists && artifactPath) {
      missing.push({ name: lib.name, expected: artifactPath, url: lib.url, kind: 'artifact' });
    }
  }

  // 1.12.x 的 Forge JSON 常同时带 log4j 2.8.1 和 2.15.0。
  // 两者都在 classpath 时，Java 先命中旧版，FermiumBooter 会报
  // NoSuchMethodError: FileAppender$Builder.setName。旧版实例按 artifact
  // 只留最高版本；natives jar 保留（它们和基础 jar 同名但 classifier 不同）。
  if (typeof versionJson.minecraftArguments === 'string') {
    const chosen = new Map();
    for (const jarPath of classpath) {
      const rel = path.relative(librariesDir, jarPath).replaceAll('\\', '/');
      const parts = rel.split('/');
      if (parts.length < 3) continue;
      const file = parts.at(-1) ?? '';
      if (/-natives-/.test(file)) continue;
      const version = parts.at(-2);
      const artifact = parts.at(-3);
      const key = `${parts.slice(0, -2).join('/')}/${artifact}`;
      const prev = chosen.get(key);
      if (!prev || compareVersion(version, prev.version) > 0) {
        chosen.set(key, { jarPath, version });
      }
    }
    if (chosen.size) {
      const keep = new Set([...chosen.values()].map((x) => x.jarPath));
      classpath = classpath.filter((jarPath) => {
        const rel = path.relative(librariesDir, jarPath).replaceAll('\\', '/');
        const file = rel.split('/').at(-1) ?? '';
        if (/-natives-/.test(file)) return true;
        return keep.has(jarPath);
      });
    }
  }

  return { classpath, natives, missing };
}

/** 把 classpath 拼成字符串（Windows 用分号） */
export function classpathString(entries) {
  return entries.join(process.platform === 'win32' ? ';' : ':');
}

/**
 * 从 jvm 参数里推断 natives 需要哪些子目录。
 *
 * 旧版本（如 1.21.11）直接写 ${natives_directory}，平铺即可；
 * 新版本（如 26.3）改成按用途分子目录：
 *   -Djava.library.path=${natives_directory}/java
 *   -Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}/lwjgl
 *   -Djna.tmpdir=${natives_directory}/jna
 *   -Dio.netty.native.workdir=${natives_directory}/netty
 * JVM 的 java.library.path 不递归搜索，所以目录结构必须完全对。
 *
 * 返回子目录名数组；没有子目录时返回空数组（表示平铺到根）。
 */
export function detectNativeSubdirs(jvmArgs) {
  const subs = new Set();
  for (const item of jvmArgs ?? []) {
    const values = typeof item === 'string' ? [item] : Array.isArray(item?.value) ? item.value : [item?.value].filter(Boolean);
    for (const v of values) {
      if (typeof v !== 'string') continue;
      const m = v.match(/\$\{natives_directory\}\/([\w.-]+)/g);
      if (!m) continue;
      for (const hit of m) {
        const name = hit.slice(hit.lastIndexOf('/') + 1);
        if (name) subs.add(name);
      }
    }
  }
  return [...subs];
}
