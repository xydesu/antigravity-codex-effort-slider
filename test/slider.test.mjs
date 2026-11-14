/**
 * antigravity-effort-slider.js 單元與模擬 DOM 測試套件
 *
 * 執行方式：`node test/slider.test.mjs`
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FakeEvent, createAntigravityDom, createTestEnv, runInBrowserVm } from "./harness.mjs";

const require = createRequire(import.meta.url);
const SLIDER_PATH = fileURLToPath(new URL("../src/antigravity-effort-slider.js", import.meta.url));
const SOURCE = readFileSync(SLIDER_PATH, "utf8");
const CODE_NO_COMMENTS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const S = require(SLIDER_PATH);

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

function near(actual, expected, label, tol = 1e-6) {
  const same = typeof actual === "number" && Math.abs(actual - expected) <= tol;
  ok(same, same ? label : `${label} (expected ~${expected}, got ${actual})`);
}

function section(title) {
  console.log(`\n[${title}]`);
}

function setTrackRect(doc, left = 0, width = 240) {
  const track = doc.querySelector('[data-ces-part="track"]');
  if (track) track.rect = { left, top: 0, right: left + width, bottom: 28, width, height: 28 };
  return track;
}

function readKnobPct(doc) {
  const knob = doc.querySelector('[data-ces-part="knob"]');
  const m = /\+\s*([\d.]+)\s*\*/.exec(knob?.style.left || "");
  return m ? Number(m[1]) : null;
}

