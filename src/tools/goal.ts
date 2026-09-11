import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import {
  getActiveTaskId,
  getDurableTask,
  runWithActiveDurableTaskSessionRebind,
  updateDurableTask,
} from "../lib/durable-tasks.js";
import { startGoalWatchdog, stopGoalWatchdog } from "../lib/goal-watchdog.js";
import {
  createGoal,
  getGoal,
  GOAL_CONTINUATION_CONTRACT,
  GOAL_GROUNDING_NOTE,
  GOAL_WATCHDOG_POLICY,
  bindGoalToSession,
  getGoalTakeoverCandidate,
  getGoalOwnerSession,
  goalVisibleToSession,
  goalSummary,
  goalTakeoverToken,
} from "../lib/goals.js";
import {
  confirmGoalRunCriterion,
  ensureGoalRunAuthority,
  synchronizeCommittedLegacyGoal,
  transitionGoalRunLifecycle,
  updateGoalRunDefinition,
} from "../lib/goal-run-web.js";
import { renderGoalRunPolicyText } from "../lib/goal-run-policy.js";
import type { GoalRunEnvelope } from "../lib/goal-run-store.js";
import { getRuntimeScope } from "../lib/runtime-scope.js";

const actionSchema = z.enum(["create", "status", "update", "confirm", "bind", "pause", "resume", "complete", "cancel"]);

