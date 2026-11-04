/**
 * 启动器核心：把版本 JSON 变成一条真正能跑的 java 命令
 *
 * 流程（顺序不能乱）：
 *   1. 读版本 JSON（含继承合并）
 *   2. 按规则筛库 -> classpath
 *   3. 抽 natives 到临时目录
 *   4. 组装占位符变量表
 *   5. 拼参数
 *   6. spawn java
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectOs } from './rules.js';
import { loadVersion, listVersions } from './version.js';
import { resolveLibraries, classpathString, detectNativeSubdirs } from './classpath.js';
import { buildLaunchCommand, offlineUuid, buildIdentityVars } from './args.js';
import { extractNatives } from './zip.js';
import { selectJava, scanJavas, probeVersion } from './java.js';
import { ensureJava } from './javadl.js';
import { getSettings, memoryArgs, splitArgs, jvmPresetArgs } from './settings.js';
import { collectPluginArgs } from './plugins.js';
import { currentAccount, msEnsureFresh, ensureAuthlibInjector } from './auth.js';
import { defaultGameDir } from './paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let APP_VERSION = '0.0.0';
try {
  APP_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version || APP_VERSION;
} catch {
  /* 打包后路径异常时保留占位值，不阻断启动 */
}

/**
 * 默认游戏目录：不再写死某个盘符和用户名。
 * 跟官方启动器一致（~/.minecraft），可用 MCLAUNCHER_GAME_DIR 覆盖。
 */
export const DEFAULT_GAME_DIR = defaultGameDir();

/** 找到可用的 java（带主版本要求；找不到时返回带诊断信息的结果） */
export async function findJava(preferred, requiredMajor, cachePath) {
  return selectJava({ requiredMajor, preferred, cachePath });
}

/**
 * 根据版本声明的 javaVersion 选出合适的 java 二进制。
 * 找不到满足要求的运行时，要给出能指导行动的报错，而不是让它去撞
 * UnsupportedClassVersionError。
 */
export async function resolveJavaBin(opts = {}, versionJson) {
  const requiredMajor = versionJson.javaVersion?.majorVersion ?? null;
  const cachePath = path.join(os.homedir(), '.mclauncher', 'java-scan.json');

  const sel = await findJava(opts.java, requiredMajor, cachePath);

  if (sel.path) {
    let major = sel.major ?? null;
    if (!major) {
      const probed = await probeVersion(sel.path);
      if (probed.ok) major = probed.major;
    }
    return { bin: sel.path, major, required: requiredMajor };
  }

  // 默认 auto 且玩家没有手填路径时，启动前补一个 JRE。
  // 玩家显式指定了 javaPath 就绝不覆盖他的选择，只保留诊断报错。
  if (requiredMajor && !opts.java && (getSettings().javaMode ?? 'auto') === 'auto') {
    const onStage = typeof opts.onJavaStage === 'function' ? opts.onJavaStage : () => {};
    const onProgress = typeof opts.onJavaProgress === 'function' ? opts.onJavaProgress : () => {};
    try {
      onStage({ stage: 'java', message: `缺少 Java ${requiredMajor}，准备自动下载 JRE` });
      const installed = await ensureJava(requiredMajor, {
        mode: 'auto',
        cachePath,
        onStage,
        onProgress,
      });
      let major = installed.major ?? requiredMajor;
      if (!major) {
        const probed = await probeVersion(installed.path);
        if (probed.ok) major = probed.major;
      }
      return { bin: installed.path, major, required: requiredMajor };
    } catch (e) {
      const reason = /ENOSPC|No space|Space|磁盘|空间/i.test(e.message) ? '磁盘空间不足' : (/ENOTFOUND|ECONN|ETIMEDOUT|timeout|HTTP|network|下载失败/i.test(e.message) ? '网络不可达/下载失败' : (/EBUSY|EPERM|EACCES|占用|denied/i.test(e.message) ? '文件被占用/没有权限' : (/zip|EOCD|损坏/i.test(e.message) ? '下载包损坏/网络不完整' : '未知原因')));
      throw new Error(`缺少 Java ${requiredMajor}，自动下载失败：${e.message}\n\n可能原因：${reason}。\n建议：检查网络连接、清理磁盘空间，或关掉可能占用 Java 文件的程序后重试。`);
    }
  }

  // 没找到合适的运行时：给出具体缺什么、现在有什么
  const have = (sel.available ?? []).map((j) => `${j.major} (${j.path})`).join('\n  ') || '（一个都没扫到）';
  const pref = sel.preferred?.path
    ? `当前设置的 Java 是 ${sel.preferred.major ?? '?'}（${sel.preferred.path}），不满足这个版本。\n`
    : '';
  throw new Error(
    `这个版本需要 Java ${requiredMajor}。\n` +
      pref +
      `本机可用的运行时：\n  ${have}\n` +
      `请安装 JDK ${requiredMajor} 后重试，或在设置里手动指定匹配的 Java。`
  );
}

