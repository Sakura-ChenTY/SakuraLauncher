/**
 * 主页头像：把正版皮肤的脸部贴图直接放大画出来，平面、不转。
 *
 * 为什么不用 3D：头像就该是一张图。渲染立方体要处理背面剔除、
 * 面排序、透视，出错的地方一堆，而效果对「头像」这件事没有帮助。
 * 这里只做一件事：从 64x64 皮肤图里裁出 8x8 的脸，等比放大填满画布。
 *
 * 裁剪坐标（64x64 标准图 / 64x32 老格式都一样）：
 *   脸（基础层）：u 8..16, v 8..16
 *   帽子层（头发/眼镜/耳机/角）：u 40..48, v 8..16，叠在脸上
 *
 * 放大时关掉平滑，保持像素风的硬边。
 */

const SKIN_URL = '/api/skin';

/**
 * 画一张平面头像。只画一次，没有动画。
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLImageElement} img 64x64（或 64x32）皮肤图
 */
function paintAvatar(canvas, img) {
  paintFace(canvas, img, { width: canvas.clientWidth || 132, height: canvas.clientHeight || 132 });
}

/* ---------------- 启动 ---------------- */

// 每次 start() 递增。页面加载时会进来两次（DOMContentLoaded 一次、
// 账号加载完一次），旧那次如果晚到，它的 onerror 会把新画布关掉——
// 必须靠序号把过期回调丢掉，否则头像会莫名消失。
let lastObjectUrl = null;
let runSeq = 0;

function start() {
  const canvas = document.getElementById('skin3d');
  if (!canvas) return;

  const mySeq = ++runSeq;

  const svg = document.getElementById('skinFallback');
  const hint = document.getElementById('skinHint');

  function useSvg() {
    if (mySeq !== runSeq) return;   // 已经被新一轮取代，别动画布
    canvas.hidden = true;
    if (svg) svg.hidden = false;
    if (hint) hint.hidden = false;
  }

  fetch(SKIN_URL, { cache: 'no-cache' })
    .then((res) => {
      if (res.status === 204 || !res.ok) throw new Error('no skin');
      return res.blob();
    })
    .then((blob) => {
      if (mySeq !== runSeq) return;   // 过期了就不要了

      const url = URL.createObjectURL(blob);
      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
      lastObjectUrl = url;

      const img = new Image();
      img.onload = () => {
        if (mySeq !== runSeq) return;   // 关键：旧图的 onload 不能盖掉新图

        canvas.hidden = false;
        if (svg) svg.hidden = true;
        if (hint) hint.hidden = true;

        paintAvatar(canvas, img);
      };
      img.onerror = useSvg;
      img.src = url;
    })
    .catch(useSvg);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

// 换账号后让主页重画
window.refreshSkin = start;
