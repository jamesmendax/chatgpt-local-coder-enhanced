import { createHash, randomUUID } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { appendHarnessEventSafe } from "./harness-events.js";
import { appendAutoMemory } from "./auto-memory.js";
import { inferProjectScope } from "./project-scope.js";
import { notifyStateInvalidated } from "./state-invalidate.js";
import { getRuntimeScope } from "./runtime-scope.js";

export type GoalStatus = "active" | "paused" | "completed" | "cancelled";

export interface GoalCriterion {
  name: string;
  passed: boolean;
  detail?: string;
  requires_confirmation?: boolean;
}

export interface DurableGoal {
  version: 1;
  id: string;
  revision: number;
  objective: string;
  success_criteria: GoalCriterion[];
  constraints: string[];
  status: GoalStatus;
  current_phase: string;
  owner_session?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export const GOAL_GROUNDING_NOTE =
  "Grounding: report only what tool results and verified evidence actually establish; mark anything unverified as unverified.";

export const GOAL_WATCHDOG_POLICY =
  "Goal watchdog = goal-scoped fallback alerting, not the execution loop. Active goal turns it on; pause/complete/cancel/no-goal turns it off; MCP exit terminates it. It never grants permission to stop and it does not auto-resume ChatGPT Web. During normal Goal execution, do not manually run watchdog scripts; use goal actions. Operator scripts are only for explicit user-requested control or debugging.";

export const GOAL_CONTINUATION_CONTRACT =
  "GoalRun controls continuous execution. Progress is a checkpoint, not a stop condition. Follow the current state policy: continue tools while RUNNING, wait only for an explicit bounded wait or verified user-only blocker, and finalize only after every criterion is confirmed by typed evidence. launch_ack never verifies completion.";

export const GOAL_CONTINUATION_SNAPSHOT =
  "Follow the current GoalRun state. Progress is a checkpoint, not a stop condition. Continue only while RUNNING; respect bounded waits; finalize only with typed evidence. launch_ack is never completion evidence.";

export type GoalMutationOptions = { expectedRevision?: number };

function assertExpectedRevision(goal: DurableGoal, opts?: GoalMutationOptions): void {
  if (opts?.expectedRevision === undefined) return;
  if (opts.expectedRevision !== goal.revision) {
    throw new Error(
      `GOAL_STALE_REVISION: goal revision is ${goal.revision}, but ${opts.expectedRevision} was supplied. Re-read the goal (action=status) and retry with the current revision.`
    );
  }
}

// Goal mutations are read-modify-write on a single file; serialize them per
// workspace so concurrent MCP calls cannot lose updates. No nesting: public
// wrappers take the lock, setGoalStatus (private) assumes it is held.
const goalChains = new Map<string, Promise<void>>();

function goalWorkspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}

async function withGoalLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = goalWorkspaceKey(workspaceRoot);
  const previous = goalChains.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.catch(() => undefined).then(() => gate);
  goalChains.set(key, chain);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (goalChains.get(key) === chain) goalChains.delete(key);
  }
}

