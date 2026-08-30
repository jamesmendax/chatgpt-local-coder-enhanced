import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.CHATGPT_TOOL_PROFILE = "slim";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "visual-review");
const workspace = path.join(tmpRoot, "workspace");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });

const svgPath = path.join(workspace, "relationship.svg");
const initialSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
  <rect width="640" height="400" fill="#f5f7fa"/>
  <circle id="left" cx="180" cy="200" r="82" fill="#3b82f6"/>
  <circle id="right" cx="460" cy="200" r="82" fill="#f59e0b"/>
  <path id="connector" d="M262 200H378" stroke="#1f2937" stroke-width="18" stroke-linecap="round"/>
</svg>`;
await fs.writeFile(svgPath, initialSvg, "utf-8");

const htmlPath = path.join(workspace, "page.html");
await fs.writeFile(
  htmlPath,
  `<!doctype html><html><head><title>Visual harness</title><style>
  body{margin:0;background:#eef2f7;font:24px sans-serif}.hero{margin:40px;padding:32px;background:white;border-radius:18px}
  .card{width:320px;height:140px;background:#22c55e;display:grid;place-items:center;color:white;border-radius:14px}
  </style></head><body><main class="hero"><h1>Universal review</h1><div id="card" class="card">Rendered UI</div></main></body></html>`,
  "utf-8"
);

const pngPath = path.join(workspace, "pixel.png");
await fs.writeFile(
  pngPath,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlTtGQAAAAASUVORK5CYII=", "base64")
);

const { createMcpServer } = await import("../dist/server-factory.js");
const { findVisualBrowserExecutable } = await import("../dist/lib/visual-harness.js");
const server = createMcpServer(workspace, 30_000, [workspace], true);
const client = new Client({ name: "visual-review-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

function data(result) {
  if (!result?.structuredContent?.ok) throw new Error(JSON.stringify(result?.structuredContent || result));
  return result.structuredContent.data;
}

function imageBlocks(result) {
  return (result.content || []).filter((block) => block.type === "image");
}

try {
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  if (!names.has("visual_review")) throw new Error("visual_review missing from slim");
  const visualTool = listed.tools.find((tool) => tool.name === "visual_review");
  const visualProperties = visualTool?.inputSchema?.properties || {};
  for (const field of ["comparison", "strengths", "improvement_opportunities", "further_improvement_worthwhile"]) {
    if (!(field in visualProperties)) throw new Error(`visual_review V3 schema field missing: ${field}`);
  }
  if (names.has("open_image") || names.has("render_svg") || names.has("capture_webpage")) {
    throw new Error("legacy visual primitives should stay hidden in slim");
  }

  const reviewed = await client.callTool({
    name: "visual_review",
    arguments: {
      target: svgPath,
      width: 640,
      height: 400,
      focus: [{ label: "circle relationship", selector: "#left", pair_selector: "#right" }],
      max_images: 4,
    },
  });
  const first = data(reviewed);
  if (first.kind !== "svg" || !first.review_id) throw new Error("SVG review metadata missing");
  if (first.visual_status !== "rendered_current" || first.model_visual_status !== "pending") throw new Error("new render/semantic status split missing");
  if (reviewed.content?.[0]?.type !== "image") throw new Error("full render pixels are not the first tool content block");
  if (imageBlocks(reviewed).length < 2) throw new Error("SVG review did not return overview and focus pixels");
  const focus = first.diagnostics?.focus?.[0];
  if (!focus?.found || !(focus.distance_px > 0) || !focus.crop_path) throw new Error("selector geometry/focus crop missing");
  if (first.machine_blocking_issues.length !== 0) throw new Error(`unexpected SVG issue: ${first.machine_blocking_issues.join("; ")}`);

  const fresh = data(await client.callTool({
    name: "visual_review",
    arguments: { action: "status", review_id: first.review_id },
  }));
  if (!fresh.fresh || !fresh.verifiable || !fresh.machine_ready || fresh.model_visual_ready || fresh.model_visual_status !== "pending") throw new Error("fresh review status invalid");

  const html = await client.callTool({
    name: "visual_review",
    arguments: { target: htmlPath, width: 900, height: 600, focus: [{ selector: "#card" }], full_page: true },
  });
  const htmlData = data(html);
  if (htmlData.kind !== "html" || htmlData.diagnostics.page_errors.length !== 0 || htmlData.diagnostics.console_errors.length !== 0) {
    throw new Error("HTML runtime diagnostics invalid");
  }
  if (imageBlocks(html).length < 2) throw new Error("HTML review did not return focus image");

  const slowFontServer = http.createServer((req, res) => {
    if (req.url === "/never.woff2") return;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><style>@font-face{font-family:Never;src:url('/never.woff2') format('woff2')}body{font-family:Never,sans-serif;font-size:48px}</style></head><body>bounded visual timeout</body></html>`);
  });
  await new Promise((resolve, reject) => {
    slowFontServer.once("error", reject);
    slowFontServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = slowFontServer.address();
    if (!address || typeof address === "string") throw new Error("slow-font test server did not bind");
    const startedAt = Date.now();
    const boundedReview = await client.callTool({
      name: "visual_review",
      arguments: { target: `http://127.0.0.1:${address.port}/`, width: 640, height: 400, timeout_ms: 1000 },
    });
    const elapsed = Date.now() - startedAt;
    if (elapsed > 8000) throw new Error(`visual_review timeout watchdog exceeded bound: ${elapsed}ms`);
    const boundedPayload = boundedReview.structuredContent;
    if (boundedPayload?.ok !== true && boundedPayload?.ok !== false) throw new Error("bounded visual review returned no stable tool envelope");
  } finally {
    slowFontServer.closeAllConnections?.();
    await new Promise((resolve) => slowFontServer.close(() => resolve()));
  }

  const imageReview = await client.callTool({ name: "visual_review", arguments: { target: pngPath, width: 640, height: 400 } });
  if (data(imageReview).kind !== "image" || imageBlocks(imageReview).length !== 1) throw new Error("image review failed");

  const browserPath = findVisualBrowserExecutable();
  if (!browserPath) throw new Error("test requires installed Edge/Chrome/Chromium");
  const pdfPath = path.join(workspace, "document.pdf");
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--disable-gpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.setContent('<main style="font:36px sans-serif;padding:60px"><h1>PDF visual review</h1><p>Page rendering evidence.</p></main>');
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
  const pdfReview = await client.callTool({ name: "visual_review", arguments: { target: pdfPath, pages: [1], width: 1000, height: 1000 } });
  const pdfData = data(pdfReview);
  if (pdfData.kind !== "pdf" || pdfData.page_paths.length !== 1 || imageBlocks(pdfReview).length < 1) throw new Error("PDF review failed");

  const task = data(await client.callTool({
    name: "task_state",
    arguments: { action: "create", goal: "Verify stale visual review enforcement", visual_required: true },
  }));
  const taskId = task.handoff.task_id;
  const taskReview = data(await client.callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400 },
  }));
  await client.callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: taskReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      further_improvement_worthwhile: false,
      assessment_summary: "Initial render inspected for stale-source guard test.",
    },
  });
  await client.callTool({
    name: "write_file",
    arguments: { path: svgPath, content: initialSvg.replace("#3b82f6", "#8b5cf6") },
  });
  const staleComplete = await client.callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (staleComplete.structuredContent?.ok !== false || !JSON.stringify(staleComplete).includes("Source changed")) {
    throw new Error("stale visual review did not block completion");
  }

  const finalReviewResult = await client.callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400, compare_to: taskReview.review_id, max_images: 3 },
  });
  const finalReview = data(finalReviewResult);
  if (!finalReview.comparison_path || !(finalReview.diagnostics.comparison.changed_pixel_ratio > 0)) {
    throw new Error("before-after comparison evidence missing");
  }
  if (imageBlocks(finalReviewResult).length < 2) throw new Error("comparison pixels not returned");

  const pendingComplete = await client.callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (pendingComplete.structuredContent?.ok !== false || !JSON.stringify(pendingComplete).includes("semantically inspected")) {
    throw new Error("unassessed rendered pixels did not block completion");
  }

  await client.callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: finalReview.review_id,
      verdict: "fail",
      inspected_full_render: true,
      issues: ["Seeded visual issue for completion-gate test"],
      comparison: "regressed",
    },
  });
  const failedAssessmentComplete = await client.callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (failedAssessmentComplete.structuredContent?.ok !== false || !JSON.stringify(failedAssessmentComplete).includes("model visual assessment failed")) {
    throw new Error("failed model visual assessment did not block completion");
  }

  const reclassify = await client.callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: finalReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["Seeded comparison evidence"],
      further_improvement_worthwhile: false,
    },
  });
  if (reclassify.structuredContent?.ok !== false || !JSON.stringify(reclassify).includes("cannot be reclassified")) {
    throw new Error("failed render could be reclassified without a fresh visual review");
  }

  await client.callTool({
    name: "write_file",
    arguments: { path: svgPath, content: initialSvg.replace("#3b82f6", "#10b981") },
  });
  const improvableReview = data(await client.callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400, compare_to: finalReview.review_id, max_images: 3 },
  }));
  const improvableAssessment = data(await client.callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: improvableReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["The new version visibly improves the seeded color treatment."],
      improvement_opportunities: ["One more deliberate visual refinement remains worthwhile."],
      further_improvement_worthwhile: true,
      assessment_summary: "Fresh full render and comparison inspected; acceptable, improved, but still worth one more iteration.",
    },
  }));
  if (improvableAssessment.model_visual_assessment.comparison !== "improved" || improvableAssessment.model_visual_assessment.further_improvement_worthwhile !== true) {
    throw new Error("V3 improvement assessment fields were not persisted");
  }
  if (improvableAssessment.model_visual_iteration.current_iteration !== 3 || improvableAssessment.model_visual_iteration.max_iterations !== 5 || improvableAssessment.model_visual_iteration.limit_reached) {
    throw new Error("V3 visual iteration state did not report iteration 3 of 5 correctly");
  }
  if (!improvableAssessment.model_visual_iteration.continuation_required || improvableAssessment.model_visual_iteration.termination_reason !== "continue") {
    throw new Error("worthwhile improvement before iteration 5 did not require continuation");
  }
  const improvableComplete = await client.callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (improvableComplete.structuredContent?.ok !== false || !JSON.stringify(improvableComplete).includes("iteration 4 of 5")) {
    throw new Error("improvable passing visual review did not block final completion");
  }
  const skipIteration = await client.callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: improvableReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["The new version visibly improves the seeded color treatment."],
      further_improvement_worthwhile: false,
    },
  });
  if (skipIteration.structuredContent?.ok !== false) {
    throw new Error("same rendered pixels could erase a worthwhile-improvement decision without revision");
  }

  await client.callTool({
    name: "write_file",
    arguments: { path: svgPath, content: initialSvg.replace("#3b82f6", "#14b8a6") },
  });
  const passedReview = data(await client.callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400, compare_to: improvableReview.review_id, max_images: 3 },
  }));
  const passedAssessment = data(await client.callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: passedReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["The follow-up version is visibly cleaner than the prior accepted version."],
      improvement_opportunities: ["A final bounded refinement remains worthwhile before the hard cap."],
      further_improvement_worthwhile: true,
      assessment_summary: "Fresh full render and comparison inspected; the fourth visual version is improved but still worth one final bounded refinement.",
    },
  }));
  if (passedAssessment.model_visual_assessment.comparison !== "improved" || passedAssessment.model_visual_assessment.further_improvement_worthwhile !== true) {
    throw new Error("iteration 4 did not preserve worthwhile improvement state");
  }
  if (passedAssessment.model_visual_iteration.current_iteration !== 4 || passedAssessment.model_visual_iteration.limit_reached || !passedAssessment.model_visual_iteration.continuation_required) {
    throw new Error("iteration 4 should still require continuation when worthwhile improvement remains");
  }
  const fourthComplete = await client.callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (fourthComplete.structuredContent?.ok !== false || !JSON.stringify(fourthComplete).includes("iteration 5 of 5")) {
    throw new Error("iteration 4 worthwhile improvement did not block completion before the cap");
  }

  await client.callTool({
    name: "write_file",
    arguments: { path: svgPath, content: initialSvg.replace("#3b82f6", "#0f766e") },
  });
  const cappedReview = data(await client.callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400, compare_to: passedReview.review_id, max_images: 3 },
  }));
  const cappedAssessment = data(await client.callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: cappedReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["The fifth bounded version visibly improves the prior treatment."],
      improvement_opportunities: ["A theoretical sixth polish could exist, but autonomous refinement must stop at the configured cap."],
      further_improvement_worthwhile: true,
      assessment_summary: "The fifth visual version still has theoretical improvement potential, but the universal autonomous iteration cap has been reached.",
    },
  }));
  const cappedIteration = cappedAssessment.model_visual_iteration;
  if (cappedIteration.current_iteration !== 5 || cappedIteration.max_iterations !== 5 || !cappedIteration.limit_reached) {
    throw new Error("visual iteration cap did not report iteration 5 of 5");
  }
  if (cappedIteration.continuation_required || cappedIteration.termination_reason !== "max_iterations_reached") {
    throw new Error("iteration 5 should stop autonomous continuation even when improvement remains worthwhile");
  }
  if (cappedAssessment.model_visual_quality_status !== "ready" || !cappedAssessment.model_visual_iteration_ready) {
    throw new Error("passing iteration 5 did not become delivery-ready under the hard cap");
  }
  const completed = data(await client.callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } }));
  if (!completed.deliverable_ready || completed.handoff.status !== "completed") throw new Error("iteration 5 hard cap did not allow a passing fresh covered artifact to complete");

  const multiPagePath = path.join(workspace, "multi-page.pdf");
  const multiPageBrowser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--disable-gpu"] });
  try {
    const page = await multiPageBrowser.newPage({ viewport: { width: 900, height: 600 } });
    const sections = Array.from({ length: 14 }, (_, index) => `<section style="break-after:page;height:900px;font:42px sans-serif;padding:70px"><h1>Visual page ${index + 1}</h1></section>`).join("");
    await page.setContent(`<html><body style="margin:0">${sections}</body></html>`);
    await page.pdf({ path: multiPagePath, width: "900px", height: "1100px", printBackground: true });
  } finally {
    await multiPageBrowser.close();
  }
  const batchOne = data(await client.callTool({ name: "visual_review", arguments: { target: multiPagePath, width: 900, height: 1000, max_images: 12 } }));
  if (batchOne.page_count < 14 || batchOne.delivered_pages.length !== 12 || batchOne.delivered_pages[0] !== 1 || batchOne.delivered_pages[11] !== 12) {
    throw new Error(`paged visual review did not return the first consecutive batch: ${JSON.stringify(batchOne.delivered_pages)}`);
  }
  const batchOneAssessment = data(await client.callTool({
    name: "visual_review",
    arguments: { action: "assess", review_id: batchOne.review_id, verdict: "pass", inspected_full_render: true, further_improvement_worthwhile: false, assessment_summary: "Inspected all first-batch page images." },
  }));
  if (batchOneAssessment.model_visual_coverage.complete || !batchOneAssessment.model_visual_coverage.missing_pages.includes(13)) {
    throw new Error("partial multi-page visual coverage was incorrectly marked complete");
  }
  const batchTwo = data(await client.callTool({ name: "visual_review", arguments: { target: multiPagePath, pages: [13, 14], width: 900, height: 1000, max_images: 12 } }));
  const batchTwoAssessment = data(await client.callTool({
    name: "visual_review",
    arguments: { action: "assess", review_id: batchTwo.review_id, verdict: "pass", inspected_full_render: true, further_improvement_worthwhile: false, assessment_summary: "Inspected the remaining full page images." },
  }));
  if (!batchTwoAssessment.model_visual_coverage.complete || batchTwoAssessment.model_visual_coverage.passed_pages.length < 14) {
    throw new Error("multi-page visual coverage did not accumulate across review batches");
  }

  console.log(`visual-review: direct pixels, semantic gate, iterative improvement loop, full multi-page coverage, SVG/HTML/image/PDF, comparison, freshness, and task completion guard OK (${listed.tools.length} slim tools)`);
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await fs.rm(tmpRoot, { recursive: true, force: true });
}