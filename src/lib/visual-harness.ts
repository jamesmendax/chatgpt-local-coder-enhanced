import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { validatePath } from "./path-security.js";
import {
  fileSignature,
  getVisualReviewFreshness,
  getVisualReviewRecord,
  MAX_VISUAL_ITERATIONS,
  saveVisualReviewRecord,
  type VisualArtifactKind,
} from "./visual-review-state.js";

const execFileAsync = promisify(execFile);
const MAX_RENDER_DIMENSION = 4096;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_RETURN_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 12;
const MAX_FOCUS = 8;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface VisualFocusInput {
  label?: string;
  selector?: string;
  pair_selector?: string;
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  unit?: "ratio" | "px";
}

export interface VisualReviewInput {
  target: string;
  kind?: "auto" | VisualArtifactKind;
  output_dir?: string;
  width?: number;
  height?: number;
  pages?: number[];
  focus?: VisualFocusInput[];
  compare_to?: string;
  full_page?: boolean;
  timeout_ms?: number;
  max_images?: number;
  allow_office_running?: boolean;
}

export interface VisualImagePayload {
  path: string;
  label: string;
  bytes: Buffer;
  mime_type: string;
}

export interface VisualReviewExecution {
  data: Record<string, unknown>;
  images: VisualImagePayload[];
}

interface ResolvedTarget {
  target: string;
  label: string;
  sourcePath?: string;
}

interface RenderResult {
  renderer: string;
  overviewPath: string;
  pagePaths: string[];
  pageMap: Map<number, string>;
  focusPaths: string[];
  focusDetails: Array<Record<string, unknown>>;
  machineIssues: string[];
  advisories: string[];
  diagnostics: Record<string, unknown>;
}

interface BrowserCaptureResult {
  overviewPath: string;
  focusPaths: string[];
  focusDetails: Array<Record<string, unknown>>;
  machineIssues: string[];
  advisories: string[];
  diagnostics: Record<string, unknown>;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function imageMimeType(filePath: string): string | null {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

async function readImage(filePath: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const mimeType = imageMimeType(filePath);
  if (!mimeType) throw new Error(`Unsupported preview image type: ${path.extname(filePath) || "none"}`);
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Preview image is missing or empty: ${filePath}`);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Preview image is ${stat.size} bytes; limit is ${MAX_IMAGE_BYTES}`);
  return { bytes: await fs.readFile(filePath), mimeType };
}

async function imageDataUrl(filePath: string): Promise<string> {
  const { bytes, mimeType } = await readImage(filePath);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function browserCandidates(): string[] {
  const envPath = process.env.CHATGPT_BROWSER_PATH?.trim();
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge"
    );
  }
  return candidates;
}

export function findVisualBrowserExecutable(): string | null {
  for (const candidate of browserCandidates()) {
    try {
      if (candidate && fsSync.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

async function withVisualDeadline<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>,
  onTimeout?: () => void
): Promise<T> {
  const bounded = Math.max(1_000, Math.floor(timeoutMs));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch {}
      reject(new Error(`${label} timed out after ${bounded}ms`));
    }, bounded);
    timer.unref?.();
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

function browserLifecycleTimeout(timeoutMs: number, multiplier = 2): number {
  return Math.min(180_000, Math.max(5_000, timeoutMs * multiplier + 5_000));
}

async function closeVisualBrowser(browser: Browser, timeoutMs: number): Promise<void> {
  const closeTimeout = Math.min(5_000, Math.max(1_000, Math.floor(timeoutMs / 4)));
  await withVisualDeadline("Visual browser close", closeTimeout, () => browser.close()).catch(() => undefined);
}

async function launchVisualBrowser(timeoutMs = 30_000): Promise<Browser> {
  const executablePath = findVisualBrowserExecutable();
  if (!executablePath) {
    throw new Error("No supported Chromium browser found. Set CHATGPT_BROWSER_PATH to Edge/Chrome/Chromium executable.");
  }
  return chromium.launch({
    executablePath,
    headless: true,
    timeout: Math.max(1_000, Math.min(120_000, timeoutMs)),
    args: [
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--disable-extensions",
      "--allow-file-access-from-files",
    ],
  });
}

async function resolveTarget(rawTarget: string): Promise<ResolvedTarget> {
  const trimmed = rawTarget.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return { target: url.toString(), label: url.toString() };
  }
  const sourcePath = await validatePath(trimmed);
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile()) throw new Error("Visual review target must be a file or HTTP/HTTPS URL");
  return { target: pathToFileURL(sourcePath).toString(), label: sourcePath, sourcePath };
}

function detectKind(resolved: ResolvedTarget, explicit: VisualReviewInput["kind"]): VisualArtifactKind {
  if (explicit && explicit !== "auto") return explicit;
  if (!resolved.sourcePath) return "url";
  const extension = path.extname(resolved.sourcePath).toLowerCase();
  if (IMAGE_MIME_BY_EXT[extension]) return "image";
  if (extension === ".svg") return "svg";
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".pdf") return "pdf";
  if (extension === ".pptx") return "pptx";
  if (extension === ".docx") return "docx";
  throw new Error(`Unsupported visual artifact type: ${extension || "none"}. Use image, SVG, HTML/URL, PDF, PPTX, or DOCX.`);
}

