"use strict";
// Real Electron main/preload/renderer, hidden window, disposable data and no Tunnel.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const electron = require("electron");
const { app } = electron;
// An Electron script entrypoint otherwise reports the Electron version; use the
// same package metadata as a normal desktop-folder launch for the UI fixture.
app.getVersion = () => require("../package.json").version;
const desktop = path.resolve(__dirname, "..");
const repo = path.resolve(desktop, "..");
const artifacts = path.join(repo, ".codex", "isolation");
fs.mkdirSync(artifacts, { recursive: true });
const fixture = fs.mkdtempSync(path.join(artifacts, "ui-run-"));
if (!path.resolve(fixture).startsWith(path.resolve(artifacts) + path.sep)) throw new Error("Unsafe UI fixture");
const userData = path.join(fixture, "chatgpt-web-harness-isolated");
fs.mkdirSync(userData, { recursive: true });
app.setPath("appData", fixture);
app.setPath("userData", userData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
// Deliberately inject synthetic legacy overrides; the real main entry must scrub them.
const protectedFixture = path.join(fixture, "production-sentinel");
fs.mkdirSync(protectedFixture);
fs.writeFileSync(path.join(protectedFixture, ".env"), "ADMIN_TOKEN=fake-parent-token\nISOLATION_SENTINEL=must-not-load\n");
process.env.CLC_RUNTIME_DIR = protectedFixture;
process.env.ADMIN_TOKEN = "fake-parent-token";
process.env.MCP_TOKEN = "fake-parent-mcp-token";
process.env.DOTENV_CONFIG_PATH = path.join(protectedFixture, ".env");
process.env.DOTENV_CONFIG_OVERRIDE = "true";
process.env.AUDIT_LOG_PATH = path.join(protectedFixture, "audit.log");
process.env.CHECKPOINT_PATH = path.join(protectedFixture, "checkpoints");
process.env.CODEX_HOME = path.join(protectedFixture, ".codex");
process.env.MCP_SHELL_STATE_DIR = path.join(protectedFixture, "state");
const legacy = path.join(fixture, "chatgpt-local-coder-desktop");
fs.mkdirSync(legacy);
fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({
  setupDone: true, autoStart: true, workspacePath: "DO-NOT-MIGRATE",
  apiKeyEnc: "fixture-not-a-real-key", tunnelId: "tunnel_" + "b".repeat(32),
}));
const uiErrors = [];
let windowResolve;
const windowReady = new Promise((resolve) => { windowResolve = resolve; });
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false, offscreen: true } });
    this.webContents.on("console-message", (_event, level, message) => {
      if (level >= 3) uiErrors.push(message);
    });
    this.webContents.on("did-fail-load", (_event, code, description) => uiErrors.push(code + ":" + description));
    this.webContents.once("did-finish-load", () => windowResolve(this));
  }
}
class HiddenTray extends EventEmitter {
  setToolTip() {} setContextMenu() {} destroy() {}
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron" && parent && parent.filename.startsWith(desktop)) {
    return { ...electron, BrowserWindow: HiddenWindow, Tray: HiddenTray,
      dialog: { ...electron.dialog, showErrorBox: (title, body) => { uiErrors.push(title + ": " + body); } },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
require("../src/main.js");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(win, expression, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await pause(50);
  }
  throw new Error("UI timeout: " + label);
}
const timeout = setTimeout(() => { console.error("FAIL isolated UI hard deadline"); app.exit(1); }, 45000);
(async () => {
  const win = await windowReady;
  await waitFor(win, "document.getElementById('f-mcp-port').value === '3300'", "initial config");
  const info = await win.webContents.executeJavaScript("window.launcher.appInfo()");
  const config = await win.webContents.executeJavaScript("window.launcher.getConfig()");
  assert.equal(info.ok, true);
  assert.equal(config.ok, true);
  assert.equal(info.result.name, "ChatGPT Web Harness Isolated");
  assert.equal(info.result.isolated, true);
  const takeover = await win.webContents.executeJavaScript("window.launcher.stopExternal()");
  assert.equal(takeover.ok, false);
  assert.match(takeover.error, /隔离版不接管或终止外部进程/);
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('btn-stop-external').disabled"), true);
  assert.equal(path.resolve(info.result.configPath), path.join(userData, "config.json"));
  assert.equal(path.resolve(info.result.runtimeDir), path.join(userData, "runtime"));
  assert.deepEqual(info.result.legacyKeys, []);
  assert.equal(info.result.legacyTunnelId, "");
  assert.equal(info.result.legacyWorkspace, "");
  assert.equal(config.result.setupDone, false);
  assert.equal(config.result.autoStart, false);
  assert.equal(config.result.workspacePath, "");
  assert.equal(config.result.hasApiKey, false);
  assert.equal(config.result.mcpPort, 3300);
  assert.equal(config.result.adminPort, 3301);
  assert.equal(config.result.tunnelPort, 8380);
  assert.equal(process.env.DOTENV_CONFIG_PATH, undefined);
  assert.equal(process.env.DOTENV_CONFIG_OVERRIDE, undefined);
  assert.equal(process.env.ADMIN_TOKEN, undefined);
  assert.equal(process.env.MCP_TOKEN, undefined);
  assert.equal(process.env.CLC_RUNTIME_DIR, path.join(userData, "runtime"));
  assert.equal(process.env.CODEX_HOME, path.join(userData, "runtime", ".codex"));
  assert.deepEqual(fs.readdirSync(protectedFixture), [".env"]);
  assert.match(fs.readFileSync(path.join(protectedFixture, ".env"), "utf8"), /ISOLATION_SENTINEL=must-not-load/);
  const stored = JSON.parse(fs.readFileSync(info.result.configPath, "utf8"));
  assert.ok(stored.adminTokenEnc);
  assert.notEqual(electron.safeStorage.decryptString(Buffer.from(stored.adminTokenEnc, "base64")), "fake-parent-token");
  const legacyAfter = JSON.parse(fs.readFileSync(path.join(legacy, "config.json"), "utf8"));
  assert.equal(legacyAfter.workspacePath, "DO-NOT-MIGRATE");
  assert.equal(legacyAfter.apiKeyEnc, "fixture-not-a-real-key");
  console.log("PASS isolated main/preload IPC, fresh config, no legacy migration or auto-start");
  await win.webContents.executeJavaScript("document.querySelector('[data-view=skills]').click()");
  await waitFor(win, "document.getElementById('installed-skills-list').textContent.includes('未发现')", "empty skill catalog");
  const catalog = await win.webContents.executeJavaScript("window.launcher.getSkillCatalog()");
  assert.equal(catalog.ok, true);
  assert.equal(catalog.result.installed.length, 0);
  // Source checkouts retain three example workflows; releases intentionally omit them.
  if (info.result.isPackaged) assert.equal(catalog.result.builtin.length, 0);
  else assert.ok(Array.isArray(catalog.result.builtin));
  assert.equal(catalog.result.external.length, 0);
  console.log("PASS real Skills view has no installed or external user skills");
  await win.webContents.executeJavaScript("document.querySelector('[data-view=dashboard]').click()");
  await waitFor(win, "document.getElementById('view-dashboard').classList.contains('active')", "dashboard selected");
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const overflow = await win.webContents.executeJavaScript("document.documentElement.scrollWidth > innerWidth");
  assert.equal(overflow, false);
  assert.equal(await win.webContents.executeJavaScript("state.view"), "dashboard");
  fs.writeFileSync(path.join(artifacts, "isolated-dashboard.png"), (await win.capturePage()).toPNG());
  assert.equal(await win.webContents.executeJavaScript("state.view"), "dashboard");
  await win.webContents.executeJavaScript("document.querySelector('[data-view=settings]').click()");
  await waitFor(win, "document.getElementById('view-settings').classList.contains('active')", "settings selected");
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(artifacts, "isolated-settings.png"), (await win.capturePage()).toPNG());
  assert.deepEqual(uiErrors.filter((error) => !/Content Security Policy/.test(error)), []);
  fs.writeFileSync(path.join(artifacts, "isolated-ui-result.json"), JSON.stringify({
    passed: true, configPath: info.result.configPath, runtimeDir: info.result.runtimeDir,
    profile: info.result.name, managedServiceAutoStart: false, externalTakeoverRejected: true, inheritedOverridesScrubbed: true, protectedFixtureUnchanged: true, screenshots: ["isolated-dashboard.png", "isolated-settings.png"],
  }, null, 2));
  console.log("PASS hidden real Electron UI, no horizontal overflow or initialization errors");
  clearTimeout(timeout);
  app.quit();
})().catch((error) => {
  clearTimeout(timeout);
  console.error(error.stack || error);
  console.error("UI errors:", JSON.stringify(uiErrors));
  app.exit(1);
});
