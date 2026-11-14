# 貢獻指南

感謝你對 **Antigravity Codex Effort Slider** 的興趣與貢獻。

## 開發環境需求

- Node.js 20+
- Antigravity Desktop（用於實機外掛測試）

## 開發與提交流程

1. Fork 本倉庫並建立功能分支。
2. 修改前端核心程式碼 [src/antigravity-effort-slider.js](src/antigravity-effort-slider.js) 或測試套件。
3. 同步外掛套件並執行完整檢查與測試：

```bash
npm run sync
npm run check
npm test
```

4. 提交變更時請維持工作區乾淨，勿提交暫存檔或個人環境路徑，並透過 Pull Request 送出審查。
