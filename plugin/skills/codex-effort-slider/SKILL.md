---
name: codex-effort-slider
description: 檢查、同步與排查 Antigravity 桌面版 Codex Effort Slider 外掛的 Sidecar 與 CDP 熱注入狀態。
---

# Codex Effort Slider 運作與排查指引

此技能協助檢查與管理 `codex-effort-slider` 外掛（安裝目錄為 `~/.gemini/config/plugins/codex-effort-slider/`）。本外掛採 **Sidecar + CDP 熱注入** 架構，無須執行 `.ps1` 腳本，也不會修改 `app.asar` 或 Antigravity 安裝目錄。

## 檢查項目與步驟

1. **驗證 Sidecar 套件完整性與語法**：
   ```bash
   node --check ~/.gemini/config/plugins/codex-effort-slider/sidecars/effort-slider/cdp-bridge.mjs
   node --check ~/.gemini/config/plugins/codex-effort-slider/sidecars/effort-slider/main.mjs
   node --check ~/.gemini/config/plugins/codex-effort-slider/sidecars/effort-slider/payload.js
   ```
2. **確認 `payload.js` 與專案原始碼 SHA-256 一致**：
   ```bash
   npm run check
   ```
   若回報未同步，執行 `npm run sync` 即可自動複製並校驗。
3. **排查 CDP 無法注入**：
   - 確認 `DevToolsActivePort` 是否存在於 Antigravity 使用者資料目錄（例如 Windows 的 `%APPDATA%\Antigravity\DevToolsActivePort`，或環境變數 `ANTIGRAVITY_DEVTOOLS_PORT_FILE`）。
   - 在 Antigravity Aux Pane 開啟 **Codex Effort Slider** 檢視 `/api/status` 顯示的 `lastReason`、`cdpPort` 與 `aliveCount / targetCount`，必要時點擊「立即同步」。
4. **原生還原機制**：
   - 停用外掛時，`main.mjs` 會在 `SIGTERM` / `SIGINT` 執行 `stop({ disposeWindows: true })`，自動呼叫 `window.__agCodexEffortSlider?.dispose?.()` 還原原生 `[data-testid="model-selector-panel"]`。