// A superseded/cancelled goal must not leave its durable task steering the
// broker snapshot toward the old objective. Returns whether the cleanup ran —
// a silent failure here would ship the new goal with the old task still active.
async function cancelStaleDurableTask(workspaceRoot: string, reason: string): Promise<boolean> {
  try {
    const taskId = await getActiveTaskId(workspaceRoot, getRuntimeScope()?.mcpSessionId);
    if (!taskId) return true;
    const task = await getDurableTask(workspaceRoot, taskId);
    if (task.status === "active" || task.status === "blocked") {
      await updateDurableTask(workspaceRoot, taskId, { status: "cancelled", current_step: reason });
    }
    return true;
  } catch (error) {
    console.warn(`[goal] stale durable task cleanup failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

function syncGoalWatchdog(workspaceRoot: string, status: string) {
  const sessionId = getRuntimeScope()?.mcpSessionId;
  if (process.env.GOAL_WATCHDOG_ENABLED === "false") {
    return { ...stopGoalWatchdog(workspaceRoot, sessionId), disabled: true };
  }
  return status === "active"
    ? startGoalWatchdog(workspaceRoot, sessionId)
    : stopGoalWatchdog(workspaceRoot, sessionId);
}

function executionContract(envelope?: GoalRunEnvelope | null): string {
  return envelope
    ? renderGoalRunPolicyText(envelope.run, { maxBytes: 1200, maxPolicyBytes: 400 })
    : GOAL_CONTINUATION_CONTRACT;
}
const criterionSchema = z.object({
  name: z.string().min(1).max(300),
  passed: z.boolean().optional().default(false),
  detail: z.string().max(2000).optional(),
  requires_confirmation: z.boolean().optional(),
  verification: z.object({
    kind: z.enum(["command", "visual", "file_exists"]),
    target: z.string().min(1).max(2000).describe("Absolute test working directory, or visual/file target"),
    command: z.string().min(1).max(2000).optional().describe("Exact verification command for command checks"),
    files: z.array(z.string().min(1).max(2000)).min(1).max(128).optional().describe("Source/test files verified by the command; edits invalidate its evidence"),
  }).optional().describe("Required before machine confirmation. file_exists proves existence only; command verifies tests; visual verifies appearance."),
});

export function registerGoalTool(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "goal",
    {
      title: "Goal Mode",
      description:
        "Web goals. Active goals continue tools until completion or verified blockers. Goal actions own a fallback watchdog; never grants stop permission or Web auto-resume. Use scripts only if asked.",
      inputSchema: {
        action: actionSchema,
        objective: z.string().min(1).max(4000).optional(),
        success_criteria: z.array(criterionSchema).min(1).max(40).optional(),
        constraints: z.array(z.string().min(1).max(1000)).max(24).optional(),
        current_phase: z.string().max(2000).optional(),
        expected_revision: z.number().int().positive().optional(),
        criterion: z.string().min(1).max(300).optional(),
        evidence_ids: z.array(z.string().max(128)).max(32).optional(),
        detail: z.string().max(2000).optional(),
        supersede: z.boolean().optional(),
        takeover_token: z.string().min(16).max(128).optional(),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, objective, success_criteria, constraints, current_phase, expected_revision, criterion, evidence_ids, detail, supersede, takeover_token }) => {
      const mutationOptions = expected_revision === undefined ? undefined : { expectedRevision: expected_revision };
      try {
        if (action === "create") {
          if (!objective?.trim()) throw new Error("goal action=create requires objective");
          if (!success_criteria?.length) throw new Error("goal action=create requires at least one success criterion");
          const prePassed = success_criteria.find((candidate) => candidate.passed === true);
          if (prePassed) {
            throw new Error(
              `goal action=create cannot pre-pass criterion "${prePassed.name}"; criteria require typed evidence after the goal starts`
            );
          }
          const goal = await createGoal(workspaceRoot, {
            objective,
            success_criteria,
            constraints,
            current_phase,
            supersede,
          });
          const envelope = await ensureGoalRunAuthority(workspaceRoot, goal, {
            allowActiveSupersede: supersede === true,
          });
          let staleTaskCancelled: boolean | undefined;
          if (supersede) staleTaskCancelled = await cancelStaleDurableTask(workspaceRoot, "Cancelled together with the superseded goal");
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          return toolResult(
            "goal",
            {
              action,
              goal,
              summary: goalSummary(goal),
              ...(supersede ? { stale_task_cancelled: staleTaskCancelled ?? false } : {}),
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              goal_run: envelope.run,
              execution_contract: executionContract(envelope),
              continue_execution: true,
            },
            { summary: `goal active: ${goal.id} — continue execution` }
          );
        }

        if (action === "status") {
          let goal = await getGoal(workspaceRoot);
          const sessionId = getRuntimeScope()?.mcpSessionId;
          if (goal && !goalVisibleToSession(goal, sessionId)) {
            return toolResult(
              "goal",
              {
                action,
                goal: null,
                goal_run: null,
                summary: null,
                foreign_goal: {
                  goal_id: goal.id,
                  status: goal.status,
                  revision: goal.revision,
                  owner_session_hint: goal.owner_session ? `${goal.owner_session.slice(0, 8)}…` : null,
                  preserved: true,
                  adoption_requires: "Explicit goal(action=bind); do not bind or supersede automatically.",
                },
                watchdog_unchanged: true,
                watchdog_policy: GOAL_WATCHDOG_POLICY,
              },
              { summary: "goal belongs to another ChatGPT window and was preserved" }
            );
          }
          if (!goal && sessionId) {
            const takeoverCandidate = await getGoalTakeoverCandidate(workspaceRoot, sessionId);
            if (takeoverCandidate) {
              return toolResult(
                "goal",
                {
                  action,
                  goal: null,
                  goal_run: null,
                  summary: null,
                  takeover_candidate: takeoverCandidate,
                  takeover_confirmation_required: true,
                  watchdog: stopGoalWatchdog(workspaceRoot, sessionId),
                  watchdog_policy: GOAL_WATCHDOG_POLICY,
                },
                { summary: "another ChatGPT window owns an active goal; explicit confirmation is required to take it over" }
              );
            }
          }
          const envelope = goal ? await ensureGoalRunAuthority(workspaceRoot, goal) : null;
          if (goal && envelope) goal = (await getGoal(workspaceRoot)) ?? goal;
          const watchdog = goal ? syncGoalWatchdog(workspaceRoot, goal.status) : stopGoalWatchdog(workspaceRoot, sessionId);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: envelope?.run ?? null,
              summary: goal ? goalSummary(goal) : null,
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              ...(envelope ? { execution_contract: executionContract(envelope) } : {}),
            },
            { summary: goal ? `goal ${goal.status}: ${goal.id}` : "no goal" }
          );
        }

        if (action === "update") {
          const updated = await updateGoalRunDefinition(workspaceRoot, {
            objective,
            success_criteria,
            constraints,
            current_phase,
          }, expected_revision);
          const goal = updated.goal;
          const envelope = updated.envelope;
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          const needsWork = goal.status === "active" && goal.success_criteria.some((criterion) => !criterion.passed);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: envelope.run,
              summary: goalSummary(goal),
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              ...(needsWork
                ? { continue_execution: true, execution_contract: executionContract(envelope) }
                : {}),
            },
            { summary: needsWork ? `goal updated: ${goal.id} — continue execution` : `goal updated: ${goal.id}` }
          );
        }

        if (action === "confirm") {
          if (!criterion?.trim()) throw new Error("goal action=confirm requires criterion");
          const confirmed = await confirmGoalRunCriterion(workspaceRoot, {
            criterion,
            evidenceIds: evidence_ids,
            detail,
            expectedRevision: expected_revision,
          });
          const goal = confirmed.goal;
          const envelope = confirmed.envelope;
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          const needsWork = goal.status === "active" && goal.success_criteria.some((criterion) => !criterion.passed);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: envelope.run,
              summary: goalSummary(goal),
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              ...(needsWork
                ? { continue_execution: true, execution_contract: executionContract(envelope) }
                : {}),
            },
            { summary: needsWork ? `criterion confirmed: ${criterion} — continue execution` : `criterion confirmed: ${criterion}` }
          );
        }

        if (action === "bind") {
          const targetSession = getRuntimeScope()?.mcpSessionId;
          if (!targetSession) throw new Error("goal(action=bind) requires a ChatGPT session context (none available).");
          const takeoverCandidate = await getGoalTakeoverCandidate(workspaceRoot, targetSession);
          if (takeoverCandidate) {
            if (expected_revision !== takeoverCandidate.revision) {
              return toolResult(
                "goal",
                {
                  action,
                  error: "GOAL_TAKEOVER_REVISION_REQUIRED",
                  takeover_candidate: takeoverCandidate,
                  expected_revision_required: takeoverCandidate.revision,
                },
                { ok: false, summary: "cross-window goal takeover requires the current goal revision" }
              );
            }
            const expectedToken = goalTakeoverToken(workspaceRoot, takeoverCandidate, targetSession);
            if (takeover_token === undefined) {
              return toolResult(
                "goal",
                {
                  action,
                  error: "GOAL_TAKEOVER_CONFIRMATION_REQUIRED",
                  takeover_candidate: takeoverCandidate,
                  takeover_token: expectedToken,
                  expected_revision: takeoverCandidate.revision,
                },
                { ok: false, summary: "cross-window goal takeover requires explicit confirmation" }
              );
            }
            if (takeover_token !== expectedToken) {
              return toolResult(
                "goal",
                {
                  action,
                  error: "GOAL_TAKEOVER_TOKEN_MISMATCH",
                  takeover_candidate: takeoverCandidate,
                },
                { ok: false, summary: "cross-window goal takeover token did not match the current goal" }
              );
            }
          }
          const sourceSession = await getGoalOwnerSession(workspaceRoot);
          const rebound = await runWithActiveDurableTaskSessionRebind(
            workspaceRoot,
            sourceSession,
            targetSession,
            () => bindGoalToSession(workspaceRoot, mutationOptions)
          );
          const boundGoal = rebound.value;
          const durableTaskRebind = rebound.durable_task_rebind;
          const envelope = await synchronizeCommittedLegacyGoal(workspaceRoot, boundGoal);
          const goal = await getGoal(workspaceRoot);
          if (!goal || goal.id !== boundGoal.id) {
            throw new Error(`GOAL_BIND_PROJECTION_MISSING: synchronized goal ${boundGoal.id} is not readable after bind.`);
          }
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          const needsWork = goal.status === "active" && goal.success_criteria.some((criterion) => !criterion.passed);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: envelope.run,
              summary: goalSummary(goal),
              durable_task_rebind: durableTaskRebind,
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              ...(needsWork
                ? { continue_execution: true, execution_contract: executionContract(envelope) }
                : {}),
            },
            { summary: needsWork ? `goal bound: ${goal.id} — continue execution` : `goal bound: ${goal.id}` }
          );
        }

        if (action === "pause") {
          const paused = await transitionGoalRunLifecycle(workspaceRoot, "pause", {
            currentPhase: current_phase,
            expectedRevision: expected_revision,
          });
          const goal = paused.goal;
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          return toolResult("goal", { action, goal, goal_run: paused.envelope.run, summary: goalSummary(goal), watchdog, watchdog_policy: GOAL_WATCHDOG_POLICY }, { summary: `goal paused: ${goal.id}` });
        }

        if (action === "resume") {
          const resumed = await transitionGoalRunLifecycle(workspaceRoot, "resume", {
            currentPhase: current_phase,
            expectedRevision: expected_revision,
          });
          const goal = resumed.goal;
          const envelope = resumed.envelope;
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: envelope.run,
              summary: goalSummary(goal),
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              execution_contract: executionContract(envelope),
              continue_execution: true,
            },
            { summary: `goal active: ${goal.id} — continue execution` }
          );
        }

        if (action === "complete") {
          const completed = await transitionGoalRunLifecycle(workspaceRoot, "complete", {
            expectedRevision: expected_revision,
          });
          const goal = completed.goal;
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          return toolResult(
            "goal",
            { action, goal, goal_run: completed.envelope.run, goal_complete: true, grounding: GOAL_GROUNDING_NOTE, summary: goalSummary(goal), watchdog, watchdog_policy: GOAL_WATCHDOG_POLICY },
            { summary: `GOAL_COMPLETE ${goal.id}` }
          );
        }

        const cancelled = await transitionGoalRunLifecycle(workspaceRoot, "cancel", {
          expectedRevision: expected_revision,
        });
        const goal = cancelled.goal;
        const staleTaskCancelled = await cancelStaleDurableTask(workspaceRoot, "Cancelled together with the goal");
        const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
        return toolResult("goal", { action, goal, goal_run: cancelled.envelope.run, stale_task_cancelled: staleTaskCancelled, summary: goalSummary(goal), watchdog, watchdog_policy: GOAL_WATCHDOG_POLICY }, { summary: `goal cancelled: ${goal.id}` });
      } catch (error) {
        return toolError("goal", error instanceof Error ? error.message : String(error));
      }
    }
  );
}
