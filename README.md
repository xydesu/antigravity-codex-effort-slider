# Antigravity Codex Effort Slider

為 Antigravity Desktop 模型選擇器提供 Codex 風格的 **Reasoning Effort** 連續滑桿與雙層模型選單，透過 Antigravity 原生 **Sidecar + CDP** 外掛架構運作。

## 功能特色

- **雙層模型與推理等級切換**
  - **第一層（主彈窗）**：點擊底部模型按鈕後，顯示目前模型入口列（`Select Model ›`）與即時 **Reasoning Effort** 物理滑條；若選用單一檔位模型，滑條區塊會自動隱藏並保留切換入口。
  - **第二層（右側模型清單）**：滑鼠懸停或點擊 `Select Model ›` 時，於主彈窗右側展開完整模型列表，並顯示各模型的標籤膠囊、模型說明及配額重置／耗盡懸停提示（`Tooltip`）。
- **物理手感與粒子視覺回饋**
  - 指標拖曳採 1:1 即時跟手追蹤，於放開（`pointerup`）或鍵盤操作定格時平滑吸附至目標刻度並同步套用設定；支援右鍵、長按滑條 600ms 或 `Shift+F10` 開啟設定面板，切換運動曲線（`full` / `quick` / `fast`）與已過刻度顯示方式（`hidden` / `dim`）。
  - 內建 22 顆黃金比例星點粒子與漸層能量光暈，隨推理等級動態調整速率，完整支援淺／深色主題與 `prefers-reduced-motion`。
- **原生外掛整合**
  - Sidecar 透過本機 `DevToolsActivePort` 自動連線主聊天視窗並監測版本變更進行熱更新，並於 Antigravity Aux Pane 提供連線狀態與手動同步按鈕；處於 Best-of-N 模式、清單載入中或停用外掛時皆會保持或還原原生介面。

## 安裝與啟用

環境需求：Node.js 20+、Antigravity Desktop。

1. 取得專案並安裝外掛至 `~/.gemini/config/plugins/codex-effort-slider`：

```bash
git clone <your-repo-url>
cd antigravity-codex-effort-slider
npm run install:plugin
```

> 若使用自訂外掛路徑，可先設定環境變數 `AGY_PLUGIN_DIR` 再執行安裝指令。

2. 於 Antigravity Desktop 的 Plugins 管理介面啟用 **Codex Effort Slider**。
3. Sidecar 會於背景自動注入開啟中的 Antigravity 主視窗；需要檢視注入狀態或手動重注時，可在 Aux Pane 開啟 **Codex Effort Slider** 面板。

## 專案結構

```text
.
├── src/
│   └── antigravity-effort-slider.js   # 前端雙層介面、物理引擎與模型選擇器連動核心
├── plugin/                            # Antigravity 外掛套件
│   ├── plugin.json                    # 外掛中繼資訊
│   ├── sidecars/effort-slider/
│   │   ├── sidecar.json               # Sidecar 與 Aux Pane 視圖設定
│   │   ├── package.json
│   │   ├── main.mjs                   # Sidecar HTTP 控制端點與生命週期管理
│   │   ├── cdp-bridge.mjs             # 本機 CDP 探測、熱注入與還原控制器
│   │   ├── index.html                 # Aux Pane 狀態頁面
│   │   └── payload.js                 # 與 src/antigravity-effort-slider.js 同步之注入腳本
│   └── skills/codex-effort-slider/
│       └── SKILL.md                   # 外掛檢查與排查指南
├── scripts/
│   ├── sync-plugin.mjs                # 同步並校驗 repo 與本機外掛 payload.js 的 SHA-256
│   └── install-plugin.mjs             # 安裝 plugin/ 套件至本機外掛目錄
├── test/
│   ├── harness.mjs                    # 模擬 DOM、React Fiber 與動畫 API 測試環境
│   ├── slider.test.mjs                # 滑桿幾何、物理曲線、雙層互動與懸停提示測試
│   ├── cdp-bridge.test.mjs            # CDP 目標過濾、模擬注入與還原測試
│   └── plugin.test.mjs                # 外掛套件結構與同步檢查測試
├── package.json
├── .gitignore
└── LICENSE
```

## 開發與測試

修改 `src/antigravity-effort-slider.js` 後，同步外掛套件並執行檢查與測試：

```bash
npm run sync
npm run check
npm test
```

若本機外掛正在運行，Sidecar 會每隔 1.2 秒自動比對 `payload.js` 的 SHA-256，偵測更新後自動重新注入並釋放舊實例。

## 授權

[MIT](LICENSE)
