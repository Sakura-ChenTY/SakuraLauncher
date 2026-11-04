/**
 * 左上角头像的 3D 正脸渲染。
 *
 * 不裁皮肤贴图：用同一套 skinview3d 模型单独朝正面渲染一张头肩图，
 * 这样头像和主页 3D 人物来自同一个模型，不依赖 PCL 的 8×8 裁切坐标。
 */
(function () {
  'use strict';

  const DEFAULT_SKIN = '/default-skins/wide/steve.png';
  let viewer = null;
  let canvas = null;
  let serial = 0;

  function ensureViewer() {
    if (viewer) return viewer;
    if (!window.skinview3d?.SkinViewer) return null;

    canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    canvas.style.display = 'none';
    document.body.appendChild(canvas);

    viewer = new window.skinview3d.SkinViewer({
      canvas,
      width: 128,
      height: 128,
      skin: DEFAULT_SKIN,
    });
    viewer.autoRotate = false;
    if (viewer.controls) {
      viewer.controls.enabled = false;
      viewer.controls.enableZoom = false;
      viewer.controls.enablePan = false;
    }
    viewer.animation = null;

    // 离屏头像只要头：把身体、四肢、披风隐藏，避免头像底部露出肩膀。
    const skin = viewer.playerObject?.skin;
    if (skin) {
      for (const part of ['body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']) {
        if (skin[part]) skin[part].visible = false;
      }
    }
    for (const part of ['cape', 'elytra']) {
      if (viewer.playerObject?.[part]) viewer.playerObject[part].visible = false;
    }

    // 只取头部：skin 组在 y=8，头部网格再抬高 4，世界高度约 y=12。
    viewer.camera.position.set(0, 12, 12);
    viewer.controls.target.set(0, 12, 0);
    viewer.controls.update();
    viewer.camera.lookAt(0, 12, 0);
    return viewer;
  }

  function drawTo(canvasTarget, dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ctx = canvasTarget.getContext('2d');
        const w = canvasTarget.width;
        const h = canvasTarget.height;
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, w, h);
        resolve();
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  async function render(source = DEFAULT_SKIN) {
    const v = ensureViewer();
    if (!v) throw new Error('3D 头像渲染器不可用');
    const mySerial = ++serial;
    await v.loadSkin(source);
    if (mySerial !== serial) return null;
    v.playerObject.skin.head.rotation.set(0, 0, 0);
    v.render();
    // 等 renderer 把这一帧真正画到 canvas。
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (mySerial !== serial) return null;
    return canvas.toDataURL('image/png');
  }

  /**
   * 把当前皮肤的正脸渲染到目标 canvas。
   * source 为空时用 Steve。
   */
  window.paintAvatar3D = async function paintAvatar3D(target, source) {
    const dataUrl = await render(source || DEFAULT_SKIN);
    if (!dataUrl) return false;
    await drawTo(target, dataUrl);
    return true;
  };

  /** 渲染器不可用时的静态 Steve 兜底，不经过 PCL 的裁脸函数。 */
  window.paintAvatar3DFallback = function paintAvatar3DFallback(target) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ctx = target.getContext('2d');
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.drawImage(img, 0, 0, target.width, target.height);
        resolve();
      };
      img.onerror = reject;
      img.src = DEFAULT_SKIN;
    });
  };
})();
