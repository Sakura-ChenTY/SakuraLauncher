/**
 * 设置：读写 + 校验
 *
 * 为什么单独一层：
 *   设置要同时被「启动」（内存/Java/玩家名/版本隔离）、
 *   「安装」（并发/镜像）两条链路读取，塞在 server.js 里会到处传参。
 *   放这里做唯一真相，其它模块只读它。
 *
 * 存储位置：用户目录 ~/.mclauncher/settings.json（见 paths.js）
 *   不能再放程序根目录：装到 C:\Program Files 时普通权限写不进去，
 *   会出现「点保存没反应 / 重启丢配置」这类没有任何报错的怪问题。
 *   写入用 tmp + rename，避免断电/崩溃时留下半个 JSON 让启动器起不来。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  SETTINGS_FILE,
  readDataFile,
  ensureHome,
  migrateLegacyFiles,
  defaultGameDir,
} from './paths.js';

export { SETTINGS_FILE };

export const DEFAULTS = {
  gameDir: defaultGameDir(),
  username: 'Player',
  memoryMin: '512M',
  memoryMax: '4096M',
  javaPath: '',
  // Java 策略，学 PCL：默认只认本机已有的 Java，不下载
  //   external = 只用外部 Java，缺了就报错提示用户自己装（体积最小）
  //   auto     = 缺了就自动下载对应版本的 JRE（开箱即用，但多占 ~180MB/版本）
  javaMode: 'auto',
  concurrency: 64,
  downloadSource: 'split', // auto | official | bmclapi | split
  mirrorShare: 50, // split 模式下分给 BMCLAPI 的百分比
  preferMirror: false, // 旧字段，仅为兼容老 settings.json，保存时与 downloadSource 同步
  isolated: 'on', // auto | on | off —— 默认总是隔离，每个实例独立存档与 mod
  extraJvm: '',
  extraGame: '',
  // JVM 参数预设：default / smooth / lowmem。
  jvmPreset: 'default',
  // 内存分配模式：auto = 自动配置，custom = 自定义
  memoryMode: 'auto',
  // 启动前是否执行内存优化（由后续启动流程决定具体动作）
  memoryOptimize: false,
  autoBackup: false,
  autoBackupBeforeLaunch: true,
  autoBackupAfterExit: true,
  autoBackupKeep: 5,
  autoDiagnostic: true,
  // 开房间内存；0 表示按原版 2048 / CurseForge 3072 自动取默认
  roomMemoryMb: 0,
  // 界面不透明度（百分比）。数值越大越不透明；30 = 几乎全透，90 = 接近实心。
  // 前端把它当成 --glass-alpha 写进 CSS，亚克力与贴壁纸两种模式共用。
  glassOpacity: 42,
  updateUrl: 'https://gh-proxy.com/https://github.com/Sakura-ChenTY/SakuraLauncher/releases/latest/download/latest.yml',
};

import { VALID_SOURCE_SETTINGS } from './sources.js';

/** JVM 参数预设；用户手填的 extraJvm 会排在这些参数之后。 */
export const JVM_PRESETS = Object.freeze({
  default: [],
  smooth: ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50', '-XX:G1NewSizePercent=20'],
  lowmem: ['-XX:+UseSerialGC', '-XX:MaxHeapFreeRatio=40', '-XX:MinHeapFreeRatio=10'],
});

export function jvmPresetArgs(value) {
  return [...(JVM_PRESETS[value] ?? JVM_PRESETS.default)];
}

/** 内存值：512M / 2048M / 4G / 6144（裸数字按 MB 处理） */
const MEMORY_RE = /^\d{1,5}([MG])?$/i;

/** 统一成 512M / 4G 这种带单位的写法，避免后端和前端各猜一次 */
export function normalizeMemoryValue(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (!MEMORY_RE.test(s)) return null;
  return /[MG]$/.test(s) ? s : `${s}M`;
}

