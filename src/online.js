/**
 * 联机：SakuraFrp / OpenFrp 的隧道列表 + frpc 托管。
 *
 * 关键点：
 *   - token 只进 secure.js，不写日志、不进 /api/state
 *   - frpc 只从官方接口拿地址，下载后校验（Sakura 用 MD5+版本号）
 *   - 启动用环境变量/参数，避免把 token 拼进我们自己的日志
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

import { getToken, setToken } from './secure.js';

const SAKURA = 'https://api.natfrp.com/v4';
const OPENFRP = 'https://api.openfrp.net';
const UA = 'SakuraLauncher/0.4.0 (Node.js)';
const TOOLS_ROOT = 'D:\\Tools\\SakuraLauncher\\frpc';

const sessions = {
  sakura: { proc: null, address: '', ipAddress: '', tunnelId: null, lines: [], error: '' },
  openfrp: { proc: null, address: '', ipAddress: '', tunnelId: null, lines: [], error: '' },
  custom: { proc: null, address: '', ipAddress: '', tunnelId: null, lines: [], error: '', configPath: '' },
};
const tunnelCache = { sakura: null, openfrp: null };

function providerName(p) {
  return p === 'sakura' ? 'SakuraFrp' : p === 'openfrp' ? 'OpenFrp' : p;
}

async function fetchJson(url, { token, timeout = 15000, method = 'GET', body, form } = {}) {
  const headers = { 'user-agent': UA, accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(
      Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
    ).toString();
  } else if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: ac.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = typeof data === 'object' && data ? data.msg ?? data.message ?? JSON.stringify(data).slice(0, 200) : String(text).slice(0, 200);
      throw new Error(`[${res.status}] ${msg || '请求失败'}`);
    }
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeout / 1000)}s）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRemote(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (t.host && t.port) return `${t.host}:${t.port}`;
  if (t.address && t.port) return `${t.address}:${t.port}`;
  return '';
}

function normalizeSakuraTunnel(t, nodeMap = {}) {
  const node = nodeMap[String(t.node)] || null;
  const host = node?.host ?? '';
  const rawRemote = String(t.remote ?? t.export ?? '').trim();
  const remote = /^\d+$/.test(rawRemote) && host ? `${host}:${rawRemote}` : rawRemote;
  return {
    id: String(t.id ?? ''),
    name: t.name ?? `隧道 ${t.id ?? ''}`,
    node: host || t.node || '',
    type: t.type ?? '',
    localPort: Number(t.local_port ?? 0) || null,
    address: remote || normalizeRemote(t.remote) || normalizeRemote(t.export),
    online: Boolean(t.online),
    status: t.status ?? '',
    statusReason: t.status_reason ?? '',
  };
}

function normalizeOpenFrpTunnel(t) {
  let address = t.connectAddress ?? '';
  if (address && !address.includes(':') && t.remotePort) address = `${address}:${t.remotePort}`;
  if (!address && t.remote) address = String(t.remote);
  return {
    id: String(t.id ?? ''),
    name: t.proxyName ?? `隧道 ${t.id ?? ''}`,
    node: t.friendlyNode ?? '',
    type: t.proxyType ?? '',
    localPort: Number(t.localPort ?? 0) || null,
    address,
    online: Boolean(t.online),
    status: t.status ? 'active' : 'disabled',
    statusReason: '',
  };
}

export async function listTunnels(provider) {
  const token = getToken(provider);
  if (!token) throw new Error('还没有保存 token');
  return listTunnelsWithToken(provider, token);
}

async function listTunnelsWithToken(provider, token) {
  if (provider === 'sakura') {
    const [data, nodesData] = await Promise.all([
      fetchJson(`${SAKURA}/tunnels`, { token }),
      fetchJson(`${SAKURA}/nodes`, { token }).catch(() => null),
    ]);
    const nodeMap = {};
    for (const [id, node] of Object.entries(nodesData ?? {})) nodeMap[id] = node;
    const list = Array.isArray(data) ? data : data?.tunnels ?? [];
    const tunnels = list.map((t) => normalizeSakuraTunnel(t, nodeMap)).filter((x) => x.id);
    tunnelCache.sakura = tunnels;
    return tunnels;
  }

  if (provider === 'openfrp') {
    const data = await fetchJson(`${OPENFRP}/api?action=getallproxies&user=${encodeURIComponent(token)}`);
    const groups = Array.isArray(data?.data) ? data.data : [];
    const tunnels = groups.flatMap((g) => (g.proxies ?? []).map(normalizeOpenFrpTunnel)).filter((x) => x.id);
    tunnelCache.openfrp = tunnels;
    return tunnels;
  }

  throw new Error('未知联机服务');
}

export function cachedTunnels(provider) {
  return tunnelCache[provider] ?? [];
}

export async function listNodes(provider) {
  if (provider !== 'sakura') throw new Error('OpenFrp 创建隧道需要网页登录一次');
  const token = getToken(provider);
  if (!token) throw new Error('还没有保存 token');
  const data = await fetchJson(`${SAKURA}/nodes`, { token });
  const list = Array.isArray(data) ? data : Object.entries(data ?? {}).map(([id, v]) => ({ id, ...v }));
  return list
    .filter((n) => n && n.id != null)
    .map((n) => ({
      id: Number(n.id),
      name: n.name ?? `节点 ${n.id}`,
      flag: Number(n.flag ?? 0),
      online: n.online !== false,
    }))
    .filter((n) => n.online);
}

export async function createTunnel(provider, { name, localPort }) {
  if (provider !== 'sakura') {
    throw new Error('OpenFrp 创建隧道需要先在其网页登录一次；当前只能启动已有隧道');
  }
  const token = getToken(provider);
  if (!token) throw new Error('还没有保存 token');
  const nodes = await listNodes(provider);
  if (!nodes.length) throw new Error('没有可用节点');
  // 公开游戏服务器必须用多线节点；自家小圈子用第一个在线节点即可。
  const node = nodes.find((n) => (n.flag & 2048) !== 0 || /多线/.test(n.name)) ?? nodes[0];
  const tunnelName = String(name || '').trim() || `sakura-mc-${Date.now()}`;
  if (!/^[\w.-]{1,32}$/.test(tunnelName)) {
    throw new Error('隧道名只能用字母/数字/下划线/点/横线，最多 32 位');
  }
  const data = await fetchJson(`${SAKURA}/tunnels`, {
    token,
    method: 'POST',
    body: {
      name: tunnelName,
      type: 'tcp',
      node: node.id,
      local_ip: '127.0.0.1',
      local_port: Number(localPort) || 25565,
    },
  });
  tunnelCache.sakura = null;
  return data;
}

export async function saveProviderToken(provider, token) {
  const clean = String(token ?? '').trim();
  if (!clean) throw new Error('token 不能为空');
  // 先验证，再落盘；token 错了不能把上一次可用的 token 覆盖掉
  const tunnels = await listTunnelsWithToken(provider, clean);
  await setToken(provider, clean);
  if (provider === 'sakura') await setToken('sakura_account', '');
  return { ok: true, tunnels };
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function download(url, dest, { md5, size, timeout = 180000 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const ws = fs.createWriteStream(part, { mode: 0o755 });
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
    }
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    if (size && bytes !== size) throw new Error(`大小不对：期望 ${size}，实际 ${bytes}`);
    if (md5 && (await md5File(part)).toLowerCase() !== String(md5).toLowerCase()) {
      throw new Error('MD5 校验失败');
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(part, dest);
    return { bytes };
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function probeFrpc(exe) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(exe, ['-V'], { windowsHide: true });
    } catch {
      return finish('');
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(out); }, 8000);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

let frpcCache = null;

/** 探测本机已有 frpc：PATH、D:\Tools、SakuraFrp 安装目录、APPDATA 线索 */
export async function detectFrpc() {
  if (frpcCache) return frpcCache;
  const candidates = [];
  const add = (p, source) => {
    if (p && fs.existsSync(p) && !candidates.some((x) => x.path.toLowerCase() === p.toLowerCase())) {
      candidates.push({ path: p, source });
    }
  };

  try {
    const out = execFileSync('where.exe', ['frpc'], { windowsHide: true, encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) add(line.trim(), 'PATH');
  } catch { /* 没在 PATH */ }

  add(path.join(TOOLS_ROOT, 'sakura', 'frpc.exe'), 'SakuraLauncher');
  add(path.join(TOOLS_ROOT, 'openfrp', 'frpc.exe'), 'SakuraLauncher');
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'SakuraFrp'),
    path.join(process.env.APPDATA || '', 'SakuraFrp'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'SakuraFrp'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SakuraFrp'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SakuraFrpLauncher'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'SakuraFrp'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'SakuraFrpLauncher'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'SakuraFrpService'),
    'D:\\Tools\\SakuraFrp',
    'D:\\Tools\\SakuraFrpLauncher',
    'D:\\Tools\\SakuraFrp\\frpc',
  ];
  for (const root of roots) {
    add(path.join(root, 'frpc.exe'), root);
    add(path.join(root, 'frpc', 'frpc.exe'), root);
  }

  // 只在 D:\Tools 下浅扫三层，避免全盘搜索
  try {
    const scan = (dir, depth) => {
      if (depth < 0) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isFile() && /^frpc(?:_.*)?(?:\.exe)?$/i.test(e.name)) add(p, 'D:\\Tools');
        else if (e.isDirectory() && depth > 0) scan(p, depth - 1);
      }
    };
    scan('D:\\Tools', 3);
  } catch { /* 忽略 */ }

  const configs = [];
  for (const root of roots) {
    for (const name of ['frpc.toml', 'frpc.ini']) {
      const p = path.join(root, name);
      if (fs.existsSync(p)) configs.push(p);
    }
  }

  const list = [];
  for (const c of candidates.slice(0, 20)) {
    const ver = await probeFrpc(c.path);
    list.push({
      path: c.path,
      source: c.source,
      valid: Boolean(ver.trim()),
      version: ver.trim().split(/\r?\n/)[0] || '',
      sakura: /sakura/i.test(ver),
    });
  }
  frpcCache = list;
  list.configs = configs;
  return list;
}

