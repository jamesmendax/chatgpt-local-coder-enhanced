import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import { getActiveTaskId, getDurableTask, updateDurableTask } from "../lib/durable-tasks.js";
import {
  cancelGoal,
  completeGoal,
  confirmGoalCriterion,
  createGoal,
  getGoal,
  GOAL_CONTINUATION_CONTRACT,
  GOAL_GROUNDING_NOTE,
  goalSummary,
  pauseGoal,
  resumeGoal,
  updateGoal,
} from "../lib/goals.js";

const actionSchema = z.enum(["create", "status", "update", "confirm", "pause", "resume", "complete", "cancel"]);

// A superseded/cancelled goal must not leave its durable task steering the
// broker snapshot toward the old objective. Returns whether the cleanup ran —
// a silent failure here would ship the new goal with the old task still active.
async function cancelStaleDurableTask(workspaceRoot: string, reason: string): Promise<boolean> {
  try {
    const taskId = await getActiveTaskId(workspaceRoot);
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
const criterionSchema = z.object({
  name: z.string().min(1).max(300),
  passed: z.boolean().optional().default(false),
  detail: z.string().max(2000).optional(),
  requires_confirmation: z.boolean().optional(),
});

export function registerGoalTool(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "goal",
    {
      title: "Goal Mode",
      description:
        "Create/manage persistent goals. Active goals require continuous execution: keep working after create/resume, yield only for blockers or pause/cancel, and complete goal then task before DELIVERABLE_READY.",
      inputSchema: {
        action: actionSchema,
        objective: z.string().min(1).max(4000).optional(),
        success_criteria: z.array(criterionSchema).min(1).max(40).optional(),
        constraints: z.array(z.string().min(1).max(1000)).max(24).optional(),
        current_phase: z.string().max(2000).optional(),
        expected_revision: z.number().int().positive().optional().describe("CAS guard against stale goal state"),
        criterion: z.string().min(1).max(300).optional().describe("Criterion name for action=confirm"),
        detail: z.string().max(2000).optional(),
        supersede: z.boolean().optional().describe("create only: cancel the existing active goal and make a clean replacement"),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, objective, success_criteria, constraints, current_phase, expected_revision, criterion, detail, supersede }) => {
      const mutationOptions = expected_revision === undefined ? undefined : { expectedRevision: expected_revision };
      try {
        if (action === "create") {
          if (!objective?.trim()) throw new Error("goal action=create requires objective");
          if (!success_criteria?.length) throw new Error("goal action=create requires at least one success criterion");
          const goal = await createGoal(workspaceRoot, {
            objective,
            success_criteria,
            constraints,
            current_phase,
            supersede,
          });
          let staleTaskCancelled: boolean | undefined;
          if (supersede) staleTaskCancelled = await cancelStaleDurableTask(workspaceRoot, "Cancelled together with the superseded goal");
          return toolResult(
            "goal",
            {
              action,
              goal,
              summary: goalSummary(goal),
              ...(supersede ? { stale_task_cancelled: staleTaskCancelled ?? false } : {}),
              execution_contract: GOAL_CONTINUATION_CONTRACT,
              continue_execution: true,
            },
            { summary: `goal active: ${goal.id} — continue execution` }
          );
        }

        if (action === "status") {
          const goal = await getGoal(workspaceRoot);
          return toolResult(
            "goal",
            { action, goal, summary: goal ? goalSummary(goal) : null },
            { summary: goal ? `goal ${goal.status}: ${goal.id}` : "no goal" }
          );
        }

        if (action === "update") {
          const goal = await updateGoal(workspaceRoot, {
            objective,
            success_criteria,
            constraints,
            current_phase,
          }, mutationOptions);
          const needsWork = goal.status === "active" && goal.success_criteria.some((criterion) => !criterion.passed);
          return toolResult(
            "goal",
            {
              action,
              goal,
              summary: goalSummary(goal),
              ...(needsWork
                ? { continue_execution: true, execution_contract: GOAL_CONTINUATION_CONTRACT }
                : {}),
            },
            { summary: needsWork ? `goal updated: ${goal.id} — continue execution` : `goal updated: ${goal.id}` }
          );
        }

        if (action === "confirm") {
          if (!criterion?.trim()) throw new Error("goal action=confirm requires criterion");
          const goal = await confirmGoalCriterion(workspaceRoot, {
            criterion,
            detail,
            expectedRevision: expected_revision,
          });
          const needsWork = goal.status === "active" && goal.success_criteria.some((criterion) => !criterion.passed);
          return toolResult(
            "goal",
            {
              action,
              goal,
              summary: goalSummary(goal),
              ...(needsWork
                ? { continue_execution: true, execution_contract: GOAL_CONTINUATION_CONTRACT }
                : {}),
            },
            { summary: needsWork ? `criterion confirmed: ${criterion} — continue execution` : `criterion confirmed: ${criterion}` }
          );
        }

        if (action === "pause") {
          const goal = await pauseGoal(workspaceRoot, current_phase, mutationOptions);
          return toolResult("goal", { action, goal, summary: goalSummary(goal) }, { summary: `goal paused: ${goal.id}` });
        }

        if (action === "resume") {
          const goal = await resumeGoal(workspaceRoot, current_phase, mutationOptions);
          return toolResult(
            "goal",
            {
              action,
              goal,
              summary: goalSummary(goal),
              execution_contract: GOAL_CONTINUATION_CONTRACT,
              continue_execution: true,
            },
            { summary: `goal active: ${goal.id} — continue execution` }
          );
        }

        if (action === "complete") {
          const goal = await completeGoal(workspaceRoot, mutationOptions);
          return toolResult(
            "goal",
            { action, goal, goal_complete: true, grounding: GOAL_GROUNDING_NOTE, summary: goalSummary(goal) },
            { summary: `GOAL_COMPLETE ${goal.id}` }
          );
        }

        const goal = await cancelGoal(workspaceRoot, mutationOptions);
        const staleTaskCancelled = await cancelStaleDurableTask(workspaceRoot, "Cancelled together with the goal");
        return toolResult("goal", { action, goal, stale_task_cancelled: staleTaskCancelled, summary: goalSummary(goal) }, { summary: `goal cancelled: ${goal.id}` });
      } catch (error) {
        return toolError("goal", error instanceof Error ? error.message : String(error));
      }
    }
  );
}
