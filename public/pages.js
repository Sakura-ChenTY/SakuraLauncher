/* 新版页面的交互：导航、下载子导航、联机、自定义、更多、插件
   依赖 app.js 里的 state / api / escapeHtml */

/* ---------------- 导航 ---------------- */

const TABS = ['home', 'download', 'version', 'saves', 'online', 'settings', 'theme', 'assistant', 'more'];

function showPanel(name) {
  if (!TABS.includes(name)) name = 'home';

  document.querySelectorAll('.nav-item').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === 'panel-' + name);
  });

  // 切到某些页面时补一次数据，省得进去是空的
  if (name === 'home') {
    if (typeof updateHome === 'function') updateHome();
  }
  if (name === 'version' && !state.versions.length) loadInstalled();
  if (name === 'download') ensureDownloadReady();
  if (name === 'online') {
    loadLanInfo();
    if (typeof refreshOnline === 'function') refreshOnline();
    if (typeof detectOnlineTools === 'function') detectOnlineTools();
  }
  if (name === 'theme') renderThemeGrid();
  if (name === 'assistant' && typeof window.assistantRefresh === 'function') window.assistantRefresh();
  if (name === 'more') renderCredits();
  if (name === 'settings') loadPlugins();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showPanel(btn.dataset.tab));
});

// app.js 里的 switchTab 走这里，保持单一入口
window.switchTab = showPanel;

/* ---------------- 下载页：子导航 ---------------- */

const SUB_TYPES = {
  vanilla: null,
  mod: 'mod',
  modpack: 'modpack',
  shader: 'shader',
  resourcepack: 'resourcepack',
};

let currentSub = 'vanilla';

function setSub(name) {
  if (!(name in SUB_TYPES)) name = 'vanilla';
  currentSub = name;

  document.querySelectorAll('.sub-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.sub === name);
  });

  // 原版 / 商店类 / 整合包 三块只能亮一块
  const which = name === 'vanilla' ? 'vanilla' : name === 'modpack' ? 'modpack' : 'store';
  document.querySelectorAll('.sub-panel').forEach((p) => {
    p.classList.toggle('active', p.id === 'sub-' + which);
  });

  // 商店那块要同步类型（模组/光影/资源包共用）
  if (SUB_TYPES[name]) {
    const t = document.getElementById('storeType');
    if (t) t.value = SUB_TYPES[name];
    state.storeType = SUB_TYPES[name];
  }

  // 搜索框提示跟着变
  const q = document.getElementById('dlQuery');
  if (q) {
    q.placeholder = name === 'vanilla'
      ? '在原版版本里找…'
      : name === 'modpack' ? '搜索整合包…'
        : name === 'mod' ? '搜索模组…'
          : name === 'shader' ? '搜索光影包…' : '搜索资源包…';
  }

  // 先给空列表一块 loading，别等搜索函数跑起来才画
  primeDownloadSkeleton(name);
  ensureDownloadReady();
  autoLoadForSub(name);
}

/** 进入整合包/光影/资源包页时，列表为空就先铺加载动画 */
function primeDownloadSkeleton(name) {
  if (typeof renderSkeleton !== 'function') return;
  if (name === 'modpack') {
    if (!(state.packs && state.packs.length)) {
      renderSkeleton('packResults', 6, '正在加载整合包…');
    }
    return;
  }
  if (SUB_TYPES[name] && !(state.storeHits && state.storeHits.length)) {
    const label = name === 'shader' ? '正在加载光影包…'
      : name === 'resourcepack' ? '正在加载资源包…'
        : '正在加载模组…';
    renderSkeleton('storeResults', 6, label);
  }
}

/**
 * 切到模组/光影包/资源包/整合包时自动拉一页，不用再点搜索。
 *
 * 为什么要判条件而不是每次无脑重拉：
 *  - 已经在看这类的列表，来回切页签不该把你的滚动位置和结果冲掉；
 *  - 但模组/光影/资源包共用一块面板，类型变了就必须重拉，否则
 *    切到光影包看到的还是模组的条目。所以要记住上次拉的是哪一类。
 */
let lastStoreType = '';
let autoLoading = false;

function autoLoadForSub(name) {
  if (autoLoading) return;

  if (name === 'modpack') {
    if (state.packs && state.packs.length) return;
    if (typeof doPackSearch !== 'function') return;
    autoLoading = true;
    doPackSearch(0).finally(() => { autoLoading = false; });
    return;
  }

  const t = SUB_TYPES[name];
  if (!t) return;
  if (typeof doStoreSearch !== 'function') return;

  const already = lastStoreType === t && state.storeHits && state.storeHits.length;
  if (already) return;

  lastStoreType = t;
  autoLoading = true;
  doStoreSearch(0).finally(() => { autoLoading = false; });
}

document.querySelectorAll('.sub-item').forEach((btn) => {
  btn.addEventListener('click', () => setSub(btn.dataset.sub));
});

/** 第一次进下载页时把清单拉起来，用户不用再点一次 */
let remoteLoaded = false;
function ensureDownloadReady() {
  if (currentSub !== 'vanilla') return;
  if (remoteLoaded || state.remote.length) return;
  remoteLoaded = true;
  if (typeof loadRemote === 'function') loadRemote();
}

/* ---------------- 搜索：一套输入框喂三种列表 ---------------- */

function runSearch() {
  const q = document.getElementById('dlQuery').value.trim();

  if (currentSub === 'vanilla') {
    filterVanilla(q);
    return;
  }

  if (currentSub === 'modpack') {
    // app.js 的 doPackSearch 从 packQuery 取值，把输入同步过去
    const pq = document.getElementById('packQuery');
    if (pq) pq.value = q;
    if (typeof doPackSearch === 'function') doPackSearch(0);
    return;
  }

  const sq = document.getElementById('storeQuery');
  if (sq) sq.value = q;
  if (typeof doStoreSearch === 'function') doStoreSearch(0);
}

/** 原版清单在本地过滤，不用重新请求 */
let vanillaQuery = '';
function filterVanilla(q) {
  vanillaQuery = q.toLowerCase();
  renderVanillaList();
}

