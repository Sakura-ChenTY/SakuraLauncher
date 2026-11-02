/**
 * Java 运行时探测与选择
 *
 * 为什么需要这一层：不同 Minecraft 版本要求不同的 Java 主版本
 * （1.21.11 -> 21，26.3 -> 25）。用错版本的表现是
 *   UnsupportedClassVersionError: ... class file version 69.0 ... up to 65.0
 * 这个报错对使用者毫无指导意义，所以启动器必须先选对 java。
 *
 * 探测策略：扫固定候选目录 -> 跑 `java -version` 读真实主版本 -> 缓存结果。
 * 缓存 24 小时，避免每次启动都跑一堆子进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { RUNTIME_DIR } from './paths.js';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 24 * 3600_000;

/**
 * 可能存放 JDK 的目录（浅扫两层，不做全盘搜索）
 *
 * 不写死盘符和用户名：别人的机器可能只有 C 盘，用户名也不是这一个。
 * 用 os.homedir() 和盘符探测拼出来，本地额外目录靠环境变量补。
 */
function buildSearchRoots() {
  const home = os.homedir();
  const roots = [
    path.join(home, '.jdks'),
    path.join(home, 'scoop', 'apps'),
    path.join(home, '.sdkman', 'candidates', 'java'),
  ];

  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    roots.push(
      path.join(pf, 'Java'),
      path.join(pf, 'Eclipse Adoptium'),
      path.join(pf, 'Microsoft'),
      path.join(pf, 'Zulu'),
      path.join(pf, 'Amazon Corretto'),
      path.join(pf, 'BellSoft'),
      path.join(pf86, 'Java'),
      // 官方启动器自己下载的运行时会在这里
      path.join(home, 'AppData', 'Local', 'Packages')
    );
    // 老用户可能把 JDK 放在非系统盘：探测存在的盘符，看常见目录
    for (const drive of ['C', 'D', 'E', 'F']) {
      for (const sub of ['Dev', 'Tools', 'Program Files']) {
        const p = `${drive}:/${sub}`;
        if (fs.existsSync(p)) roots.push(p);
      }
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines', '/opt/homebrew/opt', '/usr/local/opt');
  } else {
    roots.push('/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk');
  }

  // 用户自定义搜索目录（多个用 ; 或 : 分隔）
  const extra = process.env.MCLAUNCHER_JAVA_DIRS?.trim();
  if (extra) {
    for (const p of extra.split(process.platform === 'win32' ? ';' : ':')) {
      if (p.trim()) roots.push(p.trim());
    }
  }

  return roots;
}

const SEARCH_ROOTS = buildSearchRoots();

/** 启动器自己下载的运行时目录（runtimes/<major>/bin/java*），单独扫一层 */
const RUNTIME_ROOTS = [RUNTIME_DIR];

/** java 可执行文件名：Windows 是 java.exe，其它平台没有后缀 */
export const JAVA_BIN = process.platform === 'win32' ? 'java.exe' : 'java';

/** 国内常见的启动器运行时位置（相对家目录，跨平台安全） */
function addLauncherRunTimes(roots) {
  const home = os.homedir();
  roots.push(
    path.join(home, '.minecraft', 'runtime'),
    path.join(home, 'AppData', 'Roaming', '.minecraft', 'runtime')
  );
  return roots;
}
addLauncherRunTimes(SEARCH_ROOTS);

/** 从目录名/路径猜主版本，只作为排序提示，不作为结论 */
function guessMajor(name) {
  const m = name.match(/(?:jdk|jre|java)[-_ ]?(\d+)/i) ?? name.match(/(\d+)(?:\.\d+)?/);
  return m ? Number(m[1]) : null;
}

