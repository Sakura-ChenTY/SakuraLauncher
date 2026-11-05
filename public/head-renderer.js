/**
 * 列表用头部渲染器。
 *
 * 每次只创建一个离屏 SkinViewer，渲染完立刻 dispose。
 * 渲染流程和主页一致：整帧快照 → head.innerLayer/outerLayer 投影 →
 * 外接矩形留边裁切 → 等比缩放到目标尺寸。
 */
(function () {
  'use strict';

  const DEFAULT_SKIN = '/default-skins/wide/steve.png';
  const OFFSCREEN_SIZE = 256;
  let queue = Promise.resolve();

  function projectHeadRect(viewer, canvas) {
    const head = viewer.playerObject?.skin?.head;
    if (!head) return null;
    viewer.playerObject.updateMatrixWorld(true);
    viewer.camera.updateMatrixWorld(true);
    viewer.camera.updateProjectionMatrix();

    const meshes = [head.innerLayer, head.outerLayer].filter((o) => o?.isMesh && o.geometry);
    if (!meshes.length) return null;

    const v = head.position.clone();
    const w = canvas.width;
    const h = canvas.height;
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

  async function renderNow(skinUrl, targetSize) {
    if (!window.skinview3d?.SkinViewer) throw new Error('skinview3d 未加载');

    const canvas = document.createElement('canvas');
    canvas.width = OFFSCREEN_SIZE;
    canvas.height = OFFSCREEN_SIZE;
    canvas.style.display = 'none';
    document.body.appendChild(canvas);

    let viewer = null;
    let objectUrl = '';
    try {
      const res = await fetch(skinUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      objectUrl = URL.createObjectURL(await res.blob());

      viewer = new window.skinview3d.SkinViewer({
        canvas,
        width: OFFSCREEN_SIZE,
        height: OFFSCREEN_SIZE,
        skin: DEFAULT_SKIN,
      });
      viewer.autoRotate = false;
      viewer.animation = null;
      if (viewer.controls) {
        viewer.controls.enabled = false;
        viewer.controls.enableZoom = false;
        viewer.controls.enablePan = false;
      }
      await viewer.loadSkin(objectUrl);
      viewer.camera.position.set(0, 12, 42);
      viewer.controls.target.set(0, 12, 0);
      viewer.controls.update();
      viewer.camera.lookAt(0, 12, 0);
      viewer.playerObject.skin.head.rotation.set(0, 0, 0);
      viewer.render();

      const snapshot = document.createElement('canvas');
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext('2d').drawImage(canvas, 0, 0);

      const projected = projectHeadRect(viewer, canvas);
      let sx;
      let sy;
      let side;
      if (projected) {
        const bar = Math.max(3, Math.max(projected.maxX - projected.minX, projected.maxY - projected.minY) * 0.08);
        side = Math.ceil(Math.max(projected.maxX - projected.minX, projected.maxY - projected.minY) + bar * 2);
        sx = Math.max(0, Math.min(canvas.width - side, Math.round((projected.minX + projected.maxX) / 2 - side / 2)));
        sy = Math.max(0, Math.min(canvas.height - side, Math.round((projected.minY + projected.maxY) / 2 - side / 2)));
      } else {
        side = Math.round(OFFSCREEN_SIZE * 0.38);
        sx = Math.round((OFFSCREEN_SIZE - side) / 2);
        sy = Math.round(OFFSCREEN_SIZE * 0.04);
      }
      if (side < 8) throw new Error('头部裁切区域无效');

      const out = document.createElement('canvas');
      out.width = Math.max(32, targetSize | 0);
      out.height = Math.max(32, targetSize | 0);
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(snapshot, sx, sy, side, side, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    } finally {
      try { viewer?.dispose?.(); } catch { /* ignore */ }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      canvas.remove();
    }
  }

  /** 队列一次只跑一个，避免列表滚动时同时开多个 WebGL context。 */
  function renderHead(skinUrl, targetSize = 64) {
    const run = () => renderNow(skinUrl, targetSize);
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  window.HeadRenderer = { renderHead, projectHeadRect };
})();
