/**
 * Sidecar CDP 熱注入橋接器 (`cdp-bridge.mjs`) 測試套件
 *
 * 使用暫存 DevToolsActivePort、本機 HTTP /json/list 伺服器與模擬 CDP WebSocket，
 * 驗證目標過濾、探測、注入、版本漂移重注與 stop({ disposeWindows: true }) 還原。
 *
 * 執行方式：`node test/cdp-bridge.test.mjs`
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const {
  computeBundleVersion,
  createCdpBridgeController,
  findActiveDevToolsPort,
  isAntigravityMainPageTarget,
  listMainWindowTargets,
  parseDevToolsPortFile,
  resolveDevToolsPortCandidates,
} = await import("../plugin/sidecars/effort-slider/cdp-bridge.mjs");

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(TEST_DIR, "_tmp_cdp");
const PORT_FILE = path.join(TMP_DIR, "DevToolsActivePort");

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  const same = Object.is(actual, expected);
  ok(same, same ? label : `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function createFakeCdpTargetVm() {
  const ctx = {
    window: null,
    disposeCalls: 0,
    Boolean,
    String,
    JSON,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return ctx;
}

function makeMockWebSocketClass(targetVms, evalLog) {
  return class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      queueMicrotask(() => {
        if (!targetVms.has(url)) {
          this._emit("error", new Error(`Unknown target ${url}`));
          return;
        }
        this._emit("open", {});
      });
    }
    addEventListener(type, fn, opts) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ fn, once: Boolean(opts && opts.once) });
    }
    _emit(type, ev) {
      const list = this.listeners.get(type) || [];
      this.listeners.set(
        type,
        list.filter((rec) => !rec.once),
      );
      for (const rec of list) rec.fn(ev);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      evalLog.push({ url: this.url, expression: msg.params.expression });
      try {
        const ctx = targetVms.get(this.url);
        const value = vm.runInContext(msg.params.expression, ctx);
        queueMicrotask(() => {
          this._emit("message", {
            data: JSON.stringify({
              id: msg.id,
              result: { result: { type: typeof value, value } },
            }),
          });
        });
      } catch (err) {
        queueMicrotask(() => {
          this._emit("message", {
            data: JSON.stringify({
              id: msg.id,
              error: { message: err.message },
            }),
          });
        });
      }
    }
    close() {}
  };
}

console.log("\n[CDP Bridge Tests]");

let server = null;
try {
  // 1. Pure helper tests
  const candidates = resolveDevToolsPortCandidates({ ANTIGRAVITY_DEVTOOLS_PORT_FILE: "C:\\custom\\Port" }, "win32", "C:\\Users\\test");
  eq(candidates[0], "C:\\custom\\Port", "ANTIGRAVITY_DEVTOOLS_PORT_FILE takes precedence");
  eq(parseDevToolsPortFile("9229\n/devtools/browser/abc\n"), 9229, "parseDevToolsPortFile parses first line port");
  eq(parseDevToolsPortFile("invalid"), null, "parseDevToolsPortFile rejects invalid content");

  ok(
    isAntigravityMainPageTarget({
      type: "page",
      url: "https://127.0.0.1:51234/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/1",
    }),
    "accepts https://127.0.0.1:<port>/ page target",
  );
  ok(
    !isAntigravityMainPageTarget({
      type: "page",
      url: "vscode-webview://1234/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/2",
    }),
    "ignores vscode-webview:// target",
  );
  ok(
    !isAntigravityMainPageTarget({
      type: "iframe",
      url: "https://127.0.0.1:51234/",
      webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/3",
    }),
    "ignores non-page target",
  );

  // 2. Setup fake DevToolsActivePort & local HTTP /json/list server
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  let cdpPort = 0;
  const targetsPayload = [];
  server = http.createServer((req, res) => {
    if (req.url === "/json/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(targetsPayload));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cdpPort = server.address().port;

  fs.writeFileSync(PORT_FILE, `${cdpPort}\n/devtools/browser/test\n`, "utf8");
  eq(findActiveDevToolsPort({ env: { ANTIGRAVITY_DEVTOOLS_PORT_FILE: PORT_FILE } }), cdpPort, "findActiveDevToolsPort reads override file");

  const mainWsUrl = `ws://127.0.0.1:${cdpPort}/devtools/page/MAIN`;
  targetsPayload.push(
    {
      id: "WV",
      type: "page",
      url: "vscode-webview://fake-extension/index.html",
      webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/WV`,
    },
    {
      id: "DEV",
      type: "page",
      url: "devtools://devtools/bundled/inspector.html",
      webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/DEV`,
    },
    {
      id: "MAIN",
      type: "page",
      url: "https://127.0.0.1:49999/",
      webSocketDebuggerUrl: mainWsUrl,
    },
  );

  const filtered = await listMainWindowTargets(cdpPort);
  eq(filtered.length, 1, "listMainWindowTargets returns only 1 main window target");
  eq(filtered[0].id, "MAIN", "listMainWindowTargets selected MAIN and filtered out vscode-webview/devtools");

  // 3. Test probe -> inject -> skip when alive -> reinject on version drift -> stop({ disposeWindows: true })
  const targetVms = new Map([[mainWsUrl, createFakeCdpTargetVm()]]);
  const evalLog = [];
  const MockWS = makeMockWebSocketClass(targetVms, evalLog);

  let currentPayload = `
    window.__agCodexEffortSliderLoaded = true;
    window.__agCodexEffortSlider = {
      bundleVersion: window.__agCodexEffortSliderConfig.bundleVersion,
      ensureAlive() { return !this._disposed; },
      dispose() { this._disposed = true; window.disposeCalls += 1; delete window.__agCodexEffortSliderLoaded; delete window.__agCodexEffortSlider; }
    };
  `;

  const ctrl = createCdpBridgeController({
    env: { ANTIGRAVITY_DEVTOOLS_PORT_FILE: PORT_FILE },
    WebSocketImpl: MockWS,
    readPayload: () => currentPayload,
  });

  // First sync: uninjected -> probes + injects
  const r1 = await ctrl.syncAllWindows();
  eq(r1.ok, true, "1st sync succeeds");
  eq(r1.targets, 1, "1st sync targets === 1");
  eq(r1.injected, 1, "1st sync injected === 1");
  eq(r1.alive, 1, "1st sync alive === 1");
  eq(evalLog.length, 2, "1st sync ran probe + inject (2 evaluations)");
  eq(targetVms.get(mainWsUrl).__agCodexEffortSliderLoaded, true, "target VM has __agCodexEffortSliderLoaded === true");
  eq(
    targetVms.get(mainWsUrl).__agCodexEffortSlider.bundleVersion,
    computeBundleVersion(currentPayload),
    "target VM received computed bundleVersion",
  );

  // Second sync: already alive & matching version -> probe only, 0 injections
  evalLog.length = 0;
  const r2 = await ctrl.syncAllWindows();
  eq(r2.injected, 0, "2nd sync skips re-injection when alive and version matches");
  eq(r2.alive, 1, "2nd sync alive === 1");
  eq(evalLog.length, 1, "2nd sync ran probe only (1 evaluation)");

  // Third sync: payload changes -> version drift -> disposes & re-injects
  currentPayload = currentPayload + "\n/* v2 */\n";
  evalLog.length = 0;
  const r3 = await ctrl.syncAllWindows();
  eq(r3.injected, 1, "3rd sync re-injects on version drift");
  eq(targetVms.get(mainWsUrl).disposeCalls, 1, "re-injection disposed previous instance once");
  eq(
    targetVms.get(mainWsUrl).__agCodexEffortSlider.bundleVersion,
    computeBundleVersion(currentPayload),
    "target VM updated to new bundleVersion",
  );

  // Stop with disposeWindows: true -> disposes & restores target window
  const stopRes = await ctrl.stop({ disposeWindows: true });
  eq(stopRes.stopped, true, "stop() returns stopped=true");
  eq(stopRes.disposed, 1, "stop({ disposeWindows: true }) disposed 1 window");
  eq(targetVms.get(mainWsUrl).disposeCalls, 2, "dispose() called on target window during stop");
  eq(targetVms.get(mainWsUrl).__agCodexEffortSliderLoaded, undefined, "target window __agCodexEffortSliderLoaded cleared");
  eq(targetVms.get(mainWsUrl).__agCodexEffortSlider, undefined, "target window __agCodexEffortSlider cleared");
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  ok(!fs.existsSync(TMP_DIR), "temp test/_tmp_cdp directory cleaned up");
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:");
  for (const label of failures) console.log(`  - ${label}`);
  process.exitCode = 1;
}
