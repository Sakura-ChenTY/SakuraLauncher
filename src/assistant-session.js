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
import { detectSymptom, isTechnicalQuestion, guessSymptom, evidenceSummary, collectSymptomContext, SYMPTOMS, IMPLEMENTATION_NOTES } from './assistant-diagnostics.js';
import { createDiagnosticPackage } from './diagnostic-package.js';

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

function extractPreference(text) {
  const raw = String(text || '').trim();
  if (!/(我想要的是|我要的是|我想要|我要|想要|不想|不要|别|改成|换成|先看|先弄|先做)/i.test(raw)) return '';
  return raw.slice(0, 180);
}

function requestedCategory(text) {
  const s = String(text || '');
  if (/联机|frp|隧道|朋友.*连|房间|端口/i.test(s)) return 'online';
  if (/整合包|modpack|mrpack|server\s*pack|curseforge|modrinth/i.test(s)) return 'modpack';
  if (/资源.*下载|版本.*下载|下载失败|hash|校验|代理/i.test(s)) return 'download';
  if (/mod.*冲突|不兼容|missing depend|duplicate/i.test(s)) return 'mod';
  if (/卡顿|掉帧|性能|lag|tps/i.test(s)) return 'performance';
  if (/(\d{3,4})\s*M|内存|启动|崩溃|闪退|进不去游戏/i.test(s)) return 'startup';
  return '';
}

function requestedMemory(text) {
  const s = String(text || '');
  const m = /(?:改成|换成|降到|调到|设为|设置为|想要|要)\s*(\d{3,4})\s*M/i.exec(s) || /(\d{3,4})\s*M/i.exec(s);
  if (m) return Number(m[1]);
  const g = /(\d+(?:\.\d+)?)\s*G/i.exec(s);
  return g ? Math.round(Number(g[1]) * 1024) : 0;
}

function updatePreferences(session, text) {
  const p = extractPreference(text);
  if (!p) return;
  if (!Array.isArray(session.playerPreferences)) session.playerPreferences = [];
  session.playerPreferences.push(p);
  session.playerPreferences = session.playerPreferences.slice(-6);
}

function preferenceText(session) {
  return (session.playerPreferences || []).slice(-4).join(' / ');
}

function isContinuation(session, category) {
  return Array.isArray(session.explainedCategories) && session.explainedCategories.includes(category);
}


function runtimePromptBlock(snapshot) {
  if (!snapshot) return '';
  const actual = snapshot.ports?.actual;
  const tunnelPort = snapshot.tunnel?.localPort;
  const mismatch = actual && tunnelPort && Number(actual) !== Number(tunnelPort);
  return `
实时运行快照（只读，本次对话生成；不是历史结论）：
${JSON.stringify(snapshot)}
回答前先把这个快照和日志比对；如果快照和日志冲突，以日志里的实际证据为准，并说明冲突。
${mismatch ? `必须直接指出：隧道 local_port=${tunnelPort}，服务器实际监听=${actual}，两者不一致；建议把隧道 local_port 改成 ${actual}。不要等用户提示。` : ''}
噪声规则：401/403、Java 版本提示、mod 版本提醒最多放在最后一段「顺带看到」，不要写成原因或「可能原因」。结论只保留真正导致失败的那一条，并给一句建议。`;
}

function portMismatchReply(snapshot, continuation = false) {
  const actual = snapshot?.ports?.actual;
  const tunnelPort = snapshot?.tunnel?.localPort;
  if (!actual || !tunnelPort || Number(actual) === Number(tunnelPort)) return '';
  return `${continuation ? '接着上面：' : ''}原因：隧道 local_port 和服务器实际监听端口不一致。
依据：隧道 local_port=${tunnelPort}，服务器实际监听=${actual}。
建议：把隧道 local_port 改成 ${actual}，然后重试联机。`;
}

function crashPromptBlock(crashContext) {
  if (!crashContext) return '';
  return `
崩溃材料（来自本次真实退出，不是猜测）：
${JSON.stringify({
    oom: crashContext.oom,
    heapMb: crashContext.heapMb,
    serverHeapMb: crashContext.serverHeapMb,
    memory: crashContext.memory,
    hsErrPath: crashContext.hsErrPath,
    hsErr: String(crashContext.hsErr || '').slice(0, 14000),
  })}
如果 hs_err 是 native malloc 失败：先判断是「提交额度/页面文件不够」还是「堆上限太大」，不要把答案简化成“加内存”。给出具体缺多少、改哪个数。`;
}

