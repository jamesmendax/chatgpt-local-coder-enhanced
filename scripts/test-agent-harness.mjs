import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.CHATGPT_TOOL_PROFILE = "slim";
process.env.READ_TEXT_MAX_FILE_BYTES = "200000";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = path.join(repoRoot, ".tool-test-tmp", "agent-harness");
const workspace = path.join(tmpRoot, "workspace");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(
  path.join(workspace, "sample.test.mjs"),
  'import test from "node:test"; import assert from "node:assert/strict"; test("ok",()=>assert.equal(2+2,4));\n'
);
await fs.writeFile(
  path.join(workspace, "background.mjs"),
  'console.log("background-start"); setTimeout(()=>{ console.log("background-done"); }, 80);\n'
);
await fs.writeFile(
  path.join(workspace, "large.txt"),
  Array.from({ length: 2_000 }, (_, index) => `${String(index + 1).padStart(4, "0")}:${"x".repeat(60)}`).join("\n"),
  "utf-8"
);
await fs.writeFile(path.join(workspace, "too-large.txt"), Buffer.alloc(210_000, 0x78));
const manyDir = path.join(workspace, "many");
await fs.mkdir(manyDir, { recursive: true });
await Promise.all(Array.from({ length: 510 }, (_, index) => fs.writeFile(path.join(manyDir, `${String(index).padStart(4, "0")}.txt`), "x")));

