/**
 * 内容依赖解析：只补 required，最多 3 层，已访问项目不重复。
 * 解析失败的依赖只记录，不抛给整包安装。
 */
import { getProjectVersions } from './modrinth.js';
import { getProjectFiles } from './curseforge.js';

const REQUIRED = (d) => d?.dependencyType === 'required' || d?.relationType === 3;
const primaryFile = (files) => (files ?? []).find((f) => f.primary) ?? files?.[0];

export async function resolveRequiredDependencies({
  source,
  gameVersion,
  loader,
  files = [],
  maxDepth = 3,
  onProgress = () => {},
}) {
  const out = [];
  const failed = [];
  const visited = new Set();
  const queue = [];
  const enqueue = (deps, depth) => {
    for (const d of deps ?? []) {
      if (!REQUIRED(d) || !d.projectId) continue;
      const key = String(d.projectId);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ projectId: key, depth });
    }
  };
  for (const f of files) {
    if (f.projectId) visited.add(String(f.projectId));
    enqueue(f.dependencies, 1);
  }
  let done = 0;
  const totalHint = queue.length;
  while (queue.length) {
    const item = queue.shift();
    done += 1;
    onProgress({
      stage: 'dependencies',
      done,
      total: Math.max(totalHint, done),
      message: `解析依赖 ${done}`,
    });
    if (item.depth > maxDepth) continue;
    try {
      let candidate = null;
      let depSource = source;
      if (source === 'modrinth') {
        const versions = await getProjectVersions(item.projectId, { gameVersion, loader });
        candidate = versions.find((v) => {
          if (gameVersion && !v.gameVersions?.includes(gameVersion)) return false;
          if (loader && !v.loaders?.includes(loader)) return false;
          return Boolean(primaryFile(v.files));
        }) || null;
        if (candidate) candidate.source = 'modrinth';
      } else if (source === 'curseforge') {
        const versions = await getProjectFiles(item.projectId, { gameVersion, loader });
        candidate = versions.find((v) => {
          if (!v.distributable) return false;
          if (gameVersion && !v.gameVersions?.includes(gameVersion)) return false;
          if (loader && !v.loaders?.includes(loader)) return false;
          return Boolean(v.url);
        }) || null;
        if (candidate) candidate.source = 'curseforge';
      } else {
        continue;
      }
      if (!candidate) {
        failed.push({ name: item.projectId, projectId: item.projectId, reason: '没有匹配当前游戏版本/加载器的版本' });
        continue;
      }
      const f = primaryFile(candidate.files) || candidate;
      if (!f?.url) {
        failed.push({ name: f?.filename || item.projectId, projectId: item.projectId, reason: '没有可下载文件' });
        continue;
      }
      out.push({
        url: f.url,
        filename: f.filename || f.fileName || f.name || `${item.projectId}.jar`,
        sha1: f.sha1 || null,
        size: f.size || 0,
        source: candidate.source || depSource,
        projectId: item.projectId,
        dependencies: candidate.dependencies || [],
      });
      enqueue(candidate.dependencies, item.depth + 1);
    } catch (e) {
      failed.push({ name: item.projectId, projectId: item.projectId, reason: e.message || '解析失败' });
    }
  }
  return { files: out, added: out.length, failed };
}
