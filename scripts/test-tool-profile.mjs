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
  if (SLIM_CHATGPT_TOOLS.size !== 27) throw new Error(`expected 27 slim tools, got ${SLIM_CHATGPT_TOOLS.size}`);
  ok(`slim profile has ${SLIM_CHATGPT_TOOLS.size} tools`);

  for (const t of [
    "read_text_file", "apply_patch", "glob", "grep", "remember",
    "read_file_base64", "file_info", "write_file_base64", "save_chatgpt_file",
    "run_command", "shell_status", "start_process", "process_status", "process_output", "stop_process",
    "git_status", "git_diff", "project_context", "list_skills", "load_skill",
    "goal", "task_state", "visual_review", "rewind",
  ]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("core tools exposed in slim");

  if (shouldExposeTool("ponytail_turn", "slim")) throw new Error("unavailable ponytail_turn should be hidden in slim");

  for (const hidden of [
    "edit_file", "multi_edit", "create_directory", "copy_file", "move_file", "delete_file", "delete_directory",
    "shell_reset", "clear_processes", "git_add", "git_commit", "git_restore", "load_path_rules", "node_repl",
    "mcp_servers", "mcp_call", "browser_open", "open_image", "render_svg",
  ]) {
    if (shouldExposeTool(hidden, "slim")) throw new Error(`${hidden} should be hidden in slim`);
  }
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