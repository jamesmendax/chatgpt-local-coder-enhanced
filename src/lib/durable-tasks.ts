import { createHash, randomUUID } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { getVisualReviewFreshness } from "./visual-review-state.js";
import { assertGoalAllowsTaskCompletion, getGoal } from "./goals.js";
import { appendHarnessEventSafe, type HarnessEvidenceKind } from "./harness-events.js";
import { inferProjectRootsFromPaths, inferProjectScope, isPathWithinRoots } from "./project-scope.js";
import { notifyStateInvalidated } from "./state-invalidate.js";

export type DurableTaskStatus = "active" | "blocked" | "completed" | "cancelled";

export interface TaskCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface TaskEvent {
  time: string;
  kind: "tool" | "progress" | "decision" | "failure" | "check";
  summary: string;
  tool?: string;
  ok?: boolean;
  exit_code?: number | null;
  paths?: string[];
}

export interface TaskFailure {
  time: string;
  tool: string;
  summary: string;
  command?: string;
  exit_code?: number | null;
}

export interface TaskVisualReview {
  review_id: string;
  target: string;
  kind: string;
  reviewed_at: string;
  visual_status: string;
  machine_ready: boolean;
  blocking_issues: string[];
  source_path?: string;
  source_signature?: string;
}

export interface TaskBlockedReason {
  code: string;
  message: string;
  since: string;
}

export interface DurableTask {
  version: 2;
  id: string;
  goal: string;
  status: DurableTaskStatus;
  current_step: string;
  blocking_checks: TaskCheck[];
  advisory_checks: TaskCheck[];
  artifacts: string[];
  notes: string[];
  done: string[];
  decisions: string[];
  blockers: string[];
  next_actions: string[];
  changed_files: string[];
  observed_checks: TaskCheck[];
  recent_events: TaskEvent[];
  project_roots: string[];
  project_scope_locked: boolean;
  checkpoint_no: number;
  visual_required: boolean;
  blocked?: TaskBlockedReason;
  last_mutation_at?: string;
  visual_review?: TaskVisualReview;
  last_failure?: TaskFailure;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface TaskHandoff {
  task_id: string;
  goal: string;
  status: DurableTaskStatus;
  current_step: string;
  done: string[];
  decisions: string[];
  blockers: string[];
  next_actions: string[];
  changed_files: string[];
  artifacts: string[];
  blocking_remaining: number;
  advisory_remaining: number;
  observed_checks: TaskCheck[];
  blocked?: TaskBlockedReason;
  last_failure?: TaskFailure;
  recent_events: TaskEvent[];
  project_roots: string[];
  project_scope_locked: boolean;
  checkpoint_no: number;
  visual_required: boolean;
  last_mutation_at?: string;
  visual_review?: TaskVisualReview;
  updated_at: string;
}

interface ActiveTaskPointer {
  taskId: string | null;
  updatedAt: number;
}

const ACTIVE_TASK_TTL_MS = Math.min(
  30 * 24 * 60 * 60 * 1000,
  Math.max(60 * 60 * 1000, Number.parseInt(process.env.ACTIVE_TASK_TTL_MS || "86400000", 10) || 86_400_000)
);
const activeTaskCache = new Map<string, ActiveTaskPointer>();
const workspaceChains = new Map<string, Promise<void>>();
const MAX_LIST_ITEMS = 24;
const MAX_EVENTS = 24;
const MAX_CHANGED_FILES = 40;

function workspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}

async function withWorkspaceLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = workspaceKey(workspaceRoot);
  const previous = workspaceChains.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => gate);
  workspaceChains.set(key, chain);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (workspaceChains.get(key) === chain) workspaceChains.delete(key);
  }
}

function cleanString(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, max);
}

function assertBlockerCode(code: string): string {
  const cleaned = code.trim();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(cleaned)) {
    throw new Error(`blocker code must be lower-kebab-case, got "${code}"`);
  }
  return cleaned;
}

