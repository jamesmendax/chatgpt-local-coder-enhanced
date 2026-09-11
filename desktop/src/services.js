"use strict";
// 服务编排：启动/停止 MCP 与 Tunnel，识别外部进程，聚合状态，初始化校验与下载。
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const { ManagedProcess, killTree, sleep } = require("./processes");
const status = require("./status");
const { parseManagedDiagnostic } = require("./tunnel-health");
const harness = require("./harness");
const paths = require("./paths");
const configStore = require("./config");
const { profile } = require("./app-profile");
const accountContext = require("./account-context");
const { psQuote, runPowershell } = require("./shell-util");

const MCP_PATTERN = /dist[\\/]index\.js/i;
const TUNNEL_PATTERN = /tunnel-client(\.exe)?/i;
const TUNNEL_VERSION = "v0.0.10";
const TUNNEL_ZIP = `tunnel-client-${TUNNEL_VERSION}-windows-amd64.zip`;
const TUNNEL_URL = `https://github.com/openai/tunnel-client/releases/download/${TUNNEL_VERSION}/${TUNNEL_ZIP}`;

// Every account managed by AccountManager owns its process pair. Reusing or
// terminating a process discovered only by port/command-line heuristics would
// blur that ownership boundary, even for the legacy/default profile.
function ownershipIsolated() {
  return profile.isolated || Boolean(accountContext.current());
}

class Services extends EventEmitter {
  constructor() {
    super();
    this.mcp = new ManagedProcess("mcp");
    this.tunnel = new ManagedProcess("tunnel");
    this.launcherLines = [];
    for (const proc of [this.mcp, this.tunnel]) {
      proc.on("log", (line) => this.emit("log", { name: proc.name, line }));
      proc.on("state", () => { this.refresh().catch(() => {}); });
    }
    // 控制平面认证诊断：只从当前隧道进程的日志推导，进程重启时清空。
    this.tunnelDiagnostics = [];
    this.tunnel.on("log", (line) => {
      const item = parseManagedDiagnostic(line);
      if (item) {
        this.tunnelDiagnostics.push(item);
        if (this.tunnelDiagnostics.length > 64) this.tunnelDiagnostics.shift();
      }
    });
    this.lastStatus = null;
    this.statusInFlight = null;
    this.refreshInFlight = null;
    this.busy = false;
    this.shuttingDown = false;
  }

  note(text) {
    const line = `${new Date().toLocaleTimeString("en-GB", { hour12: false })}   ${text}`;
    this.launcherLines.push(line);
    if (this.launcherLines.length > 1000) this.launcherLines.shift();
    this.emit("log", { name: "launcher", line });
  }

  config() {
    return configStore.load();
  }

  collectStatus() {
    // Timer, IPC and managed-process events can all request the same slow poll.
    // Share only the active snapshot; actions perform their own fresh checks.
    if (this.statusInFlight) return this.statusInFlight;
    const pending = Promise.resolve().then(() => this.collectStatusSnapshot()).finally(() => {
      if (this.statusInFlight === pending) this.statusInFlight = null;
    });
    this.statusInFlight = pending;
    return pending;
  }

