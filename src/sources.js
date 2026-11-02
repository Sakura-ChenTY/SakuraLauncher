/**
 * 下载源与镜像改写
 *
 * 设计目标（对齐 PCL 的「下载源」设置）：
 *   1. 允许用户手动锁定一个源（官方 / BMCLAPI），也允许自动测速挑选
 *   2. 每个源只声明「它能把哪些官方地址映射到哪」，映射必须实测可用
 *   3. 下载失败时仍能回退到官方，任何一个源的偶发失败不该毁掉整个安装
 *
 * 本机实测（2026-10-23，RTX 机器 / 家宽）：
 *
 *   assets（20 个真实资源对象，逐个校验 SHA1）
 *     官方 resources  20/20 成功   有效吞吐 356 KB/s
 *     BMCLAPI         19/20 成功   有效吞吐  60 KB/s（1 个 25s 超时）
 *
 *   libraries（8 个真实 jar，全部校验字节）
 *     官方            8/8         730 KB/s   中位延迟 849ms
 *     BMCLAPI         8/8         287 KB/s   中位延迟 842ms
 *
 *   结论：延迟差不多，吞吐官方更好。但这台机器是特例，
 *   别人可能在官方全红的环境里，所以必须留选择权，而不是写死官方。
 *
 * ⚠️ Forge 的 maven 不要走 BMCLAPI：
 *   maven-metadata.xml 官方 5094 个版本（最新 26.3-66.1.0），
 *   镜像只有 3839 个（最新 1.1-1.3.2.3）——镜像元数据是旧的。
 *   走镜像会「查不到新版本」，所以 FORGE_MAVEN 不加入任何镜像规则。
 */

/** BMCLAPI 的映射规则：官方前缀 -> 镜像前缀 */
const BMCLAPI_RULES = [
  // 版本清单 / 版本 JSON
  [/^https?:\/\/launchermeta\.mojang\.com\//, 'https://bmclapi2.bangbang93.com/'],
  [/^https?:\/\/piston-meta\.mojang\.com\//, 'https://bmclapi2.bangbang93.com/'],
  [/^https?:\/\/piston-data\.mojang\.com\//, 'https://bmclapi2.bangbang93.com/'],
  [/^https?:\/\/launcher\.mojang\.com\//, 'https://bmclapi2.bangbang93.com/'],
  // 库文件（实测字节一致）
  [/^https?:\/\/libraries\.minecraft\.net\//, 'https://bmclapi2.bangbang93.com/maven/'],
  // Fabric / Quilt 的 maven（实测 fabric-loader jar 字节一致）
  [/^https?:\/\/maven\.fabricmc\.net\//, 'https://bmclapi2.bangbang93.com/maven/'],
  // 资源对象
  [/^https?:\/\/resources\.download\.minecraft\.net\//, 'https://bmclapi2.bangbang93.com/assets/'],
];

/**
 * 源注册表。
 * rules 为空表示「不改写，只用官方地址」。
 * 不支持镜像的地址会自动落回官方，这是安全默认。
 */
export const SOURCES = {
  official: {
    id: 'official',
    name: '官方',
    note: 'Mojang 官方线路。海外或线路好时最快',
    rules: [],
  },
  bmclapi: {
    id: 'bmclapi',
    name: 'BMCLAPI（bangbang93 镜像）',
    note: '国内镜像。官方被墙或超时严重时用它',
    rules: BMCLAPI_RULES,
  },
};

export const SOURCE_IDS = Object.keys(SOURCES);

/** auto = 安装前测速挑最快的；其余为锁定该源 */
export const VALID_SOURCE_SETTINGS = ['auto', ...SOURCE_IDS];

/**
 * 判定某个 URL 是「官方域名」还是别处。
 * 只有认识这些域名才谈得上替换；Modrinth / 自建仓库一律原样不动。
 */
export function toMirror(url, sourceId = 'bmclapi') {
  const src = SOURCES[sourceId];
  if (!src || !src.rules?.length) return null;
  for (const [re, prefix] of src.rules) {
    if (re.test(url)) return url.replace(re, prefix);
  }
  return null;
}

/** 这个 URL 是否属于可镜像范围（用于统计「真实镜像命中率」） */
export function isMirrorable(url) {
  return BMCLAPI_RULES.some(([re]) => re.test(url));
}

/**
 * 生成候选 URL：主选在前，另一个源在后作兜底。
 *
 * 兼容老签名 candidateUrls(url, { preferMirror })：
 *   preferMirror=true 等价于 source='bmclapi'
 *
 * 兜底逻辑：无论主选谁，另一个源都跟在后面。
 * 这样官方偶尔 500、或镜像偶发超时，都不会让整个安装失败。
 */
export function candidateUrls(url, opts = {}) {
  const { preferMirror = false, source, fallback = true } = opts;
  const primaryId = source ?? (preferMirror ? 'bmclapi' : 'official');

  const primary = primaryId === 'official' ? url : toMirror(url, primaryId);
  const list = [primary ?? url];

  if (fallback) {
    // 另一侧兜底
    const altId = primaryId === 'official' ? 'bmclapi' : 'official';
    const alt = altId === 'official' ? url : toMirror(url, altId);
    if (alt && alt !== list[0]) list.push(alt);
  }

  return [...new Set(list)];
}

/** 老的默认 URL 常量，保留给已有调用 */
export const VERSION_MANIFEST_URL =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

export const RESOURCES_BASE = 'https://resources.download.minecraft.net';

/** Forge / NeoForge 的 maven —— 明确不镜像（镜像元数据滞后） */
export const FORGE_MAVEN = 'https://maven.minecraftforge.net/';
export const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/';

/**
 * NeoForge 官方 maven 在国内直连超时（实测 2026-10-24：连三次全 UND_ERR_CONNECT_TIMEOUT，10s+）。
 * BMCLAPI 的 maven 镜像实测可用：1846 个版本、安装器均为合法 zip。
 * 所以 NeoForge 优先走镜像，官方放最后当兜底。
 */
export const NEOFORGE_MAVEN_MIRROR = 'https://bmclapi2.bangbang93.com/maven/';
