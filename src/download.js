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

import { candidateUrls } from './sources.js';

const agents = {
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32 }),
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32 }),
};

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
  currentJob = { ctrl: new AbortController(), reason: '', files: new Set(), dirs: [] };
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

/** 单次 GET，跟随重定向。取消信号来自模块级当前任务，自动生效 */
function requestOnce(url, { timeout = 30000, headers = {}, redirects = 0 } = {}) {
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
          return requestOnce(next, { timeout, headers, redirects: redirects + 1 })
            .then(resolve)
            .catch(reject);
        }
        resolve({ res, url });
      }
    );

    // 取消：把在飞的请求直接掐断，而不是等它下完再看标志位
    const signal = currentJob?.ctrl.signal;
    const onAbort = () => {
      req.destroy(new CancelledError(currentJob?.reason || '已取消'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
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
 * opts: { sha1, size, retries, timeout, preferMirror, source, onSkip, onDone }
 *   source: 'official' | 'bmclapi' —— 主选源；另一个源自动作兜底
 *   preferMirror: 旧参数，等价于 source='bmclapi'
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

  const urls = candidateUrls(url, { preferMirror, source });
  let lastErr = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    // 每轮开头先看有没有被取消，别在取消后还开新连接
    ensureNotCancelled();
    const target = urls[Math.min(attempt, urls.length - 1)];
    const partPath = `${destPath}.part`;

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

      const { res } = await requestOnce(target, { headers, timeout });

      if (res.statusCode === 416) {
        // Range 越界，说明 .part 已经完整或过大，重来
        res.resume();
        await fsp.rm(partPath, { force: true });
        throw new Error('HTTP 416 range not satisfiable');
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode}`);
      }

      const append = res.statusCode === 206 && startAt > 0;
      const out = fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' });

      await new Promise((resolve, reject) => {
        res.pipe(out);
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
      });

      // 校验
      if (sha1) {
        const actual = await sha1File(partPath);
        if (actual.toLowerCase() !== sha1.toLowerCase()) {
          await fsp.rm(partPath, { force: true });
          throw new Error(`SHA1 不匹配（期望 ${sha1.slice(0, 8)}… 实际 ${actual.slice(0, 8)}…）`);
        }
      }

      await fsp.rename(partPath, destPath);
      return 'downloaded';
    } catch (e) {
      // 取消不是「下载出错」，不该进重试，也不该把 .part 删掉
      //（保留才能下次 Range 续传）。直接向上抛，让上层干净收尾。
      if (e?.cancelled || isCancelled()) {
        throw new CancelledError(e?.message || '已取消');
      }
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }

  throw new Error(`下载失败 ${path.basename(destPath)}: ${lastErr?.message ?? '未知错误'}`);
}

/**
 * 并发池：限制同时进行数，收集结果与错误。
 * items: [{ url, dest, sha1, size }]
 * opts: { concurrency, retries, preferMirror, source, onProgress }
 */
export async function downloadMany(items, { concurrency = 8, retries = 3, preferMirror = false, source, onProgress } = {}) {
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
