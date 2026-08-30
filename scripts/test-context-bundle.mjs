import assert from "node:assert/strict";
import path from "node:path";
import { buildContextMap, selectRelevantContext } from "../dist/lib/context-bundle.js";

const root = path.resolve("D:/fixture-project");
const files = [
  {
    path: path.join(root, "AGENTS.md"),
    bytes: 900,
    truncated: false,
    content: `# Project map

## Architecture
Keep HTTP handlers thin and put business logic in services.

## Release workflow
Run the focused tests, update CHANGELOG.md, create the release tag, and verify CI artifacts.

## Authentication
OAuth secrets must never be printed in logs.
`,
  },
  {
    path: path.join(root, "README.md"),
    bytes: 700,
    truncated: false,
    content: `# Example

## Local development
Run npm install and npm run dev.

## Vector rendering
Render SVG to PNG, inspect the image, then fix geometry and clipping before delivery.
`,
  },
];

const map = buildContextMap(root, files);
assert.equal(map.length, 2);
assert.equal(map[0].relative_path, "AGENTS.md");
assert.ok(map[0].headings.some((heading) => heading.text === "Release workflow"));

const release = selectRelevantContext(root, files, "prepare release changelog tag and verify CI", {
  maxTotalBytes: 4_000,
  maxChunks: 4,
});
assert.ok(release.chunks.some((chunk) => chunk.heading === "Release workflow"));
assert.ok(!release.chunks.some((chunk) => chunk.heading === "Authentication"));
assert.ok(release.total_bytes <= 4_000);
assert.ok(release.files.length <= files.length);

const vector = selectRelevantContext(root, files, "矢量图渲染后检查几何和裁切", {
  maxTotalBytes: 4_000,
  maxChunks: 4,
});
assert.ok(vector.chunks.some((chunk) => chunk.heading === "Vector rendering"));

console.log("context-bundle: map, English relevance, Chinese relevance, and byte budget OK");