/** 导出 Modrinth .mrpack：可识别文件进 files[]，其余进 overrides。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { writeZipStream } from './zipstream.js';
import { getVersionFileByHash } from './modrinth.js';

const DIRS = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'screenshots'];
const CLIENT_ONLY = new Set(['resourcepacks', 'shaderpacks', 'screenshots']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sha(buf, algorithm) {
  return crypto.createHash(algorithm).update(buf).digest('hex');
}

function safeFile(name) {
  return String(name || '').replace(/[<>:"|?*\x00-\x1f]/g, '_').trim() || 'pack';
}

function instanceMeta(gameDir, versionId) {
  const root = path.join(gameDir, 'versions', versionId);
  const version = readJson(path.join(root, `${versionId}.json`)) || {};
  const sidecar = readJson(path.join(root, 'launcher-instance.json')) || {};
  const tag = `${version.id || ''} ${version.inheritsFrom || ''} ${version.mainClass || ''}`;
  let loader = 'vanilla';
  if (/fabric/i.test(tag)) loader = 'fabric';
  else if (/neoforge/i.test(tag)) loader = 'neoforge';
  else if (/forge/i.test(tag)) loader = 'forge';
  else if (/quilt/i.test(tag)) loader = 'quilt';
  const loaderVersion = (/(?:forge|fabric|neoforge|quilt)[-_ ]?([\d][\w.-]*)/i.exec(tag) || [])[1] || '';
  return {
    root,
    version,
    loader,
    loaderVersion,
    gameVersion: version.inheritsFrom || version.id || versionId,
    packName: sidecar.packName || sidecar.name || version.name || versionId,
    packVersion: sidecar.packVersion || sidecar.version || '',
    summary: sidecar.summary || '',
  };
}

function walkFiles(root, dirs, selected) {
  const out = [];
  const walk = (dir, relBase) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) out.push({ full, rel });
    }
  };
  for (const d of dirs) {
    if (!selected.has(d)) continue;
    const full = path.join(root, d);
    if (fs.existsSync(full)) walk(full, d);
  }
  return out;
}

export async function exportMrpack({ gameDir, versionId, destination, options = {}, onProgress = () => {} }) {
  const versionNumber = String(options.version || '').trim();
  if (!versionNumber) throw new Error('mrpack 需要填写整合包版本号');
  const meta = instanceMeta(gameDir, versionId);
  const selected = new Set(DIRS);
  for (const k of DIRS) {
    if (options[k] === false) selected.delete(k);
  }
  selected.delete('saves');
  const local = walkFiles(meta.root, DIRS, selected);
  const indexFiles = [];
  const overrides = [];
  const clientOverrides = [];
  let recognized = 0;
  const hashCache = new Map();

  for (const file of local) {
    const buf = fs.readFileSync(file.full);
    const h1 = sha(buf, 'sha1');
    let version = hashCache.get(h1);
    if (version === undefined) {
      try { version = await getVersionFileByHash(h1); } catch { version = null; }
      hashCache.set(h1, version);
    }
    const matched = version?.files?.find((f) => String(f.sha1 || '').toLowerCase() === h1)
      || version?.files?.find((f) => f.primary)
      || null;
    if (version && matched?.url) {
      recognized += 1;
      indexFiles.push({
        path: file.rel.replace(/\\/g, '/'),
        hashes: { sha1: h1, sha512: sha(buf, 'sha512') },
        env: {
          client: version.clientSide || 'required',
          server: version.serverSide || 'required',
        },
        downloads: [matched.url],
        fileSize: buf.length,
      });
    } else {
      const target = CLIENT_ONLY.has(file.rel.split('/')[0]) ? clientOverrides : overrides;
      target.push(file);
    }
  }

  const index = {
    formatVersion: 1,
    game: {
      version: meta.gameVersion,
      loader: meta.loader,
      id: meta.loaderVersion || '',
    },
    name: meta.packName,
    version: versionNumber,
    summary: meta.summary || `从 SakuraLauncher 导出的实例 ${versionId}`,
    files: indexFiles,
  };

  const outDir = destination && String(destination).trim()
    ? path.resolve(String(destination))
    : path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Desktop');
  fs.mkdirSync(outDir, { recursive: true });
  let name = `${safeFile(meta.packName)}-${safeFile(versionNumber)}.mrpack`;
  let zipPath = path.join(outDir, name);
  let n = 2;
  while (fs.existsSync(zipPath)) {
    name = `${safeFile(meta.packName)}-${safeFile(versionNumber)}-${n}.mrpack`;
    zipPath = path.join(outDir, name);
    n += 1;
  }

  const entries = [{ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2), 'utf8') }];
  for (const f of overrides) entries.push({ name: `overrides/${f.rel.replace(/\\/g, '/')}`, file: f.full });
  for (const f of clientOverrides) entries.push({ name: `client-overrides/${f.rel.replace(/\\/g, '/')}`, file: f.full });

  try {
    await writeZipStream(zipPath, entries, {
      onProgress: (p) => onProgress({
        stage: 'export',
        done: p.done,
        total: entries.length,
        message: `打包 ${p.name}`,
      }),
    });
  } catch (e) {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  return {
    ok: true,
    format: 'mrpack',
    zipPath,
    outputDir: outDir,
    name,
    bytes: fs.statSync(zipPath).size,
    index,
    files: indexFiles.map((f) => f.path),
    overrides: overrides.map((f) => f.rel),
    clientOverrides: clientOverrides.map((f) => f.rel),
    recognized,
    overridesCount: overrides.length + clientOverrides.length,
    summary: `已识别 ${recognized} 个 Modrinth 文件，${overrides.length + clientOverrides.length} 个文件放进 overrides`,
  };
}
