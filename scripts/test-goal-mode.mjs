import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "goal-mode");
const workspace = path.join(tmpRoot, "workspace");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
process.env.CHATGPT_TOOL_PROFILE = "slim";

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });

const {
  completeGoal,
  confirmGoalCriterion,
  createGoal,
  formatActiveGoalForInstructions,
  getGoal,
  GOAL_CONTINUATION_CONTRACT,
  pauseGoal,
  resumeGoal,
  updateGoal,
} = await import("../dist/lib/goals.js");
const { createDurableTask, completeDurableTask } = await import("../dist/lib/durable-tasks.js");
const { buildInstructionContext } = await import("../dist/lib/instruction-context.js");
const { buildHarnessRuntimeContext, formatHarnessRuntimeContext } = await import("../dist/lib/context-broker.js");

try {
  const created = await createGoal(workspace, {
    objective: "Ship a reliable Goal Mode V1",
    success_criteria: [
      { name: "implementation complete", passed: false },
      { name: "tests pass", passed: false },
    ],
    constraints: ["Keep task_state as the execution log"],
    current_phase: "Implement core state",
  });
  if (created.status !== "active" || created.success_criteria.length !== 2) throw new Error("goal create failed");

  const persisted = await getGoal(workspace);
  if (persisted?.id !== created.id) throw new Error("goal did not persist");

  const instructions = await formatActiveGoalForInstructions(workspace);
  if (!instructions.includes("## ACTIVE GOAL") || !instructions.includes(created.objective)) throw new Error("active goal instructions missing");
  if (!instructions.includes(GOAL_CONTINUATION_CONTRACT) || !instructions.includes("checkpoint, not a stop condition")) {
    throw new Error("active goal instructions missing continuous-execution contract");
  }

  const context = await buildInstructionContext({ workspaceRoot: workspace, workspaceRoots: [workspace], pid: process.pid, adminPort: 0 });
  if (!context.instructionsText.includes("ACTIVE GOAL") || !context.instructionsText.includes(created.objective)) {
    throw new Error("instruction context did not inject active goal");
  }

  const summary = (await import("../dist/lib/goals.js")).goalSummary(created);
  if (summary.execution_mode !== "continuous" || summary.continuation_contract !== GOAL_CONTINUATION_CONTRACT) {
    throw new Error("goal summary missing structured continuous-execution contract");
  }

  const brokerContext = await buildHarnessRuntimeContext(workspace, workspace);
  const brokerText = formatHarnessRuntimeContext(brokerContext);
  if (!brokerText.includes("GOAL CONTINUATION CONTRACT") || !brokerText.includes("checkpoint, not a stop condition")) {
    throw new Error("Context Broker V2 missing continuous-execution contract");
  }

  await pauseGoal(workspace, "Waiting for user");
  await resumeGoal(workspace, "Continue implementation");

  const task = await createDurableTask(workspace, {
    goal: "Goal-mode completion gate fixture",
    blocking_checks: [{ name: "task check", passed: true }],
  });

  let unmetBlocked = false;
  try {
    await completeDurableTask(workspace, task.id);
  } catch (error) {
    unmetBlocked = String(error).includes("unmet success criterion");
  }
  if (!unmetBlocked) throw new Error("task completion ignored unmet goal criteria");

  await updateGoal(workspace, {
    success_criteria: [
      { name: "implementation complete", passed: true },
      { name: "tests pass", passed: true },
    ],
    current_phase: "Ready to finish",
  });

  let activeBlocked = false;
  try {
    await completeDurableTask(workspace, task.id);
  } catch (error) {
    activeBlocked = String(error).includes("goal is still active");
  }
  if (!activeBlocked) throw new Error("task completion did not require explicit goal completion");

  const completedGoal = await completeGoal(workspace);
  if (completedGoal.status !== "completed" || !completedGoal.completed_at) throw new Error("goal did not complete");

  const completedTask = await completeDurableTask(workspace, task.id);
  if (completedTask.status !== "completed") throw new Error("task did not complete after goal completion");

  // --- Stage 4: revision CAS, requires_confirmation, user_confirmed evidence ---
  const wsCAS = path.join(tmpRoot, "ws-cas");
  await fs.mkdir(wsCAS, { recursive: true });
  const casGoal = await createGoal(wsCAS, {
    objective: "CAS and confirmation probe",
    success_criteria: [
      { name: "free criterion", passed: false },
      { name: "human sign-off", passed: false, requires_confirmation: true },
    ],
  });
  if (casGoal.revision !== 1) throw new Error("new goal must start at revision 1");

  let staleRejected = false;
  try {
    await updateGoal(wsCAS, { current_phase: "bump" }, { expectedRevision: casGoal.revision + 5 });
  } catch (error) {
    staleRejected = String(error).includes("GOAL_STALE_REVISION");
  }
  if (!staleRejected) throw new Error("stale goal revision must be rejected");

  const bumped = await updateGoal(wsCAS, { current_phase: "bump" }, { expectedRevision: casGoal.revision });
  if (bumped.revision !== casGoal.revision + 1) throw new Error("goal revision must increment on mutation");

  let confirmBypassRejected = false;
  try {
    await updateGoal(wsCAS, { success_criteria: [{ name: "human sign-off", passed: true }] });
  } catch (error) {
    confirmBypassRejected = String(error).includes("requires explicit user confirmation");
  }
  if (!confirmBypassRejected) throw new Error("requires_confirmation criterion must reject self-asserted pass");

  const confirmed = await confirmGoalCriterion(wsCAS, { criterion: "human sign-off", detail: "user said ok in chat" });
  if (!confirmed.success_criteria.find((c) => c.name === "human sign-off")?.passed) {
    throw new Error("confirm must pass the criterion");
  }

  await updateGoal(wsCAS, { success_criteria: [{ name: "free criterion", passed: true }] });
  const casDone = await completeGoal(wsCAS);
  if (casDone.status !== "completed") throw new Error("CAS goal did not complete");

  const { readHarnessEvents } = await import("../dist/lib/harness-events.js");
  const casEvidence = await readHarnessEvents(wsCAS, { type: "evidence/recorded", limit: 10 });
  if (!casEvidence.some((event) => event.evidence_kind === "user_confirmed" && event.data?.criterion === "human sign-off")) {
    throw new Error("user_confirmed evidence event missing");
  }

  // --- Supersede: a different new task must get a CLEAN goal, never append ---
  const wsSuper = path.join(tmpRoot, "ws-supersede");
  await fs.mkdir(wsSuper, { recursive: true });
  const oldGoal = await createGoal(wsSuper, {
    objective: "old unrelated task goal",
    success_criteria: [{ name: "old criterion", passed: true }],
  });
  let existsRejected = false;
  try {
    await createGoal(wsSuper, { objective: "new unrelated task", success_criteria: [{ name: "new criterion", passed: false }] });
  } catch (error) {
    existsRejected = String(error).includes("DIFFERENT task") && String(error).includes("supersede=true");
  }
  if (!existsRejected) throw new Error("goal-exists rejection must offer the supersede path");

  const newGoal = await createGoal(wsSuper, {
    objective: "new unrelated task",
    success_criteria: [{ name: "new criterion", passed: false }],
    supersede: true,
  });
  if (newGoal.id === oldGoal.id) throw new Error("supersede must mint a fresh goal id");
  if (newGoal.success_criteria.length !== 1 || newGoal.success_criteria[0].name !== "new criterion") {
    throw new Error("superseded goal must be clean — no inherited criteria");
  }
  const superEvents = await readHarnessEvents(wsSuper, { type: "goal/change", limit: 20 });
  if (!superEvents.some((event) => event.goal_id === oldGoal.id && event.data?.operation === "status:cancelled")) {
    throw new Error("supersede must cancel the old goal via event");
  }
  const policy = (await import("../dist/lib/goals.js")).goalSummary(newGoal).execution_policy;
  if (policy.progress_messages !== "checkpoint_only" || policy.user_reply !== "until_DELIVERABLE_READY_or_verified_blocker") {
    throw new Error("goal summary missing execution_policy");
  }

  console.log("goal-mode: persistence, session instructions, pause/resume, criteria gate, explicit completion, revision CAS, user confirmation, and supersede OK");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}