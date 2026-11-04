/**
 * 主页全身 3D 皮肤。
 *
 * - 第一帧先加载官方 Steve，绝不出现空白/转圈
 * - 在线账号皮肤回来后再静默替换；失败保持 Steve
 * - 身子保持静态站姿，只让视角和头部跟随鼠标
 * - 3 秒不动 / 失焦 / 指针离开时视角缓慢回正，头部留一点待机微动
 * - 右键只作用于舞台，用来刷新当前账号的官方披风
 */
(function () {
  'use strict';

  const DEFAULT_SKIN = '/default-skins/wide/steve.png';
  const API_SKIN = '/api/skin';
  const API_CAPE = '/api/cape';
  const API_CAPES = '/api/capes';

  const stage = document.getElementById('homeStage');
  const canvas = document.getElementById('skin3d');
  const fallback = document.getElementById('skinFallback');
  const hint = document.getElementById('skinHint');
  const menu = document.getElementById('capeMenu');
  const menuHint = document.getElementById('capeMenuHint');
  const capeModal = document.getElementById('capeModal');
  const capeList = document.getElementById('capeList');
  const capeStatus = document.getElementById('capeStatus');
  const capeConfirm = document.getElementById('capeConfirm');

  if (!stage || !canvas) return;

  let viewer = null;
  let lastSkinUrl = null;
  let lastCapeUrl = null;
  let skinSeq = 0;
  let capeSeq = 0;
  let capeAuthExpired = false;
  let pointerInside = false;
  let targetYaw = 0;
  let targetPitch = 0;
  let headYaw = 0;
  let headPitch = 0;
  let lastFrame = performance.now();
  let selectedCapeId = '';

  function setFallback(message) {
    if (viewer) {
      try { viewer.dispose?.(); } catch { /* ignore */ }
      viewer = null;
    }
    if (canvas) canvas.hidden = true;
    if (fallback) fallback.hidden = false;
    if (hint) {
      hint.hidden = !message;
      hint.textContent = message || '';
    }
  }

  function setCanvasVisible() {
    if (canvas) canvas.hidden = false;
    if (fallback) fallback.hidden = true;
    if (hint) hint.hidden = true;
  }

  function createViewer() {
    if (!window.skinview3d?.SkinViewer) {
      setFallback('3D 皮肤预览不可用');
      return false;
    }
    try {
      viewer = new window.skinview3d.SkinViewer({
        canvas,
        width: 280,
        height: 360,
        skin: DEFAULT_SKIN,
      });
      viewer.autoRotate = false;
      if (viewer.controls) {
        viewer.controls.enabled = false;
        viewer.controls.enableZoom = false;
        viewer.controls.enablePan = false;
      }
      viewer.camera.position.set(0, 14, 54);
      viewer.camera.lookAt(0, 12, 0);
      viewer.loadSkin(DEFAULT_SKIN).catch(() => setFallback('3D 皮肤预览不可用'));
      setCanvasVisible();
      return true;
    } catch (e) {
      console.warn('[skin3d] SkinViewer 初始化失败', e);
      setFallback('3D 皮肤预览不可用');
      return false;
    }
  }

  async function loadSkin() {
    const seq = ++skinSeq;
    if (!viewer) return;
    try {
      const res = await fetch(API_SKIN, { cache: 'no-cache' });
      if (seq !== skinSeq) return;
      if (res.status === 204 || !res.ok) return; // 保持 Steve
      const blob = await res.blob();
      if (seq !== skinSeq) return;
      const url = URL.createObjectURL(blob);
      await viewer.loadSkin(url);
      if (lastSkinUrl) URL.revokeObjectURL(lastSkinUrl);
      lastSkinUrl = url;
      if (seq !== skinSeq) return;
      setCanvasVisible();
      // 左上角头像和 3D 共用同一张 skin；3D 这张加载好后再让头像对齐一次。
      window.dispatchEvent(new CustomEvent('skin3d:skin-updated'));
    } catch (e) {
      console.warn('[skin3d] 皮肤加载失败，保持 Steve', e);
    }
  }

  async function setCapeFromResponse(res) {
    if (!viewer) return false;
    if (res.status === 204) {
      try { await viewer.loadCape(null); } catch { /* ignore */ }
      try { viewer.cape = null; } catch { /* ignore */ }
      if (lastCapeUrl) URL.revokeObjectURL(lastCapeUrl);
      lastCapeUrl = null;
      return false;
    }
    if (!res.ok) return false;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    await viewer.loadCape(url);
    if (lastCapeUrl) URL.revokeObjectURL(lastCapeUrl);
    lastCapeUrl = url;
    return true;
  }

  function showCapeAuthExpired() {
    capeAuthExpired = true;
    if (menuHint) menuHint.textContent = '登录已过期，请重新登录';
    const menuRefresh = menu?.querySelector('[data-cape-action="refresh"]');
    if (menuRefresh) menuRefresh.disabled = true;
    const login = menu?.querySelector('[data-cape-action="login"]');
    if (login) login.hidden = false;
    if (window.toast) window.toast('登录已过期，披风没能刷新；点右键菜单里的「去登录」', 'err');
  }

  async function refreshCape(showResult = true) {
    const seq = ++capeSeq;
    if (!viewer) return;
    try {
      const res = await fetch(`${API_CAPE}?refresh=1`, { cache: 'no-store' });
      if (seq !== capeSeq) return;
      if (res.status === 401) {
        showCapeAuthExpired();
        return;
      }
      const hadCape = await setCapeFromResponse(res);
      if (seq !== capeSeq) return;
      capeAuthExpired = false;
      if (menuHint) menuHint.textContent = hadCape ? '' : '该账号没有披风';
      const menuRefresh = menu?.querySelector('[data-cape-action="refresh"]');
      if (menuRefresh) menuRefresh.disabled = false;
      const login = menu?.querySelector('[data-cape-action="login"]');
      if (login) login.hidden = true;
      if (showResult && window.toast) {
        window.toast(hadCape ? '披风已刷新' : '该账号没有披风', hadCape ? 'ok' : 'err');
      }
    } catch {
      if (showResult && window.toast) window.toast('披风刷新失败，请稍后重试', 'err');
    }
  }

  function openCapeMenu(x, y) {
    if (!menu) return;
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
    if (menuHint) {
      menuHint.textContent = capeAuthExpired ? '登录已过期，请重新登录' : '';
    }
    const refresh = menu.querySelector('[data-cape-action="refresh"]');
    if (refresh) refresh.disabled = capeAuthExpired;
    const login = menu.querySelector('[data-cape-action="login"]');
    if (login) login.hidden = !capeAuthExpired;
  }

  function closeCapeMenu() {
    if (menu) menu.hidden = true;
  }

  async function openCapeList() {
    closeCapeMenu();
    if (!capeModal || !capeList) return;
    capeModal.hidden = false;
    capeList.innerHTML = '<div class="empty">正在读取披风…</div>';
    if (capeStatus) capeStatus.textContent = '';
    if (capeConfirm) capeConfirm.disabled = true;
    selectedCapeId = '';
    try {
      const res = await fetch(API_CAPES, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || data.error === 'AUTH_EXPIRED') {
        capeList.innerHTML = '<div class="empty">登录已过期，无法读取披风列表</div>';
        if (capeStatus) capeStatus.textContent = '登录已过期，请重新登录';
        capeAuthExpired = true;
        if (window.toast) window.toast('登录已过期，披风列表没能读取', 'err');
        return;
      }
      if (!data.listable) {
        capeList.innerHTML = `<div class="empty">${escapeHtml(data.reason || '当前账号不能切换披风')}</div>`;
        return;
      }
      const capes = data.capes || [];
      if (!capes.length) {
        capeList.innerHTML = '<div class="empty">该账号没有披风</div>';
        return;
      }
      selectedCapeId = capes.find((c) => c.state === 'ACTIVE')?.id || '';
      capeList.innerHTML = capes.map((c) => `
        <label class="cape-item ${c.state === 'ACTIVE' ? 'active' : ''}">
          <input type="radio" name="cape" value="${escapeHtml(c.id)}" ${c.id === selectedCapeId ? 'checked' : ''}>
          <span>${escapeHtml(c.alias)}</span>
          <small>${c.state === 'ACTIVE' ? '当前' : ''}</small>
        </label>
      `).join('');
      capeList.querySelectorAll('input[name="cape"]').forEach((el) => {
        el.addEventListener('change', () => {
          selectedCapeId = el.value;
          if (capeConfirm) capeConfirm.disabled = !selectedCapeId;
        });
      });
      if (capeConfirm) capeConfirm.disabled = !selectedCapeId;
    } catch {
      capeList.innerHTML = '<div class="empty">读取披风列表失败</div>';
    }
  }

  async function confirmCape() {
    if (!selectedCapeId || !capeConfirm) return;
    capeConfirm.disabled = true;
    try {
      const res = await fetch('/api/capes/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capeId: selectedCapeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || data.error === 'AUTH_EXPIRED') {
        capeAuthExpired = true;
        if (capeStatus) capeStatus.textContent = '登录已过期，请重新登录';
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (capeModal) capeModal.hidden = true;
      await refreshCape(true);
    } catch (e) {
      if (capeStatus) capeStatus.textContent = `切换失败：${e.message}`;
      capeConfirm.disabled = false;
    }
  }

  function stepCamera() {
    if (!viewer) return;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;

    // 视角固定正对人物；只有头部按鼠标指针方向转。
    const head = viewer.playerObject?.skin?.head;
    if (head) {
      const idle = !pointerInside;
      const idleYaw = Math.sin(now * 0.0011) * 0.035;
      const idlePitch = Math.sin(now * 0.0017) * 0.018;
      const targetHeadYaw = idle ? idleYaw : targetYaw;
      const targetHeadPitch = idle ? idlePitch : targetPitch;
      const hk = 1 - Math.exp(-7 * dt);
      headYaw += (targetHeadYaw - headYaw) * hk;
      headPitch += (targetHeadPitch - headPitch) * hk;
      head.rotation.y = headYaw;
      head.rotation.x = headPitch;
    }
    requestAnimationFrame(stepCamera);
  }

  function bindPointer() {
    // 指针在屏幕任何位置：相对人物画布中心算方向，头只转有限角度。
    window.addEventListener('pointermove', (e) => {
      if (!viewer) return;
      const r = canvas.getBoundingClientRect();
      const nx = (e.clientX - (r.left + r.width / 2)) / Math.max(1, window.innerWidth / 2);
      const ny = (e.clientY - (r.top + r.height / 2)) / Math.max(1, window.innerHeight / 2);
      targetYaw = Math.max(-1, Math.min(1, nx)) * 0.55;
      targetPitch = Math.max(-1, Math.min(1, ny)) * 0.30;
      pointerInside = true;
    });
    window.addEventListener('pointerout', (e) => {
      if (e.relatedTarget) return;
      pointerInside = false;
      targetYaw = 0;
      targetPitch = 0;
    });
    window.addEventListener('blur', () => {
      pointerInside = false;
      targetYaw = 0;
      targetPitch = 0;
      closeCapeMenu();
    });
  }

  function bindCapeMenu() {
    if (!menu) return;
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeCapeMenu();
      openCapeMenu(e.clientX, e.clientY);
    });
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cape-action]');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.capeAction;
      closeCapeMenu();
      if (action === 'refresh') refreshCape(true);
      else if (action === 'list') openCapeList();
      else if (action === 'login') {
        document.getElementById('accountCard')?.click();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (menu.hidden) return;
      if (!menu.contains(e.target)) closeCapeMenu();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeCapeMenu();
        if (capeModal) capeModal.hidden = true;
      }
    });
  }

  function bindCapeModal() {
    const close = () => { if (capeModal) capeModal.hidden = true; };
    document.getElementById('capeClose')?.addEventListener('click', close);
    document.getElementById('capeCancel')?.addEventListener('click', close);
    capeConfirm?.addEventListener('click', confirmCape);
    capeModal?.addEventListener('click', (e) => {
      if (e.target === capeModal) close();
    });
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** 把 head + 外层 hat 的包围盒八个角投影到主 canvas 的像素坐标 */
  function projectHeadRect() {
    if (!viewer || !canvas) return null;
    const head = viewer.playerObject?.skin?.head;
    if (!head) return null;

    viewer.playerObject.updateMatrixWorld(true);
    viewer.camera.updateMatrixWorld(true);
    viewer.camera.updateProjectionMatrix();

    // 只要 head 的 inner + outer（hat）。ears 也是 head 的子节点，
    // 但不能算进头部包围盒，否则裁切框会被两侧耳朵撑宽、带进肩膀。
    const meshes = [head.innerLayer, head.outerLayer].filter((o) => o?.isMesh && o.geometry);
    if (!meshes.length) return null;

    const w = canvas.width;
    const h = canvas.height;
    const v = head.position.clone();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const mesh of meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) continue;
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            v.set(x, y, z);
            mesh.localToWorld(v);
            v.project(viewer.camera);
            const px = (v.x + 1) * 0.5 * w;
            const py = (1 - v.y) * 0.5 * h;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
        }
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { minX, minY, maxX, maxY, width: w, height: h };
  }

  /**
   * 先把主舞台整帧复制成 DPR 全分辨率 PNG，再从这张图裁头部。
   * 裁切框来自 head + hat 的八点投影，不再用固定比例猜。
   */
  async function captureStageHead() {
    if (!viewer || !canvas) return null;
    // 确保拿到的是最新的一帧，而不是上一轮 resize/皮肤切换前的画面。
    viewer.render();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    viewer.render();

    // 这是 devicePixelRatio 下的 canvas 真实尺寸，不先缩成 CSS 尺寸。
    const w = canvas.width;
    const h = canvas.height;
    const snapshot = document.createElement('canvas');
    snapshot.width = w;
    snapshot.height = h;
    const snapCtx = snapshot.getContext('2d');
    snapCtx.drawImage(canvas, 0, 0, w, h);

    const projected = projectHeadRect();
    let sx;
    let sy;
    let side;
    if (projected) {
      const bar = Math.max(4, Math.max(projected.maxX - projected.minX, projected.maxY - projected.minY) * 0.07);
      const cx = (projected.minX + projected.maxX) / 2;
      const cy = (projected.minY + projected.maxY) / 2;
      side = Math.ceil(Math.max(projected.maxX - projected.minX, projected.maxY - projected.minY) + bar * 2);
      sx = Math.max(0, Math.min(w - side, Math.round(cx - side / 2)));
      sy = Math.max(0, Math.min(h - side, Math.round(cy - side / 2)));
    } else {
      // 投影失败时只做保底，不参与正常路径。
      side = Math.round(Math.min(w, h) * 0.36);
      sx = Math.round((w - side) / 2);
      sy = Math.round(h * 0.04);
    }
    if (side < 8) return null;

    // 保持裁切原图的原始像素尺寸；放大只交给最终 64×64 绘制和 CSS 预览。
    const crop = document.createElement('canvas');
    crop.width = side;
    crop.height = side;
    const cropCtx = crop.getContext('2d');
    cropCtx.imageSmoothingEnabled = true;
    cropCtx.drawImage(snapshot, sx, sy, side, side, 0, 0, side, side);

    return {
      cropDataUrl: crop.toDataURL('image/png'),
      fullDataUrl: snapshot.toDataURL('image/png'),
      rect: { x: sx, y: sy, size: side, canvasWidth: w, canvasHeight: h },
    };
  }

  function init() {
    if (!createViewer()) return;
    loadSkin();
    refreshCape(false);
    bindPointer();
    bindCapeMenu();
    bindCapeModal();
    requestAnimationFrame(stepCamera);
    window.refreshSkin = () => {
      if (!viewer) return;
      loadSkin();
      refreshCape(false);
    };
    window.refreshCape = () => refreshCape(true);
    window.captureStageHead = captureStageHead;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
