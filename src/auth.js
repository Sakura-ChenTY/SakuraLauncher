/**
 * 账号认证：微软正版 / 离线 / 第三方 yggdrasil（LittleSkin 等）
 *
 * 三条链路各自完全不同，别混：
 *   正版   MSA 设备码 -> Xbox Live -> XSTS -> Minecraft Services -> profile
 *   离线   本地算 UUID，token 填 0，服务端不验证
 *   第三方 yggdrasil/authserver/authenticate -> accessToken + selectedProfile
 *          启动时还额外需要 authlib-injector 的 -javaagent
 *
 * 实测（2026-10-23 本机）：
 *   login.live.com/oauth20_connect.srf     设备码可用（AAD v2.0 端点对 MSA client 全部 unauthorized_client）
 *   loopback redirect_uri                  被拒（只有 oauth20_desktop.srf 被接受）
 *   user.auth.xboxlive.com                 400 可达
 *   xsts.auth.xboxlive.com                 400 可达
 *   api.minecraftservices.com              401 可达
 *   littleskin.cn yggdrasil                200 / 403（错密码）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { HOME_DIR, ensureHome } from './paths.js';

/** MSA 公共客户端 id（Minecraft 生态通用的 Xbox 客户端） */
const MS_CLIENT_ID = '00000000402b5328';
const MS_SCOPE = 'XboxLive.signin offline_access';
const MS_DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const MS_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const MS_DESKTOP_REDIRECT = 'https://login.live.com/oauth20_desktop.srf';

export const ACCOUNTS_FILE = path.join(HOME_DIR, 'accounts.json');

/** 认证相关的可诊断日志；只记 URL/状态/响应，不记密码 */
function authLog(line) {
  try {
    const dir = path.join(HOME_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'launcher.log'),
      `${new Date().toISOString()} [auth] ${line}\n`,
      'utf8'
    );
  } catch {
    /* 日志失败不影响登录 */
  }
}

/* ---------------- 通用 HTTP ---------------- */

async function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') };
}

async function postJson(url, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      Accept: 'application/json',
      ...extraHeaders,
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') };
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return {
    status: res.status,
    json,
    text,
    contentType: res.headers.get('content-type'),
    finalUrl: res.url,
    redirected: res.redirected,
  };
}

/* ---------------- 微软正版 ---------------- */

/**
 * 第一步：申请设备码。
 * 返回 { deviceCode, userCode, verificationUri, expiresIn, interval }
 * 用户拿 userCode 去 verificationUri 输入，我们同时轮询。
 */
export async function msStartDeviceCode() {
  const { status, json, text } = await postForm(MS_DEVICE_CODE_URL, {
    client_id: MS_CLIENT_ID,
    scope: MS_SCOPE,
    response_type: 'device_code',
  });

  if (!json?.user_code) {
    const why = json?.error_description || json?.error || text.slice(0, 200);
    throw new Error(`申请设备码失败（HTTP ${status}）：${why}`);
  }

  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri || 'https://www.microsoft.com/link',
    expiresIn: json.expires_in ?? 900,
    interval: json.interval ?? 5,
  };
}

/**
 * 第二步：轮询 token。
 * pending 表示用户还没完成授权，前端应继续等；其它错误直接抛。
 */
export async function msPollToken(deviceCode) {
  const { status, json, text } = await postForm(MS_TOKEN_URL, {
    client_id: MS_CLIENT_ID,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  });

  if (json?.access_token) {
    return { done: true, msAccessToken: json.access_token, refreshToken: json.refresh_token ?? null };
  }

  const err = json?.error;
  if (err === 'authorization_pending' || err === 'slow_down') {
    return { done: false, pending: true };
  }
  if (err === 'expired_token') {
    throw new Error('设备码已过期，请重新登录');
  }
  if (err === 'authorization_declined') {
    throw new Error('你取消了授权');
  }
  throw new Error(`微软登录失败（HTTP ${status}）：${json?.error_description || err || text.slice(0, 200)}`);
}

