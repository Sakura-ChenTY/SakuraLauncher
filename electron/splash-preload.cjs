/**
 * 启动窗的预加载脚本。
 *
 * 它只做一件事：把「动画播完了」这个信号送出去。
 * 不给 ipcRenderer 本体 —— 启动窗是最简页面，不需要任何别的能力。
 *
 * 为什么不用页面里直接开定时器然后自己 close：
 *   启动窗关掉的时机要和「主窗口是否已经画好」配合，
 *   判断权留在主进程，页面只负责报告"我播完了"。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcSplash', {
  done: () => ipcRenderer.send('splash:done'),
});
