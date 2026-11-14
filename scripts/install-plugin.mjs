import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncPluginPayload } from './sync-plugin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_PLUGIN_DIR = resolve(__dirname, '..', 'plugin');

export function getInstalledPluginDir() {
  if (process.env.AGY_PLUGIN_DIR) {
    return resolve(process.env.AGY_PLUGIN_DIR);
  }
  return join(homedir(), '.gemini', 'config', 'plugins', 'codex-effort-slider');
}

/**
 * 將 Repo 內的外掛套件完整安裝至 `~/.gemini/config/plugins/codex-effort-slider`。
 *
 * @param {{ sourceDir?: string, targetDir?: string }} [options]
 * @returns {{ ok: boolean, sourceDir: string, targetDir: string, sha256: string }}
 */
export function installPluginBundle({
  sourceDir = REPO_PLUGIN_DIR,
  targetDir = getInstalledPluginDir(),
} = {}) {
  if (!existsSync(sourceDir)) {
    throw new Error(`找不到外掛來源目錄: ${sourceDir}`);
  }
  const syncRes = syncPluginPayload();
  if (!syncRes.ok) {
    throw new Error('同步前端程式碼至 repo plugin/sidecars/effort-slider/payload.js 失敗');
  }

  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true });

  return {
    ok: true,
    sourceDir,
    targetDir,
    sha256: syncRes.sourceSha256,
  };
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isCli) {
  try {
    const res = installPluginBundle();
    console.log(`[OK] 已安裝外掛至: ${res.targetDir}`);
    console.log(`SHA-256: ${res.sha256}`);
  } catch (err) {
    console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
