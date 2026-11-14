/**
 * antigravity-codex-effort-slider — 瀏覽器端主世界注入腳本（單層 Select Model 取代版）
 *
 * 透過 React Fiber 讀取 Antigravity `LQc` (`KQc.Provider`) 的模型目錄與派送函式
 * （找不到 Fiber 時自動降級為 DOM 掃描），直接將 `[data-testid="model-selector-panel"]`
 * 改造成「單層模型列表 + 底部 28px Codex 推理等級滑條」：
 *   1. 冪等載入守衛（`window.__agCodexEffortSliderLoaded`）與 CDP 熱注入生命週期
 *      （`window.__agCodexEffortSlider = { start, dispose, ensureAlive, bundleVersion, ... }`）
 *   2. 隱藏原生多層列表與右側二級 Effort 子選單，保留原生 Footer / Usage 區塊
 *   3. 單層列表點擊多 Effort 模型時切換至目標 Effort 並保持面板開啟，方便立即拖動滑條
 *   4. 完整視覺與連續物理引擎：`TRACK_HEIGHT=KNOB_SIZE=28`、`motionStep` (`full`/`quick`/`fast`)、
 *      藍 (#4d93f8) → 紫 (#9333ea) → 深紫 (#4c1d95)、index 0 為純藍 (energy=0)、
 *      index >= 1 開啟紫色星雲、`ces-sweep` 與 22 顆黃金比例星塵粒子（WAAPI playbackRate），
 *      以及右鍵 / 長按 600ms / Shift+F10 設定面板（`localStorage`: `ag-codex-effort-slider.settings`）
 */