export interface GoalSummary {
  goal_id: string;
  objective: string;
  status: GoalStatus;
  current_phase: string;
  criteria_passed: number;
  criteria_total: number;
  remaining_criteria: string[];
  constraints: string[];
  owner_session?: string;
  execution_mode: "continuous";
  continuation_contract: string;
  execution_policy: {
    progress_messages: "checkpoint_only";
    user_reply: "until_DELIVERABLE_READY_or_verified_blocker";
    supersedes_generic_progress_rules: true;
  };
  watchdog_policy: {
    mode: "goal_scoped";
    lifecycle: "managed_by_goal";
    role: "fallback_alert_only";
    manual_control: "operator_only";
    auto_resume_web: false;
  };
  updated_at: string;
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

// Session isolation: when a session id is present, the goal lives in a
// per-session shard so concurrent ChatGPT windows never supersede each other.
// The workspace-global goal.json remains the compatibility/discovery
// projection for session-less clients and cross-turn continuation.
function goalShardDir(workspaceRoot: string, sessionId?: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const projectDir = path.join(base, "projects", projectSlug(workspaceRoot));
  return sessionId ? path.join(projectDir, "sessions", sessionId) : projectDir;
}

function goalPath(workspaceRoot: string, sessionId?: string): string {
  return path.join(goalShardDir(workspaceRoot, sessionId), "goal.json");
}

// Sanitize a session id for safe use as a single path segment.
function sessionSegment(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const clean = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return clean || undefined;

}

/**
 * Persist a goal to its authoritative location plus the global projection.
 * A goal owned by a session lives in that session's shard; the workspace-global
 * goal.json is also refreshed so session-less clients and cross-turn
 * continuation keep working. Unbound (legacy) goals only write the global path.
 */
async function writeGoalState(workspaceRoot: string, goal: DurableGoal): Promise<void> {
  const shard = sessionSegment(goal.owner_session);
  if (shard) {
    await atomicWriteJson(goalPath(workspaceRoot, shard), goal);
  }
  await atomicWriteJson(goalPath(workspaceRoot), goal);
}

function cleanString(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, max);
}

// Punctuation/case-insensitive criterion identity: prevents variant names
// ("User sign-off.") from being minted as fresh criteria to bypass the
// requires_confirmation gate.
function criterionKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normalizeCriteria(input: unknown, existing: GoalCriterion[] = []): GoalCriterion[] {
  if (!Array.isArray(input)) return existing;
  const next = [...existing];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = cleanString(item.name, 300);
    if (!name) continue;
    const previous = next.find((criterion) => criterionKey(criterion.name) === criterionKey(name));
    const criterion: GoalCriterion = {
      name,
      passed: typeof item.passed === "boolean" ? item.passed : previous?.passed ?? false,
      ...(item.requires_confirmation === true || previous?.requires_confirmation
        ? { requires_confirmation: true }
        : {}),
      ...(cleanString(item.detail, 2000)
        ? { detail: cleanString(item.detail, 2000)! }
        : previous?.detail
          ? { detail: previous.detail }
          : {}),
    };
    const index = next.findIndex((candidate) => criterionKey(candidate.name) === criterionKey(name));
    if (index >= 0) next[index] = criterion;
    else next.push(criterion);
  }
  return next.slice(0, 40);
}

function normalizeConstraints(input: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(input)) return fallback;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const value = cleanString(raw, 1000);
    if (!value || seen.has(value.toLowerCase())) continue;
    values.push(value);
    seen.add(value.toLowerCase());
  }
  return values.slice(0, 24);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await fs.rename(temp, filePath);
}

async function recordGoalChange(workspaceRoot: string, operation: string, goal: DurableGoal): Promise<void> {
  const scope = await inferProjectScope(workspaceRoot, [goal.objective, goal.current_phase, ...goal.constraints]);
  await appendHarnessEventSafe(workspaceRoot, {
    type: "goal/change",
    project_roots: scope.roots,
    goal_id: goal.id,
    data: { operation, goal },
  });
}

function normalizeGoal(raw: DurableGoal): DurableGoal {
  return {
    version: 1,
    id: raw.id,
    revision: Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
    objective: cleanString(raw.objective, 4000) || raw.objective,
    success_criteria: normalizeCriteria(raw.success_criteria),
    constraints: normalizeConstraints(raw.constraints),
    status: raw.status,
    current_phase: cleanString(raw.current_phase, 2000) || "Work toward the goal",
    ...(raw.owner_session ? { owner_session: raw.owner_session } : {}),
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    ...(raw.completed_at ? { completed_at: raw.completed_at } : {}),
  };
}

/**
 * Session scoping: a goal created inside one ChatGPT conversation belongs to
 * that conversation's MCP session. Signals and gates only apply to the owning
 * session; other windows sharing this workspace are completely unaffected.
 * A goal without owner_session (legacy/unbound, e.g. created outside a
 * transport session) keeps the historical workspace-wide behavior.
 */
