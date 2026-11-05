/**
 * 下载引擎：重试 + 断点续传 + SHA1 校验 + 并发池
 *
 * 三个必须做对的点：
 *   1. 先校验已存在文件的 SHA1，命中就跳过（几千个资源文件全靠这个提速）
 *   2. 断点续传用 .part 文件 + Range 头，服务器回 206 就当续传，回 200 就重写
 *   3. 校验失败要删掉重下，不能留坏文件（否则下次还"存在"但内容是坏的）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { candidateUrls, toMirror } from './sources.js';
import { getSettings } from './settings.js';

const agents = {
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 64 }),
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 64 }),
};

/** 连接池大小跟当前任务并发对齐，避免排队 64 个却只有少量连接。 */
function configureAgents(concurrency) {
  const n = Math.max(1, Math.min(128, Number(concurrency) || 64));
  for (const agent of Object.values(agents)) {
    agent.maxSockets = n;
    agent.maxFreeSockets = n;
  }
}

/** Optional sink for download diagnostics; the server points this at its log. */
let downloadLogger = null;

/** Install a callback for downloader messages such as a source fallback. */
export function setDownloadLogger(fn) {
  downloadLogger = typeof fn === 'function' ? fn : null;
}

function logDownload(message) {
  try {
    if (downloadLogger) downloadLogger(message);
    else console.warn(message);
  } catch {
    /* diagnostics must never break a download */
  }
}

function hostLabel(value) {
  try {
    const u = new URL(value);
    return u.host + u.pathname.replace(/\/[^/]*$/, '/');
  } catch {
    return String(value);
  }
}

/* ---------------- 自动切源 ----------------
 * 速度优先：下载一开始走用户选的优先源，不预测试。
 * 运行中按真实吞吐/超时/失败判断，发现另一边明显更快就中断全部在飞
 * 请求，保留 .part，用 Range 从已下载字节继续。
 *
 * 防抖只做两件事：
 *   - 必须有 1.25x + 128KB/s 的收益才切，避免 0.9/0.95 这种空切
 *   - 最多 4 次、两次间隔 8 秒，避免极端网络下无限抖动
 */
const AUTO_START_DELAY_MS = 1500;
const AUTO_CHECK_MS = 1000;
const AUTO_LOW_KBPS = 256;
const AUTO_MIN_GAIN_KBPS = 128;
const AUTO_GAIN_RATIO = 1.25;
const AUTO_MAX_SWITCHES = 4;
const AUTO_DWELL_MS = 8000;
const AUTO_STALL_MS = 3000;
const PROBE_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 3000;
const STALL_TIMEOUT_MS = 30_000;
const REQUEST_LIMIT = 66;

const requestStats = {
  active: 0,
  peak: 0,
  samples: 0,
  activeSum: 0,
  byHost: {},
  rangedBatches: 0,
  maxSegmentsPerBatch: 0,
  limit429: 0,
  timeouts: 0,
  stalls: 0,
  waiting: 0,
};
const requestQueue = [];

function resetRequestStats() {
  requestStats.active = 0;
  requestStats.peak = 0;
  requestStats.samples = 0;
  requestStats.activeSum = 0;
  requestStats.byHost = {};
  requestStats.rangedBatches = 0;
  requestStats.maxSegmentsPerBatch = 0;
  requestStats.limit429 = 0;
  requestStats.timeouts = 0;
  requestStats.stalls = 0;
  requestStats.waiting = 0;
  requestQueue.length = 0;
}

function hostStats(host) {
  if (!requestStats.byHost[host]) {
    requestStats.byHost[host] = { active: 0, peak: 0, samples: 0, activeSum: 0 };
  }
  return requestStats.byHost[host];
}

async function acquireRequestSlot(host) {
  if (requestStats.active >= REQUEST_LIMIT) {
    requestStats.waiting++;
    await new Promise((resolve) => requestQueue.push({ host, resolve }));
  }
  requestStats.active++;
  const h = hostStats(host || '?');
  h.active++;
  h.peak = Math.max(h.peak, h.active);
  requestStats.peak = Math.max(requestStats.peak, requestStats.active);
}

function releaseRequestSlot(host) {
  requestStats.active = Math.max(0, requestStats.active - 1);
  const h = hostStats(host || '?');
  h.active = Math.max(0, h.active - 1);
  const next = requestQueue.shift();
  if (next) {
    requestStats.waiting = Math.max(0, requestStats.waiting - 1);
    // 交棒给排队者，下一轮由它的 acquire 路径继续计数。
    next.resolve();
  }
}

let requestSampler = null;
function startRequestSampler() {
  if (requestSampler) return;
  requestSampler = setInterval(() => {
    requestStats.samples++;
    requestStats.activeSum += requestStats.active;
    for (const h of Object.values(requestStats.byHost)) {
      h.samples++;
      h.activeSum += h.active;
    }
  }, 200);
  requestSampler.unref?.();
}
function stopRequestSampler() {
  if (requestSampler) clearInterval(requestSampler);
  requestSampler = null;
}

export function getRequestMetrics() {
  const average = requestStats.samples ? +(requestStats.activeSum / requestStats.samples).toFixed(2) : 0;
  const byHost = {};
  for (const [host, h] of Object.entries(requestStats.byHost)) {
    byHost[host] = {
      peak: h.peak,
      average: h.samples ? +(h.activeSum / h.samples).toFixed(2) : 0,
    };
  }
  return {
    limit: REQUEST_LIMIT,
    peak: requestStats.peak,
    average,
    byHost,
    rangedBatches: requestStats.rangedBatches,
    maxSegmentsPerBatch: requestStats.maxSegmentsPerBatch,
    limit429: requestStats.limit429,
    timeouts: requestStats.timeouts,
    stalls: requestStats.stalls,
  };
}

