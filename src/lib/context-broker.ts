import path from "node:path";
import { getActiveTaskId, getDurableTask, taskHandoff, type TaskHandoff } from "./durable-tasks.js";
import { GOAL_CONTINUATION_CONTRACT, getGoal, goalSummary, type DurableGoal, type GoalSummary } from "./goals.js";
import { readHarnessEventTail, harnessRepairCount, type HarnessEvidenceKind } from "./harness-events.js";
import { inferProjectScope, isPathWithinRoot } from "./project-scope.js";
import { onStateInvalidated } from "./state-invalidate.js";

export interface BrokerEvidenceSummary {
  seq: number;
  time: string;
  kind: HarnessEvidenceKind;
  source_tool?: string;
  summary: string;
}

export interface HarnessRuntimeContext {
  project_root?: string;
  goal?: GoalSummary;
  task?: Pick<
    TaskHandoff,
    | "task_id"
    | "status"
    | "current_step"
    | "blockers"
    | "next_actions"
    | "changed_files"
    | "blocking_remaining"
    | "advisory_remaining"
    | "project_roots"
    | "project_scope_locked"
    | "blocked"
  >;
  recent_evidence: BrokerEvidenceSummary[];
}

/**
 * Context Broker V2 (ported from DeepSeek Harness RuntimeContextProjection):
 * dynamic context is delivered as a superseding snapshot and only when the
 * snapshot actually changes (whole-text equality) or after a refresh interval.
 * Unchanged state costs zero tokens per tool call; a periodic refresh keeps
 * long conversations and new ChatGPT conversations informed.
 */

const SUPERSEDE_HEADER = "This harness context supersedes earlier harness context snapshots.";
const CLEARED_TEXT = `${SUPERSEDE_HEADER}\nHARNESS CONTEXT\nNo active goal or task.`;
const CONTEXT_BUDGET_CHARS = 1800;
const EVIDENCE_WINDOW = 24;

// Tools whose own results already carry state: no text snapshot, structured as before.
const SKIP_TEXT_FOR: ReadonlySet<string> = new Set([
  "goal",
  "task_state",
  "project_context",
  "agent_status",
  "list_skills",
  "load_skill",
  "remember",
]);

// These skip tools carry their own continuation signal in-band; every other
// skip tool still gets the always-on continuation tail.
const SELF_SIGNALING_TOOLS: ReadonlySet<string> = new Set(["goal", "task_state"]);

const TAIL_ESCALATION_AFTER = 12;

function continuationTail(context: HarnessRuntimeContext, streak: number): string {
  const goal = context.goal!;
  const remaining = goal.remaining_criteria;
  const counter = `GOAL ${goal.criteria_passed}/${goal.criteria_total} — ${remaining.length ? "NOT DONE." : "ALL CRITERIA PASS."} MUST_CONTINUE_TO_TOOL. Expect no user reply until DELIVERABLE_READY or a verified blocker; this goal supersedes any "report progress every N calls" rule (progress = checkpoints).`;
  // All-passed limbo: the model said "done" but never ran the finish chain —
  // without this branch the goal would stay active forever with zero signal.
  if (remaining.length === 0) {
    if (streak >= TAIL_ESCALATION_AFTER) {
      return `${counter} The finish chain is still pending — call goal(action=complete) now, then task_state(action=complete). Do not narrate.`;
    }
    return `${counter} Your next action MUST be goal(action=complete), then task_state(action=complete) for DELIVERABLE_READY. Do not end the turn before the finish chain completes.`;
  }
  const next = truncateForSnapshot(remaining[0], 120);
  if (streak >= TAIL_ESCALATION_AFTER) {
    return (
      `${counter} Unchanged for ${streak} results — either call a tool that advances "${next}", ` +
      `or pass it via goal(action=update) only with supporting evidence; do not narrate progress and do not ask permission for the next phase.`
    );
  }
  return (
    `${counter} Your next action must be a tool call advancing: ${next}. ` +
    `Progress updates, plans, and "shall I continue?" are forbidden turn endings. ` +
    `Genuinely blocked? task_state checkpoint with blocked_reason, then yield — otherwise continue.`
  );
}

