/**
 * Integration test: MCP session init, tool call, stale-session recovery.
 * Requires server running on PORT (default 3000).
 */
import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function mcpPost(path, body, sessionId, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

async function initialize(path = "/mcp") {
  const { status, headers, json } = await mcpPost(
    path,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-mcp-session", version: "1.0.0" },
      },
    },
    null
  );

  if (status !== 200) throw new Error(`initialize HTTP ${status}: ${JSON.stringify(json)}`);
  const sessionId = headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing mcp-session-id header");
  return { sessionId, json };
}

await run("health endpoint", async () => {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== "ok") throw new Error(JSON.stringify(data));
});

let sessionId;
let listedToolNames = [];
let listedTools = [];
await run("initialize session on /mcp", async () => {
  const out = await initialize("/mcp");
  sessionId = out.sessionId;
});

await run("tools/list with valid session", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}`);
  listedTools = json?.result?.tools || [];
  listedToolNames = listedTools.map((t) => t.name);
  for (const required of [
    "run_command",
    "read_file_base64",
    "file_info",
    "write_file_base64",
    "save_chatgpt_file",
    "create_directory",
    "copy_file",
    "move_file",
    "delete_file",
    "shell_reset",
    "process_status",
    "process_output",
    "stop_process",
  ]) {
    if (!listedToolNames.includes(required)) throw new Error(`${required} not in tools/list`);
  }

  const saveTool = listedTools.find((tool) => tool.name === "save_chatgpt_file");
  const fileParams = saveTool?._meta?.["openai/fileParams"];
  if (!Array.isArray(fileParams) || fileParams.length !== 1 || fileParams[0] !== "file") {
    throw new Error(`save_chatgpt_file missing openai/fileParams metadata: ${JSON.stringify(saveTool?._meta)}`);
  }
  const fileSchema = saveTool?.inputSchema?.properties?.file;
  if (!fileSchema || fileSchema.type !== "object") throw new Error("save_chatgpt_file file input is not an object schema");
  for (const field of ["file_id", "download_url"]) {
    if (!fileSchema.properties?.[field]) throw new Error(`save_chatgpt_file file schema missing ${field}`);
  }
});

await run("staged PNG write finalizes only after size and SHA256 verification", async () => {
  const payload = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlTtGQAAAAASUVORK5CYII=",
    "base64"
  );
  const first = payload.subarray(0, 24);
  const second = payload.subarray(24);
  const expectedSha256 = createHash("sha256").update(payload).digest("hex");
  const target = path.join(process.cwd(), ".mcp-binary-integration.png");
  const staging = `${target}.part`;

  try {
    await fs.rm(target, { force: true });
    await fs.rm(staging, { force: true });
    const firstWrite = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "write_file_base64",
          arguments: {
            path: target,
            content: first.toString("base64"),
            offset: 0,
            truncate: true,
            expected_size: payload.length,
            expected_sha256: expectedSha256,
          },
        },
      },
      sessionId,
      { "mcp-protocol-version": "2025-03-26" }
    );
    if (firstWrite.status !== 200 || firstWrite.json?.result?.isError) {
      throw new Error(`first chunk failed: ${firstWrite.text.slice(0, 500)}`);
    }
    try {
      await fs.stat(target);
      throw new Error("final file was visible before transfer completed");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const stagedAfterFirst = await fs.stat(staging);
    if (stagedAfterFirst.size !== first.length) throw new Error(`unexpected staging size ${stagedAfterFirst.size}`);

    const secondWrite = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "write_file_base64",
          arguments: {
            path: target,
            content: second.toString("base64"),
            offset: first.length,
            truncate: false,
            expected_size: payload.length,
            expected_sha256: expectedSha256,
          },
        },
      },
      sessionId,
      { "mcp-protocol-version": "2025-03-26" }
    );
    if (secondWrite.status !== 200 || secondWrite.json?.result?.isError) {
      throw new Error(`second chunk failed: ${secondWrite.text.slice(0, 500)}`);
    }

    const actual = await fs.readFile(target);
    if (!actual.equals(payload)) throw new Error("binary payload mismatch after staged write");
    try {
      await fs.stat(staging);
      throw new Error("staging file still exists after finalization");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    const info = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 24,
        method: "tools/call",
        params: { name: "file_info", arguments: { path: target, sha256: true, head_bytes: 16 } },
      },
      sessionId,
      { "mcp-protocol-version": "2025-03-26" }
    );
    if (info.status !== 200 || info.json?.result?.isError) {
      throw new Error(`file_info failed: ${info.text.slice(0, 500)}`);
    }
    const infoData = info.json?.result?.structuredContent?.data;
    if (infoData?.detected_type !== "png") throw new Error(`detected_type=${infoData?.detected_type}`);
    if (infoData?.first_bytes_hex !== "89504E470D0A1A0A0000000D49484452") {
      throw new Error(`unexpected PNG header ${infoData?.first_bytes_hex}`);
    }
    if (infoData?.sha256 !== expectedSha256) throw new Error("file_info SHA256 mismatch");

    const retryWrite = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: {
          name: "write_file_base64",
          arguments: {
            path: target,
            content: second.toString("base64"),
            offset: first.length,
            truncate: false,
            expected_size: payload.length,
            expected_sha256: expectedSha256,
          },
        },
      },
      sessionId,
      { "mcp-protocol-version": "2025-03-26" }
    );
    if (retryWrite.status !== 200 || retryWrite.json?.result?.isError) {
      throw new Error(`idempotent retry failed: ${retryWrite.text.slice(0, 500)}`);
    }
    if (retryWrite.json?.result?.structuredContent?.data?.idempotent_retry !== true) {
      throw new Error("final retry was not recognized as idempotent");
    }

    const readBack = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "read_file_base64", arguments: { path: target, offset: 0, length: 128 } },
      },
      sessionId,
      { "mcp-protocol-version": "2025-03-26" }
    );
    if (readBack.status !== 200 || !readBack.text.includes(payload.toString("base64"))) {
      throw new Error(`read-back mismatch: ${readBack.text.slice(0, 500)}`);
    }
  } finally {
    await fs.rm(target, { force: true });
    await fs.rm(staging, { force: true });
  }
});

await run("bad final SHA256 never publishes the formal file", async () => {
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 0x5a)]);
  const first = payload.subarray(0, 20);
  const second = payload.subarray(20);
  const target = path.join(process.cwd(), ".mcp-binary-bad-hash.zip");
  const staging = `${target}.part`;
  const wrongSha256 = "0".repeat(64);

  try {
    await fs.rm(target, { force: true });
    await fs.rm(staging, { force: true });
    const firstWrite = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 25,
        method: "tools/call",
        params: {
          name: "write_file_base64",
          arguments: {
            path: target,
            content: first.toString("base64"),
            offset: 0,
            truncate: true,
            expected_size: payload.length,
            expected_sha256: wrongSha256,
          },
        },
      },
      sessionId,
      { "mcp-protocol-version": "2025-03-26" }
    );
    if (firstWrite.status !== 200 || firstWrite.json?.result?.isError) {
      throw new Error(`bad-hash first chunk failed too early: ${firstWrite.text.slice(0, 500)}`);
    }

    const finalWrite = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 26,
        method: "tools/call",
        params: {
          name: "write_file_base64",
          arguments: {
            path: target,
            content: second.toString("base64"),
            offset: first.length,
            truncate: false,
            expected_size: payload.length,
            expected_sha256: wrongSha256,
          },
        },
      },
      sessionId,
      { "mcp-protocol-version": "2025-03-26" }
    );
    if (finalWrite.status !== 200 || !finalWrite.json?.result?.isError) {
      throw new Error(`expected SHA256 tool error: ${finalWrite.text.slice(0, 500)}`);
    }
    try {
      await fs.stat(target);
      throw new Error("bad-hash transfer published a formal file");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const staged = await fs.stat(staging);
    if (staged.size !== payload.length) throw new Error(`bad-hash staging size ${staged.size}`);
  } finally {
    await fs.rm(target, { force: true });
    await fs.rm(staging, { force: true });
  }
});

await run("stale session auto-recovery", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000099";
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "run_command", arguments: { command: "echo stale-test" } },
    },
    fakeId,
    { "mcp-protocol-version": "2025-03-26" }
  );

  if (status !== 200) {
    throw new Error(`expected recovery HTTP 200, got ${status}: ${JSON.stringify(json)}`);
  }
  if (!json?.result) throw new Error(`recovery missing result: ${JSON.stringify(json)}`);
});

await run("re-initialize with stale session header", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000088";
  const { status, headers, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-reinit", version: "1.0.0" },
      },
    },
    fakeId
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const newSession = headers.get("mcp-session-id");
  if (!newSession) throw new Error("missing new session id");
  sessionId = newSession;
});

await run("run_command after re-init", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "run_command",
        arguments: { command: process.platform === "win32" ? "echo mcp-ok" : "echo mcp-ok" },
      },
    },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const text = JSON.stringify(json?.result ?? json);
  if (!text.includes("mcp-ok") && !json?.result?.content) {
    throw new Error(`unexpected result: ${text.slice(0, 300)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);