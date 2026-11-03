/* Sakura Minecraft Launcher 前端逻辑：原生 JS，无构建步骤 */

const $ = (id) => document.getElementById(id);

const state = {
  gameDir: '',
  version: '',
  versions: [],
  remote: [],
  installing: null,
  running: null,
  storeType: 'mod',
  storeInstance: '',
  storeHits: [],
  packs: [],
  // 整合包从哪些站点找：可以多选，两个都选就是合并搜索
  packSources: ['modrinth', 'curseforge'],
  // 取消「全部」时退回哪个来源（记住最近一次的单选）
  lastPackSingle: 'modrinth',
  // 多选时一次拉多少条就存在这里，翻页在本地切，不再反复请求
  packAll: [],
  contentVersion: null,
  // 分页：每页多少条 + 当前页 + 后端报的总数
  storePage: { offset: 0, limit: 24, total: 0 },
  packPage: { offset: 0, limit: 24, total: 0 },
  // 左侧选中哪个实例（主页大按钮启动它）
  selectedVersion: localStorage.getItem('sakura.selectedVersion') || '',
  // 每个实例的 loader / 游戏版本，版本列表画图标用
  versionDetails: [],
  username: 'Player',
  // 账号
  accounts: [],
  selectedAccount: null,
  // 追更
  tracked: [],
  trackIntervalMs: 0,
};

/* ---------------- 工具 ---------------- */

function api(path, opts) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || `HTTP ${r.status}`);
      err.code = data.code || '';
      err.missing = data.missing || [];
      err.preflight = data.preflight || null;
      throw err;
    }
    return data;
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/**
 * 把时间转成「几分前 / 几小时前」这种一眼能看出新鲜度的形式。
 * 追整合包时，光看日期不够 —— 差 10 分钟就是真新鲜，差 10 天就是旧包。
 */
function fmtAge(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return '刚刚';
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return (s / 3600).toFixed(1) + ' 小时前';
  if (s < 86400 * 30) return Math.round(s / 86400) + ' 天前';
  if (s < 86400 * 365) return (s / 86400 / 30).toFixed(1) + ' 个月前';
  return (s / 86400 / 365).toFixed(1) + ' 年前';
}

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtNum(n) {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

/* ---------------- 状态显示 ---------------- */

function setStatus(kind, text) {
  $('dot').className = 'dot ' + kind;
  $('statusText').textContent = text;
}

function setAppVersion(v) {
  if (!v) return;
  state.version = v;
  for (const id of ['appVersion', 'aboutVersion']) {
    const el = $(id);
    if (el) el.textContent = `v${v}`;
  }
}

function refreshStatus() {
  if (state.installing) {
    setStatus('busy', `安装 ${state.installing.versionId ?? ''}`);
  } else if (state.running) {
    setStatus('running', `运行 ${state.running.versionId}`);
  } else {
    setStatus('idle', '空闲');
  }
  // 主页大按钮跟着安装/运行状态变
  if (typeof updateHome === 'function') updateHome();
}

/* ---------------- 进度 ---------------- */

let installRevealTimer = null;

/* 用户主动收起：下载/安装照继续，只是不再占着整屏。
   把这个状态记在模块级，showProgress(true) 反复被调时不能又把整页掀开 ——
   否则每来一条进度事件就弹一次，收起等于没用。 */
let installCollapsed = false;

function setInstallCollapsed(collapsed) {
  installCollapsed = collapsed;
  const page = $('installPage');
  const bar = $('progressBar');

  if (collapsed) {
    page.classList.remove('show');
    // 收起后变成右下角的小浮窗：照 PCL，随时点一下就能回来
    bar.classList.remove('stowed');
    bar.classList.add('floating');
    // 等淡出走完再 hidden
    setTimeout(() => {
      if (!page.classList.contains('show')) page.hidden = true;
    }, 220);
  } else {
    // 只在一个活真在跑时才掀开；已完成的不该被点一下就弹个空卡片
    if (!bar.classList.contains('show')) return;
    bar.classList.remove('floating');
    page.hidden = false;
    requestAnimationFrame(() => page.classList.add('show'));
    bar.classList.add('stowed');
  }
}

/* 取消后的提示文案。
   msg.message 本身就是「已取消」，直接拼成「已取消 — ${msg.message}」
   会变成「已取消 — 已取消」（已实测踩过）。这里统一判定，只保留一份。 */
function cancelText(message) {
  const keep = '已下载的文件会保留，下次接着下';
  const m = String(message ?? '').trim();
  if (!m || /^已取消$/.test(m)) return `已取消 — ${keep}`;
  return `已取消 — ${m}`;
}

/* 取消按钮的三个状态：可点 / 转圈等 / 已失效。
   抽成函数是因为安装开始、完成、失败、取消四处都要管它，
   散着写很容易漏一处，留下一个“点了没反应”的按钮。 */
function resetCancelButton() {
  const btn = $('installCancel');
  if (!btn) return;
  btn.disabled = false;
  btn.classList.remove('busy');
  btn.hidden = false;
}

function disableCancelButton() {
  const btn = $('installCancel');
  if (!btn) return;
  btn.classList.remove('busy');
  btn.disabled = true;
}

function showProgress(show) {
  const bar = $('progressBar');
  bar.classList.toggle('show', show);
  if (!show) bar.removeAttribute('data-state');

  const page = $('installPage');
  if (show) {
    // 用户已经收起了：只留右下角浮窗，不要再把整页弹回来
    if (installCollapsed) {
      clearTimeout(installRevealTimer);
      installRevealTimer = null;
      page.classList.remove('show');
      bar.classList.remove('stowed');
      bar.classList.add('floating');
      return;
    }
    // 太快的操作（比如只装一个小文件）不该闪一整屏，
    // 等它真跑够 250ms 再掀开整页。
    if (!page.classList.contains('show') && !installRevealTimer) {
      installRevealTimer = setTimeout(() => {
        installRevealTimer = null;
        page.hidden = false;
        // 先去掉 hidden 再下一帧加 show，否则过渡不会触发
        requestAnimationFrame(() => page.classList.add('show'));
        // 整页已经承担进度展示，底部条收起来，不然同一份进度在一屏里出现两次
        bar.classList.add('stowed');
      }, 250);
    }
  } else {
    clearTimeout(installRevealTimer);
    installRevealTimer = null;
    // 一次安装结束，收起状态自动复位，下一次才开始时还是完整卡片
    installCollapsed = false;
    page.classList.remove('show');
    bar.classList.remove('stowed');
    bar.classList.remove('floating');
    // 等淡出走完再 hidden，否则看不到过渡
    setTimeout(() => {
      if (!page.classList.contains('show')) page.hidden = true;
    }, 220);
  }
}

function updateProgress({ stage, message, done, total, downloaded, errors }) {
  const bar = $('progressBar');
  const fill = $('progressFill');
  const pctEl = $('progressPct');
  const track = fill.parentElement;

  const page = $('installPage');
  const card = page.firstElementChild;
  const iFill = $('installFill');
  const iTrack = iFill.parentElement;
  const iPct = $('installPct');

  if (message) {
    $('progressLabel').textContent = message;
    $('installTitle').textContent = message;
  }

  // 状态色跟着走：PCL 也是跑完变绿、报错变红
  const state = stage === 'done' ? 'done' : stage === 'error' ? 'error' : 'run';
  bar.dataset.state = state;
  card.dataset.state = state;

  if (total) {
    // 已有总量：正常进度 + 百分比（PCL 的「文本 - 42%」）
    const pct = Math.min(100, (done / total) * 100);
    track.classList.remove('indeterminate');
    iTrack.classList.remove('indeterminate');
    fill.style.width = pct.toFixed(1) + '%';
    iFill.style.width = pct.toFixed(1) + '%';
    pctEl.textContent = `${pct.toFixed(0)}%`;
    iPct.textContent = `${pct.toFixed(0)}%`;
    pctEl.classList.add('show');
    iPct.classList.add('show');
    const meta = `${done}/${total}  新下载 ${downloaded ?? 0}  失败 ${errors ?? 0}`;
    $('progressMeta').textContent = meta;
    $('installMeta').textContent = meta;
  } else if (stage === 'done') {
    // 完成但没有具体总量：满条，百分比给 100%
    track.classList.remove('indeterminate');
    iTrack.classList.remove('indeterminate');
    fill.style.width = '100%';
    iFill.style.width = '100%';
    pctEl.textContent = '100%';
    iPct.textContent = '100%';
    pctEl.classList.add('show');
    iPct.classList.add('show');
    $('progressMeta').textContent = '';
    $('installMeta').textContent = '';
  } else if (stage === 'error') {
    // 失败：条停在当前位置不假装跑完，颜色变红已足够
    track.classList.remove('indeterminate');
    iTrack.classList.remove('indeterminate');
    pctEl.classList.remove('show');
    iPct.classList.remove('show');
    $('progressMeta').textContent = '';
    $('installMeta').textContent = '';
  } else if (stage) {
    // 总量未知：PCL 也是不报百分比，改成来回跑的条，
    // 比一条死钉在 0% 的空条更能说明「它在干活」
    track.classList.add('indeterminate');
    iTrack.classList.add('indeterminate');
    fill.style.width = '';
    iFill.style.width = '';
    pctEl.classList.remove('show');
    iPct.classList.remove('show');
    pctEl.textContent = '';
    iPct.textContent = '';
    $('progressMeta').textContent = '';
    $('installMeta').textContent = '';
  }
}

/* ---------------- 渲染：实例 ---------------- */

function renderInstalled() {
  const box = $('installedList');
  const versions = state.versions;
  const q = ($('verSearch')?.value ?? '').trim().toLowerCase();
  const lf = $('verLoader')?.value ?? '';

  const rows = versions.filter((v) => {
    const d = (state.versionDetails || []).find((x) => x.id === v) || {};
    const kind = d.loader || 'vanilla';
    if (lf && kind !== lf) return false;
    if (q && !v.toLowerCase().includes(q)) return false;
    return true;
  });

  $('installedCount').textContent =
    rows.length === versions.length ? String(versions.length) : `${rows.length}/${versions.length}`;

  if (!versions.length) {
    box.innerHTML = '<div class="empty">还没有实例，去「下载」装一个</div>';
    updateVersionHint(false);
    updateHome();
    return;
  }

  // 之前选中的实例不在了，就回到第一个
  if (!versions.includes(state.selectedVersion)) {
    state.selectedVersion = versions[0];
    localStorage.setItem('sakura.selectedVersion', state.selectedVersion);
  }

  if (!rows.length) {
    box.innerHTML = `<div class="empty">没有匹配的实例${q ? `：${escapeHtml(q)}` : ''}</div>`;
    updateVersionHint(false);
    updateHome();
    return;
  }

  box.innerHTML = rows.map((v) => {
    const isRunning = state.running?.versionId === v;
    const d = (state.versionDetails || []).find((x) => x.id === v) || {};
    const kind = d.kind || d.loader || 'vanilla';
    const label = LOADER_LABEL[kind] ?? '原版';
    const game = d.gameVersion && d.gameVersion !== v ? d.gameVersion : v;
    const mc = game || v;
    const typeText = kind === 'snapshot' ? '快照版' : kind === 'modpack' ? '整合包' : '正式版';
    const loaderSuffix = (kind !== 'vanilla' && kind !== 'snapshot' && kind !== 'modpack')
      ? `, ${label}${d.loaderVersion ? ` ${d.loaderVersion}` : ''}`
      : '';
    const badges = [];
    if (isRunning) badges.push('<span class="ver-badge on">运行中</span>');
    if (d.modsCount) badges.push(`<span class="ver-badge">${d.modsCount} 个 mod</span>`);
    if (d.savesCount) badges.push(`<span class="ver-badge">${d.savesCount} 个存档</span>`);
    // Java 主版本不常驻显示：启动时会按版本自动挑，正常没有可提醒的差异。

    const cls = [
      'ver-row',
      v === state.selectedVersion ? 'active' : '',
      isRunning ? 'running' : '',
    ].filter(Boolean).join(' ');

    return `<div class="${cls}" data-select="${escapeHtml(v)}" title="${escapeHtml(v)}" tabindex="0">
      ${versionIconHtml(d, kind)}
      <div class="ver-main">
        <div class="ver-name">${escapeHtml(v)}</div>
        <div class="ver-sub">
          <span class="ver-type kind-${escapeHtml(kind)}">${escapeHtml(typeText)}</span>
          &nbsp;
          <span class="ver-mc">${escapeHtml(mc)}${escapeHtml(loaderSuffix)}</span>
        </div>
      </div>
      <div class="ver-side">
        <div class="ver-badges">${badges.join('')}</div>
        <button class="btn ghost ver-icon-btn" data-icon="${escapeHtml(v)}" title="换图标">换图标</button>
        <button class="btn ghost ver-icon-btn" data-more="${escapeHtml(v)}" title="更多">⋯</button>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-select]').forEach((el) => {
    const versionId = el.dataset.select;
    el.addEventListener('click', () => selectVersion(versionId));
    el.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('[data-icon]')) return;
      ev.preventDefault();
      selectVersion(versionId);
      doLaunch(versionId);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      if (ev.target.closest('[data-icon]')) return;
      ev.preventDefault();
      selectVersion(versionId);
      doLaunch(versionId);
    });
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      selectVersion(versionId);
      showVerMenu(ev.clientX, ev.clientY, versionId);
    });
  });

  // 换图标：自动取封面只能覆盖 Modrinth 的包，
  // CurseForge / 自制 / 手动导入的实例靠这个入口。
  box.querySelectorAll('[data-icon]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pickIconFor(btn.dataset.icon);
    });
  });

  box.querySelectorAll('[data-more]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectVersion(btn.dataset.more);
      const r = btn.getBoundingClientRect();
      showVerMenu(r.left + r.width, r.bottom, btn.dataset.more);
    });
  });

  updateVersionHint(rows.includes(state.selectedVersion));
  updateHome();
  syncInstanceSelect();
}

/** 版本页当前选中提示；筛选后选中项不可见时不再显示旧名字 */
function updateVersionHint(visible = true) {
  const el = $('verHint');
  if (!el) return;
  const v = state.selectedVersion;
  if (!v) {
    el.textContent = '选中后双击启动，右键更多';
  } else if (!visible) {
    el.textContent = '当前筛选没有选中项 · 双击一行启动';
  } else {
    el.textContent = `已选中：${v} · 双击启动，右键更多`;
  }
}

/** 版本页右键菜单 */
function showVerMenu(x, y, versionId) {
  const menu = $('verMenu');
  if (!menu) return;
  menu.innerHTML =
    '<button data-act="launch">启动</button>' +
    '<button data-act="folder">打开文件夹</button>' +
    '<button data-act="export">导出整合包…</button>' +
    '<button data-act="saves">存档管理…</button>' +
    '<button data-act="copy">复制为新实例</button>' +
    '<button data-act="settings">该版本的 Java / 内存…</button>' +
    '<button data-act="delete" class="danger">删除</button>';
  menu.hidden = false;
  menu.style.left = '0px';
  menu.style.top = '0px';

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 8))}px`;

  menu.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      menu.hidden = true;
      const act = btn.dataset.act;
      if (act === 'launch') {
        doLaunch(versionId);
        return;
      }
      if (act === 'folder') {
        try {
          await api('/api/instance/open-folder', {
            method: 'POST',
            body: JSON.stringify({ versionId }),
          });
        } catch (e) {
          alert('打开文件夹失败：' + e.message);
        }
        return;
      }
      if (act === 'export') {
        openExport(versionId);
        return;
      }
      if (act === 'saves') {
        openSaves(versionId);
        return;
      }
      if (act === 'copy') {
        try {
          const r = await api('/api/instance/copy', {
            method: 'POST',
            body: JSON.stringify({ versionId, includeSaves: false }),
          });
          toast(`已复制为 ${r.versionId}（不含存档）`, 'ok');
          await loadInstalled();
        } catch (e) {
          alert('复制失败：' + e.message);
        }
        return;
      }
      if (act === 'settings') {
        try {
          const info = await api('/api/instance/settings?versionId=' + encodeURIComponent(versionId));
          const r = await askForm({
            title: `实例「${versionId}」`,
            okText: '保存',
            hint: `留空跟随全局：Java ${info.global.javaPath || '自动选择'}，内存 ${info.global.memoryMax || '全局'}`,
            fields: [
              {
                id: 'javaPath',
                label: 'Java 路径',
                value: info.override.javaPath || '',
                placeholder: `跟随全局（${info.global.javaPath || '自动选择'}）`,
                browse: 'file',
              },
              {
                id: 'memoryMax',
                label: '最大内存',
                value: info.override.memoryMax || '',
                placeholder: `跟随全局（${info.global.memoryMax || '全局'}）`,
              },
            ],
          });
          if (!r) return;
          await api('/api/instance/settings', {
            method: 'POST',
            body: JSON.stringify({
              versionId,
              javaPath: r.javaPath.trim(),
              memoryMax: r.memoryMax.trim(),
            }),
          });
          toast('实例 Java/内存已保存', 'ok');
          await loadInstalled();
        } catch (e) {
          alert('保存实例设置失败：' + e.message);
        }
        return;
      }
      if (act === 'delete') {
        if (!confirm(`删除实例「${versionId}」？\n会移到 .trash，可手动恢复。`)) return;
        try {
          await api('/api/instance/delete', {
            method: 'POST',
            body: JSON.stringify({ versionId }),
          });
        } catch (e) {
          if (!/存档/.test(e.message)) {
            alert('删除失败：' + e.message);
            return;
          }
          if (!confirm(`${e.message}\n\n确认连同存档一起删除？`)) return;
          try {
            await api('/api/instance/delete', {
              method: 'POST',
              body: JSON.stringify({ versionId, force: true }),
            });
          } catch (e2) {
            alert('删除失败：' + e2.message);
            return;
          }
        }
        if (state.selectedVersion === versionId) {
          state.selectedVersion = '';
          localStorage.removeItem('sakura.selectedVersion');
        }
        await loadInstalled();
      }
    });
  });
}

/* ---- 实例导出 ---- */
const exportState = { versionId: '', preview: null, zipPath: '' };

function syncExportFormat() {
  const mrpack = $('exportFormat')?.value === 'mrpack';
  const saves = $('exportSaves');
  if (saves) {
    saves.disabled = mrpack;
    if (mrpack) saves.checked = false;
  }
}

function blockIfGameRunning() {
  if (!state.running) return false;
  toast('游戏还开着，先关掉再恢复', 'err');
  return true;
}

async function openExport(versionId) {
  try {
    const p = await api('/api/export/preview', {
      method: 'POST',
      body: JSON.stringify({ versionId, options: {} }),
    });
    exportState.versionId = versionId;
    exportState.preview = p;
    exportState.zipPath = '';
    const info = $('exportInfo');
    if (info) {
      info.textContent = [
        `实例：${versionId}`,
        `加载器：${p.meta?.loader || 'vanilla'}`,
        `游戏版本：${p.meta?.gameVersion || versionId}`,
        `建议内存：${p.meta?.memory?.max || '未设置'}`,
        `默认带：Mod、配置、资源包（存档需要手动勾选）`,
        `默认不带：光影、存档、截图`,
      ].join('\n');
    }
    if ($('exportDest')) $('exportDest').value = p.defaultDestination || '';
    for (const id of ['exportMods', 'exportConfig', 'exportResourcepacks']) {
      if ($(id)) $(id).checked = true;
    }
    for (const id of ['exportShaderpacks', 'exportSaves', 'exportScreenshots']) {
      if ($(id)) $(id).checked = false;
    }
    if ($('exportFormat')) $('exportFormat').value = 'sakura';
    if ($('exportVersion')) $('exportVersion').value = p.meta?.packVersion || '';
    syncExportFormat();
    if ($('exportProgress')) $('exportProgress').textContent = state.running ? '游戏开着，存档没带' : '';
    if ($('exportResult')) $('exportResult').textContent = '';
    if ($('exportCopyPath')) $('exportCopyPath').hidden = true;
    if ($('exportOpenFolder')) $('exportOpenFolder').hidden = true;
    if ($('exportStart')) {
      $('exportStart').disabled = false;
      $('exportStart').textContent = '开始导出';
      $('exportStart').hidden = false;
    }
    if ($('exportModal')) $('exportModal').hidden = false;
  } catch (e) {
    alert('读取实例失败：' + e.message);
  }
}

async function pickExportDestination() {
  const p = await globalThis.mcWin?.pickFolder?.();
  if (p && $('exportDest')) $('exportDest').value = p;
}

async function startExport() {
  if (!exportState.versionId) return;
  const format = $('exportFormat')?.value === 'mrpack' ? 'mrpack' : 'sakura';
  let packVersion = String($('exportVersion')?.value || '').trim();
  if (format === 'mrpack' && !packVersion) {
    packVersion = String(prompt('请输入整合包版本号（用于 .mrpack 文件名和 index.json）') || '').trim();
    if (!packVersion) return;
    if ($('exportVersion')) $('exportVersion').value = packVersion;
  }
  const options = {
    format,
    version: packVersion,
    mods: Boolean($('exportMods')?.checked),
    config: Boolean($('exportConfig')?.checked),
    resourcepacks: Boolean($('exportResourcepacks')?.checked),
    shaderpacks: Boolean($('exportShaderpacks')?.checked),
    saves: format === 'mrpack' ? false : Boolean($('exportSaves')?.checked),
    screenshots: Boolean($('exportScreenshots')?.checked),
  };
  const destination = String($('exportDest')?.value || '').trim();
  if ($('exportStart')) {
    $('exportStart').disabled = true;
    $('exportStart').textContent = '正在导出…';
  }
  if ($('exportProgress')) $('exportProgress').textContent = '准备打包…';
  try {
    const preview = await api('/api/export/preview', {
      method: 'POST',
      body: JSON.stringify({ versionId: exportState.versionId, options, whileRunning: Boolean(state.running) }),
    });
    const scan = preview.secretScan || { count: 0, files: [] };
    if (scan.count) {
      const shown = scan.files.slice(0, 10).map((f) => `- ${f}`).join('\n');
      const more = scan.files.length > 10 ? `\n…还有 ${scan.files.length - 10} 个` : '';
      const ok = confirm(
        `有 ${scan.count} 个文件可能含账号/密钥信息，导出前建议检查\n\n${shown}${more}\n\n仍然导出？`
      );
      if (!ok) {
        if ($('exportStart')) {
          $('exportStart').disabled = false;
          $('exportStart').textContent = '开始导出';
        }
        if ($('exportProgress')) $('exportProgress').textContent = '';
        return;
      }
    }
    const r = await api('/api/export', {
      method: 'POST',
      body: JSON.stringify({ versionId: exportState.versionId, destination, options, whileRunning: Boolean(state.running) }),
    });
    exportState.zipPath = r.zipPath;
    if ($('exportProgress')) $('exportProgress').textContent = r.warnings?.length ? `导出完成：${r.warnings.join('；')}` : '导出完成';
    if (r.format === 'mrpack') {
      if ($('exportResult')) {
        $('exportResult').textContent = [
          `路径：${r.zipPath}`,
          `大小：${(r.bytes / 1024 / 1024).toFixed(1)} MB`,
          `index.json：${r.files?.length || 0} 个文件`,
          `overrides：${r.overridesCount || 0} 个文件`,
          r.summary || '',
        ].filter(Boolean).join('\n');
      }
    } else {
      const label = {
        mods: 'Mod',
        config: '配置',
        resourcepacks: '资源包',
        shaderpacks: '光影',
        saves: '存档',
        screenshots: '截图',
      };
      const included = (r.included || []).map((k) => label[k] || k);
      const skipped = (r.skipped || []).map((k) => label[k] || k);
      if ($('exportResult')) {
        $('exportResult').textContent = [
          `路径：${r.zipPath}`,
          `大小：${(r.bytes / 1024 / 1024).toFixed(1)} MB`,
          `文件：${r.files?.length || 0} 个`,
          `本次带：${included.length ? included.join('、') : '无'}；跳过：${skipped.length ? skipped.join('、') : '无'}`,
          r.errors?.length ? `读取失败：${r.errors.length} 个文件` : '',
        ].filter(Boolean).join('\n');
      }
    }
    if ($('exportCopyPath')) $('exportCopyPath').hidden = false;
    if ($('exportOpenFolder')) $('exportOpenFolder').hidden = false;
    if ($('exportStart')) {
      $('exportStart').textContent = '重新导出';
      $('exportStart').disabled = false;
    }
    if (r.warnings?.length) toast(r.warnings.join('；'), 'err');
    else toast(`已导出 ${r.name}`, 'ok');
  } catch (e) {
    if ($('exportProgress')) $('exportProgress').textContent = '导出失败：' + e.message;
    if ($('exportStart')) {
      $('exportStart').disabled = false;
      $('exportStart').textContent = '重试导出';
    }
  }
}

