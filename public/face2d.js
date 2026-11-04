/**
 * 小型皮肤头像渲染。
 *
 * 这里只使用 Minecraft 皮肤贴图的标准头部区域：
 *   基础脸：u 8..16, v 8..16
 *   外层帽子：u 40..48, v 8..16（64×32 老格式没有这一层）
 *
 * 画法、比例、圆角和描边都由本项目自己定义：
 * 脸层略小，帽子层略大，两层居中对齐，最后裁成自己的圆角头像。
 */
(function () {
  'use strict';

  const FACE_UV = [8, 8, 8, 8];
  const HAT_UV = [40, 8, 8, 8];
  const FACE_SCALE = 0.70;
  const HAT_SCALE = 0.86;
  const CORNER_SCALE = 0.18;

  function roundedPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function paintFace(canvas, img, opts) {
    const o = opts || {};
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const cssW = o.width || canvas.clientWidth || 64;
    const cssH = o.height || canvas.clientHeight || 64;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const size = Math.min(W, H);
    const inset = size * 0.08;
    const frame = size - inset * 2;
    const corner = frame * CORNER_SCALE;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const srcW = img.naturalWidth || img.width || 64;
    const srcH = img.naturalHeight || img.height || 64;
    const k = Math.max(1, Math.round(srcW / 64));

    ctx.save();
    roundedPath(ctx, inset, inset, frame, frame, corner);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;

    const faceSize = frame * FACE_SCALE;
    const hatSize = frame * HAT_SCALE;
    const cx = W / 2;
    const cy = H / 2;
    const [fu, fv, fw, fh] = FACE_UV;
    ctx.drawImage(
      img, fu * k, fv * k, fw * k, fh * k,
      cx - faceSize / 2, cy - faceSize / 2, faceSize, faceSize
    );

    if (srcH >= 64) {
      const [hu, hv, hw, hh] = HAT_UV;
      ctx.drawImage(
        img, hu * k, hv * k, hw * k, hh * k,
        cx - hatSize / 2, cy - hatSize / 2, hatSize, hatSize
      );
    }
    ctx.restore();

    // 自己的细描边；不使用任何来源不明的阴影参数。
    ctx.save();
    roundedPath(ctx, inset, inset, frame, frame, corner);
    ctx.strokeStyle = 'rgba(255,255,255,.20)';
    ctx.lineWidth = Math.max(1, size * 0.012);
    ctx.stroke();
    ctx.restore();

    return true;
  }

  window.paintFace = paintFace;

  let stevePromise = null;
  function loadDefaultSkin() {
    if (!stevePromise) {
      stevePromise = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = '/steve.png';
      });
    }
    return stevePromise;
  }

  function paintDefaultFace(canvas, opts) {
    return loadDefaultSkin().then((img) => paintFace(canvas, img, opts));
  }

  window.paintDefaultFace = paintDefaultFace;
})();
