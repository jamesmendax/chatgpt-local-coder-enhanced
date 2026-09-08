import fs from "node:fs/promises";
import path from "node:path";

export type ResolvedSkillSource = "project" | "installed" | "external" | "builtin" | "computer-use";

export interface SkillLayout {
  references: string[];
  workflows: string[];
  scripts: string[];
}

export interface ResolvedSkill {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  path: string;
  dir: string;
  source: ResolvedSkillSource;
  enabled: boolean;
  version?: string;
  shadowedBy?: ResolvedSkillSource;
  warnings?: string[];
  error?: string;
  layout: SkillLayout;
}

export interface SkillResolverRegistryEntry {
  id?: string;
  name?: string;
  source?: "installed" | "external" | "builtin";
  aliases?: string[];
  path?: string;
  enabled?: boolean;
  installed_at?: string;
  version?: string;
  origin?: string;
  warnings?: string[];
  error?: string;
}

export interface SkillResolverRegistry {
  schema_version?: number;
  computer_use?: { enabled?: boolean };
  skills?: SkillResolverRegistryEntry[];
}

export interface ResolveSkillsInput {
  workspaceRoot: string;
  codeRoot: string;
  installedDir: string;
  registry: SkillResolverRegistry;
  codexHome: string;
  platform: string;
}

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  version?: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SOURCE_PRIORITY: Record<ResolvedSkillSource, number> = {
  project: 4,
  installed: 3,
  external: 2,
  builtin: 1,
  "computer-use": 5,
};

export function validateSkillId(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || !ID_PATTERN.test(value)) {
    throw new Error("Skill id 必须匹配 ^[a-z0-9][a-z0-9._-]{0,63}$。");
  }
  if (value === "." || value === ".." || WINDOWS_RESERVED.test(value) || value.toLowerCase() === "computer-use") {
    throw new Error(`保留的 Skill id 不可用: ${value}`);
  }
  if (/[ .]$/.test(value)) throw new Error("Skill id 不得以空格或句点结尾。");
  return value;
}

function indentation(line: string): number {
  const prefix = line.match(/^[ \t]*/)?.[0] ?? "";
  return prefix.replace(/\t/g, "  ").length;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) && trimmed.length >= 2) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/** Parse the intentionally small frontmatter subset used by portable Skills. */
export function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const result: ParsedFrontmatter = {};
  let metadataIndent: number | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const parsed = line.match(/^(\s*)([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!parsed) continue;
    const indent = indentation(line);
    const key = parsed[2];
    const value = parsed[3] ?? "";

    if (key === "metadata" && !value) {
      metadataIndent = indent;
      continue;
    }
    if (key === "version" && metadataIndent !== undefined && indent > metadataIndent) {
      const version = scalar(value);
      if (version) result.version = version;
      continue;
    }
    if (key !== "name" && key !== "description") continue;

    if (key === "description" && (value === ">" || value === "|" || value.startsWith("> ") || value.startsWith("| "))) {
      const marker = value[0];
      const body: string[] = [];
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = lines[next];
        if (candidate.trim() && indentation(candidate) <= indent) break;
        body.push(candidate.trim() ? candidate.trim() : "");
        index = next;
      }
      const nonEmpty = body.filter((item, position) => item || body.slice(position + 1).some(Boolean));
      result.description = marker === ">" ? nonEmpty.join(" ").trim() : nonEmpty.join("\n").trim();
    } else {
      const valueText = scalar(value);
      if (valueText) result[key] = valueText;
    }
  }
  return result;
}

async function readFile(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, "utf8"); } catch { return undefined; }
}

async function isDirectory(dir: string): Promise<boolean> {
  try { return (await fs.stat(dir)).isDirectory(); } catch { return false; }
}

async function hasFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function entries(dir: string): Promise<import("node:fs").Dirent[]> {
  try { return (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
}

async function collectLayout(dir: string): Promise<SkillLayout> {
  const layout: SkillLayout = { references: [], workflows: [], scripts: [] };
  for (const bucket of ["references", "workflows", "scripts"] as const) {
    const root = path.join(dir, bucket);
    const visit = async (current: string): Promise<void> => {
      for (const entry of await entries(current)) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) layout[bucket].push(entry.name);
      }
    };
    if (await isDirectory(root)) await visit(root);
    layout[bucket] = [...new Set(layout[bucket])].sort((a, b) => a.localeCompare(b));
  }
  return layout;
}

