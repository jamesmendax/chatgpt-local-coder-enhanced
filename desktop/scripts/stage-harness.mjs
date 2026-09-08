// 打包前把 harness 运行所需文件整理到 desktop/staging/harness：
//   dist/、bin/tunnel-client.exe、profiles/（只含通用 json/txt，不含个人 yaml/Skill）、public/、
//   package.json、.env.example，并安装生产依赖（--omit=dev）。
// 默认不重新执行 tsc，避免改动 dist 的 mtime 让线上 MCP 误报 stale_build；需要重建时加 --build。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStagingSafe } from "./lib/sanitize-profiles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const staging = path.join(desktopRoot, "staging", "harness");
const args = new Set(process.argv.slice(2));
const manifestName = "harness-files.json";

function log(msg) {
  console.log(`[stage] ${msg}`);
}

function run(cmd, cmdArgs, cwd) {
  const res = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} 失败 (exit ${res.status})`);
}

function copy(rel, opts = {}) {
  const from = path.join(repoRoot, rel);
  const to = path.join(staging, rel);
  if (!fs.existsSync(from)) {
    if (opts.optional) { log(`跳过（不存在）: ${rel}`); return; }
    throw new Error(`缺少必需文件: ${from}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: opts.filter });
  log(`复制 ${rel}`);
}

if (args.has("--build")) {
  log("执行 tsc 构建 ...");
  run("npm", ["run", "build"], repoRoot);
}
if (!fs.existsSync(path.join(repoRoot, "dist", "index.js"))) {
  throw new Error("dist/index.js 不存在：请先在仓库根目录运行 npm run build，或使用 --build。");
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

copy("dist");
copy("bin/tunnel-client.exe", { optional: true });
// Skills are deliberately not bundled into release artifacts.  The desktop
// app still ships the shared installer/resolver API, so users can install a
// package explicitly after first run.
copy("public", { optional: true });
copy(".env.example");
copy("icon.png", { optional: true });
copy("profiles", {
  filter: (src) => {
    const rel = path.relative(path.join(repoRoot, "profiles"), src);
    if (!rel) return true;
    const top = rel.split(path.sep)[0].toLowerCase();
    // Runtime-owned profiles are created/managed by the desktop app. Never
    // copy personal registrations, installed packages, or tunnel yaml.
    if (top === "local-skills" || /^plugins\.json(?:\.|$)/i.test(top) || /^mcp-upstream\.json(?:\.|$)/i.test(top) || top === ".seed-manifest.json") return false;
    if (/\.ya?ml$/i.test(rel) && !rel.includes(path.sep)) return false;
    return true;
  },
});

// Replace source-machine profile data with release-safe empty defaults. This
// also makes a missing source profile deterministic for fresh packages.
const stagedProfiles = path.join(staging, "profiles");
fs.mkdirSync(stagedProfiles, { recursive: true });
fs.writeFileSync(path.join(stagedProfiles, "plugins.json"), JSON.stringify({
  schema_version: 2,
  computer_use: { enabled: false },
  skills: [],
}, null, 2) + "\n");
fs.writeFileSync(path.join(stagedProfiles, "mcp-upstream.json"), JSON.stringify({ version: 1, servers: [] }, null, 2) + "\n");
assertStagingSafe(staging);

// 只保留生产依赖的 package.json。
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const slim = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: pkg.type,
  main: pkg.main,
  dependencies: pkg.dependencies,
};
fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify(slim, null, 2));

log("安装生产依赖（npm install --omit=dev --ignore-scripts）...");
run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], staging);

// The production dependency tree includes documentation-only examples,
// declaration files, source maps, and Playwright's bundled Skill reference
// pages. They are never imported by the harness at runtime, but their deep
// paths can push a portable launcher's temporary extraction tree over the
// legacy Windows MAX_PATH boundary. Prune them after npm has resolved the
// exact production graph so setup, portable, and ZIP artifacts share the same
// smaller, runnable payload.
function pruneNonRuntimeFiles(root) {
  let removed = 0;
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/").toLowerCase();
      const inDependencies = rel.startsWith("node_modules/");
      const isPlaywrightReference = rel.includes("node_modules/playwright-core/lib/tools/skills/");
      if (inDependencies && (rel.split("/").includes("examples") || isPlaywrightReference)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (inDependencies && (rel.endsWith(".map") || rel.endsWith(".d.ts"))) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    }
  }
  visit(root);
  log(`移除非运行时依赖文件: ${removed}`);
}

