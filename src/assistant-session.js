/**
 * 绘梨衣小助手会话。
 *
 * 会话开始时只收集「基础上下文」；只有明确进入排查意图时，才收集 full
 * 日志上下文。会话落盘，保留最近 N 轮。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { HOME_DIR } from './paths.js';
import {
  collectContext,
  collectBasicContext,
  classifyLogs,
  actionsFor,
  callAi,
  loadAiConfig,
  aiHasKey,
} from './ai.js';
import { detectSymptom, isTechnicalQuestion, collectSymptomContext, SYMPTOMS, IMPLEMENTATION_NOTES } from './assistant-diagnostics.js';

const FILE = path.join(HOME_DIR, 'assistant-sessions.json');
const MAX_SESSIONS = 20;
const MAX_MESSAGES = 12;

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' && Array.isArray(data.sessions) ? data : { sessions: [] };
  } catch {
    return { sessions: [] };
  }
}

function writeAll(data) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function publicSession(s) {
  return {
    id: s.id,
    versionId: s.versionId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messages: s.messages ?? [],
  };
}

function safeBasicContext(args) {
  try { return collectBasicContext(args); }
  catch (e) { return `基础上下文收集失败：${e.message}`; }
}

function hasFailureFiles(gameDir, versionId) {
  if (!gameDir || !versionId) return false;
  const root = path.join(gameDir, 'versions', versionId);
  try {
    if (fs.readdirSync(root).some((n) => /^hs_err_pid\d+\.log$/i.test(n))) return true;
  } catch { /* ignore */ }
  try {
    if (fs.readdirSync(path.join(root, 'crash-reports')).some((n) => n.endsWith('.txt'))) return true;
  } catch { /* ignore */ }
  return false;
}

