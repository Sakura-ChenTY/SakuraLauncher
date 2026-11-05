/**
 * Windows 工作集回收。
 *
 * 这里不是“加速器”：只是请求进程把暂时不用的工作集交还给系统。
 * 页面会被重新读回，释放量也可能马上被系统和应用重新占用。
 */
import os from 'node:os';
import { execFile } from 'node:child_process';

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SakuraMemoryTrim {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr h);
  [DllImport("psapi.dll", SetLastError = true)]
  private static extern bool EmptyWorkingSet(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetProcessWorkingSetSizeEx(IntPtr h, IntPtr min, IntPtr max, uint flags);

  public static string Trim(int pid) {
    const uint access = 0x0400 | 0x0100; // QUERY_INFORMATION | SET_QUOTA
    IntPtr h = OpenProcess(access, false, pid);
    if (h == IntPtr.Zero) return "open:" + Marshal.GetLastWin32Error();
    try {
      bool ok = EmptyWorkingSet(h);
      if (!ok) ok = SetProcessWorkingSetSizeEx(h, new IntPtr(-1), new IntPtr(-1), 0);
      return ok ? "ok" : "trim:" + Marshal.GetLastWin32Error();
    } finally {
      CloseHandle(h);
    }
  }
}
"@

$mode = [string]$env:MEM_MODE
$targetPid = 0
[void][int]::TryParse([string]$env:MEM_PID, [ref]$targetPid)
$excludePids = @($PID)
if ($env:MEM_EXCLUDE_PIDS) {
  foreach ($x in ($env:MEM_EXCLUDE_PIDS -split ',')) {
    $n = 0
    if ([int]::TryParse($x, [ref]$n)) { $excludePids += $n }
  }
}
$excludeNames = @(
  'system','idle','registry','smss','csrss','wininit','winlogon','services',
  'lsass','svchost','dwm','fontdrvhost','spoolsv','audiodg','wmiprvse',
  'memory compression','secure system','msmpeng','securityhealthservice','searchindexer','explorer','runtimebroker',
  'startmenuexperiencehost','shellexperiencehost','electron','node','powershell',
  'pwsh','java','javaw','minecraft','sakuralauncher','sakura-launcher'
)

function Get-Trimable {
  Get-Process | Where-Object {
    $name = $_.ProcessName.ToLowerInvariant()
    ($excludePids -notcontains $_.Id) -and
    ($excludeNames -notcontains $name) -and
    ($name -notlike 'sakura*') -and
    ($name -notlike 'minecraft*') -and
    ($name -notlike 'java*')
  }
}

function Process-Trim($p) {
  $before = [int64]$p.WorkingSet64
  $result = [SakuraMemoryTrim]::Trim([int]$p.Id)
  Start-Sleep -Milliseconds 120
  $after = $before
  try { $after = [int64](Get-Process -Id $p.Id -ErrorAction Stop).WorkingSet64 } catch { }
  [pscustomobject]@{
    pid = [int]$p.Id
    name = [string]$p.ProcessName
    before = $before
    after = $after
    released = [Math]::Max(0, $before - $after)
    result = $result
  }
}

if ($mode -eq 'trim' -and $targetPid -gt 0) {
  $p = Get-Process -Id $targetPid -ErrorAction Stop
  $name = $p.ProcessName.ToLowerInvariant()
  if (($excludePids -contains $targetPid) -or ($excludeNames -contains $name) -or
      ($name -like 'sakura*') -or ($name -like 'minecraft*') -or ($name -like 'java*')) {
    throw '这个进程已被排除，不能回收'
  }
  $row = Process-Trim $p
  $row | ConvertTo-Json -Compress
} elseif ($mode -eq 'trimall') {
  $rows = @()
  foreach ($p in (Get-Trimable | Sort-Object WorkingSet64 -Descending | Select-Object -First 30)) {
    try { $rows += Process-Trim $p } catch { }
  }
  @{ processes = $rows } | ConvertTo-Json -Compress -Depth 5
} else {
  $rows = @(
    Get-Trimable | Sort-Object WorkingSet64 -Descending | Select-Object -First 30 |
      ForEach-Object {
        [pscustomobject]@{
          pid = [int]$_.Id
          name = [string]$_.ProcessName
          workingSet = [int64]$_.WorkingSet64
        }
      }
  )
  @{ processes = $rows } | ConvertTo-Json -Compress -Depth 5
}
`;

function runPowerShell(mode, pid = 0) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
    const env = {
      ...process.env,
      MEM_MODE: mode,
      MEM_PID: String(pid || 0),
      MEM_EXCLUDE_PIDS: String(process.pid),
    };
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env, timeout: 25000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || stdout || err.message).trim().slice(0, 500);
          reject(new Error(`内存操作失败：${detail || err.message}`));
          return;
        }
        try {
          const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
          resolve(JSON.parse(line));
        } catch {
          reject(new Error('内存工具返回了无法解析的数据'));
        }
      }
    );
  });
}

export async function listMemoryProcesses() {
  const data = await runPowerShell('list');
  return {
    processes: (data.processes || []).map((p) => ({
      pid: Number(p.pid),
      name: String(p.name || ''),
      workingSet: Number(p.workingSet || 0),
    })),
  };
}

export async function optimizeMemory(pid = 0) {
  const freeBefore = os.freemem();
  const total = os.totalmem();
  const data = await runPowerShell(pid ? 'trim' : 'trimall', pid);
  const freeAfter = os.freemem();
  const rows = data.processes ? data.processes : [data];
  const processes = rows.map((p) => ({
    pid: Number(p.pid || 0),
    name: String(p.name || ''),
    before: Number(p.before || 0),
    after: Number(p.after || 0),
    released: Number(p.released || 0),
    result: String(p.result || ''),
  }));
  return {
    total,
    freeBefore,
    freeAfter,
    totalFreeDelta: freeAfter - freeBefore,
    processes,
    released: processes.reduce((n, p) => n + (p.released > 0 ? p.released : 0), 0),
  };
}
