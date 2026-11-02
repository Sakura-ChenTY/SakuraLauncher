/**
 * 预加载脚本：把窗口控制这几个动作开给页面
 *
 * 为什么用 .cjs：
 *   package.json 里 type=module，主进程和 src/ 都是 ESM。
 *   但 Electron 的 preload 跑在一个特殊的沙箱上下文里，用 require 更稳。
 *   改成 .cjs 就不会被当成 ESM 解析。
 *
 * 只暴露三个动作，不暴露 ipcRenderer 本体：
 *   给了本体等于把整条 IPC 通道交给页面，将来加了别的通道就一起漏了。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 窗口用的是哪种背景材质，从主进程的 additionalArguments 传进来。
 * 页面拿到 'acrylic' 就不要再画壁纸图 —— 真实桌面已经被 DWM 模糊在
 * 窗口背面了，再贴一张图等于把真效果盖掉，只剩一张假壁纸。
 */
function readMaterial() {
  const hit = process.argv.find((a) => a.startsWith('--mc-material='));
  return hit ? hit.slice('--mc-material='.length) : 'none';
}

contextBridge.exposeInMainWorld('mcWin', {
  material: readMaterial(),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  toggleMax: () => ipcRenderer.send('win:toggle-max'),
  writeClipboard: (text) => ipcRenderer.invoke('win:clipboard-write', text),
  readClipboard: () => ipcRenderer.invoke('win:clipboard-read'),
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return file?.path || ''; }
  },
  pickFolder: () => ipcRenderer.invoke('win:pick-folder'),
  pickFile: (filters) => ipcRenderer.invoke('win:pick-file', filters),
  installUpdate: (payload) => ipcRenderer.invoke('win:install-update', payload),
  autoUpdate: (payload) => ipcRenderer.invoke('win:auto-update', payload),
  onUpdateProgress: (cb) => {
    const handler = (_e, data) => { try { cb(data); } catch { /* ignore */ } };
    ipcRenderer.on('update-progress', handler);
    return () => ipcRenderer.removeListener('update-progress', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('win:open-external', url),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  /** 主进程在最大化状态变化时回调，返回取消订阅函数 */
  onMaximizedChange: (cb) => {
    const handler = (_e, value) => cb(Boolean(value));
    ipcRenderer.on('win:maximized', handler);
    return () => ipcRenderer.removeListener('win:maximized', handler);
  },
});
