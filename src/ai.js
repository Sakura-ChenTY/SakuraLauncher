/**
 * 绘梨衣小助手：OpenAI 兼容接口 + 日志脱敏 + 规则归类。
 *
 * 这里只做「读日志 -> 脱敏 -> 找模型 -> 返回人话」。
 * 密钥不写进这个文件、不写日志、不回传前端明文。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HOME_DIR } from './paths.js';
import { getToken, setToken, hasToken, secureEncryptionAvailable } from './secure.js';

const CONFIG_FILE = path.join(HOME_DIR, 'ai-config.json');

export function loadAiConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      provider: String(data.provider ?? 'custom'),
      baseURL: String(data.baseURL ?? ''),
      model: String(data.model ?? ''),
    };
  } catch {
    return { provider: 'custom', baseURL: '', model: '' };
  }
}

export async function saveAiConfig({ provider, baseURL, model, apiKey }) {
  const cleanBase = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (cleanBase && !/^https?:\/\//i.test(cleanBase)) {
    throw new Error('baseURL 必须是 http(s) 地址');
  }
  const cleanModel = String(model ?? '').trim();
  const wantsKey = Boolean(String(apiKey ?? '').trim());
  if (wantsKey && !secureEncryptionAvailable()) {
    throw new Error('当前环境不能使用系统加密，API 密钥不落盘；请在 Electron 启动器里保存');
  }
  await fsp.mkdir(HOME_DIR, { recursive: true });
  await fsp.writeFile(
    CONFIG_FILE,
    JSON.stringify({ provider: String(provider ?? 'custom'), baseURL: cleanBase, model: cleanModel }, null, 2),
    'utf8'
  );
  if (wantsKey) {
    await setToken('ai', String(apiKey).trim(), { requireEncryption: true });
  }
  return loadAiConfig();
}

export function aiHasKey() {
  return hasToken('ai');
}

export function aiKeyMask() {
  const key = getToken('ai');
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function endpoint(baseURL) {
  const b = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('还没有填 baseURL');
  if (/\/chat\/completions$/i.test(b)) return b;
  // v1 / v4 / compatible-mode/v1 / api/paas/v4 都已经带版本段
  if (/\/v\d+$/i.test(b) || /\/compatible-mode\/v1$/i.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

export async function callAi({ baseURL, apiKey, model, messages, maxTokens = 900, timeout = 45000 }) {
  const key = String(apiKey ?? '').trim() || getToken('ai');
  if (!key) throw new Error('还没有配置 API 密钥');
  const url = endpoint(baseURL);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`模型接口失败（HTTP ${res.status}）：${msg}`);
  }
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('模型返回为空');
  return String(content).trim();
}

/* ---- 脱敏 ---- */

const SECRET_PATTERNS = [
  /(access[_-]?token|client[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret)\s*[:=]\s*["']?[^\s"',}]+/gi,
  /Authorization\s*:\s*Bearer\s+[^\s]+/gi,
  /--accessToken\s+[^\s]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
];

export function redact(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => `${m.split(/[:=]/)[0].trim()}: ***`);
  // 邮箱不必给模型；保留错误形状，不保留账号
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  out = out.replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\<user>');
  return out;
}

function tailFile(file, maxBytes = 30000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, st.size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function newestCrash(gameDir, versionId) {
  const v = String(versionId || '');
  const dirs = [
    v ? path.join(gameDir, 'versions', v, 'crash-reports') : '',
    path.join(gameDir, 'crash-reports'),
  ].filter(Boolean);
  let best = null;
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.txt')) continue;
        const file = path.join(dir, name);
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      }
    } catch { /* no dir */ }
  }
  return best ? tailFile(best.file, 30000) : '';
}

export function collectContext({ gameDir, versionId, lastFailure, logs }) {
  const parts = [];
  if (lastFailure) {
    parts.push(`启动器失败摘要：${lastFailure.reason ?? ''}（code=${lastFailure.code ?? '?'}，实例=${lastFailure.versionId ?? versionId ?? '?'}）`);
  }
  const launcherLog = path.join(HOME_DIR, 'logs', 'launcher.log');
  const launcher = tailFile(launcherLog, 20000);
  if (launcher) parts.push(`启动器日志：\n${launcher}`);
  if (logs?.length) parts.push(`启动器 stderr：\n${logs.slice(-120).join('\n')}`);
  const instanceLog = versionId
    ? path.join(gameDir, 'versions', versionId, 'logs', 'latest.log')
    : '';
  const gameLog = instanceLog && fs.existsSync(instanceLog)
    ? tailFile(instanceLog, 30000)
    : tailFile(path.join(gameDir, 'logs', 'latest.log'), 30000);
  if (gameLog) parts.push(`游戏 latest.log：\n${gameLog}`);
  const crash = newestCrash(gameDir, versionId);
  if (crash) parts.push(`crash-report：\n${crash}`);
  return redact(parts.join('\n\n---\n\n')).slice(0, 40000);
}