async function ensureSakuraFrpc() {
  const dir = path.join(TOOLS_ROOT, 'sakura');
  const exe = path.join(dir, 'frpc.exe');
  const found = await detectFrpc();
  const local = found.find((x) => x.valid && x.sakura);
  if (local) return local.path;
  if (fs.existsSync(exe)) {
    const ver = await probeFrpc(exe);
    if (/sakura/i.test(ver)) return exe;
  }

  const clients = await fetchJson(`${SAKURA}/system/clients`);
  const arch = clients?.frpc?.archs?.windows_amd64;
  if (!arch?.url) throw new Error('SakuraFrp 官方没有返回 windows_amd64 的 frpc 下载地址');
  await fsp.mkdir(dir, { recursive: true });
  await download(arch.url, exe, { md5: arch.hash, size: arch.size });
  const ver = await probeFrpc(exe);
  if (!/sakura/i.test(ver)) {
    await fsp.rm(exe, { force: true }).catch(() => {});
    throw new Error(`下载到的 frpc 不是 SakuraFrp 版本（-V：${ver.trim().slice(0, 80) || '无输出'}）`);
  }
  return exe;
}

async function ensureOpenFrpFrpc() {
  const dir = path.join(TOOLS_ROOT, 'openfrp');
  const exe = path.join(dir, 'frpc.exe');
  const found = await detectFrpc();
  const local = found.find((x) => x.valid && !x.sakura);
  if (local) return local.path;
  if (fs.existsSync(exe)) {
    const ver = await probeFrpc(exe);
    if (ver.trim()) return exe;
  }

  const info = await fetchJson(`${OPENFRP}/commonQuery/get?key=software`);
  const latest = info?.data?.latest_full;
  const source = info?.data?.source?.[0]?.value;
  if (!latest || !source) throw new Error('OpenFrp 官方没有返回 frpc 下载地址');
  const zip = path.join(dir, 'frpc.zip');
  const url = `${String(source).replace(/\/+$/, '')}/${latest}/frpc_windows_amd64.zip`;
  await fsp.mkdir(dir, { recursive: true });
  await download(url, zip);
  const extractDir = path.join(dir, 'extract');
  await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(extractDir, { recursive: true });
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
  ], { windowsHide: true, timeout: 60000 });
  const hit = (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const r = walk(p);
        if (r) return r;
      } else if (/^frpc(?:[_-].*)?(?:\.exe)?$/i.test(e.name)) {
        return p;
      }
    }
    return '';
  })(extractDir);
  if (!hit) throw new Error('OpenFrp 压缩包里没有 frpc.exe');
  await fsp.rename(hit, exe).catch(async () => {
    await fsp.copyFile(hit, exe);
    await fsp.rm(hit, { force: true }).catch(() => {});
  });
  await fsp.rm(zip, { force: true }).catch(() => {});
  await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  const ver = await probeFrpc(exe);
  if (!ver.trim()) {
    throw new Error('OpenFrp frpc 无法执行；可能是 Windows 安全中心把它当成 PUA 拦截了。请先允许该文件，或改用 SakuraFrp。');
  }
  return exe;
}

