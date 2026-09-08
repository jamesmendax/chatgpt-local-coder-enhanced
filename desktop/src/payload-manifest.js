"use strict";

const fs = require("fs");
const path = require("path");

const MANIFEST_NAME = "harness-files.json";
const REQUIRED_FILES = [
  "dist/index.js",
  "dist/lib/plugin-config.js",
  "dist/lib/skill-installer.js",
  "dist/lib/skill-resolver.js",
  "node_modules/express/package.json",
  "package.json",
  "profiles/mcp-upstream.json",
  "profiles/plugins.json",
];

function collectPayloadFiles(root) {
  const files = new Map();
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`发布 payload 含不支持的链接: ${full}`);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        const relative = path.relative(root, full).split(path.sep).join("/").toLowerCase();
        if (relative !== MANIFEST_NAME) files.set(relative, fs.statSync(full).size);
      } else {
        throw new Error(`发布 payload 含不支持的文件类型: ${full}`);
      }
    }
  }
  visit(root);
  return files;
}

function validatePayload(root) {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.join(resolvedRoot, MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`发布 payload 完整性清单不可读: ${manifestPath} (${error.message})`);
  }
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`发布 payload 完整性清单版本无效: ${manifestPath}`);
  }
  const expected = new Map();
  for (const item of manifest.files) {
    const raw = typeof item?.path === "string" ? item.path : "";
    const normalized = raw.replaceAll("\\", "/");
    const target = path.resolve(resolvedRoot, normalized);
    const relative = path.relative(resolvedRoot, target);
    if (!raw || raw.includes("\0") || path.isAbsolute(raw) || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative === "") {
      throw new Error(`发布 payload 完整性清单含越界路径: ${raw}`);
    }
    const bytes = Number(item?.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`发布 payload 完整性清单含无效大小: ${raw}`);
    const key = relative.split(path.sep).join("/").toLowerCase();
    if (key === MANIFEST_NAME || expected.has(key)) throw new Error(`发布 payload 完整性清单含重复路径: ${raw}`);
    expected.set(key, bytes);
  }
  if (manifest.file_count !== expected.size) throw new Error(`发布 payload 清单数量字段不一致: ${manifest.file_count} != ${expected.size}`);
  const expectedBytes = [...expected.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (manifest.total_bytes !== expectedBytes) throw new Error(`发布 payload 清单字节字段不一致: ${manifest.total_bytes} != ${expectedBytes}`);

  let actual;
  try {
    actual = collectPayloadFiles(resolvedRoot);
  } catch (error) {
    throw new Error(`发布 payload 文件树不可验证: ${error.message}`);
  }
  if (actual.size !== expected.size) throw new Error(`发布 payload 解包不完整: 文件数 ${actual.size}/${expected.size}`);
  const actualBytes = [...actual.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (actualBytes !== expectedBytes) throw new Error(`发布 payload 解包不完整: 字节数 ${actualBytes}/${expectedBytes}`);
  for (const [key, bytes] of expected) {
    if (!actual.has(key)) throw new Error(`发布 payload 缺少文件: ${key}`);
    if (actual.get(key) !== bytes) throw new Error(`发布 payload 文件大小不符: ${key} (${actual.get(key)}/${bytes})`);
  }
  for (const required of REQUIRED_FILES) {
    const key = required.toLowerCase();
    if (!actual.has(key) || actual.get(key) <= 0) throw new Error(`发布 payload 缺少关键运行模块: ${required}`);
  }
  return { file_count: actual.size, total_bytes: actualBytes };
}

module.exports = { MANIFEST_NAME, REQUIRED_FILES, collectPayloadFiles, validatePayload };
