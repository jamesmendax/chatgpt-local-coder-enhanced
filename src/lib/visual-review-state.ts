import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type VisualArtifactKind = "image" | "svg" | "html" | "url" | "pdf" | "pptx" | "docx";

export type VisualAssessmentVerdict = "pass" | "fail";
export type VisualComparisonVerdict = "improved" | "unchanged" | "regressed" | "not_compared";
export const MAX_VISUAL_ITERATIONS = 5;

export interface ModelVisualAssessment {
  verdict: VisualAssessmentVerdict;
  inspected_full_render: true;
  issues: string[];
  comparison: VisualComparisonVerdict;
  strengths: string[];
  improvement_opportunities: string[];
  further_improvement_worthwhile: boolean;
  summary?: string;
  assessed_at: string;
  source_signature?: string;
}

export interface VisualReviewRecord {
  version: 1 | 2 | 3;
  id: string;
  target: string;
  kind: VisualArtifactKind;
  renderer: string;
  source_path?: string;
  source_signature?: string;
  source_size?: number;
  source_mtime_ms?: number;
  overview_path?: string;
  output_paths: string[];
  page_paths: string[];
  page_count?: number;
  rendered_pages?: number[];
  delivered_pages?: number[];
  focus_paths: string[];
  comparison_path?: string;
  baseline_review_id?: string;
  machine_blocking_issues: string[];
  machine_advisories: string[];
  model_visual_assessment?: ModelVisualAssessment;
  diagnostics: Record<string, unknown>;
  created_at: string;
}

export interface VisualReviewFreshness {
  review_id: string;
  fresh: boolean;
  verifiable: boolean;
  machine_ready: boolean;
  model_visual_ready: boolean;
  model_visual_iteration_ready: boolean;
  model_visual_status: "pending" | VisualAssessmentVerdict;
  model_visual_quality_status: "pending" | "failed" | "improvable" | "ready";
  model_visual_coverage: {
    page_count: number;
    passed_pages: number[];
    missing_pages: number[];
    complete: boolean;
  };
  model_visual_iteration: {
    current_iteration: number;
    max_iterations: number;
    limit_reached: boolean;
    further_improvement_worthwhile: boolean;
    continuation_required: boolean;
    termination_reason: "continue" | "no_worthwhile_improvement" | "max_iterations_reached";
    review_ids: string[];
    improvement_opportunities: string[];
  };
  reason: string;
  record: VisualReviewRecord;
  current_signature?: string;
}

async function siblingReviewRecords(workspaceRoot: string): Promise<VisualReviewRecord[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(visualReviewDir(workspaceRoot))).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name));
  } catch {
    return [];
  }
  const records: VisualReviewRecord[] = [];
  for (const name of names) {
    try {
      records.push(JSON.parse(await fs.readFile(path.join(visualReviewDir(workspaceRoot), name), "utf-8")) as VisualReviewRecord);
    } catch {}
  }
  return records;
}

function pagesForRecord(record: VisualReviewRecord): number[] {
  if (record.delivered_pages?.length) return record.delivered_pages;
  if (!record.page_count || record.page_count <= 1) return [1];
  return [];
}

async function modelVisualCoverage(workspaceRoot: string, record: VisualReviewRecord): Promise<VisualReviewFreshness["model_visual_coverage"]> {
  const pageCount = Math.max(1, Math.floor(record.page_count || 1));
  const passed = new Set<number>();
  const candidates = record.source_signature
    ? (await siblingReviewRecords(workspaceRoot)).filter((candidate) =>
        candidate.target === record.target &&
        candidate.source_signature === record.source_signature
      )
    : [record];
  for (const candidate of candidates) {
    if (candidate.machine_blocking_issues.length > 0 || candidate.model_visual_assessment?.verdict !== "pass") continue;
    for (const pageNumber of pagesForRecord(candidate)) {
      if (Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount) passed.add(pageNumber);
    }
  }
  const passedPages = [...passed].sort((a, b) => a - b);
  const missingPages = Array.from({ length: pageCount }, (_, index) => index + 1).filter((pageNumber) => !passed.has(pageNumber));
  return {
    page_count: pageCount,
    passed_pages: passedPages,
    missing_pages: missingPages,
    complete: missingPages.length === 0,
  };
}