async function createOutputDirectory(workspaceRoot: string, requested?: string): Promise<string> {
  const candidate = requested?.trim()
    ? await validatePath(requested)
    : await validatePath(path.join(workspaceRoot, ".chatgpt-local-coder", "visual-reviews", `${Date.now()}-${randomUUID().slice(0, 8)}`));
  await fs.mkdir(candidate, { recursive: true });
  return candidate;
}

function selectorForFocus(focus: VisualFocusInput): string | null {
  const selector = focus.selector?.trim();
  return selector || null;
}

function rectDistance(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function unionRect(
  a: { x: number; y: number; width: number; height: number },
  b?: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

async function pageMetrics(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const clipped: Array<Record<string, unknown>> = [];
    const elements = Array.from(document.querySelectorAll<HTMLElement>("body *")).slice(0, 5000);
    for (const element of elements) {
      const style = getComputedStyle(element);
      const horizontal = element.scrollWidth > element.clientWidth + 2;
      const vertical = element.scrollHeight > element.clientHeight + 2;
      const clips = ["hidden", "clip"].includes(style.overflow) || ["hidden", "clip"].includes(style.overflowX) || ["hidden", "clip"].includes(style.overflowY);
      if ((horizontal || vertical) && clips) {
        clipped.push({
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          class_name: typeof element.className === "string" ? element.className.slice(0, 120) : undefined,
          client_width: element.clientWidth,
          scroll_width: element.scrollWidth,
          client_height: element.clientHeight,
          scroll_height: element.scrollHeight,
        });
        if (clipped.length >= 20) break;
      }
    }
    return {
      title: document.title,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      document_width: Math.max(root.scrollWidth, body?.scrollWidth || 0),
      document_height: Math.max(root.scrollHeight, body?.scrollHeight || 0),
      clipped_elements: clipped,
      clipped_element_count: clipped.length,
    };
  });
}

async function waitForVisualStability(page: Page, timeoutMs: number): Promise<void> {
  const fontWaitMs = Math.min(3_000, Math.max(250, Math.floor(timeoutMs / 4)));
  await withVisualDeadline("Visual font stabilization", fontWaitMs + 1_000, () => page.evaluate(async (waitMs) => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      await Promise.race([
        fonts.ready,
        new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
      ]);
    }
  }, fontWaitMs)).catch(() => undefined);
  await page.waitForTimeout(Math.min(350, Math.max(80, Math.floor(timeoutMs / 100))));
}

async function captureSelectorFocus(
  page: Page,
  focusItems: VisualFocusInput[],
  outputDir: string,
  timeoutMs: number
): Promise<{
  paths: string[];
  details: Array<Record<string, unknown>>;
  issues: string[];
}> {
  const paths: string[] = [];
  const details: Array<Record<string, unknown>> = [];
  const issues: string[] = [];
  const metrics = await pageMetrics(page);
  const documentWidth = Number(metrics.document_width) || 1;
  const documentHeight = Number(metrics.document_height) || 1;

  for (let index = 0; index < Math.min(focusItems.length, MAX_FOCUS); index++) {
    const focus = focusItems[index];
    const selector = selectorForFocus(focus);
    if (!selector) continue;
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      issues.push(`Requested focus selector was not found: ${selector}`);
      details.push({ label: focus.label || selector, selector, found: false });
      continue;
    }
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await locator.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      issues.push(`Requested focus selector is not visible: ${selector}`);
      details.push({ label: focus.label || selector, selector, found: true, visible: false });
      continue;
    }

    let pairBox: { x: number; y: number; width: number; height: number } | undefined;
    if (focus.pair_selector?.trim()) {
      const pair = page.locator(focus.pair_selector.trim()).first();
      if ((await pair.count()) === 0) {
        issues.push(`Requested paired focus selector was not found: ${focus.pair_selector.trim()}`);
      } else {
        pairBox = (await pair.boundingBox()) ?? undefined;
      }
    }

    const combined = unionRect(box, pairBox);
    const padding = 28;
    const clip = {
      x: Math.max(0, combined.x - padding),
      y: Math.max(0, combined.y - padding),
      width: Math.max(1, Math.min(documentWidth - Math.max(0, combined.x - padding), combined.width + padding * 2)),
      height: Math.max(1, Math.min(documentHeight - Math.max(0, combined.y - padding), combined.height + padding * 2)),
    };
    const outputPath = path.join(outputDir, `focus-${String(index + 1).padStart(2, "0")}.png`);
    await page.screenshot({ path: outputPath, type: "png", clip, animations: "disabled", timeout: timeoutMs });
    paths.push(outputPath);

    const svgBox = await locator.evaluate((element) => {
      const candidate = element as SVGGraphicsElement;
      if (typeof candidate.getBBox !== "function") return null;
      try {
        const value = candidate.getBBox();
        return { x: value.x, y: value.y, width: value.width, height: value.height };
      } catch {
        return null;
      }
    }).catch(() => null);

    details.push({
      label: focus.label || selector,
      selector,
      pair_selector: focus.pair_selector,
      found: true,
      visible: true,
      bounding_box: box,
      pair_bounding_box: pairBox,
      distance_px: pairBox ? rectDistance(box, pairBox) : undefined,
      overlaps_pair: pairBox ? rectDistance(box, pairBox) === 0 : undefined,
      svg_box: svgBox,
      crop_path: outputPath,
    });
  }
  return { paths, details, issues };
}