export function createSession({ gameDir, versionId, lastFailure, logs, launchCommand }) {
  const basicContext = safeBasicContext({ gameDir, versionId, lastFailure, launchCommand });
  const session = {
    id: crypto.randomUUID(),
    gameDir,
    versionId: versionId || '',
    basicContext,
    diagnosticContext: null,
    classified: [],
    hasFailure: Boolean(lastFailure) || hasFailureFiles(gameDir, versionId),
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const data = readAll();
  data.sessions.unshift(session);
  data.sessions = data.sessions.slice(0, MAX_SESSIONS);
  writeAll(data);
  return publicSession(session);
}

export function getSession(id) {
  const s = readAll().sessions.find((x) => x.id === id);
  return s ? publicSession(s) : null;
}

function hasInstanceContext(text) {
  return /实例配置|实例覆盖|实际启动命令|java_command/i.test(String(text || ''));
}

function maxMemoryIn(text) {
  const source = String(text || '');
  // 实例覆盖是当前真值；日志里的旧 -Xmx 可能来自上一次启动，不能拿它当现状。
  const override = /实例覆盖[^\n]*?memoryMax"?\s*:\s*"?(\d+)M/i.exec(source);
  if (override) return Number(override[1]);
  const configured = /memoryMax"?\s*[:=]\s*"?(\d+)M/i.exec(source);
  if (configured) return Number(configured[1]);
  const found = [];
  for (const m of source.matchAll(/-Xmx(\d+)m/gi)) found.push(Number(m[1]));
  return found.length ? Math.max(...found) : 0;
}

function availableMemoryIn(text) {
  const m = /可用\s*(\d+)M/i.exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}

function localChatReply(message) {
  const text = String(message || '');
  if (/谢谢|多谢|辛苦/i.test(text)) return '嗯。';
  if (/你好|在吗|早上好|晚上好/i.test(text)) return '在。';
  if (/吃|饿|饭|蛋糕/i.test(text)) return '想吃。';
  if (/游戏|玩|动画|动漫/i.test(text)) return '嗯。想玩。';
  if (/你是谁|名字|叫什么/i.test(text)) return '绘梨衣。小助手。';
  return '嗯。你说。';
}

function localDiagnosticReply(session, message, actions, category = 'startup') {
  const cmd = String(session.diagnosticContext || session.context || '');
  const mem = maxMemoryIn(cmd);
  const hasInstance = hasInstanceContext(cmd);
  const second = /第二条|第二个|第二个按钮/i.test(String(message));
  if (second && actions[1]) {
    return `第二条是「${actions[1].label}」。它对应上面的问题，点之前会先确认。`;
  }
  if (category === 'online') {
    const provider = /当前 provider：([^\n]+)/.exec(cmd)?.[1] || '未选择';
    const room = /房间状态：([^\n]+)/.exec(cmd)?.[1] || '未知';
    const frp = /frpc 最近输出：\n([\s\S]*?)(?:\n\n|$)/.exec(cmd)?.[1]?.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') || '无输出';
    return `原因：联机链路没有建立。\n依据：provider=${provider}；房间=${room}；frpc=${frp}。\n建议：先确认选中的隧道 local_port 是 25565、frpc 正在运行；再看房间 error 和防火墙是否放行 java/javaw。`;
  }
  if (category === 'modpack') {
    const err = /房间状态：[^\n]*error=([^\n]+)/.exec(cmd)?.[1] || /error=([^\n]+)/.exec(cmd)?.[1] || '未读到明确 error';
    const sp = /serverPackFileId：([^\n]+)/.exec(cmd)?.[1] || '无';
    return `原因：整合包下载或安装没有完成。\n依据：${err.slice(0, 220)}；serverPackFileId=${sp}。\n建议：先看房间错误里的 HTTP/API 返回；有 serverPackFileId 但下载不到时，把 server-pack.zip 放进服务端目录再开房。`;
  }
  if (category === 'download') {
    const last = /最近失败：([^\n]+)/.exec(cmd)?.[1] || '没有最近的失败摘要';
    return `原因：资源/版本文件下载失败。\n依据：${last.slice(0, 220)}。\n建议：先换下载源再重试一次，检查磁盘空间和代理；还失败就把状态码和 URL 发我。`;
  }
  if (category === 'mod') {
    const lines = /相关日志：\n([\s\S]*?)(?:\n\n|$)/.exec(cmd)?.[1]?.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' / ') || '没有抓到明确冲突行';
    return `原因：可能是 mod 冲突或前置缺失。\n依据：${lines.slice(0, 220)}。\n建议：先停用日志里第一个报错的 mod，确认前置版本后重启。`;
  }
  if (category === 'performance') {
    const memLine = /系统内存：([^\n]+)/.exec(cmd)?.[1] || '内存信息不足';
    return `原因：性能瓶颈更可能在内存/GC 或客户端渲染。\n依据：${memLine}。\n建议：先看任务管理器占用，再降低视距/光影，检查 Java 参数和后台程序。`;
  }
  if (!hasInstance) {
    return '原因：这次没有读到明确的实例日志，也没看到具体报错。\n依据：没有可用的实例配置、crash-report 或 hs_err 记录。\n建议：把完整启动日志发我，或者先去「版本」页重新检查一次实例文件。';
  }
  if (/OutOfMemoryError|insufficient memory|Native memory allocation|malloc failed|页面文件|内存不足/i.test(cmd) || mem >= 3072) {
    const free = availableMemoryIn(cmd);
    if (mem && mem <= 1024) {
      return `原因：内存不足。\n依据：当前实例已经设置为 ${mem}M，日志里仍有内存分配失败；系统当时可用约 ${free || '很少'}M。\n建议：先关掉浏览器/别的游戏，确认 Windows 页面文件没有关闭；还不行再把最大内存降到 768M 试一次。`;
    }
    return `原因：内存不足。\n依据：当前实例最大内存是 ${mem || '较大'}M，系统当时可用约 ${free || '很少'}M，日志里有内存分配失败。\n建议：先把最大内存从 ${mem || '较大'}M 降到 1024M，并关掉占内存的程序。`;
  }
  if (/UnsupportedClassVersionError|class file version|Java 版本/i.test(cmd)) {
    return '原因：Java 版本对不上。\n依据：日志里出现 class file version / UnsupportedClassVersionError。\n建议：先换到实例要求的 Java，再启动。';
  }
  if (/NoClassDefFoundError|missing depend|Mod|Mixin/i.test(cmd)) {
    return '原因：可能是 mod 或前置缺失。\n依据：日志里出现 NoClassDefFoundError / missing dependency / Mixin 相关报错。\n建议：先看第一个报错的 mod，必要时先停用它。';
  }
  if (actions[0]) {
    return `原因：日志里没有唯一结论，但已经读到启动上下文。\n依据：当前实例存在失败记录，具体报错行不完整。\n建议：先试「${actions[0].label}」，不行再把最新日志发我。`;
  }
  return '原因：暂时不能确定。\n依据：这次没有读到足够明确的报错行。\n建议：把完整启动日志发我，别先改一堆设置。';
}

