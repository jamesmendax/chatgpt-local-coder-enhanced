/**
 * Goal session-scoping tests: a goal created in one ChatGPT window (MCP
 * session) must be invisible and non-gating to every other window, and
 * adoptable via goal(action=bind).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "goal-scope");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
process.env.CHATGPT_TOOL_PROFILE = "slim";

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(tmpRoot, { recursive: true });

const WS = path.join(tmpRoot, "workspace");
await fs.mkdir(WS, { recursive: true });

const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const goals = await import("../dist/lib/goals.js");
const tasks = await import("../dist/lib/durable-tasks.js");
const broker = await import("../dist/lib/context-broker.js");

function scopeFor(sessionId) {
  return createRuntimeScope({ workspaceRoot: WS, projectRoots: [WS] }, { sessionId });
}
function asSession(sessionId, fn) {
  return runWithRuntimeScope(scopeFor(sessionId), fn);
}
function baseResult() {
  return { content: [{ type: "text", text: "base" }], structuredContent: { ok: true, tool: "fixture", summary: "fixture", data: { value: 1 } } };
}

try {
  // 1. Session A creates a goal: A's tool results carry the imperative tail.
  const goal = await asSession("session-A", () =>
    goals.createGoal(WS, { objective: "Window A goal", success_criteria: [{ name: "crit", passed: false }] })
  );
  const aResult = await asSession("session-A", () =>
    broker.appendHarnessRuntimeContextToResult(WS, baseResult(), { toolName: "fixture" })
  );
  assert.ok(
    JSON.stringify(aResult.content).includes("MUST_CONTINUE_TO_TOOL"),
    "owning session must receive the continuation tail"
  );

  // 2. Session B is completely unaffected: no tail, no snapshot goal.
  const bResult = await asSession("session-B", () =>
    broker.appendHarnessRuntimeContextToResult(WS, baseResult(), { toolName: "fixture" })
  );
  assert.ok(
    !JSON.stringify(bResult.content).includes("MUST_CONTINUE_TO_TOOL"),
    "other windows must not receive the continuation tail"
  );
  const bContext = await broker.buildHarnessRuntimeContext(WS, undefined);
  assert.ok(!bContext.goal, "other windows must not see the goal in harness context");

  // 3. Gate scoping: B's task completion is not blocked by A's goal…
  const bTask = await asSession("session-B", () =>
    tasks.createDurableTask(WS, { goal: "B's own task", blocking_checks: [{ name: "b", passed: true }] })
  );
  const bCompleted = await asSession("session-B", () => tasks.completeDurableTask(WS, bTask.id));
  assert.equal(bCompleted.status, "completed", "B's task must complete without A's goal gating");

  // …while A's own task stays gated.
  const aTask = await asSession("session-A", () =>
    tasks.createDurableTask(WS, { goal: "A's task", blocking_checks: [{ name: "a", passed: true }] })
  );
  await assert.rejects(
    () => asSession("session-A", () => tasks.completeDurableTask(WS, aTask.id)),
    /unmet success criterion/,
    "the owning session's task must stay gated by its own unmet goal (mechanical gate intact)"
  );

  // 4. Cross-session create: B cannot create a second goal while A holds one.
  await assert.rejects(
    () => asSession("session-B", () => goals.createGoal(WS, { objective: "B goal", success_criteria: [{ name: "x", passed: false }] })),
    /ANOTHER ChatGPT window/,
    "cross-session create must be rejected with the ownership error"
  );
  await assert.rejects(
    () => asSession("session-B", () => goals.createGoal(WS, { objective: "B goal", success_criteria: [{ name: "x", passed: false }], supersede: true })),
    /ANOTHER ChatGPT window/,
    "cross-session supersede must be rejected too"
  );

  // 5. Observation routing: B's tool calls must not write into A's task.
  await asSession("session-B", () =>
    tasks.recordToolObservation(WS, "write_file", { path: path.join(WS, "b-file.txt") }, {
      structuredContent: { ok: true, tool: "write_file", summary: "b wrote", data: { path: path.join(WS, "b-file.txt") } },
    })
  );
  const aTaskAfter = await asSession("session-A", () => tasks.getDurableTask(WS, aTask.id));
  assert.ok(
    !aTaskAfter.changed_files.some((f) => f.includes("b-file.txt")),
    "B's observations must not land in A's task"
  );

  // 6. bind: B adopts the goal; A goes silent; B receives the contract in-band.
  await asSession("session-B", () => goals.bindGoalToSession(WS));
  const bAfterBind = await asSession("session-B", () =>
    broker.appendHarnessRuntimeContextToResult(WS, baseResult(), { toolName: "fixture" })
  );
  assert.ok(
    JSON.stringify(bAfterBind.content).includes("MUST_CONTINUE_TO_TOOL"),
    "after bind, B must receive the continuation tail"
  );
  const aAfterBind = await asSession("session-A", () =>
    broker.appendHarnessRuntimeContextToResult(WS, baseResult(), { toolName: "fixture" })
  );
  assert.ok(
    !JSON.stringify(aAfterBind.content).includes("MUST_CONTINUE_TO_TOOL"),
    "after bind, the previous owner window must go silent"
  );

  // 7. Legacy unbound goal (no session context at creation) stays workspace-wide.
  const wsLegacy = path.join(tmpRoot, "ws-legacy");
  await fs.mkdir(wsLegacy, { recursive: true });
  const legacyGoal = await goals.createGoal(wsLegacy, { objective: "legacy goal", success_criteria: [{ name: "l", passed: false }] });
  assert.ok(!legacyGoal.owner_session, "goal created without a session must be unbound");
  const legacySeen = await broker.buildHarnessRuntimeContext(wsLegacy, undefined);
  assert.ok(legacySeen.goal, "unbound goal must be visible to any session");

  console.log("goal-scope: per-session isolation, cross-session create/supersede rejection, bind adoption, observation routing, legacy compatibility OK");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