function renderVanillaList() {
  const box = document.getElementById('remoteList');
  if (!box) return;

  const all = state.remote || [];
  if (!all.length) {
    box.innerHTML = '<div class="empty">点「刷新清单」加载</div>';
    return;
  }

  const hits = vanillaQuery
    ? all.filter((v) => String(v.id).toLowerCase().includes(vanillaQuery))
    : all;

  if (!hits.length) {
    box.innerHTML = '<div class="empty">没有匹配的版本</div>';
    return;
  }

  box.innerHTML = hits.map((v) => {
    // 服务端已经只返回 release，所以这里就是「正式版」，不再读 v.type（那个字段没传）
    const installed = (state.versions || []).includes(v.id);
    return `<div class="item-row">
      <img class="ver-ico-img ver-block-icon" src="/version-icons/grass-block.png" alt="" loading="lazy">
      <div class="item-main">
        <div class="item-title">${escapeHtml(v.id)}</div>
        <div class="item-meta">
          <span>正式版</span>
          ${v.releaseTime ? `<span>${escapeHtml(String(v.releaseTime).slice(0, 10))}</span>` : ''}
          ${installed ? '<span style="color:var(--ok)">已安装</span>' : ''}
        </div>
      </div>
      <div class="item-act">
        <button class="btn" data-install="${escapeHtml(v.id)}" ${installed ? 'disabled' : ''}>
          ${installed ? '已装' : '安装'}
        </button>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-install]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof doInstall === 'function') doInstall(btn.dataset.install);
    });
  });
}

// 覆盖 app.js 的原版渲染，改成一行一行的样式
window.renderRemote = renderVanillaList;

document.getElementById('dlSearch').addEventListener('click', runSearch);
document.getElementById('dlQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});

/* ---------------- 联机 ---------------- */

async function copyText(text, label = '') {
  if (!text) return false;
  try {
    if (window.mcWin?.writeClipboard) {
      await window.mcWin.writeClipboard(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    if (typeof toast === 'function') toast(`已复制${label ? ' ' + label : ''} ${text}`, 'ok');
    return true;
  } catch {
    if (typeof toast === 'function') toast('复制失败，请手动选中地址', 'err');
    return false;
  }
}

const RECENT_ADDR_KEY = 'sakura.recentAddresses';

function rememberAddress(address) {
  const addr = String(address ?? '').trim();
  if (!/^[^\s:]+:\d{1,5}$/.test(addr)) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RECENT_ADDR_KEY) || '[]'); } catch { list = []; }
  list = [{ addr, at: Date.now() }, ...list.filter((x) => x.addr !== addr)].slice(0, 5);
  localStorage.setItem(RECENT_ADDR_KEY, JSON.stringify(list));
  renderRecentAddresses();
}

function renderRecentAddresses() {
  const sel = document.getElementById('recentAddresses');
  if (!sel) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RECENT_ADDR_KEY) || '[]'); } catch { list = []; }
  if (!list.length) {
    sel.disabled = true;
    sel.innerHTML = '<option value="">还没有最近连接</option>';
    return;
  }
  sel.disabled = false;
  sel.innerHTML = '<option value="">最近连接…</option>' + list.map((x) => {
    const t = new Date(x.at);
    const stamp = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    return `<option value="${escapeHtml(x.addr)}">${escapeHtml(x.addr)} · ${stamp}</option>`;
  }).join('');
}

function renderAddressChoices(items, autoCopy = true) {
  const box = document.getElementById('onlineResult');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = items
    .map((it, i) => `<div class="online-choice${i === 0 ? ' best' : ''}">` +
      `<span class="online-kind">${escapeHtml(it.kind)}</span>` +
      `<code>${escapeHtml(it.address)}</code>` +
      `<button class="btn ghost" data-choice-copy="${escapeHtml(it.address)}">复制</button></div>`)
    .join('');
  box.querySelectorAll('[data-choice-copy]').forEach((btn) => {
    btn.addEventListener('click', () => copyText(btn.dataset.choiceCopy, '联机地址'));
  });
  for (const it of items) rememberAddress(it.address);
  if (autoCopy && items[0]?.address) copyText(items[0].address, items[0].kind);
}

async function loadLanInfo() {
  const el = document.getElementById('lanAddr');
  if (!el) return;
  const portInput = document.getElementById('lanPort');
  const port = Math.max(1, Math.min(65535, Number(portInput?.value) || 25565));
  if (portInput) portInput.value = String(port);
  el.textContent = '读取中…';
  try {
    const data = await api('/api/net/lan');
    const list = data.addresses || [];
    if (!list.length) {
      el.textContent = '没找到局域网地址（可能没连网）';
      return;
    }
    el.innerHTML = list
      .map((a) => {
        const addr = `${a.address}:${port}`;
        const kind = a.virtual ? '虚拟局域网' : '局域网';
        return `<span class="lan-item"><span class="online-kind">${kind}</span>` +
          `<code>${escapeHtml(addr)}</code>` +
          `<span class="lan-name">${escapeHtml(a.name || '')}</span>` +
          `<button class="btn ghost lan-copy" data-ip="${escapeHtml(addr)}">复制</button></span>`;
      })
      .join('');
    el.querySelectorAll('.lan-copy').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.dataset.ip, '联机地址'));
    });
  } catch (e) {
    el.textContent = '读取失败：' + e.message;
  }
}

async function loadLanPort() {
  try {
    const q = state.selectedVersion ? `?versionId=${encodeURIComponent(state.selectedVersion)}` : '';
    const r = await api('/api/online/lan-port' + q);
    if (r.port) {
      document.getElementById('lanPort').value = String(r.port);
      await loadLanInfo();
      if (typeof toast === 'function') toast(`已从 latest.log 读到端口 ${r.port}`, 'ok');
    } else if (typeof toast === 'function') {
      toast('没在 latest.log 里找到“对局域网开放”的端口', 'err');
    }
  } catch (e) {
    if (typeof toast === 'function') toast('读取端口失败：' + e.message, 'err');
  }
}

/* ---------------- 联机：SakuraFrp / OpenFrp ---------------- */

const ONLINE_PROVIDERS = {
  sakura: { label: 'SakuraFrp' },
  openfrp: { label: 'OpenFrp' },
  custom: { label: '自定义 frps' },
};

function setOnlineStatus(provider, text, kind = '') {
  const el = document.getElementById(provider + 'Status');
  if (!el) return;
  el.textContent = text;
  el.className = 'online-status' + (kind ? ' ' + kind : '');
}

function renderOnline(provider, s) {
  if (!s) return;
  const label = ONLINE_PROVIDERS[provider].label;
  const sel = document.getElementById(provider + 'Tunnel');
  const addr = document.getElementById(provider + 'Address');
  const hint = document.getElementById(provider + 'Hint');
  const prev = sel?.value || '';

  if (s.running) setOnlineStatus(provider, '运行中', 'on');
  else if (s.configured) setOnlineStatus(provider, '已配置', '');
  else setOnlineStatus(provider, '未配置', '');
  if (s.error) setOnlineStatus(provider, '错误', 'err');

  if (provider !== 'custom') {
    const token = document.getElementById(provider + 'Token');
    if (token && s.configured) {
      token.placeholder = s.account
        ? `已保存（已识别本机 ${label}（${s.account}））`
        : 'token 已保存；要换再填';
    }
  }

  if (provider === 'custom' && s.configured) {
    const server = document.getElementById('customServer');
    const port = document.getElementById('customPort');
    const remote = document.getElementById('customRemote');
    if (server && !server.value) server.value = s.server || '';
    if (port && s.port) port.value = String(s.port);
    if (remote && s.remotePort) remote.value = String(s.remotePort);
    const token = document.getElementById('customToken');
    if (token) token.placeholder = s.hasToken ? 'token 已保存；要换再填' : 'frps token（没有就留空）';
  }

  if (sel) {
    const tunnels = s.tunnels || [];
    sel.innerHTML = tunnels.length
      ? tunnels.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} · ${escapeHtml(t.type || '?')} → ${escapeHtml(t.address || '等待地址')}</option>`).join('')
      : '<option value="">没有隧道，先刷新/去官网建一条</option>';
    if (prev && tunnels.some((t) => String(t.id) === prev)) sel.value = prev;
  }

  if (s.running || s.address) {
    addr.hidden = false;
    const ipNote = s.ipAddress && s.ipAddress !== s.address
      ? `<span class="online-ip">IP ${escapeHtml(s.ipAddress)}</span>`
      : '';
    addr.innerHTML = `<code>${escapeHtml(s.address || '等待地址…')}</code>` +
      ipNote +
      `<button class="btn ghost" data-online-copy="${escapeHtml(s.address || '')}">复制</button>`;
    addr.querySelector('[data-online-copy]')?.addEventListener('click', async (ev) => {
      const text = ev.currentTarget.dataset.onlineCopy;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        if (typeof toast === 'function') toast(`已复制 ${text}`, 'ok');
        ev.currentTarget.textContent = '已复制';
        setTimeout(() => { ev.currentTarget.textContent = '复制'; }, 1500);
      } catch {
        if (typeof toast === 'function') toast('复制失败，请手动选中地址', 'err');
      }
    });
  } else {
    addr.hidden = true;
    addr.innerHTML = '';
  }

  // frpc 的授权声明不是用户状态，不往卡片底部渲染。
  const frpLicenseLine = /(modified version of frp|distributed by\s*SakuraFrp|SakuraFrp\s+license)/i;
  const lastLine = [...(s.lines || [])].reverse()
    .find((line) => !frpLicenseLine.test(String(line))) || '';
  hint.textContent = s.error || lastLine || (s.configured
    ? '隧道已连接；先让游戏开好局域网，再点启动。'
    : `填 ${label} token 后会自动拉隧道列表。`);
}

const onlineAutoFetch = { sakura: false, openfrp: false };

function applyExclusiveStatus(s) {
  const running = ['sakura', 'openfrp', 'custom'].find((p) => s[p]?.running);
  if (!running) return;
  for (const p of ['sakura', 'openfrp', 'custom']) {
    if (p !== running && s[p]?.configured) setOnlineStatus(p, '未运行', '');
  }
}

async function refreshOnline() {
  try {
    let s = await api('/api/online/state');
    onlineStateCache = s;
    renderOnline('sakura', s.sakura);
    renderOnline('openfrp', s.openfrp);
    renderOnline('custom', s.custom);
    applyExclusiveStatus(s);
    syncFrpProviderView();
    renderRoom(onlineRoom);
    renderRoomVersions();

    // 首屏拿到 token 但还没有隧道缓存时，自动拉一次，不用用户点刷新
    let fetched = false;
    for (const p of ['sakura', 'openfrp']) {
      if (s[p]?.configured && !(s[p].tunnels || []).length && !onlineAutoFetch[p]) {
        onlineAutoFetch[p] = true;
        try {
          await api('/api/online/tunnels', {
            method: 'POST',
            body: JSON.stringify({ provider: p }),
          });
          fetched = true;
        } catch (e) {
          const hint = document.getElementById(p + 'Hint');
          if (hint) hint.textContent = '自动拉取隧道失败：' + e.message;
        }
      }
    }
    if (fetched) {
      s = await api('/api/online/state');
      onlineStateCache = s;
      renderOnline('sakura', s.sakura);
      renderOnline('openfrp', s.openfrp);
      renderOnline('custom', s.custom);
      applyExclusiveStatus(s);
      syncFrpProviderView();
      renderRoom(onlineRoom);
      renderRoomVersions();
    }
  } catch (e) {
    for (const p of ['sakura', 'openfrp']) {
      const hint = document.getElementById(p + 'Hint');
      if (hint) hint.textContent = '读取联机状态失败：' + e.message;
    }
  }
}

let downloadPrompted = false;

async function detectOnlineTools() {
  const el = document.getElementById('frpcHint');
  if (!el) return;
  try {
    const d = await api('/api/online/detect');
    const found = (d.frpc || []).filter((x) => x.valid);
    if (found.length) {
      const sakura = found.find((x) => x.sakura);
      const pick = sakura || found[0];
      const short = (String(pick.version || '').match(/\d+\.\d+(?:\.\d+)?/) || [])[0] || '';
      el.textContent = sakura
        ? `已就绪 · SakuraFrp ${short}`.trim()
        : `已就绪 · frpc ${short}`.trim();
      if (!sakura) el.textContent += '（Sakura 隧道会另下官方版）';
    } else {
      el.textContent = '尚未安装联机工具；首次启动会下载官方 frpc。';
      if (!downloadPrompted) {
        downloadPrompted = true;
        try {
          const st = await api('/api/online/state');
          const configured = st.sakura?.configured || st.openfrp?.configured || st.custom?.configured;
          if (!configured && confirm('本机没有联机工具（frpc）。要现在下载官方 frpc 吗？\n\n点“否”就继续用局域网/虚拟局域网直连。')) {
            el.textContent = '正在下载官方 frpc…';
            const r = await api('/api/online/prepare', { method: 'POST', body: JSON.stringify({ provider: 'sakura' }) });
            el.textContent = `联机工具已下载：${r.exe}`;
            toast('联机工具已下载，可直接启动', 'ok');
          } else if (!configured) {
            el.textContent = '没有下载联机工具；可以先用局域网/虚拟局域网直连。';
          }
        } catch (e) {
          el.textContent = '下载联机工具失败：' + e.message;
        }
      }
    }
    if (d.configs?.length) el.textContent += ' · 已发现本地配置';
  } catch (e) {
    el.textContent = '探测本机 frpc 失败：' + e.message;
  }
}

