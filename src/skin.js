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
import crypto from 'node:crypto';
import { CACHE_DIR, APP_ROOT } from './paths.js';
import { msEnsureFresh } from './auth.js';

const SKIN_DIR = path.join(CACHE_DIR, 'skins');
const CUSTOM_DIR = path.join(CACHE_DIR, 'skins-custom');
const AVATAR_DIR = path.join(CACHE_DIR, 'avatars');
export const SKIN_INBOX_DIR = path.join(CUSTOM_DIR, 'inbox');
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

/* ---------------- 披风 ---------------- */

export class AuthExpiredError extends Error {
  constructor(message = '登录已过期，请重新登录') {
    super(message);
    this.name = 'AuthExpiredError';
    this.authExpired = true;
  }
}

function isPng(buf) {
  return Boolean(buf && buf.length > 100 && buf.readUInt32BE(0) === 0x89504e47);
}

/** 取当前账号公开 profile 里正在显示的披风 PNG。没有披风返回 null。 */
export async function getCape(account) {
  if (!account?.uuid) return null;
  if (account.type !== 'microsoft' && account.type !== 'yggdrasil') return null;
  const meta = await fetchTextureMeta(
    account.uuid,
    account.type === 'yggdrasil' ? account.server : null
  );
  if (!meta?.capeUrl) return null;
  return download(meta.capeUrl);
}

/**
 * 微软账号的完整披风列表。
 * 返回 { listable, capes:[{id, alias, state, url}], account? }
 * account 是刷新后的账号（调用方需要时落盘）。
 */
export async function getCapeList(account) {
  if (!account) return { listable: false, capes: [], reason: '先登录账号' };

  if (account.type !== 'microsoft') {
    const png = await getCape(account);
    return {
      listable: false,
      capes: png
        ? [{ id: null, alias: '当前披风', state: 'ACTIVE', url: '/api/cape' }]
        : [],
      reason: account.type === 'yggdrasil'
        ? '第三方认证服务器的标准接口不提供可切换披风列表'
        : '离线账号没有官方披风',
    };
  }

  let fresh;
  try {
    fresh = await msEnsureFresh(account);
  } catch {
    throw new AuthExpiredError();
  }

  let res;
  try {
    res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'User-Agent': 'mclauncher/0.1',
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error('连不上微软档案服务器');
  }
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
  if (!res.ok) throw new Error(`读取披风列表失败（HTTP ${res.status}）`);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('微软档案返回了无法解析的数据');
  }

  const capes = (Array.isArray(json.capes) ? json.capes : [])
    .filter((c) => c && c.url)
    .map((c) => ({
      id: String(c.id ?? ''),
      alias: String(c.alias || c.id || '披风'),
      state: c.state === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
      url: String(c.url).replace(/^http:\/\//i, 'https://'),
    }));

  return { listable: true, capes, account: fresh };
}

/** 切换微软账号当前披风。返回刷新后的账号。 */
export async function setActiveCape(account, capeId) {
  if (!account?.uuid) throw new Error('还没有选中的账号');
  if (account.type !== 'microsoft') throw new Error('只有微软正版账号支持切换披风');
  if (!capeId) throw new Error('缺少 capeId');

  let fresh;
  try {
    fresh = await msEnsureFresh(account);
  } catch {
    throw new AuthExpiredError();
  }

  let res;
  try {
    res = await fetch('https://api.minecraftservices.com/minecraft/profile/capes/active', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'mclauncher/0.1',
      },
      body: JSON.stringify({ capeId }),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error('连不上微软披风服务器');
  }
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
  if (!res.ok) throw new Error(`切换披风失败（HTTP ${res.status}）`);
  return fresh;
}

/* ---------------- 账号自定义头像 ---------------- */

function avatarKey(account) {
  if (!account?.uuid) return null;
  return crypto.createHash('sha1')
    .update(`${account.type || 'offline'}:${String(account.uuid).toLowerCase()}`)
    .digest('hex');
}

function avatarPath(account) {
  const key = avatarKey(account);
  return key ? path.join(AVATAR_DIR, `${key}.png`) : null;
}

/** 读自定义头像；返回 { png, shape } 或 null */
export async function getCustomAvatar(account) {
  const p = avatarPath(account);
  if (!p) return null;
  try {
    const png = await fsp.readFile(p);
    if (!isPng(png)) return null;
    let shape = 'circle';
    try {
      const meta = JSON.parse(await fsp.readFile(p.replace(/\.png$/, '.json'), 'utf8'));
      if (meta.shape === 'rounded') shape = 'rounded';
    } catch {
      /* 没元数据就按圆形 */
    }
    return { png, shape };
  } catch {
    return null;
  }
}

export async function saveCustomAvatar(account, buf, shape = 'circle') {
  const p = avatarPath(account);
  if (!p) throw new Error('账号没有 uuid，不能保存头像');
  if (!isPng(buf) || buf.length > 2 * 1024 * 1024) throw new Error('头像必须是 2MB 以内的 PNG');
  await fsp.mkdir(AVATAR_DIR, { recursive: true });
  await fsp.writeFile(p, buf);
  await fsp.writeFile(
    p.replace(/\.png$/, '.json'),
    JSON.stringify({ shape: shape === 'rounded' ? 'rounded' : 'circle' }, null, 2),
    'utf8'
  );
  return p;
}

export async function clearCustomAvatar(account) {
  const p = avatarPath(account);
  if (!p) return;
  await fsp.rm(p, { force: true });
  await fsp.rm(p.replace(/\.png$/, '.json'), { force: true });
}

/* ---------------- 本地皮肤文件夹 ---------------- */

function normUuidOrNull(uuid) {
  const id = String(uuid ?? '').replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

export function skinInboxDir(account) {
  const id = normUuidOrNull(account?.uuid);
  return id ? path.join(SKIN_INBOX_DIR, id) : null;
}

export async function ensureSkinInbox(account) {
  const dir = skinInboxDir(account);
  if (!dir) throw new Error('账号 uuid 不合法');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** 把皮肤文件夹里的 skin.png 导入成当前账号的自定义皮肤 */
export async function importSkinFromInbox(account) {
  const dir = skinInboxDir(account);
  if (!dir) return false;
  const file = path.join(dir, 'skin.png');
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch {
    return false;
  }
  if (!isPng(buf)) throw new Error('skin.png 不是有效的 PNG');
  await saveCustomSkin(account.uuid, buf, 'classic');
  await clearSkinCache(account.uuid);
  return true;
}
