/**
 * 伴隨外掛 (`plugin/` 與本機安裝目錄) Sidecar + CDP 架構驗證測試
 *
 * 執行方式：`node test/plugin.test.mjs`
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, "..");
const PLUGIN_DIR = path.join(ROOT_DIR, "plugin");
const SIDECAR_DIR = path.join(PLUGIN_DIR, "sidecars", "effort-slider");
const INSTALLED_PLUGIN_DIR = process.env.AGY_PLUGIN_DIR
  ? path.resolve(process.env.AGY_PLUGIN_DIR)
  : path.join(os.homedir(), ".gemini", "config", "plugins", "codex-effort-slider");
const SRC_PAYLOAD = path.join(ROOT_DIR, "src", "antigravity-effort-slider.js");
const SYNC_SCRIPT = path.join(ROOT_DIR, "scripts", "sync-plugin.mjs");

const ALLOWED_PLUGIN_KEYS = new Set([
  "name",
  "displayName",
  "description",
  "version",
  "author",
  "homepage",
  "repository",
  "logo",
  "suggestedPrompts",
  "disabled",
]);

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

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

console.log("\n[Companion Plugin (Sidecar + CDP) Tests]");

// 1. plugin.json
const pluginJsonPath = path.join(PLUGIN_DIR, "plugin.json");
ok(fs.existsSync(pluginJsonPath), "plugin/plugin.json exists");
const pluginManifest = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
ok(Object.keys(pluginManifest).every((k) => ALLOWED_PLUGIN_KEYS.has(k)), "plugin.json contains only allowed top-level keys");
eq(pluginManifest.name, "codex-effort-slider", 'plugin.json name === "codex-effort-slider"');
ok(typeof pluginManifest.displayName === "string" && pluginManifest.displayName.length > 0, "plugin.json has displayName");
ok(typeof pluginManifest.version === "string" && pluginManifest.version.length > 0, "plugin.json has version");
ok(typeof pluginManifest.description === "string" && pluginManifest.description.length > 0, "plugin.json has description");
ok(
  Array.isArray(pluginManifest.suggestedPrompts) &&
    pluginManifest.suggestedPrompts.length >= 1 &&
    pluginManifest.suggestedPrompts.length <= 3,
  "plugin.json suggestedPrompts length in [1, 3]",
);

// 2. Old hooks.json / legacy patchers absent from repo
ok(!fs.existsSync(path.join(PLUGIN_DIR, "hooks.json")), "no legacy hooks.json in plugin/");
ok(!fs.existsSync(path.join(ROOT_DIR, "scripts", "asar-patch.mjs")), "legacy scripts/asar-patch.mjs removed");
ok(!fs.existsSync(path.join(ROOT_DIR, "install.ps1")), "legacy install.ps1 removed");

// 3. sidecars/effort-slider bundle files
const sidecarJsonPath = path.join(SIDECAR_DIR, "sidecar.json");
const pkgJsonPath = path.join(SIDECAR_DIR, "package.json");
const mainMjsPath = path.join(SIDECAR_DIR, "main.mjs");
const cdpBridgePath = path.join(SIDECAR_DIR, "cdp-bridge.mjs");
const indexHtmlPath = path.join(SIDECAR_DIR, "index.html");
const payloadJsPath = path.join(SIDECAR_DIR, "payload.js");

ok(fs.existsSync(sidecarJsonPath), "plugin/sidecars/effort-slider/sidecar.json exists");
const sidecarCfg = JSON.parse(fs.readFileSync(sidecarJsonPath, "utf8"));
eq(sidecarCfg.command, "node", 'sidecar.json command === "node"');
eq(JSON.stringify(sidecarCfg.args), '["main.mjs"]', 'sidecar.json args === ["main.mjs"]');
eq(sidecarCfg.restart_policy, "always", 'sidecar.json restart_policy === "always"');
eq(sidecarCfg.has_web_ui, true, "sidecar.json has_web_ui === true");
eq(sidecarCfg.ui_config?.views?.[0]?.entrypoint, "SIDECAR_UI_ENTRYPOINT_AUX_PANE", "sidecar.json uses SIDECAR_UI_ENTRYPOINT_AUX_PANE");

ok(fs.existsSync(pkgJsonPath), "plugin/sidecars/effort-slider/package.json exists");
const pkgCfg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
eq(pkgCfg.type, "module", 'package.json type === "module"');
eq(pkgCfg.private, true, "package.json private === true");

ok(fs.existsSync(mainMjsPath), "plugin/sidecars/effort-slider/main.mjs exists");
ok(fs.existsSync(cdpBridgePath), "plugin/sidecars/effort-slider/cdp-bridge.mjs exists");
ok(fs.existsSync(indexHtmlPath), "plugin/sidecars/effort-slider/index.html exists");
ok(fs.existsSync(payloadJsPath), "plugin/sidecars/effort-slider/payload.js exists");

eq(spawnSync("node", ["--check", mainMjsPath], { encoding: "utf8" }).status, 0, "main.mjs passes node --check");
eq(spawnSync("node", ["--check", cdpBridgePath], { encoding: "utf8" }).status, 0, "cdp-bridge.mjs passes node --check");
eq(spawnSync("node", ["--check", payloadJsPath], { encoding: "utf8" }).status, 0, "payload.js passes node --check");

// 4. payload.js byte-identical to src/antigravity-effort-slider.js & sync-plugin.mjs --check passes
eq(sha256File(payloadJsPath), sha256File(SRC_PAYLOAD), "repo plugin payload.js is byte-identical to src/antigravity-effort-slider.js");
if (fs.existsSync(INSTALLED_PLUGIN_DIR)) {
  const installedPayload = path.join(INSTALLED_PLUGIN_DIR, "sidecars", "effort-slider", "payload.js");
  ok(fs.existsSync(installedPayload), "installed plugin payload.js exists");
  if (fs.existsSync(installedPayload)) {
    eq(sha256File(installedPayload), sha256File(SRC_PAYLOAD), "installed plugin payload.js matches src/antigravity-effort-slider.js");
  }
}
const syncCheck = spawnSync("node", [SYNC_SCRIPT, "--check"], { encoding: "utf8" });
eq(syncCheck.status, 0, "scripts/sync-plugin.mjs --check exits 0");

// 5. skills/codex-effort-slider/SKILL.md
const skillPath = path.join(PLUGIN_DIR, "skills", "codex-effort-slider", "SKILL.md");
ok(fs.existsSync(skillPath), "plugin/skills/codex-effort-slider/SKILL.md exists");
const skillText = fs.readFileSync(skillPath, "utf8");
const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText);
ok(fmMatch !== null, "SKILL.md has YAML frontmatter");
const fm = fmMatch ? fmMatch[1] : "";
ok(/^name:\s*codex-effort-slider\s*$/m.test(fm), "SKILL.md frontmatter has name: codex-effort-slider");
ok(/^description:\s*\S+/m.test(fm), "SKILL.md frontmatter has non-empty description");

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:");
  for (const label of failures) console.log(`  - ${label}`);
  process.exitCode = 1;
}
