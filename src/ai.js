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
  // 先处理带具体名字的 key/value，避免把值留在 match 里。
  out = out.replace(/(access[_-]?token|client[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret)\s*[:=]\s*["']?[^\s"',}]+/gi, (_m, key) => `${key}: ***`);
  out = out.replace(/--accessToken\s+\S+/gi, '--accessToken ***');
  out = out.replace(/--uuid\s+\S+/gi, '--uuid ***');
  out = out.replace(/Authorization\s*:\s*Bearer\s+[^\s]+/gi, 'Authorization: Bearer ***');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer ***');
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

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function newestHsErr(gameDir, versionId) {
  const dirs = [
    versionId ? path.join(gameDir, 'versions', versionId) : '',
    gameDir,
  ].filter(Boolean);
  let best = null;
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/^hs_err_pid\d+\.log$/i.test(name)) continue;
        const file = path.join(dir, name);
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      }
    } catch { /* ignore */ }
  }
  return best ? tailFile(best.file, 30000) : '';
}

function modsList(gameDir, versionId) {
  if (!versionId) return '';
  const dir = path.join(gameDir, 'versions', versionId, 'mods');
  try {
    const names = fs.readdirSync(dir).filter((n) => /\.jar$/i.test(n)).sort();
    return names.slice(0, 300).map((n) => n.replace(/\.jar$/i, '')).join('\n');
  } catch { return ''; }
}