/* ---- 规则归类 ---- */

export function classifyLogs(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  const recent = lines.slice(-260);
  const defs = [
    ['mod-conflict', '模组冲突 / Mixin', /duplicate mod|mod conflict|mixin.*(fail|error)|injection.*fail/i],
    ['missing-dep', '缺前置', /missing depend|requires .* which is missing|NoClassDefFoundError/i],
    ['java', 'Java 版本', /UnsupportedClassVersionError|java\.version|class file version|requires Java/i],
    ['memory', '内存 / 页面文件不足', /OutOfMemoryError|insufficient memory|Native memory allocation|malloc failed|os::commit_memory|error=1455|页面文件太小/i],
    ['authlib', '外置登录', /authlib|yggdrasil|外置登录|invalid token/i],
    ['graphics', '显卡 / OpenGL', /OpenGL|GLFW|graphics driver|Pixel format|EGL/i],
    ['download', '文件损坏 / 下载失败', /corrupt|invalid zip|ZipException|Failed to download/i],
  ];
  const latest = new Map();
  for (let i = 0; i < recent.length; i += 1) {
    for (const [id, label, re] of defs) {
      if (re.test(recent[i])) latest.set(id, { id, label, at: i });
    }
  }
  if (!latest.size) return [];
  // 只看最后一处错误附近的类别；更早的外置登录报错不能当本次分类。
  const maxAt = Math.max(...[...latest.values()].map((x) => x.at));
  return [...latest.values()]
    .filter((x) => x.at === maxAt)
    .sort((a, b) => b.at - a.at);
}

export function actionsFor(classified, { versionId, systemMemory } = {}) {
  const actions = [];
  if (classified.some((c) => c.id === 'memory')) {
    const totalMb = systemMemory?.total ?? Math.round(os.totalmem() / 1024 / 1024);
    const freeMb = systemMemory?.free ?? Math.round(os.freemem() / 1024 / 1024);
    const cap = Math.min(40960, Math.floor(totalMb * 0.8));
    const safeByFree = Math.max(1024, Math.floor((freeMb * 0.8) / 1024) * 1024);
    const target = Math.min(6144, cap, safeByFree);
    actions.push({
      id: 'memory.set',
      label: `把当前实例内存提高到 ${target}M（可用 ${freeMb}M）`,
      payload: { versionId, memoryMax: `${target}M` },
    });
  }
  if (classified.some((c) => c.id === 'java')) {
    actions.push({ id: 'open.java', label: '打开 Java 设置' });
  }
  if (classified.some((c) => c.id === 'authlib')) {
    actions.push({ id: 'open.login', label: '打开外置登录' });
  }
  actions.push({ id: 'open.log', label: '打开 latest.log' });
  return actions;
}

export async function testAi({ baseURL, apiKey, model }) {
  const reply = await callAi({
    baseURL,
    apiKey,
    model,
    messages: [{ role: 'user', content: '只回复：OK' }],
    maxTokens: 8,
    timeout: 20000,
  });
  return reply;
}

export async function analyzeFailure({ gameDir, versionId, lastFailure, logs }) {
  const ctx = collectContext({ gameDir, versionId, lastFailure, logs });
  const classified = classifyLogs(ctx);
  const cfg = loadAiConfig();
  if (!cfg.baseURL || !aiHasKey()) {
    throw new Error('还没有配置 AI：先填 baseURL 和 API 密钥');
  }
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const systemMemory = { total: totalMb, free: freeMb };
  const system = `你是《龙族》里的上杉绘梨衣，说话短、安静、不卖萌。你帮 Sakura 看 Minecraft 启动失败日志。
只输出人话，不输出堆栈、不输出 JSON、不输出密钥。
只根据最后一次失败和最近 100 行判断；更早的登录失败、上次启动旧日志不要拿来当本次原因。
格式：
出了什么问题：...
为什么：...
怎么解决：...
如果无法判断，直接说不知道，不要编。`;
  const user = `规则命中（按最近错误）：${classified.map((c) => c.label).join('、') || '无'}\n系统内存：共 ${totalMb}M，可用 ${freeMb}M\n日志（已脱敏）：\n${ctx}`;
  const analysis = await callAi({
    ...cfg,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    maxTokens: 900,
  });
  return { analysis, classified, actions: actionsFor(classified, { versionId, systemMemory }) };
}