export function goalVisibleToSession(goal: DurableGoal, sessionId?: string): boolean {
  return !goal.owner_session || goal.owner_session === sessionId;
}

function currentSessionId(): string | undefined {
  return getRuntimeScope()?.mcpSessionId;
}

export function assertGoalAccessibleBySession(goal: DurableGoal, sessionId?: string): void {
  if (goal.owner_session && goal.owner_session !== sessionId) {
    throw new Error(
      `This goal belongs to a different ChatGPT window (session ${goal.owner_session.slice(0, 8)}…). ` +
      `Manage it from that window, or call goal(action=bind) in this window to adopt it.`
    );
  }
}

export interface GoalTakeoverCandidate {
  goal_id: string;
  status: GoalStatus;
  revision: number;
  owner_session_hint: string | null;
}

export async function getGoalTakeoverCandidate(
  workspaceRoot: string,
  targetSession?: string
): Promise<GoalTakeoverCandidate | null> {
  const global = await readGoalFile(goalPath(workspaceRoot));
  if (
    !global ||
    !global.owner_session ||
    global.owner_session === targetSession ||
    (global.status !== "active" && global.status !== "paused")
  ) {
    return null;
  }
  return {
    goal_id: global.id,
    status: global.status,
    revision: global.revision,
    owner_session_hint: `${global.owner_session.slice(0, 8)}…`,
  };
}

export function goalTakeoverToken(
  workspaceRoot: string,
  candidate: GoalTakeoverCandidate,
  targetSession: string
): string {
  return createHash("sha256")
    .update(
      [
        path.resolve(workspaceRoot),
        candidate.goal_id,
        String(candidate.revision),
        candidate.owner_session_hint ?? "",
        targetSession,
        "goal-takeover-v1",
      ].join("\0")
    )
    .digest("hex")
    .slice(0, 32);
}

export async function getGoalOwnerSession(workspaceRoot: string): Promise<string | undefined> {
  const global = await readGoalFile(goalPath(workspaceRoot));
  return global?.owner_session;
}

export function resolveGoalForSession(workspaceRoot: string, sessionId?: string): Promise<DurableGoal | null> {
  return getGoal(workspaceRoot).then((goal) => (goal && goalVisibleToSession(goal, sessionId) ? goal : null));
}