async function copyExportPath() {
  if (!exportState.zipPath) return;
  try {
    await navigator.clipboard.writeText(exportState.zipPath);
    toast('导出包路径已复制');
  } catch {
    toast('复制失败，请手动选中路径', 'err');
  }
}

async function openExportFolder() {
  if (!exportState.zipPath) return;
  try {
    await api('/api/export/open', {
      method: 'POST',
      body: JSON.stringify({ path: exportState.zipPath }),
    });
  } catch (e) {
    toast('打开文件夹失败：' + e.message, 'err');
  }
}

/* ---- 整包更新 ---- */
const packUpdateState = { versionId: '', path: '', preview: null };

function pickPackUpdateFile() {
  if (globalThis.mcWin?.pickFile) {
    return globalThis.mcWin.pickFile([{ name: '整合包', extensions: ['zip', 'mrpack'] }]);
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.mrpack';
    input.addEventListener('change', () => resolve(input.files?.[0]?.path || ''));
    input.click();
  });
}

async function openPackUpdate() {
  const versionId = state.selectedVersion;
  if (!versionId) {
    toast('先在版本页选一个实例', 'err');
    return;
  }
  let path = '';
  try { path = await pickPackUpdateFile(); } catch { /* ignore */ }
  if (!path) return;
  try {
    const preview = await api('/api/pack/update/preview', {
      method: 'POST',
      body: JSON.stringify({ versionId, path, overwriteConfig: false }),
    });
    packUpdateState.versionId = versionId;
    packUpdateState.path = path;
    packUpdateState.preview = preview;
    if ($('packUpdateGroups')) $('packUpdateGroups').textContent = preview.text || '没有内容差异';
    if ($('packUpdateText')) $('packUpdateText').textContent = `类型：${preview.kind} · 新增 ${preview.counts.added} · 变化 ${preview.counts.changed} · 移除 ${preview.counts.removed} · 跳过 ${preview.counts.skipped}`;
    if ($('packUpdateConfig')) $('packUpdateConfig').checked = false;
    if ($('packUpdateNotice')) $('packUpdateNotice').textContent = '存档和配置没动';
    if ($('packUpdateResult')) $('packUpdateResult').textContent = '';
    if ($('packUpdateModal')) $('packUpdateModal').hidden = false;
  } catch (e) {
    toast('读取整合包失败：' + e.message, 'err');
  }
}

async function applyPackUpdate() {
  if (!packUpdateState.versionId || !packUpdateState.path) return;
  const overwriteConfig = Boolean($('packUpdateConfig')?.checked);
  const btn = $('packUpdateStart');
  if (btn) { btn.disabled = true; btn.textContent = '正在更新…'; }
  try {
    const r = await api('/api/pack/update/apply', {
      method: 'POST',
      body: JSON.stringify({
        versionId: packUpdateState.versionId,
        path: packUpdateState.path,
        overwriteConfig,
      }),
    });
    if ($('packUpdateResult')) {
      const removed = r.removedDir
        ? `\n移除文件在 ${r.removedDir}；30 天后不会被清理，建议手动删`
        : '';
      $('packUpdateResult').textContent = `${r.summary}\n${r.protectedNote}${removed}`;
    }
    toast(`整合包更新完成：${r.summary}`, 'ok');
    await loadInstalled();
  } catch (e) {
    toast('更新整合包失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '开始更新'; }
  }
}


function renderSaves(data) {
  savesState.data = data;
  const info = $('savesInfo');
  if (info) {
    info.textContent = [
      `实例：${data.versionId}`,
      `存档目录：${data.savesDir}`,
      `备份目录：${data.backupDir}`,
    ].join('\n');
  }
  const list = $('savesList');
  if (list) {
    if (!data.saves?.length) {
      list.innerHTML = '<div class="saves-empty">没有存档。进入游戏创建世界后会出现在这里。</div>';
    } else {
      list.innerHTML = data.saves.map((s) => `
        <div class="save-row">
          <div class="save-row-main">
            <div class="save-row-name">${escapeHtml(s.name)}</div>
            <div class="save-row-meta">${fmtSize(s.size)} · ${new Date(s.modifiedAt).toLocaleString()}</div>
          </div>
          <button class="btn ghost" data-save-backup="${escapeHtml(s.name)}">备份</button>
        </div>`).join('');
      list.querySelectorAll('[data-save-backup]').forEach((btn) => {
        btn.addEventListener('click', () => backupSave(btn.dataset.saveBackup));
      });
    }
  }
  const backups = $('savesBackupList');
  if (backups) {
    if (!data.backups?.length) {
      backups.innerHTML = '<div class="saves-empty">还没有本地备份。</div>';
    } else {
      backups.innerHTML = data.backups.map((b) => `
        <div class="save-row">
          <div class="save-row-main">
            <div class="save-row-name">${escapeHtml(b.world)}</div>
            <div class="save-row-meta">${new Date(b.createdAt).toLocaleString()} · ${fmtSize(b.size)} · ${b.source === 'beforeLaunch' ? '进游戏前' : (b.source === 'afterExit' ? '退出后' : '手动')}${b.whileRunning ? ' · 运行中备份' : ''}</div>
          </div>
          <button class="btn ghost" data-save-restore="${escapeHtml(b.file)}" ${state.running ? 'disabled title="游戏还开着，先关掉再恢复"' : ''}>恢复</button>
        </div>`).join('');
      backups.querySelectorAll('[data-save-restore]').forEach((btn) => {
        btn.addEventListener('click', () => restoreSave(btn.dataset.saveRestore));
      });
    }
  }
}

async function reloadSaves() {
  if (!savesState.versionId) return;
  const data = await api('/api/saves?versionId=' + encodeURIComponent(savesState.versionId));
  renderSaves(data);
}

async function openSaves(versionId) {
  try {
    savesState.versionId = versionId;
    const data = await api('/api/saves?versionId=' + encodeURIComponent(versionId));
    if ($('savesTitle')) $('savesTitle').textContent = `存档管理 · ${versionId}`;
    if ($('savesProgress')) $('savesProgress').textContent = '';
    if ($('savesBackupAll')) $('savesBackupAll').disabled = false;
    if ($('savesModal')) $('savesModal').hidden = false;
    renderSaves(data);
  } catch (e) {
    alert('读取存档失败：' + e.message);
  }
}

async function backupSave(world) {
  if (!savesState.versionId) return;
  const progress = $('savesProgress');
  if (progress) progress.textContent = `正在备份 ${world}…`;
  try {
    const r = await api('/api/saves/backup', {
      method: 'POST',
      body: JSON.stringify({ versionId: savesState.versionId, world }),
    });
    if (progress) progress.textContent = `已备份：${r.file}`;
    toast(`已备份存档 ${world}`, 'ok');
    await reloadSaves();
  } catch (e) {
    if (progress) progress.textContent = '备份失败：' + e.message;
    toast('备份失败：' + e.message, 'err');
  }
}

async function backupAllSaves() {
  if (!savesState.versionId) return;
  const progress = $('savesProgress');
  if ($('savesBackupAll')) $('savesBackupAll').disabled = true;
  if (progress) progress.textContent = '正在备份全部存档…';
  try {
    const r = await api('/api/saves/backup-all', {
      method: 'POST',
      body: JSON.stringify({ versionId: savesState.versionId }),
    });
    if (progress) progress.textContent = `已备份 ${r.results?.length || 0} 个存档`;
    toast('全部存档已备份', 'ok');
    await reloadSaves();
  } catch (e) {
    if (progress) progress.textContent = '备份失败：' + e.message;
    toast('备份失败：' + e.message, 'err');
  } finally {
    if ($('savesBackupAll')) $('savesBackupAll').disabled = false;
  }
}

async function restoreSave(file) {
  if (blockIfGameRunning()) return;
  if (!savesState.versionId) return;
  if (!confirm(`恢复备份「${file}」？\n当前同名存档会先自动备份一次，再覆盖。`)) return;
  const progress = $('savesProgress');
  if (progress) progress.textContent = '正在恢复…';
  try {
    const r = await api('/api/saves/restore', {
      method: 'POST',
      body: JSON.stringify({ versionId: savesState.versionId, file }),
    });
    if (progress) progress.textContent = `已恢复：${r.world}`;
    toast(`已恢复存档 ${r.world}`, 'ok');
    await reloadSaves();
  } catch (e) {
    if (progress) progress.textContent = '恢复失败：' + e.message;
    toast('恢复失败：' + e.message, 'err');
  }
}

async function openSavesFolder(kind) {
  if (!savesState.versionId) return;
  try {
    await api('/api/saves/open', {
      method: 'POST',
      body: JSON.stringify({ versionId: savesState.versionId, kind }),
    });
  } catch (e) {
    toast('打开文件夹失败：' + e.message, 'err');
  }
}

/** 版本类型的中文名，列表图标上用 */
/* ---- 左侧导航：存档管理 ---- */
const savesPageState = { versionId: '', data: null, selectedWorld: '' };

function pickSaveImportPath(kind) {
  if (kind === 'folder' && globalThis.mcWin?.pickFolder) return globalThis.mcWin.pickFolder();
  if (kind === 'zip' && globalThis.mcWin?.pickFile) {
    return globalThis.mcWin.pickFile([{ name: 'Minecraft 世界', extensions: ['zip'] }]);
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (kind === 'folder') input.webkitdirectory = true;
    else input.accept = '.zip,application/zip';
    input.addEventListener('change', () => resolve(input.files?.[0]?.path || ''));
    input.click();
  });
}

async function previewSaveImportPath(path) {
  const versionId = savesPageState.versionId || $('savesPageInstance')?.value || '';
  if (!versionId) {
    toast('先选一个目标实例', 'err');
    return;
  }
  try {
    const info = await api('/api/saves/import/preview', {
      method: 'POST',
      body: JSON.stringify({ versionId, path }),
    });
    const message = info.mismatch
      ? `这个存档是 ${info.saveGameVersion} 版本的，可能打不开，仍然导入？`
      : `导入世界「${info.world}」？\n存档版本：${info.saveGameVersion} · 目标：${info.targetGameVersion}`;
    if (!confirm(message)) return;
    const r = await api('/api/saves/import', {
      method: 'POST',
      body: JSON.stringify({ versionId, path }),
    });
    toast(`已导入存档 ${r.world}`);
    await loadSavesPage();
    savesPageState.selectedWorld = r.world;
    renderSavesPage(savesPageState.data);
  } catch (e) {
    toast('导入存档失败：' + e.message, 'err');
  }
}

async function chooseSaveImport(kind) {
  if ($('saveImportChoiceModal')) $('saveImportChoiceModal').hidden = true;
  let path = '';
  try { path = await pickSaveImportPath(kind); } catch { /* ignore */ }
  if (!path) return;
  await previewSaveImportPath(path);
}

function fillSavesPageInstances() {
  const sel = $('savesPageInstance');
  if (!sel) return '';
  const versions = Array.isArray(state.versions) ? state.versions : [];
  const prev = sel.value || state.selectedVersion || '';
  sel.innerHTML = versions.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (versions.includes(prev)) sel.value = prev;
  else if (versions.length) sel.value = versions[0];
  return sel.value || '';
}

function renderContentBackups(items) {
  const box = $('savesContentBackups');
  if (!box) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<div class="content-backups-head">内容备份</div>` + list.map((b) => `
    <div class="content-backup-row">
      <span>${escapeHtml(b.file || '')} <span class="kind">${escapeHtml(b.source || 'modupdate')}</span></span>
      <span>${fmtSize(b.size || 0)} · ${new Date(b.createdAt).toLocaleString()}</span>
    </div>`).join('');
}

function renderSavesPage(data) {
  savesPageState.data = data;
  const list = $('savesPageList');
  if (!list) return;
  const saves = data?.saves || [];
  const backups = data?.backups || [];
  const contentBackups = data?.contentBackups || [];
  if (!saves.length) {
    list.innerHTML = '<div class="empty">这个实例还没有存档。进入游戏创建世界后会出现在这里。</div>';
    renderContentBackups(contentBackups);
    return;
  }
  list.innerHTML = saves.map((s) => {
    const own = backups.filter((b) => b.world === s.name);
    const options = own.length
      ? own.map((b) => {
        const tag = b.source === 'beforeLaunch' ? '进游戏前' : (b.source === 'afterExit' ? '退出后' : '手动');
        return `<option value="${escapeHtml(b.file)}">${new Date(b.createdAt).toLocaleString()} · ${tag}${b.whileRunning ? ' · 运行中' : ''}</option>`;
      }).join('')
      : '<option value="">没有可用备份</option>';
    const disabled = state.running || !own.length;
    const title = state.running ? '游戏还开着，先关掉再恢复' : (!own.length ? '没有可用备份' : '');
    return `<div class="save-row saves-page-row${savesPageState.selectedWorld === s.name ? ' selected' : ''}" data-page-world="${escapeHtml(s.name)}">
      <div class="save-row-main">
        <div class="save-row-name">${escapeHtml(s.name)}</div>
        <div class="save-row-meta">${fmtSize(s.size)} · ${new Date(s.modifiedAt).toLocaleString()}</div>
      </div>
      <div class="saves-page-actions">
        <select class="select" data-page-backup-pick="${escapeHtml(s.name)}" ${own.length ? '' : 'disabled'}>${options}</select>
        <button class="btn ghost" type="button" data-page-backup="${escapeHtml(s.name)}">备份</button>
        <button class="btn ghost" type="button" data-page-restore="${escapeHtml(s.name)}" ${disabled ? 'disabled' : ''} title="${title}">恢复</button>
        <button class="btn ghost" type="button" data-page-open="${escapeHtml(s.name)}">打开所在目录</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-page-backup]').forEach((btn) => {
    btn.addEventListener('click', () => backupSavePage(btn.dataset.pageBackup));
  });
  list.querySelectorAll('[data-page-restore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pick = list.querySelector(`[data-page-backup-pick="${CSS.escape(btn.dataset.pageRestore)}"]`);
      restoreSavePage(pick?.value || '');
    });
  });
  list.querySelectorAll('[data-page-open]').forEach((btn) => {
    btn.addEventListener('click', () => openSavesPageFolder());
  });
  list.querySelectorAll('.saves-page-row').forEach((row) => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('button, select')) return;
      savesPageState.selectedWorld = row.dataset.pageWorld || '';
      list.querySelectorAll('.saves-page-row').forEach((x) => x.classList.toggle('selected', x === row));
    });
  });
  renderContentBackups(contentBackups);
}

async function loadSavesPage() {
  let versionId = $('savesPageInstance')?.value || '';
  if (!versionId) versionId = fillSavesPageInstances();
  savesPageState.versionId = versionId;
  const progress = $('savesPageProgress');
  if (!versionId) {
    if (progress) progress.textContent = '还没有安装任何实例。';
    renderSavesPage({ saves: [], backups: [] });
    return;
  }
  if (progress) progress.textContent = '读取中…';
  try {
    const data = await api('/api/saves?versionId=' + encodeURIComponent(versionId));
    if (progress) progress.textContent = '';
    renderSavesPage(data);
  } catch (e) {
    if (progress) progress.textContent = '读取失败：' + e.message;
    toast('读取存档失败：' + e.message, 'err');
  }
}

async function backupSavePage(world) {
  if (!savesPageState.versionId) return;
  const progress = $('savesPageProgress');
  if (progress) progress.textContent = `正在备份 ${world}…`;
  try {
    await api('/api/saves/backup', {
      method: 'POST',
      body: JSON.stringify({ versionId: savesPageState.versionId, world }),
    });
    toast(`已备份存档 ${world}`, 'ok');
    await loadSavesPage();
  } catch (e) {
    if (progress) progress.textContent = '备份失败：' + e.message;
    toast('备份失败：' + e.message, 'err');
  }
}