async function findSkillFiles(root: string, maxDepth = 6): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      const candidate = path.join(full, "SKILL.md");
      if (await hasFile(candidate)) found.push(candidate);
      else await visit(full, depth + 1);
    }
  };
  if (await isDirectory(root)) {
    const direct = path.join(root, "SKILL.md");
    if (await hasFile(direct)) found.push(direct);
    else await visit(root, 0);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

function fallbackDescription(content: string, id: string): string {
  const marker = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? "";
  const body = content.slice(marker.length).split(/\r?\n/).find((line) => line.trim() && !line.trimStart().startsWith("#"));
  return body?.trim() || id;
}

function aliasesFor(id: string, values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const alias = value.trim();
    if (alias.toLowerCase() === id.toLowerCase() || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    out.push(alias);
  }
  return out;
}

async function makeSkill(args: {
  id: string;
  source: ResolvedSkillSource;
  skillPath: string;
  enabled?: boolean;
  aliases?: unknown[];
  version?: string;
  warnings?: string[];
  error?: string;
  readFrontmatter?: boolean;
}): Promise<ResolvedSkill> {
  const skillPath = args.skillPath ? path.resolve(args.skillPath) : "";
  const dir = skillPath ? path.dirname(skillPath) : "";
  const content = skillPath && args.readFrontmatter !== false ? await readFile(skillPath) : undefined;
  const frontmatter = content ? parseSkillFrontmatter(content) : {};
  const id = args.id;
  const aliases = aliasesFor(id, [
    ...(args.aliases ?? []),
    frontmatter.name,
  ]);
  const description = args.source === "computer-use"
    ? "Control Windows apps from ChatGPT"
    : frontmatter.description || (content ? fallbackDescription(content, id) : id);
  const error = args.error || (!content && args.source !== "computer-use" ? "SKILL.md 不存在或不可读" : undefined);
  const layout = content ? await collectLayout(dir) : { references: [], workflows: [], scripts: [] };
  const skill: ResolvedSkill = {
    id,
    name: id,
    aliases,
    description,
    path: skillPath,
    dir,
    source: args.source,
    enabled: args.enabled !== false,
    layout,
    ...(frontmatter.version || args.version ? { version: args.version || frontmatter.version } : {}),
    ...(args.warnings?.length ? { warnings: [...args.warnings] } : {}),
    ...(error ? { error } : {}),
  };
  return skill;
}

async function scanTree(root: string, source: "project" | "builtin", registryEntries: SkillResolverRegistryEntry[] = []): Promise<ResolvedSkill[]> {
  const found: ResolvedSkill[] = [];
  const registryById = new Map(registryEntries.filter((entry) => entry.source === source).map((entry) => [String(entry.id || "").toLowerCase(), entry]));
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const skillPath = path.join(full, "SKILL.md");
      if (await hasFile(skillPath)) {
        const registered = registryById.get(entry.name.toLowerCase());
        found.push(await makeSkill({
          id: entry.name,
          source,
          skillPath,
          enabled: registered?.enabled !== false,
          aliases: registered?.aliases,
          version: registered?.version,
          warnings: registered?.warnings,
        }));
      } else {
        await visit(full, depth + 1);
      }
    }
  };
  if (await isDirectory(root)) await visit(root, 0);
  return found;
}

async function scanInstalled(root: string, registryEntries: SkillResolverRegistryEntry[] = []): Promise<ResolvedSkill[]> {
  const found: ResolvedSkill[] = [];
  const registryById = new Map(registryEntries.filter((entry) => entry.source === "installed").map((entry) => [String(entry.id || "").toLowerCase(), entry]));
  for (const entry of await entries(root)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const direct = path.join(dir, "SKILL.md");
    if (await hasFile(direct)) {
      const registered = registryById.get(entry.name.toLowerCase());
      found.push(await makeSkill({
        id: entry.name,
        source: "installed",
        skillPath: direct,
        enabled: registered?.enabled !== false,
        aliases: registered?.aliases,
        version: registered?.version,
        warnings: registered?.warnings,
      }));
      continue;
    }
    const candidates = await findSkillFiles(dir);
    if (candidates.length === 1) {
      found.push(await makeSkill({
        id: entry.name,
        source: "installed",
        skillPath: candidates[0],
        enabled: registryById.get(entry.name.toLowerCase())?.enabled !== false,
        error: "package root not at top level",
      }));
    } else {
      found.push(await makeSkill({
        id: entry.name,
        source: "installed",
        skillPath: direct,
        enabled: registryById.get(entry.name.toLowerCase())?.enabled !== false,
        error: candidates.length > 1 ? "multiple SKILL.md files found" : "SKILL.md not found",
      }));
    }
  }
  return found;
}