  async collectStatusSnapshot() {
    const cfg = this.config();
    const managedAtStart = [this.mcp, this.tunnel].map((proc) => ({
      alive: proc.isAlive(), pid: proc.pid, startedAt: proc.startedAt,
    }));
    const [health, tunnelProbe, mcpOwner, tunnelOwner] = await Promise.all([
      status.probeMcp(cfg.mcpPort),
      status.probeTunnel(cfg.tunnelPort, {
        expectedTunnelId: cfg.tunnelId,
        managedStartedAt: this.tunnel.isAlive() ? this.tunnel.startedAt : null,
        managedDiagnostics: this.tunnel.isAlive() ? this.tunnelDiagnostics : [],
      }),
      this.mcp.isAlive() ? null : status.classifyPortOwner(cfg.mcpPort, MCP_PATTERN),
      this.tunnel.isAlive() ? null : status.classifyPortOwner(cfg.tunnelPort, TUNNEL_PATTERN),
    ]);
    // A save or process transition may join this flight while probes await I/O.
    // Retry serially rather than publishing old-port/old-process observations.
    const currentCfg = this.config();
    const changedConfig = ["mcpPort", "tunnelPort", "tunnelId"].some((key) => cfg[key] !== currentCfg[key]);
    const changedProcess = [this.mcp, this.tunnel].some((proc, i) =>
      proc.isAlive() !== managedAtStart[i].alive || proc.pid !== managedAtStart[i].pid || proc.startedAt !== managedAtStart[i].startedAt);
    if (changedConfig || changedProcess) return this.collectStatusSnapshot();
    const mcpManaged = this.mcp.isAlive();
    const tunnelManaged = this.tunnel.isAlive();

    const result = {
      at: Date.now(),
      busy: this.busy,
      config: configStore.publicView(currentCfg),
      mcp: {
        state: this.mcp.state,
        managed: mcpManaged,
        pid: mcpManaged
          ? this.mcp.pid
          : (health && health.runtime ? health.runtime.pid : (mcpOwner && mcpOwner.pid) || null),
        healthy: Boolean(health),
        external: !mcpManaged && Boolean(health),
        externalRecognized: Boolean(!ownershipIsolated() && !mcpManaged && mcpOwner && mcpOwner.recognized),
        ownerProbeError: !mcpManaged && mcpOwner ? mcpOwner.error : null,
        portOccupiedByUnknown: Boolean(!mcpManaged && !health && mcpOwner && mcpOwner.pid),
        build: health && health.runtime ? health.runtime.build_id : null,
        toolCount: health && health.runtime ? health.runtime.tool_count : null,
        toolProfile: health ? health.toolProfile : null,
        staleBuild: health && health.runtime ? Boolean(health.runtime.stale_build) : null,
        auth: health ? health.auth : null,
        startedAt: health && health.runtime ? health.runtime.started_at : null,
        lastExit: this.mcp.lastExit,
      },
      tunnel: {
        state: this.tunnel.state,
        managed: tunnelManaged,
        pid: tunnelManaged ? this.tunnel.pid : (tunnelOwner && tunnelOwner.pid) || null,
        reachable: tunnelProbe.reachable,
        ready: tunnelProbe.ready,
        // Cloud state comes from real poll metrics plus scoped errors, including external daemons.
        cloudState: tunnelProbe.cloudState,
        lastPollSuccessAt: tunnelProbe.lastPollSuccessAt,
        instanceId: tunnelProbe.instanceId,
        proxyRoute: tunnelProbe.proxyRoute,
        authError: tunnelProbe.authError,
        metaError: tunnelProbe.metaError,
        external: !tunnelManaged && tunnelProbe.ready,
        externalRecognized: Boolean(!ownershipIsolated() && !tunnelManaged && tunnelOwner && tunnelOwner.recognized),
        ownerProbeError: !tunnelManaged && tunnelOwner ? tunnelOwner.error : null,
        portOccupiedByUnknown: Boolean(!tunnelManaged && !tunnelProbe.ready && tunnelOwner && tunnelOwner.pid),
        lastExit: this.tunnel.lastExit,
      },
      paths: {
        codeRoot: paths.codeRoot(),
        runtimeDir: paths.runtimeDir(),
        logsDir: paths.logsDir(),
        tunnelClient: paths.tunnelClientPath(),
        tunnelClientExists: fs.existsSync(paths.tunnelClientPath()),
        distExists: fs.existsSync(paths.distEntry()),
      },
    };
    this.lastStatus = result;
    return result;
  }