async function backupAllSavesPage() {
  if (!savesPageState.versionId) return;
  const btn = $('savesPageBackupAll');
  const progress = $('savesPageProgress');
  if (btn) btn.disabled = true;
  if (progress) progress.textContent = '正在备份全部存档…';
  try {
    const r = await api('/api/saves/backup-all', {
      method: 'POST',
      body: JSON.stringify({ versionId: savesPageState.versionId }),
    });
    toast(`已备份 ${r.results?.length || 0} 个存档`, 'ok');
    await loadSavesPage();
  } catch (e) {
    if (progress) progress.textContent = '备份失败：' + e.message;
    toast('备份失败：' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function restoreSavePage(file) {
  if (!savesPageState.versionId) return;
  if (state.running) {
    toast('游戏还开着，先关掉再恢复', 'err');
    return;
  }
  if (!file) {
    toast('没有可用备份', 'err');
    return;
  }
  if (!confirm(`恢复备份「${file}」？\n当前同名存档会先自动备份一次，再覆盖。`)) return;
  const progress = $('savesPageProgress');
  if (progress) progress.textContent = '正在恢复…';
  try {
    const r = await api('/api/saves/restore', {
      method: 'POST',
      body: JSON.stringify({ versionId: savesPageState.versionId, file }),
    });
    toast(`已恢复存档 ${r.world}`, 'ok');
    await loadSavesPage();
  } catch (e) {
    if (progress) progress.textContent = '恢复失败：' + e.message;
    toast('恢复失败：' + e.message, 'err');
  }
}

async function openSavesPageFolder() {
  if (!savesPageState.versionId) return;
  try {
    await api('/api/saves/open', {
      method: 'POST',
      body: JSON.stringify({ versionId: savesPageState.versionId, kind: 'saves' }),
    });
  } catch (e) {
    toast('打开文件夹失败：' + e.message, 'err');
  }
}
function refreshSavesPageIfVisible() {
  if (savesPageState.data && $('panel-saves')?.classList.contains('active')) {
    renderSavesPage(savesPageState.data);
  }
}
const LOADER_LABEL = {
  vanilla: '原版',
  snapshot: '快照',
  modpack: '整合包',
  forge: 'Forge',
  fabric: 'Fabric',
  quilt: 'Quilt',
  neoforge: 'NeoForge',
};

/**
 * PCL 风格的类型图标。honghemc 那个站点是物品图标库，不是加载器图标，
 * 这里用内置 SVG：不依赖网络，实例自定义 icon 仍优先。
 */
const VERSION_ICON_SVG = {
  vanilla: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <polygon points="16,3 29,9.5 16,16 3,9.5" fill="#86c95a"/>
    <polygon points="3,9.5 16,16 16,29 3,22.5" fill="#9a6536"/>
    <polygon points="16,16 29,9.5 29,22.5 16,29" fill="#704526"/>
    <polygon points="7,10.5 13,13.5 13,16 7,13" fill="#a9df78" opacity=".55"/>
    <path d="M6 14l4 2v3l-4-2zM22 18l3-1.5v3l-3 1.5z" fill="#5f8f45" opacity=".5"/>
  </svg>`,
  forge: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M6 8h20l-2.5 6H8.5z" fill="#d9e0e7"/>
    <path d="M8.5 14h15l-2 6h-11z" fill="#98a4af"/>
    <path d="M12 20h8v6h-8z" fill="#6e7a86"/>
    <path d="M8 8l2-3h12l2 3" fill="none" stroke="#aeb9c3" stroke-width="2"/>
    <path d="M24 4l3 1-2 3-2-2z" fill="#ffb454"/>
    <path d="M25 2l1 2M27 5l2 1" stroke="#ffcf7a" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`,
  fabric: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="9" y="5" width="14" height="22" rx="4" fill="#c9b8ff"/>
    <path d="M12 7v18M16 7v18M20 7v18" stroke="#f1ecff" stroke-width="2" opacity=".75"/>
    <path d="M6 9h4M22 9h4M6 23h4M22 23h4" stroke="#8f7bd6" stroke-width="2" stroke-linecap="round"/>
    <path d="M23 17l5-5M26 17l3-3" stroke="#f4eaff" stroke-width="2" stroke-linecap="round"/>
    <circle cx="27" cy="10" r="1.5" fill="#fff"/>
  </svg>`,
  quilt: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="4" y="4" width="24" height="24" rx="4" fill="#e7b4cf"/>
    <path d="M16 4v24M4 16h24" stroke="#ffe3ef" stroke-width="2" stroke-dasharray="3 2"/>
    <rect x="6" y="6" width="8" height="8" rx="2" fill="#ffb3d9"/>
    <rect x="18" y="6" width="8" height="8" rx="2" fill="#d98bb5"/>
    <rect x="6" y="18" width="8" height="8" rx="2" fill="#d98bb5"/>
    <rect x="18" y="18" width="8" height="8" rx="2" fill="#ffb3d9"/>
  </svg>`,
  neoforge: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M6 8h20l-2.5 6H8.5z" fill="#c9ecff"/>
    <path d="M8.5 14h15l-2 6h-11z" fill="#79b6d3"/>
    <path d="M12 20h8v6h-8z" fill="#4d88a5"/>
    <path d="M8 8l2-3h12l2 3" fill="none" stroke="#9bd9f2" stroke-width="2"/>
    <path d="M16 1l3 5-3 3-3-3z" fill="#5de0ff"/>
    <path d="M25 3c2 2 1 5-1 6 1-3-1-4-1-5z" fill="#ffb454"/>
  </svg>`,
  snapshot: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="4" y="9" width="24" height="17" rx="4" fill="#d9ab4d"/>
    <rect x="8" y="5" width="8" height="5" rx="2" fill="#f0c96a"/>
    <circle cx="16" cy="17.5" r="6" fill="#44331a"/>
    <circle cx="16" cy="17.5" r="3" fill="#bcd8ff"/>
    <circle cx="24" cy="12" r="1.5" fill="#ffe6a8"/>
  </svg>`,
  modpack: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M4 10l12-6 12 6-12 6z" fill="#a9ddff"/>
    <path d="M4 10v13l12 6V16z" fill="#5fa9dc"/>
    <path d="M28 10v13l-12 6V16z" fill="#3f82b2"/>
    <path d="M10 13l6-3 6 3-6 3z" fill="#e8f7ff" opacity=".75"/>
    <path d="M16 16v8" stroke="#d6efff" stroke-width="1.5" opacity=".7"/>
  </svg>`,
  unknown: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="5" y="5" width="22" height="22" rx="4" fill="#aab3bf"/>
    <text x="16" y="23" text-anchor="middle" font-size="17" font-weight="700" fill="#3d4650">?</text>
  </svg>`,
};

function versionIconHtml(detail, kind, versionId) {
  // 实例自带图优先；没有就统一走后端默认图：正式版草方块、快照命令方块、
  // 整合包 modpack-block，由 server.js 的 defaultIconFor 决定。
  if (detail?.iconUrl) {
    return `<img class="ver-ico-img ver-block-icon" src="${escapeHtml(detail.iconUrl)}" alt="" loading="lazy"
      onerror="this.style.visibility='hidden'">`;
  }
  const key = Object.prototype.hasOwnProperty.call(VERSION_ICON_SVG, kind) ? kind : 'unknown';
  return `<span class="ver-ico ${key}" title="${escapeHtml(LOADER_LABEL[key] ?? '版本')}" aria-hidden="true">${VERSION_ICON_SVG[key]}</span>`;
}

/** 选中实例：高亮 + 刷新中间名字和版本 */
function selectVersion(versionId) {
  state.selectedVersion = versionId;
  localStorage.setItem('sakura.selectedVersion', versionId);
  document.querySelectorAll('[data-select]').forEach((el) => {
    el.classList.toggle('active', el.dataset.select === versionId);
  });
  updateVersionHint(true);
  updateHome();
}

/** 中间的人物名、副标题、启动按钮状态 */
function renderLastFailure() {
  const el = $('lastFailure');
  if (!el) return;
  const f = state.lastFailure;
  if (!f) { el.hidden = true; return; }
  const t = new Date(f.at || Date.now());
  const stamp = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const reason = String(f.reason || '').replace(/\s+/g, ' ').slice(0, 70);
  el.hidden = false;
  el.textContent = `上次启动失败：${f.versionId}（${stamp}）${reason ? ' · ' + reason : ''}`;
}

function updateHome() {
  const v = state.selectedVersion;
  const running = state.running?.versionId === v;
  const busy = Boolean(state.installing);

  $('charName').textContent = state.username || 'Player';
  $('charVersion').textContent = v || '还没有实例，去「安装版本」下一个';
  if ($('gameOptionsHint')) {
    $('gameOptionsHint').textContent = v
      ? `当前实例：${v} · versions/${v}/options.txt`
      : '先在版本页选一个实例，再打开游戏设置';
  }

  const btn = $('launchBtn');
  btn.classList.toggle('busy', running || busy);
  btn.title = v ? `启动 ${v}` : '';

  if (running) {
    btn.disabled = true;
    btn.textContent = '游戏运行中';
  } else if (busy) {
    btn.disabled = true;
    btn.textContent = '安装中…';
  } else if (!v) {
    btn.disabled = true;
    btn.textContent = '启动游戏';
  } else {
    btn.disabled = false;
    btn.textContent = v ? `启动 ${v}` : '启动游戏';
  }

  $('manageContent').hidden = !v;
  renderLastFailure();
}

function syncInstanceSelect() {
  const sel = $('storeInstance');
  const prev = sel.value;
  sel.innerHTML =
    '<option value="">全局（不过滤）</option>' +
    state.versions.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');

  if (state.versions.includes(prev)) sel.value = prev;
  else if (state.versions.length === 1) sel.value = state.versions[0];

  state.storeInstance = sel.value;
  updateStoreHint();
}

/* ---------------- 渲染：远程版本 ---------------- */

function renderRemote() {
  const box = $('remoteList');
  if (!state.remote.length) {
    box.innerHTML = '<div class="empty">点右上角「刷新清单」加载</div>';
    return;
  }

  box.innerHTML = state.remote.map((v) => `
    <div class="row">
      <div class="row-main">
        <div class="row-name">${escapeHtml(v.id)}</div>
        <div class="row-sub">${fmtDate(v.releaseTime)} <span class="ver-tag kind-vanilla">原版</span></div>
      </div>
      <div class="row-actions">
        ${v.installed
          ? '<span class="badge ok">已安装</span>'
          : `<button class="btn" data-install="${escapeHtml(v.id)}">安装</button>`}
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-install]').forEach((btn) => {
    btn.addEventListener('click', () => doInstall(btn.dataset.install));
  });
}

/* ---------------- 渲染：商店 ---------------- */

function updateStoreHint() {
  const el = $('storeHint');
  const inst = state.storeInstance;

  if (!inst) {
    el.innerHTML =
      '未选择实例：显示所有版本的内容。<b>选一个实例</b>可以只显示兼容该版本的条目，并直接装进去。';
    return;
  }

  el.innerHTML = `目标实例 <b>${escapeHtml(inst)}</b>：只显示兼容该版本的内容，点「装」直接安装到该实例。`;
}

/**
 * 列表加载中的动画。
 * 用的是 loading.gif（搭档给的 24 帧图，无限循环），加一行文字。
 * 只画动画，不碰数据；真正的列表回来时整块被 innerHTML 覆盖掉。
 */
function renderSkeleton(boxId, count = 6, label = '正在加载…') {
  const box = $(boxId);
  if (!box) return;
  box.innerHTML = `
      <div class="pcl-loading">
        <img class="pcl-gif" src="loading.gif" alt="">
        <div class="pcl-text">${escapeHtml(label)}</div>
      </div>`;
}

/** 列表请求失败：保留错误 + 重试按钮，不把页面留在空白 */
function renderListError(boxId, message, retry) {
  const box = $(boxId);
  if (!box) return;
  box.innerHTML = `<div class="empty">${message}<br><button class="btn ghost" data-retry>重试</button></div>`;
  box.querySelector('[data-retry]')?.addEventListener('click', retry);
}

function renderStore() {
  const box = $('storeResults');
  const hits = state.storeHits;

  if (!hits.length) {
    box.innerHTML = '<div class="empty">没有找到内容，换个关键词试试</div>';
    return;
  }

  box.innerHTML = hits.map((h) => {
    const versionLine = h.versions?.length
      ? h.versions.slice(-3).join(', ')
      : '';
    return `
      <div class="item-row">
        ${h.iconUrl
          ? `<img class="item-ico" src="${escapeHtml(h.iconUrl)}" alt="" loading="lazy">`
          : '<div class="item-ico"></div>'}
        <div class="item-main">
          <div class="item-title" title="${escapeHtml(h.title)}">${escapeHtml(h.title)}</div>
          <div class="item-desc">${escapeHtml(h.description)}</div>
          <div class="item-meta">
            <span>↓ ${fmtNum(h.downloads)}</span>
            ${h.updated ? `<span title="最后更新 ${escapeHtml(String(h.updated).slice(0, 10))}">更新 ${fmtAge(h.updated)}</span>` : ''}
            ${versionLine ? `<span>${escapeHtml(versionLine)}</span>` : ''}
          </div>
        </div>
        <div class="item-act">
          <button class="btn" data-pick="${escapeHtml(h.slug)}">装</button>
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => pickVersion(btn.dataset.pick));
  });
}

/* ---------------- 渲染：整合包 ---------------- */

function renderPacks() {
  const box = $('packResults');
  if (!state.packs.length) {
    box.innerHTML = '<div class="empty">没有找到整合包</div>';
    return;
  }

  box.innerHTML = state.packs.map((p, idx) => `
    <div class="item-row">
      ${p.iconUrl
        ? `<img class="item-ico" src="${escapeHtml(p.iconUrl)}" alt="" loading="lazy">`
        : '<div class="item-ico"></div>'}
      <div class="item-main">
        <div class="item-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
        <div class="item-desc">${escapeHtml(p.description)}</div>
        <div class="item-meta">
          <span>↓ ${fmtNum(p.downloads)}</span>
          <span>${escapeHtml((p.versions ?? []).slice(-2).join(', '))}</span>
        </div>
      </div>
      <div class="item-act">
        <button class="btn" data-pick-index="${idx}">装</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-pick-index]').forEach((btn) => {
    btn.addEventListener('click', () => pickPack(Number(btn.dataset.pickIndex)));
  });
}

/* ---------------- 追更 ---------------- */

/** 拉追更列表 */
async function loadTrack() {
  try {
    const data = await api('/api/track');
    state.tracked = data.items ?? [];
    state.trackIntervalMs = data.intervalMs ?? 0;
    renderTrack();
  } catch (e) {
    $('trackList').innerHTML = `<div class="empty">读取追更列表失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderTrack() {
  const box = $('trackList');
  const items = state.tracked;

  // 提示走同一行的 .track-status，不再单独占一行
  const mins = Math.round((state.trackIntervalMs || 0) / 60000);
  $('trackHint').textContent = items.length
    ? `${items.length} 个项目，每 ${mins} 分钟自动查一次`
    : '';

  // 没追更项目时整块隐藏：空着还占一行高度，就白压缩了
  if (!items.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;

  box.innerHTML = items.map((it) => {
    // 最新的那条更新记录（如果有）显示成醒目提示
    const latest = (it.updates ?? [])[0];
    const hasUpdate = Boolean(latest);

    let sub;
    if (it.lastError) {
      sub = `<span class="err">检查失败：${escapeHtml(it.lastError)}</span>`;
    } else if (hasUpdate) {
      const when = fmtAge(latest.detectedAt);
      sub = `当前 <b>${escapeHtml(it.currentVersion ?? '?')}</b> · ` +
        `<span class="new">${escapeHtml(latest.from ?? '?')} → ${escapeHtml(latest.to)}</span>（${when}发现，${escapeHtml(latest.releaseType ?? '')}）`;
    } else {
      const added = it.addedAt ? `追更于 ${fmtAge(it.addedAt)}` : '';
      const checked = it.lastCheckedAt ? `，上次检查 ${fmtAge(it.lastCheckedAt)}` : '';
      sub = `当前 <b>${escapeHtml(it.currentVersion ?? '无版本')}</b> · ${added}${checked}`;
    }

    return `
      <div class="track-item${hasUpdate ? ' has-update' : ''}">
        ${it.iconUrl
          ? `<img class="ti-icon" src="${escapeHtml(it.iconUrl)}" alt="" loading="lazy">`
          : '<div class="ti-icon"></div>'}
        <div class="ti-main">
          <div class="ti-title">${escapeHtml(it.title)}</div>
          <div class="ti-sub">${sub}</div>
        </div>
        <div class="ti-actions">
          <button class="btn ghost" data-untrack="${escapeHtml(it.slug)}" title="不再追这个">取消</button>
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('[data-untrack]').forEach((btn) => {
    btn.addEventListener('click', () => untrackPack(btn.dataset.untrack));
  });
}

async function addTrack() {
  const input = $('trackQuery');
  const slug = input.value.trim();
  if (!slug) return;

  const btn = $('trackAdd');
  btn.disabled = true;
  try {
    const data = await api('/api/track/add', {
      method: 'POST',
      body: JSON.stringify({ slug, releaseOnly: $('trackReleaseOnly').checked }),
    });
    state.tracked = data.items ?? [];
    state.trackIntervalMs = data.intervalMs ?? 0;
    input.value = '';
    renderTrack();
  } catch (e) {
    $('trackHint').textContent = '添加失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function untrackPack(slug) {
  try {
    const data = await api('/api/track/remove', {
      method: 'POST',
      body: JSON.stringify({ slug }),
    });
    state.tracked = data.items ?? [];
    state.trackIntervalMs = data.intervalMs ?? 0;
    renderTrack();
  } catch (e) {
    $('trackHint').textContent = '取消失败：' + e.message;
  }
}

async function checkTrackNow() {
  const btn = $('trackCheck');
  btn.disabled = true;
  $('trackHint').textContent = '检查中…';
  try {
    const data = await api('/api/track/check', { method: 'POST' });
    state.tracked = data.items ?? [];
    state.trackIntervalMs = data.intervalMs ?? 0;
    renderTrack();
    // renderTrack 会把提示行覆盖成项目数，这里再盖回本次结果
    const n = (data.found ?? []).length;
    $('trackHint').textContent = n ? `发现 ${n} 个新版本！` : '暂无新版本';
  } catch (e) {
    $('trackHint').textContent = '检查失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 渲染：实例内容 ---------------- */

const GROUP_LABEL = {
  mods: 'Mod',
  shaderpacks: '光影包',
  resourcepacks: '资源包',
};

function renderContent(data) {
  const box = $('contentGroups');
  const groups = [];

  for (const key of ['mods', 'shaderpacks', 'resourcepacks']) {
    const items = data[key] ?? [];
    if (!items.length) continue;
    groups.push(`
      <div>
        <div class="group-title">${GROUP_LABEL[key]}（${items.length}）</div>
        ${items.map((f) => `
          <div class="file-row ${f.disabled ? 'off' : ''}">
            <span class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <span class="file-size">${fmtSize(f.size)}</span>
            <button class="btn ghost" data-toggle="${escapeHtml(f.name)}" data-group="${key}" data-enable="${f.disabled ? '1' : '0'}">
              ${f.disabled ? '启用' : '停用'}
            </button>
            <button class="btn danger" data-del="${escapeHtml(f.name)}" data-group="${key}">删</button>
          </div>`).join('')}
      </div>`);
  }

  box.innerHTML = groups.length
    ? groups.join('')
    : '<div class="empty">这个实例还没有安装任何 mod / 光影 / 资源包</div>';

  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => removeFile(btn.dataset.del, btn.dataset.group));
  });
  box.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () =>
      toggleFile(btn.dataset.toggle, btn.dataset.group, btn.dataset.enable === '1')
    );
  });
}

/**
 * 换一个实例的图标。
 *
 * 自动取封面只能覆盖 Modrinth 的整合包；CurseForge、自制包、
 * 手动导入的实例都没有来源可查，只能让用户自己选图。
 * 选完直接 POST 给服务端落盘，不用刷新页面就会换。
 */
function pickIconFor(versionId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > 4 * 1024 * 1024) {
      alert('图片太大了，请选小于 4MB 的');
      return;
    }

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('读取图片失败'));
        fr.readAsDataURL(file);
      });

      const r = await api(`/api/icon/${encodeURIComponent(versionId)}`, {
        method: 'POST',
        body: JSON.stringify({ dataUrl }),
      });

      // iconUrl 带 no-store，加个时间戳确保立刻看到新图
      const d = (state.versionDetails || []).find((x) => x.id === versionId);
      const bust = `?t=${Date.now()}`;
      if (d) d.iconUrl = `/api/icon/${encodeURIComponent(versionId)}${bust}`;
      renderInstalled();

      if (r?.file) console.log(`图标已更新：${versionId} -> ${r.file}`);
    } catch (e) {
      alert('换图标失败：' + e.message);
    }
  });

  input.click();
}

/* ---------------- 动作 ---------------- */

async function loadInstalled() {
  try {
    const data = await api('/api/versions');
    state.gameDir = data.gameDir;
    state.versions = data.versions;
    state.versionDetails = data.details ?? [];
    const shownDir = String(data.gameDir || '').replace(/\//g, '\\');
    $('gameDir').textContent = shownDir;
    if ($('tbDirPath')) $('tbDirPath').textContent = shownDir;
    renderInstalled();
    loadTrashBadge();
    // 装过的版本也能作为 Fabric 的基底
    if (typeof renderFabricGameOptions === 'function') renderFabricGameOptions();
  } catch (e) {
    $('installedList').innerHTML =
      `<div class="empty">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

let installedReloadTimer = null;
const trashState = { entries: [] };

async function loadTrashBadge() {
  const btn = $('trashBtn');
  if (!btn) return;
  try {
    const data = await api('/api/trash');
    trashState.entries = data.entries || [];
    const n = trashState.entries.length;
    btn.hidden = n === 0;
    if ($('trashCount')) $('trashCount').textContent = n ? `(${n})` : '';
  } catch {
    btn.hidden = true;
  }
}

function renderTrash(entries) {
  const list = $('trashList');
  if (!list) return;
  if (!entries?.length) {
    list.innerHTML = '<div class="empty">最近删除是空的。</div>';
    return;
  }
  const now = Date.now();
  list.innerHTML = entries.map((x) => {
    const old = now - Number(x.deletedAt || 0) > 30 * 24 * 60 * 60 * 1000;
    return `<div class="trash-row">
      <div class="trash-main">
        <div class="trash-name">${escapeHtml(x.versionId || x.name)}</div>
        <div class="trash-meta">删除时间：${new Date(x.deletedAt).toLocaleString()} · ${fmtSize(x.size)}</div>
        ${old ? '<div class="trash-old">30 天后不会被清理，建议手动删</div>' : ''}
      </div>
      <div class="trash-actions">
        <button class="btn ghost" type="button" data-trash-restore="${escapeHtml(x.name)}">恢复到原位</button>
        <button class="btn ghost" type="button" data-trash-purge="${escapeHtml(x.name)}">彻底删除</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-trash-restore]').forEach((btn) => {
    btn.addEventListener('click', () => restoreTrashItem(btn.dataset.trashRestore));
  });
  list.querySelectorAll('[data-trash-purge]').forEach((btn) => {
    btn.addEventListener('click', () => purgeTrashItem(btn.dataset.trashPurge));
  });
}

async function openTrashModal() {
  try {
    const data = await api('/api/trash');
    trashState.entries = data.entries || [];
    if (!trashState.entries.length) {
      $('trashModal').hidden = true;
      await loadTrashBadge();
      toast('最近删除是空的。', 'ok');
      return;
    }
    renderTrash(trashState.entries);
    $('trashModal').hidden = false;
  } catch (e) {
    toast('读取最近删除失败：' + e.message, 'err');
  }
}

async function restoreTrashItem(name) {
  const item = trashState.entries.find((x) => x.name === name);
  if (!item) return;
  if (!confirm(`恢复实例「${item.versionId || item.name}」到原位？`)) return;
  try {
    const r = await api('/api/trash/restore', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    toast(r.renamed ? `已恢复为 ${r.versionId}（原名称被占用）` : `已恢复到 ${r.versionId}`, 'ok');
    $('trashModal').hidden = true;
    await loadInstalled();
  } catch (e) {
    toast('恢复失败：' + e.message, 'err');
  }
}

async function purgeTrashItem(name) {
  const item = trashState.entries.find((x) => x.name === name);
  if (!item) return;
  if (!confirm(`彻底删除实例「${item.versionId || item.name}」？\n删了就找不回来了。`)) return;
  if (!confirm('再次确认：删了就找不回来了，真的彻底删除？')) return;
  try {
    await api('/api/trash/purge', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    toast('已彻底删除', 'ok');
    await openTrashModal();
    await loadTrashBadge();
  } catch (e) {
    toast('彻底删除失败：' + e.message, 'err');
  }
}
function reloadInstalledSoon() {
  clearTimeout(installedReloadTimer);
  installedReloadTimer = setTimeout(() => { loadInstalled(); }, 450);
}

async function loadRemote() {
  $('remoteList').innerHTML = '<div class="empty">正在获取版本清单…</div>';
  try {
    const data = await api('/api/remote');
    state.remote = data.releases;
    renderRemote();
    if (typeof renderFabricGameOptions === 'function') renderFabricGameOptions();
  } catch (e) {
    $('remoteList').innerHTML = `<div class="empty">获取失败：${escapeHtml(e.message)}</div>`;
  }
}

/* ---------------- Fabric ---------------- */

/** 用已加载的版本清单填充「基于哪个 MC 版本」下拉框 */
function renderFabricGameOptions() {
  const sel = $('fabricGame');
  if (!sel) return;

  // 没刷新过清单就先给个提示，别让下拉框空着让人猜
  const list = state.remote.length ? state.remote : state.versions;
  if (!list.length) {
    sel.innerHTML = '<option value="">先刷新版本清单</option>';
    return;
  }

  const prev = sel.value;
  const ids = list.map((v) => (typeof v === 'string' ? v : v.id));
  sel.innerHTML =
    '<option value="">选择 MC 版本…</option>' +
    ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
  if (prev && ids.includes(prev)) sel.value = prev;
}

/** 选中 MC 版本后拉对应的 Fabric 加载器列表 */
async function loadFabricLoaders() {
  const gameVersion = $('fabricGame').value;
  const loader = $('loaderType')?.value ?? 'fabric';
  const sel = $('fabricLoader');
  const hint = $('fabricHint');

  if (!gameVersion) {
    sel.disabled = true;
    sel.innerHTML = '<option value="">—</option>';
    hint.textContent = '先在上面刷新清单，再选版本。';
    return;
  }

  if (loader !== 'fabric') {
    sel.innerHTML = '<option value="">自动选择推荐版</option>';
    sel.disabled = true;
    hint.textContent =
      loader === 'vanilla'
        ? `原版 ${gameVersion}：不需要加载器。`
        : `${loader === 'forge' ? 'Forge' : 'NeoForge'} ${gameVersion}：自动选推荐版本。`;
    return;
  }

  sel.disabled = false;
  sel.innerHTML = '<option value="">正在获取…</option>';
  try {
    const data = await api('/api/fabric/loaders?gameVersion=' + encodeURIComponent(gameVersion));
    if (!data.loaders?.length) {
      sel.innerHTML = '<option value="">该版本没有可用加载器</option>';
      hint.textContent = `Minecraft ${gameVersion} 没有找到 Fabric 加载器。`;
      return;
    }
    sel.innerHTML =
      `<option value="">最新稳定版</option>` +
      data.loaders
        .map((l) => `<option value="${escapeHtml(l.version)}">${escapeHtml(l.version)}${l.stable ? '' : '（测试版）'}</option>`)
        .join('');
    hint.textContent = `Minecraft ${gameVersion}：共 ${data.loaders.length} 个 Fabric 加载器版本。`;
  } catch (e) {
    sel.innerHTML = '<option value="">获取失败</option>';
    hint.textContent = '获取加载器失败：' + e.message;
  }
}

/** 发起安装（原版 / Fabric / Forge / NeoForge），进度走 SSE */
async function doFabricInstall() {
  if (state.installing) {
    alert('已有任务在进行，等它结束再装。');
    return;
  }

  const loader = $('loaderType')?.value ?? 'fabric';
  const gameVersion = $('fabricGame').value;
  if (!gameVersion) {
    alert('先选一个 Minecraft 版本。');
    return;
  }

  const btn = $('fabricInstall');
  if (btn?.disabled) return;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('busy');
  }

  try {
    if (loader === 'vanilla') {
      await doInstall(gameVersion);
      return;
    }

    const instanceName = $('fabricName').value.trim() || undefined;
    // 先给即时反馈，别等 SSE —— 第一下点击必须看得见动静
    showProgress(true);
    resetCancelButton();
    updateProgress({ stage: 'start', message: `准备安装 ${loader} ${gameVersion}…` });

    if (loader === 'fabric') {
      const loaderVersion = $('fabricLoader').value || undefined;
      await api('/api/fabric/install', {
        method: 'POST',
        body: JSON.stringify({ gameVersion, loaderVersion, instanceName }),
      });
    } else {
      await api(`/api/${loader}/install`, {
        method: 'POST',
        body: JSON.stringify({ gameVersion, instanceName }),
      });
    }
    // 后续进度由 fabric-start / fabric-stage / fabric-done 驱动
  } catch (e) {
    updateProgress({ stage: 'error', message: `安装请求失败：${e.message}` });
    setTimeout(() => showProgress(false), 5000);
    alert(`安装请求失败：${e.message}`);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('busy');
      }
    }, 1500);
  }
}

async function doInstall(versionId) {
  if (state.installing) return;
  showProgress(true);
  updateProgress({ stage: 'start', message: `准备安装 ${versionId}` });
  try {
    await api('/api/install', { method: 'POST', body: JSON.stringify({ versionId }) });
  } catch (e) {
    showProgress(false);
    alert('安装请求失败：' + e.message);
  }
}

function showPreflightError(missing, message, preflight = null) {
  const p = preflight || {};
  const reasonNames = {
    network: '网络连接失败（连不上/超时/DNS）',
    auth: '下载源拒绝访问（401/403，可能需要正版登录或令牌）',
    locked: '文件被占用或没有写入权限',
    disk: '磁盘空间不足',
    unknown: '没查明原因',
  };
  const problem = p.problem || message || '这个版本缺少启动文件，补不上。';
  const reason = p.reasonText || reasonNames[p.reason] || p.reason || '没查明原因';
  const suggestion = p.suggestion || p.advice || '点打开日志，把最后几行发给开发者';
  const structured = $('preflightStructured');
  if (structured) {
    structured.innerHTML = `
      <section class="preflight-section"><h4>问题</h4><p>${escapeHtml(problem)}</p></section>
      <section class="preflight-section"><h4>原因</h4><p>${escapeHtml(reason)}</p></section>
      <section class="preflight-section"><h4>建议</h4><p>${escapeHtml(suggestion)}</p></section>`;
  }
  const list = $('preflightList');
  if (list) {
    list.innerHTML = (missing || []).map((x) => `<li><b>${escapeHtml(x.label || x.kind || '文件')}</b><br>${escapeHtml(x.path || '')}</li>`).join('');
  }
  const text = $('preflightMessage');
  if (text) { text.textContent = ''; text.hidden = true; }
  const modal = $('preflightModal');
  if (modal) modal.hidden = false;
}
async function doLaunch(versionId, joinAddress, opts = {}) {
  if (state.running) {
    alert(`游戏正在运行：${state.running.versionId}\n先关掉正在跑的游戏，再${joinAddress ? '点「加入并启动」' : '重新启动'}。`);
    return;
  }
  if (state.installing) {
    alert('正在安装，等它结束再启动。');
    return;
  }
  setStatus('busy', `正在启动 ${versionId}…`);
  const logBtn = $('openLogBtn');
  if (logBtn) logBtn.hidden = true;
  appendLog(`>>> 请求启动 ${versionId}${joinAddress ? `（加入 ${joinAddress}）` : ''}`);
  try {
    const r = await api('/api/launch', {
      method: 'POST',
      body: JSON.stringify({
        versionId,
        username: state.username || 'Player',
        joinAddress,
        quickPlaySave: opts.quickPlaySave || '',
        recentMeta: opts.recentMeta || null,
      }),
    });
    setStatus('running', `运行 ${versionId}`);
    const retry = $('launchRetryBtn');
    if (retry) retry.hidden = true;
    showProgress(false);
    appendLog(`>>> 启动 ${versionId}，PID ${r.pid}`);
    syncLogs();
    if (typeof loadRecentPlay === 'function') loadRecentPlay();
  } catch (e) {
    setStatus('error', '启动失败');
    appendLog(`启动失败：${e.message}`);
    showProgress(false);
    state.launchRetryVersion = versionId;
    const retry = $('launchRetryBtn');
    if (retry) retry.hidden = false;
    if (e.code === 'PREFLIGHT_MISSING') {
      state.preflightMissing = e.missing || [];
      state.preflightMessage = e.message || '';
      state.preflightStructured = e.preflight || null;
      showPreflightError(e.missing, e.message, e.preflight);
      return;
    }
    alert('启动失败：' + e.message);
  }
}

/* ---- 商店 ---- */

/** 统一渲染分页控件：offset/limit/total -> 上一页/下一页 */
function renderPager(which, { offset, limit, total }) {
  const pager = $(`${which}Pager`);
  const info = $(`${which}PageInfo`);
  const prev = $(`${which}Prev`);
  const next = $(`${which}Next`);

  if (!total || total <= limit) {
    pager.hidden = true;
    return;
  }

  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  pager.hidden = false;
  info.innerHTML = `第 <b>${page}</b> / ${pages} 页 · 共 ${total} 条`;
  prev.disabled = offset <= 0;
  next.disabled = offset + limit >= total;
}

/** 按当前关键词和页码重新搜（翻页复用，不重读输入框） */
async function doStoreSearch(offset = 0) {
  const q = $('storeQuery').value.trim();
  const type = $('storeType').value;
  const sort = $('storeSort').value;
  const versionId = $('storeInstance').value;

  state.storeType = type;
  state.storeInstance = versionId;
  state.storePage.offset = offset;

  renderSkeleton('storeResults', 6, '正在加载…');
  $('storePager').hidden = true;

  try {
    const params = new URLSearchParams({
      type,
      q,
      sort,
      limit: String(state.storePage.limit),
      offset: String(offset),
    });
    if (versionId) params.set('versionId', versionId);

    const data = await api('/api/store/search?' + params);
    state.storeHits = data.hits;
    state.storePage.total = data.total ?? 0;

    // 显示实际生效的过滤条件，避免以为搜不到是 bug
    const f = data.filters || {};
    if (f.gameVersion) {
      $('storeHint').innerHTML = `目标实例 <b>${escapeHtml(versionId)}</b>：已按 MC <b>${escapeHtml(f.gameVersion)}</b>` +
        (f.loader ? ` + <b>${escapeHtml(f.loader)}</b>` : '') +
        ` 过滤，共 ${data.total} 条匹配。`;
    } else {
      updateStoreHint();
    }

    renderStore();
    renderPager('store', state.storePage);
  } catch (e) {
    renderListError('storeResults', `搜索失败：${escapeHtml(e.message)}`, () => doStoreSearch(offset));
    $('storePager').hidden = true;
  }
}

/** 选中某个项目 -> 弹窗选版本 -> 下载 */
async function pickVersion(slug) {
  const versionId = $('storeInstance').value;
  const type = $('storeType').value;

  $('modalTitle').textContent = '选择版本';
  $('modalBody').innerHTML = '<div class="empty">正在获取版本…</div>';
  $('versionModal').hidden = false;

  try {
    const params = new URLSearchParams({ slug, type });
    if (versionId) params.set('versionId', versionId);
    const data = await api('/api/store/versions?' + params);

    if (!data.versions.length) {
      $('modalBody').innerHTML =
        '<div class="empty">这个项目没有可用版本' +
        (data.filters?.gameVersion ? `（MC ${escapeHtml(data.filters.gameVersion)}）` : '') +
        '</div>';
      return;
    }

    const note = data.filters?.gameVersion
      ? `<div class="hint">匹配 <b>${escapeHtml(data.filters.gameVersion)}</b> 的版本 ${data.compatible} 个 / 共 ${data.total} 个
         ${data.compatible === 0 ? '<span class="warn">— 没有完全兼容的，显示全部版本，装了可能不生效</span>' : ''}</div>`
      : '';

    $('modalBody').innerHTML = note + data.versions.map((v, i) => {
      const f = v.files?.find((x) => x.primary) ?? v.files?.[0];
      if (!f) return '';
      return `
        <div class="ver-row">
          <div class="ver-main">
            <div class="ver-name">${escapeHtml(v.versionNumber)}</div>
            <div class="ver-sub">
              ${escapeHtml((v.gameVersions ?? []).slice(-2).join(', '))}
              · ${escapeHtml((v.loaders ?? []).join('/'))}
              · ${fmtSize(f.size)}
              · ${escapeHtml(v.releaseType)}
            </div>
          </div>
          <button class="btn" data-install-file="${i}">安装</button>
        </div>`;
    }).join('');

    $('modalBody').querySelectorAll('[data-install-file]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const v = data.versions[Number(btn.dataset.installFile)];
        const f = v.files?.find((x) => x.primary) ?? v.files?.[0];
        $('versionModal').hidden = true;
        await installFiles(type, [{
          url: f.url,
          filename: f.filename,
          sha1: f.sha1,
          size: f.size,
          source: 'modrinth',
          projectId: v.projectId,
          dependencies: v.dependencies || [],
        }], v.versionNumber);
      });
    });
  } catch (e) {
    $('modalBody').innerHTML = `<div class="empty">获取版本失败：${escapeHtml(e.message)}</div>`;
  }
}

async function installFiles(type, files, label) {
  const versionId = $('storeInstance').value;
  if (!versionId) {
    alert('请先在顶部选一个目标实例');
    return;
  }
  showProgress(true);
  updateProgress({ stage: 'content', message: `准备安装 ${label}` });
  try {
    await api('/api/content/install', {
      method: 'POST',
      body: JSON.stringify({ versionId, projectType: type, files, source: files[0]?.source || '' }),
    });
  } catch (e) {
    showProgress(false);
    alert('安装失败：' + e.message);
  }
}

/* ---- 整合包 ---- */

async function doPackSearch(offset = 0) {
  const q = $('packQuery').value.trim();
  const sort = $('packSort').value;
  state.packPage.offset = offset;

  const sources = state.packSources;
  const multi = sources.length > 1;
  const onlyCF = sources.length === 1 && sources[0] === 'curseforge';

  renderSkeleton(
    'packResults',
    6,
    multi ? '正在加载整合包…' : onlyCF ? '正在加载 CurseForge 整合包…' : '正在加载 Modrinth 整合包…'
  );
  $('packPager').hidden = true;

  /* 多选时两个站点各自拉一页，然后合并。
     为什么不用服务端合并：两边排序算法完全不同（一个按参数、一个按接口），
     混排只能拿下载量当尺子，放在前端做反而简单 —— 而且哪边挂了不影响另一边。 */
  const perSource = multi ? Math.max(8, Math.ceil(state.packPage.limit / sources.length)) : state.packPage.limit;

  const params = new URLSearchParams({
    type: 'modpack',
    q,
    sort,
    limit: String(perSource),
    offset: String(offset),
  });

  try {
    const tasks = sources.map((src) => {
      const url = (src === 'curseforge' ? '/api/cf/search?' : '/api/store/search?') + params;
      // 单个来源失败不能拖垮整个列表：包成 {ok:false} 让后面能分开讲
      return api(url)
        .then((data) => ({ src, data, ok: !data?.error }))
        .catch((e) => ({ src, data: null, ok: false, err: e.message }));
    });

    const results = await Promise.all(tasks);
    const loaded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    // 两个都挂了才真的没东西看
    if (!loaded.length) {
      const msg = failed
        .map((f) => `${f.src === 'curseforge' ? 'CurseForge' : 'Modrinth'}：${escapeHtml(f.data?.error ?? f.err ?? '未知错误')}`)
        .join('<br>');
      $('packResults').innerHTML = `<div class="empty">两个来源都没连上：<br>${msg}<br><button class="btn ghost" data-retry>重试</button></div>`;
      $('packResults').querySelector('[data-retry]')?.addEventListener('click', () => doPackSearch(offset));
      $('packHint').textContent = '来源全部不可用';
      return;
    }

    let hits = [];
    let total = 0;
    for (const r of loaded) {
      // 给每一条打上来源：合并后点「装」必须知道走哪个接口
      const tagged = (r.data.hits ?? []).map((h) => ({ ...h, source: r.src }));
      hits = hits.concat(tagged);
      total += r.data.total ?? tagged.length;
    }

    if (multi) {
      // 混排时按下载量降序，两边才有可比性
      hits.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
    }

    state.packs = hits;
    state.packPage.total = total;
    renderPacks();
    renderPager('pack', state.packPage);

    const cfDown = failed.some((f) => f.src === 'curseforge');
    const mrDown = failed.some((f) => f.src === 'modrinth');
    let hint;
    if (multi) {
      hint = `共 ${fmtNum(total)} 个整合包（Modrinth + CurseForge 合并）。安装时会自动建实例并装好 loader。`;
      if (cfDown) hint += ' CurseForge 本次没连上，只显示了 Modrinth。';
      if (mrDown) hint += ' Modrinth 本次没连上，只显示了 CurseForge。';
    } else if (onlyCF) {
      hint = `共 ${fmtNum(total)} 个 CurseForge 整合包。安装时会自动建实例并装好 loader。`;
    } else {
      hint = `共 ${fmtNum(total)} 个整合包。安装时会自动建独立实例并装好 loader。`;
    }
    $('packHint').textContent = hint;
  } catch (e) {
    renderListError('packResults', `搜索失败：${escapeHtml(e.message)}`, () => doPackSearch(offset));
    $('packPager').hidden = true;
  }
}

async function pickPack(index) {
  // 多来源合并后不能再用 slug 反查：同一个 slug 在两个站点可能都有，
  // 反而会把 Modrinth 的包当成 CurseForge 的去装。改成直接按索引取。
  const pack = (state.packs ?? [])[Number(index)];
  if (!pack) {
    $('versionModal').hidden = true;
    return;
  }

  $('modalTitle').textContent = '整合包版本';
  $('modalBody').innerHTML = '<div class="empty">正在获取版本…</div>';
  $('versionModal').hidden = false;

  // 封面图要从搜索结果里拿：版本接口不带 icon
  const packIcon = pack.iconUrl ?? null;

  if (pack.source === 'curseforge') {
    return pickCfPack(pack, packIcon);
  }

  const slug = pack.slug;

  try {
    const data = await api('/api/store/versions?' + new URLSearchParams({ slug, type: 'modpack' }));

    if (!data.versions.length) {
      $('modalBody').innerHTML = '<div class="empty">没有可用版本</div>';
      return;
    }

    $('modalBody').innerHTML = data.versions.map((v, i) => {
      const f = v.files?.find((x) => x.primary) ?? v.files?.[0];
      if (!f) return '';
      return `
        <div class="ver-row">
          <div class="ver-main">
            <div class="ver-name">${escapeHtml(v.versionNumber)}</div>
            <div class="ver-sub">
              MC ${escapeHtml((v.gameVersions ?? []).slice(-2).join(', '))}
              · ${escapeHtml((v.loaders ?? []).join('/'))}
              · ${fmtSize(f.size)}
            </div>
          </div>
          ${v.datePublished ? `<div class="ver-date" title="最新更新时间">
            <span>${escapeHtml(fmtDate(v.datePublished))}</span>
            <small>${escapeHtml(fmtAge(v.datePublished))}</small>
          </div>` : ''}
          <button class="btn" data-install-pack="${i}">安装</button>
        </div>`;
    }).join('');

    $('modalBody').querySelectorAll('[data-install-pack]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const v = data.versions[Number(btn.dataset.installPack)];
        const f = v.files?.find((x) => x.primary) ?? v.files?.[0];
        $('versionModal').hidden = true;

        showProgress(true);
        updateProgress({ stage: 'modpack', message: '准备安装整合包…' });
        try {
          await api('/api/modpack/install', {
            method: 'POST',
            body: JSON.stringify({
              mrpackUrl: f.url,
              mrpackSha1: f.sha1,
              instanceName: slug,
              iconUrl: packIcon,
            }),
          });
        } catch (e) {
          showProgress(false);
          alert('整合包安装失败：' + e.message);
        }
      });
    });
  } catch (e) {
    $('modalBody').innerHTML = `<div class="empty">获取失败：${escapeHtml(e.message)}</div>`;
  }
}

/**
 * CurseForge 整合包：先预览再装。
 *
 * 跟 Modrinth 不一样：CF 的版本列表只给文件名和大小，
 * 「要多少 MC 版本、什么加载器、多少个文件」都写在包内的 manifest.json 里，
 * 所以点「预览」时要真下载一次整包才能读出来（服务端读完立刻删）。
 */
async function pickCfPack(pack, packIcon) {
  if (!pack?.id) {
    $('modalBody').innerHTML = '<div class="empty">缺少 CurseForge 项目 id</div>';
    return;
  }

  $('modalBody').innerHTML = '<div class="empty">正在获取文件列表…</div>';

  try {
    const data = await api('/api/cf/files?' + new URLSearchParams({ id: String(pack.id) }));

    if (data.error) {
      $('modalBody').innerHTML = `<div class="empty">CurseForge 不可用：${escapeHtml(data.error)}</div>`;
      return;
    }
    if (!data.files?.length) {
      $('modalBody').innerHTML = '<div class="empty">这个整合包没有可下载的文件</div>';
      return;
    }

    $('modalBody').innerHTML = data.files.map((f, i) => `
      <div class="ver-row">
        <div class="ver-main">
          <div class="ver-name">${escapeHtml(f.name)}</div>
          <div class="ver-sub">
            ${escapeHtml((f.gameVersions ?? []).slice(0, 2).join(', '))}
            · ${fmtSize(f.size)}
            · ${escapeHtml(f.releaseType)}
            ${f.distributable ? '' : ' · <span class="err">不可自动下载</span>'}
          </div>
        </div>
        ${f.datePublished ? `<div class="ver-date" title="发布日期">
          <span>${escapeHtml(fmtDate(f.datePublished))}</span>
          <small>${escapeHtml(fmtAge(f.datePublished))}</small>
        </div>` : ''}
        <button class="btn" data-install-cf="${i}" ${f.distributable ? '' : 'disabled'}>安装</button>
      </div>`).join('');

    $('modalBody').querySelectorAll('[data-install-cf]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const f = data.files[Number(btn.dataset.installCf)];
        if (!f?.distributable) return;
        $('versionModal').hidden = true;

        showProgress(true);
        updateProgress({ stage: 'cfpack', message: '准备安装 CurseForge 整合包…' });
        try {
          await api('/api/cf/pack/install', {
            method: 'POST',
            body: JSON.stringify({
              modId: pack.id,
              fileId: f.id,
              instanceName: pack.slug || pack.title,
              iconUrl: packIcon,
            }),
          });
        } catch (e) {
          showProgress(false);
          alert('整合包安装失败：' + e.message);
        }
      });
    });
  } catch (e) {
    $('modalBody').innerHTML = `<div class="empty">获取失败：${escapeHtml(e.message)}</div>`;
  }
}

/* ---- 内容管理 ---- */

async function openContent(versionId) {
  state.contentVersion = versionId;
  $('contentTitle').textContent = `实例 ${versionId} 的内容`;
  state.selectedVersion = versionId;
  localStorage.setItem('sakura.selectedVersion', versionId);
  $('contentPanel').hidden = false;
  $('contentGroups').innerHTML = '<div class="empty">读取中…</div>';

  try {
    const data = await api('/api/content/list?' + new URLSearchParams({ versionId }));
    renderContent(data);
  } catch (e) {
    $('contentGroups').innerHTML = `<div class="empty">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

async function removeFile(filename, group) {
  const typeMap = { mods: 'mod', shaderpacks: 'shader', resourcepacks: 'resourcepack' };
  const type = typeMap[group];
  if (!type) return;
  if (!confirm(`确定删除 ${filename}？`)) return;

  try {
    await api('/api/content/remove', {
      method: 'POST',
      body: JSON.stringify({ versionId: state.contentVersion, projectType: type, filename }),
    });
    await openContent(state.contentVersion);
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

async function toggleFile(filename, group, enable) {
  const typeMap = { mods: 'mod', shaderpacks: 'shader', resourcepacks: 'resourcepack' };
  const type = typeMap[group];
  if (!type) return;

  try {
    await api('/api/content/toggle', {
      method: 'POST',
      body: JSON.stringify({
        versionId: state.contentVersion,
        projectType: type,
        filename,
        enable,
      }),
    });
    await openContent(state.contentVersion);
  } catch (e) {
    alert('操作失败：' + e.message);
  }
}

/* ---- 模组批量更新 ---- */

/**
 * 检查更新：只读，不改任何文件。
 * 结果先列出来让人挑，确认后才真下载 —— 批量换模组有风险，
 * 不该点一下就自动全换。
 */
async function checkModUpdates() {
  const versionId = state.contentVersion;
  if (!versionId) return;

  const box = $('modUpdates');
  const btn = $('checkModUpdates');
  if (btn.disabled) return;

  btn.disabled = true;
  btn.textContent = '扫描中…';
  box.hidden = false;
  box.innerHTML = '<div class="mu-empty">正在算文件指纹…</div>';

  try {
    const r = await api('/api/mods/check-updates', {
      method: 'POST',
      body: JSON.stringify({ versionId }),
    });
    renderModUpdates(r);
  } catch (e) {
    box.innerHTML = `<div class="mu-empty">检查失败：${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '检查更新';
  }
}

function renderModUpdates(r) {
  const box = $('modUpdates');
  box.hidden = false;

  if (!r.total) {
    box.innerHTML = '<div class="mu-empty">这个实例没有模组</div>';
    return;
  }

  const ups = r.updates ?? [];
  const parts = [];

  parts.push(`
    <div class="mu-head">
      <span>共 <b>${r.total}</b> 个模组，识别出 <b>${r.identified}</b> 个</span>
      <span>可更新 <b>${ups.length}</b></span>
      <span class="grow"></span>
      ${ups.length ? '<button class="btn" id="muSelectAll">全选</button>' : ''}
      ${ups.length ? '<button class="btn" id="muApply">更新选中</button>' : ''}
      <button class="btn ghost" id="muClose">收起</button>
    </div>`);

  if (!ups.length) {
    parts.push('<div class="mu-empty">没有可更新的模组，都是最新的</div>');
  } else {
    parts.push(
      ups.map((u, i) => {
        const tag = u.releaseType && u.releaseType !== 'release'
          ? `<span class="mu-tag ${u.releaseType}">${u.releaseType}</span>`
          : '';
        return `
        <label class="mu-row ${u.disabled ? 'off' : ''}">
          <input type="checkbox" class="mu-check" data-idx="${i}" checked>
          <span class="mu-title" title="${escapeHtml(u.oldName)} → ${escapeHtml(u.newName)}">${escapeHtml(u.title)}</span>
          ${tag}
          <span class="mu-ver">${escapeHtml(u.from)} <span class="to">→ ${escapeHtml(u.to)}</span></span>
        </label>`;
      }).join('')
    );
  }

  // 查不到 / 已最新的，折叠成一行说明，不占地方
  const unknown = r.unknown ?? [];
  const current = r.current ?? [];
  if (unknown.length || current.length) {
    const bits = [];
    if (current.length) bits.push(`${current.length} 个已最新`);
    if (unknown.length) bits.push(`${unknown.length} 个查不到（CF 独占/自制）`);
    parts.push(`
      <details class="mu-note">
        <summary>其余 ${bits.join('、')}</summary>
        ${current.map((c) => `<div>${escapeHtml(c.title)} ${escapeHtml(c.versionNumber)} — ${escapeHtml(c.note)}</div>`).join('')}
        ${unknown.map((u) => `<div>${escapeHtml(u.name)} — ${escapeHtml(u.reason)}</div>`).join('')}
      </details>`);
  }

  box.innerHTML = parts.join('');

  $('muClose')?.addEventListener('click', () => { box.hidden = true; });
  $('muSelectAll')?.addEventListener('click', () => {
    const checks = [...box.querySelectorAll('.mu-check')];
    const allOn = checks.every((c) => c.checked);
    checks.forEach((c) => { c.checked = !allOn; });
    $('muSelectAll').textContent = allOn ? '全选' : '全不选';
  });
  $('muApply')?.addEventListener('click', () => openModUpdatePreview(ups));
}

const MOD_UPDATE_TYPES = [
  ['mod', 'mods'],
  ['resourcepack', 'resourcepacks'],
  ['shader', 'shaderpacks'],
];

function modUpdateVersion(u, key) {
  if (u[key]) return u[key];
  if (key === 'to' && u.datePublished) return `有新版（${String(u.datePublished).slice(0, 10)}）`;
  return '有新版';
}

function openModUpdatePreview(ups) {
  const box = $('modUpdates');
  const picked = [...box.querySelectorAll('.mu-check')]
    .filter((c) => c.checked)
    .map((c) => ups[Number(c.dataset.idx)])
    .filter(Boolean);
  if (!picked.length) {
    alert('先选要更新的文件');
    return;
  }
  const groups = MOD_UPDATE_TYPES
    .map(([type, folder]) => ({
      type,
      folder,
      items: picked.filter((u) => (u.type || 'mod') === type),
    }))
    .filter((g) => g.items.length);
  const root = $('modUpdatePreviewGroups');
  if (root) {
    root.innerHTML = groups.map((g) => {
      const shown = g.items.slice(0, 10).map((u) => `
        <div class="mod-update-preview-row">
          <span class="name">${escapeHtml(u.title || u.oldName)}</span>
          <span class="ver">${escapeHtml(modUpdateVersion(u, 'from'))} → ${escapeHtml(modUpdateVersion(u, 'to'))}</span>
        </div>`).join('');
      const more = g.items.length > 10
        ? `<div class="mod-update-preview-more">等 ${g.items.length} 个</div>`
        : '';
      return `<div class="mod-update-preview-group">
        <div class="mod-update-preview-head">${escapeHtml(g.folder)} · ${g.items.length} 个</div>
        ${shown}${more}
      </div>`;
    }).join('');
  }
  if ($('modUpdatePreviewConfirm')) {
    $('modUpdatePreviewConfirm').textContent = `更新 ${picked.length} 个文件`;
    $('modUpdatePreviewConfirm').dataset.count = String(picked.length);
  }
  const modal = $('modUpdatePreviewModal');
  if (modal) modal.hidden = false;
  window.__pendingModUpdates = picked;
}

async function applyModUpdates(picked) {
  if (!Array.isArray(picked) || !picked.length) return;
  try {
    await api('/api/mods/apply-updates', {
      method: 'POST',
      body: JSON.stringify({ versionId: state.contentVersion, items: picked }),
    });
    // 实际下载进度走 SSE；这里只把按钮防住，防止连点
    $('muApply').disabled = true;
    $('muApply').textContent = '更新中…';
  } catch (e) {
    alert('启动更新失败：' + e.message);
  }
}

/* ---------------- 日志 ---------------- */

function appendLog(text) {
  const box = $('logBox');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.textContent += text + '\n';
  const lines = box.textContent.split('\n');
  if (lines.length > 800) box.textContent = lines.slice(-800).join('\n');
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** 从 /api/logs 拉一次完整尾部，防止 SSE 断线/漏事件时面板停在旧日志 */
async function syncLogs() {
  try {
    const data = await api('/api/logs');
    const lines = (data.logs || []).map((x) => x.line);
    if (!lines.length) return;
    const box = $('logBox');
    box.textContent = lines.join('\n');
    box.scrollTop = box.scrollHeight;
  } catch {
    /* 日志拉取失败不盖住启动反馈 */
  }
}

/** 读取游戏目录/实例目录里现成的 logs/latest.log */
async function loadLatestLog() {
  try {
    const q = state.selectedVersion ? `?versionId=${encodeURIComponent(state.selectedVersion)}` : '';
    const data = await api('/api/logs/latest' + q);
    if (!data.lines?.length) {
      toast(data.missing ? '没有找到 logs/latest.log' : 'latest.log 是空的', 'err');
      return;
    }
    const box = $('logBox');
    box.textContent =
      `===== ${data.path}（${data.lines.length} 行，历史日志）=====\n` +
      data.lines.join('\n');
    box.scrollTop = box.scrollHeight;
    toast('已读取 latest.log', 'ok');
  } catch (e) {
    toast('读取 latest.log 失败：' + e.message, 'err');
  }
}

/* ---------------- SSE ---------------- */

function connectEvents() {
  const es = new EventSource('/api/events');

  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'hello': {
        const s = msg.state || {};
        state.installing = s.installing;
        state.running = s.running;
        refreshSavesPageIfVisible();
        state.lastFailure = s.lastFailure ?? null;
        setAppVersion(s.version);
        if (s.installInterrupted) {
          const msg = `上次安装未正常结束：${s.installInterrupted.versionId || '未知实例'}`
            + (s.installInterrupted.stage ? `（阶段 ${s.installInterrupted.stage}）` : '');
          appendLog(msg);
          toast(msg, 'err');
        }
        refreshStatus();
        if (s.installing) {
          showProgress(true);
          updateProgress(s.installing);
        }
        break;
      }

      case 'save-progress':
        if ($('savesProgress')) $('savesProgress').textContent = msg.message || '';
        break;

      case 'export-progress':
        if ($('exportProgress')) $('exportProgress').textContent = msg.message || '';
        break;
      case 'install-start':
        state.installing = { versionId: msg.versionId, stage: 'start' };
        resetCancelButton();
        showProgress(true);
        updateProgress({ stage: 'start', message: `开始安装 ${msg.versionId}` });
        refreshStatus();
        break;

      case 'install-stage':
        updateProgress({ stage: msg.stage, message: msg.message });
        break;

      case 'install-progress':
        updateProgress(msg);
        break;

      case 'install-done': {
        const st = msg.report?.stages || {};
        const libs = st.libraries || {};
        const assets = st.assets || {};
        const jv = st.java || {};
        let detail = `库 ${libs.downloaded ?? 0} 个，资源 ${assets.downloaded ?? 0} 个`;
        if (jv.installed) detail += `，顺带装了 Java ${jv.required}`;
        updateProgress({ stage: 'done', message: `安装完成：${detail}` });
        $('progressFill').style.width = '100%';
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 3000);
        reloadInstalledSoon();
        loadRemote();
        break;
      }

      case 'install-error':
        updateProgress({ stage: 'error', message: `安装失败：${msg.error}` });
        $('progressFill').style.width = '0%';
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 5000);
        break;

      // 取消成功：不是失败，别报红。
      // 进度条直接收掉，并告诉人“已下好的文件留着”。
      case 'install-cancelled':
        updateProgress({ stage: 'error', message: cancelText(msg.message) });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 1800);
        break;

      case 'launch-preflight':
        setStatus('busy', msg.message || '启动前检查…');
        appendLog(`[preflight] ${msg.message || ''}`);
        if (msg.missing?.length) appendLog(`[preflight] 缺失：${msg.missing.join(' / ')}`);
        showProgress(true);
        updateProgress({ stage: 'preflight', message: msg.message || '启动前检查…' });
        break;
      case 'launch-java-stage':
        setStatus('busy', msg.message || '准备 Java 运行时…');
        appendLog(`[java] ${msg.message || ''}`);
        showProgress(true);
        updateProgress({ stage: 'java', message: msg.message || '准备 Java 运行时…' });
        break;

      case 'launch-java-progress':
        updateProgress({ ...msg, stage: 'java' });
        break;
      /* ---- 内容 ---- */
      case 'content-start':
        state.installing = { versionId: msg.versionId };
        resetCancelButton();
        showProgress(true);
        updateProgress({ stage: 'content', message: `安装 ${msg.count} 个文件…` });
        refreshStatus();
        break;

      case 'content-progress':
        updateProgress(msg);
        break;

      case 'content-done': {
        const r = msg.result || {};
        const depAdded = r.dependencies?.added || 0;
        const depFailed = r.dependencies?.failed || [];
        const depLine = depFailed.length
          ? `；以下依赖没装上：${depFailed.map((x) => `${x.name}（${x.reason}）`).join('、')}`
          : '';
        updateProgress({
          stage: 'done',
          message: `完成：新装 ${r.installed?.length ?? 0}，已有 ${r.skipped?.length ?? 0}，失败 ${r.failed?.length ?? 0}；已自动补 ${depAdded} 个依赖${depLine}`,
        });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 2500);
        if (state.contentVersion) openContent(state.contentVersion);
        break;
      }

      case 'content-error':
        updateProgress({ stage: 'error', message: `安装失败：${msg.error}` });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 5000);
        break;

      case 'content-cancelled':
        updateProgress({ stage: 'error', message: cancelText(msg.message) });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 1800);
        break;

      /* ---- 模组批量更新 ---- */
      case 'mods-update-start':
        state.installing = { versionId: msg.versionId };
        resetCancelButton();
        showProgress(true);
        updateProgress({ stage: 'mod-update', message: `开始更新 ${msg.count} 个模组…` });
        refreshStatus();
        break;

      case 'mods-update-progress':
        updateProgress({ stage: 'mod-update', done: msg.done, total: msg.total, message: msg.message });
        break;

      case 'mods-update-done': {
        const r = msg.result || {};
        const failed = r.failed?.length ?? 0;
        const failText = (r.failed || []).map((x) => `${x.name}${x.error ? `（${x.error}）` : ''}`).join('、');
        const backupText = r.backup?.file ? `；备份 ${r.backup.file}（modupdate）` : '';
        updateProgress({
          stage: failed ? 'error' : 'done',
          message: r.rolledBack
            ? `已回滚，失败的是 ${failText || '未知文件'}`
            : `更新完成：成功 ${r.updated?.length ?? 0}，失败 ${failed}${backupText}`,
        });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), failed ? 5000 : 2500);
        if (state.contentVersion) {
          openContent(state.contentVersion);
          setTimeout(() => { if (state.contentVersion) checkModUpdates(); }, 600);
        }
        break;
      }

      case 'mods-update-error':
        updateProgress({ stage: 'error', message: `模组更新失败：${msg.error}` });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 5000);
        break;

      case 'mods-update-cancelled':
        updateProgress({ stage: 'error', message: cancelText(msg.message) });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 1800);
        if (state.contentVersion) openContent(state.contentVersion);
        break;

      /* ---- Fabric ---- */
      case 'fabric-start':
        state.installing = { versionId: msg.gameVersion };
        resetCancelButton();
        showProgress(true);
        updateProgress({ stage: 'fabric', message: `开始安装 ${msg.loaderLabel ?? 'Fabric'}…` });
        refreshStatus();
        break;

      case 'fabric-stage':
        updateProgress({ stage: msg.stage, message: msg.message });
        break;

      case 'fabric-progress':
        updateProgress(msg);
        break;

      case 'fabric-done':
        updateProgress({ stage: 'done', message: `${msg.loaderLabel ?? 'Fabric'} 完成：${msg.result?.versionId}` });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 2500);
        reloadInstalledSoon();
        break;

      case 'fabric-error':
        updateProgress({ stage: 'error', message: `${msg.loaderLabel ?? 'Fabric'} 失败：${msg.error}` });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 5000);
        break;

      case 'fabric-cancelled':
        updateProgress({ stage: 'error', message: cancelText(msg.message) });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 1800);
        break;

      /* ---- 整合包 ---- */
      case 'modpack-start':
        state.installing = { versionId: 'modpack' };
        resetCancelButton();
        showProgress(true);
        updateProgress({ stage: 'modpack', message: '开始安装整合包…' });
        refreshStatus();
        break;

      case 'modpack-stage':
        updateProgress({ stage: msg.stage, message: msg.message });
        break;

      case 'modpack-progress':
        updateProgress(msg);
        break;

      case 'modpack-done': {
        const r = msg.result || {};
        updateProgress({
          stage: 'done',
          message: `整合包完成：${r.instanceId}（${r.files?.downloaded ?? 0} 个文件）`,
        });
        $('progressFill').style.width = '100%';
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 3500);
        reloadInstalledSoon();
        break;
      }

      case 'modpack-error':
        updateProgress({ stage: 'error', message: `整合包失败：${msg.error}` });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 5000);
        break;

      case 'modpack-cancelled':
        updateProgress({ stage: 'error', message: cancelText(msg.message) });
        state.installing = null;
        disableCancelButton();
        refreshStatus();
        setTimeout(() => showProgress(false), 1800);
        break;

      case 'log-clear':
        if ($('logBox')) $('logBox').textContent = '';
        break;

      /* ---- 游戏 ---- */
      case 'diagnostic-ready':
        if (typeof window.assistantDiagnosticReady === 'function') {
          window.assistantDiagnosticReady(msg.package);
        }
        break;
      case 'crash-detected':
        if (typeof window.assistantCrash === 'function') window.assistantCrash(msg.incident);
        break;
      case 'game-start':
        state.running = { versionId: msg.versionId, pid: msg.pid };
        refreshSavesPageIfVisible();
        refreshStatus();
        renderInstalled();
        break;

      case 'game-stopping':
        setStatus('busy', '游戏正在退出…');
        break;

      case 'game-exit': {
        const code = msg.code;
        state.running = null;
        refreshSavesPageIfVisible();
        renderInstalled();
        appendLog(`<<< 游戏退出 code=${code}`);
        setTimeout(() => {
          if (typeof loadRoomState === 'function') loadRoomState();
          if (typeof loadRecentPlay === 'function') loadRecentPlay();
        }, 1200);
        if (code !== 0 && code !== null && code !== undefined) {
          const reason = String(msg.reason || '').replace(/\s+/g, ' ').trim();
          setStatus('error', reason ? `启动失败：${reason.slice(0, 180)}` : `启动失败：code=${code}`);
          if (reason) appendLog(`退出原因：${reason}`);
          appendLog(`游戏异常退出（code=${code}），详情见运行日志`);
          const btn = $('openLogBtn');
          if (btn) btn.hidden = false;
          state.lastFailure = { versionId: msg.versionId, code, reason: msg.reason || '', at: Date.now() };
          renderLastFailure();
          if (typeof window.assistantOnFailure === 'function') window.assistantOnFailure();
        } else {
          refreshStatus();
          const btn = $('openLogBtn');
          if (btn) btn.hidden = true;
        }
        setTimeout(syncLogs, 300);
        break;
      }

      case 'log':
        appendLog(msg.line);
        break;

      case 'track-update': {
        // 后台轮询发现新版本：本地列表立刻刷新，不用等用户手点
        const found = msg.found ?? [];
        if (found.length) {
          for (const f of found) {
            appendLog(`发现新版本：${f.title} ${f.from ?? '?'} → ${f.to}`);
          }
          loadTrack();
        }
        break;
      }
    }
  };

  es.onerror = () => {
    setStatus('idle', '连接断开，重连中…');
  };
}

/* ---------------- 设置 ---------------- */

const settingsState = {
  loaded: false,
  settings: null,
  defaults: null,
  javas: [],
};

/** 512M / 4G -> MB */
function memToMb(s) {
  const v = String(s ?? '').trim().toUpperCase();
  if (/^\d+$/.test(v)) return Number(v);
  if (!/^\d+[MG]$/.test(v)) return 0;
  const n = Number(v.slice(0, -1));
  if (!Number.isFinite(n)) return 0;
  return v.endsWith('G') ? n * 1024 : n;
}

function flashSettings(text, kind) {
  const el = $('settingsFoot');
  const base = '设置保存在 ';
  el.innerHTML = `<span class="settings-flash ${kind}">${escapeHtml(text)}</span>${base}<code id="settingsFile">${escapeHtml(settingsState.fileLabel ?? 'settings.json')}</code>`;
  clearTimeout(flashSettings._t);
  flashSettings._t = setTimeout(() => {
    el.innerHTML = `${base}<code>${escapeHtml(settingsState.fileLabel ?? 'settings.json')}</code>`;
  }, 4000);
  toast(text, kind);
}

/** 轻量 toast：保存、复制、清屏这类动作的即时回执 */
/** 应用内表单，替代 Electron renderer 不支持的 window.prompt() */
function askForm({ title, fields = [], okText = '保存', hint = '' }) {
  return new Promise((resolve) => {
    const modal = $('formModal');
    if (!modal) return resolve(null);
    $('formTitle').textContent = title || '填写';
    $('formHint').textContent = hint || '';
    $('formFields').innerHTML = fields.map((f) => `
      <div class="field" style="margin-bottom:12px">
        <label for="form_${escapeHtml(f.id)}">${escapeHtml(f.label || f.id)}</label>
        <div class="field-line">
          <input id="form_${escapeHtml(f.id)}" class="input grow" style="min-width:0"
            type="${escapeHtml(f.type || 'text')}"
            value="${escapeHtml(f.value ?? '')}"
            placeholder="${escapeHtml(f.placeholder || '')}">
          ${f.browse ? `<button type="button" class="btn ghost" data-form-browse="${escapeHtml(f.id)}" data-form-kind="${escapeHtml(f.browse)}">浏览…</button>` : ''}
        </div>
      </div>`).join('');
    $('formFields').querySelectorAll('[data-form-browse]').forEach((b) => {
      b.addEventListener('click', async () => {
        const kind = b.dataset.formKind;
        const p = kind === 'dir'
          ? await globalThis.mcWin?.pickFolder?.()
          : await globalThis.mcWin?.pickFile?.([{ name: 'Java', extensions: ['exe'] }]);
        if (p) $('form_' + b.dataset.formBrowse).value = p.replace(/\\/g, '/');
      });
    });
    $('formSave').textContent = okText;
    modal.hidden = false;

    const done = (value) => {
      modal.hidden = true;
      $('formSave').onclick = null;
      $('formCancel').onclick = null;
      $('formClose').onclick = null;
      resolve(value);
    };
    $('formSave').onclick = () => {
      const out = {};
      for (const f of fields) out[f.id] = $(`form_${f.id}`)?.value ?? '';
      done(out);
    };
    $('formCancel').onclick = () => done(null);
    $('formClose').onclick = () => done(null);
    setTimeout(() => $(`form_${fields[0]?.id}`)?.focus(), 30);
  });
}
window.askForm = askForm;

function toast(text, kind = 'ok') {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2000);
}

function syncMemRange() {
  const max = memToMb($('setMemMax')?.value);
  const range = $('setMemMaxRange');
  const cap = memoryCapMb();
  if (range) {
    range.min = '512';
    range.max = String(Math.max(1024, Math.min(40960, cap)));
    if (max >= 512) range.value = String(Math.min(Number(range.max), max));
  }
  if ($('memMaxLabel')) {
    $('memMaxLabel').textContent = max ? `${Math.round((max / 1024) * 10) / 10}G` : '—';
  }
}

let systemMemory = null;

function memoryCapMb() {
  return Number(systemMemory?.maxMemory) || 40960;
}

function updateSettingsSaveState() {
  const btn = $('settingsSave');
  if (!btn) return;
  const over = memToMb($('setMemMax')?.value) > memoryCapMb();
  btn.disabled = over;
  btn.title = over ? `最大内存不能超过物理内存 80%（${memoryCapMb()}M）` : '';
}

async function loadSystemMemory() {
  try {
    systemMemory = await api('/api/system/memory');
  } catch {
    systemMemory = null;
  }
  renderMemoryStatus();
  syncMemRange();
}

function renderMemoryMeter() {
  const usedEl = $('memMeterUsed');
  const allocEl = $('memMeterAlloc');
  const usedText = $('memUsedText');
  const totalText = $('memTotalText');
  const allocText = $('memAllocText');
  const total = Number(systemMemory?.total) || 0;
  const used = Number(systemMemory?.used) || 0;
  const alloc = memToMb($('setMemMax')?.value);
  const usedPct = total ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  const allocEndPct = total ? Math.min(100, Math.max(0, ((used + alloc) / total) * 100)) : 0;
  const allocWidth = Math.max(0, allocEndPct - usedPct);
  if (usedEl) usedEl.style.width = `${usedPct.toFixed(2)}%`;
  if (allocEl) {
    allocEl.style.left = `${usedPct.toFixed(2)}%`;
    allocEl.style.width = `${allocWidth.toFixed(2)}%`;
  }
  if (usedText) usedText.textContent = total ? `${(used / 1024).toFixed(1)}G` : '—';
  if (totalText) totalText.textContent = total ? `${(total / 1024).toFixed(1)}G` : '—';
  if (allocText) allocText.textContent = alloc ? `${(alloc / 1024).toFixed(1)}G` : '—';
}

function recommendedMemoryMb() {
  if (!systemMemory) return 4096;
  const raw = Math.min(Number(systemMemory.total) * 0.4, 8192);
  return Math.max(512, Math.floor(raw / 512) * 512);
}

async function applyRecommendedMemory() {
  if (!systemMemory) await loadSystemMemory();
  if (!systemMemory) return;
  const mb = recommendedMemoryMb();
  $('setMemMax').value = `${mb}M`;
  if (!$('setMemMin').value) $('setMemMin').value = '512M';
  updateMemTotal();
}

function syncMemoryMode(applyAuto = false) {
  const auto = Boolean($('memModeAuto')?.checked);
  const range = $('setMemMaxRange');
  if (range) range.disabled = auto;
  if (auto && applyAuto && systemMemory) {
    $('setMemMax').value = `${recommendedMemoryMb()}M`;
    if (!$('setMemMin').value) $('setMemMin').value = '512M';
    updateMemTotal();
  }
}

function renderMemoryStatus() {
  const el = $('memSystem');
  if (!el) return;
  const maxMb = memToMb($('setMemMax')?.value);
  const cap = memoryCapMb();
  const overCap = maxMb > cap;
  renderMemoryMeter();
  if (!systemMemory) {
    el.hidden = true;
    el.classList.remove('over');
    el.classList.remove('warn');
    updateSettingsSaveState();
    return;
  }
  const overSoft = maxMb > systemMemory.total * 0.6 && !overCap;
  el.hidden = !(overCap || overSoft);
  el.textContent = overCap
    ? `超过上限 ${Math.round((cap / 1024) * 10) / 10}G`
    : (overSoft ? '超过建议值，可能和系统抢内存' : '');
  el.classList.toggle('over', overCap);
  el.classList.toggle('warn', overSoft);
  updateSettingsSaveState();
}

function updateMemTotal() {
  const min = memToMb($('setMemMin').value);
  const max = memToMb($('setMemMax').value);
  const totalEl = $('memTotal');
  if (totalEl) totalEl.textContent = max ? `${max - min >= 0 ? min + 'M ~ ' : ''}${max}M` : '-';
  syncMemRange();
  renderMemoryStatus();
}
async function checkPath(pathValue, type) {
  if (!pathValue) return null;
  return api('/api/path/check', {
    method: 'POST',
    body: JSON.stringify({ path: pathValue, type }),
  });
}

async function pickGameDir() {
  const p = await globalThis.mcWin?.pickFolder?.();
  if (!p) return;
  $('setGameDir').value = p.replace(/\\/g, '/');
  await validateGameDir(true);
}

async function validateGameDir(showToast = false) {
  const v = $('setGameDir').value.trim();
  const hint = $('gameDirHint');
  if (!v) {
    if (hint) hint.textContent = '游戏目录不能为空';
    return false;
  }
  try {
    const d = await checkPath(v, 'dir');
    const ok = d?.exists && d.dir && d.writable;
    if (hint) {
      hint.textContent = ok
        ? `目录存在且可写：${d.path}`
        : d?.exists ? `目录存在，但没有写权限：${v}` : `目录不存在：${v}`;
      hint.style.color = ok ? '' : '#e06c6c';
    }
    if (!ok && showToast) toast(hint?.textContent || '游戏目录不可用', 'err');
    return ok;
  } catch (e) {
    if (hint) hint.textContent = '目录检查失败：' + e.message;
    return false;
  }
}

async function pickJavaPath() {
  const p = await globalThis.mcWin?.pickFile?.([{ name: 'Java', extensions: ['exe'] }]);
  if (!p) return;
  const data = await checkPath(p, 'file');
  const hint = $('javaPathHint');
  if (!data?.exists || !data.file || !data.readable) {
    if (hint) {
      hint.textContent = '选中的文件不存在或不可读';
      hint.style.color = '#e06c6c';
    }
    toast('Java 文件不可用', 'err');
    return;
  }
  let opt = [...$('setJavaPath').options].find((o) => o.value === p);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    $('setJavaPath').appendChild(opt);
  }
  $('setJavaPath').value = p;
  if (hint) {
    hint.textContent = `已选择：${p}`;
    hint.style.color = '';
  }
}


function renderJavaOptions(javas, selected) {
  const sel = $('setJavaPath');
  const opts = ['<option value="">自动选择（按版本要求扫描）</option>'];

  const seen = new Set();
  for (const j of javas ?? []) {
    if (!j.path || seen.has(j.path)) continue;
    seen.add(j.path);
    const label = `Java ${j.major ?? '?'} — ${j.path}`;
    opts.push(`<option value="${escapeHtml(j.path)}">${escapeHtml(label)}</option>`);
  }

  // 手动填的路径不在扫描结果里（比如刚装的），也要显示出来
  if (selected && !seen.has(selected)) {
    opts.push(`<option value="${escapeHtml(selected)}">手动指定 — ${escapeHtml(selected)}</option>`);
  }

  sel.innerHTML = opts.join('');
  sel.value = selected ?? '';
}

/* ---------------- 游戏内选项 options.txt ---------------- */

const GAME_OPTIONS_DEFAULTS = {
  renderDistance: 12,
  simulationDistance: 12,
  fov: 70,
  gamma: 0.5,
  maxFps: 120,
  graphicsMode: 'fancy',
  particles: 'all',
  entityShadows: true,
  vsync: false,
  fullscreen: false,
  guiScale: 0,
  soundCategory_master: 1,
  soundCategory_music: 1,
  soundCategory_blocks: 1,
  soundCategory_ambient: 1,
  soundCategory_weather: 1,
  lang: 'zh_cn',
  autoJump: true,
  viewBobbing: true,
  narrator: 0,
};

const GAME_OPTIONS_DEFS = [
  { key: 'renderDistance', label: '渲染距离', type: 'number', min: 2, max: 32, step: 1 },
  { key: 'simulationDistance', label: '模拟距离', type: 'number', min: 3, max: 32, step: 1 },
  { key: 'fov', label: '视野 FOV', type: 'number', min: 30, max: 110, step: 1 },
  { key: 'gamma', label: '亮度 gamma', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'maxFps', label: '最大帧率', type: 'number', min: 10, max: 260, step: 10 },
  { key: 'graphicsMode', label: '画面模式', type: 'select', options: [['fancy', 'fancy'], ['fast', 'fast'], ['fabulous', 'fabulous']] },
  { key: 'particles', label: '粒子', type: 'select', options: [['all', 'all'], ['decreased', 'decreased'], ['minimal', 'minimal']] },
  { key: 'entityShadows', label: '实体阴影', type: 'checkbox' },
  { key: 'vsync', label: '垂直同步', type: 'checkbox' },
  { key: 'fullscreen', label: '全屏', type: 'checkbox' },
  { key: 'guiScale', label: 'GUI 缩放', type: 'number', min: 0, max: 4, step: 1 },
  { key: 'autoJump', label: '自动跳跃', type: 'checkbox' },
  { key: 'viewBobbing', label: '视角摇晃', type: 'checkbox' },
  { key: 'narrator', label: '旁白', type: 'select', options: [['0', '关闭'], ['1', '仅系统'], ['2', '全部'], ['3', '仅聊天']] },
  { key: 'lang', label: '语言', type: 'text' },
  { key: 'soundCategory_master', label: '主音量', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'soundCategory_music', label: '音乐', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'soundCategory_blocks', label: '方块音效', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'soundCategory_ambient', label: '环境音', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'soundCategory_weather', label: '天气音', type: 'number', min: 0, max: 1, step: 0.05 },
];

function renderGameOptions(values) {
  const box = $('gameOptionsFields');
  if (!box) return;
  box.innerHTML = GAME_OPTIONS_DEFS.map((d) => {
    const v = values?.[d.key] ?? GAME_OPTIONS_DEFAULTS[d.key];
    if (d.type === 'checkbox') {
      return `<div class="field"><label>${escapeHtml(d.label)}</label>
        <div class="check-line"><input type="checkbox" data-opt="${d.key}" ${v ? 'checked' : ''}></div></div>`;
    }
    if (d.type === 'select') {
      return `<div class="field"><label>${escapeHtml(d.label)}</label>
        <select class="select" data-opt="${d.key}">${d.options.map(([val, label]) =>
          `<option value="${escapeHtml(val)}" ${String(v) === String(val) ? 'selected' : ''}>${escapeHtml(label.trim())}</option>`).join('')}</select></div>`;
    }
    return `<div class="field"><label>${escapeHtml(d.label)}</label>
      <input class="input ${d.type === 'number' ? 'mono' : ''}" data-opt="${d.key}"
        type="${d.type === 'number' ? 'number' : 'text'}"
        ${d.min !== undefined ? `min="${d.min}"` : ''}
        ${d.max !== undefined ? `max="${d.max}"` : ''}
        ${d.step !== undefined ? `step="${d.step}"` : ''}
        value="${escapeHtml(String(v ?? ''))}"></div>`;
  }).join('');
}

function readGameOptionsForm() {
  const out = {};
  $('gameOptionsFields')?.querySelectorAll('[data-opt]').forEach((el) => {
    const key = el.dataset.opt;
    if (el.type === 'checkbox') out[key] = el.checked;
    else if (el.type === 'number') {
      const n = Number(el.value);
      out[key] = Number.isFinite(n) ? n : GAME_OPTIONS_DEFAULTS[key];
    } else out[key] = el.value.trim();
  });
  return out;
}

async function openGameOptions() {
  const versionId = state.selectedVersion;
  if (!versionId) {
    toast('先在版本页选一个实例', 'err');
    return;
  }
  $('gameOptionsModal').hidden = false;
  $('gameOptionsAll').checked = false;
  $('gameOptionsPath').textContent = '正在读取 options.txt…';
  try {
    const data = await api('/api/options?versionId=' + encodeURIComponent(versionId));
    renderGameOptions(data.values);
    $('gameOptionsPath').textContent = data.exists
      ? data.file
      : `${data.file}（还没有 options.txt，保存时创建）`;
  } catch (e) {
    $('gameOptionsPath').textContent = '读取失败：' + e.message;
    renderGameOptions(GAME_OPTIONS_DEFAULTS);
  }
}

async function saveGameOptions() {
  const versionId = state.selectedVersion;
  if (!versionId) return;
  const values = readGameOptionsForm();
  const applyAll = $('gameOptionsAll').checked;
  try {
    const data = await api('/api/options/save', {
      method: 'POST',
      body: JSON.stringify({ versionId, values, applyAll }),
    });
    toast(applyAll ? `已写入 ${data.written.length} 个实例` : '游戏设置已保存');
    $('gameOptionsModal').hidden = true;
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}

async function restoreGameOptions() {
  const versionId = state.selectedVersion;
  if (!versionId) return;
  try {
    await api('/api/options/restore', {
      method: 'POST',
      body: JSON.stringify({ versionId }),
    });
    toast('已恢复上次备份');
    await openGameOptions();
  } catch (e) {
    toast('恢复失败：' + e.message, 'err');
  }
}

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    settingsState.settings = data.settings;
    settingsState.defaults = data.defaults;
    settingsState.javas = data.javas ?? [];
    settingsState.fileLabel = data.file ?? 'settings.json';
    settingsState.loaded = true;
    applySettingsToForm(data.settings);
  } catch (e) {
    $('settingsFoot').innerHTML =
      `<span class="settings-flash err">读取设置失败：${escapeHtml(e.message)}</span>`;
  }
}

function applySettingsToForm(s) {
  $('setGameDir').value = s.gameDir ?? '';
  $('setUsername').value = s.username ?? '';
  $('setMemMin').value = s.memoryMin ?? '';
  $('setMemMax').value = s.memoryMax ?? '';
  const memoryMode = s.memoryMode === 'custom' ? 'custom' : 'auto';
  if ($('memModeAuto')) $('memModeAuto').checked = memoryMode === 'auto';
  if ($('memModeCustom')) $('memModeCustom').checked = memoryMode === 'custom';
  if ($('setMemoryOptimize')) $('setMemoryOptimize').checked = Boolean(s.memoryOptimize);
  if ($('setAutoBackup')) $('setAutoBackup').checked = Boolean(s.autoBackup);
  if ($('setAutoBackupBefore')) $('setAutoBackupBefore').checked = s.autoBackupBeforeLaunch !== false;
  if ($('setAutoBackupAfter')) $('setAutoBackupAfter').checked = s.autoBackupAfterExit !== false;
  if ($('setAutoBackupKeep')) $('setAutoBackupKeep').value = String(s.autoBackupKeep ?? 5);
  if ($('setAutoDiagnostic')) $('setAutoDiagnostic').checked = s.autoDiagnostic !== false;
  if ($('roomMemory')) $('roomMemory').value = String(Number(s.roomMemoryMb) > 0 ? s.roomMemoryMb : 2048);
  syncMemoryMode(false);
  $('setConcurrency').value = s.concurrency ?? 16;
  $('setDownloadSource').value = s.downloadSource ?? (s.preferMirror ? 'bmclapi' : 'auto');
  $('setJavaMode').value = s.javaMode === 'auto' ? 'auto' : 'external';
  $('setIsolated').value = s.isolated ?? 'auto';
  if ($('setUpdateUrl')) $('setUpdateUrl').value = s.updateUrl ?? '';
  if ($('setJvmPreset')) $('setJvmPreset').value = s.jvmPreset ?? 'default';
  $('setExtraJvm').value = s.extraJvm ?? '';
  $('setExtraGame').value = s.extraGame ?? '';
  // 界面透明度：不存时就按 46% 算（等于旧版写死的值，观感不变）
  applyGlassAlpha(Number(s.glassOpacity ?? 42));
  renderJavaOptions(settingsState.javas, s.javaPath ?? '');
  updateMemTotal();
  loadSystemMemory();
  validateGameDir(false);

  // 主页中间那个人物名就是这里的玩家名
  state.username = s.username || 'Player';
  if (typeof updateHome === 'function') updateHome();
}

function readSettingsForm() {
  return {
    gameDir: $('setGameDir').value.trim(),
    username: $('setUsername').value.trim(),
    memoryMin: $('setMemMin').value.trim().toUpperCase(),
    memoryMax: $('setMemMax').value.trim().toUpperCase(),
    memoryMode: $('memModeCustom')?.checked ? 'custom' : 'auto',
    memoryOptimize: Boolean($('setMemoryOptimize')?.checked),
    autoBackup: Boolean($('setAutoBackup')?.checked),
    autoBackupBeforeLaunch: Boolean($('setAutoBackupBefore')?.checked),
    autoBackupAfterExit: Boolean($('setAutoBackupAfter')?.checked),
    autoBackupKeep: Number($('setAutoBackupKeep')?.value || 5),
    autoDiagnostic: Boolean($('setAutoDiagnostic')?.checked),
    concurrency: Number($('setConcurrency').value),
    downloadSource: $('setDownloadSource').value,
    isolated: $('setIsolated').value,
    javaPath: $('setJavaPath').value,
    javaMode: $('setJavaMode').value,
    jvmPreset: $('setJvmPreset')?.value || 'default',
    updateUrl: $('setUpdateUrl')?.value.trim() ?? '',
    extraJvm: $('setExtraJvm').value.trim(),
    extraGame: $('setExtraGame').value.trim(),
    glassOpacity: Number($('setGlass').value),
  };
}

/**
 * 把界面不透明度写进 CSS 变量并更新右侧的百分比。
 *
 * 映射规则（v = 滑块值 30-90）：
 *   --glass-alpha        = v / 100        46 → .46
 *   --glass-strong-alpha = a + .14        46 → .60
 *   --acrylic-base       = a + .12        46 → .58
 *   --op-scale           = a / .46        46 → 1.0
 *
 * 为什么把亚克力底从 .65 降到 .58：
 *   .65 是当初为了压住暖色壁纸的偏色算出来的安全值，但代价是糊得太实，
 *   看起来像“深灰板”，不像亚克力。降低底色的同时把 saturate 再压一档，
 *   偏色靠去色而不是靠堆黑来中和 —— 这才是亚克力该有的透光感。
 *
 * 为什么不直接把各层 alpha 乘同一个倍率：
 *   实测拖到 75% 时 .58 × (75/46) = 0.95，接近纯黑，违背“通透”的初衷。
 *   所以用加法错位 + 上限夹住。
 */
function applyGlassAlpha(pct) {
  const v = Math.min(90, Math.max(30, Number.isFinite(pct) ? pct : 42));
  const clamp = (lo, hi, x) => Math.min(hi, Math.max(lo, x));

  const a = v / 100;
  const strong = Math.min(0.94, a + 0.14);
  const acrylic = clamp(0.36, 0.86, a + 0.12);
  const scale = clamp(0.55, 1.35, a / 0.46);

  const root = document.documentElement.style;
  root.setProperty('--glass-alpha', a.toFixed(3));
  root.setProperty('--glass-strong-alpha', strong.toFixed(3));
  root.setProperty('--acrylic-base', acrylic.toFixed(3));
  root.setProperty('--op-scale', scale.toFixed(3));

  const slider = $('setGlass');
  if (slider && Number(slider.value) !== v) slider.value = String(v);
  const label = $('glassVal');
  if (label) label.textContent = `${v}%`;
}

async function saveSettingsForm() {
  const dirOk = await validateGameDir(false);
  if (!dirOk) {
    flashSettings('游戏目录不存在或没有写权限', 'err');
    return;
  }
  const maxMb = memToMb($('setMemMax').value);
  const cap = memoryCapMb();
  if (maxMb > cap) {
    flashSettings(`最大内存不能超过物理内存 80%（${cap}M）`, 'err');
    $('setMemMax').focus();
    return;
  }
  const btn = $('settingsSave');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const data = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(readSettingsForm()),
    });
    settingsState.settings = data.settings;
    applySettingsToForm(data.settings);

    // 服务端会修正非法值（比如内存写反、并发超范围），要把结果讲清楚
    const notes = data.notes ?? [];
    if (notes.length) {
      btn.textContent = '已保存（有修正）';
      flashSettings('已保存，但有修正：' + notes.join('；'), 'err');
    } else {
      btn.textContent = '已保存';
      flashSettings('已保存', 'ok');
    }

    // 游戏目录可能变了，实例列表要跟着刷新
    await loadInstalled();
  } catch (e) {
    btn.textContent = '保存失败';
    flashSettings('保存失败：' + e.message, 'err');
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = oldText;
    }, 1200);
  }
}

async function rescanJava() {
  const btn = $('rescanJava');
  btn.disabled = true;
  btn.textContent = '扫描中…';
  try {
    const data = await api('/api/settings/javas?force=1');
    settingsState.javas = data.javas ?? [];
    renderJavaOptions(settingsState.javas, $('setJavaPath').value);
    flashSettings(`扫到 ${settingsState.javas.length} 个 Java`, 'ok');
  } catch (e) {
    flashSettings('扫描失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '重新扫描';
  }
}

function resetSettingsForm() {
  const d = settingsState.defaults;
  if (!d) return;
  if (!confirm('把表单恢复成默认值？（还要点「保存」才会生效）')) return;
  applySettingsToForm(d);
  flashSettings('已恢复默认值，点保存生效', 'ok');
}

/** 设置页「测速」：实测各源，把结果写在说明行里，并提示推荐哪个 */
async function testSources() {
  const btn = $('btnTestSource');
  const note = $('sourceNote');
  const original = note.innerHTML;
  btn.disabled = true;
  btn.textContent = '测速中…';
  note.textContent = '正在实测各源（每个源拉 3 个真实文件校验内容）…';

  try {
    const data = await api('/api/sources/measure', { method: 'POST' });
    const lines = (data.results ?? []).map((r) => {
      const speed = r.kbps > 0 ? `<b>${r.kbps} KB/s</b>` : '不可用';
      // 显示「实测下到多少数据 / 用了多久」，比单说一个数字可信
      const detail = r.mb ? `（${r.mb} MB / ${r.seconds}s，${r.ok}/${r.total} 成功）` : '';
      // ok/total 不一致时要标出来，不能让人以为全都下下来了
      const partial = r.ok < r.total ? ` ⚠ ${r.total - r.ok} 个没成功` : '';
      // 内容校验失败是最严重的：说明镜像给的文件是错的
      const warn = r.badContent > 0 ? ` ⚠ ${r.badContent} 个文件内容不对` : '';
      return `${r.name}：${speed}${detail}${partial}${warn}`;
    });
    note.innerHTML =
      `<span class="mono">${lines.join('<br>')}</span>` +
      `<br>推荐：<b>${escapeHtml(data.recommended ?? 'official')}</b>（已清空缓存，下次安装会重新决策）`;
  } catch (e) {
    note.innerHTML = original;
    flashSettings('测速失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '测速';
  }
}

/* ---------------- 账号 ---------------- */

const msLoginState = { polling: false, timer: null };

const TYPE_LABEL = {
  offline: '离线',
  microsoft: '正版',
  yggdrasil: '第三方',
};

/** 左侧卡片 + 主页人物同步当前账号 */
function renderAccountCard() {
  const acc = state.accounts.find((a) => a.key === state.selectedAccount) ?? null;
  const nameEl = $('accountName');
  const typeEl = $('accountType');

  // 账号变了才重新拉皮肤，避免每次刷新都重建画布
  const skinKey = acc ? `${acc.type}:${acc.uuid}` : null;
  if (skinKey !== renderAccountCard._skinKey) {
    renderAccountCard._skinKey = skinKey;
    if (typeof window.refreshSkin === 'function') window.refreshSkin();
  }
  paintAccountAvatar(acc);
  syncAccountActions(acc);

  if (!acc) {
    nameEl.textContent = '未登录';
    typeEl.textContent = '点击添加账号';
    typeEl.className = 'account-type';
    state.username = 'Player';
    $('accountLogout').hidden = true;
  } else {
    nameEl.textContent = acc.name;
    typeEl.className = 'account-type ' + (acc.type === 'microsoft' ? 'ms' : acc.type === 'yggdrasil' ? 'ygg' : '');
    typeEl.textContent = acc.type === 'yggdrasil'
      ? `已登录：${acc.name}（${acc.serverName ?? ''}）`
      : (TYPE_LABEL[acc.type] ?? acc.type);
    state.username = acc.name;
    $('accountLogout').hidden = !(acc.type === 'yggdrasil' || acc.type === 'microsoft');
  }

  if (typeof updateHome === 'function') updateHome();
}

/* ---------------- 头像：皮肤的脸，不是名字首字 ----------------
   和主页同一个思路：从 64x64 皮肤图里裁 8x8 的脸，关掉插值放大，
   保留像素硬边。拿不到皮肤（离线号/没登录/断网）就画官方史蒂夫的脸，
   不退成名字首字母 —— 首字母不像头像。 */
let avatarSeq = 0;
let avatarObjectUrl = null;

function paintAccountAvatar(acc) {
  const canvas = $('accountAvatarCanvas');
  const letter = $('accountAvatarLetter');
  if (!canvas || !letter) return;

  const mySeq = ++avatarSeq;

  const useDefault = () => {
    if (mySeq !== avatarSeq) return;
    if (typeof window.paintDefaultFace === 'function') {
      window.paintDefaultFace(canvas, { width: 64, height: 64 })
        .then(() => {
          if (mySeq !== avatarSeq) return;
          canvas.hidden = false;
          letter.hidden = true;
        })
        .catch(fallbackLetter);
    } else {
      fallbackLetter();
    }
  };

  // 只有连默认贴图都加载失败才退首字母（基本不会发生）
  const fallbackLetter = () => {
    if (mySeq !== avatarSeq) return;
    canvas.hidden = true;
    letter.hidden = false;
    letter.textContent = acc ? acc.name.slice(0, 1) : '?';
  };

  // 未登录：没有账号，直接给默认脸
  if (!acc) {
    useDefault();
    return;
  }

  // 离线账号本来就没有官方皮肤，连请求都省了
  if (acc.type !== 'microsoft' && acc.type !== 'yggdrasil') {
    useDefault();
    return;
  }

  fetch('/api/skin', { cache: 'no-cache' })
    .then((res) => {
      if (res.status === 204 || !res.ok) throw new Error('no skin');
      return res.blob();
    })
    .then((blob) => {
      if (mySeq !== avatarSeq) return;
      const url = URL.createObjectURL(blob);
      if (avatarObjectUrl) URL.revokeObjectURL(avatarObjectUrl);
      avatarObjectUrl = url;

      const img = new Image();
      img.onload = () => {
        if (mySeq !== avatarSeq) return;
        // 和主页一致：裁 8x8 脸 + 帽子层，最近邻放大
        paintFace(canvas, img, { width: 64, height: 64 });
        canvas.hidden = false;
        letter.hidden = true;
      };
      img.onerror = useDefault;
      img.src = url;
    })
    .catch(useDefault);
}

/* 三个图标能点不能点，按当前账号情况定 */
function syncAccountActions(acc) {
  const skinBtn = document.querySelector('[data-acc-act="skin"]');
  const switchBtn = document.querySelector('[data-acc-act="switch"]');
  if (skinBtn) {
    // 离线号没有可换的皮肤，点了也没地方去
    skinBtn.disabled = !acc || acc.type === 'offline';
    skinBtn.title = !acc
      ? '先添加账号'
      : acc.type === 'offline'
        ? '离线账号没有皮肤，换正版或第三方账号才能换'
        : '换装';
  }
  if (switchBtn) {
    // 只有一个号也别锁死，点了就开账号弹窗加一个 —— 灰色按钮等于没做
    switchBtn.disabled = false;
    switchBtn.title = state.accounts.length < 2
      ? '添加第二个账号后才能切换'
      : '切换到下一个账号';
  }

  const editBtn = document.querySelector('[data-acc-act="edit"]');
  if (editBtn) {
    editBtn.disabled = !acc;
    editBtn.title = !acc ? '先添加账号' : '编辑账号';
  }
}

/* ---------------- 换装 ---------------- */

/** 把一张皮肤图的脸画到画布上（预览用，和头像同一套裁剪） */
function drawFace(canvas, img) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
  if (img.naturalHeight >= 64) {
    ctx.drawImage(img, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
  }
}

/** 把当前皮肤画到换装弹窗的预览上 */
function refreshSkinPreview() {
  const canvas = $('skinPreviewCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  fetch('/api/skin', { cache: 'no-cache' })
    .then((res) => {
      if (res.status === 204 || !res.ok) throw new Error('no skin');
      return res.blob();
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        drawFace(canvas, img);
        URL.revokeObjectURL(url);
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    })
    .catch(() => {
      // 没皮肤就画个底色，别留白框
      const ctx2 = canvas.getContext('2d');
      ctx2.fillStyle = 'rgba(255,255,255,0.06)';
      ctx2.fillRect(0, 0, canvas.width, canvas.height);
    });
}

async function openSkinModal() {
  const acc = state.accounts.find((a) => a.key === state.selectedAccount) ?? null;
  if (!acc) return;

  $('skinStatus').textContent = '';
  $('skinPreviewName').textContent = acc.name;
  $('skinModal').hidden = false;
  refreshSkinPreview();

  try {
    const st = await api('/api/accounts/skin/state');
    $('skinReset').disabled = !st.custom;
    $('skinStatus').textContent = st.custom ? '当前用的是本地皮肤' : '';
  } catch {
    $('skinReset').disabled = true;
  }
}

function closeSkinModal() {
  $('skinModal').hidden = true;
  $('skinStatus').textContent = '';
}

/** 选图 → 读成 base64 → 交给服务端存 */
async function onSkinFileChosen(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';   // 允许重复选同一张

  if (file.type !== 'image/png') {
    $('skinStatus').textContent = '只能是 PNG 格式';
    return;
  }
  if (file.size > 900_000) {
    $('skinStatus').textContent = '图片太大（要小于 900 KB）';
    return;
  }

  $('skinStatus').textContent = '正在保存…';
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('读取图片失败'));
      fr.readAsDataURL(file);
    });

    await api('/api/accounts/skin', {
      method: 'POST',
      body: JSON.stringify({ data: dataUrl, model: 'classic' }),
    });

    $('skinStatus').textContent = '换好了';
    $('skinReset').disabled = false;
    refreshSkinPreview();
    paintAccountAvatar(state.accounts.find((a) => a.key === state.selectedAccount) ?? null);
    if (typeof window.refreshSkin === 'function') window.refreshSkin();
  } catch (err) {
    $('skinStatus').textContent = '保存失败：' + err.message;
  }
}

async function resetSkin() {
  $('skinStatus').textContent = '正在恢复…';
  try {
    await api('/api/accounts/skin', { method: 'DELETE' });
    $('skinStatus').textContent = '已恢复官方皮肤';
    $('skinReset').disabled = true;
    refreshSkinPreview();
    paintAccountAvatar(state.accounts.find((a) => a.key === state.selectedAccount) ?? null);
    if (typeof window.refreshSkin === 'function') window.refreshSkin();
  } catch (err) {
    $('skinStatus').textContent = '恢复失败：' + err.message;
  }
}

/* ---------------- 编辑账号 ---------------- */

function openEditModal() {
  const acc = state.accounts.find((a) => a.key === state.selectedAccount) ?? null;
  if (!acc) return;

  $('editName').value = acc.name;
  $('editStatus').textContent = '';

  const offline = acc.type === 'offline';
  $('editSave').disabled = !offline;
  $('editName').disabled = !offline;
  $('editNote').textContent = offline
    ? '离线账号改的就是启动器发给服务端的玩家名，改完立即生效'
    : '正版/第三方账号的名字由认证服务器决定，本地改不了。想换名字要到对应网站改，或者在下面新加一个账号';

  $('editModal').hidden = false;
}

function closeEditModal() {
  $('editModal').hidden = true;
  $('editStatus').textContent = '';
}

async function saveEditName() {
  const name = $('editName').value.trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    $('editStatus').textContent = '名字只能用字母/数字/下划线，最多 16 位';
    return;
  }

  $('editStatus').textContent = '正在保存…';
  try {
    const data = await api('/api/accounts/rename', {
      method: 'POST',
      body: JSON.stringify({ key: state.selectedAccount, name }),
    });
    applyAccounts(data);
    $('editStatus').textContent = '改好了';
    setTimeout(closeEditModal, 600);
  } catch (err) {
    $('editStatus').textContent = '保存失败：' + err.message;
  }
}

/* ---------------- 切换账号 ---------------- */

async function cycleAccount() {
  // 只有一个号时，点它就是去添加第二个，而不是装作没反应
  if (state.accounts.length < 2) {
    $('accountModal').hidden = false;
    renderAccountList();
    loadYggPresets();
    return;
  }
  const idx = state.accounts.findIndex((a) => a.key === state.selectedAccount);
  const next = state.accounts[(idx + 1) % state.accounts.length];
  try {
    await selectAccountByKey(next.key);
  } catch (e) {
    // 切换失败就保持原样，不弹窗打断
  }
}

/** 账号弹窗里的列表 */
function renderAccountList() {
  const box = $('accList');
  if (!state.accounts.length) {
    box.innerHTML = '<div class="empty" style="padding:16px">还没有账号，在下面添加一个</div>';
    return;
  }

  box.innerHTML = state.accounts.map((a) => {
    const subCls = a.type === 'microsoft' ? 'ms' : a.type === 'yggdrasil' ? 'ygg' : '';
    const sub = a.type === 'yggdrasil'
      ? `第三方 · ${escapeHtml(a.serverName ?? a.server ?? '')}`
      : TYPE_LABEL[a.type] ?? a.type;
    return `
      <div class="acc-row ${a.key === state.selectedAccount ? 'active' : ''}" data-key="${escapeHtml(a.key)}">
        <div class="acc-row-avatar">${escapeHtml(a.name.slice(0, 1))}</div>
        <div class="acc-row-main">
          <div class="acc-row-name">${escapeHtml(a.name)}</div>
          <div class="acc-row-sub ${subCls}">${sub}</div>
        </div>
        <button class="btn danger" data-delacc="${escapeHtml(a.key)}">删</button>
      </div>`;
  }).join('');

  box.querySelectorAll('[data-key]').forEach((row) => {
    row.addEventListener('click', async (e) => {
      if (e.target.dataset.delacc) return;
      await selectAccountByKey(row.dataset.key);
    });
  });

  box.querySelectorAll('[data-delacc]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除这个账号？')) return;
      const data = await api('/api/accounts/remove', {
        method: 'POST',
        body: JSON.stringify({ key: btn.dataset.delacc }),
      });
      applyAccounts(data);
    });
  });
}

/** 后端返回的账号数据统一落到 state */
function applyAccounts(data) {
  state.accounts = data.accounts ?? [];
  state.selectedAccount = data.selected ?? null;
  renderAccountCard();
  renderAccountList();
}

async function selectAccountByKey(key) {
  const data = await api('/api/accounts/select', {
    method: 'POST',
    body: JSON.stringify({ key }),
  });
  applyAccounts(data);
}

async function loadAccounts() {
  try {
    const data = await api('/api/accounts');
    applyAccounts(data);
  } catch (e) {
    $('accountName').textContent = '未登录';
    $('accountType').textContent = '读取失败，点击重试';
  }
}

/** 切换账号弹窗里的三种模式 */
function setAccountMode(mode) {
  document.querySelectorAll('.acc-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  document.querySelectorAll('.acc-pane').forEach((p) => {
    p.classList.toggle('active', p.id === 'pane-' + mode);
  });
}

/* ---- 微软正版 ---- */

function stopMsPolling() {
  msLoginState.polling = false;
  if (msLoginState.timer) {
    clearTimeout(msLoginState.timer);
    msLoginState.timer = null;
  }
}

function resetMsPane() {
  stopMsPolling();
  $('msIdle').hidden = false;
  $('msPending').hidden = true;
  $('msCode').textContent = '--------';
  $('msStatus').textContent = '等待你在浏览器完成授权…';
}

async function startMsLogin() {
  $('msStart').disabled = true;
  $('msStatus').textContent = '正在申请验证码…';
  try {
    const data = await api('/api/accounts/ms/start', { method: 'POST', body: '{}' });
    $('msIdle').hidden = true;
    $('msPending').hidden = false;
    $('msCode').textContent = data.userCode;
    $('msLink').textContent = data.verificationUri;
    $('msLink').href = data.verificationUri;
    $('msStatus').textContent = '等待你在浏览器完成授权…';

    msLoginState.polling = true;
    pollMsToken(data.interval ?? 5, data.expiresIn ?? 900);
  } catch (e) {
    $('msStatus').textContent = '申请失败：' + e.message;
    $('msStart').disabled = false;
  }
}

/** 按微软要求的 interval 轮询；pending 就继续等 */
async function pollMsToken(intervalSec, expiresInSec) {
  const deadline = Date.now() + expiresInSec * 1000;

  const tick = async () => {
    if (!msLoginState.polling) return;
    if (Date.now() > deadline) {
      stopMsPolling();
      $('msStatus').textContent = '验证码超时，请重新点登录';
      $('msStart').disabled = false;
      return;
    }

    try {
      const data = await api('/api/accounts/ms/poll', { method: 'POST', body: '{}' });
      if (data.done) {
        stopMsPolling();
        applyAccounts(data);
        resetMsPane();
        $('msStart').disabled = false;
        $('accountModal').hidden = true;
        return;
      }
      $('msStatus').textContent = '等待你在浏览器完成授权…';
    } catch (e) {
      stopMsPolling();
      $('msStatus').textContent = '登录失败：' + e.message;
      $('msStart').disabled = false;
      return;
    }

    msLoginState.timer = setTimeout(tick, intervalSec * 1000);
  };

  msLoginState.timer = setTimeout(tick, intervalSec * 1000);
}

/* ---- 第三方 ---- */

let yggPending = null;
let yggCreds = null; // 只在登录流程内存里保留，用于刷新角色列表；不落盘

function hideYggProfiles() {
  yggPending = null;
  yggCreds = null;
  const box = $('yggProfiles');
  if (box) box.hidden = true;
  if ($('yggProfileList')) $('yggProfileList').innerHTML = '';
}

function yggLastKey(server) {
  return `ygg-last:${server}`;
}

function readLastYggProfile(server) {
  try { return JSON.parse(localStorage.getItem(yggLastKey(server)) || 'null'); } catch { return null; }
}

function rememberYggProfile(server, profile) {
  try { localStorage.setItem(yggLastKey(server), JSON.stringify({ id: profile.id, name: profile.name })); } catch { /* 无痕模式 */ }
}

function safeAvatarUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

async function enrichYggProfiles(server, profiles) {
  return Promise.all((profiles ?? []).map(async (p) => {
    try {
      const r = await api('/api/accounts/yggdrasil/profile-skin', {
        method: 'POST',
        body: JSON.stringify({ server, uuid: p.id }),
      });
      return { ...p, skinUrl: safeAvatarUrl(r?.skinUrl) };
    } catch {
      return { ...p, skinUrl: '' };
    }
  }));
}

function renderYggProfiles(pending, profiles, selectedProfileId) {
  yggPending = { pending, profiles };
  const box = $('yggProfiles');
  const list = $('yggProfileList');
  if (!box || !list) return;
  if (!profiles?.length) {
    list.innerHTML = '<div class="field-note">角色列表为空。请先去皮肤站创建角色，再点「刷新角色列表」。</div>';
    box.hidden = false;
    return;
  }
  const last = readLastYggProfile(pending.server);
  const ordered = [...profiles].sort((a, b) => {
    const ai = last && a.id === last.id ? 0 : 1;
    const bi = last && b.id === last.id ? 0 : 1;
    return ai - bi;
  });
  const defaultId = last?.id || selectedProfileId || ordered[0]?.id;
  list.innerHTML = ordered.map((p) => {
    const skin = safeAvatarUrl(p.skinUrl);
    const initial = escapeHtml((p.name || '?').slice(0, 1));
    return `<button type="button" data-profile="${escapeHtml(p.id)}" class="${p.id === defaultId ? 'default' : ''}">
      ${skin
        ? `<canvas class="ygg-avatar ygg-head loading" width="32" height="32" data-skin="${escapeHtml(skin)}" data-letter="${initial}"></canvas>`
        : `<span class="ygg-avatar">${initial}</span>`}
      <span class="ygg-profile-name">${escapeHtml(p.name)}</span>
      ${p.id === last?.id ? '<span class="ygg-profile-last">上次</span>' : ''}
    </button>`;
  }).join('');
  box.hidden = false;
  paintYggHeads(list);
  list.querySelectorAll('button[data-profile]').forEach((b) => {
    b.addEventListener('click', () => selectYggProfile(b.dataset.profile, b));
  });
}

/** 先列名字，头像异步补；不要因为等皮肤把列表卡住 */
function renderYggProfilesWithSkins(pending, profiles, selectedProfileId) {
  renderYggProfiles(pending, profiles, selectedProfileId);
  if (!profiles?.length) return;
  $('yggMeta').textContent = `正在加载头像…（${profiles.length} 个角色）`;
  enrichYggProfiles(pending.server, profiles).then((enriched) => {
    if (!yggPending || yggPending.pending !== pending) return;
    yggPending = { pending, profiles: enriched };
    renderYggProfiles(pending, enriched, selectedProfileId);
    $('yggMeta').textContent = `认证成功，选择角色（${enriched.length}）`;
  }).catch(() => {
    $('yggMeta').textContent = '头像加载失败，仍可直接选择角色';
  });
}

/** 只画头部：8x8 脸 + 帽子层，最近邻放大；失败换回首字 */
function paintYggHeads(list) {
  list.querySelectorAll('canvas.ygg-head[data-skin]').forEach((canvas) => {
    const skin = canvas.dataset.skin;
    const letter = canvas.dataset.letter || '?';
    const img = new Image();
    img.onload = () => {
      if (typeof window.paintFace === 'function') {
        window.paintFace(canvas, img, { width: 32, height: 32 });
        canvas.classList.remove('loading');
      }
    };
    img.onerror = () => {
      const span = document.createElement('span');
      span.className = 'ygg-avatar';
      span.textContent = letter;
      canvas.replaceWith(span);
    };
    img.src = skin;
  });
}

async function selectYggProfile(profileId, btn) {
  if (!yggPending) return;
  const box = $('yggProfiles');
  const buttons = box ? box.querySelectorAll('button') : [];
  buttons.forEach((b) => { b.disabled = true; });
  $('yggMeta').textContent = '正在保存角色…';
  try {
    const data = await api('/api/accounts/yggdrasil/select', {
      method: 'POST',
      body: JSON.stringify({ pending: yggPending.pending, profileId }),
    });
    const profile = yggPending.profiles.find((p) => p.id === profileId);
    if (profile) rememberYggProfile(yggPending.pending.server, profile);
    applyAccounts(data);
    hideYggProfiles();
    $('accountModal').hidden = true;
  } catch (e) {
    $('yggMeta').textContent = '✗ ' + e.message;
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function refreshYggProfiles() {
  if (!yggPending) return;
  const btn = $('yggProfilesRefresh');
  if (btn) btn.disabled = true;
  $('yggMeta').textContent = '刷新角色列表中…';
  try {
    // 优先用 accounts.json 里保存的 token 恢复，不再要密码
    const current = state.accounts.find((a) => a.key === state.selectedAccount);
    if (current?.type === 'yggdrasil') {
      const data = await api('/api/accounts/yggdrasil/resume', {
        method: 'POST',
        body: JSON.stringify({ key: current.key }),
      });
      if (data.pending) {
        applyAccounts(data);
        const profiles = data.profiles ?? [];
        yggPending = { pending: data.pending, profiles };
        $('yggServer').value = data.pending.server;
        renderYggProfilesWithSkins(data.pending, profiles, data.selectedProfileId);
        $('yggMeta').textContent = `已恢复登录：${profiles.length} 个角色`;
        return;
      }
    }
    let pending = yggPending.pending;
    let profiles = yggPending.profiles;
    if (yggCreds) {
      // 登录流程内的内存凭据，用于新建角色/换皮肤后刷新
      const data = await api('/api/accounts/yggdrasil/login', {
        method: 'POST',
        body: JSON.stringify(yggCreds),
      });
      if (data.pending) {
        pending = data.pending;
        profiles = data.profiles ?? [];
      }
    }
    if (profiles.length === 1) {
      yggPending = { pending, profiles };
      await selectYggProfile(profiles[0].id);
      return;
    }
    renderYggProfilesWithSkins(pending, profiles, pending.selectedProfileId);
    $('yggMeta').textContent = `已刷新：${profiles.length} 个角色`;
  } catch (e) {
    $('yggMeta').textContent = '✗ ' + e.message;
    await loadAccounts();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function resumeYggIfPossible() {
  const acc = state.accounts.find((a) => a.key === state.selectedAccount);
  if (!acc || acc.type !== 'yggdrasil') return;
  setAccountMode('ygg');
  $('yggServer').value = acc.server ?? '';
  $('yggUser').value = acc.name ?? '';
  $('yggMeta').textContent = '正在恢复登录…';
  try {
    const data = await api('/api/accounts/yggdrasil/resume', {
      method: 'POST',
      body: JSON.stringify({ key: acc.key }),
    });
    applyAccounts(data);
    if (!data.pending) return;
    yggCreds = null;
    const profiles = data.profiles ?? [];
    yggPending = { pending: data.pending, profiles };
    renderYggProfilesWithSkins(data.pending, profiles, data.selectedProfileId);
    $('yggMeta').textContent = profiles.length
      ? `已恢复登录，选择角色（${profiles.length}）`
      : '角色列表为空。请先去皮肤站创建角色。';
  } catch (e) {
    $('yggMeta').textContent = '登录已失效，请重新输入密码：' + e.message;
    await loadAccounts();
  }
}

let yggStartupResumeKey = null;
async function resumeYggOnStartup() {
  const acc = state.accounts.find((a) => a.key === state.selectedAccount);
  if (!acc || acc.type !== 'yggdrasil' || yggStartupResumeKey === acc.key) return;
  yggStartupResumeKey = acc.key;
  try {
    const data = await api('/api/accounts/yggdrasil/resume', {
      method: 'POST',
      body: JSON.stringify({ key: acc.key }),
    });
    applyAccounts(data);
  } catch {
    // 失效时服务端已经清凭据；重新读一次状态
    await loadAccounts();
  }
}


/** 拉预设 + 已保存站点；force 用于拖入/改名后立即刷新 */
let yggPresetsLoaded = false;
async function loadYggPresets(force = false) {
  if (yggPresetsLoaded && !force) return;
  try {
    const presetData = await api('/api/accounts/yggdrasil/presets').catch(() => ({ presets: [] }));
    let sitesError = '';
    const siteData = await api('/api/accounts/yggdrasil/sites').catch((e) => {
      sitesError = e.message;
      return { sites: [] };
    });
    const sel = $('yggPreset');
    if (!sel) return;
    if (sitesError) $('yggMeta').textContent = '站点列表读取失败：' + sitesError;
    const current = $('yggServer')?.value || '';
    sel.innerHTML = '<option value="">选择认证服务器…</option>';
    const savedUrls = new Set((siteData.sites ?? []).map((s) => s.url));
    const seen = new Set();
    for (const p of presetData.presets ?? []) {
      if (savedUrls.has(p.url)) continue;
      const opt = document.createElement('option');
      opt.value = p.url;
      opt.textContent = p.name;
      opt.title = p.note ?? '';
      sel.appendChild(opt);
      seen.add(p.url);
    }
    for (const s of siteData.sites ?? []) {
      if (seen.has(s.url)) continue;
      const opt = document.createElement('option');
      opt.value = s.url;
      opt.textContent = s.name;
      opt.title = s.url;
      opt.dataset.siteId = s.id;
      sel.appendChild(opt);
      seen.add(s.url);
    }
    // 末尾留一个选项，提醒还能填自己的
    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = '自定义（自建服务器）…';
    sel.appendChild(custom);
    if (current) sel.value = current;
    yggPresetsLoaded = true;
  } catch {
    /* 拉不到就用手填，不阻止登录 */
  }
}

function selectedYggSite() {
  const opt = $('yggPreset')?.selectedOptions?.[0];
  return opt?.dataset?.siteId ? { id: opt.dataset.siteId, name: opt.textContent, url: opt.value } : null;
}

/** 选预设 -> 填地址；选自定义 -> 清空让人自己填 */
function onYggPresetChange() {
  const sel = $('yggPreset');
  const v = sel.value;
  if (!v) return;
  if (v === '__custom__') {
    $('yggServer').value = '';
    $('yggServer').focus();
    $('yggMeta').textContent = '';
    return;
  }
  $('yggServer').value = v;
  $('yggMeta').textContent = '';
  // 选中预设后直接探一次，让人马上知道这个站活着
  checkYggServer();
}

async function renameYggSite() {
  const site = selectedYggSite();
  if (!site) {
    $('yggMeta').textContent = '先选中一个自己保存的站点';
    return;
  }
  const r = await askForm({
    title: '站点改名',
    fields: [{ id: 'name', label: '名字', value: site.name }],
    okText: '保存',
  });
  if (!r?.name?.trim()) return;
  try {
    await api('/api/accounts/yggdrasil/sites', {
      method: 'PATCH',
      body: JSON.stringify({ id: site.id, name: r.name.trim() }),
    });
    await loadYggPresets(true);
    $('yggMeta').textContent = '✓ 已改名';
  } catch (e) {
    $('yggMeta').textContent = '✗ ' + e.message;
  }
}

async function deleteYggSite() {
  const site = selectedYggSite();
  if (!site) {
    $('yggMeta').textContent = '先选中一个自己保存的站点';
    return;
  }
  const r = await askForm({
    title: '删除站点',
    hint: `删除「${site.name}」？只删列表，不影响已经登录的账号。`,
    fields: [],
    okText: '删除',
  });
  if (!r) return;
  try {
    await api('/api/accounts/yggdrasil/sites', {
      method: 'DELETE',
      body: JSON.stringify({ id: site.id }),
    });
    await loadYggPresets(true);
    $('yggMeta').textContent = '已删除站点';
  } catch (e) {
    $('yggMeta').textContent = '✗ ' + e.message;
  }
}

/** 拖入的 text/html、带空白/引号的纯文本都先抠出一个地址 */
function extractYggAddress(raw) {
  let s = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\u200B/g, '').trim();
  if (!s) return '';
  // HTML 优先取 href / data-*，别误取图片和脚本里的地址
  if (/<[a-z][\s\S]*>/i.test(s)) {
    try {
      const doc = new DOMParser().parseFromString(s, 'text/html');
      const nodes = doc.querySelectorAll('a[href], [data-url], [data-href], [data-clipboard-text]');
      for (const n of nodes) {
        const v = n.getAttribute('href') || n.getAttribute('data-url') ||
          n.getAttribute('data-href') || n.getAttribute('data-clipboard-text');
        if (v && /^https?:\/\//i.test(v.trim())) return v.trim();
      }
      s = doc.body?.textContent || s;
    } catch { /* 继续按纯文本处理 */ }
  }
  const m = s.match(/https?:\/\/[^\s"'<>]+/i);
  if (m) s = m[0];
  s = s.replace(/^[<"'“”‘’]+|[>"'“”‘’]+$/g, '').replace(/[),.;]+$/g, '').trim();
  s = s.replace(/&amp;/g, '&');
  return s;
}

/** 拖入、剪贴板、手填共用：识别地址、验证、保存、切到登录 */
async function handleYggAddress(text) {
  const raw = String(text ?? '');
  const address = extractYggAddress(raw);
  if (!address) {
    $('accountModal').hidden = false;
    setAccountMode('ygg');
    $('yggMeta').textContent = `这不是外置登录地址：收到：${raw.replace(/\s+/g, ' ').slice(0, 120)}`;
    return false;
  }
  $('accountModal').hidden = false;
  setAccountMode('ygg');
  $('yggMeta').textContent = '识别站点中…';
  try {
    const data = await api('/api/accounts/yggdrasil/sites', {
      method: 'POST',
      body: JSON.stringify({ url: address }),
    });
    await loadYggPresets(true);
    $('yggPreset').value = data.site.url;
    $('yggServer').value = data.site.url;
    $('yggMeta').textContent = `✓ ${data.site.name} · 已加入站点列表`;
    $('yggPass').value = '';
    $('yggUser').focus();
    return true;
  } catch (e) {
    $('yggMeta').textContent = '✗ ' + e.message;
    return false;
  }
}

async function pasteYggAddress() {
  let text = '';
  let html = '';
  try {
    const clip = await globalThis.mcWin?.readClipboard?.();
    if (clip && typeof clip === 'object') {
      text = clip.text || '';
      html = clip.html || '';
    } else if (typeof clip === 'string') {
      text = clip;
    }
  } catch { /* fall through */ }
  if (!text && !html) {
    try { text = await navigator.clipboard.readText(); } catch { /* ignore */ }
  }
  const raw = text || html;
  if (!raw) {
    $('yggMeta').textContent = '剪贴板里没有可识别的地址';
    return;
  }
  await handleYggAddress(raw);
}

async function checkYggServer() {
  const server = $('yggServer').value.trim();
  if (!server) return;
  $('yggMeta').textContent = '检测中…';
  try {
    const m = await api('/api/accounts/yggdrasil/meta', {
      method: 'POST',
      body: JSON.stringify({ server }),
    });
    // 把实现名也带上：不同实现（如 Yggdrasil Connect）行为有差异，出问题时好看出来
    const impl = m.implementation ? ` · ${m.implementation}` : '';
    $('yggMeta').textContent = `✓ ${m.serverName}${impl}`;
    if (m.registerUrl) $('yggNote').innerHTML =
      `密码只发给你填的这个认证服务器，启动器不保存密码。没账号可以先去 <a href="${m.registerUrl}" target="_blank" rel="noopener">注册</a>`;
  } catch (e) {
    $('yggMeta').textContent = '✗ ' + e.message;
  }
}

async function doYggLogin() {
  const server = $('yggServer').value.trim();
  const username = $('yggUser').value.trim();
  const password = $('yggPass').value;

  if (!server || !username || !password) {
    $('yggMeta').textContent = '服务器、用户名、密码都要填';
    return;
  }

  const btn = $('yggLogin');
  btn.disabled = true;
  $('yggMeta').textContent = '登录中…';

  try {
    const data = await api('/api/accounts/yggdrasil/login', {
      method: 'POST',
      body: JSON.stringify({ server, username, password }),
    });
    // 密码用完立刻从界面清掉，不留在 DOM 里；只在当前登录流程的内存里留一份给“刷新”
    $('yggPass').value = '';
    if (data.pending) {
      yggCreds = { server, username, password };
      const profiles = data.profiles ?? [];
      if (profiles.length === 0) {
        $('yggMeta').textContent = '角色列表为空。请先去皮肤站创建角色，再点「刷新角色列表」。';
        renderYggProfiles(data.pending, profiles, data.selectedProfileId);
        return;
      }
      if (profiles.length === 1) {
        yggPending = { pending: data.pending, profiles };
        $('yggMeta').textContent = '只有一个角色，正在登录…';
        await selectYggProfile(profiles[0].id);
        return;
      }
      $('yggMeta').textContent = '认证成功，选择角色';
      renderYggProfilesWithSkins(data.pending, profiles, data.selectedProfileId);
      return;
    }
    // 兼容旧服务端
    applyAccounts(data);
    $('yggMeta').textContent = '✓ 登录成功';
    $('accountModal').hidden = true;
  } catch (e) {
    $('yggMeta').textContent = '✗ ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---- 离纾 ---- */

async function addOfflineAccount() {
  const name = $('offlineName').value.trim();
  if (!name) {
    $('offlineName').focus();
    return;
  }
  const btn = $('offlineAdd');
  btn.disabled = true;
  try {
    const data = await api('/api/accounts/offline', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    applyAccounts(data);
    $('offlineName').value = '';
    $('accountModal').hidden = true;
  } catch (e) {
    alert('添加失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 初始化 ---------------- */

document.querySelectorAll('.nav-item').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $('panel-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'saves') loadSavesPage();
  });
});

$('savesPageInstance')?.addEventListener('change', loadSavesPage);
$('savesPageRefresh')?.addEventListener('click', loadSavesPage);
$('savesPageBackupAll')?.addEventListener('click', backupAllSavesPage);
$('savesPageImport')?.addEventListener('click', () => {
  if ($('saveImportChoiceModal')) $('saveImportChoiceModal').hidden = false;
});
$('saveImportChoiceCancel')?.addEventListener('click', () => {
  if ($('saveImportChoiceModal')) $('saveImportChoiceModal').hidden = true;
});
$('saveImportFolder')?.addEventListener('click', () => chooseSaveImport('folder'));
$('saveImportZip')?.addEventListener('click', () => chooseSaveImport('zip'));

/** 切到指定面板（供「管理内容」等按钮调用） */
function switchTab(name) {
  const tab = document.querySelector(`.nav-item[data-tab="${name}"]`);
  if (tab) tab.click();
}

$('launchBtn').addEventListener('click', () => {
  if (state.selectedVersion) doLaunch(state.selectedVersion);
});

$('savesClose')?.addEventListener('click', () => { $('savesModal').hidden = true; });
$('savesBackupAll')?.addEventListener('click', backupAllSaves);
$('savesOpenFolder')?.addEventListener('click', () => openSavesFolder('saves'));
$('savesOpenBackups')?.addEventListener('click', () => openSavesFolder('backups'));

$('exportClose')?.addEventListener('click', () => { $('exportModal').hidden = true; });
$('exportFormat')?.addEventListener('change', syncExportFormat);
$('exportPickDest')?.addEventListener('click', pickExportDestination);
$('exportStart')?.addEventListener('click', startExport);
$('exportCopyPath')?.addEventListener('click', copyExportPath);
$('exportOpenFolder')?.addEventListener('click', openExportFolder);

$('launchRetryBtn')?.addEventListener('click', () => {
  const v = state.launchRetryVersion || state.selectedVersion;
  if (!v) return;
  $('launchRetryBtn').hidden = true;
  doLaunch(v);
});

$('preflightClose')?.addEventListener('click', () => { $('preflightModal').hidden = true; });
$('preflightAssistant')?.addEventListener('click', () => {
  const v = state.launchRetryVersion || state.selectedVersion || '';
  const missing = state.preflightMissing || [];
  const message = state.preflightMessage || '';
  const preflight = state.preflightStructured || null;
  $('preflightModal').hidden = true;
  document.querySelector('.nav-item[data-tab="home"]')?.click();
  setTimeout(() => window.assistantExplainPreflight?.({ versionId: v, missing, message, preflight }), 80);
});
$('preflightRetry')?.addEventListener('click', () => {
  const v = state.launchRetryVersion || state.selectedVersion;
  $('preflightModal').hidden = true;
  if (v) doLaunch(v);
});
$('preflightOpenLog')?.addEventListener('click', () => {
  $('preflightModal').hidden = true;
  $('openLogBtn')?.click();
});

$('manageContent').addEventListener('click', () => {
  if (state.selectedVersion) openContent(state.selectedVersion);
});

$('refreshInstalled').addEventListener('click', loadInstalled);
$('updatePackBtn')?.addEventListener('click', openPackUpdate);
$('packUpdateStart')?.addEventListener('click', applyPackUpdate);
$('packUpdateClose')?.addEventListener('click', () => { $('packUpdateModal').hidden = true; });
$('packUpdateCancel')?.addEventListener('click', () => { $('packUpdateModal').hidden = true; });
$('packUpdateConfig')?.addEventListener('change', () => {
  if ($('packUpdateNotice')) {
    $('packUpdateNotice').textContent = $('packUpdateConfig').checked
      ? '存档没动；配置已按勾选覆盖'
      : '存档和配置没动';
  }
});
$('trashBtn')?.addEventListener('click', openTrashModal);
$('trashClose')?.addEventListener('click', () => { $('trashModal').hidden = true; });
$('refreshRemote').addEventListener('click', loadRemote);
$('clearLogs').addEventListener('click', () => {
  $('logBox').textContent = '';
  toast('日志已清空', 'ok');
});
$('loadLatestLog')?.addEventListener('click', loadLatestLog);

// 版本页：搜索 / 加载器筛选 / 右键菜单
$('verSearch')?.addEventListener('input', renderInstalled);
$('verLoader')?.addEventListener('change', renderInstalled);
$('tbLogs')?.addEventListener('click', () => {
  setTimeout(async () => {
    await syncLogs();
    if (!$('logBox')?.textContent.trim()) await loadLatestLog();
  }, 50);
});
$('openLogBtn')?.addEventListener('click', () => {
  document.querySelector('.nav-item[data-tab="settings"]')?.click();
  setTimeout(() => {
    $('logsGroup')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    syncLogs();
  }, 120);
});
$('lastFailure')?.addEventListener('click', () => $('openLogBtn')?.click());
document.addEventListener('click', (e) => {
  const menu = $('verMenu');
  if (menu && !menu.hidden && !menu.contains(e.target)) menu.hidden = true;
});
window.addEventListener('blur', () => {
  const menu = $('verMenu');
  if (menu) menu.hidden = true;
});

// 版本列表：显式滚轮滚动。Chromium 在无边框窗口里偶尔不把 wheel
// 落到这个 flex 滚动容器上，拖滚动条/方向键却正常 —— 这里自己接管。
(function initVersionWheel() {
  const box = $('installedList');
  if (!box) return;
  box.addEventListener('wheel', (ev) => {
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) return;
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? box.clientHeight : 1;
    const delta = ev.deltaY * unit;
    if (!delta) return;
    if ((box.scrollTop <= 0 && delta < 0) || (box.scrollTop >= max && delta > 0)) return;
    ev.preventDefault();
    box.scrollTop = Math.max(0, Math.min(max, box.scrollTop + delta));
  }, { passive: false });
})();

/* ---- 加载器安装 ---- */
$('loaderType')?.addEventListener('change', loadFabricLoaders);
$('fabricGame').addEventListener('change', loadFabricLoaders);
$('fabricInstall').addEventListener('click', doFabricInstall);

$('storeSearch').addEventListener('click', () => doStoreSearch(0));
$('storeQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') doStoreSearch(0); });
$('storeType').addEventListener('change', () => {
  // 换类型后从第一页重新搜
  if (state.storeHits.length) doStoreSearch(0);
});
$('storeSort').addEventListener('change', () => {
  if (state.storeHits.length) doStoreSearch(0);
});
$('storePrev').addEventListener('click', () => {
  doStoreSearch(Math.max(0, state.storePage.offset - state.storePage.limit));
});
$('storeNext').addEventListener('click', () => {
  doStoreSearch(state.storePage.offset + state.storePage.limit);
});
$('storeInstance').addEventListener('change', () => {
  state.storeInstance = $('storeInstance').value;
  updateStoreHint();
});

$('packSearch').addEventListener('click', () => doPackSearch(0));
$('packQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPackSearch(0); });

/* ---------------- 来源多选（全部 / Modrinth / CurseForge） ----------------
   联动规则（就是搭档要的那三条）：
     1) 勾「全部」→ 下面两项全勾上
     2) 下面两项都勾上 → 「全部」自动也勾上
     3) 取消「全部」→ 下面两项全取消（否则会出现「全部没勾但里面勾着」的矛盾态）
   另外至少留一个来源：全取消时把「全部」勾回来。
   一个都不选等于没法搜，不如直接回退到全部。 */
function initPackSourcePicker() {
  const box = $('packSourceBox');
  const btn = $('packSourceBtn');
  const panel = $('packSourcePanel');
  const label = $('packSourceLabel');
  const cbAll = $('packSrcAll');
  const cbMr = $('packSrcModrinth');
  const cbCf = $('packSrcCurseforge');
  if (!box || !btn || !panel || !cbAll || !cbMr || !cbCf) return;

  const open = (want) => {
    panel.hidden = !want;
    btn.setAttribute('aria-expanded', String(want));
  };

  /* 根据两个具体来源反推「全部」和按钮上的文字。
     这个函数是唯一写 checkbox 状态的地方，避免多处各写一遍造成不一致。 */
  const syncFromItems = () => {
    const items = [];
    if (cbMr.checked) items.push('modrinth');
    if (cbCf.checked) items.push('curseforge');

    cbAll.checked = items.length === 2;
    state.packSources = items;
    // 记住最近一次「只选一个」的来源：取消全部时回到它，
    // 这样点下去一定看得到变化，不会出现「点了没反应」。
    if (items.length === 1) state.lastPackSingle = items[0];

    label.textContent = items.length === 2
      ? '全部'
      : items.length === 1
        ? (items[0] === 'modrinth' ? 'Modrinth' : 'CurseForge')
        : '未选择';
    btn.title = items.length === 2
      ? '从 Modrinth 和 CurseForge 一起搜'
      : items.length === 1
        ? `只从 ${label.textContent} 搜`
        : '至少选一个来源';
  };

  /* 应用一次选择变更。
     一个来源都不选就没法搜，所以归零时回退到最近一次的单来源选择。
     注意这里是有意的「可见变化」：取消全部 → 只剩一个来源，
     而不是把上一次的勾原样恢复（那会让人觉得按钮坏了）。 */
  const applySelection = (next) => {
    cbMr.checked = next.includes('modrinth');
    cbCf.checked = next.includes('curseforge');

    if (!cbMr.checked && !cbCf.checked) {
      const back = state.lastPackSingle === 'curseforge' ? 'curseforge' : 'modrinth';
      cbMr.checked = back === 'modrinth';
      cbCf.checked = back === 'curseforge';
    }

    syncFromItems();
    return true;
  };

  // 点「全部」：勾上就全勾；取消就只剩最近用过的那一个来源
  cbAll.addEventListener('change', () => {
    applySelection(cbAll.checked ? ['modrinth', 'curseforge'] : []);
    doPackSearch(0);
  });

  const onItem = () => {
    const next = [];
    if (cbMr.checked) next.push('modrinth');
    if (cbCf.checked) next.push('curseforge');
    if (applySelection(next)) doPackSearch(0);
  };
  cbMr.addEventListener('change', onItem);
  cbCf.addEventListener('change', onItem);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    open(panel.hidden);
  });

  // 点外面 / 按 Esc 关面板，这是下拉的肌肉记忆
  document.addEventListener('click', (e) => {
    if (!box.contains(e.target)) open(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      open(false);
      btn.focus();
    }
  });

  syncFromItems();
}

initPackSourcePicker();

$('packSort').addEventListener('change', () => {
  if (state.packs.length) doPackSearch(0);
});
$('packPrev').addEventListener('click', () => {
  doPackSearch(Math.max(0, state.packPage.offset - state.packPage.limit));
});
$('packNext').addEventListener('click', () => {
  doPackSearch(state.packPage.offset + state.packPage.limit);
});

/* ---- 追更 ---- */
$('trackAdd').addEventListener('click', addTrack);
$('trackQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTrack(); });
$('trackCheck').addEventListener('click', checkTrackNow);

$('closeContent').addEventListener('click', () => { $('contentPanel').hidden = true; });
$('checkModUpdates').addEventListener('click', checkModUpdates);
$('modUpdatePreviewClose')?.addEventListener('click', () => { $('modUpdatePreviewModal').hidden = true; window.__pendingModUpdates = null; });
$('modUpdatePreviewCancel')?.addEventListener('click', () => { $('modUpdatePreviewModal').hidden = true; window.__pendingModUpdates = null; });
$('modUpdatePreviewConfirm')?.addEventListener('click', () => {
  const picked = window.__pendingModUpdates || [];
  $('modUpdatePreviewModal').hidden = true;
  window.__pendingModUpdates = null;
  applyModUpdates(picked);
});
$('exportContentPack').addEventListener('click', () => {
  openExport(state.contentVersion || state.selectedVersion);
});
$('settingsSave').addEventListener('click', saveSettingsForm);
$('settingsReset').addEventListener('click', resetSettingsForm);
$('browseGameDir').addEventListener('click', pickGameDir);
$('browseJava').addEventListener('click', pickJavaPath);
$('setGameDir').addEventListener('blur', () => validateGameDir(false));
$('openGameOptions').addEventListener('click', openGameOptions);
$('gameOptionsClose').addEventListener('click', () => { $('gameOptionsModal').hidden = true; });
$('gameOptionsCancel').addEventListener('click', () => { $('gameOptionsModal').hidden = true; });
$('gameOptionsSave').addEventListener('click', saveGameOptions);
$('gameOptionsRestore').addEventListener('click', restoreGameOptions);
$('gameOptionsReset').addEventListener('click', () => {
  renderGameOptions(GAME_OPTIONS_DEFAULTS);
  $('gameOptionsAll').checked = false;
});
$('rescanJava').addEventListener('click', rescanJava);
$('btnTestSource').addEventListener('click', testSources);
$('setMemMin').addEventListener('input', updateMemTotal);
$('setMemMax').addEventListener('input', updateMemTotal);
$('memRecommend')?.addEventListener('click', applyRecommendedMemory);
document.querySelectorAll('input[name="memMode"]').forEach((el) => {
  el.addEventListener('change', () => syncMemoryMode(true));
});
$('setMemMaxRange').addEventListener('pointerdown', loadSystemMemory);
$('setMemMaxRange').addEventListener('input', (e) => {
  $('setMemMax').value = `${e.target.value}M`;
  updateMemTotal();
});
// 透明度滑块：拖的时候实时预览，不用等点保存。
$('setGlass').addEventListener('input', (e) => applyGlassAlpha(Number(e.target.value)));

// 下载/安装页收起与展开。
// 收起后底部那条还在，点它就能把整页叫回来（PCL 的习惯）。
$('installCollapse').addEventListener('click', () => setInstallCollapsed(true));

// 取消：先问一句，别让人手滑点掉跑到一半的下载。
// 确认后再调接口；真正的收尾交给 SSE 的 install-cancelled 事件，
// 不在这里直接改界面状态 —— 否则服务端还没停、界面已经说“已取消”了。
$('installCancel').addEventListener('click', async (ev) => {
  ev.stopPropagation();
  const btn = ev.currentTarget;
  if (btn.disabled || btn.classList.contains('busy')) return;

  const ok = window.confirm('确定取消这次下载吗？\n已下载完的文件会保留，下次接着下。');
  if (!ok) return;

  btn.classList.add('busy');
  btn.disabled = true;
  try {
    await api('/api/install/cancel', { method: 'POST' });
  } catch (e) {
    btn.classList.remove('busy');
    btn.disabled = false;
    // 409 = 已经没在跑了（可能刚好装完），当成正常情况处理
    if (!/没有进行中的任务|已经在收尾/.test(e.message)) {
      updateProgress({ stage: 'error', message: `取消失败：${e.message}` });
    }
  }
});
$('progressBar').addEventListener('click', (e) => {
  // 只处理“收起状态下点底部条”；有条在跑才展开
  if (!installCollapsed) return;
  if (!e.target.closest('.progress-bar')) return;
  setInstallCollapsed(false);
});
$('modalClose').addEventListener('click', () => { $('versionModal').hidden = true; });
$('versionModal').addEventListener('click', (e) => {
  if (e.target === $('versionModal')) $('versionModal').hidden = true;
});

/* ---- 账号 ---- */
$('accountCard').addEventListener('click', (e) => {
  // 点的是图标条里的按钮，别再弹账号弹窗
  if (e.target.closest && e.target.closest('.acc-act')) return;
  if (e.target.closest && e.target.closest('#accountLogout')) return;
  $('accountModal').hidden = false;
  hideYggProfiles();
  $('yggPass').value = '';
  renderAccountList();
  // 预设列表按需拉，拉不到也不影响手填地址
  loadYggPresets();
  resumeYggIfPossible();
});

async function logoutCurrentAccount() {
  const acc = state.accounts.find((a) => a.key === state.selectedAccount);
  if (!acc) return;
  try {
    const data = await api('/api/accounts/logout', {
      method: 'POST',
      body: JSON.stringify({ key: acc.key }),
    });
    applyAccounts(data);
    toast('已退出登录');
  } catch (e) {
    toast('退出失败：' + e.message, 'err');
  }
}

$('accountLogout').addEventListener('click', (e) => {
  e.stopPropagation();
  logoutCurrentAccount();
});

/* 图标条上的三个按钮：换装 / 编辑 / 切换 */
document.querySelectorAll('.acc-act').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    const act = btn.dataset.accAct;
    if (act === 'skin') openSkinModal();
    else if (act === 'edit') openEditModal();
    else if (act === 'switch') cycleAccount();
  });
});
$('accountClose').addEventListener('click', () => {
  stopMsPolling();
  resetMsPane();
  $('msStart').disabled = false;
  $('accountModal').hidden = true;
});
$('accountModal').addEventListener('click', (e) => {
  if (e.target === $('accountModal')) {
    stopMsPolling();
    resetMsPane();
    $('msStart').disabled = false;
    $('accountModal').hidden = true;
  }
});

document.querySelectorAll('.acc-tab').forEach((t) => {
  t.addEventListener('click', () => setAccountMode(t.dataset.mode));
});

/* ---- 换装弹窗 ---- */
$('skinClose').addEventListener('click', closeSkinModal);
$('skinModal').addEventListener('click', (e) => {
  if (e.target === $('skinModal')) closeSkinModal();
});
$('skinPick').addEventListener('click', () => $('skinFile').click());
$('skinFile').addEventListener('change', onSkinFileChosen);
$('skinReset').addEventListener('click', resetSkin);

/* ---- 编辑账号弹窗 ---- */
$('editClose').addEventListener('click', closeEditModal);
$('editModal').addEventListener('click', (e) => {
  if (e.target === $('editModal')) closeEditModal();
});
$('editSave').addEventListener('click', saveEditName);
$('editName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveEditName(); });

$('offlineAdd').addEventListener('click', addOfflineAccount);
$('offlineName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addOfflineAccount(); });

$('yggPreset').addEventListener('change', onYggPresetChange);

$('msStart').addEventListener('click', startMsLogin);
$('msOpen').addEventListener('click', () => {
  const url = $('msLink').href;
  window.open(url, '_blank', 'noopener');
});
$('msCancel').addEventListener('click', async () => {
  stopMsPolling();
  resetMsPane();
  $('msStart').disabled = false;
});

$('yggCheck').addEventListener('click', checkYggServer);
$('yggPaste').addEventListener('click', pasteYggAddress);
$('yggRename').addEventListener('click', renameYggSite);
$('yggDelete').addEventListener('click', deleteYggSite);
$('yggProfilesRefresh').addEventListener('click', refreshYggProfiles);
$('yggLogin').addEventListener('click', doYggLogin);
$('yggPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doYggLogin(); });

/* 拖入 URL：和手填/剪贴板共用 handleYggAddress */
/* 文件拖入：整合包 zip / mrpack / mod jar */
let pendingImport = null;

async function performImport(path, versionId, backupSaves = false) {
  try {
    const data = await api('/api/import/file', {
      method: 'POST',
      body: JSON.stringify({ path, versionId, backupSaves }),
    });
    if (data.started) {
      showProgress(true);
      updateProgress({ stage: 'modpack', message: '正在导入本地整合包…' });
      resetCancelButton();
      toast('开始导入整合包');
      refreshStatus();
      return;
    }
    if (data.kind === 'mod') {
      toast('已加入 mods');
      return;
    }
    const mods = data.mods || [];
    const skipped = (data.skipped || []).map((x) => typeof x === 'string' ? x : `${x.name}（${x.reason}）`);
    const modLine = mods.length
      ? `${mods.slice(0, 5).join('、')}${mods.length > 5 ? `等 ${mods.length} 个` : ''}`
      : '无';
    toast(`导入完成：Mod ${modLine}；覆盖 ${data.overwrites ?? 0} 个文件；跳过 ${skipped.length ? skipped.join('、') : '无'}`);
    await loadInstalled();
    state.selectedVersion = data.versionId;
    renderInstalled();
    updateHome();
  } catch (e) {
    toast('导入失败：' + e.message, 'err');
  }
}

function showImportPreview(preview, path, versionId) {
  pendingImport = { path, versionId };
  const text = $('importConfirmText');
  if (text) text.textContent = `这个包会覆盖 ${preview.overwrites || 0} 个已有文件，新增 ${preview.additions || 0} 个`;
  const list = $('importConflictList');
  if (list) {
    const paths = preview.overwritePaths || [];
    const more = (preview.overwrites || 0) > paths.length ? `\n等 ${preview.overwrites} 个` : '';
    list.textContent = paths.length ? `${paths.join('\n')}${more}` : '没有同名文件';
  }
  if ($('importConfirmModal')) $('importConfirmModal').hidden = false;
}

async function importDroppedFile(file) {
  let p = '';
  try { p = globalThis.mcWin?.getPathForFile?.(file) || file?.path || ''; } catch { /* ignore */ }
  if (!p) {
    toast('拿不到这个文件的本地路径，换从文件夹拖一次', 'err');
    return;
  }
  const ext = (p.split('.').pop() || '').toLowerCase();
  if (!['zip', 'mrpack', 'jar'].includes(ext)) {
    toast('只支持整合包 zip / mrpack 或单个 jar', 'err');
    return;
  }
  if (ext === 'jar') {
    await performImport(p, state.selectedVersion, false);
    return;
  }
  if (ext === 'zip' && $('panel-saves')?.classList.contains('active')) {
    await previewSaveImportPath(p);
    return;
  }
  try {
    const preview = await api('/api/import/preview', {
      method: 'POST',
      body: JSON.stringify({ path: p, versionId: state.selectedVersion }),
    });
    if (preview.kind === 'modpack') {
      await performImport(p, state.selectedVersion, false);
      return;
    }
    showImportPreview(preview, p, state.selectedVersion);
  } catch (e) {
    toast('读取整合包失败：' + e.message, 'err');
  }
}

function closeImportConfirm() {
  pendingImport = null;
  if ($('importConfirmModal')) $('importConfirmModal').hidden = true;
}

$('importCancel')?.addEventListener('click', closeImportConfirm);
$('importCancelX')?.addEventListener('click', closeImportConfirm);
$('importBackup')?.addEventListener('click', async () => {
  if (!pendingImport) return;
  const job = pendingImport;
  closeImportConfirm();
  await performImport(job.path, job.versionId, true);
});
$('importDirect')?.addEventListener('click', async () => {
  if (!pendingImport) return;
  const job = pendingImport;
  closeImportConfirm();
  await performImport(job.path, job.versionId, false);
});

window.addEventListener('dragover', (e) => {
  const types = e.dataTransfer?.types ?? [];
  if (types.includes('text/uri-list') || types.includes('text/plain') ||
      types.includes('text/html') || types.includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    // 只处理第一个文件；文件夹里的多个文件不批量猜
    importDroppedFile(files[0]);
    return;
  }
  const uri = e.dataTransfer?.getData('text/uri-list');
  const plain = e.dataTransfer?.getData('text/plain');
  const html = e.dataTransfer?.getData('text/html');
  const text = uri || plain || html;
  if (!text) {
    // 文件/其它东西不是外置登录地址，明确说，不要静默吞掉
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      $('accountModal').hidden = false;
      setAccountMode('ygg');
      $('yggMeta').textContent = '这不是外置登录地址：请拖入皮肤站的 API 地址';
    }
    return;
  }
  e.preventDefault();
  handleYggAddress(text);
});

/* Ctrl+V：输入框里正常粘贴，窗口空白处粘贴地址才走识别 */
document.addEventListener('paste', (e) => {
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  const text = e.clipboardData?.getData('text/plain') || e.clipboardData?.getData('text/html');
  if (text) handleYggAddress(text);
});


connectEvents();
api('/api/state').then((s) => setAppVersion(s.version)).catch(() => {});
loadTrack();
// 注意：loadInstalled / loadSettings / loadAccounts 不要在这里单独调，
// 它们在下面的启动进度里各发起一次（结果同时喂给进度条和页面）。
// 两处都调会重复请求，还会让进度多走一遍。


/* ---------------- 启动数据预加载 ----------------
   启动动画已经搬到独立透明窗口（electron/main.js 的 createSplashWindow），
   主页面里再没有任何 splash 元素，所以这里不需要"退场"逻辑。

   但三个请求还是要在这里发起：主窗口虽然不显示，也在后台加载，
   等动画播完揭开时就是有内容的一片，而不是空页。
*/
loadInstalled();
loadSettings();
loadAccounts().then(() => resumeYggOnStartup());


/* ---------------- 磨砂背景 ----------------
   浏览器拿不到系统壁纸，靠服务端 /api/wallpaper 读当前主题壁纸。
   取不到（204 / 报错）就标成 fallback，用暗色渐变顶上，
   这时视觉效果和原来的纯色主题接近，不会露出空白。
*/
function initWallpaper() {
  const el = document.getElementById('wallpaper');
  if (!el) return;

  const probe = new Image();
  probe.onload = () => {
    el.style.setProperty('--wallpaper', 'url("/api/wallpaper")');
    el.classList.remove('fallback');
  };
  probe.onerror = () => {
    el.classList.add('fallback');
  };
  probe.src = '/api/wallpaper?t=' + Date.now();
}

initWallpaper();


/* ---------------- 窗口控制（只在 Electron 壳里生效） ----------------
   浏览器里 window.mcWin 不存在，这段直接退回并把按钮藏起来，
   否则网页版会多出三个点不动的按钮。
*/
function initWindowControls() {
  const api = window.mcWin;
  const ctrls = $('winCtrls');

  if (!api) {
    document.body.classList.add('no-shell');
    return;
  }

  /* 窗口背面是 DWM 亚克力时，关掉自己画的那张假壁纸。
     真模糊已经由系统做在窗口背面了，再贴一张模糊壁纸图
     等于把它盖住 —— 看起来又在看图片，不在看桌面。 */
  if (api.material && api.material !== 'none') {
    document.body.classList.add(api.material);
  }

  if (ctrls) ctrls.hidden = false;

  $('winMin')?.addEventListener('click', () => api.minimize());
  $('winClose')?.addEventListener('click', () => api.close());

  const maxBtn = $('winMax');
  if (maxBtn) {
    maxBtn.hidden = false;
    maxBtn.addEventListener('click', () => api.toggleMax());
  }

  // 无边框窗口的标题栏双击也能最大化/还原（和普通 Windows 窗口一致）
  document.querySelector('.topbar')?.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('button')) return;
    api.toggleMax();
  });

  // 最大化时去掉外圈留白，否则边上会露出一圈透明缝
  const applyMax = (isMax) => {
    document.body.classList.toggle('maximized', isMax);
    const btn = $('winMax');
    if (btn) {
      btn.title = isMax ? '还原' : '最大化';
      btn.setAttribute('aria-label', btn.title);
    }
  };

  api.onMaximizedChange(applyMax);
  Promise.resolve(api.isMaximized()).then(applyMax);
}

initWindowControls();


/* 设置页打开时每秒读取系统内存，实时更新占用条。 */
let memoryTickerBusy = false;
setInterval(async () => {
  const panel = document.getElementById('panel-settings');
  if (!panel?.classList.contains('active') || memoryTickerBusy) return;
  memoryTickerBusy = true;
  try { await loadSystemMemory(); } finally { memoryTickerBusy = false; }
}, 1000);