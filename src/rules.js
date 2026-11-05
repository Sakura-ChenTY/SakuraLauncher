/**
 * Mojang 规则求值器（rules 数组 -> 允许/拒绝）
 *
 * 语义要点（这是官方规范里最容易写错的地方）：
 *   - rules 为空 / 不存在  -> 允许
 *   - 否则默认拒绝，按顺序遍历，命中的规则用它的 action 覆盖结果
 *   - 最后一条命中规则说了算，不是"有 allow 就允许"
 */

/** 单条规则是否命中当前环境 */
export function ruleMatches(rule, ctx) {
  if (!rule) return false;

  if (rule.os) {
    const { name, arch, version } = rule.os;
    if (name && name !== ctx.os.name) return false;
    if (arch && arch !== ctx.os.arch) return false;
    if (version) {
      let re;
      try {
        re = new RegExp(version);
      } catch {
        return false;
      }
      if (!re.test(ctx.os.version)) return false;
    }
  }

  if (rule.features) {
    for (const [key, expected] of Object.entries(rule.features)) {
      const actual = Boolean(ctx.features?.[key]);
      if (actual !== Boolean(expected)) return false;
    }
  }

  return true;
}

/** 整组 rules 的最终裁决 */
export function allows(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, ctx)) {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

/** 探测本机环境，供规则求值使用 */
export function detectOs() {
  const platform = process.platform;
  const name =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';

  const archMap = { x64: 'x86_64', ia32: 'x86', arm64: 'arm64' };
  const arch = archMap[process.arch] ?? process.arch;

  return {
    name,
    arch,
    version: process.getSystemVersion?.() ?? '',
  };
}
