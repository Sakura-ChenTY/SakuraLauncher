/**
 * 插件：让用户自己写一小段 JS 来改启动参数
 *
 * 为什么用 vm 而不是 eval：
 *   插件代码是用户自己写的，但它跑在启动器进程里，能碰到整个文件系统。
 *   用 vm 起一个只有白名单对象的沙箱，至少不会因为一句 require('fs')
 *   就把整个盘读走。这不是绝对隔离（vm 不是安全边界），但足够挡住手滑。
 *
 * 插件能拿到什么：
 *   api.memoryMax / api.memoryMin   设置里的内存字符串，如 '4096M'
 *   api.username                     游戏内玩家名
 *   api.gameVersion / api.loader     当前启动的实例信息
 *   api.instance                     实例名
 *
 * 插件要返回什么：
 *   { extraJvm: string[], extraGame: string[] }
 *   返回别的、或者抛错，都只影响这一个插件，不会拦住启动。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

import { HOME_DIR } from './paths.js';

const PLUGIN_FILE = path.join(HOME_DIR, 'plugins.json');

/** 单个插件执行的上限，防止用户写出死循环把启动卡住 */
const RUN_TIMEOUT_MS = 1500;

const EMPTY = { plugins: [] };

/** 读插件库；文件坏了就当没有，别让启动器起不来 */
export async function loadPlugins() {
  try {
    const raw = await fs.readFile(PLUGIN_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      plugins: Array.isArray(data.plugins)
        ? data.plugins.filter((p) => p && typeof p.code === 'string').map(normalize)
        : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

function normalize(p) {
  return {
    id: String(p.id ?? crypto.randomUUID()),
    name: String(p.name ?? '未命名插件').slice(0, 60),
    code: String(p.code ?? ''),
    enabled: p.enabled !== false,
    createdAt: p.createdAt ?? new Date().toISOString(),
  };
}

async function writePlugins(plugins) {
  await fs.mkdir(HOME_DIR, { recursive: true });
  await fs.writeFile(PLUGIN_FILE, JSON.stringify({ plugins }, null, 2), 'utf8');
}

export async function savePlugin(input) {
  const data = await loadPlugins();
  const plugins = data.plugins;
  const code = String(input.code ?? '');
  if (code.length > 20000) throw new Error('插件代码太长了（上限 20000 字符）');

  const idx = input.id ? plugins.findIndex((p) => p.id === input.id) : -1;
  if (idx >= 0) {
    plugins[idx] = {
      ...plugins[idx],
      name: String(input.name ?? plugins[idx].name).slice(0, 60) || '未命名插件',
      code,
      enabled: input.enabled !== false,
    };
  } else {
    plugins.push(normalize({
      id: crypto.randomUUID(),
      name: String(input.name ?? '未命名插件').slice(0, 60),
      code,
      enabled: true,
    }));
  }

  await writePlugins(plugins);
  return { plugins };
}

export async function deletePlugin(id) {
  const data = await loadPlugins();
  const plugins = data.plugins.filter((p) => p.id !== id);
  await writePlugins(plugins);
  return { plugins };
}

export async function togglePlugin(id, enabled) {
  const data = await loadPlugins();
  const p = data.plugins.find((x) => x.id === id);
  if (!p) throw new Error('找不到这个插件');
  p.enabled = Boolean(enabled);
  await writePlugins(data.plugins);
  return { plugins: data.plugins };
}

/**
 * 跑一个插件的代码，返回它给的参数。
 * 出错就返回空，并把错误带出去给设置页显示 —— 启动流程不能因为插件挂了而停。
 */
export function runPluginCode(code, api) {
  const sandbox = {
    api: Object.freeze({ ...api }),
    // 只给几个纯函数，不给 require / process / 定时器
    console: {
      log: (...a) => {},
      warn: (...a) => {},
      error: (...a) => {},
    },
    JSON: Object.freeze({ parse: JSON.parse, stringify: JSON.stringify }),
    Math: Object.freeze({
      min: Math.min,
      max: Math.max,
      round: Math.round,
      floor: Math.floor,
      ceil: Math.ceil,
      abs: Math.abs,
    }),
    String,
    Number,
    Boolean,
    Array,
    Object,
  };

  let result;
  try {
    const context = vm.createContext(sandbox);
    // 包成函数体，省得用户还要自己写 function
    const script = new vm.Script(`(function(){ ${code}\n})()`);
    result = script.runInContext(context, { timeout: RUN_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, error: e.message, extraJvm: [], extraGame: [] };
  }

  const extraJvm = Array.isArray(result?.extraJvm)
    ? result.extraJvm.map(String).filter(Boolean).slice(0, 50)
    : [];
  const extraGame = Array.isArray(result?.extraGame)
    ? result.extraGame.map(String).filter(Boolean).slice(0, 50)
    : [];

  return { ok: true, extraJvm, extraGame };
}

/**
 * 把所有启用的插件跑一遍，合并它们的参数。
 * 一个插件炸了只记下来，其余照常生效。
 */
export async function collectPluginArgs(api) {
  const { plugins } = await loadPlugins();
  const extraJvm = [];
  const extraGame = [];
  const errors = [];

  for (const p of plugins) {
    if (!p.enabled) continue;
    const r = runPluginCode(p.code, api);
    if (!r.ok) {
      errors.push(`${p.name}: ${r.error}`);
      continue;
    }
    extraJvm.push(...r.extraJvm);
    extraGame.push(...r.extraGame);
  }

  return { extraJvm, extraGame, errors };
}

export { PLUGIN_FILE };
