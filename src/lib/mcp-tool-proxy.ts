import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpUpstreamManager } from "./mcp-upstream-manager.js";
import type { UpstreamServerConfig } from "./mcp-upstream-config.js";
import { toolAnnotations } from "./tool-annotations.js";

const proxyRegistry = new WeakMap<McpServer, Map<string, RegisteredTool>>();

function getRegistry(server: McpServer): Map<string, RegisteredTool> {
  let map = proxyRegistry.get(server);
  if (!map) {
    map = new Map();
    proxyRegistry.set(server, map);
  }
  return map;
}

function jsonSchemaNodeToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();

  const node = schema as {
    type?: string | string[];
    description?: string;
    enum?: unknown[];
    const?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    additionalProperties?: boolean | unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
    nullable?: boolean;
  };

  let field: z.ZodTypeAny;

  const literalValues = Array.isArray(node.enum)
    ? node.enum.filter(
        (value): value is string | number | boolean | null =>
          value === null || ["string", "number", "boolean"].includes(typeof value)
      )
    : [];

  if (
    node.const === null ||
    ["string", "number", "boolean"].includes(typeof node.const)
  ) {
    field = z.literal(node.const as string | number | boolean | null);
  } else if (literalValues.length === 1) {
    field = z.literal(literalValues[0]);
  } else if (literalValues.length > 1) {
    const literals = literalValues.map((value) => z.literal(value));
    field = z.union(
      literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
    );
  } else {
    const variants = node.oneOf ?? node.anyOf;
    if (Array.isArray(variants) && variants.length > 0) {
      const options = variants.map(jsonSchemaNodeToZod);
      field =
        options.length === 1
          ? options[0]
          : z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    } else {
      const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
      const nonNullTypes = types.filter((type) => type !== "null");
      const primaryType = nonNullTypes[0];

      if (primaryType === "string") field = z.string();
      else if (primaryType === "number") field = z.number();
      else if (primaryType === "integer") field = z.number().int();
      else if (primaryType === "boolean") field = z.boolean();
      else if (primaryType === "array") field = z.array(jsonSchemaNodeToZod(node.items));
      else if (primaryType === "object" || node.properties) {
        const required = new Set(Array.isArray(node.required) ? node.required : []);
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, child] of Object.entries(node.properties ?? {})) {
          const childSchema = jsonSchemaNodeToZod(child);
          shape[key] = required.has(key) ? childSchema : childSchema.optional();
        }

        // Be intentionally permissive at proxy boundaries. We preserve the
        // declared properties/types but allow extra fields so a lossy JSON
        // Schema -> Zod conversion can never reject valid upstream output.
        field = z.object(shape).passthrough();
      } else if (primaryType === "null") field = z.null();
      else field = z.any();

      if (types.includes("null") || node.nullable) field = field.nullable();
    }
  }

  if (node.description) field = field.describe(node.description);
  return field;
}

export function jsonSchemaToZodShape(schema: Tool["inputSchema"]): Record<string, z.ZodTypeAny> {
  if (!schema || typeof schema !== "object") return {};
  const schemaObj = schema as { properties?: Record<string, unknown>; required?: string[] };
  const props = schemaObj.properties;
  if (!props || typeof props !== "object") return {};

  const required = new Set(Array.isArray(schemaObj.required) ? schemaObj.required : []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const field = jsonSchemaNodeToZod(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function shouldExposeTool(config: UpstreamServerConfig, toolName: string): boolean {
  if (!config.enabled || config.expose === "none" || config.expose === "meta_only") return false;
  if ((config.disabled_tools ?? []).includes(toolName)) return false;
  return config.expose === "all" || (config.tools ?? []).includes(toolName);
}

export async function refreshProxiedTools(server: McpServer, manager: McpUpstreamManager): Promise<string[]> {
  const registry = getRegistry(server);
  const activeNames = new Set<string>();

  // Codex-style semantics: enabled upstream MCPs expose all of their tools.
  // Fetch tool lists concurrently so creating a ChatGPT MCP session does not
  // serialize network/auth latency across every configured upstream server.
  const enabled = manager.listServerConfigs().filter(
    (config) => config.enabled && config.expose !== "none" && config.expose !== "meta_only"
  );
  const upstreams = await Promise.all(
    enabled.map(async (config) => {
      try {
        return { config, tools: await manager.listTools(config.id) };
      } catch {
        return { config, tools: [] as Tool[] };
      }
    })
  );

  for (const { config, tools } of upstreams) {

    const prefix = `${config.tool_prefix ?? config.id}__`;
    for (const tool of tools) {
      if (!shouldExposeTool(config, tool.name)) continue;
      const proxyName = `${prefix}${tool.name}`;
      activeNames.add(proxyName);

      if (registry.has(proxyName)) continue;

      const inputShape = jsonSchemaToZodShape(tool.inputSchema);
      const hasSchema = Object.keys(inputShape).length > 0;
      const outputShape = tool.outputSchema
        ? jsonSchemaToZodShape(tool.outputSchema as Tool["inputSchema"])
        : undefined;
      const hasOutputSchema = !!outputShape && Object.keys(outputShape).length > 0;

      const registered = server.registerTool(
        proxyName,
        {
          title: tool.title ?? tool.name,
          description: `[${config.name}] ${tool.description ?? tool.name}`,
          inputSchema: hasSchema ? inputShape : {},
          ...(hasOutputSchema ? { outputSchema: outputShape } : {}),
          annotations: tool.annotations ?? toolAnnotations("edit"),
        },
        async (args: Record<string, unknown>) => {
          // Transparent MCP proxy: preserve the upstream CallToolResult exactly
          // (text, images, embedded resources, structuredContent and isError).
          return (await manager.callTool(config.id, tool.name, args ?? {})) as any;
        }
      );
      registry.set(proxyName, registered);
    }
  }

  for (const [name, registered] of registry.entries()) {
    if (!activeNames.has(name)) {
      registered.remove();
      registry.delete(name);
    }
  }

  return [...activeNames];
}

export function clearProxiedTools(server: McpServer): void {
  const registry = getRegistry(server);
  for (const registered of registry.values()) {
    registered.remove();
  }
  registry.clear();
}
