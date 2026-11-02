#!/usr/bin/env node
/**
 * 命令行入口
 *
 *   node src/cli.js --list
 *   node src/cli.js --remote                    列出可安装的正式版
 *   node src/cli.js --install 1.21.11           安装到默认游戏目录
 *   node src/cli.js --install 1.21.11 --game-dir D:/mc-test
 *   node src/cli.js --version <实例名> --dry-run
 *   node src/cli.js --version <实例名> --username Steve
 */
import path from 'node:path';
import { launch, listVersions, DEFAULT_GAME_DIR } from './launch.js';
import { installVersion, getVersionManifest, latestReleases } from './installer.js';

function parseArgs(argv) {
  const out = { gameDir: DEFAULT_GAME_DIR, concurrency: 8 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--list': out.list = true; break;
      case '--remote': out.remote = true; break;
      case '--install': out.install = argv[++i]; break;
      case '--dry-run': out.dryRun = true; break;
      case '--version': out.versionId = argv[++i]; break;
      case '--game-dir': out.gameDir = argv[++i]; break;
      case '--username': out.username = argv[++i]; break;
      case '--java': out.java = argv[++i]; break;
      case '--concurrency': out.concurrency = Number(argv[++i]); break;
      case '--help':
      case '-h': out.help = true; break;
      default:
        if (a.startsWith('--jvm=')) out.extraJvm = [...(out.extraJvm ?? []), a.slice(6)];
        break;
    }
  }
  return out;
}

const opts = parseArgs(process.argv);

if (opts.help) {
  console.log(`用法:
  node src/cli.js --list
  node src/cli.js --remote
  node src/cli.js --install <版本号> [--game-dir <path>] [--concurrency 8]
  node src/cli.js --version <实例名> [--username <name>] [--dry-run]

说明:
  --list          列出本地已装实例
  --remote        列出官方可安装的正式版
  --install       下载并安装指定版本（含 client/libraries/assets）
  --version       启动本地实例
  --dry-run       只打印启动命令，不真的启动
`);
  process.exit(0);
}

function fmtBytes(n) {
  if (!n) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${u[i]}`;
}

if (opts.list) {
  const list = listVersions(path.join(opts.gameDir, 'versions'));
  console.log(`共 ${list.length} 个实例：`);
  for (const v of list) console.log('  ' + v);
  process.exit(0);
}

if (opts.remote) {
  try {
    const manifest = await getVersionManifest(path.join(opts.gameDir, 'version_manifest_v2.json'));
    const rel = latestReleases(manifest, 15);
    console.log('最新正式版：');
    for (const v of rel) console.log(`  ${v.id.padEnd(14)} ${v.releaseTime?.slice(0, 10) ?? ''}`);
    console.log(`\n清单共 ${manifest.versions?.length ?? 0} 个版本`);
  } catch (e) {
    console.error('获取清单失败：' + e.message);
    process.exit(1);
  }
  process.exit(0);
}

if (opts.install) {
  const t0 = Date.now();
  let lastStage = '';
  let lastPrint = 0;
  try {
    const report = await installVersion({
      gameDir: opts.gameDir,
      versionId: opts.install,
      concurrency: opts.concurrency,
      onStage: ({ stage, message }) => {
        lastStage = stage;
        console.log(`\n[${stage}] ${message}`);
      },
      onProgress: (p) => {
        if (p.stage !== lastStage) return;
        const now = Date.now();
        if (now - lastPrint < 800 && p.done !== p.total) return;
        lastPrint = now;
        const pct = p.total ? ((p.done / p.total) * 100).toFixed(1) : '0.0';
        process.stdout.write(
          `\r  ${p.done}/${p.total} (${pct}%)  跳过 ${p.skipped}  新下 ${p.downloaded}  失败 ${p.errors}   `
        );
        if (p.done === p.total) process.stdout.write('\n');
      },
    });

    console.log('\n=== 安装结果 ===');
    console.log(JSON.stringify(report, null, 2));
    console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.error('\n安装失败：' + e.message);
    process.exit(1);
  }
}

if (!opts.versionId) {
  console.error('缺少 --version 或 --install。用 --help 查看用法。');
  process.exit(2);
}

try {
  const r = await launch(opts);

  if (opts.dryRun) {
    console.log('=== java ===');
    console.log(r.command.java);
    console.log('\n=== classpath 条目数 ===');
    console.log(r.classpathCount);
    console.log('\n=== natives ===');
    console.log(`目录: ${r.nativesDir}`);
    console.log(`解出 ${r.extractedNatives.length} 个文件`);
    console.log('\n=== 缺失的库 ===');
    console.log(r.missingLibraries.length ? r.missingLibraries.map((m) => m.name).join('\n') : '无');
    console.log('\n=== 未解析占位符 ===');
    console.log(r.unresolved.length ? r.unresolved.join('\n') : '无');
    console.log('\n=== 完整参数 ===');
    console.log(r.command.args.map((x, i) => `${i}: ${x}`).join('\n'));
    process.exit(r.missingLibraries.length ? 1 : 0);
  }

  // launch() 现在用 pipe，不接走就会在约 64KB 后把 Java 阻塞在写 stdout。
  // 命令行这条路必须自己把两路数据排空。
  r.child.stdout?.pipe(process.stdout);
  r.child.stderr?.pipe(process.stderr);

  console.log(`已启动 PID ${r.child.pid}`);
  r.child.on('exit', (code) => {
    console.log(`游戏退出，code=${code}`);
    process.exit(code ?? 0);
  });
} catch (e) {
  console.error('启动失败：' + e.message);
  process.exit(1);
}
