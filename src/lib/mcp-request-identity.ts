import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface McpRequestIdentity {
  readonly conversationSessionId?: string;
  readonly transportSessionId?: string;
}

type HeaderValue = string | string[] | undefined;
type HeaderBag = Record<string, HeaderValue>;

const requestIdentityStorage = new AsyncLocalStorage<McpRequestIdentity>();

/**
 * Resolve a stable ChatGPT conversation identity from trusted host metadata.
 * OpenAI documents `openai/session` as an anonymized conversation id for
 * correlating tool calls in the same ChatGPT session. We derive a local opaque
 * id so the raw host value is never persisted in Goal/Task state paths.
 */
export function conversationSessionIdFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const raw = (meta as Record<string, unknown>)["openai/session"];
  return typeof raw === "string" && raw.trim() ? deriveConversationSessionId(raw) : undefined;
}

/** Transport fallback for ChatGPT hosts that expose the documented metadata as headers. */
export function conversationSessionIdFromHeaders(headers: HeaderBag | undefined): string | undefined {
  if (!headers) return undefined;
  const openAiSession = headerValue(headers, "x-openai-session");
  if (openAiSession?.trim()) return deriveConversationSessionId(openAiSession);

  // Compatibility with older OpenAI tunnel dispatch that exposed a stable
  // workflow id rather than the documented conversation session metadata.
  for (const name of ["x-client-request-id", "x-request-id"]) {
    const raw = headerValue(headers, name);
    if (!raw) continue;
    const match = raw.trim().match(/^(wfr_[A-Za-z0-9]+)(?:\/[A-Za-z0-9_-]+)?$/);
    if (match) return match[1];
  }
  return undefined;
}

export function runWithMcpRequestIdentity<T>(
  headers: HeaderBag | undefined,
  transportSessionId: string | undefined,
  operation: () => T
): T {
  const identity: McpRequestIdentity = {
    conversationSessionId: conversationSessionIdFromHeaders(headers),
    transportSessionId,
  };
  return requestIdentityStorage.run(identity, operation);
}

export function getMcpRequestIdentity(): McpRequestIdentity | undefined {
  return requestIdentityStorage.getStore();
}

function deriveConversationSessionId(raw: string): string {
  const digest = createHash("sha256")
    .update("chatgpt-openai-conversation-v1\0")
    .update(raw.trim())
    .digest("hex")
    .slice(0, 32);
  return `oai_conv_${digest}`;
}

function headerValue(headers: HeaderBag, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.find((item) => typeof item === "string");
  }
  return undefined;
}