/** 用 refresh_token 换新的 MSA access_token（免去重新登录） */
export async function msRefresh(refreshToken) {
  const { json, text, status } = await postForm(MS_TOKEN_URL, {
    client_id: MS_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: MS_SCOPE,
  });
  if (!json?.access_token) {
    throw new Error(`刷新令牌失败（HTTP ${status}）：${json?.error_description || text.slice(0, 160)}`);
  }
  return { msAccessToken: json.access_token, refreshToken: json.refresh_token ?? refreshToken };
}

/** 第三步：MSA token -> Xbox Live token */
async function xblAuth(msAccessToken) {
  const { status, json, text } = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });

  if (!json?.Token) {
    throw new Error(`Xbox Live 认证失败（HTTP ${status}）：${text.slice(0, 220)}`);
  }
  return json.Token;
}

/** 第四步：Xbox token -> XSTS token（含 userhash） */
async function xstsAuth(xblToken) {
  const { status, json, text } = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });

  if (!json?.Token) {
    // XErr 是 Xbox 的错误码，含义固定，翻译出来比让它自己猜强得多
    const xerr = json?.XErr;
    const map = {
      2148916233: '这个微软账号还没有 Xbox 档案，先去 xbox.com 创建',
      2148916235: '该账号所在地区不支持 Xbox Live',
      2148916236: '该账号需要成人验证',
      2148916237: '该账号受家庭安全设置限制',
      2148916238: '未成年账号需要家长加入家庭组',
    };
    const zh = map[xerr];
    throw new Error(
      zh ? `XSTS 拒绝：${zh}（XErr ${xerr}）` : `XSTS 认证失败（HTTP ${status}）：${text.slice(0, 220)}`
    );
  }

  const xui = json.DisplayClaims?.xui?.[0];
  const uhs = xui?.uhs;
  if (!uhs) throw new Error('XSTS 响应里没有 userhash');
  // xid 就是 xuid，正版启动要拼进 auth_xuid
  return { xstsToken: json.Token, userHash: uhs, xuid: xui?.xid ?? null };
}

/** 第五步：XSTS -> Minecraft access token */
async function mcAuth(xstsToken, userHash) {
  const { status, json, text } = await postJson(
    'https://api.minecraftservices.com/authentication/login_with_xbox',
    { identityToken: `XBL3.0 x=${userHash};${xstsToken}` }
  );

  if (!json?.access_token) {
    throw new Error(`Minecraft 认证失败（HTTP ${status}）：${text.slice(0, 220)}`);
  }
  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in ?? 86400,
  };
}

/** 第六步：确认这个账号真的拥有 Minecraft，并取 uuid / 名字 */
export async function mcProfile(accessToken) {
  const { status, json, text } = await getJson('https://api.minecraftservices.com/minecraft/profile', {
    Authorization: `Bearer ${accessToken}`,
  });

  if (status === 404) {
    throw new Error('这个微软账号没有购买 Minecraft（或档案还没生成）。正版登录只对有游戏的账号有效');
  }
  if (!json?.id) {
    throw new Error(`读取 Minecraft 档案失败（HTTP ${status}）：${text.slice(0, 200)}`);
  }
  return { uuid: json.id, name: json.name, skins: json.skins ?? [] };
}

/**
 * 完整正版登录：设备码授权完成后一把跑完。
 * 返回可直接落盘的账号对象。
 */
export async function msCompleteLogin(msAccessToken, refreshToken) {
  const xbl = await xblAuth(msAccessToken);
  const { xstsToken, userHash, xuid } = await xstsAuth(xbl);
  const { accessToken, expiresIn } = await mcAuth(xstsToken, userHash);
  const profile = await mcProfile(accessToken);

  return {
    type: 'microsoft',
    name: profile.name,
    uuid: profile.uuid,
    accessToken,
    userHash,
    xuid: xuid ?? '0',
    refreshToken: refreshToken ?? null,
    msAccessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    addedAt: new Date().toISOString(),
  };
}

