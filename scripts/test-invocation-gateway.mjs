/**
 * F1 focused verification for RuntimeScope, EffectiveToolRegistry, and the
 * single InvocationGateway used by native and dynamic upstream callbacks.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const testRoot = path.join(repoRoot, ".tool-test-tmp");
await fs.mkdir(testRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(testRoot, "f1-invocation-"));
const originalCwd = process.cwd();
const savedEnvironment = new Map(
  ["CHATGPT_TOOL_PROFILE", "CHATGPT_TUNNEL_PROFILE", "HARNESS_INVOCATION_TRACE", "CODEX_HOME"].map(
    (name) => [name, process.env[name]]
  )
);

const {
  EffectiveToolRegistry,
} = await import("../dist/lib/effective-tool-registry.js");
const {
  InvocationGateway,
} = await import("../dist/lib/invocation-gateway.js");
const {
  getRuntimeScope,
} = await import("../dist/lib/runtime-scope.js");
const {
  runWithMcpRequestIdentity,
} = await import("../dist/lib/mcp-request-identity.js");
const {
  createMcpServer,
  getMcpServerHarnessRuntime,
} = await import("../dist/server-factory.js");
const {
  refreshProxiedTools,
} = await import("../dist/lib/mcp-tool-proxy.js");

function result(marker) {
  return {
    content: [{ type: "text", text: marker }],
    structuredContent: { marker },
  };
}

function restoreEnvironment() {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function verifyRegistryBehavior() {
  const overrideCwd = path.join(tempRoot, "registry-overrides");
  await fs.mkdir(path.join(overrideCwd, "profiles"), { recursive: true });
  await fs.writeFile(
    path.join(overrideCwd, "profiles", "tool-overrides.json"),
    JSON.stringify({ enabled: ["edit_file", "git_diff"], disabled: ["git_diff"] }),
    "utf8"
  );

  process.chdir(overrideCwd);
  try {
    const slim = new EffectiveToolRegistry("slim");
    const editConfig = { description: "edit", inputSchema: {} };
    const edit = slim.prepare("edit_file", editConfig, async () => result("edit"));
    assert.ok(edit, "slim enabled override was not admitted");
    assert.equal(edit.config, editConfig, "slim config identity changed");
    assert.equal(slim.prepare("git_diff", {}, async () => result("git")), undefined);

    const upstreamConfig = { description: "upstream", inputSchema: {} };
    const upstream = slim.prepare("fake__echo", upstreamConfig, async () => result("upstream"));
    assert.ok(upstream, "namespaced upstream tool was filtered by slim");
    assert.equal(upstream.source, "upstream");
    assert.equal(upstream.config, upstreamConfig, "upstream config identity changed");

    slim.register(edit);
    slim.register(upstream);
    assert.deepEqual(slim.list().map((tool) => tool.name), ["edit_file", "fake__echo"]);
    assert.equal(slim.remove("edit_file"), true);
    assert.deepEqual(slim.list().map((tool) => tool.name), ["fake__echo"]);

    const full = new EffectiveToolRegistry("full");
    const fullConfig = { description: "full", inputSchema: {} };
    const fullGit = full.prepare("git_diff", fullConfig, async () => result("full"));
    assert.ok(fullGit, "full profile no longer preserves its override bypass");
    assert.notEqual(fullGit.config, fullConfig, "full schema injection did not clone config");
    assert.ok(fullGit.config.outputSchema, "full native tool lacks shared output schema");
  } finally {
    process.chdir(repoRoot);
  }
}

async function verifyGatewayBehavior() {
  const registry = new EffectiveToolRegistry("slim");
  const traces = [];
  const failures = [];
  let callbackArgsSeen;
  let scopeSeen;
  const base = result("raw");
  const definition = registry.prepare(
    "read_text_file",
    { inputSchema: {} },
    async (...callbackArgs) => {
      callbackArgsSeen = callbackArgs;
      scopeSeen = getRuntimeScope();
      return base;
    }
  );
  assert.ok(definition);
  registry.register(definition);

  const gateway = new InvocationGateway(
    registry,
    {
      workspaceRoot: path.join(tempRoot, "gateway-workspace"),
      projectRoots: [path.join(tempRoot, "gateway-workspace")],
      tunnelProfile: "business",
      deadlineAt: 123456789,
    },
    {
      onSuccess: (context, rawResult) => {
        assert.equal(getRuntimeScope(), context.scope, "scope missing in success hook");
        return { ...rawResult, structuredContent: { ...rawResult.structuredContent, transformed: true } };
      },
      onFailure: (context, error) => {
        failures.push({ context, error });
      },
      trace: (trace) => {
        traces.push(trace);
        if (trace.status === "success") throw new Error("diagnostic sink failure");
      },
    }
  );

  const controller = new AbortController();
  const args = { path: "SECRET_ARGUMENT_PATH" };
  const extra = {
    sessionId: "session-f1",
    requestId: 42,
    signal: controller.signal,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
  };
  const transformed = await gateway.invoke("read_text_file", [args, extra]);
  assert.equal(transformed.structuredContent.transformed, true);
  assert.equal(callbackArgsSeen[0], args, "gateway changed raw callback argument identity");
  assert.equal(callbackArgsSeen[1], extra, "gateway changed request-extra identity");
  assert.equal(scopeSeen.mcpSessionId, "session-f1");
  assert.equal(scopeSeen.requestId, 42);
  assert.equal(scopeSeen.signal, controller.signal);
  assert.equal(scopeSeen.tunnelProfile, "business");
  assert.equal(scopeSeen.principalId, undefined);
  assert.equal(scopeSeen.deadlineAt, 123456789);
  assert.equal(Object.isFrozen(scopeSeen.projectRoots), true);
  assert.match(scopeSeen.invocationId, /^[0-9a-f-]{36}$/i);
  assert.equal(getRuntimeScope(), undefined, "scope leaked outside invocation");
  assert.deepEqual(traces.map((trace) => trace.status), ["start", "success"]);
  assert.equal(traces[0].invocationId, traces[1].invocationId);
  assert.equal(traces[1].aborted, false);
  assert.equal(traces[1].deadlineAt, 123456789);
  assert.equal(JSON.stringify(traces).includes("SECRET_ARGUMENT_PATH"), false, "trace leaked tool arguments");

  const workflowExtra = {
    ...extra,
    sessionId: "ephemeral-transport-session",
    requestInfo: {
      headers: {
        "X-Client-Request-Id": "wfr_01abcDEF234/command_7",
      },
    },
  };
  await gateway.invoke("read_text_file", [args, workflowExtra]);
  assert.equal(
    scopeSeen.mcpSessionId,
    "wfr_01abcDEF234",
    "stable tunnel workflow id did not override ephemeral transport session"
  );

  const openAiConversation = "opaque-openai-conversation-fixture";
  await gateway.invoke("read_text_file", [args, {
    ...extra,
    sessionId: "ephemeral-openai-one",
    _meta: { "openai/session": openAiConversation },
  }]);
  const derivedOpenAiConversation = scopeSeen.mcpSessionId;
  assert.match(derivedOpenAiConversation, /^oai_conv_[0-9a-f]{32}$/);
  assert.equal(derivedOpenAiConversation.includes(openAiConversation), false, "raw OpenAI conversation id leaked into runtime scope");
  await gateway.invoke("read_text_file", [args, {
    ...extra,
    sessionId: "ephemeral-openai-two",
    _meta: { "openai/session": openAiConversation },
  }]);
  assert.equal(scopeSeen.mcpSessionId, derivedOpenAiConversation, "documented openai/session identity drifted across transports");

  const arbitraryClientRequestExtra = {
    ...extra,
    sessionId: "transport-fallback",
    requestInfo: { headers: { "x-client-request-id": "arbitrary-request-id" } },
  };
  await gateway.invoke("read_text_file", [args, arbitraryClientRequestExtra]);
  assert.equal(
    scopeSeen.mcpSessionId,
    "transport-fallback",
    "arbitrary client request id must not replace MCP transport session identity"
  );

  // A connector may rotate the ephemeral MCP transport while retaining one
  // workflow id. The documented header grammar must keep both calls in the
  // same ownership scope; malformed or missing headers must remain fail-closed
  // on the transport identity.
  const stableWorkflowHeader = "wfr_stableWorkflow123/command_1";
  await gateway.invoke("read_text_file", [args, {
    ...extra,
    sessionId: "ephemeral-transport-one",
    requestInfo: { headers: { "x-request-id": stableWorkflowHeader } },
  }]);
  assert.equal(scopeSeen.mcpSessionId, "wfr_stableWorkflow123");
  await gateway.invoke("read_text_file", [args, {
    ...extra,
    sessionId: "ephemeral-transport-two",
    requestInfo: { headers: { "x-request-id": stableWorkflowHeader.replace("command_1", "command_2") } },
  }]);
  assert.equal(scopeSeen.mcpSessionId, "wfr_stableWorkflow123", "stable workflow identity drifted across ephemeral transports");

  // Some real Web connector paths preserve the stable workflow header on the
  // raw HTTP request but the SDK callback omits requestInfo.headers. The outer
  // request identity must still override an ephemeral transport UUID.
  await runWithMcpRequestIdentity(
    { "x-client-request-id": "wfr_outerRequest456/command_1" },
    "outer-transport-one",
    () => gateway.invoke("read_text_file", [args, {
      ...extra,
      sessionId: "ephemeral-sdk-one",
      requestInfo: { headers: {} },
    }])
  );
  assert.equal(scopeSeen.mcpSessionId, "wfr_outerRequest456", "raw HTTP workflow identity did not reach invocation scope");
  await runWithMcpRequestIdentity(
    { "x-request-id": "wfr_outerRequest456/command_2" },
    "outer-transport-two",
    () => gateway.invoke("read_text_file", [args, {
      ...extra,
      sessionId: "ephemeral-sdk-two",
      requestInfo: { headers: {} },
    }])
  );
  assert.equal(scopeSeen.mcpSessionId, "wfr_outerRequest456", "outer request workflow identity drifted across transports");

  await runWithMcpRequestIdentity(
    { "x-openai-session": "opaque-header-conversation-fixture" },
    "outer-openai-transport-one",
    () => gateway.invoke("read_text_file", [args, {
      ...extra,
      sessionId: "ephemeral-header-sdk-one",
      requestInfo: { headers: {} },
    }])
  );
  const derivedHeaderConversation = scopeSeen.mcpSessionId;
  assert.match(derivedHeaderConversation, /^oai_conv_[0-9a-f]{32}$/);
  await runWithMcpRequestIdentity(
    { "x-openai-session": "opaque-header-conversation-fixture" },
    "outer-openai-transport-two",
    () => gateway.invoke("read_text_file", [args, {
      ...extra,
      sessionId: "ephemeral-header-sdk-two",
      requestInfo: { headers: {} },
    }])
  );
  assert.equal(scopeSeen.mcpSessionId, derivedHeaderConversation, "x-openai-session fallback drifted across transports");

  await gateway.invoke("read_text_file", [args, {
    ...extra,
    sessionId: "transport-malformed-workflow",
    requestInfo: { headers: { "x-client-request-id": "wfr_not-a-valid-workflow/command_1" } },
  }]);
  assert.equal(scopeSeen.mcpSessionId, "transport-malformed-workflow", "malformed workflow header must not override transport identity");
  await gateway.invoke("read_text_file", [args, {
    ...extra,
    sessionId: "transport-missing-workflow",
    requestInfo: { headers: {} },
  }]);
  assert.equal(scopeSeen.mcpSessionId, "transport-missing-workflow", "missing workflow header must use transport identity");

  const firstInvocationId = traces[0].invocationId;
  traces.length = 0;
  controller.abort();
  await gateway.invoke("read_text_file", [args, extra]);
  assert.notEqual(traces[0].invocationId, firstInvocationId, "invocation IDs were reused");
  assert.equal(traces.at(-1).aborted, true, "aborted signal did not propagate to trace");

  const handlerError = new TypeError("SECRET_HANDLER_MESSAGE");
  const failing = registry.prepare("write_file", { inputSchema: {} }, async () => {
    assert.ok(getRuntimeScope(), "scope missing in failing handler");
    throw handlerError;
  });
  assert.ok(failing);
  registry.register(failing);
  traces.length = 0;
  await assert.rejects(
    gateway.invoke("write_file", [{ path: "secret" }, extra]),
    (error) => error === handlerError
  );
  assert.equal(failures.at(-1).error, handlerError);
  assert.equal(traces.at(-1).status, "failure");
  assert.equal(traces.at(-1).errorCategory, "handler");
  assert.equal(JSON.stringify(traces).includes("SECRET_HANDLER_MESSAGE"), false, "trace leaked error text");

  const successHookError = new RangeError("success hook failed");
  const hookFailures = [];
  const hookGateway = new InvocationGateway(registry, {
    workspaceRoot: tempRoot,
    projectRoots: [tempRoot],
  }, {
    onSuccess: () => {
      throw successHookError;
    },
    onFailure: (_context, error) => hookFailures.push(error),
    trace: (trace) => traces.push(trace),
  });
  traces.length = 0;
  await assert.rejects(
    hookGateway.invoke("read_text_file", [args, extra]),
    (error) => error === successHookError
  );
  assert.equal(hookFailures[0], successHookError);
  assert.equal(traces.at(-1).errorCategory, "success_hook");

  const replacement = new Error("replacement");
  const replacementGateway = new InvocationGateway(registry, {
    workspaceRoot: tempRoot,
    projectRoots: [tempRoot],
  }, {
    onFailure: () => {
      throw replacement;
    },
  });
  await assert.rejects(
    replacementGateway.invoke("write_file", [{}, extra]),
    (error) => error === replacement
  );
  await assert.rejects(gateway.invoke("missing_tool", []), /Tool missing_tool not found/);
}

async function verifyConfiguredServerGateway() {
  const workspace = path.join(tempRoot, "server-workspace");
  await fs.mkdir(workspace, { recursive: true });
  const fixture = path.join(workspace, "fixture.txt");
  await fs.writeFile(fixture, "gateway fixture\n", "utf8");
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  process.env.CHATGPT_TUNNEL_PROFILE = "business";
  process.env.HARNESS_INVOCATION_TRACE = "1";
  process.env.CODEX_HOME = path.join(tempRoot, "codex-home");

  const upstreamConfig = {
    id: "f1-upstream",
    name: "F1 Upstream",
    enabled: true,
    expose: "all",
    tool_prefix: "f1",
  };
  let upstreamScope;
  let upstreamOptions;
  const manager = {
    tools: [{
      name: "echo",
      description: "F1 echo",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    }],
    registerMcpServer() {},
    listServerConfigs() {
      return [upstreamConfig];
    },
    async listTools() {
      return this.tools;
    },
    async callTool(_serverId, _toolName, args, options) {
      upstreamScope = getRuntimeScope();
      upstreamOptions = options;
      return result(`echo:${args.message}`);
    },
  };

  const server = createMcpServer(workspace, 30_000, [workspace], true, manager);
  const runtime = getMcpServerHarnessRuntime(server);
  assert.ok(runtime, "server did not retain its harness runtime");
    assert.equal(runtime.registry.list().length, 30, "effective slim native registry changed");

  const client = new Client({ name: "f1-gateway-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const harnessLogs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const capture = (...values) => {
    const line = values.map(String).join(" ");
    if (line.startsWith("[HARNESS]")) harnessLogs.push(line);
  };
  console.log = capture;
  console.warn = capture;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const nativeResult = await client.callTool({
      name: "read_text_file",
      arguments: { path: fixture, head: 1 },
    });
    assert.equal(nativeResult.structuredContent.ok, true);
    const nativeLogs = harnessLogs.filter((line) => line.includes("tool=read_text_file"));
    assert.equal(nativeLogs.length, 2, "native callback did not emit gateway start/success traces");
    const nativeIds = nativeLogs.map((line) => line.match(/invocation=([^ ]+)/)?.[1]);
    assert.equal(nativeIds[0], nativeIds[1], "native trace correlation changed between start and success");
    assert.equal(nativeLogs.some((line) => line.includes(fixture)), false, "server trace leaked tool arguments");

    const rawSeparatorToolName = "raw\u2028separator\u2029tool";
    manager.tools = [{ ...manager.tools[0], name: rawSeparatorToolName }];
    await refreshProxiedTools(server, manager);
    const rawSeparatorResult = await client.callTool({
      name: `f1__${rawSeparatorToolName}`,
      arguments: { message: "gateway" },
    });
    assert.equal(rawSeparatorResult.structuredContent.marker, "echo:gateway");
    const rawSeparatorLogs = harnessLogs.filter((line) => line.includes("tool=f1__raw separator tool"));
    assert.equal(rawSeparatorLogs.length, 2, "Unicode line separators were not normalized in invocation traces");
    assert.equal(
      rawSeparatorLogs.some((line) => line.includes("\u2028") || line.includes("\u2029")),
      false,
      "invocation traces emitted raw Unicode line separators"
    );

    manager.tools = [{ ...manager.tools[0], name: "echo" }];
    await refreshProxiedTools(server, manager);
    assert.equal(runtime.registry.get("f1__echo")?.source, "upstream");
    assert.equal(runtime.registry.list().length, 31, "dynamic tool was not merged into effective registry");
    const proxyResult = await client.callTool({
      name: "f1__echo",
      arguments: { message: "gateway" },
    });
    assert.equal(proxyResult.structuredContent.marker, "echo:gateway");
    assert.ok(upstreamScope, "dynamic upstream callback did not run inside RuntimeScope");
    assert.equal(upstreamScope.workspaceRoot, workspace);
    assert.equal(upstreamScope.tunnelProfile, "business");
    assert.match(upstreamScope.invocationId, /^[0-9a-f-]{36}$/i);
    assert.equal(upstreamOptions.signal, upstreamScope.signal, "upstream call did not receive invocation signal");
    assert.equal(harnessLogs.filter((line) => line.includes("tool=f1__echo")).length, 2);

    manager.tools = [];
    await refreshProxiedTools(server, manager);
    assert.equal(runtime.registry.get("f1__echo"), undefined, "removed proxy remained in effective registry");
    assert.equal(runtime.registry.list().length, 30);
    const listed = await client.listTools();
    assert.equal(listed.tools.some((tool) => tool.name === "f1__echo"), false);

    manager.tools = [{ ...manager.tools[0] ?? {
      name: "echo",
      description: "F1 echo",
      inputSchema: { type: "object", properties: { message: { type: "string" } } },
    } }];
    await refreshProxiedTools(server, manager);
    assert.ok(runtime.registry.get("f1__echo"), "proxy was not restored for failure-retention check");
    manager.listTools = async () => { throw new Error("temporary discovery failure"); };
    await refreshProxiedTools(server, manager);
    assert.ok(runtime.registry.get("f1__echo"), "transient discovery failure removed existing proxy");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

try {
  process.chdir(repoRoot);
  await verifyRegistryBehavior();
  await verifyGatewayBehavior();
  await verifyConfiguredServerGateway();
  console.log("F1 invocation gateway: scope, registry, traces, errors, native callbacks, and dynamic lifecycle passed");
} finally {
  process.chdir(originalCwd);
  restoreEnvironment();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
