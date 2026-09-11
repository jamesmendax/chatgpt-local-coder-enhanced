import fs from "fs";
import path from "path";
import os from "os";

let defaultCwd = process.cwd();

export function setDefaultCwd(cwd: string): void {
  defaultCwd = path.resolve(cwd);
}

export function getDefaultCwd(): string {
  return defaultCwd;
}

/** @deprecated use getDefaultCwd — kept for compatibility */
export function setAllowedRoots(roots: string[]): void {
  if (roots.length > 0) setDefaultCwd(roots[0]);
}

/** Returns default working directory, not an access boundary */
export function getAllowedRoots(): string[] {
  return [defaultCwd];
}

export function setFullDiskAccess(_enabled: boolean): void {}

export function getFullDiskAccess(): boolean {
  return true;
}

export async function validatePath(inputPath: string): Promise<string> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");

  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }

  // Relative paths resolve from default cwd (WORKSPACE_PATH), not a sandbox boundary.
  return path.resolve(defaultCwd, trimmed);
}

export function getMachineRoots(): string[] {
  if (process.platform === "win32") {
    const drives: string[] = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      try {
        fs.accessSync(`${letter}:\\`, fs.constants.R_OK);
        drives.push(`${letter}:\\`);
      } catch {}
    }
    return drives.length ? drives : ["C:\\"];
  }
  return ["/", os.homedir()];
}