/** 校验并收敛，返回 { value, changed }；非法项回退到 base（即上一次的值），不是硬回默认 */
export function normalize(raw = {}, base = DEFAULTS) {
  const out = { ...DEFAULTS, ...base };
  const notes = [];

  if (typeof raw.gameDir === 'string' && raw.gameDir.trim()) {
    out.gameDir = raw.gameDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  }
  if (typeof raw.username === 'string' && raw.username.trim()) {
    // 玩家名限制：字母数字下划线，3-16 位（离线模式服务端也按这个校验）
    const name = raw.username.trim();
    if (/^[A-Za-z0-9_]{1,16}$/.test(name)) out.username = name;
    else notes.push('玩家名只能用字母/数字/下划线，最多 16 位，已保留原值');
  }
  for (const key of ['memoryMin', 'memoryMax']) {
    const v = normalizeMemoryValue(raw[key]);
    if (v) out[key] = v;
    else if (raw[key] !== undefined) notes.push(`${key} 格式应为 512M / 4G / 6144，已保留原值`);
  }
  if (typeof raw.javaPath === 'string') out.javaPath = raw.javaPath.trim().replace(/\\/g, '/');

  if (typeof raw.updateUrl === 'string') {
    const u = raw.updateUrl.trim();
    if (!u) out.updateUrl = DEFAULTS.updateUrl;
    else if (/^https:\/\/ghfast\.top\/https:\/\/github\.com\//i.test(u)) {
      out.updateUrl = u.replace(/^https:\/\/ghfast\.top\//i, 'https://gh-proxy.com/');
    } else if (/^https?:\/\/.+/i.test(u)) {
      // 旧配置里写的是 latest.json；当前发布只保留 electron-builder 的 latest.yml。
      out.updateUrl = u.replace(/latest\.json(?=([?#]|$))/i, 'latest.yml');
    } else notes.push('更新地址必须是 http(s) 的 latest.yml');
  }

  if (['external', 'auto'].includes(raw.javaMode)) out.javaMode = raw.javaMode;
  else if (raw.javaMode !== undefined) notes.push('javaMode 只能是 external / auto，已保留原值');

  const n = Number(raw.concurrency);
  if (Number.isFinite(n) && n >= 1 && n <= 256) out.concurrency = Math.floor(n);
  else if (raw.concurrency !== undefined) notes.push('并发数需在 1-256，已保留原值');

  // ---- 下载源 ----
  // 新字段 downloadSource 为准；旧字段 preferMirror 仅在未提供新字段时用来推断
  if (VALID_SOURCE_SETTINGS.includes(raw.downloadSource)) {
    out.downloadSource = raw.downloadSource;
  } else if (typeof raw.preferMirror === 'boolean') {
    out.downloadSource = raw.preferMirror ? 'bmclapi' : 'auto';
  } else if (raw.downloadSource !== undefined) {
    notes.push('下载源只能是 auto / official / bmclapi，已保留原值');
  }
  // 旧字段始终与主字段同步，避免两处不一致造成误解
  out.preferMirror = out.downloadSource === 'bmclapi';

  const mirrorShare = Number(raw.mirrorShare);
  if (Number.isFinite(mirrorShare) && mirrorShare >= 0 && mirrorShare <= 100) out.mirrorShare = Math.round(mirrorShare);
  else if (raw.mirrorShare !== undefined) notes.push('分流比例需在 0-100，已保留原值');

  if (['auto', 'on', 'off'].includes(raw.isolated)) out.isolated = raw.isolated;

  if (typeof raw.extraJvm === 'string') out.extraJvm = raw.extraJvm.slice(0, 2000);
  if (['auto', 'custom'].includes(raw.memoryMode)) out.memoryMode = raw.memoryMode;
  else if (raw.memoryMode !== undefined) notes.push('memoryMode 只能是 auto / custom，已保留原值');
  if (typeof raw.memoryOptimize === 'boolean') out.memoryOptimize = raw.memoryOptimize;
  if (typeof raw.autoBackup === 'boolean') out.autoBackup = raw.autoBackup;
  if (typeof raw.autoBackupBeforeLaunch === 'boolean') out.autoBackupBeforeLaunch = raw.autoBackupBeforeLaunch;
  if (typeof raw.autoBackupAfterExit === 'boolean') out.autoBackupAfterExit = raw.autoBackupAfterExit;
  const autoKeep = Number(raw.autoBackupKeep);
  if (Number.isFinite(autoKeep) && autoKeep >= 1 && autoKeep <= 50) out.autoBackupKeep = Math.floor(autoKeep);
  else if (raw.autoBackupKeep !== undefined) notes.push('自动备份保留份数需在 1-50，已保留原值');
  if (typeof raw.autoDiagnostic === 'boolean') out.autoDiagnostic = raw.autoDiagnostic;
  if (raw.roomMemoryMb !== undefined) {
    const n = Number(raw.roomMemoryMb);
    if (n === 0 || (Number.isFinite(n) && n >= 256 && n <= 16384)) out.roomMemoryMb = Math.round(n);
    else notes.push('开房内存需在 256-16384 MB，已保留原值');
  }
  if (Object.prototype.hasOwnProperty.call(JVM_PRESETS, raw.jvmPreset)) {
    out.jvmPreset = raw.jvmPreset;
  } else if (raw.jvmPreset !== undefined) {
    notes.push('JVM 预设只能是 default / smooth / lowmem，已保留原值');
  }
  if (typeof raw.extraGame === 'string') out.extraGame = raw.extraGame.slice(0, 2000);

  // 界面不透明度：30-90 的整数百分比。超出范围就回退到原值，
  // 不静默改写 —— 用户拖到边上卡住值比"神秘变成 46"好理解。
  if (raw.glassOpacity !== undefined) {
    const g = Number(raw.glassOpacity);
    if (Number.isFinite(g) && g >= 30 && g <= 90) out.glassOpacity = Math.round(g);
    else notes.push('界面透明度需在 30-90 之间，已保留原值');
  }

  // 最小内存不能大于最大，否则 JVM 直接拒绝启动
  const toMb = (s) => {
    const v = String(s ?? '').trim().toUpperCase();
    return v.endsWith('G') ? Number(v.slice(0, -1)) * 1024 : Number(v.replace(/M$/, ''));
  };
  if (toMb(out.memoryMin) > toMb(out.memoryMax)) {
    out.memoryMin = out.memoryMax;
    notes.push('初始内存大于最大内存，已拉平到最大内存');
  }

  return { value: out, notes };
}

let cache = null;

/** 读设置（带内存缓存；文件不存在就写一份默认的） */
export function getSettings() {
  if (cache) return cache;

  // 老版本把配置写在程序目录，先搬到用户目录（失败则读备用位置）
  migrateLegacyFiles();

  const found = readDataFile('settings.json');
  if (found) {
    try {
      cache = normalize(JSON.parse(found.text)).value;
      return cache;
    } catch {
      /* 损坏的 JSON 不要直接抛：先备份再重建，否则启动器再也起不来 */
      try {
        fs.renameSync(found.path, `${found.path}.bad-${Date.now()}`);
      } catch {
        /* 备份失败也不阻断 */
      }
    }
  }

  cache = { ...DEFAULTS };
  // 首次运行落盘，方便用户直接改文件
  void saveSettings(cache).catch(() => {});
  return cache;
}

/** 写设置：校验 -> 原子替换 -> 更新缓存 */
export async function saveSettings(patch) {
  const merged = { ...getSettings(), ...(patch ?? {}) };
  // 以当前设置为底：某个字段非法时保留原值，而不是把用户之前的配置一起冲掉
  const { value, notes } = normalize(merged, getSettings());

  ensureHome();
  const tmp = `${SETTINGS_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, SETTINGS_FILE);

  cache = value;
  return { value, notes };
}

/** 重启后是否还有效：内存值必须能被 JVM 接受，这里给它统一成小写 m */
export function memoryArgs(s) {
  return [`-Xms${s.memoryMin.toLowerCase()}`, `-Xmx${s.memoryMax.toLowerCase()}`];
}

/** 额外参数按空白切分；保留引号内的空格（-Dfoo="a b" 这种） */
export function splitArgs(text) {
  if (!text) return [];
  return text.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? [];
}
