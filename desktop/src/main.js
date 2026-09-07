"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const paths = require("./paths");
const configStore = require("./config");
const legacy = require("./legacy");
const { Services } = require("./services");
const { ActivityFeeds } = require("./feeds");
const skills = require("./skills");
const { MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED_BYTES, assertExtractedTreeContained } = require("./zip-safety");
const { psQuote, runPowershell } = require("./shell-util");

const APP_NAME = "ChatGPT Web Harness";
let mainWindow = null;
let tray = null;
let quitting = false;
let statusTimer = null;
const services = new Services();
const feeds = new ActivityFeeds();
const pendingSkillSources = new Set();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    try {
      // Validate the extracted resources before any window or managed service
      // is created.  This turns a partial portable copy into an observable
      // startup failure instead of a UI with broken dynamic imports.
      paths.validatePackagedPayload();
    } catch (error) {
      dialog.showErrorBox("ChatGPT Web Harness 启动失败", `安装包解包不完整，已阻止启动。\n\n${error.message}`);
      app.quit();
      return;
    }
    bootstrap();
  });
}

function iconPath() {
  const candidates = [
    path.join(__dirname, "..", "build", "icon.png"),
    path.join(process.resourcesPath || "", "icon.png"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function createWindow() {
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: icon || undefined,
    backgroundColor: "#0d0d0d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (quitting) return;
    const cfg = configStore.load();
    const anyManaged = services.mcp.isAlive() || services.tunnel.isAlive();
    if (cfg.minimizeToTray && anyManaged && tray) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    // 服务未运行时关闭窗口即退出。
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function createTray() {
  const icon = iconPath();
  if (!icon) return;
  const image = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示窗口", click: showWindow },
    { type: "separator" },
    { label: "启动全部", click: () => services.startAll().catch((e) => notice("error", e.message)) },
    { label: "停止全部", click: () => services.stopAll().catch((e) => notice("error", e.message)) },
    { type: "separator" },
    { label: "退出（停止由启动器管理的服务）", click: () => requestQuit() },
  ]));
  tray.on("click", showWindow);
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function notice(level, message) {
  send("notice", { level, message, at: Date.now() });
}

function pathInside(parent, target) {
  const base = path.resolve(parent);
  const candidate = path.resolve(target);
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function localSkillsDir() {
  return path.join(paths.runtimeDir(), "profiles", "local-skills");
}

function isTemporarySkillPath(value) {
  const resolved = path.resolve(value);
  return pathInside(localSkillsDir(), resolved) && /^\.staging-(?:extract-)?/i.test(path.basename(resolved));
}

function discardTemporarySkillPath(value) {
  if (!value || !isTemporarySkillPath(value)) return false;
  pendingSkillSources.delete(path.resolve(value));
  fs.rmSync(path.resolve(value), { recursive: true, force: true });
  return true;
}

function cleanupTemporarySkillSources() {
  for (const source of [...pendingSkillSources]) discardTemporarySkillPath(source);
  const root = localSkillsDir();
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.staging-(?:extract-)?/i.test(entry.name)) {
      discardTemporarySkillPath(path.join(root, entry.name));
    }
  }
}

async function assertZipArchiveSafe(source) {
  const archiveSize = fs.lstatSync(source).size;
  if (archiveSize > MAX_ZIP_BYTES) throw new Error(`Skill 压缩包过大（上限 ${MAX_ZIP_BYTES} 字节）。`);
  // Validate central-directory names before Expand-Archive creates anything.
  // The PowerShell check is intentionally fail-closed and emits no entry
  // names, avoiding unbounded output for hostile archives.
  await runPowershell([
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [IO.Compression.ZipFile]::OpenRead('${psQuote(source)}')`,
    "try {",
    "  $count = 0",
    "  $total = [Int64]0",
    "  foreach ($entry in $zip.Entries) {",
    "    $count++",
    `    if ($count -gt ${MAX_ZIP_ENTRIES}) { throw '压缩包条目过多' }`,
    "    $name = $entry.FullName.Replace('\\', '/')",
    "    $parts = $name.Split('/')",
    "    if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('/') -or $name.StartsWith('//') -or $name -match '^[A-Za-z]:' -or $name.IndexOf([char]0) -ge 0) { throw ('压缩包包含不安全路径') }",
    "    for ($i = 0; $i -lt $parts.Length; $i++) {",
    "      $part = $parts[$i]",
    "      if ($i -lt ($parts.Length - 1) -and [string]::IsNullOrEmpty($part)) { throw ('压缩包包含不安全路径') }",
    "      if ($part -and ($part -eq '.' -or $part -eq '..' -or $part -match '[<>:\"|?*]' -or $part -match '[ .]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$')) { throw ('压缩包包含不安全路径') }",
    "    }",
    `    $length = [Int64]$entry.Length; if ($length -lt 0 -or $length -gt ${MAX_ZIP_UNCOMPRESSED_BYTES}) { throw '压缩包解压大小超过上限' }; if ($total -gt ([Int64]${MAX_ZIP_UNCOMPRESSED_BYTES} - $length)) { throw '压缩包解压大小超过上限' }; $total += $length`,
    "  }",
    "} finally { $zip.Dispose() }",
  ].join(";"));
}

async function extractSkillZip(zipFile) {
  const raw = String(zipFile || "").trim();
  if (!path.isAbsolute(raw) || path.extname(raw).toLowerCase() !== ".zip") {
    throw new Error("Skill 压缩包必须是 .zip 绝对路径。");
  }
  const source = path.resolve(raw);
  if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) throw new Error(`找不到 Skill 压缩包: ${source}`);
  await assertZipArchiveSafe(source);
  paths.ensureRuntimeDir();
  cleanupTemporarySkillSources();
  const destination = path.join(localSkillsDir(), `.staging-extract-${crypto.randomBytes(8).toString("hex")}`);
  fs.mkdirSync(destination, { recursive: true });
  pendingSkillSources.add(destination);
  try {
    await runPowershell(`Expand-Archive -LiteralPath '${psQuote(source)}' -DestinationPath '${psQuote(destination)}' -Force`);
    assertExtractedTreeContained(destination);
    return destination;
  } catch (error) {
    discardTemporarySkillPath(destination);
    throw error;
  }
}

async function prepareSkillSource(source) {
  const raw = String(source || "").trim();
  if (!path.isAbsolute(raw)) throw new Error("Skill source 必须是绝对路径。");
  const resolved = path.resolve(raw);
  if (pendingSkillSources.has(resolved) && fs.existsSync(resolved)) return resolved;
  for (const pending of [...pendingSkillSources]) discardTemporarySkillPath(pending);
  return path.extname(resolved).toLowerCase() === ".zip" ? extractSkillZip(resolved) : resolved;
}

async function requestQuit() {
  if (quitting) return;
  quitting = true;
  try {
    await services.shutdown();
  } catch {}
  app.quit();
}

// 日志批量推送：避免每行一次 IPC。
const pendingLogs = [];
let logFlushTimer = null;
function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    const batch = pendingLogs.splice(0, pendingLogs.length);
    if (batch.length) send("log", batch);
  }, 150);
}
services.on("log", (entry) => {
  pendingLogs.push(entry);
  scheduleLogFlush();
});
services.on("status", (snapshot) => send("status", snapshot));
// 外部进程（旧脚本/手动启动）没有可继承的 stdout，实时信息改从 HTTP 活动源拉取。
feeds.on("lines", ({ name, lines }) => {
  for (const line of lines) pendingLogs.push({ name, line });
  scheduleLogFlush();
});

async function bootstrap() {
  app.setAppUserModelId("com.chatgpt-web-harness.desktop");
  migrateLegacyUserData();
  try {
    const cfg = configStore.load();
    const hadStoredToken = Boolean(cfg.adminTokenEnc);
    configStore.ensureAdminToken(cfg);
    if (!hadStoredToken && !process.env.ADMIN_TOKEN && cfg.adminTokenEnc) configStore.save(cfg);
  } catch (err) {
    // Do not silently start an unauthenticated Admin server when the
    // per-user token cannot be protected; mcpSpawnSpec repeats this guard on
    // service start and reports a clear error to the UI.
    services.note(`Admin token 初始化失败: ${err.message}`);
  }
  try {
    paths.ensureRuntimeDir();
  } catch (err) {
    services.note(`初始化运行目录失败: ${err.message}`);
  }
  createWindow();
  createTray();
  registerIpc();

  statusTimer = setInterval(() => {
    services.refresh().catch(() => {});
  }, 3000);
  services.refresh().catch(() => {});

  const syncFeeds = () => {
    const cfg = configStore.load();
    let adminToken = "";
    try { adminToken = configStore.getAdminToken(cfg); } catch (err) { services.note(`Admin 活动源鉴权不可用: ${err.message}`); }
    feeds.configure({ adminPort: cfg.adminPort, tunnelPort: cfg.tunnelPort, adminToken });
  };
  syncFeeds();
  services.on("status", syncFeeds);
  feeds.start();

  const cfg = configStore.load();
  if (cfg.setupDone && cfg.autoStart) {
    services.note("按配置自动启动服务 ...");
    services.startAll().catch((err) => notice("error", err.message));
  }
}

/**
 * 应用改名后 userData 目录也会变（Electron 用 package.json 的 name）。
 * 若新目录还没有配置、旧目录有，就搬过来——safeStorage 的密文绑定 Windows 用户而非路径，仍可解密。
 */
function migrateLegacyUserData() {
  try {
    const target = paths.configPath();
    if (fs.existsSync(target)) return;
    const legacyDir = path.join(path.dirname(app.getPath("userData")), "chatgpt-local-coder-desktop");
    const legacyConfig = path.join(legacyDir, "config.json");
    if (!fs.existsSync(legacyConfig)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(legacyConfig, target);
    services.note(`已从旧版目录迁移配置: ${legacyConfig}`);
  } catch (err) {
    services.note(`迁移旧配置失败（可重新初始化）: ${err.message}`);
  }
}

function wrap(handler) {
  return async (_event, payload) => {
    try {
      const result = await handler(payload);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

function registerIpc() {
  ipcMain.handle("app:info", wrap(async () => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    isPackaged: paths.isPackaged(),
    codeRoot: paths.codeRoot(),
    runtimeDir: paths.runtimeDir(),
    logsDir: paths.logsDir(),
    configPath: paths.configPath(),
    encryptionAvailable: configStore.encryptionAvailable(),
    legacyKeys: paths.isPackaged() ? [] : legacy.legacyKeyFiles().map((k) => k.label),
    legacyTunnelId: paths.isPackaged() ? "" : (legacy.readDotEnvValue("OPENAI_TUNNEL_ID") || legacy.readProfileTunnelId("business-local.yaml")),
    legacyWorkspace: paths.isPackaged() ? "" : legacy.readDotEnvValue("WORKSPACE_PATH"),
    migration: paths.getMigrationStatus(),
  })));

  ipcMain.handle("config:get", wrap(async () => configStore.publicView(configStore.load())));

  ipcMain.handle("config:save", wrap(async (payload) => {
    const cfg = configStore.load();
    applyConfigPayload(cfg, payload || {});
    configStore.save(cfg);
    services.refresh().catch(() => {});
    return configStore.publicView(cfg);
  }));

  ipcMain.handle("config:importLegacyKey", wrap(async (payload) => {
    if (paths.isPackaged()) throw new Error("打包版不支持从仓库导入旧密钥。");
    const label = payload && payload.label;
    const entry = legacy.legacyKeyFiles().find((k) => k.label === label);
    if (!entry) throw new Error(`未找到 ${label} 的旧密钥文件。`);
    const key = await legacy.readLegacyKey(entry.file);
    const cfg = configStore.load();
    cfg.apiKeyEnc = configStore.encryptKey(key);
    configStore.save(cfg);
    services.note(`已从旧的 ${label} 密钥文件导入 Runtime API Key（已用 safeStorage 重新加密）。`);
    return { imported: true };
  }));

  ipcMain.handle("dialog:pickFolder", wrap(async (payload) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 ChatGPT 默认操作的工作区目录",
      defaultPath: payload && payload.current ? payload.current : undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }));

  ipcMain.handle("tunnel:download", wrap(async () => {
    const file = await services.downloadTunnelClient((p) => send("setup:progress", { stage: "download", ...p }));
    services.note(`tunnel-client 已就绪: ${file}`);
    return file;
  }));

  ipcMain.handle("setup:run", wrap(async (payload) => runSetup(payload || {})));

  ipcMain.handle("status:get", wrap(async () => services.collectStatus()));
  ipcMain.handle("skills:catalog", wrap(async () => {
    const cfg = configStore.load();
    return skills.catalog(cfg.workspacePath);
  }));
  ipcMain.handle("skills:save", wrap(async (payload) => {
    const cfg = configStore.load();
    return skills.save({ ...payload, workspacePath: cfg.workspacePath });
  }));
  ipcMain.handle("skills:pickFile", wrap(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择本地 SKILL.md",
      properties: ["openFile"],
      filters: [{ name: "Skill 文件", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const file = result.filePaths[0];
    if (path.basename(file) !== "SKILL.md") throw new Error("请选择名为 SKILL.md 的文件。");
    return file;
  }));
  ipcMain.handle("skills:pickFolder", wrap(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Skill 包目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }));
  ipcMain.handle("skills:pickZip", wrap(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Skill 压缩包",
      properties: ["openFile"],
      filters: [{ name: "Skill 压缩包", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }));
  ipcMain.handle("skills:inspectSource", wrap(async (payload) => {
    const source = await prepareSkillSource(payload && payload.source);
    const inspected = await skills.inspectSource(source);
    return { ...inspected, source, temporary: pendingSkillSources.has(path.resolve(source)) };
  }));
  ipcMain.handle("skills:discardSource", wrap(async (payload) => {
    const source = payload && payload.source;
    if (source) discardTemporarySkillPath(source);
    else cleanupTemporarySkillSources();
    return true;
  }));
  ipcMain.handle("skills:install", wrap(async (payload) => {
    const source = await prepareSkillSource(payload && payload.source);
    try {
      const result = await skills.install({
        source,
        id: typeof payload?.id === "string" ? payload.id : undefined,
        overwrite: payload?.overwrite !== false,
      });
      const cfg = configStore.load();
      return { result, catalog: await skills.catalog(cfg.workspacePath) };
    } finally {
      discardTemporarySkillPath(source);
    }
  }));
  ipcMain.handle("skills:uninstall", wrap(async (payload) => {
    const result = await skills.uninstall(String(payload?.id || ""));
    const cfg = configStore.load();
    return { result, catalog: await skills.catalog(cfg.workspacePath) };
  }));
  ipcMain.handle("skills:setEnabled", wrap(async (payload) => {
    const result = await skills.setEnabled({
      id: String(payload?.id || ""),
      enabled: payload?.enabled === true,
      source: payload?.source,
    });
    const cfg = configStore.load();
    return { result, catalog: await skills.catalog(cfg.workspacePath) };
  }));
  ipcMain.handle("skills:setComputerUse", wrap(async (payload) => {
    const result = await skills.setComputerUseEnabled(payload?.enabled === true);
    const cfg = configStore.load();
    return { result, catalog: await skills.catalog(cfg.workspacePath) };
  }));
  ipcMain.handle("profiles:reset", wrap(async () => {
    const reset = paths.resetRuntimeProfiles();
    const cfg = configStore.load();
    return { reset, migration: paths.getMigrationStatus(), catalog: await skills.catalog(cfg.workspacePath) };
  }));
  ipcMain.handle("app:uninstall", wrap(async () => {
    const userData = path.resolve(app.getPath("userData"));
    const runtime = path.resolve(paths.runtimeDir());
    const override = String(process.env.CLC_RUNTIME_DIR || "").trim();
    const deleteOptions = { userData, runtime, packaged: paths.isPackaged(), override };
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "卸载并清理数据",
      message: "确定删除 ChatGPT Web Harness 的配置、日志和已安装 Skill？",
      detail: `${userData}\n\nportable/zip 版不会删除 EXE 文件；完成后可手动删除它。此操作不可撤销。`,
      buttons: ["取消", "删除数据并退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return { canceled: true };
    await paths.uninstallUserData({
      ...deleteOptions,
      stopExternal: async () => { try { await services.stopExternal(); } catch {} },
      shutdown: () => services.shutdown(),
      stopFeeds: () => feeds.stop(),
    });
    quitting = true;
    setImmediate(() => app.quit());
    return { removed: userData, restartRequired: false };
  }));
  ipcMain.handle("services:startAll", wrap(async () => services.startAll()));
  ipcMain.handle("services:stopAll", wrap(async () => services.stopAll()));
  ipcMain.handle("services:stopExternal", wrap(async () => services.stopExternal()));
  ipcMain.handle("mcp:start", wrap(async () => services.withBusy(() => services.startMcp())));
  ipcMain.handle("mcp:stop", wrap(async () => services.withBusy(() => services.stopMcp())));
  ipcMain.handle("mcp:restart", wrap(async () => services.restartMcp()));
  ipcMain.handle("tunnel:start", wrap(async () => services.withBusy(() => services.startTunnel())));
  ipcMain.handle("tunnel:stop", wrap(async () => services.withBusy(() => services.stopTunnel())));

  ipcMain.handle("logs:get", wrap(async () => ({
    mcp: services.mcp.lines.slice(),
    tunnel: services.tunnel.lines.slice(),
    launcher: services.launcherLines.slice(),
  })));
  ipcMain.handle("logs:openFile", wrap(async (payload) => {
    const name = payload && payload.name === "tunnel" ? "tunnel" : "mcp";
    const file = path.join(paths.logsDir(), `${name}.log`);
    if (!fs.existsSync(file)) throw new Error(`日志文件还不存在: ${file}`);
    await shell.openPath(file);
    return file;
  }));
  ipcMain.handle("logs:clear", wrap(async (payload) => {
    const name = payload && payload.name;
    if (name === "mcp") services.mcp.lines.length = 0;
    else if (name === "tunnel") services.tunnel.lines.length = 0;
    else if (name === "launcher") services.launcherLines.length = 0;
    return true;
  }));

  ipcMain.handle("shell:openExternal", wrap(async (payload) => {
    const url = payload && payload.url;
    if (!/^https?:\/\//i.test(url || "")) throw new Error("只允许打开 http/https 链接。");
    await shell.openExternal(url);
    return true;
  }));
  ipcMain.handle("shell:openLogs", wrap(async () => {
    fs.mkdirSync(paths.logsDir(), { recursive: true });
    await shell.openPath(paths.logsDir());
    return true;
  }));
  ipcMain.handle("shell:openRuntime", wrap(async () => {
    await shell.openPath(paths.runtimeDir());
    return true;
  }));
  ipcMain.handle("clipboard:copy", wrap(async (payload) => {
    clipboard.writeText(String((payload && payload.text) || ""));
    return true;
  }));
}

function applyConfigPayload(cfg, payload) {
  if (typeof payload.tunnelId === "string") {
    const value = payload.tunnelId.trim();
    if (value && !configStore.validateTunnelId(value)) throw new Error("Tunnel ID 格式不正确，应为 tunnel_ + 32 位十六进制。");
    cfg.tunnelId = value;
  }
  if (typeof payload.apiKey === "string" && payload.apiKey.trim()) {
    cfg.apiKeyEnc = configStore.encryptKey(payload.apiKey.trim());
  }
  if (typeof payload.workspacePath === "string" && payload.workspacePath.trim()) {
    const value = payload.workspacePath.trim();
    // 必须是绝对路径：`D:web-local` 这类驱动器相对路径会解析到当前目录，不是用户想要的。
    if (!path.isAbsolute(value)) throw new Error(`工作区必须是绝对路径，例如 C:\\Users\\你\\Documents\\项目（收到: ${value}）`);
    cfg.workspacePath = path.resolve(value);
  }
  for (const key of ["mcpPort", "adminPort", "tunnelPort"]) {
    if (payload[key] !== undefined && payload[key] !== "") {
      if (!configStore.validatePort(payload[key])) throw new Error(`${key} 端口无效。`);
      cfg[key] = Number(payload[key]);
    }
  }
  if (payload.toolProfile === "slim" || payload.toolProfile === "full") cfg.toolProfile = payload.toolProfile;
  if (typeof payload.autoStart === "boolean") cfg.autoStart = payload.autoStart;
  if (typeof payload.minimizeToTray === "boolean") cfg.minimizeToTray = payload.minimizeToTray;
  if (typeof payload.setupDone === "boolean") cfg.setupDone = payload.setupDone;
  const ports = new Set([cfg.mcpPort, cfg.adminPort, cfg.tunnelPort]);
  if (ports.size !== 3) throw new Error("MCP、Admin、Tunnel 三个端口不能相同。");
}

async function runSetup(payload) {
  const progress = (stage, message) => send("setup:progress", { stage, message });
  const cfg = configStore.load();
  applyConfigPayload(cfg, payload);
  if (!cfg.tunnelId) throw new Error("请填写 Tunnel ID。");
  if (!cfg.apiKeyEnc) throw new Error("请填写 Runtime API Key。");
  if (!cfg.workspacePath) throw new Error("请选择工作区目录。");

  progress("workspace", `准备工作区 ${cfg.workspacePath}`);
  fs.mkdirSync(cfg.workspacePath, { recursive: true });
  paths.ensureRuntimeDir();
  require("./harness").ensureDotEnv();

  if (!fs.existsSync(paths.distEntry())) {
    throw new Error(`找不到 MCP 构建产物 ${paths.distEntry()}。开发模式下请先在仓库运行 npm run build。`);
  }

  if (!fs.existsSync(paths.tunnelClientPath())) {
    progress("download", "下载 tunnel-client ...");
    await services.downloadTunnelClient((p) => send("setup:progress", { stage: "download", ...p }));
  }

  // 先保存（setupDone 保持原值），doctor 通过后再标记完成。
  configStore.save(cfg);

  let doctor = { ok: true, output: "（已跳过在线校验）" };
  if (!payload.skipDoctor) {
    progress("doctor", "运行 tunnel-client doctor 校验 Tunnel ID 与 Runtime Key ...");
    const apiKey = configStore.decryptKey(cfg);
    doctor = await services.runDoctor(cfg, apiKey, (line) => progress("doctor-line", line));
  }
  if (!doctor.ok) {
    return { ok: false, doctor: doctor.output, message: "doctor 校验失败，请检查 Tunnel ID、Runtime API Key（须为 Runtime key 而非 Admin key）以及该 key 是否具有 Tunnels 权限。" };
  }
  cfg.setupDone = true;
  configStore.save(cfg);
  services.note("初始化完成。");
  services.refresh().catch(() => {});
  return { ok: true, doctor: doctor.output, config: configStore.publicView(cfg) };
}

app.on("before-quit", () => {
  quitting = true;
  if (statusTimer) clearInterval(statusTimer);
  feeds.stop();
  cleanupTemporarySkillSources();
});
app.on("will-quit", (event) => {
  if (services.mcp.isAlive() || services.tunnel.isAlive()) {
    event.preventDefault();
    services.shutdown().finally(() => app.exit(0));
  }
});
app.on("window-all-closed", () => {
  // 服务仍在运行时窗口已被隐藏而非关闭；到这里说明用户确实要退出。
  requestQuit();
});
