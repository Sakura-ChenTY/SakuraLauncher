/**
 * 本地 HTTP 服务：给前端提供 API + 静态文件 + SSE 进度推送
 *
 * 为什么用 SSE 而不是 WebSocket：
 *   进度是单向的（服务端 -> 浏览器），SSE 用原生 EventSource 即可，
 *   不需要额外依赖，也不需要握手协商，断线浏览器会自动重连。
 *
 * 安全边界：只监听 127.0.0.1，且校验 Origin/Host，避免局域网其他机器
 * 通过浏览器打这个接口来启动游戏或下载文件。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import net from 'node:net';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { launch, listVersions, DEFAULT_GAME_DIR } from './launch.js';
import { startJob, endJob, cancelJob, isCancelled, CancelledError, rollbackJob } from './download.js';
import { installVersion, getVersionManifest, latestReleases, findVersionInManifest } from './installer.js';
import { searchProjects, getProjectVersions, getProject, detectLoaderFromVersionJson, PROJECT_TYPES } from './modrinth.js';
import { installFabric, listLoaders } from './fabric.js';
import { installForge, installNeoForge } from './forge.js';
import { initSecureStore, setToken, clearToken, hasToken } from './secure.js';
import {
  loadAiConfig,
  saveAiConfig,
  aiHasKey,
  aiKeyMask,
  testAi,
  analyzeFailure,
} from './ai.js';
import { markInstallStart, markInstallEnd, takeInterruptedInstall } from './install-marker.js';
import { onboardingState, completeOnboarding, resetOnboarding } from './onboarding.js';
import {
  saveProviderToken,
  listTunnels,
  startTunnel,
  stopTunnel,
  createTunnel,
  detectFrpc,
  detectClient,
  importClientToken,
  saveCustomConfig,
  prepareFrpc,
  onlineSnapshot,
  detectLanPort,
  setSakuraTunnelLocalPort,
} from './online.js';
import { startRoom, stopRoom, getRoomState, setRoomFrp, failRoom, attachHostGame, onHostGameExit, getWorldSettings, saveWorldSettings } from './gameserver.js';
import { readRecent, saveRecent, clearRecent, validateRecent } from './recent-play.js';
import { openPort as openUpnp, closePort as closeUpnp, mappingState as upnpState } from './upnp.js';
import { installContent, listInstalled, removeContent, toggleContent } from './content.js';
import { checkModUpdates, applyModUpdates } from './modupdate.js';
import { installModpack, previewModpack } from './modpack.js';
import { listEntries, readEntry } from './zip.js';
import {
  searchProjects as cfSearchProjects,
  getProjectBySlug as cfGetProjectBySlug,
  getProject as cfGetProject,
  getProjectFiles as cfGetProjectFiles,
  hasCfKey,
  cfKeyMask,
} from './curseforge.js';
import { installCurseForgePack, previewCurseForgePack } from './cfpack.js';
import { createSession, getSession, chatSession } from './assistant-session.js';
import { detectSymptom, guessSymptom, collectSymptomContext, SYMPTOMS, IMPLEMENTATION_NOTES } from './assistant-diagnostics.js';
import { previewDiagnosticPackage, createDiagnosticPackage, createCrashDiagnosticPackage, sanitizeDiagnostic } from './diagnostic-package.js';
import { snapshotCrashArtifacts, newCrashArtifacts } from './crash-watch.js';
import { previewExport, exportInstance } from './modpack-export.js';
import { previewPackUpdate, applyPackUpdate } from './packupdate.js';
import { listSaves, backupWorld, backupAll, restoreBackup, autoBackupAll } from './saves.js';
import { previewSaveImport, importSave } from './saveimport.js';
import {
  addTracked,
  removeTracked,
  checkAll,
  listTracked,
  setTrackInterval,
  startTracking,
} from './tracker.js';
import { scanJavas } from './java.js';
import { getSkin, clearSkinCache, saveCustomSkin, clearCustomSkin, hasCustomSkin, defaultSkinFor, readDefaultSkin } from './skin.js';
import { loadPlugins, savePlugin, deletePlugin, togglePlugin, runPluginCode } from './plugins.js';
import { JAVA_SCAN_CACHE } from './paths.js';
import { HOME_DIR } from './paths.js';
import { getSettings, saveSettings, DEFAULTS, SETTINGS_FILE } from './settings.js';
import { resolveSource, measureSources, clearSourceCache } from './speedtest.js';
import { appendLogLine } from './logfile.js';
import { listTrash, restoreTrash, purgeTrash } from './trash.js';
import { resolveRequiredDependencies } from './dependencies.js';
import { installCfManifestMods } from './cfimport.js';
import { ensureVersionFiles } from './preflight.js';
import { SOURCES, SOURCE_IDS } from './sources.js';
import {
  msStartDeviceCode,
  msPollToken,
  msCompleteLogin,
  msEnsureFresh,
  yggdrasilMeta,
  yggdrasilLogin,
  yggdrasilSelectProfile,
  yggdrasilProfileSkin,
  yggdrasilRefresh,
  yggdrasilValidate,
  YGGDRASIL_PRESETS,
  normalizeServerUrl,
  makeOfflineAccount,
  loadAccounts,
  saveAccounts,
  upsertAccount,
  removeAccount,
  selectAccount,
  currentAccount,
  accountKey,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* 版本号从 package.json 读，不在代码里另写一份 ——
   两处各写一个版本号迟早会对不上（改了一边忘了另一边）。
   读不到就退回 '0.0.0'，绝不能因此让服务起不来。 */
let APP_VERSION = '0.0.0';
try {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  APP_VERSION = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')).version || APP_VERSION;
} catch {
  /* 打包后路径可能不同，读不到就用占位值 */
}

/* ---- 外置登录站点（拖入 / 粘贴） ---- */
const YGG_SITES_FILE = path.join(HOME_DIR, 'yggdrasil-sites.json');

async function loadYggSites() {
  try {
    const raw = await fsp.readFile(YGG_SITES_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.sites) ? data.sites : [];
  } catch {
    return [];
  }
}

async function saveYggSites(sites) {
  await fsp.mkdir(path.dirname(YGG_SITES_FILE), { recursive: true });
  const tmp = `${YGG_SITES_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ sites }, null, 2), 'utf8');
  await fsp.rename(tmp, YGG_SITES_FILE);
  return sites;
}

/** 把拖入/粘贴的文本变成候选 API 地址；不验证网络 */
function extractYggUrl(raw) {
  let s = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\u200B/g, '').trim();
  if (!s) return null;
  const attr = s.match(/(?:href|data-url|data-href|data-clipboard-text)\s*=\s*["']([^"']+)["']/i);
  if (attr) s = attr[1];
  else {
    const m = s.match(/https?:\/\/[^\s"'<>]+/i);
    if (m) s = m[0];
  }
  s = s.replace(/&amp;/g, '&').trim();
  s = s.replace(/^[<"'“”‘’]+|[>"'“”‘’]+$/g, '').replace(/[),.;]+$/g, '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (!/^[\w.-]+(?::\d+)?(?:\/|$)/.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    u.protocol = 'https:';
    let pathname = u.pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/') pathname = '/api/yggdrasil';
    u.pathname = pathname;
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** 按 精确 -> 去文档前缀 -> 根路径 的顺序生成候选；失败再换下一个 */
function yggCandidateUrls(raw) {
  const exact = extractYggUrl(raw);
  if (!exact) return [];
  const u = new URL(exact);
  const pathname = u.pathname.replace(/\/+$/, '') || '/api/yggdrasil';
  const hosts = [u.hostname];
  const stripped = u.hostname.replace(/^(manual|docs|help|wiki)\./i, '');
  if (stripped && stripped !== u.hostname) hosts.push(stripped);
  const paths = [pathname];
  if (pathname !== '/api/yggdrasil') paths.push('/api/yggdrasil');
  const out = [];
  const seen = new Set();
  for (const host of hosts) {
    for (const p of paths) {
      const href = `https://${host}${p}`;
      if (!seen.has(href)) {
        seen.add(href);
        out.push(href);
      }
    }
  }
  return out;
}

function recognizeYggInput(raw) {
  return yggCandidateUrls(raw)[0] ?? null;
}

async function resolveYggSite(raw) {
  const received = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const candidates = yggCandidateUrls(raw);
  if (!candidates.length) {
    throw new Error(`这不是外置登录地址（收到：${received || '空内容'}）`);
  }
  const tried = [];
  for (const candidate of candidates) {
    try {
      pushLog(`[ygg] 尝试 ${candidate}（收到 ${received}）`);
      const meta = await yggdrasilMeta(candidate);
      pushLog(`[ygg] 成功 ${candidate} -> ${meta.serverName}`);
      return { url: meta.base, meta, candidate, tried };
    } catch (e) {
      tried.push(`${candidate} -> ${e.message}`);
      pushLog(`[ygg] 失败 ${candidate} -> ${e.message}`);
    }
  }
  throw new Error(
    `这不是外置登录地址（收到：${received}；试过：${tried.join('；')}）`
  );
}

async function validateYggSite(raw) {
  return resolveYggSite(raw);
}

