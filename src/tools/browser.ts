import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import { findBrowserExecutable } from "./visual.js";

const MAX_BROWSER_SESSIONS = 4;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_EXCERPT = 5000;
const MAX_CONSOLE_ITEMS = 100;

interface BrowserSession {
  id: string;
  context: BrowserContext;
  page: Page;
  console: Array<{ type: string; text: string; at: string }>;
  createdAt: number;
  lastUsedAt: number;
}

interface BrowserPayload extends Record<string, unknown> {
  ok: boolean;
  tool: string;
  summary: string;
  data: Record<string, unknown>;
}

const sessions = new Map<string, BrowserSession>();
let sharedBrowser: Browser | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;

function idleTtlMs(): number {
  const parsed = Number.parseInt(process.env.BROWSER_SESSION_TTL_MS || "", 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_IDLE_TTL_MS;
}

function browserImageResult(tool: string, data: Record<string, unknown>, image: Buffer, summary: string) {
  if (image.length > MAX_IMAGE_BYTES) throw new Error(`Browser screenshot exceeds ${MAX_IMAGE_BYTES} bytes`);
  const payload: BrowserPayload = { ok: true, tool, summary, data };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
      { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" },
    ],
    structuredContent: payload,
  };
}

async function closeSharedBrowserIfUnused(): Promise<void> {
  if (sessions.size === 0 && sharedBrowser) {
    const browser = sharedBrowser;
    sharedBrowser = null;
    await browser.close().catch(() => {});
  }
}

async function closeSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  await session.context.close().catch(() => {});
  await closeSharedBrowserIfUnused();
  return true;
}

async function cleanupIdleSessions(): Promise<void> {
  const cutoff = Date.now() - idleTtlMs();
  const stale = [...sessions.values()].filter((session) => session.lastUsedAt < cutoff).map((session) => session.id);
  for (const id of stale) await closeSession(id);
}

function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupIdleSessions().catch(() => {});
  }, 60_000);
  cleanupTimer.unref?.();
}

async function ensureBrowser(): Promise<Browser> {
  await cleanupIdleSessions();
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error("No supported Chromium browser found. Set CHATGPT_BROWSER_PATH to Edge/Chrome/Chromium executable.");
  }
  sharedBrowser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-gpu", "--no-first-run", "--disable-extensions"],
  });
  ensureCleanupTimer();
  return sharedBrowser;
}

async function resolveTarget(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).toString();
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  const localPath = await validatePath(trimmed);
  const stat = await fs.stat(localPath);
  if (!stat.isFile()) throw new Error("Local browser target must be a file");
  return pathToFileURL(localPath).toString();
}

function attachDiagnostics(session: BrowserSession): void {
  session.page.on("console", (message) => {
    session.console.push({ type: message.type(), text: message.text().slice(0, 3000), at: new Date().toISOString() });
    if (session.console.length > MAX_CONSOLE_ITEMS) session.console.splice(0, session.console.length - MAX_CONSOLE_ITEMS);
  });
  session.page.on("pageerror", (error) => {
    session.console.push({ type: "pageerror", text: error.message.slice(0, 3000), at: new Date().toISOString() });
    if (session.console.length > MAX_CONSOLE_ITEMS) session.console.splice(0, session.console.length - MAX_CONSOLE_ITEMS);
  });
}

async function pageMetadata(session: BrowserSession): Promise<Record<string, unknown>> {
  session.lastUsedAt = Date.now();
  const page = session.page;
  const [title, text] = await Promise.all([
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 2000 }).catch(() => ""),
  ]);
  const recentConsole = session.console.slice(-20);
  return {
    session_id: session.id,
    url: page.url(),
    title,
    text_excerpt: text.slice(0, MAX_TEXT_EXCERPT),
    console_recent: recentConsole,
    console_errors: recentConsole.filter((item) => ["error", "warning", "pageerror"].includes(item.type)),
    active_sessions: sessions.size,
    idle_ttl_ms: idleTtlMs(),
  };
}

async function snapshot(session: BrowserSession, fullPage = false): Promise<Buffer> {
  const image = await session.page.screenshot({ type: "png", fullPage, animations: "disabled", caret: "hide" });
  return Buffer.from(image);
}

function getSession(sessionId: string): BrowserSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Unknown or expired browser session_id");
  session.lastUsedAt = Date.now();
  return session;
}

export function getBrowserRuntimeStatus() {
  const now = Date.now();
  return {
    active_sessions: sessions.size,
    browser_connected: Boolean(sharedBrowser?.isConnected()),
    idle_ttl_ms: idleTtlMs(),
    max_sessions: MAX_BROWSER_SESSIONS,
    sessions: [...sessions.values()].map((session) => ({
      id: session.id,
      age_ms: now - session.createdAt,
      idle_ms: now - session.lastUsedAt,
      url: session.page.url(),
    })),
  };
}

