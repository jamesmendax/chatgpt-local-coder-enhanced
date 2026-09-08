import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface GoalWatchdogStatus {
  running: boolean;
  state: "on" | "off";
  mode: "goal_scoped";
  lifecycle: "managed_by_goal";
  role: "fallback_alert_only";
  parent_bound: boolean;
  pid?: number;
  parent_pid?: number;
  workspace?: string;
}

const watchdogs = new Map<string, ChildProcess>();

function stoppedStatus(): GoalWatchdogStatus {
  return {
    running: false,
    state: "off",
    mode: "goal_scoped",
    lifecycle: "managed_by_goal",
    role: "fallback_alert_only",
    parent_bound: false,
  };
}

function scriptPath(): string {
  // src/lib -> repo/scripts in ts-node/source mode; dist/lib -> repo/scripts after build.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "scripts", "goal-watchdog.mjs");
}

function childRunning(child: ChildProcess | null): child is ChildProcess {
  return Boolean(child && child.exitCode === null && !child.killed);
}

export function goalWatchdogStatus(workspaceRoot?: string): GoalWatchdogStatus {
  const resolved = workspaceRoot ? path.resolve(workspaceRoot) : undefined;
  const entries = resolved
    ? [[resolved, watchdogs.get(resolved) ?? null] as const]
    : [...watchdogs.entries()];
  for (const [workspace, child] of entries) {
    if (!childRunning(child)) watchdogs.delete(workspace);
  }
  const current: ChildProcess | null = resolved
    ? watchdogs.get(resolved) ?? null
    : [...watchdogs.entries()][0]?.[1] ?? null;
  const currentWorkspace = resolved ?? [...watchdogs.entries()][0]?.[0];
  if (!childRunning(current)) {
    return stoppedStatus();
  }
  return {
    running: true,
    state: "on",
    mode: "goal_scoped",
    lifecycle: "managed_by_goal",
    role: "fallback_alert_only",
    parent_bound: true,
    ...(current.pid ? { pid: current.pid } : {}),
    parent_pid: process.pid,
    ...(currentWorkspace ? { workspace: currentWorkspace } : {}),
  };
}

export function startGoalWatchdog(workspaceRoot: string): GoalWatchdogStatus {
  const resolved = path.resolve(workspaceRoot);
  const current = goalWatchdogStatus(resolved);
  if (current.running) return current;

  const child = spawn(process.execPath, [scriptPath()], {
    cwd: path.resolve(path.dirname(scriptPath()), ".."),
    env: {
      ...process.env,
      WATCH_WORKSPACE: resolved,
      WATCHDOG_PARENT_PID: String(process.pid),
    },
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  watchdogs.set(resolved, child);
  child.once("exit", () => {
    if (watchdogs.get(resolved) === child) watchdogs.delete(resolved);
  });
  return goalWatchdogStatus(resolved);
}

export function stopGoalWatchdog(workspaceRoot?: string): GoalWatchdogStatus {
  const resolved = workspaceRoot ? path.resolve(workspaceRoot) : undefined;
  const targets = resolved
    ? [resolved]
    : [...watchdogs.keys()];
  for (const workspace of targets) {
    const child = watchdogs.get(workspace) ?? null;
    watchdogs.delete(workspace);
    if (childRunning(child)) {
    try {
      child.kill();
    } catch {}
    }
  }
  return resolved ? goalWatchdogStatus(resolved) : stoppedStatus();
}
