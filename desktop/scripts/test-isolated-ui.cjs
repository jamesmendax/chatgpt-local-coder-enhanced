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
const timeout = setTimeout(() => { console.error("FAIL isolated UI hard deadline"); app.exit(1); }, 60000);
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
  const initialAccounts = await win.webContents.executeJavaScript("window.launcher.listAccounts()");
  assert.equal(initialAccounts.ok, true);
  assert.equal(initialAccounts.result.selectedId, "default");
  assert.equal(initialAccounts.result.accounts.length, 1);
  assert.equal(initialAccounts.result.accounts[0].name, "默认账号（原配置）");
  assert.equal(initialAccounts.result.accounts[0].config.hasApiKey, false);
  assert.equal(initialAccounts.result.accounts[0].mcp.owned, false);
  assert.equal(initialAccounts.result.accounts[0].tunnel.owned, false);

  await win.webContents.executeJavaScript(`document.getElementById("btn-account-create").click()`);
  await waitFor(win, "document.getElementById('account-dialog').open === true", "account create dialog");
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('account-dialog-title').textContent"), "新建账号");
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById("account-dialog-name").value = "第二账号验收";
    document.getElementById("account-dialog-form").requestSubmit();
  })()`);
  await waitFor(win, "state.accountId && state.accountId !== 'default' && state.accountSwitching === false && document.getElementById('dashboard-account-name').textContent === '第二账号验收' && document.getElementById('btn-account-rename').disabled === false", "second account created, selected, and rename action enabled");
  const secondId = await win.webContents.executeJavaScript("state.accountId");
  assert.match(secondId, /^[a-f0-9]{32}$/);
  const secondConfig = await win.webContents.executeJavaScript("window.launcher.getConfig()");
  const secondAccounts = await win.webContents.executeJavaScript("window.launcher.listAccounts()");
  assert.equal(secondConfig.ok, true);
  assert.equal(secondConfig.result.setupDone, false);
  assert.equal(secondConfig.result.hasApiKey, false, "new profiles must not copy another account's key");
  assert.deepEqual([secondConfig.result.mcpPort, secondConfig.result.adminPort, secondConfig.result.tunnelPort], [3400, 3401, 3402]);
  assert.equal(secondAccounts.result.accounts.length, 2);
  const secondRow = secondAccounts.result.accounts.find((row) => row.id === secondId);
  assert.ok(secondRow);
  assert.equal(path.resolve(secondRow.dataDir), path.join(userData, "accounts", secondId));
  assert.notEqual(path.resolve(secondRow.dataDir), path.resolve(info.result.configPath, ".."));
  assert.match(secondAccounts.result.securityBoundary, /不是 Windows 用户或系统安全沙箱/);
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('btn-stop-external').disabled"), true);
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('btn-stop-external').hidden"), true);
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('setup-required').hidden"), false);
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('btn-configure-account').textContent"), "完成配置");
  console.log("PASS real Electron UI creates/selects a second profile with private data root, ports and no copied key");

  // The dashboard label is updated inside reloadCurrentAccount() before the
  // create flow's finally block clears accountSwitching.  Do not race that
  // intentional disabled state: wait until the action is actually interactive.
  await waitFor(win, "state.accountSwitching === false && document.getElementById('btn-account-rename').disabled === false", "account create transition completed");
  await win.webContents.executeJavaScript(`document.getElementById("btn-account-rename").click()`);
  await waitFor(win, "document.getElementById('account-dialog').open === true", "account rename dialog");
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('account-dialog-title').textContent"), "重命名账号");
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById("account-dialog-name").value = "第二账号（验收）";
    document.getElementById("account-dialog-form").requestSubmit();
  })()`);
  await waitFor(win, "document.getElementById('dashboard-account-name').textContent === '第二账号（验收）'", "second account renamed");
  console.log("PASS account create/rename uses the in-app dialog instead of browser prompt");

  await win.webContents.executeJavaScript(`(() => {
    const select = document.getElementById("account-select");
    select.value = "default";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(win, "state.accountId === 'default' && document.getElementById('f-mcp-port').value === '3300'", "switch back to default account");
  const returnedConfig = await win.webContents.executeJavaScript("window.launcher.getConfig()");
  assert.equal(returnedConfig.result.mcpPort, 3300);
  assert.equal(returnedConfig.result.adminPort, 3301);
  assert.equal(returnedConfig.result.tunnelPort, 8380);
  assert.equal(returnedConfig.result.hasApiKey, false);
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('account-select').value"), "default");
  console.log("PASS account switch returns to original profile without mutating its configuration");
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
  await waitFor(win, "document.getElementById('toasts').children.length === 0", "temporary notices expired before visual capture");
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const overflow = await win.webContents.executeJavaScript("document.documentElement.scrollWidth > innerWidth");
  assert.equal(overflow, false);
  assert.equal(await win.webContents.executeJavaScript("state.view"), "dashboard");
  win.setSize(900, 600);
  await pause(150);
  const minWidthState = await win.webContents.executeJavaScript(`({
    overflow: document.documentElement.scrollWidth > innerWidth,
    accountVisible: getComputedStyle(document.getElementById("account-select")).display !== "none",
    createVisible: getComputedStyle(document.getElementById("btn-account-create")).display !== "none",
    navTextVisible: getComputedStyle(document.querySelector('[data-view="dashboard"]')).fontSize !== "0px"
  })`);
  assert.deepEqual(minWidthState, { overflow: false, accountVisible: true, createVisible: true, navTextVisible: true });
  console.log("PASS 900px minimum window keeps account switching and navigation visible without horizontal overflow");
  win.setSize(1120, 760);
  await pause(150);
  fs.writeFileSync(path.join(artifacts, "isolated-dashboard.png"), (await win.capturePage()).toPNG());
  assert.equal(await win.webContents.executeJavaScript("state.view"), "dashboard");
  await win.webContents.executeJavaScript("document.querySelector('[data-view=settings]').click()");
  await waitFor(win, "document.getElementById('view-settings').classList.contains('active')", "settings selected");
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(artifacts, "isolated-settings.png"), (await win.capturePage()).toPNG());
  assert.deepEqual(uiErrors.filter((error) => !/Content Security Policy/.test(error)), []);
  fs.writeFileSync(path.join(artifacts, "isolated-ui-result.json"), JSON.stringify({
    passed: true, configPath: info.result.configPath, runtimeDir: info.result.runtimeDir,
    profile: info.result.name, managedServiceAutoStart: false, externalTakeoverRejected: true,
    inheritedOverridesScrubbed: true, protectedFixtureUnchanged: true,
    multiAccount: { count: secondAccounts.result.accounts.length, secondId, ports: [3400, 3401, 3402], noCopiedApiKey: true, returnedToDefault: true, internalAccountDialog: true, renameVerified: true, setupCallout: true, minWidthNoOverflow: true },
    screenshots: ["isolated-dashboard.png", "isolated-settings.png"],
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