function attachOutput(session, stream, onLine) {
  let buf = '';
  stream?.on('data', (chunk) => {
    buf += String(chunk);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      session.lines.push(line);
      if (session.lines.length > 200) session.lines.shift();
      onLine(line);
    }
  });
}

export async function prepareFrpc(provider) {
  return provider === 'sakura' ? ensureSakuraFrpc() : ensureOpenFrpFrpc();
}

const SAKURA_CONFIG_PATHS = [
  path.join(process.env.ProgramData || 'C:\\ProgramData', 'SakuraFrpService', 'config.json'),
  path.join(process.env.APPDATA || '', 'SakuraFrpLauncher', 'config.json'),
  path.join(process.env.LOCALAPPDATA || '', 'SakuraFrpLauncher', 'config.json'),
];
const SAKURA_FRPC_PATHS = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SakuraFrpLauncher', 'frpc.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'SakuraFrpLauncher', 'frpc.exe'),
  'D:\\Tools\\SakuraFrpLauncher\\frpc.exe',
];

function readSakuraConfig() {
  for (const p of SAKURA_CONFIG_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const token = String(j.token ?? '').trim();
      if (token) {
        return {
          path: p,
          token,
          frpcVersion: j.last_frpc_version ?? '',
          installId: j.installation_id ?? '',
        };
      }
    } catch {
      /* 读不了就试下一个 */
    }
  }
  return null;
}

