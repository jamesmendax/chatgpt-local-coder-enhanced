import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";

/** Trusted, process-side values used to build one invocation scope. */
export interface RuntimeScopeSeed {
  readonly tunnelProfile?: string;
  readonly principalId?: string;
  readonly workspaceRoot: string;
  readonly projectRoots: readonly string[];
  readonly deadlineAt?: number;
}

/** The request metadata that is safe and useful at the tool callback boundary. */
export interface RequestContext {
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly requestId?: RequestId;
}

/** Per-invocation state shared through the asynchronous call chain. */
export interface RuntimeScope {
  invocationId: string;
  mcpSessionId?: string;
  tunnelProfile?: string;
  principalId?: string;
  workspaceRoot: string;
  readonly projectRoots: readonly string[];
  deadlineAt?: number;
  signal?: AbortSignal;
  requestId?: RequestId;
}

const runtimeScopeStorage = new AsyncLocalStorage<RuntimeScope>();

/**
 * Creates a scope without deriving identity from transport metadata.
 * `projectRoots` is copied and frozen so a caller cannot mutate the scope via
 * the seed array after creation.
 */
export function createRuntimeScope(
  seed: RuntimeScopeSeed,
  requestContext?: RequestContext
): RuntimeScope {
  return {
    invocationId: crypto.randomUUID(),
    mcpSessionId: requestContext?.sessionId,
    tunnelProfile: seed.tunnelProfile,
    principalId: seed.principalId,
    workspaceRoot: seed.workspaceRoot,
    projectRoots: Object.freeze([...seed.projectRoots]),
    deadlineAt: seed.deadlineAt,
    signal: requestContext?.signal,
    requestId: requestContext?.requestId,
  };
}

/** Runs a synchronous or asynchronous operation with `scope` as its store. */
export function runWithRuntimeScope<T>(scope: RuntimeScope, operation: () => T): T {
  return runtimeScopeStorage.run(scope, operation);
}

/** Returns the scope associated with the current asynchronous execution. */
export function getRuntimeScope(): RuntimeScope | undefined {
  return runtimeScopeStorage.getStore();
}