async function scanExternal(entriesToScan: SkillResolverRegistryEntry[]): Promise<ResolvedSkill[]> {
  const found: ResolvedSkill[] = [];
  for (const entry of entriesToScan) {
    if (entry.source !== "external") continue;
    const id = String(entry.id || entry.name || (entry.path ? path.basename(path.dirname(entry.path)) : "unknown-skill"));
    const skillPath = entry.path ? path.resolve(entry.path) : "";
    found.push(await makeSkill({
      id,
      source: "external",
      skillPath,
      enabled: entry.enabled !== false,
      aliases: [...(entry.aliases ?? []), entry.name],
      version: entry.version,
      warnings: entry.warnings,
      error: entry.error || (!skillPath ? "external registration requires path" : undefined),
    }));
  }
  return found;
}

export async function findComputerUseSkill(input: { codexHome: string; platform: string }): Promise<string | undefined> {
  if (input.platform !== "win32") return undefined;
  const root = path.join(path.resolve(input.codexHome), "plugins", "cache", "openai-bundled", "computer-use");
  const versions = (await entries(root)).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const version of versions.reverse()) {
    const candidate = path.join(root, version, "skills", "computer-use", "SKILL.md");
    if (await hasFile(candidate)) return candidate;
  }
  return undefined;
}

function applyShadowing(skills: ResolvedSkill[]): ResolvedSkill[] {
  const groups = new Map<string, ResolvedSkill[]>();
  for (const skill of skills) {
    const key = skill.id.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(skill);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const computer = group.find((skill) => skill.source === "computer-use" && skill.enabled && !skill.error);
    const eligible = group.filter((skill) => skill.enabled && !skill.error && skill.source !== "computer-use");
    const winner = computer || [...eligible].sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source] || a.id.localeCompare(b.id) || a.path.localeCompare(b.path))[0];
    for (const skill of group) {
      if (skill.source !== "computer-use" && skill.id.toLowerCase() === "computer-use") {
        skill.shadowedBy = "computer-use";
      } else if (winner && skill !== winner && skill.enabled && !skill.error) {
        skill.shadowedBy = winner.source;
      }
    }
  }
  return skills;
}

export async function resolveSkills(input: ResolveSkillsInput): Promise<ResolvedSkill[]> {
  const registryEntries = input.registry.skills ?? [];
  const project = await scanTree(path.join(path.resolve(input.workspaceRoot), ".claude", "skills"), "project");
  const installed = await scanInstalled(path.resolve(input.installedDir), registryEntries);
  const external = await scanExternal(input.registry.skills ?? []);
  const builtin = await scanTree(path.join(path.resolve(input.codeRoot), "skills"), "builtin", registryEntries);
  const all = [...project, ...installed, ...external, ...builtin];
  const computerPath = await findComputerUseSkill({ codexHome: input.codexHome, platform: input.platform });
  if (computerPath) {
    all.push(await makeSkill({
      id: "computer-use",
      source: "computer-use",
      skillPath: computerPath,
      enabled: input.registry.computer_use?.enabled === true,
      readFrontmatter: false,
    }));
  }
  return applyShadowing(all);
}

function selectable(skills: ResolvedSkill[]): ResolvedSkill[] {
  return skills.filter((skill) => skill.enabled && !skill.shadowedBy && !skill.error);
}

export function selectSkill(skills: ResolvedSkill[], requested: string): ResolvedSkill {
  const value = requested.trim().toLowerCase();
  const available = selectable(skills);
  const exact = available.filter((skill) => skill.id.toLowerCase() === value);
  const candidates = exact.length
    ? exact
    : available.filter((skill) => skill.aliases.some((alias) => alias.toLowerCase() === value));
  const selected = [...candidates].sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source] || a.id.localeCompare(b.id) || a.path.localeCompare(b.path))[0];
  if (!selected) {
    const names = available.flatMap((skill) => [skill.id, ...skill.aliases]).join(", ");
    throw new Error(`Unknown Skill: ${requested}. Available ids/aliases: ${names || "(none)"}`);
  }
  return selected;
}

export function resolvedVia(skill: ResolvedSkill, requested: string): "id" | "alias" {
  return skill.id.toLowerCase() === requested.trim().toLowerCase() ? "id" : "alias";
}