async function readGoalFile(filePath: string): Promise<DurableGoal | null> {
  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Error(`GOAL_STATE_UNREADABLE: cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const raw = JSON.parse(rawText) as DurableGoal;
    return normalizeGoal(raw);
  } catch (error) {
    throw new Error(`GOAL_STATE_UNREADABLE: invalid goal state in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve the active goal for the current runtime session.
 * Reads the per-session shard first (session isolation); falls back to the
 * workspace-global compatibility projection for session-less clients and
 * cross-turn continuation. Pass an explicit sessionId to read a specific
 * shard; omit to use the current runtime scope.
 */
export async function getGoal(workspaceRoot: string, sessionId?: string): Promise<DurableGoal | null> {
  const effective = sessionSegment(sessionId ?? currentSessionId());
  if (effective) {
    // Session shard is authoritative for this window.
    const sharded = await readGoalFile(goalPath(workspaceRoot, effective));
    if (sharded) return sharded;
    // Fall back to the global projection ONLY when it is visible to this
    // session (unbound legacy goal, or one this window owns). A global goal
    // owned by a different window must never leak into this window's context.
    const global = await readGoalFile(goalPath(workspaceRoot));
    if (global && goalVisibleToSession(global, effective)) return global;
    return null;
  }
  return readGoalFile(goalPath(workspaceRoot));
}

/**
 * Compatibility projection writer used only after GoalRun has committed an
 * authoritative transition. It never invents a new revision itself.
 */
export async function writeGoalRunProjection(
  workspaceRoot: string,
  projection: DurableGoal,
  options: { expectedCurrentRevision: number; operation?: string }
): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const current = await getGoal(workspaceRoot);
    if (!current) throw new Error("No legacy goal projection exists for this workspace.");
    assertGoalAccessibleBySession(current, currentSessionId());
    if (current.id !== projection.id) {
      throw new Error(
        `GOAL_RUN_PROJECTION_MISMATCH: current goal is ${current.id}, projection is ${projection.id}.`
      );
    }
    if (current.revision !== options.expectedCurrentRevision) {
      throw new Error(
        `GOAL_STALE_REVISION: goal revision is ${current.revision}, but ${options.expectedCurrentRevision} was expected. Re-read the goal and retry.`
      );
    }
    if (!Number.isInteger(projection.revision) || projection.revision <= current.revision) {
      throw new Error(
        `GOAL_RUN_PROJECTION_REVISION: projection revision ${projection.revision} must be newer than ${current.revision}.`
      );
    }
    // Keep unknown top-level compatibility fields. Older/newer readers may
    // attach metadata that this version does not understand; projection
    // normalization must not erase it during an authoritative GoalRun commit.
    const next = {
      ...(projection as unknown as Record<string, unknown>),
      ...normalizeGoal(projection),
    } as DurableGoal;
    await writeGoalState(workspaceRoot, next);
    notifyStateInvalidated(workspaceRoot);
    await recordGoalChange(workspaceRoot, options.operation ?? "goal-run-projection", next);
    if (next.status === "completed" && current.status !== "completed") {
      try {
        const summary = goalSummary(next);
        await appendAutoMemory(
          workspaceRoot,
          `Goal completed (${summary.criteria_passed}/${summary.criteria_total} criteria): ${summary.objective.slice(0, 200)}`
        );
      } catch {}
    }
    return next;
  });
}

export async function createGoal(
  workspaceRoot: string,
  input: {
    objective: string;
    success_criteria: GoalCriterion[];
    constraints?: string[];
    current_phase?: string;
    supersede?: boolean;
  }
): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const ownerSession = currentSessionId();
    const shard = sessionSegment(ownerSession);
    // Session sharding: each ChatGPT window owns an independent goal slot.
    // Conflict detection and supersede happen ONLY within this window's shard,
    // so a goal held by another window never blocks or gets replaced from here.
    const existing = await getGoal(workspaceRoot);
    if (existing && (existing.status === "active" || existing.status === "paused")) {
      if (input.supersede) {
        // Atomic clean replacement: never append a new task's criteria onto an
        // old goal — that is how goal state becomes a junk drawer.
        await setGoalStatus(workspaceRoot, "cancelled", "Superseded by a new goal");
      } else {
        throw new Error(
          `An active goal already exists (${existing.id}): "${existing.objective.slice(0, 120)}". ` +
          `If the user's new task continues THIS goal, update it (action=update) — do not append unrelated criteria. ` +
          `If it is a DIFFERENT task, cancel the old one first (action=cancel), or call action=create again with supersede=true for a clean replacement.`
        );
      }
    }
    const objective = cleanString(input.objective, 4000);
    if (!objective) throw new Error("Goal objective is required.");
    const criteria = normalizeCriteria(input.success_criteria);
    if (!criteria.length) throw new Error("Goal requires at least one success criterion.");
    // requires_confirmation criteria can never enter the world pre-passed —
    // the confirmation path (confirmGoalCriterion) is the only way.
    for (const criterion of criteria) {
      if (criterion.requires_confirmation) criterion.passed = false;
    }
    const now = new Date().toISOString();
    const goal: DurableGoal = {
      version: 1,
      id: randomUUID(),
      revision: 1,
      objective,
      success_criteria: criteria,
      constraints: normalizeConstraints(input.constraints),
      status: "active",
      current_phase: cleanString(input.current_phase, 2000) || "Work toward the goal",
      ...(ownerSession ? { owner_session: ownerSession } : {}),
      created_at: now,
      updated_at: now,
    };
    // Write the session shard (authoritative for this window) and the global
    // compatibility projection for session-less clients / cross-turn continuation.
    if (shard) {
      await atomicWriteJson(goalPath(workspaceRoot, shard), goal);
    }
    await atomicWriteJson(goalPath(workspaceRoot), goal);
    notifyStateInvalidated(workspaceRoot);
    await recordGoalChange(workspaceRoot, "create", goal);
    return goal;
  });
}