/** 正版 token 快过期时续一下（启动前调用） */
export async function msEnsureFresh(account) {
  const fiveMin = 5 * 60 * 1000;
  if (account.expiresAt && account.expiresAt - Date.now() > fiveMin) return account;

  if (account.refreshToken) {
    const t = await msRefresh(account.refreshToken);
    const fresh = await msCompleteLogin(t.msAccessToken, t.refreshToken);
    return { ...fresh, addedAt: account.addedAt ?? fresh.addedAt };
  }
  // 没有 refresh token 就只能重新登录
  throw new Error('登录已过期，请重新登录微软账号');
}

/* ---------------- 第三方 yggdrasil（LittleSkin 等） ---------------- */

/**
 * 常用认证服务器预设。
 *
 * 全部于 2026-10-23 实测过 meta 端点（返回 200 且含 meta.serverName）：
 *   littleskin   https://littleskin.cn/api/yggdrasil                        203ms
 *   blessingdemo https://skin.prinzeugen.net/api/yggdrasil                 667ms
 *   ely          https://authserver.ely.by/api/authlib-injector            576ms
 *
 * ⚠️ Ely.by 的地址形态和其它家不一样：
 *    它是 authserver.ely.by/api/authlib-injector，不是 /api/yggdrasil。
 *    实测 /api/yggdrasil 返回 404。所以不能靠「base + 固定后缀」猜。
 *
 * 用户也可以填任意自建 Blessing Skin，所以预设只是快捷方式，不是白名单。
 */
export const YGGDRASIL_PRESETS = [
  {
    id: 'littleskin',
    name: 'LittleSkin',
    url: 'https://littleskin.cn/api/yggdrasil',
    note: '国内最大第三方皮肤站，注册需邮箱',
  },
  {
    id: 'ely',
    name: 'Ely.by',
    url: 'https://authserver.ely.by/api/authlib-injector',
    note: '国际站，支持正版皮肤映射',
  },
  {
    id: 'blessing',
    name: 'Blessing Skin（官方演示）',
    url: 'https://skin.prinzeugen.net/api/yggdrasil',
    note: 'Blessing Skin 官方演示站；自建用户填自己的地址',
  },
];

/**
 * 规范化用户填的认证服务器地址。
 * 常见误填：末尾斜杠、误填首页、漏了 /api/yggdrasil。
 * 这里只做「去尾部斜杠」和协议补全，不擅自改路径 —— 猜路径会把 Ely.by 弄坏。
 */
export function normalizeServerUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('认证服务器地址不能为空');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.')) throw new Error('bad');
  } catch {
    throw new Error('认证服务器地址格式不对，示例：https://littleskin.cn/api/yggdrasil');
  }
  return s;
}

/** 拉取认证服务器元数据，确认它确实是 yggdrasil 实现 */
export async function yggdrasilProbe(serverUrl) {
  const base = normalizeServerUrl(serverUrl);
  const probe = await getJson(`${base}/`);
  const { status, json, text, contentType, finalUrl, redirected } = probe;
  authLog(
    `[ygg] try ${base}/ -> ${status} ${contentType || 'no-content-type'}` +
      `${redirected ? ` final=${finalUrl}` : ''} body=${String(text ?? '').slice(0, 200).replace(/\s+/g, ' ')}`
  );
  return { ...probe, base };
}

export async function yggdrasilMeta(serverUrl) {
  const probe = await yggdrasilProbe(serverUrl);
  const { status, json, text, contentType, finalUrl, redirected, base } = probe;
  if (!json?.meta) {
    // 填了首页是最常见的错，给一条能直接照做的提示
    throw new Error(
      `这个地址不是 yggdrasil 认证服务器（HTTP ${status}${redirected ? `，最终 ${finalUrl}` : ''}）。` +
        `要填的是以 /api/yggdrasil 结尾的地址，比如 https://littleskin.cn/api/yggdrasil`
    );
  }
  return {
    serverName: json.meta.serverName ?? '未知服务器',
    implementation: json.meta.implementationName ?? '',
    implementationVersion: json.meta.implementationVersion ?? '',
    skinDomains: json.skinDomains ?? [],
    hasPublicKey: Boolean(json.signaturePublickey),
    registerUrl: json.meta.links?.register ?? null,
    loginUrl: `${base}/authserver/authenticate`,
    base,
  };
}