pruneNonRuntimeFiles(staging);

// The MCP SDK is imported by runtime JavaScript using package subpaths. Move
// it to a short, private package name in the release payload and rewrite only
// the emitted runtime imports. Keeping the package contents and exports
// unchanged avoids dropping required server middleware while reclaiming the
// 17 characters in the scoped directory name that matter to MAX_PATH.
function shortenMcpSdkPath(root) {
  const source = path.join(root, "node_modules", "@modelcontextprotocol", "sdk");
  const target = path.join(root, "node_modules", "mcp-sdk");
  if (!fs.existsSync(source)) throw new Error(`缺少 MCP SDK 生产依赖: ${source}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  fs.rmSync(path.dirname(source), { recursive: true, force: true });

  let rewritten = 0;
  for (const file of collectFiles(path.join(root, "dist"))) {
    if (path.extname(file).toLowerCase() !== ".js") continue;
    const content = fs.readFileSync(file, "utf8");
    const next = content.replaceAll("@modelcontextprotocol/sdk", "mcp-sdk");
    if (next !== content) {
      fs.writeFileSync(file, next, "utf8");
      rewritten += 1;
    }
  }
  log(`压缩 MCP SDK 路径: ${rewritten} 个运行时导入`);
}

function collectFiles(dir) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
      else throw new Error(`staging 中存在不支持的文件类型: ${full}`);
    }
  }
  visit(dir);
  return files;
}

shortenMcpSdkPath(staging);

// Playwright's browser runtime is also imported by the browser and visual
// tools. Keep its complete package (including trace/recorder assets), but
// shorten the package directory so those assets remain extractable below
// MAX_PATH in deeply nested temporary directories.
function shortenPlaywrightPath(root) {
  const source = path.join(root, "node_modules", "playwright-core");
  const target = path.join(root, "node_modules", "pw");
  if (!fs.existsSync(source)) throw new Error(`缺少 Playwright 生产依赖: ${source}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  fs.rmSync(source, { recursive: true, force: true });

  let rewritten = 0;
  for (const file of collectFiles(path.join(root, "dist"))) {
    if (path.extname(file).toLowerCase() !== ".js") continue;
    const content = fs.readFileSync(file, "utf8");
    const next = content.replaceAll("\"playwright-core\"", "\"pw\"").replaceAll("'playwright-core'", "'pw'");
    if (next !== content) {
      fs.writeFileSync(file, next, "utf8");
      rewritten += 1;
    }
  }
  for (const name of ["playwright-core", "playwright-core.cmd", "playwright-core.ps1"]) {
    const file = path.join(root, "node_modules", ".bin", name);
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    const next = content.replaceAll("..\\playwright-core\\", "..\\pw\\");
    if (next !== content) fs.writeFileSync(file, next, "utf8");
  }
  log(`压缩 Playwright 路径: ${rewritten} 个运行时导入`);
}

shortenPlaywrightPath(staging);

const buildHash = createHash("sha256").update(fs.readFileSync(path.join(staging, "dist", "index.js"))).digest("hex").slice(0, 16);
fs.writeFileSync(path.join(staging, "harness-version.json"), JSON.stringify({
  harness_version: pkg.version,
  dist_index_sha256_16: buildHash,
  staged_at: new Date().toISOString(),
}, null, 2));

const size = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? size(full) : fs.statSync(full).size;
  }
  return total;
};

const manifestPath = path.join(staging, manifestName);
const manifestFiles = collectFiles(staging)
  .filter((file) => path.resolve(file) !== path.resolve(manifestPath))
  .map((file) => ({
    path: path.relative(staging, file).split(path.sep).join("/"),
    bytes: fs.statSync(file).size,
  }))
  .sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(manifestPath, JSON.stringify({
  schema_version: 1,
  file_count: manifestFiles.length,
  total_bytes: manifestFiles.reduce((sum, entry) => sum + entry.bytes, 0),
  files: manifestFiles,
}, null, 2) + "\n");
log(`写入完整性清单 ${manifestName}: ${manifestFiles.length} files`);
log(`完成: ${staging} (${Math.round(size(staging) / 1048576)} MB)`);
