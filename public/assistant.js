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
    box.scrollTop = box.scrollHeight;
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

  async function sendChat(text) {
    const message = String(text ?? '').trim();
    if (!message || sending) return;
    sending = true;
    const input = el('aiChatInput');
    if (input) input.value = '';
    showAssistantToast('正在看日志…', { sticky: true });
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
        body: JSON.stringify({ sessionId, message }),
      });
      const msgs = d.messages || [];
      chatActions = {};
      chatActions[msgs.length - 1] = d.actions || [];
      renderChat(msgs, chatActions);
      if (el('aiTarget')) el('aiTarget').textContent = `会话 ${sessionId.slice(0, 8)} · ${targetVersion() || '最近失败'}`;
      showAssistantToast(d.reply || '没有新的分析结果。');
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
    await sendChat('分析最近一次启动失败，为什么进不去游戏？');
  }

  function showBubble() {
    const b = el('assistantBubble');
    if (b) b.hidden = true;
    showAssistantToast('启动失败了。主页的小助手可以看日志。', { timeout: 6000 });
  }
  window.assistantOnFailure = showBubble;

  function setHomeCollapsed(collapsed, { persist = false } = {}) {
    const home = el('homeAssistant');
    const btn = el('homeAssistantToggle');
    if (!home) return;
    home.classList.toggle('is-collapsed', Boolean(collapsed));
    if (btn) {
      btn.textContent = collapsed ? '展开' : '收起';
      btn.setAttribute('aria-expanded', String(!collapsed));
    }
    if (persist) localStorage.setItem('sakura.homeAssistantCollapsed', collapsed ? '1' : '0');
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
    el('homeAssistantToggle')?.addEventListener('click', () => {
      const home = el('homeAssistant');
      setHomeCollapsed(!home?.classList.contains('is-collapsed'), { persist: true });
    });
    const savedCollapsed = localStorage.getItem('sakura.homeAssistantCollapsed');
    setHomeCollapsed(savedCollapsed === '1' || (savedCollapsed === null && window.innerWidth < 760));
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
