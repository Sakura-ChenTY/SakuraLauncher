/**
 * 首次安装引导：只做配置，不碰游戏实例/存档。
 * 目标：新电脑第一次打开时能选 Java、游戏目录、账号、第一个版本，然后进联机页。
 */
(() => {
  const overlay = document.getElementById('onboarding');
  if (!overlay) return;

  const body = document.getElementById('obBody');
  const dots = document.getElementById('obDots');
  const back = document.getElementById('obBack');
  const skip = document.getElementById('obSkip');
  const next = document.getElementById('obNext');

  const steps = ['welcome', 'java', 'dir', 'account', 'version', 'done'];
  let i = 0;
  let javas = [];
  let settings = null;
  let account = null;
  let msTimer = null;
  let msCode = null;
  let releases = [];
  let selectedRelease = '';
  let pendingInstall = '';
  let chosenJava = '';
  let chosenDir = '';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function show() {
    overlay.hidden = false;
    render();
  }

  function hide() {
    overlay.hidden = true;
    if (msTimer) { clearInterval(msTimer); msTimer = null; }
  }

  function setDots() {
    dots.innerHTML = steps.map((_, n) => `<span class="${n === i ? 'on' : ''}"></span>`).join('');
  }

  function canSkip() {
    return i !== 0 && i !== steps.length - 1;
  }

  function render() {
    setDots();
    back.disabled = i === 0;
    back.textContent = i === 0 ? '上一步' : '上一步';
    skip.style.display = canSkip() ? '' : 'none';
    next.textContent = i === steps.length - 1 ? '完成' : (i === 0 ? '开始设置' : '下一步');

    if (i === 0) {
      body.innerHTML = `
        <h2>第一次用 Sakura Launcher</h2>
        <p>先花一分钟把 Java、游戏目录、账号和第一个版本弄好。以后启动、装 mod、联机都在一个地方。</p>
        <p class="hint">不会上传你的账号、token 或游戏文件；只写本地配置。</p>
        <p><button class="btn ghost" id="obReset">重置启动器配置，重新走首次启动</button></p>`;
      document.getElementById('obReset')?.addEventListener('click', renderReset);
    } else if (i === 1) {
      const options = javas.map((j) => `<option value="${esc(j.path)}">Java ${esc(j.version || '?')} · ${esc(j.path)}</option>`).join('');
      body.innerHTML = `
        <h2>选择 Java</h2>
        <p>启动器会先自动扫描。找不到也可以先跳过，之后在设置里补。</p>
        <div class="ob-field">
          <label>检测到的 Java</label>
          <select class="select" id="obJava" style="width:100%">
            ${options || '<option value="">没有检测到 Java</option>'}
          </select>
          <div class="ob-choice">
            <button class="btn ghost" id="obJavaScan">重新检测</button>
            <span class="hint" id="obJavaHint">${javas.length ? '' : '没装 Java 也能先完成引导，但启动游戏前必须装。'}</span>
          </div>
        </div>
        ${javas.length ? '' : '<p class="ob-warn">没有检测到 Java。可去 Adoptium 下载 Temurin 21，装完回来点“重新检测”。</p>'}`;
      const sel = document.getElementById('obJava');
      if (settings?.javaPath && javas.some((j) => j.path === settings.javaPath)) sel.value = settings.javaPath;
      chosenJava = sel.value || chosenJava;
      sel.addEventListener('change', () => { chosenJava = sel.value; });
      document.getElementById('obJavaScan')?.addEventListener('click', scanJava);
      if (!javas.length) {
        const a = document.createElement('button');
        a.className = 'btn ghost';
        a.textContent = '打开 Adoptium 下载页';
        a.addEventListener('click', () => window.mcWin?.openExternal?.('https://adoptium.net/temurin/releases/?version=21'));
        body.querySelector('.ob-warn')?.after(a);
      }
    } else if (i === 2) {
      body.innerHTML = `
        <h2>游戏目录</h2>
        <p>实例、mod、存档都会放这里。建议放 D 盘，别塞 C 盘。</p>
        <div class="ob-field">
          <label>游戏目录</label>
          <div class="ob-choice">
            <input class="input mono grow" id="obDir" placeholder="例如 D:/PCL/.minecraft" value="${esc(chosenDir || settings?.gameDir || 'D:\\PCL\\.minecraft')}">
            <button class="btn ghost" id="obDirBrowse">浏览…</button>
          </div>
          <div class="ob-choice">
            <button class="btn ghost" id="obDirDefault">用 D:\\PCL\\.minecraft</button>
            <span class="hint">选完点「下一步」才校验并创建目录。</span>
          </div>
        </div>`;
      const dirInput = document.getElementById('obDir');
      chosenDir = dirInput.value;
      dirInput.addEventListener('input', () => { chosenDir = dirInput.value; });
      document.getElementById('obDirDefault')?.addEventListener('click', () => {
        document.getElementById('obDir').value = 'D:\\PCL\\.minecraft';
        chosenDir = 'D:\\PCL\\.minecraft';
      });
      document.getElementById('obDirBrowse')?.addEventListener('click', async () => {
        const p = await globalThis.mcWin?.pickFolder?.();
        if (!p) return;
        document.getElementById('obDir').value = p;
        chosenDir = p;
      });
    } else if (i === 3) {
      body.innerHTML = `
        <h2>登录</h2>
        <p>正版账号走微软设备码；离线账号只写本地用户名，不需要密码。</p>
        <div class="ob-field">
          <label>离线用户名</label>
          <div class="ob-choice">
            <input class="input grow" id="obName" maxlength="16" placeholder="例如 Sakura" value="${esc(account?.name || '')}">
            <button class="btn" id="obOffline">创建离线账号</button>
          </div>
        </div>
        <div class="ob-field">
          <label>正版微软账号</label>
          <div class="ob-choice">
            <button class="btn ghost" id="obMs">使用微软账号登录</button>
            <span class="hint" id="obMsHint">${account?.type === 'ms' ? `已登录 ${esc(account.name)}` : '会打开浏览器，输入设备码'}</span>
          </div>
          <div class="hint" id="obMsCode"></div>
        </div>`;
      document.getElementById('obOffline')?.addEventListener('click', createOffline);
      document.getElementById('obMs')?.addEventListener('click', startMs);
    } else if (i === 4) {
      const opts = releases.map((r) => `<option value="${esc(r.id)}">${esc(r.id)}${r.installed ? '（已安装）' : ''}</option>`).join('');
      body.innerHTML = `
        <h2>第一个版本</h2>
        <p>选一个版本装。装完就能启动；也可以先跳过，去版本页再装。</p>
        <div class="ob-field">
          <label>Minecraft 版本</label>
          <select class="select" id="obVersion" style="width:100%">
            ${opts || '<option value="">读取版本列表失败</option>'}
          </select>
          <div class="hint" id="obVersionHint">安装会在后台继续，不会卡住引导。</div>
        </div>`;
      const sel = document.getElementById('obVersion');
      if (selectedRelease) sel.value = selectedRelease;
      sel.addEventListener('change', () => { selectedRelease = sel.value; });
    } else {
      const java = chosenJava || settings?.javaPath || '';
      body.innerHTML = `
        <h2>可以开始了</h2>
        <p>配置已保存到本机。接下来可以进联机页找朋友，或者先去版本页装整合包。</p>
        <p class="hint">Java：${esc(java || '未设置（启动前需要补）')}<br>
        游戏目录：${esc(chosenDir || settings?.gameDir || '默认')}<br>
        账号：${esc(account?.name || '未登录')}</p>`;
    }
  }

  async function scanJava() {
    const hint = document.getElementById('obJavaHint');
    if (hint) hint.textContent = '正在扫描…';
    try {
      const r = await api('/api/settings/javas?force=1');
      javas = r.javas || [];
      render();
    } catch (e) {
      if (hint) hint.textContent = '扫描失败：' + e.message;
    }
  }

  async function refreshReleases() {
    try {
      const r = await api('/api/remote');
      releases = (r.releases || []).slice(0, 12);
      if (!selectedRelease || !releases.some((x) => x.id === selectedRelease)) {
        selectedRelease = releases[0]?.id || '';
      }
    } catch {
      /* 版本列表失败不阻塞引导 */
    }
  }

  async function createOffline() {
    const name = document.getElementById('obName')?.value.trim();
    if (!name) return toast('先填离线用户名', 'err');
    try {
      const r = await api('/api/accounts/offline', { method: 'POST', body: JSON.stringify({ name }) });
      account = (r.accounts || []).find((a) => a.key === r.selected) || { name, type: 'offline' };
      toast(`离线账号 ${name} 已创建`, 'ok');
      render();
    } catch (e) {
      toast('创建失败：' + e.message, 'err');
    }
  }

  async function startMs() {
    const hint = document.getElementById('obMsHint');
    const code = document.getElementById('obMsCode');
    if (hint) hint.textContent = '正在申请设备码…';
    try {
      const r = await api('/api/accounts/ms/start', { method: 'POST', body: '{}' });
      msCode = r;
      if (code) {
        code.innerHTML = `打开 <a href="#" id="obMsLink">${esc(r.verificationUri)}</a>，输入 <b>${esc(r.userCode)}</b>`;
        document.getElementById('obMsLink')?.addEventListener('click', (e) => {
          e.preventDefault();
          window.mcWin?.openExternal?.(r.verificationUri);
        });
      }
      if (window.mcWin?.openExternal) window.mcWin.openExternal(r.verificationUri);
      if (hint) hint.textContent = '等待浏览器里完成登录…';
      if (msTimer) clearInterval(msTimer);
      const interval = Math.max(3000, Number(r.interval || 5) * 1000);
      msTimer = setInterval(async () => {
        try {
          const p = await api('/api/accounts/ms/poll', { method: 'POST', body: '{}' });
          if (p.done) {
            clearInterval(msTimer); msTimer = null;
            account = (p.accounts || []).find((a) => a.key === p.selected) || { name: p.selected, type: 'ms' };
            if (hint) hint.textContent = `已登录 ${account.name}`;
            if (code) code.textContent = '';
            toast(`微软账号已登录：${account.name}`, 'ok');
            render();
          }
        } catch (e) {
          if (hint) hint.textContent = '登录轮询失败：' + e.message;
        }
      }, interval);
    } catch (e) {
      if (hint) hint.textContent = '申请设备码失败：' + e.message;
    }
  }

  async function saveConfig() {
    const patch = {};
    if (chosenJava) patch.javaPath = chosenJava;
    if (chosenDir) patch.gameDir = chosenDir;
    if (Object.keys(patch).length) {
      await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
      settings = { ...(settings || {}), ...patch };
    }
  }

  function goDone() {
    const sel = document.getElementById('obVersion');
    if (sel?.value) selectedRelease = sel.value;
    const item = releases.find((r) => r.id === selectedRelease);
    pendingInstall = item && !item.installed ? selectedRelease : '';
    i = 5;
    render();
  }

  async function finish(goOnline, installVersion = true) {
    try {
      await saveConfig();
      if (installVersion && pendingInstall) {
        await api('/api/install', { method: 'POST', body: JSON.stringify({ versionId: pendingInstall }) });
        toast(`已开始安装 ${pendingInstall}`, 'ok');
      }
      pendingInstall = '';
      await api('/api/onboarding/complete', { method: 'POST', body: '{}' });
      // 设置页/标题栏的游戏目录是渲染时缓存的，保存后重新拉一次
      if (typeof loadInstalled === 'function') await loadInstalled();
      if (typeof loadSettings === 'function') await loadSettings();
      if (typeof loadAccounts === 'function') await loadAccounts();
      hide();
      if (goOnline) {
        document.querySelector('.nav-item[data-tab="online"]')?.click();
      } else {
        document.querySelector('.nav-item[data-tab="home"]')?.click();
      }
    } catch (e) {
      toast('保存引导失败：' + e.message, 'err');
    }
  }

  function renderReset() {
    next.style.display = 'none';
    skip.style.display = 'none';
    back.style.display = 'none';
    body.innerHTML = `
      <h2>重置启动器配置</h2>
      <p>这会把启动器当成第一次打开。游戏实例、存档、mod、整合包都不会动。</p>
      <label class="hint"><input type="checkbox" id="obResetSettings" checked disabled> 清理 settings.json 和引导标记（必选）</label><br>
      <label class="hint"><input type="checkbox" id="obResetAccounts"> 同时退出本机账号（accounts.json）</label><br>
      <label class="hint"><input type="checkbox" id="obResetSecrets"> 同时清除联机登录态（SakuraFrp/OpenFrp/自定义 token）</label>
      <p class="hint">清联机登录态后要重新识别或填 token；不清也能重新跑引导。</p>
      <div class="ob-choice">
        <button class="btn" id="obResetConfirm">确认重置</button>
        <button class="btn ghost" id="obResetCancel">取消</button>
      </div>
      <p class="hint" id="obResetStatus"></p>`;
    document.getElementById('obResetCancel')?.addEventListener('click', () => {
      next.style.display = '';
      skip.style.display = '';
      back.style.display = '';
      render();
    });
    document.getElementById('obResetConfirm')?.addEventListener('click', async () => {
      const status = document.getElementById('obResetStatus');
      const btn = document.getElementById('obResetConfirm');
      if (btn) btn.disabled = true;
      if (status) status.textContent = '正在清理…';
      try {
        const r = await api('/api/onboarding/reset', {
          method: 'POST',
          body: JSON.stringify({
            settings: true,
            accounts: document.getElementById('obResetAccounts')?.checked || false,
            secrets: document.getElementById('obResetSecrets')?.checked || false,
          }),
        });
        body.innerHTML = `
          <h2>已重置</h2>
          <p>启动器配置已清理。请关闭这个窗口，再重新打开 SakuraLauncher。</p>
          <p class="hint">没有删除游戏实例、存档、mod 或整合包。</p>`;
        if (r?.cleared) {
          body.querySelector('p.hint').textContent +=
            ` 清理结果：settings=${r.cleared.settings ? '是' : '否'}，accounts=${r.cleared.accounts ? '是' : '否'}，secrets=${r.cleared.secrets ? '是' : '否'}`;
        }
      } catch (e) {
        if (status) status.textContent = '重置失败：' + e.message;
        if (btn) btn.disabled = false;
      }
    });
  }

  async function resetAll() {
    // 兼容旧入口；实际重置走 renderReset 的显式按钮
    renderReset();
  }

  async function boot() {
    try {
      const st = await api('/api/onboarding/state');
      if (!st.needed) return;
    } catch {
      return;
    }
    try {
      const s = await api('/api/settings');
      settings = s.settings || {};
      javas = s.javas || [];
    } catch { /* 空环境也能继续 */ }
    try {
      const a = await api('/api/accounts');
      account = (a.accounts || []).find((x) => x.key === a.selected) || null;
    } catch { /* 忽略 */ }
    try {
      await refreshReleases();
    } catch { /* 忽略 */ }
    show();
  }

  back.addEventListener('click', () => {
    if (i > 0) { i -= 1; render(); }
  });
  skip.addEventListener('click', async () => {
    if (i === 4) { pendingInstall = ''; i = 5; render(); return; }
    i = Math.min(i + 1, steps.length - 1);
    if (i === 5) await finish(false);
    else render();
  });
  next.addEventListener('click', async () => {
    if (i === 0) { i = 1; render(); return; }
    if (i === 4) { goDone(); return; }
    if (i === 5) { await finish(true); return; }
    if (i === 2) {
      try {
        const pathValue = document.getElementById('obDir')?.value.trim() || chosenDir;
        if (!pathValue) throw new Error('游戏目录不能为空');
        const ensured = await api('/api/path/ensure', {
          method: 'POST',
          body: JSON.stringify({ path: pathValue }),
        });
        chosenDir = ensured.path;
        await saveConfig();
        // 版本页的“已安装”必须按刚选的游戏目录重新读
        await refreshReleases();
      } catch (e) {
        toast('保存游戏目录失败：' + e.message, 'err');
        return;
      }
    }
    i += 1;
    render();
  });

  boot();
})();