function stallGapMs(): number {
  const parsed = Number.parseInt(process.env.GOAL_STALL_GAP_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

const lastStallNotified = new Map<string, number>();

function pruneStallThrottle(): void {
  if (lastStallNotified.size <= 512) return;
  const cutoff = Date.now() - 2 * stallGapMs();
  for (const [key, at] of lastStallNotified) {
    if (at < cutoff) lastStallNotified.delete(key);
  }
}

/**
 * Stall telemetry, covering BOTH task-backed and goal-only workflows (an
 * earlier inline version in recordToolObservation only saw task-backed ones).
 * A stall = goal active + unmet criteria + no high-value activity for longer
 * than the gap threshold. A recorded blocker is a sanctioned yield, not a
 * stall. Throttled to one event per gap per workspace.
 */
export async function recordGoalStallTelemetry(workspaceRoot: string): Promise<void> {
  try {
    const gap = stallGapMs();
    if (gap <= 0) return;
    const goal = await getGoal(workspaceRoot);
    if (!goal || goal.status !== "active") return;

    const activeTaskId = await getActiveTaskId(workspaceRoot);
    let lastActivity = Date.parse(goal.updated_at);
    let taskId: string | undefined;
    let blocked = false;
    if (activeTaskId) {
      try {
        const task = await getDurableTask(workspaceRoot, activeTaskId);
        taskId = task.id;
        blocked = Boolean(task.blocked);
        const taskActivity = Date.parse(task.updated_at);
        if (Number.isFinite(taskActivity) && taskActivity > lastActivity) lastActivity = taskActivity;
      } catch {}
    }
    if (blocked || !Number.isFinite(lastActivity)) return;

    const gapMs = Date.now() - lastActivity;
    if (gapMs <= gap) return;

    const throttleKey = workspaceKey(workspaceRoot);
    const lastNotified = lastStallNotified.get(throttleKey) ?? 0;
    if (Date.now() - lastNotified <= gap) return;

    await appendHarnessEventSafe(workspaceRoot, {
      type: "goal/stall",
      ...(taskId ? { task_id: taskId } : {}),
      project_roots: [path.resolve(workspaceRoot)],
      data: {
        gap_ms: gapMs,
        criteria_passed: goal.success_criteria.filter((criterion) => criterion.passed).length,
        criteria_total: goal.success_criteria.length,
        scope: taskId ? "task" : "goal_only",
      },
    });
    // Stamp the throttle only after the event is durably handed off, so a
    // failed write retries on the next call instead of suppressing a stall.
    lastStallNotified.set(throttleKey, Date.now());
    pruneStallThrottle();
  } catch {}
}

function appendUnique(existing: string[], incoming: unknown, maxItems = MAX_LIST_ITEMS): string[] {
  const values = Array.isArray(incoming) ? incoming : incoming == null ? [] : [incoming];
  const next = [...existing];
  const seen = new Set(next.map((item) => item.toLowerCase()));
  for (const value of values) {
    const cleaned = cleanString(value);
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    next.push(cleaned);
    seen.add(cleaned.toLowerCase());
  }
  return next.slice(-maxItems);
}

function removeStrings(existing: string[], values: unknown): string[] {
  if (!Array.isArray(values)) return existing;
  const removals = new Set(values.map((value) => cleanString(value)?.toLowerCase()).filter(Boolean));
  return existing.filter((item) => !removals.has(item.toLowerCase()));
}

function mergeChecks(existing: TaskCheck[], incoming?: TaskCheck[]): TaskCheck[] {
  if (!incoming?.length) return existing;
  const next = [...existing];
  for (const check of incoming) {
    const name = cleanString(check.name, 300);
    if (!name) continue;
    const normalized: TaskCheck = {
      name,
      passed: Boolean(check.passed),
      ...(cleanString(check.detail, 2000) ? { detail: cleanString(check.detail, 2000)! } : {}),
    };
    const index = next.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());
    if (index >= 0) next[index] = normalized;
    else next.push(normalized);
  }
  return next.slice(-50);
}

function normalizeTask(
  raw: Partial<DurableTask> & Pick<DurableTask, "id" | "goal" | "status" | "current_step" | "created_at" | "updated_at">,
  workspaceRoot?: string
): DurableTask {
  return {
    version: 2,
    id: raw.id,
    goal: raw.goal,
    status: raw.status,
    current_step: raw.current_step,
    blocking_checks: raw.blocking_checks ?? [],
    advisory_checks: raw.advisory_checks ?? [],
    artifacts: raw.artifacts ?? [],
    notes: raw.notes ?? [],
    done: raw.done ?? [],
    decisions: raw.decisions ?? [],
    blockers: raw.blockers ?? [],
    next_actions: raw.next_actions ?? [],
    changed_files: raw.changed_files ?? [],
    observed_checks: raw.observed_checks ?? [],
    recent_events: raw.recent_events ?? [],
    project_roots: raw.project_roots?.length
      ? raw.project_roots.map((root) => path.resolve(root))
      : workspaceRoot
        ? [path.resolve(workspaceRoot)]
        : [],
    project_scope_locked: raw.project_scope_locked ?? false,
    ...(raw.blocked && typeof raw.blocked === "object"
      ? { blocked: raw.blocked as TaskBlockedReason }
      : {}),
    checkpoint_no: raw.checkpoint_no ?? 0,
    visual_required: raw.visual_required ?? false,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    ...(raw.completed_at ? { completed_at: raw.completed_at } : {}),
    ...(raw.last_failure ? { last_failure: raw.last_failure } : {}),
    ...(raw.last_mutation_at ? { last_mutation_at: raw.last_mutation_at } : {}),
    ...(raw.visual_review ? { visual_review: raw.visual_review } : {}),
  };
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

export function durableTaskDir(workspaceRoot: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", projectSlug(workspaceRoot), "tasks");
}

function activeTaskPath(workspaceRoot: string): string {
  return path.join(durableTaskDir(workspaceRoot), "active-task.json");
}

function taskPath(workspaceRoot: string, taskId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error("Invalid task_id");
  return path.join(durableTaskDir(workspaceRoot), `${taskId}.json`);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await fs.rename(temp, filePath);
}

async function recordTaskChange(workspaceRoot: string, operation: string, task: DurableTask): Promise<void> {
  let data: Record<string, unknown> = { operation, task };
  if (Buffer.byteLength(JSON.stringify(data), "utf-8") > 60_000) {
    // Whole-value snapshots stay under the event cap; pathological tasks fall
    // back to a summary event instead of silently dropping the change.
    data = {
      operation,
      task_summary: { id: task.id, status: task.status, checkpoint_no: task.checkpoint_no, updated_at: task.updated_at },
      snapshot_omitted: "task snapshot exceeds the 60KB event budget; read the task file for full state",
    };
  }
  await appendHarnessEventSafe(workspaceRoot, {
    type: "task/change",
    project_roots: task.project_roots,
    task_id: task.id,
    data,
  });
}

async function setActiveTaskId(workspaceRoot: string, taskId: string | null): Promise<void> {
  const key = workspaceKey(workspaceRoot);
  const previous = activeTaskCache.get(key)?.taskId ?? null;
  const updatedAt = Date.now();
  activeTaskCache.set(key, { taskId, updatedAt });
  const filePath = activeTaskPath(workspaceRoot);
  if (!taskId) {
    await fs.rm(filePath, { force: true });
  } else {
    // Always rewrite: updated_at is the TTL heartbeat for the 24h pointer expiry.
    await atomicWriteJson(filePath, { task_id: taskId, updated_at: new Date(updatedAt).toISOString() });
  }
  // Observations re-assert the same pointer on every tool call; only a real
  // pointer change may invalidate the broker cache, or the 2s state cache
  // would be defeated entirely.
  if (taskId !== previous) notifyStateInvalidated(workspaceRoot);
}

export async function getActiveTaskId(workspaceRoot: string): Promise<string | null> {
  const key = workspaceKey(workspaceRoot);
  const cached = activeTaskCache.get(key);
  if (cached) {
    if (!cached.taskId || Date.now() - cached.updatedAt <= ACTIVE_TASK_TTL_MS) return cached.taskId;
    activeTaskCache.delete(key);
    await fs.rm(activeTaskPath(workspaceRoot), { force: true }).catch(() => {});
    return null;
  }
  try {
    const raw = JSON.parse(await fs.readFile(activeTaskPath(workspaceRoot), "utf-8")) as { task_id?: string; updated_at?: string };
    const taskId = typeof raw.task_id === "string" ? raw.task_id : null;
    const updatedAt = Date.parse(raw.updated_at || "");
    if (taskId && (!Number.isFinite(updatedAt) || Date.now() - updatedAt > ACTIVE_TASK_TTL_MS)) {
      activeTaskCache.set(key, { taskId: null, updatedAt: Date.now() });
      await fs.rm(activeTaskPath(workspaceRoot), { force: true });
      return null;
    }
    activeTaskCache.set(key, { taskId, updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now() });
    return taskId;
  } catch {
    activeTaskCache.set(key, { taskId: null, updatedAt: Date.now() });
    return null;
  }
}

export async function createDurableTask(
  workspaceRoot: string,
  input: {
    goal: string;
    current_step?: string;
    blocking_checks?: TaskCheck[];
    advisory_checks?: TaskCheck[];
    artifacts?: string[];
    notes?: string[];
    visual_required?: boolean;
  }
): Promise<DurableTask> {
  const now = new Date().toISOString();
  const scope = await inferProjectScope(workspaceRoot, [input.goal, input.current_step, ...(input.notes ?? [])]);
  const task: DurableTask = {
    version: 2,
    id: randomUUID(),
    goal: input.goal.trim(),
    status: "active",
    current_step: input.current_step?.trim() || "Start work",
    blocking_checks: input.blocking_checks ?? [],
    advisory_checks: input.advisory_checks ?? [],
    artifacts: input.artifacts ?? [],
    notes: input.notes ?? [],
    done: [],
    decisions: [],
    blockers: [],
    next_actions: [],
    changed_files: [],
    observed_checks: [],
    recent_events: [],
    project_roots: scope.roots,
    project_scope_locked: scope.locked,
    checkpoint_no: 0,
    visual_required: Boolean(input.visual_required),
    created_at: now,
    updated_at: now,
  };
  await withWorkspaceLock(workspaceRoot, async () => {
    await atomicWriteJson(taskPath(workspaceRoot, task.id), task);
    await setActiveTaskId(workspaceRoot, task.id);
    notifyStateInvalidated(workspaceRoot);
  });
  await recordTaskChange(workspaceRoot, "create", task);
  return task;
}

export async function getDurableTask(workspaceRoot: string, taskId: string): Promise<DurableTask> {
  const raw = await fs.readFile(taskPath(workspaceRoot, taskId), "utf-8");
  return normalizeTask(JSON.parse(raw) as DurableTask, workspaceRoot);
}

export async function updateDurableTask(
  workspaceRoot: string,
  taskId: string,
  patch: Partial<Pick<DurableTask, "goal" | "status" | "current_step" | "blocking_checks" | "advisory_checks" | "artifacts" | "notes" | "visual_required">>
): Promise<DurableTask> {
  return withWorkspaceLock(workspaceRoot, async () => {
    const task = await getDurableTask(workspaceRoot, taskId);
    const next: DurableTask = {
      ...task,
      ...patch,
      goal: patch.goal?.trim() || task.goal,
      current_step: patch.current_step?.trim() ?? task.current_step,
      updated_at: new Date().toISOString(),
    };
    if (next.status === "completed" && !next.completed_at) next.completed_at = next.updated_at;
    if (next.status !== "completed") delete next.completed_at;
    if (next.status === "completed" || next.status === "cancelled") delete next.blocked;
    await atomicWriteJson(taskPath(workspaceRoot, taskId), next);
    notifyStateInvalidated(workspaceRoot);
    if (next.status === "active" || next.status === "blocked") await setActiveTaskId(workspaceRoot, taskId);
    else if ((await getActiveTaskId(workspaceRoot)) === taskId) await setActiveTaskId(workspaceRoot, null);
    await recordTaskChange(workspaceRoot, "update", next);
    return next;
  });
}

export async function resolveDurableTask(workspaceRoot: string, taskId?: string): Promise<DurableTask> {
  if (taskId) return getDurableTask(workspaceRoot, taskId);
  const activeId = await getActiveTaskId(workspaceRoot);
  if (activeId) {
    try {
      return await getDurableTask(workspaceRoot, activeId);
    } catch {
      await setActiveTaskId(workspaceRoot, null);
    }
  }
  const recent = await listDurableTasks(workspaceRoot, { limit: 20 });
  const resumable = recent.find((task) => task.status === "active" || task.status === "blocked");
  if (!resumable) throw new Error("No active task. Create one with task_state action=create.");
  await setActiveTaskId(workspaceRoot, resumable.id);
  return resumable;
}

export async function checkpointDurableTask(
  workspaceRoot: string,
  taskId: string | undefined,
  input: {
    current_step?: string;
    done?: string[];
    decisions?: string[];
    blockers?: string[];
    resolved_blockers?: string[];
    blocked_reason?: { code: string; message: string };
    next_actions?: string[];
    artifacts?: string[];
    notes?: string[];
    blocking_checks?: TaskCheck[];
    advisory_checks?: TaskCheck[];
    visual_required?: boolean;
  }
): Promise<DurableTask> {
  const task = await resolveDurableTask(workspaceRoot, taskId);
  return withWorkspaceLock(workspaceRoot, async () => {
    const current = await getDurableTask(workspaceRoot, task.id);
    const now = new Date().toISOString();
    const next: DurableTask = {
      ...current,
      current_step: cleanString(input.current_step, 2000) ?? current.current_step,
      done: appendUnique(current.done, input.done),
      decisions: appendUnique(current.decisions, input.decisions),
      blockers: appendUnique(removeStrings(current.blockers, input.resolved_blockers), input.blockers),
      next_actions: appendUnique([], input.next_actions, 12),
      artifacts: appendUnique(current.artifacts, input.artifacts, 40),
      notes: appendUnique(current.notes, input.notes, 40),
      blocking_checks: mergeChecks(current.blocking_checks, input.blocking_checks),
      advisory_checks: mergeChecks(current.advisory_checks, input.advisory_checks),
      visual_required: input.visual_required ?? current.visual_required,
      ...(input.blocked_reason
        ? {
            blocked: {
              code: assertBlockerCode(input.blocked_reason.code),
              message: cleanString(input.blocked_reason.message, 1000) ?? "blocked",
              since: now,
            },
          }
        : input.resolved_blockers?.length
          ? { blocked: undefined }
          : {}),
      checkpoint_no: current.checkpoint_no + 1,
      updated_at: now,
      recent_events: [
        ...current.recent_events,
        {
          time: now,
          kind: "progress",
          summary: cleanString(input.current_step, 500) ?? `Checkpoint ${current.checkpoint_no + 1}`,
        } satisfies TaskEvent,
      ].slice(-MAX_EVENTS),
    };
    await atomicWriteJson(taskPath(workspaceRoot, next.id), next);
    await setActiveTaskId(workspaceRoot, next.id);
    notifyStateInvalidated(workspaceRoot);
    await recordTaskChange(workspaceRoot, "checkpoint", next);
    return next;
  });
}

export function taskHandoff(task: DurableTask): TaskHandoff {
  return {
    task_id: task.id,
    goal: task.goal,
    status: task.status,
    current_step: task.current_step,
    done: task.done.slice(-10),
    decisions: task.decisions.slice(-8),
    blockers: task.blockers.slice(-8),
    next_actions: task.next_actions.slice(0, 8),
    changed_files: task.changed_files.slice(-16),
    artifacts: task.artifacts.slice(-16),
    blocking_remaining: task.blocking_checks.filter((check) => !check.passed).length,
    advisory_remaining: task.advisory_checks.filter((check) => !check.passed).length,
    ...(task.blocked ? { blocked: task.blocked } : {}),
    observed_checks: task.observed_checks.slice(-12),
    ...(task.last_failure ? { last_failure: task.last_failure } : {}),
    recent_events: task.recent_events.slice(-8),
    project_roots: task.project_roots,
    project_scope_locked: task.project_scope_locked,
    checkpoint_no: task.checkpoint_no,
    visual_required: task.visual_required,
    ...(task.last_mutation_at ? { last_mutation_at: task.last_mutation_at } : {}),
    ...(task.visual_review ? { visual_review: task.visual_review } : {}),
    updated_at: task.updated_at,
  };
}

function resultPayload(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  return structured && typeof structured === "object" ? structured as Record<string, unknown> : null;
}

function objectValue(source: unknown, key: string): unknown {
  return source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;
}

function extractPaths(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractPaths(item, depth + 1));
  if (typeof value !== "object") return [];
  const out: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (["path", "source", "destination", "output_path", "full_output_path", "saved_to", "staging_path"].includes(key) && typeof nested === "string") {
      out.push(nested);
    } else if (["files", "artifacts", "data", "output_paths", "page_paths", "focus_paths", "images_returned"].includes(key)) {
      out.push(...extractPaths(nested, depth + 1));
    }
  }
  return [...new Set(out)].slice(0, 20);
}

