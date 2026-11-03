/**
 * 模组批量更新
 *
 * 为什么靠哈希而不是文件名：
 *   同一个模组各版本文件名千奇百怪（sodium-fabric-mc1.20.1-0.5.3.jar、
 *   Sodium-0.5.3.jar…），按名字猜必然错一堆。而 jar 的 sha1 是唯一指纹：
 *   Modrinth 有 POST /version_files，直接拿哈希换「这是哪个项目的哪个版本」。
 *
 *   实测（2026-10-24）：本机 33 个 mod 认出 31 个（另 2 个是 CurseForge 独占/自制），
 *   一次批量查询 359ms，且能直接给出「可更新的新版本」。
 *
 * 为什么要 /version_files/update 而不是自己比对：
 *   自己拉每个项目的全部版本 = 477 次请求，必然撞 300 请求/分钟的限流。
 *   /version_files/update 一次就把「在指定游戏版本+加载器下」的最新版算好了。
 *
 * 不覆盖的情况（这些必须原样保留、只报告）：
 *   - Modrinth 查不到的（CF 独占 / 自制 / 非 Modrinth 渠道）
 *   - 已是最新（哈希一致）
 *   - 新版本没有可下载文件
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { sha1File, downloadFile, ensureNotCancelled, isCancelled } from './download.js';
import { instanceDir } from './content.js';

const BASE = 'https://api.modrinth.com/v2';
// Modrinth 要求带可识别的 UA，否则可能被限流
const UA = { 'User-Agent': 'sakura-launcher/0.1 (github.com/sakura-launcher)' };

/** 批量上限：官方没明说，100 一片实测稳定，且远低于限流 */
const CHUNK = 100;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? 5);
    await new Promise((r) => setTimeout(r, Math.min(retry, 30) * 1000));
    throw new Error('Modrinth 限流，请稍后再试');
  }
  if (!res.ok) throw new Error(`Modrinth HTTP ${res.status}`);
  return res.json();
}

/** 可更新的包：Mod 用 jar，资源包/光影用 zip */
const PACK_DIRS = [
  { folder: 'mods', type: 'mod', extensions: ['.jar', '.jar.disabled'] },
  { folder: 'resourcepacks', type: 'resourcepack', extensions: ['.zip', '.zip.disabled'] },
  { folder: 'shaderpacks', type: 'shader', extensions: ['.zip', '.zip.disabled'] },
];

/** 扫描 mods / resourcepacks / shaderpacks；保留 jars 字段兼容旧调用 */
export async function listModJars(gameDir, versionId) {
  const base = instanceDir(gameDir, versionId);
  const dirs = {};
  const packages = [];
  for (const spec of PACK_DIRS) {
    const dir = path.join(base, spec.folder);
    dirs[spec.type] = dir;
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const n of names) {
      const lower = n.toLowerCase();
      if (!spec.extensions.some((ext) => lower.endsWith(ext))) continue;
      const p = path.join(dir, n);
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
        packages.push({
          name: n,
          path: p,
          size: st.size,
          disabled: lower.endsWith('.disabled'),
          type: spec.type,
          dir,
          folder: spec.folder,
        });
      } catch { /* 读不到就跳过 */ }
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return {
    dir: dirs.mod,
    dirs,
    jars: packages.filter((p) => p.type === 'mod'),
    packages,
  };
}

/**
 * 检查更新。
 * 返回 {
 *   total, identified, updates:[{...}], unknown:[...], current:[...]
 * }
 * 不写盘、不改文件 —— 纯只读，先让人看清再决定。
 */
