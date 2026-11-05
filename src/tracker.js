/**
 * 整合包追更：盯着你关心的整合包，作者一发新版本就提示你。
 *
 * 为什么单独一层：
 *   追更需要「长期状态」（上次看到哪个版本）+「定时任务」，和安装流程是两件事。
 *   塞进 server.js 会和安装状态机纠缠，也会让 server.js 继续膨胀。
 *
 * ⚠️ 一个必须绕开的坑：
 *   现有 getProjectVersions() 为了「装得对」会按兼容性打分排序（正式版 +10、
 *   匹配游戏版本 +100）。那个排序适合安装，但**不适合追更** ——
 *   它会把一个刚发的 beta 排到最早的正式版后面，导致追更永远看不到 beta。
 *   所以这里直接拉原始版本接口，严格按 date_published 倒序取最新。
 *
 * 时效上限（2026-10-23 实测）：
 *   Modrinth 没有 RSS / webhook（三个地址都 404），只能轮询。
 *   好消息是版本接口几乎没有索引延迟 —— 实测「6 分钟前刚更新」的包，
 *   版本接口立刻就能拿到。所以发现速度只取决于轮询间隔。
 *   默认 5 分钟，最短 1 分钟（再快对 Modrinth 不礼貌，也没什么意义）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchJson } from './download.js';
import { TRACK_FILE, readDataFile, ensureHome } from './paths.js';

export { TRACK_FILE };

const MODRINTH_BASE = 'https://api.modrinth.com/v2';

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
export const MIN_INTERVAL_MS = 60 * 1000;
const MAX_HISTORY = 20;

let cache = null;
let timer = null;
let running = false;
let onUpdateCb = null;

/* ---------------- 状态读写 ---------------- */

function emptyState() {
  return { items: [], intervalMs: DEFAULT_INTERVAL_MS };
}

/** 读状态。文件坏了不能拖垮启动器，退回空状态。 */
export function loadTrack() {
  if (cache) return cache;
  // 优先用户目录；迁移失败时回退老的程序目录
  const found = readDataFile('tracked.json');
  try {
    if (!found) throw new Error('no track file');
    const raw = JSON.parse(found.text);
    cache = {
      items: Array.isArray(raw.items) ? raw.items : [],
      intervalMs: Number(raw.intervalMs) >= MIN_INTERVAL_MS ? Number(raw.intervalMs) : DEFAULT_INTERVAL_MS,
    };
  } catch {
    cache = emptyState();
  }
  return cache;
}

