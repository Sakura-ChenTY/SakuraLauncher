/**
 * Modrinth API 客户端
 *
 * 为什么用 Modrinth 而不是 CurseForge：
 *   Modrinth 的 API 免费、无需 key、允许直接 CDN 下载，且四类项目
 *   （mod / modpack / shader / resourcepack）用同一套接口，不需要
 *   为每种内容写一遍逻辑。CurseForge 需要 API key 且下载要过授权。
 *
 * 实测（2026-10-23，本机）：
 *   mod 搜索            200  891ms  77560 条
 *   modpack 搜索        200  325ms  18903 条
 *   shader 搜索         200  331ms  1029 条
 *   resourcepack 搜索   200  326ms  36854 条
 *   版本过滤+加载器     200       18032 条
 *   项目版本列表        200       258 条（sodium）
 *
 * 限流：Modrinth 要求 300 请求/分钟，并且要求带可识别的 UA。
 */
import { fetchJson, fetchText } from './download.js';

const BASE = 'https://api.modrinth.com/v2';

/** 允许的项目类型 —— 与界面上的四个分类一一对应 */
export const PROJECT_TYPES = {
  mod: { folder: 'mods', label: 'Mod' },
  modpack: { folder: null, label: '整合包' },
  shader: { folder: 'shaderpacks', label: '光影包' },
  resourcepack: { folder: 'resourcepacks', label: '资源包' },
};

/**
 * 搜索项目。
 * opts: { type, query, gameVersion, loader, limit, offset, sortBy }
 * sortBy: relevance | downloads | follows | newest | updated
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

  if (!PROJECT_TYPES[type]) throw new Error(`不支持的项目类型：${type}`);

  // facets 是「数组的数组」，内层数组之间是 AND，内层元素之间是 OR
  const facets = [[`project_type:${type}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);

  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    index: sortBy,
    facets: JSON.stringify(facets),
  });
  if (query.trim()) params.set('query', query.trim());

  const data = await fetchJson(`${BASE}/search?${params}`, { timeout: 25000 });

  return {
    total: data.total_hits ?? 0,
    hits: (data.hits ?? []).map(normalizeHit),
  };
}

function normalizeHit(h) {
  return {
    // 前端多选来源后要把两边的结果混在一张列表里，点「装」时必须知道
    // 这一条是哪个来源的 —— 两个来源装包走的是完全不同的接口。
    source: 'modrinth',
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    downloads: h.downloads,
    follows: h.follows,
    iconUrl: h.icon_url,
    categories: h.categories ?? [],
    versions: h.versions ?? [],
    projectType: h.project_type,
    updated: h.date_modified,
  };
}

/**
 * 取某个项目的版本列表。
 * 返回值已按「能用于当前游戏版本/加载器」优先排序，前端可直接展示。
 */
export async function getProjectVersions(slugOrId, { gameVersion, loader } = {}) {
  const all = await fetchJson(`${BASE}/project/${encodeURIComponent(slugOrId)}/version`, {
    timeout: 25000,
  });
  if (!Array.isArray(all)) return [];

  const mapped = all.map((v) => ({
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions ?? [],
    loaders: v.loaders ?? [],
    releaseType: v.version_type,
    datePublished: v.date_published,
    downloads: v.downloads,
    files: (v.files ?? []).map((f) => ({
      filename: f.filename,
      url: f.url,
      size: f.size,
      sha1: f.hashes?.sha1 ?? null,
      primary: Boolean(f.primary),
    })),
    dependencies: (v.dependencies ?? [])
      .filter((d) => d.dependency_type === 'required')
      .map((d) => ({
        projectId: d.project_id,
        versionId: d.version_id,
        dependencyType: 'required',
      })),
  }));

  // 兼容性排序：游戏版本命中 > 加载器命中 > 发布时间新
  const score = (v) => {
    let s = 0;
    if (gameVersion && v.gameVersions.includes(gameVersion)) s += 100;
    if (loader && v.loaders.includes(loader)) s += 50;
    if (v.releaseType === 'release') s += 10;
    return s;
  };

  return mapped.sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return String(b.datePublished).localeCompare(String(a.datePublished));
  });
}

/** 项目详情（含正文描述，用于详情面板） */
export async function getVersionFileByHash(hash, { algorithm = 'sha1' } = {}) {
  const h = String(hash || '').trim().toLowerCase();
  if (!h) return null;
  const v = await fetchJson(`${BASE}/version_file/${encodeURIComponent(h)}?algorithm=${encodeURIComponent(algorithm)}`, {
    timeout: 20000,
  });
  return {
    id: v.id,
    projectId: v.project_id,
    versionNumber: v.version_number,
    gameVersions: v.game_versions ?? [],
    loaders: v.loaders ?? [],
    clientSide: v.client_side || '',
    serverSide: v.server_side || '',
    files: (v.files ?? []).map((f) => ({
      filename: f.filename,
      url: f.url,
      size: f.size,
      sha1: f.hashes?.sha1 ?? null,
      sha512: f.hashes?.sha512 ?? null,
      primary: Boolean(f.primary),
    })),
    dependencies: (v.dependencies ?? []).map((d) => ({
      projectId: d.project_id,
      versionId: d.version_id,
      dependencyType: d.dependency_type,
    })),
  };
}

export async function getProject(slugOrId) {
  const p = await fetchJson(`${BASE}/project/${encodeURIComponent(slugOrId)}`, { timeout: 25000 });
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body ?? '',
    iconUrl: p.icon_url,
    downloads: p.downloads,
    projectType: p.project_type,
    categories: p.categories ?? [],
    loaders: p.loaders ?? [],
    gameVersions: p.game_versions ?? [],
  };
}

/**
 * 检测实例用的是哪个加载器，供搜索过滤使用。
 * 返回 'fabric' | 'forge' | 'neoforge' | 'quilt' | null（原版）
 */
export function detectLoaderFromVersionJson(versionJson) {
  if (!versionJson) return null;

  const mainClass = String(versionJson.mainClass ?? '');
  if (/knot/i.test(mainClass)) return 'fabric';
  if (/quilt/i.test(mainClass)) return 'quilt';
  if (/neoforge/i.test(mainClass)) return 'neoforge';
  if (/forge/i.test(mainClass)) return 'forge';

  const id = String(versionJson.id ?? '').toLowerCase();
  if (id.includes('fabric')) return 'fabric';
  if (id.includes('quilt')) return 'quilt';
  if (id.includes('neoforge')) return 'neoforge';
  if (id.includes('forge')) return 'forge';

  const libNames = (versionJson.libraries ?? []).map((l) => String(l.name ?? '')).join(' ');

  // 顺序很重要：NeoForge 21.1+ 依赖 net.fabricmc:sponge-mixin（Fabric 的 Mixin 移植版），
  // 所以「有 net.fabricmc 库」不等于就是 Fabric。实测 nf-sparky-test 被误判成 fabric。
  // 先认 neoforge / forge 这两个明确的牌子，再退到 fabric。
  if (/net\.neoforged/.test(libNames)) return 'neoforge';
  if (/net\.minecraftforge/.test(libNames)) return 'forge';
  if (/org\.quiltmc/.test(libNames)) return 'quilt';
  if (/net\.fabricmc/.test(libNames)) return 'fabric';

  return null;
}

export { BASE as MODRINTH_BASE, fetchText };