async function modelVisualIterationState(
  workspaceRoot: string,
  record: VisualReviewRecord
): Promise<VisualReviewFreshness["model_visual_iteration"]> {
  const candidates = record.source_signature
    ? (await siblingReviewRecords(workspaceRoot)).filter((candidate) =>
        candidate.target === record.target &&
        candidate.source_signature === record.source_signature
      )
    : [record];
  const improvable = candidates.filter((candidate) =>
    candidate.machine_blocking_issues.length === 0 &&
    candidate.model_visual_assessment?.verdict === "pass" &&
    candidate.model_visual_assessment.further_improvement_worthwhile === true
  );
  const opportunities = [...new Set(improvable.flatMap((candidate) =>
    candidate.model_visual_assessment?.improvement_opportunities ?? []
  ))].slice(0, 30);
  const allRecords = await siblingReviewRecords(workspaceRoot);
  const byId = new Map(allRecords.map((candidate) => [candidate.id, candidate]));
  const chain: VisualReviewRecord[] = [];
  const seen = new Set<string>();
  let cursor: VisualReviewRecord | undefined = record;
  while (cursor && !seen.has(cursor.id) && chain.length < 100) {
    chain.push(cursor);
    seen.add(cursor.id);
    if (!cursor.baseline_review_id) break;
    const baseline = byId.get(cursor.baseline_review_id);
    if (!baseline || baseline.target !== record.target) break;
    cursor = baseline;
  }
  chain.reverse();
  let currentIteration = 0;
  let previousVersionKey: string | undefined;
  for (const candidate of chain) {
    const versionKey = candidate.source_signature
      ? `source:${candidate.source_signature}`
      : `review:${candidate.id}`;
    if (versionKey !== previousVersionKey) {
      currentIteration += 1;
      previousVersionKey = versionKey;
    }
  }
  currentIteration = Math.max(1, currentIteration);
  const limitReached = currentIteration >= MAX_VISUAL_ITERATIONS;
  const furtherImprovementWorthwhile = improvable.length > 0;
  const continuationRequired = furtherImprovementWorthwhile && !limitReached;
  return {
    current_iteration: currentIteration,
    max_iterations: MAX_VISUAL_ITERATIONS,
    limit_reached: limitReached,
    further_improvement_worthwhile: furtherImprovementWorthwhile,
    continuation_required: continuationRequired,
    termination_reason: continuationRequired
      ? "continue"
      : limitReached
        ? "max_iterations_reached"
        : "no_worthwhile_improvement",
    review_ids: improvable.map((candidate) => candidate.id),
    improvement_opportunities: opportunities,
  };
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

export function visualReviewDir(workspaceRoot: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", projectSlug(workspaceRoot), "visual-reviews");
}

function reviewPath(workspaceRoot: string, reviewId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(reviewId)) throw new Error("Invalid visual review_id");
  return path.join(visualReviewDir(workspaceRoot), `${reviewId}.json`);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await fs.rename(temporary, filePath);
}

export async function fileSignature(filePath: string): Promise<{
  signature: string;
  size: number;
  mtime_ms: number;
}> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("Visual review source is not a regular file");
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return {
    signature: hash.digest("hex"),
    size: stat.size,
    mtime_ms: stat.mtimeMs,
  };
}

export async function saveVisualReviewRecord(
  workspaceRoot: string,
  input: Omit<VisualReviewRecord, "version" | "id" | "created_at">
): Promise<VisualReviewRecord> {
  const record: VisualReviewRecord = {
    version: 3,
    id: randomUUID(),
    ...input,
    created_at: new Date().toISOString(),
  };
  await atomicWriteJson(reviewPath(workspaceRoot, record.id), record);
  return record;
}

