/** 记录一次启动前后的 crash/hs_err 文件，用于判断退出后是否新增。 */
import fs from 'node:fs';
import path from 'node:path';

function dirs(gameDir, versionId) {
  const root = versionId ? path.join(gameDir, 'versions', versionId) : '';
  return [root, gameDir].filter(Boolean);
}

function files(gameDir, versionId) {
  const out = [];
  for (const dir of dirs(gameDir, versionId)) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/^hs_err_pid\d+\.log$/i.test(name)) continue;
        const file = path.join(dir, name);
        const st = fs.statSync(file);
        out.push({ file, key: file, mtime: st.mtimeMs, size: st.size });
      }
    } catch { /* ignore */ }
    try {
      const crashDir = path.join(dir, 'crash-reports');
      for (const name of fs.readdirSync(crashDir)) {
        if (!name.endsWith('.txt')) continue;
        const file = path.join(crashDir, name);
        const st = fs.statSync(file);
        out.push({ file, key: file, mtime: st.mtimeMs, size: st.size });
      }
    } catch { /* ignore */ }
  }
  return out;
}

export function snapshotCrashArtifacts(gameDir, versionId) {
  const map = new Map();
  for (const item of files(gameDir, versionId)) map.set(item.key, { mtime: item.mtime, size: item.size });
  return map;
}

export function newCrashArtifacts(gameDir, versionId, snapshot) {
  const before = snapshot instanceof Map ? snapshot : new Map();
  return files(gameDir, versionId).filter((item) => {
    const old = before.get(item.key);
    return !old || item.mtime > old.mtime || item.size !== old.size;
  }).map((item) => ({ file: item.file, size: item.size }));
}
