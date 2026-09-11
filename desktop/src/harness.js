"use strict";
// 生成 MCP / Tunnel 子进程所需的环境变量与 tunnel-client profile。
const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const configStore = require("./config");
const { profile } = require("./app-profile");
const accountContext = require("./account-context");
const { isolatedEnvironment } = require("./isolated-runtime");
const { resolveTunnelProxy, applyTunnelProxy } = require("./tunnel-proxy");

/** 去掉 Electron 自身注入的变量，避免污染子进程。 */
function baseEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^ELECTRON_/i.test(key)) continue;
    if (key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  return profile.isolated || accountContext.current() ? isolatedEnvironment(env, paths.runtimeDir()) : env;
}

/** 首次运行时从 .env.example 生成 .env（dotenv 只在变量未设置时才读取它）。 */
function ensureDotEnv() {
  const dir = paths.runtimeDir();
  const envFile = path.join(dir, ".env");
  if (fs.existsSync(envFile)) return envFile;
  const example = path.join(dir, ".env.example");
  if (fs.existsSync(example)) {
    let text = fs.readFileSync(example, "utf8");
    text = text.replace(/^WORKSPACE_PATH=.*$/m, "WORKSPACE_PATH=");
    fs.writeFileSync(envFile, text, "utf8");
  } else {
    fs.writeFileSync(envFile, "PORT=3000\nHOST=127.0.0.1\nCHATGPT_TOOL_PROFILE=slim\n", "utf8");
  }
  return envFile;
}

function ensureNodeShim() {
  if (process.platform !== "win32") return "";
  const dir = path.join(path.dirname(paths.configPath()), "node-bin");
  const file = path.join(dir, "node.cmd");
  fs.mkdirSync(dir, { recursive: true });
  const executable = String(process.execPath).replace(/"/g, '""');
  const content = [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    "set \"ELECTRON_RUN_AS_NODE=1\"",
    `\"${executable}\" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) fs.writeFileSync(file, content, "utf8");
  return dir;
}

// Windows treats environment names case-insensitively, but the JS object does
// not. Node sorts duplicate spellings and sends only the first one to a child.
// Keep the inherited effective PATH, remove aliases, and prepend only our shim.
function prependWindowsPath(env, directory) {
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH").sort();
  const inherited = keys.length ? String(env[keys[0]] || "") : "";
  for (const key of keys) delete env[key];
  env.PATH = [directory, ...inherited.split(";").filter(Boolean)].join(";");
  return env;
}

function mcpSpawnSpec(config) {
  const env = baseEnv();
  env.ELECTRON_RUN_AS_NODE = "1";
  if (accountContext.current()) env.HARNESS_ACCOUNT_ID = accountContext.current().id;
  env.ELECTRON_NO_ATTACH_CONSOLE = "1";
  env.PORT = String(config.mcpPort);
  env.HOST = "127.0.0.1";
  env.ADMIN_PORT = String(config.adminPort);
  env.WORKSPACE_PATH = config.workspacePath;
  env.CHATGPT_TOOL_PROFILE = config.toolProfile || "slim";
  env.FORCE_COLOR = "0";
  env.CHATGPT_PLUGINS_CONFIG = path.join(paths.runtimeDir(), "profiles", "plugins.json");
  env.MCP_UPSTREAM_CONFIG = path.join(paths.runtimeDir(), "profiles", "mcp-upstream.json");
  env.MCP_SHELL_STATE_DIR = path.join(paths.runtimeDir(), ".mcp-state");
  // Keep account state in the isolated CODEX_HOME, but allow the MCP to read
  // the trusted OpenAI-bundled Computer Use catalog/runtime from the host.
  const hostHome = String(process.env.USERPROFILE || process.env.HOME || "").trim();
  const hostLocalAppData = String(process.env.LOCALAPPDATA || "").trim();
  if (hostHome) env.HARNESS_COMPUTER_USE_CODEX_HOME = path.join(hostHome, ".codex");
  if (hostLocalAppData) {
    env.HARNESS_COMPUTER_USE_RUNTIME_ROOT = path.join(hostLocalAppData, "OpenAI", "Codex", "runtimes", "cua_node");
  }
  const hadStoredToken = Boolean(config && config.adminTokenEnc);
  const adminToken = configStore.ensureAdminToken(config || {});
  if (!hadStoredToken && (profile.isolated || accountContext.current() || !process.env.ADMIN_TOKEN) && config?.adminTokenEnc) {
    // First-run generation is persisted only after safeStorage encryption;
    // never write a plaintext token or log its value.
    configStore.save(config);
  }
  if (adminToken) env.ADMIN_TOKEN = adminToken;
  const nodeShimDir = ensureNodeShim();
  if (nodeShimDir) prependWindowsPath(env, nodeShimDir);
  // 隧道凭据绝不传给 MCP 进程。
  delete env.OPENAI_TUNNEL_API_KEY;
  delete env.CONTROL_PLANE_API_KEY;
  return {
    command: process.execPath,
    args: [paths.distEntry()],
    cwd: paths.runtimeDir(),
    env,
  };
}

function writeTunnelProfile(config) {
  const file = paths.tunnelProfilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const yaml = [
    "config_version: 1",
    "control_plane:",
    `  tunnel_id: ${config.tunnelId}`,
    "  api_key: env:OPENAI_TUNNEL_API_KEY",
    "log:",
    "  level: info",
    "  format: struct-text",
    "health:",
    `  listen_addr: 127.0.0.1:${config.tunnelPort}`,
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: http://127.0.0.1:${config.mcpPort}/mcp`,
    "",
  ].join("\n");
  fs.writeFileSync(file, yaml, "utf8");
  return file;
}

async function tunnelSpawnSpec(config, apiKey, subcommand = "run", proxyOptions) {
  const proxyInfo = await resolveTunnelProxy(config, proxyOptions);
  const profile = writeTunnelProfile(config);
  const env = baseEnv();
  // Tunnel-client authenticates with its own profile/API key.  Do not let it
  // inherit loopback MCP/Admin bearer tokens from the desktop process.
  delete env.ADMIN_TOKEN;
  delete env.MCP_TOKEN;
  delete env.MCP_API_KEY;
  delete env.RUNTIME_API_KEY;
  env.OPENAI_TUNNEL_API_KEY = apiKey;
  env.CONTROL_PLANE_API_KEY = apiKey;
  env.CONTROL_PLANE_TUNNEL_ID = config.tunnelId;
  const args = subcommand === "doctor"
    ? ["doctor", "--profile-file", profile, "--explain"]
    : ["run", "--profile-file", profile];
  applyTunnelProxy(env, args, proxyInfo);
  return {
    proxyInfo,
    command: paths.tunnelClientPath(),
    args,
    cwd: paths.runtimeDir(),
    env,
  };
}

module.exports = { ensureDotEnv, ensureNodeShim, prependWindowsPath, mcpSpawnSpec, tunnelSpawnSpec, writeTunnelProfile };
