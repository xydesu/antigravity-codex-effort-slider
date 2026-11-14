import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PAYLOAD_PATH = join(__dirname, 'payload.js');

const MAIN_PAGE_URL_RE = /^https:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i;
const LOOPBACK_WS_RE = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i;

/**
 * 依序計算 DevToolsActivePort 候選路徑。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [homeDir]
 * @returns {string[]}
 */
export function resolveDevToolsPortCandidates(
  env = process.env,
  platform = process.platform,
  homeDir = homedir()
) {
  const candidates = [];
  const overridePath = String(env?.ANTIGRAVITY_DEVTOOLS_PORT_FILE || '').trim();
  if (overridePath) {
    candidates.push(overridePath);
  }

  if (platform === 'win32') {
    const appData = env?.APPDATA || join(homeDir, 'AppData', 'Roaming');
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    candidates.push(
      join(appData, 'Antigravity', 'DevToolsActivePort'),
      join(localAppData, 'Antigravity', 'DevToolsActivePort')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      join(homeDir, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')
    );
  } else {
    const xdgConfig = env?.XDG_CONFIG_HOME || join(homeDir, '.config');
    candidates.push(join(xdgConfig, 'Antigravity', 'DevToolsActivePort'));
  }

  return [...new Set(candidates)];
}

/**
 * 解析 DevToolsActivePort 檔案第一行的監聽連接埠。
 *
 * @param {string} rawText
 * @returns {number | null}
 */
export function parseDevToolsPortFile(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const firstLine = rawText.split(/\r?\n/, 1)[0].trim();
  if (!/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * 判斷 CDP target 是否為 Antigravity 主聊天視窗頁面，排除 vscode-webview 等嵌入目標。
 *
 * @param {Record<string, unknown>} target
 * @returns {boolean}
 */
export function isAntigravityMainPageTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.type !== 'page') return false;
  if (typeof target.url !== 'string' || !MAIN_PAGE_URL_RE.test(target.url)) return false;
  if (
    typeof target.webSocketDebuggerUrl !== 'string' ||
    !LOOPBACK_WS_RE.test(target.webSocketDebuggerUrl)
  ) {
    return false;
  }
  return true;
}

/**
 * 依候選路徑尋找目前有效的 CDP 連接埠。
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, homeDir?: string }} [options]
 * @returns {number | null}
 */
export function findActiveDevToolsPort({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
} = {}) {
  const candidates = resolveDevToolsPortCandidates(env, platform, homeDir);
  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue;
      const port = parseDevToolsPortFile(readFileSync(filePath, 'utf8'));
      if (port) return port;
    } catch {
      // 忽略單一不可讀檔案，繼續檢查下一候選位置
    }
  }
  return null;
}

/**
 * 透過本機 CDP HTTP 端點取得並過濾主聊天視窗目標清單。
 *
 * @param {number} cdpPort
 * @param {{ httpModule?: typeof http, timeoutMs?: number }} [options]
 * @returns {Promise<Array<{ id?: string, title?: string, url: string, webSocketDebuggerUrl: string }>>}
 */
export async function listMainWindowTargets(
  cdpPort,
  { httpModule = http, timeoutMs = 1500 } = {}
) {
  const rawBody = await new Promise((resolve, reject) => {
    const req = httpModule.get(`http://127.0.0.1:${cdpPort}/json/list`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`CDP HTTP ${res.statusCode}`));
        return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve(text));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('CDP /json/list timeout')));
    req.on('error', reject);
  });

  const parsed = JSON.parse(rawBody);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isAntigravityMainPageTarget);
}

/**
 * 透過 CDP WebSocket 在指定頁面執行 Runtime.evaluate。
 *
 * @param {string} wsUrl
 * @param {string} expression
 * @param {{ WebSocketImpl?: typeof WebSocket, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export async function evaluateOnTarget(
  wsUrl,
  expression,
  { WebSocketImpl, timeoutMs = 2500 } = {}
) {
  const WS = WebSocketImpl || globalThis.WebSocket;
  if (typeof WS !== 'function') {
    throw new Error('WebSocket runtime unavailable');
  }

  let ws = null;
  let timer = null;
  try {
    ws = new WS(wsUrl);
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      timer = setTimeout(() => {
        done(reject, new Error('CDP Runtime.evaluate timeout'));
      }, timeoutMs);

      const onOpen = () => {
        try {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: {
                expression,
                returnByValue: true,
                awaitPromise: true,
              },
            })
          );
        } catch (err) {
          done(reject, err instanceof Error ? err : new Error(String(err)));
        }
      };

      const onMessage = (ev) => {
        try {
          const raw = typeof ev?.data === 'string' ? ev.data : String(ev?.data ?? '');
          const msg = JSON.parse(raw);
          if (msg && msg.id === 1) {
            if (msg.error) {
              done(reject, new Error(msg.error.message || 'CDP Runtime.evaluate error'));
              return;
            }
            done(resolve, msg);
          }
        } catch {
          // 忽略非目標或無法解析的事件幀
        }
      };

      const onError = (err) => {
        done(reject, err instanceof Error ? err : new Error('CDP WebSocket error'));
      };

      const onClose = () => {
        done(reject, new Error('CDP WebSocket closed before response'));
      };

      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener('close', onClose, { once: true });
    });
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (ws) {
      try {
        ws.close();
      } catch {
        // 忽略關閉時的例外
      }
    }
  }
}

/**
 * 計算 payload 原始碼的簡短 SHA-256 指紋，作為版本漂移判斷依據。
 *
 * @param {string} payloadSource
 * @returns {string}
 */