function xForPct(pct, left = 0, width = 240) {
  return left + S.KNOB_RADIUS + pct * (width - S.KNOB_RADIUS * 2);
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ══════════════════════════════════════════════════════════════════════ */

section("1. Geometry, CSS & Static Guarantees");
{
  eq(S.TRACK_HEIGHT, 28, "[1] TRACK_HEIGHT === 28");
  eq(S.KNOB_SIZE, 28, "[1] KNOB_SIZE === TRACK_HEIGHT === 28");
  eq(S.KNOB_RADIUS, 14, "[1] KNOB_RADIUS === 14");
  eq(S.knobOffsetOf(0), "calc(14px + 0 * (100% - 28px))", "[1] knobOffsetOf(0)");
  eq(S.knobOffsetOf(0.5), "calc(14px + 0.5 * (100% - 28px))", "[1] knobOffsetOf(0.5)");
  eq(S.knobOffsetOf(1), "calc(14px + 1 * (100% - 28px))", "[1] knobOffsetOf(1)");

  ok(S.CSS.includes(".ces-track{"), "[1] CSS defines .ces-track");
  ok(S.CSS.includes(".ces-knob{") && S.CSS.includes("border-radius:50%"), "[1] CSS defines circular .ces-knob");
  ok(S.CSS.includes("@keyframes ces-sweep"), "[1] CSS defines @keyframes ces-sweep");
  ok(S.CSS.includes("@keyframes ces-star-sweep"), "[1] CSS defines @keyframes ces-star-sweep");
  ok(S.CSS.includes("@media (prefers-reduced-motion: reduce)"), "[1] CSS handles prefers-reduced-motion");
  ok(S.CSS.includes(".dark .ces-track") && S.CSS.includes("[data-theme='dark'] .ces-star__dot"), "[1] CSS supports dark theme selectors");
  ok(S.CSS.includes("[data-reached-ticks='hidden'] .ces-tick[data-on='1']{display:none}"), "[1] CSS hides reached ticks in hidden mode");
  ok(!CODE_NO_COMMENTS.includes("Math.random"), "[1] deterministic: no Math.random in source");
}

section("2. Colors & Energy Gradient");
{
  eq(S.energyFor(0), 0, "[2] index 0 (pct=0) has energy=0");
  ok(S.energyFor(1 / 3) > 0, "[2] pct=1/3 enables energy > 0");
  near(S.energyFor(2 / 3), 2 / 3, "[2] pct=2/3 energy");
  eq(S.energyFor(1), 1, "[2] pct=1 has energy=1");

  eq(S.fillColorFor(0), "rgb(77,147,248)", "[2] fillColorFor(0) is base blue #4d93f8");
  eq(S.fillColorFor(2 / 3), "rgb(147,51,234)", "[2] fillColorFor(2/3) is violet #9333ea");
  eq(S.fillColorFor(1), "rgb(76,29,149)", "[2] fillColorFor(1) is deep violet #4c1d95");
  eq(
    S.fillBackgroundFor(2 / 3),
    "linear-gradient(90deg, rgb(77,147,248), rgb(147,51,234))",
    "[2] fillBackgroundFor linear gradient stops",
  );

  eq(S.valueColorFor(0, { id: "low", name: "Low" }), "rgb(77,147,248)", "[2] Low text color is blue");
  eq(S.valueColorFor(1, { id: "max", name: "Max" }), "rgb(139,92,246)", "[2] Max text color is violet #8b5cf6");
  eq(S.valueColorFor(0.5, { id: "off", name: "Off" }), "", "[2] Off level preserves default gray");
  eq(S.valueColorFor(0.5, { name: "關閉" }), "", "[2] localized off level preserves default gray");
  eq(S.starLayerOpacityFor(0), 0, "[2] starLayerOpacityFor(0) === 0");
  eq(S.starLayerOpacityFor(1), 1, "[2] starLayerOpacityFor(1) === 1");
}

section("3. Physics & Motion Engine (full / quick / fast + hysteresis)");
{
  const sets = [
    ["full", S.MOTION],
    ["quick", S.MOTION_REDUCED],
    ["fast", S.MOTION_FAST],
  ];
  for (const [name, p] of sets) {
    ok(p.amax / 60 <= 0.7 * p.vmax + 1e-9, `[3] ${name} stability criterion amax/60 <= 0.7*vmax`);
    for (const [x0, target] of [
      [0, 1],
      [1, 0],
      [0.3, 0.5],
      [0.5, 1 / 3],
    ]) {
      const m = { x: x0, v: 0, a: 0, target };
      let settledAt = -1;
      let maxOvershoot = 0;
      for (let f = 1; f <= 120; f += 1) {
        S.motionStep(m, 1 / 60, p);
        const over = target > x0 ? m.x - target : target - m.x;
        if (over > maxOvershoot) maxOvershoot = over;
        if (settledAt < 0 && S.motionSettled(m, p)) settledAt = f;
      }
      ok(settledAt > 0 && settledAt <= 90, `[3] ${name} ${x0}->${target.toFixed(2)} converges in ${settledAt} frames`);
      ok(maxOvershoot <= 0.03, `[3] ${name} ${x0}->${target.toFixed(2)} overshoot ${(maxOvershoot * 100).toFixed(2)}% <= 3%`);
      near(m.x, target, `[3] ${name} ${x0}->${target.toFixed(2)} lands on target`, 1e-3);
    }
  }

  // Hysteresis (+1/3 forward, -2/3 backward)
  eq(S.detentTargetIndex(0.3, 0, 4), 0, "[3] detentTargetIndex: +0.30 stays at 0");
  eq(S.detentTargetIndex(0.34, 0, 4), 1, "[3] detentTargetIndex: +0.34 advances to 1");
  eq(S.detentTargetIndex(0.34, 1, 4), 1, "[3] detentTargetIndex: 0.34 from 1 stays at 1 (hysteresis)");
  eq(S.detentTargetIndex(0.3, 1, 4), 0, "[3] detentTargetIndex: 0.30 from 1 retreats to 0");
  eq(S.detentTargetIndex(2.2, 0, 4), 2, "[3] detentTargetIndex: large jump to 2");

  // Pointer speed decay
  eq(S.decayPointerSpeed(2, 0.01, 2 / 60, 0.03), 2, "[3] decayPointerSpeed within stale window");
  const decayed = S.decayPointerSpeed(2, 0.2, 2 / 60, 0.03);
  ok(decayed > 0 && decayed < 0.05, `[3] decayPointerSpeed decayed after 200ms (${decayed.toExponential(2)})`);
  ok(S.decayPointerSpeed(-2, 0.2, 2 / 60, 0.03) < 0, "[3] decayPointerSpeed preserves negative sign");
}

section("4. 22 Golden-Ratio Particles & Web Animations API");
{
  eq(S.PARTICLES.length, 22, "[4] PARTICLES.length === 22");
  const phases = S.PARTICLES.map((p) => p.phase);
  const heights = S.PARTICLES.map((p) => p.y);
  ok(phases.every((p) => p >= 0 && p < 1), "[4] all phases in [0, 1)");
  ok(heights.every((y) => y >= 8 && y <= 92), "[4] all y positions in [8%, 92%]");

  // Height-phase decorrelation
  const mx = phases.reduce((a, b) => a + b, 0) / 22;
  const my = heights.reduce((a, b) => a + b, 0) / 22;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < 22; i += 1) {
    sxy += (phases[i] - mx) * (heights[i] - my);
    sxx += (phases[i] - mx) ** 2;
    syy += (heights[i] - my) ** 2;
  }
  const corr = sxy / Math.sqrt(sxx * syy);
  ok(Math.abs(corr) < 0.35, `[4] phase-height correlation |${corr.toFixed(3)}| < 0.35`);

  // Phase-adjacent particles vertically separated
  const order = S.PARTICLES.map((p, i) => ({ i, phase: p.phase })).sort((a, b) => a.phase - b.phase).map((o) => o.i);
  let minGap = Infinity;
  for (let k = 1; k < order.length; k += 1) {
    minGap = Math.min(minGap, Math.abs(heights[order[k]] - heights[order[k - 1]]));
  }
  ok(minGap >= 12, `[4] adjacent-phase vertical gap ${minGap.toFixed(1)}% >= 12%`);

  // Render in simulated DOM at index 0 (Low) vs index >= 1 (High / Max)
  const env = createTestEnv();
  const ag = createAntigravityDom(env, { activeEffort: "low" });
  const ctrl = S.createController({ doc: env.doc, win: env.win });
  ctrl.start();

  const starsLow = env.doc.querySelectorAll('[data-ces-part="star"]');
  const dotsLow = env.doc.querySelectorAll('[data-ces-part="particle"]');
  eq(starsLow.length, 22, "[4] 22 .ces-star DOM nodes rendered");
  eq(dotsLow.length, 22, "[4] 22 .ces-star__dot DOM nodes rendered");

  const hostLow = env.doc.querySelector('[data-ces-part="host"]');
  eq(hostLow.getAttribute("data-energy"), "0", "[4] Low (index 0) sets data-energy='0'");
  eq(env.doc.querySelector('[data-ces-part="stars"]').style.opacity, "0.000", "[4] Low hides star layer");
  ok(dotsLow.every((d) => d.style.opacity === "0.000"), "[4] Low keeps all 22 dots opacity 0");
  ok(
    starsLow.every((st) => {
      const dur = parseFloat(st.style.animationDuration);
      const del = parseFloat(st.style.animationDelay);
      return dur >= 1.84 && dur <= 2.16 && del <= 0;
    }),
    "[4] star animationDuration ~2s+-8% and negative animationDelay",
  );

  // Switch externally to Max (pct=1) -> same 22 nodes preserved, playbackRate updated via getAnimations()
  ag.setEffortExternally("max");
  env.flushObservers();
  eq(hostLow.getAttribute("data-energy"), "1", "[4] Max (index 3) sets data-energy='1'");
  const starsMax = env.doc.querySelectorAll('[data-ces-part="star"]');
  ok(starsMax[0] === starsLow[0] && starsMax[21] === starsLow[21], "[4] star DOM nodes reused without reset");
  const visibleAtMax = env.doc.querySelectorAll('[data-ces-part="particle"]').filter((d) => parseFloat(d.style.opacity) > 0).length;
  eq(visibleAtMax, 22, "[4] all 22 particles visible at Max");
  near(starsMax[0].getAnimations()[0].playbackRate, S.speedFor(1), "[4] Web Animations API playbackRate updated to speedFor(1)=2");

  // Switch to High (pct=2/3) -> playbackRate = speedFor(2/3)=1
  ag.setEffortExternally("high");
  env.flushObservers();
  near(starsMax[0].getAnimations()[0].playbackRate, S.speedFor(2 / 3), "[4] Web Animations API playbackRate updated to speedFor(2/3)=1");

  ctrl.dispose();
}