function localDiagnosticReply(session, message, actions, category = 'startup', preference = '', continuation = false, runtimeSnapshot = null, crashContext = null) {
  const cmd = String(session.diagnosticContext || session.context || '');
  const mem = maxMemoryIn(cmd);
  const hasInstance = hasInstanceContext(cmd);
  const reqMem = requestedMemory(preference || message);
  const second = /第二条|第二个|第二个按钮/i.test(String(message));
  const noise = [];
  if (/\b401\b|\b403\b/.test(cmd)) noise.push('日志里有 401/403');
  if (/Java 版本|UnsupportedClassVersionError|class file version/i.test(cmd)) noise.push('日志里有 Java 版本提示');
  if (/mod.*版本|版本提醒/i.test(cmd)) noise.push('日志里有 mod 版本提醒');
  const noiseTail = noise.length ? `\n\n顺带看到：${noise.join('；')}。` : '';
  if (category === 'startup' && crashContext?.oom) {
    const mem = crashContext.memory || {};
    const need = (Number(crashContext.heapMb) || 0) + (Number(crashContext.serverHeapMb) || 0) + 2048;
    const headroom = Number(mem.commitLimitMb) && Number(mem.commitUsedMb)
      ? Math.max(0, Number(mem.commitLimitMb) - Number(mem.commitUsedMb)) : null;
    if (headroom != null && headroom < need) {
      const page = mem.pagefileMb ? `${Math.round(mem.pagefileMb / 1024)}GB` : '未知';
      return `原因：提交额度不够，不是单纯物理内存不够。\n依据：崩溃时堆 ${crashContext.heapMb || '?'}M + 服务端 ${crashContext.serverHeapMb || 0}M + 2GB 余量需要约 ${need}M；提交额度只剩 ${headroom}M；页面文件 ${page}。hs_err 是 native malloc 失败。\n建议：先把页面文件调大到至少 ${Math.max(16, Math.ceil((Number(mem.commitUsedMb || 0) + need) / 1024))}GB，再关闭占内存进程；不要只加堆。`;
    }
    if (Number(crashContext.heapMb) >= 4096) {
      return `原因：堆上限偏大，先压缩堆再启动。\n依据：客户端 -Xmx${crashContext.heapMb}M，hs_err 是 native malloc 失败；当前物理可用 ${mem.availableMb ?? '?'}M。\n建议：把客户端堆降到 2048M 或 3072M，再关闭占内存进程。`;
    }
  }
  if ((category === 'online' || /联机|隧道|端口|frp/i.test(String(message))) && runtimeSnapshot?.tunnel?.localPort && runtimeSnapshot?.ports?.actual) {
    const mismatch = portMismatchReply(runtimeSnapshot, continuation);
    if (mismatch) return mismatch;
  }
  if (second && actions[1]) {
    return `第二条是「${actions[1].label}」。它对应上面的问题，点之前会先确认。`;
  }
  if (category === 'startup' && reqMem) {
    const prefix = continuation ? '接着上面说：' : '';
    if (reqMem === mem) {
      return `${prefix}你希望的是 ${reqMem}M，现在实例已经是 ${reqMem}M，所以这个按钮不会改变现状。可以继续看 Java、mod 或日志里的下一条错误。`;
    }
    return `${prefix}你希望把最大内存改成 ${reqMem}M。依据：当前实例是 ${mem || '未知'}M，日志里有内存压力；目标值可以试。建议：按你的方向改成 ${reqMem}M，再启动一次看结果。`;
  }
  if (category === 'startup' && /不要.*内存|不是内存|不想.*内存|别.*内存/.test(preference) && /OutOfMemoryError|insufficient memory|Native memory allocation|malloc failed|页面文件|内存不足/i.test(cmd)) {
    return '先说明证据：日志里确实有内存分配失败，当前实例也已经有内存压力。你不想先动内存，可以走别的路：先换 Java 运行时、检查 mod 冲突，或把最新日志发我，我按这两条继续查。';
  }
  if (category === 'online') {
    const provider = /当前 provider：([^\n]+)/.exec(cmd)?.[1] || '未选择';
    const room = /房间状态：([^\n]+)/.exec(cmd)?.[1] || '未知';
    const frp = /frpc 最近输出：\n([\s\S]*?)(?:\n\n|$)/.exec(cmd)?.[1]?.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') || '无输出';
    const conflict = /不要.*内存|不是内存|不想.*内存|别.*内存/.test(preference);
    const evidence = conflict && session.lastReply
      ? '先说明证据：上一轮看到的是内存分配失败，不是联机隧道报错。\n'
      : '';
    return `${evidence}${continuation ? '接着上面：' : '原因：联机链路没有建立。\n依据：'}provider=${provider}；房间=${room}；frpc=${frp}。\n建议：先确认选中的隧道 local_port 是 25565、frpc 正在运行；再看房间 error 和防火墙是否放行 java/javaw。${noiseTail}`;
  }
  if (category === 'modpack') {
    const err = /房间状态：[^\n]*error=([^\n]+)/.exec(cmd)?.[1] || /error=([^\n]+)/.exec(cmd)?.[1] || '未读到明确 error';
    const sp = /serverPackFileId：([^\n]+)/.exec(cmd)?.[1] || '无';
    return `原因：整合包下载或安装没有完成。\n依据：${err.slice(0, 220)}；serverPackFileId=${sp}。\n建议：先看房间错误里的 HTTP/API 返回；有 serverPackFileId 但下载不到时，把 server-pack.zip 放进服务端目录再开房。`;
  }
  if (category === 'download') {
    const last = /最近失败：([^\n]+)/.exec(cmd)?.[1] || '没有最近的失败摘要';
    return `原因：资源/版本文件下载失败。\n依据：${last.slice(0, 220)}。\n建议：先换下载源再重试一次，检查磁盘空间和代理；还失败就把状态码和 URL 发我。${noiseTail}`;
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
    const prefix = continuation ? '接着上面说：' : '';
    if (mem && mem <= 1024) {
      return `${prefix}内存还是不够。依据：当前实例已经是 ${mem}M，日志里仍有分配失败；系统当时可用约 ${free || '很少'}M。建议：先关掉浏览器/别的游戏，确认 Windows 页面文件没有关闭；还不行再把最大内存降到 768M 试一次。`;
    }
    return `${prefix}内存还是不够。依据：当前实例最大内存是 ${mem || '较大'}M，系统当时可用约 ${free || '很少'}M，日志里有分配失败。建议：先把最大内存从 ${mem || '较大'}M 降到 1024M，并关掉占内存的程序。`;
  }
  if (/UnsupportedClassVersionError|class file version|Java 版本/i.test(cmd)) {
    return `原因：暂时不能确定。\n依据：日志里只有 Java 版本提示，没有更强的失败行。\n建议：先确认实例要求的 Java，再启动一次看真正的第一处报错。\n\n顺带看到：Java 版本提示。`;
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

export async function chatSession({ id, message, mode, diagnosticsState, runtimeSnapshot = null, crashContext = null }) {
  const data = readAll();
  const session = data.sessions.find((x) => x.id === id);
  if (!session) throw new Error('会话不存在或已过期');
  const text = String(message ?? '').trim();
  if (!text) throw new Error('消息不能为空');
  if (!Array.isArray(session.messages)) session.messages = [];
  if (!Array.isArray(session.classified)) session.classified = [];
  updatePreferences(session, text);
  const preference = preferenceText(session);
  const currentPreference = extractPreference(text);
  const preferredCategory = requestedCategory(currentPreference);

  if (/收集诊断|打包诊断|诊断包/i.test(text)) {
    const pkg = await createDiagnosticPackage({
      gameDir: session.gameDir || diagnosticsState?.gameDir,
      versionId: session.versionId,
    });
    const reply = `诊断包打好了。\n${pkg.zipPath}`;
    session.messages.push({ role: 'user', content: text, at: Date.now() });
    session.messages.push({ role: 'assistant', content: reply, at: Date.now() });
    session.messages = session.messages.slice(-MAX_MESSAGES);
    session.updatedAt = Date.now();
    writeAll(data);
    return { sessionId: id, mode: 'package', category: 'package', reply, package: pkg, actions: [], messages: session.messages };
  }
  let category = preferredCategory || intentCategory(session, text, mode);
  let guessed = false;
  const followUp = /(那|接着|然后|继续|接下来|怎么弄|办)/i.test(text);
  if ((!category || category === 'unknown') && followUp && session.lastCategory) category = session.lastCategory;
  if (category === 'unknown') {
    category = guessSymptom(text, diagnosticsState);
    guessed = true;
  }
  const diagnostic = Boolean(category);
  const continuation = diagnostic && session.lastCategory === category && isContinuation(session, category);
  let context = String(session.basicContext || session.context || '');
  let candidates = [];
  if (diagnostic) {
    context = await collectDiagnostic(session, category, diagnosticsState);
    candidates = buildActions(session);
  }

  const cfg = loadAiConfig();
  const runtimeBlock = runtimePromptBlock(runtimeSnapshot);
  const crashBlock = crashPromptBlock(crashContext);
  let reply = '';
  if (aiHasKey() && cfg.baseURL && !currentPreference) {
    const system = diagnostic
      ? `你是《龙族》里的上杉绘梨衣，正在帮 Sakura 排查 Minecraft 问题。说话安静、短，不卖萌。
当前症状类别：${SYMPTOMS[category] || category}。${runtimeBlock}${crashBlock}
玩家在本会话的诉求（最后一条优先）：${preference || '无'}。
${continuation ? '这是同一会话的追问/改口：不要从头复述上一轮原因和依据，只补充这次的新信息。' : ''}
如果玩家改口，按他的新诉求重新排查和换方案，不要固守上一轮；如果诉求和证据冲突，先用一句话说明证据，再给出沿他方向的可行路径，不要只说不行。
输出必须包含三段：原因：... / 依据：...（引用一到两条当前类别材料里的具体内容）/ 建议：...（一到两步）。
${category === 'startup' ? `当前实例最大内存：${maxMemoryIn(context) || '未知'}M；系统可用：${availableMemoryIn(context) || '未知'}M。
不要建议把内存改成和当前相同的值。若当前已经 ≤1024M 且日志仍报内存不足，优先建议关掉别的程序、检查 Windows 页面文件，再考虑降到 768M。` : '按联机/下载/整合包/mod/性能对应的材料回答，不要把问题一律归因于内存。'}
我们的实现约束：${IMPLEMENTATION_NOTES}
只输出人话，不输出 JSON 和堆栈。不要编造材料里没有的证据。`
      : `你是《龙族》里的上杉绘梨衣，正在和 Sakura 普通聊天。说话短、轻、安静、有一点自己的态度，不卖萌，不装客服。
可以正常说两三句话；觉得需要时可以反问一句。不要主动分析日志，不要使用「原因 / 依据 / 建议」这类排查标题，不要列步骤。
不要主动提内存、报错、日志或启动问题；只有用户明确问这些时才展开。
当前实例：${session.versionId || '未选择'}。${runtimeBlock}`;
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
        reply = localDiagnosticReply(session, text, candidates, category, preference, continuation, runtimeSnapshot, crashContext);
      }
    } catch {
      reply = diagnostic ? localDiagnosticReply(session, text, candidates, category, preference, continuation, runtimeSnapshot, crashContext) : localChatReply(text);
    }
  } else {
    reply = diagnostic ? localDiagnosticReply(session, text, candidates, category, preference, continuation, runtimeSnapshot, crashContext) : localChatReply(text);
  }
  // 模型可能忽略快照；端口不一致是确定性事实，必须出现在回答里。
  if (diagnostic && category === 'online' && runtimeSnapshot) {
    const actual = runtimeSnapshot.ports?.actual;
    const tunnelPort = runtimeSnapshot.tunnel?.localPort;
    if (actual && tunnelPort && Number(actual) !== Number(tunnelPort) && !String(reply).includes(String(actual))) {
      reply = `${portMismatchReply(runtimeSnapshot)}\n\n${reply}`;
    }
  }
  const actions = diagnostic ? actionsFromReply(reply, session) : [];
  if (guessed) {
    const evidence = evidenceSummary(category, diagnosticsState);
    if (!/我看到的依据是/.test(reply)) reply += `\n\n我看到的依据是：${evidence}。`;
    reply += '\n\n如果不是这个，把报错原文贴给我。';
  }
  session.lastReply = reply;
  if (diagnostic) {
    if (!Array.isArray(session.explainedCategories)) session.explainedCategories = [];
    if (!session.explainedCategories.includes(category)) session.explainedCategories.push(category);
    session.lastCategory = category;
  }

  session.messages.push({ role: 'user', content: text, at: Date.now() });
  session.messages.push({ role: 'assistant', content: reply, at: Date.now() });
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.updatedAt = Date.now();
  writeAll(data);
  return { sessionId: id, mode: diagnostic ? 'diagnostic' : 'chat', category: category || 'chat', reply, actions, messages: session.messages };
}