const sourceAffinityPath = path.join(os.homedir(), '.mclauncher', 'source-affinity.json');
let sourceAffinity = {};
try {
  sourceAffinity = JSON.parse(fs.readFileSync(sourceAffinityPath, 'utf8')) || {};
} catch {
  sourceAffinity = {};
}
let saveSourceTimer = null;
function saveSourceAffinity() {
  clearTimeout(saveSourceTimer);
  saveSourceTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(sourceAffinityPath), { recursive: true });
      fs.writeFileSync(sourceAffinityPath, JSON.stringify(sourceAffinity, null, 2));
    } catch {
      /* 源记忆失败不影响下载 */
    }
  }, 300);
}
function sourceKeyFor(url, opts = {}) {
  if (opts.sourceKey) return String(opts.sourceKey);
  if (opts.sha1) return `sha1:${String(opts.sha1).toLowerCase()}`;
  return `url:${String(url)}`;
}
function sourceHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
function sourceMemory(key) {
  if (!sourceAffinity[key]) sourceAffinity[key] = { preferred: null, failures: 0, failedHosts: {}, updatedAt: 0 };
  return sourceAffinity[key];
}
function preferHost(urls, host) {
  if (!host) return urls;
  const hit = urls.find((u) => sourceHost(u) === host);
  return hit ? [hit, ...urls.filter((u) => u !== hit)] : urls;
}
function rememberSourceFailure(key, target) {
  const m = sourceMemory(key);
  const h = sourceHost(target);
  m.failures = (Number(m.failures) || 0) + 1;
  m.failedHosts[h] = (Number(m.failedHosts[h]) || 0) + 1;
  m.updatedAt = Date.now();
  saveSourceAffinity();
}
function rememberSourceSuccess(key, target) {
  const m = sourceMemory(key);
  m.preferred = sourceHost(target);
  m.failures = 0;
  m.failedHosts[m.preferred] = 0;
  m.updatedAt = Date.now();
  saveSourceAffinity();
}

function makeStallGuard(ctrl, label) {
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!ctrl.signal.aborted) ctrl.abort(new Error(`STALL_TIMEOUT:${label}`));
    }, STALL_TIMEOUT_MS);
  };
  arm();
  return {
    reset: arm,
    clear: () => clearTimeout(timer),
  };
}

let sourceState = null;
let sourceChangeListener = null;

// 404 是“这个候选地址不存在”，不是网络抖动：记住后不要再反复撞。
const invalidCandidates = new Set();
const invalidMirrorPrefixes = new Set();
const badDomains = new Set();

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function markDomainBad(target) {
  const host = hostOf(target);
  if (host) badDomains.add(host);
}

function markCandidateInvalid(target) {
  invalidCandidates.add(target);
  markDomainBad(target);
  try {
    const u = new URL(target);
    if (u.hostname === 'mod.mcimirror.top') {
      const first = u.pathname.split('/').filter(Boolean)[0] || '';
      invalidMirrorPrefixes.add(`${u.protocol}//${u.host}/${first ? `${first}/` : ''}`);
    }
  } catch {
    /* 非标准 URL 只按完整地址失效 */
  }
}

function availableCandidates(url, opts) {
  return candidateUrls(url, opts).filter((candidate) => {
    if (invalidCandidates.has(candidate)) return false;
    for (const prefix of invalidMirrorPrefixes) {
      if (candidate.startsWith(prefix)) return false;
    }
    return true;
  });
}

/** 安装页/服务端可以订阅活动源变化 */
export function setSourceChangeListener(fn) {
  sourceChangeListener = typeof fn === 'function' ? fn : null;
}

function notifySourceChanged(reason) {
  if (!sourceChangeListener || !sourceState) return;
  try {
    sourceChangeListener({
      source: sourceState.active,
      preferred: sourceState.preferred,
      reason,
      manualOverride: sourceState.manualOverride,
      switches: sourceState.switches,
    });
  } catch {
    /* 诊断/UI 回调不能影响下载 */
  }
}

function sourceLabel(id) {
  return id === 'bmclapi' ? '镜像' : '官方';
}

function sourceSnapshot() {
  if (!sourceState) return null;
  return {
    source: sourceState.active,
    preferred: sourceState.preferred,
    manualOverride: sourceState.manualOverride,
    switches: sourceState.switches,
    switching: sourceState.switching,
  };
}

export function getSourceSnapshot() {
  return sourceSnapshot();
}

/** 安装开始时设定优先源；startJob 也会按设置自动调用 */
export function setSourcePolicy(preferred) {
  if (!sourceState) return;
  sourceState.preferred = preferred === 'bmclapi' ? 'bmclapi' : 'official';
  sourceState.active = sourceState.preferred;
  sourceState.generation += 1;
  sourceState.manualOverride = false;
  sourceState.autoSwitchUsed = false;
  sourceState.switches = 0;
}

export class SourceSwitchError extends Error {
  constructor(message = '切换下载源') {
    super(message);
    this.name = 'SourceSwitchError';
    this.sourceSwitch = true;
  }
}

function abortActiveTransfers(reason = 'source-switch') {
  if (!sourceState) return;
  for (const t of sourceState.transfers) {
    try {
      t.controller.abort(reason === 'source-switch' ? new SourceSwitchError() : new Error(reason));
    } catch {
      /* 已经结束的 transfer 忽略 */
    }
  }
}

