import type { VisualReviewFreshness } from "./visual-review-state.js";

/** Make the next operation explicit; operation success is not delivery readiness. */
export function visualDeliveryFeedback(state: VisualReviewFreshness): Record<string, unknown> {
  const record = state.record;
  const ready = state.fresh && state.machine_ready && state.model_visual_ready &&
    state.model_visual_iteration_ready && state.model_visual_coverage.complete;
  const review = { tool: "visual_review", arguments: { action: "review", target: record.target, compare_to: record.id, quality_bar: record.quality_bar ?? "standard" } };
  let action = "complete_visual_verification";
  let next: unknown = null;
  if (!state.fresh) {
    action = "review_current_source";
    next = review;
  } else if (!state.machine_ready || state.model_visual_quality_gate.status === "failed" || state.model_visual_status === "fail") {
    action = state.model_visual_iteration.limit_reached ? "report_unmet_quality_at_iteration_limit" : "repair_artifact_then_review";
    next = state.model_visual_iteration.limit_reached
      ? { target: record.target, review_id: record.id, report: "Describe unmet requirements; do not claim completion or start another review iteration." }
      : { edit_target: record.target, after_edit: review };
  } else if (!record.model_visual_critique) {
    action = "inspect_images_then_critique";
    next = { tool: "visual_review", arguments: { action: "critique", review_id: record.id }, supply_after_inspection: ["inspected_full_render", "quality_scores", "first_impression", "delivery_recommendation", "critical_issues", "major_issues", "minor_issues", "further_improvement_worthwhile"] };
  } else if (state.model_visual_status === "pending") {
    action = "assess";
    next = { tool: "visual_review", arguments: { action: "assess", review_id: record.id }, supply_after_inspection: ["verdict", "inspected_full_render", "issues"] };
  } else if (!state.model_visual_coverage.complete) {
    action = "review_missing_pages";
    next = { tool: "visual_review", arguments: { ...review.arguments, pages: state.model_visual_coverage.missing_pages.slice(0, 12) } };
  } else if (state.model_visual_iteration.continuation_required) {
    action = "repair_artifact_then_review";
    next = { edit_target: record.target, after_edit: review };
  }
  return {
    delivery_ready: ready,
    assessment_source: "calling_model_self_report",
    independent_quality_verified: false,
    next_required_action: action,
    next_action: next,
    repair_focus: [...new Set([
      ...record.machine_blocking_issues,
      ...(record.model_visual_critique?.critical_issues ?? []),
      ...(record.model_visual_critique?.major_issues ?? []),
      ...(state.model_visual_quality_gate.reasons ?? []),
      ...state.model_visual_iteration.improvement_opportunities,
    ])].slice(0, 12),
  };
}
