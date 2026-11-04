/**
 * Electron 主进程：把启动器做成独立桌面程序
 *
 * 和 desktop.js 的区别：
 *   desktop.js 用 Edge 的 --app 模式开窗口 —— 那还是浏览器，任务栏是浏览器的，
 *   关掉浏览器就没了，装到别人机器上还得求人家有 Edge。
 *   这里是自带 Chromium 的真程序：自己的进程、自己的图标、自己画的标题栏。
 *
 * 为什么保留 src/server.js 那套 HTTP 服务：
 *   界面、接口、皮肤、账号逻辑全在里面（30KB+），改成本地调用等于重写一遍。
 *   用 127.0.0.1 回环加载页面，前端代码一行都不用动，只是「谁在显示它」变了。
 *
 * 窗口不画系统边框（frame: false），标题栏由页面自己画：
 *   这样玻璃圆角、磨砂背景才不会被系统标题栏切成直角的黑条。
 *   transparent: true 让窗口外圈的 12px 留白真正透明 —— 壁纸是「外面的」，
 *   不是页面里画的一张图，看起来才像一块玻璃浮在桌面上。
 */
import { app, BrowserWindow, ipcMain, shell, screen, clipboard, dialog, Tray, Menu, powerMonitor } from 'electron';
import electronUpdater from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const { autoUpdater } = electronUpdater;
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.on('download-progress', (p) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-progress', {
      percent: Number(p?.percent || 0),
      transferred: Number(p?.transferred || 0),
      total: Number(p?.total || 0),
      bytesPerSecond: Number(p?.bytesPerSecond || 0),
    });
  }
});

import { fileURLToPath } from 'node:url';

import { startServer, server as httpServer } from '../src/server.js';

/* Windows 部分显卡驱动会导致 GPU / Network service 崩溃，先禁用硬件加速。 */
app.disableHardwareAcceleration();

let fatalShown = false;
function showFatal(err) {
  if (fatalShown) return;
  fatalShown = true;
  const message = String(err?.message ?? err ?? '未知错误');
  console.error('[fatal]', err);
  try {
    dialog.showErrorBox(
      'SakuraLauncher 启动失败',
      `启动器遇到一个错误，界面无法继续加载。\n\n${message}\n\n` +
      '这不是电脑坏了。请把这段文字发给开发者；如果重复出现，先关闭所有 SakuraLauncher 进程再试。'
    );
  } catch {
    /* 窗口还没准备好时只能写控制台 */
  }
  setTimeout(() => app.exit(1), 150);
}
process.on('uncaughtException', showFatal);
process.on('unhandledRejection', showFatal);


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/* 开发版单独用一份 userData，避免和已安装的 0.9.18 抢单实例锁：
   否则 npm start 可能直接退出，用户看到的仍是旧版窗口。 */
if (!app.isPackaged) {
  app.setPath('userData', path.join(ROOT, '.dev-userdata'));
}

/*
 * 应用名：任务栏、通知、错误对话框上显示的名字。
 *
 * 不能只靠 package.json 的 name —— 那个是 npm 包名（sakura-launcher），
 * 带连字符也不好看。Windows 任务栏认的是 app.setName 设置的这个值。
 * 而且必须在 app ready 之前调，晚了就不生效。
 */
app.setName('Sakura Minecraft Launcher');

/*
 * 任务栏身份标识（AppUserModelID）。
 *
 * 不设的话，任务栏会把本程序和 electron.exe 混成一组，
 * 固定到任务栏后图标可能变回 Electron 默认的原子图标。
 * 用包名当 ID，保证它是独立的一条。
 */
app.setAppUserModelId('com.sakura.launcher');

/**
 * 窗口图标的路径。
 *
 * 开发时图标在 <ROOT>/build/ 下，直接能用。
 * 打包后代码在 app.asar 里，虽然 Electron 对 asar 做了 fs 补丁，
 * 但给 BrowserWindow 传图标路径时最好用真实文件系统路径 ——
 * 所以打包时会把图标另存一份到 resources/icon.ico，优先用它。
 */
const ICON_PATH = (() => {
  const packaged = path.join(process.resourcesPath || '', 'icon.ico');
  try {
    if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  } catch {
    /* 读不到就往下走 */
  }
  return path.join(ROOT, 'build', 'sakura-launcher.ico');
})();

const DEFAULT_PORT = Number(process.env.MCLAUNCHER_PORT || 7801);
/** 端口被占时最多往后试几个 */
const PORT_TRIES = 12;

