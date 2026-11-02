/**
 * 极简 UPnP IGD 端口映射。
 *
 * 只做 TCP、只映射一个端口、退出时删除；不依赖第三方库。
 * 失败必须把原因带回：路由器没开 UPnP / 没有公网 IPv4 / CGNAT / 映射冲突。
 */
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { URL } from 'node:url';

const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

let mapping = null;

function localAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)) {
        return n.address;
      }
    }
  }
  return '127.0.0.1';
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
        timeout: 5000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { text += d; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function pickTag(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

async function discover() {
  return await new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const found = [];
    const finish = (err) => {
      try { sock.close(); } catch {}
      if (found.length) resolve(found);
      else reject(err ?? new Error('没有发现 UPnP 网关'));
    };
    sock.on('error', (e) => finish(e));
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/^HTTP\/1\.1 200/i.test(text)) return;
      const m = /^location:\s*(.+)$/im.exec(text);
      if (!m) return;
      const loc = m[1].trim();
      if (!found.includes(loc)) found.push(loc);
    });
    sock.bind(() => {
      try {
        const search = [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_HOST}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          'MX: 2',
          'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
          '', '',
        ].join('\r\n');
        sock.send(Buffer.from(search), SSDP_PORT, SSDP_HOST);
      } catch (e) {
        finish(e);
      }
    });
    setTimeout(() => finish(new Error('UPnP 搜索超时（路由器可能未开启 UPnP）')), 3000);
  });
}

function resolveUrl(base, href) {
  return new URL(href, base).toString();
}

function soap(serviceType, action, body) {
  return [
    '<?xml version="1.0"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${action} xmlns:u="${serviceType}">${body}</u:${action}>`,
    '</s:Body>',
    '</s:Envelope>',
  ].join('');
}

async function readGateway(location) {
  const r = await request(location);
  if (r.status !== 200) throw new Error(`读取网关描述失败 HTTP ${r.status}`);
  const xml = r.text;
  const base = pickTag(xml, 'URLBase') || location;
  for (const type of SERVICE_TYPES) {
    const idx = xml.indexOf(type);
    if (idx < 0) continue;
    // 找这个 service 块里的 controlURL
    const start = xml.lastIndexOf('<service>', idx);
    const end = xml.indexOf('</service>', idx);
    const block = start >= 0 && end >= 0 ? xml.slice(start, end) : xml;
    const control = pickTag(block, 'controlURL');
    const scpd = pickTag(block, 'SCPDURL');
    if (control) {
      return {
        serviceType: type,
        controlUrl: resolveUrl(base, control),
        scpdUrl: scpd ? resolveUrl(base, scpd) : '',
      };
    }
  }
  throw new Error('路由器没有 WANIPConnection/WANPPPConnection 服务');
}

async function publicIp() {
  const r = await request('https://api.ipify.org?format=json');
  if (r.status !== 200) throw new Error(`查询公网 IP 失败 HTTP ${r.status}`);
  const data = JSON.parse(r.text);
  return String(data.ip ?? '').trim();
}

function isPrivateOrCgnat(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|0\.)/.test(ip);
}

async function getExternalIp(gw) {
  const body = soap(gw.serviceType, 'GetExternalIPAddress', '');
  const r = await request(gw.controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: `"${gw.serviceType}#GetExternalIPAddress"`,
      'content-length': Buffer.byteLength(body),
    },
    body,
  });
  if (r.status !== 200) throw new Error(`GetExternalIPAddress HTTP ${r.status}`);
  return pickTag(r.text, 'NewExternalIPAddress');
}

async function addMapping(gw, port, internalIp) {
  const body = soap(
    gw.serviceType,
    'AddPortMapping',
    `<NewRemoteHost></NewRemoteHost>` +
      `<NewExternalPort>${port}</NewExternalPort>` +
      `<NewProtocol>TCP</NewProtocol>` +
      `<NewInternalPort>${port}</NewInternalPort>` +
      `<NewInternalClient>${internalIp}</NewInternalClient>` +
      `<NewEnabled>1</NewEnabled>` +
      `<NewPortMappingDescription>SakuraLauncher</NewPortMappingDescription>` +
      `<NewLeaseDuration>0</NewLeaseDuration>`
  );
  const r = await request(gw.controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: `"${gw.serviceType}#AddPortMapping"`,
      'content-length': Buffer.byteLength(body),
    },
    body,
  });
  if (r.status !== 200) {
    const code = pickTag(r.text, 'errorCode');
    throw new Error(`路由器拒绝端口映射${code ? `（${code}）` : ''}`);
  }
}

async function deleteMapping(gw, port) {
  const body = soap(
    gw.serviceType,
    'DeletePortMapping',
    `<NewRemoteHost></NewRemoteHost><NewExternalPort>${port}</NewExternalPort><NewProtocol>TCP</NewProtocol>`
  );
  await request(gw.controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: `"${gw.serviceType}#DeletePortMapping"`,
      'content-length': Buffer.byteLength(body),
    },
    body,
  }).catch(() => {});
}

export async function openPort(port) {
  if (!(port > 0 && port < 65536)) throw new Error('端口不合法');
  if (mapping) await closePort();

  let gateways;
  try {
    gateways = await discover();
  } catch (e) {
    throw new Error(e.message);
  }
  let lastError = null;
  for (const location of gateways) {
    try {
      const gw = await readGateway(location);
      const external = await getExternalIp(gw);
      if (!external) throw new Error('路由器没有返回公网 IP');
      if (isPrivateOrCgnat(external)) {
        throw new Error(`路由器 WAN IP 是 ${external}（内网/CGNAT），UPnP 映射外网连不进来`);
      }
      let pub = '';
      try { pub = await publicIp(); } catch { /* 查询失败不阻断，但提示 */ }
      if (pub && pub !== external) {
        throw new Error(`路由器 WAN IP ${external} 与公网 IP ${pub} 不一致，可能是 CGNAT`);
      }
      const internal = localAddress();
      await addMapping(gw, port, internal);
      mapping = { gw, port, external, internal };
      return {
        ok: true,
        port,
        publicIp: external,
        localIp: internal,
        gateway: location,
        warning: pub ? '' : '未能查询公网 IP，地址可能不可达',
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(lastError?.message || 'UPnP 映射失败');
}

export async function closePort() {
  if (!mapping) return { ok: true };
  const m = mapping;
  mapping = null;
  await deleteMapping(m.gw, m.port);
  return { ok: true };
}

export function mappingState() {
  return mapping ? { port: mapping.port, publicIp: mapping.external, localIp: mapping.internal } : null;
}
