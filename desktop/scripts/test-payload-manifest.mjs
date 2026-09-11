import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MANIFEST_NAME, validatePayload } = require("../src/payload-manifest.js");
const root = path.resolve(process.env.HARNESS_TEST_TMP_ROOT || path.join(os.tmpdir(), "chatgpt-web-harness"), `.codex-tmp`, `payload-manifest-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
const harness = path.join(root, "harness");

const files = {
  "dist/index.js": "index\n",
  "dist/lib/plugin-config.js": "plugin\n",
  "dist/lib/skill-installer.js": "installer\n",
  "dist/lib/skill-resolver.js": "resolver\n",
  "node_modules/express/package.json": "{}\n",
  "package.json": "{\"type\":\"module\"}\n",
  "profiles/mcp-upstream.json": "{\"version\":1,\"servers\":[]}\n",
  "profiles/plugins.json": "{\"schema_version\":2,\"skills\":[]}\n",
};

async function writeManifest() {
  const entries = Object.entries(files).map(([file, content]) => ({
    path: file,
    bytes: Buffer.byteLength(content),
  })).sort((a, b) => a.path.localeCompare(b.path));
  await fs.writeFile(path.join(harness, MANIFEST_NAME), JSON.stringify({
    schema_version: 1,
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  }, null, 2) + "\n", "utf8");
}

try {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(harness, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  await writeManifest();
  assert.deepEqual(validatePayload(harness), {
    file_count: Object.keys(files).length,
    total_bytes: Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0),
  });
  await fs.rm(path.join(harness, "dist", "lib", "plugin-config.js"));
  assert.throws(() => validatePayload(harness), /解包不完整|缺少文件|关键运行模块/);
  console.log("PASS payload manifest rejects an incomplete extracted tree");
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