async function saveOnlineToken(provider) {
  const input = document.getElementById(provider + 'Token');
  const btn = document.getElementById(provider + 'Save');
  const token = input?.value.trim();
  if (!token) return alert('先填 token');
  btn.disabled = true;
  btn.textContent = '校验中…';
  try {
    await api('/api/online/token', {
      method: 'POST',
      body: JSON.stringify({ provider, token }),
    });
    input.value = '';
    input.placeholder = 'token 已保存；要换再填';
    if (typeof toast === 'function') toast(`${ONLINE_PROVIDERS[provider].label} token 已保存`, 'ok');
    await refreshOnline();
  } catch (e) {
    if (typeof toast === 'function') toast('token 校验失败：' + e.message, 'err');
    else alert('token 校验失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function importProviderClient(provider) {
  const label = ONLINE_PROVIDERS[provider].label;
  let info;
  try {
    info = await api('/api/online/detect-client?provider=' + encodeURIComponent(provider));
  } catch (e) {
    return toast('识别失败：' + e.message, 'err');
  }
  if (!info.found) {
    return toast(`没有找到本机 ${label} 客户端；请填 token 或先安装它的客户端`, 'err');
  }
  if (info.hasToken === false) {
    return toast(`发现 ${label} 客户端，但没有读到登录 token；请先在客户端登录`, 'err');
  }
  const ok = confirm(
    `要从本机 ${info.name || label} 客户端读取登录信息吗？\n\n` +
    `只读本地配置，不上传、不打印 token；界面上只显示账号名。`
  );
  if (!ok) return;

  const btn = document.getElementById(provider + 'Detect');
  if (btn) { btn.disabled = true; btn.textContent = '识别中…'; }
  try {
    const r = await api('/api/online/import-client', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
    const input = document.getElementById(provider + 'Token');
    if (input) {
      input.value = '';
      input.placeholder = `已识别本机 ${label}${r.account ? `（${r.account}）` : ''}，直接用它的隧道`;
    }
    toast(`已识别本机 ${label}${r.account ? `（${r.account}）` : ''}，直接用它的隧道`, 'ok');
    await refreshOnline();
  } catch (e) {
    toast('导入失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '识别本机'; }
  }
}

async function saveCustomFrps() {
  const server = document.getElementById('customServer').value.trim();
  const port = Number(document.getElementById('customPort').value);
  const remotePort = Number(document.getElementById('customRemote').value);
  const token = document.getElementById('customToken').value;
  if (!server) return toast('先填 frps 地址', 'err');
  try {
    await api('/api/online/custom', {
      method: 'POST',
      body: JSON.stringify({ server, port, remotePort, token }),
    });
    document.getElementById('customToken').value = '';
    document.getElementById('customToken').placeholder = 'token 已保存；要换再填';
    toast('自定义 frps 已保存', 'ok');
    await refreshOnline();
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}

async function ensureFrpcForStart() {
  try {
    const d = await api('/api/online/detect');
    if ((d.frpc || []).some((x) => x.valid)) return true;
  } catch { /* 探测失败也允许试启动 */ }
  const ok = confirm('本机没有可用的 frpc。要现在下载官方 frpc 吗？\n\n点“否”就取消这次联机。');
  if (!ok) return false;
  await api('/api/online/prepare', {
    method: 'POST',
    body: JSON.stringify({ provider: 'sakura' }),
  });
  toast('官方 frpc 已下载', 'ok');
  return true;
}

async function startCustomFrps() {
  const server = document.getElementById('customServer')?.value.trim();
  if (!server) {
    toast('先填 frps 地址', 'err');
    return;
  }
  try {
    await api('/api/online/custom', {
      method: 'POST',
      body: JSON.stringify({
        server,
        port: Number(document.getElementById('customPort')?.value) || 7000,
        remotePort: Number(document.getElementById('customRemote')?.value) || 0,
        token: document.getElementById('customToken')?.value || '',
      }),
    });
    document.getElementById('customToken').value = '';
  } catch (e) {
    toast('自定义 frps 配置保存失败：' + e.message, 'err');
    return;
  }
  if (!(await ensureFrpcForStart())) return;
  const port = await detectPort(true);
  try {
    const r = await api('/api/online/start', {
      method: 'POST',
      body: JSON.stringify({ provider: 'custom', localPort: port }),
    });
    if (r.address) renderAddressChoices([{ kind: '公网（自定义 frps）', address: r.address }], true);
    toast(`自定义 frps 已启动${r.address ? `：${r.address}` : ''}`, 'ok');
    await refreshOnline();
  } catch (e) {
    toast('自定义 frps 启动失败：' + e.message, 'err');
    await refreshOnline();
  }
}

async function openProviderRegister(provider) {
  const urls = {
    sakura: 'https://www.natfrp.com/',
    openfrp: 'https://www.openfrp.net/',
  };
  const url = urls[provider];
  if (!url) return;
  try {
    if (window.mcWin?.openExternal) await window.mcWin.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  } catch (e) {
    toast('打开浏览器失败：' + e.message, 'err');
  }
}

async function refreshProviderTunnels(provider) {
  try {
    const r = await api('/api/online/tunnels', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
    if (typeof toast === 'function') toast(`已刷新 ${r.tunnels?.length ?? 0} 条隧道`, 'ok');
    await refreshOnline();
  } catch (e) {
    if (typeof toast === 'function') toast('刷新失败：' + e.message, 'err');
  }
}

async function createProviderTunnel(provider) {
  const label = ONLINE_PROVIDERS[provider].label;
  const r = await askForm({
    title: `${label} 新隧道`,
    hint: '名字用字母/数字/下划线；本地端口填游戏里“对局域网开放”显示的端口',
    fields: [
      {
        id: 'name',
        label: '隧道名',
        value: `mc-${Date.now().toString().slice(-5)}`,
        placeholder: '例如 sakura-mc',
      },
      {
        id: 'port',
        label: '本地端口',
        value: document.getElementById('lanPort')?.value || '25565',
        type: 'number',
      },
    ],
  });
  if (!r) return;
  const name = (r.name || '').trim();
  const port = Number(r.port || 0);
  if (!name) return toast('先填隧道名', 'err');
  if (!(port > 0 && port < 65536)) return toast('端口不合法', 'err');
  try {
    await api('/api/online/create', {
      method: 'POST',
      body: JSON.stringify({ provider, name, localPort: port }),
    });
    if (typeof toast === 'function') toast(`${label} 隧道已创建`, 'ok');
    await refreshOnline();
    await refreshProviderTunnels(provider);
  } catch (e) {
    if (typeof toast === 'function') toast('创建失败：' + e.message, 'err');
    else alert('创建失败：' + e.message);
  }
}

async function startProviderTunnel(provider) {
  const sel = document.getElementById(provider + 'Tunnel');
  const id = sel?.value;
  if (!id) return alert('先选一条隧道');
  if (!(await ensureFrpcForStart())) return;

  // 启动前先对齐当前游戏端口；不要拿输入框里过期的 25565 去改隧道
  let localPort = Number(document.getElementById('lanPort')?.value) || undefined;
  try {
    const q = state.selectedVersion ? `?versionId=${encodeURIComponent(state.selectedVersion)}` : '';
    const detected = await api('/api/online/lan-port' + q);
    if (detected.port) {
      localPort = detected.port;
      document.getElementById('lanPort').value = String(detected.port);
    }
  } catch {
    /* 检测失败就用输入框的值 */
  }

  const btn = document.getElementById(provider + 'Start');
  btn.disabled = true;
  btn.textContent = '启动中…';
  try {
    const r = await api('/api/online/start', {
      method: 'POST',
      body: JSON.stringify({ provider, tunnelId: id, localPort }),
    });
    if (typeof toast === 'function') {
      toast(r.address
        ? `隧道已启动：${r.address}${r.ipAddress && r.ipAddress !== r.address ? `（IP ${r.ipAddress}）` : ''}`
        : '隧道已启动，等待地址', 'ok');
    }
    if (r.address) renderAddressChoices([{ kind: `公网（${ONLINE_PROVIDERS[provider].label}）`, address: r.address }], true);
    await refreshOnline();
  } catch (e) {
    if (typeof toast === 'function') toast('启动失败：' + e.message, 'err');
    else alert('启动失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '启动';
  }
}

async function stopProviderTunnel(provider) {
  try {
    await api('/api/online/stop', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
    if (typeof toast === 'function') toast(`${ONLINE_PROVIDERS[provider].label} 已停止`, 'ok');
    await refreshOnline();
  } catch (e) {
    if (typeof toast === 'function') toast('停止失败：' + e.message, 'err');
  }
}

async function detectPort(silent = false) {
  try {
    const q = state.selectedVersion ? `?versionId=${encodeURIComponent(state.selectedVersion)}` : '';
    const r = await api('/api/online/lan-port' + q);
    if (r.port) {
      document.getElementById('lanPort').value = String(r.port);
      await loadLanInfo();
      if (!silent) toast(`已读到端口 ${r.port}（${r.source === 'stdout' ? '游戏输出' : 'latest.log'}）`, 'ok');
      return r.port;
    }
    if (!silent) toast('没在游戏输出或 latest.log 里找到“对局域网开放”的端口；确认游戏里已经点过开放，或手动填端口', 'err');
  } catch (e) {
    if (!silent) toast('读取端口失败：' + e.message, 'err');
  }
  return Number(document.getElementById('lanPort')?.value) || 25565;
}

async function unifiedConnect() {
  const btn = document.getElementById('onlineConnect');
  btn.disabled = true;
  btn.textContent = '正在准备…';
  try {
    const port = await detectPort(true);
    const choices = [];
    let s = await api('/api/online/state');

    // 如果 provider 已经有地址，优先；否则如果已配置且选了隧道，点一次联机就把它启动
    for (const p of ['sakura', 'openfrp', 'custom']) {
      if (s[p]?.running || s[p]?.address) {
        if (s[p].address) choices.push({ kind: `公网（${ONLINE_PROVIDERS[p].label}）`, address: s[p].address });
      }
    }
    if (!choices.length && s.sakura?.configured && document.getElementById('sakuraTunnel')?.value) {
      await startProviderTunnel('sakura');
      s = await api('/api/online/state');
      if (s.sakura?.address) choices.push({ kind: '公网（SakuraFrp）', address: s.sakura.address });
    }
    if (!choices.length && s.openfrp?.configured && document.getElementById('openfrpTunnel')?.value) {
      await startProviderTunnel('openfrp');
      s = await api('/api/online/state');
      if (s.openfrp?.address) choices.push({ kind: '公网（OpenFrp）', address: s.openfrp.address });
    }
    if (!choices.length && s.custom?.configured) {
      await startCustomFrps();
      s = await api('/api/online/state');
      if (s.custom?.address) choices.push({ kind: '公网（自定义 frps）', address: s.custom.address });
    }

    const lan = await api('/api/net/lan');
    const ips = lan.addresses || [];
    for (const a of ips.filter((x) => x.virtual)) {
      choices.push({ kind: '虚拟局域网', address: `${a.address}:${port}` });
    }
    for (const a of ips.filter((x) => !x.virtual)) {
      choices.push({ kind: '局域网', address: `${a.address}:${port}` });
    }

    if (!choices.length) {
      if (typeof toast === 'function') toast('没有可用地址：先让游戏对局域网开放，或配置 SakuraFrp', 'err');
      return;
    }
    renderAddressChoices(choices, true);
    document.getElementById('onlineResult')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    if (typeof toast === 'function') toast('联机准备失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '一键联机';
  }
}

async function joinFriendRoom() {
  const input = document.getElementById('joinAddress');
  const hint = document.getElementById('joinHint');
  const raw = String(input?.value || '').trim();
  if (!raw) {
    hint.textContent = '先粘贴朋友给的地址，例如 frp-top.com:48501';
    return;
  }
  const m = /([A-Za-z0-9._-]+):(\d{1,5})/.exec(raw);
  if (!m) {
    hint.textContent = '地址格式不对，应为 host:端口';
    return;
  }
  if (!state.selectedVersion) {
    hint.textContent = '先在「版本」页选一个已安装的实例';
    alert('先在「版本」页选一个已安装的实例，再回来粘贴地址加入。');
    document.querySelector('.nav-item[data-tab="version"]')?.click();
    return;
  }
  const address = `${m[1]}:${m[2]}`;
  rememberAddress(address);
  hint.textContent = `正在用 ${state.selectedVersion} 加入 ${address}…（版本/mod 不匹配会被服务器踢）`;
  const detail = (state.versionDetails || []).find((x) => x.id === state.selectedVersion) || {};
  const remotePort = Number(m[2]) || 0;
  await doLaunch(state.selectedVersion, address, {
    recentMeta: {
      mode: 'multiplayer',
      role: 'guest',
      versionId: state.selectedVersion,
      loader: detail.kind || detail.loader || 'vanilla',
      gameVersion: detail.gameVersion || state.selectedVersion,
      gameDir: state.gameDir,
      joinAddress: address,
      room: {
        provider: selectedFrpProvider(),
        remotePort,
        address,
      },
    },
  });
}

let upnpActive = false;
async function toggleUpnp() {  const btn = document.getElementById('upnpConnect');
  const hint = document.getElementById('upnpHint');
  const port = Number(document.getElementById('lanPort')?.value) || 25565;
  btn.disabled = true;
  try {
    if (upnpActive) {
      await api('/api/online/upnp/stop', { method: 'POST', body: '{}' });
      upnpActive = false;
      btn.textContent = '尝试公网直连（UPnP）';
      hint.textContent = '已关闭 UPnP 映射';
      toast('已关闭 UPnP 映射', 'ok');
      return;
    }
    hint.textContent = '正在搜索路由器…';
    const r = await api('/api/online/upnp/start', {
      method: 'POST',
      body: JSON.stringify({ port }),
    });
    upnpActive = true;
    btn.textContent = '关闭公网直连（UPnP）';
    hint.textContent = `公网 ${r.publicIp}:${r.port}（本机 ${r.localIp}）`;
    renderAddressChoices([{ kind: '公网（UPnP）', address: `${r.publicIp}:${r.port}` }], true);
  } catch (e) {
    hint.textContent = 'UPnP 不可用：' + e.message;
    toast('UPnP 不可用：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 联机：frp 配置 / 开房间 ---------------- */

let onlineStateCache = null;
let onlineRoom = { status: 'idle' };
let roomFallbackError = '';
let roomWorldSettings = null;

function selectedFrpProvider() {
  return document.getElementById('onlineProvider')?.value || 'sakura';
}

function providerConfigured(provider) {
  return Boolean(onlineStateCache?.[provider]?.configured);
}

function syncFrpProviderView() {
  const p = selectedFrpProvider();
  localStorage.setItem('sakura.onlineProvider', p);
  for (const id of ['sakura', 'openfrp', 'custom']) {
    const el = document.getElementById('provider' + (id === 'sakura' ? 'Sakura' : id === 'openfrp' ? 'Openfrp' : 'Custom'));
    if (el) el.hidden = id !== p;
  }
  const configured = providerConfigured(p);
  const status = document.getElementById('frpConfigStatus');
  if (status) {
    status.textContent = configured ? '已配置' : '未配置';
    status.className = 'online-status' + (configured ? ' on' : '');
  }
  const hint = document.getElementById('frpProviderHint');
  if (hint) hint.textContent = configured
    ? '凭据已保存；开房时使用当前 provider。'
    : '选一个服务，填一次凭据。';
  renderRoom(onlineRoom);
}

function renderRoomVersions() {
  const sel = document.getElementById('roomVersion');
  if (!sel) return;
  const previous = sel.value || state.selectedVersion || '';
  const details = state.versionDetails || [];
  const candidates = (state.versions || []).filter((id) => {
    const d = details.find((x) => x.id === id) || {};
    const kind = d.kind || d.loader || 'vanilla';
    return kind === 'vanilla' || kind === 'snapshot' || !d.loader;
  });
  sel.innerHTML = candidates.length
    ? candidates.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('')
    : '<option value="">先安装一个原版实例</option>';
  if (candidates.includes(previous)) sel.value = previous;
}

function roomMemoryDefault() {
  const id = document.getElementById('roomVersion')?.value || '';
  const detail = (state.versionDetails || []).find((x) => x.id === id) || {};
  return detail.kind === 'curseforge' ? 3072 : 2048;
}

async function loadRoomMemory() {
  const input = document.getElementById('roomMemory');
  if (!input) return;
  try {
    const d = await api('/api/settings');
    const n = Number(d.settings?.roomMemoryMb);
    input.value = String(n > 0 ? n : roomMemoryDefault());
  } catch {
    input.value = String(roomMemoryDefault());
  }
}

async function saveRoomMemory() {
  const input = document.getElementById('roomMemory');
  if (!input) return;
  const n = Number(input.value);
  if (!Number.isInteger(n) || n < 256 || n > 16384) {
    input.value = String(roomMemoryDefault());
    if (typeof toast === 'function') toast('开房内存需在 256-16384 MB', 'err');
    return;
  }
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ roomMemoryMb: n }) });
    if (typeof toast === 'function') toast(`开房内存已保存：${n} MB`);
  } catch (e) {
    if (typeof toast === 'function') toast('保存开房内存失败：' + e.message, 'err');
  }
}

function roomProviderLabel(provider) {
  return { sakura: 'SakuraFrp', openfrp: 'OpenFrp', custom: '自定义 frps' }[provider] || provider;
}

async function loadCfApiKey() {
  try {
    const d = await api('/api/cf/key');
    window.cfHasKey = Boolean(d.hasKey);
    const hint = document.getElementById('cfApiKeyHint');
    if (hint) {
      if (d.source === 'env') hint.textContent = `已由环境变量提供（${d.keyMask}）`;
      else if (d.hasKey) hint.textContent = `已保存：${d.keyMask}`;
      else hint.textContent = '未配置；CurseForge 搜索、安装和更新会跳过，只用 Modrinth';
    }
    const cfLabel = document.getElementById('packSrcCurseforge')?.closest('label');
    const cfText = cfLabel?.querySelector('span:last-child');
    if (cfText) cfText.textContent = d.hasKey ? 'CurseForge' : 'CurseForge（需要 API Key）';
    const sourceHint = document.getElementById('packCfKeyHint');
    if (sourceHint) {
      sourceHint.hidden = Boolean(d.hasKey);
      sourceHint.textContent = 'CurseForge 需要 API Key；未配置时自动只用 Modrinth';
    }
    const link = document.getElementById('cfApiKeyLink');
    if (link && d.applyUrl) link.href = d.applyUrl;
  } catch { /* 旧服务没有这个接口时保持静默 */ }
}

async function saveCfApiKey() {
  const input = document.getElementById('cfApiKey');
  const hint = document.getElementById('cfApiKeyHint');
  const key = String(input?.value || '').trim();
  if (!key) { if (hint) hint.textContent = '先粘贴 API Key'; return; }
  try {
    const d = await api('/api/cf/key', { method: 'POST', body: JSON.stringify({ apiKey: key }) });
    if (input) input.value = '';
    await loadCfApiKey();
    if (typeof toast === 'function') toast('CurseForge API Key 已保存');
  } catch (e) {
    if (hint) hint.textContent = '保存失败：' + e.message;
  }
}

async function clearCfApiKey() {
  try {
    await api('/api/cf/key', { method: 'POST', body: JSON.stringify({ apiKey: '' }) });
    const input = document.getElementById('cfApiKey');
    if (input) input.value = '';
    await loadCfApiKey();
    if (typeof toast === 'function') toast('CurseForge API Key 已清除');
  } catch (e) {
    if (typeof toast === 'function') toast('清除失败：' + e.message, 'err');
  }
}

function openCurseForgeKeySettings() {
  if (typeof showPanel === 'function') showPanel('settings');
  setTimeout(() => document.getElementById('cfApiKey')?.focus(), 80);
}
function renderRoom(room) {
  onlineRoom = room || { status: 'idle' };
  const card = document.getElementById('roomCard');
  if (!card) return;
  const status = onlineRoom.status || 'idle';
  const p = selectedFrpProvider();
  const configured = providerConfigured(p);
  const btn = document.getElementById('roomToggle');
  const statusEl = document.getElementById('roomStatus');
  const fields = document.getElementById('roomFields');
  const hint = document.getElementById('roomHint');
  const running = status === 'running';

  if (statusEl) {
    statusEl.textContent = running
      ? '运行中'
      : status === 'starting' ? '启动中'
        : status === 'stopping' ? '停止中'
          : status === 'error' ? '启动失败' : '未开房';
    statusEl.className = 'online-status' + (running ? ' on' : status === 'error' ? ' err' : '');
  }
  if (btn) {
    btn.disabled = !running && !configured;
    btn.classList.toggle('running', running);
    btn.textContent = running
      ? '停止房间'
      : status === 'starting' ? '正在启动…'
        : status === 'stopping' ? '正在停止…'
          : configured ? '开房间' : '先配置 frp';
  }
  if (fields) fields.hidden = status === 'idle';
  if (hint) {
    hint.textContent = status === 'error'
      ? (onlineRoom.error || roomFallbackError || '开房失败')
      : running
        ? `server 已在 25565 监听；world 会保留在 ${onlineRoom.worldDir || '服务端目录'}`
        : configured
          ? '勾选 EULA 后点击开房间；固定端口 25565，停服不删 world。'
          : '先在顶部配置 frp，再开房间。';
  }
  const fallbackBtn = document.getElementById('roomFallbackBtn');
  if (fallbackBtn) {
    const failedPack = Boolean(onlineRoom.pack) && status === 'error';
    fallbackBtn.hidden = !(status === 'error' || failedPack || roomFallbackError);
  }
  const cfKeyBtn = document.getElementById('roomCfKeyBtn');
  if (cfKeyBtn) {
    const errorText = String(onlineRoom.error || roomFallbackError || '');
    cfKeyBtn.hidden = !(status === 'error' && /CurseForge API Key/i.test(errorText));
  }
  if (running) roomFallbackError = '';
  const shownVersion = onlineRoom.pack?.gameVersion || onlineRoom.gameVersion || onlineRoom.versionId;
  if (shownVersion) {
    const v = document.getElementById('roomVersionValue');
    if (v) v.textContent = shownVersion;
  }
  const portEl = document.getElementById('roomPortValue');
  if (portEl) portEl.textContent = String(onlineRoom.port || 25565);
  const providerEl = document.getElementById('roomProviderValue');
  if (providerEl) providerEl.textContent = roomProviderLabel(p);
  const tunnelEl = document.getElementById('roomTunnelValue');
  if (tunnelEl) {
    const tunnel = document.getElementById(p + 'Tunnel');
    tunnelEl.textContent = tunnel?.selectedOptions?.[0]?.textContent || '未选择';
  }
  const addressEl = document.getElementById('roomAddressValue');
  const roomAddress = onlineRoom.frp?.address || onlineStateCache?.[p]?.address || '';
  if (addressEl) addressEl.textContent = roomAddress || '—';
  const copyBtn = document.getElementById('roomAddressCopy');
  if (copyBtn) copyBtn.hidden = !roomAddress;
  const worldEl = document.getElementById('roomWorldValue');
  if (worldEl) worldEl.textContent = onlineRoom.worldDir || '—';
}

function showRoomFallback(message) {
  roomFallbackError = String(message || '');
  const btn = document.getElementById('roomFallbackBtn');
  if (btn) btn.hidden = false;
}

function openRoomFallback() {
  const details = document.querySelector('.online-advanced');
  if (details) {
    details.open = true;
    details.classList.add('attention');
    details.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const lan = document.getElementById('lanPort');
  lan?.focus();
  const detect = document.getElementById('lanDetect');
  if (detect) {
    detect.classList.add('attention');
    setTimeout(() => detect.classList.remove('attention'), 2600);
  }
  if (typeof toast === 'function') {
    toast('已打开高级联机：先让游戏对局域网开放，再点「读游戏端口」');
  }
}

async function loadRoomState() {
  try {
    const r = await api('/api/online/room/state');
    renderRoom(r.room);
  } catch { /* 房间接口不可用时保持禁用状态 */ }
}

function fillWorldSettings(s = {}) {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = String(value ?? '');
  };
  set('wpKeepInventory', s.keepInventory);
  set('wpDifficulty', s.difficulty || 'normal');
  set('wpOnlineMode', s.onlineMode !== false);
  set('wpMaxPlayers', s.maxPlayers ?? 20);
  set('wpViewDistance', s.viewDistance ?? 10);
  set('wpPvp', s.pvp !== false);
  set('wpSpawnProtection', s.spawnProtection ?? 16);
}

function readWorldSettings() {
  return {
    keepInventory: Boolean(document.getElementById('wpKeepInventory')?.checked),
    difficulty: document.getElementById('wpDifficulty')?.value || 'normal',
    onlineMode: Boolean(document.getElementById('wpOnlineMode')?.checked),
    maxPlayers: Number(document.getElementById('wpMaxPlayers')?.value) || 20,
    viewDistance: Number(document.getElementById('wpViewDistance')?.value) || 10,
    pvp: Boolean(document.getElementById('wpPvp')?.checked),
    spawnProtection: Number(document.getElementById('wpSpawnProtection')?.value) || 0,
  };
}

async function loadWorldSettings(force = false) {
  const versionId = document.getElementById('roomVersion')?.value;
  if (!versionId) { fillWorldSettings(); return; }
  if (roomWorldSettings && !force) { fillWorldSettings(roomWorldSettings); return; }
  try {
    const r = await api('/api/online/room/settings?versionId=' + encodeURIComponent(versionId));
    roomWorldSettings = r.settings || null;
    fillWorldSettings(roomWorldSettings || {});
  } catch {
    fillWorldSettings();
  }
}

async function openWorldParams() {
  await loadWorldSettings(true);
  const note = document.getElementById('worldParamsNote');
  if (note) note.textContent = '';
  const modal = document.getElementById('worldParamsModal');
  if (modal) modal.hidden = false;
}

async function saveWorldParams() {
  const versionId = document.getElementById('roomVersion')?.value;
  if (!versionId) return;
  const btn = document.getElementById('worldParamsSave');
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/online/room/settings', {
      method: 'POST',
      body: JSON.stringify({ versionId, settings: readWorldSettings() }),
    });
    roomWorldSettings = r.settings;
    fillWorldSettings(roomWorldSettings);
    const labels = {
      onlineMode: '正版验证', maxPlayers: '最大人数', viewDistance: '视距',
      pvp: 'PvP', spawnProtection: '出生点保护',
    };
    const note = document.getElementById('worldParamsNote');
    if (note) {
      if (r.restartRequired?.length) {
        note.textContent = `已保存；${r.restartRequired.map((k) => labels[k] || k).join('、')}：重开房间生效。`;
      } else if (r.applied?.length) {
        note.textContent = '已保存，难度和死亡不掉落已立即下发。';
      } else {
        note.textContent = '已保存，下次开房生效。';
      }
    }
    if (typeof toast === 'function') toast('世界参数已保存');
  } catch (e) {
    if (typeof toast === 'function') toast('保存世界参数失败：' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function toggleRoom() {
  const btn = document.getElementById('roomToggle');
  if (btn?.disabled && onlineRoom.status !== 'running') return;
  if (onlineRoom.status === 'running' || onlineRoom.status === 'starting') {
    if (btn) { btn.disabled = true; btn.textContent = '正在停止…'; }
    try {
      const r = await api('/api/online/room/stop', { method: 'POST', body: '{}' });
      renderRoom(r.room);
      if (typeof toast === 'function') toast('房间已停止，world 保留');
    } catch (e) {
      if (typeof toast === 'function') toast('停止失败：' + e.message, 'err');
      await loadRoomState();
    }
    return;
  }
  if (!providerConfigured(selectedFrpProvider())) {
    if (typeof toast === 'function') toast('先配置 frp', 'err');
    return;
  }
  if (!document.getElementById('roomEula')?.checked) {
    if (typeof toast === 'function') toast('先勾选同意 Minecraft EULA', 'err');
    return;
  }
  const versionId = document.getElementById('roomVersion')?.value;
  if (!versionId) {
    if (typeof toast === 'function') toast('先安装一个原版实例', 'err');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '正在准备 server…'; }
  const hint = document.getElementById('roomHint');
  if (hint) hint.textContent = '正在下载/启动官方 server.jar…';
  const p = selectedFrpProvider();
  const tunnelSel = document.getElementById(p + 'Tunnel');
  const tunnelId = tunnelSel?.value || '';
  const tunnel = (onlineStateCache?.[p]?.tunnels || []).find((t) => String(t.id) === String(tunnelId));
  let remotePort = 0;
  if (p === 'custom') remotePort = Number(document.getElementById('customRemote')?.value) || 0;
  else {
    const m = /:(\d{1,5})\s*$/.exec(String(tunnel?.address || ''));
    remotePort = m ? Number(m[1]) : Number(tunnel?.remotePort) || 0;
  }
  const detail = (state.versionDetails || []).find((x) => x.id === versionId) || {};
  try {
    const r = await api('/api/online/room/start', {
      method: 'POST',
      body: JSON.stringify({
        versionId,
        memoryMb: Number(document.getElementById('roomMemory')?.value) || undefined,
        eulaAccepted: true,
        autoStopOnExit: Boolean(document.getElementById('roomAutoStop')?.checked),
        joinGame: Boolean(document.getElementById('roomJoinGame')?.checked),
        provider: p,
        tunnelId,
        remotePort,
        address: onlineStateCache?.[p]?.address || '',
        loader: detail.kind || detail.loader || 'vanilla',
        gameVersion: detail.gameVersion || versionId,
        settings: readWorldSettings(),
      }),
    });
    renderRoom(r.room);
    if (r.gameError && typeof toast === 'function') toast('服务端已开，但进入游戏失败：' + r.gameError, 'err');
    else if (typeof toast === 'function') toast('房间已开，端口 25565');
    await loadRecentPlay();
  } catch (e) {
    if (typeof toast === 'function') toast('开房失败：' + e.message, 'err');
    await loadRoomState();
    showRoomFallback(e.message);
    const hint = document.getElementById('roomHint');
    if (hint) hint.textContent = String(e.message || '开房失败');
  }
}

async function loadOnlineConfig() {
  try {
    const s = await api('/api/online/state');
    onlineStateCache = s;
    renderOnline('sakura', s.sakura);
    renderOnline('openfrp', s.openfrp);
    renderOnline('custom', s.custom);
    syncFrpProviderView();
  } catch { /* 保持禁用 */ }
}
async function loadRecentPlay() {
  const btn = document.getElementById('recentPlayBtn');
  if (!btn) return;
  try {
    const r = await api('/api/recent');
    const rec = r?.recent;
    if (!rec) {
      btn.hidden = true;
      return;
    }
    const detail = (state.versionDetails || []).find((x) => x.id === rec.versionId) || {};
    const modeText = rec.mode === 'single'
      ? '单人'
      : rec.role === 'host' ? '联机房主' : '联机';
    const extra = rec.mode === 'single'
      ? (rec.saveName ? ` · ${rec.saveName}` : '')
      : (rec.role === 'host'
        ? ` · ${rec.room?.provider || 'frp'}${rec.room?.remotePort ? `:${rec.room.remotePort}` : ''}`
        : ` · ${rec.joinAddress || ''}`);
    btn.hidden = false;
    const hint = document.getElementById('recentPlayHint');
    if (hint) hint.textContent = `${modeText} · ${rec.versionId}${extra}`;
    btn.dataset.version = rec.versionId;
    btn.dataset.mode = rec.mode;
  } catch {
    btn.hidden = true;
  }
}

async function runRecentPlay() {
  const btn = document.getElementById('recentPlayBtn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const hint = document.getElementById('recentPlayHint');
  if (hint) hint.textContent = '正在恢复…';
  try {
    const r = await api('/api/recent/launch', { method: 'POST', body: '{}' });
    if (typeof toast === 'function') toast(`已恢复 ${r.recent?.versionId || ''}`);
    await loadRecentPlay();
    await loadRoomState();
    await refreshOnline();
  } catch (e) {
    if (typeof toast === 'function') toast('最近游玩失败：' + e.message, 'err');
    await loadRecentPlay();
  } finally {
    btn.disabled = false;
  }
}
function initOnline() {
  const port = document.getElementById('lanPort');
  port?.addEventListener('input', loadLanInfo);
  document.getElementById('lanDetect')?.addEventListener('click', () => detectPort(false));
  document.getElementById('onlineConnect')?.addEventListener('click', unifiedConnect);
  document.getElementById('upnpConnect')?.addEventListener('click', toggleUpnp);
  document.getElementById('joinConnect')?.addEventListener('click', joinFriendRoom);
  document.getElementById('joinAddress')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinFriendRoom();
  });
  document.getElementById('recentAddresses')?.addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('joinAddress').value = e.target.value;
  });
  renderRecentAddresses();
  const providerSel = document.getElementById('onlineProvider');
  if (providerSel) {
    providerSel.value = localStorage.getItem('sakura.onlineProvider') || 'sakura';
    providerSel.addEventListener('change', syncFrpProviderView);
  }
  document.getElementById('roomToggle')?.addEventListener('click', toggleRoom);
  document.getElementById('roomFallbackBtn')?.addEventListener('click', openRoomFallback);
  document.getElementById('roomCfKeyBtn')?.addEventListener('click', openCurseForgeKeySettings);
  document.getElementById('cfApiKeySave')?.addEventListener('click', saveCfApiKey);
  document.getElementById('cfApiKeyClear')?.addEventListener('click', clearCfApiKey);
  loadCfApiKey();
  document.getElementById('worldParamsBtn')?.addEventListener('click', openWorldParams);
  document.getElementById('roomAddressCopy')?.addEventListener('click', async () => {
    const text = document.getElementById('roomAddressValue')?.textContent || '';
    if (!text || text === '—') return;
    try { await navigator.clipboard.writeText(text); if (typeof toast === 'function') toast('地址已复制'); } catch { if (typeof toast === 'function') toast('复制失败', 'err'); }
  });
  document.getElementById('worldParamsClose')?.addEventListener('click', () => { const m = document.getElementById('worldParamsModal'); if (m) m.hidden = true; });
  document.getElementById('worldParamsCancel')?.addEventListener('click', () => { const m = document.getElementById('worldParamsModal'); if (m) m.hidden = true; });
  document.getElementById('worldParamsSave')?.addEventListener('click', saveWorldParams);
  document.getElementById('recentPlayBtn')?.addEventListener('click', runRecentPlay);
  document.getElementById('roomEula')?.addEventListener('change', () => renderRoom(onlineRoom));
  document.getElementById('roomVersion')?.addEventListener('change', () => { roomWorldSettings = null; renderRoom(onlineRoom); loadWorldSettings(true); loadRoomMemory(); });
  document.getElementById('roomMemory')?.addEventListener('change', saveRoomMemory);
  renderRoomVersions();
  loadRoomMemory();
  loadRoomState();
  loadRecentPlay();
  setTimeout(() => { renderRoomVersions(); loadWorldSettings(true); }, 1200);
  document.getElementById('customSave')?.addEventListener('click', saveCustomFrps);
  document.getElementById('customStart')?.addEventListener('click', startCustomFrps);
  document.getElementById('customStop')?.addEventListener('click', () => stopProviderTunnel('custom'));
  document.getElementById('sakuraRegister')?.addEventListener('click', () => openProviderRegister('sakura'));
  document.getElementById('openfrpRegister')?.addEventListener('click', () => openProviderRegister('openfrp'));

  for (const p of ['sakura', 'openfrp']) {
    document.getElementById(p + 'Detect')?.addEventListener('click', () => importProviderClient(p));
    document.getElementById(p + 'Save')?.addEventListener('click', () => saveOnlineToken(p));
    document.getElementById(p + 'Refresh')?.addEventListener('click', () => refreshProviderTunnels(p));
    document.getElementById(p + 'Create')?.addEventListener('click', () => createProviderTunnel(p));
    document.getElementById(p + 'Start')?.addEventListener('click', () => startProviderTunnel(p));
    document.getElementById(p + 'Stop')?.addEventListener('click', () => stopProviderTunnel(p));
    document.getElementById(p + 'Token')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveOnlineToken(p);
    });
  }
  refreshOnline();
  detectOnlineTools();
}

initOnline();

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const src = document.getElementById(btn.dataset.copy);
    if (!src) return;
    const text = src.dataset.ips || src.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1500);
    } catch {
      // 没有剪贴板权限就退化成选中文本
      const range = document.createRange();
      range.selectNodeContents(src);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = '已选中';
      setTimeout(() => { btn.textContent = '复制'; }, 1500);
    }
  });
});