async function captureBrowserArtifact(
  resolved: ResolvedTarget,
  outputDir: string,
  width: number,
  height: number,
  timeoutMs: number,
  fullPage: boolean,
  focusItems: VisualFocusInput[]
): Promise<BrowserCaptureResult> {
  const browser = await launchVisualBrowser(timeoutMs);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  try {
    return await withVisualDeadline(
      "Visual browser capture",
      browserLifecycleTimeout(timeoutMs),
      async () => {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        page.setDefaultTimeout(timeoutMs);
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text().slice(0, 1000));
        });
        page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 1000)));
        page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`.slice(0, 1000)));
        await page.goto(resolved.target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await waitForVisualStability(page, timeoutMs);
        const metrics = await withVisualDeadline("Visual page metrics", timeoutMs, () => pageMetrics(page));
        const documentHeight = Number(metrics.document_height) || height;
        const documentWidth = Number(metrics.document_width) || width;
        const useFullPage = fullPage && documentHeight <= MAX_RENDER_DIMENSION * 4 && documentWidth <= MAX_RENDER_DIMENSION;
        const overviewPath = path.join(outputDir, "overview.png");
        await page.screenshot({
          path: overviewPath,
          type: "png",
          fullPage: useFullPage,
          animations: "disabled",
          timeout: timeoutMs,
        });
        const selectorFocus = await captureSelectorFocus(page, focusItems, outputDir, timeoutMs);
        const machineIssues = [
          ...pageErrors.map((error) => `Page error: ${error}`),
          ...consoleErrors.map((error) => `Console error: ${error}`),
          ...selectorFocus.issues,
        ];
        const clippedCount = Number(metrics.clipped_element_count) || 0;
        const advisories = [
          ...requestFailures.slice(0, 10).map((failure) => `Request failed: ${failure}`),
          ...(clippedCount > 0 ? [`Detected ${clippedCount} element(s) with clipped/overflowing content.`] : []),
          ...(fullPage && !useFullPage ? ["Full-page capture was bounded because the document exceeded the safe render size."] : []),
        ];
        return {
          overviewPath,
          focusPaths: selectorFocus.paths,
          focusDetails: selectorFocus.details,
          machineIssues,
          advisories,
          diagnostics: {
            ...metrics,
            console_errors: consoleErrors,
            page_errors: pageErrors,
            request_failures: requestFailures,
            full_page_requested: fullPage,
            full_page_captured: useFullPage,
            browser: findVisualBrowserExecutable(),
          },
        };
      },
      () => { void browser.close().catch(() => undefined); }
    );
  } finally {
    await closeVisualBrowser(browser, timeoutMs);
  }
}

async function captureImageArtifact(
  sourcePath: string,
  outputDir: string,
  width: number,
  height: number,
  timeoutMs: number
): Promise<BrowserCaptureResult> {
  const browser = await launchVisualBrowser(timeoutMs);
  try {
    return await withVisualDeadline(
      "Visual image capture",
      browserLifecycleTimeout(timeoutMs),
      async () => {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        page.setDefaultTimeout(timeoutMs);
        const dataUrl = await imageDataUrl(sourcePath);
        await page.setContent(
          `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;background:#eef2f5;display:grid;place-items:center;overflow:hidden}img{display:block;max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img id="artifact" src="${dataUrl}"></body></html>`,
          { waitUntil: "load", timeout: timeoutMs }
        );
        await page.locator("#artifact").waitFor({ state: "visible", timeout: timeoutMs });
        const dimensions = await page.locator("#artifact").evaluate((element) => {
          const image = element as HTMLImageElement;
          return { natural_width: image.naturalWidth, natural_height: image.naturalHeight };
        });
        const overviewPath = path.join(outputDir, "overview.png");
        await page.screenshot({ path: overviewPath, type: "png", animations: "disabled", timeout: timeoutMs });
        return {
          overviewPath,
          focusPaths: [],
          focusDetails: [],
          machineIssues: [],
          advisories: [],
          diagnostics: { ...dimensions, browser: findVisualBrowserExecutable() },
        };
      },
      () => { void browser.close().catch(() => undefined); }
    );
  } finally {
    await closeVisualBrowser(browser, timeoutMs);
  }
}

function estimatePdfPageCount(pdfBytes: Buffer): number {
  const text = pdfBytes.toString("latin1");
  const directPages = (text.match(/\/Type\s*\/Page\b/g) || []).length;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 10000);
  return Math.max(1, directPages, counts.length ? Math.max(...counts) : 1);
}

function normalizePages(requested: number[] | undefined, pageCount: number): number[] {
  const values = requested?.length
    ? requested
    : Array.from({ length: Math.min(pageCount, MAX_PAGES) }, (_, index) => index + 1);
  return [...new Set(values.map((value) => Math.floor(value)).filter((value) => value >= 1 && value <= pageCount))].slice(0, MAX_PAGES);
}

