/** 读取 level.dat 里最小的 NBT 字段：LevelName / DataVersion。 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const TAG = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
};

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.p = 0;
  }
  u8() { return this.buf.readUInt8(this.p++); }
  i8() { return this.buf.readInt8(this.p++); }
  i16() { const v = this.buf.readInt16BE(this.p); this.p += 2; return v; }
  u16() { const v = this.buf.readUInt16BE(this.p); this.p += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.p); this.p += 4; return v; }
  i64() { const v = this.buf.readBigInt64BE(this.p); this.p += 8; return v; }
  f32() { const v = this.buf.readFloatBE(this.p); this.p += 4; return v; }
  f64() { const v = this.buf.readDoubleBE(this.p); this.p += 8; return v; }
  str() {
    const n = this.u16();
    const v = this.buf.toString('utf8', this.p, this.p + n);
    this.p += n;
    return v;
  }
}

function readPayload(r, type) {
  switch (type) {
    case TAG.Byte: return r.i8();
    case TAG.Short: return r.i16();
    case TAG.Int: return r.i32();
    case TAG.Long: return r.i64();
    case TAG.Float: return r.f32();
    case TAG.Double: return r.f64();
    case TAG.ByteArray: {
      const n = r.i32(); const b = r.buf.subarray(r.p, r.p + n); r.p += n; return b;
    }
    case TAG.String: return r.str();
    case TAG.List: {
      const itemType = r.u8(); const n = r.i32(); const out = [];
      for (let i = 0; i < n; i++) out.push(readPayload(r, itemType));
      return out;
    }
    case TAG.Compound: {
      const out = {};
      for (;;) {
        const t = r.u8();
        if (t === TAG.End) break;
        const name = r.str();
        out[name] = readPayload(r, t);
      }
      return out;
    }
    case TAG.IntArray: {
      const n = r.i32(); const out = []; for (let i = 0; i < n; i++) out.push(r.i32()); return out;
    }
    case TAG.LongArray: {
      const n = r.i32(); const out = []; for (let i = 0; i < n; i++) out.push(r.i64()); return out;
    }
    default: return null;
  }
}

export function parseLevelDat(buf) {
  let raw = buf;
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  const r = new Reader(raw);
  const type = r.u8();
  if (type !== TAG.Compound) throw new Error('level.dat 不是 NBT 根复合标签');
  r.str(); // root name
  const root = readPayload(r, TAG.Compound);
  const data = root?.Data ?? root?.data ?? {};
  const levelName = String(data.LevelName ?? data.levelName ?? '');
  const dataVersion = Number(data.DataVersion ?? data.dataVersion ?? 0) || null;
  return { levelName, dataVersion };
}

export function readLevelDatFile(file) {
  return parseLevelDat(fs.readFileSync(file));
}
