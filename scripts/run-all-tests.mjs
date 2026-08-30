/**
 * Full verification suite for ChatGPT MCP readiness.
 */
import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const mcpPort = 4200 + Math.floor(Math.random() * 200);
const adminPort = mcpPort + 1;

function runNode(script, env = {}) {
  const scriptPath = path.join(root, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exit ${code}`))));
  });
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc")], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", () => {
      const fallback = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
      fallback.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tsc exit ${code}`))));
  });
}

async function waitFor(url, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout ${url}`);
}

console.log("=== Build ===");
await runBuild();

const unitScripts = [
  "scripts/test-patch.mjs",
  "scripts/test-tools.mjs",
  "scripts/test-checkpoints.mjs",
  "scripts/test-activity-log.mjs",
  "scripts/test-project-memory.mjs",
  "scripts/test-context-bundle.mjs",
  "scripts/test-harness-v2.mjs",
  "scripts/test-path-rules.mjs",
  "scripts/test-goal-mode.mjs",
  "scripts/test-durable-tasks.mjs",
  "scripts/test-command-observation.mjs",
  "scripts/test-repeat-guard.mjs",
  "scripts/test-projection-replay.mjs",
  "scripts/test-runtime-manifest.mjs",
  "scripts/test-tool-profile.mjs",
  "scripts/test-shell-persist.mjs",
  "scripts/test-agent-harness.mjs",
  "scripts/test-visual-review.mjs",
  "scripts/test-office-visual-review.mjs",
];

console.log("\n=== Unit tests ===");
for (const script of unitScripts) {
  console.log(`\n--- ${script} ---`);
  await runNode(script);
}

console.log("\n=== Integration (spawn server) ===");
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    CHATGPT_TOOL_PROFILE: "slim",
    MCP_SESSION_TTL_MS: "60000",
    MCP_SESSION_CLEANUP_MS: "1000",
    MCP_SESSION_MAX_COUNT: "8",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout?.on("data", (d) => (serverLog += d));
server.stderr?.on("data", (d) => (serverLog += d));

try {
  const health = await waitFor(`http://127.0.0.1:${mcpPort}/health`);
  if (health.status !== "ok" || health.toolProfile !== "slim") throw new Error("public health invalid");
  if (health.runtime?.tool_count !== 27) throw new Error(`health runtime tool count invalid: ${health.runtime?.tool_count}`);
  if (health.runtime?.stale_build !== false) throw new Error("temporary server started with stale build");
  if (!/^[a-f0-9]{16}$/.test(health.runtime?.build_id || "")) throw new Error("health runtime build id invalid");
  for (const privateField of ["workspace", "defaultCwd", "mcpEndpoints", "instructions"]) {
    if (privateField in health) throw new Error(`public health leaks ${privateField}`);
  }
  console.log(`OK  public health: profile=${health.toolProfile}, auth=${health.auth}`);

  const admin = await waitFor(`http://127.0.0.1:${adminPort}/health`);
  if (!admin.instructions) throw new Error("admin health missing instructions");
  console.log("OK  admin health");

  const preview = await (await fetch(`http://127.0.0.1:${adminPort}/api/instructions/preview`)).json();
  if (!preview.preview?.includes("## Local work")) throw new Error("instructions preview missing agent prompt");
  console.log(`OK  instructions preview ${preview.total_chars} chars`);

  // MCP session + tools/list count
  const initRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }),
  });
  const sid = initRes.headers.get("mcp-session-id");
  if (!sid) throw new Error("no session id");

  const listRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listText = await listRes.text();
  const listJson = JSON.parse(listText);
  const tools = listJson?.result?.tools || [];
  // Measure the tools payload, not the raw JSON-RPC envelope text — the
  // protocol framing is not tool-surface growth and drifts between clients.
  const bytes = Buffer.byteLength(JSON.stringify({ tools }), "utf-8");
  console.log(`OK  tools/list: ${tools.length} tools, ${Math.round(bytes / 1024)}KB`);
  if (tools.length !== 27) throw new Error(`expected 27 slim tools, got ${tools.length}`);
  if (bytes > 23_000) throw new Error(`slim tools/list budget exceeded: ${bytes} bytes`);
  if (tools.length > 30) console.warn(`WARN tools/list has ${tools.length} tools — consider slim profile`);
  if (!tools.some((t) => t.name === "apply_patch")) throw new Error("apply_patch missing");
  if (!tools.some((t) => t.name === "visual_review")) throw new Error("visual_review missing from slim tools/list");
  if (!tools.some((t) => t.name === "goal")) throw new Error("goal missing from slim tools/list");
  if (tools.some((t) => t.name === "open_image")) throw new Error("legacy open_image should be hidden from slim tools/list");
  if (tools.some((t) => t.outputSchema)) throw new Error("slim tools/list repeats generic outputSchema");
  console.log("OK  slim omits repeated generic output schemas");

  // ChatGPT web may initialize a fresh MCP session for each tool call. Verify
  // the server bounds retained sessions without breaking stale-session recovery.
  const retentionSessions = [];
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 100 + i,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "retention-test", version: "1" } },
      }),
    });
    const retentionSid = res.headers.get("mcp-session-id");
    if (!res.ok || !retentionSid) throw new Error(`retention initialize ${i} failed: HTTP ${res.status}`);
    retentionSessions.push(retentionSid);
  }

  const cappedHealth = await (await fetch(`http://127.0.0.1:${adminPort}/health`)).json();
  if (cappedHealth.active_sessions > 8) {
    throw new Error(`session cap failed: ${cappedHealth.active_sessions} active sessions`);
  }
  console.log(`OK  session cap: ${cappedHealth.active_sessions}/8 active`);

  const staleSid = retentionSessions[0];
  const recoveryRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": staleSid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 200, method: "tools/list", params: {} }),
  });
  if (!recoveryRes.ok) throw new Error(`evicted session recovery failed: HTTP ${recoveryRes.status}`);
  const recoveredHealth = await (await fetch(`http://127.0.0.1:${adminPort}/health`)).json();
  if (recoveredHealth.active_sessions > 8) {
    throw new Error(`session cap exceeded after recovery: ${recoveredHealth.active_sessions}`);
  }
  console.log("OK  evicted session auto-recovery stays within cap");

  process.env.PORT = String(mcpPort);
  await runNode("scripts/test-mcp-session.mjs", { PORT: String(mcpPort) });
  console.log("OK  test-mcp-session");
} finally {
  server.kill();
}

console.log("\n=== ALL TESTS PASSED ===");