function friendlyNetError(err) {
  const raw = String(err ?? '');
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return `域名解析失败（${raw}）`;
  if (/ETIMEDOUT|连接超时/i.test(raw)) return `连接超时（${raw}）`;
  if (/ECONNREFUSED/i.test(raw)) return `服务器拒绝连接（${raw}）`;
  if (/ECONNRESET/i.test(raw)) return `连接被重置（${raw}）`;
  return raw || '未知错误';
}

async function pingServer() {
  const host = document.getElementById('mcHost').value.trim();
  const out = document.getElementById('mcPingResult');
  const btn = document.getElementById('mcPingBtn');

  if (!host) {
    out.textContent = '先填个地址';
    return;
  }

  btn.disabled = true;
  out.textContent = '正在连接…';
  try {
    const r = await api('/api/net/ping', {
      method: 'POST',
      body: JSON.stringify({ host }),
    });
    const motd = escapeHtml(r.motd || '').replace(/\n/g, '<br>');
    out.innerHTML = r.ok
      ? `<span style="color:var(--ok)">在线</span> · ${escapeHtml(r.host)}:${r.port} · ${r.ms} ms` +
        (r.version ? ` · ${escapeHtml(r.version)}` : '') +
        (r.players ? ` · ${r.players.online}/${r.players.max} 人` : '') +
        (motd ? `<br><span class="hint">${motd}</span>` : '') +
        (r.srv ? `<br><span class="hint">SRV → ${escapeHtml(r.srv.name)}:${r.srv.port}</span>` : '')
      : `<span style="color:var(--err)">连不上</span> · ${escapeHtml(friendlyNetError(r.error))}`;
  } catch (e) {
    out.textContent = '测试失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('mcPingBtn').addEventListener('click', pingServer);
document.getElementById('mcHost').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pingServer();
});