/* ---- 内存上限：物理内存 80%，硬顶 40960M ---- */
function memoryToMb(v) {
  const s = String(v ?? '').trim().toUpperCase();
  const m = s.match(/^(\d{1,6})([MG])?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === 'G' ? n * 1024 : n;
}

function memoryCapMb() {
  return Math.max(1024, Math.min(40960, Math.floor((os.totalmem() / 1024 / 1024) * 0.8)));
}

/** gh-proxy.com / ghproxy.net 镜像优先；GitHub 直连作为第二跳 */
const UPDATE_MIRRORS = [
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
];
const UPDATE_MIRROR_PREFIXES = [...UPDATE_MIRRORS, 'https://ghfast.top/'];

function bareUpdateUrl(url) {
  const u = String(url ?? '').trim();
  for (const prefix of UPDATE_MIRROR_PREFIXES) {
    if (u.toLowerCase().startsWith(prefix)) return u.slice(prefix.length);
  }
  return u;
}

function updateUrlCandidates(url) {
  const u = String(url ?? '').trim().replace(/\/+$/, '');
  if (!u) return [];
  const canonical = bareUpdateUrl(u);
  if (!/^https:\/\/github\.com\//i.test(canonical)) return [u];
  const list = [];
  // 配置的地址如果是可用镜像，先尊重它；旧 ghfast 地址不再排第一。
  if (UPDATE_MIRRORS.some((m) => u.toLowerCase().startsWith(m))) list.push(u);
  else list.push(`${UPDATE_MIRRORS[0]}${canonical}`);
  list.push(canonical);
  for (const mirror of UPDATE_MIRRORS) {
    const candidate = `${mirror}${canonical}`;
    if (!list.includes(candidate)) list.push(candidate);
  }
  return [...new Set(list)];
}

function isNewerVersion(current, latest) {
  const norm = (v) => String(v).replace(/^v/i, '').split(/[.+-]/).map((x) => Number(x) || 0);
  const a = norm(current);
  const b = norm(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false;
  }
  return false;
}

/** latest.yml 旁边通常没有 latest.json；旧配置写 latest.json 时自动改试 yml。 */
function updateFileCandidates(urls) {
  const out = [];
  for (const u of urls) {
    out.push(u);
    if (/latest\.json(?:[?#].*)?$/i.test(u)) out.push(u.replace(/latest\.json/i, 'latest.yml'));
    else if (/latest\.yml(?:[?#].*)?$/i.test(u)) out.push(u.replace(/latest\.yml/i, 'latest.json'));
  }
  return [...new Set(out)];
}

/** electron-builder 的 latest.yml -> 启动器当前需要的更新对象。 */
function updateFromLatestYml(text, sourceUrl) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new Error('latest.yml 解析失败：' + e.message);
  }
  if (!doc || typeof doc !== 'object') throw new Error('latest.yml 内容为空');
  const version = String(doc.version ?? '').trim().replace(/^v/i, '');
  const files = Array.isArray(doc.files) ? doc.files : [];
  const file = files.find((f) => f && f.url) || (doc.path ? {
    url: doc.path,
    sha512: doc.sha512,
    size: doc.size,
  } : null);
  if (!version || !file?.url) throw new Error('latest.yml 缺 version/文件地址');
  let url;
  try {
    url = new URL(String(file.url), sourceUrl).toString();
  } catch {
    throw new Error('latest.yml 文件地址不合法');
  }
  return {
    version,
    url,
    notes: String(doc.releaseNotes ?? doc.notes ?? ''),
    // electron-builder 默认只写 sha512；保留空 sha256，前端不依赖它做一键更新。
    sha256: String(file.sha256 ?? doc.sha256 ?? '').trim().toLowerCase(),
  };
}

function updateFromResponse(text, sourceUrl) {
  try {
    const data = JSON.parse(text);
    if (data?.version && data?.url) {
      return {
        version: String(data.version).replace(/^v/i, ''),
        url: String(data.url),
        notes: String(data.notes ?? ''),
        sha256: String(data.sha256 ?? '').trim().toLowerCase(),
      };
    }
  } catch { /* 不是 JSON，继续按 latest.yml 解析 */ }
  return updateFromLatestYml(text, sourceUrl);
}

/* ---- options.txt：只改认识的键，保留其它行 ---- */
const GAME_OPTION_DEFAULTS = {
  renderDistance: 12,
  simulationDistance: 12,
  fov: 70,
  gamma: 0.5,
  maxFps: 120,
  graphicsMode: 'fancy',
  particles: 'all',
  entityShadows: true,
  vsync: false,
  fullscreen: false,
  guiScale: 0,
  soundCategory_master: 1,
  soundCategory_music: 1,
  soundCategory_blocks: 1,
  soundCategory_ambient: 1,
  soundCategory_weather: 1,
  lang: 'zh_cn',
  autoJump: true,
  viewBobbing: true,
  narrator: 0,
};

const GAME_OPTION_BOOLS = new Set(['entityShadows', 'vsync', 'fullscreen', 'autoJump', 'viewBobbing']);
const GAME_OPTION_INTS = new Set([
  'renderDistance', 'simulationDistance', 'maxFps', 'guiScale', 'narrator',
]);

function optionsFilePath(versionId) {
  const dir = resolveInstanceDir(versionId);
  if (!dir) throw new Error('实例不存在');
  return path.join(dir, 'options.txt');
}

function optionValueString(key, value) {
  if (GAME_OPTION_BOOLS.has(key)) return value ? 'true' : 'false';
  if (GAME_OPTION_INTS.has(key)) return String(Math.round(Number(value) || 0));
  if (typeof value === 'number') {
    if (key === 'gamma' || key.startsWith('soundCategory_')) return String(Number(value.toFixed(2)));
    return String(value);
  }
  // options.txt 的字符串值（lang 等）按原样写，不加引号
  return String(value ?? '').replace(/[\r\n]/g, '');
}

function parseOptionValue(key, raw) {
  const s = String(raw ?? '').trim();
  const unquoted = s.replace(/^"(.*)"$/, '$1');
  if (GAME_OPTION_BOOLS.has(key)) return unquoted === 'true';
  if (GAME_OPTION_INTS.has(key)) {
    const n = Number(unquoted);
    return Number.isFinite(n) ? n : GAME_OPTION_DEFAULTS[key];
  }
  if (key === 'gamma' || key.startsWith('soundCategory_') || key === 'fov') {
    const n = Number(unquoted);
    return Number.isFinite(n) ? n : GAME_OPTION_DEFAULTS[key];
  }
  return unquoted;
}

function readOptions(versionId) {
  const file = optionsFilePath(versionId);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 还没有 options.txt */ }
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) map.set(line.slice(0, i), line.slice(i + 1));
  }
  const values = {};
  for (const [key, fallback] of Object.entries(GAME_OPTION_DEFAULTS)) {
    values[key] = map.has(key) ? parseOptionValue(key, map.get(key)) : fallback;
  }
  return { file, exists: fs.existsSync(file), values };
}

/** 新实例 / 首次启动：没有 lang 就补 zh_cn；已有设置不覆盖 */
function ensureChineseLanguage(versionId) {
  const file = optionsFilePath(versionId);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 新实例 */ }
  if (/^lang\s*:/m.test(text)) return false;
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  else fs.mkdirSync(path.dirname(file), { recursive: true });
  const suffix = text && !text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, `${text}${suffix}lang:zh_cn\n`, 'utf8');
  return true;
}

function writeOptions(versionId, values) {
  const file = optionsFilePath(versionId);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 新建 */ }
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set();
  const has = (key) => Object.prototype.hasOwnProperty.call(values ?? {}, key);
  const next = lines.map((line) => {
    const i = line.indexOf(':');
    if (i <= 0) return line;
    const key = line.slice(0, i);
    if (!(key in GAME_OPTION_DEFAULTS) || seen.has(key)) return line;
    seen.add(key);
    // 没在本次表单里提交的已知键也保持原行，不拿默认值覆盖
    if (!has(key)) return line;
    return `${key}:${optionValueString(key, values[key])}`;
  });
  for (const key of Object.keys(values ?? {})) {
    if (!(key in GAME_OPTION_DEFAULTS) || seen.has(key)) continue;
    next.push(`${key}:${optionValueString(key, values[key])}`);
    seen.add(key);
  }
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${next.join('\n')}\n`, 'utf8');
  return { file, backup: `${file}.bak` };
}

/* ---- 拖入文件导入 ---- */
function safeInstanceName(name, fallback = 'imported-pack') {
  const s = String(name ?? '').replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').trim().slice(0, 60);
  return s || fallback;
}

function extractZipTo(buf, entries, targetDir, mapRel = (name) => name) {
  const root = path.resolve(targetDir);
  fs.mkdirSync(root, { recursive: true });
  let count = 0;
  for (const e of entries) {
    if (!e.name || e.name.endsWith('/')) continue;
    const rel = mapRel(e.name.replace(/\\/g, '/'));
    if (!rel) continue;
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readEntry(buf, e));
    count += 1;
  }
  return count;
}

function importEntryRel(name, manifest) {
  let rel = String(name || '').replace(/\\/g, '/');
  if (!manifest) return rel;
  const prefix = String(manifest.overrides || 'overrides').replace(/\\/g, '/').replace(/\/+$/, '');
  if (rel === 'manifest.json' || rel === `${prefix}/`) return '';
  if (rel.startsWith(`${prefix}/`)) rel = rel.slice(prefix.length + 1);
  return rel;
}

function buildImportPlan(entries, targetDir, mapRel) {
  const root = path.resolve(targetDir);
  const overwritePaths = [];
  let overwrites = 0;
  let additions = 0;
  for (const e of entries) {
    if (!e.name || e.name.endsWith('/')) continue;
    const rel = mapRel(e.name.replace(/\\/g, '/'));
    if (!rel) continue;
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) continue;
    if (fs.existsSync(dest)) {
      overwrites += 1;
      if (overwritePaths.length < 10) overwritePaths.push(rel);
    } else {
      additions += 1;
    }
  }
  return { overwrites, additions, overwritePaths };
}

async function handleDroppedFile(filePath, versionId, opts = {}) {
  const src = path.resolve(String(filePath ?? ''));
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new Error('拖入的文件不存在');
  }
  const ext = path.extname(src).toLowerCase();
  const targetVersion = versionId || state.selectedVersion || '';

  if (ext === '.jar') {
    if (!targetVersion) throw new Error('拖入 jar 需要先在版本页选中一个实例');
    const dir = resolveInstanceDir(targetVersion);
    if (!dir) throw new Error('目标实例不存在');
    const outDir = path.join(dir, 'mods');
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, path.basename(src));
    fs.copyFileSync(src, dest);
    pushLog(`拖入 jar：${path.basename(src)} → ${targetVersion}/mods`);
    return { kind: 'mod', versionId: targetVersion, file: dest };
  }

  if (ext !== '.zip' && ext !== '.mrpack') {
    throw new Error('只支持拖入整合包 zip / mrpack 或单个 jar');
  }

  const buf = fs.readFileSync(src);
  const entries = listEntries(buf);
  const names = entries.map((e) => e.name.replace(/\\/g, '/'));
  const isMrpack = /\.mrpack$/i.test(ext) || names.some((n) => n === 'modrinth.index.json' || n.endsWith('/modrinth.index.json'));

  if (isMrpack) {
    if (opts.preview) return { kind: 'modpack', preview: true, versionId: path.parse(src).name };
    if (state.installing) throw new Error('已有安装任务在进行');
    if (state.running) throw new Error('游戏正在运行，先退出再导入');
    state.installing = { versionId: path.parse(src).name, stage: 'modpack', done: 0, total: 0 };
    markInstallStart({ versionId: state.installing.versionId, stage: 'modpack' });
    startJob();
    emit('modpack-start', { mrpackPath: src });
    (async () => {
      try {
        const r = await installModpack({
          gameDir: state.gameDir,
          mrpackPath: src,
          source: (await awaitOrCancel(resolveSource(getSettings().downloadSource))).source,
          onStage: ({ stage, message }) => {
            state.installing = { ...state.installing, stage, message };
            emit('install-stage', { versionId: state.installing.versionId, stage, message });
            pushLog(`[${stage}] ${message}`);
          },
          onProgress: (p) => {
            state.installing = { ...state.installing, ...p };
            emit('install-progress', { versionId: state.installing.versionId, ...p });
          },
        });
        ensureChineseLanguage(r.instanceId);
        state.installing = null;
        endJob();
        emit('install-done', { versionId: r.instanceId, report: r });
        pushLog(`本地整合包导入完成：${r.instanceId}`);
      } catch (e) {
        state.installing = null;
        endJob();
        emit('install-error', { versionId: path.parse(src).name, error: e.message });
        pushLog(`本地整合包导入失败：${e.message}`);
      } finally {
        markInstallEnd();
      }
    })();
    return { kind: 'modpack', started: true };
  }

  // 普通 zip：找 manifest.json 认版本/名字，解压到实例目录
  const manifestEntry = entries.find((e) => /(^|\/)manifest\.json$/i.test(e.name));
  let manifest = null;
  if (manifestEntry) {
    try { manifest = JSON.parse(readEntry(buf, manifestEntry).toString('utf8')); } catch { /* ignore */ }
  }
  const mcVersion = manifest?.minecraft?.version ?? '';
  const sakuraExport = manifest?.format === 'sakura-instance';
  const cfManifest = !sakuraExport && Array.isArray(manifest?.files) && Boolean(manifest?.minecraft);
  let instanceId = targetVersion || safeInstanceName(manifest?.name || path.parse(src).name);
  if (sakuraExport) {
    // 自己导出的包：默认建一个新实例，避免同名覆盖原实例。
    const base = safeInstanceName(manifest?.name || path.parse(src).name);
    instanceId = base;
    let n = 2;
    while (fs.existsSync(path.join(state.gameDir, 'versions', instanceId))) {
      instanceId = `${base}-${n}`;
      n += 1;
    }
  }
  const instanceDir = path.join(state.gameDir, 'versions', instanceId);
  const mapRel = cfManifest
    ? (name) => importEntryRel(name, manifest)
    : (name) => name;
  const plan = buildImportPlan(entries, instanceDir, mapRel);
  if (opts.preview) {
    return {
      kind: 'zip',
      preview: true,
      versionId: instanceId,
      gameVersion: mcVersion || null,
      loader: manifest?.loader || (cfManifest ? 'curseforge' : null),
      ...plan,
      cf: cfManifest ? { files: manifest.files.length } : null,
    };
  }

  if (opts.backupSaves && fs.existsSync(instanceDir)) {
    await backupAll({
      gameDir: state.gameDir,
      versionId: instanceId,
      whileRunning: Boolean(state.running),
      source: 'manual',
    });
  }
  const count = extractZipTo(buf, entries, instanceDir, mapRel);
  let cfResult = null;
  if (cfManifest) {
    try {
      cfResult = await installCfManifestMods({
        gameDir: state.gameDir,
        versionId: instanceId,
        manifest,
      });
    } catch (e) {
      cfResult = { installed: [], skipped: [], failed: [{ name: 'CurseForge 清单', reason: e.message }] };
    }
  }
  if (sakuraExport) {
    const sourceName = String(manifest?.versionJson || `${manifest?.name || ''}.json`).replace(/\\/g, '/');
    const sourceJson = path.join(instanceDir, sourceName);
    const targetJson = path.join(instanceDir, `${instanceId}.json`);
    if (!fs.existsSync(sourceJson)) {
      throw new Error(`整合包缺少版本描述：${sourceName || 'version JSON'}`);
    }
    const versionData = JSON.parse(fs.readFileSync(sourceJson, 'utf8'));
    versionData.id = instanceId;
    if (sourceJson !== targetJson) fs.rmSync(sourceJson, { force: true });
    fs.writeFileSync(targetJson, JSON.stringify(versionData, null, 2), 'utf8');
  }
  const installedMods = cfResult
    ? cfResult.installed
    : entries
      .map((e) => importEntryRel(e.name, null))
      .filter((name) => /^mods\/[^/]+\.jar$/i.test(name))
      .map((name) => name.slice(5));
  const skipped = cfResult ? [...(cfResult.skipped || []), ...(cfResult.failed || [])] : [];
  const summary = `导入完成：Mod ${installedMods.length} 个，覆盖 ${plan.overwrites} 个文件，跳过 ${skipped.length} 个`;
  pushLog(`拖入 zip：解压 ${count} 个文件 → ${instanceId}${mcVersion ? `（MC ${mcVersion}）` : ''}；${summary}`);
  return {
    kind: 'zip',
    versionId: instanceId,
    gameVersion: mcVersion || null,
    loader: cfResult?.loader || manifest?.loader || null,
    files: count,
    overwrites: plan.overwrites,
    additions: plan.additions,
    mods: installedMods,
    skipped,
    summary,
  };
}

const MIME = {  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

/** 全局状态：当前安装/游戏进程 */
const hadSettingsAtStart = fs.existsSync(SETTINGS_FILE);
const initialSettings = getSettings();

export const state = {
  gameDir: initialSettings.gameDir || DEFAULT_GAME_DIR,
  installing: null,   // { versionId, stage, done, total, ... }
  running: null,      // { versionId, pid, startedAt }
  lanPort: null,      // 从游戏 stdout 抓到的「对局域网开放」端口
  lastFailure: null,  // 最近一次非 0 退出的摘要
  lastLaunch: null,   // 最近一次实际启动命令与进程信息
  crashBaseline: null, // 本次启动前的 crash/hs_err 文件快照
  crashIncident: null, // 最近一次自动崩溃提示
  logs: [],           // 最近日志行（环形，最多 500）
  installInterrupted: null, // 上次安装被中断的信息（启动时取一次）
  forceFirstRun: false, // --first-run：强制显示引导，不删数据
  msLogin: null,      // 进行中的微软设备码登录 { deviceCode, userCode, ... }
};

const activeTasks = new Map();

function startTask(kind, requestedId) {
  const id = String(requestedId || crypto.randomUUID());
  activeTasks.set(id, { id, kind, cancelled: false, startedAt: Date.now() });
  return id;
}

function taskCancelled(id) {
  return Boolean(activeTasks.get(String(id))?.cancelled);
}

function finishTask(id) {
  if (id) activeTasks.delete(String(id));
}

function cancelTask(id) {
  const task = activeTasks.get(String(id));
  if (!task) return false;
  task.cancelled = true;
  return true;
}

const bus = new EventEmitter();
bus.setMaxListeners(50);
const RUNNING_RESTORE_BLOCK = '游戏还开着，先关掉再恢复';

function emit(type, payload) {
  bus.emit('event', { type, at: Date.now(), ...payload });
}

function pushLog(line) {
  const entry = { at: Date.now(), line: String(line) };
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  emit('log', entry);
  try {
    const dir = path.join(os.homedir(), '.mclauncher', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    appendLogLine(
      path.join(dir, 'launcher.log'),
      `${new Date(entry.at).toISOString()} ${entry.line}\n`
    );
  } catch {
    /* 文件日志失败不影响运行 */
  }
}

/**
 * 等一个可能很慢的异步（比如测速），但一旦用户取消就立即抛 CancelledError。
 *
 * 为什么不能只靠下游 downloadFile 自查：
 *   实测过 —— auto 源测速要十几秒，用户在这段时间点取消，
 *   接口返回 200 了，但任务一直卡在 stage=start 不动，
 *   界面看起来就是“点了没反应”。取消必须在每个阶段边界都能生效。
 */
async function awaitOrCancel(promise, tickMs = 120) {
  if (isCancelled()) throw new CancelledError();
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setInterval(() => {
          if (isCancelled()) {
            clearInterval(timer);
            timer = null;
            reject(new CancelledError());
          }
        }, tickMs);
      }),
    ]);
  } finally {
    if (timer) clearInterval(timer);
  }
}

/* ---------------- 静态文件 ---------------- */

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, rel);

  // 防目录穿越：解析后必须仍在 public 内
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

/* ---------------- 请求体 ---------------- */

async function readBody(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) {
      throw new Error('请求体过大');
    }
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 发给前端的账号：抹掉令牌，只留能展示的字段 */
function safeAccount(a) {
  return {
    key: accountKey(a),
    type: a.type,
    name: a.name,
    uuid: a.uuid,
    serverName: a.serverName ?? null,
    server: a.server ?? null,
    expiresAt: a.expiresAt ?? null,
    addedAt: a.addedAt ?? null,
  };
}

/* ---------------- 业务 ---------------- */

async function handleInstall(versionId) {
  if (state.installing) throw new Error('已有安装任务在进行');
  if (state.running) throw new Error('游戏正在运行，先退出再安装');

  const s = getSettings();

  state.installing = { versionId, stage: 'start', done: 0, total: 0 };
  markInstallStart({ versionId, stage: 'start' });
  // 开一个新任务：把取消句柄重置掉，下载层才能被这一次中断
  startJob();
  emit('install-start', { versionId });
  pushLog(`开始安装 ${versionId}`);

  // 后台跑，立刻返回，进度走 SSE
  (async () => {
    try {
      // auto 模式会先实测各源吞吐，挑最快的；手动指定则直接用
      const pick = await awaitOrCancel(resolveSource(s.downloadSource));
      pushLog(`下载源：${pick.reason}`);
      emit('install-stage', { versionId, stage: 'source', message: `下载源：${pick.reason}` });

      const report = await installVersion({
        gameDir: state.gameDir,
        versionId,
        concurrency: s.concurrency,
        source: pick.source,
        onStage: ({ stage, message }) => {
          state.installing = { ...state.installing, stage, message };
          emit('install-stage', { versionId, stage, message });
          pushLog(`[${stage}] ${message}`);
        },
        onProgress: (p) => {
          state.installing = { ...state.installing, ...p };
          emit('install-progress', { versionId, ...p });
        },
      });
      state.installing = null;
      endJob();
      emit('install-done', { versionId, report });
      pushLog(`安装完成 ${versionId}，ok=${report.ok}`);
      try { ensureChineseLanguage(versionId); } catch { /* 不阻断安装 */ }
    } catch (e) {
      // 取消 = 回滚（对齐 PCL）：把本次写下的文件与新建目录清干净，
      // 必须赶在 endJob() 之前 —— 清空了 currentJob 就不知道删什么了。
      const cancelled = e?.cancelled || e instanceof CancelledError;
      let wiped = null;
      if (cancelled) {
        try {
          wiped = await rollbackJob();
        } catch {
          /* 回滚失败不该盖住取消本身 */
        }
      }
      state.installing = null;
      endJob();
      // 取消不是失败：单独一种事件，前端可以把卡片收掉而不是报红
      if (cancelled) {
        emit('install-cancelled', {
          versionId,
          message: e.message || '已取消',
          wiped: wiped ?? undefined,
        });
        pushLog(
          wiped && (wiped.files || wiped.dirs)
            ? `已取消安装 ${versionId}，清理本次下载 ${wiped.files} 个文件、${wiped.dirs} 个空目录`
            : `已取消安装 ${versionId}`
        );
        return;
      }
      emit('install-error', { versionId, error: e.message });
      pushLog(`安装失败 ${versionId}: ${e.message}`);
    } finally {
      markInstallEnd();
    }
  })();

  return { started: true, versionId };
}

/**
 * 把游戏子进程的输出同时写到终端和内存日志。
 *
 * 先按行缓存原始字节，再解码：
 *   - UTF-8 优先，中文/emoji 跨 chunk 不会切出 �；
 *   - 如果 UTF-8 解不动（中文 Windows 下 Java 8 可能吐 GBK），
 *     用 GBK 再试一次；
 *   - close 时 flush 剩余缓冲，崩溃的最后一行往往没有换行，不能吞。
 */
function pipeGameLog(stream, out, onLine) {
  if (!stream) return;
  let pending = Buffer.alloc(0);
  let done = false;

  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let gbk = null;
  try {
    gbk = new TextDecoder('gbk', { fatal: true });
  } catch {
    /* ICU 不带 GBK 就只走 UTF-8 */
  }

  const decodeLine = (buf) => {
    try {
      return utf8.decode(buf);
    } catch {
      if (gbk) {
        try {
          return gbk.decode(buf);
        } catch {
          /* 两种都不行，退回宽松 UTF-8 */
        }
      }
      return buf.toString('utf8');
    }
  };

  const emitLine = (buf) => {
    const line = decodeLine(buf).replace(/\r$/, '');
    if (line.length) onLine(line);
  };

  const consume = (flush = false) => {
    let idx;
    while ((idx = pending.indexOf(0x0a)) !== -1) {
      emitLine(pending.subarray(0, idx));
      pending = pending.subarray(idx + 1);
    }
    if (flush && pending.length) {
      emitLine(pending);
      pending = Buffer.alloc(0);
    }
  };

  const flush = () => {
    if (done) return;
    done = true;
    consume(true);
  };

  stream.on('data', (chunk) => {
    try {
      out.write(chunk);
    } catch {
      /* 终端已关，不影响日志面板 */
    }
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    consume(false);
  });
  stream.on('end', flush);
  stream.on('close', flush);
  stream.on('error', flush);
}

function parseLanPortLine(line) {
  const text = String(line ?? '');
  const patterns = [
    /Local game hosted on port\s+(\d{2,5})/i,
    /Started serving on\s+(?:[^\s:]+:)?(\d{2,5})\b/i,
    /Started serving on\s+(\d{2,5})\b/i,
    /对局域网开放[^\n]*?(\d{2,5})/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const port = Number(m[1]);
      if (port > 0 && port < 65536) return port;
    }
  }
  return null;
}

async function restoreRoomSakuraPort(frp) {
  if (!frp || frp.provider !== 'sakura') return '';
  if (!frp.originalLocalPort || Number(frp.originalLocalPort) === Number(frp.localPort)) return '';
  try {
    await setSakuraTunnelLocalPort(frp.tunnelId, frp.originalLocalPort);
    return '';
  } catch (e) {
    return e.message || String(e);
  }
}
async function runAutoBackup(versionId, source) {
  const s = getSettings();
  if (!s.autoBackup) return;
  if (source === 'beforeLaunch' && !s.autoBackupBeforeLaunch) return;
  if (source === 'afterExit' && !s.autoBackupAfterExit) return;
  try {
    const results = await autoBackupAll({
      gameDir: state.gameDir,
      versionId,
      source,
      keep: s.autoBackupKeep,
      onProgress: (p) => {
        if (p?.message) pushLog(`自动备份：${p.message}`);
      },
    });
    for (const r of results) {
      if (r.error) pushLog(`自动备份失败：${r.world}: ${r.error}`);
      else if (r.removed?.length) pushLog(`自动备份清理：${r.world} 删除 ${r.removed.join(', ')}`);
    }
  } catch (e) {
    pushLog(`自动备份失败：${e.message}`);
  }
}

async function handleLaunch({ versionId, joinAddress, quickPlaySave, recentMeta }) {
  if (state.installing) throw new Error('正在安装，稍后再启动');
  if (state.running) throw new Error(`已有游戏在运行（PID ${state.running.pid}）`);

  let extraGame = [];
  if (joinAddress) {
    const m = /^([^:/\s]+):(\d{1,5})$/.exec(String(joinAddress).trim());
    if (!m) throw new Error('加入地址格式应为 host:port');
    const port = Number(m[2]);
    if (!(port > 0 && port < 65536)) throw new Error('加入端口不合法');
    // 1.20.1 起客户端不再识别旧的 --server/--port，Quick Play 才是可用入口。
    const info = readInstanceInfo(versionId) || {};
    const mcVersion = String(info.gameVersion || versionId).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] || '';
    const [maj, min = 0, patch = 0] = mcVersion.split('.').map((x) => Number(x) || 0);
    const quickPlay = maj > 1 || (maj === 1 && (min > 20 || (min === 20 && patch >= 1)));
    if (quickPlay) extraGame = ['--quickPlayMultiplayer', `${m[1]}:${port}`];
    else extraGame = ['--server', m[1], '--port', String(port)];
  } else if (quickPlaySave) {
    extraGame = ['--quickPlaySingleplayer', String(quickPlaySave)];
  }

  const override = readInstanceOverride(versionId) ?? {};
  const memory = {};
  if (override.memoryMin) memory.memoryMin = override.memoryMin;
  if (override.memoryMax) memory.memoryMax = override.memoryMax;

  // 新实例或首次启动：没有 lang 就补 zh_cn；已有语言不覆盖
  try { ensureChineseLanguage(versionId); } catch { /* 不阻断启动 */ }

  // 玩家名 / 内存 / Java / 隔离 全部来自设置，不再由前端硬编码传参
  // 启动前校验：缺文件先补齐，补不上返回可读清单，不把 JVM 栈直接甩给用户。
  await ensureVersionFiles({
    gameDir: state.gameDir,
    versionId,
    onStage: (event) => emit('launch-preflight', event),
  });
  await runAutoBackup(versionId, 'beforeLaunch');
  state.crashBaseline = snapshotCrashArtifacts(state.gameDir, versionId);
  const r = await launch({
    gameDir: state.gameDir,
    versionId,
    extraGame,
    java: override.javaPath || undefined,
    memory: Object.keys(memory).length ? memory : undefined,
    onJavaStage: ({ message }) => {
      pushLog(`[java] ${message}`);
      emit('launch-java-stage', { message });
    },
    onJavaProgress: (progress) => {
      emit('launch-java-progress', progress || {});
    },
  });

  state.lastLaunch = {
    versionId,
    command: r.command,
    pid: r.child.pid,
    at: Date.now(),
  };
  state.running = {
    versionId,
    pid: r.child.pid,
    startedAt: Date.now(),
    nativesDir: r.nativesDir,
  };
  const roomNow = getRoomState();
  const isHostGame = roomNow.status === 'running' || roomNow.status === 'starting';
  if (isHostGame) attachHostGame(r.child.pid);
  try {
    const mode = (joinAddress || isHostGame) ? 'multiplayer' : 'single';
    const role = isHostGame ? 'host' : (joinAddress ? 'guest' : 'single');
    saveRecent({
      ...(recentMeta && typeof recentMeta === 'object' ? recentMeta : {}),
      versionId,
      loader: recentMeta?.loader || '',
      gameVersion: recentMeta?.gameVersion || versionId,
      gameDir: state.gameDir,
      mode,
      role,
      joinAddress: joinAddress || '',
      saveName: quickPlaySave || recentMeta?.saveName || '',
      serverWorldPath: recentMeta?.serverWorldPath || roomNow.worldDir || '',
      worldSettings: recentMeta?.worldSettings || roomNow.settings,
      hostJoined: isHostGame ? true : Boolean(recentMeta?.hostJoined),
      room: recentMeta?.room || (isHostGame ? {
        provider: roomNow.frp?.provider || '',
        tunnelId: roomNow.frp?.tunnelId || '',
        remotePort: Number(String(roomNow.frp?.address || '').split(':').pop()) || 0,
        address: roomNow.frp?.address || '',
      } : null),
    });
  } catch { /* 最近游玩失败不阻断启动 */ }
  state.lanPort = null;
  // 每次启动都是新会话：日志面板先清空，避免把上一次的启动行续在前面
  state.logs = [];
  emit('log-clear');
  emit('game-start', { versionId, pid: r.child.pid });
  pushLog(`启动 ${versionId}，PID ${r.child.pid}`);
  if (joinAddress) pushLog(`加入服务器 ${joinAddress}`);

  if (r.missingLibraries.length) {
    pushLog(`警告：缺失 ${r.missingLibraries.length} 个库`);
  }
  pushLog(`使用 Java ${r.javaActual ?? '?'}：${r.javaBin}`);

  // 双写：终端仍能看到，/api/logs 也能拿到。两路都用 pipe 后的流，
  // 不能再依赖 inherit（inherit 时 child.stdout 是 null）。
  let exitWatchdog = null;
  let forcedExit = false;
  const noteGameLine = (line) => {
    pushLog(line);
    const levelMatch = /(?:Loading level|Preparing level)\s+['"](.+?)['"]/i.exec(String(line));
    if (levelMatch) {
      const rec = readRecent();
      if (rec?.mode === 'single') {
        try {
          saveRecent({ ...rec, saveName: levelMatch[1], savePath: rec.savePath || '' });
        } catch { /* ignore */ }
      }
    }
    const lanPort = parseLanPortLine(line);
    if (lanPort) {
      state.lanPort = { port: lanPort, at: Date.now(), versionId };
      emit('lan-port', state.lanPort);
    }
    // 有些 Forge/整合包在 Stopping! 之后还会挂 20 秒才退；
    // 给 10 秒保存时间，仍不退就结束进程树，别让启动键一直灰着。
    if (!exitWatchdog && /Stopping!|Stopping server/.test(line)) {
      emit('game-stopping', { versionId });
      exitWatchdog = setTimeout(() => {
        if (r.child.exitCode !== null) return;
        forcedExit = true;
        pushLog('游戏已停止但进程未退出，启动器结束它');
        try {
          execFileSync('taskkill', ['/PID', String(r.child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch {
          try { r.child.kill(); } catch { /* 已经退了 */ }
        }
      }, 10000);
    }
  };
  pipeGameLog(r.child.stdout, process.stdout, noteGameLine);
  pipeGameLog(r.child.stderr, process.stdout, noteGameLine);

  r.child.on('exit', (code) => {
    if (exitWatchdog) clearTimeout(exitWatchdog);
    state.running = null;
    void runAutoBackup(versionId, 'afterExit');
    const uiCode = forcedExit ? 0 : code;
    const recent = state.logs.slice(-120).map((x) => String(x.line ?? x));
    const reasonLine = [...recent].reverse().find((line) =>
      /insufficient memory|Native memory allocation|malloc failed|Unsupported JNI|hs_err_pid|Exception in thread|Could not find or load|Error:|错误|失败/i.test(line)
    ) || '';
    if (uiCode !== 0 && uiCode !== null && uiCode !== undefined) {
      state.lastFailure = { versionId, code: uiCode, reason: reasonLine.slice(0, 500), at: Date.now() };
    }
    const newArtifacts = forcedExit ? [] : newCrashArtifacts(state.gameDir, versionId, state.crashBaseline);
    if (!forcedExit && ((uiCode === null || (uiCode !== 0 && uiCode !== undefined)) || newArtifacts.length)) {
      const incident = {
        id: `crash-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        versionId,
        code: uiCode,
        reason: sanitizeDiagnostic(reasonLine).slice(0, 500),
        artifacts: newArtifacts,
        at: Date.now(),
        prompted: false,
      };
      state.crashIncident = incident;
      emit('crash-detected', { incident });
      if (getSettings().autoDiagnostic !== false) {
        void createCrashDiagnosticPackage({
          gameDir: state.gameDir,
          versionId,
          incident,
        }).then((pkg) => {
          pushLog(`崩溃诊断包已生成：${pkg.zipPath}`);
          emit('diagnostic-ready', { package: pkg, incidentId: incident.id });
        }).catch((e) => {
          pushLog(`诊断包生成失败：${e.message}`);
        });
      }
    }
    state.crashBaseline = null;
    emit('game-exit', { versionId, code: uiCode, forced: forcedExit, reason: reasonLine.slice(0, 500) });
    pushLog(forcedExit ? '游戏已强制结束，状态回到空闲' : `游戏退出，code=${code}`);
    const roomBefore = getRoomState();
    void onHostGameExit(r.child.pid).then(async (stopped) => {
      if (stopped) {
        if (roomBefore.frp?.provider && !roomBefore.frp.external) {
          try { stopTunnel(roomBefore.frp.provider); } catch { /* ignore */ }
        }
        await restoreRoomSakuraPort(roomBefore.frp);
        pushLog('房主退出，已自动关服；world 保留');
      }
    }).catch(() => {});
    // 清掉本次 natives 临时目录
    try {
      fs.rmSync(r.nativesDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  });

  return { pid: r.child.pid, versionId };
}