function instanceConfig(gameDir, versionId) {
  if (!versionId) return '';
  const root = path.join(gameDir, 'versions', versionId);
  const out = [];
  const versionJson = readJson(path.join(root, `${versionId}.json`));
  if (versionJson) {
    out.push(`版本 JSON：id=${versionJson.id ?? versionId} inheritsFrom=${versionJson.inheritsFrom ?? ''} mainClass=${versionJson.mainClass ?? ''} java=${versionJson.javaVersion?.majorVersion ?? '?'}`);
  }
  const override = readJson(path.join(root, 'launcher-instance.json'));
  if (override) out.push(`实例覆盖：${JSON.stringify(override)}`);
  return out.join('\n');
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

function hasFailureArtifacts(gameDir, versionId) {
  const dirs = [
    versionId ? path.join(gameDir, 'versions', versionId) : '',
    gameDir,
  ].filter(Boolean);
  for (const dir of dirs) {
    try {
      if (fs.readdirSync(dir).some((n) => /^hs_err_pid\d+\.log$/i.test(n))) return true;
    } catch { /* ignore */ }
    try {
      const crashDir = path.join(dir, 'crash-reports');
      if (fs.readdirSync(crashDir).some((n) => n.endsWith('.txt'))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/** 闲聊层：只带实例/版本等基本信息，不读日志和 crash 文件。 */
export function collectBasicContext({ gameDir, versionId, lastFailure, launchCommand }) {
  const parts = [`系统内存：共 ${Math.round(os.totalmem() / 1024 / 1024)}M，可用 ${Math.round(os.freemem() / 1024 / 1024)}M`];
  if (lastFailure) {
    parts.push(`上次启动：实例=${lastFailure.versionId ?? versionId ?? '?'} 退出码=${lastFailure.code ?? '?'}`);
  }
  const info = instanceConfig(gameDir, versionId);
  if (info) parts.push(`实例配置：\n${info}`);
  const hasFailure = Boolean(lastFailure) || hasFailureArtifacts(gameDir, versionId);
  parts.push(`失败上下文：${hasFailure ? '有' : '无'}`);
  return redact(parts.join('\n\n')).slice(0, 12000);
}
export function collectContext({ gameDir, versionId, lastFailure, logs, launchCommand }) {
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const parts = [`系统内存：共 ${totalMb}M，可用 ${freeMb}M`];
  if (lastFailure) {
    parts.push(`上次启动：实例=${lastFailure.versionId ?? versionId ?? '?'} 退出码=${lastFailure.code ?? '?'} 原因=${lastFailure.reason ?? ''}`);
  }
  if (launchCommand) parts.push(`实际启动命令：\n${JSON.stringify(launchCommand, null, 2)}`);
  const settings = readJson(path.join(HOME_DIR, 'settings.json'));
  if (settings) parts.push(`启动器设置：Java=${settings.javaPath || '自动'} 默认内存=${settings.memoryMin || '?'}/${settings.memoryMax || '?'}`);
  const info = instanceConfig(gameDir, versionId);
  if (info) parts.push(`实例配置：\n${info}`);
  const mods = modsList(gameDir, versionId);
  parts.push(`mods 列表（文件名含版本）：\n${mods || '无'}`);

  const launcherLog = path.join(HOME_DIR, 'logs', 'launcher.log');
  const launcher = tailFile(launcherLog, 20000);
  if (launcher) parts.push(`启动器日志：\n${launcher}`);
  const exits = [...launcher.matchAll(/游戏退出[，,]\s*code=([^\s]+)/g)];
  if (exits.length) parts.push(`上次启动退出码：${exits[exits.length - 1][1]}`);
  if (logs?.length) parts.push(`启动器 stderr：\n${logs.slice(-120).join('\n')}`);

  const instanceLog = versionId
    ? path.join(gameDir, 'versions', versionId, 'logs', 'latest.log')
    : '';
  const gameLog = instanceLog && fs.existsSync(instanceLog)
    ? tailFile(instanceLog, 30000)
    : tailFile(path.join(gameDir, 'logs', 'latest.log'), 30000);
  if (gameLog) parts.push(`游戏 latest.log：\n${gameLog}`);

  const crash = newestCrash(gameDir, versionId);
  if (crash) parts.push(`最新 crash-report：\n${crash}`);
  else parts.push('最新 crash-report：无');
  const hs = newestHsErr(gameDir, versionId);
  if (hs) {
    parts.push(`最新 hs_err：\n${hs}`);
    const jc = /(?:java_command|Command Line):\s*([^\r\n]+)/.exec(hs);
    if (jc) parts.push(`实际启动命令（来自 hs_err）：\n${jc[1]}`);
  }

  let text = redact(parts.join('\n\n---\n\n'));
  // 账号名不交给模型；命令与日志里可能带用户名。
  try {
    const acc = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'accounts.json'), 'utf8'));
    for (const a of acc.accounts ?? []) {
      if (a?.name && String(a.name).length >= 2) {
        text = text.split(String(a.name)).join('<account>');
      }
    }
  } catch { /* ignore */ }
  text = text.replace(/--username\s+\S+/gi, '--username <account>');
  text = text.replace(/--uuid\s+\S+/gi, '--uuid <uuid>');
  return text.slice(0, 60000);
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
  classified = Array.isArray(classified) ? classified : [];
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
  let ctx = '';
  try { ctx = collectContext({ gameDir, versionId, lastFailure, logs }); }
  catch (e) { ctx = `上下文收集失败：${e.message}`; }
  const classified = classifyLogs(ctx);
  const cfg = loadAiConfig();
  if (!cfg.baseURL || !aiHasKey()) {
    const mem = [...ctx.matchAll(/-Xmx(\d+)m/gi)].map((m) => Number(m[1]));
    const maxMem = mem.length ? Math.max(...mem) : 0;
    const hasInstance = /实例配置|实例覆盖|实际启动命令|java_command/i.test(ctx);
    let analysis = '我看到了启动材料，但这次没有模型 key，只能按本地规则看。';
    if (!hasInstance) {
      analysis = '原因：这次没有读到明确的实例日志，也没看到具体报错。\n依据：没有可用的实例配置、crash-report 或 hs_err 记录。\n建议：把完整启动日志发我，或者先去「版本」页重新检查一次实例文件。';
    } else if (/insufficient memory|Native memory allocation|OutOfMemoryError|内存不足/i.test(ctx) || maxMem >= 3072) {
      analysis = `原因：内存不足。\n依据：实例最大内存是 ${maxMem || '较大'}M，日志里有内存分配失败。\n建议：先把最大内存降到 1024M，再启动一次。`;
    } else if (/UnsupportedClassVersionError|class file version/i.test(ctx)) {
      analysis = '原因：Java 版本对不上。\n依据：日志里出现 class file version / UnsupportedClassVersionError。\n建议：先换到实例要求的 Java，再启动。';
    } else if (classified.length) {
      analysis = `原因：${classified.map((c) => c.label).join('、')}相关报错。\n依据：日志里出现对应错误。\n建议：先看最新的那行报错，再决定下一步。`;
    } else {
      analysis = '原因：暂时不能确定。\n依据：没有找到明确错误，可能只是没有生成日志。\n建议：先把完整启动日志发我。';
    }
    const allowed = new Set(['memory.set', 'java.open', 'java.set', 'redownload.version', 'redownload.resources', 'open.instance', 'mod.disable', 'serverpack.redownload']);
    const actions = actionsFor(classified, { versionId, systemMemory: {
      total: Math.round(os.totalmem() / 1024 / 1024),
      free: Math.round(os.freemem() / 1024 / 1024),
    } }).filter((a) => allowed.has(a.id));
    if (!hasInstance) return { analysis, classified, actions: [] };
    if (maxMem >= 3072 && !actions.some((a) => a.id === 'memory.set')) {
      actions.unshift({ id: 'memory.set', label: '把实例内存降到 1024M', payload: { versionId, memoryMin: '512M', memoryMax: '1024M' } });
    }
    return { analysis, classified, actions };
  }
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const systemMemory = { total: totalMb, free: freeMb };
  const system = `你是《龙族》里的上杉绘梨衣，说话短、安静、不卖萌。你帮 Sakura 看 Minecraft 启动失败日志。
只输出人话，不输出堆栈、不输出 JSON、不输出密钥。
只根据最后一次失败和最近 100 行判断；更早的登录失败、上次启动旧日志不要拿来当本次原因。
格式：
原因：...
依据：...（引用一到两条日志里的具体内容）
建议：...（一到两步）
如果无法判断，直接说不知道，不要编。`;
  const user = `规则命中（按最近错误）：${classified.map((c) => c.label).join('、') || '无'}\n系统内存：共 ${totalMb}M，可用 ${freeMb}M\n日志（已脱敏）：\n${ctx}`;
  const analysis = await callAi({
    ...cfg,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    maxTokens: 900,
  });
  return { analysis, classified, actions: actionsFor(classified, { versionId, systemMemory }) };
}