async function renderPdfPages(
  pdfPath: string,
  outputDir: string,
  width: number,
  height: number,
  timeoutMs: number,
  requestedPages?: number[]
): Promise<{
  pagePaths: string[];
  pageMap: Map<number, string>;
  pageCount: number;
  advisories: string[];
  diagnostics: Record<string, unknown>;
}> {
  const pdfBytes = await fs.readFile(pdfPath);
  const pageCount = estimatePdfPageCount(pdfBytes);
  const pages = normalizePages(requestedPages, pageCount);
  const browser = await launchVisualBrowser(timeoutMs);
  const pagePaths: string[] = [];
  const pageMap = new Map<number, string>();
  const errors: string[] = [];
  try {
    for (const pageNumber of pages) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      page.setDefaultTimeout(timeoutMs);
      page.on("pageerror", (error) => errors.push(error.message.slice(0, 1000)));
      const target = `${pathToFileURL(pdfPath).toString()}#page=${pageNumber}&zoom=page-fit`;
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForTimeout(Math.min(1400, Math.max(500, Math.floor(timeoutMs / 20))));
      const outputPath = path.join(outputDir, `page-${String(pageNumber).padStart(3, "0")}.png`);
      const toolbar = Math.min(64, Math.max(0, height - 100));
      await page.screenshot({
        path: outputPath,
        type: "png",
        clip: { x: 0, y: toolbar, width, height: height - toolbar },
        animations: "disabled",
        timeout: timeoutMs,
      });
      pagePaths.push(outputPath);
      pageMap.set(pageNumber, outputPath);
      await page.close();
    }
  } finally {
    await closeVisualBrowser(browser, timeoutMs);
  }
  return {
    pagePaths,
    pageMap,
    pageCount,
    advisories: [
      "PDF pages are captured through the installed Chromium PDF viewer; page-count detection is best-effort for unusual PDFs.",
    ],
    diagnostics: { requested_pages: pages, estimated_page_count: pageCount, page_errors: errors, browser: findVisualBrowserExecutable() },
  };
}

async function officeProcessIds(processName: "WINWORD" | "POWERPNT"): Promise<number[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process ${processName} -ErrorAction SilentlyContinue).Id -join ','`],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }
    );
    return stdout.trim().split(",").map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
  } catch {
    return [];
  }
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }).catch(() => undefined);
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
}

async function cleanupNewOfficeProcesses(processName: "WINWORD" | "POWERPNT", before: number[]): Promise<void> {
  const previous = new Set(before);
  const after = await officeProcessIds(processName);
  for (const pid of after) {
    if (!previous.has(pid)) await terminateProcessTree(pid);
  }
}

async function runPowerShellScript(
  scriptPath: string,
  args: string[],
  timeoutMs: number,
  officeProcessName: "WINWORD" | "POWERPNT",
  allowOfficeRunning: boolean
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "win32") throw new Error("Office rendering currently requires Windows PowerShell automation");
  const before = await officeProcessIds(officeProcessName);
  if (before.length > 0 && !allowOfficeRunning) {
    throw new Error(`${officeProcessName} is already running. Safe Office rendering was skipped to avoid touching the user's open Office session. Close it or set allow_office_running=true.`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await terminateProcessTree(child.pid || 0);
      await cleanupNewOfficeProcesses(officeProcessName, before);
      reject(new Error(`Office renderer timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-100000); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-100000); });
    child.on("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await cleanupNewOfficeProcesses(officeProcessName, before);
      reject(error);
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await cleanupNewOfficeProcesses(officeProcessName, before);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr.trim() || stdout.trim() || `Office renderer exited with code ${code}`));
    });
  });
}

async function exportPptx(
  sourcePath: string,
  outputDir: string,
  width: number,
  height: number,
  timeoutMs: number,
  allowOfficeRunning: boolean
): Promise<string[]> {
  const slideDir = path.join(outputDir, "slides");
  await fs.mkdir(slideDir, { recursive: true });
  const scriptPath = path.join(outputDir, "export-pptx.ps1");
  await fs.writeFile(scriptPath, String.raw`param([string]$InputPath,[string]$OutputDir,[int]$Width,[int]$Height)
$ErrorActionPreference='Stop'
$app=$null
$presentation=$null
try {
  $app=New-Object -ComObject PowerPoint.Application
  $presentation=$app.Presentations.Open($InputPath,$true,$true,$false)
  New-Item -ItemType Directory -Force $OutputDir | Out-Null
  $presentation.Export($OutputDir,'PNG',$Width,$Height)
} finally {
  if($presentation){$presentation.Close()}
  if($app){$app.Quit()}
}
`, "utf-8");
  try {
    await runPowerShellScript(
      scriptPath,
      ["-InputPath", sourcePath, "-OutputDir", slideDir, "-Width", String(width), "-Height", String(height)],
      timeoutMs,
      "POWERPNT",
      allowOfficeRunning
    );
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined);
  }
  const names = (await fs.readdir(slideDir)).filter((name) => /\.png$/i.test(name));
  names.sort((left, right) => {
    const leftNumber = Number.parseInt(left.match(/\d+/)?.[0] || "0", 10);
    const rightNumber = Number.parseInt(right.match(/\d+/)?.[0] || "0", 10);
    return leftNumber - rightNumber || left.localeCompare(right);
  });
  if (names.length === 0) throw new Error("PowerPoint finished without exporting slide images");
  return names.map((name) => path.join(slideDir, name));
}

async function exportDocxToPdf(
  sourcePath: string,
  outputDir: string,
  timeoutMs: number,
  allowOfficeRunning: boolean
): Promise<string> {
  const pdfPath = path.join(outputDir, "document.pdf");
  const scriptPath = path.join(outputDir, "export-docx.ps1");
  await fs.writeFile(scriptPath, String.raw`param([string]$InputPath,[string]$OutputPdf)
$ErrorActionPreference='Stop'
$app=$null
$document=$null
try {
  $app=New-Object -ComObject Word.Application
  $app.Visible=$false
  $app.DisplayAlerts=0
  $document=$app.Documents.Open($InputPath,$false,$true)
  $document.ExportAsFixedFormat($OutputPdf,17)
} finally {
  if($document){$document.Close($false)}
  if($app){$app.Quit()}
}
`, "utf-8");
  try {
    await runPowerShellScript(
      scriptPath,
      ["-InputPath", sourcePath, "-OutputPdf", pdfPath],
      timeoutMs,
      "WINWORD",
      allowOfficeRunning
    );
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined);
  }
  const stat = await fs.stat(pdfPath).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) throw new Error("Word finished without exporting a PDF");
  return pdfPath;
}

async function createContactSheet(imagePaths: string[], outputPath: string, timeoutMs: number): Promise<string> {
  if (imagePaths.length === 1) return imagePaths[0];
  const cards = await Promise.all(imagePaths.slice(0, MAX_PAGES).map(async (imagePath, index) => {
    const dataUrl = await imageDataUrl(imagePath);
    return `<figure><figcaption>Page ${index + 1}</figcaption><img src="${dataUrl}"></figure>`;
  }));
  const browser = await launchVisualBrowser(timeoutMs);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(timeoutMs);
    await page.setContent(
      `<!doctype html><html><head><style>body{margin:0;padding:24px;background:#e9eef2;font:18px sans-serif;color:#243746}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}figure{margin:0;background:white;border-radius:12px;padding:12px;box-shadow:0 3px 14px #0002}figcaption{font-weight:700;margin:0 0 8px}img{display:block;width:100%;height:360px;object-fit:contain;background:#f7f8fa}</style></head><body><div class="grid">${cards.join("")}</div></body></html>`,
      { waitUntil: "load", timeout: timeoutMs }
    );
    await page.screenshot({ path: outputPath, type: "png", fullPage: true, animations: "disabled", timeout: timeoutMs });
    return outputPath;
  } finally {
    await closeVisualBrowser(browser, timeoutMs);
  }
}