export async function updateGoal(
  workspaceRoot: string,
  patch: {
    objective?: string;
    success_criteria?: GoalCriterion[];
    constraints?: string[];
    current_phase?: string;
  },
  opts?: GoalMutationOptions
): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal) throw new Error("No goal exists for this workspace. Create one with goal action=create.");
    if (goal.status === "completed" || goal.status === "cancelled") {
      throw new Error(`Cannot update a ${goal.status} goal. Create a new goal instead.`);
    }
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    const next: DurableGoal = {
      ...goal,
      objective: cleanString(patch.objective, 4000) || goal.objective,
      success_criteria: patch.success_criteria ? normalizeCriteria(patch.success_criteria, goal.success_criteria) : goal.success_criteria,
      constraints: patch.constraints ? normalizeConstraints(patch.constraints) : goal.constraints,
      current_phase: cleanString(patch.current_phase, 2000) || goal.current_phase,
      revision: goal.revision + 1,
      updated_at: new Date().toISOString(),
    };
    for (const criterion of next.success_criteria) {
      const previousPassed = goal.success_criteria.find((c) => criterionKey(c.name) === criterionKey(criterion.name))?.passed ?? false;
      if (criterion.requires_confirmation && criterion.passed && !previousPassed) {
        throw new Error(`criterion "${criterion.name}" requires explicit user confirmation — use goal action=confirm instead of marking it passed`);
      }
    }
    await writeGoalState(workspaceRoot, next);
    notifyStateInvalidated(workspaceRoot);
    await recordGoalChange(workspaceRoot, "update", next);
    return next;
  });
}

// Private: caller must hold the goal lock.
async function setGoalStatus(workspaceRoot: string, status: GoalStatus, phase?: string): Promise<DurableGoal> {
  const goal = await getGoal(workspaceRoot);
  if (!goal) throw new Error("No goal exists for this workspace.");
  const now = new Date().toISOString();
  const next: DurableGoal = {
    ...goal,
    status,
    current_phase: cleanString(phase, 2000) || goal.current_phase,
    revision: goal.revision + 1,
    updated_at: now,
    ...(status === "completed" ? { completed_at: now } : {}),
  };
  if (status !== "completed") delete next.completed_at;
  await writeGoalState(workspaceRoot, next);
  notifyStateInvalidated(workspaceRoot);
  await recordGoalChange(workspaceRoot, `status:${status}`, next);
  return next;
}

export async function pauseGoal(workspaceRoot: string, phase?: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal || goal.status !== "active") throw new Error("Only an active goal can be paused.");
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    return setGoalStatus(workspaceRoot, "paused", phase);
  });
}

export async function resumeGoal(workspaceRoot: string, phase?: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal || goal.status !== "paused") throw new Error("Only a paused goal can be resumed.");
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    return setGoalStatus(workspaceRoot, "active", phase);
  });
}

export async function cancelGoal(workspaceRoot: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal || (goal.status !== "active" && goal.status !== "paused")) {
      throw new Error("Only an active or paused goal can be cancelled.");
    }
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    return setGoalStatus(workspaceRoot, "cancelled", "Cancelled");
  });
}

