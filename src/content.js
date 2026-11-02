/**
 * 内容安装：mod / 光影包 / 资源包 落到实例目录
 *
 * 目录约定（必须对，否则游戏读不到）：
 *   <gameDir>/versions/<实例>/mods/*.jar
 *   <gameDir>/versions/<实例>/shaderpacks/*.zip
 *   <gameDir>/versions/<实例>/resourcepacks/*.zip
 *
 * 为什么要放在 versions/<实例>/ 而不是全局根目录：
 *   launch.js 的版本隔离逻辑是——实例目录里出现 mods/saves/options.txt/config
 *   就把 gameDir 指向实例目录。这样不同实例的 mod 互不污染，
 *   和 PCL 的「版本隔离」是同一个思路。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { downloadFile } from './download.js';

/** 项目类型 -> 实例内子目录 */
export const FOLDER_BY_TYPE = {
  mod: 'mods',
  shader: 'shaderpacks',
  resourcepack: 'resourcepacks',
  modpack: null, // 整合包落在实例根，见 modpack.js
};

/** 允许的文件扩展名 —— 挡住误下载的可执行文件 */
const ALLOWED_EXT = {
  mod: ['.jar', '.zip', '.disabled'],
  shader: ['.zip'],
  resourcepack: ['.zip'],
};

export function instanceDir(gameDir, versionId) {
  return path.join(gameDir, 'versions', versionId);
}

/** 该类型内容的安装目录；modpack 返回实例根 */
export function targetDir(gameDir, versionId, projectType) {
  const sub = FOLDER_BY_TYPE[projectType];
  const base = instanceDir(gameDir, versionId);
  return sub ? path.join(base, sub) : base;
}

/**
 * 只保留文件名，挡掉路径穿越。
 * Modrinth 的 filename 一般很干净，但不能假设外部数据可信。
 */
function safeFilename(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
}

function extAllowed(projectType, filename) {
  const list = ALLOWED_EXT[projectType] ?? ['.jar', '.zip'];
  const lower = filename.toLowerCase();
  return list.some((e) => lower.endsWith(e));
}

/**
 * 安装一批文件到实例目录。
 * files: [{ url, filename, sha1, size }]
 * 返回 { installed: [...], skipped: [...], failed: [...] }
 */
export async function installContent(opts = {}) {
  const {
    gameDir,
    versionId,
    projectType,
    files = [],
    overwrite = true,
    onProgress = () => {},
    source,
  } = opts;

  if (!gameDir) throw new Error('缺少 gameDir');
  if (!versionId) throw new Error('缺少实例名 versionId');
  if (!FOLDER_BY_TYPE[projectType]) throw new Error(`不支持的内容类型：${projectType}`);
  if (!files.length) throw new Error('没有要下载的文件');

  const dir = targetDir(gameDir, versionId, projectType);
  await fsp.mkdir(dir, { recursive: true });

  const result = { dir, installed: [], skipped: [], failed: [] };
  let done = 0;

  for (const f of files) {
    const name = safeFilename(f.filename);
    done++;

    if (!name) {
      result.failed.push({ name: String(f.filename), error: '文件名无效' });
      continue;
    }
    if (!extAllowed(projectType, name)) {
      result.failed.push({ name, error: '文件类型不允许' });
      continue;
    }

    const dest = path.join(dir, name);

    if (fs.existsSync(dest) && !overwrite) {
      result.skipped.push(name);
      onProgress({ done, total: files.length, message: `已存在，跳过 ${name}` });
      continue;
    }

    try {
      const r = await downloadFile(f.url, dest, {
        sha1: f.sha1 ?? undefined,
        size: f.size ?? undefined,
        retries: 3,
        timeout: 120000,
        source,
      });
      result.installed.push({ name, action: r, path: dest });
      onProgress({ done, total: files.length, message: `${r === 'skipped' ? '已有' : '已下载'} ${name}` });
    } catch (e) {
      result.failed.push({ name, error: e.message });
      onProgress({ done, total: files.length, message: `失败 ${name}：${e.message}` });
    }
  }

  return result;
}

/** 列出实例里已装的内容（文件名 + 大小） */
export async function listInstalled(gameDir, versionId) {
  const base = instanceDir(gameDir, versionId);
  const out = { instanceDir: base, mods: [], shaderpacks: [], resourcepacks: [] };

  for (const [key, sub] of [
    ['mods', 'mods'],
    ['shaderpacks', 'shaderpacks'],
    ['resourcepacks', 'resourcepacks'],
  ]) {
    const dir = path.join(base, sub);
    if (!fs.existsSync(dir)) continue;
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    const items = [];
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
        items.push({ name: n, size: st.size, disabled: n.endsWith('.disabled') });
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
    out[key] = items.sort((a, b) => a.name.localeCompare(b.name));
  }

  return out;
}

/** 删除某个已安装文件 */
export async function removeContent({ gameDir, versionId, projectType, filename }) {
  const dir = targetDir(gameDir, versionId, projectType);
  const name = safeFilename(filename);
  if (!name) throw new Error('文件名无效');
  const p = path.join(dir, name);
  // 二次确认仍在目标目录内
  if (!path.resolve(p).startsWith(path.resolve(dir) + path.sep)) {
    throw new Error('拒绝删除目标目录之外的文件');
  }
  await fsp.rm(p, { force: true });
  return { removed: name };
}

/** 启用/禁用（改后缀 .disabled，这是 Minecraft 认的停用方式） */
export async function toggleContent({ gameDir, versionId, projectType, filename, enable }) {
  const dir = targetDir(gameDir, versionId, projectType);
  const name = safeFilename(filename);
  const clean = name.endsWith('.disabled') ? name.slice(0, -9) : name;
  const from = path.join(dir, enable ? name : clean);
  const to = path.join(dir, enable ? clean : clean + '.disabled');
  if (!fs.existsSync(from)) throw new Error(`找不到文件 ${path.basename(from)}`);
  await fsp.rename(from, to);
  return { from: path.basename(from), to: path.basename(to) };
}