export async function assessVisualReviewRecord(
  workspaceRoot: string,
  reviewId: string,
  input: {
    verdict: VisualAssessmentVerdict;
    inspected_full_render: true;
    issues?: string[];
    comparison?: VisualComparisonVerdict;
    strengths?: string[];
    improvement_opportunities?: string[];
    further_improvement_worthwhile?: boolean;
    summary?: string;
  }
): Promise<VisualReviewRecord> {
  const record = await getVisualReviewRecord(workspaceRoot, reviewId);
  const issues = (input.issues ?? []).map((issue) => issue.trim()).filter(Boolean).slice(0, 30);
  const strengths = (input.strengths ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 30);
  const improvementOpportunities = (input.improvement_opportunities ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 30);
  const summary = input.summary?.trim().slice(0, 4000) || undefined;
  const comparison: VisualComparisonVerdict = input.comparison ?? "not_compared";
  const hasComparisonEvidence = Boolean(record.comparison_path);
  if (input.verdict === "fail" && issues.length === 0) {
    throw new Error("A failed visual assessment must include at least one concrete visual issue.");
  }
  if (hasComparisonEvidence && comparison === "not_compared") {
    throw new Error("This review includes before-after comparison pixels. Inspect them and submit comparison=improved|unchanged|regressed.");
  }
  if (!hasComparisonEvidence && comparison !== "not_compared") {
    throw new Error("comparison can only be improved|unchanged|regressed when this review includes comparison pixels. Use comparison=not_compared otherwise.");
  }
  if (comparison === "improved" && strengths.length === 0) {
    throw new Error("An improved comparison must include at least one concrete strength describing what visibly improved.");
  }
  if (input.verdict === "pass" && typeof input.further_improvement_worthwhile !== "boolean") {
    throw new Error("A passing visual assessment must explicitly state further_improvement_worthwhile=true|false after inspecting the pixels.");
  }
  if (input.verdict === "pass" && input.further_improvement_worthwhile === true && improvementOpportunities.length === 0) {
    throw new Error("When further_improvement_worthwhile=true, include at least one concrete improvement_opportunity for the next iteration.");
  }
  if (input.verdict === "pass" && record.machine_blocking_issues.length > 0) {
    throw new Error("Cannot pass model visual assessment while machine blocking issues remain.");
  }
  if (input.verdict === "pass" && record.model_visual_assessment?.verdict === "fail") {
    throw new Error("A failed visual assessment cannot be reclassified as pass on the same rendered pixels. Revise the artifact and run visual_review again to obtain a new review_id.");
  }
  if (
    input.verdict === "pass" &&
    input.further_improvement_worthwhile === false &&
    record.model_visual_assessment?.further_improvement_worthwhile === true
  ) {
    throw new Error("This exact rendered review was already assessed as having worthwhile visual improvement remaining. Revise the artifact and run visual_review again instead of marking the same pixels as finished.");
  }
  if (input.verdict === "pass" && record.source_signature) {
    const siblings = await siblingReviewRecords(workspaceRoot);
    const priorFailed = siblings.find((candidate) =>
      candidate.id !== record.id &&
      candidate.target === record.target &&
      candidate.source_signature === record.source_signature &&
      candidate.model_visual_assessment?.verdict === "fail"
    );
    if (priorFailed) {
      throw new Error("Cannot pass visual assessment because this exact source version was previously assessed as failed. Revise the artifact so its source signature changes, then run visual_review again.");
    }
    if (input.further_improvement_worthwhile === false) {
      const currentPages = new Set(pagesForRecord(record));
      const priorImprovable = siblings.find((candidate) =>
        candidate.id !== record.id &&
        candidate.target === record.target &&
        candidate.source_signature === record.source_signature &&
        candidate.model_visual_assessment?.verdict === "pass" &&
        candidate.model_visual_assessment.further_improvement_worthwhile === true &&
        pagesForRecord(candidate).some((pageNumber) => currentPages.has(pageNumber))
      );
      if (priorImprovable) {
        throw new Error("Cannot mark the same source pixels as visually finished because an overlapping review already found worthwhile improvement. Revise the artifact so its source signature changes, then compare and assess the new version.");
      }
    }
  }

  if (record.source_path && record.source_signature) {
    const current = await fileSignature(record.source_path);
    if (current.signature !== record.source_signature) {
      throw new Error("Cannot assess a stale visual review. Run visual_review again on the current source first.");
    }
  }

  const next: VisualReviewRecord = {
    ...record,
    version: 3,
    model_visual_assessment: {
      verdict: input.verdict,
      inspected_full_render: true,
      issues,
      comparison,
      strengths,
      improvement_opportunities: improvementOpportunities,
      further_improvement_worthwhile: input.verdict === "pass" ? input.further_improvement_worthwhile! : true,
      ...(summary ? { summary } : {}),
      assessed_at: new Date().toISOString(),
      ...(record.source_signature ? { source_signature: record.source_signature } : {}),
    },
  };
  await atomicWriteJson(reviewPath(workspaceRoot, reviewId), next);
  return next;
}

