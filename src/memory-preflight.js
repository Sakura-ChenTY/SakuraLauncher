/**
 * 启动/开房前的内存预算。
 *
 * 只算账，不启动进程。调用方确认后才写配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { getSettings, saveSettings } from './settings.js';

export const MEMORY_RESERVE_MB = 2048;

export function memoryMbFromText(value) {
  const m = /^(\d{1,5})\s*([MG])?$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  return m[2]?.toUpperCase() === 'G' ? Number(m[1]) * 1024 : Number(m[1]);
}

function instanceFile(gameDir, versionId) {
  return versionId ? path.join(gameDir, 'versions', versionId, 'launcher-instance.json') : null;
}

export function readClientMemoryMb(gameDir, versionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(instanceFile(gameDir, versionId), 'utf8'));
    return memoryMbFromText(raw.memoryMax) || memoryMbFromText(getSettings().memoryMax) || 2048;
  } catch {
    return memoryMbFromText(getSettings().memoryMax) || 2048;
  }
}

export function readSystemMemory() {
  const fallback = {
    totalMb: Math.round(os.totalmem() / 1024 / 1024),
    availableMb: Math.round(os.freemem() / 1024 / 1024),
    commitUsedMb: null,
    commitLimitMb: null,
    pagefileMb: null,
    pagefileUsedMb: null,
    pagefilePath: null,
    pagefileManaged: null,
    topProcesses: [],
  };
  try {
    const script = [
      '$os=Get-CimInstance Win32_OperatingSystem;',
      '$pf=Get-CimInstance Win32_PageFileUsage | Select-Object -First 1;',
      '$cs=Get-CimInstance Win32_ComputerSystem;',
      '$c=Get-Counter "\\Memory\\Committed Bytes","\\Memory\\Commit Limit" -ErrorAction SilentlyContinue;',
      '$cu=($c.CounterSamples|Where-Object Path -like "*committed bytes*").CookedValue;',
      '$cl=($c.CounterSamples|Where-Object Path -like "*commit limit*").CookedValue;',
      '$top=Get-Process|Sort-Object WorkingSet64 -Descending|Select-Object -First 8 Name,Id,WorkingSet64;',
      '[pscustomobject]@{',
      'totalMb=[math]::Round($os.TotalVisibleMemorySize/1024);',
      'availableMb=[math]::Round($os.FreePhysicalMemory/1024);',
      'commitUsedMb=[math]::Round($cu/1MB);',
      'commitLimitMb=[math]::Round($cl/1MB);',
      'pagefileMb=if($pf){$pf.AllocatedBaseSize}else{$null};',
      'pagefileUsedMb=if($pf){$pf.CurrentUsage}else{$null};',
      'pagefilePath=if($pf){$pf.Name}else{$null};',
      'pagefileManaged=$cs.AutomaticManagedPagefile;',
      'topProcesses=@($top|ForEach-Object{[pscustomobject]@{name=$_.Name;pid=$_.Id;workingSetMb=[math]::Round($_.WorkingSet64/1MB,1)}})',
      '} | ConvertTo-Json -Compress',
    ].join(' ');
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const data = JSON.parse(String(raw).trim());
    return { ...fallback, ...data, topProcesses: Array.isArray(data.topProcesses) ? data.topProcesses : [data.topProcesses].filter(Boolean) };
  } catch {
    return fallback;
  }
}

export function memoryCapMb() {
  return Math.max(1024, Math.min(40960, Math.floor((os.totalmem() / 1024 / 1024) * 0.8)));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function planMemory({
  mode = 'game',
  availableMb = Math.floor(os.freemem() / 1024 / 1024),
  clientMb = 2048,
  serverMb = 0,
  withClient = true,
  commitUsedMb = null,
  commitLimitMb = null,
  pagefileMb = null,
  pagefileUsedMb = null,
  pagefilePath = null,
  pagefileManaged = null,
  topProcesses = [],
} = {}) {
  const cap = memoryCapMb();
  const client = Math.max(1024, Math.min(cap, Number(clientMb) || 2048));
  const server = Math.max(1024, Math.min(cap, Number(serverMb) || 0));
  const roomClient = mode === 'room' ? withClient : true;
  const needed = ((roomClient ? client : 0) + (mode === 'room' ? server : 0)) + MEMORY_RESERVE_MB;
  const commitHeadroom = commitLimitMb != null && commitUsedMb != null
    ? Math.max(0, Number(commitLimitMb) - Number(commitUsedMb))
    : null;
  const commitShort = commitHeadroom != null && commitHeadroom < needed;
  const physicalShort = availableMb < needed;
  const ok = !physicalShort && !commitShort;
  const pagefileShort = pagefileMb != null && commitShort && Number(pagefileMb) < needed;
  const reasons = [];
  if (physicalShort) reasons.push('physical');
  if (commitShort) reasons.push('commit');
  if (pagefileShort) reasons.push('pagefile');
  const budget = Math.max(0, availableMb - MEMORY_RESERVE_MB);
  let recClient = roomClient ? client : 0;
  let recServer = mode === 'room' ? server : 0;
  if (!ok) {
    if (mode === 'room') {
      // 两边都按 60% 上限，再压到总预算内；两边各保底 1024M。
      const eachLimit = Math.max(1024, Math.min(Math.floor(availableMb * 0.6), Math.max(1024, budget)));
      recClient = roomClient ? clamp(Math.min(client, eachLimit), 1024, cap) : 0;
      recServer = clamp(Math.min(server, eachLimit), 1024, cap);
      if (recClient + recServer > budget) {
        const excess = recClient + recServer - budget;
        const cutServer = Math.min(excess, Math.max(0, recServer - 1024));
        recServer -= cutServer;
        const rest = excess - cutServer;
        recClient = Math.max(roomClient ? 1024 : 0, recClient - rest);
      }
    } else {
      const fit = Math.max(1024, availableMb - MEMORY_RESERVE_MB);
      recClient = clamp(Math.min(client, Math.floor(availableMb * 0.6), fit), 1024, cap);
    }
  }
  const recommendedNeeded = ((roomClient ? recClient : 0) + (mode === 'room' ? recServer : 0)) + MEMORY_RESERVE_MB;
  const recommendPagefileGb = pagefileShort
    ? Math.max(1, Math.ceil((Number(commitUsedMb || 0) + needed) / 1024))
    : null;
  return {
    mode,
    availableMb,
    requiredMb: needed,
    shortfallMb: Math.max(0, needed - availableMb),
    clientMb: roomClient ? client : 0,
    serverMb: mode === 'room' ? server : 0,
    recommendClientMb: recClient,
    recommendServerMb: mode === 'room' ? recServer : 0,
    recommendRequiredMb: recommendedNeeded,
    capMb: cap,
    ok,
    commitUsedMb,
    commitLimitMb,
    commitHeadroomMb: commitHeadroom,
    commitShort,
    pagefileMb,
    pagefileUsedMb,
    pagefilePath,
    pagefileManaged,
    pagefileShort,
    physicalShort,
    reasons,
    topProcesses: Array.isArray(topProcesses) ? topProcesses : [],
    recommendPagefileGb,
  };
}

export function preflightMemory({ mode = 'game', gameDir, versionId, roomMemoryMb, joinGame = true } = {}) {
  const client = readClientMemoryMb(gameDir, versionId);
  const configuredRoom = Number(roomMemoryMb) > 0 ? Number(roomMemoryMb) : Number(getSettings().roomMemoryMb) > 0
    ? Number(getSettings().roomMemoryMb)
    : 2048;
  const system = readSystemMemory();
  return planMemory({
    mode,
    availableMb: system.availableMb,
    clientMb: client,
    serverMb: configuredRoom,
    withClient: mode === 'room' ? Boolean(joinGame) : true,
    ...system,
  });
}

export async function applyMemoryPlan({ gameDir, versionId, clientMb, serverMb }) {
  const cap = memoryCapMb();
  if (clientMb != null) {
    const value = Math.max(1024, Math.min(cap, Math.round(Number(clientMb))));
    const file = instanceFile(gameDir, versionId);
    if (!file) throw new Error('没有实例，不能写内存');
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
    data.memoryMax = `${value}M`;
    if (!data.memoryMin) data.memoryMin = '512M';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }
  if (serverMb != null) {
    const value = Math.max(256, Math.min(memoryCapMb(), Math.round(Number(serverMb))));
    await saveSettings({ roomMemoryMb: value });
  }
  return getSettings();
}
