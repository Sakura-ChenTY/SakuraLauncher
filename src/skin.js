/**
 * 正版皮肤获取
 *
 * 链路（PCL 也是这么走的）：
 *   sessionserver.mojang.com/session/minecraft/profile/<uuid>
 *     -> properties[textures] (base64 JSON)
 *       -> textures.SKIN.url 指向 textures.minecraft.net 的 PNG
 *
 * 注意两点，都踩过：
 *   1. 那个 url 是 http://，某些环境只放行 https，统一改写成 https
 *   2. 服务器返回的 uuid 不能带连字符，带了对某些客户端会 404
 *
 * 第三方 yggdrasil（LittleSkin / Blessing Skin）用同样的
 * /sessionserver/session/minecraft/profile/<uuid> 路径，所以一套代码通用。
 *
 * 全部结果落盘缓存：皮肤是按 uuid 内容寻址的，缓存后离线也能显示。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR, APP_ROOT } from './paths.js';

const SKIN_DIR = path.join(CACHE_DIR, 'skins');
const CUSTOM_DIR = path.join(CACHE_DIR, 'skins-custom');
const MOJANG_SESSION = 'https://sessionserver.mojang.com/session/minecraft/profile/';

/** 官方 18 套默认皮肤（9 个角色 x slim/wide），直接从客户端 jar 抽出，不是手画 */
const DEFAULT_SKIN_DIR = path.join(APP_ROOT, 'public', 'default-skins');

/**
 * 没皮肤的玩家该长什么样 —— 照抄游戏本体的算法：
 *
 *   fvm.c(uuid) = fvm.a[Math.floorMod(uuid.hashCode(), fvm.a.length)]
 *
 * 那个数组长度 18：前 9 项 slim、后 9 项 wide，名字顺序都是
 * alex, ari, efe, kai, makena, noor, steve, sunny, zuri。
 * （用 javap 反编译客户端 class 得到的，不是猜的）
 *
 * 要点：启动器选的必须和游戏里显示的一致。Java 的 UUID.hashCode()
 * 是四个 32 位半区相异或，不是 64 位整体异或 —— 写错了不会报错，
 * 只会安静地选错人。这里跟 Java 逐值对过。
 */
const DEFAULT_SKIN_NAMES = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];

