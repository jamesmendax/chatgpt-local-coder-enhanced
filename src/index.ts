#!/usr/bin/env node

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { randomUUID } from "crypto";

import {
  setDefaultCwd,
  getDefaultCwd,
  getFullDiskAccess,
} from "./lib/path-security.js";
import {
  consumeSessionTransportError,
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
} from "./lib/mcp-session-manager.js";
import { initUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { startAdminServer } from "./admin/server.js";
import { logMcpHttpEvent, logMcpRequest } from "./lib/activity-log.js";
import {
  buildInstructionContext,
  summarizeInstructionContext,
  type InstructionContext,
} from "./lib/instruction-context.js";
import { getChatGptToolProfile } from "./lib/tool-profile.js";
import { getRuntimeManifest, getRuntimeManifestSummary } from "./lib/runtime-manifest.js";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const PORT = intEnv("PORT", 3000, 1, 65535);
const HOST = process.env.HOST || "127.0.0.1";
const MCP_TOKEN = (process.env.MCP_TOKEN || "").trim();
const ADMIN_PORT = intEnv("ADMIN_PORT", 3001, 1, 65535);
const SHELL_TIMEOUT = intEnv("SHELL_TIMEOUT", 120, 1, 3600);
const MCP_JSON_LIMIT = process.env.MCP_JSON_LIMIT?.trim() || "16mb";
const SESSION_RECOVERY =
  (process.env.MCP_SESSION_RECOVERY || "true").toLowerCase() !== "false";

const configuredCorsOrigins = (process.env.MCP_CORS_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const MCP_CORS_ORIGINS = new Set(
  configuredCorsOrigins.length
    ? configuredCorsOrigins
    : ["https://chatgpt.com", "https://chat.openai.com"]
);
const MCP_CORS_ALLOW_ALL = MCP_CORS_ORIGINS.has("*");

function redactMcpPath(value: string): string {
  if (!MCP_TOKEN) return value;
  return value.split(MCP_TOKEN).join("<redacted>");
}

function splitWorkspaceEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((p) => p.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

function resolveWorkspaceRoots(): string[] {
  const configuredRoots = [
    ...splitWorkspaceEnv(process.env.WORKSPACE_PATH || process.cwd()),
    ...splitWorkspaceEnv(process.env.EXTRA_WORKSPACE_PATHS),
    ...splitWorkspaceEnv(process.env.WORKSPACE_PATHS),
    ...splitWorkspaceEnv(process.env.ALLOWED_WORKSPACE_PATHS),
  ];

  const roots = configuredRoots.map((p) => path.resolve(p));
  return [...new Set(roots)];
}

const workspaceRoots = resolveWorkspaceRoots();
const workspaceRoot = workspaceRoots[0] || process.cwd();
setDefaultCwd(workspaceRoot);

const upstreamManager = await initUpstreamManager();

const instructionContext: InstructionContext = await buildInstructionContext({
  workspaceRoot,
  workspaceRoots,
  pid: process.pid,
  adminPort: ADMIN_PORT,
});

if (instructionContext.projectMemory.sections.length > 0) {
  console.log(
    `[MCP] Project memory: ${instructionContext.projectMemory.sections.length} file(s) from ${workspaceRoot} (${instructionContext.projectMemory.total_bytes} bytes)`
  );
} else {
  console.log(
    `[MCP] Project memory: no CLAUDE.md/AGENTS.md at ${workspaceRoot} — set WORKSPACE_PATH to your project root`
  );
}
if (instructionContext.git.is_repo) {
  console.log(`[MCP] Git: branch ${instructionContext.git.branch}`);
}
console.log(
  `[MCP] MCP instructions: ${Math.round(instructionContext.instructionBytes / 1024)}KB (agent prompt + env + git + memory)`
);
console.log(`[MCP] Tool profile: ${getChatGptToolProfile()} (CHATGPT_TOOL_PROFILE)`);
const startupManifest = getRuntimeManifest();
console.log(
  `[MCP] Runtime build: ${startupManifest.build_id}; local tools: ${startupManifest.tool_count}; manifest: ${startupManifest.tool_manifest_hash.slice(0, 12)}`
);

const sessionManager = createSessionManager({
  workspaceRoot,
  shellTimeout: SHELL_TIMEOUT,
  workspaceRoots,
  port: PORT,
  projectMemoryInstructions: instructionContext.instructionsText,
});

const app = express();
app.use(cors({
  origin(origin, callback) {
    if (!origin || MCP_CORS_ALLOW_ALL || MCP_CORS_ORIGINS.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Accept",
    "Mcp-Session-Id",
    "Mcp-Protocol-Version",
    "Last-Event-ID",
  ],
  exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version"],
  maxAge: 600,
}));
app.use(express.json({ limit: MCP_JSON_LIMIT }));
// ChatGPT co the goi "/" hoac "/mcp" — ho tro ca hai.
// Neu dat MCP_TOKEN, endpoint doi thanh "/<token>" + "/mcp/<token>" va cac path
// khong co token se tra 401 (chong scan tunnel URL / trang web goi vao localhost).
const MCP_PATHS = MCP_TOKEN ? [`/${MCP_TOKEN}`, `/mcp/${MCP_TOKEN}`] : ["/", "/mcp"];
const MCP_PATHS_SET = new Set(MCP_PATHS);

app.use((req, res, next) => {
  const started = Date.now();
  const isMcpRoute = MCP_PATHS_SET.has(req.path);
  res.on("finish", () => {
    const duration = Date.now() - started;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const sessionInfo = sessionId ? ` session=${String(sessionId).slice(0, 8)}...` : "";

    if (req.method === "POST" && isMcpRoute) {
      const transportError =
        consumeSessionTransportError(sessionId) ||
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined);
      logMcpRequest(req.body, sessionId, duration, res.statusCode, transportError);
      return;
    }

    if (isMcpRoute && res.statusCode >= 400) {
      const reason =
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined) ||
        (res.statusCode === 404
          ? "Session not found"
          : res.statusCode === 400
            ? "Bad Request (missing Mcp-Session-Id or invalid state)"
            : `HTTP ${res.statusCode}`);
      logMcpHttpEvent({
        method: req.method,
        path: redactMcpPath(req.path),
        httpStatus: res.statusCode,
        durationMs: duration,
        sessionId,
        errorMessage: reason,
      });
      return;
    }

    if (!isMcpRoute) {
      console.log(`[HTTP] ${req.method} ${req.path} ${res.statusCode} ${duration}ms${sessionInfo}`);
    }
  });
  next();
});

if (MCP_TOKEN) {
  // 404 chu KHONG phai 401: theo chuan MCP, 401 la tin hieu "can OAuth" — client
  // (ChatGPT) se di tim OAuth metadata, khong thay, roi treo. 404 = khong co gi o day.
  for (const unguarded of ["/", "/mcp"]) {
    app.all(unguarded, (_req, res) => {
      res.status(404).json({ ok: false, error: "Not found" });
    });
  }
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "codex-mcp-server",
    version: "2.0.0",
    auth: MCP_TOKEN ? "path-token" : "none",
    toolProfile: getChatGptToolProfile(),
    sessionRecovery: SESSION_RECOVERY,
    runtime: getRuntimeManifestSummary(),
  });
});