/** 第三方登录：用户名 + 密码 */
export async function yggdrasilLogin(serverUrl, username, password) {
  if (!username) throw new Error('请填邮箱或用户名');
  if (!password) throw new Error('请填密码');

  let meta;
  try {
    meta = await yggdrasilMeta(serverUrl);
  } catch (e) {
    throw new Error(`连不上认证服务器：${e.message}`);
  }

  const clientToken = crypto.randomUUID().replace(/-/g, '');
  let status;
  let json;
  let text;
  try {
    ({ status, json, text } = await postJson(meta.loginUrl, {
      agent: { name: 'Minecraft', version: 1 },
      username,
      password,
      clientToken,
      requestUser: false,
    }));
  } catch (e) {
    throw new Error(`连不上认证服务器：${e.message}`);
  }

  if (!json?.accessToken) {
    if (status === 401 || status === 403) {
      throw new Error('邮箱/用户名或密码不正确。确认密码后重试；如果刚在皮肤站改过密码，先去网页端重新登录一次');
    }
    const msg = json?.errorMessage || json?.error || text.slice(0, 200);
    throw new Error(`登录失败（HTTP ${status}）：${msg}`);
  }

  const profiles = Array.isArray(json.availableProfiles) ? json.availableProfiles : [];
  if (!profiles.length && !json.selectedProfile) {
    throw new Error('登录成功，但这个账号没有角色（角色列表为空）。请先去皮肤站创建或绑定一个角色');
  }

  const selected = json.selectedProfile ?? profiles[0];
  const account = {
    type: 'yggdrasil',
    server: meta.base,
    serverName: meta.serverName,
    name: selected.name,
    uuid: selected.id,
    accessToken: json.accessToken,
    clientToken,
    refreshToken: json.refreshToken ?? null,
    userType: 'mojang',
    addedAt: new Date().toISOString(),
  };

  // 不在这里落盘，交给前端选角色后再保存
  return {
    account,
    profiles: (profiles.length ? profiles : [selected]).map((p) => ({ id: p.id, name: p.name })),
    selectedProfileId: selected.id,
  };
}

/** 读取角色皮肤；没有皮肤/服务器不支持时返回 null */
export async function yggdrasilProfileSkin(server, uuid) {
  if (!server || !uuid) return null;
  try {
    const base = normalizeServerUrl(server);
    const { status, json } = await getJson(
      `${base}/sessionserver/session/minecraft/profile/${encodeURIComponent(uuid)}`
    );
    if (status !== 200 || !json) return null;
    const prop = (json.properties ?? []).find((p) => p?.name === 'textures' && p.value);
    if (!prop) return null;
    const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
    return decoded?.textures?.SKIN?.url ?? null;
  } catch {
    return null;
  }
}
export async function yggdrasilSelectProfile(pending, profileId) {
  if (!pending?.server || !pending?.accessToken || !pending?.clientToken) {
    throw new Error('登录会话已失效，请重新登录');
  }
  if (!profileId) throw new Error('请选择一个角色');

  // LittleSkin/Blessing Skin 的 refresh 要求 selectedProfile 是对象，
  // 传字符串会被 400 拒绝；没有选择时整个字段应省略（本函数只在选择时调用）。
  const picked = (pending.profiles ?? []).find((p) => p.id === profileId || p.id === String(profileId).replace(/-/g, ''));
  const selectedProfile = {
    id: String(profileId).replace(/-/g, ''),
    name: picked?.name ?? String(profileId),
  };

  let status;
  let json;
  let text;
  try {
    ({ status, json, text } = await postJson(`${pending.server}/authserver/refresh`, {
      accessToken: pending.accessToken,
      clientToken: pending.clientToken,
      selectedProfile,
      requestUser: false,
    }));
  } catch (e) {
    throw new Error(`连不上认证服务器：${e.message}`);
  }

  if (!json?.accessToken || !json.selectedProfile) {
    if (status === 401 || status === 403) {
      throw new Error('这个角色暂时不能使用（令牌无效或角色已被移除），请重新登录');
    }
    throw new Error(`选择角色失败（HTTP ${status}）：${json?.errorMessage ?? text.slice(0, 160)}`);
  }

  return {
    type: 'yggdrasil',
    server: pending.server,
    serverName: pending.serverName,
    name: json.selectedProfile.name,
    uuid: json.selectedProfile.id,
    accessToken: json.accessToken,
    clientToken: pending.clientToken,
    refreshToken: json.refreshToken ?? pending.refreshToken ?? null,
    // 记住可选角色；重开登录器后不再输密码也能列出
    profiles: (pending.profiles ?? [])
      .filter((p) => p?.id)
      .map((p) => ({ id: p.id, name: p.name ?? p.id })),
    userType: 'mojang',
    addedAt: new Date().toISOString(),
  };
}

