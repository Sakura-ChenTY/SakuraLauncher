/**
 * 启动器文件日志：超过上限先轮转，最多保留固定数量的旧文件。
 * 单独放置便于直接用临时目录做 6MB 轮转测试。
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_MAX_OLD = 3;

function removeOlderThan(file, maxOld) {
  const dir = path.dirname(file);
  const base = path.basename(file) + '.';
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(base)) continue;
    const n = Number(name.slice(base.length));
    if (Number.isInteger(n) && n > maxOld) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
    }
  }
}

function rotate(file, maxOld) {
  removeOlderThan(file, maxOld);
  for (let i = maxOld; i >= 2; i -= 1) {
    const from = `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    if (!fs.existsSync(from)) continue;
    try { fs.rmSync(to, { force: true }); } catch { /* ignore */ }
    try { fs.renameSync(from, to); } catch { /* ignore */ }
  }
  try {
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
  } catch { /* ignore */ }
}

export function appendLogLine(file, line, { maxBytes = LOG_MAX_BYTES, maxOld = LOG_MAX_OLD } = {}) {
  const text = String(line);
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let size = 0;
  try { size = fs.statSync(target).size; } catch { /* no file yet */ }
  if (size + Buffer.byteLength(text, 'utf8') > maxBytes) rotate(target, maxOld);
  fs.appendFileSync(target, text, 'utf8');
}

export function rotateLogFile(file, { maxOld = LOG_MAX_OLD } = {}) {
  rotate(path.resolve(file), maxOld);
}
