/**
 * 标准 CurseForge 整合包 zip：manifest.files 只给 projectID/fileID，
 * 需要补下载文件，并以第 5 件的 required 依赖链路补齐依赖。
 */
import fs from 'node:fs';
import path from 'node:path';

import { getCurseForgeFile, parseLoader } from './cfpack.js';
import { resolveRequiredDependencies } from './dependencies.js';
import { installContent } from './content.js';

export async function installCfManifestMods({ gameDir, versionId, manifest }) {
  const gameVersion = String(manifest?.minecraft?.version || '');
  const loader = parseLoader(manifest?.minecraft?.modLoaders || []).kind || '';
  const modsDir = path.join(gameDir, 'versions', versionId, 'mods');
  let existing = new Set();
  try {
    existing = new Set(fs.readdirSync(modsDir).map((n) => n.toLowerCase()));
  } catch { /* 目录还不存在 */ }

  const roots = [];
  const initial = [];
  const skipped = [];
  const failed = [];
  const manifestFiles = (manifest?.files || []).filter((f) => f && f.required !== false);
  for (const item of manifestFiles) {
    const projectId = String(item.projectID ?? '');
    const fileId = String(item.fileID ?? '');
    try {
      const raw = await getCurseForgeFile(projectId, fileId);
      if (!raw) {
        failed.push({ name: projectId || fileId || '未知文件', reason: '镜像查不到这个文件' });
        continue;
      }
      const filename = String(raw.fileName || `${projectId}-${fileId}.jar`).split(/[\\/]/).pop();
      if (!raw.downloadUrl) {
        failed.push({ name: filename, reason: '作者关闭了第三方分发' });
        continue;
      }
      const file = {
        url: raw.downloadUrl,
        filename,
        sha1: raw.hashes?.find((h) => h.algo === 1)?.value || null,
        size: raw.fileLength || raw.fileLength,
        source: 'curseforge',
        projectId,
        dependencies: (raw.dependencies || [])
          .filter((d) => d.relationType === 3)
          .map((d) => ({ projectId: d.modId, dependencyType: 'required' })),
      };
      initial.push(file);
      if (existing.has(filename.toLowerCase())) {
        skipped.push({ name: filename, reason: '已存在' });
        continue;
      }
      roots.push(file);
    } catch (e) {
      failed.push({ name: projectId || fileId || '未知文件', reason: e.message || '查询失败' });
    }
  }

  let dep = { files: [], added: 0, failed: [] };
  try {
    dep = await resolveRequiredDependencies({
      source: 'curseforge',
      gameVersion,
      loader,
      files: initial,
      maxDepth: 3,
    });
  } catch (e) {
    failed.push({ name: '依赖解析', reason: e.message });
  }

  const installList = [...roots, ...(dep.files || [])];
  let installed = [];
  if (installList.length) {
    const r = await installContent({
      gameDir,
      versionId,
      projectType: 'mod',
      files: installList,
    });
    installed = (r.installed || []).map((x) => x.name);
    for (const f of r.failed || []) failed.push({ name: f.name, reason: f.error });
  }
  for (const f of dep.failed || []) failed.push({ name: f.name, reason: f.reason });

  return {
    installed,
    skipped,
    failed,
    loader,
    gameVersion,
    manifestCount: manifestFiles.length,
  };
}
