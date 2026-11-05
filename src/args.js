import { allows } from './rules.js';

/**
 * 命令行参数构建
 *
 * 版本 JSON 的 arguments 是"字符串或带 rules 的对象"混合数组，
 * 必须先按规则过滤、再展开、最后统一做占位符替换。
 * 顺序错了就会把规则对象当参数传给 java（真实崩溃现场）。
 */

/** 从混合数组里取出实际生效的参数（已展开成字符串列表） */
export function flattenArguments(rawArgs, ctx) {
  const out = [];
  for (const item of rawArgs ?? []) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      if (!allows(item.rules, ctx)) continue;
      const v = item.value;
      if (Array.isArray(v)) out.push(...v);
      else if (typeof v === 'string') out.push(v);
    }
  }
  return out;
}

/** 占位符替换：${name} -> 值 */
export function substitute(token, vars) {
  return token.replace(/\$\{([^}]+)\}/g, (whole, key) => {
    const v = vars[key];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** 批量替换，丢弃替换后仍含未解析占位符的参数（避免把字面量喂给 java） */
export function substituteAll(tokens, vars) {
  const out = [];
  const unresolved = [];
  for (const t of tokens) {
    const s = substitute(t, vars);
    if (/\$\{[^}]+\}/.test(s)) unresolved.push(s);
    else out.push(s);
  }
  return { args: out, unresolved };
}

/**
 * 构建完整启动命令。
 * 返回 { javaBin, args, unresolved, missingVars }
 */
export function buildLaunchCommand({ versionJson, javaBin, vars, ctx, jvmBase, extraJvm = [], extraGame = [] }) {
  let jvmRaw = flattenArguments(versionJson.arguments?.jvm, ctx);

  // 1.12 那代没有 arguments.jvm，只有 minecraftArguments。
  // 如果不补 -cp，java 会直接报 “找不到主类 launchwrapper.Launch”。
  if (!jvmRaw.some((t) => t === '-cp' || t === '-classpath')) {
    jvmRaw = ['-cp', '${classpath}', ...jvmRaw];
  }
  if (!jvmRaw.some((t) => typeof t === 'string' && t.includes('java.library.path'))) {
    jvmRaw = ['-Djava.library.path=${natives_directory}', ...jvmRaw];
  }

  let gameRaw = flattenArguments(versionJson.arguments?.game, ctx);
  if (!gameRaw.length && typeof versionJson.minecraftArguments === 'string') {
    gameRaw =
      versionJson.minecraftArguments.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? [];
  }

  const jvm = substituteAll(jvmRaw, vars);
  const game = substituteAll(gameRaw, vars);

  const base = jvmBase ?? ['-Xms512m', '-Xmx4096m'];
  const args = [
    ...base,
    ...extraJvm,
    ...jvm.args,
    versionJson.mainClass,
    ...game.args,
    ...extraGame,
  ];

  return {
    javaBin,
    args,
    unresolved: [...jvm.unresolved, ...game.unresolved],
  };
}

/**
 * 构建启动用的身份变量。
 * 三种账号的来源不同，但最终都要落成 JVM 能读的这几个变量：
 *   离线     token 填 0，user_type=legacy
 *   正版     token 是真 accessToken，user_type=msa，带 xuid
 *   第三方   token 是 yggdrasil 的 accessToken，user_type=mojang
 */
export function buildIdentityVars(account, fallbackName = 'Player', cryptoMod) {
  const acc = account;

  if (!acc || acc.type === 'offline') {
    const name = acc?.name ?? fallbackName;
    return {
      auth_player_name: name,
      auth_uuid: acc?.uuid ?? offlineUuid(name, cryptoMod),
      auth_access_token: '0',
      auth_session: '0',
      auth_xuid: '0',
      clientid: '0',
      user_type: 'legacy',
    };
  }

  if (acc.type === 'microsoft') {
    return {
      auth_player_name: acc.name,
      auth_uuid: acc.uuid,
      auth_access_token: acc.accessToken,
      auth_session: acc.accessToken,
      auth_xuid: acc.xuid ?? '0',
      clientid: acc.clientId ?? '0',
      user_type: 'msa',
    };
  }

  // yggdrasil（LittleSkin 等）
  return {
    auth_player_name: acc.name,
    auth_uuid: acc.uuid,
    auth_access_token: acc.accessToken,
    auth_session: acc.accessToken,
    auth_xuid: '0',
    clientid: '0',
    user_type: 'mojang',
  };
}

export function offlineUuid(name, crypto) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
