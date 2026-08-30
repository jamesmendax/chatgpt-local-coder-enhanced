---
name: visual-qa
description: Close the visual feedback loop for SVG, web UI, charts, documents, slides, and other rendered artifacts by returning real images to the model and iterating from what is actually visible.
---
# Visual QA loop

Use this skill whenever correctness depends on how an artifact actually looks, not only whether its source parses or its build succeeds.

## Core rule

Never treat "file exists", "XML is valid", "export succeeded", or "browser exit code is 0" as proof of visual quality.

The model must inspect pixels before declaring a visual artifact finished.

## Preferred tool

Use `visual_review(target)` for images, SVG, HTML/URLs, PDF, PPTX, and DOCX. It returns the overview image, optional focus crops, geometry/runtime diagnostics, and a freshness-tracked `review_id`.

For every meaningful visual revision, modify the source artifact and call `visual_review` again with `compare_to=<prior review_id>`. Fix source files, never the generated preview.

## Review order

Inspect in this order so high-impact problems are fixed first:

1. missing/incorrect content;
2. geometry, overlap, clipping, and alignment;
3. hierarchy, scale, whitespace, and composition;
4. typography and readability;
5. minor polish.

For HTML and interactive UI, `visual_review` also reports console errors, page errors, request failures, overflow, and clipping signals.

## Iterative improvement loop

After inspecting the real rendered pixels, separate two questions:

1. Is the current version acceptable, or does it contain a blocking visual problem (`verdict=pass|fail`)?
2. Even if acceptable, is another revision visibly worthwhile (`further_improvement_worthwhile=true|false`)?

When comparison pixels are returned, explicitly judge `comparison=improved|unchanged|regressed`. If the new version improved, record concrete `strengths` as the positive signal. If another meaningful gain is still visible, record concrete `improvement_opportunities`, keep `further_improvement_worthwhile=true`, revise the source, and compare again.

Do not use fixed visual-domain checklists as the definition of quality. Let the model's multimodal inspection judge the artifact in the context of the user's actual request. Before setting `further_improvement_worthwhile=false`, inspect the current render on its own merits; do not confuse "better than the previous version" with "finished". Stop early when the current version passes, full required coverage is complete, and another revision is no longer worthwhile.

The same loop applies to every supported visual artifact, not just SVG or illustration. The universal autonomous visual-iteration budget is **5 total visual versions/review iterations** (initial version plus at most four further revisions). While the current iteration is below 5, a passing artifact with `further_improvement_worthwhile=true` must be revised again. At iteration 5, autonomous refinement stops even if the model can still identify theoretical improvements. The hard cap only stops further polishing: it never overrides a failed visual verdict, machine blocking issues, incomplete page coverage, or stale source evidence.

## SVG-specific rule

For genuine vector deliverables, validate that the SVG does not merely embed a raster `<image>` unless the user explicitly allows it. Use selector and paired-selector focus requests for important spatial relationships.