export async function checkModUpdates({ gameDir, versionId, gameVersion, loader, onProgress = () => {} }) {
  const { dir, dirs, packages } = await listModJars(gameDir, versionId);
  if (!packages.length) {
    return { dir, dirs, total: 0, identified: 0, updates: [], unknown: [], current: [], counts: {} };
  }

  onProgress({ phase: 'hash', done: 0, total: packages.length, message: '正在算文件指纹…' });

  // 1) 本地算哈希；键带类型，避免 mods 和资源包同名冲突
  const hashOf = new Map(); // type/name -> sha1
  const keyOf = (p) => `${p.type}/${p.name}`;
  let i = 0;
  for (const p of packages) {
    ensureNotCancelled();
    hashOf.set(keyOf(p), await sha1File(p.path));
    i++;
    if (i % 10 === 0 || i === packages.length) {
      onProgress({ phase: 'hash', done: i, total: packages.length, message: `算指纹 ${i}/${packages.length}` });
    }
  }

  const hashes = [...hashOf.values()];

  // 2) 批量认领：这个文件是哪个项目的哪个版本
  onProgress({ phase: 'identify', done: 0, total: packages.length, message: '正在识别内容…' });
  const known = {};
  for (let off = 0; off < hashes.length; off += CHUNK) {
    ensureNotCancelled();
    const chunk = hashes.slice(off, off + CHUNK);
    try {
      const data = await postJson(`${BASE}/version_files`, { hashes: chunk, algorithm: 'sha1' });
      Object.assign(known, data);
    } catch (e) {
      // 单片失败不该毁掉整次检查：记下来继续，最后一起报
      onProgress({ phase: 'identify', done: off, total: hashOf.size, message: `识别失败：${e.message}` });
      throw e;
    }
    await new Promise((r) => setTimeout(r, 250)); // 礼貌间隔
  }

  const identified = packages.filter((p) => known[hashOf.get(keyOf(p))]);

  // 3) 批量查新版；mods 才带 loader 过滤，资源包/光影只按游戏版本过滤
  onProgress({ phase: 'update', done: 0, total: identified.length, message: '正在比对版本…' });
  let latest = {};
  for (const type of ['mod', 'resourcepack', 'shader']) {
    const group = identified.filter((p) => p.type === type);
    if (!group.length) continue;
    const body = {
      hashes: group.map((p) => hashOf.get(keyOf(p))),
      algorithm: 'sha1',
    };
    if (type === 'mod' && loader) body.loaders = [loader];
    if (gameVersion) body.game_versions = [gameVersion];
    const data = await postJson(`${BASE}/version_files/update`, body);
    Object.assign(latest, data);
    await new Promise((r) => setTimeout(r, 250));
  }

  // 4) 取项目标题（一次批量，别逐个查）
  const projectIds = [...new Set(Object.values(known).map((v) => v.project_id))];
  const titles = new Map();
  const icons = new Map();
  for (let off = 0; off < projectIds.length; off += CHUNK) {
    const ids = projectIds.slice(off, off + CHUNK);
    try {
      const url = `${BASE}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`;
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        const list = await res.json();
        for (const p of list) {
          titles.set(p.id, p.title ?? p.slug ?? p.id);
          icons.set(p.id, p.icon_url ?? null);
        }
      }
    } catch {
      /* 标题拿不到不算错，退化成文件名 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // 5) 归类
  const updates = [];
  const current = [];
  const unknown = [];

  for (const j of packages) {
    const h = hashOf.get(keyOf(j));
    const cur = known[h];
    if (!cur) {
      unknown.push({ name: j.name, size: j.size, type: j.type, reason: 'Modrinth 上没有这个文件（可能是 CurseForge 独占或自制）' });
      continue;
    }

    const title = titles.get(cur.project_id) ?? cur.project_id;
    const next = latest[h];

    // 没有返回 → 在目标环境里没有可用新版
    if (!next) {
      current.push({
        name: j.name,
        type: j.type,
        dir: j.dir,
        title,
        versionNumber: cur.version_number,
        note: '当前游戏版本/加载器下没有可用更新',
      });
      continue;
    }

    if (next.id === cur.id) {
      current.push({ name: j.name, type: j.type, dir: j.dir, title, versionNumber: cur.version_number, note: '已是最新' });
      continue;
    }

    const file = (next.files ?? []).find((f) => f.primary) ?? (next.files ?? [])[0];
    if (!file?.url) {
      current.push({ name: j.name, type: j.type, dir: j.dir, title, versionNumber: cur.version_number, note: '新版本没有可下载文件' });
      continue;
    }

    updates.push({
      oldName: j.name,
      type: j.type,
      dir: j.dir,
      disabled: j.disabled,
      title,
      iconUrl: icons.get(cur.project_id) ?? null,
      projectId: cur.project_id,
      from: cur.version_number,
      to: next.version_number,
      releaseType: next.version_type,
      gameVersions: next.game_versions ?? [],
      loaders: next.loaders ?? [],
      // 新文件名可能和老文件完全不同，替换时要按 oldName 删旧的
      newName: file.filename,
      url: file.url,
      sha1: file.hashes?.sha1 ?? null,
      size: file.size ?? null,
      datePublished: next.date_published ?? null,
    });
  }

  const counts = {};
  for (const p of packages) counts[p.type] = (counts[p.type] || 0) + 1;
  return {
    dir,
    dirs,
    total: packages.length,
    identified: identified.length,
    counts,
    gameVersion: gameVersion ?? null,
    loader: loader ?? null,
    updates: updates.sort((a, b) => a.title.localeCompare(b.title)),
    current,
    unknown,
  };
}

/**
 * 执行更新。先下到临时文件，校验通过才动老文件 —— 中途失败不能把能用的模组弄没。
 *
 * 备份：老文件移到 mods/.backup/<时间戳>/ 而不是直接删。
 *      出问题能手动捞回来，也不会被 Minecraft 当模组加载（子目录不扫描）。
 */
export async function applyModUpdates({ gameDir, versionId, items, onProgress = () => {} }) {
  const { dir, dirs } = await listModJars(gameDir, versionId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = { updated: [], failed: [], skipped: [], backupDir: null };
  let done = 0;

  for (const it of items) {
    ensureNotCancelled();
    done++;

    const targetDir = it.dir || (it.type === 'resourcepack' ? dirs.resourcepack : it.type === 'shader' ? dirs.shader : dir);
    const backupDir = path.join(targetDir, '.backup', stamp);
    const oldPath = path.join(targetDir, it.oldName);
    // 新文件名过一遍安全过滤，挡掉路径穿越；资源包/光影是 zip
    const safeNew = String(it.newName ?? '').split(/[\\/]/).pop();
    const ext = it.type === 'resourcepack' || it.type === 'shader' ? '.zip' : '.jar';
    if (!safeNew || !safeNew.toLowerCase().endsWith(ext)) {
      result.failed.push({ name: it.title ?? it.oldName, error: '新文件名不合法' });
      onProgress({ done, total: items.length, message: `跳过 ${it.title}：文件名不合法` });
      continue;
    }

    // 保持原来的停用状态：.disabled 的更新完还是 .disabled
    const finalName = it.disabled ? `${safeNew}.disabled` : safeNew;
    const finalPath = path.join(targetDir, finalName);
    const tmpPath = path.join(targetDir, `.${safeNew}.downloading`);

    try {
      if (!fs.existsSync(oldPath)) {
        result.skipped.push({ name: it.title ?? it.oldName, note: '原文件已不在' });
        continue;
      }

      onProgress({ done: done - 1, total: items.length, message: `下载 ${it.title} ${it.to}` });
      await downloadFile(it.url, tmpPath, {
        sha1: it.sha1 ?? undefined,
        size: it.size ?? undefined,
        retries: 3,
        timeout: 180000,
      });

      ensureNotCancelled();

      // 老文件进备份，再落新文件
      await fsp.mkdir(backupDir, { recursive: true });
      await fsp.rename(oldPath, path.join(backupDir, it.oldName));
      result.backupDir = backupDir;

      // 同名的情况（只有版本号变了、文件名没变）已经在上一行移走了，这里直接改名
      await fsp.rename(tmpPath, finalPath);

      result.updated.push({
        title: it.title ?? it.oldName,
        type: it.type || 'mod',
        from: it.from,
        to: it.to,
        from_file: it.oldName,
        to_file: finalName,
      });
      onProgress({ done, total: items.length, message: `已更新 ${it.title} → ${it.to}` });
    } catch (e) {
      // 尽力清理临时文件；老文件若已移走，搬回去
      try {
        await fsp.rm(tmpPath, { force: true });
      } catch {
        /* ignore */
      }
      const backedUp = path.join(backupDir, it.oldName);
      if (fs.existsSync(backedUp) && !fs.existsSync(oldPath)) {
        try {
          await fsp.rename(backedUp, oldPath);
        } catch {
          /* 还原失败只能报告 */
        }
      }
      if (e?.cancelled || isCancelled()) {
        result.failed.push({ name: it.title ?? it.oldName, error: '已取消' });
        break;
      }
      result.failed.push({ name: it.title ?? it.oldName, error: e.message });
      onProgress({ done, total: items.length, message: `失败 ${it.title}：${e.message}` });
    }
  }

  return result;
}
