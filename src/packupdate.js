/** 从 zip / mrpack 整包更新实例，保留玩家存档与默认配置。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { downloadFile } from './download.js';
import { listEntries, readEntry } from './zip.js';
import { backupAll } from './saves.js';

const CONTENT_DIRS = new Set(['mods', 'config', 'resourcepacks', 'shaderpacks']);
const REMOVABLE_DIRS = new Set(['mods', 'resourcepacks', 'shaderpacks']);
const FORBIDDEN = new Set(['saves', 'logs', 'crash-reports', '.removed', '.trash', '.mclauncher']);

function norm(name) {
  return String(name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function safeRel(rel) {
  const p = norm(rel);
  if (!p || p.split('/').includes('..') || p.startsWith('../')) return '';
  return p;
}

function category(rel) {
  return norm(rel).split('/')[0] || '';
}

function isProtected(rel) {
  const r = norm(rel);
  if (r === 'options.txt' || r === 'servers.dat') return true;
  return FORBIDDEN.has(category(r));
}

function readArchive(archivePath) {
  const buf = fs.readFileSync(archivePath);
  const entries = listEntries(buf);
  const names = entries.map((e) => norm(e.name));
  const fileMap = new Map();
  let kind = 'zip';
  let manifest = null;
  const idx = entries.find((e) => norm(e.name) === 'modrinth.index.json');
  if (idx) {
    kind = 'mrpack';
    const index = JSON.parse(readEntry(buf, idx).toString('utf8'));
    for (const f of index.files || []) {
      const rel = safeRel(f.path);
      if (!rel || isProtected(rel) || f.env?.client === 'unsupported') continue;
      if (!Array.isArray(f.downloads) || !f.downloads.length) continue;
      fileMap.set(rel, { type: 'remote', item: f });
    }
    const prefixes = ['overrides/', 'client-overrides/'];
    for (const e of entries) {
      const name = norm(e.name);
      if (!name || name.endsWith('/')) continue;
      const prefix = prefixes.find((p) => name.startsWith(p));
      if (!prefix) continue;
      const rel = safeRel(name.slice(prefix.length));
      if (!rel || isProtected(rel)) continue;
      fileMap.set(rel, { type: 'archive', entry: e });
    }
  } else {
    const manifestEntry = entries.find((e) => /(^|\/)manifest\.json$/i.test(norm(e.name)));
    if (manifestEntry) {
      try { manifest = JSON.parse(readEntry(buf, manifestEntry).toString('utf8')); } catch { /* ignore */ }
    }
    const sakura = manifest?.format === 'sakura-instance';
    let prefix = '';
    if (manifest && !sakura && Array.isArray(manifest.files)) {
      prefix = norm(manifest.overrides || 'overrides').replace(/\/+$/, '') + '/';
    } else if (!sakura) {
      const clean = names.filter((n) => n && !n.endsWith('/'));
      const roots = new Set(clean.map((n) => n.split('/')[0]));
      if (roots.size === 1) {
        const first = [...roots][0];
        if (clean.some((n) => n.startsWith(`${first}/`) && CONTENT_DIRS.has(n.split('/')[1]))) {
          prefix = `${first}/`;
        }
      }
    }
    for (const e of entries) {
      const name = norm(e.name);
      if (!name || name.endsWith('/')) continue;
      if (manifestEntry && norm(manifestEntry.name) === name) continue;
      if (!prefix && !sakura && /^(manifest\.json|modrinth\.index\.json)$/i.test(name)) continue;
      if (!prefix && sakura && !name.includes('/') && /\.json$/i.test(name)) continue;
      if (name.startsWith(prefix)) {
        const rel = safeRel(name.slice(prefix.length));
        if (!rel || isProtected(rel)) continue;
        fileMap.set(rel, { type: 'archive', entry: e });
      }
    }
  }
  return { buf, entries, fileMap, kind, manifest };
}

function listTargetFiles(instanceDir) {
  const out = [];
  const walk = (dir, relBase = '') => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (FORBIDDEN.has(e.name)) continue;
        walk(full, rel);
      } else if (e.isFile()) {
        if (!isProtected(rel)) out.push(rel);
      }
    }
  };
  for (const dir of CONTENT_DIRS) {
    const full = path.join(instanceDir, dir);
    if (fs.existsSync(full)) walk(full, dir);
  }
  return out;
}

function sameFile(instanceDir, rel, item) {
  const target = path.join(instanceDir, rel);
  let st;
  try { st = fs.statSync(target); } catch { return false; }
  if (!st.isFile()) return false;
  if (item.type === 'archive') {
    const buf = readEntry(item.buf || item.archiveBuf, item.entry);
    if (buf.length !== st.size) return false;
    const a = crypto.createHash('sha1').update(buf).digest('hex');
    const b = crypto.createHash('sha1').update(fs.readFileSync(target)).digest('hex');
    return a === b;
  }
  const f = item.item;
  const sha1 = f.hashes?.sha1;
  if (sha1) {
    return crypto.createHash('sha1').update(fs.readFileSync(target)).digest('hex') === sha1;
  }
  return Number(f.fileSize) === st.size;
}