/**
 * 启动一个实例。
 * opts: { gameDir, versionId, java, username, memory, dryRun, extraJvm, extraGame }
 * 返回 { child, command, nativesDir }（dryRun 时 child 为 null）
 */
export async function launch(opts = {}) {
  // 设置作为默认值；显式传入的 opts 优先（命令行调试时用得上）
  const s = getSettings();
  const gameDir = path.resolve(opts.gameDir ?? s.gameDir ?? DEFAULT_GAME_DIR).replace(/\\/g, '/');
  const versionsDir = path.join(gameDir, 'versions');
  const librariesDir = path.join(gameDir, 'libraries');
  const assetsDir = path.join(gameDir, 'assets');

  const versionId = opts.versionId;
  if (!versionId) {
    throw new Error(`缺少 versionId。可用实例：${listVersions(versionsDir).join(' | ')}`);
  }

  const { json: versionJson, jarPath, dir: versionDir } = loadVersion(versionsDir, versionId);
  if (!jarPath) throw new Error('找不到 client jar，无法启动');
  if (!fs.existsSync(assetsDir)) throw new Error(`找不到 assets 目录：${assetsDir}`);

  // 版本隔离：实例目录里若已有 mods/saves/options.txt 之类，就把 gameDir 指向实例目录。
  // 版本隔离按这个方式工作；不做这步，模组和存档都不会被加载。
  const isolationMarkers = ['mods', 'saves', 'options.txt', 'config'];
  const looksIsolated = isolationMarkers.some((m) => fs.existsSync(path.join(versionDir, m)));
  const isoMode = opts.isolated !== undefined ? (opts.isolated ? 'on' : 'off') : (s.isolated ?? 'auto');
  const isolated = isoMode === 'on' || (isoMode === 'auto' && looksIsolated);
  const effectiveGameDir = isolated ? versionDir.replace(/\\/g, '/') : gameDir;

  const ctx = { os: detectOs(), features: {} };
  const { classpath, natives, missing } = resolveLibraries(versionJson, librariesDir, ctx);

  // natives 解压到独立临时目录，避免污染实例
  const nativesDir = path.join(os.tmpdir(), `mc-natives-${versionId.replace(/[^\w.-]/g, '_')}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(nativesDir, { recursive: true });

  // 目录结构跟着 jvm 参数走：
  //   旧版平铺在根，新版按 java/lwjgl/jna/netty 分子目录。
  // JVM 的 java.library.path 不递归搜索，结构错了就是
  // "Failed to locate library: lwjgl.dll"。
  const nativeSubdirs = detectNativeSubdirs(versionJson.arguments?.jvm);
  const extracted = [];
  for (const n of natives) {
    try {
      if (nativeSubdirs.length) {
        // 每个子目录都放一份并拍平路径，成本很低，但能避开按 jar 名猜归属的脆弱逻辑
        for (const sub of nativeSubdirs) {
          extracted.push(
            ...extractNatives(n.jarPath, path.join(nativesDir, sub), ['.dll', '.so', '.dylib'], { flatten: true })
          );
        }
      } else {
        extracted.push(...extractNatives(n.jarPath, nativesDir, ['.dll', '.so', '.dylib'], { flatten: true }));
      }
    } catch (e) {
      console.warn(`[warn] natives 解压失败 ${n.name}: ${e.message}`);
    }
  }

  const username = opts.username ?? s.username ?? 'Player';

  // 账号：没显式传就用当前选中的；正版快过期就先续一下。
  // 续失败不能挡住离线启动，但要告诉用户为什么掉回离线。
  let account = opts.account ?? (await currentAccount());
  if (account?.type === 'microsoft') {
    try {
      account = await msEnsureFresh(account);
    } catch (e) {
      console.warn(`[warn] 正版令牌刷新失败，改用离线身份：${e.message}`);
      account = null;
    }
  } else if (account?.type === 'yggdrasil' && account.refreshToken) {
    // 第三方 token 有时效，过期就尝试续一次；失败也不拦启动
    try {
      const { yggdrasilRefresh } = await import('./auth.js');
      account = await yggdrasilRefresh(account);
    } catch {
      /* 用旧 token 试一把 */
    }
  }

  const identity = buildIdentityVars(account, username, crypto);

  const vars = {
    ...identity,
    // 原版参数里有 "--clientId ${clientid}"。substituteAll 只会丢掉
    // 含未解析占位符的那一个 token，于是 --clientId 会留着，
    // 把紧跟其后的 --xuid 当成自己的值吞掉（xuid 也跟着坏）。
    // 所以这里必须给 clientid 一个值，保持成对参数完整。
    clientid: account?.clientId ?? '',
    version_name: versionId,
    game_directory: effectiveGameDir,
    assets_root: assetsDir,
    assets_index_name: versionJson.assetIndex?.id ?? versionJson.assets ?? 'legacy',
    version_type: versionJson.type ?? 'release',
    natives_directory: nativesDir,
    launcher_name: 'sakura-launcher',
    launcher_version: APP_VERSION,
    classpath: classpathString([...classpath, jarPath]),
    // Forge/NeoForge 的 jvm 参数是拿这两个拼模块路径的：
    //   -p ${library_directory}/cpw/mods/bootstraplauncher/...${classpath_separator}...
    // 而 substituteAll 会把「替换后还带占位符」的参数整条丢掉，
    // 所以缺了这两个变量，Forge 的 -p 会被静默删掉，装好了也起不来。
    library_directory: librariesDir.replace(/\\/g, '/'),
    classpath_separator: path.delimiter,
    // 让通过 MCP/HTTP 等方式启动的实例也能找到自己的资源
    assets_root_hint: assetsDir,
  };

  // java 优先级：opts.java > 设置里的 javaPath > 自动扫
  const java = await resolveJavaBin(
    { ...opts, java: opts.java ?? s.javaPath ?? '' },
    versionJson
  );
  const javaBin = java.bin;
  // 内存与额外参数也跟设置走；opts.extraJvm 只作为叠加。
  // 编码参数两套都带上：Java 8-17 认 sun.*，Java 18+ 认 stdout.encoding；
  // 不这么做，中文 Windows 下游戏 stdout 走 GBK，日志面板会看到 �。
  const extraJvm = [
    ...(opts.useSettingsMemory === false ? [] : memoryArgs({ ...s, ...(opts.memory ?? {}) })),
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    ...jvmPresetArgs(s.jvmPreset),
    ...splitArgs(s.extraJvm),
    ...(opts.extraJvm ?? []),
  ];
  const extraGame = [...splitArgs(s.extraGame), ...(opts.extraGame ?? [])];

  // 插件：用户自己写的启动参数调整。
  // 放在设置参数之后、账号相关参数之前 —— 插件拿到的 api 是设置快照，
  // 不包含账号密码这类东西。插件炸了只记日志，不拦启动。
  const plug = await collectPluginArgs({
    memoryMin: s.memoryMin,
    memoryMax: s.memoryMax,
    username: vars.auth_player_name,
    instance: opts.versionId ?? vars.version_name,
    gameVersion: versionJson.inheritsFrom ?? versionJson.id ?? '',
    loader: versionJson.mainClass ?? '',
  });
  if (plug.extraJvm.length) extraJvm.push(...plug.extraJvm);
  if (plug.extraGame.length) extraGame.push(...plug.extraGame);
  for (const err of plug.errors) console.warn(`[plugin] ${err}`);

  // 有些版本的 arguments 里没有 --userType（实测 1.21.11-Fabric、26.2、26.3、RLCraft 都缺）。
  // 正版/第三方登录缺它就会被当成 legacy 身份，认证直接失败，所以缺了就补上。
  const hasUserType = /userType|user_type/i.test(JSON.stringify(versionJson.arguments?.game ?? []));
  if (!hasUserType && account && account.type !== 'offline') {
    const ut = account.type === 'microsoft' ? 'msa' : 'mojang';
    extraGame.push('--userType', ut);
  }

  // 第三方账号必须挂 authlib-injector，否则客户端会把令牌发给 Mojang 官方验，直接登录失败
  if (account?.type === 'yggdrasil' && account.server) {
    const inj = await ensureAuthlibInjector((msg) => console.log(`[authlib] ${msg}`));
    // prefetched 必须是 metadata JSON 的 base64，不能是 URL 本身。
    // 取不到就只留 -javaagent=<url>，让 injector 自己拉。
    let prefetched = null;
    try {
      const res = await fetch(`${account.server.replace(/\/+$/, '')}/`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const text = await res.text();
        JSON.parse(text); // 确认不是 HTML
        prefetched = Buffer.from(text, 'utf8').toString('base64');
      }
    } catch {
      /* 预取失败不阻塞启动，javaagent URL 仍可用 */
    }
    extraJvm.unshift(`-javaagent:${inj.jarPath}=${account.server}`);
    if (prefetched) extraJvm.unshift(`-Dauthlibinjector.yggdrasil.prefetched=${prefetched}`);
    else console.log('[authlib] 预取失败，改用 -javaagent URL 自取 metadata');
  }

  const cmd = buildLaunchCommand({
    versionJson,
    javaBin,
    vars,
    ctx,
    jvmBase: [],
    extraJvm,
    extraGame,
  });

  const result = {
    command: { java: cmd.javaBin, args: cmd.args },
    javaBin: cmd.javaBin,
    javaActual: java.major,
    javaRequired: versionJson.javaVersion?.majorVersion ?? null,
    nativesDir,
    extractedNatives: extracted,
    missingLibraries: missing,
    unresolved: cmd.unresolved,
    classpathCount: classpath.length,
    account: account ? { type: account.type, name: account.name } : { type: 'offline', name: username },
  };

  if (opts.dryRun) return { ...result, child: null };

  const child = spawn(cmd.javaBin, cmd.args, {
    cwd: versionDir,
    // stdin 不给 java（它不读），stdout/stderr 必须 pipe：
    // server.js 要双写进终端和日志面板，inherit 时 child.stdout 是 null。
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  return { ...result, child };
}

export { listVersions, loadVersion };
