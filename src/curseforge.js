/**
 * CurseForge API 客户端（经 MCIM 镜像）
 *
 * 为什么走镜像：
 *   官方 api.curseforge.com 必须带 x-api-key，而 key 的申请入口只有
 *   「用 Google 登录 console.curseforge.com」这一条路 —— 本机网络下
 *   accounts.google.com 直接 ECONNABORTED，申请不了。
 *   mod.mcimirror.top 是国内公开的 CF API 镜像（PCL2 也在用），
 *   接口形状与官方一致，且它返回的 downloadUrl 指向官方 CDN，
 *   文件本身仍是 CurseForge 提供。
 *
 * 实测（2026-10-24，本机）：
 *   slug 精确搜索    200   540ms  命中 id=925200 "All the Mods 10 - ATM10"
 *   文件列表         200   200ms  id=9190157 8.3.zip 190.8MB
 *   文件下载         200  6.6s/6.3MB  魔数 504b0304 = ZIP ✅
 *   封面 256 缩略图  200  127KV PNG ✅
 *
 * 重要：这是第三方镜像，不是官方承诺。它可能限速/停服，
 * 所以所有调用都带超时，失败时由上层回落到 Modrinth 或手动路径，
 * 绝不能让它变成硬依赖。
 */

const MCIM = 'https://mod.mcimirror.top/curseforge/v1';
const UA = 'mclauncher/0.1 (local)';

/** CurseForge 的 gameId：Minecraft 固定 432 */
const GAME_ID = 432;

/**
 * classId 与界面四个分类的对应。
 * 这些值是 CF 官方 API 的固定常量，不随项目变。
 */
export const CF_CLASS = {
  mod: 6,
  modpack: 4471,
  shader: 6552,
  resourcepack: 12,
};

/** 加载器 → CF 的 modLoaderType 数值 */
const LOADER_TYPE = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

/**
 * CF 的 modLoaderType 反查成名字，前端要用。
 * 1=Forge 2=Cauldron 3=LiteLoader 4=Fabric 5=Quilt 6=NeoForge
 */
function loaderName(t) {
  return { 1: 'forge', 2: 'cauldron', 3: 'liteloader', 4: 'fabric', 5: 'quilt', 6: 'neoforge' }[t] ?? null;
}

/** 所有请求统一的超时包装：镜像挂了不能让界面卡死 */
async function mcimGet(pathAndQuery, timeout = 20000) {
  const url = `${MCIM}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CurseForge 镜像返回 ${res.status}${text ? '：' + text.slice(0, 120) : ''}`);
  }
  return res.json();
}

/** 封面图统一取 256 缩略图（原图动辄 1MB，列表里浪费流量） */
function pickLogo(mod) {
  const t = mod?.logo?.thumbnailUrl;
  const raw = mod?.logo?.url;
  // thumbnailUrl 已经是 .../256/256/xxx.png，直接用；没有就退原图
  return t || raw || null;
}

function normalizeHit(m) {
  return {
    source: 'curseforge',
    id: m.id,
    slug: m.slug,
    title: m.name,
    description: m.summary ?? '',
    author: (m.authors ?? [])[0]?.name ?? null,
    downloads: m.downloadCount ?? 0,
    follows: m.thumbsUpCount ?? 0,
    iconUrl: pickLogo(m),
    categories: (m.categories ?? []).map((c) => c.name),
    gameVersions: (m.latestFilesIndexes ?? []).map((f) => f.gameVersion).filter(Boolean),
    updated: m.dateModified ?? null,
    classId: m.classId,
  };
}

/**
 * 搜索。
 * opts: { type, query, gameVersion, loader, limit, offset, sortBy }
 * sortBy: relevance | downloads | newest | updated
 *
 * 注意：CF 的 searchFilter 目前对中文/长句匹配很差，所以优先用
 *       slug 精确匹配 —— 实例名/包名常常就是 slug。
 */
