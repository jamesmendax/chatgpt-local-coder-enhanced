"use strict";
// 服务编排：启动/停止 MCP 与 Tunnel，识别外部进程，聚合状态，初始化校验与下载。
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const { ManagedProcess, killTree, sleep } = require("./processes");
const status = require("./status");
const harness = require("./harness");
const paths = require("./paths");
const configStore = require("./config");
const { psQuote, runPowershell } = require("./shell-util");

const MCP_PATTERN = /dist[\\/]index\.js/i;
const TUNNEL_PATTERN = /tunnel-client(\.exe)?/i;
const TUNNEL_VERSION = "v0.0.10";
const TUNNEL_ZIP = `tunnel-client-${TUNNEL_VERSION}-windows-amd64.zip`;
const TUNNEL_URL = `https://github.com/openai/tunnel-client/releases/download/${TUNNEL_VERSION}/${TUNNEL_ZIP}`;

// tunnel-client 的 /readyz 只验证"守护进程在跑且本地 MCP 可达"，即使 Tunnel ID / Runtime Key
// 无效也会返回 ready。真正的控制平面认证失败只体现在日志里，因此单独扫描这些特征。
const TUNNEL_AUTH_FAIL = /invalid_api_key|"?status"?[:=]\s*401\b|\b401\b[^0-9]{0,40}(unauthorized|invalid)|unauthorized/i;
const TUNNEL_META_FAIL = /tunnel metadata fetch failed|poll failed; backing off/i;

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
    this.tunnelDiag = { authError: null, metaError: null };
    this.tunnel.on("log", (line) => {
      if (TUNNEL_AUTH_FAIL.test(line)) this.tunnelDiag.authError = { at: Date.now(), line: line.slice(0, 300) };
      else if (TUNNEL_META_FAIL.test(line)) this.tunnelDiag.metaError = { at: Date.now(), line: line.slice(0, 300) };
    });
    this.lastStatus = null;
    this.busy = false;
  }

  note(text) {
    const line = `${new Date().toISOString().slice(11, 19)}   ${text}`;
    this.launcherLines.push(line);
    if (this.launcherLines.length > 1000) this.launcherLines.shift();
    this.emit("log", { name: "launcher", line });
  }

  config() {
    return configStore.load();
  }

  async collectStatus() {
    const cfg = this.config();
    const health = await status.probeMcp(cfg.mcpPort);
    const tunnelProbe = await status.probeTunnel(cfg.tunnelPort);

    const mcpManaged = this.mcp.isAlive();
    const mcpOwner = mcpManaged ? null : status.classifyPortOwner(cfg.mcpPort, MCP_PATTERN);
    const tunnelManaged = this.tunnel.isAlive();
    const tunnelOwner = tunnelManaged ? null : status.classifyPortOwner(cfg.tunnelPort, TUNNEL_PATTERN);

    const result = {
      at: Date.now(),
      busy: this.busy,
      config: configStore.publicView(cfg),
      mcp: {
        state: this.mcp.state,
        managed: mcpManaged,
        pid: mcpManaged
          ? this.mcp.pid
          : (health && health.runtime ? health.runtime.pid : (mcpOwner && mcpOwner.pid) || null),
        healthy: Boolean(health),
        external: !mcpManaged && Boolean(health),
        externalRecognized: Boolean(mcpOwner && mcpOwner.recognized),
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
        // ready 只说明本地链路通；凭据是否被控制平面接受要看下面两个诊断。
        authError: tunnelManaged ? this.tunnelDiag.authError : null,
        metaError: tunnelManaged ? this.tunnelDiag.metaError : null,
        external: !tunnelManaged && tunnelProbe.ready,
        externalRecognized: Boolean(tunnelOwner && tunnelOwner.recognized),
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

  async refresh() {
    const snapshot = await this.collectStatus();
    this.emit("status", snapshot);
    return snapshot;
  }

  async withBusy(fn) {
    if (this.busy) throw new Error("上一个操作还在进行中，请稍候。");
    this.busy = true;
    this.emit("status", await this.collectStatus());
    try {
      return await fn();
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  async waitFor(check, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
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
      this.note(`端口 ${cfg.mcpPort} 已有健康的 MCP（PID ${health.runtime && health.runtime.pid}），沿用该外部进程。`);
      return;
    }
    const owner = status.classifyPortOwner(cfg.mcpPort, MCP_PATTERN);
    if (owner.pid) {
      throw new Error(`端口 ${cfg.mcpPort} 被 PID ${owner.pid}（${owner.info ? owner.info.name : "未知"}）占用且不是健康的 MCP，未做任何终止。`);
    }
    if (!fs.existsSync(paths.distEntry())) throw new Error(`找不到 MCP 构建产物: ${paths.distEntry()}`);
    paths.ensureRuntimeDir();
    harness.ensureDotEnv();
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
    const probe = await status.probeTunnel(cfg.tunnelPort);
    if (probe.ready) {
      this.note(`端口 ${cfg.tunnelPort} 已有就绪的隧道，沿用该外部进程。`);
      return;
    }
    const owner = status.classifyPortOwner(cfg.tunnelPort, TUNNEL_PATTERN);
    if (owner.pid) {
      throw new Error(`端口 ${cfg.tunnelPort} 被 PID ${owner.pid}（${owner.info ? owner.info.name : "未知"}）占用且未就绪，未做任何终止。`);
    }
    if (!fs.existsSync(paths.tunnelClientPath())) throw new Error("找不到 tunnel-client.exe，请先在初始化页下载。");
    const apiKey = configStore.decryptKey(cfg);
    if (!apiKey) throw new Error("尚未保存 Runtime API Key。");
    this.tunnelDiag = { authError: null, metaError: null };
    const spec = harness.tunnelSpawnSpec(cfg, apiKey, "run");
    const pid = this.tunnel.start(spec);
    this.note(`Tunnel 已启动，PID ${pid}，等待 /readyz ...`);
    const ok = await this.waitFor(async () => (await status.probeTunnel(cfg.tunnelPort)).ready, 60000, "Tunnel /readyz");
    if (!ok) {
      if (this.tunnel.isAlive()) await this.tunnel.stop();
      throw new Error("Tunnel 未在 60 秒内就绪，请检查 Tunnel 日志（常见原因：Tunnel ID / Runtime Key 错误或网络不通）。");
    }
    this.tunnel.markRunning();
    // /readyz 就绪后再给控制平面几秒，让认证失败（401）有机会出现在日志里。
    await sleep(2500);
    if (this.tunnelDiag.authError) {
      this.note("警告：隧道本地已就绪，但控制平面拒绝了凭据（401 / invalid_api_key）。ChatGPT 仍无法连接，请检查 Tunnel ID 与 Runtime API Key。");
    } else {
      this.note(`Tunnel 就绪: http://127.0.0.1:${cfg.tunnelPort}/readyz`);
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
    return this.withBusy(async () => {
      const cfg = this.config();
      const targets = [
        ["Tunnel", cfg.tunnelPort, TUNNEL_PATTERN],
        ["MCP", cfg.mcpPort, MCP_PATTERN],
      ];
      for (const [label, port, pattern] of targets) {
        const owner = status.classifyPortOwner(port, pattern);
        if (!owner.pid) continue;
        if (!owner.recognized) {
          this.note(`${label} 端口 ${port} 的占用者 PID ${owner.pid} 未被识别为本项目进程，跳过。`);
          continue;
        }
        let pid = owner.pid;
        // MCP 若由 start.ps1 的 PowerShell 窗口启动，一并关闭其父窗口。
        if (label === "MCP") {
          const info = status.processInfo(pid);
          if (info && info.ParentProcessId) {
            const parent = status.processInfo(info.ParentProcessId);
            if (parent && /powershell|pwsh/i.test(parent.Name || "") && /start\.ps1/i.test(parent.CommandLine || "")) {
              pid = info.ParentProcessId;
            }
          }
        }
        this.note(`终止外部 ${label} 进程树 PID ${pid} ...`);
        killTree(pid);
        if (pid !== owner.pid) killTree(owner.pid);
        await this.waitFor(() => Promise.resolve(status.listeningPids(port).length === 0), 10000, `${label} 端口释放`);
      }
    });
  }

  async shutdown() {
    if (this.tunnel.isAlive()) await this.tunnel.stop(5000);
    if (this.mcp.isAlive()) await this.mcp.stop(5000);
  }

  /** 运行 tunnel-client doctor 验证凭据；输出脱敏后返回。 */
  runDoctor(cfg, apiKey, onLine) {
    return new Promise((resolve) => {
      const spec = harness.tunnelSpawnSpec(cfg, apiKey, "doctor");
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
