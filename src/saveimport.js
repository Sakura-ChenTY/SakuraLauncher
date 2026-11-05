/** 外部世界文件夹 / zip 导入。 */
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { listEntries, readEntry } from './zip.js';
import { parseLevelDat } from './leveldat.js';
import { backupAll } from './saves.js';

const DATA_VERSION_BY_GAME = {
  '1.21.4': 4189,
  '1.21.3': 4082,
  '1.21.2': 4080,
  '1.21.1': 3955,
  '1.21': 3953,
  '1.20.6': 3839,
  '1.20.5': 3837,
  '1.20.4': 3700,
  '1.20.3': 3698,
  '1.20.2': 3578,
  '1.20.1': 3465,
  '1.20': 3463,
  '1.19.4': 3337,
  '1.19.3': 3218,
  '1.19.2': 3120,
  '1.19.1': 3105,
  '1.19': 3105,
  '1.18.2': 2975,
  '1.18.1': 2865,
  '1.18': 2860,
  '1.17.1': 2730,
  '1.17': 2724,
  '1.16.5': 2586,
  '1.16.4': 2584,
  '1.16.3': 2580,
  '1.16.2': 2578,
  '1.16.1': 2567,
  '1.15.2': 2230,
  '1.15.1': 2227,
  '1.15': 2225,
  '1.14.4': 1976,
  '1.13.2': 1631,
  '1.12.2': 1343,
  '1.12.1': 1241,
  '1.12': 1132,
};
const GAME_BY_DATA_VERSION = Object.fromEntries(
  Object.entries(DATA_VERSION_BY_GAME).map(([game, data]) => [String(data), game])
);

function safeWorldName(name, fallback = '导入世界') {
  const s = String(name ?? '').replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').trim().slice(0, 60);
  return s || fallback;
}

function sourceInfo(source) {
  const src = path.resolve(String(source || ''));
  if (!fs.existsSync(src)) throw new Error('存档来源不存在');
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    const level = path.join(src, 'level.dat');
    if (!fs.existsSync(level)) throw new Error('这个文件夹里没有 level.dat');
    return {
      kind: 'dir',
      root: src,
      levelBuf: fs.readFileSync(level),
      prefix: '',
      fallbackName: path.basename(src),
    };
  }
  if (!st.isFile() || !/\.zip$/i.test(src)) throw new Error('只支持世界文件夹或 .zip');
  const buf = fs.readFileSync(src);
  const entries = listEntries(buf);
  const levels = entries
    .map((e) => ({ entry: e, name: e.name.replace(/\\/g, '/') }))
    .filter((x) => /(^|\/)level\.dat$/i.test(x.name))
    .sort((a, b) => a.name.length - b.name.length);
  const level = levels[0];
  if (!level) throw new Error('这个 zip 里没有 level.dat');
  const prefix = level.name.includes('/')
    ? level.name.slice(0, level.name.lastIndexOf('/') + 1)
    : '';
  return {
    kind: 'zip',
    root: src,
    buf,
    entries,
    levelBuf: readEntry(buf, level.entry),
    prefix,
    fallbackName: path.basename(src, path.extname(src)),
  };
}

function targetName(savesDir, levelName, fallback) {
  const base = safeWorldName(levelName, safeWorldName(fallback));
  const candidates = [base, `${base} (导入)`];
  for (let n = 2; n < 1000; n += 1) candidates.push(`${base} (导入 ${n})`);
  return candidates.find((x) => !fs.existsSync(path.join(savesDir, x))) || `${base} (导入 ${Date.now()})`;
}

function publicInfo(info, targetGameVersion, savesDir) {
  const parsed = parseLevelDat(info.levelBuf);
  const levelName = parsed.levelName || info.fallbackName;
  const dataVersion = parsed.dataVersion;
  const saveGameVersion = GAME_BY_DATA_VERSION[String(dataVersion)] || (dataVersion ? `DataVersion ${dataVersion}` : '未知');
  const targetDataVersion = DATA_VERSION_BY_GAME[targetGameVersion] || null;
  const mismatch = Boolean(targetDataVersion && dataVersion && targetDataVersion !== dataVersion);
  return {
    kind: info.kind,
    levelName,
    dataVersion,
    saveGameVersion,
    targetGameVersion: targetGameVersion || '未知',
    mismatch,
    world: targetName(savesDir, levelName, info.fallbackName),
    source: info.root,
  };
}

export function previewSaveImport({ gameDir, versionId, source, targetGameVersion }) {
  const savesDir = path.join(gameDir, 'versions', versionId, 'saves');
  return publicInfo(sourceInfo(source), targetGameVersion, savesDir);
}

export async function importSave({ gameDir, versionId, source, targetGameVersion }) {
  const savesDir = path.join(gameDir, 'versions', versionId, 'saves');
  const info = sourceInfo(source);
  const data = publicInfo(info, targetGameVersion, savesDir);
  const dest = path.join(savesDir, data.world);
  await fsp.mkdir(savesDir, { recursive: true });

  // 导入前把目标实例现有存档做一次流式备份；失败就不动目标世界。
  await backupAll({ gameDir, versionId, source: 'import' });

  if (info.kind === 'dir') {
    await fsp.cp(info.root, dest, { recursive: true, force: false });
  } else {
    await fsp.mkdir(dest, { recursive: true });
    for (const entry of info.entries) {
      const name = String(entry.name || '').replace(/\\/g, '/');
      if (!name || name.endsWith('/')) continue;
      if (!name.startsWith(info.prefix)) continue;
      const rel = name.slice(info.prefix.length);
      if (!rel) continue;
      const target = path.resolve(dest, rel);
      if (target !== dest && !target.startsWith(dest + path.sep)) continue;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, readEntry(info.buf, entry));
    }
  }
  return {
    ok: true,
    world: data.world,
    levelName: data.levelName,
    dataVersion: data.dataVersion,
    saveGameVersion: data.saveGameVersion,
    targetGameVersion: data.targetGameVersion,
    mismatch: data.mismatch,
    source: info.root,
  };
}
