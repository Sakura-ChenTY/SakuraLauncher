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
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { candidateUrls, toMirror } from './sources.js';
import { getSettings } from './settings.js';

const agents = {
  'https:': new https.Agent({ keepAlive: true, maxSockets: 256 }),
  'http:': new http.Agent({ keepAlive: true, maxSockets: 256 }),
};

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

let sourceState = null;
let sourceChangeListener = null;

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

/** 以 1MB Range 探测某个源的即时吞吐；不会占用 .part，也不写盘 */
async function probeSource(rawUrl, sourceId) {
  const target = sourceId === 'official' ? rawUrl : toMirror(rawUrl, sourceId);
  if (!target) return null;

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
      return null;
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
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function maybeAutoSwitch() {
  const s = sourceState;
  if (!s || s.switching || s.manualOverride) return;
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
 * 取消语义：取消 = 回滚
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
function requestOnce(url, { timeout = 30000, headers = {}, redirects = 0, deadlineMs = 0, signal: extraSignal = null } = {}) {
  if (isCancelled()) return Promise.reject(new CancelledError());

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`无效 URL: ${url}`));
    }
    const mod = u.protocol === 'http:' ? http : https;

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
        const { statusCode, headers: h } = res;
        if (statusCode >= 300 && statusCode < 400 && h.location) {
          res.resume();
          if (redirects >= 5) return reject(new Error('重定向次数过多'));
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
      else req.destroy(new CancelledError(currentJob?.reason || '已取消'));
    };
    for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => {
      if (deadline) clearTimeout(deadline);
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    });

    req.on('timeout', () => {
      req.destroy(new Error('TIMEOUT'));
    });
    req.on('error', reject);
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
 * 下载单个文件。
 * opts: { sha1, size, retries, timeout, preferMirror, source, gameDir, reuseRoots, onSkip, onDone }
 *   source: 'official' | 'bmclapi' —— 优先源；运行中由 sourceState 自动降级
 *   preferMirror: 旧参数，等价于 source='bmclapi'
 *   reuseRoots: 其他 .minecraft 根目录，按相对路径找同文件后直接复制
 * 返回 'skipped' | 'downloaded'
 */
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
  } = opts;

  await mkdirTracked(path.dirname(destPath));

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

  try {
    while (attempt < retries) {
      // 每轮开头先看有没有被取消，别在取消后还开新连接
      ensureNotCancelled();

      const effectiveSource = sourceState?.active ?? (source === 'bmclapi' ? 'bmclapi' : 'official');
      const urls = candidateUrls(url, { preferMirror, source: effectiveSource });
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
          throw new Error(`HTTP ${res.statusCode}`);
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
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            if (sourceState) {
              sourceState.windowBytes += chunk.length;
              sourceState.lastByteAt = Date.now();
            }
            cb(null, chunk);
          },
        });

        await pipeline(res, meter, out, { signal: ctrl.signal });

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
        if (sourceState) {
          sourceState.consecutiveFailures += 1;
          if (String(e?.message ?? '').includes('TIMEOUT')) sourceState.lastTimeoutAt = Date.now();
        }
        attempt += 1;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
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
  concurrency = 8,
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
  const errors = [];

  async function worker() {
    while (true) {
      // 取消后立刻停止再取新任务：否则 8 个 worker 还会各自再去开新连接
      if (isCancelled()) return;
      const i = index++;
      if (i >= items.length) return;
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
        });
        if (r === 'skipped') skipped++;
        else downloaded++;
      } catch (e) {
        // 取消不算失败条目，否则浮窗上会出现“失败 N 个”的误导计数
        if (e?.cancelled || isCancelled()) return;
        errors.push({ item: it, error: e.message });
      } finally {
        done++;
        if (onProgress) {
          try {
            onProgress({ done, total: items.length, skipped, downloaded, errors: errors.length, current: it });
          } catch {
            /* 进度回调异常不影响下载 */
          }
        }
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, worker));

  // 取消了就不要装成“全部跑完”：上层据此决定是收尾还是报错
  if (isCancelled()) throw new CancelledError();

  return { total: items.length, skipped, downloaded, errors };
}