/** @type {BrowserWindow | null} */
let win = null;
/** 启动窗（透明小窗，只放 GIF）@type {BrowserWindow | null} */
let splashWin = null;

/* 主窗口「可以亮了」的两个前提：
     mainReady  —— 页面首帧画好（不会先黑一下）
     splashDone —— 启动动画播完
   两个都到才显示主窗，然后关掉启动窗。
   少一个就显示，会要么闪黑、要么动画被切掉。 */
let mainReady = false;
let splashDone = false;
let pendingSecondInstance = false;

function focusMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.setAlwaysOnTop(false);
  win.moveTop?.();
}

/**
 * 起服务。端口被占就往后挪，别直接死。
 * 返回实际端口；全都失败时抛错（交给调用方弹框，别静默黑屏）。
 */
async function bootServer() {
  let lastError = null;
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = DEFAULT_PORT + i;
    try {
      await startServer({
        port,
        gameDir: process.env.MCLAUNCHER_GAME_DIR || undefined,
        firstRun: process.argv.includes('--first-run') || process.env.MCLAUNCHER_FIRST_RUN === '1',
      });
      return port;
    } catch (e) {
      lastError = e;
      // 只有端口被占才值得重试；别的错误重试也没用
      if (e?.code !== 'EADDRINUSE') break;
    }
  }
  throw lastError ?? new Error('无法启动本地服务');
}