async function handleMcpPost(req: express.Request, res: express.Response): Promise<void> {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const requestId = extractRequestId(req.body);

    const existing = sessionId ? sessionManager.get(sessionId) : undefined;
    if (existing) {
      await sessionManager.handleExisting(existing, req, res, req.body);
      return;
    }

    if (isInitializeRequest(req.body)) {
      if (sessionId) {
        console.log(`[MCP] Re-initialize with stale session header: ${sessionId}`);
      }
      await sessionManager.createNew(req, res, req.body);
      return;
    }

    if (sessionId) {
      if (SESSION_RECOVERY) {
        const recovered = await sessionManager.tryRecoverStale(
          sessionId,
          req,
          res,
          req.body
        );
        if (recovered) return;
      }
      sessionManager.sendSessionNotFound(res, requestId);
      return;
    }

    // ChatGPT gui mot so request (vd "server/discover") KHONG kem Mcp-Session-Id.
    // Tra 400 o day khien connector retry vo han ("loading mai"). Thay vao do tao
    // session moi + warm-up roi phuc vu request, de SDK tra loi JSON-RPC hop le.
    if (SESSION_RECOVERY) {
      const adopted = await sessionManager.tryRecoverStale(
        randomUUID(),
        req,
        res,
        req.body
      );
      if (adopted) return;
    }

    sessionManager.sendBadRequest(
      res,
      "Bad Request: Mcp-Session-Id header is required",
      requestId
    );
  } catch (error) {
    console.log("[MCP] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: extractRequestId(req.body),
      });
    }
  }
}

