import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SOURCE_PATH = resolve(__dirname, '..', 'src', 'antigravity-effort-slider.js');
export const DEFAULT_REPO_TARGET_PATH = resolve(
  __dirname,
  '..',
  'plugin',
  'sidecars',
  'effort-slider',
  'payload.js'
);

export function getInstalledPayloadPath() {
  const pluginDir = process.env.AGY_PLUGIN_DIR
    ? resolve(process.env.AGY_PLUGIN_DIR)
    : join(homedir(), '.gemini', 'config', 'plugins', 'codex-effort-slider');
  return join(pluginDir, 'sidecars', 'effort-slider', 'payload.js');
}

export const DEFAULT_TARGET_PATH = DEFAULT_REPO_TARGET_PATH;

/**
 * 計算檔案內容的完整 SHA-256 雜湊值。
 *
 * @param {string} filePath
 * @returns {string}
 */
export function hashFileSha256(filePath) {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function syncOneTarget(sourcePath, sourceSha256, targetPath, checkOnly) {
  let targetSha256 = existsSync(targetPath) ? hashFileSha256(targetPath) : '';
  let updated = false;

  if (sourceSha256 !== targetSha256) {
    if (checkOnly) {
      return {
        ok: false,
        targetPath,
        targetSha256,
        updated: false,
      };
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    targetSha256 = hashFileSha256(targetPath);
    updated = true;
  }

  return {
    ok: sourceSha256 === targetSha256,
    targetPath,
    targetSha256,
    updated,
  };
}

/**
 * 將前端滑桿程式碼同步至 repo 內 `plugin/` 與已安裝的外掛 sidecar payload（若存在），
 * 並確認 SHA-256 位元組一致。
 *
 * @param {{ sourcePath?: string, targetPath?: string, installedPath?: string, checkOnly?: boolean }} [options]
 */
export function syncPluginPayload({
  sourcePath = DEFAULT_SOURCE_PATH,
  targetPath = DEFAULT_REPO_TARGET_PATH,
  installedPath = getInstalledPayloadPath(),
  checkOnly = false,
} = {}) {
  if (!existsSync(sourcePath)) {
    throw new Error(`找不到來源檔案: ${sourcePath}`);
  }

  const sourceSha256 = hashFileSha256(sourcePath);
  const targets = [syncOneTarget(sourcePath, sourceSha256, targetPath, checkOnly)];

  const installedDir = resolve(installedPath, '..', '..', '..');
  if (resolve(installedPath) !== resolve(targetPath) && existsSync(installedDir)) {
    targets.push(syncOneTarget(sourcePath, sourceSha256, installedPath, checkOnly));
  }

  const allOk = targets.every((t) => t.ok);
  return {
    ok: allOk,
    sourcePath,
    targetPath,
    sourceSha256,
    targetSha256: targets[0].targetSha256,
    updated: targets.some((t) => t.updated),
    targets,
  };
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isCli) {
  const checkOnly = process.argv.includes('--check');
  try {
    const result = syncPluginPayload({ checkOnly });
    if (!result.ok) {
      for (const t of result.targets) {
        if (!t.ok) {
          console.error(
            `[FAIL] ${t.targetPath} 與來源尚未同步 (source=${result.sourceSha256}, target=${t.targetSha256 || 'missing'})`
          );
        }
      }
      process.exit(1);
    }
    for (const t of result.targets) {
      const action = t.updated ? '已同步更新' : '已一致';
      console.log(`[OK] ${action}: ${t.targetPath}`);
    }
    console.log(`SHA-256: ${result.sourceSha256}`);
  } catch (err) {
    console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