function createSplashWindow(port) {
  /* 透明启动窗
     ------------------------------------------------------------
     为什么必须单开一个窗口：
     主窗口整块有底色（亚克力/深色面板），截图里那个 1200x880 的黑框
     就是它自己。想让画面上「只有 GIF、背景是桌面」，
     唯一的做法是开一个 transparent 的窗口，里面只放那张图，
     其余像素全部透明。

     注意 transparent:true 和 backgroundMaterial 互斥（主窗口那套用不了），
     所以这个窗不能用亚克力，也不需要 —— 它没有任何面板。 */
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  /* 启动窗尺寸
     ------------------------------------------------------------
     启动窗按 128×128 物理像素设计。BrowserWindow 的 width/height
     使用 DIP；本机缩放 150%，直接写 128 会变成 192 物理像素，
     所以先取物理目标，再除 scaleFactor 换成 DIP。
     workAreaSize 也是 DIP，居中计算保持一致。 */
  const TARGET_PHYSICAL = 128;
  /* 无边框窗口仍会占一圈外沿：实测多约 3 物理像素，先扣除再换算 DIP。 */
  const FRAME_PHYSICAL = 3;
  const scale = display.scaleFactor || 1;
  const size = Math.max(48, Math.round((TARGET_PHYSICAL - FRAME_PHYSICAL) / scale));

  splashWin = new BrowserWindow({
    width: size,
    height: size,
    x: Math.round((width - size) / 2),
    y: Math.round((height - size) / 2),
    frame: false,
    transparent: true,
    // 透明窗必须关掉阴影，否则 DWM 会按矩形外框画一圈灰边
    hasShadow: false,
    // 不能调大小、不能最大化：它只是一个动画，不是窗口
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    // 永远置顶，免得被别的窗口盖住导致「什么都没看到」
    alwaysOnTop: true,
    // 别抢焦点：用户可能在别的程序里打字
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 透明窗口里视频/图片解码走 GPU，关掉沙箱更容易拿到硬件加速
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  splashWin.loadURL(`http://127.0.0.1:${port}/splash.html`);
  splashWin.once('ready-to-show', () => {
    if (splashWin && !splashWin.isDestroyed()) splashWin.show();
  });
  // 兜底：ready-to-show 在透明窗上不保证会来，1.5s 后无论如何先显示
  const splashShowFallback = setTimeout(() => {
    if (splashWin && !splashWin.isDestroyed() && !splashWin.isVisible()) splashWin.show();
  }, 1500);

  splashWin.on('closed', () => {
    clearTimeout(splashShowFallback);
    splashWin = null;
  });
}

/* 启动动画播完 → 揭开主窗口。
   即使页面那边因为异常没发信号，主进程也有自己的兜底计时（见 createWindow）。 */
ipcMain.on('splash:done', () => {
  splashDone = true;
  revealMainWindow();
});

/** 两个前提都满足才显示主窗口，然后淡出启动窗 */
function revealMainWindow() {
  if (!mainReady || !splashDone) return;
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) return;

  win.show();
  if (pendingSecondInstance) {
    pendingSecondInstance = false;
    focusMainWindow();
  }

  if (splashWin && !splashWin.isDestroyed()) {
    // 启动窗留 120ms 再关，避免主窗首帧和桌面之间闪一下空白
    const s = splashWin;
    setTimeout(() => {
      if (s && !s.isDestroyed()) s.close();
    }, 120);
  }
}

function createWindow(port) {
  /* 主窗口尺寸
     ------------------------------------------------------------
     目标物理尺寸 1382×885，本机缩放 150% → 921×590 DIP。

     但 BrowserWindow 的 width/height 不等于最终窗口外沿：
     frame:false 时 Windows 仍会给一圈非客户区。实测：
       写 921×590 → 量到 1404×896（多 23×11）
     这圈固定开销换算成 DIP 约 15×7，所以写的时候先减掉：
     (1382-23)/1.5 ≈ 906，(885-11)/1.5 ≈ 583。

     做成可调整大小：窗口小的时候列表只放得下七行，
     搜索/筛选能救急，但用户要求能拉大/最大化，所以不再锁死。 */
  win = new BrowserWindow({
    width: 906,
    height: 583,
    minWidth: 760,
    minHeight: 480,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    thickFrame: true,
    // 无系统边框，标题栏和按钮都由页面画
    frame: false,
    /* 真正的「透过窗口看到模糊桌面」
       ------------------------------------------------------------
       CSS 的 backdrop-filter 只能模糊同一个窗口内部的内容，
       窗户外面的桌面它一点都碰不到 —— 之前那个"透光"其实是把
       壁纸图片自己模糊了再贴进来，本质上还是一张图。

       backgroundMaterial 走的是 Windows DWM 合成层，模糊的是
       窗口背面的真实桌面，连桌面图标和别的窗口一起模糊掉了。
       只有 Win11 22H2+ 支持，参数可选 mica / acrylic / tabbed。
       选 acrylic：mica 偏「着色壁纸」，acrylic 才是真模糊。

       注意：transparent:true 和 backgroundMaterial 互斥，
       两个一起给会是黑屏或者材质不生效。用材质就必须关透明。
    */
    transparent: false,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    // 圆角交给 DWM，Windows 11 上窗口外沿不会出现直角黑边
    roundedCorners: true,
    // 先不显示，等页面画好再 show，避免白屏闪一下
    show: false,
    // 不抢系统菜单，这个程序没有菜单栏
    autoHideMenuBar: true,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // 页面是本地回环，但预加载脚本只暴露窗口控制这几个方法，别的都不给
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 告诉页面当前用的是哪种材质，页面据此决定画不画那张假壁纸
      additionalArguments: ['--mc-material=acrylic'],
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${port}/`);

  /* 页面画好也不马上显示。
     两个条件都满足才亮相：页面首帧就绪（不闪黑）+ 启动动画播完（不被切掉）。

     注意：不能直接用 ready-to-show 就 show —— 那个事件在 backgroundMaterial
     下实测根本不触发（旧代码靠 3 秒超时兜底才能看见窗口）。
     所以这里用 did-finish-load 作为「首帧好了」的信号，它可靠得多。 */
  const markReady = () => {
    if (!win || win.isDestroyed()) return;
    mainReady = true;
    revealMainWindow();
  };
  win.webContents.once('did-finish-load', markReady);
  win.once('ready-to-show', markReady);

  /* 兜底：动画信号丢了/页面报错，也不能把人卡在透明窗前。
     透明窗没边框没按钮，一旦不关就等于程序消失。
     取 4s：原速动画 2.08s 再加启动开销，正常绝不会走到这里。 */
  const showFallback = setTimeout(() => {
    splashDone = true;
    markReady();
  }, 4000);
  win.once('closed', () => clearTimeout(showFallback));

  // 最大化状态变了要通知页面，按钮图标得跟着换
  const pushMaxState = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('win:maximized', win.isMaximized());
    }
  };
  win.on('maximize', pushMaxState);
  win.on('unmaximize', pushMaxState);

  /* 失焦会把亚克力打回纯色
     ------------------------------------------------------------
     Windows 对 background acrylic 的官方设计就是：窗口一失去活动状态，
     半透明和纹理原地换成一块纯色（微软文档 "Acrylic material" 明确写了）。
     所以切到别的窗口时，这块玻璃会突然变成灰板 —— 不是我们的 bug。

     这里试的办法：失焦后重新设一次材质，看能不能把材质状态抢回来。
     加一点延迟，等系统先把"失活"这套画完再覆盖，否则会被立刻盖回去。 */
  const reapplyMaterial = () => {
    if (!win || win.isDestroyed()) return;
    try {
      win.setBackgroundMaterial('none');
      win.setBackgroundMaterial('acrylic');
    } catch {
      /* 旧系统不支持就算了，保持默认行为 */
    }
  };
  win.on('blur', () => setTimeout(reapplyMaterial, 120));
  win.on('focus', () => setTimeout(reapplyMaterial, 120));

  // 页面里的外链一律丢给系统浏览器，别在启动器里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

/* ---------- 托盘：显示定时清理的上次/下次时间 ---------- */
let tray = null;
let trayPoll = null;

function memoryTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function memoryMbText(bytes) {
  const mb = Number(bytes || 0) / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

async function readMemorySchedule(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/system/memory/schedule`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function trayMenu(status) {
  const last = status?.lastAt
    ? `上次清理：${memoryTime(status.lastAt)}，释放 ${memoryMbText(status.lastReleased)}`
    : '上次清理：还没有记录';
  const next = status?.enabled
    ? `下次清理：${memoryTime(status.nextAt)}${status.suspended ? '（系统休眠中，唤醒后重算）' : ''}`
    : '定时清理：已关闭';
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => focusMainWindow() },
    { type: 'separator' },
    { label: last, enabled: false },
    { label: next, enabled: false },
    { type: 'separator' },
    { label: '退出启动器', click: () => app.quit() },
  ]);
}

async function refreshTray(port) {
  if (!tray) return;
  const status = await readMemorySchedule(port);
  const last = status?.lastAt
    ? `上次清理：${memoryTime(status.lastAt)}，释放 ${memoryMbText(status.lastReleased)}`
    : '上次清理：还没有记录';
  const next = status?.enabled
    ? `下次：${memoryTime(status.nextAt)}`
    : '下次：已关闭';
  tray.setToolTip(`Sakura Launcher\n${last}\n${next}`);
  tray.setContextMenu(trayMenu(status));
}

function createTray(port) {
  if (tray) return;
  try {
    tray = new Tray(ICON_PATH);
  } catch {
    return;
  }
  tray.setToolTip('Sakura Launcher');
  tray.on('click', () => focusMainWindow());
  tray.on('right-click', async () => {
    const status = await readMemorySchedule(port);
    tray.popUpContextMenu(trayMenu(status));
  });
  refreshTray(port);
  trayPoll = setInterval(() => refreshTray(port), 15_000);
  trayPoll.unref?.();
}

async function notifyMemoryPower(port, action) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/system/memory/schedule/power`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  } catch {
    /* 服务已经退出时忽略 */
  }
}

function bindPowerMonitor(port) {
  // 睡眠时停表；唤醒后从当前时刻重新计时，不补跑睡前的次数。
  powerMonitor.on('suspend', () => { void notifyMemoryPower(port, 'suspend'); });
  powerMonitor.on('resume', () => { void notifyMemoryPower(port, 'resume'); });
}

/** 只允许开一个实例：第二次双击就把已有窗口提到前面 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    pendingSecondInstance = true;
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    try {
      const port = await bootServer();
      // 先开透明启动窗（只放 GIF），再在背后把主窗口准备好 ——
      // 主窗不显示，但已经开始加载数据，所以动画播完时揭开的不是空页。
      createSplashWindow(port);
      createWindow(port);
      createTray(port);
      bindPowerMonitor(port);
    } catch (e) {
      // 起不来时给个能看清的对话框，别让用户对着空屏幕
      const { dialog } = await import('electron');
      dialog.showErrorBox(
        'Sakura Minecraft Launcher 启动失败',
        `无法启动本地服务（试过端口 ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_TRIES - 1}）。\n\n` +
          `${e?.message ?? '未知错误'}\n\n` +
          `可以设置环境变量 MCLAUNCHER_PORT 指定空闲端口后重试。`
      );
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit();
    });
  });
}

/* ---------- 窗口控制（页面标题栏按钮走这里） ---------- */
ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:close', () => win?.close());
ipcMain.on('win:toggle-max', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle('win:is-maximized', () => Boolean(win?.isMaximized()));
ipcMain.handle('win:clipboard-write', async (_e, text) => {
  await clipboard.writeText(String(text ?? ''));
  return true;
});
ipcMain.handle('win:clipboard-read', async () => {
  let text = '';
  let html = '';
  // Electron 45 的 clipboard 是异步 W3C 风格：readText()/read()/writeText()。
  // 没有旧版同步 readHTML()，这里从 ClipboardItem 里取 text/html。
  try {
    const items = await clipboard.read();
    for (const item of items) {
      const types = item?.types ?? [];
      if (types.includes('text/plain')) {
        const blob = await item.getType('text/plain');
        if (blob && typeof blob.text === 'function') text = await blob.text();
      }
      if (types.includes('text/html')) {
        const blob = await item.getType('text/html');
        if (blob && typeof blob.text === 'function') html = await blob.text();
      }
    }
  } catch {
    /* 平台不支持 read() 时退回纯文本 */
  }
  if (!text) {
    try { text = await clipboard.readText(); } catch { /* ignore */ }
  }
  return { text, html };
});
ipcMain.handle('win:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择文件夹',
    properties: ['openDirectory'],
  });
  return r.canceled ? '' : (r.filePaths?.[0] ?? '');
});
ipcMain.handle('win:pick-file', async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择文件',
    properties: ['openFile'],
    filters: Array.isArray(filters) && filters.length ? filters : [{ name: '可执行文件', extensions: ['exe'] }],
  });
  return r.canceled ? '' : (r.filePaths?.[0] ?? '');
});

ipcMain.handle('win:install-update', async (_e, { installerPath, exePath, installDir }) => {
  if (!installerPath || !fs.existsSync(installerPath)) throw new Error('更新包不存在');
  const dir = installDir || path.dirname(exePath || process.execPath);
  const helper = path.join(os.tmpdir(), `sakura-update-${Date.now()}.ps1`);
  const script = `
