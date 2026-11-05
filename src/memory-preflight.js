/**
 * 启动/开房前的内存预算。
 *
 * 只算账，不启动进程。调用方确认后才写配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
} = {}) {
  const cap = memoryCapMb();
  const client = Math.max(1024, Math.min(cap, Number(clientMb) || 2048));
  const server = Math.max(1024, Math.min(cap, Number(serverMb) || 0));
  const roomClient = mode === 'room' ? withClient : true;
  const needed = ((roomClient ? client : 0) + (mode === 'room' ? server : 0)) + MEMORY_RESERVE_MB;
  const ok = availableMb >= needed;
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
  };
}

export function preflightMemory({ mode = 'game', gameDir, versionId, roomMemoryMb, joinGame = true } = {}) {
  const client = readClientMemoryMb(gameDir, versionId);
  const configuredRoom = Number(roomMemoryMb) > 0 ? Number(roomMemoryMb) : Number(getSettings().roomMemoryMb) > 0
    ? Number(getSettings().roomMemoryMb)
    : 2048;
  return planMemory({
    mode,
    clientMb: client,
    serverMb: configuredRoom,
    withClient: mode === 'room' ? Boolean(joinGame) : true,
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