function extractScopePaths(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractScopePaths(item, depth + 1));
  if (typeof value !== "object") return [];
  const out: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (["path", "source", "destination", "working_directory", "cwd", "target"].includes(key) && typeof nested === "string") {
      out.push(nested);
    } else if (["files", "data", "images_returned"].includes(key)) {
      out.push(...extractScopePaths(nested, depth + 1));
    }
  }
  return [...new Set(out)].slice(0, 20);
}

function observationEvidenceKind(tool: string, data: Record<string, unknown>): HarnessEvidenceKind {
  if (tool === "visual_review" && (data.action === "assess" || data.model_visual_assessment)) return "model_assessed";
  if (["run_command", "start_process", "process_output", "stop_process", "render_svg", "capture_webpage", "visual_review"].includes(tool)) {
    return "runtime";
  }
  return "deterministic";
}

function observedCheck(command: string | undefined, passed: boolean, detail: string): TaskCheck | null {
  if (!command) return null;
  const normalized = command.toLowerCase();
  let name: string | null = null;
  if (/\b(test|pytest|vitest|jest|cargo test|go test|mvn test|gradle test)\b/.test(normalized)) name = "tests";
  else if (/\b(build|compile|tsc|cargo build|go build)\b/.test(normalized)) name = "build";
  else if (/\b(lint|eslint|ruff|clippy)\b/.test(normalized)) name = "lint";
  else if (/\b(format|prettier|gofmt|rustfmt)\b/.test(normalized)) name = "format";
  if (!name) return null;
  return { name, passed, detail: detail.slice(0, 1000) };
}