export function computeBundleVersion(payloadSource) {
  return createHash('sha256').update(String(payloadSource || ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 建構管理 CDP 輪詢探測、熱注入、版本漂移重注與卸載清理的控制器。
 *
 * @param {object} [options]
 */
export function createCdpBridgeController(options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    homeDir = homedir(),
    WebSocketImpl,
    httpModule = http,
    payloadPath = DEFAULT_PAYLOAD_PATH,
    readPayload = () => readFileSync(payloadPath, 'utf8'),
    getBundleVersion,
    bundleVersion: fixedBundleVersion,
    initialDelayMs = 300,
    pollIntervalMs = 1200,
    cdpTimeoutMs = 2500,
  } = options;

  let stopped = false;
  let running = false;
  let initialTimer = null;
  let pollTimer = null;
  let activeSyncPromise = null;

  const status = {
    running: false,
    stopped: false,
    cdpPort: null,
    targetCount: 0,
    aliveCount: 0,
    injectedCount: 0,
    totalInjections: 0,
    bundleVersion: '',
    lastReason: 'idle',
    lastError: null,
    lastSyncAt: null,
  };

  function resolveVersion(payloadSource) {
    if (typeof getBundleVersion === 'function') {
      return String(getBundleVersion(payloadSource) || '');
    }
    if (fixedBundleVersion) {
      return String(fixedBundleVersion);
    }
    return computeBundleVersion(payloadSource);
  }

  async function runSyncInternal({ forceReinject = false } = {}) {
    if (stopped) {
      status.lastReason = 'stopped';
      return { ok: false, reason: 'stopped', injected: 0, alive: 0, targets: 0 };
    }

    let payloadSource = '';
    try {
      payloadSource = readPayload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.lastReason = 'payload_missing';
      status.lastError = msg;
      status.lastSyncAt = new Date().toISOString();
      return { ok: false, reason: 'payload_missing', error: msg, injected: 0, alive: 0, targets: 0 };
    }

    const bundleVersion = resolveVersion(payloadSource);
    status.bundleVersion = bundleVersion;

    const cdpPort = findActiveDevToolsPort({ env, platform, homeDir });
    status.cdpPort = cdpPort;
    if (!cdpPort) {
      status.targetCount = 0;
      status.aliveCount = 0;
      status.injectedCount = 0;
      status.lastReason = 'no_devtools_port';
      status.lastError = null;
      status.lastSyncAt = new Date().toISOString();
      return { ok: false, reason: 'no_devtools_port', bundleVersion, injected: 0, alive: 0, targets: 0 };
    }

    let targets = [];
    try {
      targets = await listMainWindowTargets(cdpPort, { httpModule, timeoutMs: cdpTimeoutMs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.targetCount = 0;
      status.aliveCount = 0;
      status.injectedCount = 0;
      status.lastReason = 'cdp_unreachable';
      status.lastError = msg;
      status.lastSyncAt = new Date().toISOString();
      return { ok: false, reason: 'cdp_unreachable', error: msg, cdpPort, bundleVersion, injected: 0, alive: 0, targets: 0 };
    }

    status.targetCount = targets.length;
    if (targets.length === 0) {
      status.aliveCount = 0;
      status.injectedCount = 0;
      status.lastReason = 'no_targets';
      status.lastError = null;
      status.lastSyncAt = new Date().toISOString();
      return { ok: true, reason: 'no_targets', cdpPort, bundleVersion, injected: 0, alive: 0, targets: 0 };
    }

    const probeExpr = `(() => {
      try {
        const loaded = Boolean(window.__agCodexEffortSliderLoaded);
        const ctrl = window.__agCodexEffortSlider;
        const alive = Boolean(ctrl && typeof ctrl.ensureAlive === 'function' && ctrl.ensureAlive());
        const bundleVersion = String(ctrl?.bundleVersion || window.__agCodexEffortSliderConfig?.bundleVersion || '');
        return { loaded, alive, bundleVersion };
      } catch {
        return { loaded: false, alive: false, bundleVersion: '' };
      }
    })()`;

    const injectExpr = `(() => {
      try { window.__agCodexEffortSlider?.dispose?.(); } catch {}
      try {
        delete window.__agCodexEffortSliderLoaded;
        delete window.__agCodexEffortSlider;
      } catch {}
      window.__agCodexEffortSliderConfig = ${JSON.stringify({ bundleVersion })};
      ${payloadSource}
      return {
        loaded: Boolean(window.__agCodexEffortSliderLoaded),
        alive: Boolean(window.__agCodexEffortSlider?.ensureAlive?.()),
        bundleVersion: String(window.__agCodexEffortSlider?.bundleVersion || window.__agCodexEffortSliderConfig?.bundleVersion || ''),
      };
    })()`;

    let injected = 0;
    let alive = 0;
    let lastTargetError = null;

    for (const target of targets) {
      try {
        if (!forceReinject) {
          const probeRes = await evaluateOnTarget(target.webSocketDebuggerUrl, probeExpr, {
            WebSocketImpl,
            timeoutMs: cdpTimeoutMs,
          });
          const snap = probeRes?.result?.result?.value;
          if (
            snap &&
            snap.loaded === true &&
            snap.alive === true &&
            snap.bundleVersion === bundleVersion
          ) {
            alive += 1;
            continue;
          }
        }

        await evaluateOnTarget(target.webSocketDebuggerUrl, injectExpr, {
          WebSocketImpl,
          timeoutMs: cdpTimeoutMs,
        });
        injected += 1;
        alive += 1;
      } catch (err) {
        lastTargetError = err instanceof Error ? err.message : String(err);
      }
    }

    status.aliveCount = alive;
    status.injectedCount = injected;
    status.totalInjections += injected;
    status.lastReason = lastTargetError && alive === 0 ? 'target_eval_failed' : 'synced';
    status.lastError = lastTargetError;
    status.lastSyncAt = new Date().toISOString();

    return {
      ok: lastTargetError === null || alive > 0,
      reason: status.lastReason,
      cdpPort,
      bundleVersion,
      targets: targets.length,
      alive,
      injected,
      error: lastTargetError,
    };
  }

  async function syncAllWindows(opts = {}) {
    if (activeSyncPromise) {
      return activeSyncPromise;
    }
    activeSyncPromise = runSyncInternal(opts).finally(() => {
      activeSyncPromise = null;
    });
    return activeSyncPromise;
  }

  function scheduleNextPoll() {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      syncAllWindows()
        .catch(() => {})
        .finally(() => {
          scheduleNextPoll();
        });
    }, pollIntervalMs);
    pollTimer.unref?.();
  }

  function start() {
    stopped = false;
    running = true;
    status.running = true;
    status.stopped = false;

    if (initialTimer) clearTimeout(initialTimer);
    if (pollTimer) clearTimeout(pollTimer);

    initialTimer = setTimeout(() => {
      initialTimer = null;
      syncAllWindows()
        .catch(() => {})
        .finally(() => {
          scheduleNextPoll();
        });
    }, initialDelayMs);
    initialTimer.unref?.();
  }

  async function stop({ disposeWindows = false } = {}) {
    stopped = true;
    running = false;
    status.running = false;
    status.stopped = true;

    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    if (activeSyncPromise) {
      await activeSyncPromise.catch(() => {});
    }

    let disposed = 0;
    if (disposeWindows) {
      const cdpPort = findActiveDevToolsPort({ env, platform, homeDir });
      if (cdpPort) {
        const targets = await listMainWindowTargets(cdpPort, {
          httpModule,
          timeoutMs: cdpTimeoutMs,
        }).catch(() => []);
        const disposeExpr = `(() => {
          try {
            const existed = Boolean(window.__agCodexEffortSlider || window.__agCodexEffortSliderLoaded);
            window.__agCodexEffortSlider?.dispose?.();
            delete window.__agCodexEffortSliderLoaded;
            delete window.__agCodexEffortSlider;
            delete window.__agCodexEffortSliderConfig;
            return existed;
          } catch {
            return false;
          }
        })()`;
        for (const target of targets) {
          try {
            const res = await evaluateOnTarget(target.webSocketDebuggerUrl, disposeExpr, {
              WebSocketImpl,
              timeoutMs: cdpTimeoutMs,
            });
            if (res?.result?.result?.value === true) {
              disposed += 1;
            }
          } catch {
            // 單一視窗離線或關閉時不阻斷其餘視窗還原
          }
        }
      }
      status.aliveCount = 0;
      status.injectedCount = 0;
    }

    status.lastReason = 'stopped';
    return { stopped: true, disposed };
  }

  return {
    syncAllWindows,
    start,
    stop,
    getStatus: () => ({ ...status, running, stopped }),
  };
}