async function collectDiagnostic(session, category, diagnosticsState) {
  if (session.diagnosticCategory === category && session.diagnosticContext) return session.diagnosticContext;
  session.diagnosticCategory = category;
  try {
    session.diagnosticContext = await collectSymptomContext(category, {
      gameDir: session.gameDir || diagnosticsState?.gameDir,
      versionId: session.versionId,
      state: diagnosticsState,
    });
  } catch (e) {
    session.diagnosticContext = `上下文收集失败：${e.message}`;
  }
  session.classified = classifyLogs(session.diagnosticContext);
  return session.diagnosticContext;
}

function buildActions(session) {
  const context = String(session.diagnosticContext || '');
  if (!hasInstanceContext(context)) return [];
  const allowed = new Set([
    'memory.set', 'java.open', 'java.set', 'redownload.version', 'redownload.resources',
    'open.instance', 'mod.disable', 'serverpack.redownload',
  ]);
  const currentMemory = maxMemoryIn(context);
  const actions = actionsFor(Array.isArray(session.classified) ? session.classified : [], { versionId: session.versionId })
    .filter((a) => allowed.has(a.id))
    .filter((a) => a.id !== 'memory.set' || Number(String(a.payload?.memoryMax || '').replace(/[^0-9]/g, '')) > currentMemory);
  const has = (id) => actions.some((a) => a.id === id);
  if (!has('memory.set') && currentMemory > 2048) {
    actions.unshift({
      id: 'memory.set',
      label: '把实例内存降到 1024M',
      payload: { versionId: session.versionId, memoryMin: '512M', memoryMax: '1024M' },
    });
  }
  if (!has('java.set')) actions.push({ id: 'java.open', label: '换 Java 运行时' });
  if (!has('open.instance')) actions.push({ id: 'open.instance', label: '打开实例目录' });
  if (!has('redownload.version')) actions.push({ id: 'redownload.version', label: '重新下载版本文件' });
  if (!has('redownload.resources')) actions.push({ id: 'redownload.resources', label: '重新下载资源文件' });
  if (!has('serverpack.redownload')) actions.push({ id: 'serverpack.redownload', label: '重新下载 server pack' });
  if (!has('mod.disable')) actions.push({ id: 'mod.disable', label: '停用可疑 mod（需确认）' });
  const rank = { 'memory.set': 0, 'java.open': 1, 'java.set': 1, 'open.instance': 2, 'redownload.version': 3, 'redownload.resources': 4, 'serverpack.redownload': 5, 'mod.disable': 6 };
  actions.sort((a, b) => (rank[a.id] ?? 99) - (rank[b.id] ?? 99));
  return actions;
}

function actionsFromReply(reply, session) {
  const text = String(reply || '');
  const context = String(session.diagnosticContext || '');
  const hasInstance = hasInstanceContext(context);
  const current = maxMemoryIn(context);
  const actions = [];
  const memory = /(?:降到|降至|改成|改为|调到|设置为)\s*(\d{3,4})\s*M/i.exec(text);
  if (hasInstance && memory) {
    const target = Number(memory[1]);
    if (target >= 512 && target !== current) {
      actions.push({
        id: 'memory.set',
        label: `把实例内存${target < current ? '降到' : '改为'} ${target}M`,
        payload: { versionId: session.versionId, memoryMin: '512M', memoryMax: `${target}M` },
      });
    }
  }
  if (hasInstance && /Java|java|JVM|运行时/.test(text) && /换|改|设置|版本|对不上|不匹配/.test(text)) {
    actions.push({ id: 'java.open', label: '换 Java 运行时' });
  }
  if (hasInstance && /打开.*目录|实例目录/.test(text)) actions.push({ id: 'open.instance', label: '打开实例目录' });
  if (hasInstance && /重新下载.*版本|版本文件/.test(text)) actions.push({ id: 'redownload.version', label: '重新下载版本文件' });
  if (hasInstance && /重新下载.*资源|资源文件/.test(text)) actions.push({ id: 'redownload.resources', label: '重新下载资源文件' });
  if (/server\s*pack|服务端包/i.test(text)) actions.push({ id: 'serverpack.redownload', label: '重新下载 server pack' });
  if (/停用.*mod|禁用.*mod|停用可疑/.test(text)) actions.push({ id: 'mod.disable', label: '停用可疑 mod（需确认）' });
  return actions;
}