/** Java UUID.hashCode()：(int)((msb >> 32) ^ msb ^ (lsb >> 32) ^ lsb) */
export function uuidHash(uuid) {
  const hex = String(uuid ?? '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const msb = BigInt('0x' + hex.slice(0, 16));
  const lsb = BigInt('0x' + hex.slice(16, 32));
  const M = 0xffffffffn;
  const x = ((msb >> 32n) & M) ^ (msb & M) ^ ((lsb >> 32n) & M) ^ (lsb & M);
  return Number(BigInt.asIntN(32, x));
}

/** Java Math.floorMod：JS 的 % 遇到负数给负值，不能直接用 */
function floorMod(a, n) {
  return ((a % n) + n) % n;
}

/** 这个 uuid 在游戏里会被分到哪套默认皮肤 */
export function defaultSkinFor(uuid) {
  const h = uuidHash(uuid);
  if (h === null) return { name: 'steve', variant: 'wide', index: 15 };
  const idx = floorMod(h, DEFAULT_SKIN_NAMES.length * 2);   // 0..17
  const slim = idx < DEFAULT_SKIN_NAMES.length;
  return {
    name: DEFAULT_SKIN_NAMES[idx % DEFAULT_SKIN_NAMES.length],
    variant: slim ? 'slim' : 'wide',
    index: idx,
  };
}

/** 读出某套默认皮肤 PNG；读不到返回 null */
export async function readDefaultSkin(name, variant) {
  const safeName = DEFAULT_SKIN_NAMES.includes(name) ? name : 'steve';
  const safeVariant = variant === 'slim' ? 'slim' : 'wide';
  try {
    const png = await fsp.readFile(path.join(DEFAULT_SKIN_DIR, safeVariant, `${safeName}.png`));
    if (png.length > 100 && png.readUInt32BE(0) === 0x89504e47) return png;
  } catch {
    /* 文件不在就用下面那张兜底 */
  }
  try {
    return await fsp.readFile(path.join(DEFAULT_SKIN_DIR, 'wide', 'steve.png'));
  } catch {
    return null;
  }
}

/** 合法 uuid 就返回去横线小写形式，否则 null */
function normUuid(uuid) {
  const id = String(uuid ?? '').replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

/** 缓存目录里的文件名。uuid 去掉连字符并统一小写 */
function cachePath(uuid) {
  const id = normUuid(uuid);
  if (!id) return null;
  return path.join(SKIN_DIR, `${id}.png`);
}

/** 本地自定义皮肤（用户自己选的 PNG），优先级高于官方皮肤 */
function customPath(uuid) {
  const id = normUuid(uuid);
  if (!id) return null;
  return path.join(CUSTOM_DIR, `${id}.png`);
}

/** 取 textures 属性里的皮肤/披风地址；拿不到返回 null */
async function fetchTextureMeta(uuid, sessionServer) {
  const base = sessionServer ? `${sessionServer.replace(/\/+$/, '')}/sessionserver/session/minecraft/profile/` : MOJANG_SESSION;
  const url = base + String(uuid).replace(/-/g, '');

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'mclauncher/0.1' },
      signal: AbortSignal.timeout(9000),
    });
  } catch {
    return null;   // 断网/超时，交给缓存兜底
  }
  if (!res.ok) return null;

  let json;
  try {
    json = await res.json();
  } catch {
    return null;
  }

  const tex = (json.properties ?? []).find((p) => p.name === 'textures');
  if (!tex?.value) return null;

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8'));
  } catch {
    return null;
  }

  const skinUrl = decoded.textures?.SKIN?.url;
  if (!skinUrl) return null;

  return {
    skinUrl: skinUrl.replace(/^http:\/\//i, 'https://'),
    capeUrl: decoded.textures?.CAPE?.url?.replace(/^http:\/\//i, 'https://') ?? null,
    // slim（Alex）手臂 3 像素宽，classic（Steve）4 像素
    model: decoded.textures?.SKIN?.metadata?.model === 'slim' ? 'slim' : 'classic',
  };
}

async function download(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'mclauncher/0.1' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG 魔数校验，别把错误页当图片存下去
    if (buf.length < 500 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * 取皮肤 PNG。
 * @param {object} account 账号对象（需要 uuid、type，yggdrasil 还要 server）
 * @returns {Promise<{png: Buffer, model: string, from: 'cache'|'network'} | null>}
 */
export async function getSkin(account) {
  if (!account?.uuid) return null;

  // 先看用户自己选的本地皮肤，有就用它，不再走网络
  const custom = customPath(account.uuid);
  if (custom) {
    try {
      const png = await fsp.readFile(custom);
      if (png.length > 500 && png.readUInt32BE(0) === 0x89504e47) {
        let model = 'classic';
        try {
          const meta = JSON.parse(await fsp.readFile(custom.replace(/\.png$/, '.json'), 'utf8'));
          model = meta.model === 'slim' ? 'slim' : 'classic';
        } catch {
          /* 没 meta 就当 classic */
        }
        return { png, model, from: 'custom' };
      }
    } catch {
      /* 没本地皮肤，继续往下走 */
    }
  }

  // 离线账号没有官方皮肤，别白跑一趟网络
  if (account.type !== 'microsoft' && account.type !== 'yggdrasil') return null;

  const cp = cachePath(account.uuid);
  const modelFile = cp ? cp.replace(/\.png$/, '.json') : null;

  // 先看缓存（含 model 信息）
  let cachedModel = 'classic';
  if (cp) {
    try {
      const png = await fsp.readFile(cp);
      if (png.length > 500 && png.readUInt32BE(0) === 0x89504e47) {
        try {
          const meta = JSON.parse(await fsp.readFile(modelFile, 'utf8'));
          cachedModel = meta.model === 'slim' ? 'slim' : 'classic';
        } catch {
          /* 没 meta 就当 classic */
        }
        return { png, model: cachedModel, from: 'cache' };
      }
    } catch {
      /* 没缓存，走网络 */
    }
  }

  const meta = await fetchTextureMeta(account.uuid, account.type === 'yggdrasil' ? account.server : null);
  if (!meta) return null;

  const png = await download(meta.skinUrl);
  if (!png) return null;

  if (cp) {
    try {
      await fsp.mkdir(SKIN_DIR, { recursive: true });
      await fsp.writeFile(cp, png);
      await fsp.writeFile(modelFile, JSON.stringify({ model: meta.model, capeUrl: meta.capeUrl }, null, 2), 'utf8');
    } catch {
      /* 缓存失败不影响这次显示 */
    }
  }

  return { png, model: meta.model, from: 'network' };
}

/** 手动清缓存用（换皮肤后强制刷新） */
export async function clearSkinCache(uuid) {
  const cp = cachePath(uuid);
  if (!cp) return;
  await fsp.rm(cp, { force: true });
  await fsp.rm(cp.replace(/\.png$/, '.json'), { force: true });
}

/**
 * 存一张用户自己选的皮肤（本地换装）。
 * 只校验 PNG 魔数，尺寸不管 —— 64x64 和 64x32 老格式都能用，
 * 取脸时按标准坐标裁，尺寸不对顶多显示怪，不会把启动器搞崩。
 */
export async function saveCustomSkin(uuid, buf, model = 'classic') {
  const cp = customPath(uuid);
  if (!cp) throw new Error('账号 uuid 不合法');
  if (!buf || buf.length < 100 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是有效的 PNG 图片');
  }
  await fsp.mkdir(CUSTOM_DIR, { recursive: true });
  await fsp.writeFile(cp, buf);
  await fsp.writeFile(
    cp.replace(/\.png$/, '.json'),
    JSON.stringify({ model: model === 'slim' ? 'slim' : 'classic' }, null, 2),
    'utf8'
  );
  return cp;
}

/** 删掉本地换装，回到官方皮肤 */
export async function clearCustomSkin(uuid) {
  const cp = customPath(uuid);
  if (!cp) return;
  await fsp.rm(cp, { force: true });
  await fsp.rm(cp.replace(/\.png$/, '.json'), { force: true });
}

/** 当前账号是否在用本地皮肤（前端判断"恢复官方"按钮要不要亮） */
export async function hasCustomSkin(uuid) {
  const cp = customPath(uuid);
  if (!cp) return false;
  try {
    const st = await fsp.stat(cp);
    return st.size > 100;
  } catch {
    return false;
  }
}