section("5. Settings Storage & Settings Panel UI");
{
  const env = createTestEnv();
  createAntigravityDom(env, { activeEffort: "high" });
  const ctrl = S.createController({ doc: env.doc, win: env.win });
  ctrl.start();

  // Defaults & normalization
  eq(ctrl.getState().settings.motion, "full", "[5] default motion is full");
  eq(ctrl.getState().settings.reachedTicks, "hidden", "[5] default reachedTicks is hidden");
  eq(S.normalizeSettings({ motion: "invalid", reachedTicks: "dim" }).motion, "full", "[5] normalizeSettings rejects invalid motion");
  eq(S.normalizeSettings({ motion: "invalid", reachedTicks: "dim" }).reachedTicks, "dim", "[5] normalizeSettings keeps valid reachedTicks");

  // Right-click opens settings panel
  const track = setTrackRect(env.doc);
  track.dispatchEvent(new FakeEvent("contextmenu", { bubbles: true, cancelable: true }));
  const panel = env.doc.querySelector(".ces-set");
  ok(panel !== null && panel.style.display === "block", "[5] contextmenu opens settings panel");

  // Switch motion to 'quick' -> host gets data-motion="concise" and persisted in localStorage
  const quickRadio = panel.querySelector('input[data-ces-key="motion"][value="quick"]');
  ok(quickRadio !== null, "[5] quick radio exists in settings panel");
  quickRadio.checked = true;
  panel.dispatchEvent(new FakeEvent("change", { bubbles: true, target: quickRadio }));
  const saved = JSON.parse(env.win.localStorage.getItem(S.SETTINGS_KEY));
  eq(saved.motion, "quick", "[5] localStorage persists motion='quick'");
  eq(env.doc.querySelector('[data-ces-part="host"]').getAttribute("data-motion"), "concise", "[5] quick sets data-motion='concise'");

  // Copy trace & Reset & Close
  const traceBtn = panel.querySelector("[data-ces-trace]");
  traceBtn.click();
  ok(env.clipboardWrites.length === 1 && env.clipboardWrites[0].includes("Antigravity"), "[5] Copy Trace writes diagnostics to clipboard");

  const resetBtn = panel.querySelector("[data-ces-reset]");
  resetBtn.click();
  eq(ctrl.getState().settings.motion, "full", "[5] Reset restores default motion='full'");

  // Escape closes settings panel
  env.doc.dispatchEvent(new FakeEvent("keydown", { key: "Escape", bubbles: true }));
  eq(panel.style.display, "none", "[5] Escape closes settings panel");

  // Shift+F10 opens settings panel when track focused
  track.focus();
  env.doc.dispatchEvent(new FakeEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
  ok(env.doc.querySelector(".ces-set").style.display === "block", "[5] Shift+F10 opens settings panel");

  // Outside mousedown closes settings panel
  env.doc.body.dispatchEvent(new FakeEvent("mousedown", { bubbles: true }));
  eq(env.doc.querySelector(".ces-set").style.display, "none", "[5] outside mousedown closes settings panel");

  // 600ms long-press opens settings panel
  track.dispatchEvent(new FakeEvent("pointerdown", { button: 0, clientX: 50, clientY: 14, pointerId: 2, bubbles: true }));
  await waitMs(650);
  ok(env.doc.querySelector(".ces-set").style.display === "block", "[5] 600ms long-press opens settings panel");
  env.doc.dispatchEvent(new FakeEvent("pointerup", { bubbles: true }));

  ctrl.dispose();
}

section("6. DOM Fallback Single-Layer Panel Replacement & Trigger Sync");
{
  const env = createTestEnv();
  const ag = createAntigravityDom(env, {
    activeEffort: "high",
    contextSuffix: " · 1M",
    closeOnSelect: true,
  });
  const ctrl = S.createController({ doc: env.doc, win: env.win });
  ctrl.start();

  // Mounted at top of [data-testid="model-selector-panel"], model list hidden behind layer-2 right submenu
  const host = env.doc.querySelector('[data-ces-part="host"]');
  ok(host !== null && host.parentNode === ag.panel, "[6] layer-1 host mounted inside [data-testid='model-selector-panel']");
  eq(ag.panel.firstChild, host, "[6] layer-1 host mounted at top of panel");
  eq(ag.nativeListContainer.style.display, "none", "[6] native multi-level model list hidden");
  eq(ag.submenu.style.display, "none", "[6] native secondary effort submenu popup hidden");
  ok(ag.nativeFooter.style.display !== "none", "[6] native footer preserved and visible");
  eq(env.doc.querySelector('[data-ces-part="model-submenu"]'), null, "[6] layer-2 model list is not shown immediately on open");
  const trigRow = host.querySelector('[data-ces-part="model-select-trigger"]');
  ok(trigRow !== null, "[6] layer-1 shows Select Model trigger row");
  trigRow.click();
  const layer2 = env.doc.querySelector('[data-ces-part="model-submenu"]');
  ok(layer2 !== null && layer2.style.display === "flex", "[6] clicking Select Model opens layer-2 submenu");
  ok(parseInt(layer2.style.left, 10) >= ag.panel.rect.right, "[6] layer-2 submenu positioned to the right of panel");
  eq(layer2.querySelectorAll('[data-ces-part="model-row"]').length, 2, "[6] layer-2 model list renders 2 rows (1 multi-effort + 1 single)");

  // Trigger color synced on start (including ' · 1M' suffix)
  eq(ag.triggerEffortSpan.style.color, S.valueColorFor(2 / 3, { id: "high", name: "High" }), "[6] trigger effort span color synced at High");

  // Dragging across track + mouseleave keeps panel open & defers click until pointerup
  const track = setTrackRect(env.doc, 0, 240);
  eq(track.getAttribute("aria-valuenow"), "2", "[6] initial aria-valuenow='2' (High)");
  eq(track.getAttribute("aria-valuetext"), "High", "[6] initial aria-valuetext='High'");

  track.dispatchEvent(new FakeEvent("pointerdown", { button: 0, clientX: xForPct(0), pointerId: 1 }));
  for (let i = 0; i < 60; i += 1) env.flushFrames(1, 16);
  const leaveEv = new FakeEvent("mouseleave", { bubbles: true });
  ag.panel.dispatchEvent(leaveEv);
  eq(ag.clicks.length, 0, "[6] zero option clicks dispatched mid-drag (panel stays open)");
  near(readKnobPct(env.doc), 0, "[6] knob visually tracks pointer to Low during drag", 0.02);

  // Move to Max and release -> dispatches real click on Max option
  track.dispatchEvent(new FakeEvent("pointermove", { clientX: xForPct(1), buttons: 1 }));
  for (let i = 0; i < 60; i += 1) env.flushFrames(1, 16);
  eq(ag.clicks.length, 0, "[6] still zero clicks before pointerup");

  track.dispatchEvent(new FakeEvent("pointerup", { clientX: xForPct(1) }));
  eq(ag.clicks.length, 1, "[6] pointerup dispatches 1 real click on effort option");
  eq(ag.clicks[0], "max", "[6] clicked option is 'max'");
  eq(ag.getActiveEffort(), "max", "[6] Antigravity active effort updated to 'max'");
  eq(ag.triggerEffortSpan.style.color, S.valueColorFor(1, { id: "max", name: "Max" }), "[6] trigger color updated to Max violet");

  // Reopen menu & test keyboard navigation + 120ms throttle + dedupe
  ag.openMenu();
  env.flushObservers();
  const track2 = setTrackRect(env.doc, 0, 240);
  track2.dispatchEvent(new FakeEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  eq(ag.clicks.length, 1, "[6] keyboard ArrowLeft throttled (not clicked immediately)");
  await waitMs(160);
  eq(ag.clicks.length, 2, "[6] keyboard ArrowLeft committed after 120ms throttle");
  eq(ag.clicks[1], "high", "[6] ArrowLeft switched from Max to High");

  // Dedupe: Enter on already active level doesn't re-click
  ag.openMenu();
  env.flushObservers();
  const track3 = setTrackRect(env.doc, 0, 240);
  track3.dispatchEvent(new FakeEvent("keydown", { key: "Enter", bubbles: true }));
  eq(ag.clicks.length, 2, "[6] Enter on already active High is deduped");

  // Fail-open when panel closes -> native nodes restored
  ag.closeMenu();
  env.flushObservers();
  eq(env.doc.querySelector('[data-ces-part="host"]'), null, "[6] slider detached cleanly when menu closes");
  eq(ag.nativeListContainer.style.display, "", "[6] native list display restored on close");
  eq(ag.submenu.style.display, "", "[6] native submenu display restored on close");

  // Optimistic rollback on timeout
  const envErr = createTestEnv();
  const agErr = createAntigravityDom(envErr, { activeEffort: "low", rejectClick: true });
  const ctrlErr = S.createController({ doc: envErr.doc, win: envErr.win, commitDeadlineMs: 80 });
  ctrlErr.start();
  const tErr = setTrackRect(envErr.doc, 0, 240);
  tErr.dispatchEvent(new FakeEvent("pointerdown", { button: 0, clientX: xForPct(1), pointerId: 1 }));
  for (let i = 0; i < 60; i += 1) envErr.flushFrames(1, 16);
  tErr.dispatchEvent(new FakeEvent("pointerup", { clientX: xForPct(1) }));
  eq(ctrlErr.getState().optimistic, "max", "[6] optimistic state set to 'max' immediately on release");
  await waitMs(130);
  eq(ctrlErr.getState().optimistic, null, "[6] optimistic state rolled back after commitDeadlineMs");
  const errEl = envErr.doc.querySelector('[data-ces-part="error"]');
  ok(errEl && errEl.style.display === "block" && errEl.textContent.includes("rolled back"), "[6] .ces-error displayed on rollback");

  // dispose() restores trigger color & native DOM
  ctrl.dispose();
  ctrlErr.dispose();
  eq(ag.triggerEffortSpan.style.color, "", "[6] dispose() restores original trigger effort color");
  eq(agErr.nativeListContainer.style.display, "", "[6] dispose() restores native list display");
}

section("7. Fast Mode (Codex Detent Feel) & Browser CDP Lifecycle");
{
  const env = createTestEnv();
  createAntigravityDom(env, { activeEffort: "low" });
  const ctrl = S.createController({ doc: env.doc, win: env.win });
  ctrl.start();
  env.win.localStorage.setItem(S.SETTINGS_KEY, JSON.stringify({ motion: "fast", reachedTicks: "hidden", v: 1 }));
  env.win.dispatchEvent(new env.win.CustomEvent(S.SETTINGS_EVENT));

  const track = setTrackRect(env.doc, 0, 240);
  track.dispatchEvent(new FakeEvent("pointerdown", { button: 0, clientX: xForPct(0.05), pointerId: 1 }));
  for (let i = 0; i < 15; i += 1) env.flushFrames(1, 16);
  near(readKnobPct(env.doc), 0, "[7] fast mode snaps to nearest detent (0) instead of pointer 0.05", 0.02);

  // Move to 10% (pos=0.30, within hysteresis threshold 1/3) -> stays at 0
  track.dispatchEvent(new FakeEvent("pointermove", { clientX: xForPct(0.1), buttons: 1 }));
  for (let i = 0; i < 10; i += 1) env.flushFrames(1, 16);
  near(readKnobPct(env.doc), 0, "[7] fast mode ignores small jitter within 1/3 step", 0.02);

  // Move to 2/3 -> snaps to 2/3
  track.dispatchEvent(new FakeEvent("pointermove", { clientX: xForPct(0.67), buttons: 1 }));
  for (let i = 0; i < 15; i += 1) env.flushFrames(1, 16);
  near(readKnobPct(env.doc), 2 / 3, "[7] fast mode snaps to 2/3 detent", 0.02);
  track.dispatchEvent(new FakeEvent("pointerup", { clientX: xForPct(0.67) }));
  ctrl.dispose();

  // Browser VM auto-boot + idempotent guard + ensureAlive + dispose cleanup
  const vmEnv = createTestEnv();
  const vmAg = createAntigravityDom(vmEnv, { activeEffort: "medium" });
  vmEnv.win.__agCodexEffortSliderConfig = { bundleVersion: "test-v1" };
  const run1 = runInBrowserVm(SLIDER_PATH, vmEnv);
  const run2 = runInBrowserVm(SLIDER_PATH, vmEnv);
  eq(vmEnv.win.__agCodexEffortSliderLoaded, true, "[7] browser boot sets window.__agCodexEffortSliderLoaded");
  eq(vmEnv.win.__agCodexEffortSlider?.bundleVersion, "test-v1", "[7] exposes bundleVersion from config");
  eq(vmEnv.win.__agCodexEffortSlider?.ensureAlive(), true, "[7] ensureAlive() returns true when active");
  eq(vmEnv.doc.querySelectorAll('style[data-plugin-css="ag-codex-effort-slider"]').length, 1, "[7] double-execution installs style once");
  eq(vmEnv.doc.querySelectorAll('[data-ces-part="host"]').length, 1, "[7] double-execution mounts slider once");

  vmEnv.win.__agCodexEffortSlider.dispose();
  eq(vmEnv.win.__agCodexEffortSliderLoaded, undefined, "[7] dispose() clears __agCodexEffortSliderLoaded");
  eq(vmEnv.win.__agCodexEffortSlider, undefined, "[7] dispose() clears __agCodexEffortSlider");
  eq(vmEnv.doc.querySelectorAll('style[data-plugin-css="ag-codex-effort-slider"]').length, 0, "[7] dispose() removes <style>");
  eq(vmEnv.doc.querySelectorAll('[data-ces-part="host"]').length, 0, "[7] dispose() removes host DOM");
  eq(vmAg.nativeListContainer.style.display, "", "[7] dispose() restores native list DOM");
  run1.cleanup();
  run2.cleanup();
}

section("8. React Fiber LQc/XQc Context, Layer-2 Right Model Switch & Smooth Release");
{
  // 8a. Fiber mode: 2 multi-effort models + 1 single-effort model
  const env = createTestEnv();
  const ag = createAntigravityDom(env, { withFiber: true, activeEffort: "high" });
  const ctrl = S.createController({ doc: env.doc, win: env.win });
  ctrl.start();

  const ctx = S.findModelSelectorContext(env.doc);
  ok(ctx !== null && ctx.hasNonClosingSetter === true, "[8] findModelSelectorContext locates LQc provider & XQc non-closing setter");
  eq(env.doc.querySelector('[data-ces-part="model-submenu"]'), null, "[8] layer-2 model submenu hidden until Select Model hovered/clicked");
  eq(env.doc.querySelector('[data-ces-part="current-model"]').textContent, "Claude Opus 4.6 (Thinking)", "[8] layer-1 shows active model summary");
  eq(env.doc.querySelectorAll('[data-ces-part="tick"]').length, 4, "[8] slider shows 4 ticks for Claude Opus immediately on open");

  // Hover Select Model trigger -> opens layer-2 submenu to the right of panel
  const selTrigger = env.doc.querySelector('[data-ces-part="model-select-trigger"]');
  selTrigger.dispatchEvent(new FakeEvent("mouseenter"));
  const submenu = env.doc.querySelector('[data-ces-part="model-submenu"]');
  ok(submenu !== null && submenu.style.display === "flex", "[8] hovering Select Model opens layer-2 submenu");
  ok(parseInt(submenu.style.left, 10) >= ag.panel.rect.right, "[8] layer-2 submenu opens on the right side");
  const rows = submenu.querySelectorAll('[data-ces-part="model-row"]');
  eq(rows.length, 3, "[8] layer-2 list renders all 3 models (Claude 4-level, GPT-OSS 3-level, Gemini single)");
  eq(rows[0].getAttribute("data-active"), "1", "[8] Claude Opus row is initially active");

  // Click second multi-effort model (GPT-OSS 120B, 3 efforts: low/medium/high) -> keeps panel open, closes layer-2, switches slider to 3 ticks
  rows[1].click();
  env.flushObservers();
  ok(ag.fiberCalls.some((c) => c.via === "xqc" && c.label === "GPT-OSS 120B (Medium)"), "[8] clicking multi-effort model calls XQc non-closing setSelectedModel(Medium)");
  ok(ag.panel.parentNode === env.doc.body, "[8] panel remains open after switching multi-effort model");
  eq(submenu.style.display, "none", "[8] layer-2 submenu collapses after selecting a model");
  eq(env.doc.querySelector('[data-ces-part="current-model"]').textContent, "GPT-OSS 120B", "[8] layer-1 updates active model name");
  eq(env.doc.querySelectorAll('[data-ces-part="tick"]').length, 3, "[8] slider updates to 3 ticks for GPT-OSS");

  // Smooth drag on GPT-OSS: tracks 1:1 immediately without mid-drag React churn, commits via XQc on release
  const callsBeforeDrag = ag.fiberCalls.length;
  const track = setTrackRect(env.doc, 0, 240);
  track.dispatchEvent(new FakeEvent("pointerdown", { button: 0, clientX: xForPct(0), pointerId: 1 }));
  near(readKnobPct(env.doc), 0, "[8] knob tracks pointerdown 1:1 immediately without spring lag", 0.01);
  eq(env.doc.querySelector('[data-ces-part="host"]').getAttribute("data-dragging"), "1", "[8] data-dragging='1' active while dragging");
  eq(ag.fiberCalls.length, callsBeforeDrag, "[8] zero React Fiber commits mid-drag (silky smooth frames)");
  track.dispatchEvent(new FakeEvent("pointermove", { clientX: xForPct(0.88), buttons: 1 }));
  near(readKnobPct(env.doc), 0.88, "[8] knob tracks pointermove 1:1 immediately", 0.01);
  eq(ag.fiberCalls.length, callsBeforeDrag, "[8] zero React Fiber commits during pointermove");
  track.dispatchEvent(new FakeEvent("pointerup", { clientX: xForPct(1) }));
  for (let i = 0; i < 60; i += 1) env.flushFrames(1, 16);
  eq(env.doc.querySelector('[data-ces-part="host"]').getAttribute("data-dragging"), "0", "[8] data-dragging='0' restored after release");
  ok(ag.fiberCalls.length > callsBeforeDrag && ag.fiberCalls.every((c) => c.via === "xqc"), "[8] release commits via XQc non-closing setter");
  eq(ag.providerValue.selectedModel.label, "GPT-OSS 120B (High)", "[8] slider release selects GPT-OSS 120B (High) via Fiber");
  ok(ag.panel.parentNode === env.doc.body, "[8] panel remains open after slider effort switch");
  eq(ag.triggerEffortSpan.style.color, S.valueColorFor(1, { id: "high", name: "High" }), "[8] trigger effort color synced for GPT-OSS High");

  // Reopen layer-2 by click -> click single-effort model (Gemini 3 Flash) -> slider section hides, layer-1 Select Model stays accessible
  selTrigger.click();
  eq(submenu.style.display, "flex", "[8] clicking Select Model reopens layer-2 submenu");
  submenu.querySelectorAll('[data-ces-part="model-row"]')[2].click();
  env.flushObservers();
  eq(env.doc.querySelector('[data-ces-part="slider-section"]').style.display, "none", "[8] slider section hidden for 1-level model");
  eq(env.doc.querySelector('[data-ces-part="model-select-trigger"]').style.display, "", "[8] Select Model row remains visible for 1-level model");
  eq(ag.providerValue.selectedModel.label, "Gemini 3 Flash", "[8] single-effort model selected via Fiber");

  // Dispose restores everything cleanly & removes layer-2 submenu
  ctrl.dispose();
  eq(ag.nativeListContainer.style.display, "", "[8] dispose() restores native list in Fiber mode");
  eq(env.doc.querySelector('[data-ces-part="model-submenu"]'), null, "[8] dispose() removes layer-2 submenu from doc.body");

  // 8b. Best-of-N enabled -> fail-open (native UI untouched, no slider mounted)
  const envBon = createTestEnv();
  const agBon = createAntigravityDom(envBon, { withFiber: true, bestOfN: true });
  const ctrlBon = S.createController({ doc: envBon.doc, win: envBon.win });
  ctrlBon.start();
  eq(envBon.doc.querySelector('[data-ces-part="host"]'), null, "[8] Best-of-N enabled fails open (no replacement mounted)");
  eq(agBon.nativeListContainer.style.display, "", "[8] Best-of-N leaves native list visible");
  ctrlBon.dispose();

  // 8c. Model hover badges & quota warning tooltips inside layer-2 submenu
  const envTip = createTestEnv();
  const futureIso = new Date(Date.now() + 3600_000).toISOString();
  createAntigravityDom(envTip, {
    withFiber: true,
    secondTagTitle: "Preview",
    secondTagDescription: "Experimental reasoning model",
    secondQuotaInfo: { remainingFraction: 0, resetTime: futureIso },
    singleTagTitle: "Fast",
    singleTagDescription: "Fast responses for everyday tasks",
  });
  const ctrlTip = S.createController({ doc: envTip.doc, win: envTip.win });
  ctrlTip.start();

  envTip.doc.querySelector('[data-ces-part="model-select-trigger"]').click();
  const tipRows = envTip.doc.querySelectorAll('[data-ces-part="model-row"]');
  const secondRow = tipRows[1];
  const singleRow = tipRows[2];
  const warnEl = secondRow.querySelector('[data-ces-part="model-warning"]');
  const secondBadge = secondRow.querySelector('[data-ces-part="model-badge"]');
  const singleBadge = singleRow.querySelector('[data-ces-part="model-badge"]');
  ok(warnEl !== null, "[8] quota exhausted model renders warning badge");
  ok(secondBadge !== null && secondBadge.textContent.includes("Preview"), "[8] model renders tagTitle pill");
  ok(singleBadge !== null && singleBadge.querySelector(".ces-ag-model-badge__icon") !== null, "[8] tagDescription badge includes info icon");

  // Hover tag badge -> tooltip shown in doc.body (not clipped by panel overflow-hidden)
  singleBadge.dispatchEvent(new FakeEvent("mouseenter"));
  const tooltipEl = envTip.doc.body.querySelector('[data-ces-part="model-tooltip"]');
  ok(tooltipEl !== null && tooltipEl.parentNode === envTip.doc.body, "[8] floating tooltip mounts on doc.body");
  eq(tooltipEl.style.display, "block", "[8] hovering tag badge shows tooltip");
  eq(tooltipEl.textContent, "Fast responses for everyday tasks", "[8] tooltip shows tagDescription");

  singleBadge.dispatchEvent(new FakeEvent("mouseleave"));
  eq(tooltipEl.style.display, "none", "[8] mouseleave on badge hides tooltip");

  // Hover warning badge -> tooltip shows quota reset notice
  warnEl.dispatchEvent(new FakeEvent("mouseenter"));
  eq(tooltipEl.style.display, "block", "[8] hovering warning icon shows tooltip");
  ok(tooltipEl.textContent.includes("Your quota for GPT-OSS 120B (Medium) will reset on "), "[8] warning tooltip includes quota reset message");
  warnEl.dispatchEvent(new FakeEvent("mouseleave"));
  eq(tooltipEl.style.display, "none", "[8] mouseleave on warning icon hides tooltip");

  // Hover row itself -> shows tagDescription tooltip cleanly
  secondRow.dispatchEvent(new FakeEvent("mouseenter"));
  eq(tooltipEl.style.display, "block", "[8] hovering model row shows tooltip");
  eq(tooltipEl.textContent, "Experimental reasoning model", "[8] row hover prefers tagDescription");

  // Scroll list -> hides tooltip
  const listEl = envTip.doc.querySelector('[data-ces-part="model-list"]');
  listEl.dispatchEvent(new FakeEvent("scroll"));
  eq(tooltipEl.style.display, "none", "[8] scrolling model list hides tooltip");

  // Escape closes layer-2 submenu cleanly
  envTip.doc.dispatchEvent(new FakeEvent("keydown", { key: "Escape", bubbles: true }));
  eq(envTip.doc.querySelector('[data-ces-part="model-submenu"]').style.display, "none", "[8] Escape closes layer-2 submenu");

  // Dispose removes tooltip and submenu from doc.body
  ctrlTip.dispose();
  eq(envTip.doc.body.querySelector('[data-ces-part="model-tooltip"]'), null, "[8] dispose() removes floating tooltip from doc.body");
  eq(envTip.doc.body.querySelector('[data-ces-part="model-submenu"]'), null, "[8] dispose() removes layer-2 submenu from doc.body");
}

/* ══════════════════════════════════════════════════════════════════════
 * 9. Settings Panel Triggers (Gear Button, ContextMenu, Long-Press, Shift+F10)
 * ══════════════════════════════════════════════════════════════════════ */
{
  console.log("\n[9. Settings Panel Triggers & Base UI Isolation]");
  const envSet = createTestEnv();
  const agSet = createAntigravityDom(envSet, { withFiber: true, activeEffort: "medium" });
  const ctrlSet = S.createController({ doc: envSet.doc, win: envSet.win });
  ctrlSet.start();

  const track = envSet.doc.querySelector('[data-ces-part="track"]');
  const settingsBtn = envSet.doc.querySelector('[data-ces-part="settings-trigger"]');
  ok(settingsBtn !== null, "[9] settings gear trigger exists in slider header");

  if (settingsBtn) {
    // 1) Click gear button opens settings panel and keeps focus inside host panel (not stealing focus to doc.body)
    track.focus();
    settingsBtn.click();
    const setPanel = envSet.doc.body.querySelector(".ces-set");
    ok(setPanel !== null && setPanel.style.display === "block", "[9] clicking settings gear opens settings panel");
    ok(agSet.panel.parentNode === envSet.doc.body, "[9] main selector panel remains open after opening settings");
    ok(envSet.doc.activeElement === track || agSet.panel.contains(envSet.doc.activeElement), "[9] opening settings via click keeps focus inside main panel");

    // Window capture guard protects settings panel pointerdown/mousedown/focusin from Base UI outside-click dismissal
    let winReceived = false;
    const winListener = () => { winReceived = true; };
    envSet.win.addEventListener("pointerdown", winListener, false);
    const radio = setPanel.querySelector('input[value="fast"]');
    radio.dispatchEvent(new FakeEvent("pointerdown", { bubbles: true }));
    envSet.win.removeEventListener("pointerdown", winListener, false);
    eq(winReceived, false, "[9] pointerdown inside settings panel is shielded from window outside-click guard");

    // Toggle closed via gear button
    settingsBtn.click();
    eq(setPanel.style.display, "none", "[9] clicking settings gear again closes settings panel");
  }

  // 2) Right-click (contextmenu) on track opens settings panel without closing main panel
  track.focus();
  track.dispatchEvent(new FakeEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 12 }));
  const setByCtx = envSet.doc.body.querySelector(".ces-set");
  ok(setByCtx !== null && setByCtx.style.display === "block", "[9] contextmenu on track opens settings panel");
  ok(envSet.doc.activeElement === track || agSet.panel.contains(envSet.doc.activeElement), "[9] contextmenu keeps focus inside main panel");
  envSet.doc.dispatchEvent(new FakeEvent("keydown", { key: "Escape", bubbles: true }));

  // 3) Long-press 600ms on track opens settings and cancels active drag so pointerup does not commit
  const callsBefore = agSet.fiberCalls.length;
  track.dispatchEvent(new FakeEvent("pointerdown", { button: 0, clientX: 190, clientY: 12, pointerId: 1, bubbles: true }));
  await new Promise((r) => setTimeout(r, 640));
  const setByHold = envSet.doc.body.querySelector(".ces-set");
  ok(setByHold !== null && setByHold.style.display === "block", "[9] long-press 600ms opens settings panel");
  envSet.doc.dispatchEvent(new FakeEvent("pointerup", { button: 0, clientX: 190, clientY: 12, pointerId: 1, bubbles: true }));
  eq(agSet.fiberCalls.length, callsBefore, "[9] long-press cancels drag so release does not commit effort change");
  envSet.doc.dispatchEvent(new FakeEvent("keydown", { key: "Escape", bubbles: true }));

  // 4) Shift+F10 when track is focused opens settings panel
  track.focus();
  envSet.doc.dispatchEvent(new FakeEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
  const setByKey = envSet.doc.body.querySelector(".ces-set");
  ok(setByKey !== null && setByKey.style.display === "block", "[9] Shift+F10 when track focused opens settings panel");

  ctrlSet.dispose();
}

/* ══════════════════════════════════════════════════════════════════════ */

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:");
  for (const label of failures) console.log(`  - ${label}`);
  process.exitCode = 1;
}
