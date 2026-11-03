/** 存档列表、备份和恢复。所有备份都在本机 ~/.mclauncher/save-backups。 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { HOME_DIR } from './paths.js';
import { writeZip } from './zipwrite.js';
import { listEntries, readEntry, extractAll } from './zip.js';

const BACKUP_ROOT = path.join(HOME_DIR, 'save-backups');

function safePart(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'world';
}

function verDir(gameDir, versionId) {
  const root = path.join(gameDir, 'versions', String(versionId || ''));
  const resolved = path.resolve(root);
  const versions = path.resolve(gameDir, 'versions');
  if (!resolved.startsWith(versions + path.sep)) throw new Error('实例名不合法');
  return resolved;
}

function worldDir(gameDir, versionId, world) {
  const saves = path.join(verDir(gameDir, versionId), 'saves');
  const target = path.resolve(saves, String(world || ''));
  if (!target.startsWith(path.resolve(saves) + path.sep)) throw new Error('存档名不合法');
  return { saves, target };
}

function walk(dir, base, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) {
      try {
        out.push({ full, rel: path.relative(base, full).replace(/\\/g, '/'), size: fs.statSync(full).size });
      } catch { /* skip */ }
    }
  }
}

function sizeOf(dir) {
  const files = [];
  walk(dir, dir, files);
  return files.reduce((n, f) => n + f.size, 0);
}

function mtimeOf(dir) {
  try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
}

function backupDir(versionId) {
  return path.join(BACKUP_ROOT, safePart(versionId));
}

function safeBackupPath(versionId, file) {
  const root = path.resolve(backupDir(versionId));
  const target = path.resolve(root, String(file || ''));
  if (!target.startsWith(root + path.sep)) throw new Error('备份路径不合法');
  return target;
}

function readBackupMeta(zipPath) {
  try {
    const buf = fs.readFileSync(zipPath);
    const entries = listEntries(buf);
    const entry = entries.find((e) => e.name === 'manifest.json' || e.name.endsWith('/manifest.json'));
    if (!entry) return null;
    return JSON.parse(readEntry(buf, entry).toString('utf8'));
  } catch { return null; }
}

export function listSaves({ gameDir, versionId }) {
  const root = path.join(verDir(gameDir, versionId), 'saves');
  const saves = [];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      saves.push({
        name: e.name,
        path: dir,
        size: sizeOf(dir),
        modifiedAt: mtimeOf(dir),
      });
    }
  } catch { /* no saves */ }
  saves.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const backups = [];
  try {
    for (const name of fs.readdirSync(backupDir(versionId))) {
      if (!/\.zip$/i.test(name)) continue;
      const file = path.join(backupDir(versionId), name);
      const meta = readBackupMeta(file);
      backups.push({
        file: name,
        path: file,
        size: fs.statSync(file).size,
        createdAt: fs.statSync(file).mtimeMs,
        world: meta?.world || name.replace(/-\d{8}-\d{6}\.zip$/i, ''),
        whileRunning: Boolean(meta?.whileRunning),
        versionId,
      });
    }
  } catch { /* no backups */ }
  backups.sort((a, b) => b.createdAt - a.createdAt);
  return { versionId, savesDir: root, backupDir: backupDir(versionId), saves, backups };
}

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function verifyBackup(zipPath, expected) {
  const buf = fs.readFileSync(zipPath);
  const entries = listEntries(buf);
  for (const item of expected) {
    const entry = entries.find((e) => e.name === item.name);
    if (!entry) throw new Error(`缺少文件 ${item.name}`);
    const data = readEntry(buf, entry);
    if (data.length !== item.size || sha1(data) !== item.sha1) {
      throw new Error(`内容不一致 ${item.name}`);
    }
  }
}

export async function backupWorld({ gameDir, versionId, world, whileRunning = false, onProgress = () => {} }) {
  const { target } = worldDir(gameDir, versionId, world);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('存档不存在');
  const files = [];
  walk(target, target, files);
  const dir = backupDir(versionId);
  await fsp.mkdir(dir, { recursive: true });
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const zipPath = path.join(dir, `${safePart(world)}-${stamp}.zip`);
  const entries = [];
  const expected = [];
  let done = 0;
  for (const file of files) {
    const data = await fsp.readFile(file.full);
    const name = `${world}/${file.rel}`;
    entries.push({ name, data });
    expected.push({ name, size: data.length, sha1: sha1(data) });
    done += 1;
    onProgress({ stage: 'save-backup', done, total: files.length + 1, message: `备份 ${file.rel}` });
  }
  const manifest = {
    format: 'sakura-save-backup',
    formatVersion: 1,
    versionId,
    world,
    whileRunning: Boolean(whileRunning),
    createdAt: new Date().toISOString(),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  onProgress({ stage: 'save-backup', done: files.length + 1, total: files.length + 1, message: '写入备份 zip' });
  try {
    writeZip(zipPath, entries);
    verifyBackup(zipPath, expected);
  } catch (e) {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    throw new Error(`备份校验失败：${e.message}`);
  }
  return { zipPath, file: path.basename(zipPath), world, whileRunning: Boolean(whileRunning), verified: true, bytes: fs.statSync(zipPath).size, files: files.length };
}

export async function backupAll({ gameDir, versionId, whileRunning = false, onProgress = () => {} }) {
  const saves = listSaves({ gameDir, versionId }).saves;
  const result = [];
  for (const save of saves) result.push(await backupWorld({ gameDir, versionId, world: save.name, whileRunning, onProgress }));
  return result;
}

export async function restoreBackup({ gameDir, versionId, file, onProgress = () => {} }) {
  const zipPath = safeBackupPath(versionId, file);
  if (!fs.existsSync(zipPath)) throw new Error('备份文件不存在');
  const meta = readBackupMeta(zipPath);
  const world = String(meta?.world || path.basename(zipPath).replace(/-\d{8}-\d{6}\.zip$/i, ''));
  if (!world) throw new Error('备份缺少存档名');
  const { saves, target } = worldDir(gameDir, versionId, world);
  const tmp = path.join(backupDir(versionId), `.restore-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  let old = '';
  try {
    onProgress({ stage: 'save-restore', message: '解压备份' });
    extractAll(zipPath, tmp);
    let src = path.join(tmp, world);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      const dirs = fs.readdirSync(tmp, { withFileTypes: true }).filter((e) => e.isDirectory());
      src = dirs.length === 1 ? path.join(tmp, dirs[0].name) : '';
    }
    if (!src) throw new Error('备份里没有存档目录');
    await fsp.mkdir(saves, { recursive: true });
    if (fs.existsSync(target)) {
      // 覆盖前先保存当前世界，失败就不动原目录。
      onProgress({ stage: 'save-restore', message: '先备份当前存档' });
      await backupWorld({ gameDir, versionId, world, onProgress: () => {} });
      old = `${target}.restore-old-${Date.now()}`;
      fs.renameSync(target, old);
    }
    try {
      fs.cpSync(src, target, { recursive: true, force: true });
    } catch (e) {
      if (old && fs.existsSync(old) && !fs.existsSync(target)) fs.renameSync(old, target);
      throw e;
    }
    if (old) fs.rmSync(old, { recursive: true, force: true });
    onProgress({ stage: 'save-restore', message: '恢复完成' });
    return { world, restoredFrom: file };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export { BACKUP_ROOT };
