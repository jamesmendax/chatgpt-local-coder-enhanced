import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server-factory.js";
import { getUpstreamManager } from "./mcp-upstream-manager.js";
import { refreshProxiedTools } from "./mcp-tool-proxy.js";
import { runCodexSessionStartHooks } from "./codex-hooks.js";


const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

function boundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const SESSION_TTL_MS = boundedIntEnv("MCP_SESSION_TTL_MS", 300_000, 60_000, 604_800_000); // 1m..7d
const SESSION_CLEANUP_INTERVAL_MS = boundedIntEnv("MCP_SESSION_CLEANUP_MS", 30_000, 1_000, 3_600_000); // 1s..1h
const SESSION_DELETE_GRACE_MS = boundedIntEnv("MCP_SESSION_DELETE_GRACE_MS", 45_000, 0, 600_000); // 0..10m
const SESSION_MAX_COUNT = boundedIntEnv("MCP_SESSION_MAX_COUNT", 32, 4, 512);

const lastTransportErrors: Record<string, string> = {};
const sessionOpChains = new Map<string, Promise<void>>();

/**
 * Gan Mcp-Session-Id vao request truoc khi day cho transport.
 *
 * SDK >=1.29 boc Node transport quanh WebStandardStreamableHTTPServerTransport
 * va dung @hono/node-server de doi IncomingMessage -> fetch Request. Hono dung
 * `incoming.rawHeaders`, KHONG dung `incoming.headers` — nen chi va req.headers
 * la vo tac dung. Phai va ca hai.
 */
function withSessionIdHeader(
  req: Request,
  sessionId: string,
  protocolVersion: string
): Request {
  const headers = {
    ...req.headers,
    "mcp-session-id": sessionId,
    "mcp-protocol-version": protocolVersion,
  };
  const drop = new Set(["mcp-session-id", "mcp-protocol-version"]);
  const raw: string[] = [];
  const existing = req.rawHeaders || [];
  for (let i = 0; i < existing.length; i += 2) {
    if (drop.has(existing[i]?.toLowerCase())) continue;
    raw.push(existing[i], existing[i + 1]);
  }
  raw.push("mcp-session-id", sessionId, "mcp-protocol-version", protocolVersion);
  return Object.assign(req, { headers, rawHeaders: raw });
}

/**
 * ChatGPT (openai-mcp) gui MCP-Protocol-Version moi hon SDK ho tro (vd 2026-07-28)
 * trong request discovery. SDK se tra 400 cho moi request mang version la, lam
 * connector retry vo han. Kep ve version SDK that su ho tro.
 */