function chooseAlternate() {
  if (!sourceState) return null;
  return sourceState.active === 'official' ? 'bmclapi' : 'official';
}

/** 探测官方的候选地址；edge/media 实际常由 mediafilez 提供，不能只探 edge。 */
function officialProbeUrls(rawUrl) {
  const urls = [rawUrl];
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'edge.forgecdn.net' || u.hostname === 'media.forgecdn.net') {
      u.hostname = 'mediafilez.forgecdn.net';
      urls.push(u.toString());
    }
  } catch {
    /* 非标准 URL 只探原地址 */
  }
  return [...new Set(urls)];
}

/** 以 1MB Range 探测某个源的即时吞吐；不会占用 .part，也不写盘 */
async function probeSource(rawUrl, sourceId) {
  const targets = sourceId === 'official'
    ? officialProbeUrls(rawUrl)
    : [toMirror(rawUrl, sourceId)].filter(Boolean);
  if (!targets.length) return null;

  for (const target of targets) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('PROBE_TIMEOUT')), PROBE_TIMEOUT_MS);
    const started = Date.now();
    let bytes = 0;
    try {
      const { res } = await requestOnce(target, {
        timeout: PROBE_TIMEOUT_MS,
        headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
        signal: ctrl.signal,
      });
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        continue;
      }
      for await (const chunk of res) {
        bytes += chunk.length;
        if (bytes >= PROBE_BYTES) {
          res.destroy();
          break;
        }
      }
      const ms = Math.max(1, Date.now() - started);
      return { source: sourceId, bytes, ms, kbps: Math.round(bytes / 1024 / (ms / 1000)) };
    } catch {
      /* 这个候选探测失败，继续试官方回退地址 */
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }
  return null;
}

async function maybeAutoSwitch() {
  const s = sourceState;
  if (!s || sourceState !== s || s.switching || s.manualOverride) return;
  if (s.switches >= AUTO_MAX_SWITCHES) return;
  if (!s.transfers.size) return;
  if (Date.now() - s.startedAt < AUTO_START_DELAY_MS) return;
  if (Date.now() - s.lastSwitchAt < AUTO_DWELL_MS) return;
  if (Date.now() - s.lastProbeAt < 1500) return;

  const elapsed = Math.max(1, Date.now() - s.windowStart);
  const kbps = Math.round(s.windowBytes / 1024 / (elapsed / 1000));
  const stalled = Date.now() - s.lastByteAt > AUTO_STALL_MS;
  const failed = s.consecutiveFailures >= 2;
  const timedOut = !!s.lastTimeoutAt && Date.now() - s.lastTimeoutAt < AUTO_CHECK_MS * 2;
  if (!stalled && !failed && !timedOut && kbps >= AUTO_LOW_KBPS) {
    s.windowStart = Date.now();
    s.windowBytes = 0;
    return;
  }

  const sample = s.transfers.values().next().value;
  if (!sample?.url) return;
  const alt = chooseAlternate();
  if (!alt) return;

  s.lastProbeAt = Date.now();
  const beforeSource = s.active;
  const beforeGeneration = s.generation;
  const probe = await probeSource(sample.url, alt);
  // 探测期间任务可能已经结束并开始了下一单；旧任务的结果绝不能作用到新任务。
  if (sourceState !== s) return;
  // 探测期间可能被用户手动切源了；手动优先，丢弃这次自动判断。
  if (s.manualOverride || s.active !== beforeSource || s.generation !== beforeGeneration) return;
  if (!probe || probe.kbps <= 0) {
    logDownload(`[自动切源] ${sourceLabel(alt)} 探测失败，继续用 ${sourceLabel(s.active)}`);
    return;
  }
  const gain = probe.kbps - kbps;
  if (probe.kbps < kbps * AUTO_GAIN_RATIO || gain < AUTO_MIN_GAIN_KBPS) {
    logDownload(
      `[自动切源] ${sourceLabel(alt)} 探测 ${probe.kbps} KB/s，较当前 ${kbps} KB/s 收益不足，不切换`
    );
    return;
  }

  s.switching = true;
  try {
    logDownload(
      `[自动切源] 当前 ${sourceLabel(s.active)} ${kbps} KB/s，${sourceLabel(alt)} ${probe.kbps} KB/s，切换`
    );
    s.active = alt;
    s.generation += 1;
    s.switches += 1;
    s.autoSwitchUsed = true;
    s.lastSwitchAt = Date.now();
    s.windowStart = Date.now();
    s.windowBytes = 0;
    s.lastTimeoutAt = 0;
    s.consecutiveFailures = 0;
    s.lastByteAt = Date.now();
    abortActiveTransfers('source-switch');
    logDownload(`[自动切源] 已切到 ${sourceLabel(alt)}，${s.transfers.size} 个活动下载重新 Range 续传`);
    notifySourceChanged('auto');
  } finally {
    s.switching = false;
  }
}

function startSourceMonitor() {
  if (!sourceState || sourceState.monitor) return;
  sourceState.monitor = setInterval(() => {
    maybeAutoSwitch().catch((e) => logDownload(`[自动切源] 判断失败：${e.message}`));
  }, AUTO_CHECK_MS);
  sourceState.monitor.unref?.();
}

function stopSourceMonitor() {
  if (sourceState?.monitor) clearInterval(sourceState.monitor);
  if (sourceState) sourceState.monitor = null;
}