const MUTATING_TOOLS = new Set([
  "write_file",
  "write_file_base64",
  "save_chatgpt_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "delete_file",
  "copy_file",
  "move_file",
]);

const HIGH_VALUE_OBSERVATION_TOOLS = new Set([
  ...MUTATING_TOOLS,
  "run_command",
  "start_process",
  "process_output",
  "stop_process",
  "open_image",
  "render_svg",
  "capture_webpage",
  "visual_review",
]);

const ARTIFACT_TOOLS = new Set([
  "run_command",
  "start_process",
  "process_output",
  "open_image",
  "render_svg",
  "capture_webpage",
  "visual_review",
]);

const MAX_ARTIFACT_HASH_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_REFS = 4;

// Content-addressed artifact references for the event mirror: events carry
// {path, sha256, bytes} only, never file content. Best-effort — unhashable
// artifacts keep their plain path entry.
async function hashArtifactFiles(paths: string[]): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const refs: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const candidate of paths.slice(0, MAX_ARTIFACT_REFS)) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_HASH_BYTES) continue;
      const digest = createHash("sha256").update(await fs.readFile(candidate)).digest("hex");
      refs.push({ path: candidate, sha256: digest, bytes: stat.size });
    } catch {}
  }
  return refs;
}

const VISUAL_EXTENSIONS = new Set([
  ".svg", ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".pptx", ".docx",
]);

