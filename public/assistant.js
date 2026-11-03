/* 绘梨衣小助手：模型配置 + 会话聊天 + 白名单动作 */
(function () {
  const PROVIDERS = {
    deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    kimi: { name: 'Kimi / Moonshot', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    zhipu: { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    qwen: { name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    siliconflow: { name: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    custom: { name: '自定义', baseURL: '', model: '' },
  };

  let lastConfig = { hasKey: false };
  let currentSessionId = '';
  let sending = false;
  let chatActions = {};

  let assistantToastTimer = null;

  function showAssistantToast(text, { sticky = false, timeout = 4800 } = {}) {
    const box = el('assistantToast');
    if (!box) return;
    if (assistantToastTimer) clearTimeout(assistantToastTimer);
    const clean = String(text || '').trim();
    if (!clean) { box.hidden = true; return; }
    box.textContent = clean.length > 260 ? clean.slice(0, 260) + '…' : clean;
    box.classList.toggle('above-home', Boolean(document.getElementById('panel-home')?.classList.contains('active')));
    box.hidden = false;
    if (!sticky) assistantToastTimer = setTimeout(() => { box.hidden = true; }, timeout);
  }
  function el(id) { return document.getElementById(id); }
  function setStatus(text, bad) {
    const n = el('aiStatus');
    if (!n) return;
    n.textContent = text;
    n.style.color = bad ? '#e06c6c' : '';
  }

  function applyProvider(provider, { keepValues = false } = {}) {
    const p = PROVIDERS[provider] || PROVIDERS.custom;
    if (el('aiProvider')) el('aiProvider').value = provider in PROVIDERS ? provider : 'custom';
    if (el('aiCustomFields')) el('aiCustomFields').hidden = provider !== 'custom';
    if (!keepValues) {
      if (el('aiBase')) el('aiBase').value = p.baseURL;
      if (el('aiModel')) el('aiModel').value = p.model;
    }
    if (el('aiProviderInfo')) {
      el('aiProviderInfo').textContent = provider === 'custom'
        ? '自己填 baseURL 和 model。'
        : `${p.baseURL} · ${p.model}`;
    }
  }

  function providerForConfig(cfg) {
    for (const [id, p] of Object.entries(PROVIDERS)) {
      if (p.baseURL && p.baseURL === cfg.baseURL && p.model === cfg.model) return id;
    }
    return 'custom';
  }

  async function loadAiConfig() {
    try {
      setStatus('');
      const d = await api('/api/assistant/config');
      lastConfig = d;
      const provider = d.provider && PROVIDERS[d.provider] ? d.provider : providerForConfig(d);
      if (el('aiBase')) el('aiBase').value = d.baseURL || '';
      if (el('aiModel')) el('aiModel').value = d.model || '';
      applyProvider(provider, { keepValues: true });
      if (el('aiKeyHint')) el('aiKeyHint').textContent = d.hasKey ? `已保存：${d.keyMask}` : '未保存密钥（仍可本地分析日志）';
    } catch (e) {
      setStatus('读取配置失败：' + e.message, true);
    }
  }

  window.assistantRefresh = loadAiConfig;

  async function saveAiConfig() {
    setStatus('保存中…');
    try {
      const d = await api('/api/assistant/config', {
        method: 'POST',
        body: JSON.stringify({
          provider: el('aiProvider').value,
          baseURL: el('aiBase').value.trim(),
          model: el('aiModel').value.trim(),
          apiKey: el('aiKey').value,
        }),
      });
      lastConfig = d;
      el('aiKey').value = '';
      el('aiKeyHint').textContent = d.hasKey ? `已保存：${d.keyMask}` : '未保存密钥（仍可本地分析日志）';
      setStatus('已保存');
    } catch (e) {
      setStatus('保存失败：' + e.message, true);
    }
  }

  async function testAi() {
    setStatus('测试中…');
    try {
      const d = await api('/api/assistant/test', {
        method: 'POST',
        body: JSON.stringify({
          baseURL: el('aiBase').value.trim(),
          model: el('aiModel').value.trim(),
          apiKey: el('aiKey').value || undefined,
        }),
      });
      setStatus(`连接成功：${String(d.reply || 'OK').slice(0, 40)}`);
    } catch (e) {
      setStatus('测试失败：' + e.message, true);
    }
  }

  function targetVersion() {
    return state.selectedVersion || state.lastFailure?.versionId || '';
  }

  function renderChat(messages, actionsByMessage = {}) {
    const box = el('aiResult');
    if (!box) return;
    box.innerHTML = (messages || []).map((m, i) => {
      const isUser = m.role === 'user';
      const actions = actionsByMessage[i] || [];
      const actionHtml = actions.length
        ? `<div class="assistant-actions">${actions.map((a, j) =>
            `<button class="btn ghost" data-chat-action="${i}:${j}">${escapeHtml(a.label)}</button>`).join('')}</div>`
        : '';
      return `<div class="assistant-msg ${isUser ? 'user' : 'bot'}">` +
        `<div class="assistant-msg-role">${isUser ? 'Sakura' : '绘梨衣'}</div>` +
        `<div class="assistant-msg-text">${escapeHtml(m.content || '')}</div>${actionHtml}</div>`;
    }).join('') || '<div class="empty">问吧。我会带着这次启动的上下文回答。</div>';
    requestAnimationFrame(() => {
      const last = box.querySelector('.assistant-msg:last-of-type');
      if (!last) { box.scrollTop = box.scrollHeight; return; }
      const long = last.offsetHeight > box.clientHeight * 0.72;
      if (long) {
        const boxRect = box.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();
        box.scrollTop = Math.max(0, box.scrollTop + lastRect.top - boxRect.top - 4);
      } else {
        box.scrollTop = box.scrollHeight;
      }
    });
    box.querySelectorAll('[data-chat-action]').forEach((b) => {
      b.addEventListener('click', () => {
        const [mi, ai] = b.dataset.chatAction.split(':').map(Number);
        runAction(actionsByMessage[mi]?.[ai]);
      });
    });
  }

  function appendUser(text) {
    const box = el('aiResult');
    if (!box) return;
    const old = box.querySelector('.empty');
    if (old) old.remove();
    const div = document.createElement('div');
    div.className = 'assistant-msg user';
    div.innerHTML = `<div class="assistant-msg-role">Sakura</div><div class="assistant-msg-text">${escapeHtml(text)}</div>`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  async function ensureSession(forceNew = false) {
    if (!forceNew && currentSessionId) return currentSessionId;
    const d = await api('/api/assistant/session', {
      method: 'POST',
      body: JSON.stringify({ versionId: targetVersion() }),
    });
    currentSessionId = d.session.id;
    localStorage.setItem('sakura.assistantSession', currentSessionId);
    chatActions = {};
    const box = el('aiResult');
    if (box) box.innerHTML = '<div class="empty">新会话。上下文已经收集好了。</div>';
    return currentSessionId;
  }

  let lastUserText = '';
  let diagPreview = null;
  let diagPackage = null;

  function renderDiagnosticPreview(data) {
    diagPreview = data;
    diagPackage = null;
    if (el('diagTitle')) el('diagTitle').textContent = '收集诊断信息';
    const lines = [
      `实例：${data.versionId || '未选择'}`,
      `输出目录：${data.outputDir || ''}`,
      '',
      '将要收集：',
      ...(data.files || []).map((f) => `· ${f.label}${f.size ? `（${Math.round(f.size / 1024)} KB）` : ''}`),
      '',
      '脱敏规则：',
      ...(data.redaction || []).map((r) => `· ${r}`),
      '',
      '只在本机生成 zip，不上传。',
    ];
    if (el('diagText')) el('diagText').textContent = lines.join('\n');
    if (el('diagPackBtn')) el('diagPackBtn').hidden = false;
    if (el('diagCopyPath')) el('diagCopyPath').hidden = true;
    if (el('diagOpenBtn')) el('diagOpenBtn').hidden = true;
    if (el('diagModal')) el('diagModal').hidden = false;
  }

  function renderDiagnosticPackage(pkg) {
    diagPackage = pkg;
    if (el('diagTitle')) el('diagTitle').textContent = '诊断包已生成';
    const lines = [
      `路径：${pkg.zipPath || ''}`,
      '',
      '包内文件：',
      ...(pkg.files || []).map((f) => `· ${f.name}（${f.bytes} bytes）`),
      '',
      '脱敏规则：',
      ...(pkg.redaction || []).map((r) => `· ${r}`),
      '',
      '没有上传，文件只在本机。',
    ];
    if (el('diagText')) el('diagText').textContent = lines.join('\n');
    if (el('diagPackBtn')) el('diagPackBtn').hidden = true;
    if (el('diagCopyPath')) el('diagCopyPath').hidden = false;
    if (el('diagOpenBtn')) el('diagOpenBtn').hidden = false;
    if (el('diagModal')) el('diagModal').hidden = false;
  }

  async function openDiagnosticPreview() {
    try {
      const versionId = state.selectedVersion || state.lastFailure?.versionId || '';
      const data = await api('/api/assistant/diagnose/package/preview', {
        method: 'POST',
        body: JSON.stringify({ versionId }),
      });
      renderDiagnosticPreview(data);
    } catch (e) {
      showAssistantToast('列出诊断文件失败：' + e.message, { timeout: 6000 });
    }
  }

  async function createDiagnosticPackageNow() {
    try {
      const versionId = diagPreview?.versionId || state.selectedVersion || '';
      const data = await api('/api/assistant/diagnose/package', {
        method: 'POST',
        body: JSON.stringify({ versionId }),
      });
      renderDiagnosticPackage(data);
      showAssistantToast('诊断包已生成，可复制路径或打开文件夹。', { timeout: 5000 });
    } catch (e) {
      showAssistantToast('生成诊断包失败：' + e.message, { timeout: 7000 });
    }
  }

  async function openDiagnosticFolder() {
    if (!diagPackage?.zipPath) return;
    try {
      await api('/api/assistant/diagnose/package/open', {
        method: 'POST',
        body: JSON.stringify({ path: diagPackage.zipPath }),
      });
    } catch (e) {
      showAssistantToast('打开文件夹失败：' + e.message, { timeout: 5000 });
    }
  }

  async function copyDiagnosticPath() {
    if (!diagPackage?.zipPath) return;
    try {
      await navigator.clipboard.writeText(diagPackage.zipPath);
      if (typeof toast === 'function') toast('诊断包路径已复制');
    } catch {
      if (typeof toast === 'function') toast('复制失败，请手动选中路径', 'err');
    }
  }

  async function sendChat(text, { diagnostic = false } = {}) {
    const message = String(text ?? '').trim();
    if (!message || sending) return;
    lastUserText = message;
    sending = true;
    const input = el('aiChatInput');
    if (input) input.value = '';
    if (diagnostic) showAssistantToast('正在看日志…', { sticky: true });
    else { const t = el('assistantToast'); if (t) t.hidden = true; }
    appendUser(message);
    const box = el('aiResult');
    const pending = document.createElement('div');
    pending.className = 'assistant-msg bot';
    pending.innerHTML = '<div class="assistant-msg-role">绘梨衣</div><div class="assistant-msg-text">……</div>';
    box?.appendChild(pending);
    try {
      const sessionId = await ensureSession(false);
      const d = await api('/api/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({ sessionId, message, mode: diagnostic ? 'diagnostic' : 'chat' }),
      });
      const msgs = d.messages || [];
      chatActions = {};
      chatActions[msgs.length - 1] = d.actions || [];
      renderChat(msgs, chatActions);
      if (el('aiTarget')) el('aiTarget').textContent = `会话 ${sessionId.slice(0, 8)} · ${targetVersion() || '最近失败'}`;
      setHomeCollapsed(false, { persist: true });
      if (d.package) renderDiagnosticPackage(d.package);
    } catch (e) {
      if (pending) pending.querySelector('.assistant-msg-text').textContent = '出了点问题：' + e.message;
      showAssistantToast('出错了：' + e.message, { sticky: false, timeout: 6000 });
    } finally {
      sending = false;
    }
  }

  async function newSession() {
    currentSessionId = '';
    try {
      await ensureSession(true);
      if (el('aiChatInput')) el('aiChatInput').focus();
    } catch (e) {
      setStatus('新会话失败：' + e.message, true);
    }
  }

  async function runAction(action) {
    if (!action) return;
    if (action.id === 'memory.set') {
      const p = action.payload || {};
      const r = await askForm({
        title: '改内存',
        hint: `把 ${p.versionId || targetVersion()} 的最大内存改为 ${p.memoryMax || '1024M'}？`,
        fields: [],
        okText: '执行',
      });
      if (!r) return;
      try {
        const d = await api('/api/assistant/action', { method: 'POST', body: JSON.stringify(action) });
        toast(d.message || '已执行');
        await loadInstalled?.();
      } catch (e) { toast('执行失败：' + e.message, 'err'); }
      return;
    }
    if (action.id === 'java.open') {
      showPanel('settings');
      el('setJavaPath')?.focus();
      return;
    }
    if (action.id === 'open.instance') {
      try {
        const d = await api('/api/assistant/action', { method: 'POST', body: JSON.stringify(action) });
        toast(d.message || '已打开');
      } catch (e) { toast('执行失败：' + e.message, 'err'); }
      return;
    }
    if (action.id === 'mod.disable') {
      const file = await askForm({
        title: '停用 mod',
        hint: '只把 jar 改名为 .disabled，不删除文件。',
        fields: [{ id: 'file', label: 'mod 文件名', placeholder: '例如 example.jar' }],
        okText: '确认停用',
      });
      if (!file?.file) return;
      try {
        const d = await api('/api/assistant/action', {
          method: 'POST',
          body: JSON.stringify({ action: 'mod.disable', payload: { versionId: action.payload?.versionId || targetVersion(), file: file.file } }),
        });
        toast(d.message || '已停用');
      } catch (e) { toast('执行失败：' + e.message, 'err'); }
      return;
    }
    if (action.id === 'redownload.version' || action.id === 'redownload.resources' || action.id === 'serverpack.redownload') {
      try {
        const d = await api('/api/assistant/action', { method: 'POST', body: JSON.stringify(action) });
        toast(d.message || '已开始');
      } catch (e) { toast('执行失败：' + e.message, 'err'); }
    }
  }

  async function runAnalyze() {
    if (el('aiChatInput')) el('aiChatInput').value = '分析最近一次启动失败，为什么进不去游戏？';
    await sendChat('分析最近一次启动失败，为什么进不去游戏？', { diagnostic: true });
  }

  async function onCrash(incident) {
    if (!incident?.id) return;
    try {
      const d = await api('/api/assistant/auto', {
        method: 'POST',
        body: JSON.stringify({ incidentId: incident.id }),
      });
      if (d.already) return;
      if (d.sessionId) {
        currentSessionId = d.sessionId;
        localStorage.setItem('sakura.assistantSession', currentSessionId);
      }
      // 崩溃提示直接进入主页对话区，不替换已有消息。
      const box = el('aiResult');
      if (box) {
        const empty = box.querySelector('.empty');
        if (empty) empty.remove();
        const div = document.createElement('div');
        div.className = 'assistant-msg bot';
        div.innerHTML = '<div class="assistant-msg-role">绘梨衣</div>' +
          `<div class="assistant-msg-text">${escapeHtml(d.reply || '')}</div>`;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
      }
      setHomeCollapsed(false, { persist: true });
      const notice = el('crashNotice');
      if (notice) notice.hidden = true;
    } catch (e) {
      showAssistantToast('自动分析崩溃失败：' + e.message, { timeout: 6500 });
    }
  }
  function showBubble() {
    const b = el('assistantBubble');
    if (b) b.hidden = true;
    showAssistantToast('启动失败了。主页的小助手可以看日志。', { timeout: 6000 });
  }
  window.assistantOnFailure = showBubble;
  window.assistantCrash = onCrash;

  let assistantBarFrame = 0;
  function syncAssistantBarHeight() {
    const panel = el('panel-home');
    const home = el('homeAssistant');
    if (!panel || !home) return;
    const collapsed = home.classList.contains('is-collapsed');
    panel.classList.toggle('has-collapsed-assistant', collapsed);
    if (!collapsed) return;
    const height = Math.ceil(home.getBoundingClientRect().height || 0);
    if (height > 0) panel.style.setProperty('--assistant-bar-height', `${height}px`);
  }
  function scheduleAssistantBarHeight() {
    if (assistantBarFrame) cancelAnimationFrame(assistantBarFrame);
    assistantBarFrame = requestAnimationFrame(() => {
      assistantBarFrame = 0;
      syncAssistantBarHeight();
    });
  }

  function setHomeCollapsed(collapsed, { persist = false } = {}) {
    const home = el('homeAssistant');
    const btn = el('homeAssistantToggle');
    const more = el('homeAssistantMore');
    if (!home) return;
    home.classList.toggle('is-collapsed', Boolean(collapsed));
    if (btn) {
      btn.textContent = collapsed ? '展开' : '收起';
      btn.setAttribute('aria-expanded', String(!collapsed));
    }
    const analyze = el('aiAnalyze');
    const diag = el('homeDiagBtn');
    if (analyze) analyze.textContent = '分析失败';
    if (diag) diag.textContent = '诊断';
    if (more) more.hidden = false;
    if (!collapsed && el('homeAssistantMoreMenu')) el('homeAssistantMoreMenu').hidden = true;
    if (persist) localStorage.setItem('sakura.homeAssistantCollapsed', collapsed ? '1' : '0');
    scheduleAssistantBarHeight();
  }
  function init() {
    if (!el('aiBase')) return;
    loadAiConfig();
    el('aiProvider')?.addEventListener('change', () => applyProvider(el('aiProvider').value));
    el('aiSave')?.addEventListener('click', saveAiConfig);
    el('aiTest')?.addEventListener('click', testAi);
    el('aiAnalyze')?.addEventListener('click', runAnalyze);
    el('aiChatSend')?.addEventListener('click', () => sendChat(el('aiChatInput')?.value));
    el('aiChatNew')?.addEventListener('click', newSession);
    el('homeDiagBtn')?.addEventListener('click', openDiagnosticPreview);
    el('crashNoticeDismiss')?.addEventListener('click', () => { el('crashNotice').hidden = true; });
    el('diagPackBtn')?.addEventListener('click', createDiagnosticPackageNow);
    el('diagOpenBtn')?.addEventListener('click', openDiagnosticFolder);
    el('diagCopyPath')?.addEventListener('click', copyDiagnosticPath);
    el('diagClose')?.addEventListener('click', () => { el('diagModal').hidden = true; });
    el('diagDone')?.addEventListener('click', () => { el('diagModal').hidden = true; });
    el('diagCopy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(el('diagText')?.textContent || ''); if (typeof toast === 'function') toast('诊断信息已复制'); }
      catch { if (typeof toast === 'function') toast('复制失败，请手动选中', 'err'); }
    });
    el('homeAssistantMore')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const menu = el('homeAssistantMoreMenu');
      if (menu) menu.hidden = !menu.hidden;
    });
    el('homeAssistantMoreMenu')?.querySelectorAll('[data-more-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const menu = el('homeAssistantMoreMenu');
        if (menu) menu.hidden = true;
        const action = btn.dataset.moreAction;
        if (action === 'analyze') runAnalyze();
        else if (action === 'diag') openDiagnosticPreview();
        else if (action === 'new') newSession();
      });
    });
    document.addEventListener('click', (ev) => {
      const menu = el('homeAssistantMoreMenu');
      if (!menu || menu.hidden) return;
      if (!ev.target.closest('#homeAssistantMoreMenu') && !ev.target.closest('#homeAssistantMore')) {
        menu.hidden = true;
      }
    });
    el('homeAssistantToggle')?.addEventListener('click', () => {
      const home = el('homeAssistant');
      setHomeCollapsed(!home?.classList.contains('is-collapsed'), { persist: true });
    });
    const savedCollapsed = localStorage.getItem('sakura.homeAssistantCollapsed');
    setHomeCollapsed(savedCollapsed === '1' || (savedCollapsed === null && window.innerWidth < 760));
    if (window.ResizeObserver) {
      const barForResize = el('homeAssistant');
      if (barForResize) new ResizeObserver(scheduleAssistantBarHeight).observe(barForResize);
    }
    window.addEventListener('resize', scheduleAssistantBarHeight);
    el('aiChatInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(el('aiChatInput').value); }
    });
    el('assistantBubbleAnalyze')?.addEventListener('click', () => {
      el('assistantBubble').hidden = true;
      showPanel('assistant');
      runAnalyze();
    });
    el('assistantBubbleClose')?.addEventListener('click', () => {
      el('assistantBubble').hidden = true;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
