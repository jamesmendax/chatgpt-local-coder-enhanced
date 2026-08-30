import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.CHATGPT_TOOL_PROFILE = "slim";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const overridesPath = path.join(root, "profiles", "tool-overrides.json");
const previousOverrides = await fs.readFile(overridesPath, "utf-8").catch(() => null);

try {
  await fs.writeFile(overridesPath, "{}\n", "utf-8");
  const { getRuntimeManifest } = await import(`../dist/lib/runtime-manifest.js?test=${Date.now()}`);
  const manifest = getRuntimeManifest();
  assert.equal(manifest.tool_profile, "slim");
  assert.equal(manifest.tool_count, 27);
  assert.ok(manifest.tool_names.includes("visual_review"));
  assert.ok(manifest.tool_names.includes("rewind"));
  assert.ok(!manifest.tool_names.includes("open_image"));
  assert.equal(manifest.stale_build, false);
  assert.match(manifest.build_id, /^[a-f0-9]{16}$/);
  assert.match(manifest.tool_manifest_hash, /^[a-f0-9]{64}$/);
  console.log(`runtime-manifest: build=${manifest.build_id} tools=${manifest.tool_count} hash=${manifest.tool_manifest_hash.slice(0, 12)} OK`);
} finally {
  if (previousOverrides === null) await fs.rm(overridesPath, { force: true });
  else await fs.writeFile(overridesPath, previousOverrides, "utf-8");
}