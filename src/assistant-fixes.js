/**
 * 小助手一键修复：白名单、预览、备份、校验、会话内撤回。
 *
 * 只允许四类动作：
 *   tunnel.localPort / tunnel.restart / server.properties / heap.set
 * 不碰 mods、存档、Java 安装或任意文件删除。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { HOME_DIR } from './paths.js';
import { getSettings } from './settings.js';
import { portFromServerProperties } from './room-port.js';
import {
  setSakuraTunnelLocalPort,
  stopTunnel,
  startTunnel,
  listTunnels,
  onlineSnapshot,
} from './online.js';

const FIXES_FILE = path.join(HOME_DIR, 'assistant-fixes.json');
const BACKUPS_ROOT = path.join(HOME_DIR, 'backups');
const previews = new Map();
const rollbacks = new Map();
const MAX_RECORDS = 50;

// 生产环境用 online.js；测试可注入本地适配器，避免真的去改远端隧道。
const defaultTunnelOps = {
  setSakuraTunnelLocalPort,
  stopTunnel,
  startTunnel,
  listTunnels,
  onlineSnapshot,
};
let tunnelOps = { ...defaultTunnelOps };
export function setAssistantFixOpsForTest(ops = {}) {
  tunnelOps = { ...defaultTunnelOps, ...ops };
}

function intPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function memoryMb(value) {
  const m = /^(\d{1,5})\s*([MG])?$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  return m[2]?.toUpperCase() === 'G' ? Number(m[1]) * 1024 : Number(m[1]);
}

function heapCapMb() {
  return Math.max(1024, Math.min(40960, Math.floor((os.totalmem() / 1024 / 1024) * 0.8)));
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function instanceDir(gameDir, versionId) {
  return versionId ? path.join(gameDir, 'versions', versionId) : gameDir;
}

function fixRecord({ action, before, after, ok, backupDir, error = '' }) {
  const data = readJson(FIXES_FILE, { fixes: [] });
  const list = Array.isArray(data.fixes) ? data.fixes : [];
  list.unshift({
    at: new Date().toISOString(),
    action,
    before,
    after,
    ok: Boolean(ok),
    backupDir,
    ...(error ? { error: String(error).slice(0, 300) } : {}),
  });
  writeJson(FIXES_FILE, { fixes: list.slice(0, MAX_RECORDS) });
}

export function listAssistantFixes(limit = 5) {
  const data = readJson(FIXES_FILE, { fixes: [] });
  return (Array.isArray(data.fixes) ? data.fixes : []).slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));
}

function currentHeapMb(snapshot, gameDir, versionId) {
  const fromSnapshot = Number(snapshot?.launcher?.heapMb);
  if (fromSnapshot) return fromSnapshot;
  const file = path.join(instanceDir(gameDir, versionId), 'launcher-instance.json');
  const override = readJson(file, {});
  return memoryMb(override.memoryMax) || memoryMb(getSettings().memoryMax) || null;
}

function serverPortFile(snapshot, gameDir, versionId, room) {
  const candidates = [
    snapshot?.ports?.serverPropertiesFile,
    room?.serverDir ? path.join(room.serverDir, 'server.properties') : null,
    path.join(instanceDir(gameDir, versionId), 'server.properties'),
  ].filter(Boolean);
  return candidates.find((f) => fs.existsSync(f)) || candidates[1] || candidates[2] || candidates[0];
}

function buildActions({ snapshot, gameDir, versionId, room, includeServerPort = false, serverPort = null, includeRestart = false }) {
  const actions = [];
  const actual = intPort(snapshot?.ports?.actual);
  const tunnel = snapshot?.tunnel ?? {};
  const tunnelPort = intPort(tunnel.localPort);
  if (actual && tunnelPort && actual !== tunnelPort && tunnel.provider === 'sakura' && tunnel.tunnelId) {
    actions.push({
      id: 'tunnel.localPort',
      label: '隧道 local_port',
      before: String(tunnelPort),
      after: String(actual),
      kind: 'tunnel-local-port',
      provider: 'sakura',
      tunnelId: String(tunnel.tunnelId),
    });
  }
  if (includeRestart && tunnel.provider === 'sakura' && tunnel.tunnelId && tunnelPort) {
    actions.push({
      id: 'tunnel.restart',
      label: '重启隧道',
      before: String(tunnelPort),
      after: String(actual || tunnelPort),
      kind: 'tunnel-restart',
      provider: 'sakura',
      tunnelId: String(tunnel.tunnelId),
    });
  }

  if (includeServerPort && intPort(serverPort)) {
    const file = serverPortFile(snapshot, gameDir, versionId, room);
    const before = file ? portFromServerProperties(file) : snapshot?.ports?.serverProperties;
    if (file && intPort(serverPort) !== before) {
      actions.push({
        id: 'server.properties',
        label: 'server.properties 的 server-port',
        before: before ? String(before) : '未设置',
        after: String(intPort(serverPort)),
        kind: 'server-port',
        file,
      });
    }
  }

  const currentHeap = currentHeapMb(snapshot, gameDir, versionId);
  const cap = heapCapMb();
  if (currentHeap && currentHeap <= cap) {
    const target = Math.min(4096, cap);
    if (target !== currentHeap) {
      actions.push({
        id: 'heap.set',
        label: '堆内存',
        before: `${currentHeap}M`,
        after: `${target}M`,
        kind: 'heap',
        targetMb: target,
        file: path.join(instanceDir(gameDir, versionId), 'launcher-instance.json'),
      });
    }
  }
  return actions;
}

export function previewAssistantFixes(args = {}) {
  const actions = buildActions(args);
  if (!actions.length) return { token: null, actions: [], createdAt: Date.now() };
  const token = crypto.randomUUID();
  const preview = {
    token,
    actions,
    versionId: String(args.versionId || ''),
    gameDir: String(args.gameDir || ''),
    createdAt: Date.now(),
  };
  previews.set(token, preview);
  // 预览只活一小会儿，避免旧状态被误用。
  setTimeout(() => previews.delete(token), 5 * 60 * 1000).unref?.();
  return { token, actions, createdAt: preview.createdAt };
}

function safeBackupName(action, index) {
  return `${String(index + 1).padStart(2, '0')}-${action.kind}-${path.basename(action.file || 'state')}`;
}

async function backupForAction(action, dir, index, manifest) {
  await fsp.mkdir(dir, { recursive: true });
  if (action.kind === 'tunnel-local-port' || action.kind === 'tunnel-restart') {
    const file = path.join(dir, `${String(index + 1).padStart(2, '0')}-tunnel.json`);
    const before = { localPort: Number(action.before) || null, status: action.kind === 'tunnel-restart' ? 'restart' : 'set-port' };
    await fsp.writeFile(file, JSON.stringify(before, null, 2), 'utf8');
    manifest.files.push({ file, existed: true, kind: 'tunnel-state' });
    return { file, existed: true, backup: file };
  }
  if (!action.file) return { file: null, existed: false, backup: null };
  const exists = fs.existsSync(action.file);
  const backup = path.join(dir, safeBackupName(action, index));
  if (exists) await fsp.copyFile(action.file, backup);
  manifest.files.push({ file: action.file, backup, existed: exists });
  return { file: action.file, existed: exists, backup };
}

async function verifyAction(action) {
  if (action.kind === 'tunnel-local-port') {
    const list = await tunnelOps.listTunnels('sakura');
    const found = list.find((t) => String(t.id) === String(action.tunnelId));
    return found && Number(found.localPort) === Number(action.after);
  }
  if (action.kind === 'server-port') {
    return portFromServerProperties(action.file) === Number(action.after);
  }
  if (action.kind === 'heap') {
    const data = readJson(action.file, {});
    return memoryMb(data.memoryMax) === Number(String(action.after).replace(/\D/g, ''));
  }
  if (action.kind === 'tunnel-restart') {
    return Boolean(tunnelOps.onlineSnapshot()?.sakura?.running);
  }
  return false;
}

async function runAction(action, backupDir, index, manifest) {
  const backup = await backupForAction(action, backupDir, index, manifest);
  if (action.kind === 'tunnel-local-port') {
    await tunnelOps.setSakuraTunnelLocalPort(action.tunnelId, Number(action.after));
    return { backup, ok: await verifyAction(action) };
  }
  if (action.kind === 'tunnel-restart') {
    await tunnelOps.stopTunnel(action.provider);
    // 如果同一次预览里先修了 local_port，重启必须跟随修复后的端口，不能退回旧值。
    await tunnelOps.startTunnel(action.provider, action.tunnelId, Number(action.after));
    return { backup, ok: await verifyAction(action) };
  }
  if (action.kind === 'server-port') {
    const text = fs.existsSync(action.file) ? fs.readFileSync(action.file, 'utf8') : '';
    const lines = text.split(/\r?\n/);
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*server-port\s*=/.test(lines[i])) {
        lines[i] = `server-port=${action.after}`;
        changed = true;
        break;
      }
    }
    if (!changed) lines.push(`server-port=${action.after}`);
    await fsp.mkdir(path.dirname(action.file), { recursive: true });
    fs.writeFileSync(action.file, lines.join('\n'), 'utf8');
    return { backup, ok: await verifyAction(action) };
  }
  if (action.kind === 'heap') {
    const data = readJson(action.file, {});
    data.memoryMax = `${action.targetMb}M`;
    writeJson(action.file, data);
    return { backup, ok: await verifyAction(action) };
  }
  return { backup, ok: false };
}

export async function applyAssistantFixes({ token, selectedIds = [], snapshot = null }) {
  const preview = previews.get(token);
  if (!preview) throw new Error('预览已过期，请重新点一键修复');
  const ids = Array.isArray(selectedIds) && selectedIds.length
    ? selectedIds
    : preview.actions.map((a) => a.id);
  const actions = preview.actions.filter((a) => ids.includes(a.id));
  if (!actions.length) throw new Error('没有选中可执行项');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACKUPS_ROOT, stamp);
  await fsp.mkdir(backupDir, { recursive: true });
  const manifest = { createdAt: new Date().toISOString(), actions: actions.map((a) => a.id), files: [] };
  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    try {
      // 预览后状态可能变化：执行前再读一遍当前值。
      let unchanged = true;
      if (action.kind === 'tunnel-local-port') {
        unchanged = Number(snapshot?.tunnel?.localPort) === Number(action.before);
      } else if (action.kind === 'tunnel-restart') {
        unchanged = Number(snapshot?.tunnel?.localPort) === Number(action.before);
      } else if (action.kind === 'server-port') {
        unchanged = portFromServerProperties(action.file) === Number(action.before);
      } else if (action.kind === 'heap') {
        unchanged = currentHeapMb(snapshot, preview.gameDir, preview.versionId) === Number(String(action.before).replace(/\D/g, ''));
      }
      if (!unchanged) throw new Error('状态已变化，请重新预览后再执行');
      const { backup, ok } = await runAction(action, backupDir, i, manifest);
      results.push({ ...action, backup: backup.backup, ok });
      fixRecord({ action: action.id, before: action.before, after: action.after, ok, backupDir });
    } catch (e) {
      results.push({ ...action, ok: false, error: e.message });
      fixRecord({ action: action.id, before: action.before, after: action.after, ok: false, backupDir, error: e.message });
    }
  }
  writeJson(path.join(backupDir, 'manifest.json'), manifest);
  const allOk = results.every((r) => r.ok);
  if (allOk) {
    const rollbackId = crypto.randomUUID();
    rollbacks.set(rollbackId, { actions, backupDir, manifest });
    return { ok: true, backupDir, results, rollbackId };
  }
  return { ok: false, backupDir, results, rollbackId: null };
}

async function restoreBackup(entry) {
  if (!entry?.file) return;
  if (entry.existed && entry.backup && fs.existsSync(entry.backup)) {
    await fsp.mkdir(path.dirname(entry.file), { recursive: true });
    await fsp.copyFile(entry.backup, entry.file);
  }
}

export async function rollbackAssistantFixes(rollbackId) {
  const session = rollbacks.get(rollbackId);
  if (!session) throw new Error('撤回已过期（只在本次会话内可用）');
  const actions = [...session.actions].reverse();
  const results = [];
  for (const action of actions) {
    try {
      if (action.kind === 'tunnel-local-port') {
        await tunnelOps.setSakuraTunnelLocalPort(action.tunnelId, Number(action.before));
        results.push({ action: action.id, ok: await verifyAction({ ...action, after: action.before }) });
      } else if (action.kind === 'tunnel-restart') {
        await tunnelOps.stopTunnel(action.provider);
        await tunnelOps.startTunnel(action.provider, action.tunnelId, Number(action.before));
        results.push({ action: action.id, ok: Boolean(tunnelOps.onlineSnapshot()?.sakura?.running) });
      } else if (action.kind === 'server-port' || action.kind === 'heap') {
        const entry = session.manifest.files.find((f) => f.file === action.file);
        await restoreBackup(entry);
        results.push({ action: action.id, ok: true });
      } else {
        results.push({ action: action.id, ok: false });
      }
    } catch (e) {
      results.push({ action: action.id, ok: false, error: e.message });
    }
  }
  rollbacks.delete(rollbackId);
  return { ok: results.every((r) => r.ok), results };
}