/** 只读探测：不返回 token，不写日志 */
export async function detectClient(provider) {
  if (provider === 'sakura') {
    const conf = readSakuraConfig();
    const frpc = SAKURA_FRPC_PATHS.find((p) => fs.existsSync(p)) || '';
    if (!conf && !frpc) return { found: false, provider };
    let account = '';
    if (conf?.token) {
      try {
        const u = await fetchJson(`${SAKURA}/user/info`, { token: conf.token });
        account = u?.name ?? '';
      } catch {
        /* token 失效也仍然报告发现，让用户知道要重新登录 */
      }
    }
    return {
      found: true,
      provider: 'sakura',
      name: 'SakuraFrp 启动器',
      account,
      frpcPath: frpc,
      configPath: conf?.path ?? '',
      hasToken: Boolean(conf?.token),
      version: conf?.frpcVersion ?? '',
    };
  }

  if (provider === 'openfrp') {
    const roots = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenFrp'),
      path.join(process.env.LOCALAPPDATA || '', 'OpenFrp'),
      path.join(process.env.APPDATA || '', 'OpenFrp'),
    ];
    const hit = roots.find((p) => fs.existsSync(p));
    return hit
      ? { found: true, provider: 'openfrp', name: 'OpenFrp 客户端', configPath: hit, hasToken: false }
      : { found: false, provider: 'openfrp' };
  }

  throw new Error('未知联机服务');
}

