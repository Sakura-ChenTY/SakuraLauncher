/**
 * 路径：所有「会写入的用户数据」都集中到这里
 *
 * 为什么不能放在程序目录：
 *   装到 C:\Program Files 时普通权限写不进去 —— 设置页点保存没反应、
 *   追更列表重启就丢、Edge 的 --user-data-dir 指到不可写目录窗口都打不开。
 *   所以配置、状态、运行时一律放用户目录，程序目录只留代码。
 *
 * 位置：
 *   Windows  ~/.mclauncher/            （与 accounts.json 一致，不另起炉灶）
 *   可用环境变量 MCLAUNCHER_HOME 覆盖，方便做绿色版/多份隔离测试
 *
 * 迁移：
 *   老版本把 settings.json / tracked.json 写在程序根目录。
 *   首次运行会把它们搬到新位置并留 .migrated 备份，不会丢配置。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 程序目录（只读代码，不写数据） */
export const APP_ROOT = path.join(__dirname, '..');

/** 用户数据目录 */
export const HOME_DIR =
  process.env.MCLAUNCHER_HOME?.trim() ||
  path.join(os.homedir(), '.mclauncher');

export const SETTINGS_FILE = path.join(HOME_DIR, 'settings.json');
export const TRACK_FILE = path.join(HOME_DIR, 'tracked.json');
export const RECENT_FILE = path.join(HOME_DIR, 'recent-play.json');
export const RUNTIME_DIR = path.join(HOME_DIR, 'runtimes');
export const CACHE_DIR = path.join(HOME_DIR, 'cache');
export const JAVA_SCAN_CACHE = path.join(CACHE_DIR, 'java-scan.json');
export const EDGE_PROFILE_DIR = path.join(HOME_DIR, 'ui-profile');

/** 老版本放在程序根目录的文件名 */
const LEGACY = ['settings.json', 'tracked.json'];

/** 确保目录存在；失败返回 false 而不是抛（调用方要能优雅降级） */
export function ensureHome() {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把老版本的配置文件搬到用户目录。
 * 只在目标不存在时才搬，绝不覆盖新位置的配置。
 * 返回搬过的文件名，便于日志/自检。
 */
export function migrateLegacyFiles() {
  const moved = [];
  if (!ensureHome()) return moved;

  for (const name of LEGACY) {
    const from = path.join(APP_ROOT, name);
    const to = path.join(HOME_DIR, name);
    try {
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) {
        // 两个都有：保留新的，老文件改名留证，避免每次启动都重复处理
        fs.renameSync(from, `${from}.migrated`);
        continue;
      }
      fs.copyFileSync(from, to);
      fs.renameSync(from, `${from}.migrated`);
      moved.push(name);
    } catch {
      /* 权限等问题：保持原样，让调用方回退到程序目录读取 */
    }
  }
  return moved;
}

/**
 * 读一个数据文件：优先用户目录，其次老的程序目录。
 * 这样即使迁移失败（比如目录不可写），老用户也还能正常读到自己的配置。
 */
export function readDataFile(name) {
  const primary = path.join(HOME_DIR, name);
  try {
    if (fs.existsSync(primary)) return { path: primary, text: fs.readFileSync(primary, 'utf8') };
  } catch {
    /* 落到备用 */
  }
  const fallback = path.join(APP_ROOT, name);
  try {
    if (fs.existsSync(fallback)) return { path: fallback, text: fs.readFileSync(fallback, 'utf8') };
  } catch {
    /* 没有就是没有 */
  }
  return null;
}

/** 默认游戏目录：跟官方启动器一致，新机器上也能直接找到 */
export function defaultGameDir() {
  if (process.env.MCLAUNCHER_GAME_DIR?.trim()) return process.env.MCLAUNCHER_GAME_DIR.trim();
  return path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
}
