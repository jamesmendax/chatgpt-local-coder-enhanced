import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { compactOutput, observeCommand } from "../lib/command-observation.js";
import { toSpillRef } from "../lib/spill.js";
import {
  bootstrapShellSession,
  createCommandLogFile,
  execInShellSession,
  getShellStatus,
  resetShellSession,
  getWinShell,
  transpileCompoundOperators,
} from "../lib/persistent-shell.js";

interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutChars: number;
  stderrChars: number;
  fullOutputPath?: string;
  logStream?: import("fs").WriteStream;
}

const processes = new Map<string, ManagedProcess>();
const MAX_LOG_CHARS = 400_000;
const MAX_PROCESS_RECORDS = 32;
const FINISHED_PROCESS_TTL_MS = 30 * 60 * 1000;

function compactShellResult(
  result: Awaited<ReturnType<typeof execInShellSession>>,
  outputMode: "compact" | "full" | "none",
  outputChars: number
) {
  const observation = observeCommand({
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exit_code,
    timedOut: result.timed_out,
  });
  if (outputMode === "full") return { ...result, ...observation };
  if (outputMode === "none") {
    return { ...result, stdout: "", stderr: "", ...observation };
  }

  const hasStdout = Boolean(result.stdout.trim());
  const hasStderr = Boolean(result.stderr.trim());
  const stdoutBudget = hasStdout && !hasStderr ? outputChars : hasStdout ? Math.max(1000, Math.floor(outputChars * 0.55)) : 500;
  const stderrBudget = hasStderr && !hasStdout ? outputChars : hasStderr ? Math.max(1000, outputChars - stdoutBudget) : 500;
  const stdout = compactOutput(result.stdout, stdoutBudget);
  const stderr = compactOutput(result.stderr, stderrBudget);
  return {
    ...result,
    stdout: stdout.text,
    stderr: stderr.text,
    output_preview_chars: stdout.text.length + stderr.text.length,
    output_omitted_chars: stdout.omitted_chars + stderr.omitted_chars,
    output_truncated: stdout.truncated || stderr.truncated || result.stdout_truncated || result.stderr_truncated,
    ...observation,
  };
}

function pruneFinishedProcesses(): number {
  const now = Date.now();
  let cleared = 0;
  for (const [id, item] of processes) {
    const finished = item.exitCode !== null || item.signal !== null;
    const ageMs = now - Date.parse(item.startedAt);
    if (finished && ageMs > FINISHED_PROCESS_TTL_MS) {
      processes.delete(id);
      cleared++;
    }
  }

  if (processes.size > MAX_PROCESS_RECORDS) {
    const finished = [...processes.values()]
      .filter((item) => item.exitCode !== null || item.signal !== null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const item of finished) {
      if (processes.size <= MAX_PROCESS_RECORDS) break;
      processes.delete(item.id);
      cleared++;
    }
  }
  return cleared;
}

function appendLog(lines: string[], data: Buffer): void {
  lines.push(data.toString());
  let total = lines.reduce((sum, item) => sum + item.length, 0);
  while (total > MAX_LOG_CHARS && lines.length > 1) {
    const removed = lines.shift();
    total -= removed?.length || 0;
  }
}

export function getManagedProcessRuntimeStatus() {
  pruneFinishedProcesses();
  const values = [...processes.values()];
  return {
    records: values.length,
    running: values.filter((item) => item.exitCode === null && item.signal === null).length,
    finished_retained: values.filter((item) => item.exitCode !== null || item.signal !== null).length,
    max_records: MAX_PROCESS_RECORDS,
    max_log_chars_per_stream: MAX_LOG_CHARS,
    finished_ttl_ms: FINISHED_PROCESS_TTL_MS,
  };
}