/** 在若干根目录下找 bin/java.exe */
function findJavaExecutables() {
  const found = [];
  const seen = new Set();

  const push = (p) => {
    const norm = p.replace(/\\/g, '/');
    if (!seen.has(norm) && fs.existsSync(norm)) {
      seen.add(norm);
      found.push(norm);
    }
  };

  for (const root of SEARCH_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name).replace(/\\/g, '/');
      // 直接是 JDK 目录
      push(`${dir}/bin/${JAVA_BIN}`);
      // 再下一层（例如 runtime/java-runtime-delta/windows-x64/bin）
      let subs = [];
      try {
        subs = fs.readdirSync(dir, { withFileTypes: true }).filter((s) => s.isDirectory());
      } catch {
        continue;
      }
      for (const s of subs.slice(0, 40)) {
        const sub = `${dir}/${s.name}`;
        push(`${sub}/bin/${JAVA_BIN}`);
        // Mojang 官方运行时的子目录按平台命名
        push(`${sub}/windows-x64/bin/${JAVA_BIN}`);
        push(`${sub}/windows/bin/${JAVA_BIN}`);
        push(`${sub}/mac-os/bin/${JAVA_BIN}`);
        push(`${sub}/linux/bin/${JAVA_BIN}`);
      }
    }
  }

  // 启动器自管的运行时：runtimes/<major>/bin/java.exe
  for (const root of RUNTIME_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      // 跳过下载临时目录 .tmp-xxx
      if (d.name.startsWith('.')) continue;
      push(`${root}/${d.name}/bin/${JAVA_BIN}`);
    }
  }

  return found;
}

/** 跑 java -version 读主版本（stderr 才有输出） */
export async function probeVersion(javaPath) {
  try {
    const { stderr, stdout } = await execFileAsync(javaPath, ['-version'], {
      timeout: 15000,
      windowsHide: true,
    });
    const text = `${stderr}\n${stdout}`;
    // 形如 openjdk version "25.0.1" 或 java version "1.8.0_392"
    const m = text.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return { ok: false, raw: text.slice(0, 200) };
    let major = Number(m[1]);
    // 1.8 这种老式版本号：主版本是第二段
    if (major === 1 && m[2]) major = Number(m[2]);
    const line = text.split(/\r?\n/).find((l) => /version "/.test(l)) ?? '';
    return { ok: true, major, raw: line.trim() };
  } catch (e) {
    return { ok: false, raw: e.message };
  }
}

/** 扫描并返回 [{ path, major, raw }]；force=true 忽略缓存 */
export async function scanJavas(cachePath, opts = {}) {
  const { force = false } = opts;
  if (!force && cachePath && fs.existsSync(cachePath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (Date.now() - (c.at ?? 0) < CACHE_TTL_MS && Array.isArray(c.list)) {
        // 缓存里的路径仍要存在才算数
        return c.list.filter((j) => fs.existsSync(j.path));
      }
    } catch {
      /* 缓存坏了重扫 */
    }
  }

  const exes = findJavaExecutables();
  const list = [];
  for (const p of exes) {
    const v = await probeVersion(p);
    if (v.ok) list.push({ path: p, major: v.major, raw: v.raw });
  }

  // 去重：同一主版本只保留第一个（优先路径短的）
  list.sort((a, b) => a.path.length - b.path.length);

  if (cachePath) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ at: Date.now(), list }), 'utf8');
    } catch {
      /* 缓存写失败不影响功能 */
    }
  }

  return list;
}

/**
 * 按需要的 Java 主版本挑一个。
 * 优先精确匹配；没有精确匹配但有更高版本时，返回更高版本并标记 mismatch。
 */
export async function selectJava({ requiredMajor, preferred, cachePath } = {}) {
  let preferredInfo = null;
  if (preferred && fs.existsSync(preferred)) {
    const v = await probeVersion(preferred);
    preferredInfo = {
      path: preferred,
      major: v.ok ? v.major : null,
      required: requiredMajor ?? null,
      exact: !requiredMajor || (v.ok && v.major === requiredMajor),
      source: 'manual',
    };
    // 版本要求的 Java 不匹配时不能用它；继续扫描正确的版本。
    if (preferredInfo.exact) return preferredInfo;
  }

  const list = await scanJavas(cachePath);
  if (!list.length) {
    return {
      path: null,
      major: null,
      required: requiredMajor ?? null,
      exact: false,
      source: 'none',
      available: [],
      preferred: preferredInfo,
    };
  }

  if (requiredMajor) {
    const exact = list.find((j) => j.major === requiredMajor);
    if (exact) {
      return { ...exact, required: requiredMajor, exact: true, source: 'scan', available: list, preferred: preferredInfo };
    }
    // 不能拿更高版本硬顶：LWJGL/原生库可能直接崩。
    return {
      path: null,
      major: null,
      required: requiredMajor,
      exact: false,
      source: 'missing',
      available: list,
      preferred: preferredInfo,
    };
  }

  if (preferredInfo?.path) return preferredInfo;

  // 没指定要求：取最高版本
  const best = [...list].sort((a, b) => b.major - a.major)[0];
  return { ...best, required: null, exact: true, source: 'scan', available: list };
}
