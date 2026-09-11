import type { CallToolResult, RequestId } from "@modelcontextprotocol/sdk/types.js";

import {
  createRuntimeScope,
  runWithRuntimeScope,
  type RequestContext,
  type RuntimeScope,
  type RuntimeScopeSeed,
} from "./runtime-scope.js";
import {
  conversationSessionIdFromHeaders,
  conversationSessionIdFromMeta,
  getMcpRequestIdentity,
} from "./mcp-request-identity.js";
import type {
  EffectiveToolDefinition,
  EffectiveToolRegistry,
  ToolSource,
} from "./effective-tool-registry.js";

export interface InvocationContext {
  readonly definition: EffectiveToolDefinition;
  readonly scope: RuntimeScope;
  readonly rawArgs: unknown;
  readonly callbackArgs: readonly unknown[];
}

export type InvocationSuccessHook = (
  context: InvocationContext,
  result: CallToolResult
) => CallToolResult | Promise<CallToolResult>;

export type InvocationFailureHook = (
  context: InvocationContext,
  error: unknown
) => void | Promise<void>;

export type InvocationTraceStatus = "start" | "success" | "failure";
export type InvocationErrorCategory = "handler" | "success_hook";

/** Bounded trace data; arguments, results, error text, and auth data are absent. */
export interface InvocationTraceRecord {
  readonly invocationId: string;
  readonly tool: string;
  readonly source: ToolSource;
  readonly sessionId?: string;
  readonly requestId?: RequestId;
  readonly deadlineAt?: number;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly status: InvocationTraceStatus;
  readonly errorCategory?: InvocationErrorCategory;
}

export type InvocationTraceCallback = (
  record: InvocationTraceRecord
) => void | Promise<void>;

export interface InvocationGatewayOptions {
  readonly onSuccess?: InvocationSuccessHook;
  readonly onFailure?: InvocationFailureHook;
  readonly trace?: InvocationTraceCallback;
}

/** Executes every registered tool through one scope-aware invocation path. */
export class InvocationGateway {
  private readonly registry: EffectiveToolRegistry;
  private readonly scopeSeed: RuntimeScopeSeed;
  private readonly onSuccess?: InvocationSuccessHook;
  private readonly onFailure?: InvocationFailureHook;
  private readonly trace?: InvocationTraceCallback;

  constructor(
    registry: EffectiveToolRegistry,
    scopeSeed: RuntimeScopeSeed,
    options: InvocationGatewayOptions = {}
  ) {
    this.registry = registry;
    this.scopeSeed = scopeSeed;
    this.onSuccess = options.onSuccess;
    this.onFailure = options.onFailure;
    this.trace = options.trace;
  }

  /**
   * Invokes a tool with the exact callback argument list supplied by the SDK.
   * The request extra is read from the final callback argument and reduced to
   * the minimal request context before creating the runtime scope.
   */
  async invoke(
    toolName: string,
    callbackArgs: readonly unknown[]
  ): Promise<CallToolResult>;
  async invoke(toolName: string, ...callbackArgs: unknown[]): Promise<CallToolResult>;
  async invoke(toolName: string, ...callbackArguments: unknown[]): Promise<CallToolResult> {
    const definition = this.registry.get(toolName);
    if (!definition) throw new Error(`Tool ${toolName} not found`);

    // Accept both an already-collected SDK argument list and direct varargs so
    // a wrapper can preserve the callback's original arity and ordering.
    const callbackArgs =
      callbackArguments.length === 1 && Array.isArray(callbackArguments[0])
        ? (callbackArguments[0] as readonly unknown[])
        : callbackArguments;
    const requestContext = findRequestContext(callbackArgs);
    const scope = createRuntimeScope(this.scopeSeed, requestContext);
    const context: InvocationContext = {
      definition,
      scope,
      rawArgs: callbackArgs[0],
      callbackArgs: Object.freeze([...callbackArgs]),
    };
    const startedAt = Date.now();

    return runWithRuntimeScope(scope, async () => {
      await this.emitTrace({
        invocationId: scope.invocationId,
        tool: definition.name,
        source: definition.source,
        sessionId: scope.mcpSessionId,
        requestId: scope.requestId,
        deadlineAt: scope.deadlineAt,
        aborted: scope.signal?.aborted ?? false,
        durationMs: 0,
        status: "start",
      });

      let failureCategory: InvocationErrorCategory = "handler";
      try {
        const rawResult = await definition.execute(callbackArgs, scope);
        failureCategory = "success_hook";
        const result = this.onSuccess
          ? await this.onSuccess(context, rawResult)
          : rawResult;

        await this.emitTrace({
          invocationId: scope.invocationId,
          tool: definition.name,
          source: definition.source,
          sessionId: scope.mcpSessionId,
          requestId: scope.requestId,
          deadlineAt: scope.deadlineAt,
          aborted: scope.signal?.aborted ?? false,
          durationMs: elapsedMs(startedAt),
          status: "success",
        });
        return result;
      } catch (error) {
        await this.emitTrace({
          invocationId: scope.invocationId,
          tool: definition.name,
          source: definition.source,
          sessionId: scope.mcpSessionId,
          requestId: scope.requestId,
          deadlineAt: scope.deadlineAt,
          aborted: scope.signal?.aborted ?? false,
          durationMs: elapsedMs(startedAt),
          status: "failure",
          errorCategory: failureCategory,
        });

        if (this.onFailure) await this.onFailure(context, error);
        // If onFailure throws, this throw is not reached, so JavaScript keeps
        // its normal replacement-error semantics instead of masking the hook.
        throw error;
      }
    });
  }

  private async emitTrace(record: InvocationTraceRecord): Promise<void> {
    if (!this.trace) return;
    try {
      await this.trace(record);
    } catch {
      // Trace observers are diagnostic only and cannot affect tool behavior.
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function findRequestContext(callbackArgs: readonly unknown[]): RequestContext | undefined {
  const candidate = callbackArgs[callbackArgs.length - 1];
  if (!isRequestContextLike(candidate)) return undefined;

  return {
    // OpenAI tunnel command dispatch can create a fresh transport-level MCP
    // session for every tool call while keeping one stable workflow request
    // id for the ChatGPT turn/workflow. Goal/task ownership must follow that
    // stable workflow identity rather than the ephemeral transport session.
    // Fall back to the SDK sessionId for ordinary MCP clients.
    sessionId:
      conversationSessionIdFromMeta(candidate._meta) ??
      conversationSessionIdFromHeaders(candidate.requestInfo?.headers) ??
      getMcpRequestIdentity()?.conversationSessionId ??
      (typeof candidate.sessionId === "string" ? candidate.sessionId : undefined),
    signal: candidate.signal as AbortSignal | undefined,
    requestId: isRequestId(candidate.requestId) ? candidate.requestId : undefined,
  };
}

function isRequestContextLike(value: unknown): value is {
  sessionId?: unknown;
  signal?: unknown;
  requestId?: unknown;
  _meta?: unknown;
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "signal" in record && "requestId" in record;
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}