async function cropRasterRegions(
  pageMap: Map<number, string>,
  focuses: VisualFocusInput[],
  outputDir: string,
  timeoutMs: number
): Promise<{ paths: string[]; details: Array<Record<string, unknown>>; issues: string[] }> {
  const regionFocus = focuses.filter((focus) => focus.x !== undefined || focus.y !== undefined || focus.width !== undefined || focus.height !== undefined).slice(0, MAX_FOCUS);
  if (regionFocus.length === 0) return { paths: [], details: [], issues: [] };
  const browser = await launchVisualBrowser(timeoutMs);
  const paths: string[] = [];
  const details: Array<Record<string, unknown>> = [];
  const issues: string[] = [];
  try {
    for (let index = 0; index < regionFocus.length; index++) {
      const focus = regionFocus[index];
      const pageNumber = Math.max(1, Math.floor(focus.page || 1));
      const sourcePath = pageMap.get(pageNumber);
      if (!sourcePath) {
        issues.push(`Requested focus page was not rendered: ${pageNumber}`);
        continue;
      }
      const dataUrl = await imageDataUrl(sourcePath);
      const page = await browser.newPage({ viewport: { width: 100, height: 100 }, deviceScaleFactor: 1 });
      page.setDefaultTimeout(timeoutMs);
      await page.setContent(`<html><body style="margin:0"><img id="artifact" style="display:block" src="${dataUrl}"></body></html>`, { waitUntil: "load", timeout: timeoutMs });
      const dimensions = await page.locator("#artifact").evaluate((element) => {
        const image = element as HTMLImageElement;
        return { width: image.naturalWidth, height: image.naturalHeight };
      });
      await page.setViewportSize({ width: Math.max(1, Math.min(MAX_RENDER_DIMENSION, dimensions.width)), height: Math.max(1, Math.min(MAX_RENDER_DIMENSION, dimensions.height)) });
      const ratio = focus.unit !== "px";
      const x = ratio ? (focus.x ?? 0) * dimensions.width : (focus.x ?? 0);
      const y = ratio ? (focus.y ?? 0) * dimensions.height : (focus.y ?? 0);
      const width = ratio ? (focus.width ?? 1) * dimensions.width : (focus.width ?? dimensions.width);
      const height = ratio ? (focus.height ?? 1) * dimensions.height : (focus.height ?? dimensions.height);
      const clip = {
        x: Math.max(0, Math.min(dimensions.width - 1, x)),
        y: Math.max(0, Math.min(dimensions.height - 1, y)),
        width: Math.max(1, Math.min(dimensions.width - Math.max(0, x), width)),
        height: Math.max(1, Math.min(dimensions.height - Math.max(0, y), height)),
      };
      const outputPath = path.join(outputDir, `region-${String(index + 1).padStart(2, "0")}.png`);
      await page.screenshot({ path: outputPath, type: "png", clip, animations: "disabled", timeout: timeoutMs });
      await page.close();
      paths.push(outputPath);
      details.push({ label: focus.label || `Page ${pageNumber} region`, page: pageNumber, unit: focus.unit || "ratio", clip, crop_path: outputPath });
    }
  } finally {
    await closeVisualBrowser(browser, timeoutMs);
  }
  return { paths, details, issues };
}

