/** 首次安装引导状态与显式重置；不碰游戏实例/存档。 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { SETTINGS_FILE } from './settings.js';
import { ACCOUNTS_FILE } from './auth.js';
import { clearAllTokens } from './secure.js';

const HOME = path.join(os.homedir(), '.mclauncher');
const FILE = path.join(HOME, 'onboarding.json');

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeMarker(extra = {}) {
  await fsp.mkdir(HOME, { recursive: true });
  await fsp.writeFile(
    FILE,
    JSON.stringify({ completed: true, at: Date.now(), version: '0.6.0', ...extra }, null, 2),
    'utf8'
  );
}

export function onboardingState({ force = false, hadSettings = false } = {}) {
  const marker = readMarker();
  if (force) return { needed: true, forced: true, completed: false };
  if (marker?.completed) return { needed: false, forced: false, completed: true, at: marker.at ?? null };
  // settings 是在 getSettings() 里首次写入的，所以要用“启动前是否已有 settings”判断老用户
  if (hadSettings) {
    writeMarker({ migrated: true }).catch(() => {});
    return { needed: false, forced: false, completed: true, migrated: true };
  }
  return { needed: true, forced: false, completed: false };
}

export async function completeOnboarding() {
  await writeMarker();
  return { ok: true };
}

export async function resetOnboarding({ settings = true, accounts = false, secrets = false } = {}) {
  await fsp.rm(FILE, { force: true }).catch(() => {});
  if (settings) await fsp.rm(SETTINGS_FILE, { force: true }).catch(() => {});
  if (accounts) await fsp.rm(ACCOUNTS_FILE, { force: true }).catch(() => {});
  if (secrets) await clearAllTokens();
  return {
    ok: true,
    cleared: {
      settings: !fs.existsSync(SETTINGS_FILE),
      accounts: !fs.existsSync(ACCOUNTS_FILE),
      secrets: secrets ? !fs.existsSync(path.join(os.homedir(), '.mclauncher', 'online-secrets.json')) : false,
      onboarding: !fs.existsSync(FILE),
    },
  };
}