function negotiateProtocolVersion(requested: string | undefined): string {
  if (requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastAccessedAt: number;
  createdAt: number;
}

export interface SessionManagerConfig {
  workspaceRoot: string;
  shellTimeout: number;
  workspaceRoots: string[];
  port: number;
  projectMemoryInstructions?: string;
}

export interface SessionManager {
  get(sessionId: string): McpSession | undefined;
  touch(sessionId: string): void;
  count(): number;
  createNew(req: Request, res: Response, body: unknown): Promise<void>;
  handleExisting(session: McpSession, req: Request, res: Response, body?: unknown): Promise<void>;
  tryRecoverStale(
    staleSessionId: string,
    req: Request,
    res: Response,
    body: unknown
  ): Promise<boolean>;
  sendSessionNotFound(res: Response, requestId?: string | number | null): void;
  sendBadRequest(res: Response, message: string, requestId?: string | number | null): void;
  startCleanup(): void;
  stopCleanup(): void;
}

function extractRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

async function loopbackMcpPost(
  port: number,
  path: string,
  body: unknown,
  sessionId?: string,
  protocolVersion?: string
): Promise<{ ok: boolean; status: number; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}

export function consumeSessionTransportError(sessionId?: string): string | undefined {
  if (!sessionId || !lastTransportErrors[sessionId]) return undefined;
  const message = lastTransportErrors[sessionId];
  delete lastTransportErrors[sessionId];
  return message;
}

async function enqueueSessionOp(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = sessionOpChains.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(op);
  sessionOpChains.set(sessionId, run);
  try {
    await run;
  } finally {
    if (sessionOpChains.get(sessionId) === run) {
      sessionOpChains.delete(sessionId);
    }
  }
}

export function createSessionManager(config: SessionManagerConfig): SessionManager {
  const sessions: Record<string, McpSession> = {};
  const pendingRecoveries: Record<string, McpSession> = {};
  const deleteGraceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const activeRequestCounts = new Map<string, number>();
  const initializingServers = new Set<McpServer>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function beginSessionRequest(sessionId: string): void {
    activeRequestCounts.set(sessionId, (activeRequestCounts.get(sessionId) ?? 0) + 1);
  }

  function endSessionRequest(sessionId: string): void {
    const next = (activeRequestCounts.get(sessionId) ?? 1) - 1;
    if (next > 0) activeRequestCounts.set(sessionId, next);
    else activeRequestCounts.delete(sessionId);
    enforceSessionLimit();
  }

  function isSessionBusy(sessionId: string): boolean {
    const session = sessions[sessionId];
    return (
      (activeRequestCounts.get(sessionId) ?? 0) > 0 ||
      sessionOpChains.has(sessionId) ||
      Boolean(session && initializingServers.has(session.server))
    );
  }

  function touch(sessionId: string): void {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (session) {
      session.lastAccessedAt = Date.now();
    }
  }

  function cancelDeleteGrace(sessionId: string): void {
    const timer = deleteGraceTimers[sessionId];
    if (!timer) return;
    clearTimeout(timer);
    delete deleteGraceTimers[sessionId];
  }

  function scheduleDeleteGrace(sessionId: string): void {
    cancelDeleteGrace(sessionId);
    console.log(
      `[MCP] Session DELETE — giữ ${SESSION_DELETE_GRACE_MS / 1000}s để tool call đang chạy: ${sessionId}`
    );
    deleteGraceTimers[sessionId] = setTimeout(() => {
      delete deleteGraceTimers[sessionId];
      removeSession(sessionId, "client DELETE (grace expired)");
    }, SESSION_DELETE_GRACE_MS);
    deleteGraceTimers[sessionId].unref?.();
  }

  function removeSession(sessionId: string, reason: string, closeTransport = false): void {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (!session) return;
    getUpstreamManager().unregisterMcpServer(session.server);
    delete sessions[sessionId];
    delete lastTransportErrors[sessionId];
    sessionOpChains.delete(sessionId);
    activeRequestCounts.delete(sessionId);
    initializingServers.delete(session.server);
    if (closeTransport) void session.transport.close().catch(() => undefined);
    console.log(`[MCP] Session removed (${reason}): ${sessionId}`);
  }

  function clearPendingRecovery(sessionId: string, disposeReason?: string): void {
    const pending = pendingRecoveries[sessionId];
    if (!pending) return;
    delete pendingRecoveries[sessionId];
    const active = sessions[sessionId];
    if (disposeReason && (!active || active.server !== pending.server)) {
      getUpstreamManager().unregisterMcpServer(pending.server);
      initializingServers.delete(pending.server);
      void pending.transport.close().catch(() => undefined);
      console.log(`[MCP] Pending recovery disposed (${disposeReason}): ${sessionId}`);
    }
  }

  function enforceSessionLimit(protectedSessionId?: string): void {
    let count = Object.keys(sessions).length;
    if (count <= SESSION_MAX_COUNT) return;

    const candidates = Object.entries(sessions)
      .filter(([sid]) => sid !== protectedSessionId && !isSessionBusy(sid))
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

    for (const [sid] of candidates) {
      if (count <= SESSION_MAX_COUNT) break;
      removeSession(sid, `LRU cap ${SESSION_MAX_COUNT}`, true);
      count--;
    }
  }

  async function buildSession(preferredSessionId?: string): Promise<McpSession> {
    const hookInstructions = await runCodexSessionStartHooks().catch((error) => {
      console.warn("[MCP] Codex SessionStart hook failed:", error);
      return "";
    });
    const mcpServer = createMcpServer(
      config.workspaceRoot,
      config.shellTimeout,
      config.workspaceRoots,
      true,
      getUpstreamManager(),
      [config.projectMemoryInstructions, hookInstructions].filter(Boolean).join("\n\n")
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: preferredSessionId
        ? () => preferredSessionId
        : () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        const existing = sessions[sid];
        sessions[sid] = {
          transport,
          server: mcpServer,
          lastAccessedAt: Date.now(),
          createdAt: existing?.createdAt ?? Date.now(),
        };
        clearPendingRecovery(sid);
        enforceSessionLimit(sid);
        console.log(`[MCP] Session initialized: ${sid}`);
      },
      onsessionclosed: (sid) => {
        if (sid && sessions[sid]) scheduleDeleteGrace(sid);
      },
    });

    transport.onerror = (error) => {
      const sid = transport.sessionId;
      const message = error.message || String(error);
      if (sid) lastTransportErrors[sid] = message;
    };

    // Keep session alive across transient SSE disconnects; explicit DELETE cleans up.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (!sid || !sessions[sid]) return;
      console.log(`[MCP] Transport closed for ${sid} (session kept for recovery)`);
    };

    await mcpServer.connect(transport);
    // Native tools must be available immediately. Upstream discovery can spawn
    // local processes or wait on remote MCPs, so publish it when ready instead.
    void refreshProxiedTools(mcpServer, getUpstreamManager())
      .then(() => mcpServer.sendToolListChanged())
      .catch((error) => console.warn("[MCP] Upstream tool refresh failed:", error));

    const sid = transport.sessionId ?? preferredSessionId ?? randomUUID();
    return (
      sessions[sid] ?? {
        transport,
        server: mcpServer,
        lastAccessedAt: Date.now(),
        createdAt: Date.now(),
      }
    );
  }

  async function warmUpRecoveredSession(
    staleSessionId: string,
    mcpPath: string,
    protocolVersion: string
  ): Promise<boolean> {
    const initResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      {
        jsonrpc: "2.0",
        id: "__session_recovery_init__",
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "codex-mcp-session-recovery", version: "1.0.0" },
        },
      },
      staleSessionId
    );

    if (!initResult.ok) {
      console.log(
        `[MCP] Recovery initialize failed: HTTP ${initResult.status} for ${staleSessionId}`
      );
      return false;
    }

    const notifyResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      staleSessionId,
      protocolVersion
    );

    if (!notifyResult.ok && notifyResult.status !== 202) {
      console.log(
        `[MCP] Recovery initialized notification failed: HTTP ${notifyResult.status}`
      );
      return false;
    }

    return Boolean(sessions[staleSessionId]);
  }

  return {
    get(sessionId: string) {
      return sessions[sessionId];
    },

    touch,

    count() {
      return Object.keys(sessions).length;
    },

    sendSessionNotFound(res: Response, requestId: string | number | null = null) {
      const message =
        "Session not found. Server restarted or connector session expired — refresh connector and open a new chat.";
      res.locals.mcpError = message;
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message },
        id: requestId,
      });
    },

    sendBadRequest(res: Response, message: string, requestId: string | number | null = null) {
      res.locals.mcpError = message;
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id: requestId,
      });
    },

    async createNew(req: Request, res: Response, body: unknown): Promise<void> {
      const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
      let session: McpSession;

      if (headerSessionId && pendingRecoveries[headerSessionId]) {
        session = pendingRecoveries[headerSessionId];
        clearPendingRecovery(headerSessionId);
        console.log(`[MCP] Using pending recovery transport for ${headerSessionId}`);
      } else {
        session = await buildSession();
      }

      const sid = headerSessionId || session.transport.sessionId;
      const run = async () => {
        initializingServers.add(session.server);
        if (sid) beginSessionRequest(sid);
        try {
          await session.transport.handleRequest(req, res, body);
          const activeSid = session.transport.sessionId;
          if (activeSid) touch(activeSid);
        } finally {
          initializingServers.delete(session.server);
          if (sid) endSessionRequest(sid);
          else enforceSessionLimit();
        }
      };

      if (sid) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async handleExisting(
      session: McpSession,
      req: Request,
      res: Response,
      body?: unknown
    ): Promise<void> {
      const sid =
        session.transport.sessionId || (req.headers["mcp-session-id"] as string | undefined);
      if (sid) touch(sid);
      const run = async () => {
        if (sid) beginSessionRequest(sid);
        try {
          await session.transport.handleRequest(req, res, body);
        } finally {
          if (sid) endSessionRequest(sid);
        }
      };
      // GET mo SSE stream song lau: handleRequest chi resolve khi stream dong.
      // Neu day vao hang doi tuan tu, no giu khoa vinh vien va MOI POST sau do
      // (tools/list, tools/call) se treo — deadlock. Chi tuan tu hoa POST/DELETE.
      if (sid && req.method !== "GET") {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async tryRecoverStale(
      staleSessionId: string,
      req: Request,
      res: Response,
      body: unknown
    ): Promise<boolean> {
      if (isInitializeRequest(body)) {
        return false;
      }

      console.log(`[MCP] Attempting session recovery for stale ID: ${staleSessionId}`);

      const protocolVersion = negotiateProtocolVersion(
        req.headers["mcp-protocol-version"] as string | undefined
      );
      const mcpPath = req.path || "/mcp";

      const pending = await buildSession(staleSessionId);
      pendingRecoveries[staleSessionId] = pending;

      const warmed = await warmUpRecoveredSession(staleSessionId, mcpPath, protocolVersion);
      if (!warmed) {
        clearPendingRecovery(staleSessionId, "recovery failed before initialization");
        removeSession(staleSessionId, "recovery failed", true);
        return false;
      }

      const recovered = sessions[staleSessionId];
      if (!recovered) {
        clearPendingRecovery(staleSessionId);
        return false;
      }

      touch(staleSessionId);
      console.log(`[MCP] Session recovered: ${staleSessionId}`);

      const patchedReq = withSessionIdHeader(req, staleSessionId, protocolVersion);
      await enqueueSessionOp(staleSessionId, async () => {
        beginSessionRequest(staleSessionId);
        try {
          await recovered.transport.handleRequest(patchedReq, res, body);
        } finally {
          endSessionRequest(staleSessionId);
        }
      });
      return true;
    },

    startCleanup() {
      if (cleanupTimer) return;
      cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [sid, session] of Object.entries(sessions)) {
          if (now - session.lastAccessedAt > SESSION_TTL_MS && !isSessionBusy(sid)) {
            removeSession(sid, "TTL expired", true);
          }
        }
        for (const [sid, pending] of Object.entries(pendingRecoveries)) {
          const orphanAge = Math.max(SESSION_CLEANUP_INTERVAL_MS * 2, 60_000);
          if (!sessions[sid] && now - pending.createdAt > orphanAge) {
            clearPendingRecovery(sid, "orphaned recovery cleanup");
          }
        }
        enforceSessionLimit();
      }, SESSION_CLEANUP_INTERVAL_MS);
      cleanupTimer.unref?.();
    },

    stopCleanup() {
      if (!cleanupTimer) return;
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    },
  };
}

export function isStaleSessionRequest(
  sessionId: string | undefined,
  body: unknown,
  getSession: (id: string) => McpSession | undefined
): boolean {
  return Boolean(sessionId && !getSession(sessionId) && !isInitializeRequest(body));
}

export { extractRequestId, isInitializeRequest };