export async function getVisualReviewRecord(workspaceRoot: string, reviewId: string): Promise<VisualReviewRecord> {
  return JSON.parse(await fs.readFile(reviewPath(workspaceRoot, reviewId), "utf-8")) as VisualReviewRecord;
}

export async function getVisualReviewFreshness(
  workspaceRoot: string,
  reviewId: string
): Promise<VisualReviewFreshness> {
  const record = await getVisualReviewRecord(workspaceRoot, reviewId);
  const machineReady = record.machine_blocking_issues.length === 0;
  const modelVisualStatus = record.model_visual_assessment?.verdict ?? "pending";
  const coverage = await modelVisualCoverage(workspaceRoot, record);
  const iteration = await modelVisualIterationState(workspaceRoot, record);
  const modelVisualReady = modelVisualStatus === "pass" && coverage.complete;
  const modelVisualIterationReady = modelVisualReady && !iteration.continuation_required;
  const modelVisualQualityStatus: VisualReviewFreshness["model_visual_quality_status"] =
    modelVisualStatus === "pending"
      ? "pending"
      : modelVisualStatus === "fail"
        ? "failed"
        : iteration.continuation_required
          ? "improvable"
          : "ready";

  if (!record.source_path || !record.source_signature) {
    return {
      review_id: record.id,
      fresh: true,
      verifiable: false,
      machine_ready: machineReady,
      model_visual_ready: modelVisualReady,
      model_visual_iteration_ready: modelVisualIterationReady,
      model_visual_status: modelVisualStatus,
      model_visual_quality_status: modelVisualQualityStatus,
      model_visual_coverage: coverage,
      model_visual_iteration: iteration,
      reason: "Live/remote target has no stable local source signature; task mutation time must be used as the freshness guard.",
      record,
    };
  }

  try {
    const current = await fileSignature(record.source_path);
    const fresh = current.signature === record.source_signature;
    return {
      review_id: record.id,
      fresh,
      verifiable: true,
      machine_ready: machineReady,
      model_visual_ready: modelVisualReady,
      model_visual_iteration_ready: modelVisualIterationReady,
      model_visual_status: modelVisualStatus,
      model_visual_quality_status: modelVisualQualityStatus,
      model_visual_coverage: coverage,
      model_visual_iteration: iteration,
      reason: fresh ? "Reviewed source signature is current." : "Source changed after the visual review.",
      record,
      current_signature: current.signature,
    };
  } catch (error) {
    return {
      review_id: record.id,
      fresh: false,
      verifiable: true,
      machine_ready: machineReady,
      model_visual_ready: modelVisualReady,
      model_visual_iteration_ready: modelVisualIterationReady,
      model_visual_status: modelVisualStatus,
      model_visual_quality_status: modelVisualQualityStatus,
      model_visual_coverage: coverage,
      model_visual_iteration: iteration,
      reason: `Reviewed source is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      record,
    };
  }
}