async function resolveComparisonTarget(
  workspaceRoot: string,
  compareTo: string
): Promise<{ path: string; reviewId?: string }> {
  const trimmed = compareTo.trim();
  if (/^[a-f0-9-]{36}$/i.test(trimmed)) {
    const review = await getVisualReviewRecord(workspaceRoot, trimmed);
    const baseline = review.overview_path || review.output_paths[0];
    if (!baseline) throw new Error(`Visual review ${trimmed} has no preview image`);
    return { path: baseline, reviewId: trimmed };
  }
  return { path: await validatePath(trimmed) };
}

async function createComparison(
  baselinePath: string,
  currentPath: string,
  outputPath: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const before = await imageDataUrl(baselinePath);
  const after = await imageDataUrl(currentPath);
  const browser = await launchVisualBrowser(timeoutMs);
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(timeoutMs);
    await page.setContent(
      `<!doctype html><html><head><style>body{margin:0;padding:22px;background:#e9eef2;font:18px sans-serif;color:#243746}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:white;padding:12px;border-radius:12px}.card h2{margin:0 0 8px;font-size:20px}.card img,.card canvas{display:block;width:100%;height:520px;object-fit:contain;background:#f7f8fa}.diff{grid-column:1/-1}</style></head><body><div class="grid"><section class="card"><h2>Before</h2><img id="before" src="${before}"></section><section class="card"><h2>After</h2><img id="after" src="${after}"></section><section class="card diff"><h2>Pixel difference</h2><canvas id="diff"></canvas></section></div><script>Promise.all([new Promise(r=>before.onload=r),new Promise(r=>after.onload=r)]).then(()=>{const w=Math.max(1,Math.min(before.naturalWidth,after.naturalWidth,1200));const h=Math.max(1,Math.min(before.naturalHeight,after.naturalHeight,800));const a=document.createElement('canvas');const b=document.createElement('canvas');a.width=b.width=diff.width=w;a.height=b.height=diff.height=h;const ac=a.getContext('2d'),bc=b.getContext('2d'),dc=diff.getContext('2d');ac.drawImage(before,0,0,w,h);bc.drawImage(after,0,0,w,h);const ad=ac.getImageData(0,0,w,h),bd=bc.getImageData(0,0,w,h),out=dc.createImageData(w,h);let changed=0,total=0;for(let i=0;i<ad.data.length;i+=4){const d=Math.abs(ad.data[i]-bd.data[i])+Math.abs(ad.data[i+1]-bd.data[i+1])+Math.abs(ad.data[i+2]-bd.data[i+2]);total+=d;if(d>36)changed++;out.data[i]=Math.min(255,d);out.data[i+1]=0;out.data[i+2]=0;out.data[i+3]=255;}dc.putImageData(out,0,0);window.__metrics={width:w,height:h,changed_pixel_ratio:changed/(w*h),mean_absolute_difference:total/(w*h*3)};window.__ready=true;});</script></body></html>`,
      { waitUntil: "load", timeout: timeoutMs }
    );
    await page.waitForFunction(() => (window as Window & { __ready?: boolean }).__ready === true, undefined, { timeout: timeoutMs });
    const metrics = await page.evaluate(() => (window as Window & { __metrics?: Record<string, unknown> }).__metrics || {});
    await page.screenshot({ path: outputPath, type: "png", fullPage: true, animations: "disabled", timeout: timeoutMs });
    return metrics;
  } finally {
    await closeVisualBrowser(browser, timeoutMs);
  }
}

