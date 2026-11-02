#!/usr/bin/env node
/**
 * GUI 启动入口：起本地 Web 服务并打开浏览器
 *
 *   node src\gui.js
 *   node src\gui.js --game-dir D:\Tools\mclauncher\test-mc --port 7801 --no-open
 */
import { spawn } from 'node:child_process';
import { startServer } from './server.js';
import { DEFAULT_GAME_DIR } from './launch.js';

function parseArgs(argv) {
  const out = { gameDir: DEFAULT_GAME_DIR, port: 7801, open: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--game-dir') out.gameDir = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--no-open') out.open = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const opts = parseArgs(process.argv);

if (opts.help) {
  console.log(`用法:
  node src/gui.js [--game-dir <path>] [--port 7801] [--no-open]

默认游戏目录: ${DEFAULT_GAME_DIR}
默认地址: http://127.0.0.1:7801/
`);
  process.exit(0);
}

try {
  const { url } = await startServer({ port: opts.port, gameDir: opts.gameDir });
  console.log(`Sakura Minecraft Launcher UI: ${url}`);
  console.log(`游戏目录: ${opts.gameDir}`);
  console.log('按 Ctrl+C 停止服务');

  if (opts.open) {
    // Windows 下用 start 打开默认浏览器
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  }

  process.on('SIGINT', () => {
    console.log('\n已停止');
    process.exit(0);
  });
} catch (e) {
  console.error('启动服务失败：' + e.message);
  process.exit(1);
}
