import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import { performVisualReview } from "../lib/visual-harness.js";
import { assessVisualReviewRecord, getVisualReviewFreshness, MAX_VISUAL_ITERATIONS } from "../lib/visual-review-state.js";

const focusSchema = z.object({
  label: z.string().max(120).optional(),
  selector: z.string().max(500).optional(),
  pair_selector: z.string().max(500).optional(),
  page: z.number().int().min(1).max(500).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  unit: z.enum(["ratio", "px"]).optional().default("ratio"),
});

function visualReviewResult(data: Record<string, unknown>, images: Array<{ bytes: Buffer; mime_type: string; label: string; path: string }>) {
  const payload = {
    ok: true,
    tool: "visual_review",
    summary: `visual_review: ${String(data.target || "done")}`,
    data,
  };
  return {
    content: [
      ...images.flatMap((image) => [
        { type: "image" as const, data: image.bytes.toString("base64"), mimeType: image.mime_type },
        { type: "text" as const, text: `${image.label}: ${image.path}` },
      ]),
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}

export function registerVisualReviewTool(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "visual_review",
    {
      title: "Universal Visual Review",
      description:
        `Render an image, SVG, HTML/URL, PDF, PPTX, or DOCX and return the real rendered pixels directly to the model. Machine diagnostics are auxiliary only. After inspecting the returned full render/page images, call action=assess with the same review_id. Assessment records whether the artifact is acceptable and whether another improvement iteration is worthwhile. This is one universal visual loop for every supported artifact kind, with a hard autonomous cap of ${MAX_VISUAL_ITERATIONS} visual iterations.`,
      inputSchema: {
        action: z.enum(["review", "status", "assess"]).optional().default("review"),
        target: z.string().min(1).optional(),
        review_id: z.string().uuid().optional(),
        verdict: z.enum(["pass", "fail"]).optional(),
        inspected_full_render: z.boolean().optional(),
        issues: z.array(z.string().min(1).max(1000)).max(30).optional(),
        comparison: z.enum(["improved", "unchanged", "regressed", "not_compared"]).optional(),
        strengths: z.array(z.string().min(1).max(1000)).max(30).optional(),
        improvement_opportunities: z.array(z.string().min(1).max(1000)).max(30).optional(),
        further_improvement_worthwhile: z.boolean().optional().describe(`Judge the current rendered artifact on its own merits, not merely by whether it improved versus the prior version. Set true whenever a clear, worthwhile visual improvement remains. Set false only when another revision would be low-value. Be truthful even on iteration ${MAX_VISUAL_ITERATIONS}; the harness applies the hard iteration cap separately.`),
        assessment_summary: z.string().max(4000).optional(),
        kind: z.enum(["auto", "image", "svg", "html", "url", "pdf", "pptx", "docx"]).optional().default("auto"),
        output_dir: z.string().optional(),
        width: z.number().int().min(320).max(2400).optional(),
        height: z.number().int().min(240).max(1800).optional(),
        pages: z.array(z.number().int().min(1).max(500)).max(12).optional(),
        focus: z.array(focusSchema).max(8).optional(),
        compare_to: z.string().optional().describe("Prior review_id or local preview image"),
        full_page: z.boolean().optional().default(false),
        max_images: z.number().int().min(1).max(12).optional().default(12),
        timeout_ms: z.number().int().min(1000).max(120000).optional().default(30000),
        allow_office_running: z.boolean().optional().default(false),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ action, target, review_id, verdict, inspected_full_render, issues, comparison, strengths, improvement_opportunities, further_improvement_worthwhile, assessment_summary, ...options }) => {
      try {
        if (action === "status") {
          if (!review_id) throw new Error("visual_review action=status requires review_id");
          const freshness = await getVisualReviewFreshness(workspaceRoot, review_id);
          return toolResult("visual_review", { action, ...freshness }, { summary: freshness.reason });
        }
        if (action === "assess") {
          if (!review_id) throw new Error("visual_review action=assess requires review_id");
          if (!verdict) throw new Error("visual_review action=assess requires verdict=pass|fail");
          if (inspected_full_render !== true) {
            throw new Error("visual_review action=assess requires inspected_full_render=true after the model has actually inspected the returned full render/page images.");
          }
          const record = await assessVisualReviewRecord(workspaceRoot, review_id, {
            verdict,
            inspected_full_render: true,
            issues,
            comparison,
            strengths,
            improvement_opportunities,
            further_improvement_worthwhile,
            summary: assessment_summary,
          });
          const freshness = await getVisualReviewFreshness(workspaceRoot, review_id);
          return toolResult("visual_review", {
            action,
            review_id,
            target: record.target,
            kind: record.kind,
            source_signature: record.source_signature,
            render_status: record.machine_blocking_issues.length === 0 ? "clean" : "blocked",
            model_visual_status: record.model_visual_assessment?.verdict ?? "pending",
            model_visual_quality_status: freshness.model_visual_quality_status,
            model_visual_iteration_ready: freshness.model_visual_iteration_ready,
            model_visual_assessment: record.model_visual_assessment,
            model_visual_coverage: freshness.model_visual_coverage,
            model_visual_iteration: freshness.model_visual_iteration,
            recommended_next_pages: freshness.model_visual_coverage.missing_pages.slice(0, 12),
            machine_blocking_issues: record.machine_blocking_issues,
            fresh: freshness.fresh,
          }, { summary: `visual assessment: ${record.model_visual_assessment?.verdict ?? "pending"}` });
        }
        if (!target?.trim()) throw new Error("visual_review action=review requires target");
        const result = await performVisualReview(workspaceRoot, { target, ...options });
        return visualReviewResult(result.data, result.images);
      } catch (error) {
        return toolError("visual_review", error instanceof Error ? error.message : String(error));
      }
    }
  );
}