function looksLikeVisualMutation(tool: string, paths: string[], command?: string): boolean {
  if (MUTATING_TOOLS.has(tool) && paths.some((candidate) => VISUAL_EXTENSIONS.has(path.extname(candidate).toLowerCase()))) {
    return true;
  }
  if (tool !== "run_command" && tool !== "start_process") return false;
  const normalized = (command || "").toLowerCase();
  return /\.(svg|html?|css|scss|sass|less|png|jpe?g|webp|gif|pdf|pptx|docx)\b/.test(normalized) ||
    /\b(vite|webpack|next\s+build|astro|storybook|playwright|puppeteer)\b/.test(normalized);
}

export async function recordToolObservation(
  workspaceRoot: string,
  tool: string,
  args: unknown,
  result?: unknown,
  thrownError?: unknown
): Promise<void> {
  if (tool === "task_state" || tool.startsWith("task_")) return;
  const taskId = await getActiveTaskId(workspaceRoot);
  if (!taskId) return;

  await withWorkspaceLock(workspaceRoot, async () => {
    let task: DurableTask;
    try {
      task = await getDurableTask(workspaceRoot, taskId);
    } catch {
      await setActiveTaskId(workspaceRoot, null);
      return;
    }
    if (task.status !== "active" && task.status !== "blocked") return;

    const payload = resultPayload(result);
    const data = payload?.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const ok = thrownError ? false : payload?.ok !== false;
    const summary = cleanString(
      thrownError instanceof Error ? thrownError.message : thrownError ? String(thrownError) : payload?.summary,
      300
    ) ?? `${tool}: ${ok ? "done" : "failed"}`;
    const command = cleanString(objectValue(args, "command") ?? data.command, 200) ?? undefined;
    const exitCode = typeof data.exit_code === "number" || data.exit_code === null ? data.exit_code as number | null : undefined;
    const paths = [...new Set([...extractPaths(args), ...extractPaths(data)])];
    const scopePaths = [...new Set([...extractScopePaths(args), ...extractScopePaths(data)])];
    let projectRoots = task.project_roots.length ? task.project_roots : [path.resolve(workspaceRoot)];
    let projectScopeLocked = task.project_scope_locked;
    if (!projectScopeLocked && scopePaths.some((candidate) => path.isAbsolute(candidate))) {
      const inferred = await inferProjectRootsFromPaths(scopePaths, workspaceRoot);
      if (inferred.length) {
        projectRoots = inferred;
        projectScopeLocked = true;
      }
    }
    const absoluteScopePaths = scopePaths.filter((candidate) => path.isAbsolute(candidate));
    if (projectScopeLocked && absoluteScopePaths.length > 0 && !absoluteScopePaths.some((candidate) => isPathWithinRoots(candidate, projectRoots))) {
      return;
    }
    const scopedPaths = paths.filter((candidate) => !path.isAbsolute(candidate) || isPathWithinRoots(candidate, projectRoots));
    const keyLines = Array.isArray(data.key_lines)
      ? data.key_lines.map((line) => cleanString(line, 500)).filter((line): line is string => Boolean(line)).slice(0, 4)
      : [];
    const evidence = cleanString(keyLines.join(" | "), 1200) ?? summary;
    const running = typeof data.running === "boolean" ? data.running : undefined;
    const canObserveCheck = tool === "run_command" || (tool === "process_output" && running === false && exitCode !== undefined);
    const check = canObserveCheck
      ? observedCheck(command, ok && exitCode === 0, evidence)
      : null;
    if (ok && !HIGH_VALUE_OBSERVATION_TOOLS.has(tool) && !check) return;

    const artifactPaths = ARTIFACT_TOOLS.has(tool)
      ? paths.filter((candidate) =>
          candidate === data.full_output_path ||
          candidate === data.output_path ||
          tool === "open_image" ||
          tool === "render_svg" ||
          tool === "capture_webpage" ||
          tool === "visual_review"
        )
      : [];
    const artifactRefs = await hashArtifactFiles(artifactPaths);
    const now = new Date().toISOString();
    const visualMutation = ok && looksLikeVisualMutation(tool, scopedPaths, command);
    const reviewId = typeof data.review_id === "string" ? data.review_id : undefined;
    const target = cleanString(data.target, 2000);
    const visualReview = ok && tool === "visual_review" && reviewId && typeof data.visual_status === "string"
      ? {
          review_id: reviewId,
          target: target || "visual artifact",
          kind: cleanString(data.kind, 100) || "unknown",
          reviewed_at: now,
          visual_status: String(data.visual_status),
          machine_ready: !Array.isArray(data.machine_blocking_issues) || data.machine_blocking_issues.length === 0,
          blocking_issues: Array.isArray(data.machine_blocking_issues)
            ? data.machine_blocking_issues.map((item) => cleanString(item, 1000)).filter((item): item is string => Boolean(item)).slice(0, 20)
            : [],
          ...(target && !/^https?:\/\//i.test(target) ? { source_path: target } : {}),
          ...(typeof data.source_signature === "string" ? { source_signature: data.source_signature } : {}),
        } satisfies TaskVisualReview
      : undefined;
    const event: TaskEvent = {
      time: now,
      kind: ok ? "tool" : "failure",
      summary: ok ? summary : evidence === summary ? summary : `${summary}: ${evidence}`,
      tool,
      ok,
      ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
      ...(scopedPaths.length ? { paths: scopedPaths.slice(0, 8) } : {}),
    };
    const next: DurableTask = {
      ...task,
      changed_files: MUTATING_TOOLS.has(tool)
        ? appendUnique(task.changed_files, scopedPaths, MAX_CHANGED_FILES)
        : task.changed_files,
      artifacts: appendUnique(task.artifacts, artifactPaths, 40),
      observed_checks: check ? mergeChecks(task.observed_checks, [check]) : task.observed_checks,
      recent_events: [...task.recent_events, event].slice(-MAX_EVENTS),
      project_roots: projectRoots,
      project_scope_locked: projectScopeLocked,
      updated_at: now,
      visual_required: task.visual_required || visualMutation || Boolean(visualReview),
      ...(visualMutation ? { last_mutation_at: now } : {}),
      ...(visualReview ? { visual_review: visualReview } : {}),
      ...(ok
        ? {}
        : {
            last_failure: {
              time: now,
              tool,
              summary: evidence === summary ? summary : `${summary}: ${evidence}`,
              ...(command ? { command } : {}),
              ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
            } satisfies TaskFailure,
          }),
    };
    await atomicWriteJson(taskPath(workspaceRoot, taskId), next);
    await setActiveTaskId(workspaceRoot, taskId);
    // Observation mutations (recent_events/observed_checks/changed_files) do
    // not alter any field the broker snapshot renders, so no invalidation here.
    const evidenceKind = observationEvidenceKind(tool, data);
    await appendHarnessEventSafe(workspaceRoot, {
      type: "tool/observation",
      project_roots: next.project_roots,
      task_id: taskId,
      evidence_kind: evidenceKind,
      data: {
        tool,
        ok,
        summary,
        ...(command ? { command } : {}),
        ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
        ...(scopedPaths.length ? { paths: scopedPaths.slice(0, 8) } : {}),
        ...(artifactRefs.length ? { artifacts: artifactRefs } : {}),
      },
    });
    if (check || evidenceKind === "model_assessed") {
      await appendHarnessEventSafe(workspaceRoot, {
        type: "evidence/recorded",
        project_roots: next.project_roots,
        task_id: taskId,
        evidence_kind: evidenceKind,
        data: {
          source_tool: tool,
          ...(check ? { check } : {}),
          summary: evidence,
        },
      });
    }
    // Observation-driven task mutations are mirrored as slim tool/observation
    // events; whole-value task/change stays reserved for explicit state changes
    // (create/update/checkpoint/complete) so the log cannot grow 10KB per call.
  });
}

export async function completeDurableTask(workspaceRoot: string, taskId: string, note?: string): Promise<DurableTask> {
  const task = await getDurableTask(workspaceRoot, taskId);
  const failedBlocking = task.blocking_checks.filter((check) => !check.passed);
  if (failedBlocking.length > 0) {
    throw new Error(
      `Cannot complete task: ${failedBlocking.length} blocking check(s) are not passed: ${failedBlocking.map((c) => c.name).join(", ")}. ` +
      `Keep executing toward the remaining checks — a progress update is not a stop condition.`
    );
  }
  await assertGoalAllowsTaskCompletion(workspaceRoot);
  if (task.visual_required) {
    if (!task.visual_review) {
      throw new Error("Cannot complete task: visual review is required but no current visual_review result is recorded.");
    }
    const freshness = await getVisualReviewFreshness(workspaceRoot, task.visual_review.review_id);
    if (!freshness.machine_ready) {
      throw new Error(`Cannot complete task: visual review has machine blocking issue(s): ${freshness.record.machine_blocking_issues.join("; ")}`);
    }
    if (!freshness.model_visual_ready) {
      const assessment = freshness.record.model_visual_assessment;
      if (assessment?.verdict === "fail") {
        throw new Error(`Cannot complete task: model visual assessment failed: ${assessment.issues.join("; ") || assessment.summary || "visual defects remain"}. Revise the artifact, rerun visual_review, inspect the new rendered pixels, and assess again.`);
      }
      if (assessment?.verdict === "pass" && !freshness.model_visual_coverage.complete) {
        const missing = freshness.model_visual_coverage.missing_pages.slice(0, 12);
        throw new Error(`Cannot complete task: model visual assessment passed for the delivered pages, but full visual coverage is incomplete. Missing page(s): ${missing.join(", ")}${freshness.model_visual_coverage.missing_pages.length > missing.length ? ", ..." : ""}. Run visual_review for the next missing pages, inspect every returned page image, and assess that review_id.`);
      }
      throw new Error("Cannot complete task: the latest rendered pixels have not been semantically inspected and passed by the model. Inspect the full render/page images returned by visual_review, then call visual_review action=assess with verdict=pass and inspected_full_render=true.");
    }
    if (freshness.verifiable && !freshness.fresh) {
      throw new Error(`Cannot complete task: ${freshness.reason} Run visual_review again after the latest source change.`);
    }
    if (!freshness.verifiable && task.last_mutation_at && task.last_mutation_at > task.visual_review.reviewed_at) {
      throw new Error("Cannot complete task: the project changed after the latest live/remote visual review. Run visual_review again.");
    }
    if (!freshness.model_visual_iteration_ready) {
      const opportunities = freshness.model_visual_iteration.improvement_opportunities.slice(0, 5);
      const iteration = freshness.model_visual_iteration;
      throw new Error(`Cannot complete task: the model passed the current visual version but identified worthwhile further improvement. Continue visual iteration ${Math.min(iteration.current_iteration + 1, iteration.max_iterations)} of ${iteration.max_iterations} before delivery: ${opportunities.join("; ") || "see model visual iteration notes"}.`);
    }
  }
  const notes = note?.trim() ? [...task.notes, note.trim()] : task.notes;
  return updateDurableTask(workspaceRoot, taskId, {
    status: "completed",
    current_step: "Deliverable ready",
    notes,
  });
}

export async function listDurableTasks(
  workspaceRoot: string,
  options?: { status?: DurableTaskStatus; limit?: number }
): Promise<DurableTask[]> {
  const dir = durableTaskDir(workspaceRoot);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name));
  } catch {
    return [];
  }

  const tasks: DurableTask[] = [];
  for (const name of names) {
    try {
      const task = normalizeTask(JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")) as DurableTask, workspaceRoot);
      if (!options?.status || task.status === options.status) tasks.push(task);
    } catch {}
  }
  tasks.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return tasks.slice(0, Math.max(1, Math.min(options?.limit ?? 20, 100)));
}