/** 手动切源：立即中断正在下载的文件，保留 .part 用新源续传 */
export function manualSwitchSource(source) {
  if (!sourceState) return null;
  if (source !== 'official' && source !== 'bmclapi') throw new Error('下载源只能是 official 或 bmclapi');
  if (source === sourceState.active) return sourceSnapshot();

  sourceState.manualOverride = true;
  sourceState.autoSwitchUsed = true;
  sourceState.active = source;
  sourceState.generation += 1;
  sourceState.lastSwitchAt = Date.now();
  sourceState.windowStart = Date.now();
  sourceState.windowBytes = 0;
  sourceState.lastTimeoutAt = 0;
  sourceState.consecutiveFailures = 0;
  abortActiveTransfers('source-switch');
  logDownload(
    `[手动切源] 已切到 ${sourceLabel(source)}，${sourceState.transfers.size} 个活动下载重新 Range 续传`
  );
  notifySourceChanged('manual');
  return sourceSnapshot();
}

/* ---------------- 取消 ----------------
 * 为什么用模块级单例而不是层层传 signal：
 *   服务端本来就只允许一个安装任务（`if (state.installing) throw`），
 *   没有并发场景。用模块级「当前任务」能让所有下载点自动获得取消能力，
 *   不用改 installer/fabric/modpack 等每个函数的签名。
 * 取消语义（对齐 PCL）：取消 = 回滚
 *   取消后把本次任务写下的文件、.part 残留、本次新建的目录全部清掉，
 *   回到「任务开始前」的状态，不留半成品。
 *   只删「本次真的写过」的文件 —— 已存在而被跳过的一律不动，
 *   否则会误伤别的实例共用的 libraries/assets。 */
export class CancelledError extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

let currentJob = null; // { ctrl, reason, files:Set, dirs:[] }

/** 开一个新任务，返回前一个若存在则先收尾 */
export function startJob() {
  endJob();
  resetRequestStats();
  startRequestSampler();
  const preferred = getSettings().downloadSource === 'bmclapi' ? 'bmclapi' : 'official';
  sourceState = {
    preferred,
    active: preferred,
    generation: 0,
    manualOverride: false,
    autoSwitchUsed: false,
    switches: 0,
    startedAt: Date.now(),
    lastSwitchAt: 0,
    windowStart: Date.now(),
    windowBytes: 0,
    lastByteAt: Date.now(),
    lastTimeoutAt: 0,
    consecutiveFailures: 0,
    transfers: new Set(),
    destinations: new Set(),
    switching: false,
    monitor: null,
  };
  currentJob = { ctrl: new AbortController(), reason: '', files: new Set(), dirs: [] };
  configureAgents(getSettings().concurrency);
  startSourceMonitor();
  notifySourceChanged('start');
  return currentJob.ctrl.signal;
}

/** 记录本次任务写下的文件（用于取消时回滚） */
export function trackFile(filePath) {
  if (currentJob) currentJob.files.add(path.resolve(filePath));
}

/** 记录本次任务新建的目录（由 mkdirTracked 调用） */
function trackDir(dirPath) {
  if (currentJob) currentJob.dirs.push(path.resolve(dirPath));
}

/**
 * 建目录，并记住「本次新建」的那些。
 * 回滚时只删自己建的，别人的目录一格都不碰。
 */
async function mkdirTracked(dir) {
  const abs = path.resolve(dir);
  // 先攒出需要新建的层级（从最外层开始）
  const missing = [];
  let cur = abs;
  while (!fs.existsSync(cur)) {
    missing.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  await fsp.mkdir(abs, { recursive: true });
  for (const d of missing) trackDir(d);
}

/** 供其他模块建目录时复用（同样会登记本任务新建的层级） */
export { mkdirTracked };

export function endJob() {
  stopRequestSampler();
  stopSourceMonitor();
  if (sourceState) {
    abortActiveTransfers('job-end');
    sourceState.transfers.clear();
    sourceState.destinations.clear();
  }
  sourceState = null;
  currentJob = null;
}

/**
 * 取消后的回滚：删掉本次写过的文件、残留 .part、以及本次新建的空目录。
 * 返回 { files, dirs } 便于日志说清到底清了多少。
 *
 * 注意顺序：先删文件再删目录，且目录只在空了才删 ——
 * 万一里面有别的实例的东西，宁可留着也不能删。
 */
export async function rollbackJob() {
  const job = currentJob;
  const removed = { files: 0, dirs: 0 };
  if (!job) return removed;

  for (const f of job.files) {
    for (const p of [f, `${f}.part`]) {
      try {
        if (fs.existsSync(p)) {
          await fsp.rm(p, { force: true });
          removed.files++;
        }
      } catch {
        /* 单个删不掉（占用/权限）就跳过，不中断回滚 */
      }
    }
  }

  // 深的先删，父目录才可能变空
  const dirs = [...job.dirs].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d)) continue;
      const left = await fsp.readdir(d);
      if (left.length === 0) {
        await fsp.rmdir(d);
        removed.dirs++;
      }
    } catch {
      /* 非空 / 占用的留着 */
    }
  }

  return removed;
}

export function isCancelled() {
  return !!currentJob?.ctrl.signal.aborted;
}

/** 抛已取消 —— 供各层在进入下一阶段前自查 */
export function ensureNotCancelled() {
  if (isCancelled()) throw new CancelledError(currentJob?.reason || '已取消');
}

/** 用户点取消。返回是否真的取消了一个在跑的任务 */
export function cancelJob(reason = '用户取消') {
  if (!currentJob || currentJob.ctrl.signal.aborted) return false;
  currentJob.reason = reason;
  currentJob.ctrl.abort(reason);
  return true;
}