async function renderArtifact(
  resolved: ResolvedTarget,
  kind: VisualArtifactKind,
  outputDir: string,
  input: Required<Pick<VisualReviewInput, "width" | "height" | "timeout_ms" | "full_page" | "allow_office_running">> & Pick<VisualReviewInput, "pages" | "focus">
): Promise<RenderResult> {
  const focus = input.focus || [];
  if (kind === "image") {
    if (!resolved.sourcePath) throw new Error("Image review requires a local file");
    const captured = await captureImageArtifact(resolved.sourcePath, outputDir, input.width, input.height, input.timeout_ms);
    const pageMap = new Map<number, string>([[1, captured.overviewPath]]);
    const regions = await cropRasterRegions(pageMap, focus, outputDir, input.timeout_ms);
    return {
      renderer: "chromium-image",
      overviewPath: captured.overviewPath,
      pagePaths: [captured.overviewPath],
      pageMap,
      focusPaths: regions.paths,
      focusDetails: regions.details,
      machineIssues: regions.issues,
      advisories: captured.advisories,
      diagnostics: captured.diagnostics,
    };
  }

  if (kind === "svg" || kind === "html" || kind === "url") {
    const captured = await captureBrowserArtifact(
      resolved,
      outputDir,
      input.width,
      input.height,
      input.timeout_ms,
      input.full_page,
      focus.filter((item) => Boolean(item.selector))
    );
    const pageMap = new Map<number, string>([[1, captured.overviewPath]]);
    const regions = await cropRasterRegions(pageMap, focus, outputDir, input.timeout_ms);
    return {
      renderer: kind === "svg" ? "playwright-svg" : "playwright-page",
      overviewPath: captured.overviewPath,
      pagePaths: [captured.overviewPath],
      pageMap,
      focusPaths: [...captured.focusPaths, ...regions.paths],
      focusDetails: [...captured.focusDetails, ...regions.details],
      machineIssues: [...captured.machineIssues, ...regions.issues],
      advisories: captured.advisories,
      diagnostics: captured.diagnostics,
    };
  }

  if (!resolved.sourcePath) throw new Error(`${kind.toUpperCase()} review requires a local file`);

  if (kind === "pdf") {
    const rendered = await renderPdfPages(resolved.sourcePath, outputDir, input.width, input.height, input.timeout_ms, input.pages);
    const overviewPath = await createContactSheet(rendered.pagePaths, path.join(outputDir, "overview.png"), input.timeout_ms);
    const regions = await cropRasterRegions(rendered.pageMap, focus, outputDir, input.timeout_ms);
    return {
      renderer: "chromium-pdf-viewer",
      overviewPath,
      pagePaths: rendered.pagePaths,
      pageMap: rendered.pageMap,
      focusPaths: regions.paths,
      focusDetails: regions.details,
      machineIssues: regions.issues,
      advisories: rendered.advisories,
      diagnostics: rendered.diagnostics,
    };
  }

  if (kind === "pptx") {
    const allSlides = await exportPptx(resolved.sourcePath, outputDir, input.width, input.height, input.timeout_ms, input.allow_office_running);
    const selectedPages = normalizePages(input.pages, allSlides.length);
    const pageMap = new Map<number, string>(allSlides.map((slide, index) => [index + 1, slide]));
    const pagePaths = selectedPages.map((pageNumber) => pageMap.get(pageNumber)!).filter(Boolean);
    const overviewPath = await createContactSheet(pagePaths, path.join(outputDir, "overview.png"), input.timeout_ms);
    const regions = await cropRasterRegions(pageMap, focus, outputDir, input.timeout_ms);
    return {
      renderer: "powerpoint-com",
      overviewPath,
      pagePaths,
      pageMap,
      focusPaths: regions.paths,
      focusDetails: regions.details,
      machineIssues: regions.issues,
      advisories: [],
      diagnostics: { page_count: allSlides.length, reviewed_pages: selectedPages },
    };
  }

  const pdfPath = await exportDocxToPdf(resolved.sourcePath, outputDir, input.timeout_ms, input.allow_office_running);
  const rendered = await renderPdfPages(pdfPath, outputDir, input.width, input.height, input.timeout_ms, input.pages);
  const overviewPath = await createContactSheet(rendered.pagePaths, path.join(outputDir, "overview.png"), input.timeout_ms);
  const regions = await cropRasterRegions(rendered.pageMap, focus, outputDir, input.timeout_ms);
  return {
    renderer: "word-com-to-pdf-to-chromium",
    overviewPath,
    pagePaths: rendered.pagePaths,
    pageMap: rendered.pageMap,
    focusPaths: regions.paths,
    focusDetails: regions.details,
    machineIssues: regions.issues,
    advisories: rendered.advisories,
    diagnostics: { ...rendered.diagnostics, exported_pdf: pdfPath },
  };
}

