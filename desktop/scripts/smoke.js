"use strict";
// 无界面冒烟测试：electron scripts/smoke.js
// 在临时 userData 与测试端口上验证：配置加密存储、MCP 子进程启动/健康/停止、状态聚合、日志缓冲。
// 设置 SMOKE_TUNNEL_DOCTOR=1 时，额外从旧 .secrets 导入 Business 密钥并运行 tunnel-client doctor（只读校验）。
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clc-smoke-"));
app.setPath("userData", tmp);
// 运行目录也指向临时目录，避免测试写入仓库 profiles/。
process.env.CLC_RUNTIME_DIR = path.join(tmp, "runtime");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const paths = require("../src/paths");
  const configStore = require("../src/config");
  const { Services } = require("../src/services");
  const status = require("../src/status");

  check("userData 隔离", app.getPath("userData") === tmp, tmp);
  const isolatedDeleteRoot = path.join(tmp, "isolated-delete");
  const isolatedRuntime = path.join(isolatedDeleteRoot, "runtime");
  fs.mkdirSync(isolatedRuntime, { recursive: true });
  check("卸载删除路径仅允许隔离运行目录", paths.canDeleteUserData(isolatedDeleteRoot, isolatedRuntime, { packaged: false, override: isolatedRuntime }) === true);
  const packagedAllowed = path.join(tmp, "chatgpt-web-harness-desktop");
  const packagedProductName = path.join(tmp, "ChatGPT Web Harness");
  const packagedArbitrary = path.join(tmp, "other");
  let packagedError = "";
  try {
    await paths.uninstallUserData({ userData: packagedArbitrary, runtime: isolatedRuntime, packaged: true });
  } catch (error) {
    packagedError = String(error?.message || error);
  }
  check(
    "打包版 userData 仅接受应用目录白名单",
    paths.canDeleteUserData(packagedAllowed, isolatedRuntime, { packaged: true }) === true &&
      paths.canDeleteUserData(packagedProductName, isolatedRuntime, { packaged: true }) === true &&
      paths.canDeleteUserData(packagedArbitrary, isolatedRuntime, { packaged: true }) === false &&
      /白名单/.test(packagedError),
    packagedError
  );
  check("卸载删除拒绝目录根与越界", paths.canDeleteUserData(path.parse(tmp).root, isolatedRuntime, { packaged: true }) === false && paths.canDeleteUserData(packagedArbitrary, isolatedRuntime, { packaged: false, override: isolatedRuntime }) === false);
  const deleteOutside = path.join(tmp, "delete-outside");
  fs.mkdirSync(deleteOutside, { recursive: true });
  const deleteLink = path.join(isolatedDeleteRoot, "linked-outside");
  fs.symlinkSync(deleteOutside, deleteLink, "junction");
  check("卸载删除拒绝 reparse 点", paths.canDeleteUserData(deleteLink, isolatedRuntime, { packaged: false, override: isolatedRuntime }) === false);
  fs.unlinkSync(deleteLink);
  fs.writeFileSync(path.join(isolatedDeleteRoot, "delete-marker.txt"), "isolated\n", "utf8");
  const uninstallOrder = [];
  const removedUserData = await paths.uninstallUserData({
    userData: isolatedDeleteRoot,
    runtime: isolatedRuntime,
    packaged: false,
    override: isolatedRuntime,
    stopExternal: async () => uninstallOrder.push("stopExternal"),
    shutdown: async () => uninstallOrder.push("shutdown"),
    stopFeeds: () => uninstallOrder.push("stopFeeds"),
  });
  check(
    "便携版隔离卸载实际停止并删除 userData",
    removedUserData === path.resolve(isolatedDeleteRoot) &&
      uninstallOrder.join(",") === "stopExternal,shutdown,stopFeeds" &&
      !fs.existsSync(isolatedDeleteRoot),
    `${removedUserData}; order=${uninstallOrder.join(",")}`
  );
  paths.ensureRuntimeDir();

  // 1. 配置与密钥加密
  const cfg = configStore.load();
  check("第三方机器无开发机工作区默认", configStore.DEFAULTS.workspacePath === "");
  cfg.tunnelId = "tunnel_" + "a".repeat(32);
  cfg.apiKeyEnc = configStore.encryptKey("EXAMPLE_SMOKE_KEY");
  cfg.workspacePath = path.join(tmp, "ws");
  cfg.mcpPort = 3999;
  cfg.adminPort = 3998;
  cfg.tunnelPort = 8099;
  cfg.setupDone = true;
  fs.mkdirSync(cfg.workspacePath, { recursive: true });
  configStore.save(cfg);
  const reloaded = configStore.load();
  check("safeStorage 加解密往返", configStore.decryptKey(reloaded) === "EXAMPLE_SMOKE_KEY");
  check("config.json 不含明文密钥", !fs.readFileSync(paths.configPath(), "utf8").includes("EXAMPLE_SMOKE_KEY"));
  check("publicView 不泄露密文", !("apiKeyEnc" in configStore.publicView(reloaded)) && configStore.publicView(reloaded).hasApiKey === true);
  check("publicView 不泄露 Admin token 字段", !("adminTokenEnc" in configStore.publicView(reloaded)) && !("adminToken" in configStore.publicView(reloaded)));

  // 2. 隧道 profile 生成
  const harness = require("../src/harness");
  const previousAdminToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "EXAMPLE_ADMIN_TOKEN";
  const profile = harness.writeTunnelProfile(reloaded);
  const yaml = fs.readFileSync(profile, "utf8");
  check("launcher.yaml 生成", yaml.includes(`tunnel_id: ${cfg.tunnelId}`) && yaml.includes("127.0.0.1:8099") && yaml.includes("http://127.0.0.1:3999/mcp") && yaml.includes("env:OPENAI_TUNNEL_API_KEY"), profile);
  const mcpSpec = harness.mcpSpawnSpec(reloaded);
  check(
    "MCP 环境边界与显式运行目录",
    !("OPENAI_TUNNEL_API_KEY" in mcpSpec.env) &&
      !("CONTROL_PLANE_API_KEY" in mcpSpec.env) &&
      mcpSpec.env.ADMIN_TOKEN === "EXAMPLE_ADMIN_TOKEN" &&
      mcpSpec.env.CHATGPT_PLUGINS_CONFIG === path.join(paths.runtimeDir(), "profiles", "plugins.json") &&
      mcpSpec.env.MCP_UPSTREAM_CONFIG === path.join(paths.runtimeDir(), "profiles", "mcp-upstream.json") &&
      mcpSpec.env.MCP_SHELL_STATE_DIR === path.join(paths.runtimeDir(), ".mcp-state") &&
      mcpSpec.env.ELECTRON_RUN_AS_NODE === "1" && mcpSpec.env.PORT === "3999"
  );
  const previousMcpToken = process.env.MCP_TOKEN;
  const previousMcpApiKey = process.env.MCP_API_KEY;
  process.env.MCP_TOKEN = "EXAMPLE_MCP_TOKEN";
  process.env.MCP_API_KEY = "EXAMPLE_MCP_API_KEY";
  const tunnelSpec = harness.tunnelSpawnSpec(reloaded, "EXAMPLE_TUNNEL_API_KEY", "doctor");
  check(
    "Tunnel 子进程不继承 Admin/MCP secrets",
    !("ADMIN_TOKEN" in tunnelSpec.env) && !("MCP_TOKEN" in tunnelSpec.env) && !("MCP_API_KEY" in tunnelSpec.env) &&
      tunnelSpec.env.OPENAI_TUNNEL_API_KEY === "EXAMPLE_TUNNEL_API_KEY" && tunnelSpec.env.CONTROL_PLANE_API_KEY === "EXAMPLE_TUNNEL_API_KEY",
    "只保留 Tunnel 自身认证变量"
  );
  if (previousMcpToken === undefined) delete process.env.MCP_TOKEN;
  else process.env.MCP_TOKEN = previousMcpToken;
  if (previousMcpApiKey === undefined) delete process.env.MCP_API_KEY;
  else process.env.MCP_API_KEY = previousMcpApiKey;
  const { ActivityFeeds } = require("../src/feeds");
  const feedProbe = new ActivityFeeds();
  feedProbe.configure({ adminPort: cfg.adminPort, tunnelPort: cfg.tunnelPort, adminToken: "EXAMPLE_ADMIN_TOKEN" });
  check("桌面活动源配置 Admin token", feedProbe.adminToken === "EXAMPLE_ADMIN_TOKEN", "活动请求使用内存 header，不写入 URL");

  // Skills / plugin registry
  const skills = require("../src/skills");
  const skillDir = path.join(tmp, "registered-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: smoke-skill\ndescription: Smoke skill description\n---\n# Smoke skill\n", "utf8");
  const savedSkills = await skills.save({
    workspacePath: cfg.workspacePath,
    registrations: [{ name: "smoke-skill", path: path.join(skillDir, "SKILL.md"), enabled: true }],
    computerUseEnabled: false,
  });
  const skillCatalog = await skills.catalog(cfg.workspacePath);
  check(
    "Skill 注册表保存与读取",
    savedSkills.ok === true &&
      skillCatalog.registered.length === 1 &&
      skillCatalog.registered[0].name === "smoke-skill" &&
      skillCatalog.registered[0].enabled === true &&
      skillCatalog.registered[0].description === "Smoke skill description",
    skillCatalog.registered[0] ? `name=${skillCatalog.registered[0].name} path=${skillCatalog.registered[0].path}` : "no registered skill"
  );
  check("Computer Use 默认关闭", skillCatalog.computerUse.enabled === false);

  const installedSource = path.join(tmp, "installed-source");
  fs.mkdirSync(installedSource, { recursive: true });
  fs.writeFileSync(path.join(installedSource, "SKILL.md"), "---\nname: smoke-installed-alias\n---\n# installed\n", "utf8");
  const installedResult = await skills.install({ source: installedSource, id: "smoke-installed" });
  const installedCatalog = await skills.catalog(cfg.workspacePath);
  check("统一 installer 安装并发现", installedResult.id === "smoke-installed" && installedCatalog.installed.some((skill) => skill.id === "smoke-installed"));
  await skills.setEnabled({ id: "smoke-installed", source: "installed", enabled: false });
  const disabledCatalog = await skills.catalog(cfg.workspacePath);
  check("统一 installer 即时禁用", disabledCatalog.installed.some((skill) => skill.id === "smoke-installed" && skill.enabled === false));

  // 3. MCP 启动 / 健康 / 状态 / 停止
  const services = new Services();
  const logs = [];
  services.on("log", (e) => logs.push(e));
  const before = await status.probeMcp(3999);
  check("测试端口 3999 空闲", !before);
  const tunnelAvailable = fs.existsSync(paths.tunnelClientPath());
  await services.startAll().catch((err) => {
    // Tunnel 会因假密钥失败，这是预期；MCP 应已启动。
    console.log("startAll 预期失败（假密钥）:", err.message.slice(0, 120));
  });
  const health = await status.probeMcp(3999);
  check("MCP 健康", Boolean(health) && health.runtime?.tool_count === 30, health ? `pid=${health.runtime.pid} build=${health.runtime.build_id} tools=${health.runtime.tool_count}` : "no health");
  const snap = await services.collectStatus();
  check("状态聚合: MCP managed", snap.mcp.managed === true && snap.mcp.healthy === true && snap.mcp.pid === services.mcp.pid);
  if (tunnelAvailable) {
    // tunnel-client 用无效凭据也会让 /readyz 返回 ready，因此必须靠日志诊断识别 401。
    check(
      "假凭据被识别为控制平面认证失败（不谎报在线）",
      Boolean(snap.tunnel.authError),
      `ready=${snap.tunnel.ready} authError=${snap.tunnel.authError ? "yes" : "no"} metaError=${snap.tunnel.metaError ? "yes" : "no"}`
    );
    check("Tunnel 日志已捕获", logs.some((e) => e.name === "tunnel"));
  } else {
    check("公开源码检出可在无 tunnel-client 二进制时运行", true, "跳过仅依赖可选 tunnel-client.exe 的诊断");
  }
  check("MCP 日志已捕获", logs.some((e) => e.name === "mcp" && /Codex MCP Server|Runtime build/.test(e.line)));
  const live = await status.probeMcp(3000);
  check("线上 3000 未受影响", !live || live.runtime.pid !== health?.runtime?.pid, live ? `live pid=${live.runtime.pid}` : "3000 not running");

  await services.stopAll();
  const after = await status.probeMcp(3999);
  check("MCP 已停止且端口释放", !after && status.listeningPids(3999).length === 0);
  if (tunnelAvailable) check("Tunnel 已停止且端口释放", status.listeningPids(8099).length === 0);
  check("日志文件落盘", fs.existsSync(path.join(paths.logsDir(), "mcp.log")));

  fs.writeFileSync(path.join(paths.runtimeDir(), "profiles", "mcp-upstream.json"), JSON.stringify({ version: 1, servers: [{ id: "smoke-server", type: "stdio", command: "node" }] }, null, 2));
  const beforeResetSkill = fs.readFileSync(path.join(paths.runtimeDir(), "profiles", "local-skills", "smoke-installed", "SKILL.md"), "utf8");
  const reset = paths.resetRuntimeProfiles();
  const resetPlugins = JSON.parse(fs.readFileSync(reset.plugins, "utf8"));
  const resetUpstream = JSON.parse(fs.readFileSync(reset.upstream, "utf8"));
  const resetBackupExists = fs.readdirSync(path.dirname(reset.plugins)).some((name) => /^plugins\.json\.reset-.*\.bak$/.test(name));
  check("profiles reset 只重置配置", resetPlugins.schema_version === 2 && resetPlugins.skills.length === 0 && resetUpstream.servers.length === 0 && fs.readFileSync(path.join(paths.runtimeDir(), "profiles", "local-skills", "smoke-installed", "SKILL.md"), "utf8") === beforeResetSkill && resetBackupExists);

  // 4. 可选：真实凭据 doctor
  if (process.env.SMOKE_TUNNEL_DOCTOR === "1") {
    const legacy = require("../src/legacy");
    const files = legacy.legacyKeyFiles();
    const entry = files.find((f) => f.label === "Business") || files[0];
    if (entry) {
      const key = await legacy.readLegacyKey(entry.file);
      const realCfg = { ...reloaded, tunnelId: legacy.readProfileTunnelId("business-local.yaml") || legacy.readDotEnvValue("OPENAI_TUNNEL_ID"), tunnelPort: 8099 };
      const doctor = await services.runDoctor(realCfg, key, (line) => console.log("  doctor:", line.slice(0, 160)));
      check("tunnel-client doctor（真实凭据，只读）", doctor.ok, `exit=${doctor.code} 输出不含密钥=${!doctor.output.includes(key)}`);
    } else {
      check("旧密钥文件存在", false, "未找到 .secrets/*.xml");
    }
  }

  if (previousAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = previousAdminToken;

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    console.log(`（临时目录未能删除，可忽略: ${err.code}）`);
  }
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(() => main().catch((err) => {
  console.error("SMOKE ERROR", err);
  app.exit(2);
}));