/**
 * 刷新第三方 token。
 *
 * 修正一个真 bug（2026-10-23）：原来第一行就 `if (!account.refreshToken) throw`，
 * 但登录时根本没存过 refreshToken —— 导致外置账号每次都走登录失败分支。
 *
 * 实际上经典 yggdrasil 的 /authserver/refresh 只需要 accessToken + clientToken，
 * 不需要 refreshToken。已实测 LittleSkin / Ely.by / Blessing Skin 三个服务的
 * refresh 端点都存在（用假 token 得到 403/401，不是 404）。
 *
 * 所以：有 refreshToken 就带上，没有也能刷。
 */
export async function yggdrasilRefresh(account) {
  if (!account?.server) throw new Error('账号缺认证服务器地址，请重新登录');
  if (!account.accessToken) throw new Error('账号没有令牌，请重新登录');

  const payload = {
    accessToken: account.accessToken,
    clientToken: account.clientToken,
    requestUser: false,
  };
  if (account.refreshToken) payload.refreshToken = account.refreshToken;

  const { status, json, text } = await postJson(`${account.server}/authserver/refresh`, payload);

  if (!json?.accessToken) {
    throw new Error(
      `令牌续期失败（HTTP ${status}）：${json?.errorMessage ?? text.slice(0, 120)}，请重新登录`
    );
  }

  return {
    ...account,
    accessToken: json.accessToken,
    // 有的服务刷新后会发新 refreshToken，没发就保留原来的
    refreshToken: json.refreshToken ?? account.refreshToken ?? null,
    name: json.selectedProfile?.name ?? account.name,
    uuid: json.selectedProfile?.id ?? account.uuid,
    profiles: Array.isArray(json.availableProfiles) && json.availableProfiles.length
      ? json.availableProfiles.map((p) => ({ id: p.id, name: p.name ?? p.id }))
      : account.profiles,
  };
}

/**
 * 用 authserver/validate 验证令牌是否真的还有效。
 * 返回 true 表示有效。这个测试不需要密码，可以用来验收登录是否真成功。
 */