export async function performVisualReview(workspaceRoot: string, input: VisualReviewInput): Promise<VisualReviewExecution> {
  const resolved = await resolveTarget(input.target);
  const kind = detectKind(resolved, input.kind);
  const width = clampInteger(input.width, kind === "svg" ? 1200 : 1440, 320, 2400);
  const height = clampInteger(input.height, kind === "svg" ? 800 : 1000, 240, 1800);
  const timeoutMs = clampInteger(input.timeout_ms, 30_000, 1_000, 120_000);
  const maxImages = clampInteger(input.max_images, 12, 1, 12);
  const outputDir = await createOutputDirectory(workspaceRoot, input.output_dir);
  const signatureBefore = resolved.sourcePath ? await fileSignature(resolved.sourcePath) : undefined;
  const rendered = await renderArtifact(resolved, kind, outputDir, {
    width,
    height,
    timeout_ms: timeoutMs,
    full_page: Boolean(input.full_page),
    allow_office_running: Boolean(input.allow_office_running),
    pages: input.pages,
    focus: input.focus?.slice(0, MAX_FOCUS),
  });

  let comparisonPath: string | undefined;
  let comparisonMetrics: Record<string, unknown> | undefined;
  let baselineReviewId: string | undefined;
  if (input.compare_to?.trim()) {
    const baseline = await resolveComparisonTarget(workspaceRoot, input.compare_to);
    comparisonPath = path.join(outputDir, "comparison.png");
    comparisonMetrics = await createComparison(baseline.path, rendered.overviewPath, comparisonPath, timeoutMs);
    baselineReviewId = baseline.reviewId;
  }

  const signature = resolved.sourcePath ? await fileSignature(resolved.sourcePath) : undefined;
  if (signatureBefore && signature && signatureBefore.signature !== signature.signature) {
    rendered.machineIssues.push("Source changed while the visual review was rendering; rerun visual_review on the stable final source.");
  }
  const outputPaths = [...new Set([
    rendered.overviewPath,
    ...rendered.pagePaths,
    ...rendered.focusPaths,
    ...(comparisonPath ? [comparisonPath] : []),
  ])];
  const pagedArtifact = kind === "pdf" || kind === "pptx" || kind === "docx";
  const preferredPaths = [...new Set(pagedArtifact
    ? [
        ...rendered.pagePaths,
        rendered.overviewPath,
        ...rendered.focusPaths,
        ...(comparisonPath ? [comparisonPath] : []),
      ]
    : [
        rendered.overviewPath,
        ...rendered.focusPaths,
        ...(comparisonPath ? [comparisonPath] : []),
      ])].slice(0, maxImages);
  const images: VisualImagePayload[] = [];
  let returnedImageBytes = 0;
  for (let index = 0; index < preferredPaths.length; index++) {
    const imagePath = preferredPaths[index];
    const { bytes, mimeType } = await readImage(imagePath);
    if (images.length > 0 && returnedImageBytes + bytes.length > MAX_TOTAL_RETURN_IMAGE_BYTES) continue;
    images.push({
      path: imagePath,
      label: imagePath === rendered.overviewPath
        ? (pagedArtifact ? "overview/contact sheet" : "full render")
        : imagePath === comparisonPath
          ? "before-after comparison"
          : path.basename(imagePath),
      bytes,
      mime_type: mimeType,
    });
    returnedImageBytes += bytes.length;
  }

  const pageCount = pagedArtifact
    ? Math.max(1, Number(rendered.diagnostics.page_count ?? rendered.diagnostics.estimated_page_count) || rendered.pageMap.size || 1)
    : 1;
  const renderedPages = pagedArtifact ? [...rendered.pageMap.keys()].sort((a, b) => a - b) : [1];
  const deliveredPages = pagedArtifact
    ? [...rendered.pageMap.entries()]
        .filter(([, pagePath]) => images.some((image) => image.path === pagePath))
        .map(([pageNumber]) => pageNumber)
        .sort((a, b) => a - b)
    : (images.length > 0 ? [1] : []);

  const record = await saveVisualReviewRecord(workspaceRoot, {
    target: resolved.label,
    kind,
    renderer: rendered.renderer,
    source_path: resolved.sourcePath,
    source_signature: signature?.signature,
    source_size: signature?.size,
    source_mtime_ms: signature?.mtime_ms,
    overview_path: rendered.overviewPath,
    output_paths: outputPaths,
    page_paths: rendered.pagePaths,
    page_count: pageCount,
    rendered_pages: renderedPages,
    delivered_pages: deliveredPages,
    focus_paths: rendered.focusPaths,
    comparison_path: comparisonPath,
    baseline_review_id: baselineReviewId,
    machine_blocking_issues: rendered.machineIssues,
    machine_advisories: rendered.advisories,
    diagnostics: {
      ...rendered.diagnostics,
      focus: rendered.focusDetails,
      comparison: comparisonMetrics,
    },
  });
  const freshness = await getVisualReviewFreshness(workspaceRoot, record.id);

  return {
    data: {
      review_id: record.id,
      target: resolved.label,
      kind,
      renderer: rendered.renderer,
      visual_status: rendered.machineIssues.length === 0 ? "rendered_current" : "rendered_with_blocking_issues",
      render_status: rendered.machineIssues.length === 0 ? "clean" : "blocked",
      model_visual_status: "pending",
      model_visual_assessment_required: true,
      model_visual_instruction: `Inspect every returned full render/page image with model vision. Do not infer visual quality from machine_blocking_issues. Then call visual_review action=assess with this review_id and inspected_full_render=true. If compare pixels are returned, judge whether the new version improved, regressed, or stayed unchanged. Record strengths and whether another improvement iteration is worthwhile. Before setting further_improvement_worthwhile=false, judge the current artifact independently of how much it improved over the prior version: improvement versus before is not proof that the current version is finished. If a clear worthwhile visual improvement remains and the iteration budget is not exhausted, revise the real source and use compare_to=<prior review_id> for the next review. The universal visual loop is capped at ${MAX_VISUAL_ITERATIONS} iterations for every supported artifact kind; reaching the cap stops autonomous refinement but never bypasses fail, machine-blocking, page-coverage, or source-freshness gates. For paged artifacts, continue with recommended_next_pages until model_visual_coverage.complete is true.`,
      source_signature: signature?.signature,
      overview_path: rendered.overviewPath,
      output_paths: outputPaths,
      page_paths: rendered.pagePaths,
      page_count: pageCount,
      rendered_pages: renderedPages,
      delivered_pages: deliveredPages,
      model_visual_coverage: freshness.model_visual_coverage,
      recommended_next_pages: freshness.model_visual_coverage.missing_pages.slice(0, MAX_PAGES),
      focus_paths: rendered.focusPaths,
      comparison_path: comparisonPath,
      machine_blocking_issues: rendered.machineIssues,
      machine_advisories: rendered.advisories,
      diagnostics: record.diagnostics,
      images_returned: images.map((image) => ({ path: image.path, label: image.label, mime_type: image.mime_type, bytes: image.bytes.length })),
      images_not_returned: outputPaths.filter((candidate) => !images.some((image) => image.path === candidate)),
      returned_image_bytes: returnedImageBytes,
      return_image_byte_limit: MAX_TOTAL_RETURN_IMAGE_BYTES,
    },
    images,
  };
}