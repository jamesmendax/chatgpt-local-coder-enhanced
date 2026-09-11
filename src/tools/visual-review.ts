import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import { performVisualReview } from "../lib/visual-harness.js";
import { visualDeliveryFeedback } from "../lib/visual-feedback.js";
import {
  assessVisualReviewRecord,
  critiqueVisualReviewRecord,
  getVisualReviewFreshness,
  MAX_VISUAL_ITERATIONS,
} from "../lib/visual-review-state.js";

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

const qualityScoresSchema = z.object({
  task_fidelity: z.number().min(1).max(5),
  composition: z.number().min(1).max(5),
  visual_hierarchy: z.number().min(1).max(5),
  coherence: z.number().min(1).max(5),
  craft_precision: z.number().min(1).max(5),
  professional_readiness: z.number().min(1).max(5),
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
      title: "Visual Review",
      description:
        `Inspect appearance of SVG/images, web pages, PDF, PPTX or DOCX. review returns pixels; critique records your inspection; assess checks readiness. Follow next_required_action: failed quality requires edits and a new review. Scores are caller assessments. Max ${MAX_VISUAL_ITERATIONS} versions.`,
      inputSchema: {
        action: z.enum(["review", "status", "critique", "assess"]).optional().default("review"),
        target: z.string().min(1).optional(),
        review_id: z.string().min(1).optional(),
        quality_bar: z.enum(["draft", "standard", "polished"]).optional(),
        verdict: z.enum(["pass", "fail"]).optional(),
        inspected_full_render: z.boolean().optional(),
        issues: z.array(z.string().min(1).max(1000)).max(30).optional(),
        first_impression: z.enum(["rough", "acceptable", "polished"]).optional(),
        delivery_recommendation: z.enum(["reject", "revise", "accept"]).optional(),
        quality_scores: qualityScoresSchema.optional(),
        critical_issues: z.array(z.string()).max(30).optional(),
        major_issues: z.array(z.string()).max(30).optional(),
        minor_issues: z.array(z.string()).max(30).optional(),
        comparison: z.enum(["improved", "unchanged", "regressed", "not_compared"]).optional(),
        strengths: z.array(z.string().min(1).max(1000)).max(30).optional(),
        improvement_opportunities: z.array(z.string().min(1).max(1000)).max(30).optional(),
        further_improvement_worthwhile: z.boolean().optional(),
        assessment_summary: z.string().max(4000).optional(),
        kind: z.enum(["auto", "image", "svg", "html", "url", "pdf", "pptx", "docx"]).optional().default("auto"),
        output_dir: z.string().optional(),
        width: z.number().int().min(320).max(2400).optional(),
        height: z.number().int().min(240).max(1800).optional(),
        pages: z.array(z.number().int().min(1).max(500)).max(12).optional(),
        focus: z.array(focusSchema).max(8).optional(),
        compare_to: z.string().optional(),
        full_page: z.boolean().optional().default(false),
        max_images: z.number().int().min(1).max(12).optional().default(12),
        timeout_ms: z.number().int().min(1000).max(120000).optional().default(30000),
        allow_office_running: z.boolean().optional().default(false),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ action, target, review_id, quality_bar, verdict, inspected_full_render, issues, first_impression, delivery_recommendation, quality_scores, critical_issues, major_issues, minor_issues, comparison, strengths, improvement_opportunities, further_improvement_worthwhile, assessment_summary, ...options }) => {
      try {
        if (action === "status") {
          if (!review_id) throw new Error("visual_review action=status requires review_id");
          const freshness = await getVisualReviewFreshness(workspaceRoot, review_id);
          return toolResult("visual_review", { action, ...freshness, ...visualDeliveryFeedback(freshness) }, { summary: freshness.reason });
        }
        if (action === "critique") {
          if (!review_id) throw new Error("visual_review action=critique requires review_id");
          if (inspected_full_render !== true) {
            throw new Error("visual_review action=critique requires inspected_full_render=true after the model has actually inspected every returned full render/page image.");
          }
          if (!first_impression) throw new Error("visual_review action=critique requires first_impression=rough|acceptable|polished");
          if (!delivery_recommendation) throw new Error("visual_review action=critique requires delivery_recommendation=reject|revise|accept");
          if (!quality_scores) throw new Error("visual_review action=critique requires quality_scores across all universal quality dimensions");
          if (typeof further_improvement_worthwhile !== "boolean") {
            throw new Error("visual_review action=critique requires further_improvement_worthwhile=true|false");
          }
          const record = await critiqueVisualReviewRecord(workspaceRoot, review_id, {
            inspected_full_render: true,
            first_impression,
            delivery_recommendation,
            quality_scores,
            critical_issues,
            major_issues,
            minor_issues,
            strengths,
            improvement_opportunities,
            further_improvement_worthwhile,
            summary: assessment_summary,
          });
          const freshness = await getVisualReviewFreshness(workspaceRoot, review_id);
          const feedback = visualDeliveryFeedback(freshness);
          return toolResult("visual_review", {
            action,
            ...feedback,
            review_id,
            target: record.target,
            kind: record.kind,
            quality_bar: record.quality_bar ?? "standard",
            source_signature: record.source_signature,
            model_visual_critique: record.model_visual_critique,
            model_visual_quality_gate: freshness.model_visual_quality_gate,
            model_visual_quality_status: freshness.model_visual_quality_status,
            model_visual_iteration: freshness.model_visual_iteration,
            machine_blocking_issues: record.machine_blocking_issues,
            fresh: freshness.fresh,
          }, { summary: `visual critique: delivery_ready=false; next=${feedback.next_required_action}; quality=${freshness.model_visual_quality_gate.status}` });
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
          const feedback = visualDeliveryFeedback(freshness);
          return toolResult("visual_review", {
            action,
            ...feedback,
            review_id,
            target: record.target,
            kind: record.kind,
            quality_bar: record.quality_bar ?? "standard",
            source_signature: record.source_signature,
            render_status: record.machine_blocking_issues.length === 0 ? "clean" : "blocked",
            machine_ready: freshness.machine_ready,
            verifiable: freshness.verifiable,
            model_visual_ready: freshness.model_visual_ready,
            model_visual_status: record.model_visual_assessment?.verdict ?? "pending",
            model_visual_semantic_status: record.model_visual_assessment?.verdict ?? "pending",
            model_visual_quality_status: freshness.model_visual_quality_status,
            model_visual_quality_gate: freshness.model_visual_quality_gate,
            model_visual_iteration_ready: freshness.model_visual_iteration_ready,
            model_visual_critique: record.model_visual_critique,
            model_visual_assessment: record.model_visual_assessment,
            model_visual_coverage: freshness.model_visual_coverage,
            model_visual_iteration: freshness.model_visual_iteration,
            recommended_next_pages: freshness.model_visual_coverage.missing_pages.slice(0, 12),
            machine_blocking_issues: record.machine_blocking_issues,
            fresh: freshness.fresh,
          }, { summary: `visual assessment: delivery_ready=${feedback.delivery_ready}; next=${feedback.next_required_action}; quality=${freshness.model_visual_quality_status}` });
        }
        if (!target?.trim()) throw new Error("visual_review action=review requires target");
        const result = await performVisualReview(workspaceRoot, { target, quality_bar, ...options });
        const freshness = await getVisualReviewFreshness(workspaceRoot, String(result.data.review_id));
        return visualReviewResult({ ...result.data, ...visualDeliveryFeedback(freshness) }, result.images);
      } catch (error) {
        return toolError("visual_review", error instanceof Error ? error.message : String(error));
      }
    }
  );
}
