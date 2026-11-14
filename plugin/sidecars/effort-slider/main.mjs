import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { createCdpBridgeController } from './cdp-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LS_ADDR = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

/**
 * 校驗請求是否來自本機回環同埠位址或受信 Webview Origin，防止跨站存取本機控制端點。
 *
 * @param {object} req
 * @returns {boolean}
 */
export function isLocalHostRequest(req) {
  if (!req?.headers) return true;
  const host = String(req.headers.host || '').trim().toLowerCase();
  const hostMatch = host.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
  if (host && !hostMatch) {
    return false;
  }
  const origin = String(req.headers.origin || '').trim().toLowerCase();
  if (origin && /^vscode-webview:\/\/[a-z0-9._-]+$/.test(origin)) {
    return true;
  }
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return false;
  }
  if (origin) {
    const originMatch = origin.match(
      /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/
    );
    if (!originMatch) {
      return false;
    }
    if (hostMatch) {
      const defaultPort = originMatch[1] === 'https' ? '443' : '80';
      const originPort = originMatch[3] || defaultPort;
      const hostPort = hostMatch[2] || defaultPort;
      if (originPort !== hostPort) {
        return false;
      }
    }
  }
  return true;
}

const app = new SidecarApp();
const controller = createCdpBridgeController({
  payloadPath: join(HERE, 'payload.js'),
});

app.page('/', async () => {
  const html = await readFile(join(HERE, 'index.html'), 'utf8');
  return new Response(html, {
    contentType: 'text/html; charset=utf-8',
    headers: NO_STORE_HEADERS,
  });
});

app.api(
  '/api/status',
  (_data, req) => {
    if (!isLocalHostRequest(req)) {
      return new Response(JSON.stringify({ error: 'Forbidden host or origin' }), {
        status: 403,
        contentType: 'application/json',
        headers: NO_STORE_HEADERS,
      });
    }
    return new Response(JSON.stringify(controller.getStatus()), {
      status: 200,
      contentType: 'application/json',
      headers: NO_STORE_HEADERS,
    });
  },
  'GET'
);

app.api(
  '/api/sync',
  async (_data, req) => {
    if (!isLocalHostRequest(req)) {
      return new Response(JSON.stringify({ error: 'Forbidden host or origin' }), {
        status: 403,
        contentType: 'application/json',
        headers: NO_STORE_HEADERS,
      });
    }
    const result = await controller.syncAllWindows({ forceReinject: true });
    return new Response(
      JSON.stringify({
        sync: result,
        status: controller.getStatus(),
      }),
      {
        status: 200,
        contentType: 'application/json',
        headers: NO_STORE_HEADERS,
      }
    );
  },
  'POST'
);

let shuttingDown = false;
function handleShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  controller
    .stop({ disposeWindows: true })
    .catch(() => {})
    .finally(() => {
      process.exit(0);
    });
}

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

app.run();
if (LS_ADDR && LS_ADDR !== 'test.invalid') {
  controller.start();
}
