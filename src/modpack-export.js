/**
 * 实例导出：生成能被本启动器普通 zip 导入识别的实例包。
 * 不打包账号/token/日志/crash，不上传。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { writeZip } from './zipwrite.js';
import { getSettings } from './settings.js';

const ALWAYS = ['mods', 'config'];
const OPTIONAL = ['resourcepacks', 'shaderpacks', 'saves', 'screenshots'];
const FORBIDDEN = new Set(['logs', 'crash-reports', '.cache', '.backup', 'server', '.mclauncher']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function walk(dir, base, out, errors) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { errors.push(`${dir}: ${e.message}`); return; }
  for (const entry of entries) {
    if (FORBIDDEN.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) walk(full, base, out, errors);
    else if (entry.isFile()) {
      try { out.push({ full, rel, size: fs.statSync(full).size }); }
      catch (e) { errors.push(`${full}: ${e.message}`); }
    }
  }
}

function instanceMeta(gameDir, versionId) {
  const root = path.join(gameDir, 'versions', versionId);
  const version = readJson(path.join(root, `${versionId}.json`)) || {};
  const override = readJson(path.join(root, 'launcher-instance.json')) || {};
  const mainClass = String(version.mainClass || '');
  const tag = `${version.id || ''} ${version.inheritsFrom || ''} ${mainClass}`;
  let loader = 'vanilla';
  if (/fabric/i.test(tag)) loader = 'fabric';
  else if (/neoforge/i.test(tag)) loader = 'neoforge';
  else if (/forge/i.test(tag)) loader = 'forge';
  else if (/quilt/i.test(tag)) loader = 'quilt';
  const settings = getSettings();
  const loaderVersion = (/(?:forge|fabric|neoforge|quilt)[-_ ]?([\d][\w.-]*)/i.exec(tag) || [])[1] || '';
  return {
    version,
    loader,
    loaderVersion,
    gameVersion: version.inheritsFrom || version.id || versionId,
    memory: {
      min: override.memoryMin || settings.memoryMin || '',
      max: override.memoryMax || settings.memoryMax || '',
    },
  };
}

export function previewExport({ gameDir, versionId, options = {} }) {
  const root = path.join(gameDir, 'versions', versionId);
  const meta = instanceMeta(gameDir, versionId);
  const selected = new Set(ALWAYS);
  for (const key of OPTIONAL) if (options[key]) selected.add(key);
  const files = [];
  const errors = [];
  for (const dir of selected) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    walk(full, root, files, errors);
  }
  const versionFile = path.join(root, `${versionId}.json`);
  if (fs.existsSync(versionFile)) files.push({ full: versionFile, rel: `${versionId}.json`, size: fs.statSync(versionFile).size });
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const { version: _version, ...publicMeta } = meta;
  return {
    versionId,
    meta: publicMeta,
    options: { mods: true, config: true, ...options },
    files: files.map(({ rel, size }) => ({ name: rel, size })),
    totalBytes: bytes,
    errors,
    defaultDestination: path.join(os.homedir(), 'Desktop'),
  };
}

export async function exportInstance({ gameDir, versionId, destination, options = {}, onProgress = () => {} }) {
  const preview = previewExport({ gameDir, versionId, options });
  const root = path.join(gameDir, 'versions', versionId);
  const files = [];
  const errors = [];
  const selected = new Set(ALWAYS);
  for (const key of OPTIONAL) if (options[key]) selected.add(key);
  for (const dir of selected) {
    const full = path.join(root, dir);
    if (fs.existsSync(full)) walk(full, root, files, errors);
  }
  const versionFile = path.join(root, `${versionId}.json`);
  if (fs.existsSync(versionFile)) files.push({ full: versionFile, rel: `${versionId}.json`, size: fs.statSync(versionFile).size });

  const outDir = destination && String(destination).trim()
    ? path.resolve(String(destination))
    : preview.defaultDestination;
  fs.mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  let zipName = `${versionId}-${date}.zip`;
  let zipPath = path.join(outDir, zipName);
  let n = 2;
  while (fs.existsSync(zipPath)) {
    zipName = `${versionId}-${date}-${n}.zip`;
    zipPath = path.join(outDir, zipName);
    n += 1;
  }

  const manifest = {
    format: 'sakura-instance',
    formatVersion: 1,
    name: versionId,
    versionJson: `${versionId}.json`,
    minecraft: { version: preview.meta.gameVersion },
    loader: preview.meta.loader,
    loaderVersion: preview.meta.loaderVersion || '',
    memory: preview.meta.memory,
    createdAt: new Date().toISOString(),
    options: { mods: true, config: true, ...options },
  };
  const entries = [];
  let done = 0;
  const total = files.length + 1;
  for (const file of files) {
    try {
      const data = fs.readFileSync(file.full);
      entries.push({ name: file.rel, data });
      done += 1;
      onProgress({ stage: 'export', done, total, bytes: data.length, message: `打包 ${file.rel}` });
    } catch (e) {
      errors.push(`${file.rel}: ${e.message}`);
    }
  }
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  done += 1;
  onProgress({ stage: 'export', done, total, message: '写入 zip' });
  writeZip(zipPath, entries);
  return {
    ok: true,
    zipPath,
    outputDir: outDir,
    name: zipName,
    bytes: fs.statSync(zipPath).size,
    files: entries.filter((e) => e.name !== 'manifest.json').map((e) => e.name),
    errors,
    preview,
  };
}
