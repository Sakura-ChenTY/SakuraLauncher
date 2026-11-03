/**
 * 崩溃诊断一键打包：只在本地读文件、脱敏、写 zip，不上传。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { HOME_DIR } from './paths.js';
import { getSettings } from './settings.js';
import { redact } from './ai.js';
import { writeZip } from './zipwrite.js';

const OUT_DIR = path.join(HOME_DIR, 'diagnostic-packages');
const MAX_LOG = 60000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function tail(file, maxBytes = MAX_LOG) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, st.size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

function newest(dir, re) {
  try {
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (!re.test(name)) continue;
      const file = path.join(dir, name);
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
    return best?.file || '';
  } catch { return ''; }
}

function accountNames() {
  const data = readJson(path.join(HOME_DIR, 'accounts.json'));
  return (data?.accounts || []).map((a) => String(a?.name || '')).filter((n) => n.length >= 2);
}

export function sanitizeDiagnostic(text) {
  let out = redact(String(text ?? ''));
  out = out.replace(/"(access[_-]?token|refresh[_-]?token|uuid|password|passwd|api[_-]?key|token)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>');
  out = out.replace(/--uuid\s+\S+/gi, '--uuid ***');
  out = out.replace(/--accessToken\s+\S+/gi, '--accessToken ***');
  out = out.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<token>');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer ***');
  for (const name of accountNames()) out = out.split(name).join('<account>');
  return out;
}

function instanceFiles(gameDir, versionId) {
  const root = versionId ? path.join(gameDir, 'versions', versionId) : '';
  const crashDirs = [root, gameDir].filter(Boolean).map((d) => path.join(d, 'crash-reports'));
  let crash = '';
  for (const dir of crashDirs) {
    const hit = newest(dir, /\.txt$/i);
    if (hit && (!crash || fs.statSync(hit).mtimeMs > fs.statSync(crash).mtimeMs)) crash = hit;
  }
  let hs = '';
  for (const dir of [root, gameDir].filter(Boolean)) {
    const hit = newest(dir, /^hs_err_pid\d+\.log$/i);
    if (hit && (!hs || fs.statSync(hit).mtimeMs > fs.statSync(hs).mtimeMs)) hs = hit;
  }
  return { root, crash, hs };
}

export function previewDiagnosticPackage({ gameDir, versionId }) {
  const dirs = instanceFiles(gameDir, versionId);
  const candidates = [];
  const launcherLog = path.join(HOME_DIR, 'logs', 'launcher.log');
  for (const [key, label, file] of [
    ['launcher-log', '启动器日志尾部', launcherLog],
    ['crash-report', '最新 crash-report', dirs.crash],
    ['hs-err', '最新 hs_err', dirs.hs],
  ]) {
    if (!file || !fs.existsSync(file)) continue;
    const st = fs.statSync(file);
    candidates.push({ key, label, file, name: path.basename(file), size: st.size });
  }
  candidates.push({ key: 'instance-info', label: '当前实例配置（脱敏文本）', file: null, name: 'instance-info.txt', size: null });
  candidates.push({ key: 'manifest', label: '文件清单 / 脱敏说明', file: null, name: 'manifest.json', size: null });
  return {
    gameDir: sanitizeDiagnostic(gameDir || ''),
    versionId: versionId || '',
    outputDir: OUT_DIR,
    files: candidates,
    redaction: [
      'accessToken / refreshToken / token / password / apiKey',
      'uuid 以及 --uuid 参数',
      '账号名、邮箱、用户目录',
    ],
    note: '只在本机生成 zip，不上传。',
  };
}

function instanceInfo(gameDir, versionId) {
  const v = readJson(path.join(gameDir, 'versions', versionId, `${versionId}.json`)) || {};
  const override = readJson(path.join(gameDir, 'versions', versionId, 'launcher-instance.json')) || {};
  const settings = getSettings();
  const lines = [
    `收集时间：${new Date().toISOString()}`,
    `游戏目录：${sanitizeDiagnostic(gameDir || '')}`,
    `实例：${versionId || '未选择'}`,
    `版本 JSON：id=${v.id ?? versionId ?? ''} inheritsFrom=${v.inheritsFrom ?? ''} mainClass=${v.mainClass ?? ''}`,
    `版本要求 Java：${v.javaVersion?.majorVersion ?? '?'}`,
    `实例覆盖：${sanitizeDiagnostic(JSON.stringify(override))}`,
    `设置 Java 路径：${sanitizeDiagnostic(override.javaPath || settings.javaPath || '自动')}`,
    `Java 模式：${settings.javaMode || 'auto'}`,
    `设置内存：${override.memoryMin || settings.memoryMin || '?'} / ${override.memoryMax || settings.memoryMax || '?'}`,
  ];
  return sanitizeDiagnostic(lines.join('\n'));
}

export async function createDiagnosticPackage({ gameDir, versionId }) {
  const preview = previewDiagnosticPackage({ gameDir, versionId });
  const dirs = instanceFiles(gameDir, versionId);
  const entries = [];
  const manifest = { createdAt: new Date().toISOString(), versionId: versionId || '', files: [], redaction: preview.redaction, note: 'local only; no upload' };
  const add = (name, data) => {
    const clean = sanitizeDiagnostic(data);
    entries.push({ name, data: clean });
    manifest.files.push({ name, bytes: Buffer.byteLength(clean) });
  };
  const launcherLog = path.join(HOME_DIR, 'logs', 'launcher.log');
  if (fs.existsSync(launcherLog)) add('launcher.log', tail(launcherLog));
  if (dirs.crash) add('crash-report.txt', tail(dirs.crash, 120000));
  if (dirs.hs) add('hs_err.log', tail(dirs.hs, 180000));
  add('instance-info.txt', instanceInfo(gameDir, versionId));
  // manifest 是本模块生成的结构化清单，不能再把说明文字当日志做 --uuid 替换。
  entries.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const zipPath = path.join(OUT_DIR, `Sakura-Diagnostics-${stamp}.zip`);
  writeZip(zipPath, entries);
  const files = manifest.files.concat([{ name: 'manifest.json', bytes: Buffer.byteLength(JSON.stringify(manifest, null, 2)) }]);
  return { zipPath, outputDir: OUT_DIR, versionId: versionId || '', files, redaction: preview.redaction };
}
