/**
 * 联机 token 的本地保存。
 *
 * 生产环境（Electron）用 safeStorage（Windows DPAPI）加密；
 * 纯 Node 调试环境没有 safeStorage，退化成 base64 并明确标注，
 * 但绝不把 token 写进日志或 /api/state。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HOME_DIR } from './paths.js';

const FILE = path.join(HOME_DIR, 'online-secrets.json');

let safeStorage = null;
let ready = false;
let encryptionAvailable = false;
const tokenCache = new Map();

export async function initSecureStore() {
  if (ready) return;
  ready = true;
  if (!process.versions.electron) return;
  try {
    const electron = await import('electron');
    safeStorage = electron?.safeStorage ?? null;
    if (safeStorage?.isAsyncEncryptionAvailable) {
      encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable();
    }
  } catch {
    safeStorage = null;
    encryptionAvailable = false;
  }
  // 旧版同步加密/解密在 Electron 45 已废弃；这里统一用 async 并缓存明文，
  // 让联机 token 的同步 getToken 调用保持不变。
  const all = readAll();
  for (const [provider, entry] of Object.entries(all)) {
    try { tokenCache.set(provider, await decrypt(entry)); } catch { /* 解密失败就当没保存 */ }
  }
}

async function encrypt(plain, { requireEncryption = false } = {}) {
  const text = String(plain ?? '');
  if (encryptionAvailable && safeStorage?.encryptStringAsync) {
    const buf = await safeStorage.encryptStringAsync(text);
    return { enc: true, value: Buffer.from(buf).toString('base64') };
  }
  if (requireEncryption) {
    throw new Error('当前环境不能使用系统加密，密钥不会写入磁盘');
  }
  return { enc: false, value: Buffer.from(text, 'utf8').toString('base64') };
}

async function decrypt(entry) {
  if (!entry?.value) return '';
  if (entry.enc) {
    if (!encryptionAvailable || !safeStorage?.decryptStringAsync) {
      throw new Error('当前环境无法解密已保存的 token');
    }
    const result = await safeStorage.decryptStringAsync(Buffer.from(entry.value, 'base64'));
    return typeof result === 'string' ? result : String(result?.result ?? result?.value ?? '');
  }
  // 旧数据：plain base64（不再产生新数据）
  return Buffer.from(entry.value, 'base64').toString('utf8');
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeAll(obj) {
  await fsp.mkdir(path.dirname(FILE), { recursive: true });
  await fsp.writeFile(FILE, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export async function setToken(provider, token, opts = {}) {
  const all = readAll();
  const entry = await encrypt(token, opts);
  all[provider] = { ...entry, savedAt: Date.now() };
  await writeAll(all);
  tokenCache.set(provider, String(token ?? ''));
}

export function getToken(provider) {
  return tokenCache.get(provider) ?? '';
}

export function hasToken(provider) {
  return Boolean(getToken(provider));
}

export async function clearToken(provider) {
  const all = readAll();
  delete all[provider];
  await writeAll(all);
  tokenCache.delete(provider);
}

export async function clearAllTokens() {
  await writeAll({});
  tokenCache.clear();
}

/** 当前进程是否真的能使用系统加密（Windows DPAPI） */
export function secureEncryptionAvailable() {
  return encryptionAvailable;
}
