import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".mcp-state",
  ".mcp-checkpoints",
  ".mcp-oauth",
  ".secrets",
  "bin",
]);
const ignoredFiles = new Set([
  "scripts/check-public-secrets.mjs",
]);
const maxTextBytes = 2 * 1024 * 1024;

const directPatterns = [
  { name: "OpenAI-style API key", re: /\bsk-[A-Za-z0-9_-]{10,}\b/ },
  { name: "real OpenAI tunnel id", re: /\btunnel_[0-9a-f]{20,}\b/i },
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
];

const assignmentNames = [
  "MCP_TOKEN",
  "ADMIN_TOKEN",
  "OPENAI_TUNNEL_API_KEY",
  "CONTROL_PLANE_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
];

function isSafePlaceholder(value) {
  const raw = value.trim();
  const v = raw.replace(/^['\"]|['\"]$/g, "").trim();
  if (!v) return true;
  if (/^<[^>]+>$/.test(v)) return true;
  if (/^(?:YOUR|EXAMPLE|CHANGEME|REPLACE_ME|REDACTED)[A-Z0-9_<>.-]*$/i.test(v)) return true;
  if (/^(?:null|undefined)$/i.test(v)) return true;

  // Runtime expressions/variable references are not embedded secrets.
  if (/^\$[A-Za-z_]/.test(raw)) return true;
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(raw)) return true;
  if (/\bprocess\.env\b/i.test(raw)) return true;
  if (/\bGet-DotEnvValue\b/i.test(raw)) return true;
  if (/\[Environment\]::GetEnvironmentVariable/i.test(raw)) return true;

  return false;
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const hits = [];
for (const file of await walk(root)) {
  const rel = path.relative(root, file).replaceAll("\\", "/");
  if (ignoredFiles.has(rel)) continue;

  let info;
  try { info = await stat(file); } catch { continue; }
  if (info.size > maxTextBytes) continue;

  let text;
  try { text = await readFile(file, "utf8"); } catch { continue; }
  if (text.includes("\u0000")) continue;

  for (const { name, re } of directPatterns) {
    if (re.test(text)) hits.push(`${rel}: ${name}`);
  }

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    for (const name of assignmentNames) {
      const match = line.match(new RegExp(`\\b${name}\\b\\s*[:=]\\s*(.*)$`, "i"));
      if (!match) continue;
      if (!isSafePlaceholder(match[1])) {
        hits.push(`${rel}:${index + 1}: non-placeholder ${name} assignment`);
      }
    }
  }
}

if (hits.length) {
  console.error("Potential public-secret patterns found:");
  for (const hit of [...new Set(hits)].sort()) console.error(`- ${hit}`);
  process.exit(1);
}

console.log("No obvious public secret patterns found.");