param([string]$Setup,[string]$Exe,[string]$InstallDir,[int]$WaitPid)
try { Wait-Process -Id $WaitPid -Timeout 30 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 700
try {
  if ($InstallDir -match '(?i)Program Files') {
    Start-Process -FilePath $Setup -ArgumentList @('/S', "/D=$InstallDir") -Verb RunAs -Wait
  } else {
    Start-Process -FilePath $Setup -ArgumentList @('/S', "/D=$InstallDir") -Wait
  }
} catch {}
Start-Sleep -Milliseconds 1200
try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $Exe + '"') } catch {}
`;
  fs.writeFileSync(helper, script, 'utf8');
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-Setup', installerPath,
    '-Exe', exePath || process.execPath,
    '-InstallDir', dir,
    '-WaitPid', String(process.pid),
  ];
  const child = spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => app.quit(), 300);
  return true;
});

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function feedCandidates(feedUrl) {
  const u = String(feedUrl ?? '').trim().replace(/\/+$/, '');
  if (!u) return [];
  const list = [u];
  const mirror = 'https://gh-proxy.com/';
  const backup = 'https://ghproxy.net/';
  if (u.toLowerCase().startsWith(mirror)) {
    const direct = u.slice(mirror.length);
    list.push(direct, `${backup}${direct}`);
  } else if (u.toLowerCase().startsWith(backup)) {
    const direct = u.slice(backup.length);
    list.push(direct, `${mirror}${direct}`);
  } else if (/^https:\/\/github\.com\//i.test(u)) {
    list.push(`${mirror}${u}`, `${backup}${u}`);
  }
  return [...new Set(list)];
}

ipcMain.handle('win:auto-update', async (_e, { feedUrl }) => {
  const candidates = feedCandidates(feedUrl);
  let lastError = null;
  for (const url of candidates) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: `${url}/` });
      const result = await withTimeout(autoUpdater.checkForUpdates(), 60000, '检查更新超时（60 秒）');
      if (!result?.updateInfo) throw new Error('没有可用的更新清单');
      await withTimeout(autoUpdater.downloadUpdate(), 10 * 60 * 1000, '差分下载超时（10 分钟）');
      // true = 静默安装，true = 安装后自动重启
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 300);
      return true;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('更新检查失败');
});
ipcMain.handle('win:open-external', (_e, url) => {
  const u = new URL(String(url));
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('只允许打开 http(s) 链接');
  return shell.openExternal(u.toString());
});

// 窗口全关掉就退出进程 —— 这里的服务跟界面是一体的，留着也没人用
app.on('window-all-closed', () => {
  try {
    httpServer.close();
  } catch {
    /* 已经关了 */
  }
  app.quit();
});
