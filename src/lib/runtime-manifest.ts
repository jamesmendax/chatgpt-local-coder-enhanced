import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LOCAL_TOOL_CATALOG,
  getChatGptToolProfile,
  shouldExposeTool,
  type ToolProfileName,
} from "./tool-profile.js";

const RUNTIME_MODULE_PATH = fileURLToPath(import.meta.url);
const STARTED_AT = new Date().toISOString();
const LOADED_RUNTIME_MTIME_MS = fs.statSync(RUNTIME_MODULE_PATH).mtimeMs;
const PROFILE = getChatGptToolProfile();
const TOOL_NAMES = localToolNames(PROFILE);
const TOOL_MANIFEST_HASH = digest(TOOL_NAMES.join("\n"));
const BUILD_ID = digest(
  `${LOADED_RUNTIME_MTIME_MS}\n${PROFILE}\n${TOOL_MANIFEST_HASH}`
).slice(0, 16);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function localToolNames(profile: ToolProfileName): string[] {
  return LOCAL_TOOL_CATALOG
    .filter((name) => shouldExposeTool(name, profile))
    .sort((left, right) => left.localeCompare(right));
}

function currentRuntimeMtimeMs(): number {
  try {
    return fs.statSync(RUNTIME_MODULE_PATH).mtimeMs;
  } catch {
    return LOADED_RUNTIME_MTIME_MS;
  }
}

export interface RuntimeManifest {
  pid: number;
  started_at: string;
  build_id: string;
  tool_profile: ToolProfileName;
  tool_count: number;
  tool_names: string[];
  tool_manifest_hash: string;
  loaded_runtime_mtime_ms: number;
  current_runtime_mtime_ms: number;
  stale_build: boolean;
}

export function getRuntimeManifest(): RuntimeManifest {
  const currentMtime = currentRuntimeMtimeMs();
  return {
    pid: process.pid,
    started_at: STARTED_AT,
    build_id: BUILD_ID,
    tool_profile: PROFILE,
    tool_count: TOOL_NAMES.length,
    tool_names: [...TOOL_NAMES],
    tool_manifest_hash: TOOL_MANIFEST_HASH,
    loaded_runtime_mtime_ms: LOADED_RUNTIME_MTIME_MS,
    current_runtime_mtime_ms: currentMtime,
    stale_build: currentMtime > LOADED_RUNTIME_MTIME_MS + 1,
  };
}

export function getRuntimeManifestSummary(): Omit<RuntimeManifest, "tool_names"> {
  const { tool_names: _toolNames, ...summary } = getRuntimeManifest();
  return summary;
}