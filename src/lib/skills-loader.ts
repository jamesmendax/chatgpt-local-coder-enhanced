import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { getLocalPluginsConfig, getLocalPluginsConfigPath } from "./plugin-config.js";
import {
  resolveSkills,
  resolvedVia,
  selectSkill,
  type ResolvedSkill,
} from "./skill-resolver.js";

export type SkillSummary = ResolvedSkill;

function serverRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function getSkillCodeRoot(): string {
  return serverRoot();
}

export function getSkillInstalledDir(): string {
  return path.join(path.dirname(getLocalPluginsConfigPath()), "local-skills");
}

export async function resolveAllSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  const registry = getLocalPluginsConfig();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return resolveSkills({
    workspaceRoot: path.resolve(workspaceRoot),
    codeRoot: serverRoot(),
    installedDir: getSkillInstalledDir(),
    registry,
    codexHome,
    platform: process.platform,
  });
}

export async function loadProjectSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  const skills = await resolveAllSkills(workspaceRoot);
  return skills.filter((skill) => skill.enabled && !skill.shadowedBy && !skill.error);
}

export function formatSkillsForInstructions(skills: SkillSummary[]): string {
  if (!skills.length) return "";
  return [
    "## Skills",
    `${skills.length} skills are available. Call list_skills, then load_skill(name) before applying a matching workflow; do not guess a skill body from its name.`,
    skills.some((skill) => skill.id === "computer-use") ? "Computer Use is available: load_skill(\"computer-use\") before any Windows UI automation." : "",
  ].join("\n");
}

export async function loadProjectSkill(
  workspaceRoot: string,
  name: string,
  maxBytes = 200_000
): Promise<{
  skill: SkillSummary;
  resolved_via: "id" | "alias";
  dir: string;
  layout: SkillSummary["layout"];
  usage: string;
  content: string;
  truncated: boolean;
  references?: Array<{ path: string; content: string; truncated: boolean }>;
  reference_paths?: string[];
}> {
  const allSkills = await resolveAllSkills(workspaceRoot);
  const skill = selectSkill(allSkills, name);
  const data = await fs.readFile(skill.path);
  const content = data.subarray(0, maxBytes).toString("utf-8");
  let remaining = maxBytes - Buffer.byteLength(content);
  let truncated = data.length > maxBytes;
  const references: Array<{ path: string; content: string; truncated: boolean }> = [];
  const referencePaths = skill.layout.references.map((file) => path.join(skill.dir, "references", file));

  if (skill.source === "computer-use" && remaining > 0) {
    const pluginRoot = path.resolve(path.dirname(skill.path), "..", "..");
    for (const file of ["guidance.md", "api.md", "confirmations.md"]) {
      const referencePath = path.join(pluginRoot, "docs", file);
      try {
        const reference = await fs.readFile(referencePath);
        const referenceContent = reference.subarray(0, Math.max(0, remaining)).toString("utf-8");
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
    resolved_via: resolvedVia(skill, name),
    dir: skill.dir,
    layout: skill.layout,
    usage: `SKILL_DIR=${skill.dir}; use absolute paths or run_command working_directory=${skill.dir}; do not cd into the Skill directory`,
    content,
    truncated,
    ...(references.length ? { references } : {}),
    ...(referencePaths.length ? { reference_paths: referencePaths } : {}),
  };
}
