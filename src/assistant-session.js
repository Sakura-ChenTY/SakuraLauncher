/**
 * 绘梨衣小助手会话。
 *
 * 会话开始时收集一次上下文快照，之后只带历史消息，不再反复读日志。
 * 会话落盘到 ~/.mclauncher/assistant-sessions.json，最近 N 轮保留。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { HOME_DIR } from './paths.js';
import {
  collectContext,
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

export function createSession({ gameDir, versionId, lastFailure, logs, launchCommand }) {
  let context = '';
  try { context = collectContext({ gameDir, versionId, lastFailure, logs, launchCommand }); }
  catch (e) { context = `上下文收集失败：${e.message}`; }
  const session = {
    id: crypto.randomUUID(),
    versionId: versionId || '',
    context,
    classified: classifyLogs(context),
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

function localReply(session, message, actions) {
  const cmd = String(session.context || '');
  const memMatches = [];
  for (const m of cmd.matchAll(/-Xmx(\d+)m/gi)) memMatches.push(Number(m[1]));
  for (const m of cmd.matchAll(/memoryMax"?\s*[:=]\s*"?(\d+)M/gi)) memMatches.push(Number(m[1]));
  const mem = memMatches.length ? String(Math.max(...memMatches)) : '';
  const hasInstance = /实例配置|实例覆盖|实际启动命令|java_command/i.test(cmd);
  if (!hasInstance) {
    return '这次没有读到明确的实例日志，也没看到具体报错。你可以把完整启动日志发我，或者先去「版本」页重新检查一次实例文件。';
  }
  const memoryIssue = hasInstance && /OutOfMemoryError|insufficient memory|Native memory allocation|malloc failed|页面文件|内存不足/i.test(cmd);
  const second = /第二条|第二个|第二个按钮/i.test(String(message));
  if (second && actions[1]) {
    return `第二条是「${actions[1].label}」。它对应上面的问题，点之前会先确认。`;
  }
  if (memoryIssue || (mem && Number(mem) >= 3072)) {
    return `看到了，是内存不够。\n实例现在分配了 ${mem ? `${mem}M` : '较大内存'}，机器当时可用内存不够，JVM 在启动阶段就退出了。\n先把最大内存降到 1024M 试试。`;
  }
  if (/UnsupportedClassVersionError|class file version|Java 版本/i.test(cmd)) {
    return '看到了，是 Java 版本对不上。先换到实例要求的 Java，再试一次。';
  }
  if (/NoClassDefFoundError|missing depend|Mod|Mixin/i.test(cmd)) {
    return '看起来是 mod 或前置的问题。先看日志里第一个报错的 mod，必要时先停用它。';
  }
  return '这次没有读到明确的实例日志，也没看到具体报错。你可以把完整启动日志发我，或者先去「版本」页重新检查一次实例文件。';
}

function buildActions(session) {
  if (!/实例配置|实例覆盖|实际启动命令|java_command/i.test(String(session.context || ''))) return [];
  const allowed = new Set([
    'memory.set', 'java.open', 'java.set', 'redownload.version', 'redownload.resources',
    'open.instance', 'mod.disable', 'serverpack.redownload',
  ]);
  const actions = actionsFor(Array.isArray(session.classified) ? session.classified : [], { versionId: session.versionId })
    .filter((a) => allowed.has(a.id));
  const has = (id) => actions.some((a) => a.id === id);
  if (!has('memory.set')) {
    const ms = [];
    const context = String(session.context || '');
    for (const m of context.matchAll(/-Xmx(\d+)m/gi)) ms.push(Number(m[1]));
    for (const m of context.matchAll(/memoryMax"?\s*[:=]\s*"?(\d+)M/gi)) ms.push(Number(m[1]));
    if (ms.length && Math.max(...ms) > 2048) {
      actions.unshift({
        id: 'memory.set',
        label: '把实例内存降到 1024M',
        payload: { versionId: session.versionId, memoryMin: '512M', memoryMax: '1024M' },
      });
    }
  }
  if (!has('java.set')) {
    actions.push({ id: 'java.open', label: '换 Java 运行时' });
  }
  if (!has('open.instance')) {
    actions.push({ id: 'open.instance', label: '打开实例目录' });
  }
  if (!has('redownload.version')) {
    actions.push({ id: 'redownload.version', label: '重新下载版本文件' });
  }
  if (!has('redownload.resources')) {
    actions.push({ id: 'redownload.resources', label: '重新下载资源文件' });
  }
  if (!has('serverpack.redownload')) {
    actions.push({ id: 'serverpack.redownload', label: '重新下载 server pack' });
  }
  if (!has('mod.disable')) {
    actions.push({ id: 'mod.disable', label: '停用可疑 mod（需确认）' });
  }
  const rank = { 'memory.set': 0, 'java.open': 1, 'java.set': 1, 'open.instance': 2, 'redownload.version': 3, 'redownload.resources': 4, 'serverpack.redownload': 5, 'mod.disable': 6 };
  actions.sort((a, b) => (rank[a.id] ?? 99) - (rank[b.id] ?? 99));
  return actions;
}

export async function chatSession({ id, message }) {
  const data = readAll();
  const session = data.sessions.find((x) => x.id === id);
  if (!session) throw new Error('会话不存在或已过期');
  const text = String(message ?? '').trim();
  if (!text) throw new Error('消息不能为空');
  if (!Array.isArray(session.messages)) session.messages = [];
  if (!Array.isArray(session.classified)) session.classified = [];
  const actions = buildActions(session);
  let reply = '';
  if (aiHasKey() && loadAiConfig().baseURL) {
    const system = `你是《龙族》里的上杉绘梨衣，说话短、安静、不卖萌。你在帮 Sakura 排查 Minecraft 启动问题。
只输出人话，不输出堆栈和 JSON。这个会话已经有一份启动上下文快照，不要要求重新读全部日志。
可以追问，也可以回答上下文里的细节。结论后面会由启动器附上可执行动作。
当前动作（按显示顺序）：${actions.map((a, i) => `${i + 1}. ${a.label}`).join('；')}`;
    const ctx = `启动上下文快照（已脱敏）：\n${session.context}`;
    const history = (session.messages ?? []).slice(-8).map((m) => ({ role: m.role, content: m.content }));
    const first = history.length === 0;
    const messages = [
      { role: 'system', content: system },
      ...(first ? [{ role: 'user', content: ctx }] : []),
      ...history,
      { role: 'user', content: text },
    ];
    try {
      reply = await callAi({ ...loadAiConfig(), messages, maxTokens: 1000 });
    } catch (e) {
      reply = `模型暂时没回答（${e.message}）。${localReply(session, text, actions)}`;
    }
  } else {
    reply = localReply(session, text, actions);
  }
  session.messages.push({ role: 'user', content: text, at: Date.now() });
  session.messages.push({ role: 'assistant', content: reply, at: Date.now() });
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.updatedAt = Date.now();
  writeAll(data);
  return { sessionId: id, reply, actions, messages: session.messages };
}
