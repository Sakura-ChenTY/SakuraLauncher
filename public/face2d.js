/**
 * 头像绘制：照 PCL 的真机制来，不自己编形状。
 *
 * PCL（Plain Craft Launcher 2）的源码 `MySkin.xaml` 里写得很直白：
 *
 *     <Image x:Name="ImgBack" Width="48" Height="48" NearestNeighbor />
 *     <Image x:Name="ImgFore" Width="56" Height="56" NearestNeighbor />
 *
 *   - ImgBack = Image.Clip(Scale*8,  Scale*8, Scale*8, Scale*8)   脸层
 *   - ImgFore = Image.Clip(Scale*40, Scale*8, Scale*8, Scale*8)   头发/帽子层
 *
 * 两层都居中，但帽子层是 56、脸层是 48 —— 帽子层比脸大一圈（56/48 ≈ 1.167）。
 * 头发就从脸的边缘自然探出去，那种"毛茸茸、圆润"的观感是这么来的。
 *
 * 所以不做手抠轮廓、不做遮罩挖台阶、更不做整脸模糊：
 * 把两层按 48:56 的比例叠上去，剩下的交给贴图自己的 alpha。
 * 贴图哪里透明，脸就从哪里露出来 —— 轮廓是"长"出来的，不是画出来的。
 *
 * 另外两点照抄 PCL：
 *   - Scale = Width / 64，高清皮肤（128/256）等比换算，不能硬套 8 和 40。
 *   - 64x32 老格式没有帽子层，只画脸。
 *
 * 放大一律最近邻（NearestNeighbor），一个像素都不许糊。
 */
(function () {
  /** 头像占画布的比例 */
  const FILL = 0.86;
  /** PCL：ImgFore 56 / ImgBack 48 */
  const OVERLAY_RATIO = 56 / 48;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLImageElement} img 64x64 / 64x32 皮肤图（高清同理，按 64 的倍数）
   * @param {{width?:number, height?:number, shadow?:boolean}} [opts]
   */
  function paintFace(canvas, img, opts) {
    const o = opts || {};
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const cssW = o.width || canvas.clientWidth || 132;
    const cssH = o.height || canvas.clientHeight || 132;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const W = canvas.width;
    const H = canvas.height;
    /** 帽子层的外框（= PCL 的 56 那层） */
    const size = Math.round(Math.min(W, H) * FILL);
    const dx = Math.round((W - size) / 2);
    const dy = Math.round((H - size) / 2);

    // Scale = Width / 64，PCL 的同一套换算
    const srcW = img.naturalWidth || img.width || 64;
    const srcH = img.naturalHeight || img.height || 64;
    const k = Math.max(1, Math.round(srcW / 64));

    // 脸层比帽子层小一圈：48 对 56
    const faceSize = Math.round(size / OVERLAY_RATIO);
    const faceOff = Math.round((size - faceSize) / 2);

    // ---- 合成：脸在下、帽子在上，两层都居中 ----
    const comp = document.createElement('canvas');
    comp.width = size;
    comp.height = size;
    const cg = comp.getContext('2d');
    cg.imageSmoothingEnabled = false;

    // 脸层（8x8）
    cg.drawImage(
      img, 8 * k, 8 * k, 8 * k, 8 * k,
      faceOff, faceOff, faceSize, faceSize
    );

    // 帽子/头发层（8x8），比脸大一圈，居中压上去
    if (srcH >= 64) {
      cg.drawImage(
        img, 40 * k, 8 * k, 8 * k, 8 * k,
        0, 0, size, size
      );
    }

    // ---- 外发光：PCL 是 DropShadowEffect BlurRadius=10 ShadowDepth=0 Opacity=0.2 ----
    // ShadowDepth=0 意味着没有偏移，是四周均匀的一圈柔光，不是朝下掉的投影。
    if (o.shadow !== false) {
      const solid = document.createElement('canvas');
      solid.width = size;
      solid.height = size;
      const s2 = solid.getContext('2d');
      s2.drawImage(comp, 0, 0);
      s2.globalCompositeOperation = 'source-in';
      s2.fillStyle = '#000';
      s2.fillRect(0, 0, size, size);

      ctx.save();
      ctx.filter = `blur(${Math.max(2, size * 0.05).toFixed(2)}px)`;
      ctx.globalAlpha = 0.22;
      ctx.drawImage(solid, dx, dy);
      ctx.restore();
    }

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(comp, dx, dy);
    return true;
  }

  window.paintFace = paintFace;

  /* ---------------- 没有皮肤时的默认头像 ----------------
     离线号 / 第三方号没登录 / 皮肤拿不到，一律画史蒂夫的脸，
     不要退成名字首字母 —— 首字母不像头像。
     贴图直接从客户端 jar 里抄出来的官方 wide/steve.png，不是手画的。 */
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
