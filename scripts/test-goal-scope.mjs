/**
 * Goal session-scoping tests: a goal created in one ChatGPT window (MCP
 * session) must be invisible and non-gating to every other window, and
 * adoptable via goal(action=bind).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const goalRunWeb = await import("../dist/lib/goal-run-web.js");

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
  await asSession("session-A", () => goalRunWeb.ensureGoalRunAuthority(WS, goal));
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

  // 4. Cross-session create (Plan A): B creates its OWN goal in an independent
  // shard while A holds one — the two windows never supersede each other.
  const bGoal = await asSession("session-B", () =>
    goals.createGoal(WS, { objective: "B goal", success_criteria: [{ name: "x", passed: false }] })
  );
  assert.ok(bGoal.owner_session === "session-B", "B's goal must be owned by session-B");
  // A's shard goal is untouched and still active.
  const aStill = await asSession("session-A", () => goals.getGoal(WS));
  assert.ok(aStill && aStill.id === goal.id && aStill.status === "active", "A's goal must be unaffected by B's create");
  // B sees only its own goal, not A's.
  const bSees = await asSession("session-B", () => goals.getGoal(WS));
  assert.ok(bSees && bSees.id === bGoal.id, "B must resolve its own shard goal");

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

  // 6. bind (cross-turn handover): a brand-new session C (no shard of its own)
  // adopts the goal carried by the global projection. Under Plan A, session A
  // keeps its own independent shard and is unaffected by C's bind; the previous
  // owner of the global projection (session B) goes silent.
  const boundGoal = await asSession("session-C", () => goals.bindGoalToSession(WS));
  assert.ok(boundGoal.owner_session === "session-C", "bind must transfer ownership to session-C");
  assert.ok(boundGoal.id === bGoal.id, "bind must adopt the global-projection goal (B's goal)");
  await asSession("session-C", () => goalRunWeb.synchronizeCommittedLegacyGoal(WS, boundGoal));
  const cAfterBind = await asSession("session-C", () =>
    broker.appendHarnessRuntimeContextToResult(WS, baseResult(), { toolName: "fixture" })
  );
  assert.ok(
    JSON.stringify(cAfterBind.content).includes("MUST_CONTINUE_TO_TOOL"),
    "after bind, the adopting window must receive the continuation tail"
  );
  // A's independent shard goal is untouched by C's bind and still active.
  const aAfterBind = await asSession("session-A", () => goals.getGoal(WS));
  assert.ok(aAfterBind && aAfterBind.id === goal.id && aAfterBind.status === "active", "A's shard goal must remain active after C's bind");
  const aResultAfterBind = await asSession("session-A", () =>
    broker.appendHarnessRuntimeContextToResult(WS, baseResult(), { toolName: "fixture" })
  );
  assert.ok(
    JSON.stringify(aResultAfterBind.content).includes("MUST_CONTINUE_TO_TOOL"),
    "A must still receive its own goal tail because its shard is independent"
  );
  // B's shard has been adopted by C, so B no longer sees an active goal.
  const bAfterBind = await asSession("session-B", () => goals.getGoal(WS));
  assert.ok(!bAfterBind, "B must go silent after its goal is adopted by C");
  const bResultAfterBind = await asSession("session-B", () =>
    broker.appendHarnessRuntimeContextToResult(WS, baseResult(), { toolName: "fixture" })
  );
  assert.ok(
    !JSON.stringify(bResultAfterBind.content).includes("MUST_CONTINUE_TO_TOOL"),
    "B must not receive a tail after its goal is adopted by C"
  );

  // 7. Legacy unbound goal (no session context at creation) stays workspace-wide.
  const wsLegacy = path.join(tmpRoot, "ws-legacy");
  await fs.mkdir(wsLegacy, { recursive: true });
  const legacyGoal = await goals.createGoal(wsLegacy, { objective: "legacy goal", success_criteria: [{ name: "l", passed: false }] });
  assert.ok(!legacyGoal.owner_session, "goal created without a session must be unbound");
  const legacySeen = await broker.buildHarnessRuntimeContext(wsLegacy, undefined);
  assert.ok(legacySeen.goal, "unbound goal must be visible to any session");

  // 8. A corrupt session shard must fail closed; it must never be treated as
  // "no goal" and overwritten by a later create.
  const wsCorrupt = path.join(tmpRoot, "ws-corrupt");
  await fs.mkdir(wsCorrupt, { recursive: true });
  await asSession("session-corrupt", () =>
    goals.createGoal(wsCorrupt, { objective: "corrupt me", success_criteria: [{ name: "c", passed: false }] })
  );
  const corruptSlug = crypto.createHash("sha256").update(path.resolve(wsCorrupt)).digest("hex").slice(0, 12);
  const corruptGoalPath = path.join(
    process.env.CODEX_HOME,
    "projects",
    corruptSlug,
    "sessions",
    "session-corrupt",
    "goal.json"
  );
  await fs.writeFile(corruptGoalPath, "{ not valid json", "utf8");
  await assert.rejects(
    () => asSession("session-corrupt", () => goals.getGoal(wsCorrupt)),
    /GOAL_STATE_UNREADABLE/,
    "corrupt goal.json must fail closed instead of resolving to null"
  );
  await assert.rejects(
    () => asSession("session-corrupt", () =>
      goals.createGoal(wsCorrupt, { objective: "must not overwrite", success_criteria: [{ name: "safe", passed: false }] })
    ),
    /GOAL_STATE_UNREADABLE/,
    "create must not replace a corrupt goal shard"
  );
  assert.equal(await fs.readFile(corruptGoalPath, "utf8"), "{ not valid json", "corrupt goal shard was modified");

  console.log("goal-scope: per-session isolation, cross-session create/supersede rejection, bind adoption, observation routing, legacy compatibility, corrupt-shard fail-closed OK");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