export async function completeGoal(workspaceRoot: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal) throw new Error("No goal exists for this workspace.");
    if (goal.status !== "active") throw new Error(`Cannot complete a ${goal.status} goal.`);
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    const remaining = goal.success_criteria.filter((criterion) => !criterion.passed);
    if (remaining.length) {
      throw new Error(
        `Cannot complete goal: ${remaining.length} success criterion/criteria remain: ${remaining.map((criterion) => criterion.name).join(", ")}. ` +
        `Keep executing toward the remaining criteria — a progress update is not a stop condition.`
      );
    }
    const completed = await setGoalStatus(workspaceRoot, "completed", "Goal complete");
    // Crystallize the outcome into cross-session memory: a fresh conversation
    // inherits what was achieved without re-reading the whole event log.
    try {
      const summary = goalSummary(completed);
      await appendAutoMemory(
        workspaceRoot,
        `Goal completed (${summary.criteria_passed}/${summary.criteria_total} criteria): ${summary.objective.slice(0, 200)}`
      );
    } catch {}
    return completed;
  });
}

/**
 * Explicit user-confirmation path for criteria declared requires_confirmation.
 * The caller relays a human confirmation; the fact is recorded as
 * user_confirmed evidence and can never be self-asserted via action=update.
 */
export async function confirmGoalCriterion(
  workspaceRoot: string,
  input: { criterion: string; detail?: string; expectedRevision?: number }
): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal) throw new Error("No goal exists for this workspace.");
    if (goal.status !== "active" && goal.status !== "paused") {
      throw new Error(`Cannot confirm criteria on a ${goal.status} goal.`);
    }
    assertExpectedRevision(goal, { expectedRevision: input.expectedRevision });
    const index = goal.success_criteria.findIndex((c) => criterionKey(c.name) === criterionKey(input.criterion));
    if (index < 0) throw new Error(`Unknown criterion "${input.criterion}".`);
    const criterion = goal.success_criteria[index];
    if (!criterion.requires_confirmation) {
      throw new Error(`Criterion "${criterion.name}" is not marked requires_confirmation; update it with action=update instead.`);
    }
    if (criterion.passed) throw new Error(`Criterion "${criterion.name}" is already confirmed.`);
    assertGoalAccessibleBySession(goal, currentSessionId());
    const detail = cleanString(input.detail, 2000);
    const next: DurableGoal = {
      ...goal,
      success_criteria: goal.success_criteria.map((c, i) =>
        i === index
          ? { ...c, passed: true, ...(detail ? { detail } : {}) }
          : c
      ),
      revision: goal.revision + 1,
      updated_at: new Date().toISOString(),
    };
    await writeGoalState(workspaceRoot, next);
    notifyStateInvalidated(workspaceRoot);
    await recordGoalChange(workspaceRoot, "confirm", next);
    const scope = await inferProjectScope(workspaceRoot, [next.objective, next.current_phase, ...next.constraints]);
    await appendHarnessEventSafe(workspaceRoot, {
      type: "evidence/recorded",
      project_roots: scope.roots,
      goal_id: next.id,
      evidence_kind: "user_confirmed",
      data: { criterion: criterion.name, source_tool: "goal", ...(detail ? { summary: detail } : {}) },
    });
    return next;
  });
}

/**
 * Cross-session adoption: a NEW ChatGPT conversation (new MCP session) binds
 * the existing goal to itself, moving the continuation signals and gates into
 * that window. Requires this window's session id; bumps revision. This low-level
 * store helper only mutates Goal state; the public `goal(action=bind)` tool
 * preflights and migrates the paired session-scoped durable task around it.
 */