/* ---------------- 自定义：配色 ---------------- */

const THEMES = [
  { id: 'blackgold', name: '黑金', note: '默认 · 沉稳', bg: '#14141a', accent: '#d4af37' },
  { id: 'sakura', name: '樱粉', note: '柔和 · 暖', bg: '#1e151b', accent: '#ff8fb1' },
  { id: 'ocean', name: '深海', note: '冷色 · 清爽', bg: '#101a2b', accent: '#4a9eff' },
  { id: 'forest', name: '初音绿', note: '经典 · 明亮', bg: '#161c24', accent: '#39c5bb' },
  { id: 'violet', name: '紫罗兰', note: '安静 · 夜晚', bg: '#171424', accent: '#a78bfa' },
  { id: 'light', name: '白昼', note: '浅色 · 白底', bg: '#f5f2eb', accent: '#b7791f' },
];

const THEME_KEY = 'sakura.theme';
const ACCENT_KEY = 'sakura.accent';
const BG_COLOR_KEY = 'sakura.bgColor';
const TEXT_COLOR_KEY = 'sakura.textColor';
const BG_KEY = 'sakura.bg';
const BG_PATH_KEY = 'sakura.bgPath';
const BG_FIT_KEY = 'sakura.bgFit';

function rgbOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 15, g: 20, b: 25 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function hexOf({ r, g, b }) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function mixHex(a, b, t) {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return hexOf({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

function applyCustomTheme(accent, bg, text) {
  const accentHex = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#d4af37';
  const bgHex = /^#[0-9a-f]{6}$/i.test(bg) ? bg : '#0b0b0d';
  const textHex = /^#[0-9a-f]{6}$/i.test(text) ? text : '#f0e9d8';
  const bg2 = mixHex(bgHex, '#ffffff', 0.07);
  const bg3 = mixHex(bgHex, '#ffffff', 0.12);
  const dim = mixHex(textHex, bgHex, 0.48);
  const c = rgbOf(bg2);
  document.documentElement.dataset.theme = 'custom';
  document.body.dataset.theme = 'custom';
  const root = document.documentElement.style;
  root.setProperty('--accent', accentHex);
  root.setProperty('--accent-2', shade(accentHex, -0.18));
  root.setProperty('--bg', bgHex);
  root.setProperty('--bg-2', bg2);
  root.setProperty('--bg-3', bg3);
  root.setProperty('--bg-2-rgb', `${c.r}, ${c.g}, ${c.b}`);
  root.setProperty('--text', textHex);
  root.setProperty('--text-dim', dim);
  const luminance = (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) / 255;
  const light = luminance > 0.55;
  document.documentElement.style.colorScheme = light ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', light);
  localStorage.setItem(ACCENT_KEY, accentHex);
  localStorage.setItem(BG_COLOR_KEY, bgHex);
  localStorage.setItem(TEXT_COLOR_KEY, textHex);
  localStorage.setItem(THEME_KEY, 'custom');
  renderThemeGrid();
}

function applyTheme(id) {
  // html 和 body 都写：CSS 变量在 html 上也能立刻级联，
  // 避免某些组件在 body 变量切换时没有重绘。
  document.documentElement.dataset.theme = id;
  document.body.dataset.theme = id;
  // 预设主题优先于之前自定义留下的 inline 变量
  for (const v of ['--accent', '--accent-2', '--bg', '--bg-2', '--bg-3', '--bg-2-rgb', '--text', '--text-dim']) {
    document.documentElement.style.removeProperty(v);
  }
  document.documentElement.style.colorScheme = id === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', id === 'light');
  localStorage.setItem(THEME_KEY, id);
  renderThemeGrid();
}

function currentVar(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

/** 自定义主题色：直接改 CSS 变量，优先级高于预设 */
function applyCustomAccent(hex) {
  applyCustomTheme(
    hex,
    localStorage.getItem(BG_COLOR_KEY) || currentVar('--bg', '#0b0b0d'),
    localStorage.getItem(TEXT_COLOR_KEY) || currentVar('--text', '#f0e9d8')
  );
}

/** 把 #rrggbb 调亮/调暗，amount 为负变暗 */
function shade(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((num >> 16) & 255) * (1 + amount));
  const g = clamp(((num >> 8) & 255) * (1 + amount));
  const b = clamp((num & 255) * (1 + amount));
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function renderThemeGrid() {
  const grid = document.getElementById('themeGrid');
  if (!grid) return;

  const cur = localStorage.getItem(THEME_KEY) || 'blackgold';
  grid.innerHTML = THEMES.map((t) => `
    <button class="theme-tile ${t.id === cur ? 'active' : ''}" data-theme-id="${t.id}">
      <div class="theme-swatch" style="background:${t.bg};--sw-accent:${t.accent}"></div>
      <div class="theme-name">${t.name}</div>
      <div class="theme-note">${t.note}</div>
    </button>`).join('');

  grid.querySelectorAll('[data-theme-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.themeId);
      // 换了预设就把自定义色清掉，否则两套规则打架
      localStorage.removeItem(ACCENT_KEY);
      localStorage.removeItem(BG_COLOR_KEY);
      localStorage.removeItem(TEXT_COLOR_KEY);
      for (const v of ['--accent', '--accent-2', '--bg', '--bg-2', '--bg-3', '--bg-2-rgb', '--text', '--text-dim']) {
        document.documentElement.style.removeProperty(v);
      }
      syncColorPickers();
    });
  });
}

/* 自定义色 / 背景图 */
let customColorValues = { accent: '#d4af37', bg: '#0b0b0d', text: '#f0e9d8' };

function rgbToHsl(hex) {
  const { r, g, b } = rgbOf(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(h, s, l) {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  if (sn === 0) { const v = Math.round(ln * 255); return { r: v, g: v, b: v }; }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue(hn + 1 / 3) * 255),
    g: Math.round(hue(hn) * 255),
    b: Math.round(hue(hn - 1 / 3) * 255),
  };
}

function hslHex(h, s, l) {
  return hexOf(hslToRgb(h, s, l));
}

function createColorPicker(slot, key) {
  if (!slot) return null;
  let { h, s, l } = rgbToHsl(customColorValues[key] || '#000000');
  const wrap = document.createElement('div');
  wrap.className = 'cp';
  wrap.innerHTML = `
    <button class="cp-trigger" type="button">
      <span class="cp-swatch"></span><span class="cp-hex-label"></span>
    </button>
    <div class="cp-popover" hidden>
      <canvas class="cp-canvas" width="220" height="132"></canvas>
      <input class="cp-hue" type="range" min="0" max="360" step="1" aria-label="色相">
      <div class="cp-fields">
        <label class="cp-field">H<input class="cp-h" type="number" min="0" max="360" step="1"></label>
        <label class="cp-field">S<input class="cp-s" type="number" min="0" max="100" step="1"></label>
        <label class="cp-field">L<input class="cp-l" type="number" min="0" max="100" step="1"></label>
      </div>
      <div class="cp-hex-row"><input class="cp-hex" type="text" maxlength="7" spellcheck="false" aria-label="十六进制颜色"></div>
    </div>`;
  slot.replaceChildren(wrap);
  const trigger = wrap.querySelector('.cp-trigger');
  const pop = wrap.querySelector('.cp-popover');
  const canvas = wrap.querySelector('.cp-canvas');
  const hue = wrap.querySelector('.cp-hue');
  const hInput = wrap.querySelector('.cp-h');
  const sInput = wrap.querySelector('.cp-s');
  const lInput = wrap.querySelector('.cp-l');
  const hexInput = wrap.querySelector('.cp-hex');
  const swatch = wrap.querySelector('.cp-swatch');
  const label = wrap.querySelector('.cp-hex-label');
  const ctx = canvas.getContext('2d');

  const currentHex = () => hslHex(h, s, l);
  const paintCanvas = () => {
    if (!ctx) return;
    const image = ctx.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const rgb = hslToRgb(h, (x / (canvas.width - 1)) * 100, (1 - y / (canvas.height - 1)) * 100);
        const i = (y * canvas.width + x) * 4;
        image.data[i] = rgb.r; image.data[i + 1] = rgb.g; image.data[i + 2] = rgb.b; image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const cx = (s / 100) * (canvas.width - 1);
    const cy = (1 - l / 100) * (canvas.height - 1);
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.stroke();
  };
  const update = (emit = true) => {
    const value = currentHex();
    swatch.style.background = value;
    label.textContent = value;
    hue.value = h;
    hInput.value = h;
    sInput.value = s;
    lInput.value = l;
    hexInput.value = value;
    paintCanvas();
    if (emit) {
      customColorValues[key] = value;
      applyCustomTheme(customColorValues.accent, customColorValues.bg, customColorValues.text);
    }
  };
  const setHex = (value) => {
    if (!/^#[0-9a-f]{6}$/i.test(value)) return;
    ({ h, s, l } = rgbToHsl(value));
    update(false);
  };
  const setHsl = (nextH = h, nextS = s, nextL = l) => {
    h = Math.max(0, Math.min(360, Number(nextH) || 0));
    s = Math.max(0, Math.min(100, Number(nextS) || 0));
    l = Math.max(0, Math.min(100, Number(nextL) || 0));
    update(true);
  };
  const position = () => {
    const r = trigger.getBoundingClientRect();
    const width = 236;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.min(window.innerHeight - 260, r.bottom + 6)}px`;
  };
  const close = () => { pop.hidden = true; };
  trigger.addEventListener('click', (ev) => {
    ev.stopPropagation();
    document.querySelectorAll('.cp-popover').forEach((p) => { if (p !== pop) p.hidden = true; });
    pop.hidden = !pop.hidden;
    if (!pop.hidden) { position(); paintCanvas(); }
  });
  pop.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', close);
  canvas.addEventListener('pointerdown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const pick = (e) => setHsl(h, ((e.clientX - rect.left) / rect.width) * 100, (1 - (e.clientY - rect.top) / rect.height) * 100);
    pick(ev);
    const move = (e) => pick(e);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  });
  hue.addEventListener('input', () => setHsl(Number(hue.value), s, l));
  hInput.addEventListener('change', () => setHsl(hInput.value, s, l));
  sInput.addEventListener('change', () => setHsl(h, sInput.value, l));
  lInput.addEventListener('change', () => setHsl(h, s, lInput.value));
  hexInput.addEventListener('input', () => {
    const v = hexInput.value.trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      ({ h, s, l } = rgbToHsl(v));
      update(true);
    }
  });
  update(false);
  return { setHex, close };
}

let colorPickers = {};
function syncColorPickers() {
  const values = {
    accent: localStorage.getItem(ACCENT_KEY) || currentVar('--accent', '#d4af37'),
    bg: localStorage.getItem(BG_COLOR_KEY) || currentVar('--bg', '#0b0b0d'),
    text: localStorage.getItem(TEXT_COLOR_KEY) || currentVar('--text', '#f0e9d8'),
  };
  customColorValues = values;
  for (const [key, picker] of Object.entries(colorPickers)) picker?.setHex(values[key]);
}

function initColorPickers() {
  customColorValues = {
    accent: localStorage.getItem(ACCENT_KEY) || currentVar('--accent', '#d4af37'),
    bg: localStorage.getItem(BG_COLOR_KEY) || currentVar('--bg', '#0b0b0d'),
    text: localStorage.getItem(TEXT_COLOR_KEY) || currentVar('--text', '#f0e9d8'),
  };
  colorPickers = {
    accent: createColorPicker(document.getElementById('colorPickerAccent'), 'accent'),
    bg: createColorPicker(document.getElementById('colorPickerBg'), 'bg'),
    text: createColorPicker(document.getElementById('colorPickerText'), 'text'),
  };
}

document.getElementById('bgPick').addEventListener('click', () => {
  document.getElementById('bgFile').click();
});

document.getElementById('bgFile').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  // 图太大塞进 localStorage 会超配额，超过 1.5MB 就不收
  if (file.size > 1.5 * 1024 * 1024) {
    alert('图片太大了（超过 1.5MB），换一张小一点的');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      localStorage.setItem(BG_KEY, reader.result);
      if (file.path) localStorage.setItem(BG_PATH_KEY, file.path);
      else localStorage.removeItem(BG_PATH_KEY);
      applyBg();
    } catch {
      alert('保存失败，可能浏览器存储空间不够');
    }
  };
  reader.readAsDataURL(file);
});

document.getElementById('bgFit')?.addEventListener('change', (e) => {
  localStorage.setItem(BG_FIT_KEY, e.target.value);
  applyBg();
});

document.getElementById('bgClear').addEventListener('click', () => {
  localStorage.removeItem(BG_KEY);
  localStorage.removeItem(BG_PATH_KEY);
  localStorage.removeItem(BG_FIT_KEY);
  applyBg();
});

function applyBg() {
  const bg = localStorage.getItem(BG_KEY);
  const fit = localStorage.getItem(BG_FIT_KEY) || 'cover';
  const preview = document.getElementById('bgPreview');
  const fitSelect = document.getElementById('bgFit');
  if (fitSelect) fitSelect.value = fit;
  if (bg) {
    document.body.classList.add('has-custom-bg');
    document.documentElement.style.setProperty('--custom-bg', `url("${bg}")`);
    const fitMap = {
      cover: ['cover', 'no-repeat', 'center'],
      contain: ['contain', 'no-repeat', 'center'],
      tile: ['auto', 'repeat', 'left top'],
      center: ['auto', 'no-repeat', 'center'],
      stretch: ['100% 100%', 'no-repeat', 'center'],
    };
    const [size, repeat, position] = fitMap[fit] || fitMap.cover;
    document.documentElement.style.setProperty('--custom-bg-size', size);
    document.documentElement.style.setProperty('--custom-bg-repeat', repeat);
    document.documentElement.style.setProperty('--custom-bg-position', position);
    if (preview) {
      const mode = { cover: '铺满裁切', contain: '完整显示', tile: '平铺', center: '居中', stretch: '拉伸铺满' }[fit] || '铺满裁切';
      preview.textContent = `当前使用：本地图片 · ${mode}`;
    }
  } else {
    document.body.classList.remove('has-custom-bg');
    document.documentElement.style.removeProperty('--custom-bg');
    document.documentElement.style.removeProperty('--custom-bg-size');
    document.documentElement.style.removeProperty('--custom-bg-repeat');
    document.documentElement.style.removeProperty('--custom-bg-position');
    if (preview) preview.textContent = '当前使用：跟随系统壁纸';
  }
}

/* 启动时恢复上次的主题 */
(function restoreTheme() {
  const id = localStorage.getItem(THEME_KEY);
  const accent = localStorage.getItem(ACCENT_KEY);
  const bg = localStorage.getItem(BG_COLOR_KEY);
  const text = localStorage.getItem(TEXT_COLOR_KEY);
  if (id) {
    document.documentElement.dataset.theme = id;
    document.body.dataset.theme = id;
  }
  // 只有当前就是 custom 才恢复自定义色；否则预设会被 inline 色盖掉
  if (id === 'custom') {
    applyCustomTheme(accent || '#d4af37', bg || '#0b0b0d', text || '#f0e9d8');
  } else if (id === 'light') {
    document.documentElement.style.colorScheme = 'light';
  }
  applyBg();
  initColorPickers();
})();

/* ---------------- 插件（高级配置） ---------------- */

let pluginState = { list: [], currentId: null };

async function loadPlugins() {
  const box = document.getElementById('pluginList');
  if (!box) return;
  try {
    const data = await api('/api/plugins');
    pluginState.list = data.plugins || [];
    renderPluginList();
  } catch (e) {
    box.innerHTML = `<div class="hint">读取插件失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderPluginList() {
  const box = document.getElementById('pluginList');
  if (!box) return;

  if (!pluginState.list.length) {
    box.innerHTML = '<div class="hint">还没有插件。写一个能让启动更贴合你机器的组合</div>';
    return;
  }

  box.innerHTML = pluginState.list.map((p) => `
    <div class="plugin-row ${p.id === pluginState.currentId ? 'active' : ''} ${p.enabled ? 'enabled' : ''}"
         data-plugin="${escapeHtml(p.id)}">
      <span>${escapeHtml(p.name)}</span>
      <span class="plugin-on">${p.enabled ? '已启用' : '已停用'}</span>
    </div>`).join('');

  box.querySelectorAll('[data-plugin]').forEach((row) => {
    row.addEventListener('click', () => selectPlugin(row.dataset.plugin));
  });
}

function selectPlugin(id) {
  const p = pluginState.list.find((x) => x.id === id);
  if (!p) return;
  pluginState.currentId = id;
  document.getElementById('pluginName').value = p.name;
  document.getElementById('pluginCode').value = p.code;
  document.getElementById('pluginStatus').textContent = '';
  renderPluginList();
}

document.getElementById('pluginNew').addEventListener('click', () => {
  pluginState.currentId = null;
  document.getElementById('pluginName').value = '';
  document.getElementById('pluginCode').value = '';
  document.getElementById('pluginStatus').textContent = '新插件：写完点「保存插件」';
  renderPluginList();
});

document.getElementById('pluginSave').addEventListener('click', async () => {
  const name = document.getElementById('pluginName').value.trim();
  const code = document.getElementById('pluginCode').value;
  const out = document.getElementById('pluginStatus');

  if (!name) { out.textContent = '先给插件起个名字'; return; }
  if (!code.trim()) { out.textContent = '代码不能为空'; return; }

  try {
    const data = await api('/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ id: pluginState.currentId, name, code }),
    });
    pluginState.list = data.plugins || [];
    const saved = pluginState.list.find((x) => x.name === name);
    if (saved) pluginState.currentId = saved.id;
    renderPluginList();
    out.textContent = '已保存';
  } catch (e) {
    out.textContent = '保存失败：' + e.message;
  }
});

document.getElementById('pluginRun').addEventListener('click', async () => {
  const code = document.getElementById('pluginCode').value;
  const out = document.getElementById('pluginStatus');
  out.textContent = '试运行中…';
  try {
    const r = await api('/api/plugins/test', {
      method: 'POST',
      body: JSON.stringify({ code, instance: state.selectedVersion || '' }),
    });
    if (!r.ok) {
      out.innerHTML = `<span style="color:var(--err)">出错了：${escapeHtml(r.error)}</span>`;
      return;
    }
    const jvm = r.extraJvm.length ? r.extraJvm.join(' ') : '(无)';
    const game = r.extraGame.length ? r.extraGame.join(' ') : '(无)';
    out.innerHTML = `<span style="color:var(--ok)">成功了</span><br>JVM：<code>${escapeHtml(jvm)}</code><br>游戏：<code>${escapeHtml(game)}</code>`;
  } catch (e) {
    out.textContent = '试运行失败：' + e.message;
  }
});

document.getElementById('pluginDelete').addEventListener('click', async () => {
  if (!pluginState.currentId) {
    document.getElementById('pluginStatus').textContent = '先选一个插件';
    return;
  }
  try {
    const data = await api('/api/plugins/delete', {
      method: 'POST',
      body: JSON.stringify({ id: pluginState.currentId }),
    });
    pluginState.list = data.plugins || [];
    pluginState.currentId = null;
    document.getElementById('pluginName').value = '';
    document.getElementById('pluginCode').value = '';
    renderPluginList();
    document.getElementById('pluginStatus').textContent = '已删除';
  } catch (e) {
    document.getElementById('pluginStatus').textContent = '删除失败：' + e.message;
  }
});

/* ---------------- 更多：鸣谢 ---------------- */

/* 名单来自 GitHub API（repos/Meloong-Git/PCL/contributors）实拉的，
   按提交数排序的前 40 位；仓库共 58 位贡献者。没有编造。 */
const PCL_CONTRIBUTORS = [
  'allMagicNB', 'RyogiMutsuki', 'wyc-26', 'Pigeon0v0', 'tangge233',
  'Silverteal', 'zkitefly', 'wuliaodexiaoluo', 'MoYuan-CN', 'Open-KFC',
  'MatchaOre', 'HerobrineXia', 'youzi-3222', 'pynickle', '0x1A5',
  '3gf8jv4dv', 'Pearl-Luo', 'hadesanc1', 'CerikoSky', 'SALTWOOD',
  'tmdakm', 'Neclyon', 'shanlisi567', 'WForst-Breeze', 'Light-Beacon',
  'so1ve', 'lingting', 'lactobionicAcid', 'CiiLu', 'Hill23333',
  'Howard302', 'killcerr', 'Ad-closeNN', 'pover0k', 'nanhuajiaren',
  'Chiloven945', 'Mxmilu666', 'Txt-Text', 'Copilot', 'shatyuka',
];

let creditsRendered = false;
function renderCredits() {
  if (creditsRendered) return;
  const box = document.getElementById('pclContributors');
  if (!box) return;
  creditsRendered = true;
  box.innerHTML = PCL_CONTRIBUTORS.map((n) => `<span>${escapeHtml(n)}</span>`).join('')
    + '<span>…等共 58 位</span>';
}

/* ---------------- 更多：回声洞 ---------------- */

let echoMessages = [];
let echoCurrent = '';
let echoTimer = 0;

function pickEcho(avoid) {
  if (!echoMessages.length) return '';
  if (echoMessages.length === 1) return echoMessages[0];
  let next = avoid;
  for (let i = 0; i < 12 && next === avoid; i++) {
    next = echoMessages[Math.floor(Math.random() * echoMessages.length)];
  }
  return next === avoid ? echoMessages[(echoMessages.indexOf(avoid) + 1) % echoMessages.length] : next;
}

function paintEcho(text, animate = true) {
  const msg = document.getElementById('echoMessage');
  if (!msg) return;
  if (!animate) {
    msg.textContent = text;
    msg.style.opacity = '1';
    return;
  }
  msg.style.opacity = '0';
  clearTimeout(echoTimer);
  echoTimer = setTimeout(() => {
    msg.textContent = text;
    requestAnimationFrame(() => { msg.style.opacity = '1'; });
  }, 100);
}

function nextEcho() {
  if (!echoMessages.length) return;
  const next = pickEcho(echoCurrent);
  if (!next) return;
  echoCurrent = next;
  try { localStorage.setItem('sakura.echo.last', next); } catch { /* 忽略隐私模式 */ }
  paintEcho(next, true);
}

async function initEchoHollow() {
  const local = Array.isArray(window.ECHO_HOLLOW) ? window.ECHO_HOLLOW.filter(Boolean) : [];
  let remote = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch('/api/echo', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : data?.messages;
      if (Array.isArray(list)) {
        remote = list.map((x) => typeof x === 'string' ? x : x?.text).filter(Boolean);
      }
    }
  } catch {
    remote = null;
  }
  echoMessages = remote && remote.length ? remote : local;
  if (!echoMessages.length) return;
  let saved = '';
  try { saved = localStorage.getItem('sakura.echo.last') || ''; } catch { /* 忽略 */ }
  const savedIndex = echoMessages.indexOf(saved);
  echoCurrent = savedIndex >= 0 ? saved : echoMessages[Math.floor(Math.random() * echoMessages.length)];
  paintEcho(echoCurrent, false);
  const card = document.getElementById('echoCard');
  card?.addEventListener('click', nextEcho);
  card?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      nextEcho();
    }
  });
}