/** 单次 GET，跟随重定向。全局取消和单个 transfer 的切源中断都能生效 */
async function requestOnce(url, { timeout = 30000, headers = {}, redirects = 0, deadlineMs = 0, signal: extraSignal = null } = {}) {
  if (isCancelled()) throw new CancelledError();

  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`无效 URL: ${url}`);
  }
  const host = u.hostname;
  await acquireRequestSlot(host);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseRequestSlot(host);
  };

  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'http:' ? http : https;
    let hasResponse = false;

    const req = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'mclauncher/0.1', ...headers },
        agent: agents[u.protocol],
        timeout,
      },
      (res) => {
        hasResponse = true;
        const { statusCode, headers: h } = res;
        res.once('close', release);
        res.once('end', release);
        if (statusCode === 429) requestStats.limit429++;
        if (statusCode >= 300 && statusCode < 400 && h.location) {
          res.resume();
          if (redirects >= 5) { release(); reject(new Error('重定向次数过多')); return; }
          const next = new URL(h.location, url).toString();
          return requestOnce(next, { timeout, headers, redirects: redirects + 1, deadlineMs, signal: extraSignal })
            .then(resolve)
            .catch(reject);
        }
        resolve({ res, url });
      }
    );

    // 可选总时限：防止某个源虽然不断流但持续拖慢整个阶段
    const deadline = deadlineMs > 0
      ? setTimeout(() => req.destroy(new Error('下载超过总时限')), deadlineMs)
      : null;

    // 取消：把在飞的请求直接掐断，而不是等它下完再看标志位。
    // extraSignal 是单个 transfer 的切源中断，不能和全局取消混用。
    const signals = [currentJob?.ctrl.signal, extraSignal].filter(Boolean);
    const onAbort = (event) => {
      const reason = event?.target?.reason;
      if (reason instanceof SourceSwitchError) req.destroy(reason);
      else if (String(reason?.message || '').startsWith('STALL_TIMEOUT')) req.destroy(reason);
      else req.destroy(new CancelledError(currentJob?.reason || '已取消'));
    };
    for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => {
      if (deadline) clearTimeout(deadline);
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    });

    req.on('timeout', () => {
      requestStats.timeouts++;
      req.destroy(new Error('TIMEOUT'));
    });
    req.on('error', (e) => { release(); reject(e); });
    req.on('close', () => { if (!hasResponse) release(); });
    req.end();
  });
}

