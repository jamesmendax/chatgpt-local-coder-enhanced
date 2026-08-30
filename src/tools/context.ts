import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit, getAuditPath } from "../lib/audit.js";
import { describePermissionProfile, getPermissionProfile } from "../lib/permissions.js";
import { getDefaultCwd, getFullDiskAccess, getMachineRoots } from "../lib/path-security.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { MCP_QUICKSTART } from "../lib/quickstart.js";
import { getCheckpointConfig } from "../lib/checkpoint.js";
import { getUpstreamManager } from "../lib/mcp-upstream-manager.js";
import { appendAutoMemory } from "../lib/auto-memory.js";
import { loadPathRulesForFile } from "../lib/path-rules.js";
import { toolResult } from "../lib/tool-result.js";
import { loadProjectSkill, loadProjectSkills } from "../lib/skills-loader.js";
import {
  buildContextMap,
  selectRelevantContext,
  type ContextSourceFile,
} from "../lib/context-bundle.js";
import { getBrowserRuntimeStatus } from "./browser.js";
import { getManagedProcessRuntimeStatus } from "./shell.js";
import { getRuntimeManifest } from "../lib/runtime-manifest.js";
import { buildHarnessRuntimeContext } from "../lib/context-broker.js";
import { appendHarnessEventSafe, getHarnessEventLogHealth } from "../lib/harness-events.js";



const contextFileNames = [
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  ".claude/settings.json",
  ".codex/config.toml",
  ".cursor/rules",
];

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findContextFiles(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    for (const name of contextFileNames) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) found.push(candidate);
    }

    if (depth === maxDepth) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return [...new Set(found)];
}

