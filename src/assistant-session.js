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

export function createSession({ gameDir, versionId, lastFailure, logs, launchCommand }) {
  const basicContext = safeBasicContext({ gameDir, versionId, lastFailure, launchCommand });
  const session = {
    id: crypto.randomUUID(),
    gameDir,
    versionId: versionId || '',
    basicContext,
    diagnosticContext: null,
    classified: [],
    hasFailure: Boolean(lastFailure) || /失败上下文：有/.test(basicContext),
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
  const found = [];
  for (const m of String(text || '').matchAll(/-Xmx(\d+)m/gi)) found.push(Number(m[1]));
  for (const m of String(text || '').matchAll(/memoryMax"?\s*[:=]\s*"?(\d+)M/gi)) found.push(Number(m[1]));
  return found.length ? Math.max(...found) : 0;
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

function localDiagnosticReply(session, message, actions) {
  const cmd = String(session.diagnosticContext || session.context || '');
  const mem = maxMemoryIn(cmd);
  const hasInstance = hasInstanceContext(cmd);
  const second = /第二条|第二个|第二个按钮/i.test(String(message));
  if (second && actions[1]) {
    return `第二条是「${actions[1].label}」。它对应上面的问题，点之前会先确认。`;
  }
  if (!hasInstance) {
    return '原因：这次没有读到明确的实例日志，也没看到具体报错。\n依据：没有可用的实例配置、crash-report 或 hs_err 记录。\n建议：把完整启动日志发我，或者先去「版本」页重新检查一次实例文件。';
  }
  if (/OutOfMemoryError|insufficient memory|Native memory allocation|malloc failed|页面文件|内存不足/i.test(cmd) || mem >= 3072) {
    return `原因：内存不足。\n依据：实例最大内存是 ${mem || '较大'}M，日志里有内存分配失败。\n建议：先把最大内存降到 1024M，再启动一次。`;
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

function collectDiagnostic(session) {
  if (session.diagnosticContext) return session.diagnosticContext;
  try {
    session.diagnosticContext = collectContext({
      gameDir: session.gameDir,
      versionId: session.versionId,
      lastFailure: null,
      logs: [],
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
  const actions = actionsFor(Array.isArray(session.classified) ? session.classified : [], { versionId: session.versionId })
    .filter((a) => allowed.has(a.id));
  const has = (id) => actions.some((a) => a.id === id);
  if (!has('memory.set') && maxMemoryIn(context) > 2048) {
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

function isDiagnosticIntent(session, message, mode) {
  if (mode === 'diagnostic' || mode === 'analyze') return true;
  const text = String(message || '');
  const diagWords = /进不去|启动失败|闪退|崩溃|报错|错误日志|日志|crash|hs_err|内存不足|Java 版本|class file|mod 冲突|退出码|卡在|打不开|连不上|无法启动|异常/i;
  if (!diagWords.test(text)) return false;
  if (session.hasFailure || /失败上下文：有/.test(String(session.basicContext || ''))) return true;
  return /进不去|启动失败|闪退|崩溃|报错|日志|hs_err|crash|退出码|内存不足|卡在|打不开|连不上|无法启动/i.test(text);
}

function historyForModel(session) {
  return (Array.isArray(session.messages) ? session.messages : [])
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content }));
}

export async function chatSession({ id, message, mode }) {
  const data = readAll();
  const session = data.sessions.find((x) => x.id === id);
  if (!session) throw new Error('会话不存在或已过期');
  const text = String(message ?? '').trim();
  if (!text) throw new Error('消息不能为空');
  if (!Array.isArray(session.messages)) session.messages = [];
  if (!Array.isArray(session.classified)) session.classified = [];

  const diagnostic = isDiagnosticIntent(session, text, mode);
  let context = String(session.basicContext || session.context || '');
  let actions = [];
  if (diagnostic) {
    context = collectDiagnostic(session);
    actions = buildActions(session);
  }

  const cfg = loadAiConfig();
  let reply = '';
  if (aiHasKey() && cfg.baseURL) {
    const system = diagnostic
      ? `你是《龙族》里的上杉绘梨衣，正在帮 Sakura 排查 Minecraft 启动问题。说话安静、短，不卖萌。
输出必须包含三段：原因：... / 依据：...（引用一到两条日志里的具体内容）/ 建议：...（一到两步）。
只输出人话，不输出 JSON 和堆栈。不要编造日志里没有的证据。`
      : `你是《龙族》里的上杉绘梨衣，正在和 Sakura 普通聊天。说话短、轻、安静，不卖萌。
不要主动分析日志，不要使用「原因 / 依据 / 建议」这类排查标题，不要列一堆步骤。
当前实例：${session.versionId || '未选择'}。只在用户明确问启动问题时才认真展开。`;
    const ctx = diagnostic
      ? `启动上下文快照（已脱敏）：\n${context}`
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
      reply = await callAi({ ...cfg, messages, maxTokens: diagnostic ? 1000 : 220 });
      if (diagnostic && !/原因[:：]/.test(reply)) {
        reply = localDiagnosticReply(session, text, actions);
      }
    } catch {
      reply = diagnostic ? localDiagnosticReply(session, text, actions) : localChatReply(text);
    }
  } else {
    reply = diagnostic ? localDiagnosticReply(session, text, actions) : localChatReply(text);
  }

  session.messages.push({ role: 'user', content: text, at: Date.now() });
  session.messages.push({ role: 'assistant', content: reply, at: Date.now() });
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.updatedAt = Date.now();
  writeAll(data);
  return { sessionId: id, mode: diagnostic ? 'diagnostic' : 'chat', reply, actions, messages: session.messages };
}