export async function yggdrasilValidate(account) {
  if (!account?.server || !account.accessToken) return false;
  try {
    const res = await fetch(`${account.server}/authserver/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken, clientToken: account.clientToken }),
      signal: AbortSignal.timeout(15000),
    });
    return res.status === 204 || res.status === 200;
  } catch {
    return false;
  }
}

/* ---------------- 离线 ---------------- */

/** 离线 UUID：和原版 OfflinePlayer 算法一致 */
export function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function makeOfflineAccount(name) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    throw new Error('玩家名只能用字母/数字/下划线，最多 16 位');
  }
  return {
    type: 'offline',
    name,
    uuid: offlineUuid(name),
    accessToken: '0',
    userType: 'legacy',
    addedAt: new Date().toISOString(),
  };
}

/* ---------------- 存储 ---------------- */

const EMPTY = { accounts: [], selected: null };

/** 读账号库；文件坏了就当空的，别让启动器起不来 */
export async function loadAccounts() {
  try {
    const raw = await fsp.readFile(ACCOUNTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      accounts: Array.isArray(data.accounts) ? data.accounts : [],
      selected: data.selected ?? null,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** 写账号库：tmp + rename，避免半个文件 */
export async function saveAccounts(data) {
  await fsp.mkdir(path.dirname(ACCOUNTS_FILE), { recursive: true });
  const tmp = `${ACCOUNTS_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, ACCOUNTS_FILE);
  return data;
}

/** 账号唯一键：type + uuid */
export function accountKey(a) {
  return `${a.type}:${a.uuid}`;
}

/** 加或更新账号，返回新的账号库 */
export async function upsertAccount(account) {
  const data = await loadAccounts();
  const key = accountKey(account);
  const idx = data.accounts.findIndex((a) => accountKey(a) === key);

  let accounts;
  if (idx >= 0) {
    // 保留原 addedAt，其它字段用新的
    accounts = data.accounts.map((a, i) =>
      i === idx ? { ...account, addedAt: a.addedAt ?? account.addedAt } : a
    );
  } else {
    accounts = [...data.accounts, account];
  }

  return saveAccounts({ accounts, selected: key });
}

/** 删除账号；删的正好是选中账号就重置选中 */
export async function removeAccount(key) {
  const data = await loadAccounts();
  const accounts = data.accounts.filter((a) => accountKey(a) !== key);
  const selected = data.selected === key ? (accounts[0] ? accountKey(accounts[0]) : null) : data.selected;
  return saveAccounts({ accounts, selected });
}

/** 选中某个账号 */
export async function selectAccount(key) {
  const data = await loadAccounts();
  if (!data.accounts.some((a) => accountKey(a) === key)) {
    throw new Error('账号不存在');
  }
  return saveAccounts({ accounts: data.accounts, selected: key });
}

/** 取当前选中账号 */
export async function currentAccount() {
  const data = await loadAccounts();
  if (!data.selected) return null;
  return data.accounts.find((a) => accountKey(a) === data.selected) ?? null;
}

/* ---------------- authlib-injector ---------------- */

/** authlib-injector 缓存目录与版本记录 */
const INJECTOR_DIR = HOME_DIR;
const INJECTOR_META = path.join(INJECTOR_DIR, 'authlib-injector.json');

/**
 * 第三方登录进游戏必须带 -javaagent:authlib-injector.jar=<认证服务器>，
 * 否则客户端会把 token 发到 Mojang 官方去验，直接失败。
 * 这里把 jar 下到本地并缓存，只下一次。
 *
 * 返回 { jarPath, version }
 */
export async function ensureAuthlibInjector(onLog = () => {}) {
  await fsp.mkdir(INJECTOR_DIR, { recursive: true });

  // 已有缓存就直接用（版本变了也没关系，能跑就行）
  try {
    const meta = JSON.parse(await fsp.readFile(INJECTOR_META, 'utf8'));
    if (meta.jarPath && fs.existsSync(meta.jarPath)) {
      return { jarPath: meta.jarPath, version: meta.version };
    }
  } catch {
    /* 没有缓存，往下走 */
  }

  onLog('正在获取 authlib-injector…');
  const { status, json } = await getJson('https://authlib-injector.yushi.moe/artifact/latest.json');
  if (!json?.download_url) {
    throw new Error(`获取 authlib-injector 失败（HTTP ${status}）`);
  }

  const jarPath = path.join(INJECTOR_DIR, `authlib-injector-${json.version}.jar`);

  if (!fs.existsSync(jarPath)) {
    const res = await fetch(json.download_url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`下载 authlib-injector 失败（HTTP ${res.status}）`);
    const buf = Buffer.from(await res.arrayBuffer());
    // 先写临时文件再改名，避免下到一半留下坏 jar
    const tmp = `${jarPath}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, jarPath);
    onLog(`authlib-injector ${json.version} 已下载（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
  }

  await fsp.writeFile(
    INJECTOR_META,
    JSON.stringify({ jarPath, version: json.version, at: new Date().toISOString() }, null, 2),
    'utf8'
  );

  return { jarPath, version: json.version };
}

export { MS_CLIENT_ID, MS_DESKTOP_REDIRECT };