/** 取整个响应体到内存（只用于 json 之类小文件） */
export async function fetchText(url, opts = {}) {
  const { res } = await requestOnce(url, opts);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} ${url}`);
  }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchJson(url, opts = {}) {
  return JSON.parse(await fetchText(url, opts));
}

/** 计算文件 SHA1 */
export async function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** 已存在且校验通过？ */
async function isComplete(filePath, expectedSha1, expectedSize) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return false;
    if (expectedSize != null && st.size !== expectedSize) return false;
    if (expectedSha1) {
      const actual = await sha1File(filePath);
      return actual.toLowerCase() === expectedSha1.toLowerCase();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 大文件分段下载：4 个 Range 请求并行写入临时段，最后合并。
 * 只在全新文件、已知大小 > 8MB 时尝试；服务器不支持 Range 时返回 false，
 * 调用方退回原来的单流路径。
 */
async function downloadRanged(url, destPath, size, sha1, source, sourceKey) {
  const effectiveSource = sourceState?.active ?? (source === 'bmclapi' ? 'bmclapi' : 'official');
  const sourceMem = sourceKey ? sourceMemory(sourceKey) : null;
  const target = preferHost(
    availableCandidates(url, { source: effectiveSource }),
    sourceMem?.preferred
  )[0];
  if (!target) return false;
  const partPath = `${destPath}.part`;
  let completed = false;
  const segs = [];
  const count = 8;
  const chunk = Math.ceil(size / count);
  for (let i = 0; i < count; i++) {
    const start = i * chunk;
    const end = Math.min(size - 1, start + chunk - 1);
    if (start <= end) segs.push({ start, end, path: `${partPath}.${i}` });
  }
  requestStats.rangedBatches++;
  requestStats.maxSegmentsPerBatch = Math.max(requestStats.maxSegmentsPerBatch, segs.length);
  const ctrl = new AbortController();
  const transfer = {
    controller: ctrl,
    url,
    dest: path.resolve(destPath),
    source: effectiveSource,
    generation: sourceState?.generation ?? 0,
  };
  sourceState?.transfers.add(transfer);
  let rangeTimer = null;
  let rangeReject = null;
  const resetRangeTimer = () => {
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(() => {
      const e = new Error('STALL_TIMEOUT:range');
      ctrl.abort(e);
      rangeReject?.(e);
    }, STALL_TIMEOUT_MS);
  };
  const rangeTimeout = new Promise((_, reject) => { rangeReject = reject; });
  try {
    resetRangeTimer();
    const rangeWork = Promise.all(segs.map(async (seg) => {
      const { res } = await requestOnce(target, {
        headers: { Range: `bytes=${seg.start}-${seg.end}` },
        timeout: 90000,
        signal: ctrl.signal,
      });
      if (res.statusCode !== 206) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode}（不支持 Range）`);
      }
      const contentRange = String(res.headers['content-range'] ?? '');
      const m = /^bytes\s+(\d+)-/i.exec(contentRange);
      if (!m || Number(m[1]) !== seg.start) {
        res.resume();
        throw new Error(`Range 起点不匹配（期望 ${seg.start}）`);
      }
      const out = fs.createWriteStream(seg.path, { flags: 'w' });
      const stall = makeStallGuard(ctrl, `${target}#${seg.start}`);
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          if (sourceState) {
            sourceState.windowBytes += chunk.length;
            sourceState.lastByteAt = Date.now();
          }
          stall.reset();
          resetRangeTimer();
          cb(null, chunk);
        },
      });
      try {
        await pipeline(res, meter, out, { signal: ctrl.signal });
      } finally {
        stall.clear();
      }
    }));
    await Promise.race([rangeWork, rangeTimeout]);

    const out = fs.createWriteStream(partPath, { flags: 'w' });
    try {
      for (const seg of segs) {
        for await (const chunk of fs.createReadStream(seg.path)) {
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        }
      }
    } finally {
      out.end();
      await new Promise((resolve, reject) => {
        out.once('finish', resolve);
        out.once('error', reject);
      });
    }
    if (sha1) {
      const actual = await sha1File(partPath);
      if (actual.toLowerCase() !== sha1.toLowerCase()) {
        throw new Error(`SHA1 不匹配（期望 ${sha1.slice(0, 8)}… 实际 ${actual.slice(0, 8)}…）`);
      }
    }
    await fsp.rename(partPath, destPath);
    completed = true;
    if (sourceKey) rememberSourceSuccess(sourceKey, target);
    return true;
  } catch (e) {
    if (e?.sourceSwitch || ctrl.signal.reason instanceof SourceSwitchError) {
      throw new SourceSwitchError();
    }
    if (sourceKey) rememberSourceFailure(sourceKey, target);
    try { ctrl.abort(); } catch { /* ignore */ }
    return false;
  } finally {
    clearTimeout(rangeTimer);
    sourceState?.transfers.delete(transfer);
    for (const seg of segs) {
      try { await fsp.rm(seg.path, { force: true }); } catch { /* ignore */ }
    }
    if (!completed) {
      try { await fsp.rm(partPath, { force: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * 下载单个文件。
 * opts: { sha1, size, retries, timeout, preferMirror, source, gameDir, reuseRoots, onSkip, onDone }
 *   source: 'official' | 'bmclapi' —— 优先源；运行中由 sourceState 自动降级
 *   preferMirror: 旧参数，等价于 source='bmclapi'
 *   reuseRoots: 其他 .minecraft 根目录，按相对路径找同文件后直接复制
 * 返回 'skipped' | 'downloaded'
 */
async function probeFileCandidates(url, opts, key) {
  const m = sourceMemory(key);
  if ((Number(m.failures) || 0) < 2) return null;
  if (Date.now() - Number(m.lastProbeAt || 0) < 60_000) return m.preferred || null;
  m.lastProbeAt = Date.now();
  const list = availableCandidates(url, opts);
  const results = [];
  await Promise.all(list.map(async (target) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('PROBE_TIMEOUT')), 3000);
    const started = Date.now();
    let bytes = 0;
    try {
      const { res } = await requestOnce(target, {
        timeout: 3000,
        headers: { Range: 'bytes=0-1023' },
        signal: ctrl.signal,
      });
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return;
      }
      for await (const chunk of res) {
        bytes += chunk.length;
        if (bytes >= 1024) {
          res.destroy();
          break;
        }
      }
      if (bytes > 0) results.push({ target, ms: Math.max(1, Date.now() - started) });
    } catch {
      /* 探测失败不阻塞下载 */
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }));
  if (!results.length) return null;
  results.sort((a, b) => a.ms - b.ms);
  m.preferred = sourceHost(results[0].target);
  m.updatedAt = Date.now();
  saveSourceAffinity();
  logDownload(`[源探测] ${path.basename(key)} 选中 ${m.preferred}（${results[0].ms}ms）`);
  return m.preferred;
}

export async function downloadFile(url, destPath, opts = {}) {
  const {
    sha1,
    size,
    retries = 3,
    timeout = 60000,
    preferMirror = false,
    source,
    gameDir,
    reuseRoots = [],
    onThrottle,
    ranged = true,
    sourceKey: explicitSourceKey,
  } = opts;

  await mkdirTracked(path.dirname(destPath));
  const sourceKey = sourceKeyFor(url, { ...opts, sourceKey: explicitSourceKey });
  const sourceMem = sourceMemory(sourceKey);
  let preferredHost = sourceMem.preferred;
  if (Number(sourceMem.failures) >= 2) {
    preferredHost = (await probeFileCandidates(url, { preferMirror, source }, sourceKey)) || preferredHost;
  }

  // 已存在且校验通过 -> 直接跳过，**不能登记**：
  // 它是别的任务/别的实例早先装好的，取消时去删它就是把好文件删了。
  if (await isComplete(destPath, sha1, size)) return 'skipped';

  // 从现在起，这个目标（含它的 .part）算「本次写下」的东西。
  // 必须在开下载之前登记：否则取消时还没 rename，destPath 没被记上，
  // 半截 .part 就留在磁盘上了 —— 正是要避免的那种「残留」。
  trackFile(destPath);

  // 已有但校验不过 -> 删掉重下
  if (fs.existsSync(destPath)) {
    await fsp.rm(destPath, { force: true });
  }

  // 跨 .minecraft 复用：相对路径一致，且大小/SHA1 都对得上才复制。
  // 这是冷装之外最划算的一步：已有对象不发网络请求。
  if (gameDir && reuseRoots.length) {
    const rel = path.relative(path.resolve(gameDir), path.resolve(destPath));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      for (const root of reuseRoots) {
        const candidate = path.join(root, rel);
        if (path.resolve(candidate) === path.resolve(destPath)) continue;
        if (!(await isComplete(candidate, sha1, size))) continue;
        await fsp.mkdir(path.dirname(destPath), { recursive: true });
        await fsp.copyFile(candidate, destPath);
        trackFile(destPath);
        return 'skipped';
      }
    }
  }

  const destKey = path.resolve(destPath);
  if (sourceState?.destinations.has(destKey)) {
    throw new Error(`重复的下载目标：${destPath}`);
  }
  sourceState?.destinations.add(destKey);

  let lastErr = null;
  let previousTarget = null;
  let attempt = 0;
  let domainRetryUsed = false;

  try {
    while (attempt < retries) {
      // 每轮开头先看有没有被取消，别在取消后还开新连接
      ensureNotCancelled();

      const effectiveSource = sourceState?.active ?? (source === 'bmclapi' ? 'bmclapi' : 'official');
      let urls = preferHost(availableCandidates(url, { preferMirror, source: effectiveSource }), preferredHost);
      if (!urls.length && badDomains.size && !domainRetryUsed) {
        // 域名负缓存不能把整个候选集永久锁死；清零后给一次重试机会。
        badDomains.clear();
        domainRetryUsed = true;
        logDownload(`[域名负缓存] 候选全部被跳过，清零重试一次：${path.basename(destPath)}`);
        urls = availableCandidates(url, { preferMirror, source: effectiveSource });
      }
      if (!urls.length) throw new Error(`没有可用的下载候选：${path.basename(destPath)}`);
      const target = urls[Math.min(attempt, urls.length - 1)];
      if (attempt > 0 && target !== previousTarget) {
        logDownload(
          `[下载降级] ${hostLabel(previousTarget)} 请求失败，改用备用源 ${hostLabel(target)}；` +
          `原因：${lastErr?.message ?? '未知错误'}`
        );
      }
      previousTarget = target;

      const partPath = `${destPath}.part`;
      const ctrl = new AbortController();
      const transfer = {
        controller: ctrl,
        url,
        dest: destKey,
        source: effectiveSource,
        generation: sourceState?.generation ?? 0,
      };
      sourceState?.transfers.add(transfer);

      try {
        let startAt = 0;
        try {
          const st = await fsp.stat(partPath);
          startAt = st.size;
        } catch {
          startAt = 0;
        }

        const headers = {};
        if (startAt > 0) headers.Range = `bytes=${startAt}-`;

        // 全新大文件先尝试 4 段 Range；镜像/服务器不支持时自动回退单流。
        if (ranged && startAt === 0 && Number(size) > 8 * 1024 * 1024) {
          try {
            if (await downloadRanged(url, destPath, Number(size), sha1, effectiveSource, sourceKey)) {
              return 'downloaded';
            }
          } catch (e) {
            if (e?.sourceSwitch || e instanceof SourceSwitchError) throw e;
          }
        }

        const { res } = await requestOnce(target, {
          headers,
          timeout,
          signal: ctrl.signal,
        });

        if (res.statusCode === 416) {
          // Range 越界：.part 已经完整或过大。交给下一轮从头校验。
          res.resume();
          await fsp.rm(partPath, { force: true });
          throw new Error('HTTP 416 range not satisfiable');
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          throw err;
        }

        // 旧源在响应途中被切走：不要写盘，直接让 worker 用新源重来。
        if (sourceState && sourceState.generation !== transfer.generation) {
          res.resume();
          throw new SourceSwitchError();
        }

        let append = false;
        if (res.statusCode === 206 && startAt > 0) {
          const contentRange = String(res.headers['content-range'] ?? '');
          const m = /^bytes\s+(\d+)-/i.exec(contentRange);
          if (!m || Number(m[1]) !== startAt) {
            res.resume();
            await fsp.rm(partPath, { force: true });
            throw new Error(`Range 起点不匹配（期望 ${startAt}，收到 ${m?.[1] ?? '无'}）`);
          }
          append = true;
        } else if (res.statusCode === 200 && startAt > 0) {
          // 新源不支持 Range：覆盖同一个 .part，绝不能追加。
          append = false;
        }

        const out = fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' });
        const stall = makeStallGuard(ctrl, target);
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            if (sourceState) {
              sourceState.windowBytes += chunk.length;
              sourceState.lastByteAt = Date.now();
            }
            stall.reset();
            cb(null, chunk);
          },
        });

        try {
          await pipeline(res, meter, out, { signal: ctrl.signal });
        } finally {
          stall.clear();
        }

        // 校验
        if (sha1) {
          const actual = await sha1File(partPath);
          if (actual.toLowerCase() !== sha1.toLowerCase()) {
            await fsp.rm(partPath, { force: true });
            throw new Error(`SHA1 不匹配（期望 ${sha1.slice(0, 8)}… 实际 ${actual.slice(0, 8)}…）`);
          }
        }

        await fsp.rename(partPath, destPath);
        if (sourceState) sourceState.consecutiveFailures = 0;
        rememberSourceSuccess(sourceKey, target);
        preferredHost = sourceHost(target);
        return 'downloaded';
      } catch (e) {
        // 取消不是「下载出错」，不该进重试，也不该把 .part 删掉
        //（保留才能下次 Range 续传）。直接向上抛，让上层干净收尾。
        if (e?.cancelled || isCancelled()) {
          throw new CancelledError(e?.message || '已取消');
        }

        const switched = e?.sourceSwitch || ctrl.signal.reason instanceof SourceSwitchError;
        if (switched) {
          // 切源中断不计失败、不增加 attempt；回到新源的主选，接着 Range。
          attempt = 0;
          previousTarget = null;
          if (sourceState) sourceState.lastByteAt = Date.now();
          continue;
        }

        lastErr = e;
        rememberSourceFailure(sourceKey, target);
        const stalled = String(e?.message ?? '').includes('STALL_TIMEOUT');
        if (stalled) {
          requestStats.stalls++;
          if (sourceState) sourceState.lastTimeoutAt = Date.now();
          markDomainBad(target);
          logDownload(`[下载停滞] ${hostLabel(target)} 30 秒无字节增长，断开并换候选`);
        } else if (/aborted|ECONNRESET|socket hang up/i.test(String(e?.message ?? ''))) {
          markDomainBad(target);
          logDownload(`[域名负缓存] ${hostLabel(target)} 本轮出现 aborted/ECONNRESET，后续跳过`);
        }
        const status = Number(e?.statusCode || /^HTTP\s+(\d{3})\b/i.exec(String(e?.message ?? ''))?.[1] || 0);
        // 404 不是可重试错误：标记候选（镜像按前缀）并立刻换下一个候选。
        if (status === 404) {
          markCandidateInvalid(target);
          logDownload(`[下载候选失效] 404 ${target}，换下一个候选`);
          attempt = 0;
          previousTarget = null;
          await new Promise((r) => setTimeout(r, 80));
          continue;
        }
        const retryable = status === 429 || status >= 500;
        if (retryable) {
          try { onThrottle?.(); } catch { /* 降低并发失败不影响重试 */ }
        }
        if (sourceState) {
          sourceState.consecutiveFailures += 1;
          if (String(e?.message ?? '').includes('TIMEOUT')) sourceState.lastTimeoutAt = Date.now();
        }
        attempt += 1;
        // 429/5xx 指数退避；普通网络错误只做短退避。
        const backoff = retryable
          ? Math.min(30_000, 500 * 2 ** Math.min(6, attempt))
          : 300 * (attempt + 1);
        await new Promise((r) => setTimeout(r, backoff + Math.floor(Math.random() * 200)));
      } finally {
        sourceState?.transfers.delete(transfer);
      }
    }
  } finally {
    sourceState?.destinations.delete(destKey);
  }

  throw new Error(`下载失败 ${path.basename(destPath)}: ${lastErr?.message ?? '未知错误'}`);
}