interface CoreState {
  goal: DurableGoal | null;
  task: Awaited<ReturnType<typeof getDurableTask>> | null;
  activeTaskId: string | null;
}

function workspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => isPathWithinRoot(a, b) || isPathWithinRoot(b, a)));
}

function cleanSummary(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : fallback;
}

function stateCacheTtlMs(): number {
  const parsed = Number.parseInt(process.env.HARNESS_STATE_CACHE_TTL_MS || "2000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
}

function snapshotRefreshMs(): number {
  const parsed = Number.parseInt(process.env.HARNESS_CONTEXT_REFRESH_MS || "300000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300000;
}

async function loadCoreState(workspaceRoot: string): Promise<CoreState> {
  const [goal, activeTaskId] = await Promise.all([getGoal(workspaceRoot), getActiveTaskId(workspaceRoot)]);
  let task: CoreState["task"] = null;
  if (activeTaskId) {
    try {
      task = await getDurableTask(workspaceRoot, activeTaskId);
    } catch {}
  }
  return { goal, task, activeTaskId };
}

const coreStateCache = new Map<string, { expires: number; promise: Promise<CoreState> }>();

// Goal/task mutations drop the cache for their workspace immediately; the TTL
// only bounds staleness from external file edits.
onStateInvalidated((workspaceRoot) => {
  coreStateCache.delete(workspaceKey(workspaceRoot));
});

function getCachedCoreState(workspaceRoot: string): Promise<CoreState> {
  const key = workspaceKey(workspaceRoot);
  const now = Date.now();
  const cached = coreStateCache.get(key);
  if (cached && cached.expires > now) return cached.promise;
  const promise = loadCoreState(workspaceRoot);
  coreStateCache.set(key, { expires: now + stateCacheTtlMs(), promise });
  void promise.catch(() => coreStateCache.delete(key));
  return promise;
}

interface EvidenceWindowItem extends BrokerEvidenceSummary {
  task_id?: string;
  project_roots?: string[];
}

interface EvidenceWindow {
  items: EvidenceWindowItem[];
  offset: number;
  repairs: number;
}

const evidenceWindows = new Map<string, EvidenceWindow>();

async function refreshEvidenceWindow(workspaceRoot: string): Promise<EvidenceWindowItem[]> {
  const key = workspaceKey(workspaceRoot);
  const generation = harnessRepairCount(workspaceRoot);
  const win = evidenceWindows.get(key) ?? { items: [], offset: 0, repairs: generation };
  if (win.repairs !== generation) {
    // The log was rewritten (migration/repair/quarantine): byte offsets no
    // longer mean anything — rescan from the start.
    win.items = [];
    win.offset = 0;
    win.repairs = generation;
  }
  try {
    const tail = await readHarnessEventTail(workspaceRoot, win.offset);
    if (tail.reset) win.items = [];
    for (const event of tail.events) {
      if (event.type !== "evidence/recorded" || !event.evidence_kind) continue;
      win.items.push({
        seq: event.seq,
        time: event.time,
        kind: event.evidence_kind,
        ...(typeof event.data.source_tool === "string" ? { source_tool: event.data.source_tool } : {}),
        summary: cleanSummary(event.data.summary, event.type),
        ...(event.task_id ? { task_id: event.task_id } : {}),
        ...(event.project_roots?.length ? { project_roots: event.project_roots } : {}),
      });
    }
    win.offset = tail.next_offset;
    if (win.items.length > EVIDENCE_WINDOW) win.items = win.items.slice(-EVIDENCE_WINDOW);
    evidenceWindows.set(key, win);
  } catch {
    // Evidence is advisory; a failed incremental read keeps the last window.
  }
  return win.items;
}

export async function buildHarnessRuntimeContext(
  workspaceRoot: string,
  projectRoot?: string
): Promise<HarnessRuntimeContext> {
  const resolvedProject = projectRoot ? path.resolve(projectRoot) : undefined;
  const core = await getCachedCoreState(workspaceRoot);

  let taskContext: HarnessRuntimeContext["task"];
  let taskId: string | undefined;
  let taskRoots: string[] = [];
  if (core.task) {
    if (!resolvedProject || scopesOverlap(core.task.project_roots, [resolvedProject])) {
      const handoff = taskHandoff(core.task);
      taskId = core.task.id;
      taskRoots = core.task.project_roots;
      taskContext = {
        task_id: handoff.task_id,
        status: handoff.status,
        current_step: handoff.current_step,
        blockers: handoff.blockers,
        next_actions: handoff.next_actions,
        changed_files: handoff.changed_files,
        blocking_remaining: handoff.blocking_remaining,
        advisory_remaining: handoff.advisory_remaining,
        project_roots: handoff.project_roots,
        project_scope_locked: handoff.project_scope_locked,
        ...(handoff.blocked ? { blocked: handoff.blocked } : {}),
      };
    }
  }

  let goalContext: GoalSummary | undefined;
  if (core.goal) {
    const scope = await inferProjectScope(workspaceRoot, [core.goal.objective, core.goal.current_phase, ...core.goal.constraints]);
    if (!resolvedProject || scopesOverlap(scope.roots, [resolvedProject])) goalContext = goalSummary(core.goal);
  }

  const projectForEvidence = resolvedProject ?? taskRoots[0];
  const windowItems = await refreshEvidenceWindow(workspaceRoot);
  const recentEvidence = windowItems
    .filter((item) => !taskId || item.task_id === taskId)
    .filter((item) => !projectForEvidence || scopesOverlap(item.project_roots ?? [], [projectForEvidence]))
    .slice(-5)
    .map(({ task_id: _taskId, project_roots: _roots, ...summary }) => summary);

  return {
    ...(resolvedProject ? { project_root: resolvedProject } : {}),
    ...(goalContext ? { goal: goalContext } : {}),
    ...(taskContext ? { task: taskContext } : {}),
    recent_evidence: recentEvidence,
  };
}

interface RenderLimits {
  evidence: number;
  nextActions: number;
  remaining: number;
}

const RENDER_LADDER: RenderLimits[] = [
  { evidence: 3, nextActions: 3, remaining: 5 },
  { evidence: 2, nextActions: 2, remaining: 3 },
  { evidence: 1, nextActions: 1, remaining: 2 },
  { evidence: 0, nextActions: 1, remaining: 0 },
];

function renderSnapshot(context: HarnessRuntimeContext, limits: RenderLimits): string {
  const lines: string[] = [];
  // Goal block renders BEFORE the task block: head-preserving truncation must
  // never be able to cut the continuation contract or the goal state away.
  if (context.goal) {
    if (context.goal.status === "active") lines.push(`GOAL CONTINUATION CONTRACT: ${GOAL_CONTINUATION_CONTRACT}`);
    lines.push(`ACTIVE GOAL: ${truncateForSnapshot(context.goal.objective, 300)}`);
    lines.push(`Phase: ${truncateForSnapshot(context.goal.current_phase, 200)} | status: ${context.goal.status}`);
    lines.push(`Success criteria: ${context.goal.criteria_passed}/${context.goal.criteria_total} passed`);
    // Never render an empty remaining list as "none": with unmet criteria that
    // would read as a false all-clear and invite premature completion claims.
    const remaining = context.goal.remaining_criteria.slice(0, limits.remaining);
    if (remaining.length) lines.push(`Remaining: ${remaining.map((name) => truncateForSnapshot(name, 160)).join("; ")}`);
  }
  if (context.task) {
    lines.push(`Task: ${context.task.task_id} (${context.task.status})`);
    lines.push(`Step: ${truncateForSnapshot(context.task.current_step, 200)}`);
    lines.push(`Blocking checks remaining: ${context.task.blocking_remaining}`);
    if (context.task.blockers.length) {
      lines.push(`Blockers: ${context.task.blockers.slice(-3).map((blocker) => truncateForSnapshot(blocker, 160)).join("; ")}`);
    }
    if (context.task.blocked) lines.push(`Blocked: [${context.task.blocked.code}] ${truncateForSnapshot(context.task.blocked.message, 200)}`);
    if (context.task.next_actions.length) {
      lines.push(`Next: ${context.task.next_actions.slice(0, limits.nextActions).map((action) => truncateForSnapshot(action, 160)).join("; ")}`);
    }
  }
  if (limits.evidence > 0 && context.recent_evidence.length) {
    lines.push("Recent evidence:");
    for (const item of context.recent_evidence.slice(-limits.evidence)) {
      lines.push(`- [${item.kind}]${item.source_tool ? ` ${item.source_tool}:` : ""} ${item.summary}`);
    }
  }
  return lines.join("\n");
}

// The continuation contract consumes ~600 of the 1800-char snapshot budget;
// without these caps a long objective/step pushes the status lines past
// hardTruncate and the snapshot loses exactly the state it exists to deliver.
function truncateForSnapshot(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function hardTruncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const omitted = text.length - budget;
  return `${text.slice(0, budget)}…(+${omitted} chars omitted)`;
}

export function formatHarnessRuntimeContext(context: HarnessRuntimeContext): string {
  const hasState = Boolean(context.goal || context.task || context.recent_evidence.length);
  if (!hasState) return CLEARED_TEXT;
  const body = ["HARNESS CONTEXT"];
  for (const limits of RENDER_LADDER) {
    const candidate = `${body.join("\n")}\n${renderSnapshot(context, limits)}`;
    const full = `${SUPERSEDE_HEADER}\n${candidate}`;
    if (full.length <= CONTEXT_BUDGET_CHARS) return full;
  }
  return hardTruncate(`${SUPERSEDE_HEADER}\n${body.join("\n")}\n${renderSnapshot(context, RENDER_LADDER[RENDER_LADDER.length - 1])}`, CONTEXT_BUDGET_CHARS);
}

interface RetainedSnapshot {
  text: string;
  at: number;
  tailStreak: number;
}

const retainedByWorkspace = new Map<string, RetainedSnapshot>();

/**
 * New MCP sessions (new/evicted/recovered ChatGPT conversations) rebuild their
 * instructions from boot-time state, so the first tool result of a fresh
 * conversation must re-deliver the snapshot even when the process-level
 * retained text is unchanged — otherwise a new chat could stay blind to the
 * goal for up to the refresh interval.
 */
export function resetHarnessSnapshotRetention(workspaceRoot: string): void {
  retainedByWorkspace.delete(workspaceKey(workspaceRoot));
}

function withStructuredHarnessContext(result: unknown, context: HarnessRuntimeContext): unknown {
  const candidate = result as { structuredContent?: Record<string, unknown> };
  const structured = candidate.structuredContent;
  const data = structured?.data;
  if (!structured || !data || typeof data !== "object" || Array.isArray(data)) return result;
  // project_context already embeds a project-scoped harness_context of its own;
  // never overwrite a scope-specific view with the workspace-wide one.
  if ("harness_context" in (data as Record<string, unknown>)) return result;
  return {
    ...(result as Record<string, unknown>),
    structuredContent: {
      ...structured,
      data: {
        ...(data as Record<string, unknown>),
        harness_context: context,
      },
    },
  };
}

function withTextEntry(result: unknown, text: string): unknown {
  const candidate = result as { content?: unknown[] };
  if (!Array.isArray(candidate.content)) return result;
  return { ...(result as Record<string, unknown>), content: [...candidate.content, { type: "text", text }] };
}

export async function appendHarnessRuntimeContextToResult(
  workspaceRoot: string,
  result: unknown,
  options: { toolName?: string } = {}
): Promise<unknown> {
  if (!result || typeof result !== "object") return result;
  const candidate = result as { content?: unknown[]; structuredContent?: Record<string, unknown> };
  const structuredData = candidate.structuredContent?.data;
  const hasStructuredData = Boolean(structuredData && typeof structuredData === "object" && !Array.isArray(structuredData));
  const toolName = options.toolName ?? "";
  const skipSnapshot = SKIP_TEXT_FOR.has(toolName);
  const selfSignaling = SELF_SIGNALING_TOOLS.has(toolName);
  const canCarryText = Array.isArray(candidate.content);
  if (!skipSnapshot && !hasStructuredData && !canCarryText) return result;

  let context: HarnessRuntimeContext;
  try {
    context = await buildHarnessRuntimeContext(workspaceRoot);
  } catch (error) {
    console.warn(`[harness-context] snapshot unavailable: ${(error as Error).message}`);
    return result;
  }

  const key = workspaceKey(workspaceRoot);
  // An active goal ALWAYS needs a signal: unmet criteria → "advance X" tail;
  // all-passed limbo → "run the finish chain" tail. Zero-signal gaps here are
  // how goals end up active forever.
  const activeNeedsWork = Boolean(context.goal?.status === "active");

  if (skipSnapshot) {
    const withStructured = hasStructuredData ? withStructuredHarnessContext(result, context) : result;
    // Skip tools skip the SNAPSHOT, not the continuation signal: ChatGPT's
    // turn-start preflight calls (agent_status/remember/…) and any turn ENDING
    // on one of them previously had no signal at the stop-decision point.
    // goal/task_state are self-signaling and stay tail-free.
    if (selfSignaling || !activeNeedsWork || !canCarryText) return withStructured;
    const retained = retainedByWorkspace.get(key) ?? { text: "", at: 0, tailStreak: 0 };
    retained.tailStreak += 1;
    retainedByWorkspace.set(key, retained);
    return withTextEntry(withStructured, continuationTail(context, retained.tailStreak));
  }

  const text = formatHarnessRuntimeContext(context);
  const retained = retainedByWorkspace.get(key);
  const cleared = text === CLEARED_TEXT;
  let inject: boolean;
  if (cleared) {
    inject = Boolean(retained && retained.text !== CLEARED_TEXT);
  } else if (!retained || retained.text !== text) {
    inject = true;
  } else {
    inject = Date.now() - retained.at > snapshotRefreshMs();
  }

  if (!inject) {
    // The full snapshot is deduped, but an active goal with unmet criteria must
    // keep a continuation signal in EVERY result: the model's stop decision
    // happens per tool call, and a gap without the signal is exactly how
    // "report progress and wait" relapses.
    if (activeNeedsWork && canCarryText) {
      const streak = (retained?.tailStreak ?? 0) + 1;
      if (retained) retained.tailStreak = streak;
      retainedByWorkspace.set(key, retained ?? { text, at: Date.now(), tailStreak: streak });
      return withTextEntry(result, continuationTail(context, streak));
    }
    return result;
  }

  const tailStreak = activeNeedsWork && canCarryText ? 1 : 0;
  retainedByWorkspace.set(key, { text, at: Date.now(), tailStreak });
  const withStructured = hasStructuredData ? withStructuredHarnessContext(result, context) : result;
  const withSnapshot = withTextEntry(withStructured, text);
  // A changed/full snapshot is informational context, not a continuation
  // command. Keep the imperative tail as the LAST model-visible text entry on
  // every ordinary tool result while a Goal is active, including reinjection
  // calls triggered by changed task/goal state. Otherwise the exact calls that
  // make progress can become silent stop points.
  return activeNeedsWork && canCarryText
    ? withTextEntry(withSnapshot, continuationTail(context, tailStreak))
    : withSnapshot;
}