export async function searchProjects(opts = {}) {
  const {
    type = 'mod',
    query = '',
    gameVersion,
    loader,
    limit = 20,
    offset = 0,
    sortBy = 'relevance',
  } = opts;

  const classId = CF_CLASS[type];
  if (!classId) throw new Error(`CurseForge 不支持的类型：${type}`);

  const params = new URLSearchParams({
    gameId: String(GAME_ID),
    classId: String(classId),
    index: String(Math.max(offset, 0)),
    pageSize: String(Math.min(Math.max(limit, 1), 50)),
  });

  if (query.trim()) params.set('searchFilter', query.trim());
  if (gameVersion) params.set('gameVersion', gameVersion);

  const loaderType = LOADER_TYPE[loader];
  // 光影/资源包没有加载器概念，只有 mod 和整合包才传
  if (loaderType && (type === 'mod' || type === 'modpack')) {
    params.set('modLoaderType', String(loaderType));
  }

  const sortKey = { relevance: 2, downloads: 6, newest: 11, updated: 3 }[sortBy];
  if (sortKey) params.set('sortField', String(sortKey));

  const data = await mcimGet(`/mods/search?${params}`);
  const list = data?.data ?? [];

  return {
    source: 'curseforge',
    total: data?.pagination?.totalCount ?? list.length,
    hits: list.map(normalizeHit),
  };
}

/** 按 slug 精确拿一个项目（用于反查封面、确认存在） */
export async function getProjectBySlug(slug) {
  const data = await mcimGet(`/mods/search?gameId=${GAME_ID}&slug=${encodeURIComponent(slug)}`);
  const hit = (data?.data ?? [])[0];
  return hit ? normalizeHit(hit) : null;
}

/** 按 id 拿项目详情 */
export async function getProject(id) {
  const data = await mcimGet(`/mods/${id}`);
  const m = data?.data;
  if (!m) throw new Error('CurseForge 项目不存在');
  return {
    ...normalizeHit(m),
    body: m.links?.websiteUrl ? '' : '',
    websiteUrl: m.links?.websiteUrl ?? null,
    screenshots: (m.screenshots ?? []).map((s) => s.thumbnailUrl ?? s.url),
  };
}

/**
 * 文件列表。
 * opts: { gameVersion, loader, limit }
 * 返回按发布时间倒序，且每个文件都带可下载 url。
 */
export async function getProjectFiles(id, opts = {}) {
  const { gameVersion, loader, limit = 50 } = opts;

  const params = new URLSearchParams({ pageSize: String(Math.min(limit, 50)) });
  if (gameVersion) params.set('gameVersion', gameVersion);

  const loaderType = LOADER_TYPE[loader];
  if (loaderType) params.set('modLoaderType', String(loaderType));

  const data = await mcimGet(`/mods/${id}/files?${params}`);
  const files = data?.data ?? [];

  return files.map((f) => ({
    id: f.id,
    name: f.displayName ?? f.fileName,
    fileName: f.fileName,
    size: f.fileLength ?? 0,
    url: f.downloadUrl ?? null,
    // downloadUrl 为空 = 作者关闭了第三方分发，只能去官网手动下
    distributable: Boolean(f.downloadUrl),
    releaseType: { 1: 'release', 2: 'beta', 3: 'alpha' }[f.releaseType] ?? 'release',
    gameVersions: f.gameVersions ?? [],
    loaders: (f.sortableGameVersions ?? []).map((g) => g.gameVersionName).filter(Boolean),
    datePublished: f.fileDate ?? null,
    downloads: f.downloadCount ?? 0,
  }));
}

/**
 * 取整合包最新一个能下的文件。
 * 装整合包只需要这一个：CF 的整合包是一个 zip，里面已有完整清单。
 */
export async function getLatestPackFile(id, { gameVersion } = {}) {
  const files = await getProjectFiles(id, { gameVersion, limit: 50 });
  const downloadable = files.find((f) => f.distributable);
  if (!downloadable) {
    throw new Error('这个整合包没有可下载的文件（作者可能关闭了第三方分发）');
  }
  return downloadable;
}

/**
 * 这个文件是不是 CF 的整合包 zip（而不是 mrpack）。
 * CF 的整合包是 manifest.json + overrides/，与 Modrinth 的 mrpack 不同。
 */
export function isCurseForgePack() {
  return true;
}

export { MCIM as CF_MIRROR_BASE, GAME_ID as CF_GAME_ID };