/**
 * 并发池：限制同时进行数，收集结果与错误。
 * items: [{ url, dest, sha1, size }]
 * opts: { concurrency, retries, preferMirror, source, gameDir, reuseRoots, onProgress }
 */
export async function downloadMany(items, {
  concurrency = 64,
  retries = 3,
  preferMirror = false,
  source,
  gameDir,
  reuseRoots = [],
  onProgress,
} = {}) {
  let index = 0;
  let done = 0;
  let skipped = 0;
  let downloaded = 0;
  let doneBytes = 0;
  const totalBytes = items.reduce((n, it) => n + (Number(it.size) || 0), 0);
  const errors = [];
  const n = Math.max(1, Math.min(128, Math.max(1, Number(concurrency) || 64), items.length));
  configureAgents(n);
  // 域名负缓存只作用于当前这一轮；下一轮再给这些域名一次机会。
  badDomains.clear();

  // 只创建 n 个 worker，按 index 排队取任务；不会给 4000 个文件各建一个 Promise。
  // activeLimit 遇到 429/5xx 会下调，已开始的请求继续，后续排队请求等水位。
  let active = 0;
  let activeLimit = n;
  const waiters = [];
  const acquire = () => new Promise((resolve) => {
    if (active < activeLimit) {
      active++;
      resolve();
    } else {
      waiters.push(resolve);
    }
  });
  const release = () => {
    active--;
    while (waiters.length && active < activeLimit) {
      active++;
      waiters.shift()();
    }
  };
  const reduceConcurrency = () => {
    activeLimit = Math.max(4, Math.floor(activeLimit * 0.7));
    while (waiters.length && active < activeLimit) {
      active++;
      waiters.shift()();
    }
  };

  async function worker() {
    while (true) {
      if (isCancelled()) return;
      const i = index++;
      if (i >= items.length) return;
      await acquire();
      if (isCancelled()) { release(); return; }
      const it = items[i];
      try {
        const r = await downloadFile(it.url, it.dest, {
          sha1: it.sha1,
          size: it.size,
          retries,
          preferMirror: it.preferMirror ?? preferMirror,
          source: it.source ?? source,
          gameDir,
          reuseRoots,
          onThrottle: reduceConcurrency,
        });
        if (r === 'skipped') skipped++;
        else downloaded++;
      } catch (e) {
        // 取消不算失败条目，否则浮窗上会出现“失败 N 个”的误导计数
        if (e?.cancelled || isCancelled()) return;
        if (e?.statusCode === 429 || Number(e?.statusCode) >= 500) reduceConcurrency();
        errors.push({ item: it, error: e.message });
      } finally {
        release();
        done++;
        doneBytes += Number(it.size) || 0;
        if (onProgress) {
          try {
            onProgress({
              done, total: items.length, skipped, downloaded, errors: errors.length, current: it,
              bytes: doneBytes, totalBytes,
            });
          } catch {
            /* 进度回调异常不影响下载 */
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: n }, worker));

  // 取消了就不要装成“全部跑完”：上层据此决定是收尾还是报错
  if (isCancelled()) throw new CancelledError();

  badDomains.clear();
  return { total: items.length, skipped, downloaded, errors };
}
