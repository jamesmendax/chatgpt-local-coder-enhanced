import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerContextTools } from "./tools/context.js";
import { registerRewindTools } from "./tools/rewind.js";
import { registerMcpBridgeTools } from "./tools/mcp-bridge.js";
import { registerNodeReplTool } from "./tools/node-repl.js";
import { registerPonytailTurnTool } from "./tools/ponytail.js";
import { registerVisualTools } from "./tools/visual.js";
import { registerVisualReviewTool } from "./tools/visual-review.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerGoalTool } from "./tools/goal.js";
import { registerBrowserTools } from "./tools/browser.js";
import { buildServerInstructions } from "./lib/quickstart.js";
import type { McpUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { getChatGptToolProfile, shouldExposeTool } from "./lib/tool-profile.js";
import { TOOL_RESULT_OUTPUT_SCHEMA } from "./lib/tool-result.js";
import { recordGoalStallTelemetry, recordToolObservation } from "./lib/durable-tasks.js";
import { appendHarnessRuntimeContextToResult, resetHarnessSnapshotRetention } from "./lib/context-broker.js";
import { appendRepeatGuardReminderToResult, recordRepeatGuardFailure } from "./lib/repeat-guard.js";

const NOOP_TOOL = {
  remove: () => {},
  update: () => {},
  enable: () => {},
  disable: () => {},
  handler: async () => ({ content: [] }),
  enabled: false,
} as unknown as RegisteredTool;

function configureToolRegistration(server: McpServer, workspaceRoot: string): void {
  const profile = getChatGptToolProfile();
  const original = server.registerTool.bind(server);
  server.registerTool = ((name, config, callback) => {
    const toolName = String(name);
    const isUpstreamProxy = toolName.includes("__");

    // Upstream MCP tools are namespaced as <server>__<tool>. An enabled
    // upstream is always exposed directly, even when local tools use slim.
    if (!isUpstreamProxy && profile !== "full" && !shouldExposeTool(toolName, profile)) {
      return NOOP_TOOL;
    }

    // Every native Local Coder tool returns the stable
    // { ok, tool, summary, data } structuredContent envelope. The generic
    // output schema costs ~0.5KB per tool in tools/list, so keep advertising it
    // for full clients but omit the repeated declaration from ChatGPT web slim.
    // structuredContent itself is still returned in both profiles.
    const nextConfig =
      profile === "full" && !isUpstreamProxy && !config.outputSchema
        ? { ...config, outputSchema: TOOL_RESULT_OUTPUT_SCHEMA }
        : config;

    const wrappedCallback = (async (...callbackArgs: any[]) => {
      try {
        const result = await (callback as any)(...callbackArgs);
        await recordToolObservation(workspaceRoot, toolName, callbackArgs[0], result).catch(() => undefined);
        await recordGoalStallTelemetry(workspaceRoot).catch(() => undefined);
        const withHarnessContext = await appendHarnessRuntimeContextToResult(workspaceRoot, result, { toolName });
        return appendRepeatGuardReminderToResult(workspaceRoot, toolName, callbackArgs[0], withHarnessContext);
      } catch (error) {
        await recordToolObservation(workspaceRoot, toolName, callbackArgs[0], undefined, error).catch(() => undefined);
        recordRepeatGuardFailure(workspaceRoot, toolName, callbackArgs[0]);
        throw error;
      }
    }) as typeof callback;

    return original(name, nextConfig as any, wrappedCallback as any);
  }) as typeof server.registerTool;
}

export function createMcpServer(
  workspaceRoot: string,
  shellTimeout: number,
  workspaceRoots: string[] = [workspaceRoot],
  fullDiskAccess = false,
  upstreamManager?: McpUpstreamManager,
  projectMemoryInstructions?: string
): McpServer {
  // Each MCP session is a fresh ChatGPT conversation: its first tool result
  // must carry a snapshot even if the process already delivered one elsewhere.
  resetHarnessSnapshotRetention(workspaceRoot);
  const server = new McpServer(
    {
      name: "codex-mcp-server",
      version: "2.0.0",
    },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true },
      },
      instructions: buildServerInstructions(
        workspaceRoot,
        workspaceRoots,
        fullDiskAccess,
        projectMemoryInstructions
      ),
    }
  );

  configureToolRegistration(server, workspaceRoot);

  registerFilesystemTools(server, workspaceRoot);
  registerShellTools(server, workspaceRoot, shellTimeout);
  registerGitTools(server, workspaceRoot);
  registerContextTools(server, workspaceRoot);
  registerNodeReplTool(server, workspaceRoot);
  registerPonytailTurnTool(server);
  registerVisualTools(server);
  registerVisualReviewTool(server, workspaceRoot);
  registerGoalTool(server, workspaceRoot);
  registerTaskTools(server, workspaceRoot);
  registerBrowserTools(server);
  registerRewindTools(server);

  if (upstreamManager) {
    registerMcpBridgeTools(server, upstreamManager);
    upstreamManager.registerMcpServer(server);
  }

  return server;
}
