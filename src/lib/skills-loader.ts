import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { resolveComputerUseSkillPath } from "./plugin-config.js";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source?: "project" | "builtin" | "plugin";
}

function serverRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

export async function loadProjectSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  const out: SkillSummary[] = [];

  async function walk(dir: string, depth: number, source: "project" | "builtin"): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skillFile = path.join(full, "SKILL.md");
        try {
          const content = await fs.readFile(skillFile, "utf-8");
          const fm = parseFrontmatter(content);
          const name = fm.name || entry.name;
          const description = fm.description || content.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || name;
          if (!out.some((skill) => skill.name === name)) {
            out.push({ name, description: description.slice(0, 200), path: skillFile, source });
          }
        } catch {
          await walk(full, depth + 1, source);
        }
      }
    }
  }

  // Project skills win by name. Built-ins provide a stable Codex-like baseline
  // for every WORKSPACE_PATH without copying skill files into each project.
  await walk(path.join(workspaceRoot, ".claude", "skills"), 0, "project");
  await walk(path.join(serverRoot(), "skills"), 0, "builtin");
  const computerUseSkill = await resolveComputerUseSkillPath();
  if (computerUseSkill) {
    const content = await fs.readFile(computerUseSkill, "utf-8");
    const frontmatter = parseFrontmatter(content);
    const name = frontmatter.name || "computer-use";
    if (!out.some((skill) => skill.name === name)) {
      out.push({
        name,
        description: (frontmatter.description || "Control Windows apps from ChatGPT").slice(0, 200),
        path: computerUseSkill,
        source: "plugin",
      });
    }
  }
  return out;
}

export function formatSkillsForInstructions(skills: SkillSummary[]): string {
  if (!skills.length) return "";
  return [
    "## Skills",
    `${skills.length} skills are available. Call list_skills, then load_skill(name) before applying a matching workflow; do not guess a skill body from its name.`,
    skills.some((skill) => skill.name === "computer-use") ? "Computer Use plugin is enabled: load_skill(\"computer-use\") before any Windows UI automation." : "",
  ].join("\n");
}

export async function loadProjectSkill(
  workspaceRoot: string,
  name: string,
  maxBytes = 200_000
): Promise<{
  skill: SkillSummary;
  content: string;
  truncated: boolean;
  references?: Array<{ path: string; content: string; truncated: boolean }>;
}> {
  const skill = (await loadProjectSkills(workspaceRoot)).find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`Unknown project skill: ${name}`);
  const data = await fs.readFile(skill.path);
  const content = data.subarray(0, maxBytes).toString("utf-8");
  let remaining = maxBytes - Buffer.byteLength(content);
  let truncated = data.length > maxBytes;
  const references: Array<{ path: string; content: string; truncated: boolean }> = [];

  if (skill.source === "plugin" && skill.name === "computer-use" && remaining > 0) {
    const pluginRoot = path.resolve(path.dirname(skill.path), "..", "..");
    for (const file of ["guidance.md", "api.md", "confirmations.md"]) {
      const referencePath = path.join(pluginRoot, "docs", file);
      try {
        const reference = await fs.readFile(referencePath);
        const referenceContent = reference.subarray(0, remaining).toString("utf-8");
        const referenceTruncated = reference.length > remaining;
        references.push({ path: referencePath, content: referenceContent, truncated: referenceTruncated });
        remaining -= Buffer.byteLength(referenceContent);
        truncated ||= referenceTruncated;
        if (remaining <= 0) break;
      } catch {
        // A Codex version may omit an optional Computer Use reference document.
      }
    }
  }

  return {
    skill,
    content,
    truncated,
    ...(references.length ? { references } : {}),
  };
}