export function registerBrowserTools(server: McpServer): void {
  server.registerTool(
    "browser_open",
    {
      title: "Open Browser Session",
      description:
        "Open a persistent headless Edge/Chrome/Chromium session for a URL or local file and return the first screenshot as image content. Sessions auto-expire to control memory.",
      inputSchema: {
        target: z.string().min(1),
        width: z.number().int().min(320).max(3840).optional().default(1440),
        height: z.number().int().min(240).max(2160).optional().default(1000),
        wait_until: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional().default("load"),
        timeout_ms: z.number().int().min(1000).max(120000).optional().default(30000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({ target, width, height, wait_until, timeout_ms }) => {
      try {
        await cleanupIdleSessions();
        if (sessions.size >= MAX_BROWSER_SESSIONS) {
          throw new Error(`Browser session limit reached (${MAX_BROWSER_SESSIONS}); close an existing session first.`);
        }
        const browser = await ensureBrowser();
        const context = await browser.newContext({ viewport: { width, height } });
        const page = await context.newPage();
        const session: BrowserSession = {
          id: randomUUID(),
          context,
          page,
          console: [],
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        };
        attachDiagnostics(session);
        sessions.set(session.id, session);
        try {
          const resolvedTarget = await resolveTarget(target);
          await page.goto(resolvedTarget, { waitUntil: wait_until, timeout: timeout_ms });
          const [data, image] = await Promise.all([pageMetadata(session), snapshot(session)]);
          return browserImageResult("browser_open", data, image, `browser_open: ${page.url()}`);
        } catch (error) {
          await closeSession(session.id);
          throw error;
        }
      } catch (error) {
        return toolError("browser_open", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "browser_action",
    {
      title: "Browser Action",
      description:
        "Act inside a persistent browser session, then optionally return a fresh screenshot plus URL/title/body excerpt and recent console errors. Supports navigate, click, fill, press, hover, wait, and evaluate.",
      inputSchema: {
        session_id: z.string().uuid(),
        action: z.enum(["navigate", "click", "fill", "press", "hover", "wait", "evaluate"]),
        selector: z.string().max(4000).optional(),
        text: z.string().max(20000).optional(),
        key: z.string().max(200).optional(),
        url: z.string().max(8000).optional(),
        script: z.string().max(50000).optional(),
        milliseconds: z.number().int().min(0).max(30000).optional(),
        timeout_ms: z.number().int().min(500).max(120000).optional().default(15000),
        screenshot: z.boolean().optional().default(true),
        full_page: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({ session_id, action, selector, text, key, url, script, milliseconds, timeout_ms, screenshot, full_page }) => {
      try {
        await cleanupIdleSessions();
        const session = getSession(session_id);
        const page = session.page;
        let actionResult: unknown = null;

        if (action === "navigate") {
          if (!url) throw new Error("navigate requires url");
          await page.goto(await resolveTarget(url), { waitUntil: "load", timeout: timeout_ms });
        } else if (action === "click") {
          if (!selector) throw new Error("click requires selector");
          await page.locator(selector).click({ timeout: timeout_ms });
        } else if (action === "fill") {
          if (!selector) throw new Error("fill requires selector");
          if (text === undefined) throw new Error("fill requires text");
          await page.locator(selector).fill(text, { timeout: timeout_ms });
        } else if (action === "press") {
          if (!key) throw new Error("press requires key");
          if (selector) await page.locator(selector).press(key, { timeout: timeout_ms });
          else await page.keyboard.press(key);
        } else if (action === "hover") {
          if (!selector) throw new Error("hover requires selector");
          await page.locator(selector).hover({ timeout: timeout_ms });
        } else if (action === "wait") {
          await page.waitForTimeout(milliseconds ?? 1000);
        } else if (action === "evaluate") {
          if (!script) throw new Error("evaluate requires script");
          actionResult = await page.evaluate((source) => (0, eval)(source), script);
        }

        const data = { ...(await pageMetadata(session)), action, action_result: actionResult };
        if (!screenshot) return toolResult("browser_action", data, { summary: `browser_action: ${action}` });
        const image = await snapshot(session, full_page);
        return browserImageResult("browser_action", data, image, `browser_action: ${action}`);
      } catch (error) {
        return toolError("browser_action", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close Browser Session",
      description: "Close a persistent browser session. When the last session closes, the shared browser process is also terminated to release memory.",
      inputSchema: { session_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ session_id }) => {
      try {
        const closed = await closeSession(session_id);
        return toolResult("browser_close", { session_id, closed, active_sessions: sessions.size });
      } catch (error) {
        return toolError("browser_close", error instanceof Error ? error.message : String(error));
      }
    }
  );
}
