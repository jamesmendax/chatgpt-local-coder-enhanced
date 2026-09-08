import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const canonicalRepository = "jamesmendax/chatgpt-local-coder-enhanced";

function normalizeGitHubRepository(value) {
  return String(value || "")
    .trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageRepository = normalizeGitHubRepository(
  typeof packageJson.repository === "string" ? packageJson.repository : packageJson.repository?.url,
);

let origin;
try {
  origin = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
} catch {
  console.error("Release target check failed: git remote 'origin' is missing.");
  process.exit(1);
}

const actualRepository = normalizeGitHubRepository(origin);
const actionRepository = normalizeGitHubRepository(process.env.GITHUB_REPOSITORY);
const errors = [];

if (actualRepository !== canonicalRepository) {
  errors.push(`origin resolves to ${actualRepository || "<empty>"}`);
}
if (packageRepository !== canonicalRepository) {
  errors.push(`package.json resolves to ${packageRepository || "<empty>"}`);
}
if (process.env.GITHUB_REPOSITORY && actionRepository !== canonicalRepository) {
  errors.push(`GITHUB_REPOSITORY resolves to ${actionRepository || "<empty>"}`);
}

if (errors.length) {
  console.error(`Release target check failed; expected ${canonicalRepository}:`);
  for (const error of errors) console.error(`- ${error}`);
  console.error("Do not create or publish to a replacement repository.");
  process.exit(1);
}

console.log(`Release target verified: ${canonicalRepository}`);