function guessJavaMajorFromPath(p) {
  const m = String(p ?? '').match(/(?:jdk|jre|java)[-_ ]?(\d+)/i);
  return m ? Number(m[1]) : null;
}

function resolveInstanceDir(versionId) {
  const id = String(versionId ?? '').trim();
  if (!id || id === '.' || id === '..' || /[\\/]/.test(id)) return null;
  const root = path.resolve(state.gameDir, 'versions');
  const dir = path.resolve(root, id);
  if (!dir.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** 找出 inheritsFrom 指向这个实例的其它实例，删基底前必须拦住 */
function readInstanceOverride(versionId) {
  const dir = resolveInstanceDir(versionId);
  if (!dir) return null;
  try {
    const p = path.join(dir, 'launcher-instance.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeInstanceOverride(versionId, patch) {
  const dir = resolveInstanceDir(versionId);
  if (!dir) throw new Error('实例不存在');
  const p = path.join(dir, 'launcher-instance.json');
  const cur = readInstanceOverride(versionId) ?? {};
  const next = { ...cur };
  if (patch.javaPath !== undefined) {
    const v = String(patch.javaPath ?? '').trim();
    if (v) next.javaPath = v; else delete next.javaPath;
  }
  if (patch.memoryMax !== undefined) {
    const v = String(patch.memoryMax ?? '').trim();
    if (v) next.memoryMax = v; else delete next.memoryMax;
  }
  if (patch.memoryMin !== undefined) {
    const v = String(patch.memoryMin ?? '').trim();
    if (v) next.memoryMin = v; else delete next.memoryMin;
  }
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function findDependentInstances(versionId) {
  const root = path.join(state.gameDir, 'versions');
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (d.name === versionId) continue;
    const jsonPath = path.join(root, d.name, `${d.name}.json`);
    try {
      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (json?.inheritsFrom === versionId) out.push(d.name);
    } catch {
      /* 没有 JSON / JSON 坏了，不算依赖 */
    }
  }
  return out;
}

function mcVarInt(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function mcString(s) {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([mcVarInt(b.length), b]);
}

function readMcVarInt(buf, off = 0) {
  let value = 0;
  let shift = 0;
  let pos = off;
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, size: pos - off };
    shift += 7;
    if (shift > 35) break;
  }
  return null;
}

function flattenChat(desc) {
  if (desc == null) return '';
  if (typeof desc === 'string') return desc;
  if (Array.isArray(desc)) return desc.map(flattenChat).join('');
  let s = '';
  if (typeof desc.text === 'string') s += desc.text;
  if (typeof desc.translate === 'string') s += desc.translate;
  if (Array.isArray(desc.extra)) s += desc.extra.map(flattenChat).join('');
  return s;
}

/** 真 Minecraft status ping：SRV + handshake + status，不再只测 TCP */
async function pingMinecraft(host, port, explicitPort) {
  const started = Date.now();
  let target = host;
  let actualPort = port;
  let srv = null;

  if (!explicitPort && !net.isIP(host)) {
    try {
      const recs = await dns.resolveSrv(`_minecraft._tcp.${host}`);
      if (recs?.length) {
        recs.sort((a, b) => b.priority - a.priority || b.weight - a.weight);
        target = recs[0].name;
        actualPort = recs[0].port;
        srv = { name: target, port: actualPort };
      }
    } catch {
      /* 没有 SRV 就用原地址 */
    }
  }

  return await new Promise((resolve) => {
    const sock = net.createConnection({ host: target, port: actualPort });
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (payload) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ host, port: actualPort, srv, ms: Date.now() - started, ...payload });
    };

    sock.setTimeout(6000);
    sock.once('timeout', () => finish({ ok: false, error: '连接超时' }));
    sock.once('error', (e) => finish({ ok: false, error: e.code || e.message }));
    sock.once('connect', () => {
      const handshake = Buffer.concat([
        mcVarInt(0),          // packet id
        mcVarInt(767),        // protocol version (status ping 不依赖真实版本)
        mcString(target),
        Buffer.from([(actualPort >> 8) & 0xff, actualPort & 0xff]),
        mcVarInt(1),          // next state: status
      ]);
      sock.write(Buffer.concat([mcVarInt(handshake.length), handshake]));
      sock.write(Buffer.from([1, 0])); // status request: length 1, id 0
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const len = readMcVarInt(buf, 0);
      if (!len) return;
      const total = len.size + len.value;
      if (buf.length < total) return;
      const packet = buf.subarray(len.size, total);
      const id = readMcVarInt(packet, 0);
      if (!id || id.value !== 0) return finish({ ok: false, error: '服务器返回了非 status 包' });
      const slen = readMcVarInt(packet, id.size);
      if (!slen) return finish({ ok: false, error: 'status 包不完整' });
      const jsonBuf = packet.subarray(id.size + slen.size, id.size + slen.size + slen.value);
      try {
        const status = JSON.parse(jsonBuf.toString('utf8'));
        const players = status.players ?? {};
        finish({
          ok: true,
          version: status.version?.name ?? '',
          protocol: status.version?.protocol ?? null,
          motd: flattenChat(status.description).replace(/§[0-9a-fk-or]/gi, ''),
          players: { online: players.online ?? 0, max: players.max ?? 0 },
          icon: Boolean(status.favicon),
        });
      } catch {
        finish({ ok: false, error: '无法解析服务器 status' });
      }
    });
  });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // 只接受本机访问（Host 必须是 127.0.0.1 / localhost）
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    res.writeHead(403).end('forbidden host');
    return;
  }

  try {
    // ---- SSE ----
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`retry: 3000\n\n`);

      const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
      send({ type: 'hello', state: snapshot() });

      const onEvent = (evt) => send(evt);
      bus.on('event', onEvent);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);

      req.on('close', () => {
        bus.off('event', onEvent);
        clearInterval(ping);
      });
      return;
    }

    // ---- API ----
    if (p === '/api/state') return json(res, 200, snapshot());

    if (p === '/api/onboarding/state') {
      const force = state.forceFirstRun || url.searchParams.get('force') === '1';
      return json(res, 200, onboardingState({ force, hadSettings: hadSettingsAtStart }));
    }

    if (p === '/api/onboarding/complete' && req.method === 'POST') {
      await completeOnboarding();
      state.forceFirstRun = false;
      return json(res, 200, { ok: true });
    }

    if (p === '/api/onboarding/reset' && req.method === 'POST') {
      if (state.installing) return json(res, 400, { error: '安装进行中，不能重置' });
      if (state.running) return json(res, 400, { error: '游戏正在运行，不能重置' });
      const body = await readBody(req);
      const r = await resetOnboarding({
        settings: body.settings !== false,
        accounts: Boolean(body.accounts),
        secrets: Boolean(body.secrets),
      });
      state.forceFirstRun = true;
      pushLog('首次启动重置：仅清理启动器配置，未动游戏实例/存档');
      return json(res, 200, { ...r, restart: true });
    }

    if (p === '/api/versions') {
      const versions = listVersions(path.join(state.gameDir, 'versions'));
      // 一次性把每个实例的类型/游戏版本带出去，版本页要按类型显示图标。
      // 逐个请求 /api/instance/info 会发几十次请求，这里合进列表省事。
      const details = versions.map((v) => {
        const info = readInstanceInfo(v);
        const icon = findInstanceIcon(v);
        const base = path.join(state.gameDir, 'versions', v);
        const count = (sub, dirs = false) => {
          try {
            const p = path.join(base, sub);
            if (!fs.existsSync(p)) return 0;
            return fs.readdirSync(p, { withFileTypes: true }).filter((x) => dirs ? x.isDirectory() : x.isFile()).length;
          } catch { return 0; }
        };
        return {
          id: v,
          gameVersion: info?.gameVersion ?? '',
          loader: info?.loader ?? '',
          kind: info?.kind ?? info?.loader ?? 'vanilla',
          loaderVersion: info?.loaderVersion ?? '',
          javaRequired: info?.javaRequired ?? null,
          javaCurrent: guessJavaMajorFromPath(getSettings().javaPath),
          javaMismatch: Boolean(
            info?.javaRequired &&
            guessJavaMajorFromPath(getSettings().javaPath) &&
            info.javaRequired !== guessJavaMajorFromPath(getSettings().javaPath)
          ),
          modsCount: count('mods'),
          savesCount: count('saves', true),
          // hasOwnIcon 让前端知道该不该走 /api/icon 取真图
          hasOwnIcon: icon.own,
          iconUrl: `/api/icon/${encodeURIComponent(v)}`,
        };
      });
      return json(res, 200, {
        gameDir: state.gameDir,
        versions,
        details,
      });
    }

    if (p === '/api/remote') {
      const manifest = await getVersionManifest(
        path.join(state.gameDir, 'version_manifest_v2.json')
      );
      const installed = new Set(listVersions(path.join(state.gameDir, 'versions')));
      const releases = (manifest.versions ?? [])
        .filter((v) => v.type === 'release')
        .slice(0, 40)
        .map((v) => ({
          id: v.id,
          releaseTime: v.releaseTime,
          installed: installed.has(v.id),
        }));
      return json(res, 200, { releases, total: manifest.versions?.length ?? 0 });
    }

    if (p === '/api/install' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.versionId) return json(res, 400, { error: '缺少 versionId' });
      return json(res, 200, await handleInstall(body.versionId));
    }

    if (p === '/api/tasks/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const taskId = String(body.taskId || '');
      if (!taskId) return json(res, 400, { error: '缺少 taskId' });
      if (!cancelTask(taskId)) return json(res, 409, { error: '任务已经结束' });
      pushLog(`取消任务：${taskId}`);
      return json(res, 200, { cancelled: true, taskId });
    }

    // 中途取消：只掐当前任务，不动已下好的文件。
    // .part 保留，下次同一条目会 Range 续传，不白下。
    if (p === '/api/install/cancel' && req.method === 'POST') {
      if (!state.installing) return json(res, 409, { error: '当前没有进行中的任务' });
      const ok = cancelJob('用户取消');
      if (!ok) return json(res, 409, { error: '任务已经在收尾了' });
      pushLog('用户取消安装，正在停止…');
      return json(res, 200, { cancelled: true, versionId: state.installing?.versionId ?? null });
    }

    if (p === '/api/launch' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.versionId) return json(res, 400, { error: '缺少 versionId' });
      try {
        return json(res, 200, await handleLaunch(body));
      } catch (e) {
        return json(res, e.code === 'PREFLIGHT_MISSING' ? 409 : 400, {
          error: e.message,
          code: e.code || undefined,
          missing: e.missing || undefined,
          preflight: e.preflight || undefined,
        });
      }
    }

    if (p === '/api/logs') {
      return json(res, 200, { logs: state.logs.slice(-200) });
    }

    if (p === '/api/logs/latest') {
      const versionId = url.searchParams.get('versionId');
      const candidates = [];
      if (versionId && !/[\\/]/.test(versionId) && versionId !== '.' && versionId !== '..') {
        candidates.push({
          source: 'instance',
          file: path.join(state.gameDir, 'versions', versionId, 'logs', 'latest.log'),
        });
      }
      candidates.push({
        source: 'game',
        file: path.join(state.gameDir, 'logs', 'latest.log'),
      });

      for (const c of candidates) {
        if (!fs.existsSync(c.file)) continue;
        try {
          const st = fs.statSync(c.file);
          const maxBytes = 256 * 1024;
          const start = Math.max(0, st.size - maxBytes);
          const fd = fs.openSync(c.file, 'r');
          const buf = Buffer.alloc(Math.min(maxBytes, st.size - start));
          fs.readSync(fd, buf, 0, buf.length, start);
          fs.closeSync(fd);
          const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-400);
          return json(res, 200, { source: c.source, path: c.file, lines, size: st.size });
        } catch (e) {
          return json(res, 500, { error: `读取 latest.log 失败：${e.message}` });
        }
      }
      return json(res, 200, { lines: [], path: null, missing: true });
    }

    /* ---- 账号 ---- */

    // 当前账号的皮肤 PNG（主页小人用）
    if (p === '/api/skin') {
      const acc = await currentAccount();
      if (!acc) {
        res.writeHead(204).end();
        return;
      }
      const skin = await getSkin(acc);
      if (skin) {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache',
          'X-Skin-Model': skin.model,
          'X-Skin-From': skin.from,
        });
        res.end(skin.png);
        return;
      }

      // 没有自己的皮肤：按 uuid 发游戏里那套官方默认皮肤，
      // 保证启动器显示的和进游戏后看到的是同一个人。
      const pick = defaultSkinFor(acc.uuid);
      const fallback = await readDefaultSkin(pick.name, pick.variant);
      if (!fallback) {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache',
        'X-Skin-Model': pick.variant,
        'X-Skin-From': 'default',
        'X-Skin-Default': pick.name,
      });
      res.end(fallback);
      return;
    }

    if (p === '/api/accounts' && req.method === 'GET') {
      const data = await loadAccounts();
      // 不把 accessToken / refreshToken 送出去，前端只要名字和类型
      return json(res, 200, {
        accounts: data.accounts.map(safeAccount),
        selected: data.selected,
      });
    }

    // 离线账号：直接建
    if (p === '/api/accounts/offline' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const acc = makeOfflineAccount(name);
      const data = await upsertAccount(acc);
      pushLog(`添加离线账号 ${name}`);
      return json(res, 200, { accounts: data.accounts.map(safeAccount), selected: data.selected });
    }

    // 第三方认证服务器预设列表（前端下拉框用）
    if (p === '/api/accounts/yggdrasil/presets') {
      return json(res, 200, { presets: YGGDRASIL_PRESETS });
    }

    // 已保存的外置登录站点
    if (p === '/api/accounts/yggdrasil/sites' && req.method === 'GET') {
      const sites = await loadYggSites();
      pushLog(`[ygg] 读取站点 ${YGG_SITES_FILE} -> ${sites.length} 条`);
      return json(res, 200, { sites });
    }

    // 拖入/粘贴/手填都走这里：识别、验证、保存
    if (p === '/api/accounts/yggdrasil/sites' && req.method === 'POST') {
      const body = await readBody(req);
      const { url, meta } = await validateYggSite(body.url);
      const sites = await loadYggSites();
      let site = sites.find((s) => s.url === url);
      if (!site) {
        site = {
          id: globalThis.crypto.randomUUID(),
          name: String(body.name ?? '').trim() || meta.serverName || new URL(url).hostname,
          url,
          createdAt: new Date().toISOString(),
        };
        sites.push(site);
      } else if (String(body.name ?? '').trim()) {
        site.name = String(body.name).trim();
      }
      await saveYggSites(sites);
      return json(res, 200, { site, sites, meta });
    }

    // 改名
    if (p === '/api/accounts/yggdrasil/sites' && req.method === 'PATCH') {
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      if (!name) throw new Error('站点名字不能为空');
      const sites = await loadYggSites();
      const site = sites.find((s) => s.id === body.id);
      if (!site) throw new Error('站点不存在');
      site.name = name.slice(0, 40);
      await saveYggSites(sites);
      return json(res, 200, { site, sites });
    }

    // 删除
    if (p === '/api/accounts/yggdrasil/sites' && req.method === 'DELETE') {
      const body = await readBody(req);
      const sites = (await loadYggSites()).filter((s) => s.id !== body.id);
      await saveYggSites(sites);
      return json(res, 200, { sites });
    }

    // 第三方认证服务器探测（LittleSkin 等）
    if (p === '/api/accounts/yggdrasil/meta' && req.method === 'POST') {
      const body = await readBody(req);
      const { meta } = await resolveYggSite(body.server);
      return json(res, 200, meta);
    }

    // 验证某个第三方账号的令牌是否真的有效（不需要密码）
    if (p === '/api/accounts/yggdrasil/verify' && req.method === 'POST') {
      const body = await readBody(req);
      const data = await loadAccounts();
      const acc = data.accounts.find((a) => accountKey(a) === body.key);
      if (!acc) throw new Error('账号不存在');
      if (acc.type !== 'yggdrasil') throw new Error('只有第三方账号可以这样验证');
      const ok = await yggdrasilValidate(acc);
      return json(res, 200, { valid: ok, name: acc.name, server: acc.serverName ?? acc.server });
    }

    // 第三方登录：先认证，返回角色列表；选角色后再落盘
    if (p === '/api/accounts/yggdrasil/login' && req.method === 'POST') {
      const body = await readBody(req);
      const { url: server } = await resolveYggSite(body.server);
      const pending = await yggdrasilLogin(server, body.username, body.password);
      return json(res, 200, {
        pending: {
          server: pending.account.server,
          serverName: pending.account.serverName,
          accessToken: pending.account.accessToken,
          clientToken: pending.account.clientToken,
          refreshToken: pending.account.refreshToken,
          profiles: pending.profiles,
        },
        profiles: pending.profiles,
        selectedProfileId: pending.selectedProfileId,
      });
    }

    // 选角色：refresh 成功后保存账号
    if (p === '/api/accounts/yggdrasil/select' && req.method === 'POST') {
      const body = await readBody(req);
      const acc = await yggdrasilSelectProfile(body.pending, body.profileId);
      const data = await upsertAccount(acc);
      pushLog(`第三方登录成功：${acc.name} @ ${acc.serverName}`);
      return json(res, 200, { accounts: data.accounts.map(safeAccount), selected: data.selected });
    }

    // 角色头像：只读皮肤站公开 profile，失败就返回 null
    if (p === '/api/accounts/yggdrasil/profile-skin' && req.method === 'POST') {
      const body = await readBody(req);
      const skinUrl = await yggdrasilProfileSkin(body.server, body.uuid);
      return json(res, 200, { skinUrl });
    }

    // 用已保存的 clientToken/accessToken 恢复登录，不再要密码
    if (p === '/api/accounts/yggdrasil/resume' && req.method === 'POST') {
      const body = await readBody(req);
      const data = await loadAccounts();
      const acc = data.accounts.find((a) => accountKey(a) === body.key);
      if (!acc) throw new Error('账号不存在');
      if (acc.type !== 'yggdrasil') throw new Error('这个账号不是外置登录');
      try {
        const refreshed = await yggdrasilRefresh(acc);
        const saved = await upsertAccount(refreshed);
        const current = saved.accounts.find((a) => accountKey(a) === body.key) ?? refreshed;
        const profiles = (refreshed.profiles?.length ? refreshed.profiles : [
          { id: refreshed.uuid, name: refreshed.name },
        ]);
        return json(res, 200, {
          accounts: saved.accounts.map(safeAccount),
          selected: saved.selected,
          pending: {
            server: refreshed.server,
            serverName: refreshed.serverName,
            accessToken: refreshed.accessToken,
            clientToken: refreshed.clientToken,
            refreshToken: refreshed.refreshToken,
            profiles,
          },
          profiles,
          selectedProfileId: refreshed.uuid,
          name: current.name,
        });
      } catch (e) {
        // 明确 401/403/invalid 才清凭据；网络错误保留，等下次再试
        if (/HTTP\s*(401|403)|invalid|令牌无效/i.test(e.message)) {
          await removeAccount(body.key);
          pushLog(`外置登录失效，已清除凭据：${acc.name}`);
          throw new Error('登录已失效，请重新输入密码');
        }
        throw e;
      }
    }

    // 退出登录：清掉当前账号凭据
    if (p === '/api/accounts/logout' && req.method === 'POST') {
      const body = await readBody(req);
      const data = await removeAccount(body.key);
      return json(res, 200, { accounts: data.accounts.map(safeAccount), selected: data.selected });
    }

    // 微软正版：第一步拿设备码
    if (p === '/api/accounts/ms/start' && req.method === 'POST') {
      const dc = await msStartDeviceCode();
      state.msLogin = { ...dc, startedAt: Date.now() };
      return json(res, 200, {
        userCode: dc.userCode,
        verificationUri: dc.verificationUri,
        expiresIn: dc.expiresIn,
        interval: dc.interval,
      });
    }

    // 微软正版：第二步轮询（前端按 interval 反复调）
    if (p === '/api/accounts/ms/poll' && req.method === 'POST') {
      if (!state.msLogin?.deviceCode) {
        return json(res, 400, { error: '没有进行中的登录，请先点登录' });
      }
      const r = await msPollToken(state.msLogin.deviceCode);
      if (!r.done) return json(res, 200, { pending: true });

      const acc = await msCompleteLogin(r.msAccessToken, r.refreshToken);
      state.msLogin = null;
      const data = await upsertAccount(acc);
      pushLog(`正版登录成功：${acc.name}`);
      return json(res, 200, { done: true, accounts: data.accounts.map(safeAccount), selected: data.selected });
    }

    if (p === '/api/accounts/select' && req.method === 'POST') {
      const body = await readBody(req);
      const data = await selectAccount(body.key);
      return json(res, 200, { accounts: data.accounts.map(safeAccount), selected: data.selected });
    }

    if (p === '/api/accounts/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const data = await removeAccount(body.key);
      return json(res, 200, { accounts: data.accounts.map(safeAccount), selected: data.selected });
    }

    /* 换装：清掉当前账号的皮肤缓存，下次取皮肤重新走网络。
       正版/第三方改完皮肤后，Mojang 侧也不一定立刻生效，所以这里只负责"重新拉"。 */
    if (p === '/api/accounts/refresh-skin' && req.method === 'POST') {
      const acc = await currentAccount();
      if (!acc) return json(res, 400, { error: '还没有选中的账号' });
      if (acc.type !== 'microsoft' && acc.type !== 'yggdrasil') {
        return json(res, 400, { error: '离线账号没有官方皮肤' });
      }
      await clearSkinCache(acc.uuid);
      pushLog(`刷新皮肤缓存：${acc.name}`);
      return json(res, 200, { ok: true, name: acc.name });
    }

    /* 换装：存一张本地皮肤（前端传 base64） */
    if (p === '/api/accounts/skin' && req.method === 'POST') {
      const acc = await currentAccount();
      if (!acc) return json(res, 400, { error: '还没有选中的账号' });
      const body = await readBody(req);

      const raw = String(body.data ?? '');
      if (!raw) return json(res, 400, { error: '没有收到图片' });
      const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;

      let buf;
      try {
        buf = Buffer.from(b64, 'base64');
      } catch {
        return json(res, 400, { error: '图片数据解析失败' });
      }
      if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504e47) {
        return json(res, 400, { error: '只支持 PNG 格式的皮肤图' });
      }

      await saveCustomSkin(acc.uuid, buf, body.model === 'slim' ? 'slim' : 'classic');
      pushLog(`换装：${acc.name} 用了本地皮肤（${Math.round(buf.length / 1024)} KB）`);
      return json(res, 200, { ok: true, name: acc.name });
    }

    /* 换装：丢掉本地皮肤，回到官方 */
    if (p === '/api/accounts/skin' && req.method === 'DELETE') {
      const acc = await currentAccount();
      if (!acc) return json(res, 400, { error: '还没有选中的账号' });
      await clearCustomSkin(acc.uuid);
      await clearSkinCache(acc.uuid);
      pushLog(`换装：${acc.name} 恢复官方皮肤`);
      return json(res, 200, { ok: true, name: acc.name });
    }

    /* 换装：当前账号的皮肤状态（前端决定显示"恢复官方"还是"选图"） */
    if (p === '/api/accounts/skin/state') {
      const acc = await currentAccount();
      if (!acc) return json(res, 200, { account: null, custom: false });
      const custom = await hasCustomSkin(acc.uuid);
      return json(res, 200, { account: acc.name, custom, type: acc.type });
    }

    /* 改名：只改本地显示名。
       离线号改的是启动器发给服务端的玩家名，确实生效。
       正版/第三方的名字归认证服务器管，本地改了只在启动器里显示，进游戏还是原名。 */
    if (p === '/api/accounts/rename' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const key = body.key;

      if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
        return json(res, 400, { error: '名字只能用字母/数字/下划线，最多 16 位' });
      }

      const data = await loadAccounts();
      const acc = data.accounts.find((a) => accountKey(a) === key);
      if (!acc) return json(res, 400, { error: '账号不存在' });

      // 正版改本地名会让账号和皮肤对不上，直接在服务端回绝，免得前端以为改成功了
      if (acc.type !== 'offline') {
        return json(res, 400, {
          error: '正版/第三方账号的名字由认证服务器决定，不能在这里改',
        });
      }

      const accounts = data.accounts.map((a) =>
        accountKey(a) === key ? { ...a, name } : a
      );
      const saved = await saveAccounts({ accounts, selected: data.selected });
      pushLog(`离线账号改名：${acc.name} → ${name}`);
      return json(res, 200, { accounts: saved.accounts.map(safeAccount), selected: saved.selected });
    }

    /* ---- 内容商店：搜项目 / 看版本 / 装内容 ---- */

    if (p === '/api/store/search') {
      const type = url.searchParams.get('type') || 'mod';
      const q = url.searchParams.get('q') || '';
      const limit = Number(url.searchParams.get('limit') || 20);
      const offset = Number(url.searchParams.get('offset') || 0);
      const sortBy = url.searchParams.get('sort') || 'relevance';
      const versionId = url.searchParams.get('versionId') || '';

      // 实例信息决定兼容过滤条件；没指定实例就不过滤
      let gameVersion = null;
      let loader = null;
      if (versionId) {
        const info = readInstanceInfo(versionId);
        if (info) {
          gameVersion = info.gameVersion;
          loader = info.loader;
        }
      }
      // 光影/资源包不吃 loader，只有 mod 需要
      const useLoader = type === 'mod' ? loader : null;

      const r = await searchProjects({
        type,
        query: q,
        gameVersion,
        loader: useLoader,
        limit: Math.min(Math.max(limit, 1), 50),
        offset: Math.max(offset, 0),
        sortBy,
      });

      return json(res, 200, {
        ...r,
        filters: { gameVersion, loader: useLoader, versionId: versionId || null },
        installed: versionId ? await listInstalled(state.gameDir, versionId) : null,
      });
    }

    if (p === '/api/store/versions') {
      const slug = url.searchParams.get('slug');
      if (!slug) return json(res, 400, { error: '缺少 slug' });
      const versionId = url.searchParams.get('versionId') || '';

      let gameVersion = null;
      let loader = null;
      if (versionId) {
        const info = readInstanceInfo(versionId);
        if (info) {
          gameVersion = info.gameVersion;
          loader = info.loader;
        }
      }

      const versions = await getProjectVersions(slug, { gameVersion, loader });
      const type = url.searchParams.get('type') || 'mod';
      const useLoader = type === 'mod' ? loader : undefined;

      // 只留能用的：mod 必须有对应游戏版本，光影/资源包也尽量匹配
      const compatible = versions.filter((v) => {
        if (gameVersion && !v.gameVersions.includes(gameVersion)) return false;
        if (useLoader && !v.loaders.includes(useLoader)) return false;
        return true;
      });

      return json(res, 200, {
        slug,
        total: versions.length,
        compatible: compatible.length,
        versions: (compatible.length ? compatible : versions).slice(0, 40),
        filters: { gameVersion, loader: useLoader ?? null },
      });
    }

    if (p === '/api/store/project') {
      const slug = url.searchParams.get('slug');
      if (!slug) return json(res, 400, { error: '缺少 slug' });
      return json(res, 200, await getProject(slug));
    }

    /* ---- CurseForge（经 MCIM 镜像）---- */

    if (p === '/api/cf/key' && req.method === 'GET') {
      const env = String(process.env.CURSEFORGE_API_KEY || process.env.CF_API_KEY || '').trim();
      return json(res, 200, {
        hasKey: hasCfKey(),
        keyMask: cfKeyMask(),
        source: env ? 'env' : (hasToken('curseforge') ? 'secure' : 'none'),
        applyUrl: 'https://forms.monday.com/forms/dce5ccb7afda9a1c21dab1a1aa1d84eb?r=use1',
      });
    }

    if (p === '/api/cf/key' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const env = String(process.env.CURSEFORGE_API_KEY || process.env.CF_API_KEY || '').trim();
        if (env) throw new Error('环境变量已提供 CurseForge API Key，优先使用环境变量');
        const key = String(body.apiKey ?? '').trim();
        if (!key) {
          await clearToken('curseforge');
          return json(res, 200, { hasKey: false, keyMask: '', source: 'none' });
        }
        await setToken('curseforge', key, { requireEncryption: true });
        return json(res, 200, { hasKey: true, keyMask: cfKeyMask(), source: 'secure' });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (p === '/api/cf/search') {
      if (!hasCfKey()) {
        return json(res, 200, {
          source: 'curseforge',
          total: 0,
          hits: [],
          skipped: true,
          error: '已跳过 CurseForge（未配置 Key）',
        });
      }
      const type = url.searchParams.get('type') || 'mod';
      const q = url.searchParams.get('q') || '';
      const limit = Number(url.searchParams.get('limit') || 20);
      const offset = Number(url.searchParams.get('offset') || 0);
      const sortBy = url.searchParams.get('sort') || 'relevance';
      const versionId = url.searchParams.get('versionId') || '';

      let gameVersion = null;
      let loader = null;
      if (versionId) {
        const info = readInstanceInfo(versionId);
        if (info) {
          gameVersion = info.gameVersion;
          loader = info.loader;
        }
      }

      try {
        const r = await cfSearchProjects({
          type,
          query: q,
          gameVersion,
          loader: type === 'mod' ? loader : null,
          limit: Math.min(Math.max(limit, 1), 50),
          offset: Math.max(offset, 0),
          sortBy,
        });
        return json(res, 200, {
          ...r,
          filters: { gameVersion, loader: type === 'mod' ? loader : null, versionId: versionId || null },
        });
      } catch (e) {
        // 镜像挂了不能让整个商店报错 —— 明确告诉前端是 CF 不可用
        return json(res, 200, { source: 'curseforge', total: 0, hits: [], error: e.message });
      }
    }

    if (p === '/api/cf/project') {
      if (!hasCfKey()) return json(res, 200, { skipped: true, error: '已跳过 CurseForge（未配置 Key）' });
      const slug = url.searchParams.get('slug');
      const id = url.searchParams.get('id');
      if (!slug && !id) return json(res, 400, { error: '缺少 slug 或 id' });
      try {
        if (id) return json(res, 200, await cfGetProject(id));
        const hit = await cfGetProjectBySlug(slug);
        if (!hit) return json(res, 404, { error: 'CurseForge 上找不到这个项目' });
        return json(res, 200, hit);
      } catch (e) {
        return json(res, 200, { error: e.message });
      }
    }

    if (p === '/api/cf/files') {
      if (!hasCfKey()) return json(res, 200, { id: url.searchParams.get('id') || '', files: [], skipped: true, error: '已跳过 CurseForge（未配置 Key）' });
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: '缺少 id' });
      const versionId = url.searchParams.get('versionId') || '';
      let gameVersion = null;
      let loader = null;
      if (versionId) {
        const info = readInstanceInfo(versionId);
        if (info) {
          gameVersion = info.gameVersion;
          loader = info.loader;
        }
      }
      try {
        const files = await cfGetProjectFiles(id, {
          gameVersion: url.searchParams.get('gameVersion') || gameVersion,
          loader: url.searchParams.get('loader') || loader,
          limit: 50,
        });
        return json(res, 200, { id, files, filters: { gameVersion, loader } });
      } catch (e) {
        return json(res, 200, { id, files: [], error: e.message });
      }
    }

    if (p === '/api/cf/pack/preview' && req.method === 'POST') {
      if (!hasCfKey()) return json(res, 400, { skipped: true, error: '已跳过 CurseForge（未配置 Key）' });
      const body = await readBody(req);
      if (!body.modId) return json(res, 400, { error: '缺少 modId' });
      try {
        return json(res, 200, await previewCurseForgePack({
          modId: body.modId,
          fileId: body.fileId,
        }));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/cf/pack/install' && req.method === 'POST') {
      if (!hasCfKey()) return json(res, 400, { skipped: true, error: '已跳过 CurseForge（未配置 Key）' });
      const body = await readBody(req);
      if (!body.modId) return json(res, 400, { error: '缺少 modId' });
      if (state.installing) return json(res, 409, { error: '已有任务在进行' });

      state.installing = { versionId: body.instanceName || 'cfpack', stage: 'cfpack', done: 0, total: 0 };
      startJob();
      emit('modpack-start', { source: 'curseforge', modId: body.modId });

      (async () => {
        try {
          const r = await installCurseForgePack({
            gameDir: state.gameDir,
            modId: body.modId,
            fileId: body.fileId,
            instanceName: body.instanceName,
            iconUrl: body.iconUrl,
            source: (await awaitOrCancel(resolveSource(getSettings().downloadSource))).source,
            onStage: ({ stage, message }) => {
              state.installing = { ...state.installing, stage, message };
              emit('modpack-stage', { stage, message });
              pushLog(`[${stage}] ${message}`);
            },
            onProgress: (pr) => {
              state.installing = { ...state.installing, ...pr };
              emit('modpack-progress', pr);
            },
          });
          state.installing = null;
          endJob();
          emit('modpack-done', { result: r });
          pushLog(`整合包安装完成：${r.instanceId}（文件 ${r.files.downloaded} 个）`);
          if (r.files.notDistributable) {
            pushLog(`有 ${r.files.notDistributable} 个文件作者关闭了第三方分发，已跳过`);
          }
        } catch (e) {
          const cancelled = e?.cancelled || e instanceof CancelledError;
          let wiped = null;
          if (cancelled) {
            try {
              wiped = await rollbackJob();
            } catch {
              /* 回滚失败不盖住取消 */
            }
          }
          state.installing = null;
          endJob();
          if (cancelled) {
            emit('modpack-cancelled', { message: e.message || '已取消', wiped: wiped ?? undefined });
            pushLog(
              wiped && (wiped.files || wiped.dirs)
                ? `已取消整合包安装，清理 ${wiped.files} 个文件、${wiped.dirs} 个空目录`
                : '已取消整合包安装'
            );
            return;
          }
          emit('modpack-error', { error: e.message });
          pushLog(`整合包安装失败：${e.message}`);
        }
      })();

      return json(res, 200, { started: true });
    }

    if (p === '/api/content/install' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await handleContentInstall(body));
    }

    if (p === '/api/content/list') {
      const versionId = url.searchParams.get('versionId');
      if (!versionId) return json(res, 400, { error: '缺少 versionId' });
      return json(res, 200, await listInstalled(state.gameDir, versionId));
    }

    if (p === '/api/content/remove' && req.method === 'POST') {
      const body = await readBody(req);
      return json(
        res,
        200,
        await removeContent({
          gameDir: state.gameDir,
          versionId: body.versionId,
          projectType: body.projectType,
          filename: body.filename,
        })
      );
    }

    if (p === '/api/content/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      return json(
        res,
        200,
        await toggleContent({
          gameDir: state.gameDir,
          versionId: body.versionId,
          projectType: body.projectType,
          filename: body.filename,
          enable: Boolean(body.enable),
        })
      );
    }

    /* ---- 模组批量更新 ---- */

    // 只读检查：不写盘、不改文件，先让人看清楚再决定
    if (p === '/api/mods/check-updates' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.versionId) return json(res, 400, { error: '缺少 versionId' });
      if (state.installing) return json(res, 409, { error: '已有任务在进行' });

      const info = readInstanceInfo(body.versionId);
      try {
        const r = await checkModUpdates({
          gameDir: state.gameDir,
          versionId: body.versionId,
          // 实例自身的信息优先，没读到就不传（退化成不过滤）
          gameVersion: info?.gameVersion,
          loader: info?.loader,
          onProgress: (pr) => emit('mods-check-progress', { versionId: body.versionId, ...pr }),
        });
        return json(res, 200, r);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // 执行更新：下载新文件 → 校验 → 老文件进 .backup → 落盘
    if (p === '/api/mods/apply-updates' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.versionId) return json(res, 400, { error: '缺少 versionId' });
      if (!Array.isArray(body.items) || !body.items.length) {
        return json(res, 400, { error: '没有要更新的项目' });
      }
      if (state.installing) return json(res, 409, { error: '已有任务在进行' });
      if (state.running) return json(res, 409, { error: '游戏正在运行，先退出再更新' });

      const versionId = body.versionId;
      const items = body.items;
      state.installing = { versionId, stage: 'mod-update', done: 0, total: items.length };
      startJob();
      emit('mods-update-start', { versionId, count: items.length });
      pushLog(`开始更新 ${items.length} 个模组（${versionId}）`);

      (async () => {
        try {
          const r = await applyModUpdates({
            gameDir: state.gameDir,
            versionId,
            items,
            onProgress: (pr) => {
              state.installing = { ...state.installing, ...pr };
              emit('mods-update-progress', { versionId, ...pr });
            },
          });
          state.installing = null;
          endJob();
          emit('mods-update-done', { versionId, result: r });
          pushLog(
            `模组更新完成：成功 ${r.updated.length}，失败 ${r.failed.length}，跳过 ${r.skipped.length}`
          );
          if (r.backupDir) pushLog(`旧文件已备份到 ${r.backupDir}`);
        } catch (e) {
          const cancelled = e?.cancelled || e instanceof CancelledError;
          let wiped = null;
          if (cancelled) {
            // 模组更新的“下载”是写到 .downloading 临时文件，回滚会一并清掉；
            // 已换上的新模组不动（旧文件在 .backup，属于已完成项，不应逆向回滚）
            try {
              wiped = await rollbackJob();
            } catch {
              /* 回滚失败不盖住取消 */
            }
          }
          state.installing = null;
          endJob();
          if (cancelled) {
            emit('mods-update-cancelled', {
              versionId,
              message: e.message || '已取消',
              wiped: wiped ?? undefined,
            });
            pushLog(
              wiped && (wiped.files || wiped.dirs)
                ? `已取消模组更新，清理本次未完成的下载 ${wiped.files} 个文件`
                : '已取消模组更新'
            );
            return;
          }
          emit('mods-update-error', { versionId, error: e.message });
          pushLog(`模组更新失败：${e.message}`);
        }
      })();

      return json(res, 200, { started: true, count: items.length });
    }

    /* ---- Fabric ---- */

    if (p === '/api/fabric/loaders') {
      const gv = url.searchParams.get('gameVersion');
      if (!gv) return json(res, 400, { error: '缺少 gameVersion' });
      return json(res, 200, { gameVersion: gv, loaders: await listLoaders(gv) });
    }

    if (p === '/api/fabric/install' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await handleFabricInstall(body));
    }

    if (p === '/api/forge/install' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await handleForgeInstall(body, 'forge'));
    }

    if (p === '/api/neoforge/install' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await handleForgeInstall(body, 'neoforge'));
    }

    /* ---- 整合包 ---- */

    if (p === '/api/modpack/preview' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.mrpackUrl) return json(res, 400, { error: '缺少 mrpackUrl' });
      return json(res, 200, await previewModpack(body.mrpackUrl, { sha1: body.mrpackSha1 }));
    }

    if (p === '/api/modpack/install' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await handleModpackInstall(body));
    }

    if (p === '/api/import/preview' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, await handleDroppedFile(body.path, body.versionId, { preview: true }));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/import/file' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, await handleDroppedFile(body.path, body.versionId, {
          backupSaves: body.backupSaves === true || body.options?.backupSaves === true,
        }));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    /* ---- 追更（盯整合包新版本）---- */

    if (p === '/api/track') {
      return json(res, 200, listTracked());
    }

    if (p === '/api/track/add' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await addTracked(body.slug, { releaseOnly: Boolean(body.releaseOnly) });
      pushLog(
        r.created
          ? `开始追更：${r.item.title}（当前 ${r.item.baselineVersionNumber ?? '无版本'}）`
          : `已在追更列表：${r.item.title}`
      );
      return json(res, 200, { ...r, ...listTracked() });
    }

    if (p === '/api/track/remove' && req.method === 'POST') {
      const body = await readBody(req);
      await removeTracked(body.slug);
      pushLog(`取消追更：${body.slug}`);
      return json(res, 200, listTracked());
    }

    if (p === '/api/track/check' && req.method === 'POST') {
      const found = await checkAll();
      pushLog(found.length ? `追更检查：发现 ${found.length} 个新版本` : '追更检查：暂无新版本');
      return json(res, 200, { found, ...listTracked() });
    }

    if (p === '/api/track/interval' && req.method === 'POST') {
      const body = await readBody(req);
      const ms = await setTrackInterval(body.intervalMs);
      return json(res, 200, { intervalMs: ms });
    }

    if (p === '/api/game-dir/open' && req.method === 'POST') {
      // state.gameDir 内部统一存正斜杠；Explorer 收到 D:/... 会当成
      // 未知参数并退回“文档”。这里必须换成 Windows 原生反斜杠路径。
      const dir = path.win32.normalize(path.resolve(state.gameDir));
      if (!fs.existsSync(dir)) {
        return json(res, 404, { error: `游戏目录不存在：${dir}` });
      }
      try {
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      } catch (e) {
        return json(res, 500, { error: `打开游戏目录失败：${e.message}` });
      }
      return json(res, 200, { ok: true, path: dir });
    }

    if (p === '/api/instance/open-folder' && req.method === 'POST') {
      const body = await readBody(req);
      const dir = resolveInstanceDir(body.versionId);
      if (!dir) return json(res, 404, { error: '实例不存在' });
      try {
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      } catch (e) {
        return json(res, 500, { error: `打开文件夹失败：${e.message}` });
      }
      return json(res, 200, { ok: true, path: dir });
    }

    if (p === '/api/instance/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const versionId = String(body.versionId ?? '').trim();
      if (state.running?.versionId === versionId) {
        return json(res, 409, { error: '这个实例正在运行，先退出游戏再删' });
      }
      if (state.installing) {
        return json(res, 409, { error: '正在安装/更新，等任务结束再删' });
      }
      const dir = resolveInstanceDir(versionId);
      if (!dir) return json(res, 404, { error: '实例不存在' });

      const savesDir = path.join(dir, 'saves');
      let saveCount = 0;
      try {
        saveCount = fs.existsSync(savesDir)
          ? fs.readdirSync(savesDir, { withFileTypes: true }).filter((x) => x.isDirectory()).length
          : 0;
      } catch { /* 忽略 */ }
      if (saveCount && !body.force) {
        return json(res, 409, {
          error: `这个实例里有 ${saveCount} 个存档；确认删除会一起移到 .trash，可手动恢复。`,
          saves: saveCount,
        });
      }

      // 基底是共享的：26.1.1 被 zz-032-fab 继承时，不能把 26.1.1 删掉
      const dependents = findDependentInstances(versionId);
      if (dependents.length) {
        return json(res, 409, {
          error: `${versionId} 还被这些实例继承：${dependents.join('、')}；先删/迁移它们，或给它们换基底`,
        });
      }

      const trash = path.join(state.gameDir, '.trash');
      await fsp.mkdir(trash, { recursive: true });
      const dest = path.join(trash, `${versionId}-${Date.now()}`);
      try {
        await fsp.rename(dir, dest);
      } catch (e) {
        return json(res, 500, { error: `删除失败（可能被占用）：${e.message}` });
      }
      pushLog(`删除实例 ${versionId}，已移到 ${dest}`);
      return json(res, 200, { ok: true, versionId, trashedTo: dest });
    }

    if (p === '/api/trash' && req.method === 'GET') {
      return json(res, 200, { ...listTrash(state.gameDir), retentionDays: 30 });
    }

    if (p === '/api/trash/restore' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await restoreTrash(state.gameDir, String(body.name || ''));
        pushLog(`恢复最近删除实例：${body.name} → ${r.versionId}`);
        return json(res, 200, r);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/trash/purge' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await purgeTrash(state.gameDir, String(body.name || ''));
        pushLog(`彻底删除最近删除实例：${body.name}`);
        return json(res, 200, r);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/instance/info') {
      const versionId = url.searchParams.get('versionId');
      if (!versionId) return json(res, 400, { error: '缺少 versionId' });
      const info = readInstanceInfo(versionId);
      if (!info) return json(res, 404, { error: '找不到该实例' });
      return json(res, 200, {
        ...info,
        content: await listInstalled(state.gameDir, versionId),
      });
    }

    if (p === '/api/instance/settings' && req.method === 'GET') {
      const versionId = url.searchParams.get('versionId') || '';
      const dir = resolveInstanceDir(versionId);
      if (!dir) return json(res, 404, { error: '实例不存在' });
      const s = getSettings();
      const o = readInstanceOverride(versionId) ?? {};
      return json(res, 200, {
        versionId,
        override: o,
        global: {
          javaPath: s.javaPath || '',
          memoryMin: s.memoryMin,
          memoryMax: s.memoryMax,
        },
        effective: {
          javaPath: o.javaPath || s.javaPath || '',
          memoryMin: o.memoryMin || s.memoryMin,
          memoryMax: o.memoryMax || s.memoryMax,
        },
      });
    }

    if (p === '/api/instance/settings' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const o = writeInstanceOverride(body.versionId, body);
        pushLog(`实例 ${body.versionId} 的 Java/内存已单独设置`);
        return json(res, 200, { ok: true, override: o });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/options' && req.method === 'GET') {
      const versionId = url.searchParams.get('versionId') || '';
      try {
        const data = readOptions(versionId);
        return json(res, 200, data);
      } catch (e) {
        return json(res, 404, { error: e.message });
      }
    }

    if (p === '/api/options/save' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const versionId = String(body.versionId ?? '').trim();
        const values = body.values && typeof body.values === 'object' ? body.values : {};
        const roots = body.applyAll
          ? listVersions(path.join(state.gameDir, 'versions'))
          : [versionId];
        const written = [];
        for (const id of roots) {
          if (!resolveInstanceDir(id)) continue;
          written.push(writeOptions(id, values));
        }
        pushLog(`游戏设置已写入：${written.map((w) => path.basename(path.dirname(w.file))).join(', ')}`);
        return json(res, 200, { ok: true, written });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/options/restore' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const file = optionsFilePath(body.versionId);
        const backup = `${file}.bak`;
        if (!fs.existsSync(backup)) throw new Error('这个实例还没有 options.txt 备份');
        fs.copyFileSync(backup, file);
        pushLog(`恢复 options.txt 备份：${file}`);
        return json(res, 200, { ok: true, file });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/instance/copy' && req.method === 'POST') {
      const body = await readBody(req);
      const versionId = String(body.versionId ?? '').trim();
      if (state.running?.versionId === versionId) return json(res, 409, { error: '实例正在运行，先退出游戏' });
      if (state.installing) return json(res, 409, { error: '正在安装/更新，稍后再复制' });
      const src = resolveInstanceDir(versionId);
      if (!src) return json(res, 404, { error: '实例不存在' });

      let newId = `${versionId}-copy`;
      for (let n = 2; fs.existsSync(path.join(state.gameDir, 'versions', newId)); n += 1) {
        newId = `${versionId}-copy${n}`;
      }
      const dest = path.join(state.gameDir, 'versions', newId);
      try {
        await fsp.cp(src, dest, { recursive: true, errorOnExist: true });
        if (!body.includeSaves) {
          await fsp.rm(path.join(dest, 'saves'), { recursive: true, force: true }).catch(() => {});
        }
        const oldJson = path.join(dest, `${versionId}.json`);
        const newJson = path.join(dest, `${newId}.json`);
        if (!fs.existsSync(oldJson)) throw new Error('实例缺少版本 JSON');
        const data = JSON.parse(fs.readFileSync(oldJson, 'utf8'));
        data.id = newId;
        await fsp.writeFile(newJson, JSON.stringify(data, null, 2), 'utf8');
        if (oldJson !== newJson) await fsp.rm(oldJson, { force: true });
        const copyOverride = path.join(dest, 'launcher-instance.json');
        if (fs.existsSync(copyOverride)) await fsp.rm(copyOverride, { force: true });
        pushLog(`复制实例 ${versionId} → ${newId}`);
        return json(res, 200, { ok: true, versionId: newId });
      } catch (e) {
        await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
        return json(res, 500, { error: `复制失败：${e.message}` });
      }
    }

    if (p === '/api/meta/types') {
      return json(res, 200, { types: PROJECT_TYPES });
    }

    /* ---- 插件（高级配置） ---- */

    if (p === '/api/plugins' && req.method === 'GET') {
      return json(res, 200, await loadPlugins());
    }

    if (p === '/api/plugins' && req.method === 'POST') {
      const body = await readBody(req);
      if (!String(body.code ?? '').trim()) return json(res, 400, { error: '插件代码不能为空' });
      return json(res, 200, await savePlugin(body));
    }

    if (p === '/api/plugins/delete' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: '缺少 id' });
      return json(res, 200, await deletePlugin(body.id));
    }

    if (p === '/api/plugins/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: '缺少 id' });
      return json(res, 200, await togglePlugin(body.id, body.enabled));
    }

    // 试运行：不保存也能先看看插件会给出什么参数
    if (p === '/api/plugins/test' && req.method === 'POST') {
      const body = await readBody(req);
      const s = getSettings();
      const r = runPluginCode(String(body.code ?? ''), {
        memoryMin: s.memoryMin,
        memoryMax: s.memoryMax,
        username: s.username,
        instance: body.instance ?? '',
        gameVersion: body.gameVersion ?? '',
        loader: body.loader ?? '',
      });
      return json(res, 200, r);
    }

    /* ---- 联机小工具 ---- */

    /* ---- 联机：SakuraFrp / OpenFrp ---- */

    if (p === '/api/online/state') {
      return json(res, 200, { ...onlineSnapshot(), upnp: upnpState() });
    }

    if (p === '/api/online/room/state' && req.method === 'GET') {
      return json(res, 200, { room: getRoomState() });
    }

    if (p === '/api/online/room/settings' && req.method === 'GET') {
      const versionId = url.searchParams.get('versionId') || '';
      return json(res, 200, { settings: getWorldSettings({ gameDir: state.gameDir, versionId }) });
    }

    if (p === '/api/online/room/settings' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = saveWorldSettings({
          gameDir: state.gameDir,
          versionId: body.versionId,
          settings: body.settings,
          onLog: (line) => emit('room-log', { line }),
        });
        emit('room-settings', result);
        return json(res, 200, { ok: true, ...result });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/online/room/start' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const room = await startRoom({
          versionId: body.versionId,
          gameDir: state.gameDir,
          eulaAccepted: body.eulaAccepted === true,
          memoryMb: body.memoryMb,
          autoStopOnExit: body.autoStopOnExit !== false,
          settings: body.settings,
          pack: body.pack || null,
          requestedFrp: { provider: body.provider || '', tunnelId: body.tunnelId || '' },
          onStage: (message) => {
            emit('room-stage', { message });
            pushLog(`[room] ${message}`);
          },
          onLog: (line) => emit('room-log', { line }),
        });

        let frp = null;
        let sakuraPortInfo = null;
        try {
          if (!body.provider) throw new Error('没有选择 frp provider');
          if (!body.tunnelId && body.provider !== 'custom') throw new Error('没有选择隧道');
          if (body.provider === 'sakura') {
            sakuraPortInfo = await setSakuraTunnelLocalPort(body.tunnelId, 25565);
            pushLog(`Sakura 隧道 ${body.tunnelId} local_port → 25565${sakuraPortInfo.changed ? `（原 ${sakuraPortInfo.previousLocalPort}）` : ''}`);
          }
          const r = await startTunnel(body.provider, body.tunnelId, 25565);
          if (!r?.address) throw new Error('frpc 已启动但没有拿到公网地址');
          frp = {
            provider: body.provider,
            tunnelId: body.tunnelId || '',
            address: r.address,
            ipAddress: r.ipAddress || '',
            pid: r.pid || null,
            localPort: 25565,
            originalLocalPort: sakuraPortInfo?.previousLocalPort ?? null,
          };
          setRoomFrp(frp);
          room.frp = frp;
          pushLog(`frpc 已启动：${frp.address}`);
        } catch (e) {
          // SakuraFrp 发行版 frpc 拒绝第三方直接启动；若本机服务已把这条
          // 隧道挂到 25565，则复用它的真实地址，否则必须报错。
          const external = onlineSnapshot()[body.provider]?.tunnels
            ?.find((t) => String(t.id) === String(body.tunnelId));
          if (external?.online && external.address && Number(external.localPort) === 25565) {
            frp = {
              provider: body.provider,
              tunnelId: body.tunnelId || '',
              address: external.address,
              ipAddress: external.ipAddress || '',
              pid: null,
              external: true,
              localPort: 25565,
              originalLocalPort: sakuraPortInfo?.previousLocalPort ?? null,
            };
            setRoomFrp(frp);
            room.frp = frp;
            pushLog(`复用已运行的 frp 隧道：${frp.address}`);
          } else {
            try { stopTunnel(body.provider); } catch { /* ignore */ }
            const restoreError = await restoreRoomSakuraPort({
              provider: body.provider,
              tunnelId: body.tunnelId,
              originalLocalPort: sakuraPortInfo?.previousLocalPort,
              localPort: 25565,
            });
            await stopRoom({ keepWorld: true, onLog: (line) => emit('room-log', { line }) });
            const failed = failRoom(`frpc 启动失败：${e.message}${restoreError ? `；还原隧道端口失败：${restoreError}` : ''}`);
            emit('room-state', { room: failed });
            return json(res, 400, { error: failed.error, room: failed });
          }
        }

        try {
          saveRecent({
            mode: 'multiplayer',
            role: 'host',
            versionId: body.versionId,
            loader: body.loader || '',
            gameVersion: body.gameVersion || body.versionId,
            gameDir: state.gameDir,
            serverWorldPath: room.worldDir,
            hostJoined: Boolean(body.joinGame),
            eulaAccepted: body.eulaAccepted === true,
            autoStopOnExit: body.autoStopOnExit !== false,
            worldSettings: room.settings,
            pack: body.pack || null,
            room: {
              provider: body.provider || '',
              tunnelId: body.tunnelId || '',
              remotePort: Number(body.remotePort) || 0,
              address: frp?.address || body.address || '',
            },
          });
        } catch { /* recent 失败不影响开房 */ }

        let gameError = '';
        if (body.joinGame) {
          try {
            await handleLaunch({
              versionId: body.versionId,
              joinAddress: '127.0.0.1:25565',
              recentMeta: {
                mode: 'multiplayer',
                role: 'host',
                versionId: body.versionId,
                loader: body.loader || '',
                gameVersion: body.gameVersion || body.versionId,
                gameDir: state.gameDir,
                serverWorldPath: room.worldDir,
                worldSettings: room.settings,
                hostJoined: true,
                eulaAccepted: body.eulaAccepted === true,
                autoStopOnExit: body.autoStopOnExit !== false,
                room: {
                  provider: body.provider || '',
                  tunnelId: body.tunnelId || '',
                  remotePort: Number(body.remotePort) || 0,
                  address: frp?.address || body.address || '',
                },
              },
            });
          } catch (e) {
            gameError = e.message;
            pushLog(`开房后启动游戏失败：${e.message}`);
          }
        }
        emit('room-state', { room });
        return json(res, 200, { ok: true, room, gameError });
      } catch (e) {
        emit('room-state', { room: getRoomState() });
        return json(res, 400, { error: e.message, room: getRoomState() });
      }
    }
    if (p === '/api/online/room/stop' && req.method === 'POST') {
      try {
        const current = getRoomState();
        if (current.frp?.provider && !current.frp.external) {
          try { stopTunnel(current.frp.provider); } catch { /* frpc 可能已退出 */ }
        }
        const room = await stopRoom({
          keepWorld: true,
          onLog: (line) => emit('room-log', { line }),
        });
        const restoreError = await restoreRoomSakuraPort(current.frp);
        emit('room-state', { room });
        return json(res, 200, { ok: true, room, restoreError });
      } catch (e) {
        return json(res, 500, { error: e.message, room: getRoomState() });
      }
    }

    if (p === '/api/recent' && req.method === 'GET') {
      const recent = readRecent();
      if (!recent) return json(res, 200, { recent: null });
      const check = validateRecent(recent, state.gameDir);
      if (!check.valid) {
        clearRecent();
        return json(res, 200, { recent: null, cleared: check.reason });
      }
      return json(res, 200, { recent });
    }

    if (p === '/api/recent/launch' && req.method === 'POST') {
      const recent = readRecent();
      if (!recent) return json(res, 404, { error: '没有最近游玩记录' });
      const check = validateRecent(recent, state.gameDir);
      if (!check.valid) {
        clearRecent();
        return json(res, 400, { error: check.reason });
      }
      try {
        if (recent.mode === 'single') {
          const launch = await handleLaunch({
            versionId: recent.versionId,
            quickPlaySave: recent.saveName || '',
            recentMeta: recent,
          });
          return json(res, 200, { ok: true, launch, recent });
        }
        if (recent.mode === 'multiplayer' && recent.role === 'guest') {
          const launch = await handleLaunch({
            versionId: recent.versionId,
            joinAddress: recent.joinAddress,
            recentMeta: recent,
          });
          return json(res, 200, { ok: true, launch, recent });
        }
        if (recent.mode === 'multiplayer' && recent.role === 'host') {
          if (getRoomState().status !== 'idle') throw new Error('当前已有房间在运行');
          const provider = recent.room?.provider;
          const configured = provider ? onlineSnapshot()[provider]?.configured : false;
          if (!configured) throw new Error('原来的 frp 配置不可用，请重新配置');
          const room = await startRoom({
            versionId: recent.versionId,
            gameDir: state.gameDir,
            eulaAccepted: true,
            memoryMb: getSettings().roomMemoryMb || undefined,
            autoStopOnExit: recent.autoStopOnExit !== false,
            settings: recent.worldSettings,
            onStage: (message) => {
              emit('room-stage', { message });
              pushLog(`[room] ${message}`);
            },
            onLog: (line) => emit('room-log', { line }),
          });
          let frp = null;
          try {
            let sakuraPortInfo = null;
            if (provider === 'sakura') {
              sakuraPortInfo = await setSakuraTunnelLocalPort(recent.room?.tunnelId || '', 25565);
            }
            const r = await startTunnel(provider, recent.room?.tunnelId || '', 25565);
            if (!r?.address) throw new Error('frpc 已启动但没有拿到公网地址');
            frp = {
              provider,
              tunnelId: recent.room?.tunnelId || '',
              address: r.address,
              ipAddress: r.ipAddress || '',
              pid: r.pid || null,
              localPort: 25565,
              originalLocalPort: sakuraPortInfo?.previousLocalPort ?? null,
            };
            setRoomFrp(frp);
            room.frp = frp;
          } catch (e) {
            const external = onlineSnapshot()[provider]?.tunnels
              ?.find((t) => String(t.id) === String(recent.room?.tunnelId));
            if (external?.online && external.address && Number(external.localPort) === 25565) {
              frp = {
                provider,
                tunnelId: recent.room?.tunnelId || '',
                address: external.address,
                ipAddress: external.ipAddress || '',
                pid: null,
                external: true,
                localPort: 25565,
                originalLocalPort: null,
              };
              setRoomFrp(frp);
              room.frp = frp;
            } else {
              try { stopTunnel(provider); } catch { /* ignore */ }
              await stopRoom({ keepWorld: true, onLog: (line) => emit('room-log', { line }) });
              const failed = failRoom(`frpc 启动失败：${e.message}`);
              emit('room-state', { room: failed });
              return json(res, 400, { error: failed.error, room: failed });
            }
          }
          const roomMeta = { ...recent.room, address: frp.address };
          saveRecent({
            ...recent,
            serverWorldPath: room.worldDir,
            hostJoined: Boolean(recent.hostJoined),
            room: roomMeta,
          });
          room.frp = frp;
          let launch = null;
          if (recent.hostJoined) {
            launch = await handleLaunch({
              versionId: recent.versionId,
              joinAddress: '127.0.0.1:25565',
              recentMeta: { ...recent, room: roomMeta },
            });
          }
          emit('room-state', { room });
          return json(res, 200, { ok: true, room, launch, recent });
        }
        throw new Error('未知的最近游玩模式');
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/online/detect') {
      try {
        const frpc = await detectFrpc();
        return json(res, 200, { frpc, configs: frpc.configs ?? [] });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    if (p === '/api/online/detect-client') {
      try {
        return json(res, 200, await detectClient(url.searchParams.get('provider')));
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    if (p === '/api/online/custom' && req.method === 'GET') {
      return json(res, 200, onlineSnapshot().custom);
    }

    if (p === '/api/online/custom' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, await saveCustomConfig(body));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/online/prepare' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const exe = await prepareFrpc(body.provider === 'openfrp' ? 'openfrp' : 'sakura');
        pushLog(`联机工具已就绪：${exe}`);
        return json(res, 200, { ok: true, exe });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/online/import-client' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await importClientToken(body.provider);
        pushLog(`已从本机 SakuraFrp 客户端导入登录态${r.account ? `（${r.account}）` : ''}`);
        return json(res, 200, r);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/online/token' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await saveProviderToken(body.provider, body.token);
        pushLog(`${body.provider === 'sakura' ? 'SakuraFrp' : 'OpenFrp'} token 已保存`);
        return json(res, 200, r);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/online/tunnels' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, { tunnels: await listTunnels(body.provider) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/online/create' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await createTunnel(body.provider, {
          name: body.name,
          localPort: body.localPort,
        });
        pushLog(`${body.provider === 'sakura' ? 'SakuraFrp' : 'OpenFrp'} 隧道已创建：${r?.name ?? r?.id ?? ''}`);
        return json(res, 200, { ok: true, tunnel: r });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/online/start' && req.method === 'POST') {      const body = await readBody(req);
      try {
        const r = await startTunnel(body.provider, body.tunnelId, body.localPort);
        pushLog(`${body.provider === 'sakura' ? 'SakuraFrp' : 'OpenFrp'} 隧道启动：${r.address || '等待地址'}`);
        return json(res, 200, r);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    if (p === '/api/online/stop' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, stopTunnel(body.provider));
    }

    if (p === '/api/online/lan-port') {
      const versionId = url.searchParams.get('versionId') || '';
      if (state.lanPort?.port && (!versionId || !state.lanPort.versionId || state.lanPort.versionId === versionId)) {
        return json(res, 200, { ...state.lanPort, source: 'stdout' });
      }
      const found = detectLanPort(state.gameDir, versionId);
      return json(res, 200, { ...found, source: 'latest.log' });
    }

    if (p === '/api/online/upnp/start' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await openUpnp(Number(body.port) || 25565);
        pushLog(`UPnP 端口映射：公网 ${r.publicIp}:${r.port}`);
        return json(res, 200, { ...r, mapping: upnpState() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/online/upnp/stop' && req.method === 'POST') {
      try {
        await closeUpnp();
        return json(res, 200, { ok: true, mapping: upnpState() });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // 本机局域网 IP：游戏里「对局域网开放」后，朋友要连的就是它
    if (p === '/api/net/lan') {      const nets = os.networkInterfaces();
      const addrs = [];
      for (const [name, list] of Object.entries(nets)) {
        for (const n of list ?? []) {
          // 只要 IPv4、非回环，虚拟网卡（VMware/VirtualBox）尽量排在后面
          if (n.family !== 'IPv4' || n.internal) continue;
          addrs.push({
            name,
            address: n.address,
            virtual: /vmware|virtualbox|vethernet|hyper-v|wsl|tap|tun|radmin|hamachi|zerotier|tailscale|wireguard|openvpn|蒲公英|pgy/i.test(name),
          });
        }
      }
      addrs.sort((a, b) => Number(a.virtual) - Number(b.virtual));
      return json(res, 200, { addresses: addrs });
    }

    // 真 Minecraft status ping：SRV + handshake + status
    if (p === '/api/net/ping' && req.method === 'POST') {
      const body = await readBody(req);
      const raw = String(body.host ?? '').trim();
      if (!raw) return json(res, 400, { error: '请填服务器地址' });

      const m = /^([^:/\s]+)(?::(\d+))?$/.exec(raw);
      if (!m) return json(res, 400, { error: '地址格式不对，例如 play.example.com 或 1.2.3.4:25565' });
      const host = m[1];
      const port = m[2] ? Number(m[2]) : 25565;
      if (!(port > 0 && port < 65536)) return json(res, 400, { error: '端口要在 1-65535 之间' });

      const result = await pingMinecraft(host, port, Boolean(m[2]));
      return json(res, 200, result);
    }

    /* ---- 设置 ---- */

    if (p === '/api/settings' && req.method === 'GET') {
      return json(res, 200, {
        settings: getSettings(),
        defaults: DEFAULTS,
        file: SETTINGS_FILE,
        // Java 候选列表，给设置页的下拉框用
        javas: await listJavas(),
      });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const askedMb = memoryToMb(body.memoryMax);
      const cap = memoryCapMb();
      if (askedMb && askedMb > cap) {
        return json(res, 400, { error: `最大内存 ${body.memoryMax} 超过物理内存 80% 上限（${cap}M）` });
      }
      const before = getSettings();
      const { value, notes } = await saveSettings(body);

      // 游戏目录改了要同步给正在跑的服务，否则装到旧目录去
      if (value.gameDir !== before.gameDir) {
        if (state.installing) throw new Error('正在安装，不能改游戏目录');
        if (state.running) throw new Error('游戏正在运行，不能改游戏目录');
        state.gameDir = value.gameDir;
      }

      pushLog(`设置已保存（并发 ${value.concurrency}，最大内存 ${value.memoryMax}）`);
      return json(res, 200, { settings: value, notes });
    }

    if (p === '/api/update/check' && req.method === 'GET') {
      const configured = String(getSettings().updateUrl ?? '').trim() ||
        'https://gh-proxy.com/https://github.com/Sakura-ChenTY/SakuraLauncher/releases/latest/download/latest.yml';
      const candidates = updateFileCandidates(updateUrlCandidates(configured));
      const errors = [];
      for (const candidate of candidates) {
        try {
          if (!/^https?:\/\//i.test(candidate)) throw new Error('更新地址不是 http(s)');
          const r = await fetch(candidate, {
            headers: { Accept: 'application/json, text/yaml, text/plain, */*' },
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = updateFromResponse(await r.text(), candidate);
          if (!data?.version || !data?.url) throw new Error('更新清单缺 version/url');
          return json(res, 200, {
            current: APP_VERSION,
            update: isNewerVersion(APP_VERSION, data.version) ? {
              version: String(data.version),
              url: String(data.url),
              notes: String(data.notes ?? ''),
              sha256: String(data.sha256 ?? ''),
              feedUrl: new URL('.', candidate).toString(),
            } : null,
          });
        } catch (e) {
          errors.push(`${candidate}：${e.message || '请求失败'}`);
          // 当前地址失败，继续尝试直连/备用镜像
        }
      }
      return json(res, 200, {
        current: APP_VERSION,
        update: null,
        error: errors.length ? errors.join('；') : '没有可用的更新地址',
      });
    }

    if (p === '/api/update/install' && req.method === 'POST') {
      const body = await readBody(req);
      const url = String(body.url ?? '').trim();
      const sha = String(body.sha256 ?? '').trim().toLowerCase();
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: '安装包地址必须是 http(s)' });
      if (!/^[a-f0-9]{64}$/.test(sha)) return json(res, 400, { error: 'latest.json 缺少有效 sha256' });
      const target = path.join(os.tmpdir(), `SakuraLauncher-Setup-${Date.now()}.exe`);
      const candidates = updateUrlCandidates(url);
      let lastError = null;
      for (const candidate of candidates) {
        try {
          const r = await fetch(candidate, { signal: AbortSignal.timeout(5 * 60 * 1000) });
          if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`);
          const buf = Buffer.from(await r.arrayBuffer());
          const got = crypto.createHash('sha256').update(buf).digest('hex');
          if (got !== sha) throw new Error('sha256 校验失败，已拒绝安装');
          await fsp.writeFile(target, buf);
          return json(res, 200, {
            path: target,
            exePath: process.execPath,
            installDir: path.dirname(process.execPath),
            size: buf.length,
          });
        } catch (e) {
          lastError = e;
          try { await fsp.rm(target, { force: true }); } catch { /* ignore */ }
        }
      }
      return json(res, 400, { error: lastError?.message || '下载安装包失败' });
    }

    if (p === '/api/system/memory' && req.method === 'GET') {
      const total = os.totalmem();
      const free = os.freemem();
      return json(res, 200, {
        total: Math.round(total / 1024 / 1024),
        free: Math.round(free / 1024 / 1024),
        used: Math.round((total - free) / 1024 / 1024),
        maxMemory: memoryCapMb(),
      });
    }

    if (p === '/api/path/ensure' && req.method === 'POST') {
      const body = await readBody(req);
      const target = path.resolve(String(body.path ?? '').trim());
      if (!target) return json(res, 400, { error: '路径为空' });
      try {
        fs.mkdirSync(target, { recursive: true });
        fs.accessSync(target, fs.constants.W_OK);
        return json(res, 200, { ok: true, path: target });
      } catch (e) {
        return json(res, 400, { error: `无法创建/写入目录：${e.message}` });
      }
    }

    if (p === '/api/path/check' && req.method === 'POST') {
      const body = await readBody(req);
      const target = path.resolve(String(body.path ?? '').trim());
      const out = { path: target, exists: false, dir: false, file: false, readable: false, writable: false };
      try {
        const st = fs.statSync(target);
        out.exists = true;
        out.dir = st.isDirectory();
        out.file = st.isFile();
        try { fs.accessSync(target, fs.constants.R_OK); out.readable = true; } catch { /* no */ }
        try { fs.accessSync(target, fs.constants.W_OK); out.writable = true; } catch { /* no */ }
      } catch { /* missing */ }
      return json(res, 200, out);
    }

    /* ---- 绘梨衣小助手 ---- */
    if (p === '/api/assistant/config' && req.method === 'GET') {
      const cfg = loadAiConfig();
      return json(res, 200, {
        provider: cfg.provider,
        baseURL: cfg.baseURL,
        model: cfg.model,
        hasKey: aiHasKey(),
        keyMask: aiKeyMask(),
      });
    }

    if (p === '/api/assistant/config' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const cfg = await saveAiConfig(body);
        return json(res, 200, {
          provider: cfg.provider,
          baseURL: cfg.baseURL,
          model: cfg.model,
          hasKey: aiHasKey(),
          keyMask: aiKeyMask(),
        });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/assistant/test' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const cfg = loadAiConfig();
        const reply = await testAi({
          baseURL: body.baseURL || cfg.baseURL,
          apiKey: body.apiKey || undefined,
          model: body.model || cfg.model,
        });
        return json(res, 200, { ok: true, reply: String(reply).slice(0, 80) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/assistant/session' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const versionId = String(body.versionId || state.running?.versionId || state.lastFailure?.versionId || '').trim();
        const session = createSession({
          gameDir: state.gameDir,
          versionId,
          lastFailure: state.lastFailure,
          logs: state.logs.map((x) => x.line ?? x),
          launchCommand: state.lastLaunch?.command ?? null,
        });
        return json(res, 200, { session });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/assistant/chat' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = await chatSession({ id: body.sessionId, message: body.message, mode: body.mode, diagnosticsState: state });
        return json(res, 200, result);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/assistant/auto' && req.method === 'POST') {
      const incident = state.crashIncident;
      if (!incident) return json(res, 404, { error: '没有新的崩溃记录' });
      if (incident.prompted) return json(res, 200, { already: true, incident });
      incident.prompted = true;
      try {
        const session = createSession({
          gameDir: state.gameDir,
          versionId: incident.versionId,
          lastFailure: { versionId: incident.versionId, code: incident.code, reason: incident.reason, at: incident.at },
          logs: state.logs.map((x) => x.line ?? x),
          launchCommand: state.lastLaunch?.command ?? null,
        });
        const result = await chatSession({
          id: session.id,
          message: `游戏异常退出，退出码 ${incident.code ?? '未知'}。请分析原因并给下一步建议。`,
          mode: 'diagnostic',
          diagnosticsState: state,
        });
        return json(res, 200, { ...result, incident });
      } catch (e) {
        incident.prompted = false;
        return json(res, 400, { error: e.message });
      }
    }
    if (p === '/api/saves' && req.method === 'GET') {
      const url = new URL(req.url, 'http://127.0.0.1');
      const versionId = String(url.searchParams.get('versionId') || '').trim();
      if (!versionId || !resolveInstanceDir(versionId)) return json(res, 404, { error: '实例不存在' });
      return json(res, 200, listSaves({ gameDir: state.gameDir, versionId }));
    }

    if (p === '/api/saves/backup' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const versionId = String(body.versionId || '').trim();
        if (!resolveInstanceDir(versionId)) throw new Error('实例不存在');
        if (state.saving) throw new Error('正在处理存档，请稍候');
        state.saving = true;
        const taskId = startTask('backup', body.taskId);
        try {
          const result = await backupWorld({
            gameDir: state.gameDir,
            versionId,
            world: String(body.world || ''),
            whileRunning: Boolean(state.running),
            shouldCancel: () => taskCancelled(taskId),
            onProgress: (p) => emit('save-progress', { ...p, taskId }),
          });
          pushLog(`存档已备份：${result.world}`);
          return json(res, 200, { ...result, taskId });
        } catch (e) {
          if (e?.cancelled || taskCancelled(taskId)) {
            return json(res, 200, { cancelled: true, taskId, message: '已取消' });
          }
          return json(res, 400, { error: e.message });
        } finally {
          finishTask(taskId);
        }
      } catch (e) {
        return json(res, 400, { error: e.message });
      } finally { state.saving = false; }
    }

    if (p === '/api/saves/backup-all' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const versionId = String(body.versionId || '').trim();
        if (!resolveInstanceDir(versionId)) throw new Error('实例不存在');
        if (state.saving) throw new Error('正在处理存档，请稍候');
        state.saving = true;
        const taskId = startTask('backup', body.taskId);
        try {
          const results = await backupAll({
            gameDir: state.gameDir,
            versionId,
            whileRunning: Boolean(state.running),
            shouldCancel: () => taskCancelled(taskId),
            onProgress: (p) => emit('save-progress', { ...p, taskId }),
          });
          return json(res, 200, { results, taskId });
        } catch (e) {
          if (e?.cancelled || taskCancelled(taskId)) {
            return json(res, 200, { cancelled: true, taskId, message: '已取消' });
          }
          return json(res, 400, { error: e.message });
        } finally {
          finishTask(taskId);
        }
      } catch (e) {
        return json(res, 400, { error: e.message });
      } finally { state.saving = false; }
    }

    if (p === '/api/saves/import/preview' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const versionId = String(body.versionId || '').trim();
        if (!resolveInstanceDir(versionId)) throw new Error('实例不存在');
        const info = readInstanceInfo(versionId) || {};
        return json(res, 200, previewSaveImport({
          gameDir: state.gameDir,
          versionId,
          source: String(body.path || ''),
          targetGameVersion: info.gameVersion || versionId,
        }));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/saves/import' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.running) return json(res, 409, { error: '游戏还开着，先关掉再导入' });
      try {
        const versionId = String(body.versionId || '').trim();
        if (!resolveInstanceDir(versionId)) throw new Error('实例不存在');
        if (state.saving) throw new Error('正在处理存档，请稍候');
        state.saving = true;
        const info = readInstanceInfo(versionId) || {};
        const result = await importSave({
          gameDir: state.gameDir,
          versionId,
          source: String(body.path || ''),
          targetGameVersion: info.gameVersion || versionId,
        });
        pushLog(`导入外部存档：${result.world}`);
        return json(res, 200, result);
      } catch (e) {
        return json(res, 400, { error: e.message });
      } finally { state.saving = false; }
    }

    if (p === '/api/saves/restore' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.running) return json(res, 409, { error: RUNNING_RESTORE_BLOCK });
      try {
        const versionId = String(body.versionId || '').trim();
        if (!resolveInstanceDir(versionId)) throw new Error('实例不存在');
        if (state.saving) throw new Error('正在处理存档，请稍候');
        state.saving = true;
        const result = await restoreBackup({
          gameDir: state.gameDir,
          versionId,
          file: String(body.file || ''),
          onProgress: (p) => emit('save-progress', p),
        });
        pushLog(`存档已恢复：${result.world}`);
        return json(res, 200, result);
      } catch (e) {
        return json(res, 400, { error: e.message });
      } finally { state.saving = false; }
    }

    if (p === '/api/saves/open' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const versionId = String(body.versionId || '').trim();
        if (!resolveInstanceDir(versionId)) throw new Error('实例不存在');
        const kind = body.kind === 'backups' ? 'backups' : 'saves';
        const info = listSaves({ gameDir: state.gameDir, versionId });
        const target = kind === 'backups' ? info.backupDir : info.savesDir;
        fs.mkdirSync(target, { recursive: true });
        spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, path: target });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/pack/update/preview' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const versionId = String(body.versionId || '').trim();
        if (!resolveInstanceDir(versionId)) throw new Error('实例不存在');
        return json(res, 200, previewPackUpdate({
          gameDir: state.gameDir,
          versionId,
          archivePath: String(body.path || ''),
          overwriteConfig: body.overwriteConfig === true,
        }));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/pack/update/apply' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.running) return json(res, 409, { error: '游戏正在运行，先退出再更新' });
      if (state.saving) return json(res, 409, { error: '正在处理存档，请稍候' });
      try {
        const versionId = String(body.versionId || '').trim();
        if (!resolveInstanceDir(versionId)) throw new Error('实例不存在');
        state.saving = true;
        const result = await applyPackUpdate({
          gameDir: state.gameDir,
          versionId,
          archivePath: String(body.path || ''),
          overwriteConfig: body.overwriteConfig === true,
        });
        pushLog(`整合包更新：${result.summary}；${result.protectedNote}${result.removedDir ? `；移除文件在 ${result.removedDir}` : ''}`);
        return json(res, 200, result);
      } catch (e) {
        return json(res, 400, { error: e.message });
      } finally { state.saving = false; }
    }

    if (p === '/api/export/preview' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, previewExport({
          gameDir: state.gameDir,
          versionId: String(body.versionId || ''),
          options: { ...(body.options || {}), whileRunning: Boolean(state.running) },
        }));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/export' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.exporting) return json(res, 409, { error: '正在导出，请稍候' });
      state.exporting = true;
      const taskId = startTask('export', body.taskId);
      try {
        const result = await exportInstance({
          gameDir: state.gameDir,
          versionId: String(body.versionId || ''),
          destination: body.destination || '',
          options: {
            ...(body.options || {}),
            whileRunning: Boolean(state.running),
            shouldCancel: () => taskCancelled(taskId),
          },
          onProgress: (p) => emit('export-progress', { ...p, taskId }),
        });
        pushLog(`整合包导出完成：${result.name}`);
        return json(res, 200, { ...result, taskId });
      } catch (e) {
        if (e?.cancelled || taskCancelled(taskId)) {
          pushLog('整合包导出已取消，临时文件已清理');
          return json(res, 200, { cancelled: true, taskId, message: '已取消' });
        }
        return json(res, 400, { error: e.message });
      } finally {
        state.exporting = false;
        finishTask(taskId);
      }
    }

    if (p === '/api/export/open' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const target = path.resolve(String(body.path || ''));
        if (!fs.existsSync(target) || !/\.zip$/i.test(target)) throw new Error('导出文件不存在');
        spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/assistant/diagnose/package/preview' && req.method === 'POST') {
      const body = await readBody(req);
      const versionId = String(body.versionId || state.running?.versionId || state.lastFailure?.versionId || '').trim();
      return json(res, 200, previewDiagnosticPackage({ gameDir: state.gameDir, versionId }));
    }

    if (p === '/api/assistant/diagnose/package' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const versionId = String(body.versionId || state.running?.versionId || state.lastFailure?.versionId || '').trim();
        const result = await createDiagnosticPackage({ gameDir: state.gameDir, versionId });
        return json(res, 200, result);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/assistant/diagnose/package/open' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const target = path.resolve(String(body.path || ''));
        const root = path.resolve(HOME_DIR, 'diagnostic-packages');
        const desktop = path.resolve(os.homedir(), 'Desktop');
        const desktopDiag = path.dirname(target) === desktop
          && /^绘梨衣诊断-.*\.zip$/i.test(path.basename(target));
        if (!target.startsWith(root + path.sep) && !desktopDiag) throw new Error('诊断包目录不合法');
        spawn('explorer.exe', [path.dirname(target)], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (p === '/api/assistant/diagnose' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        let category = body.category && SYMPTOMS[body.category]
          ? body.category
          : detectSymptom(body.message || '');
        if (category === 'unknown') category = guessSymptom(body.message || '', state);
        const text = await collectSymptomContext(category, {
          gameDir: state.gameDir,
          versionId: body.versionId || state.running?.versionId || state.lastFailure?.versionId || '',
          state,
        });
        return json(res, 200, { category, label: SYMPTOMS[category], text });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (p === '/api/assistant/session' && req.method === 'GET') {
      const session = getSession(url.searchParams.get('id') || '');
      return json(res, session ? 200 : 404, session ? { session } : { error: '会话不存在' });
    }
    if (p === '/api/assistant/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = await analyzeFailure({
          gameDir: state.gameDir,
          versionId: body.versionId || state.running?.versionId || state.lastFailure?.versionId,
          lastFailure: state.lastFailure,
          logs: state.logs,
        });
        return json(res, 200, result);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/assistant/action' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.action && body.id) body.action = body.id;
      try {
        const versionId = String(body.payload?.versionId ?? body.versionId ?? '').trim();
        const needVersion = () => { if (!versionId) throw new Error('没有目标实例'); };
        if (body.action === 'memory.set') {
          const memoryMax = String(body.payload?.memoryMax ?? '6144M').trim();
          const memoryMin = String(body.payload?.memoryMin ?? '').trim();
          needVersion();
          if (memoryToMb(memoryMax) > memoryCapMb()) {
            throw new Error(`建议内存 ${memoryMax} 超过物理内存 80% 上限（${memoryCapMb()}M）`);
          }
          const patch = { memoryMax };
          if (memoryMin) patch.memoryMin = memoryMin;
          writeInstanceOverride(versionId, patch);
          return json(res, 200, { ok: true, message: `已把 ${versionId} 内存改为 ${memoryMin || '原值'} / ${memoryMax}` });
        }
        if (body.action === 'java.set') {
          needVersion();
          const javaPath = String(body.payload?.javaPath ?? '').trim();
          if (!javaPath) throw new Error('没有选择 Java 路径');
          writeInstanceOverride(versionId, { javaPath });
          return json(res, 200, { ok: true, message: `已为 ${versionId} 指定 Java：${javaPath}` });
        }
        if (body.action === 'open.instance') {
          needVersion();
          const dir = resolveInstanceDir(versionId);
          if (!dir) throw new Error('实例不存在');
          spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, message: '已打开实例目录' });
        }
        if (body.action === 'redownload.version' || body.action === 'redownload.resources') {
          needVersion();
          const source = (await resolveSource(getSettings().downloadSource)).source;
          await installVersion({ gameDir: state.gameDir, versionId, source, onStage: () => {}, onProgress: () => {} });
          return json(res, 200, { ok: true, message: '版本/资源文件已重新检查并补齐' });
        }
        if (body.action === 'mod.disable') {
          needVersion();
          const file = String(body.payload?.file ?? '').trim();
          if (!file || /[\\/]/.test(file) || !/\.jar$/i.test(file)) throw new Error('mod 文件名不合法');
          const dir = path.join(state.gameDir, 'versions', versionId, 'mods');
          const src = path.join(dir, file);
          if (!fs.existsSync(src)) throw new Error('mod 文件不存在');
          await fsp.rename(src, `${src}.disabled`);
          return json(res, 200, { ok: true, message: `已停用 ${file}（没有删除）` });
        }
        if (body.action === 'serverpack.redownload') {
          const room = getRoomState();
          const cache = room?.serverDir ? path.join(room.serverDir, '.cache', 'cf-server.zip') : '';
          if (cache && fs.existsSync(cache)) {
            await fsp.rm(cache, { force: true });
            return json(res, 200, { ok: true, message: '已清理 server pack 缓存，请重新开房' });
          }
          return json(res, 200, { ok: true, message: '没有缓存可清理，请重新开房' });
        }
        throw new Error('这个动作不在白名单里');
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // Java 目录扫描（设置页「重新扫描」按钮）
    if (p === '/api/settings/javas') {
      const force = url.searchParams.get('force') === '1';
      return json(res, 200, { javas: await listJavas(force) });
    }

    /* ---- 下载源 ---- */

    // 有哪些源可选（给设置页下拉框）
    if (p === '/api/sources') {
      return json(res, 200, {
        current: getSettings().downloadSource,
        sources: SOURCE_IDS.map((id) => ({
          id,
          name: SOURCES[id].name,
          note: SOURCES[id].note,
          mirrorable: SOURCES[id].rules.length > 0,
        })),
      });
    }

    // 实测各源速度（设置页「测速」按钮，也供安装前 auto 用）
    if (p === '/api/sources/measure' && req.method === 'POST') {
      if (state.installing) throw new Error('正在安装，稍后再测速');
      const results = await measureSources();
      // 测完清缓存，让下一次 auto 重新决策（用户手动点测速后应生效）
      clearSourceCache();
      const best = results.find((r) => r.ok > 0 && r.badContent === 0);
      pushLog(
        `下载源测速：${results.map((r) => `${r.name} ${r.ok}/${r.total} ${r.kbps}KB/s`).join('，')}`
      );
      return json(res, 200, {
        results: results.map((r) => ({
          id: r.id,
          name: r.name,
          ok: r.ok,
          fail: r.fail,
          badContent: r.badContent,
          total: r.total,
          kbps: r.kbps,
          mb: Number((r.bytes / 1024 / 1024).toFixed(2)),
          seconds: Number((r.ms / 1000).toFixed(1)),
          consistent: r.consistent,
          errors: r.errors,
        })),
        recommended: best?.id ?? 'official',
      });
    }

    // ---- 桌面壁纸（磨砂背景用）----
    // 页面想要「桌面壁纸 + 毛玻璃」的观感，但浏览器拿不到系统壁纸。
    // 这里把当前用户主题里的壁纸读出来喂给前端，读不到就让前端退回渐变。
    if (p === '/api/wallpaper') {
      const file = findWallpaper();
      if (!file) {
        res.writeHead(204).end();
        return;
      }
      try {
        const data = await fsp.readFile(file);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-store',
          'X-Wallpaper-Source': encodeURIComponent(path.basename(file)),
        });
        res.end(data);
      } catch {
        res.writeHead(204).end();
      }
      return;
    }

    // ---- 实例图标 ----
    // 手动换图标：前端传 base64，落盘成实例目录里的 icon.*
    // 这一条覆盖所有来源的实例（CurseForge / 自制 / 手动导入），
    // 因为自动取封面只能覆盖 Modrinth 的整合包。
    if (p.startsWith('/api/icon/') && req.method === 'POST') {
      const versionId = decodeURIComponent(p.slice('/api/icon/'.length));
      if (!versionId || versionId.includes('/') || versionId.includes('\\') || versionId.includes('..')) {
        res.writeHead(400).end('bad id');
        return;
      }

      const dir = path.join(state.gameDir, 'versions', versionId);
      if (!fs.existsSync(dir)) {
        json(res, 404, { error: `实例不存在：${versionId}` });
        return;
      }

      const body = await readBody(req);
      const dataUrl = String(body.dataUrl ?? '');
      const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!m) {
        json(res, 400, { error: '只支持 PNG / JPEG / WebP / GIF 图片' });
        return;
      }

      let buf;
      try {
        buf = Buffer.from(m[2], 'base64');
      } catch {
        json(res, 400, { error: '图片数据损坏' });
        return;
      }
      if (!buf.length) return json(res, 400, { error: '图片为空' });
      if (buf.length > 4 * 1024 * 1024) return json(res, 400, { error: '图片过大（上限 4MB）' });

      // 按真实字节定后缀，别信 dataUrl 声明的类型
      const ext =
        buf[0] === 0x89 && buf[1] === 0x50 ? 'png'
          : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg'
            : buf.slice(0, 4).toString('latin1') === 'RIFF' ? 'webp'
              : buf.slice(0, 3).toString('latin1') === 'GIF' ? 'gif'
                : null;
      if (!ext) return json(res, 400, { error: '无法识别图片格式' });

      // 清掉旧的图标候选，避免 icon.png 和 icon.webp 同时存在时取错
      for (const n of ['icon.png', 'icon.jpg', 'icon.jpeg', 'icon.webp', 'icon.gif', 'pack.png', 'logo.png', `${versionId}.png`]) {
        const f = path.join(dir, n);
        if (fs.existsSync(f)) {
          try { await fsp.rm(f, { force: true }); } catch { /* 删不掉就留着 */ }
        }
      }

      const name = `icon.${ext}`;
      await fsp.writeFile(path.join(dir, name), buf);
      pushLog(`已更换实例图标：${versionId} → ${name}（${Math.round(buf.length / 1024)}KB）`);
      return json(res, 200, { ok: true, file: name, bytes: buf.length });
    }

    // ---- 实例图标 ----
    // 实例自己的图优先，没有就回落到加载器默认图（原版方块贴图）
    if (p.startsWith('/api/icon/') && req.method === 'GET') {
      const versionId = decodeURIComponent(p.slice('/api/icon/'.length));
      if (!versionId || versionId.includes('/') || versionId.includes('\\') || versionId.includes('..')) {
        res.writeHead(400).end('bad id');
        return;
      }

      const own = findInstanceIcon(versionId);
      let filePath = own.file;
      if (!filePath) {
        const info = readInstanceInfo(versionId);
        filePath = path.join(PUBLIC_DIR, 'version-icons', defaultIconFor(info?.kind ?? info?.loader ?? ''));
      }

      try {
        const data = await fsp.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'image/png',
          // 不加 max-age：用户换完图标应该立刻看到，
          // 之前的 max-age=600 导致旧图被缓存、新图标迟迟不生效。
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(data);
      } catch {
        res.writeHead(404).end('no icon');
      }
      return;
    }

    // ---- 静态 ----
    if (req.method === 'GET') return serveStatic(req, res, p);

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

/**
 * 找当前用户的桌面壁纸。
 *
 * 浏览器拿不到系统壁纸，但「磨砂玻璃」观感需要底下有真实图像，
 * 否则只剩一片糊状的灰色。两处来源：
 *   1. 注册表 WallPaper 指向的原图（用户自己设的那种）
 *   2. 主题转码后的 TranscodedWallpaper（幻灯片/主题包的兜底）
 * 找不到返回 null，前端退回渐变背景。
 */
function findWallpaper() {
  const cands = [];

  // 注册表里的原始路径。reg.exe 在所有 Windows 上都在，比额外加依赖划算。
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    const m = out.match(/WallPaper\s+REG_SZ\s+(.+)/i);
    if (m) cands.push(m[1].trim());
  } catch {
    /* 没有就算了，下面还有兜底 */
  }

  const appData = process.env.APPDATA;
  if (appData) {
    cands.push(path.join(appData, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper'));
    cands.push(path.join(appData, 'Microsoft', 'Windows', 'Themes', 'CachedFiles'));
  }

  for (const c of cands) {
    try {
      const st = fs.statSync(c);
      if (st.isFile() && st.size > 20_000) return c;
      if (st.isDirectory()) continue;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

function snapshot() {
  return {
    gameDir: state.gameDir,
    installing: state.installing,
    installInterrupted: state.installInterrupted,
    lastFailure: state.lastFailure,
    running: state.running,
    logs: state.logs.slice(-50),
    version: APP_VERSION,
  };
}

/** 扫描本机可用的 Java（设置页展示用） */
async function listJavas(force = false) {
  try {
    const list = await scanJavas(JAVA_SCAN_CACHE, { force });
    return list.map((j) => ({ path: j.path, major: j.major, raw: j.raw }));
  } catch (e) {
    return [{ path: '', major: null, raw: '扫描失败：' + e.message }];
  }
}

/* ---------------- 内容/模组/整合包 ---------------- */

/** 读实例的版本 JSON（合并继承后的最简信息），用于判断加载器与游戏版本 */
function readInstanceInfo(versionId) {
  const dir = path.join(state.gameDir, 'versions', versionId);
  const jsonPath = path.join(dir, `${versionId}.json`);
  if (!fs.existsSync(jsonPath)) return null;

  let json;
  try {
    json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return null;
  }

  // 游戏版本判定顺序（实测踩过坑，别改回去）：
  //   1. clientVersion —— PCL 导出的实例会带这个字段，是最可靠的真值
  //   2. inheritsFrom  —— 标准 Fabric/Forge 实例指向父版本
  //   3. 父版本的 id
  //   4. 实例名本身（仅作最后兜底）
  //
  // 为什么不能直接用 versionId：PCL 建实例时会取名 "26.3-Fabric 0.19.5"，
  // json 里 id 也是这个名字且没有 inheritsFrom。把它当游戏版本传给 Modrinth，
  // 会一个都匹配不上 —— 实测 15 个可更新变成 0 个。
  let gameVersion = json.clientVersion || json.inheritsFrom || null;
  let loader = detectLoaderFromVersionJson(json);

  // 继承型的实例（Fabric 等）自身字段很少，要看父版本
  if (json.inheritsFrom) {
    const parentPath = path.join(state.gameDir, 'versions', json.inheritsFrom, `${json.inheritsFrom}.json`);
    if (fs.existsSync(parentPath)) {
      try {
        const parent = JSON.parse(fs.readFileSync(parentPath, 'utf8'));
        gameVersion = json.clientVersion || parent.id || json.inheritsFrom;
        loader = loader ?? detectLoaderFromVersionJson(parent);
      } catch {
        /* 父版本 JSON 坏了就用 inherit 值 */
      }
    }
  }

  // 加载器都认不出、且名字里的版本号也取不到时，才退回实例名
  if (!gameVersion) {
    // 从 "26.3-Fabric 0.19.5" / "1.21.1-Forge_47.4.16" 这类名字里扒出版本号
    const m = /^(\d+\.\d+(?:\.\d+)?)/.exec(versionId);
    gameVersion = m && m[1] !== versionId ? m[1] : versionId;
  }

  let hasMods = false;
  try {
    const modsDir = path.join(dir, 'mods');
    hasMods = fs.existsSync(modsDir) &&
      fs.readdirSync(modsDir, { withFileTypes: true }).some((x) => !x.isDirectory());
  } catch { /* 忽略 */ }
  const snapshot = json.type === 'snapshot' || /snapshot/i.test(versionId);
  const kind = snapshot ? 'snapshot' : (hasMods ? 'modpack' : (loader || 'vanilla'));
  const loaderVersion =
    (versionId.match(/neoforge[-_ ]?([\d.]+)/i) ||
      versionId.match(/forge[-_ ]?([\d.]+)/i) ||
      versionId.match(/fabric[-_ ]?([\d.]+)/i) ||
      versionId.match(/quilt[-_ ]?([\d.]+)/i) ||
      [])[1] || '';

  return {
    versionId,
    gameVersion,
    loader,
    kind,
    loaderVersion,
    javaRequired: json.javaVersion?.majorVersion ?? null,
    name: json.id ?? versionId,
  };
}

/**
 * 实例图标：优先用实例目录里自带的图片，没有就用加载器对应的默认图。
 * 默认图是从游戏 jar 里取的原版方块贴图（见 public/version-icons），
 * 不是画出来的色块。
 */
function findInstanceIcon(versionId) {
  const dir = path.join(state.gameDir, 'versions', versionId);
  // PCL 的习惯是 <版本名>.png；有些整合包用 icon.png / pack.png
  const candidates = [
    path.join(dir, `${versionId}.png`),
    path.join(dir, 'icon.png'),
    path.join(dir, 'icon.webp'),
    path.join(dir, 'pack.png'),
    path.join(dir, 'icon.jpg'),
    path.join(dir, 'icon.jpeg'),
    path.join(dir, 'logo.png'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { own: true, file: c };
  }
  return { own: false, file: null };
}

/** 加载器 → 默认图标文件名（这些文件在 public/version-icons 下） */
const DEFAULT_ICON_BY_LOADER = {
  forge: 'forge-block.png',
  fabric: 'fabric-block.png',
  quilt: 'quilt-block.png',
  neoforge: 'neoforge-block.png',
  vanilla: 'grass-block.png',
  snapshot: 'command-block.png',
  modpack: 'modpack-block.png',
};

function defaultIconFor(loader) {
  // loader 可能是 '' / null / undefined，三种都算原版。
  // 用 ?? 坑在这里：空字符串不是 nullish，会绕过兜底取到 default.png。
  const key = String(loader || 'vanilla').toLowerCase();
  return DEFAULT_ICON_BY_LOADER[key] ?? 'default.png';
}

async function handleContentInstall(body) {
  const { versionId, projectType, files } = body;
  if (!versionId) throw new Error('缺少 versionId（目标实例）');
  if (!projectType) throw new Error('缺少 projectType');
  if (!Array.isArray(files) || !files.length) throw new Error('缺少 files');
  if (state.installing) throw new Error('已有任务在进行');

  state.installing = { versionId, stage: 'content', done: 0, total: files.length };
  startJob();
  emit('content-start', { versionId, projectType, count: files.length });

  (async () => {
    try {
      const info = readInstanceInfo(versionId) || {};
      let dep = { files: [], added: 0, failed: [] };
      if (projectType === 'mod') {
        dep = await resolveRequiredDependencies({
          source: body.source || files[0]?.source || '',
          gameVersion: info.gameVersion || '',
          loader: info.loader || '',
          files,
          maxDepth: 3,
          onProgress: (p) => {
            state.installing = { ...state.installing, ...p };
            emit('content-progress', { versionId, ...p });
          },
        });
      }
      const r = await installContent({
        gameDir: state.gameDir,
        versionId,
        projectType,
        files: [...files, ...dep.files],
        source: (await awaitOrCancel(resolveSource(getSettings().downloadSource))).source,
        onProgress: (p) => {
          state.installing = { ...state.installing, ...p };
          emit('content-progress', { versionId, ...p });
        },
      });
      r.dependencies = dep;
      state.installing = null;
      endJob();
      emit('content-done', { versionId, projectType, result: r });
      pushLog(
        `内容安装完成：${r.installed.length} 个新装，${r.skipped.length} 个已存在，${r.failed.length} 个失败；已自动补 ${r.dependencies?.added || 0} 个依赖 → ${r.dir}`
      );
      for (const depFail of r.dependencies?.failed || []) {
        pushLog(`依赖未安装：${depFail.name}（${depFail.reason}）`);
      }
    } catch (e) {
      const cancelled = e?.cancelled || e instanceof CancelledError;
      let wiped = null;
      if (cancelled) {
        try {
          wiped = await rollbackJob();
        } catch {
          /* 回滚失败不盖住取消 */
        }
      }
      state.installing = null;
      endJob();
      if (cancelled) {
        emit('content-cancelled', { versionId, message: e.message || '已取消', wiped: wiped ?? undefined });
        pushLog(
          wiped && (wiped.files || wiped.dirs)
            ? `已取消内容安装 ${versionId}，清理 ${wiped.files} 个文件`
            : `已取消内容安装 ${versionId}`
        );
        return;
      }
      emit('content-error', { versionId, error: e.message });
      pushLog(`内容安装失败：${e.message}`);
    }
  })();

  return { started: true, versionId, projectType };
}

async function handleFabricInstall(body) {
  const { gameVersion, loaderVersion, instanceName } = body;
  if (!gameVersion) throw new Error('缺少 gameVersion');
  if (state.installing) throw new Error('已有任务在进行');

  state.installing = {
    versionId: instanceName || `fabric-${gameVersion}`,
    stage: 'fabric',
    done: 0,
    total: 0,
  };
  markInstallStart({ versionId: state.installing.versionId, stage: 'fabric' });
  emit('fabric-start', { gameVersion });

  (async () => {
    try {
      const r = await installFabric({
        gameDir: state.gameDir,
        gameVersion,
        loaderVersion,
        versionIdOverride: instanceName,
        source: (await awaitOrCancel(resolveSource(getSettings().downloadSource))).source,
        onStage: ({ stage, message }) => {
          state.installing = { ...state.installing, stage, message };
          emit('fabric-stage', { stage, message });
          pushLog(`[${stage}] ${message}`);
        },
        onProgress: (p) => {
          state.installing = { ...state.installing, ...p };
          emit('fabric-progress', p);
        },
      });
      state.installing = null;
      endJob();
      emit('fabric-done', { result: r });
      pushLog(`Fabric 安装完成：${r.versionId}`);
    } catch (e) {
      const cancelled = e?.cancelled || e instanceof CancelledError;
      let wiped = null;
      if (cancelled) {
        try {
          wiped = await rollbackJob();
        } catch {
          /* 回滚失败不盖住取消 */
        }
      }
      state.installing = null;
      endJob();
      if (cancelled) {
        emit('fabric-cancelled', { message: e.message || '已取消', wiped: wiped ?? undefined });
        pushLog(
          wiped && (wiped.files || wiped.dirs)
            ? `已取消 Fabric 安装，清理 ${wiped.files} 个文件`
            : '已取消 Fabric 安装'
        );
        return;
      }
      emit('fabric-error', { error: e.message });
      pushLog(`Fabric 安装失败：${e.message}`);
    } finally {
      markInstallEnd();
    }
  })();

  return { started: true, gameVersion };
}

async function handleForgeInstall(body, kind) {
  const { gameVersion, loaderVersion, instanceName } = body;
  if (!gameVersion) throw new Error('缺少 gameVersion');
  if (state.installing) throw new Error('已有任务在进行');

  const label = kind === 'forge' ? 'Forge' : 'NeoForge';
  state.installing = {
    versionId: instanceName || `${kind}-${gameVersion}`,
    stage: kind,
    done: 0,
    total: 0,
  };
  markInstallStart({ versionId: state.installing.versionId, stage: kind });
  startJob();
  emit('fabric-start', { gameVersion, loaderLabel: label });

  (async () => {
    try {
      const install = kind === 'forge' ? installForge : installNeoForge;
      const r = await install({
        gameDir: state.gameDir,
        gameVersion,
        loaderVersion,
        versionIdOverride: instanceName,
        source: (await awaitOrCancel(resolveSource(getSettings().downloadSource))).source,
        onStage: ({ stage, message }) => {
          state.installing = { ...state.installing, stage, message };
          emit('fabric-stage', { stage, message, loaderLabel: label });
          pushLog(`[${stage}] ${message}`);
        },
        onProgress: (p) => {
          state.installing = { ...state.installing, ...p };
          emit('fabric-progress', { ...p, loaderLabel: label });
        },
      });
      state.installing = null;
      endJob();
      emit('fabric-done', { result: r, loaderLabel: label });
      pushLog(`${label} 安装完成：${r.versionId}`);
    } catch (e) {
      const cancelled = e?.cancelled || e instanceof CancelledError;
      let wiped = null;
      if (cancelled) {
        try {
          wiped = await rollbackJob();
        } catch {
          /* 回滚失败不盖住取消 */
        }
      }
      state.installing = null;
      endJob();
      if (cancelled) {
        emit('fabric-cancelled', {
          message: e.message || '已取消',
          wiped: wiped ?? undefined,
          loaderLabel: label,
        });
        pushLog(`已取消 ${label} 安装`);
        return;
      }
      emit('fabric-error', { error: e.message, loaderLabel: label });
      pushLog(`${label} 安装失败：${e.message}`);
    } finally {
      markInstallEnd();
    }
  })();

  return { started: true, gameVersion, loader: kind };
}

async function handleModpackInstall(body) {
  const { mrpackUrl, mrpackSha1, instanceName, iconUrl } = body;
  if (!mrpackUrl) throw new Error('缺少 mrpackUrl');
  if (state.installing) throw new Error('已有任务在进行');

  state.installing = { versionId: instanceName || 'modpack', stage: 'modpack', done: 0, total: 0 };
  markInstallStart({ versionId: state.installing.versionId, stage: 'modpack' });
  startJob();
  emit('modpack-start', { mrpackUrl });

  (async () => {
    try {
      const r = await installModpack({
        gameDir: state.gameDir,
        mrpackUrl,
        mrpackSha1,
        instanceName,
        iconUrl,
        source: (await awaitOrCancel(resolveSource(getSettings().downloadSource))).source,
        onStage: ({ stage, message }) => {
          state.installing = { ...state.installing, stage, message };
          emit('modpack-stage', { stage, message });
          pushLog(`[${stage}] ${message}`);
        },
        onProgress: (p) => {
          state.installing = { ...state.installing, ...p };
          emit('modpack-progress', p);
        },
      });
      state.installing = null;
      endJob();
      emit('modpack-done', { result: r });
      pushLog(`整合包安装完成：${r.instanceId}（文件 ${r.files.downloaded} 个）`);
    } catch (e) {
      state.installing = null;
      endJob();
      if (e?.cancelled || e instanceof CancelledError) {
        emit('modpack-cancelled', { message: e.message || '已取消' });
        pushLog('已取消整合包安装');
        return;
      }
      emit('modpack-error', { error: e.message });
      pushLog(`整合包安装失败：${e.message}`);
    } finally {
      markInstallEnd();
    }
  })();

  return { started: true };
}
export async function startServer({ port = 7801, host = '127.0.0.1', gameDir, firstRun = false } = {}) {
  if (gameDir) state.gameDir = gameDir;
  if (firstRun) state.forceFirstRun = true;

  await initSecureStore();
  const interrupted = takeInterruptedInstall();
  if (interrupted) {
    state.installInterrupted = interrupted;
    pushLog(
      `上次安装未正常结束：${interrupted.versionId || '未知实例'}` +
        (interrupted.stage ? `（阶段 ${interrupted.stage}）` : '')
    );
  }

  // 追更轮询：启动时就跑起来，发现新版本通过 SSE 推给界面。
  // 回调里不用 await，避免检查卡住其它请求。
  startTracking({
    onUpdate: (found) => {
      emit('track-update', { found });
      for (const f of found) {
        pushLog(`发现新版本：${f.title} ${f.from ?? '?'} → ${f.to}（${f.releaseType}）`);
      }
    },
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({ port, host, url: `http://${host}:${port}/` });
    });
  });
}

export { server };