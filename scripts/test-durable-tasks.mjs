import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  completeDurableTask,
  checkpointDurableTask,
  createDurableTask,
  durableTaskDir,
  getActiveTaskId,
  getDurableTask,
  listDurableTasks,
  recordToolObservation,
  resolveDurableTask,
  taskHandoff,
  updateDurableTask,
} from "../dist/lib/durable-tasks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpHome = path.join(root, ".task-test-home");
const workspace = path.join(root, ".task-test-workspace");

process.env.CODEX_HOME = tmpHome;
await fs.rm(tmpHome, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });

try {
  const created = await createDurableTask(workspace, {
    goal: "Verify durable task lifecycle",
    current_step: "Run blocking check",
    blocking_checks: [{ name: "tests pass", passed: false }],
    advisory_checks: [{ name: "optional polish", passed: false }],
    artifacts: ["artifact.txt"],
  });
  if (!created.id || created.status !== "active") throw new Error("task_create state invalid");
  if ((await resolveDurableTask(workspace)).id !== created.id) throw new Error("active task pointer missing");

  const checkpointed = await checkpointDurableTask(workspace, created.id, {
    current_step: "Patch implementation",
    done: ["Inspected the failing module"],
    decisions: ["Keep the public API stable"],
    blockers: ["Tests still fail"],
    next_actions: ["Apply focused patch", "Run tests"],
  });
  if (checkpointed.checkpoint_no !== 1 || !checkpointed.done.length) throw new Error("compact checkpoint failed");

  await recordToolObservation(
    workspace,
    "apply_patch",
    { path: path.join(workspace, "src", "app.ts") },
    { structuredContent: { ok: true, summary: "patched app.ts", data: { path: path.join(workspace, "src", "app.ts") } } }
  );
  await recordToolObservation(
    workspace,
    "run_command",
    { command: "npm test" },
    { structuredContent: { ok: false, summary: "exit 1 in fixture", data: { command: "npm test", exit_code: 1 } } }
  );
  const observed = await getDurableTask(workspace, created.id);
  const handoff = taskHandoff(observed);
  if (!handoff.changed_files.some((file) => file.endsWith(path.join("src", "app.ts")))) throw new Error("changed file was not auto-recorded");
  if (handoff.last_failure?.tool !== "run_command") throw new Error("last failure was not auto-recorded");
  if (!handoff.observed_checks.some((check) => check.name === "tests" && !check.passed)) throw new Error("test observation missing");

  const restored = await getDurableTask(workspace, created.id);
  if (restored.goal !== created.goal) throw new Error("task did not persist");

  let blocked = false;
  try {
    await completeDurableTask(workspace, created.id);
  } catch (error) {
    blocked = String(error).includes("blocking check");
  }
  if (!blocked) throw new Error("completion was not blocked by failed blocking check");

  const updated = await updateDurableTask(workspace, created.id, {
    current_step: "Ready to deliver",
    blocking_checks: [{ name: "tests pass", passed: true, detail: "ok" }],
  });
  if (!updated.blocking_checks[0]?.passed) throw new Error("blocking check update failed");

  const completed = await completeDurableTask(workspace, created.id, "Delivered");
  if (completed.status !== "completed" || !completed.completed_at) throw new Error("task did not complete");
  if (completed.advisory_checks[0]?.passed) throw new Error("advisory check unexpectedly changed");

  const listed = await listDurableTasks(workspace, { status: "completed" });
  if (!listed.some((task) => task.id === created.id)) throw new Error("completed task missing from list");

  const staleWorkspace = path.join(root, ".task-test-stale-workspace");
  const staleDir = durableTaskDir(staleWorkspace);
  await fs.mkdir(staleDir, { recursive: true });
  await fs.writeFile(
    path.join(staleDir, "active-task.json"),
    JSON.stringify({ task_id: "11111111-1111-4111-8111-111111111111", updated_at: "2000-01-01T00:00:00.000Z" }),
    "utf-8"
  );
  if ((await getActiveTaskId(staleWorkspace)) !== null) throw new Error("stale active task pointer was not expired");
  let stalePointerExists = true;
  try {
    await fs.access(path.join(staleDir, "active-task.json"));
  } catch {
    stalePointerExists = false;
  }
  if (stalePointerExists) throw new Error("expired active task pointer file was not removed");

  console.log(`OK durable task ${created.id} persisted, blocked early completion, completed after blocking checks, and expired stale pointers`);
} finally {
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
}