initEchoHollow();
/* ---------------- 更多：百宝箱 ---------------- */

document.getElementById('tbOpenContent').addEventListener('click', () => {
  if (!state.selectedVersion) {
    alert('先去「版本」选一个实例');
    return;
  }
  showPanel('home');
  if (typeof openContent === 'function') openContent(state.selectedVersion);
});

document.getElementById('tbOpenDir').addEventListener('click', async () => {
  try {
    await api('/api/game-dir/open', { method: 'POST' });
    if (typeof toast === 'function') toast('已打开游戏目录', 'ok');
  } catch (e) {
    if (typeof toast === 'function') toast('打开失败：' + e.message, 'err');
    else alert('打开失败：' + e.message);
  }
});

document.getElementById('tbLogs').addEventListener('click', () => {
  document.getElementById('logsGroup')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---------------- 初始化 ---------------- */

setSub('vanilla');

// 拖到最后：app.js 可能还没跑完，等下一帧再绑定
requestAnimationFrame(() => {
  renderThemeGrid();
  renderCredits();
});

/* 内存控件兜底绑定，避免 app.js 早期错误导致推荐值失效。 */
document.getElementById('memRecommend')?.addEventListener('click', () => {
  if (typeof applyRecommendedMemory === 'function') applyRecommendedMemory();
});
document.getElementById('setMemMaxRange')?.addEventListener('input', (e) => {
  const max = document.getElementById('setMemMax');
  if (max) max.value = `${e.target.value}M`;
  if (typeof updateMemTotal === 'function') updateMemTotal();
});
document.getElementById('setMemMaxRange')?.addEventListener('pointerdown', () => {
  if (typeof loadSystemMemory === 'function') loadSystemMemory();
});
document.getElementById('setMemMax')?.addEventListener('input', () => {
  if (typeof updateMemTotal === 'function') updateMemTotal();
});

/* ---------------- 设置分类 ---------------- */
function initSettingsCategories() {
  const panel = document.getElementById('panel-settings');
  const tabs = document.getElementById('settingsTabs');
  if (!panel || !tabs) return;
  const groups = [...panel.querySelectorAll('.settings-group')];
  const byTitle = {
    '游戏设置': 'game',
    '更新检查': 'download',
    '下载设置': 'download',
    '启动器设置': 'launcher',
    '高级配置（插件）': 'advanced',
    'CurseForge API': 'advanced',
  };
  for (const group of groups) {
    const title = group.querySelector('.group-title')?.textContent.trim() || '';
    group.dataset.settingsCat = byTitle[title] || 'advanced';
  }
  const buttons = [...tabs.querySelectorAll('[data-settings-cat]')];
  const apply = (cat) => {
    for (const group of groups) group.hidden = cat !== 'all' && group.dataset.settingsCat !== cat;
    for (const btn of buttons) {
      const on = btn.dataset.settingsCat === cat;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    }
    localStorage.setItem('sakura.settingsCategory', cat);
  };
  const saved = localStorage.getItem('sakura.settingsCategory') || 'all';
  apply(buttons.some((b) => b.dataset.settingsCat === saved) ? saved : 'all');
  for (const btn of buttons) btn.addEventListener('click', () => apply(btn.dataset.settingsCat));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSettingsCategories);
else initSettingsCategories();
