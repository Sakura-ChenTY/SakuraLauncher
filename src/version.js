/**
 * 版本 JSON 的加载与继承合并
 *
 * 现实里启动器的复杂性有一半在 inheritsFrom：
 * Forge/Fabric/OptiFine 的版本 JSON 只写"差异"，真正完整的定义在父版本里。
 * 这里实现标准合并语义，顺序是：
 *   父版本先落地 -> 子版本覆盖标量 -> libraries 累加去重 -> arguments 拼接
 *
 * 注意：PCL 的实例 JSON 往往已经是合并完的（inheritsFrom 不存在），
 * 这时本模块退化为"只读一次"，不会出错。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 判断同一个库：以 name 为准（group:artifact:version[:classifier]） */
function libKey(lib) {
  return lib?.name ?? JSON.stringify(lib);
}

/** 合并两个版本对象：parent 为底，child 覆盖 */
export function mergeVersion(parent, child) {
  if (!parent) return structuredClone(child);

  const out = { ...structuredClone(parent) };

  for (const [k, v] of Object.entries(child)) {
    if (k === 'libraries' || k === 'arguments') continue;
    if (v !== undefined) out[k] = v;
  }

  // libraries：父在前，子覆盖同名项
  const libs = new Map();
  for (const l of parent.libraries ?? []) libs.set(libKey(l), structuredClone(l));
  for (const l of child.libraries ?? []) libs.set(libKey(l), structuredClone(l));
  out.libraries = [...libs.values()];

  // arguments：jvm/game 分别拼接，子在后
  if (parent.arguments || child.arguments) {
    out.arguments = {
      game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
      jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])],
    };
    if (parent.arguments?.defaultUserJvm || child.arguments?.defaultUserJvm) {
      out.arguments.defaultUserJvm = [
        ...(parent.arguments?.defaultUserJvm ?? []),
        ...(child.arguments?.defaultUserJvm ?? []),
      ];
    }
  }

  delete out.inheritsFrom;
  return out;
}

/**
 * 从 versionsDir 读取指定的版本并递归合并。
 * 返回 { json, jarPath, dir }
 */
export function loadVersion(versionsDir, versionId, seen = new Set()) {
  if (seen.has(versionId)) {
    throw new Error(`版本继承出现环：${[...seen, versionId].join(' -> ')}`);
  }
  seen.add(versionId);

  const dir = path.join(versionsDir, versionId);
  if (!fs.existsSync(dir)) {
    throw new Error(`找不到版本目录：${dir}`);
  }

  // 优先用与目录同名的 json，否则取目录里第一个 json
  let jsonPath = path.join(dir, `${versionId}.json`);
  if (!fs.existsSync(jsonPath)) {
    const cand = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.json'));
    if (!cand.length) throw new Error(`版本目录里没有 json：${dir}`);
    jsonPath = path.join(dir, cand[0]);
  }

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  let merged = raw;
  if (raw.inheritsFrom) {
    const parent = loadVersion(versionsDir, raw.inheritsFrom, seen);
    merged = mergeVersion(parent.json, raw);
    // 继承来的 jar 指向父版本的 jar
    merged.__inheritedJar = parent.jarPath;
  }

  // 定位 client jar
  let jarPath = null;
  const ownJar = path.join(dir, `${versionId}.jar`);
  if (fs.existsSync(ownJar)) jarPath = ownJar;
  else if (merged.__inheritedJar) jarPath = merged.__inheritedJar;

  return { json: merged, jarPath, dir, jsonPath };
}

/** 列出所有可启动实例 */
export function listVersions(versionsDir) {
  if (!fs.existsSync(versionsDir)) return [];
  return fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      const dir = path.join(versionsDir, name);
      const hasJson = fs
        .readdirSync(dir)
        .some((f) => f.toLowerCase().endsWith('.json'));
      return hasJson;
    });
}
