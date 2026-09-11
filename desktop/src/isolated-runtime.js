"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { profile } = require("./app-profile");

const DATA_NAME = "chatgpt-web-harness-isolated";
const CONTROLLED_ENV = new Set([
  "CLC_RUNTIME_DIR", "ADMIN_TOKEN", "MCP_TOKEN", "MCP_API_KEY", "RUNTIME_API_KEY",
  "ELECTRON_RUN_AS_NODE", "SMOKE_TUNNEL_DOCTOR", "NODE_OPTIONS", "NODE_PATH", "DOTENV_KEY",
  "AUDIT_LOG_PATH", "CHECKPOINT_PATH", "CODEX_HOME", "MCP_SHELL_STATE_DIR",
  "HARNESS_COMPUTER_USE_CODEX_HOME", "HARNESS_COMPUTER_USE_RUNTIME_ROOT",
  "EXTRA_WORKSPACE_PATHS", "WORKSPACE_PATHS", "ALLOWED_WORKSPACE_PATHS",
]);
function controlledKey(key) {
  const upper = key.toUpperCase();
  return CONTROLLED_ENV.has(upper) || upper.startsWith("DOTENV_CONFIG_");
}
function isolatedEnvironment(inherited, runtime) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) if (!controlledKey(key)) env[key] = value;
  return Object.assign(env, {
    CLC_RUNTIME_DIR: runtime,
    AUDIT_LOG_PATH: path.join(runtime, ".mcp-audit.log"),
    CHECKPOINT_PATH: path.join(runtime, ".mcp-checkpoints"),
    CODEX_HOME: path.join(runtime, ".codex"),
    MCP_SHELL_STATE_DIR: path.join(runtime, ".mcp-state"),
  });
}
function samePath(a, b) {
  const normalize = (value) => path.resolve(value).toLowerCase();
  return normalize(a) === normalize(b);
}
function isolatedPaths({ appData, desktopRoot, isPackaged, requestedUserData = "" }) {
  const defaultRoot = path.join(path.resolve(appData), DATA_NAME);
  const localRoot = path.join(path.resolve(desktopRoot), ".isolated", DATA_NAME);
  const allowed = isPackaged ? [defaultRoot] : [defaultRoot, localRoot];
  if (requestedUserData && !path.isAbsolute(requestedUserData)) throw new Error("隔离版拒绝相对 user-data-dir。");
  const requested = requestedUserData ? path.resolve(requestedUserData) : defaultRoot;
  const userData = allowed.find((candidate) => samePath(candidate, requested));
  if (!userData) throw new Error("隔离版拒绝非专用数据目录；请使用默认目录或 Start-Isolated.cmd。");
  return { userData, runtime: path.join(userData, "runtime") };
}
function assertNoLinkedAncestor(target, fileSystem = fs) {
  let current = path.resolve(target);
  const root = path.parse(current).root;
  while (current && current !== root) {
    try {
      if (fileSystem.lstatSync(current).isSymbolicLink()) throw new Error("隔离数据目录不能经由符号链接或 junction。");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}
function initializeIsolatedRuntime(app, options = {}) {
  if (!profile.isolated) return null;
  const env = options.env || process.env;
  const fileSystem = options.fs || fs;
  const roots = isolatedPaths({
    appData: app.getPath("appData"),
    desktopRoot: options.desktopRoot || path.resolve(__dirname, ".."),
    isPackaged: app.isPackaged,
    requestedUserData: app.commandLine.getSwitchValue("user-data-dir"),
  });
  // Validate before any config read, migration, service construction or instance lock.
  assertNoLinkedAncestor(roots.userData, fileSystem);
  assertNoLinkedAncestor(roots.runtime, fileSystem);
  fileSystem.mkdirSync(roots.userData, { recursive: true });
  assertNoLinkedAncestor(roots.userData, fileSystem);
  app.setPath("userData", roots.userData);
  app.setPath("sessionData", roots.userData);
  const clean = isolatedEnvironment(env, roots.runtime);
  for (const key of Object.keys(env)) if (controlledKey(key)) delete env[key];
  Object.assign(env, clean);
  app.setAppUserModelId(profile.appId);
  return roots;
}

module.exports = { DATA_NAME, isolatedPaths, isolatedEnvironment, initializeIsolatedRuntime, assertNoLinkedAncestor };
