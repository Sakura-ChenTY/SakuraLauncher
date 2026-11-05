/**
 * 实例最近删除：.trash 下的目录仍保留完整实例，可恢复或彻底删除。
 * 不做自动清理；30 天只是提示用户手动处理。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const TRASH_RETENTION_DAYS = 30;

function trashRoot(gameDir) {
  return path.join(gameDir, '.trash');
}

function parseEntryName(name, stat) {
  const m = /^(.*)-(\d{10,16})$/.exec(name);
  return {
    versionId: m ? m[1] : name,
    deletedAt: m ? Number(m[2]) : stat.mtimeMs,
  };
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) {
      try { total += fs.statSync(full).size; } catch { /* ignore */ }
    }
  }
  return total;
}

function safeTrashEntry(gameDir, name) {
  const root = path.resolve(trashRoot(gameDir));
  const target = path.resolve(root, String(name || ''));
  if (!target.startsWith(root + path.sep)) throw new Error('最近删除路径不合法');
  return target;
}

function uniqueTarget(versionsDir, base) {
  let candidate = path.join(versionsDir, base);
  if (!fs.existsSync(candidate)) return candidate;
  candidate = path.join(versionsDir, `${base} (恢复)`);
  if (!fs.existsSync(candidate)) return candidate;
  for (let n = 2; n < 1000; n += 1) {
    const next = path.join(versionsDir, `${base} (恢复 ${n})`);
    if (!fs.existsSync(next)) return next;
  }
  throw new Error('恢复目标名称已被占用');
}

export function listTrash(gameDir) {
  const root = trashRoot(gameDir);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { trashDir: root, entries: [] }; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const parsed = parseEntryName(entry.name, st);
    out.push({
      name: entry.name,
      versionId: parsed.versionId,
      deletedAt: parsed.deletedAt,
      size: dirSize(full),
    });
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt);
  return { trashDir: root, entries: out };
}

export async function restoreTrash(gameDir, name) {
  const source = safeTrashEntry(gameDir, name);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('最近删除里没有这个实例');
  const parsed = parseEntryName(path.basename(source), fs.statSync(source));
  const versionsDir = path.join(gameDir, 'versions');
  await fsp.mkdir(versionsDir, { recursive: true });
  const target = uniqueTarget(versionsDir, parsed.versionId);
  await fsp.rename(source, target);
  return {
    ok: true,
    versionId: path.basename(target),
    restoredTo: target,
    renamed: path.basename(target) !== parsed.versionId,
  };
}

export async function purgeTrash(gameDir, name) {
  const target = safeTrashEntry(gameDir, name);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('最近删除里没有这个实例');
  await fsp.rm(target, { recursive: true, force: true });
  return { ok: true, name };
}