export async function bindGoalToSession(workspaceRoot: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const sessionId = currentSessionId();
    if (!sessionId) throw new Error("goal(action=bind) requires a ChatGPT session context (none available).");
    // Bind is an explicit cross-window adoption: it must read the global
    // projection (the cross-turn continuation carrier) regardless of which
    // window owns it — the per-session visibility filter would otherwise hide
    // the very goal this window is trying to take over.
    const goal = await readGoalFile(goalPath(workspaceRoot));
    const destinationShard = sessionSegment(sessionId);
    const destinationGoal = destinationShard
      ? await readGoalFile(goalPath(workspaceRoot, destinationShard))
      : null;
    if (destinationGoal) {
      throw new Error(
        "This window already owns a goal. Complete or cancel it before taking over another window's goal."
      );
    }
    if (!goal || (goal.status !== "active" && goal.status !== "paused")) {
      throw new Error("No active or paused goal to bind in this workspace.");
    }
    if (goal.owner_session === sessionId) {
      throw new Error("Goal is already bound to this window.");
    }
    assertExpectedRevision(goal, opts);
    const previousShard = sessionSegment(goal.owner_session);
    const next: DurableGoal = {
      ...goal,
      owner_session: sessionId,
      revision: goal.revision + 1,
      updated_at: new Date().toISOString(),
    };
    await writeGoalState(workspaceRoot, next);
    // Remove the previous owner's shard so that window goes silent after the
    // handover instead of keeping a stale copy of the adopted goal.
    if (previousShard && previousShard !== sessionSegment(sessionId)) {
      await fs.rm(goalPath(workspaceRoot, previousShard), { force: true }).catch(() => {});
    }
    notifyStateInvalidated(workspaceRoot);
    await recordGoalChange(workspaceRoot, "bind", next);
    return next;
  });
}

export function goalSummary(goal: DurableGoal): GoalSummary {
  const remaining = goal.success_criteria.filter((criterion) => !criterion.passed);
  return {
    goal_id: goal.id,
    objective: goal.objective,
    status: goal.status,
    current_phase: goal.current_phase,
    criteria_passed: goal.success_criteria.length - remaining.length,
    criteria_total: goal.success_criteria.length,
    remaining_criteria: remaining.map((criterion) => criterion.name),
    constraints: goal.constraints,
    owner_session: goal.owner_session,
    execution_mode: "continuous",
    execution_policy: {
      progress_messages: "checkpoint_only",
      user_reply: "until_DELIVERABLE_READY_or_verified_blocker",
      supersedes_generic_progress_rules: true,
    },
    watchdog_policy: {
      mode: "goal_scoped",
      lifecycle: "managed_by_goal",
      role: "fallback_alert_only",
      manual_control: "operator_only",
      auto_resume_web: false,
    },
    continuation_contract: GOAL_CONTINUATION_CONTRACT,
    updated_at: goal.updated_at,
  };
}

export async function formatActiveGoalForInstructions(workspaceRoot: string): Promise<string> {
  const goal = await getGoal(workspaceRoot);
  if (!goal || goal.status !== "active") return "";
  const criteria = goal.success_criteria
    .map((criterion) => `- [${criterion.passed ? "x" : " "}] ${criterion.name}${criterion.detail ? ` — ${criterion.detail}` : ""}`)
    .join("\n");
  const constraints = goal.constraints.length
    ? `\nConstraints:\n${goal.constraints.map((constraint) => `- ${constraint}`).join("\n")}`
    : "";
  return [
    "## ACTIVE GOAL",
    `Execution contract: ${GOAL_CONTINUATION_CONTRACT}`,
    `Watchdog policy: ${GOAL_WATCHDOG_POLICY}`,
    `Objective: ${goal.objective}`,
    `Current phase: ${goal.current_phase}`,
    "Success criteria:",
    criteria,
    constraints,
    "Goal rules: keep executing unless the continuation contract permits yielding; normal agent execution must use goal actions rather than watchdog scripts.",
  ].filter(Boolean).join("\n");
}

export async function assertGoalAllowsTaskCompletion(workspaceRoot: string): Promise<void> {
  const sessionId = getRuntimeScope()?.mcpSessionId;
  const goal = await getGoal(workspaceRoot);
  if (!goal || goal.status !== "active" || !goalVisibleToSession(goal, sessionId)) return;
  const remaining = goal.success_criteria.filter((criterion) => !criterion.passed);
  if (remaining.length) {
    throw new Error(
      `Cannot complete task: active goal has ${remaining.length} unmet success criterion/criteria: ${remaining.map((criterion) => criterion.name).join(", ")}. ` +
      `Keep executing toward the remaining criteria — a progress update is not a stop condition.`
    );
  }
  throw new Error("Cannot complete task: active goal criteria are satisfied but the goal is still active. Call goal action=complete first.");
}
