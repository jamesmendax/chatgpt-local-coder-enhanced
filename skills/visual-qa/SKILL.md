---
name: visual-qa
description: Close the visual feedback loop for SVG, web UI, charts, documents, slides, and other rendered artifacts by returning real images to the model and iterating from what is actually visible.
---
# Visual QA loop

Use this skill whenever correctness depends on how an artifact actually looks, not only whether its source parses or its build succeeds.

## Core rule

Never treat "file exists", "XML is valid", "export succeeded", or "browser exit code is 0" as proof of visual quality.

The model must inspect pixels before declaring a visual artifact finished, but pixel inspection alone is not enough. A creator can see real defects and still rationalize them as acceptable because it is trying to finish the task. The universal quality gate therefore separates **semantic/task correctness** from **finished-product visual quality** and does not allow a self-reported PASS to grant delivery by itself.

## Preferred tool

Use `visual_review(target)` for images, SVG, HTML/URLs, PDF, PPTX, and DOCX. It returns the overview image, optional focus crops, geometry/runtime diagnostics, and a freshness-tracked `review_id`.

Each review chain locks a universal `quality_bar` before judging pixels:

- `draft`: only for an explicitly requested rough draft, wireframe, sketch, or exploratory result;
- `standard`: default finished-product bar;
- `polished`: explicit premium/high-end/polished/final-presentation requests.

Once pixels in a chain have been inspected, never lower its quality bar to make a weak result pass.

For every meaningful visual revision, modify the source artifact and call `visual_review` again with `compare_to=<prior review_id>`. Fix source files, never the generated preview.

## Review order

Inspect in this order so high-impact problems are fixed first:

1. missing/incorrect content;
2. geometry, overlap, clipping, and alignment;
3. hierarchy, scale, whitespace, and composition;
4. typography and readability;
5. minor polish.

For HTML and interactive UI, `visual_review` also reports console errors, page errors, request failures, overflow, and clipping signals.

## Critic -> Judge -> server gate

After inspecting every returned full render/page image, **do not jump straight to PASS**.

First call `visual_review(action=critique)` on the exact `review_id`. The Critic is an external-reviewer pass with no PASS authority. Ignore creator effort, elapsed work, Goal completion pressure, and the fact that the artifact merely renders or is recognizable. Record:

- `first_impression=rough|acceptable|polished`;
- `delivery_recommendation=reject|revise|accept`;
- six 1-5 scores: task fidelity, composition, visual hierarchy, coherence, craft precision, and professional readiness;
- critical/major/minor issues;
- strengths;
- concrete high-value `improvement_opportunities`;
- `further_improvement_worthwhile=true|false`.

Calibrate all six scores strictly and consistently:

- **1** = broken / unacceptable;
- **2** = weak;
- **3** = competent but visibly rough or unfinished;
- **4** = solid finished/presentable work you would hand to the user unchanged;
- **5** = exceptional.

Do not award 4+ merely because the artifact is recognizable, complete, technically valid, or improved over a prior version. `delivery_recommendation=accept` means you would actually deliver this exact visible version unchanged at the locked quality bar.

Use `improvement_opportunities` only for changes that are genuinely worth another revision. Put low-value optional polish in `minor_issues`. Reporting concrete worthwhile improvements while also saying no further improvement is worthwhile is contradictory and must fail closed.

Then call `visual_review(action=assess)` for semantic/task correctness and, when present, the before/after comparison verdict. The model's semantic `verdict=pass` is **not** the finished-product quality decision. The server-calculated quality gate must also be acceptable, required page coverage complete, source fresh, machine checks clean, and no required refinement remain before visual evidence may verify completion.

This makes the two questions explicit:

1. Does the visible artifact actually satisfy the requested task semantically?
2. Is it visually good enough to hand to the user as the requested level of finished product?

Both must pass.

## Iterative improvement loop

When comparison pixels are returned, explicitly judge `comparison=improved|unchanged|regressed`. If the new version improved, record concrete `strengths` as the positive signal. If the Critic finds another meaningful gain is still visible, keep `further_improvement_worthwhile=true`, revise the real source, and compare again.

Do not use fixed visual-domain checklists as the definition of quality. The six quality dimensions are universal calibration dimensions, not style prescriptions. Judge the artifact in the context of the user's actual request. Do not confuse "better than the previous version", "recognizable", "technically valid", or "not visibly broken" with "finished".

The same loop applies to every supported visual artifact, not just SVG or illustration. The universal autonomous visual-iteration budget is **5 total visual versions/review iterations** (initial version plus at most four further revisions). While the current iteration is below 5, a quality-acceptable artifact with a concrete worthwhile improvement must be revised again. At iteration 5, autonomous refinement stops even if low-value/theoretical improvements remain. The hard cap only stops further polishing: it never converts a failed server quality gate, failed semantic verdict, machine blocking issue, incomplete page coverage, or stale source into PASS.

## Goal evidence rule

For GoalRun work, `visual_review(action=assess)` is criterion-verifying model evidence only when the server returns all of:

- semantic/task verdict PASS;
- `model_visual_quality_status=ready`;
- `model_visual_iteration_ready=true`.

A self-authored `verdict=pass` alone is never sufficient visual completion evidence.

## SVG-specific rule

For genuine vector deliverables, validate that the SVG does not merely embed a raster `<image>` unless the user explicitly allows it. Use selector and paired-selector focus requests for important spatial relationships.
