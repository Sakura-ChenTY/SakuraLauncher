/**
 * 下载源测速与选择
 *
 * 为什么需要它：
 *   不同网络下「官方快」还是「镜像快」完全可能反转，写死任何一方都会坑到人。
 *   所以 auto 模式在安装前实测一次，按真实吞吐挑，而不是按文档猜。
 *
 * ⚠️ 这段逻辑被真实压测推翻过一次，记下来免得再犯：
 *   第一版只拉 3 个小文件、各源串行测，结果两源「打平」（220 vs 217 KB/s）。
 *   但同一台机器上用真实资源索引、16 并发拉 400 个对象：
 *       官方   7.0s / 22.1 MB = 3215 KB/s
 *       BMCLAPI 70.7s / 22.1 MB =  320 KB/s
 *   差 10 倍。原因：镜像的瓶颈在高并发下的限速与排队，
 *   3 个串行请求根本压不到那个瓶颈，测出来的是「延迟」不是「吞吐」。
 *
 * 所以现在的测法：
 *   1. 拉真实资源索引，取一批真实存在的对象（几千个小文件，和安装时一样）
 *   2. 用与安装相同的并发数去打
 *   3. 记录实际落盘字节 / 墙钟时间 = 有效吞吐
 *   4. 同一批对象在两个源上各测一遍，可比性才有保证
 */
import crypto from 'node:crypto';

import { SOURCES, SOURCE_IDS, RESOURCES_BASE, VERSION_MANIFEST_URL } from './sources.js';
import { fetchJson } from './download.js';

/** 测速取样数量：够压出瓶颈，又不至于让「点一下测速」等太久 */
const SAMPLE_COUNT = 60;
const PROBE_CONCURRENCY = 16;
const PROBE_TIMEOUT_MS = 20000;

/** 用哪个版本的资源索引做样本（挑一个装的人多、索引稳定的版本） */
const SAMPLE_VERSION = '1.20.1';

/** 缓存的样本对象，避免每次测速都重新拉索引 */
let sampleCache = null;

/**
 * 取一批真实资源对象作为测速样本。
 * 均匀取样，避免只抽到同一类文件（索引是按名字排序的，连续取样会偏）。
 */
async function getSample({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (sampleCache) return sampleCache;

  const manifest = await fetchJson(VERSION_MANIFEST_URL, { timeout: timeoutMs });
  const entry = (manifest.versions ?? []).find((v) => v.id === SAMPLE_VERSION);
  if (!entry) throw new Error(`测速样本：清单里没有 ${SAMPLE_VERSION}`);

  const vjson = await fetchJson(entry.url, { timeout: timeoutMs });
  const idxUrl = vjson.assetIndex?.url;
  if (!idxUrl) throw new Error('测速样本：该版本没有资源索引');

  const index = await fetchJson(idxUrl, { timeout: 60000 });
  const all = Object.entries(index.objects ?? {}).map(([, v]) => ({ hash: v.hash, size: v.size }));
  if (!all.length) throw new Error('测速样本：资源索引是空的');

  const step = Math.max(1, Math.floor(all.length / SAMPLE_COUNT));
  const picked = [];
  for (let i = 0; i < all.length && picked.length < SAMPLE_COUNT; i += step) picked.push(all[i]);

  sampleCache = picked;
  return picked;
}

/** 某个源拿这个资源对象的 URL */
function objectUrl(sourceId, hash) {
  const official = `${RESOURCES_BASE}/${hash.slice(0, 2)}/${hash}`;
  if (sourceId === 'official') return official;
  const src = SOURCES[sourceId];
  if (!src?.rules?.length) return official;
  for (const [re, prefix] of src.rules) {
    if (re.test(official)) return official.replace(re, prefix);
  }
  return official;
}

/**
 * 在一个源上并发拉一批对象，返回真实吞吐。
 * 只统计成功项；失败项单独计数，不污染吞吐数字。
 */
async function measureOne(sourceId, sample, { concurrency = PROBE_CONCURRENCY, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let idx = 0;
  let ok = 0;
  let fail = 0;
  let bytes = 0;
  let badContent = 0;
  const errors = [];
  const sha1Set = [];

  const t0 = Date.now();

  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= sample.length) return;
      const { hash } = sample[i];
      try {
        const res = await fetch(objectUrl(sourceId, hash), { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          fail++;
          if (errors.length < 3) errors.push(`HTTP ${res.status}`);
          continue;
        }
        const ct = res.headers.get('content-type') ?? '';
        // 镜像偶尔用 HTML 错误页回 200，必须挡掉，否则会被算成"下载成功"
        if (/text\/html/i.test(ct)) {
          badContent++;
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        // 资源对象的内容哈希就是文件名，可以直接验内容有没有被篡改/替换
        const sha = crypto.createHash('sha1').update(buf).digest('hex');
        if (sha !== hash) {
          badContent++;
          continue;
        }
        ok++;
        bytes += buf.length;
        if (sha1Set.length < 8) sha1Set.push(sha);
      } catch (e) {
        fail++;
        if (errors.length < 3) errors.push(e.name === 'TimeoutError' ? '超时' : e.message.slice(0, 40));
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, sample.length));
  await Promise.all(Array.from({ length: n }, worker));

  const ms = Math.max(1, Date.now() - t0);
  return {
    id: sourceId,
    name: SOURCES[sourceId]?.name ?? sourceId,
    ok,
    fail,
    badContent,
    total: sample.length,
    bytes,
    ms,
    kbps: Math.round(bytes / 1024 / (ms / 1000)),
    sha1Set,
    errors,
  };
}

/**
 * 实测所有源，返回按吞吐排序的数组（最快的在前）。
 * 注意：这是「并发吞吐」测试，不是延迟测试 —— 装一个版本要拉几千个文件，
 * 吞吐才决定总时长。
 */
export async function measureSources({ concurrency = PROBE_CONCURRENCY } = {}) {
  const sample = await getSample();

  const results = [];
  for (const id of SOURCE_IDS) {
    results.push(await measureOne(id, sample, { concurrency }));
  }

  // 内容正确性：资源对象是按内容寻址的（哈希即文件名），
  // 所以每拉一个文件时「sha1 === 文件名」就已经证明了内容没被替换。
  // 不需要再跨源比哈希集合 —— 那样比的是不同文件，结论没有意义。
  for (const r of results) {
    r.consistent = r.ok > 0 ? r.badContent === 0 : null;
  }

  // 排序：先看能不能用（有内容校验失败的直接沉底），再比吞吐
  results.sort((a, b) => {
    const aBad = a.badContent > 0 ? 1 : 0;
    const bBad = b.badContent > 0 ? 1 : 0;
    if (aBad !== bBad) return aBad - bBad;
    if (b.ok !== a.ok) return b.ok - a.ok;
    return b.kbps - a.kbps;
  });

  return results;
}

/** 清空测速样本缓存（用户手动点测速后调用） */
export function clearSourceCache() {
  sampleCache = null;
}

/**
 * 决定本次安装的优先源。
 * 不做安装前测速：一开始先走用户选的源，下载过程中由下载引擎
 * 根据真实吞吐自动切换到更快的另一边。
 * setting: 'official' | 'bmclapi'
 */
export async function resolveSource(setting) {
  const source = SOURCE_IDS.includes(setting) ? setting : 'official';
  return {
    source,
    reason: source === 'bmclapi' ? '优先镜像' : '优先官方',
  };
}
