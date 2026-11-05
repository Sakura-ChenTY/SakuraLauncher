/**
 * 实例导出：生成能被本启动器普通 zip 导入识别的实例包。
 * 不打包账号/token/日志/crash，不上传。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { writeZipStream } from './zipstream.js';
import { getSettings } from './settings.js';
import { exportMrpack } from './mrpack-export.js';

const CATEGORY_DIRS = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots'];
const DEFAULT_SELECTED = new Set(['mods', 'config', 'resourcepacks']);
const SECRET_RE = /token|api_key|secret|password|passwd|session|cookie|access_key/i;
const FORBIDDEN = new Set(['logs', 'crash-reports', '.cache', '.backup', 'server', '.mclauncher']);

function toolVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

function loaderLabel(loader) {
  return {
    vanilla: 'Vanilla',
    fabric: 'Fabric',
    forge: 'Forge',
    neoforge: 'NeoForge',
    quilt: 'Quilt',
  }[loader] || loader || 'Vanilla';
}

function selectedDirs(options = {}, whileRunning = false) {
  const selected = new Set();
  for (const key of CATEGORY_DIRS) {
    const wanted = options[key] === undefined ? DEFAULT_SELECTED.has(key) : Boolean(options[key]);
    if (wanted && !(whileRunning && key === 'saves')) selected.add(key);
  }
  return selected;
}

function scanConfigSecrets(root) {
  const configDir = path.join(root, 'config');
  if (!fs.existsSync(configDir)) return { count: 0, files: [] };
  const found = [];
  const errors = [];
  const files = [];
  walk(configDir, root, files, errors);
  for (const file of files) {
    if (file.size > 2 * 1024 * 1024) continue;
    try {
      const data = fs.readFileSync(file.full);
      if (data.includes(0)) continue;
      if (SECRET_RE.test(data.toString('utf8'))) found.push(file.rel);
    } catch { /* 单个文件读不到不影响导出 */ }
  }
  return { count: found.length, files: found };
}

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
    packVersion: override.packVersion || override.version || '',
    packName: override.packName || override.name || version.name || versionId,
    memory: {
      min: override.memoryMin || settings.memoryMin || '',
      max: override.memoryMax || settings.memoryMax || '',
    },
  };
}

export function previewExport({ gameDir, versionId, options = {} }) {
  const root = path.join(gameDir, 'versions', versionId);
  const meta = instanceMeta(gameDir, versionId);
  const whileRunning = Boolean(options.whileRunning);
  const selected = selectedDirs(options, whileRunning);
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
  const optionState = Object.fromEntries(CATEGORY_DIRS.map((key) => [key, selected.has(key)]));
  const skipped = CATEGORY_DIRS.filter((key) => !selected.has(key));
  return {
    versionId,
    meta: publicMeta,
    options: optionState,
    included: [...selected],
    skipped,
    secretScan: selected.has('config') ? scanConfigSecrets(root) : { count: 0, files: [] },
    files: files.map(({ rel, size }) => ({ name: rel, size })),
    totalBytes: bytes,
    errors,
    warnings: whileRunning && (options.saves === undefined || options.saves) ? ['游戏开着，存档没带'] : [],
    defaultDestination: path.join(os.homedir(), 'Desktop'),
  };
}

export async function exportInstance({ gameDir, versionId, destination, options = {}, onProgress = () => {} }) {
  if (options.format === 'mrpack') {
    return exportMrpack({ gameDir, versionId, destination, options, onProgress });
  }
  const whileRunning = Boolean(options.whileRunning);
  const preview = previewExport({ gameDir, versionId, options: { ...options, whileRunning } });
  const root = path.join(gameDir, 'versions', versionId);
  const files = [];
  const errors = [];
  const selected = selectedDirs(options, whileRunning);
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
    options: preview.options,
    whileRunning,
  };
  const packName = preview.meta.packName || versionId;
  const packVersion = String(options.version || preview.meta.packVersion || '1.0');
  const loaderName = loaderLabel(preview.meta.loader);
  const modCount = files.filter((f) => /^mods\/[^/]+\.jar(?:\.disabled)?$/i.test(f.rel)).length;
  const packInfo = {
    format: 'sakura-instance',
    name: packName,
    version: packVersion,
    minecraft: preview.meta.gameVersion,
    loader: loaderName,
    mods: modCount,
    exportedAt: new Date().toISOString(),
    exporter: `SakuraLauncher ${toolVersion()}`,
  };
  const readme = [
    `${packName} ${packVersion}`,
    '',
    '这是一个 Minecraft 实例整合包。',
    `MC 版本：${preview.meta.gameVersion}`,
    `加载器：${loaderName}`,
    `Mod 数量：${modCount}`,
    '',
    '用 SakuraLauncher 打开这个 zip 即可导入；如果使用其他启动器，请按 zip 内的版本描述手动建立实例。',
    '装之前先备份你的存档。',
    '',
  ].join('\n');
  const shareText = [
    `${packName} ${packVersion}`,
    `MC ${preview.meta.gameVersion}`,
    loaderName,
    `${modCount} 个 Mod`,
  ].join('\n');
  const entries = files.map((file) => ({ name: file.rel, file: file.full }));
  entries.push({ name: 'pack-info.json', data: Buffer.from(JSON.stringify(packInfo, null, 2), 'utf8') });
  entries.push({ name: 'README.txt', data: Buffer.from(readme, 'utf8') });
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  try {
    await writeZipStream(zipPath, entries, {
      shouldCancel: typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false,
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
    zipPath,
    outputDir: outDir,
    name: zipName,
    bytes: fs.statSync(zipPath).size,
    files: entries.filter((e) => !['manifest.json', 'pack-info.json', 'README.txt'].includes(e.name)).map((e) => e.name),
    errors,
    warnings: preview.warnings || [],
    included: preview.included,
    skipped: preview.skipped,
    secretScan: preview.secretScan,
    packInfo,
    shareText,
    preview,
  };
}
