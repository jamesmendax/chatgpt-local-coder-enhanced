"use strict";
// 子进程管理：隐藏窗口启动、日志环形缓冲 + 落盘、taskkill 进程树终止。
const { spawn, spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const paths = require("./paths");

const MAX_LINES = 3000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

class ManagedProcess extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.child = null;
    this.pid = null;
    this.state = "stopped"; // stopped | starting | running | stopping | error
    this.lines = [];
    this.lastExit = null;
    this.startedAt = null;
  }

  get logFile() {
    return path.join(paths.logsDir(), `${this.name}.log`);
  }

  isAlive() {
    return this.child !== null && this.state !== "stopped" && this.state !== "error";
  }

  appendLine(stream, text) {
    const stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const line = `${stamp} ${stream === "stderr" ? "! " : "  "}${text}`;
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.emit("log", line);
    this.writeLog(line);
  }

  writeLog(line) {
    try {
      const file = this.logFile;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {}
      fs.appendFileSync(file, `${line}\n`, "utf8");
    } catch {}
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  start(spec) {
    if (this.isAlive()) throw new Error(`${this.name} 已在运行（PID ${this.pid}）。`);
    this.setState("starting");
    this.appendLine("stdout", `[launcher] 启动: ${spec.command} ${spec.args.join(" ")}`);
    this.appendLine("stdout", `[launcher] cwd: ${spec.cwd}`);

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.pid = child.pid;
    this.startedAt = Date.now();
    this.lastExit = null;

    const hook = (stream) => {
      let buffer = "";
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (line.trim()) this.appendLine(stream, line);
        }
      });
      child[stream].on("end", () => {
        if (buffer.trim()) this.appendLine(stream, buffer);
        buffer = "";
      });
    };
    hook("stdout");
    hook("stderr");

    child.on("error", (err) => {
      this.appendLine("stderr", `[launcher] 启动失败: ${err.message}`);
      this.child = null;
      this.pid = null;
      this.setState("error");
    });
    child.on("exit", (code, signal) => {
      this.lastExit = { code, signal, at: Date.now() };
      this.appendLine("stdout", `[launcher] 进程退出 code=${code} signal=${signal || "-"}`);
      this.child = null;
      const wasStopping = this.state === "stopping";
      this.pid = null;
      this.setState(wasStopping || code === 0 ? "stopped" : "error");
    });
    return child.pid;
  }

  markRunning() {
    if (this.child) this.setState("running");
  }

  async stop(timeoutMs = 10000) {
    if (!this.child) {
      this.setState("stopped");
      return;
    }
    const pid = this.pid;
    this.setState("stopping");
    this.appendLine("stdout", `[launcher] 停止进程树 PID ${pid}`);
    killTree(pid);
    const deadline = Date.now() + timeoutMs;
    while (this.child && Date.now() < deadline) {
      await sleep(200);
    }
    if (this.child) {
      this.appendLine("stderr", `[launcher] PID ${pid} 未在 ${timeoutMs}ms 内退出，再次强制终止`);
      try { this.child.kill("SIGKILL"); } catch {}
      killTree(pid);
      await sleep(500);
    }
    this.child = null;
    this.pid = null;
    this.setState("stopped");
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000 });
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ManagedProcess, killTree, sleep };
