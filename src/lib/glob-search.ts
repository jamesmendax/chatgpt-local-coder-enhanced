import fs from "fs/promises";
import path from "path";

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let regex = "";

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      index++;
      if (normalized[index + 1] === "/") {
        // `**/` matches zero or more complete path segments, so patterns such
        // as `**/*.ts` also include files at the search root.
        index++;
        regex += "(?:.*/)?";
      } else {
        regex += ".*";
      }
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }

  return new RegExp(`^${regex}$`, "i");
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === "build";
}

export async function globFiles(
  rootDir: string,
  pattern: string,
  maxResults: number
): Promise<Array<{ path: string; mtimeMs: number }>> {
  if (!Number.isFinite(maxResults) || maxResults <= 0) return [];
  const matcher = globToRegExp(pattern.replace(/\\/g, "/"));
  const matches: Array<{ path: string; mtimeMs: number }> = [];

  function retainNewest(candidate: { path: string; mtimeMs: number }): void {
    let low = 0;
    let high = matches.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const current = matches[middle];
      const candidateBefore =
        candidate.mtimeMs > current.mtimeMs ||
        (candidate.mtimeMs === current.mtimeMs && candidate.path.localeCompare(current.path) < 0);
      if (candidateBefore) high = middle;
      else low = middle + 1;
    }
    matches.splice(low, 0, candidate);
    if (matches.length > maxResults) matches.pop();
  }

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(rootDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) await walk(fullPath);
        continue;
      }

      if (!matcher.test(rel) && !matcher.test(entry.name)) continue;

      try {
        const stat = await fs.stat(fullPath);
        retainNewest({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }

  await walk(rootDir);
  return matches;
}
