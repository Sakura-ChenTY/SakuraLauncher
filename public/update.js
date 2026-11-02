/* 更新检查：启动 5 秒后静默一次；只提示，不自动安装 */
(function () {
  let current = null;

  function $(id) { return document.getElementById(id); }

  function openUrl(url) {
    if (!url) return;
    if (window.mcWin?.openExternal) window.mcWin.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  }

  function render() {
    const badge = $('updateBadge');
    const notice = $('updateNotice');
    const skipped = localStorage.getItem('skipUpdateVersion') || '';
    if (!current || current.version === skipped) {
      if (badge) badge.hidden = true;
      if (notice) notice.hidden = true;
      return;
    }
    if (badge) {
      badge.hidden = false;
      if ($('updateBadgeText')) $('updateBadgeText').textContent = `有新版本 ${current.version}`;
    }
    if (notice) {
      notice.hidden = false;
      if ($('updateVersion')) $('updateVersion').textContent = current.version;
      if ($('updateNotes')) $('updateNotes').textContent = current.notes || '';
    }
  }

  function setStatus(text, bad) {
    const el = $('updateStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = bad ? '#e06c6c' : '';
  }

  async function checkForUpdate(manual = false) {
    const btn = $('updateCheck');
    if (manual && btn) {
      btn.disabled = true;
      btn.textContent = '检查中…';
      setStatus('正在检查更新…');
    }
    try {
      const r = await fetch('/api/update/check', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      current = data?.update || null;
      render();
      if (manual) {
        if (current) {
          setStatus(`发现新版本 ${current.version}`);
          if (typeof toast === 'function') toast(`发现新版本 ${current.version}`);
        } else if (data?.error) {
          setStatus(`检查失败：${data.error}`, true);
          if (typeof toast === 'function') toast(`检查更新失败：${data.error}`, 'err');
        } else {
          setStatus(`已是最新版本 ${data?.current ?? ''}`);
          if (typeof toast === 'function') toast(`已是最新版本 ${data?.current ?? ''}`);
        }
      }
    } catch (e) {
      if (manual) setStatus(`检查失败：${e.message}`, true);
      // 启动时静默忽略，不影响启动
    } finally {
      if (manual && btn) {
        btn.disabled = false;
        btn.textContent = '立即检查更新';
      }
    }
  }

  function download() {
    if (current?.url) openUrl(current.url);
  }

  async function installOneClick() {
    if (!current?.url) return;
    const btn = $('updateInstall');
    if (btn) { btn.disabled = true; btn.textContent = '正在准备差分更新…'; }
    if ($('updateNotes')) $('updateNotes').textContent = '正在用 electron-updater 检查并下载差异…';
    try {
      let feedUrl = current.feedUrl || '';
      if (!feedUrl) {
        try { feedUrl = new URL(current.url).href.replace(/\/[^/]+$/, '/'); } catch { feedUrl = ''; }
      }
      const ok = await window.mcWin?.autoUpdate?.({ feedUrl });
      if (!ok) throw new Error('electron-updater 不可用');
      // 主进程会在下载完成后静默安装并退出
    } catch (e) {
      if ($('updateNotes')) $('updateNotes').textContent = `一键更新失败：${e.message}，改用浏览器下载`;
      download();
      if (btn) { btn.disabled = false; btn.textContent = '一键更新'; }
    }
  }

  function skip() {
    if (!current?.version) return;
    localStorage.setItem('skipUpdateVersion', current.version);
    render();
    if (typeof toast === 'function') toast(`已跳过 ${current.version}`);
  }

  function init() {
    $('updateBadgeBtn')?.addEventListener('click', download);
    $('updateDownload')?.addEventListener('click', download);
    $('updateInstall')?.addEventListener('click', installOneClick);
    $('updateSkip')?.addEventListener('click', skip);
    $('updateCheck')?.addEventListener('click', () => checkForUpdate(true));
    $('updateCheckTop')?.addEventListener('click', () => checkForUpdate(true));
    window.mcWin?.onUpdateProgress?.((p) => {
      const pct = Number(p?.percent || 0);
      const mb = (n) => (Number(n || 0) / 1024 / 1024).toFixed(1);
      const text = `electron-updater 下载中 ${pct.toFixed(1)}% · ${mb(p.transferred)}/${mb(p.total)} MB`;
      if ($('updateNotes')) $('updateNotes').textContent = text;
      setStatus(text);
    });
    setTimeout(() => checkForUpdate(false), 5000);
  }

  window.checkForUpdate = checkForUpdate;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