/** 写状态：tmp + rename，避免断电时留下半个 JSON */
async function saveTrack(state) {
  ensureHome();
  const tmp = `${TRACK_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, TRACK_FILE);
  cache = state;
}

/* ---------------- 版本查询 ---------------- */

/**
 * 严格按发布时间倒序拿版本列表。
 * 不能复用 getProjectVersions()，原因见文件头注释。
 */
async function fetchVersionsByDate(slug) {
  const all = await fetchJson(`${MODRINTH_BASE}/project/${encodeURIComponent(slug)}/version`, {
    timeout: 25000,
  });
  if (!Array.isArray(all)) return [];
  return all
    .map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      name: v.name,
      releaseType: v.version_type,
      published: v.date_published,
      gameVersions: v.game_versions ?? [],
      loaders: v.loaders ?? [],
      files: (v.files ?? []).map((f) => ({
        filename: f.filename,
        url: f.url,
        size: f.size,
        sha1: f.hashes?.sha1 ?? null,
        primary: Boolean(f.primary),
      })),
    }))
    .sort((a, b) => String(b.published).localeCompare(String(a.published)));
}

/** 「只看正式版」时，跳过 beta/alpha 找最近的 release */
function pickTarget(versions, releaseOnly) {
  if (!versions.length) return null;
  if (!releaseOnly) return versions[0];
  return versions.find((v) => v.releaseType === 'release') ?? null;
}

/* ---------------- 增删 ---------------- */

/**
 * 添加追更。
 * 关键：首次添加时把「当前最新版」记为基线，**不当成新版本提示** ——
 * 否则一加就弹「发现新版本」，纯属噪音。
 */
export async function addTracked(slugOrUrl, { releaseOnly = false } = {}) {
  const slug = parseSlug(slugOrUrl);
  if (!slug) throw new Error('请填整合包名字或链接，例如 sodium 或 https://modrinth.com/modpack/xxx');

  const state = loadTrack();
  const existing = state.items.find((x) => x.slug === slug);

  // 项目详情：拿标题和图标，顺便验证这个 slug 真的存在
  const proj = await fetchJson(`${MODRINTH_BASE}/project/${encodeURIComponent(slug)}`, { timeout: 25000 });
  if (!proj?.slug) throw new Error(`找不到这个项目：${slug}`);

  const versions = await fetchVersionsByDate(proj.slug);
  const target = pickTarget(versions, releaseOnly);

  if (existing) {
    // 已存在：只更新展示信息和筛选开关，不重置基线（否则会漏掉期间的更新）
    existing.title = proj.title ?? existing.title;
    existing.iconUrl = proj.icon_url ?? existing.iconUrl;
    existing.releaseOnly = releaseOnly;
    await saveTrack(state);
    return { item: existing, created: false };
  }

  const item = {
    slug: proj.slug,
    title: proj.title ?? slug,
    iconUrl: proj.icon_url ?? null,
    projectType: proj.project_type ?? null,
    baselineVersionId: target?.id ?? null,
    baselineVersionNumber: target?.versionNumber ?? null,
    baselinePublished: target?.published ?? null,
    releaseOnly,
    addedAt: new Date().toISOString(),
    lastCheckedAt: null,
    lastError: null,
    history: [],
  };

  state.items.push(item);
  await saveTrack(state);
  return { item, created: true };
}

export async function removeTracked(slug) {
  const state = loadTrack();
  const before = state.items.length;
  state.items = state.items.filter((x) => x.slug !== slug);
  if (state.items.length === before) throw new Error('这个整合包不在追更列表里');
  await saveTrack(state);
  return state.items;
}

/** 从 URL / slug / 名字里取出 modrinth slug */
function parseSlug(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  // https://modrinth.com/modpack/xxx 或 /mod/xxx 或 /project/xxx
  const m = s.match(/modrinth\.com\/(?:modpack|mod|project|shader|resourcepack)\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  // 纯 slug
  if (/^[A-Za-z0-9_-]{2,64}$/.test(s)) return s;
  return null;
}

/* ---------------- 检查更新 ---------------- */

/**
 * 检查单个条目。发现新版本返回新版本对象，否则 null。
 * 出错只记录到 lastError，不抛 —— 一个包挂了不该影响其它包。
 */
async function checkOne(item) {
  item.lastCheckedAt = new Date().toISOString();
  try {
    const versions = await fetchVersionsByDate(item.slug);
    const target = pickTarget(versions, item.releaseOnly);

    if (!target) {
      item.lastError = item.releaseOnly ? '没有正式版' : '没有可用版本';
      return null;
    }

    // 首次建档没基线（比如加的时候项目还没版本），这里补上，不报警
    if (!item.baselineVersionId) {
      item.baselineVersionId = target.id;
      item.baselineVersionNumber = target.versionNumber;
      item.baselinePublished = target.published;
      item.lastError = null;
      return null;
    }

    if (target.id === item.baselineVersionId) {
      item.lastError = null;
      return null; // 没变化
    }

    // 有变化：先确认「确实更新了」而不是回退（极少见，但作者撤版会发生）
    const prevTs = Date.parse(item.baselinePublished ?? '') || 0;
    const nextTs = Date.parse(target.published ?? '') || 0;
    if (nextTs <= prevTs) {
      item.lastError = null;
      return null; // 比基线还旧，当作没更新
    }

    const found = {
      slug: item.slug,
      title: item.title,
      from: item.baselineVersionNumber,
      to: target.versionNumber,
      releaseType: target.releaseType,
      published: target.published,
      gameVersions: target.gameVersions,
      loaders: target.loaders,
      file: target.files.find((f) => f.primary) ?? target.files[0] ?? null,
    };

    item.baselineVersionId = target.id;
    item.baselineVersionNumber = target.versionNumber;
    item.baselinePublished = target.published;
    item.lastError = null;

    item.history.unshift({ ...found, detectedAt: new Date().toISOString() });
    if (item.history.length > MAX_HISTORY) item.history.length = MAX_HISTORY;

    return found;
  } catch (e) {
    item.lastError = e.message.slice(0, 120);
    return null;
  }
}

/**
 * 立刻检查全部条目。
 * 返回「本次发现的更新」数组。同时也通过 onUpdate 回调推给界面。
 */
export async function checkAll() {
  if (running) return []; // 上一轮还没跑完，别叠加
  running = true;
  const state = loadTrack();
  const found = [];

  try {
    for (const item of state.items) {
      const r = await checkOne(item);
      if (r) found.push(r);
      // 逐个查、每个之间停一下：一次性并发打过去容易被限流
      await new Promise((res) => setTimeout(res, 400));
    }
    await saveTrack(state);
    if (found.length && onUpdateCb) onUpdateCb(found);
    return found;
  } finally {
    running = false;
  }
}

/* ---------------- 定时循环 ---------------- */

/**
 * 启动轮询。用 setTimeout 链而不是 setInterval：
 * 上一轮没跑完时 setInterval 会叠加请求，链式就不会。
 */
export function startTracking({ onUpdate } = {}) {
  onUpdateCb = onUpdate ?? null;
  stopTracking();
  schedule();
}

function schedule() {
  const state = loadTrack();
  const interval = Math.max(MIN_INTERVAL_MS, state.intervalMs || DEFAULT_INTERVAL_MS);
  timer = setTimeout(async () => {
    try {
      // 没有追更项就空转，不发请求
      if (loadTrack().items.length > 0) await checkAll();
    } catch {
      /* 单轮失败不影响下一轮 */
    }
    schedule();
  }, interval);
  // 别让这个定时器拖住进程退出
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopTracking() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 调轮询间隔（毫秒），立即生效 */
export async function setTrackInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) throw new Error('间隔必须是数字');
  const state = loadTrack();
  state.intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(60 * 60 * 1000, Math.floor(n)));
  await saveTrack(state);
  schedule(); // 重新排下一轮
  return state.intervalMs;
}

/** 给界面看的列表（不含内部字段） */
export function listTracked() {
  const state = loadTrack();
  return {
    intervalMs: state.intervalMs,
    items: state.items.map((x) => ({
      slug: x.slug,
      title: x.title,
      iconUrl: x.iconUrl,
      projectType: x.projectType,
      currentVersion: x.baselineVersionNumber,
      currentPublished: x.baselinePublished,
      releaseOnly: x.releaseOnly,
      addedAt: x.addedAt,
      lastCheckedAt: x.lastCheckedAt,
      lastError: x.lastError,
      updates: (x.history ?? []).slice(0, 5),
    })),
  };
}