  refresh() {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.collectStatus().then((snapshot) => {
      this.emit("status", snapshot);
      return snapshot;
    }).finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    });
    this.refreshInFlight = pending;
    return pending;
  }

  async withBusy(fn) {
    if (this.busy) throw new Error("上一个操作还在进行中，请稍候。");
    this.busy = true;
    try {
      this.emit("status", await this.collectStatus());
      return await fn();
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  async waitFor(check, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.shuttingDown) return false;
      if (await check()) return true;
      await sleep(500);
    }
    this.note(`等待 ${label} 超时（${Math.round(timeoutMs / 1000)}s）`);
    return false;
  }

  async startMcp() {
    const cfg = this.config();
    if (!cfg.setupDone) throw new Error("请先完成初始化。");
    if (this.mcp.isAlive()) { this.note("MCP 已由启动器管理，跳过。"); return; }
    const health = await status.probeMcp(cfg.mcpPort);
    if (health) {
      if (ownershipIsolated()) throw new Error("隔离版不复用外部 MCP；多账号模式同样要求当前账号使用独立端口，且不会接管或终止任何外部进程。");
      this.note(`端口 ${cfg.mcpPort} 已有健康的 MCP（PID ${health.runtime && health.runtime.pid}），沿用该外部进程。`);
      return;
    }
    const owner = await status.classifyPortOwner(cfg.mcpPort, MCP_PATTERN, { fresh: true });
    if (owner.error) throw new Error(`无法确认端口 ${cfg.mcpPort} 的占用状态（${owner.error}），未启动 MCP。`);
    if (owner.pid) {
      throw new Error(`端口 ${cfg.mcpPort} 被 PID ${owner.pid}（${owner.info ? owner.info.name : "未知"}）占用且不是健康的 MCP，未做任何终止。`);
    }
    if (!fs.existsSync(paths.distEntry())) throw new Error(`找不到 MCP 构建产物: ${paths.distEntry()}`);
    paths.ensureRuntimeDir();
    harness.ensureDotEnv();
    if (this.shuttingDown) throw new Error("程序正在退出，已取消 MCP 启动。");
    const spec = harness.mcpSpawnSpec(cfg);
    const pid = this.mcp.start(spec);
    this.note(`MCP 已启动，PID ${pid}，等待 /health ...`);
    const ok = await this.waitFor(async () => Boolean(await status.probeMcp(cfg.mcpPort)), 45000, "MCP /health");
    if (!ok) {
      if (this.mcp.isAlive()) await this.mcp.stop();
      throw new Error("MCP 未在 45 秒内就绪，请查看 MCP 日志。");
    }
    this.mcp.markRunning();
    const h = await status.probeMcp(cfg.mcpPort);
    if (h && h.runtime) {
      this.note(`MCP 就绪: build ${h.runtime.build_id}，${h.runtime.tool_count} tools，stale_build=${h.runtime.stale_build}`);
    }
  }

  async startTunnel() {
    const cfg = this.config();
    if (!cfg.setupDone) throw new Error("请先完成初始化。");
    if (this.tunnel.isAlive()) { this.note("Tunnel 已由启动器管理，跳过。"); return; }
    const probe = await status.probeTunnel(cfg.tunnelPort, { expectedTunnelId: cfg.tunnelId });
    if (probe.metaError?.code === "tunnel_mismatch") throw new Error("本地端口上的 Tunnel ID 与配置不符；未终止外部进程，请检查端口或配置。");
    if (probe.ready) {
      if (ownershipIsolated()) throw new Error("隔离版不复用外部 Tunnel；多账号模式同样要求当前账号使用独立端口，且不会接管或终止任何外部进程。");
      this.note(`端口 ${cfg.tunnelPort} 已有就绪的隧道，沿用该外部进程。`);
      return;
    }
    const owner = await status.classifyPortOwner(cfg.tunnelPort, TUNNEL_PATTERN, { fresh: true });
    if (owner.error) throw new Error(`无法确认端口 ${cfg.tunnelPort} 的占用状态（${owner.error}），未启动 Tunnel。`);
    if (owner.pid) {
      throw new Error(`端口 ${cfg.tunnelPort} 被 PID ${owner.pid}（${owner.info ? owner.info.name : "未知"}）占用且未就绪，未做任何终止。`);
    }
    if (!fs.existsSync(paths.tunnelClientPath())) throw new Error("找不到 tunnel-client.exe，请先在初始化页下载。");
    const apiKey = configStore.decryptKey(cfg);
    if (!apiKey) throw new Error("尚未保存 Runtime API Key。");
    this.tunnelDiagnostics = [];
    const spec = await harness.tunnelSpawnSpec(cfg, apiKey, "run");
    this.note(`Tunnel 出站策略：${spec.proxyInfo.mode === "proxy" ? spec.proxyInfo.url : "直连"}（${spec.proxyInfo.source}）；本地 MCP 直连。`);
    if (this.shuttingDown) throw new Error("程序正在退出，已取消隧道启动。");
    const pid = this.tunnel.start(spec);
    this.note(`Tunnel 已启动，PID ${pid}，等待 /readyz ...`);
    const ok = await this.waitFor(async () => (await status.probeTunnel(cfg.tunnelPort)).ready, 60000, "Tunnel /readyz");
    if (!ok) {
      if (this.tunnel.isAlive()) await this.tunnel.stop();
      throw new Error("Tunnel 未在 60 秒内就绪，请检查 Tunnel 日志（常见原因：Tunnel ID / Runtime Key 错误或网络不通）。");
    }
    this.tunnel.markRunning();
    // This short settle may surface an auth failure; it is not cloud-success evidence.
    await sleep(2500);
    const cloud = await status.probeTunnel(cfg.tunnelPort, { expectedTunnelId: cfg.tunnelId,
      managedStartedAt: this.tunnel.startedAt, managedDiagnostics: this.tunnelDiagnostics });
    if (cloud.authError) {
      this.note("警告：隧道本地已就绪，但控制平面拒绝了凭据（401/403）。请检查 Tunnel ID 与 Runtime API Key。");
    } else if (cloud.metaError) {
      this.note("警告：本地 ready，但云端连接异常，正在退避重试；请检查 Tunnel 出站代理和网络。");
    } else if (cloud.cloudState === "online") {
      this.note("Tunnel 已完成真实云端轮询，本地 MCP 也已就绪。");
    } else {
      this.note("Tunnel 本地已就绪；正在等待首轮云端轮询确认（通常约 30 秒），尚不表示云端在线。");
    }
  }

  async startAll() {
    return this.withBusy(async () => {
      await this.startMcp();
      await this.startTunnel();
    });
  }

  async stopTunnel() {
    if (this.tunnel.isAlive()) {
      await this.tunnel.stop();
      this.note("Tunnel 已停止。");
    } else {
      this.note("Tunnel 不是由启动器管理的进程，未停止。若要停止外部进程请使用“接管外部进程”。");
    }
  }

  async stopMcp() {
    if (this.mcp.isAlive()) {
      await this.mcp.stop();
      this.note("MCP 已停止。");
    } else {
      this.note("MCP 不是由启动器管理的进程，未停止。");
    }
  }

  async stopAll() {
    return this.withBusy(async () => {
      await this.stopTunnel();
      await this.stopMcp();
    });
  }

  async restartMcp() {
    return this.withBusy(async () => {
      if (this.mcp.isAlive()) await this.mcp.stop();
      await this.startMcp();
    });
  }

  /** 明确的用户操作：终止已识别的外部 MCP / Tunnel 进程（只终止命令行匹配的进程）。 */
  async stopExternal() {
    // Isolation is an ownership boundary, not a heuristic command-name match.
    if (ownershipIsolated()) throw new Error("隔离版不接管或终止外部进程；多账号模式也只管理当前账号由本程序启动的服务。");
    return this.withBusy(async () => {
      const cfg = this.config();
      const targets = [
        ["Tunnel", cfg.tunnelPort, TUNNEL_PATTERN],
        ["MCP", cfg.mcpPort, MCP_PATTERN],
      ];
      for (const [label, port, pattern] of targets) {
        const owner = await status.classifyPortOwner(port, pattern, { fresh: true });
        if (owner.error) {
          this.note(`${label} 端口 ${port} 的占用状态无法确认（${owner.error}），未终止任何进程。`);
          continue;
        }
        if (!owner.pid) continue;
        if (!owner.recognized || !owner.creationDate) {
          this.note(`${label} 端口 ${port} 的占用者 PID ${owner.pid} 身份未完整确认，跳过。`);
          continue;
        }
        // Bypass both the display cache and earlier in-flight polls again.
        // PID + CreationDate detects PID reuse even when the new command matches.
        const current = await status.processInfo(owner.pid, { fresh: true });
        if (!current || current.ProcessId !== owner.pid || current.CreationDate !== owner.creationDate ||
            current.Name !== owner.info.name || current.CommandLine !== owner.info.commandLine) {
          this.note(`${label} 端口 ${port} 的占用者在校验期间变化或无法确认，未终止任何进程。`);
          continue;
        }
        // CIM can be slow: check the actual listener AFTER the last identity
        // query too, so a port reassigned during that query cannot authorize a kill.
        const pids = await status.listeningPids(port, { fresh: true }).catch(() => null);
        if (!pids || pids.length !== 1 || pids[0] !== owner.pid) {
          this.note(`${label} 端口 ${port} 的占用者已变化或无法确认，未终止任何进程。`);
          continue;
        }
        // Never promote ParentProcessId to a kill target: its original process
        // may have exited and that PID may now belong to an unrelated shell.
        this.note(`终止外部 ${label} 进程树 PID ${owner.pid} ...`);
        killTree(owner.pid);
        await this.waitFor(async () => {
          try { return (await status.listeningPids(port, { fresh: true })).length === 0; }
          catch { return false; } // A failed netstat is not proof the port is free.
        }, 10000, `${label} 端口释放`);
      }
    });
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.tunnel.isAlive()) await this.tunnel.stop(5000);
    if (this.mcp.isAlive()) await this.mcp.stop(5000);
  }

  /** doctor validates local preflight; only successful polling proves remote authentication. */
  async runDoctor(cfg, apiKey, onLine) {
    const spec = await harness.tunnelSpawnSpec(cfg, apiKey, "doctor");
    return new Promise((resolve) => {
      let output = "";
      let child;
      try {
        child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true });
      } catch (err) {
        resolve({ ok: false, output: `无法启动 doctor: ${err.message}` });
        return;
      }
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 90000);
      const onData = (chunk) => {
        const text = String(chunk).split(apiKey).join("<redacted>");
        output += text;
        if (onLine) for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, output: `${output}\n${err.message}` }); });
      child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output, code }); });
    });
  }

  /** 下载官方 tunnel-client 到运行目录 bin/。 */
  async downloadTunnelClient(onProgress) {
    const target = path.join(paths.runtimeDir(), "bin", "tunnel-client.exe");
    if (fs.existsSync(target)) return target;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const zipPath = path.join(paths.runtimeDir(), "bin", TUNNEL_ZIP);
    await downloadFile(TUNNEL_URL, zipPath, onProgress);
    const extractDir = path.join(paths.runtimeDir(), "bin", "_extract");
    fs.rmSync(extractDir, { recursive: true, force: true });
    await runPowershell(`Expand-Archive -LiteralPath '${psQuote(zipPath)}' -DestinationPath '${psQuote(extractDir)}' -Force`);
    const found = findFile(extractDir, "tunnel-client.exe");
    if (!found) throw new Error("压缩包内未找到 tunnel-client.exe");
    fs.copyFileSync(found, target);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
    return target;
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name) {
      return full;
    }
  }
  return null;
}

function downloadFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("重定向次数过多"));
      return;
    }
    https.get(url, { headers: { "User-Agent": "chatgpt-local-coder-desktop" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        downloadFile(res.headers.location, dest, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers["content-length"] || 0);
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on("data", (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
      });
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
      res.on("error", reject);
    }).on("error", reject);
  });
}

module.exports = { Services, MCP_PATTERN, TUNNEL_PATTERN };
