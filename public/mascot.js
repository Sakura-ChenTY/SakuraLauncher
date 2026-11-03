/* Q 版绘梨衣：右下角静态形象 + 小助手气泡。 */
(function () {
  const IMAGES = {
    normal: '/mascot/normal.png',
    thinking: '/mascot/thinking.png',
    happy: '/mascot/happy.png',
    sad: '/mascot/sad.png',
    hungry: '/mascot/hungry.png',
    angry: '/mascot/angry.png',
    working: '/mascot/working.png',
    crying: '/mascot/crying.png',
  };
  const IDLE = ['normal', 'thinking', 'thinking', 'sad'];
  const CACHE = new Map();
  let enabled = true;
  let current = 'normal';
  let idleTimer = null;
  let typeTimer = null;
  let hideTimer = null;
  let busy = false;

  const el = (id) => document.getElementById(id);

  function loadImage(name) {
    if (CACHE.has(name)) return CACHE.get(name);
    const src = IMAGES[name];
    if (!src) return Promise.resolve('');
    const promise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(src);
      img.onerror = () => resolve('');
      img.src = src;
    });
    CACHE.set(name, promise);
    return promise;
  }

  function setEmotion(name) {
    if (!enabled) return;
    const img = el('mascotImage');
    if (!img) return;
    const target = IMAGES[name] ? name : 'normal';
    current = target;
    loadImage(target).then((src) => {
      if (!src) {
        // 图片缺失时静默降级，不把界面卡在空白按钮上。
        if (el('mascotLayer')) el('mascotLayer').hidden = true;
        document.body.classList.remove('mascot-on');
        return;
      }
      img.src = src;
    });
  }

  function stopTypewriter() {
    if (typeTimer) clearInterval(typeTimer);
    typeTimer = null;
  }

  function hideBubbleSoon(delay = 5200) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const b = el('mascotBubble');
      if (b) { b.hidden = true; b.textContent = ''; }
      busy = false;
      scheduleIdle();
    }, delay);
  }

  function say(text, emotion = 'normal') {
    if (!enabled) return;
    const bubble = el('mascotBubble');
    if (!bubble) return;
    stopTypewriter();
    if (hideTimer) clearTimeout(hideTimer);
    busy = true;
    const clean = String(text || '').replace(/\s+\n/g, '\n').trim().slice(0, 220);
    if (!clean) return;
    setEmotion(emotion);
    bubble.hidden = false;
    bubble.textContent = '';
    let i = 0;
    typeTimer = setInterval(() => {
      i += 1;
      bubble.textContent = clean.slice(0, i);
      if (i >= clean.length) {
        stopTypewriter();
        hideBubbleSoon();
      }
    }, 28);
  }

  function emotionFor(text) {
    const s = String(text || '');
    if (/错误|失败|崩溃|内存|进不去|不兼容|异常|难过|抱歉/i.test(s)) return 'sad';
    if (/成功|好了|可以|喜欢|高兴|棒|嗯。/i.test(s)) return 'happy';
    if (/看看|日志|检查|分析|为什么|怎么|想|可能/i.test(s)) return 'thinking';
    return 'normal';
  }

  function scheduleIdle() {
    if (!enabled) return;
    if (idleTimer) clearTimeout(idleTimer);
    const delay = 16000 + Math.floor(Math.random() * 14000);
    idleTimer = setTimeout(() => {
      if (enabled && !busy && !document.hidden) {
        const next = IDLE[Math.floor(Math.random() * IDLE.length)];
        setEmotion(next);
        const b = el('mascotBubble');
        if (b) {
          b.hidden = false;
          b.textContent = next === 'thinking' ? '……' : next === 'sad' ? '嗯。' : '在。';
          hideBubbleSoon(2600);
        }
      }
      scheduleIdle();
    }, delay);
  }

  function show() {
    if (!enabled) return;
    const layer = el('mascotLayer');
    if (!layer) return;
    layer.hidden = false;
    document.body.classList.add('mascot-on');
    setEmotion(current || 'normal');
    scheduleIdle();
  }

  function setEnabled(value, { persist = false } = {}) {
    enabled = Boolean(value);
    const layer = el('mascotLayer');
    const box = el('setMascot');
    if (box) box.checked = enabled;
    if (!enabled) {
      layer && (layer.hidden = true);
      document.body.classList.remove('mascot-on');
      stopTypewriter();
      if (idleTimer) clearTimeout(idleTimer);
      const b = el('mascotBubble');
      if (b) { b.hidden = true; b.textContent = ''; }
    } else {
      show();
    }
    if (persist) {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mascotEnabled: enabled }),
      }).catch(() => {});
    }
  }

  function openAssistant() {
    const b = el('mascotBubble');
    if (b) { b.hidden = true; b.textContent = ''; }
    if (typeof showPanel === 'function') showPanel('assistant');
    else document.querySelector('[data-tab="assistant"]')?.click();
    setTimeout(() => el('aiChatInput')?.focus(), 100);
  }

  async function init() {
    const layer = el('mascotLayer');
    if (!layer) return;
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setEnabled(data?.settings?.mascotEnabled !== false);
    } catch {
      setEnabled(true);
    }
    const syncPanel = () => {
      document.body.classList.toggle('mascot-assistant', Boolean(document.getElementById('panel-assistant')?.classList.contains('active')));
    };
    new MutationObserver(syncPanel).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    syncPanel();
    el('mascotButton')?.addEventListener('click', openAssistant);
    el('mascotBubble')?.addEventListener('click', openAssistant);
    el('setMascot')?.addEventListener('change', (e) => setEnabled(e.target.checked, { persist: true }));
    window.addEventListener('assistant:reply', (e) => {
      const text = e?.detail?.text || '';
      const emotion = e?.detail?.emotion || emotionFor(text);
      say(text, emotion);
    });
  }

  window.assistantMascot = { say, setEnabled, openAssistant, setEmotion };
  init();
})();
