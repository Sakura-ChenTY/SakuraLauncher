/**
 * 最小 ZIP 解包器（仅用 Node 内置 zlib，无第三方依赖）
 *
 * 为什么自己写：natives 需要从 jar 里抽 .dll/.so 到临时目录。
 * 引入 archiver/adm-zip 只为这点功能不值当，而且原生实现可控。
 *
 * 只做启动器真正需要的两件事：列出条目、按 entry 解出内容。
 * 走中央目录解析，比顺着 local header 扫更可靠（能处理 data descriptor）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;

/** 在 buffer 中从尾部往前找 EOCD 签名 */
function findEocd(buf) {
  const maxBack = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/** 解析 zip，返回 { entries: [{ name, method, compSize, uncompSize, localOffset }] } */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];

  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) break;
    if (buf.readUInt32LE(p) !== SIG_CEN) break;

    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** 取出某个条目的原始内容（已解压） */
export function readEntry(buf, entry) {
  const lh = entry.localOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) {
    throw new Error(`条目 ${entry.name} 的 local header 无效`);
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${entry.method}（${entry.name}）`);
}

/**
 * 把 jar 里的原生库解到目标目录。
 * opts:
 *   exts    —— 要解出的扩展名
 *   flatten —— true 时只保留文件名，不保留 jar 内的嵌套路径
 *
 * 为什么需要 flatten：新版本（如 26.3）的原生 jar 内部是
 *   windows/x64/org/lwjgl/lwjgl.dll
 * 这种嵌套结构，而 JVM 的 java.library.path 不递归搜索，
 * 所以必须拍平成 lwjgl.dll 才能被找到。
 */
export function extractNatives(jarPath, outDir, exts = ['.dll', '.so', '.dylib'], opts = {}) {
  const { flatten = false } = opts;
  const buf = fs.readFileSync(jarPath);
  const entries = listEntries(buf);
  fs.mkdirSync(outDir, { recursive: true });

  const written = [];
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const lower = e.name.toLowerCase();
    if (!exts.some((x) => lower.endsWith(x))) continue;

    const data = readEntry(buf, e);
    const rel = flatten ? e.name.split('/').pop() : e.name;
    if (!rel) continue;
    const target = `${outDir}/${rel}`;
    const parent = target.slice(0, target.lastIndexOf('/'));
    if (parent) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(target, data);
    written.push(rel);
  }
  return written;
}

/** 仅列出 jar 内条目名（诊断用） */
export function listJar(jarPath) {
  return listEntries(fs.readFileSync(jarPath)).map((e) => e.name);
}

/**
 * 全量解压 zip 到目录。
 * opts:
 *   stripTopLevel  —— 去掉统一的顶层目录名（JDK 包普遍是 jdk-25.x.x/ 开头）
 *   onProgress     —— (done, total) 回调
 * 返回解出的文件数。
 *
 * 注意：要防 zip slip（条目名里带 ../ 能写到目录外）。
 */
export function extractAll(zipPath, outDir, opts = {}) {
  const { stripTopLevel = false, onProgress } = opts;
  const buf = fs.readFileSync(zipPath);
  const entries = listEntries(buf);

  // 判断是否有统一顶层目录
  let prefix = '';
  if (stripTopLevel && entries.length) {
    const first = entries[0].name.split('/')[0];
    const allSame = entries.every((e) => e.name === first || e.name.startsWith(first + '/'));
    if (allSame && first) prefix = first + '/';
  }

  const outRoot = path.resolve(outDir);
  fs.mkdirSync(outRoot, { recursive: true });

  let done = 0;
  let written = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) {
      done++;
      continue;
    }

    let rel = prefix ? e.name.slice(prefix.length) : e.name;
    if (!rel) {
      done++;
      continue;
    }

    // zip slip 防护
    const target = path.resolve(outRoot, rel);
    if (target !== outRoot && !target.startsWith(outRoot + path.sep)) {
      done++;
      continue;
    }

    const data = readEntry(buf, e);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written++;
    done++;

    if (onProgress && done % 200 === 0) {
      try {
        onProgress(done, entries.length);
      } catch {
        /* 进度回调异常不影响解压 */
      }
    }
  }

  if (onProgress) {
    try {
      onProgress(entries.length, entries.length);
    } catch {
      /* 忽略 */
    }
  }

  return written;
}