(function (root) {
  "use strict";

  var LOAD_GUARD_KEY = "__agCodexEffortSliderLoaded";
  var INSTANCE_KEY = "__agCodexEffortSlider";
  var CONFIG_KEY = "__agCodexEffortSliderConfig";
  var STYLE_MARKER = "ag-codex-effort-slider";
  var SETTINGS_KEY = "ag-codex-effort-slider.settings";
  var SETTINGS_EVENT = "ag-codex-effort-slider:settings";
  var SETTINGS_VERSION = 1;
  var BUNDLE_VERSION = (root && root[CONFIG_KEY] && typeof root[CONFIG_KEY].bundleVersion === "string" && root[CONFIG_KEY].bundleVersion)
    ? root[CONFIG_KEY].bundleVersion
    : "2.0.0";

  /* ── 尺寸、速率與顏色常數（必須在 CSS 陣列之前宣告） ── */
  var TRACK_HEIGHT = 28;
  var KNOB_SIZE = TRACK_HEIGHT;
  var KNOB_RADIUS = KNOB_SIZE / 2;
  var GOLDEN_RATIO = 0.6180339887498949;
  var STARFIELD_DURATION_FIXED = 2;
  var STARFIELD_DURATION_SPREAD = 0.08;
  var STARFIELD_MIN = 0.5;
  var MIN_HEIGHT_SLOTS = 3;
  var DETENT_THIRD = 1 / 3;
  var ENERGY_START = 0;
  var ENERGY_END = 2 / 3;

  var COLOR_BLUE = [77, 147, 248];
  var COLOR_VIOLET = [147, 51, 234];
  var COLOR_DEEP = [76, 29, 149];
  var COLOR_TEXT_VIOLET = [139, 92, 246];

  var COMMIT_THROTTLE_MS = 120;
  var COMMIT_DEADLINE_MS = 10000;
  var MAX_FRAME_DT = 0.05;
  var POINTER_SPEED_EMA = 0.4;
  var POINTER_STALE_S = 2 / 60;
  var POINTER_SPEED_TAU = 0.03;
  var RELEASE_PROJECT_S = 0;

  var EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
  var EFFORT_LABELS = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra",
    max: "Max",
  };
  var EFFORT_LABEL_RE = /^(.*?)\s*\((low|medium|high|xhigh|max)(?:\s+thinking)?\)\s*$/i;

  var FALLBACK_EFFORT_PCT = {
    low: 0,
    medium: 1 / 3,
    high: 2 / 3,
    xhigh: 0.75,
    max: 1,
  };

  var MOTION = {
    K: 20,
    A: 120,
    k: 40,
    amax: 240,
    vmax: 6,
    epsX: 0.0015,
    epsV: 0.02,
  };
  var MOTION_REDUCED = {
    K: 40,
    A: 300,
    k: 40,
    amax: 200,
    vmax: 7,
    epsX: 0.0015,
    epsV: 0.02,
  };
  var MOTION_FAST = {
    K: 60,
    A: 500,
    k: 60,
    amax: 300,
    vmax: 10,
    epsX: 0.0015,
    epsV: 0.02,
  };

  var SETTINGS_SCHEMA = [
    {
      key: "motion",
      kind: "radio",
      group: "動畫效果",
      label: "動畫效果",
      default: "full",
      options: [
        { value: "fast", label: "快速動畫" },
        { value: "quick", label: "簡潔動畫" },
        { value: "full", label: "完整動畫" },
      ],
    },
    {
      key: "reachedTicks",
      kind: "radio",
      group: "已到達檔位的刻度點",
      label: "刻度點",
      default: "hidden",
      options: [
        { value: "highlight", label: "亮白顯示" },
        { value: "dim", label: "與未到達同色" },
        { value: "hidden", label: "隱藏" },
      ],
    },
  ];

  var FILL_RADIUS = "border-radius:" + KNOB_RADIUS + "px 0 0 " + KNOB_RADIUS + "px";
  var CSS = [
    ".ces-inline{--ces-accent:var(--primary,#4d93f8);box-sizing:border-box;width:100%;min-width:0}",
    ".ces-ag-selector{display:flex;flex-direction:column;width:100%;min-width:248px;box-sizing:border-box}",
    ".ces-ag-model-trigger-row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--secondary-foreground,inherit);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;transition:background-color .12s ease,color .12s ease;box-sizing:border-box}",
    ".ces-ag-model-trigger-row:hover,.ces-ag-model-trigger-row[data-open='1']{background:var(--secondary,rgba(127,127,127,.14));color:var(--foreground,inherit)}",
    ".ces-ag-model-trigger-main{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;flex:1}",
    ".ces-ag-model-trigger-label{font-weight:500;flex-shrink:0}",
    ".ces-ag-model-trigger-current{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted-foreground,rgba(127,127,127,.9))}",
    ".ces-ag-model-trigger-arrow{font-size:14px;line-height:1;opacity:.65;flex-shrink:0}",
    ".ces-ag-submenu{position:fixed;z-index:2147483600;display:flex;flex-direction:column;min-width:264px;max-width:340px;padding:6px;border-radius:10px;box-sizing:border-box;background:var(--popover,var(--card,#fff));color:var(--popover-foreground,var(--foreground,#1b1c20));border:1px solid var(--border,rgba(127,127,127,.26));box-shadow:0 12px 32px rgba(0,0,0,.22);font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}",
    ".dark .ces-ag-submenu,.theme-dark .ces-ag-submenu,[data-theme='dark'] .ces-ag-submenu{background:var(--popover,var(--card,#24262c));color:var(--popover-foreground,var(--foreground,#e8e9ec))}",
    ".ces-ag-list-header{font-size:12px;line-height:16px;font-weight:500;padding:4px 8px 6px;color:var(--muted-foreground,rgba(127,127,127,.85));user-select:none}",
    ".ces-ag-model-list{display:flex;flex-direction:column;gap:1px;max-height:300px;overflow-y:auto}",
    ".ces-ag-model-row{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:5px 8px;border:0;border-radius:6px;background:transparent;color:var(--secondary-foreground,inherit);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;transition:background-color .12s ease,color .12s ease;box-sizing:border-box}",
    ".ces-ag-model-row:hover:not([aria-disabled='true']){background:var(--secondary,rgba(127,127,127,.12));color:var(--foreground,inherit)}",
    ".ces-ag-model-row[data-active='1']{background:var(--secondary,rgba(127,127,127,.16));color:var(--foreground,inherit);font-weight:500}",
    ".ces-ag-model-row:disabled,.ces-ag-model-row[aria-disabled='true']{opacity:.5;cursor:not-allowed}",
    ".ces-ag-model-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".ces-ag-model-meta{display:flex;align-items:center;gap:6px;flex-shrink:0;font-size:12px}",
    ".ces-ag-model-effort{opacity:.8;font-weight:500}",
    ".ces-ag-model-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;padding:1px 6px;border-radius:999px;background:var(--secondary,rgba(127,127,127,.14));color:var(--muted-foreground,inherit);opacity:.85}",
    ".ces-ag-model-badge__icon{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;opacity:.75;flex-shrink:0}",
    ".ces-ag-badge-warn{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;color:var(--warning,#f59e0b);flex-shrink:0}",
    ".ces-ag-tooltip{position:fixed;z-index:2147483647;max-width:240px;padding:6px 9px;border-radius:6px;background:var(--popover,#1f2328);color:var(--popover-foreground,#f8fafc);border:1px solid var(--border,rgba(127,127,127,.28));box-shadow:0 8px 24px rgba(0,0,0,.24);font:12px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;white-space:normal;word-break:break-word;pointer-events:none}",
    ".ces-ag-model-check{font-size:12px;line-height:1;opacity:.9}",
    ".ces-ag-slider-section{margin-top:4px;padding:8px 8px 6px;border-top:1px solid var(--border,rgba(127,127,127,.22));border-radius:8px;transition:box-shadow .2s ease}",
    ".ces-ag-host{padding:6px 8px 8px;margin-bottom:4px;min-width:216px;border-radius:8px;border-bottom:1px solid var(--border,rgba(127,127,127,.22));transition:box-shadow .2s ease}",
    ".ces-ag-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:12px;line-height:16px;user-select:none}",
    ".ces-ag-label{color:var(--muted-foreground,rgba(127,127,127,.85));font-weight:500}",
    ".ces-ag-value{font-weight:600;transition:color .12s ease}",
    ".ces-inline[data-dragging='1'] .ces-ag-value,.ces-inline[data-dragging='1'] .ces-ag-slider-section,.ces-inline[data-dragging='1'] .ces-energy,.ces-inline[data-dragging='1'] .ces-stars{transition:none}",
    ".ces-track{position:relative;box-sizing:border-box;height:" + TRACK_HEIGHT + "px;margin-top:2px;border-radius:999px;background:var(--border,rgba(15,17,21,.10));cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}",
    ".dark .ces-track,.theme-dark .ces-track,[data-theme='dark'] .ces-track{background:var(--border,rgba(255,255,255,.12))}",
    ".ces-track:focus-visible{outline:2px solid var(--ces-accent);outline-offset:2px}",
    ".ces-fill{position:absolute;top:0;bottom:0;left:0;" + FILL_RADIUS + ";pointer-events:none;will-change:width}",
    ".ces-tick{position:absolute;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;border-radius:50%;background:rgba(128,128,128,.30);background:color-mix(in srgb,var(--foreground,#0f1115) 26%,transparent);pointer-events:none}",
    ".ces-tick[data-on='1']{background:rgba(255,255,255,.5)}",
    ".ces-knob{position:absolute;top:50%;width:" + KNOB_SIZE + "px;height:" + KNOB_SIZE + "px;margin:" + (-KNOB_RADIUS) + "px 0 0 " + (-KNOB_RADIUS) + "px;border-radius:50%;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.34),0 0 0 .5px rgba(0,0,0,.06);pointer-events:none;transform:translate3d(0,0,0);will-change:left}",
    ".ces-error{margin-top:6px;font-size:11px;line-height:16px;color:var(--error,#e5484d)}",
    ".ces-inline[data-energy='1'] .ces-track{box-shadow:0 0 calc(var(--ces-energy,0) * 16px) rgba(168,85,247,.5)}",
    ".ces-inline[data-energy='0'] .ces-star,.ces-inline[data-energy='0'] .ces-energy__sweep{animation-play-state:paused}",
    ".ces-energy{position:absolute;top:0;bottom:0;left:0;" + FILL_RADIUS + ";overflow:hidden;pointer-events:none;opacity:var(--ces-energy,0);transition:opacity .2s ease;background:linear-gradient(90deg,#3b1178 0%,#6d28d9 30%,#9333ea 62%,#c084fc 100%);will-change:width,opacity}",
    ".ces-stars{position:absolute;top:0;bottom:0;left:0;" + FILL_RADIUS + ";overflow:hidden;pointer-events:none;transition:opacity .2s ease;will-change:width,opacity}",
    ".ces-star{position:absolute;left:0;right:0;height:3px;margin-top:-1.5px;pointer-events:none;animation-name:ces-star-sweep;animation-timing-function:linear;animation-iteration-count:infinite}",
    ".ces-star__dot{position:absolute;left:100%;top:0;width:3px;height:3px;margin-left:-1.5px;border-radius:50%;background:#fff;box-shadow:0 0 4px rgba(255,255,255,.85);opacity:var(--ces-b,1);transform:scale(var(--ces-b,1))}",
    ".dark .ces-star__dot,.theme-dark .ces-star__dot,[data-theme='dark'] .ces-star__dot{background:#f5f3ff;box-shadow:0 0 5px rgba(216,180,254,.95)}",
    "@keyframes ces-star-sweep{0%{transform:translate3d(0,0,0);opacity:0}6%{opacity:1}94%{opacity:1}100%{transform:translate3d(-100%,0,0);opacity:0}}",
    ".ces-energy__sweep{position:absolute;inset:0;background:linear-gradient(100deg,transparent 18%,rgba(255,255,255,.30) 50%,transparent 82%);transform:translateX(100%);animation:ces-sweep 2.4s linear infinite}",
    "@keyframes ces-sweep{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}",
    "@media (prefers-reduced-motion: reduce){.ces-energy{transition:none}.ces-energy__sweep{display:none}}",
    ".ces-set{position:fixed;z-index:2147483000;min-width:252px;max-width:340px;padding:10px 12px;border-radius:10px;box-sizing:border-box;background:var(--card,#fff);color:var(--foreground,#1b1c20);border:1px solid var(--border,rgba(127,127,127,.28));box-shadow:0 12px 32px rgba(0,0,0,.24);font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}",
    ".dark .ces-set,.theme-dark .ces-set,[data-theme='dark'] .ces-set{background:var(--card,#24262c);color:var(--foreground,#e8e9ec)}",
    ".ces-set__title{font-weight:600;margin:0 0 6px 0}",
    ".ces-set__row{font-size:12px;opacity:.72;margin-bottom:8px}",
    ".ces-set__group{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}",
    ".ces-set__group label{display:flex;gap:6px;align-items:center;cursor:pointer}",
    ".ces-set__actions{display:flex;justify-content:space-between;gap:8px}",
    ".ces-set button{cursor:pointer;font:inherit;color:inherit;padding:4px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent}",
    ".ces-set button:hover{background:rgba(127,127,127,.14)}",
    ".ces-inline[data-reached-ticks='dim'] .ces-tick[data-on='1']{background:rgba(128,128,128,.30);background:color-mix(in srgb,var(--foreground,#0f1115) 26%,transparent)}",
    ".ces-inline[data-reached-ticks='hidden'] .ces-tick[data-on='1']{display:none}",
  ].join("\n");

  /* ════════════════════════════ 純數學與色彩 ════════════════════════════ */

  function clamp01(value) {
    if (!(value > 0)) return 0;
    return value > 1 ? 1 : value;
  }

  function clampAbs(value, limit) {
    if (value > limit) return limit;
    return value < -limit ? -limit : value;
  }

  function indexFromPct(pct, count) {
    if (count <= 1) return 0;
    return Math.max(0, Math.min(count - 1, Math.round(clamp01(pct) * (count - 1))));
  }

  function pctFromIndex(index, count) {
    if (count <= 0) return 0;
    if (count === 1) return 1;
    var safe = Math.max(0, Math.min(count - 1, index));
    return safe / (count - 1);
  }

  /** 快速動畫 (Codex 手感) 滯回檔位判定：前進過 +1/3 才進格，後退過 -2/3 才退格。 */
  function detentTargetIndex(pos, cur, count, third) {
    if (count <= 1) return 0;
    var th = typeof third === "number" && third > 0 && third < 0.5 ? third : DETENT_THIRD;
    var lo = Math.max(0, Math.min(count - 1, typeof cur === "number" ? cur : 0));
    var p = Math.max(0, Math.min(count - 1, pos));
    if (p >= lo + th) return Math.min(count - 1, Math.max(lo + 1, Math.round(p)));
    if (p <= lo - (1 - th)) return Math.max(0, Math.min(lo - 1, Math.round(p)));
    return lo;
  }

  function motionStep(m, dt, p) {
    var e = m.target - m.x;
    var vAbs = p.K * Math.abs(e);
    var brake = Math.sqrt(2 * p.A * Math.abs(e));
    if (brake < vAbs) vAbs = brake;
    if (vAbs > p.vmax) vAbs = p.vmax;
    var vDesired = e > 0 ? vAbs : (e < 0 ? -vAbs : 0);
    m.a = clampAbs(p.k * (vDesired - m.v), p.amax);
    m.v = clampAbs(m.v + m.a * dt, p.vmax);
    if (e !== 0 && Math.abs(m.v * dt) >= Math.abs(e)) {
      m.x = m.target;
      m.v = 0;
      m.a = 0;
      return m;
    }
    var xRaw = m.x + m.v * dt;
    var xClamped = xRaw < 0 ? 0 : (xRaw > 1 ? 1 : xRaw);
    if (xClamped !== xRaw && ((xClamped === 0 && m.v < 0) || (xClamped === 1 && m.v > 0))) {
      m.v = 0;
      m.a = 0;
    }
    m.x = xClamped;
    if (motionSettled(m, p)) {
      m.x = m.target;
      m.v = 0;
      m.a = 0;
    }
    return m;
  }

  function motionSettled(m, p) {
    return Math.abs(m.target - m.x) < p.epsX && Math.abs(m.v) < p.epsV;
  }

  function decayPointerSpeed(vPtr, sinceS, staleS, tau) {
    if (!(sinceS > staleS)) return vPtr;
    return vPtr * Math.exp(-(sinceS - staleS) / tau);
  }

  function releaseIndexFor(targetPct, vPtr, count) {
    return indexFromPct(clamp01(targetPct + vPtr * RELEASE_PROJECT_S), count);
  }

  function starHash01(index, salt) {
    var value = ((index + 1) * salt * 2654435761) % 4294967296;
    return ((value >>> 8) % 1000) / 1000;
  }

  /** 預先建好 22 顆確定性粒子：黃金比例低差異相位 + 高度與相位解耦排列。 */
  var PARTICLES = (function buildParticles() {
    var count = 22;
    var out = [];
    var i;
    for (i = 0; i < count; i += 1) {
      out.push({ y: 0, phase: ((i + 1) * GOLDEN_RATIO) % 1 });
    }
    var byPhase = [];
    for (i = 0; i < count; i += 1) byPhase.push(i);
    byPhase.sort(function (a, b) {
      return out[a].phase - out[b].phase;
    });
    var slots = null;
    for (var salt = 71; salt < 4000 && slots === null; salt += 1) {
      var candidate = [];
      for (i = 0; i < count; i += 1) candidate.push(i);
      candidate.sort(function (a, b) {
        var ha = starHash01(a, salt);
        var hb = starHash01(b, salt);
        return ha === hb ? a - b : ha - hb;
      });
      var ok = true;
      for (var k = 1; k < count && ok; k += 1) {
        if (Math.abs(candidate[k] - candidate[k - 1]) < MIN_HEIGHT_SLOTS) ok = false;
      }
      if (ok) slots = candidate;
    }
    if (slots === null) {
      slots = [];
      for (i = 0; i < count; i += 1) slots.push((i * 5) % count);
    }
    for (var rank = 0; rank < count; rank += 1) {
      out[byPhase[rank]].y = 8 + (slots[rank] / (count - 1)) * 84;
    }
    return out;
  })();

  function mixColor(from, to, t) {
    var k = clamp01(t);
    return [
      Math.round(from[0] + (to[0] - from[0]) * k),
      Math.round(from[1] + (to[1] - from[1]) * k),
      Math.round(from[2] + (to[2] - from[2]) * k),
    ];
  }

  function rgbOf(color) {
    return "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
  }

  function isOffLevel(level) {
    if (!level) return false;
    var candidates = [level.id, level.name];
    for (var i = 0; i < candidates.length; i += 1) {
      if (typeof candidates[i] !== "string") continue;
      var flat = candidates[i].replace(/\s+/g, "").toLowerCase();
      if (flat === "off" || flat === "none" || flat === "关闭" || flat === "關閉" || flat === "无" || flat === "無") {
        return true;
      }
    }
    return false;
  }

  /** index 0 (pct=0) 為純藍且 energy=0；index >= 1 (pct > 0) 起開啟星雲與粒子。 */
  function energyFor(pct) {
    return clamp01((clamp01(pct) - ENERGY_START) / (1 - ENERGY_START));
  }

  function fillColorFor(pct) {
    var t = clamp01(pct);
    if (t <= ENERGY_START) return rgbOf(COLOR_BLUE);
    if (t <= ENERGY_END) {
      return rgbOf(mixColor(COLOR_BLUE, COLOR_VIOLET, (t - ENERGY_START) / (ENERGY_END - ENERGY_START)));
    }
    return rgbOf(mixColor(COLOR_VIOLET, COLOR_DEEP, (t - ENERGY_END) / (1 - ENERGY_END)));
  }

  function fillBackgroundFor(pct) {
    return "linear-gradient(90deg, " + rgbOf(COLOR_BLUE) + ", " + fillColorFor(pct) + ")";
  }

  function valueColorFor(pct, level) {
    if (isOffLevel(level)) return "";
    return rgbOf(mixColor(COLOR_BLUE, COLOR_TEXT_VIOLET, energyFor(pct)));
  }

  function speedFor(pct) {
    return Math.min(2, Math.max(0.55, 3 * clamp01(pct) - 1));
  }

  function particleCountFor(pct) {
    return Math.round(energyFor(pct) * PARTICLES.length);
  }

  function starBrightnessFor(index) {
    return STARFIELD_MIN + (1 - STARFIELD_MIN) * starHash01(index, 61);
  }

  function starDurationFor(index) {
    var spread = 1 - STARFIELD_DURATION_SPREAD + 2 * STARFIELD_DURATION_SPREAD * starHash01(index, 29);
    return STARFIELD_DURATION_FIXED * spread;
  }

  function starDelayFor(index, duration) {
    var particle = PARTICLES[index];
    var phase = particle && typeof particle.phase === "number" ? particle.phase : 0;
    var jitter = starHash01(index, 53) * 0.03;
    return -((phase + jitter) % 1) * duration;
  }

  function starLayerOpacityFor(pct) {
    var e = energyFor(pct);
    return e > 0 ? 0.6 + 0.4 * e : 0;
  }

  function knobOffsetOf(pct) {
    var t = Math.round(clamp01(pct) * 10000) / 10000;
    return "calc(" + KNOB_RADIUS + "px + " + t + " * (100% - " + KNOB_RADIUS * 2 + "px))";
  }

  /* ════════════════════════════ 設定與診斷 ════════════════════════════ */

  function schemaDefaults() {
    var out = {};
    for (var i = 0; i < SETTINGS_SCHEMA.length; i += 1) {
      var item = SETTINGS_SCHEMA[i];
      out[item.key] = item.default !== undefined ? item.default : item.options[0].value;
    }
    return out;
  }

  function normalizeSettings(raw) {
    var out = schemaDefaults();
    var source = raw && typeof raw === "object" ? raw : {};
    for (var i = 0; i < SETTINGS_SCHEMA.length; i += 1) {
      var item = SETTINGS_SCHEMA[i];
      var value = source[item.key];
      if (value === undefined) continue;
      if (item.kind === "radio") {
        for (var j = 0; j < item.options.length; j += 1) {
          if (item.options[j].value === value) {
            out[item.key] = value;
            break;
          }
        }
      }
    }
    return out;
  }

  function createSettingsStore(win) {
    var cache = null;
    function read() {
      if (cache !== null) return cache;
      var raw = null;
      try {
        if (win && win.localStorage) raw = win.localStorage.getItem(SETTINGS_KEY);
      } catch (e) { /* 忽略儲存錯誤 */ }
      var parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch (e) {
        parsed = null;
      }
      var out = normalizeSettings(parsed);
      out.v = SETTINGS_VERSION;
      cache = out;
      return out;
    }
    function write(patch) {
      var cur = read();
      var merged = {};
      for (var k in cur) if (Object.prototype.hasOwnProperty.call(cur, k)) merged[k] = cur[k];
      if (patch && typeof patch === "object") {
        for (var k2 in patch) if (Object.prototype.hasOwnProperty.call(patch, k2)) merged[k2] = patch[k2];
      }
      var next = normalizeSettings(merged);
      next.v = SETTINGS_VERSION;
      cache = next;
      try {
        if (win && win.localStorage) win.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch (e) { /* 忽略儲存錯誤 */ }
      try {
        if (win && typeof win.dispatchEvent === "function" && typeof win.CustomEvent === "function") {
          win.dispatchEvent(new win.CustomEvent(SETTINGS_EVENT));
        }
      } catch (e) { /* 忽略事件錯誤 */ }
      return next;
    }
    function clearCache() {
      cache = null;
    }
    return { read: read, write: write, clearCache: clearCache };
  }

  function motionParamsForMode(mode) {
    if (mode === "quick") return MOTION_REDUCED;
    if (mode === "fast") return MOTION_FAST;
    return MOTION;
  }

  function createTraceBuffer() {
    var buf = [];
    return {
      push: function (entry) {
        try {
          buf.push(entry);
          if (buf.length > 400) buf.splice(0, buf.length - 400);
        } catch (e) { /* 忽略 */ }
      },
      clear: function () {
        buf.length = 0;
      },
      dump: function (settingsRead) {
        if (buf.length === 0) return "（尚未記錄：請先在滑條上拖動/放手幾次再複製）";
        var lines = [];
        lines.push("=== Antigravity 滑條診斷 " + new Date().toISOString() + " ===");
        lines.push("記錄 " + buf.length + " 筆；動畫模式 = " + (settingsRead ? settingsRead().motion : "unknown"));
        var tail = buf.slice(-120);
        for (var i = 0; i < tail.length; i += 1) lines.push(JSON.stringify(tail[i]));
        return lines.join("\n");
      },
    };
  }

  /* ════════════════════════════ React Fiber & DOM 探索 ════════════════════════════ */

  function normalizeEffortId(raw) {
    if (typeof raw !== "string") return "";
    return raw.trim().toLowerCase();
  }

  function effortDisplayName(id) {
    return EFFORT_LABELS[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : "");
  }

  function parseModelLabel(label) {
    if (typeof label !== "string") return null;
    var m = EFFORT_LABEL_RE.exec(label);
    if (!m) return null;
    return { base: m[1].trim(), effort: m[2].toLowerCase() };
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (typeof el.hasAttribute === "function") {
      if (el.hasAttribute("hidden") || el.hasAttribute("data-closed")) return false;
    }
    if (el.style && el.style.display === "none") return false;
    return true;
  }

  function getFiberFromElement(el) {
    if (!el || typeof el !== "object") return null;
    var keys;
    try {
      keys = Object.keys(el);
    } catch (e) {
      return null;
    }
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) {
        return el[k];
      }
    }
    return null;
  }

  function isProviderValue(val) {
    return !!(
      val &&
      typeof val === "object" &&
      val.effortIndex &&
      typeof val.effortIndex.get === "function" &&
      typeof val.setSelectedModel === "function" &&
      Array.isArray(val.groups)
    );
  }

  /**
   * 從 `[data-testid="model-selector-panel"]` 或 `[data-testid="model-selector-trigger"]`
   * 沿 React Fiber `.return` 向上尋找 `LQc` (`KQc.Provider`) 的 context value；
   * 同時尋找外層 `XQc`（含有未被 `setIsOpen(false)` 包裝的原始 `setSelectedModel`），
   * 讓點擊與拖動時能保持選單開啟。
   */
  function findModelSelectorContext(doc) {
    if (!doc || typeof doc.querySelector !== "function") return null;
    var anchors = [
      doc.querySelector('[data-testid="model-selector-panel"]'),
      doc.querySelector('[data-testid="model-selector-trigger"]'),
    ];
    for (var a = 0; a < anchors.length; a += 1) {
      var fiber = getFiberFromElement(anchors[a]);
      var hops = 0;
      var providerVal = null;
      var rawSetSelectedModel = null;
      while (fiber && hops < 80) {
        var props = fiber.memoizedProps;
        if (!providerVal && props && isProviderValue(props.value)) {
          providerVal = props.value;
        }
        if (
          providerVal &&
          !rawSetSelectedModel &&
          props &&
          typeof props.setSelectedModel === "function" &&
          typeof props.setIsOpen === "function" &&
          props.setSelectedModel !== providerVal.setSelectedModel
        ) {
          rawSetSelectedModel = props.setSelectedModel;
          break;
        }
        fiber = fiber.return;
        hops += 1;
      }
      if (providerVal) {
        return {
          provider: providerVal,
          setSelectedModel: rawSetSelectedModel || providerVal.setSelectedModel,
          hasNonClosingSetter: !!rawSetSelectedModel,
          bestOfNEnabled: !!(providerVal.bestOfNConfig && providerVal.bestOfNConfig.isBestOfNEnabled),
          isLoading: providerVal.isModelListLoading === true,
        };
      }
    }
    return null;
  }

  function orderedEffortsFromMap(byEffort) {
    var list = [];
    if (!byEffort || typeof byEffort.has !== "function") return list;
    for (var i = 0; i < EFFORT_ORDER.length; i += 1) {
      if (byEffort.has(EFFORT_ORDER[i])) list.push(EFFORT_ORDER[i]);
    }
    if (typeof byEffort.forEach === "function") {
      byEffort.forEach(function (_v, key) {
        if (list.indexOf(key) < 0) list.push(key);
      });
    }
    return list;
  }

  function findEffortEntryForOption(option, effortIndex) {
    if (!option || !effortIndex || typeof effortIndex.get !== "function") return null;
    var parsed = option.isCustom ? null : parseModelLabel(option.label);
    if (parsed) {
      var map = effortIndex.get(parsed.base);
      if (map && map.size >= 2) {
        return { base: parsed.base, effort: parsed.effort, byEffort: map, efforts: orderedEffortsFromMap(map) };
      }
    }
    var found = null;
    if (typeof effortIndex.forEach === "function") {
      effortIndex.forEach(function (byEffort, base) {
        if (found || !byEffort || byEffort.size < 2 || typeof byEffort.forEach !== "function") return;
        byEffort.forEach(function (opt, eff) {
          if (found || !opt) return;
          if (opt === option || (opt.value !== undefined && opt.value === option.value && opt.label === option.label)) {
            found = { base: base, effort: eff, byEffort: byEffort, efforts: orderedEffortsFromMap(byEffort) };
          }
        });
      });
    }
    return found;
  }

  function sameModelOption(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.label && b.label && a.label === b.label) {
      if (a.value !== undefined && b.value !== undefined) return a.value === b.value;
      return true;
    }
    return false;
  }

  function computeQuotaWarning(opt, displayLabel) {
    var qi = opt && opt.quotaInfo;
    if (!qi || qi.remainingFraction === undefined || qi.remainingFraction > 0) return null;
    var label = displayLabel || opt.label || "this model";
    var resetMs = qi.resetTime ? Date.parse(qi.resetTime) : NaN;
    if (!isNaN(resetMs) && resetMs > Date.now()) {
      return "Your quota for " + label + " will reset on " + new Date(resetMs).toLocaleString() + ".";
    }
    return "Your quota for " + label + " has been reached.";
  }

  function extractOptionTagMeta(opt, targetOpt, levels, displayLabel) {
    var sources = [];
    if (targetOpt) sources.push(targetOpt);
    if (opt && opt !== targetOpt) sources.push(opt);
    if (Array.isArray(levels)) {
      for (var i = 0; i < levels.length; i += 1) {
        if (levels[i] && levels[i].option) sources.push(levels[i].option);
      }
    }
    var tagTitle = null;
    var tagDescription = null;
    for (var s = 0; s < sources.length; s += 1) {
      var src = sources[s];
      if (!src) continue;
      if (!tagTitle && typeof src.tagTitle === "string" && src.tagTitle) tagTitle = src.tagTitle;
      if (!tagDescription && typeof src.tagDescription === "string" && src.tagDescription) tagDescription = src.tagDescription;
    }
    var warningText = computeQuotaWarning(targetOpt, displayLabel) || computeQuotaWarning(opt, displayLabel);
    if (!warningText && Array.isArray(levels) && levels.length > 0) {
      var allZero = true;
      var firstWarn = null;
      for (var j = 0; j < levels.length; j += 1) {
        var lvlWarn = computeQuotaWarning(levels[j] && levels[j].option, displayLabel);
        if (!lvlWarn) { allZero = false; break; }
        if (!firstWarn) firstWarn = lvlWarn;
      }
      if (allZero && firstWarn) warningText = firstWarn;
    }
    return {
      tagTitle: tagTitle,
      tagDescription: tagDescription,
      warningText: warningText,
    };
  }

  /**
   * 將 `LQc` (`KQc.Provider`) 的模型群組與 `effortIndex` 轉為單層模型列表與目前滑條檔位。
   */
  function buildUnifiedModelState(provider, overrideSelected) {
    if (!provider || !Array.isArray(provider.groups)) return null;
    var effortIndex = provider.effortIndex;
    var selected = overrideSelected || provider.selectedModel || null;
    var selectedEntry = selected ? findEffortEntryForOption(selected, effortIndex) : null;
    var selectedParsed = selected && !selected.isCustom ? parseModelLabel(selected.label) : null;
    var selectedBase = selectedEntry ? selectedEntry.base : (selectedParsed ? selectedParsed.base : null);
    var selectedEffort = selectedEntry ? selectedEntry.effort : (selectedParsed ? selectedParsed.effort : null);

    var items = [];
    var seenBases = {};
    var activeLevels = [];
    var activeEffortIdx = 0;

    function addOption(opt) {
      if (!opt || typeof opt.label !== "string") return;
      var entry = findEffortEntryForOption(opt, effortIndex);
      if (entry) {
        if (seenBases[entry.base]) return;
        seenBases[entry.base] = true;
        var isActive = selectedBase === entry.base;
        var targetEffort = isActive && selectedEffort && entry.byEffort.has(selectedEffort)
          ? selectedEffort
          : (entry.byEffort.has("medium") ? "medium" : entry.efforts[0]);
        var targetOpt = entry.byEffort.get(targetEffort) || opt;
        var levels = [];
        for (var e = 0; e < entry.efforts.length; e += 1) {
          var eid = entry.efforts[e];
          var eOpt = entry.byEffort.get(eid);
          levels.push({
            id: eid,
            name: effortDisplayName(eid),
            option: eOpt,
            disabled: !!(eOpt && eOpt.disabled),
          });
        }
        var metaGroup = extractOptionTagMeta(opt, targetOpt, levels, (targetOpt && targetOpt.label) || opt.label || entry.base);
        items.push({
          key: "base:" + entry.base,
          label: entry.base,
          base: entry.base,
          isMultiEffort: true,
          isActive: isActive,
          disabled: !!(targetOpt && targetOpt.disabled),
          badge: metaGroup.tagTitle,
          tagDescription: metaGroup.tagDescription,
          warningText: metaGroup.warningText,
          currentEffort: targetEffort,
          targetOption: targetOpt,
          levels: levels,
        });
        if (isActive) {
          activeLevels = levels;
          for (var li = 0; li < levels.length; li += 1) {
            if (levels[li].id === targetEffort) {
              activeEffortIdx = li;
              break;
            }
          }
        }
      } else {
        var singleKey = "single:" + opt.label;
        if (seenBases[singleKey]) return;
        seenBases[singleKey] = true;
        var activeSingle = !!(selected && sameModelOption(selected, opt));
        var metaSingle = extractOptionTagMeta(opt, opt, null, opt.label);
        items.push({
          key: singleKey,
          label: opt.label,
          base: opt.label,
          isMultiEffort: false,
          isActive: activeSingle,
          disabled: !!opt.disabled,
          badge: metaSingle.tagTitle || (opt.isCustom ? "Custom" : null),
          tagDescription: metaSingle.tagDescription,
          warningText: metaSingle.warningText,
          currentEffort: null,
          targetOption: opt,
          levels: [],
        });
      }
    }

    for (var g = 0; g < provider.groups.length; g += 1) {
      var group = provider.groups[g];
      var opts = group && Array.isArray(group.options) ? group.options : [];
      for (var o = 0; o < opts.length; o += 1) {
        addOption(opts[o]);
      }
    }

    var customs = Array.isArray(provider.customModels) ? provider.customModels : [];
    for (var c = 0; c < customs.length; c += 1) {
      addOption(customs[c]);
    }

    if (items.length === 0) return null;
    return {
      source: "fiber",
      items: items,
      levels: activeLevels,
      activeIndex: activeEffortIdx,
      selectedModel: selected,
    };
  }

  /* ── DOM 輔助函式（用於觸發鈕與無 Fiber 時的降級掃描） ── */

  function isOptionChecked(targetEl, optEl) {
    var els = targetEl && targetEl !== optEl ? [targetEl, optEl] : [optEl];
    for (var i = 0; i < els.length; i += 1) {
      var node = els[i];
      if (!node || typeof node.getAttribute !== "function") continue;
      if (node.getAttribute("aria-checked") === "true") return true;
      if (node.getAttribute("data-selected") === "true") return true;
      if (typeof node.hasAttribute === "function" && node.hasAttribute("data-checked") && node.getAttribute("data-checked") !== "false") {
        return true;
      }
      if (node.classList && typeof node.classList.contains === "function" && node.classList.contains("bg-secondary")) {
        return true;
      }
    }
    return false;
  }

  function isOptionDisabled(targetEl, optEl) {
    var els = targetEl && targetEl !== optEl ? [targetEl, optEl] : [optEl];
    for (var i = 0; i < els.length; i += 1) {
      var node = els[i];
      if (!node || typeof node.getAttribute !== "function") continue;
      if (node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true" || node.hasAttribute("data-disabled")) {
        return true;
      }
    }
    return false;
  }

  function closestInteractiveOption(optEl) {
    if (!optEl || typeof optEl.closest !== "function") return optEl;
    return optEl.closest('[role="menuitemradio"],[role="menuitem"],button,[tabindex]') || optEl;
  }

  function findSubmenuRoot(optEl) {
    if (!optEl) return null;
    if (typeof optEl.closest === "function") {
      var menu = optEl.closest('[role="menu"]');
      if (menu) return menu;
      var rg = optEl.closest('[role="radiogroup"]');
      if (rg && rg.parentNode && rg.parentNode.nodeType === 1) return rg.parentNode;
      if (rg) return rg;
    }
    return optEl.parentNode || null;
  }

  function parseTriggerEffort(triggerEl) {
    if (!triggerEl || typeof triggerEl.querySelectorAll !== "function") return null;
    var candidates = [];
    var opacitySpan = typeof triggerEl.querySelector === "function" ? triggerEl.querySelector("span.opacity-70") : null;
    if (opacitySpan) candidates.push(opacitySpan);
    var spans = triggerEl.querySelectorAll("span");
    for (var i = 0; i < spans.length; i += 1) {
      if (spans[i] !== opacitySpan) candidates.push(spans[i]);
    }
    for (var j = 0; j < candidates.length; j += 1) {
      var raw = (candidates[j].textContent || "").trim();
      if (!raw) continue;
      var match = /^(low|medium|high|extra|xhigh|max)(?:\s|$|\u00b7)/i.exec(raw);
      if (match) {
        var token = match[1].toLowerCase();
        var id = token === "extra" ? "xhigh" : token;
        return { el: candidates[j], id: id, label: effortDisplayName(id) };
      }
    }
    return null;
  }

  function extractTriggerModelBase(triggerEl) {
    if (!triggerEl || typeof triggerEl.querySelector !== "function") return "";
    var mainSpan = triggerEl.querySelector("span");
    if (!mainSpan) return "";
    var full = (mainSpan.textContent || "").trim();
    var eff = parseTriggerEffort(triggerEl);
    if (eff && eff.el && eff.el.textContent) {
      var suffix = eff.el.textContent.trim();
      if (suffix && full.endsWith(suffix)) {
        return full.slice(0, full.length - suffix.length).trim();
      }
    }
    return full;
  }

  function findOpenSubmenu(doc) {
    if (!doc || typeof doc.querySelector !== "function" || typeof doc.querySelectorAll !== "function") return null;
    var panel = doc.querySelector('[data-testid="model-selector-panel"]');
    if (!panel || !isElementVisible(panel)) return null;

    var optionEls = doc.querySelectorAll('[data-testid="model-selector-effort-option"]');
    if (!optionEls || optionEls.length === 0) return null;

    var submenu = null;
    for (var i = 0; i < optionEls.length; i += 1) {
      var r = findSubmenuRoot(optionEls[i]);
      if (r) {
        submenu = r;
        break;
      }
    }
    if (!submenu) return null;

    var scopedOptions = submenu.querySelectorAll('[data-testid="model-selector-effort-option"]');
    var levels = [];
    var seen = {};
    var activeIndex = -1;
    for (var j = 0; j < scopedOptions.length; j += 1) {
      var opt = scopedOptions[j];
      var id = normalizeEffortId(opt.getAttribute("data-effort"));
      if (!id || seen[id]) continue;
      seen[id] = true;
      var targetEl = closestInteractiveOption(opt);
      var name = (opt.textContent || "").trim() || effortDisplayName(id);
      var checked = isOptionChecked(targetEl, opt);
      if (checked && activeIndex < 0) activeIndex = levels.length;
      levels.push({
        id: id,
        name: name,
        optEl: opt,
        targetEl: targetEl,
        disabled: isOptionDisabled(targetEl, opt),
        checked: checked,
      });
    }
    if (levels.length === 0) return null;

    var modelBase = "";
    var groupLabel = null;
    var groups = panel.querySelectorAll('[data-testid="model-selector-effort-group"]');
    for (var g = 0; g < groups.length; g += 1) {
      var grp = groups[g];
      var row = typeof grp.closest === "function" ? grp.closest('[role="menuitem"],button,div') : grp.parentNode;
      var isHighlighted = row && typeof row.hasAttribute === "function" && (row.hasAttribute("data-highlighted") || row.hasAttribute("data-popup-open") || row.getAttribute("aria-expanded") === "true");
      if (isHighlighted || groups.length === 1) {
        modelBase = grp.getAttribute("data-model-base") || (grp.textContent || "").trim();
        groupLabel = row ? row.querySelector("span.opacity-70") : null;
        break;
      }
    }
    if (!modelBase) {
      modelBase = extractTriggerModelBase(doc.querySelector('[data-testid="model-selector-trigger"]'));
    }

    if (activeIndex < 0 && groupLabel) {
      var gText = (groupLabel.textContent || "").trim().toLowerCase();
      for (var k = 0; k < levels.length; k += 1) {
        if (levels[k].name.toLowerCase() === gText || levels[k].id === gText) {
          activeIndex = k;
          break;
        }
      }
    }
    if (activeIndex < 0) {
      var triggerInfo = parseTriggerEffort(doc.querySelector('[data-testid="model-selector-trigger"]'));
      if (triggerInfo) {
        for (var m = 0; m < levels.length; m += 1) {
          if (levels[m].id === triggerInfo.id) {
            activeIndex = m;
            break;
          }
        }
      }
    }
    if (activeIndex < 0) activeIndex = 0;

    return {
      panel: panel,
      submenu: submenu,
      levels: levels,
      activeIndex: activeIndex,
      modelBase: modelBase,
    };
  }

  /**
   * 無 React Fiber 時的 DOM 降級掃描：從 `[data-testid="model-selector-panel"]`
   * 讀取分組模型列、單一模型列與現有的 `[data-testid="model-selector-effort-option"]`。
   */
  function buildDomFallbackState(doc, panel, modelEffortsCache) {
    if (!doc || !panel) return null;
    var trigger = doc.querySelector('[data-testid="model-selector-trigger"]');
    var triggerBase = extractTriggerModelBase(trigger);
    var triggerEffort = parseTriggerEffort(trigger);

    var submenuInfo = findOpenSubmenu(doc);
    var submenuLevels = submenuInfo ? submenuInfo.levels : null;
    var items = [];
    var seen = {};
    var activeLevels = [];
    var activeEffortIdx = 0;

    var groupEls = panel.querySelectorAll('[data-testid="model-selector-effort-group"]');
    for (var i = 0; i < groupEls.length; i += 1) {
      var grp = groupEls[i];
      var base = grp.getAttribute("data-model-base") || (grp.textContent || "").trim();
      if (!base || seen["base:" + base]) continue;
      seen["base:" + base] = true;
      var row = typeof grp.closest === "function" ? grp.closest('[role="menuitem"],button,div') : grp.parentNode;
      var effSpan = row && typeof row.querySelector === "function" ? row.querySelector("span.opacity-70") : null;
      var effRaw = effSpan ? (effSpan.textContent || "").trim().toLowerCase() : "";
      var rowEffId = effRaw === "extra" ? "xhigh" : effRaw;
      var isActive = (row && isOptionChecked(row, grp)) || (!!triggerBase && triggerBase === base);
      var effId = isActive && triggerEffort ? triggerEffort.id : (rowEffId || "medium");

      var levelsForGroup = [];
      if (submenuLevels && submenuLevels.length > 0 && (submenuInfo.modelBase === base || groupEls.length === 1 || isActive)) {
        levelsForGroup = submenuLevels;
      } else if (modelEffortsCache && modelEffortsCache[base]) {
        levelsForGroup = modelEffortsCache[base];
      } else {
        var defaultIds = ["low", "medium", "high", "max"];
        if (effId === "xhigh") defaultIds = ["low", "medium", "high", "xhigh", "max"];
        for (var d = 0; d < defaultIds.length; d += 1) {
          levelsForGroup.push({ id: defaultIds[d], name: effortDisplayName(defaultIds[d]), targetEl: null, disabled: false });
        }
      }

      items.push({
        key: "base:" + base,
        label: base,
        base: base,
        isMultiEffort: true,
        isActive: isActive,
        disabled: isOptionDisabled(row, grp),
        badge: null,
        tagDescription: null,
        warningText: null,
        currentEffort: effId,
        targetEl: row || grp,
        levels: levelsForGroup,
      });

      if (isActive) {
        activeLevels = levelsForGroup;
        if (submenuInfo && submenuLevels === levelsForGroup) {
          activeEffortIdx = submenuInfo.activeIndex;
        } else {
          for (var li = 0; li < levelsForGroup.length; li += 1) {
            if (levelsForGroup[li].id === effId) {
              activeEffortIdx = li;
              break;
            }
          }
        }
      }
    }

    var singleEls = panel.querySelectorAll('[data-testid="model-selector-item"],[data-testid="model-selector-custom-item"]');
    for (var s = 0; s < singleEls.length; s += 1) {
      var itemEl = singleEls[s];
      var lbl = itemEl.getAttribute("data-model-label") || (itemEl.textContent || "").trim();
      if (!lbl || seen["single:" + lbl]) continue;
      seen["single:" + lbl] = true;
      var activeSingle = isOptionChecked(itemEl, itemEl) || (!!triggerBase && triggerBase === lbl);
      items.push({
        key: "single:" + lbl,
        label: lbl,
        base: lbl,
        isMultiEffort: false,
        isActive: activeSingle,
        disabled: isOptionDisabled(itemEl, itemEl),
        badge: null,
        tagDescription: null,
        warningText: null,
        currentEffort: null,
        targetEl: itemEl,
        levels: [],
      });
    }

    if (items.length === 0) return null;
    if (activeLevels.length === 0 && submenuLevels && submenuLevels.length > 0) {
      activeLevels = submenuLevels;
      activeEffortIdx = submenuInfo.activeIndex;
    }

    return {
      source: "dom",
      items: items,
      levels: activeLevels,
      activeIndex: activeEffortIdx,
      submenu: submenuInfo ? submenuInfo.submenu : null,
    };
  }

  function findNativeSubmenuPopups(doc, panel) {
    var out = [];
    if (!doc || typeof doc.querySelectorAll !== "function") return out;
    var optEls = doc.querySelectorAll('[data-testid="model-selector-effort-option"]');
    for (var i = 0; i < optEls.length; i += 1) {
      var menu = findSubmenuRoot(optEls[i]);
      if (!menu || menu === panel || out.indexOf(menu) >= 0) continue;
      if (typeof menu.closest === "function" && menu.closest(".ces-inline")) continue;
      out.push(menu);
    }
    return out;
  }

  /* ════════════════════════════ 主控制器 ════════════════════════════ */

  function createController(options) {
    var opts = options || {};
    var doc = opts.doc || (typeof document !== "undefined" ? document : null);
    var win = opts.win || (typeof window !== "undefined" ? window : null);
    if (!doc) return null;

    var settingsStore = createSettingsStore(win);
    var trace = createTraceBuffer();
    var modelEffortsCache = {};

    var disposed = false;
    var observer = null;
    var fallbackTimer = null;

    var hostState = null; // { panel, container, listEl, rowEls, sliderSection, headValueEl, trackEl, fillEl, energyEl, starsEl, starDots, ticksWrap, tickEls, tickSignature, knobEl, errorEl }
    var hiddenDomNodes = []; // [{ el, prevDisplay }]
    var activeCtx = null; // Fiber context { provider, setSelectedModel, hasNonClosingSetter }
    var unifiedState = null; // { source, items, levels, activeIndex }
    var levels = [];
    var activeIndex = 0;
    var optimistic = null; // { id, timer, selectedModel }
    var errorMsg = null;

    var dragging = false;
    var buttonDown = false;
    var draft = null; // { pct, index }
    var detentIndex = -1;
    var snapIndex = null;
    var lastCommittedId = null;
    var holdFrames = 0;

    var motion = null;
    var frameHandle = null;
    var lastTs = 0;
    var lastPtrPct = null;
    var lastPointerAt = 0;
    var starRateCache = null;

    var commitState = { timer: null, inFlight: false, queued: null };
    var commitOnDrag = opts.commitOnDrag === true;
    var commitDeadlineMs = typeof opts.commitDeadlineMs === "number" ? opts.commitDeadlineMs : COMMIT_DEADLINE_MS;
    var commitThrottleMs = typeof opts.commitThrottleMs === "number" ? opts.commitThrottleMs : COMMIT_THROTTLE_MS;

    var settingsUi = {
      panel: null,
      anchorEl: null,
      longPressTimer: null,
      longPressOrigin: null,
    };
    var seatState = null; // { el, previousColor }
    var tooltipEl = null;
    var tooltipAnchor = null;
    var lastStarRatePct = null;
    var submenuEl = null;
    var submenuListEl = null;
    var submenuListSignature = "";
    var submenuRowRefs = [];
    var submenuOpen = false;
    var submenuPinned = false;
    var submenuCloseTimer = null;

    function createBadgeIcon(kind) {
      var wrap = doc.createElement("span");
      wrap.className = "ces-ag-model-badge__icon";
      wrap.setAttribute("aria-hidden", "true");
      if (typeof doc.createElementNS === "function") {
        var ns = "http://www.w3.org/2000/svg";
        var svg = doc.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", kind === "warn" ? "14" : "11");
        svg.setAttribute("height", kind === "warn" ? "14" : "11");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        if (kind === "warn") {
          var p1 = doc.createElementNS(ns, "path");
          p1.setAttribute("d", "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3");
          var p2 = doc.createElementNS(ns, "path");
          p2.setAttribute("d", "M12 9v4");
          var p3 = doc.createElementNS(ns, "path");
          p3.setAttribute("d", "M12 17h.01");
          svg.appendChild(p1);
          svg.appendChild(p2);
          svg.appendChild(p3);
        } else {
          var c = doc.createElementNS(ns, "circle");
          c.setAttribute("cx", "12");
          c.setAttribute("cy", "12");
          c.setAttribute("r", "10");
          var l1 = doc.createElementNS(ns, "path");
          l1.setAttribute("d", "M12 16v-4");
          var l2 = doc.createElementNS(ns, "path");
          l2.setAttribute("d", "M12 8h.01");
          svg.appendChild(c);
          svg.appendChild(l1);
          svg.appendChild(l2);
        }
        wrap.appendChild(svg);
      } else {
        wrap.textContent = kind === "warn" ? "\u26A0" : "\u24D8";
      }
      return wrap;
    }

    function ensureTooltipEl() {
      if (tooltipEl && tooltipEl.parentNode) return tooltipEl;
      if (!doc.body) return null;
      if (!tooltipEl) {
        tooltipEl = doc.createElement("div");
        tooltipEl.className = "ces-ag-tooltip";
        tooltipEl.setAttribute("data-ces-part", "model-tooltip");
        tooltipEl.setAttribute("role", "tooltip");
        tooltipEl.style.display = "none";
      }
      doc.body.appendChild(tooltipEl);
      return tooltipEl;
    }

    function positionTooltip(anchorEl) {
      if (!tooltipEl || !anchorEl) return;
      var rect = typeof anchorEl.getBoundingClientRect === "function"
        ? anchorEl.getBoundingClientRect()
        : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      var vw = (win && typeof win.innerWidth === "number" && win.innerWidth > 0)
        ? win.innerWidth
        : ((doc.documentElement && doc.documentElement.clientWidth) || 1024);
      var vh = (win && typeof win.innerHeight === "number" && win.innerHeight > 0)
        ? win.innerHeight
        : ((doc.documentElement && doc.documentElement.clientHeight) || 768);
      var tipW = tooltipEl.offsetWidth || 200;
      var tipH = tooltipEl.offsetHeight || 34;
      var left = Math.round(rect.left + (rect.width || 0) / 2 - tipW / 2);
      left = Math.max(8, Math.min(vw - tipW - 8, left));
      var top = Math.round(rect.top - tipH - 6);
      if (top < 8) top = Math.round((rect.bottom || rect.top + (rect.height || 0)) + 6);
      if (top + tipH > vh - 8) top = Math.max(8, vh - tipH - 8);
      tooltipEl.style.left = left + "px";
      tooltipEl.style.top = top + "px";
    }

    function showTooltip(anchorEl, text) {
      if (disposed || !anchorEl || !text) return;
      var tip = ensureTooltipEl();
      if (!tip) return;
      tooltipAnchor = anchorEl;
      tip.textContent = text;
      tip.style.display = "block";
      tip.style.visibility = "hidden";
      positionTooltip(anchorEl);
      tip.style.visibility = "visible";
    }

    function hideTooltip(onlyAnchor) {
      if (onlyAnchor && tooltipAnchor !== onlyAnchor) return;
      tooltipAnchor = null;
      if (tooltipEl) {
        tooltipEl.style.display = "none";
      }
    }

    function disposeTooltip() {
      tooltipAnchor = null;
      if (tooltipEl) {
        try {
          if (tooltipEl.parentNode) tooltipEl.parentNode.removeChild(tooltipEl);
        } catch (e) { /* 忽略 */ }
        tooltipEl = null;
      }
    }

    function cancelSubmenuClose() {
      if (submenuCloseTimer !== null) {
        clearTimeout(submenuCloseTimer);
        submenuCloseTimer = null;
      }
    }

    function ensureSubmenuEl() {
      if (submenuEl && submenuEl.parentNode) return submenuEl;
      if (!doc.body) return null;
      if (!submenuEl) {
        submenuEl = doc.createElement("div");
        submenuEl.className = "ces-ag-submenu";
        submenuEl.setAttribute("data-ces-part", "model-submenu");
        submenuEl.setAttribute("role", "dialog");
        submenuEl.setAttribute("aria-label", "Select model");
        submenuEl.style.display = "none";

        var subHeader = doc.createElement("div");
        subHeader.className = "ces-ag-list-header";
        subHeader.setAttribute("data-ces-part", "list-header");
        subHeader.textContent = "Select Model";

        submenuListEl = doc.createElement("div");
        submenuListEl.className = "ces-ag-model-list";
        submenuListEl.setAttribute("data-ces-part", "model-list");
        submenuListEl.setAttribute("role", "listbox");
        submenuListEl.setAttribute("aria-label", "Select model");
        submenuListEl.addEventListener("scroll", function () { hideTooltip(); });

        submenuEl.appendChild(subHeader);
        submenuEl.appendChild(submenuListEl);

        submenuEl.addEventListener("mouseenter", function () {
          cancelSubmenuClose();
        });
        submenuEl.addEventListener("mouseleave", function () {
          if (!submenuPinned) scheduleCloseSubmenu();
        });
      }
      doc.body.appendChild(submenuEl);
      return submenuEl;
    }

    function positionSubmenu() {
      if (!submenuEl || !hostState) return;
      var rawPanel = hostState.panel;
      var panelAnchor = (rawPanel && rawPanel.parentNode && rawPanel.parentNode !== doc.body && rawPanel.parentNode !== doc.documentElement && rawPanel.parentNode.nodeType === 1)
        ? rawPanel.parentNode
        : (rawPanel || hostState.container);
      var rowAnchor = hostState.modelTriggerBtn || panelAnchor;
      if (!panelAnchor || typeof panelAnchor.getBoundingClientRect !== "function") return;
      var pRect = panelAnchor.getBoundingClientRect();
      var rRect = rowAnchor && typeof rowAnchor.getBoundingClientRect === "function"
        ? rowAnchor.getBoundingClientRect()
        : pRect;
      var vw = (win && typeof win.innerWidth === "number" && win.innerWidth > 0)
        ? win.innerWidth
        : ((doc.documentElement && doc.documentElement.clientWidth) || 1024);
      var vh = (win && typeof win.innerHeight === "number" && win.innerHeight > 0)
        ? win.innerHeight
        : ((doc.documentElement && doc.documentElement.clientHeight) || 768);
      var subW = submenuEl.offsetWidth || 280;
      var subH = submenuEl.offsetHeight || 240;
      var rightPos = Math.round((pRect.right || (pRect.left + (pRect.width || 264))) + 6);
      var left = rightPos + subW <= vw - 8
        ? rightPos
        : Math.max(8, Math.round((pRect.left || 0) - subW - 6));
      left = Math.max(8, Math.min(vw - subW - 8, left));
      var top = Math.max(8, Math.min(vh - subH - 8, Math.round((rRect.top || 0) - 6)));
      submenuEl.style.left = left + "px";
      submenuEl.style.top = top + "px";
    }

    function syncTriggerButtonVisual() {
      if (!hostState || !hostState.modelTriggerBtn) return;
      hostState.modelTriggerBtn.setAttribute("data-open", submenuOpen ? "1" : "0");
      hostState.modelTriggerBtn.setAttribute("aria-expanded", submenuOpen ? "true" : "false");
    }

    function openSubmenu(pin) {
      if (disposed || !hostState) return;
      cancelSubmenuClose();
      var el = ensureSubmenuEl();
      if (!el) return;
      submenuOpen = true;
      if (typeof pin === "boolean") submenuPinned = pin;
      syncModelList();
      el.style.display = "flex";
      el.style.visibility = "hidden";
      positionSubmenu();
      el.style.visibility = "visible";
      syncTriggerButtonVisual();
    }

    function closeSubmenu() {
      cancelSubmenuClose();
      submenuOpen = false;
      submenuPinned = false;
      hideTooltip();
      if (submenuEl) {
        submenuEl.style.display = "none";
      }
      syncTriggerButtonVisual();
    }

    function scheduleCloseSubmenu() {
      cancelSubmenuClose();
      submenuCloseTimer = setTimeout(function () {
        submenuCloseTimer = null;
        if (!submenuPinned) closeSubmenu();
      }, 160);
    }

    function disposeSubmenu() {
      closeSubmenu();
      submenuListSignature = "";
      submenuRowRefs = [];
      submenuListEl = null;
      if (submenuEl) {
        try {
          if (submenuEl.parentNode) submenuEl.parentNode.removeChild(submenuEl);
        } catch (e) { /* 忽略 */ }
        submenuEl = null;
      }
    }

    function nowMs() {
      if (win && win.performance && typeof win.performance.now === "function") return win.performance.now();
      if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
      return Date.now();
    }

    function scheduleFrame(cb) {
      if (win && typeof win.requestAnimationFrame === "function") {
        return { raf: true, id: win.requestAnimationFrame(cb) };
      }
      return { raf: false, id: setTimeout(function () { cb(nowMs()); }, 16) };
    }

    function cancelFrame(handle) {
      if (!handle) return;
      if (handle.raf) {
        if (win && typeof win.cancelAnimationFrame === "function") win.cancelAnimationFrame(handle.id);
      } else {
        clearTimeout(handle.id);
      }
    }

    function installStyles() {
      try {
        if (!doc.head) return null;
        var existing = doc.querySelector('style[data-plugin-css="' + STYLE_MARKER + '"]');
        if (existing) return existing;
        var style = doc.createElement("style");
        style.setAttribute("data-plugin-css", STYLE_MARKER);
        style.textContent = CSS;
        doc.head.appendChild(style);
        return style;
      } catch (e) {
        return null;
      }
    }

    function uninstallStyles() {
      try {
        var styles = doc.querySelectorAll('style[data-plugin-css="' + STYLE_MARKER + '"]');
        for (var i = 0; i < styles.length; i += 1) {
          if (styles[i].parentNode) styles[i].parentNode.removeChild(styles[i]);
        }
      } catch (e) { /* 忽略 */ }
    }

    function isOwnNode(node) {
      if (!node || typeof node.closest !== "function") return false;
      return !!(node.closest(".ces-inline") || node.closest(".ces-ag-submenu") || node.closest(".ces-ag-tooltip") || node.closest(".ces-set"));
    }

    function effectiveIndex() {
      if (optimistic !== null) {
        for (var i = 0; i < levels.length; i += 1) {
          if (levels[i].id === optimistic.id) return i;
        }
      }
      return Math.max(0, Math.min(Math.max(0, levels.length - 1), activeIndex));
    }

    function effectivePct() {
      return pctFromIndex(effectiveIndex(), levels.length);
    }

    function currentShown() {
      var effIdx = effectiveIndex();
      var effPct = pctFromIndex(effIdx, levels.length);
      var idx = draft !== null ? draft.index : effIdx;
      var pct = draft !== null && typeof draft.pct === "number" ? draft.pct : effPct;
      return { index: idx, pct: pct, effIndex: effIdx, effPct: effPct, level: levels[idx] || null };
    }

    /* ── 原生節點隱藏與還原 ── */
    function hideNativeNode(el) {
      if (!el || !el.style) return;
      for (var i = 0; i < hiddenDomNodes.length; i += 1) {
        if (hiddenDomNodes[i].el === el) {
          if (el.style.display !== "none") el.style.display = "none";
          return;
        }
      }
      hiddenDomNodes.push({ el: el, prevDisplay: el.style.display || "" });
      if (typeof el.setAttribute === "function") el.setAttribute("data-ces-hidden", "1");
      el.style.display = "none";
    }

    function restoreHiddenNodes() {
      for (var i = 0; i < hiddenDomNodes.length; i += 1) {
        var rec = hiddenDomNodes[i];
        try {
          if (rec.el && rec.el.style) rec.el.style.display = rec.prevDisplay;
          if (rec.el && typeof rec.el.removeAttribute === "function") rec.el.removeAttribute("data-ces-hidden");
        } catch (e) { /* 忽略 */ }
      }
      hiddenDomNodes = [];
    }

    function hideNativePanelParts(panel) {
      if (!panel || !panel.children) return;
      var listMarkersSelector = '[data-testid="model-selector-header"],[data-testid="model-selector-effort-group"],[data-testid="model-selector-item"],[data-testid="model-selector-custom-item"],[data-testid="model-selector-empty"]';
      var directListSelector = '[data-testid="model-selector-header"],[data-testid="model-selector-effort-group"],[data-testid="model-selector-item"],[data-testid="model-selector-custom-item"],[data-testid="model-selector-empty"],[data-testid="model-selector-refresh"]';
      var children = [];
      for (var i = 0; i < panel.children.length; i += 1) children.push(panel.children[i]);

      for (var c = 0; c < children.length; c += 1) {
        var child = children[c];
        if (!child || (hostState && child === hostState.container)) continue;
        if (typeof child.matches === "function" && child.matches(directListSelector)) {
          hideNativeNode(child);
          continue;
        }
        var hasList = typeof child.querySelector === "function" && child.querySelector(listMarkersSelector);
        if (hasList) {
          hideNativeNode(child);
        }
      }

      var popups = findNativeSubmenuPopups(doc, panel);
      for (var p = 0; p < popups.length; p += 1) {
        hideNativeNode(popups[p]);
      }
    }

    /* ── 觸發鈕顏色同步 ── */
    function releaseSeat() {
      if (!seatState) return;
      try {
        if (seatState.el && seatState.el.style) seatState.el.style.color = seatState.previousColor;
      } catch (e) { /* 忽略 */ }
      seatState = null;
    }

    function syncTrigger() {
      var trigger = typeof doc.querySelector === "function" ? doc.querySelector('[data-testid="model-selector-trigger"]') : null;
      var info = parseTriggerEffort(trigger);
      if (!info || !info.el || !info.el.style) {
        releaseSeat();
        return;
      }
      if (!seatState || seatState.el !== info.el) {
        releaseSeat();
        seatState = { el: info.el, previousColor: info.el.style.color || "" };
      }
      var base = extractTriggerModelBase(trigger);
      var cached = base && modelEffortsCache[base];
      var pct = null;
      if (cached && cached.length > 0) {
        for (var i = 0; i < cached.length; i += 1) {
          if (cached[i].id === info.id) {
            pct = pctFromIndex(i, cached.length);
            break;
          }
        }
      }
      if (pct === null) {
        pct = Object.prototype.hasOwnProperty.call(FALLBACK_EFFORT_PCT, info.id) ? FALLBACK_EFFORT_PCT[info.id] : 0.5;
      }
      info.el.style.color = valueColorFor(pct, { id: info.id, name: info.label });
    }

    /* ── 設定面板 ── */
    function disposeSettingsPanel() {
      try {
        var stale = doc.querySelectorAll(".ces-set");
        for (var i = 0; i < stale.length; i += 1) {
          if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
        }
      } catch (e) { /* 忽略 */ }
      settingsUi.panel = null;
    }

    function closeSettingsPanel() {
      var panel = settingsUi.panel;
      if (!panel || panel.style.display === "none") return;
      panel.style.display = "none";
      try {
        if (settingsUi.anchorEl && typeof settingsUi.anchorEl.focus === "function") settingsUi.anchorEl.focus();
      } catch (e) { /* 忽略 */ }
    }

    function syncSettingsPanel() {
      var panel = settingsUi.panel;
      if (!panel) return;
      var s = settingsStore.read();
      for (var i = 0; i < SETTINGS_SCHEMA.length; i += 1) {
        var item = SETTINGS_SCHEMA[i];
        var radios = panel.querySelectorAll('[data-ces-key="' + item.key + '"]');
        for (var r = 0; r < radios.length; r += 1) radios[r].checked = radios[r].value === s[item.key];
      }
      var sys = panel.querySelector("[data-ces-system]");
      if (sys) sys.textContent = "三種動畫都不受系統「減少動態效果」影響";
    }

    function openSettingsPanel(rect, anchorEl) {
      if (!doc.body) return;
      disposeSettingsPanel();
      var s = settingsStore.read();
      var esc = function (v) {
        return String(v === undefined || v === null ? "" : v)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      };
      var bodyHtml = "";
      for (var i = 0; i < SETTINGS_SCHEMA.length; i += 1) {
        var item = SETTINGS_SCHEMA[i];
        var optsHtml = "";
        for (var j = 0; j < item.options.length; j += 1) {
          var o = item.options[j];
          optsHtml += '<label><input type="radio" name="ces-' + esc(item.key) + '" data-ces-key="' + esc(item.key) +
            '" value="' + esc(o.value) + '"' + (s[item.key] === o.value ? " checked" : "") + "> " + esc(o.label) + "</label>";
        }
        bodyHtml += '<div class="ces-set__group" role="radiogroup" aria-label="' + esc(item.group) + '">' +
          '<div class="ces-set__row">' + esc(item.group) + "</div>" + optsHtml + "</div>";
      }

      var panel = doc.createElement("div");
      panel.className = "ces-set";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "推理等級滑條設定");
      panel.setAttribute("tabindex", "-1");
      panel.innerHTML =
        '<div class="ces-set__title">滑條設定</div>' +
        '<div class="ces-set__row" data-ces-system></div>' +
        bodyHtml +
        '<div class="ces-set__actions">' +
        '<button type="button" data-ces-trace>複製診斷</button>' +
        '<button type="button" data-ces-reset>恢復預設</button>' +
        '<button type="button" data-ces-close>關閉</button>' +
        "</div>";

      var applyInput = function (input) {
        if (!input || typeof input.getAttribute !== "function") return;
        var key = input.getAttribute("data-ces-key");
        if (!key) return;
        var patch = {};
        patch[key] = input.value;
        settingsStore.write(patch);
        syncSettingsPanel();
        renderSlider();
      };
      panel.addEventListener("input", function (ev) { applyInput(ev.target); });
      panel.addEventListener("change", function (ev) { applyInput(ev.target); });
      panel.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var el = ev.target;
        if (!el || typeof el.hasAttribute !== "function") return;
        if (el.hasAttribute("data-ces-trace")) {
          var txt = trace.dump(settingsStore.read);
          try {
            if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
              win.navigator.clipboard.writeText(txt);
              el.textContent = "已複製";
            } else {
              el.textContent = "無法複製";
            }
          } catch (err) {
            el.textContent = "無法複製";
          }
          setTimeout(function () { el.textContent = "複製診斷"; }, 1500);
        } else if (el.hasAttribute("data-ces-reset")) {
          settingsStore.write(schemaDefaults());
          syncSettingsPanel();
          renderSlider();
        } else if (el.hasAttribute("data-ces-close")) {
          closeSettingsPanel();
        }
      });
      panel.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
      panel.addEventListener("mousedown", function (ev) { ev.stopPropagation(); });

      doc.body.appendChild(panel);
      settingsUi.panel = panel;
      settingsUi.anchorEl = anchorEl || null;
      syncSettingsPanel();
      panel.style.display = "block";
      var width = panel.offsetWidth || 280;
      var height = panel.offsetHeight || 200;
      var x = rect ? rect.left : 40;
      var y = rect ? rect.bottom + 6 : 80;
      var maxX = ((win && win.innerWidth) || 1024) - width - 8;
      var maxY = ((win && win.innerHeight) || 768) - height - 8;
      panel.style.left = Math.max(8, Math.min(x, maxX)) + "px";
      panel.style.top = Math.max(8, Math.min(y, maxY)) + "px";
      try { panel.focus(); } catch (e) { /* 忽略 */ }
    }

    /* ── 提交寫回 (優先使用 React Fiber setSelectedModel，無 Fiber 時退回 DOM 點擊) ── */
    function clearOptimisticTimer() {
      if (optimistic && optimistic.timer !== null) {
        clearTimeout(optimistic.timer);
        optimistic.timer = null;
      }
    }

    function rollbackOptimistic(message) {
      clearOptimisticTimer();
      optimistic = null;
      errorMsg = message || "Failed to switch reasoning effort (rolled back)";
      renderSlider();
    }

    function keepFocusInPanel() {
      if (!hostState || !hostState.container) return;
      try {
        var active = doc.activeElement;
        if (!active || !hostState.container.contains(active)) {
          if (hostState.trackEl && typeof hostState.trackEl.focus === "function") {
            hostState.trackEl.focus({ preventScroll: true });
          }
        }
      } catch (e) { /* 忽略 */ }
    }

    function invokeSetSelectedModel(targetOption) {
      if (!activeCtx || typeof activeCtx.setSelectedModel !== "function") {
        return { ok: false, error: "ModelSelector setter unavailable" };
      }
      var panelEl = hostState && hostState.panel ? hostState.panel : null;
      var htmlProto = win && win.HTMLElement && win.HTMLElement.prototype ? win.HTMLElement.prototype : null;
      var origFocus = htmlProto && typeof htmlProto.focus === "function" ? htmlProto.focus : null;
      if (htmlProto && origFocus && panelEl) {
        // 阻止 $Qc 內部的 w()?.focus() 將焦點拉回外部編輯器，避免 Base UI Popover 因失焦自動關閉
        htmlProto.focus = function () {
          try {
            if (panelEl.contains(this)) {
              return origFocus.apply(this, arguments);
            }
          } catch (e) { /* 忽略 */ }
        };
      }
      try {
        activeCtx.setSelectedModel(targetOption);
        keepFocusInPanel();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      } finally {
        if (htmlProto && origFocus && htmlProto.focus !== origFocus) {
          htmlProto.focus = origFocus;
        }
      }
    }

    function clickDomElement(el) {
      if (!el) return { ok: false, error: "Target element missing" };
      if (typeof el.click === "function") {
        el.click();
        return { ok: true };
      }
      if (typeof el.dispatchEvent === "function") {
        var MouseEv = (win && win.MouseEvent) || (typeof MouseEvent === "function" ? MouseEvent : null);
        if (MouseEv) {
          el.dispatchEvent(new MouseEv("click", { bubbles: true, cancelable: true }));
          return { ok: true };
        }
      }
      return { ok: false, error: "Target element is not clickable" };
    }

    function activateLevel(levelId) {
      var target = null;
      for (var i = 0; i < levels.length; i += 1) {
        if (levels[i].id === levelId) {
          target = levels[i];
          break;
        }
      }
      if (!target) return { ok: false, error: "Effort option unavailable: " + levelId };
      if (target.disabled) return { ok: false, error: "Effort option is disabled: " + target.name };

      if (activeCtx && target.option) {
        return invokeSetSelectedModel(target.option);
      }
      if (target.targetEl) {
        return clickDomElement(target.targetEl);
      }
      return { ok: false, error: "Effort target unavailable: " + levelId };
    }

    function selectModelItem(item) {
      if (!item || item.disabled) return;
      errorMsg = null;
      if (activeCtx && item.targetOption) {
        if (item.isMultiEffort) {
          var nextLevels = item.levels || [];
          var nextIdx = 0;
          for (var i = 0; i < nextLevels.length; i += 1) {
            if (nextLevels[i].id === item.currentEffort) {
              nextIdx = i;
              break;
            }
          }
          levels = nextLevels;
          activeIndex = nextIdx;
          if (item.base && levels.length > 0) modelEffortsCache[item.base] = levels;
          draft = null;
          snapIndex = null;
          motion = null;
        } else {
          levels = [];
          activeIndex = 0;
          draft = null;
          snapIndex = null;
          motion = null;
        }
        clearOptimisticTimer();
        var selTimer = setTimeout(function () {
          if (optimistic && optimistic.selectedModel && sameModelOption(optimistic.selectedModel, item.targetOption)) {
            rollbackOptimistic("Model switch timed out (rolled back)");
          }
        }, commitDeadlineMs);
        optimistic = {
          id: item.currentEffort || null,
          selectedModel: item.targetOption,
          timer: selTimer,
        };
        var res = invokeSetSelectedModel(item.targetOption);
        if (!res.ok) {
          rollbackOptimistic(res.error);
        } else {
          if (unifiedState && unifiedState.items) {
            for (var j = 0; j < unifiedState.items.length; j += 1) {
              unifiedState.items[j].isActive = unifiedState.items[j].key === item.key;
            }
          }
          renderSlider();
          syncTrigger();
          closeSubmenu();
        }
        return;
      }

      if (item.targetEl) {
        clickDomElement(item.targetEl);
        closeSubmenu();
        scan();
      }
    }

    function flushCommit() {
      if (commitState.timer !== null) {
        clearTimeout(commitState.timer);
        commitState.timer = null;
      }
      var levelId = commitState.queued;
      commitState.queued = null;
      trace.push({ k: "flush", id: levelId });
      if (!levelId || levels.length === 0) return;

      var currentActive = levels[activeIndex] ? levels[activeIndex].id : null;
      if (currentActive === levelId && optimistic === null) {
        trace.push({ k: "flush-skip", id: levelId, why: "dedupe" });
        return;
      }

      var targetOption = null;
      for (var i = 0; i < levels.length; i += 1) {
        if (levels[i].id === levelId) {
          targetOption = levels[i].option || null;
          break;
        }
      }

      commitState.inFlight = true;
      clearOptimisticTimer();
      var timer = setTimeout(function () {
        if (optimistic && optimistic.id === levelId) {
          rollbackOptimistic("Effort change timed out (rolled back)");
        }
      }, commitDeadlineMs);
      optimistic = { id: levelId, selectedModel: targetOption, timer: timer };
      errorMsg = null;
      renderSlider();

      var res = activateLevel(levelId);
      commitState.inFlight = false;
      if (!res || res.ok === false) {
        trace.push({ k: "commit-fail", id: levelId, err: res && res.error });
        rollbackOptimistic(res && res.error);
      } else {
        trace.push({ k: "commit-ok", id: levelId });
        syncTrigger();
      }
      if (commitState.queued !== null) flushCommit();
    }

    function requestCommit(levelId, immediate) {
      if (!levelId || levels.length === 0) return;
      var currentActive = levels[activeIndex] ? levels[activeIndex].id : null;
      if (currentActive === levelId && commitState.queued === null && !commitState.inFlight && optimistic === null) {
        return;
      }
      commitState.queued = levelId;
      trace.push({ k: "req", id: levelId, imm: immediate === true });
      if (commitState.inFlight) return;
      if (immediate === true) {
        flushCommit();
        return;
      }
      if (commitState.timer !== null) return;
      commitState.timer = setTimeout(function () {
        commitState.timer = null;
        flushCommit();
      }, commitThrottleMs);
    }

    /* ── 物理運動迴圈 ── */
    function ensureMotion() {
      if (motion === null) {
        var x0 = draft !== null && typeof draft.pct === "number" ? draft.pct : effectivePct();
        motion = { x: x0, v: 0, a: 0, target: x0, vPtr: 0 };
      }
      return motion;
    }

    function draftIndexFor(m) {
      if (dragging) return indexFromPct(m.x, levels.length);
      return snapIndex !== null ? snapIndex : indexFromPct(m.x, levels.length);
    }

    function publishMotion(m) {
      var next = { pct: m.x, index: draftIndexFor(m) };
      if (draft !== null && draft.pct === next.pct && draft.index === next.index) return;
      draft = next;
      renderSlider();
    }

    function startFrames() {
      if (frameHandle !== null) return;
      lastTs = nowMs();
      var step = function (ts) {
        frameHandle = null;
        if (disposed || motion === null) return;
        var p = motionParamsForMode(settingsStore.read().motion);
        var dt = Math.min(MAX_FRAME_DT, Math.max(0.001, (ts - lastTs) / 1000));
        lastTs = ts;
        var sincePtr = (ts - lastPointerAt) / 1000;
        motion.vPtr = decayPointerSpeed(motion.vPtr, sincePtr, POINTER_STALE_S, POINTER_SPEED_TAU);
        motionStep(motion, dt, p);
        if (motionSettled(motion, p)) {
          motion.x = motion.target;
          motion.v = 0;
          motion.a = 0;
          if (dragging) {
            publishMotion(motion);
            frameHandle = scheduleFrame(step);
            return;
          }
          var effPct = effectivePct();
          if (Math.abs(effPct - motion.target) > 0.001 && holdFrames < 45) {
            holdFrames += 1;
            draft = { pct: motion.target, index: snapIndex };
            renderSlider();
            frameHandle = scheduleFrame(step);
            return;
          }
          holdFrames = 0;
          draft = null;
          snapIndex = null;
          renderSlider();
          return;
        }
        publishMotion(motion);
        frameHandle = scheduleFrame(step);
      };
      frameHandle = scheduleFrame(step);
    }

    function pctAt(clientX) {
      if (!hostState || !hostState.trackEl || typeof hostState.trackEl.getBoundingClientRect !== "function") return null;
      var rect = hostState.trackEl.getBoundingClientRect();
      var usable = rect.width - KNOB_RADIUS * 2;
      if (!(usable > 0)) return null;
      return clamp01((clientX - rect.left - KNOB_RADIUS) / usable);
    }

    function moveTo(clientX) {
      if (levels.length <= 1) return;
      var pct = pctAt(clientX);
      if (pct === null) return;
      var m = ensureMotion();
      var now = nowMs();
      var dtPtr = (now - lastPointerAt) / 1000;
      if (lastPtrPct !== null && dtPtr > 0.001) {
        var raw = (pct - lastPtrPct) / dtPtr;
        m.vPtr = m.vPtr * (1 - POINTER_SPEED_EMA) + clampAbs(raw, MOTION.vmax) * POINTER_SPEED_EMA;
      }
      lastPtrPct = pct;
      lastPointerAt = now;

      var fastMode = settingsStore.read().motion === "fast";
      if (fastMode) {
        var pos = pct * Math.max(1, levels.length - 1);
        var curDetent = detentIndex;
        if (!(curDetent >= 0)) curDetent = indexFromPct(m.target, levels.length);
        curDetent = detentTargetIndex(pos, curDetent, levels.length, DETENT_THIRD);
        detentIndex = curDetent;
        m.target = pctFromIndex(curDetent, levels.length);
      } else {
        m.target = pct;
        m.x = pct;
        m.v = 0;
        m.a = 0;
        publishMotion(m);
      }

      if (commitOnDrag && levels.length > 0) {
        var nowIndex = fastMode ? detentIndex : indexFromPct(pct, levels.length);
        var nowId = levels[nowIndex] ? levels[nowIndex].id : null;
        if (nowId && nowId !== lastCommittedId) {
          lastCommittedId = nowId;
          requestCommit(nowId, false);
        }
      }
      if (fastMode) startFrames();
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (hostState && hostState.container) {
        hostState.container.setAttribute("data-dragging", "0");
      }
      if (levels.length === 0) return;
      var m = ensureMotion();
      var idx;
      if (settingsStore.read().motion === "fast") {
        idx = detentIndex >= 0 ? detentIndex : indexFromPct(m.target, levels.length);
        idx = Math.max(0, Math.min(levels.length - 1, idx));
        m.vPtr = 0;
        m.target = pctFromIndex(idx, levels.length);
      } else {
        idx = releaseIndexFor(m.target, m.vPtr, levels.length);
        m.vPtr = 0;
        m.target = pctFromIndex(idx, levels.length);
      }
      snapIndex = idx;
      if (levels[idx]) requestCommit(levels[idx].id, true);
      trace.push({ k: "release", idx: idx, x: Math.round(m.x * 1000) / 1000, target: Math.round(m.target * 1000) / 1000 });
      publishMotion(m);
      startFrames();
    }

    function swallow(ev) {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    }

    /* ── 雙層面板 DOM 建立（第一層：滑條 + Model Select 入口；第二層：右側 Select Model） ── */
    function buildSelectorDom(panel) {
      var container = doc.createElement("div");
      container.className = "ces-inline ces-ag-selector";
      container.setAttribute("data-ces-part", "host");
      container.setAttribute("data-dragging", "0");

      var modelTriggerBtn = doc.createElement("button");
      modelTriggerBtn.type = "button";
      modelTriggerBtn.className = "ces-ag-model-trigger-row";
      modelTriggerBtn.setAttribute("data-ces-part", "model-select-trigger");
      modelTriggerBtn.setAttribute("aria-haspopup", "listbox");
      modelTriggerBtn.setAttribute("aria-expanded", "false");

      var triggerMain = doc.createElement("span");
      triggerMain.className = "ces-ag-model-trigger-main";

      var triggerLabel = doc.createElement("span");
      triggerLabel.className = "ces-ag-model-trigger-label";
      triggerLabel.textContent = "Select Model";

      var triggerCurrentEl = doc.createElement("span");
      triggerCurrentEl.className = "ces-ag-model-trigger-current";
      triggerCurrentEl.setAttribute("data-ces-part", "current-model");

      var triggerArrow = doc.createElement("span");
      triggerArrow.className = "ces-ag-model-trigger-arrow";
      triggerArrow.setAttribute("aria-hidden", "true");
      triggerArrow.textContent = "\u203A";

      triggerMain.appendChild(triggerLabel);
      triggerMain.appendChild(triggerCurrentEl);
      modelTriggerBtn.appendChild(triggerMain);
      modelTriggerBtn.appendChild(triggerArrow);

      modelTriggerBtn.addEventListener("mouseenter", function () {
        if (dragging) return;
        openSubmenu();
      });
      modelTriggerBtn.addEventListener("mouseleave", function () {
        if (!submenuPinned) scheduleCloseSubmenu();
      });
      modelTriggerBtn.addEventListener("click", function (ev) {
        swallow(ev);
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        if (submenuOpen && submenuPinned) {
          closeSubmenu();
        } else {
          openSubmenu(true);
        }
      });

      var sliderSection = doc.createElement("div");
      sliderSection.className = "ces-ag-slider-section";
      sliderSection.setAttribute("data-ces-part", "slider-section");

      var head = doc.createElement("div");
      head.className = "ces-ag-head";
      var labelEl = doc.createElement("span");
      labelEl.className = "ces-ag-label";
      labelEl.textContent = "Reasoning effort";
      var headValueEl = doc.createElement("span");
      headValueEl.className = "ces-ag-value";
      headValueEl.setAttribute("data-ces-part", "value");
      head.appendChild(labelEl);
      head.appendChild(headValueEl);

      var trackEl = doc.createElement("div");
      trackEl.className = "ces-track";
      trackEl.setAttribute("data-ces-part", "track");
      trackEl.setAttribute("role", "slider");
      trackEl.setAttribute("tabindex", "0");
      trackEl.setAttribute("aria-label", "Reasoning effort");

      var fillEl = doc.createElement("div");
      fillEl.className = "ces-fill";
      fillEl.setAttribute("data-ces-part", "fill");

      var energyEl = doc.createElement("div");
      energyEl.className = "ces-energy";
      energyEl.setAttribute("data-ces-part", "energy");
      var sweepEl = doc.createElement("div");
      sweepEl.className = "ces-energy__sweep";
      sweepEl.setAttribute("data-ces-part", "sweep");
      energyEl.appendChild(sweepEl);

      var starsEl = doc.createElement("div");
      starsEl.className = "ces-stars";
      starsEl.setAttribute("data-ces-part", "stars");

      var starDots = [];
      for (var s = 0; s < PARTICLES.length; s += 1) {
        var starEl = doc.createElement("span");
        starEl.className = "ces-star";
        starEl.setAttribute("data-ces-part", "star");
        var dur = starDurationFor(s);
        starEl.style.top = PARTICLES[s].y + "%";
        starEl.style.animationDuration = dur.toFixed(3) + "s";
        starEl.style.animationDelay = starDelayFor(s, dur).toFixed(3) + "s";

        var dotEl = doc.createElement("span");
        dotEl.className = "ces-star__dot";
        dotEl.setAttribute("data-ces-part", "particle");
        starEl.appendChild(dotEl);
        starsEl.appendChild(starEl);
        starDots.push({ starEl: starEl, dotEl: dotEl });
      }

      var ticksWrap = doc.createElement("div");
      ticksWrap.setAttribute("data-ces-part", "ticks");

      var knobEl = doc.createElement("div");
      knobEl.className = "ces-knob";
      knobEl.setAttribute("data-ces-part", "knob");

      var errorEl = doc.createElement("div");
      errorEl.className = "ces-error";
      errorEl.setAttribute("data-ces-part", "error");
      errorEl.setAttribute("role", "status");
      errorEl.style.display = "none";

      trackEl.appendChild(fillEl);
      trackEl.appendChild(energyEl);
      trackEl.appendChild(starsEl);
      trackEl.appendChild(ticksWrap);
      trackEl.appendChild(knobEl);

      sliderSection.appendChild(head);
      sliderSection.appendChild(trackEl);
      sliderSection.appendChild(errorEl);

      container.appendChild(modelTriggerBtn);
      container.appendChild(sliderSection);

      var isolatedEvents = ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "mouseover", "mousemove", "mouseenter", "mouseleave", "mouseout"];
      for (var eIdx = 0; eIdx < isolatedEvents.length; eIdx += 1) {
        sliderSection.addEventListener(isolatedEvents[eIdx], swallow);
      }

      trackEl.addEventListener("pointerdown", function (ev) {
        if (ev && typeof ev.button === "number" && ev.button !== 0) return;
        if (levels.length <= 1) return;
        swallow(ev);
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        closeSubmenu();
        dragging = true;
        buttonDown = true;
        container.setAttribute("data-dragging", "1");
        lastCommittedId = null;
        detentIndex = -1;
        if (settingsStore.read().motion === "fast") {
          var p0 = pctAt(ev.clientX);
          if (p0 !== null) detentIndex = indexFromPct(p0, levels.length);
        }
        holdFrames = 0;
        snapIndex = null;
        try {
          if (typeof trackEl.setPointerCapture === "function" && ev.pointerId !== undefined) {
            trackEl.setPointerCapture(ev.pointerId);
          }
        } catch (err) { /* 忽略不支援的指標捕獲 */ }
        lastPtrPct = null;
        moveTo(ev.clientX);
      });

      trackEl.addEventListener("pointermove", function (ev) {
        if (!dragging) return;
        if (ev && ev.buttons === 0 && buttonDown !== true) return;
        swallow(ev);
        moveTo(ev.clientX);
      });

      trackEl.addEventListener("pointerup", function (ev) {
        swallow(ev);
        buttonDown = false;
        endDrag();
      });
      trackEl.addEventListener("pointercancel", function (ev) {
        swallow(ev);
        buttonDown = false;
        endDrag();
      });

      trackEl.addEventListener("keydown", function (ev) {
        if (levels.length <= 1) return;
        var key = ev.key;
        var cur = draft !== null ? draft.index : effectiveIndex();
        var next = null;
        if (key === "ArrowLeft" || key === "ArrowDown") next = Math.max(0, cur - 1);
        else if (key === "ArrowRight" || key === "ArrowUp") next = Math.min(levels.length - 1, cur + 1);
        else if (key === "Home") next = 0;
        else if (key === "End") next = levels.length - 1;
        else if (key === "Enter" || key === " ") {
          swallow(ev);
          if (typeof ev.preventDefault === "function") ev.preventDefault();
          if (levels[cur]) requestCommit(levels[cur].id, true);
          return;
        } else {
          return;
        }
        swallow(ev);
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        var m = ensureMotion();
        snapIndex = next;
        m.target = pctFromIndex(next, levels.length);
        m.vPtr = 0;
        publishMotion(m);
        startFrames();
        if (levels[next]) requestCommit(levels[next].id, false);
      });

      if (panel.firstChild) {
        panel.insertBefore(container, panel.firstChild);
      } else {
        panel.appendChild(container);
      }

      starRateCache = null;
      lastStarRatePct = null;
      return {
        panel: panel,
        container: container,
        modelTriggerBtn: modelTriggerBtn,
        triggerCurrentEl: triggerCurrentEl,
        sliderSection: sliderSection,
        headValueEl: headValueEl,
        trackEl: trackEl,
        fillEl: fillEl,
        energyEl: energyEl,
        starsEl: starsEl,
        starDots: starDots,
        ticksWrap: ticksWrap,
        tickEls: [],
        tickSignature: "",
        knobEl: knobEl,
        errorEl: errorEl,
      };
    }

    function syncModelTriggerRow() {
      if (!hostState || !hostState.triggerCurrentEl) return;
      var items = unifiedState && Array.isArray(unifiedState.items) ? unifiedState.items : [];
      var activeLabel = "";
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].isActive) {
          activeLabel = items[i].label || "";
          break;
        }
      }
      hostState.triggerCurrentEl.textContent = activeLabel;
      syncTriggerButtonVisual();
    }

    function syncModelList() {
      if (!submenuListEl) return;
      var items = unifiedState && Array.isArray(unifiedState.items) ? unifiedState.items : [];
      var sig = items.map(function (it) {
        return it.key + ":" + (it.disabled ? "1" : "0") + ":" + (it.badge || "") + ":" + (it.tagDescription || "") + ":" + (it.warningText || "");
      }).join("|");
      if (submenuListSignature !== sig) {
        submenuListSignature = sig;
        hideTooltip();
        while (submenuListEl.firstChild) submenuListEl.removeChild(submenuListEl.firstChild);
        submenuRowRefs = [];
        for (var i = 0; i < items.length; i += 1) {
          (function (idx) {
            var item = items[idx];
            var btn = doc.createElement("button");
            btn.type = "button";
            btn.className = "ces-ag-model-row";
            btn.setAttribute("role", "option");
            btn.setAttribute("data-ces-part", "model-row");
            btn.setAttribute("data-model-key", item.key);
            if (item.disabled) {
              btn.setAttribute("aria-disabled", "true");
            }

            var nameSpan = doc.createElement("span");
            nameSpan.className = "ces-ag-model-name";
            nameSpan.textContent = item.label;
            btn.appendChild(nameSpan);

            var metaSpan = doc.createElement("span");
            metaSpan.className = "ces-ag-model-meta";

            var warnSpan = null;
            if (item.warningText) {
              warnSpan = doc.createElement("span");
              warnSpan.className = "ces-ag-badge-warn";
              warnSpan.setAttribute("data-ces-part", "model-warning");
              warnSpan.setAttribute("aria-label", item.warningText);
              warnSpan.appendChild(createBadgeIcon("warn"));
              warnSpan.addEventListener("mouseenter", function (ev) { swallow(ev); showTooltip(warnSpan, item.warningText); });
              warnSpan.addEventListener("mouseleave", function (ev) { swallow(ev); hideTooltip(warnSpan); });
              metaSpan.appendChild(warnSpan);
            }

            var badgeSpan = null;
            if (item.badge) {
              badgeSpan = doc.createElement("span");
              badgeSpan.className = "ces-ag-model-badge";
              badgeSpan.setAttribute("data-ces-part", "model-badge");
              var badgeText = doc.createElement("span");
              badgeText.textContent = item.badge;
              badgeSpan.appendChild(badgeText);
              if (item.tagDescription) {
                badgeSpan.setAttribute("aria-label", item.tagDescription);
                badgeSpan.appendChild(createBadgeIcon("info"));
                badgeSpan.addEventListener("mouseenter", function (ev) { swallow(ev); showTooltip(badgeSpan, item.tagDescription); });
                badgeSpan.addEventListener("mouseleave", function (ev) { swallow(ev); hideTooltip(badgeSpan); });
              }
              metaSpan.appendChild(badgeSpan);
            }

            var effSpan = doc.createElement("span");
            effSpan.className = "ces-ag-model-effort";
            effSpan.setAttribute("data-ces-part", "row-effort");
            metaSpan.appendChild(effSpan);

            var checkSpan = doc.createElement("span");
            checkSpan.className = "ces-ag-model-check";
            checkSpan.textContent = "\u2713";
            metaSpan.appendChild(checkSpan);

            btn.appendChild(metaSpan);

            var rowTooltipText = item.tagDescription || item.warningText || null;
            var rowTooltipAnchor = (item.tagDescription ? badgeSpan : warnSpan) || btn;
            if (rowTooltipText) {
              btn.addEventListener("mouseenter", function (ev) {
                if (ev && ev.target && ev.target !== btn) {
                  if (warnSpan && (ev.target === warnSpan || (typeof warnSpan.contains === "function" && warnSpan.contains(ev.target)))) return;
                  if (badgeSpan && item.tagDescription && (ev.target === badgeSpan || (typeof badgeSpan.contains === "function" && badgeSpan.contains(ev.target)))) return;
                }
                showTooltip(rowTooltipAnchor, rowTooltipText);
              });
              btn.addEventListener("mouseleave", function () { hideTooltip(); });
              btn.addEventListener("focus", function () { showTooltip(rowTooltipAnchor, rowTooltipText); });
              btn.addEventListener("blur", function () { hideTooltip(); });
            }

            btn.addEventListener("click", function (ev) {
              swallow(ev);
              if (typeof ev.preventDefault === "function") ev.preventDefault();
              hideTooltip();
              var curItems = unifiedState && unifiedState.items ? unifiedState.items : [];
              if (curItems[idx] && !curItems[idx].disabled) selectModelItem(curItems[idx]);
            });
            submenuListEl.appendChild(btn);
            submenuRowRefs.push({ btn: btn, effSpan: effSpan, checkSpan: checkSpan });
          })(i);
        }
      }

      for (var r = 0; r < items.length && r < submenuRowRefs.length; r += 1) {
        var it = items[r];
        var ref = submenuRowRefs[r];
        ref.btn.setAttribute("data-active", it.isActive ? "1" : "0");
        ref.btn.setAttribute("aria-selected", it.isActive ? "true" : "false");
        ref.checkSpan.style.visibility = it.isActive ? "visible" : "hidden";
        if (it.isMultiEffort && it.currentEffort) {
          var shownEffName = effortDisplayName(it.currentEffort);
          var rowColor = "";
          if (it.isActive && levels.length > 0) {
            var cur = currentShown();
            shownEffName = cur.level ? cur.level.name : shownEffName;
            rowColor = valueColorFor(cur.pct, cur.level);
          } else {
            var idxInList = 0;
            for (var k = 0; k < it.levels.length; k += 1) {
              if (it.levels[k].id === it.currentEffort) {
                idxInList = k;
                break;
              }
            }
            var rowPct = pctFromIndex(idxInList, it.levels.length);
            rowColor = valueColorFor(rowPct, { id: it.currentEffort, name: shownEffName });
          }
          ref.effSpan.textContent = shownEffName;
          ref.effSpan.style.display = "inline";
          ref.effSpan.style.color = it.isActive ? rowColor : "";
        } else {
          ref.effSpan.textContent = "";
          ref.effSpan.style.display = "none";
        }
      }
    }

    function syncTicks(state) {
      var sig = levels.map(function (l) { return l.id; }).join("|");
      if (state.tickSignature === sig) return;
      state.tickSignature = sig;
      while (state.ticksWrap.firstChild) state.ticksWrap.removeChild(state.ticksWrap.firstChild);
      state.tickEls = [];
      for (var t = 0; t < levels.length; t += 1) {
        var tick = doc.createElement("span");
        tick.className = "ces-tick";
        tick.setAttribute("data-ces-part", "tick");
        tick.style.left = knobOffsetOf(pctFromIndex(t, levels.length));
        state.ticksWrap.appendChild(tick);
        state.tickEls.push(tick);
      }
    }

    function updateStarPlaybackRate(state, pct) {
      if (dragging && lastStarRatePct !== null && Math.abs(pct - lastStarRatePct) < 0.08 && pct !== 0 && pct !== 1) {
        return;
      }
      lastStarRatePct = pct;
      var rate = speedFor(pct);
      if (!starRateCache || starRateCache.length !== state.starDots.length) {
        starRateCache = [];
        for (var i = 0; i < state.starDots.length; i += 1) {
          var el = state.starDots[i].starEl;
          var anims = el && typeof el.getAnimations === "function" ? el.getAnimations() : [];
          starRateCache.push(anims.length > 0 ? anims : null);
        }
      }
      for (var j = 0; j < starRateCache.length; j += 1) {
        var list = starRateCache[j];
        if (!list) continue;
        for (var a = 0; a < list.length; a += 1) {
          try { list[a].playbackRate = rate; } catch (err) { /* 忽略已取消的動畫 */ }
        }
      }
    }

    function renderSlider() {
      if (!hostState) return;
      syncModelTriggerRow();
      if (submenuOpen) syncModelList();

      var hasMultiLevels = levels.length > 1;
      hostState.container.setAttribute("data-slider-disabled", hasMultiLevels ? "0" : "1");
      hostState.sliderSection.style.display = hasMultiLevels ? "block" : "none";
      hostState.trackEl.setAttribute("aria-disabled", hasMultiLevels ? "false" : "true");

      if (!hasMultiLevels) {
        hostState.container.setAttribute("data-energy", "0");
        hostState.sliderSection.style.boxShadow = "";
        return;
      }

      syncTicks(hostState);

      var cur = currentShown();
      var shownPct = cur.pct;
      var shownIndex = cur.index;
      var shownLevel = cur.level;
      var energy = energyFor(shownPct);
      var energyOn = energy > 0;
      var knobOffset = knobOffsetOf(shownPct);
      var settings = settingsStore.read();

      hostState.container.setAttribute("data-energy", energyOn ? "1" : "0");
      hostState.container.setAttribute("data-motion", settings.motion === "quick" ? "concise" : settings.motion);
      hostState.container.setAttribute("data-reached-ticks", settings.reachedTicks);
      hostState.container.style.setProperty("--ces-energy", String(energy));
      hostState.sliderSection.style.boxShadow = energyOn
        ? "inset 0 0 0 1px rgba(168,85,247," + (0.16 + 0.34 * energy).toFixed(2) + ")"
        : "";

      hostState.headValueEl.textContent = shownLevel ? shownLevel.name : "";
      hostState.headValueEl.style.color = valueColorFor(shownPct, shownLevel);

      hostState.trackEl.setAttribute("aria-valuemin", "0");
      hostState.trackEl.setAttribute("aria-valuemax", String(Math.max(0, levels.length - 1)));
      hostState.trackEl.setAttribute("aria-valuenow", String(shownIndex));
      hostState.trackEl.setAttribute("aria-valuetext", shownLevel ? shownLevel.name : "");

      hostState.fillEl.style.width = knobOffset;
      hostState.fillEl.style.background = fillBackgroundFor(shownPct);
      hostState.energyEl.style.width = knobOffset;
      hostState.starsEl.style.width = knobOffset;
      hostState.starsEl.style.opacity = starLayerOpacityFor(shownPct).toFixed(3);
      hostState.knobEl.style.left = knobOffset;

      for (var t = 0; t < hostState.tickEls.length; t += 1) {
        hostState.tickEls[t].setAttribute("data-on", t <= shownIndex ? "1" : "0");
      }

      var starProgress = clamp01(shownPct);
      var starGlow = 0.45 + 0.55 * starProgress;
      var total = PARTICLES.length;
      for (var s = 0; s < total; s += 1) {
        var threshold = s / total;
        var reveal = energyOn ? clamp01((starProgress - threshold) / 0.22) : 0;
        var brightness = starBrightnessFor(s) * starGlow;
        var dot = hostState.starDots[s].dotEl;
        dot.setAttribute("data-brightness", brightness.toFixed(3));
        dot.style.setProperty("--ces-b", brightness.toFixed(3));
        dot.style.opacity = reveal.toFixed(3);
      }
      updateStarPlaybackRate(hostState, shownPct);

      if (errorMsg) {
        hostState.errorEl.textContent = errorMsg;
        hostState.errorEl.style.display = "block";
      } else {
        hostState.errorEl.textContent = "";
        hostState.errorEl.style.display = "none";
      }

      trace.push({
        k: "s",
        shown: Math.round(shownPct * 10000) / 10000,
        eff: Math.round(cur.effPct * 10000) / 10000,
      });
    }

    function detachHost() {
      disposeSubmenu();
      disposeTooltip();
      restoreHiddenNodes();
      if (hostState) {
        try {
          if (hostState.container && hostState.container.parentNode) {
            hostState.container.parentNode.removeChild(hostState.container);
          }
        } catch (e) { /* 忽略 */ }
      }
      hostState = null;
      unifiedState = null;
      activeCtx = null;
      starRateCache = null;
      lastStarRatePct = null;
      dragging = false;
      buttonDown = false;
      draft = null;
      snapIndex = null;
      motion = null;
      cancelFrame(frameHandle);
      frameHandle = null;
      clearOptimisticTimer();
      optimistic = null;
    }

    function scan() {
      if (disposed) return;
      try {
        syncTrigger();
      } catch (e) { /* 忽略 */ }

      var panel = typeof doc.querySelector === "function" ? doc.querySelector('[data-testid="model-selector-panel"]') : null;
      if (!panel || !isElementVisible(panel)) {
        detachHost();
        return;
      }

      if (dragging && hostState && hostState.panel === panel) {
        return;
      }

      var fiberCtx = null;
      try {
        fiberCtx = findModelSelectorContext(doc);
      } catch (e) {
        fiberCtx = null;
      }

      if (fiberCtx && (fiberCtx.bestOfNEnabled || fiberCtx.isLoading)) {
        detachHost();
        return;
      }

      var nextState = null;
      if (fiberCtx) {
        var overrideSel = optimistic && optimistic.selectedModel ? optimistic.selectedModel : null;
        nextState = buildUnifiedModelState(fiberCtx.provider, overrideSel);
        activeCtx = fiberCtx;
      } else {
        activeCtx = null;
        nextState = buildDomFallbackState(doc, panel, modelEffortsCache);
      }

      if (!nextState) {
        detachHost();
        return;
      }

      unifiedState = nextState;
      levels = nextState.levels || [];
      activeIndex = nextState.activeIndex || 0;

      for (var i = 0; i < nextState.items.length; i += 1) {
        var it = nextState.items[i];
        if (it.isMultiEffort && it.base && it.levels && it.levels.length > 0) {
          modelEffortsCache[it.base] = it.levels;
        }
      }

      if (optimistic !== null) {
        var matched = false;
        if (fiberCtx && optimistic.selectedModel && fiberCtx.provider.selectedModel && sameModelOption(fiberCtx.provider.selectedModel, optimistic.selectedModel)) {
          matched = true;
        } else if (optimistic.id && levels[activeIndex] && levels[activeIndex].id === optimistic.id) {
          matched = true;
        }
        if (matched) {
          clearOptimisticTimer();
          optimistic = null;
        }
      }

      if (!hostState || hostState.panel !== panel || !doc.documentElement || !doc.documentElement.contains(hostState.container)) {
        if (hostState && hostState.container && hostState.container.parentNode) {
          hostState.container.parentNode.removeChild(hostState.container);
        }
        restoreHiddenNodes();
        hostState = buildSelectorDom(panel);
      }

      hideNativePanelParts(panel);

      if (motion !== null && draft === null && !dragging) {
        var eff = effectivePct();
        motion.x = eff;
        motion.v = 0;
        motion.a = 0;
        motion.target = eff;
        motion.vPtr = 0;
      }

      renderSlider();
    }

    /* ── 全域事件監聽（安全網、設定面板快捷操作、Hover 防關） ── */
    function isInsideSlider(node) {
      return !!(node && typeof node.closest === "function" && node.closest(".ces-ag-slider-section, .ces-ag-host"));
    }

    function onDocContextMenu(ev) {
      if (!isInsideSlider(ev.target)) return;
      ev.preventDefault();
      ev.stopPropagation();
      var anchor = ev.target.closest(".ces-ag-slider-section, .ces-ag-host") || ev.target.closest(".ces-inline");
      openSettingsPanel(anchor.getBoundingClientRect(), anchor);
    }

    function onWinSubmenuGuard(ev) {
      if (!submenuOpen || !submenuEl || !ev || !ev.target) return;
      if (typeof submenuEl.contains === "function" && submenuEl.contains(ev.target)) {
        // 阻止 Base UI Popover 將右側第二層浮動選單的按下事件誤判為外部點擊而關閉主面板
        swallow(ev);
        if ((ev.type === "pointerdown" || ev.type === "mousedown") && typeof ev.preventDefault === "function") {
          ev.preventDefault();
        }
      }
    }

    function onDocPointerDown(ev) {
      if (submenuOpen && ev && ev.target) {
        var inSub = submenuEl && typeof submenuEl.contains === "function" && submenuEl.contains(ev.target);
        var inTrig = hostState && hostState.modelTriggerBtn && typeof hostState.modelTriggerBtn.contains === "function" && hostState.modelTriggerBtn.contains(ev.target);
        if (!inSub && !inTrig) {
          closeSubmenu();
        }
      }
      if (ev && typeof ev.button === "number" && ev.button !== 0) return;
      if (!isInsideSlider(ev.target)) return;
      var anchor = ev.target.closest(".ces-ag-slider-section, .ces-ag-host") || ev.target.closest(".ces-inline");
      clearTimeout(settingsUi.longPressTimer);
      settingsUi.longPressOrigin = { x: ev.clientX || 0, y: ev.clientY || 0 };
      settingsUi.longPressTimer = setTimeout(function () {
        settingsUi.longPressTimer = null;
        openSettingsPanel(anchor.getBoundingClientRect(), anchor);
      }, 600);
    }

    function cancelLongPress() {
      if (!settingsUi.longPressTimer) return;
      clearTimeout(settingsUi.longPressTimer);
      settingsUi.longPressTimer = null;
    }

    function onDocPointerMove(ev) {
      if (settingsUi.longPressOrigin && settingsUi.longPressTimer) {
        if (Math.abs((ev.clientX || 0) - settingsUi.longPressOrigin.x) > 6 ||
            Math.abs((ev.clientY || 0) - settingsUi.longPressOrigin.y) > 6) {
          cancelLongPress();
        }
      }
      if (dragging && hostState && ev.target !== hostState.trackEl) {
        moveTo(ev.clientX);
      }
    }

    function onDocPointerUp() {
      cancelLongPress();
      buttonDown = false;
      if (dragging) endDrag();
    }

    function onDocLeaveGuard(ev) {
      if (!dragging || !hostState) return;
      if (ev.target === hostState.panel || (hostState.panel && typeof hostState.panel.contains === "function" && hostState.panel.contains(ev.target))) {
        ev.stopPropagation();
      }
    }

    function onDocKeyDown(ev) {
      if (ev.key === "Escape") {
        if (submenuOpen) {
          swallow(ev);
          closeSubmenu();
        }
        closeSettingsPanel();
        return;
      }
      var isMenuKey = (ev.shiftKey && ev.key === "F10") || ev.key === "ContextMenu";
      if (!isMenuKey) return;
      var active = doc.activeElement;
      if (!isInsideSlider(active)) return;
      ev.preventDefault();
      openSettingsPanel(active.getBoundingClientRect(), active);
    }

    function onDocMouseDown(ev) {
      var panel = settingsUi.panel;
      if (!panel || panel.style.display === "none") return;
      if (panel.contains(ev.target)) return;
      if (isInsideSlider(ev.target)) return;
      closeSettingsPanel();
    }

    function onSettingsBroadcast() {
      settingsStore.clearCache();
      renderSlider();
    }

    function bindObserver() {
      if (observer) return;
      var MO = (win && win.MutationObserver) || (typeof MutationObserver === "function" ? MutationObserver : null);
      if (typeof MO === "function") {
        try {
          observer = new MO(function (mutations) {
            if (mutations && mutations.length > 0) {
              var allInternal = true;
              for (var i = 0; i < mutations.length; i += 1) {
                if (!isOwnNode(mutations[i].target)) {
                  allInternal = false;
                  break;
                }
              }
              if (allInternal) return;
            }
            scan();
          });
          observer.observe(doc.body || doc.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["aria-checked", "data-checked", "data-selected", "data-effort", "hidden", "data-closed", "style", "class"],
          });
        } catch (e) {
          observer = null;
        }
      }
      if (!observer && fallbackTimer === null && win && typeof win.setInterval === "function") {
        fallbackTimer = win.setInterval(scan, 400);
      }
    }

    function start() {
      disposed = false;
      installStyles();
      doc.addEventListener("contextmenu", onDocContextMenu, true);
      doc.addEventListener("pointerdown", onDocPointerDown, true);
      doc.addEventListener("pointermove", onDocPointerMove, true);
      doc.addEventListener("pointerup", onDocPointerUp, true);
      doc.addEventListener("pointercancel", onDocPointerUp, true);
      doc.addEventListener("mouseleave", onDocLeaveGuard, true);
      doc.addEventListener("pointerleave", onDocLeaveGuard, true);
      doc.addEventListener("keydown", onDocKeyDown, true);
      doc.addEventListener("mousedown", onDocMouseDown, true);
      if (win && typeof win.addEventListener === "function") {
        win.addEventListener(SETTINGS_EVENT, onSettingsBroadcast);
        win.addEventListener("pointerdown", onWinSubmenuGuard, true);
        win.addEventListener("mousedown", onWinSubmenuGuard, true);
        win.addEventListener("focusin", onWinSubmenuGuard, true);
        win.addEventListener("pointermove", onDocPointerMove, true);
        win.addEventListener("pointerup", onDocPointerUp, true);
        win.addEventListener("pointercancel", onDocPointerUp, true);
      }
      bindObserver();
      scan();
    }

    function ensureAlive() {
      if (disposed) return false;
      installStyles();
      bindObserver();
      scan();
      return true;
    }

    function dispose() {
      disposed = true;
      cancelLongPress();
      if (observer) {
        try { observer.disconnect(); } catch (e) { /* 忽略 */ }
        observer = null;
      }
      if (fallbackTimer !== null && win && typeof win.clearInterval === "function") {
        win.clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
      if (commitState.timer !== null) {
        clearTimeout(commitState.timer);
        commitState.timer = null;
      }
      doc.removeEventListener("contextmenu", onDocContextMenu, true);
      doc.removeEventListener("pointerdown", onDocPointerDown, true);
      doc.removeEventListener("pointermove", onDocPointerMove, true);
      doc.removeEventListener("pointerup", onDocPointerUp, true);
      doc.removeEventListener("pointercancel", onDocPointerUp, true);
      doc.removeEventListener("mouseleave", onDocLeaveGuard, true);
      doc.removeEventListener("pointerleave", onDocLeaveGuard, true);
      doc.removeEventListener("keydown", onDocKeyDown, true);
      doc.removeEventListener("mousedown", onDocMouseDown, true);
      if (win && typeof win.removeEventListener === "function") {
        win.removeEventListener(SETTINGS_EVENT, onSettingsBroadcast);
        win.removeEventListener("pointerdown", onWinSubmenuGuard, true);
        win.removeEventListener("mousedown", onWinSubmenuGuard, true);
        win.removeEventListener("focusin", onWinSubmenuGuard, true);
        win.removeEventListener("pointermove", onDocPointerMove, true);
        win.removeEventListener("pointerup", onDocPointerUp, true);
        win.removeEventListener("pointercancel", onDocPointerUp, true);
      }
      detachHost();
      releaseSeat();
      disposeSettingsPanel();
      uninstallStyles();
      if (win) {
        try { delete win[LOAD_GUARD_KEY]; } catch (e) { win[LOAD_GUARD_KEY] = undefined; }
        try { delete win[INSTANCE_KEY]; } catch (e) { win[INSTANCE_KEY] = undefined; }
      }
    }

    return {
      bundleVersion: BUNDLE_VERSION,
      start: start,
      scan: scan,
      ensureAlive: ensureAlive,
      dispose: dispose,
      requestCommit: requestCommit,
      openSettingsPanel: openSettingsPanel,
      closeSettingsPanel: closeSettingsPanel,
      getState: function () {
        return {
          bundleVersion: BUNDLE_VERSION,
          levels: levels,
          activeIndex: activeIndex,
          optimistic: optimistic ? optimistic.id : null,
          draft: draft,
          error: errorMsg,
          host: hostState,
          unified: unifiedState,
          settings: settingsStore.read(),
        };
      },
    };
  }

  /* ════════════════════════════ 匯出與自動掛載 ════════════════════════════ */

  var internals = {
    BUNDLE_VERSION: BUNDLE_VERSION,
    bundleVersion: BUNDLE_VERSION,
    TRACK_HEIGHT: TRACK_HEIGHT,
    KNOB_SIZE: KNOB_SIZE,
    KNOB_RADIUS: KNOB_RADIUS,
    GOLDEN_RATIO: GOLDEN_RATIO,
    STARFIELD_DURATION_FIXED: STARFIELD_DURATION_FIXED,
    STARFIELD_DURATION_SPREAD: STARFIELD_DURATION_SPREAD,
    STARFIELD_MIN: STARFIELD_MIN,
    MIN_HEIGHT_SLOTS: MIN_HEIGHT_SLOTS,
    DETENT_THIRD: DETENT_THIRD,
    ENERGY_START: ENERGY_START,
    ENERGY_END: ENERGY_END,
    COLOR_BLUE: COLOR_BLUE,
    COLOR_VIOLET: COLOR_VIOLET,
    COLOR_DEEP: COLOR_DEEP,
    COLOR_TEXT_VIOLET: COLOR_TEXT_VIOLET,
    COMMIT_THROTTLE_MS: COMMIT_THROTTLE_MS,
    COMMIT_DEADLINE_MS: COMMIT_DEADLINE_MS,
    SETTINGS_KEY: SETTINGS_KEY,
    SETTINGS_EVENT: SETTINGS_EVENT,
    SETTINGS_SCHEMA: SETTINGS_SCHEMA,
    MOTION: MOTION,
    MOTION_REDUCED: MOTION_REDUCED,
    MOTION_FAST: MOTION_FAST,
    PARTICLES: PARTICLES,
    CSS: CSS,
    clamp01: clamp01,
    clampAbs: clampAbs,
    indexFromPct: indexFromPct,
    pctFromIndex: pctFromIndex,
    detentTargetIndex: detentTargetIndex,
    motionStep: motionStep,
    motionSettled: motionSettled,
    decayPointerSpeed: decayPointerSpeed,
    releaseIndexFor: releaseIndexFor,
    starHash01: starHash01,
    mixColor: mixColor,
    rgbOf: rgbOf,
    isOffLevel: isOffLevel,
    energyFor: energyFor,
    fillColorFor: fillColorFor,
    fillBackgroundFor: fillBackgroundFor,
    valueColorFor: valueColorFor,
    speedFor: speedFor,
    particleCountFor: particleCountFor,
    starBrightnessFor: starBrightnessFor,
    starDurationFor: starDurationFor,
    starDelayFor: starDelayFor,
    starLayerOpacityFor: starLayerOpacityFor,
    knobOffsetOf: knobOffsetOf,
    schemaDefaults: schemaDefaults,
    normalizeSettings: normalizeSettings,
    createSettingsStore: createSettingsStore,
    motionParamsForMode: motionParamsForMode,
    parseModelLabel: parseModelLabel,
    findModelSelectorContext: findModelSelectorContext,
    buildUnifiedModelState: buildUnifiedModelState,
    findOpenSubmenu: findOpenSubmenu,
    parseTriggerEffort: parseTriggerEffort,
    createController: createController,
  };

  if (typeof module !== "undefined" && module && module.exports) {
    module.exports = internals;
  }

  // 瀏覽器主世界自動啟動（單例冪等守衛 + CDP 熱更新版本支援）
  var isNodeTest = typeof module !== "undefined" && module && module.exports && typeof process !== "undefined" && process.versions && process.versions.node;
  if (!isNodeTest && typeof document !== "undefined" && root) {
    if (root[LOAD_GUARD_KEY]) {
      var prev = root[INSTANCE_KEY];
      if (prev && prev.bundleVersion === BUNDLE_VERSION && typeof prev.ensureAlive === "function" && prev.ensureAlive()) {
        return;
      }
      if (prev && typeof prev.dispose === "function") {
        prev.dispose();
      }
    }
    root[LOAD_GUARD_KEY] = true;
    var ctrl = createController({ doc: document, win: root });
    if (ctrl) {
      root[INSTANCE_KEY] = ctrl;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () { ctrl.start(); }, { once: true });
      } else {
        ctrl.start();
      }
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