function intentCategory(session, message, mode) {
  const detected = detectSymptom(message);
  if (detected !== 'unknown') return detected;
  if (mode === 'diagnostic' || mode === 'analyze') return 'startup';
  if (isTechnicalQuestion(message)) return 'unknown';
  return null;
}

function historyForModel(session) {
  return (Array.isArray(session.messages) ? session.messages : [])
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content }));
}

export async function chatSession({ id, message, mode, diagnosticsState }) {
  const data = readAll();
  const session = data.sessions.find((x) => x.id === id);
  if (!session) throw new Error('会话不存在或已过期');
  const text = String(message ?? '').trim();
  if (!text) throw new Error('消息不能为空');
  if (!Array.isArray(session.messages)) session.messages = [];
  if (!Array.isArray(session.classified)) session.classified = [];

  const category = intentCategory(session, text, mode);
  const diagnostic = Boolean(category);
  let context = String(session.basicContext || session.context || '');
  let candidates = [];
  if (category === 'unknown') {
    const question = '是启动不了，还是联机进不去？';
    session.messages.push({ role: 'user', content: text, at: Date.now() });
    session.messages.push({ role: 'assistant', content: question, at: Date.now() });
    session.messages = session.messages.slice(-MAX_MESSAGES);
    session.updatedAt = Date.now();
    writeAll(data);
    return { sessionId: id, mode: 'diagnostic', category, reply: question, actions: [], messages: session.messages };
  }
  if (diagnostic) {
    context = await collectDiagnostic(session, category, diagnosticsState);
    candidates = buildActions(session);
  }

  const cfg = loadAiConfig();
  let reply = '';
  if (aiHasKey() && cfg.baseURL) {
    const system = diagnostic
      ? `你是《龙族》里的上杉绘梨衣，正在帮 Sakura 排查 Minecraft 问题。说话安静、短，不卖萌。
当前症状类别：${SYMPTOMS[category] || category}。
输出必须包含三段：原因：... / 依据：...（引用一到两条当前类别材料里的具体内容）/ 建议：...（一到两步）。
${category === 'startup' ? `当前实例最大内存：${maxMemoryIn(context) || '未知'}M；系统可用：${availableMemoryIn(context) || '未知'}M。
不要建议把内存改成和当前相同的值。若当前已经 ≤1024M 且日志仍报内存不足，优先建议关掉别的程序、检查 Windows 页面文件，再考虑降到 768M。` : '按联机/下载/整合包/mod/性能对应的材料回答，不要把问题一律归因于内存。'}
我们的实现约束：${IMPLEMENTATION_NOTES}
只输出人话，不输出 JSON 和堆栈。不要编造材料里没有的证据。`
      : `你是《龙族》里的上杉绘梨衣，正在和 Sakura 普通聊天。说话短、轻、安静、有一点自己的态度，不卖萌，不装客服。
可以正常说两三句话；觉得需要时可以反问一句。不要主动分析日志，不要使用「原因 / 依据 / 建议」这类排查标题，不要列步骤。
不要主动提内存、报错、日志或启动问题；只有用户明确问这些时才展开。
当前实例：${session.versionId || '未选择'}。`;
    const ctx = diagnostic
      ? `当前问题的诊断材料（已脱敏）：\n${context}`
      : `会话基本信息：\n${context}`;
    const history = historyForModel(session);
    const first = history.length === 0;
    const messages = [
      { role: 'system', content: system },
      ...(first ? [{ role: 'user', content: ctx }] : []),
      ...history,
      { role: 'user', content: text },
    ];
    try {
      reply = await callAi({ ...cfg, messages, maxTokens: diagnostic ? 1000 : 500 });
      if (diagnostic && !/原因[:：]/.test(reply)) {
        reply = localDiagnosticReply(session, text, candidates, category);
      }
    } catch {
      reply = diagnostic ? localDiagnosticReply(session, text, candidates, category) : localChatReply(text);
    }
  } else {
    reply = diagnostic ? localDiagnosticReply(session, text, candidates, category) : localChatReply(text);
  }
  const actions = diagnostic ? actionsFromReply(reply, session) : [];

  session.messages.push({ role: 'user', content: text, at: Date.now() });
  session.messages.push({ role: 'assistant', content: reply, at: Date.now() });
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.updatedAt = Date.now();
  writeAll(data);
  return { sessionId: id, mode: diagnostic ? 'diagnostic' : 'chat', category: category || 'chat', reply, actions, messages: session.messages };
}
