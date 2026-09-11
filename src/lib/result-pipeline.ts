import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { appendHarnessRuntimeContextToResult } from "./context-broker.js";
import { recordGoalStallTelemetry, recordToolObservation } from "./durable-tasks.js";
import type { InvocationContext } from "./invocation-gateway.js";
import { appendGoalRunEvidenceToResult, recordGoalRunToolFailure } from "./goal-run-web.js";
import {
  appendRepeatGuardReminderToResult,
  recordRepeatGuardFailure,
} from "./repeat-guard.js";

type MaybePromise<T> = T | Promise<T>;

/** Injectable seam for deterministic result-pipeline tests. */
export interface WebHarnessResultPipelineOperations {
  recordToolObservation(
    context: InvocationContext,
    result: CallToolResult | undefined,
    error?: unknown
  ): MaybePromise<void>;
  recordGoalStallTelemetry(): MaybePromise<void>;
  appendGoalRunEvidenceToResult(
    context: InvocationContext,
    result: CallToolResult
  ): MaybePromise<CallToolResult>;
  appendHarnessRuntimeContextToResult(
    context: InvocationContext,
    result: CallToolResult
  ): MaybePromise<CallToolResult>;
  appendRepeatGuardReminderToResult(
    context: InvocationContext,
    result: CallToolResult
  ): MaybePromise<CallToolResult>;
  recordRepeatGuardFailure(context: InvocationContext): MaybePromise<void>;
  recordGoalRunToolFailure(context: InvocationContext, error: unknown): MaybePromise<void>;
}

/** Owns the ordered post-handler pipeline for ChatGPT Web harness results. */
export class WebHarnessResultPipeline {
  constructor(private readonly operations: WebHarnessResultPipelineOperations) {}

  async processSuccess(
    context: InvocationContext,
    result: CallToolResult
  ): Promise<CallToolResult> {
    await suppressErrors(() => this.operations.recordToolObservation(context, result));
    await suppressErrors(() => this.operations.recordGoalStallTelemetry());
    const withGoalRunEvidence = await this.operations.appendGoalRunEvidenceToResult(
      context,
      result
    );
    const withHarnessContext = await this.operations.appendHarnessRuntimeContextToResult(
      context,
      withGoalRunEvidence
    );
    return await this.operations.appendRepeatGuardReminderToResult(
      context,
      withHarnessContext
    );
  }

  async processFailure(context: InvocationContext, error: unknown): Promise<void> {
    await suppressErrors(() =>
      this.operations.recordToolObservation(context, undefined, error)
    );
    await suppressErrors(() => this.operations.recordGoalRunToolFailure(context, error));
    await this.operations.recordRepeatGuardFailure(context);
  }
}

/** Production adapter matching the current server-factory operation mapping. */
export function createWebHarnessResultPipeline(
  workspaceRoot: string
): WebHarnessResultPipeline {
  return new WebHarnessResultPipeline({
    recordToolObservation: (context, result, error) =>
      recordToolObservation(
        workspaceRoot,
        context.definition.name,
        context.rawArgs,
        result,
        error
      ),
    recordGoalStallTelemetry: () => recordGoalStallTelemetry(workspaceRoot),
    appendGoalRunEvidenceToResult: (context, result) =>
      appendGoalRunEvidenceToResult(workspaceRoot, context, result),
    appendHarnessRuntimeContextToResult: async (context, result) =>
      (await appendHarnessRuntimeContextToResult(workspaceRoot, result, {
        toolName: context.definition.name,
        toolAction:
          context.rawArgs && typeof context.rawArgs === "object" && !Array.isArray(context.rawArgs) &&
          typeof (context.rawArgs as Record<string, unknown>).action === "string"
            ? (context.rawArgs as Record<string, unknown>).action as string
            : undefined,
      })) as CallToolResult,
    appendRepeatGuardReminderToResult: (context, result) =>
      appendRepeatGuardReminderToResult(
        workspaceRoot,
        context.definition.name,
        context.rawArgs,
        result
      ) as CallToolResult,
    recordRepeatGuardFailure: (context) =>
      recordRepeatGuardFailure(
        workspaceRoot,
        context.definition.name,
        context.rawArgs
      ),
    recordGoalRunToolFailure: (context, error) =>
      recordGoalRunToolFailure(workspaceRoot, context, error),
  });
}

async function suppressErrors(operation: () => MaybePromise<void>): Promise<void> {
  try {
    await operation();
  } catch {}
}