/** 用户确认后导入；token 只进 secure store，不返回给前端 */
export async function importClientToken(provider) {
  if (provider !== 'sakura') throw new Error('OpenFrp 暂不支持从客户端导入登录态');
  const conf = readSakuraConfig();
  if (!conf?.token) throw new Error('没有在本机 SakuraFrp 配置里找到登录 token');
  const tunnels = await listTunnelsWithToken(provider, conf.token);
  await setToken(provider, conf.token);
  let account = '';
  try {
    const u = await fetchJson(`${SAKURA}/user/info`, { token: conf.token });
    account = u?.name ?? '';
  } catch { /* 导入本身已成功 */ }
  await setToken('sakura_account', account);
  return { ok: true, account, tunnels, configPath: conf.path };
}

function readCustomConfig() {
  try {
    const raw = getToken('custom');
    if (!raw) return null;
    const j = JSON.parse(raw);
    const server = String(j.server ?? '').trim();
    const port = Number(j.port ?? 7000);
    const remotePort = Number(j.remotePort ?? 0);
    if (!server || !(port > 0 && port < 65536) || !(remotePort > 0 && remotePort < 65536)) return null;
    return { server, port, remotePort, token: String(j.token ?? ''), name: j.name || 'sakura-mc' };
  } catch {
    return null;
  }
}

export async function saveCustomConfig(body) {
  const server = String(body.server ?? '').trim();
  const port = Number(body.port ?? 7000);
  const remotePort = Number(body.remotePort ?? 0);
  if (!/^[A-Za-z0-9._-]+$/.test(server)) throw new Error('frps 地址格式不对（不要带协议/路径）');
  if (!(port > 0 && port < 65536)) throw new Error('frps 端口要在 1-65535 之间');
  if (!(remotePort > 0 && remotePort < 65536)) throw new Error('远端端口要在 1-65535 之间');
  const cfg = {
    server,
    port,
    remotePort,
    token: String(body.token ?? '').trim() || (readCustomConfig()?.token ?? ''),
    name: String(body.name ?? 'sakura-mc').replace(/[^A-Za-z0-9_-]/g, '') || 'sakura-mc',
  };
  await setToken('custom', JSON.stringify(cfg));
  return customSnapshot();
}

export function customSnapshot() {
  const c = readCustomConfig();
  const s = sessions.custom;
  return {
    configured: Boolean(c),
    server: c?.server ?? '',
    port: c?.port ?? 7000,
    remotePort: c?.remotePort ?? 0,
    hasToken: Boolean(c?.token),
    running: Boolean(s.proc),
    address: s.address,
    ipAddress: s.ipAddress,
    error: s.error,
    lines: s.lines.slice(-20),
  };
}

async function ensureGenericFrpc() {
  const found = await detectFrpc();
  const local = found.find((x) => x.valid);
  if (local) return local.path;
  return ensureSakuraFrpc();
}

