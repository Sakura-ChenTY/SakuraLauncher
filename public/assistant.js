/* 绘梨衣小助手：配置、分析、白名单动作、失败气泡 */
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
      if (el('aiKeyHint')) {
        el('aiKeyHint').textContent = d.hasKey ? `已保存：${d.keyMask}` : '未保存密钥';
      }
    } catch (e) {
      setStatus('读取配置失败：' + e.message, true);
    }
  }

  window.assistantRefresh = loadAiConfig;

  async function saveAiConfig() {
    setStatus('保存中…');
    try {
      const provider = el('aiProvider').value;
      const d = await api('/api/assistant/config', {
        method: 'POST',
        body: JSON.stringify({
          provider,
          baseURL: el('aiBase').value.trim(),
          model: el('aiModel').value.trim(),
          apiKey: el('aiKey').value,
        }),
      });
      lastConfig = d;
      el('aiKey').value = '';
      el('aiKeyHint').textContent = d.hasKey ? `已保存：${d.keyMask}` : '未保存密钥';
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

  function renderAnalysis(data) {
    const box = el('aiResult');
    if (!box) return;
    const chips = (data.classified ?? [])
      .map((c) => `<span class="issue-chip">${escapeHtml(c.label)}</span>`).join('');
    const actions = (data.actions ?? []).map((a, i) =>
      `<button class="btn ghost" data-ai-action="${i}">${escapeHtml(a.label)}</button>`).join('');
    box.innerHTML = `${chips ? `<div>${chips}</div>` : ''}<div>${escapeHtml(data.analysis || '没有分析结果')}</div>` +
      (actions ? `<div class="assistant-actions">${actions}</div>` : '');
    box.querySelectorAll('[data-ai-action]').forEach((b) => {
      b.addEventListener('click', () => runAction(data.actions[Number(b.dataset.aiAction)]));
    });
  }

  async function runAnalyze() {
    const box = el('aiResult');
    if (!box) return;
    const target = state.selectedVersion || state.lastFailure?.versionId || '';
    if (el('aiTarget')) el('aiTarget').textContent = target ? `实例：${target}` : '没有选中实例，只能看最近失败';
    box.innerHTML = '<div class="pcl-loading"><img class="pcl-gif" src="loading.gif" alt=""><div class="pcl-text">正在看日志…</div></div>';
    try {
      const data = await api('/api/assistant/analyze', {
        method: 'POST',
        body: JSON.stringify({ versionId: target }),
      });
      renderAnalysis(data);
    } catch (e) {
      box.innerHTML = `<div class="empty">分析失败：${escapeHtml(e.message)}</div>`;
    }
  }

  async function runAction(action) {
    if (!action) return;
    if (action.id === 'memory.set') {
      const r = await askForm({
        title: '改内存',
        hint: `把 ${action.payload.versionId} 的最大内存改为 ${action.payload.memoryMax}？`,
        fields: [],
        okText: '执行',
      });
      if (!r) return;
      try {
        const d = await api('/api/assistant/action', {
          method: 'POST',
          body: JSON.stringify(action),
        });
        toast(d.message || '已执行');
        await loadInstalled?.();
      } catch (e) {
        toast('执行失败：' + e.message, 'err');
      }
      return;
    }
    if (action.id === 'open.java') {
      showPanel('settings');
      el('setJavaPath')?.focus();
      return;
    }
    if (action.id === 'open.login') {
      el('accountModal').hidden = false;
      return;
    }
    if (action.id === 'open.log') {
      showPanel('home');
      el('openLogBtn')?.click();
      return;
    }
  }

  function showBubble() {
    const b = el('assistantBubble');
    if (b) b.hidden = false;
  }

  window.assistantOnFailure = showBubble;

  function init() {
    if (!el('aiBase')) return;
    loadAiConfig();
    el('aiProvider')?.addEventListener('change', () => applyProvider(el('aiProvider').value));
    el('aiSave')?.addEventListener('click', saveAiConfig);
    el('aiTest')?.addEventListener('click', testAi);
    el('aiAnalyze')?.addEventListener('click', runAnalyze);
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
