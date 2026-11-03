/**
 * 流式 ZIP 写入器。
 *
 * 每个条目边读边压缩，用 data descriptor 记录 CRC/大小，不把源文件
 * 或压缩结果整体放进内存。只支持普通 ZIP（<4GB 单条目/总大小）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable, Transform, Writable, pipeline } from 'node:stream';
import { promisify } from 'node:util';

const pipelineAsync = promisify(pipeline);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crcUpdate(crc, chunk) {
  let c = crc;
  for (let i = 0; i < chunk.length; i += 1) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function writeTo(stream, buf) {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

function makeTee({ hash = false } = {}) {
  let crc = 0xffffffff;
  let size = 0;
  const sha = hash ? crypto.createHash('sha1') : null;
  const transform = new Transform({
    transform(chunk, _enc, cb) {
      crc = crcUpdate(crc, chunk);
      size += chunk.length;
      if (sha) sha.update(chunk);
      this.push(chunk);
      cb();
    },
  });
  transform.result = () => ({
    crc: (crc ^ 0xffffffff) >>> 0,
    size,
    sha1: sha ? sha.digest('hex') : '',
  });
  return transform;
}

/** 把 gzip 容器的头尾去掉，留下 ZIP method 8 需要的 raw DEFLATE 数据。 */
class GzipToRaw extends Transform {
  constructor() {
    super();
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.started = false;
  }
  _transform(chunk, _enc, cb) {
    let data = chunk;
    if (!this.started) {
      this.head = Buffer.concat([this.head, data]);
      if (this.head.length < 10) return cb();
      if (this.head[0] !== 0x1f || this.head[1] !== 0x8b) return cb(new Error('不是 gzip 数据'));
      data = this.head.subarray(10);
      this.head = Buffer.alloc(0);
      this.started = true;
    }
    this.tail = Buffer.concat([this.tail, data]);
    if (this.tail.length > 8) {
      this.push(this.tail.subarray(0, this.tail.length - 8));
      this.tail = this.tail.subarray(-8);
    }
    cb();
  }
  _flush(cb) {
    cb();
  }
}
function localHeader(name, method) {
  const n = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
  return Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0808), u16(method), u16(0), u16(0),
    u32(0), u32(0), u32(0), u16(n.length), u16(0), n,
  ]);
}

function dataDescriptor(crc, compSize, size) {
  return Buffer.concat([u32(0x08074b50), u32(crc), u32(compSize), u32(size)]);
}

function centralHeader(entry) {
  const n = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
  return Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(entry.method), u16(0), u16(0),
    u32(entry.crc), u32(entry.compSize), u32(entry.size), u16(n.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(entry.localOffset), n,
  ]);
}

/**
 * entries: [{ name, file }] 或 [{ name, data }]
 * opts.hash: 同时计算源文件 SHA-1，返回 entries[].sha1/dataOffset/compSize
 */
export async function writeZipStream(file, entries, opts = {}) {
  const { hash = false, onProgress = () => {} } = opts;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  const written = [];
  let offset = 0;
  let done = 0;
  try {
    for (const item of entries) {
      const name = String(item.name).replace(/\\/g, '/');
      let source;
      let expected = 0;
      if (item.file) {
        const st = await fs.promises.stat(item.file);
        if (!st.isFile()) throw new Error(`不是文件：${item.file}`);
        expected = st.size;
        source = fs.createReadStream(item.file);
      } else {
        source = Readable.from([Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.data ?? ''))]);
      }
      const tee = makeTee({ hash });
      const method = 8;
      const header = localHeader(name, method);
      await writeTo(out, header);
      const dataOffset = offset + header.length;
      const compressor = opts.gzip ? zlib.createGzip({ level: 6 }) : zlib.createDeflateRaw({ level: 6 });
      const rawTail = opts.gzip ? new GzipToRaw() : null;
      let compSize = 0;
      const sink = new Writable({
        write(chunk, _enc, cb) {
          compSize += chunk.length;
          out.write(chunk, cb);
        },
      });
      if (rawTail) await pipelineAsync(source, tee, compressor, rawTail, sink);
      else await pipelineAsync(source, tee, compressor, sink);
      const info = tee.result();
      if (item.file && expected !== info.size) {
        throw new Error(`源文件大小变化：${name}`);
      }
      const desc = dataDescriptor(info.crc, compSize, info.size);
      await writeTo(out, desc);
      const entry = {
        name,
        method,
        crc: info.crc,
        compSize,
        size: info.size,
        localOffset: offset,
        dataOffset,
        sha1: info.sha1,
      };
      written.push(entry);
      offset += header.length + compSize + desc.length;
      done += 1;
      onProgress({ done, total: entries.length, name, bytes: compSize });
    }
    const centralOffset = offset;
    let centralSize = 0;
    for (const entry of written) {
      const c = centralHeader(entry);
      await writeTo(out, c);
      centralSize += c.length;
    }
    const end = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(written.length), u16(written.length),
      u32(centralSize), u32(centralOffset), u16(0),
    ]);
    await writeTo(out, end);
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    return { file, entries: written, size: offset + centralSize + end.length };
  } catch (e) {
    try { out.destroy(); } catch { /* ignore */ }
    try { await fs.promises.rm(file, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 校验流式 zip 的条目：只流式读取压缩区间，解压后算 SHA-1。
 */
export async function verifyZipStream(file, entries) {
  for (const entry of entries) {
    if (!entry.sha1) continue;
    let size = 0;
    const hash = crypto.createHash('sha1');
    const source = fs.createReadStream(file, {
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compSize - 1,
    });
    const transform = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        hash.update(chunk);
        cb();
      },
    });
    if (entry.method === 8) {
      const inflate = zlib.createInflateRaw();
      await pipelineAsync(source, inflate, transform);
    } else {
      await pipelineAsync(source, transform);
    }
    if (size !== entry.size || hash.digest('hex') !== entry.sha1) {
      throw new Error(`条目校验失败：${entry.name}`);
    }
  }
}
