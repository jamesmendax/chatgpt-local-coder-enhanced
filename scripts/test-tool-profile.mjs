/**
 * Verify slim tool profile exposes expected tools only.
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { LOCAL_TOOL_CATALOG, SLIM_CHATGPT_TOOLS, shouldExposeTool } from "../dist/lib/tool-profile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  if (SLIM_CHATGPT_TOOLS.size < 18) throw new Error(`slim set too small: ${SLIM_CHATGPT_TOOLS.size}`);
  ok(`slim profile has ${SLIM_CHATGPT_TOOLS.size} tools`);

  for (const t of [
    "apply_patch", "glob", "remember", "load_path_rules",
    "read_file_base64", "file_info", "write_file_base64", "save_chatgpt_file",
    "create_directory", "copy_file", "move_file", "delete_file",
    "shell_reset", "process_status", "process_output", "stop_process", "clear_processes",
  ]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("core tools exposed in slim");

  if (shouldExposeTool("mcp_call", "slim")) throw new Error("mcp_call should be hidden in slim");
  if (shouldExposeTool("delete_directory", "slim")) throw new Error("delete_directory hidden");
  ok("heavy tools hidden in slim");

  if (!shouldExposeTool("mcp_call", "full")) throw new Error("full should expose all");
  ok("full profile exposes all");

  const srcDir = path.join(root, "src");
  const stack = [srcDir];
  const registered = new Set();
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const text = await fs.readFile(full, "utf8");
        for (const match of text.matchAll(/registerTool\(\s*\r?\n?\s*"([^"]+)"/g)) {
          registered.add(match[1]);
        }
      }
    }
  }
  const missing = [...registered].filter((name) => !LOCAL_TOOL_CATALOG.includes(name)).sort();
  if (missing.length) throw new Error(`LOCAL_TOOL_CATALOG missing: ${missing.join(", ")}`);
  ok(`tool catalog covers all ${registered.size} statically registered tools`);
} catch (e) {
  fail("tool profile", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);