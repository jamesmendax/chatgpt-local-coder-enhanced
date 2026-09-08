"use strict";
// 运行状态探测：MCP /health、Tunnel /readyz、端口占用者及其命令行（用于识别外部进程）。
const { spawnSync } = require("child_process");
const { probeTunnel, readLoopback } = require("./tunnel-health");

async function probeMcp(port) {
  const res = await readLoopback(port, "/health", { maxBytes: 256 * 1024 });
  if (res.error || res.status !== 200) return null;
  try {
    const health = JSON.parse(res.text);
    return health && health.name === "codex-mcp-server" ? health : null;
  } catch { return null; }
}
/** 返回监听该端口的 PID 列表（netstat 解析）。 */
function listeningPids(port) {
  try {
    const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).stdout || "";
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const local = parts[1];
      if (!local.endsWith(`:${port}`)) continue;
      const pid = Number(parts[parts.length - 1]);
      if (pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

const infoCache = new Map();
/** 通过 PowerShell CIM 查询进程名与命令行，缓存 15 秒。 */
function processInfo(pid) {
  const cached = infoCache.get(pid);
  if (cached && Date.now() - cached.at < 15000) return cached.value;
  let value = null;
  try {
    const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object Name,CommandLine,ParentProcessId | ConvertTo-Json -Compress`;
    const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 8000,
    }).stdout;
    if (out && out.trim()) value = JSON.parse(out.trim());
  } catch {}
  infoCache.set(pid, { at: Date.now(), value });
  return value;
}

function classifyPortOwner(port, expectedPattern) {
  const pids = listeningPids(port);
  if (pids.length === 0) return { pid: null, recognized: false, info: null };
  const pid = pids[0];
  const info = processInfo(pid);
  const cmd = (info && info.CommandLine) || "";
  const name = (info && info.Name) || "";
  const recognized = expectedPattern.test(cmd) || expectedPattern.test(name);
  return { pid, recognized, info: info ? { name, commandLine: cmd } : null };
}

module.exports = { probeMcp, probeTunnel, listeningPids, processInfo, classifyPortOwner };