export function registerContextTools(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "list_skills",
    {
      title: "List Skills",
      description: "List project skills and their short activation descriptions. Read a matching skill with load_skill before following it.",
      inputSchema: {},
      annotations: toolAnnotations("read"),
    },
    async () => {
      const skills = await loadProjectSkills(workspaceRoot);
      return toolResult("list_skills", { skills, count: skills.length });
    }
  );

  server.registerTool(
    "load_skill",
    {
      title: "Load Skill",
      description: "Load one skill's complete instructions. Computer Use includes its bundled guidance, API, and confirmation references.",
      inputSchema: {
        name: z.string().min(1).describe("Exact skill name returned by list_skills"),
        max_bytes: z.number().int().positive().max(500000).optional().default(200000),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ name, max_bytes }) => {
      const loaded = await loadProjectSkill(workspaceRoot, name, max_bytes);
      await audit({ tool: "load_skill", action: "read", target: loaded.skill.path, status: "ok" });
      return toolResult("load_skill", loaded);
    }
  );

  server.registerTool(
    "project_context",
    {
      title: "Project Context",
      description:
        "Return a compact project map or a task-relevant context bundle from AGENTS.md/CLAUDE.md/README/config files. Prefer query + relevant; use full only when exact complete text is necessary.",
      inputSchema: {
        path: z.string().optional().describe("Project directory, defaults to primary workspace"),
        max_depth: z.number().int().min(0).max(5).optional().default(3),
        max_bytes_per_file: z.number().int().positive().max(200000).optional().default(60000),
        query: z.string().max(4000).optional().describe("Current task or question used to select relevant sections"),
        mode: z.enum(["map", "relevant", "full"]).optional().describe("Defaults to relevant when query is supplied, otherwise map"),
        max_total_bytes: z.number().int().min(2000).max(50000).optional().default(12000),
        max_chunks: z.number().int().min(1).max(24).optional().default(10),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: projectPath, max_depth, max_bytes_per_file, query, mode, max_total_bytes, max_chunks }) => {
      const root = projectPath ? await validatePath(projectPath) : workspaceRoot;
      const files = await findContextFiles(root, max_depth);
      const sources: ContextSourceFile[] = [];

      for (const file of files) {
        try {
          const buf = await fs.readFile(file);
          const truncated = buf.length > max_bytes_per_file;
          const text = buf.subarray(0, max_bytes_per_file).toString("utf-8");
          sources.push({ path: file, content: text, truncated, bytes: buf.length });
        } catch {}
      }

      const effectiveMode = mode ?? (query?.trim() ? "relevant" : "map");
      await audit({
        tool: "project_context",
        action: "read",
        target: root,
        status: "ok",
        details: { files: sources.length, mode: effectiveMode, query: query?.slice(0, 200) },
      });

      if (effectiveMode === "full") {
        return toolResult("project_context", {
          root,
          mode: effectiveMode,
          files: sources.map(({ bytes, ...file }) => ({ ...file, bytes })),
          count: sources.length,
          total_bytes: sources.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf-8"), 0),
        });
      }

      if (effectiveMode === "map") {
        return toolResult("project_context", {
          root,
          mode: effectiveMode,
          files: buildContextMap(root, sources),
          count: sources.length,
        });
      }

      if (!query?.trim()) throw new Error("project_context mode=relevant requires query");
      const bundle = selectRelevantContext(root, sources, query, {
        maxTotalBytes: max_total_bytes,
        maxChunks: max_chunks,
      });
      const harnessContext = await buildHarnessRuntimeContext(workspaceRoot, root);
      await appendHarnessEventSafe(workspaceRoot, {
        type: "context/bundle",
        project_roots: [root],
        ...(harnessContext.task?.task_id ? { task_id: harnessContext.task.task_id } : {}),
        ...(harnessContext.goal?.goal_id ? { goal_id: harnessContext.goal.goal_id } : {}),
        data: {
          query: query.trim(),
          selected_chunks: bundle.chunks.length,
          selected_files: bundle.files.map((file) => file.relative_path),
          total_bytes: bundle.total_bytes,
        },
      });
      return toolResult("project_context", {
        root,
        mode: effectiveMode,
        ...bundle,
        harness_context: harnessContext,
        count: sources.length,
      });
    }
  );

  server.registerTool(
    "agent_status",
    {
      title: "Agent Status",
      description:
        "Optional: full tool cheat sheet, apply_patch format, permissions, and upstream MCP list. Default workflow is already in MCP instructions.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const upstreamManager = getUpstreamManager();
      let upstream: Awaited<ReturnType<typeof upstreamManager.listStatuses>> = [];
      try {
        upstream = await upstreamManager.listStatuses();
      } catch {}
      return toolResult("agent_status", {
        permission_profile: getPermissionProfile(),
        permission_description: describePermissionProfile(),
        full_machine_access: getFullDiskAccess(),
        default_cwd: getDefaultCwd(),
        machine_roots: getMachineRoots(),
        audit_log: getAuditPath(),
        pid: process.pid,
        node: process.version,
        memory: process.memoryUsage(),
        browser_runtime: getBrowserRuntimeStatus(),
        process_runtime: getManagedProcessRuntimeStatus(),
        quickstart: MCP_QUICKSTART,
        rewind: getCheckpointConfig(),
        upstream_mcp: {
          config_path: upstreamManager.getConfigPath(),
          servers: upstream,
        },
        admin_ui: `http://127.0.0.1:${process.env.ADMIN_PORT || "3001"}/ui`,
        tool_profile: process.env.CHATGPT_TOOL_PROFILE || "slim",
        runtime_manifest: getRuntimeManifest(),
        event_log: await getHarnessEventLogHealth(workspaceRoot),
      });
    }
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description: "Save a note to auto memory for future ChatGPT sessions (like Claude Code MEMORY.md).",
      inputSchema: {
        note: z.string().describe("Short fact to remember: build command, convention, gotcha"),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ note }) => {
      const file = await appendAutoMemory(workspaceRoot, note);
      await audit({ tool: "remember", action: "append", target: file, status: "ok" });
      return toolResult("remember", { saved_to: file, note }, { summary: "saved to auto memory" });
    }
  );

  server.registerTool(
    "load_path_rules",
    {
      title: "Load Path Rules",
      description:
        "Load the AGENTS.md/CLAUDE.md chain from project root to a file plus matching .claude/rules globs. Deeper directory instructions have higher precedence.",
      inputSchema: {
        path: z.string().describe("File path to match against rule paths: frontmatter"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath }) => {
      const validPath = await validatePath(filePath);
      const rules = await loadPathRulesForFile(workspaceRoot, validPath);
      await audit({ tool: "load_path_rules", action: "read", target: validPath, status: "ok", details: { rules: rules.length } });
      return toolResult("load_path_rules", { path: validPath, rules, count: rules.length });
    }
  );
}