export function registerShellTools(server: McpServer, defaultCwd: string, timeoutSec: number): void {
  void bootstrapShellSession(defaultCwd);

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Run shell commands to verify work (tests, build, lint). Cwd persists across ChatGPT tool calls (saved to disk). Use shell_status to check cwd. Use start_process for long jobs.",
      inputSchema: {
        command: z.string(),
        working_directory: z.string().optional().describe("One-off override; does not reset persistent cwd unless you use shell_reset"),
        output_mode: z.enum(["compact", "full", "none"]).optional().default("compact"),
        output_chars: z.number().int().min(1000).max(50000).optional().default(12000),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory, output_mode, output_chars }) => {
      pruneFinishedProcesses();
      requireCommandAllowed(command);
      const cwdOverride = working_directory ? await validatePath(working_directory) : undefined;
      const result = await execInShellSession(command, defaultCwd, timeoutSec * 1000, cwdOverride);
      await audit({
        tool: "run_command",
        action: "command",
        target: result.cwd,
        status: result.exit_code === 0 ? "ok" : "error",
        details: { command, exit_code: result.exit_code },
      });
      const compact = compactShellResult(result, output_mode, output_chars);
      const spill = await toSpillRef(compact.full_output_path);
      return toolResult("run_command", { ...compact, ...(spill ? { spill } : {}) }, {
        ok: result.exit_code === 0,
        summary: `${compact.command_kind} ${compact.outcome}: exit ${result.exit_code} in ${result.cwd}`,
      });
    }
  );

  server.registerTool(
    "shell_status",
    {
      title: "Shell Status",
      description: "Show persistent shell session cwd and recent commands.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const status = getShellStatus();
      return toolResult("shell_status", status, { summary: `cwd: ${status.cwd}` });
    }
  );

  server.registerTool(
    "shell_reset",
    {
      title: "Shell Reset",
      description: "Reset persistent shell cwd to a directory (default: workspace).",
      inputSchema: { path: z.string().optional() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      const cwd = dirPath ? await validatePath(dirPath) : defaultCwd;
      resetShellSession(cwd);
      return toolResult("shell_reset", { cwd }, { summary: `shell cwd reset to ${cwd}` });
    }
  );

  server.registerTool(
    "start_process",
    {
      title: "Start Background Process",
      description: "Start a long-running command in the background. Use process_output/process_status/stop_process afterwards.",
      inputSchema: { command: z.string(), working_directory: z.string().optional() },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory }) => {
      requireCommandAllowed(command);
      const cwd = working_directory ? await validatePath(working_directory) : getShellStatus().cwd || defaultCwd;
      let shell = "bash";
      let effectiveCommand = command;
      let args = ["-lc", effectiveCommand];

      if (process.platform === "win32") {
        const winShellInfo = getWinShell();
        shell = winShellInfo.shell;
        if (!winShellInfo.isPwsh) {
          effectiveCommand = transpileCompoundOperators(command);
        }
        args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", effectiveCommand];
      }

      const child = spawn(shell, args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          CI: "true",
          PAGER: "cat",
          GIT_PAGER: "cat",
          NO_COLOR: "1",
        },
      });
      const log = createCommandLogFile(defaultCwd);
      log.stream?.write(`# cwd: ${cwd}\n# started: ${new Date().toISOString()}\n\n`);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const item: ManagedProcess = {
        id,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        child,
        stdout: [],
        stderr: [],
        exitCode: null,
        signal: null,
        stdoutChars: 0,
        stderrChars: 0,
        fullOutputPath: log.path,
        logStream: log.stream,
      };
      processes.set(id, item);
      child.stdout.on("data", (d: Buffer) => {
        item.stdoutChars += d.length;
        item.logStream?.write(`[stdout]\n${d.toString()}`);
        appendLog(item.stdout, d);
      });
      child.stderr.on("data", (d: Buffer) => {
        item.stderrChars += d.length;
        item.logStream?.write(`[stderr]\n${d.toString()}`);
        appendLog(item.stderr, d);
      });
      child.on("close", (code, signal) => {
        item.exitCode = code;
        item.signal = signal;
        item.logStream?.end(`\n# exit: ${code}\n# signal: ${signal ?? "none"}\n`);
      });
      await audit({ tool: "start_process", action: "start", target: cwd, status: "ok", details: { id, command } });
      const spill = await toSpillRef(item.fullOutputPath);
      return toolResult("start_process", { id, pid: child.pid, command, cwd, started_at: item.startedAt, full_output_path: item.fullOutputPath, ...(spill ? { spill } : {}) }, {
        summary: `started ${id}`,
      });
    }
  );

  server.registerTool(
    "process_status",
    {
      title: "Process Status",
      description: "Show status of background process(es).",
      inputSchema: { id: z.string().optional() },

      annotations: toolAnnotations("read"),
    },
    async ({ id }) => {
      pruneFinishedProcesses();
      const processes_list = [...processes.values()]
        .filter((p) => !id || p.id === id)
        .map((p) => ({
          id: p.id,
          pid: p.child.pid,
          command: p.command,
          cwd: p.cwd,
          started_at: p.startedAt,
          running: p.exitCode === null && p.signal === null,
          exit_code: p.exitCode,
          signal: p.signal,
          stdout_chars: p.stdoutChars,
          stderr_chars: p.stderrChars,
          full_output_path: p.fullOutputPath,
        }));
      return toolResult("process_status", { processes: processes_list }, { summary: `${processes_list.length} process(es)` });
    }
  );

  server.registerTool(
    "process_output",
    {
      title: "Process Output",
      description: "Read stdout/stderr logs for a background process.",
      inputSchema: {
        id: z.string(),
        tail_chars: z.number().int().positive().max(200000).optional().default(12000),
        output_mode: z.enum(["compact", "full", "none"]).optional().default("compact"),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, tail_chars, output_mode }) => {
      pruneFinishedProcesses();
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      const rawStdout = item.stdout.join("");
      const rawStderr = item.stderr.join("");
      const observation = observeCommand({
        command: item.command,
        stdout: rawStdout,
        stderr: rawStderr,
        exitCode: item.exitCode,
      });
      const stdout = output_mode === "full"
        ? rawStdout.slice(-tail_chars)
        : output_mode === "none"
          ? ""
          : compactOutput(rawStdout, Math.max(1000, Math.floor(tail_chars * 0.55))).text;
      const stderr = output_mode === "full"
        ? rawStderr.slice(-tail_chars)
        : output_mode === "none"
          ? ""
          : compactOutput(rawStderr, Math.max(1000, Math.floor(tail_chars * 0.45))).text;
      const data = {
        id,
        running: item.exitCode === null && item.signal === null,
        exit_code: item.exitCode,
        signal: item.signal,
        stdout,
        stderr,
        stdout_chars: item.stdoutChars,
        stderr_chars: item.stderrChars,
        full_output_path: item.fullOutputPath,
        ...observation,
      };
      const spill = await toSpillRef(item.fullOutputPath);
      return toolResult("process_output", { ...data, ...(spill ? { spill } : {}) }, { summary: `output for ${id}` });
    }
  );

  server.registerTool(
    "stop_process",
    {
      title: "Stop Process",
      description: "Stop a background process by id.",
      inputSchema: { id: z.string(), force: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ id, force }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      if (item.exitCode !== null || item.signal !== null) {
        return toolResult("stop_process", { id, already_exited: true }, { summary: `${id} already exited` });
      }
      item.child.kill(force ? "SIGKILL" : "SIGTERM");
      await audit({ tool: "stop_process", action: "stop", target: item.cwd, status: "ok", details: { id, force } });
      return toolResult("stop_process", { id, force }, { summary: `stop sent to ${id}` });
    }
  );

  server.registerTool(
    "clear_processes",
    {
      title: "Clear Finished Processes",
      description: "Remove finished process records from memory.",
      inputSchema: {},

      annotations: toolAnnotations("edit"),
    },
    async () => {
      let cleared = pruneFinishedProcesses();
      for (const [id, item] of processes) {
        if (item.exitCode !== null || item.signal !== null) {
          processes.delete(id);
          cleared++;
        }
      }
      return toolResult("clear_processes", { cleared }, { summary: `cleared ${cleared}` });
    }
  );
}