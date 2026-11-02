/**
 * 启动自检：Node 版本
 *
 * 为什么要有这个：代码用到 fetch / AbortSignal.timeout（需要 Node 18+）。
 * 版本太低时，报错会出现在语法解析阶段或某个深层调用里，对使用者毫无意义。
 * 这里在入口最前面挡一道，直接把「该装哪个版本」说出来。
 */
const REQUIRED_MAJOR = 18;

export function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= REQUIRED_MAJOR) return { ok: true, major };

  const message =
    `Sakura Minecraft Launcher 需要 Node.js ${REQUIRED_MAJOR} 或更高版本，当前是 ${process.versions.node}。\n\n` +
    `请到 https://nodejs.org 安装 LTS 版本后重试。`;
  return { ok: false, major, message };
}