function makePlan(instanceDir, archive, overwriteConfig) {
  const desired = archive.fileMap;
  const targetFiles = listTargetFiles(instanceDir);
  const targetSet = new Set(targetFiles);
  const groups = {};
  const applyAdded = [];
  const applyChanged = [];
  const removed = [];
  let skipped = 0;
  const bump = (cat, key) => {
    if (!groups[cat]) groups[cat] = { added: 0, changed: 0, removed: 0 };
    groups[cat][key] += 1;
  };
  const presentCats = new Set([...desired.keys()].map(category));
  for (const [rel, item] of desired) {
    const cat = category(rel);
    const exists = targetSet.has(rel);
    const same = exists && sameFile(instanceDir, rel, { ...item, buf: archive.buf });
    if (exists && same) continue;
    bump(cat, exists ? 'changed' : 'added');
    if (cat === 'config' && !overwriteConfig) {
      skipped += 1;
      continue;
    }
    if (exists) applyChanged.push({ rel, item });
    else applyAdded.push({ rel, item });
  }
  for (const rel of targetFiles) {
    const cat = category(rel);
    if (!presentCats.has(cat) || !REMOVABLE_DIRS.has(cat)) continue;
    if (desired.has(rel)) continue;
    removed.push(rel);
    bump(cat, 'removed');
  }
  const count = (key) => Object.values(groups).reduce((n, g) => n + g[key], 0);
  return {
    groups,
    added: count('added'),
    changed: count('changed'),
    removedCount: count('removed'),
    skipped,
    applyAdded,
    applyChanged,
    removed,
    protectedNote: overwriteConfig ? '存档没动；配置已按勾选覆盖' : '存档和配置没动',
  };
}

function groupText(groups) {
  const order = ['mods', 'config', 'resourcepacks', 'shaderpacks'];
  const keys = [...new Set([...order, ...Object.keys(groups)])];
  return keys
    .filter((k) => groups[k] && (groups[k].added || groups[k].changed || groups[k].removed))
    .map((k) => {
      const g = groups[k];
      const parts = [];
      if (g.added) parts.push(`新增 ${g.added}`);
      if (g.changed) parts.push(`变化 ${g.changed}`);
      if (g.removed) parts.push(`移除 ${g.removed}`);
      return `${k} ${parts.join(' ')}`;
    })
    .join(' · ');
}

export function previewPackUpdate({ gameDir, versionId, archivePath, overwriteConfig = false }) {
  const instanceDir = path.join(gameDir, 'versions', versionId);
  if (!fs.existsSync(instanceDir)) throw new Error('实例不存在');
  const archive = readArchive(archivePath);
  const plan = makePlan(instanceDir, archive, overwriteConfig);
  return {
    versionId,
    kind: archive.kind,
    groups: plan.groups,
    text: groupText(plan.groups),
    counts: {
      added: plan.added,
      changed: plan.changed,
      removed: plan.removedCount,
      skipped: plan.skipped,
    },
    protectedNote: plan.protectedNote,
    hasRemovals: plan.removedCount > 0,
  };
}

export async function applyPackUpdate({ gameDir, versionId, archivePath, overwriteConfig = false }) {
  const instanceDir = path.join(gameDir, 'versions', versionId);
  if (!fs.existsSync(instanceDir)) throw new Error('实例不存在');
  const archive = readArchive(archivePath);
  const plan = makePlan(instanceDir, archive, overwriteConfig);
  await backupAll({ gameDir, versionId, source: 'update' });

  for (const { rel, item } of [...plan.applyAdded, ...plan.applyChanged]) {
    const dest = path.join(instanceDir, rel);
    if (!dest.startsWith(instanceDir + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (item.type === 'archive') {
      fs.writeFileSync(dest, readEntry(archive.buf, item.entry));
    } else {
      const url = item.item.downloads?.[0];
      if (!url) continue;
      await downloadFile(url, dest, {
        sha1: item.item.hashes?.sha1,
        size: item.item.fileSize,
        retries: 3,
        timeout: 120000,
      });
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const removedDir = plan.removed.length ? path.join(instanceDir, '.removed', stamp) : '';
  for (const rel of plan.removed) {
    if (!removedDir) break;
    const src = path.join(instanceDir, rel);
    const dest = path.join(removedDir, rel);
    if (!dest.startsWith(removedDir + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(src, dest); } catch {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      fs.rmSync(src, { force: true });
    }
  }

  const applied = plan.applyAdded.length + plan.applyChanged.length;
  return {
    ok: true,
    added: plan.applyAdded.length,
    updated: plan.applyChanged.length,
    removed: plan.removed.length,
    skipped: plan.skipped,
    applied,
    groups: plan.groups,
    text: groupText(plan.groups),
    removedDir: removedDir ? path.relative(instanceDir, removedDir).replace(/\\/g, '/') : '',
    protectedNote: plan.protectedNote,
    summary: `新增 ${plan.applyAdded.length}、更新 ${plan.applyChanged.length}、移除 ${plan.removed.length}、跳过 ${plan.skipped}`,
  };
}
