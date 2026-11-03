/**
 * 启动前文件校验与补齐。
 *
 * 只做存在性 + 大小检查，不解压、不哈希全量；发现缺失时优先复用现有的
 * Forge/NeoForge 安装器，普通客户端文件和库则按版本 JSON 的下载地址补齐。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadVersion } from './version.js';
import { resolveLibraries } from './classpath.js';
import { detectOs } from './rules.js';
import { flattenArguments } from './args.js';
import { downloadFile } from './download.js';
import { installForge, installNeoForge } from './forge.js';

function fileState(file, expectedSize = 0) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size <= 0) return 'missing';
    if (expectedSize && st.size !== expectedSize) return 'size';
    return 'ok';
  } catch {
    return 'missing';
  }
}

function parseFmlArgs(versionJson, ctx) {
  const out = {};
  const args = flattenArguments(versionJson.arguments?.game ?? [], ctx);
  for (let i = 0; i < args.length - 1; i += 1) {
    const key = String(args[i]);
    if (key.startsWith('--fml.')) out[key] = String(args[i + 1]);
  }
  return out;
}

function addMissing(list, file, kind, label, extra = {}) {
  if (!file) return;
  if (fileState(file, extra.size) === 'ok') return;
  if (list.some((x) => x.path === file)) return;
  list.push({ kind, label, path: file, ...extra });
}

export function inspectVersion({ gameDir, versionId }) {
  const versionsDir = path.join(gameDir, 'versions');
  const librariesDir = path.join(gameDir, 'libraries');
  const assetsDir = path.join(gameDir, 'assets');
  const { json: versionJson, jarPath, dir } = loadVersion(versionsDir, versionId);
  const ctx = { os: detectOs(), features: {} };
  const missing = [];

  const clientDl = versionJson.downloads?.client;
  if (!jarPath || fileState(jarPath, clientDl?.size || 0) !== 'ok') {
    const expected = jarPath || path.join(dir, `${versionId}.jar`);
    addMissing(missing, expected, 'client-jar', '客户端 jar', {
      url: clientDl?.url,
      sha1: clientDl?.sha1,
      size: clientDl?.size || 0,
    });
  }

  const libs = resolveLibraries(versionJson, librariesDir, ctx);
  for (const m of libs.missing) {
    addMissing(missing, m.expected, m.kind || 'library', m.name || '库文件', {
      url: m.url,
    });
  }

  const assetIndex = versionJson.assetIndex;
  if (assetIndex?.id || versionJson.assets) {
    const id = assetIndex?.id || versionJson.assets;
    const file = path.join(assetsDir, 'indexes', `${id}.json`);
    addMissing(missing, file, 'asset-index', `资源索引 ${id}.json`, {
      url: assetIndex?.url,
      sha1: assetIndex?.sha1,
    });
  }

  const fml = parseFmlArgs(versionJson, ctx);
  const mcVersion = fml['--fml.mcVersion'] || versionJson.inheritsFrom || '';
  if (fml['--fml.mcpVersion'] && fml['--fml.forgeVersion'] && mcVersion) {
    const clientVersion = `${mcVersion}-${fml['--fml.mcpVersion']}`;
    const forgeVersion = `${mcVersion}-${fml['--fml.forgeVersion']}`;
    addMissing(missing, path.join(librariesDir, 'net', 'minecraft', 'client', clientVersion, `client-${clientVersion}-srg.jar`), 'forge-client', 'Forge 客户端 srg jar');
    addMissing(missing, path.join(librariesDir, 'net', 'minecraft', 'client', clientVersion, `client-${clientVersion}-extra.jar`), 'forge-client', 'Forge 客户端 extra jar');
    addMissing(missing, path.join(librariesDir, 'net', 'minecraftforge', 'forge', forgeVersion, `forge-${forgeVersion}-client.jar`), 'forge-client', 'Forge 客户端 jar');
  }

  if (fml['--fml.neoForgeVersion']) {
    const lv = fml['--fml.neoForgeVersion'];
    addMissing(missing, path.join(librariesDir, 'net', 'neoforged', 'neoforge', lv, `neoforge-${lv}-client.jar`), 'neoforge-client', 'NeoForge 客户端 jar');
  }

  return {
    versionId,
    versionJson,
    dir,
    jarPath,
    missing,
    fml,
    gameVersion: mcVersion,
  };
}

async function fillGeneric(item, onStage) {
  if (!item.url) throw new Error(`没有下载地址：${item.label}`);
  onStage({ stage: 'preflight', status: 'repair', message: `补齐 ${item.label}` });
  await downloadFile(item.url, item.path, {
    sha1: item.sha1 || undefined,
    size: item.size || undefined,
    retries: 3,
    timeout: 180000,
  });
}

export async function ensureVersionFiles({ gameDir, versionId, onStage = () => {} }) {
  let info = inspectVersion({ gameDir, versionId });
  if (!info.missing.length) return { ok: true, repaired: false, missing: [], info };

  onStage({
    stage: 'preflight',
    status: 'missing',
    count: info.missing.length,
    missing: info.missing.map((x) => x.label),
    message: `缺 ${info.missing.length} 个文件，正在补齐`,
  });

  const forgeMissing = info.missing.some((x) => x.kind === 'forge-client');
  const neoMissing = info.missing.some((x) => x.kind === 'neoforge-client');
  let repairError = null;

  if (forgeMissing || neoMissing) {
    try {
      if (forgeMissing) {
        onStage({ stage: 'preflight', status: 'repair', message: '正在补齐 Forge 客户端文件…' });
        await installForge({
          gameDir,
          gameVersion: info.gameVersion,
          loaderVersion: info.fml['--fml.forgeVersion'],
          versionIdOverride: versionId,
          onStage: (p) => onStage({ stage: 'preflight', status: 'repair', message: p.message || '补齐 Forge 文件…' }),
        });
      } else {
        onStage({ stage: 'preflight', status: 'repair', message: '正在补齐 NeoForge 客户端文件…' });
        await installNeoForge({
          gameDir,
          gameVersion: info.gameVersion,
          loaderVersion: info.fml['--fml.neoForgeVersion'],
          onStage: (p) => onStage({ stage: 'preflight', status: 'repair', message: p.message || '补齐 NeoForge 文件…' }),
        });
      }
    } catch (e) {
      repairError = e;
    }
  }

  info = inspectVersion({ gameDir, versionId });
  for (const item of [...info.missing]) {
    if (['forge-client', 'neoforge-client'].includes(item.kind)) continue;
    try {
      await fillGeneric(item, onStage);
    } catch (e) {
      repairError = repairError || e;
    }
  }

  info = inspectVersion({ gameDir, versionId });
  if (info.missing.length) {
    const list = info.missing.map((x) => `- ${x.label}: ${x.path}`);
    const err = new Error(`这个版本缺 ${info.missing.length} 个文件，补不上：\n${list.join('\n')}`);
    err.code = 'PREFLIGHT_MISSING';
    err.missing = info.missing.map((x) => ({ label: x.label, path: x.path, kind: x.kind }));
    if (repairError?.message) err.detail = repairError.message;
    throw err;
  }

  return { ok: true, repaired: true, missing: [], info };
}
