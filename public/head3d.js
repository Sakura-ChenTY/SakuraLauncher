/**
 * 等距（isometric）头部渲染：把皮肤画成有立体感的方块头。
 *
 * 为什么不是简单裁脸：把 8x8 的脸拉伸填满方块，得到的就是一张"方脸贴纸"，
 * 一旦放大就露馅。这里按等距投影画出立方体的三个可见面（顶 / 正 / 右），
 * 每个面用皮肤的对应贴图做仿射映射，再叠一层很淡的明暗，立体感就出来了。
 *
 * 64x64 皮肤图的头部区域（64x32 老格式的头部坐标相同，只是没有帽子层）：
 *   正面 u8..16 v8..16   左侧 u16..24 v8..16   顶面 u8..16 v0..8
 * 帽子层（头发/眼镜/耳机）整体右移 32px：
 *   正面 u40..48 v8..16  左侧 u48..56 v8..16  顶面 u40..48 v0..8
 * 注：等距视图里露在屏幕右侧的是玩家的「左侧」面，所以取 u16..24。
 */
(function () {
  const COS30 = Math.sqrt(3) / 2;

  // 一个面 = 平行四边形：起点 P0，沿纹理 u 方向走 E1，沿纹理 v 方向走 E2
  // 等距投影 sx=(x-z)cos30、sy=(x+z)/2-y，立方体 [0,1]^3，逐面推导得出：
  //   正面 z=1：u 随 x 增、v 随 y 增（向下）
  //   屏幕右侧那面是 x=1，也就是玩家的左侧；u=16 那条边贴着正面
  //   顶面 y=1：u 随 x 增，v 从 z=1 走向 z=0
  const HEAD = {
    front: { tex: [8, 8, 8, 8], P0: [-COS30, -0.5], E1: [COS30, 0.5], E2: [0, 1] },
    right: { tex: [16, 8, 8, 8], P0: [0, 0], E1: [COS30, -0.5], E2: [0, 1] },
    top: { tex: [8, 0, 8, 8], P0: [0, -1], E1: [COS30, 0.5], E2: [-COS30, 0.5] },
  };
  const HAT = {
    front: { tex: [40, 8, 8, 8] },
    right: { tex: [48, 8, 8, 8] },
    top: { tex: [40, 0, 8, 8] },
  };
  // 光照：顶面提亮、正面原色、右侧压暗
  const SHADE = { top: 0.07, front: 0, right: -0.12 };
  // 先画后面再画前面；三个面本来不重叠，顺序只是保险
  const ORDER = ['top', 'front', 'right'];

  /**
   * 把皮肤图画成等距立体头，铺在画布上。
   * @param {HTMLCanvasElement} canvas 目标画布
   * @param {HTMLImageElement} img 64x64 / 64x32 皮肤图
   * @param {{padding?: number}} [opts] padding 是四周留白比例
   */
  function paintHead3D(canvas, img, opts) {
    const o = opts || {};
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const cssW = o.width || canvas.clientWidth || 132;
    const cssH = o.height || canvas.clientHeight || 132;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 像素风：放大不插值，否则一个像素糊成一片
    ctx.imageSmoothingEnabled = false;

    const W = canvas.width;
    const H = canvas.height;
    // 投影包围盒：宽 2*cos30 ≈ 1.732，高 2
    const pad = o.padding ?? 0.05;
    const k = Math.min((W * (1 - pad * 2)) / (2 * COS30), (H * (1 - pad * 2)) / 2);
    const ox = W / 2;
    const oy = H / 2;

    const hasHat = img.naturalHeight >= 64;

    const drawFace = (geo, tex, shade) => {
      const [u, v, tw, th] = tex;
      const px = ox + geo.P0[0] * k;
      const py = oy + geo.P0[1] * k;
      const e1x = geo.E1[0] * k;
      const e1y = geo.E1[1] * k;
      const e2x = geo.E2[0] * k;
      const e2y = geo.E2[1] * k;

      ctx.save();
      ctx.setTransform(e1x / tw, e1y / tw, e2x / th, e2y / th, px, py);
      ctx.drawImage(img, u, v, tw, th, 0, 0, tw, th);
      ctx.restore();

      if (!shade) return;

      // 同一个平行四边形当裁剪区，叠一层极淡的明暗
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + e1x, py + e1y);
      ctx.lineTo(px + e1x + e2x, py + e1y + e2y);
      ctx.lineTo(px + e2x, py + e2y);
      ctx.closePath();
      ctx.clip();
      // 只作用在已经画上去的像素上，不会把透明区域染黑
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = shade > 0
        ? 'rgba(255,255,255,' + shade + ')'
        : 'rgba(0,0,0,' + (-shade) + ')';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    };

    for (const name of ORDER) {
      drawFace(HEAD[name], HEAD[name].tex, SHADE[name]);
    }
    if (hasHat) {
      for (const name of ORDER) {
        drawFace(HEAD[name], HAT[name].tex, SHADE[name]);
      }
    }

    return true;
  }

  window.paintHead3D = paintHead3D;
})();