function handleStaleSession(
  req: express.Request,
  res: express.Response,
  sessionId: string | undefined
): boolean {
  if (!sessionId || sessionManager.get(sessionId)) {
    return false;
  }
  sessionManager.sendSessionNotFound(res);
  return true;
}

async function handleMcpGet(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (handleStaleSession(req, res, sessionId)) return;

  if (!sessionId) {
    sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

async function handleMcpDelete(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (handleStaleSession(req, res, sessionId)) return;

  if (!sessionId) {
    sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

for (const mcpPath of MCP_PATHS) {
  app.post(mcpPath, handleMcpPost);
  app.get(mcpPath, handleMcpGet);
  app.delete(mcpPath, handleMcpDelete);
}

sessionManager.startCleanup();

const adminServer = startAdminServer({
  port: ADMIN_PORT,
  host: "127.0.0.1",
  mcpPort: PORT,
  pid: process.pid,
  manager: upstreamManager,
  sessionCount: () => sessionManager.count(),
  instructionSummary: () => summarizeInstructionContext(instructionContext),
  instructionsPreview: () => instructionContext.instructionsText,
});

const server = app.listen(PORT, HOST, () => {
  console.log("");
  console.log("========================================");
  console.log("  Codex MCP Server");
  console.log("========================================");
  console.log(`  Local:     http://${HOST}:${PORT}`);
  console.log(`  MCP:       http://${HOST}:${PORT}${redactMcpPath(MCP_PATHS[0])}`);
  console.log(`  MCP alt:   http://${HOST}:${PORT}${redactMcpPath(MCP_PATHS[1])}`);
  console.log(`  Health:    http://${HOST}:${PORT}/health`);
  console.log(`  Admin UI:  http://127.0.0.1:${ADMIN_PORT}/ui`);
  console.log(`  Default cwd: ${workspaceRoot}`);
  console.log(`  Full machine access: ON (no path restrictions)`);
  console.log(`  Session recovery: ${SESSION_RECOVERY ? "ON" : "OFF"}`);
  console.log(`  Auth:      ${MCP_TOKEN ? "ON (MCP_TOKEN in URL path)" : "OFF — dat MCP_TOKEN trong .env!"}`);
  console.log(`  PID:       ${process.pid}`);
  console.log(`  Build:     ${startupManifest.build_id}`);
  console.log(`  Tools:     ${startupManifest.tool_count} (${startupManifest.tool_manifest_hash.slice(0, 12)})`);
  console.log("========================================");
  console.log("  Dang chay... (Ctrl+C de dung)");
  console.log("========================================");
  console.log("");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[LOI] Port ${PORT} da co server khac dang chay!`);
    console.error("Chay lenh sau de tim process:");
    console.error(`  netstat -ano | findstr ":${PORT}"`);
    console.error("Hoac dung: .\\stop.ps1 de tat server cu\n");
  } else {
    console.error("\n[LOI] Khong the khoi dong server:", err.message, "\n");
  }
  process.exit(1);
});

let shuttingDown = false;

function shutdownServer(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[DUNG] Server dang tat... (${signal})`);
  sessionManager.stopCleanup();
  void upstreamManager.shutdown();
  adminServer.close();
  const forceTimer = setTimeout(() => {
    console.warn("[DUNG] Active request did not drain; forcing HTTP connections closed.");
    server.closeAllConnections?.();
    process.exit(0);
  }, 8_000);
  forceTimer.unref?.();
  server.close(() => {
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdownServer("SIGINT"));
process.on("SIGTERM", () => shutdownServer("SIGTERM"));

// Tranh process tu tat khi stdin dong (Windows)
if (process.stdin.isTTY) {
  process.stdin.resume();
}