const { createMcpServer } = await import("../dist/server-factory.js");
const server = createMcpServer(workspace, 30_000, [workspace], true);
const client = new Client({ name: "agent-harness-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

function data(result) {
  if (!result?.structuredContent?.ok) {
    throw new Error(`tool failed: ${JSON.stringify(result?.structuredContent)}`);
  }
  return result.structuredContent.data;
}

try {
  const listed = await client.listTools();
  if (listed.tools.length !== 27) throw new Error(`expected 27 slim tools, got ${listed.tools.length}`);
  if (listed.tools.some((tool) => tool.outputSchema)) throw new Error("slim repeated outputSchema");
  const toolsListBytes = Buffer.byteLength(JSON.stringify(listed), "utf-8");
  if (toolsListBytes > 23_000) throw new Error(`slim tools/list budget exceeded: ${toolsListBytes} bytes`);

  const largeRead = data(await client.callTool({
    name: "read_text_file",
    arguments: { path: path.join(workspace, "large.txt") },
  }));
  if (!largeRead.truncated || !largeRead.next_offset || largeRead.content.length > 50_000) {
    throw new Error(`large read was not bounded: ${JSON.stringify({ truncated: largeRead.truncated, next_offset: largeRead.next_offset, chars: largeRead.content.length })}`);
  }
  const largeListing = data(await client.callTool({ name: "list_directory", arguments: { path: manyDir } }));
  if (!largeListing.truncated || largeListing.count !== 500 || largeListing.omitted_entries !== 10) {
    throw new Error(`large directory listing was not bounded: ${JSON.stringify(largeListing)}`);
  }
  const tooLarge = await client.callTool({
    name: "read_text_file",
    arguments: { path: path.join(workspace, "too-large.txt") },
  });
  const tooLargeText = JSON.stringify(tooLarge);
  const tooLargeRejected = tooLarge.isError === true || tooLarge.structuredContent?.ok === false;
  if (!tooLargeRejected || !tooLargeText.includes("READ_TEXT_MAX_FILE_BYTES")) {
    throw new Error(`oversized text file was not rejected safely: ${JSON.stringify(tooLarge.structuredContent)}`);
  }

  const created = data(await client.callTool({
    name: "task_state",
    arguments: {
      action: "create",
      goal: "Verify compact task tracking and command evidence",
      current_step: "Create fixture",
      blocking_checks: [{ name: "tests pass", passed: false }],
      next_actions: ["Run tests", "Inspect background process"],
    },
  }));
  const taskId = created.handoff.task_id;

  const createdGoal = data(await client.callTool({
    name: "goal",
    arguments: {
      action: "create",
      objective: "Verify Goal Mode keeps the agent focused until evidence is complete",
      success_criteria: [{ name: "tests pass", passed: false }],
      current_phase: "Run harness checks",
    },
  }));
  if (createdGoal.continue_execution !== true || !String(createdGoal.execution_contract || "").includes("continuous execution")) {
    throw new Error("goal create result missing the continuation-contract signal");
  }

  const generatedPath = path.join(workspace, "generated.txt");
  const writeResult = await client.callTool({ name: "write_file", arguments: { path: generatedPath, content: "tracked\n" } });
  data(writeResult);
  if (!JSON.stringify(writeResult.content).includes("ACTIVE GOAL")) {
    throw new Error("active goal snapshot was not appended to tool result");
  }
  if (!writeResult.structuredContent?.data?.harness_context?.goal?.goal_id) {
    throw new Error("active goal was not appended to structured harness context");
  }

  const tested = data(await client.callTool({
    name: "run_command",
    arguments: { command: "node --test", working_directory: workspace },
  }));
  if (tested.exit_code !== 0 || tested.command_kind !== "test" || tested.outcome !== "passed") {
    throw new Error(`unexpected test observation: ${JSON.stringify(tested)}`);
  }
  if (!tested.full_output_path) throw new Error("run_command full_output_path missing");
  await fs.stat(tested.full_output_path);

  const started = data(await client.callTool({
    name: "start_process",
    arguments: { command: "node background.mjs", working_directory: workspace },
  }));
  if (!started.full_output_path) throw new Error("start_process full_output_path missing");

  let status;
  for (let attempt = 0; attempt < 80; attempt++) {
    status = data(await client.callTool({ name: "process_status", arguments: { id: started.id } }));
    if (!status.processes[0]?.running) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (status?.processes[0]?.running) throw new Error("background process did not finish");
  const output = data(await client.callTool({
    name: "process_output",
    arguments: { id: started.id, output_mode: "compact" },
  }));
  if (!output.stdout.includes("background-done")) throw new Error("background output missing completion marker");
  await fs.stat(output.full_output_path);

  const resumed = data(await client.callTool({ name: "task_state", arguments: { action: "resume", task_id: taskId } }));
  if (!resumed.handoff.changed_files.some((file) => file.endsWith("generated.txt"))) {
    throw new Error("task did not auto-record changed file");
  }
  if (!resumed.handoff.observed_checks.some((check) => check.name === "tests" && check.passed)) {
    throw new Error("task did not auto-record passing tests");
  }

  const checkpointed = data(await client.callTool({
    name: "task_state",
    arguments: {
      action: "checkpoint",
      task_id: taskId,
      current_step: "Ready to deliver",
      done: ["Created fixture", "Ran tests", "Inspected background process"],
      blocking_checks: [{ name: "tests pass", passed: true, detail: "node --test passed" }],
      next_actions: [],
    },
  }));
  if (checkpointed.continue_execution !== true || !String(checkpointed.execution_hint || "").includes("not a stop condition")) {
    throw new Error("checkpoint result missing the continuation-contract signal");
  }

  data(await client.callTool({
    name: "goal",
    arguments: {
      action: "update",
      current_phase: "Finish delivery",
      success_criteria: [{ name: "tests pass", passed: true, detail: "node --test passed" }],
    },
  }));

  const premature = await client.callTool({
    name: "task_state",
    arguments: { action: "complete", task_id: taskId },
  });
  if (premature.structuredContent?.ok !== false || !JSON.stringify(premature.structuredContent).includes("goal is still active")) {
    throw new Error("task completion was not gated by active goal");
  }

  data(await client.callTool({ name: "goal", arguments: { action: "complete" } }));
  const completed = data(await client.callTool({
    name: "task_state",
    arguments: { action: "complete", task_id: taskId, note: "Harness integration passed" },
  }));
  if (!completed.deliverable_ready || completed.handoff.status !== "completed") {
    throw new Error("task did not enter DELIVERABLE_READY");
  }

  let resumeFailed = false;
  const afterComplete = await client.callTool({ name: "task_state", arguments: { action: "resume" } });
  resumeFailed = afterComplete.structuredContent?.ok === false;
  if (!resumeFailed) throw new Error("completed task remained active");

  console.log(`agent-harness: 27-tool slim (${toolsListBytes} bytes), Goal Mode, compact task tracking, automatic observations, command logs, and background logs OK`);
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  await fs.rm(tmpRoot, { recursive: true, force: true });
}