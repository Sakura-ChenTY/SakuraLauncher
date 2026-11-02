/**
 * 安装状态落盘：应用/进程在安装中被结束，下次启动能告诉用户
 * “上次安装被中断”，而不是把半成品当成正常实例。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE = path.join(os.homedir(), '.mclauncher', 'install-state.json');

export function markInstallStart({ versionId, stage = 'start' }) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(
      FILE,
      JSON.stringify({ pid: process.pid, versionId, stage, startedAt: Date.now() }),
      'utf8'
    );
  } catch {
    /* 标记失败不应阻断安装 */
  }
}

export function markInstallEnd() {
  try { fs.rmSync(FILE, { force: true }); } catch { /* 忽略 */ }
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 启动时取一次；发现上次进程已死就返回中断信息并清掉标记 */
export function takeInterruptedInstall() {
  if (!fs.existsSync(FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    fs.rmSync(FILE, { force: true });
    if (pidAlive(data.pid)) return null;
    return {
      versionId: data.versionId ?? '',
      stage: data.stage ?? '',
      startedAt: data.startedAt ?? null,
    };
  } catch {
    try { fs.rmSync(FILE, { force: true }); } catch {}
    return null;
  }
}