function startCustom(localPort) {
  const cfg = readCustomConfig();
  if (!cfg) throw new Error('先保存自定义 frps 配置');
  stopOtherProviders('custom');
  return (async () => {
    const exe = await ensureGenericFrpc();
    const dir = path.join(os.homedir(), '.mclauncher', 'custom-frpc');
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, `frpc-${process.pid}.ini`);
    const ini = [
      '[common]',
      `server_addr = ${cfg.server}`,
      `server_port = ${cfg.port}`,
      `token = ${cfg.token}`,
      '',
      `[${cfg.name}]`,
      'type = tcp',
      'local_ip = 127.0.0.1',
      `local_port = ${Number(localPort) || 25565}`,
      `remote_port = ${cfg.remotePort}`,
    ].join('\n');
    fs.writeFileSync(configPath, ini, { encoding: 'utf8', mode: 0o600 });
    const s = sessions.custom;
    s.configPath = configPath;
    s.address = `${cfg.server}:${cfg.remotePort}`;
    s.ipAddress = '';
    s.tunnelId = 'custom';
    s.error = '';
    s.lines = [];
    const proc = spawn(exe, ['-c', configPath], {
      cwd: path.dirname(exe),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    s.proc = proc;
    s.lines = [];
    let connected = false;
    const onLine = (line) => {
      if (/登录节点失败|连接失败|invalid configuration|token.*invalid|authentication failed/i.test(line)) {
        s.error = line.slice(0, 300);
      }
      if (/login to server success|登录成功|start proxy success|启动成功|proxy.*success/i.test(line)) {
        connected = true;
      }
    };
    attachOutput(s, proc.stdout, onLine);
    attachOutput(s, proc.stderr, onLine);
    proc.on('error', (e) => { s.error = e.message; });
    proc.on('close', (code) => {
      if (s.proc === proc) {
        s.proc = null;
        if (!s.error && code !== 0) s.error = `frpc 退出，code=${code}`;
      }
    });
    // 等实际登录/代理成功，不能只看进程还活着
    for (let n = 0; n < 12; n += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (s.error || connected || !s.proc) break;
    }
    if (!s.proc || s.error || !connected) {
      const err = s.error || (!s.proc ? 'frpc 启动后立即退出，检查 frps 地址/端口/token' : 'frpc 还没有连上 frps（超时）');
      if (s.proc) stopSession('custom');
      throw new Error(err);
    }
    return { ok: true, address: s.address, pid: proc.pid };
  })();
}


function stopOtherProviders(keep) {
  for (const p of ['sakura', 'openfrp', 'custom']) {
    if (p !== keep) {
      try { stopSession(p); } catch { /* 忽略 */ }
    }
  }
}

function stopSession(provider) {
  const s = sessions[provider];
  if (!s?.proc) return false;
  try {
    execFileSync('taskkill', ['/PID', String(s.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    try { s.proc.kill(); } catch {}
  }
  s.proc = null;
  if (s.configPath) {
    try { fs.rmSync(s.configPath, { force: true }); } catch {}
    s.configPath = '';
  }
  s.address = '';
  s.ipAddress = '';
  s.tunnelId = null;
  return true;
}

export async function startTunnel(provider, tunnelId, localPort) {
  const s = sessions[provider];
  if (!s) throw new Error('未知联机服务');
  if (s.proc) return { ok: true, address: s.address, already: true };
  stopOtherProviders(provider);
  if (provider === 'custom') return startCustom(localPort);
  const token = getToken(provider);
  if (!token) throw new Error('还没有保存 token');

  let tunnels = tunnelCache[provider]?.length ? tunnelCache[provider] : await listTunnels(provider);
  let tunnel = tunnels.find((t) => String(t.id) === String(tunnelId));
  if (!tunnel) throw new Error('找不到这条隧道，先刷新列表');

  const wantedPort = Number(localPort) || 0;
  if (provider === 'sakura' && wantedPort && tunnel.localPort && Number(tunnel.localPort) !== wantedPort) {
    // 对局域网开放的端口会变；Sakura 支持用 API 改隧道本地端口，
    // 这样“启动器里点联机”不需要玩家回官网改端口。
    await fetchJson(`${SAKURA}/tunnel/edit`, {
      token,
      method: 'POST',
      form: { id: tunnel.id, local_port: wantedPort },
    });
    tunnels = await listTunnels(provider);
    tunnel = tunnels.find((t) => String(t.id) === String(tunnelId));
    if (!tunnel) throw new Error('改端口后找不到隧道');
  }

  const exe = provider === 'sakura' ? await ensureSakuraFrpc() : await ensureOpenFrpFrpc();
  const cwd = path.dirname(exe);
  const env = { ...process.env };
  let args;
  if (provider === 'sakura') {
    env.NATFRP_TOKEN = token;
    env.NATFRP_TARGET = String(tunnel.id);
    args = ['--disable_log_color'];
  } else {
    // OpenFrp 的简易启动参数
    args = ['-u', token, '-p', String(tunnel.id)];
  }

  const proc = spawn(exe, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  s.proc = proc;
  s.address = tunnel.address;
  s.ipAddress = '';
  s.tunnelId = tunnel.id;
  s.error = '';
  s.lines = [];

  const onLine = (line) => {
    const m = /使用[^>]*>>\s*([^\s<]+)\s*<</.exec(line) || /tunnel\s*>>\s*([^\s<]+)\s*<</.exec(line);
    if (m) {
      const addr = m[1].replace(/^[<>]+|[<>]+$/g, '');
      if (addr.includes(':')) {
        // API 给的是域名时优先保留域名；frpc 实际连到的 IP 只做提示。
        s.ipAddress = addr;
        if (!s.address) s.address = addr;
      }
    }
  };
  attachOutput(s, proc.stdout, onLine);
  attachOutput(s, proc.stderr, onLine);
  proc.on('error', (e) => { s.error = e.message; });
  proc.on('close', (code) => {
    if (s.proc === proc) {
      s.proc = null;
      if (!s.error && code !== 0) s.error = `frpc 退出，code=${code}`;
    }
  });

  // 等 1.5 秒看它有没有立刻报错（token 错误/隧道不存在）
  await new Promise((r) => setTimeout(r, 1500));
  if (!s.proc) throw new Error(s.error || 'frpc 启动后立即退出，查看日志');
  return { ok: true, address: s.address, ipAddress: s.ipAddress, pid: proc.pid };
}

export function stopTunnel(provider) {
  return { ok: stopSession(provider) };
}

// 启动器退出时不要留下 frpc 子进程
process.once('exit', () => {
  for (const p of ['sakura', 'openfrp', 'custom']) {
    try { stopSession(p); } catch { /* 忽略 */ }
  }
});

export function onlineSnapshot() {
  const out = {};
  for (const p of ['sakura', 'openfrp']) {
    const s = sessions[p];
    out[p] = {
      configured: Boolean(getToken(p)),
      account: p === 'sakura' ? (getToken('sakura_account') || '') : '',
      running: Boolean(s.proc),
      pid: s.proc?.pid ?? null,
      address: s.address,
      ipAddress: s.ipAddress,
      tunnelId: s.tunnelId,
      error: s.error,
      lines: s.lines.slice(-20),
      tunnels: (tunnelCache[p] ?? []).map((t) => ({
        id: t.id, name: t.name, type: t.type, localPort: t.localPort, address: t.address, online: t.online,
      })),
    };
  }
  out.custom = customSnapshot();
  return out;
}

/** 从实例/游戏目录的 latest.log 找「对局域网开放」端口 */
export function detectLanPort(gameDir, versionId) {
  const files = [];
  if (versionId && !/[\\/]/.test(versionId)) {
    files.push(path.join(gameDir, 'versions', versionId, 'logs', 'latest.log'));
  }
  files.push(path.join(gameDir, 'logs', 'latest.log'));
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const max = 128 * 1024;
      const start = Math.max(0, st.size - max);
      const buf = Buffer.alloc(Math.min(max, st.size - start));
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const m = text.match(/Local game hosted on port\s+(\d{2,5})/i) ||
        text.match(/Started serving on\s+(?:[^\s:]+:)?(\d{2,5})\b/i) ||
        text.match(/Started serving on\s+(\d{2,5})\b/i) ||
        text.match(/对局域网开放[^\n]*?(\d{2,5})/);
      if (m) return { port: Number(m[1]), file };
    } catch {
      /* 换下一个 */
    }
  }
  return { port: null, file: null };
}
