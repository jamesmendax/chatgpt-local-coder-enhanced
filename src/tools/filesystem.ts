import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { createHash } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { applyMultiFilePatch, applyUnifiedPatchToText, buildSimpleDiff, isMultiFilePatch, parseMultiFilePatch } from "../lib/patch.js";
import { checkpointBefore } from "../lib/checkpoint.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { enrichAfterEdit } from "../lib/edit-enrichment.js";
import { toolResult } from "../lib/tool-result.js";
import { globFiles } from "../lib/glob-search.js";
import { grepSearch } from "../lib/grep-search.js";

const MAX_BINARY_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_BINARY_CHUNK_BYTES / 3) * 4;
const MAX_CHATGPT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 5;

const chatGptFileSchema = z.object({
  file_id: z.string().min(1),
  download_url: z.string().url(),
  file_name: z.string().min(1).max(1024).optional(),
  name: z.string().min(1).max(1024).optional(),
  mime_type: z.string().max(255).optional(),
  size: z.number().int().nonnegative().optional(),
}).passthrough();

type ChatGptFileRef = z.infer<typeof chatGptFileSchema>;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function detectFileType(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 6 && (head.subarray(0, 6).toString("ascii") === "GIF87a" || head.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "gif";
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("ascii") === "RIFF" &&
    head.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  if (head.length >= 5 && head.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06) || (head[2] === 0x07 && head[3] === 0x08))
  ) {
    return "zip";
  }
  return null;
}

async function readHead(filePath: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function decodeBase64Strict(content: string): Buffer {
  const normalized = content.replace(/\s+/g, "");
  if (normalized.length === 0) return Buffer.alloc(0);

  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (normalized.length % 4 !== 0 || !validBase64.test(normalized)) {
    throw new Error("Invalid base64 content: malformed characters or padding");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.toString("base64") !== normalized) {
    throw new Error("Invalid base64 content: round-trip validation failed");
  }
  return buffer;
}

function isPrivateOrReservedIp(input: string): boolean {
  let ip = input.toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);

  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (version === 6) {
    return (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      /^fe[89ab]/.test(ip)
    );
  }

  return false;
}

export function isProxySyntheticIp(input: string): boolean {
  let ip = input.toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
}

async function assertPublicHttpsUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("ChatGPT file download_url is not a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("ChatGPT file download_url must use HTTPS");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("ChatGPT file download_url points to a local hostname");
  }

  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new Error("ChatGPT file download_url points to a private/reserved IP");
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("ChatGPT file download_url hostname did not resolve");
  if (addresses.some(({ address }) => isPrivateOrReservedIp(address) && !isProxySyntheticIp(address))) {
    throw new Error("ChatGPT file download_url resolves to a private/reserved IP");
  }
  return url;
}

async function fetchChatGptFile(downloadUrl: string): Promise<{ response: Response; finalUrl: string }> {
  let current = downloadUrl;

  for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects++) {
    const safeUrl = await assertPublicHttpsUrl(current);
    const response = await fetch(safeUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
      headers: { "User-Agent": "chatgpt-local-coder/1.0" },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`ChatGPT file download redirect ${response.status} has no Location header`);
      current = new URL(location, safeUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw new Error(`ChatGPT file download failed: HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("ChatGPT file download returned an empty response body");
    return { response, finalUrl: safeUrl.toString() };
  }

  throw new Error(`ChatGPT file download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects`);
}

export async function streamResponseBodyToFile(
  response: Response,
  outputPath: string,
  maxBytes = MAX_CHATGPT_FILE_BYTES
): Promise<{ bytes: number; sha256: string }> {
  if (!response.body) throw new Error("Response has no body");
  const hash = createHash("sha256");
  const handle = await fs.open(outputPath, "w");
  let bytes = 0;

  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new Error(`ChatGPT file exceeds the ${maxBytes} byte safety limit`);
      hash.update(buffer);
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }

  return { bytes, sha256: hash.digest("hex") };
}

function fallbackFileName(file: ChatGptFileRef): string {
  const candidate = file.file_name ?? file.name;
  if (!candidate) throw new Error("No destination path was provided and ChatGPT did not provide a file name");
  const base = path.basename(candidate.trim());
  if (!base || base === "." || base === "..") throw new Error("ChatGPT provided an invalid file name");
  return base;
}



async function searchDirectory(
  dir: string,
  regex: RegExp,
  globPattern: string,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= maxResults) break;

    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      await searchDirectory(fullPath, regex, globPattern, results, maxResults);
    } else if (matchesGlob(entry.name, globPattern)) {
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (results.length < maxResults && regex.test(line)) {
            results.push(`${fullPath}:${idx + 1}: ${line.trim()}`);
          }
        });
      } catch {}
    }
  }
}

function matchesGlob(filename: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const regex = new RegExp(
    "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(filename);
}

async function buildTree(dirPath: string, depth: number, maxDepth: number): Promise<object> {
  const name = path.basename(dirPath);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  if (depth >= maxDepth) return { name, type: "directory", truncated: true };

  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) children.push(await buildTree(childPath, depth + 1, maxDepth));
    else children.push({ name: entry.name, type: "file" });
  }

  return { name, type: "directory", children };
}

export function registerFilesystemTools(server: McpServer): void {
  server.registerTool(
    "read_text_file",
    {
      title: "Read Text File",
      description: "Read a file before editing. Use offset+limit for partial reads (1-based line numbers). Always read files you plan to patch.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().positive().optional().describe("1-based line number to start reading"),
        limit: z.number().int().positive().optional().describe("Number of lines to read from offset"),
        head: z.number().optional(),
        tail: z.number().optional(),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, offset, limit, head, tail }) => {
      const validPath = await validatePath(filePath);
      const content = await fs.readFile(validPath, "utf-8");
      const lines = content.split("\n");

      if (offset !== undefined) {
        const start = Math.max(0, offset - 1);
        const end = limit !== undefined ? start + limit : lines.length;
        const slice = lines.slice(start, end);
        const numbered = slice.map((line, idx) => `${String(start + idx + 1).padStart(6, " ")}|${line}`);
        await audit({ tool: "read_text_file", action: "read", target: validPath, status: "ok", details: { offset, limit } });
        return toolResult("read_text_file", { path: validPath, content: numbered.join("\n"), offset, limit, lines: slice.length });
      }

      const result =
        head !== undefined ? lines.slice(0, head).join("\n") : tail !== undefined ? lines.slice(-tail).join("\n") : content;
      await audit({ tool: "read_text_file", action: "read", target: validPath, status: "ok" });
      return toolResult("read_text_file", { path: validPath, content: result, head, tail });
    }
  );

  server.registerTool(
    "read_file_base64",
    {
      title: "Read File Base64",
      description: "Read any local file as base64. Use offset/length for large files. For ChatGPT web prefer chunks <= 64 KiB; hard max 8 MiB.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().nonnegative().optional().default(0),
        length: z.number().int().positive().max(MAX_BINARY_CHUNK_BYTES).optional().default(64 * 1024),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, offset, length }) => {
      const validPath = await validatePath(filePath);
      const stat = await fs.stat(validPath);
      if (!stat.isFile()) throw new Error("Path is not a regular file");
      const start = Math.min(offset, stat.size);
      const chunkLength = Math.min(length, MAX_BINARY_CHUNK_BYTES, stat.size - start);
      const handle = await fs.open(validPath, "r");
      try {
        const buffer = Buffer.alloc(chunkLength);
        const { bytesRead } = await handle.read(buffer, 0, chunkLength, start);
        const data = buffer.subarray(0, bytesRead);
        const nextOffset = start + bytesRead;
        await audit({ tool: "read_file_base64", action: "read", target: validPath, status: "ok", details: { offset: start, bytesRead } });
        return toolResult("read_file_base64", {
          path: validPath,
          size: stat.size,
          offset: start,
          bytes_read: bytesRead,
          next_offset: nextOffset < stat.size ? nextOffset : null,
          done: nextOffset >= stat.size,
          encoding: "base64",
          content: data.toString("base64"),
        });
      } finally {
        await handle.close();
      }
    }
  );

  server.registerTool(
    "file_info",
    {
      title: "File Info",
      description:
        "Inspect a local path without modifying it. For files, optionally calculate SHA256 and return leading bytes so callers can verify real file type/signature instead of trusting the extension.",
      inputSchema: {
        path: z.string(),
        sha256: z.boolean().optional().default(false),
        head_bytes: z.number().int().nonnegative().max(64).optional().default(16),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, sha256, head_bytes }) => {
      const validPath = await validatePath(filePath);
      const stat = await fs.lstat(validPath);
      const type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
      const head = stat.isFile() ? await readHead(validPath, head_bytes) : Buffer.alloc(0);
      let digest: string | undefined;
      if (stat.isFile()) {
        if (sha256) digest = await sha256File(validPath);
      }
      await audit({ tool: "file_info", action: "stat", target: validPath, status: "ok" });
      return toolResult("file_info", {
        path: validPath,
        type,
        size: stat.size,
        extension: stat.isFile() ? path.extname(validPath).toLowerCase() : "",
        created_at: stat.birthtime.toISOString(),
        modified_at: stat.mtime.toISOString(),
        accessed_at: stat.atime.toISOString(),
        detected_type: stat.isFile() ? detectFileType(head) : null,
        first_bytes_hex: stat.isFile() ? head.toString("hex").toUpperCase() : "",
        sha256: digest,
      });
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: "Save text to a local file. Routine local file update.",
      inputSchema: { path: z.string(), content: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, content }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const checkpointId = await checkpointBefore("write_file", [validPath]);
      await fs.mkdir(path.dirname(validPath), { recursive: true });
      await fs.writeFile(validPath, content, "utf-8");
      await audit({ tool: "write_file", action: "write", target: validPath, status: "ok", details: { bytes: Buffer.byteLength(content) } });
      const data = await enrichAfterEdit(
        { path: validPath, bytes: Buffer.byteLength(content), checkpoint_id: checkpointId },
        [validPath]
      );
      return toolResult("write_file", data);
    }
  );

  server.registerTool(
    "write_file_base64",
    {
      title: "Write File Base64",
      description:
        "Create or update a binary file from strict base64. For reliable multi-chunk transfers, provide expected_size on every chunk: data is written to <path>.part and the final path is replaced only after the exact size is reached and optional SHA256 verification passes. First call truncate=true, offset=0; later calls truncate=false with returned next_offset. Retries before finalization are idempotent; when expected_sha256 is supplied, a retry of the final chunk after finalization is also recognized safely. Prefer chunks <= 256 KiB in ChatGPT web.",
      inputSchema: {
        path: z.string(),
        content: z.string().max(MAX_BASE64_CHARS),
        offset: z.number().int().nonnegative().optional().default(0),
        truncate: z.boolean().optional().default(true),
        expected_size: z.number().int().nonnegative().optional(),
        expected_sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional(),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, content, offset, truncate, expected_size, expected_sha256 }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      if (truncate && offset !== 0) {
        throw new Error("truncate=true requires offset=0");
      }

      const buffer = decodeBase64Strict(content);
      if (expected_size !== undefined && offset + buffer.length > expected_size) {
        throw new Error(
          `Chunk exceeds expected_size: offset ${offset} + ${buffer.length} bytes > ${expected_size}`
        );
      }

      const staged = expected_size !== undefined;
      const writePath = staged ? `${validPath}.part` : validPath;
      const checkpointId = truncate ? await checkpointBefore("write_file_base64", [validPath]) : undefined;
      await fs.mkdir(path.dirname(validPath), { recursive: true });

      let idempotentRetry = false;
      if (truncate) {
        await fs.writeFile(writePath, buffer);
      } else {
        let currentSize = 0;
        try {
          currentSize = (await fs.stat(writePath)).size;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          if (staged && expected_sha256) {
            try {
              const finalStat = await fs.stat(validPath);
              if (finalStat.isFile() && finalStat.size === expected_size && offset + buffer.length <= finalStat.size) {
                const handle = await fs.open(validPath, "r");
                try {
                  const existing = Buffer.alloc(buffer.length);
                  const { bytesRead } = await handle.read(existing, 0, buffer.length, offset);
                  if (bytesRead === buffer.length && existing.equals(buffer)) {
                    const finalSha256 = await sha256File(validPath);
                    if (finalSha256.toLowerCase() === expected_sha256.toLowerCase()) {
                      return toolResult("write_file_base64", {
                        path: validPath,
                        bytes_written: 0,
                        offset,
                        next_offset: offset + buffer.length,
                        file_size: finalStat.size,
                        expected_size,
                        sha256: finalSha256,
                        finalized: true,
                        idempotent_retry: true,
                        checkpoint_id: checkpointId,
                      });
                    }
                  }
                } finally {
                  await handle.close();
                }
              }
            } catch (finalErr) {
              if ((finalErr as NodeJS.ErrnoException).code !== "ENOENT") throw finalErr;
            }
          }
          if (offset !== 0) throw new Error(`Cannot write at offset ${offset}: target file does not exist`);
          await fs.writeFile(writePath, Buffer.alloc(0));
        }

        if (offset > currentSize) {
          throw new Error(`Cannot write at offset ${offset}: current file size is ${currentSize}`);
        }

        if (offset < currentSize) {
          if (offset + buffer.length > currentSize) {
            throw new Error(
              `Chunk overlaps existing EOF: offset ${offset}, chunk ${buffer.length} bytes, current size ${currentSize}`
            );
          }
          const handle = await fs.open(writePath, "r");
          try {
            const existing = Buffer.alloc(buffer.length);
            const { bytesRead } = await handle.read(existing, 0, buffer.length, offset);
            if (bytesRead !== buffer.length || !existing.equals(buffer)) {
              throw new Error(`Chunk conflict at offset ${offset}: existing bytes differ from retry payload`);
            }
            idempotentRetry = true;
          } finally {
            await handle.close();
          }
        } else {
          const handle = await fs.open(writePath, "r+");
          try {
            await handle.write(buffer, 0, buffer.length, offset);
          } finally {
            await handle.close();
          }
        }
      }

      let stat = await fs.stat(writePath);
      let sha256: string | undefined;
      let finalized = false;

      if (staged && stat.size === expected_size) {
        if (expected_sha256) {
          sha256 = await sha256File(writePath);
          if (sha256.toLowerCase() !== expected_sha256.toLowerCase()) {
            throw new Error(`SHA256 mismatch: expected ${expected_sha256.toLowerCase()}, got ${sha256}`);
          }
        }
        await fs.rename(writePath, validPath);
        stat = await fs.stat(validPath);
        finalized = true;
      } else if (!staged && expected_sha256) {
        sha256 = await sha256File(validPath);
        if (sha256.toLowerCase() !== expected_sha256.toLowerCase()) {
          throw new Error(`SHA256 mismatch: expected ${expected_sha256.toLowerCase()}, got ${sha256}`);
        }
      }

      const nextOffset = offset + buffer.length;
      await audit({
        tool: "write_file_base64",
        action: "write",
        target: validPath,
        status: "ok",
        details: { bytes: buffer.length, offset, truncate, file_size: stat.size, expected_size, sha256, finalized, idempotentRetry },
      });
      return toolResult("write_file_base64", {
        path: validPath,
        bytes_written: buffer.length,
        offset,
        next_offset: nextOffset,
        file_size: stat.size,
        expected_size,
        sha256,
        finalized,
        staging_path: staged && !finalized ? writePath : undefined,
        idempotent_retry: idempotentRetry,
        checkpoint_id: checkpointId,
      });
    }
  );

  server.registerTool(
    "save_chatgpt_file",
    {
      title: "Save ChatGPT File",
      description:
        "Save a file attached to the current ChatGPT conversation directly to the local machine without Base64. Pass the attachment in file; ChatGPT supplies a temporary authorized file_id/download_url object. The original bytes are streamed to <path>.part, SHA256 is calculated, and the file is atomically published only after the transfer completes. If path is omitted, the original attachment name is saved in WORKSPACE_PATH.",
      inputSchema: {
        file: chatGptFileSchema.describe("A ChatGPT conversation attachment. Do not manually construct this object or copy file bytes into it."),
        path: z.string().optional().describe("Destination local path. Relative paths resolve from WORKSPACE_PATH. Defaults to the attachment file name."),
      },
      _meta: { "openai/fileParams": ["file"] },
      annotations: toolAnnotations("edit"),
    },
    async ({ file, path: destinationPath }) => {
      requireWriteAllowed();
      const requestedPath = destinationPath?.trim() || fallbackFileName(file);
      const validPath = await validatePath(requestedPath);
      const stagingPath = `${validPath}.part`;
      const checkpointId = await checkpointBefore("save_chatgpt_file", [validPath]);
      await fs.mkdir(path.dirname(validPath), { recursive: true });
      await fs.rm(stagingPath, { force: true });

      let finalUrlHost: string | undefined;
      try {
        const fetched = await fetchChatGptFile(file.download_url);
        finalUrlHost = new URL(fetched.finalUrl).hostname;
        const contentLengthRaw = fetched.response.headers.get("content-length");
        const contentLength = contentLengthRaw ? Number(contentLengthRaw) : undefined;
        if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > MAX_CHATGPT_FILE_BYTES) {
          throw new Error(`ChatGPT file is ${contentLength} bytes, above the ${MAX_CHATGPT_FILE_BYTES} byte safety limit`);
        }
        if (file.size !== undefined && file.size > MAX_CHATGPT_FILE_BYTES) {
          throw new Error(`ChatGPT file metadata reports ${file.size} bytes, above the ${MAX_CHATGPT_FILE_BYTES} byte safety limit`);
        }

        const { bytes, sha256 } = await streamResponseBodyToFile(fetched.response, stagingPath);
        if (file.size !== undefined && bytes !== file.size) {
          throw new Error(`ChatGPT file size mismatch: metadata says ${file.size} bytes, downloaded ${bytes}`);
        }
        if (contentLength !== undefined && Number.isFinite(contentLength) && bytes !== contentLength) {
          throw new Error(`ChatGPT file size mismatch: HTTP Content-Length says ${contentLength} bytes, downloaded ${bytes}`);
        }

        await fs.rename(stagingPath, validPath);
        const head = await readHead(validPath, 16);
        await audit({
          tool: "save_chatgpt_file",
          action: "write",
          target: validPath,
          status: "ok",
          details: { file_id: file.file_id, bytes, sha256, mime_type: file.mime_type, final_url_host: finalUrlHost },
        });
        return toolResult("save_chatgpt_file", {
          path: validPath,
          file_id: file.file_id,
          source_name: file.file_name ?? file.name,
          mime_type: file.mime_type,
          size: bytes,
          sha256,
          detected_type: detectFileType(head),
          first_bytes_hex: head.toString("hex").toUpperCase(),
          finalized: true,
          checkpoint_id: checkpointId,
        });
      } catch (error) {
        await fs.rm(stagingPath, { force: true });
        await audit({
          tool: "save_chatgpt_file",
          action: "write",
          target: validPath,
          status: "error",
          details: { file_id: file.file_id, final_url_host: finalUrlHost, error: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit File",
      description: "Apply exact text replacement to a file. Returns diff.",
      inputSchema: {
        path: z.string(),
        old_text: z.string(),
        new_text: z.string(),
        replace_all: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, old_text, new_text, replace_all, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const content = await fs.readFile(validPath, "utf-8");
      if (!content.includes(old_text)) throw new Error("old_text not found in file. Ensure exact match.");
      const newContent = replace_all ? content.split(old_text).join(new_text) : content.replace(old_text, new_text);
      const diff = buildSimpleDiff(content, newContent);
      const checkpointId = await checkpointBefore("edit_file", [validPath], { dry_run });
      if (!dry_run) await fs.writeFile(validPath, newContent, "utf-8");
      await audit({ tool: "edit_file", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok" });
      const data = await enrichAfterEdit({ path: validPath, diff, dry_run, checkpoint_id: checkpointId }, [validPath], dry_run);
      return toolResult("edit_file", data, { summary: dry_run ? `dry-run ${validPath}` : `edited ${validPath}` });
    }
  );

  server.registerTool(
    "multi_edit",
    {
      title: "Multi Edit",
      description: "Apply multiple exact replacements to one text file atomically.",
      inputSchema: {
        path: z.string(),
        edits: z.array(z.object({ old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional().default(false) })),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, edits, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const original = await fs.readFile(validPath, "utf-8");
      let next = original;
      for (const edit of edits) {
        if (!next.includes(edit.old_text)) throw new Error(`old_text not found: ${edit.old_text.slice(0, 120)}`);
        next = edit.replace_all ? next.split(edit.old_text).join(edit.new_text) : next.replace(edit.old_text, edit.new_text);
      }
      const diff = buildSimpleDiff(original, next);
      const checkpointId = await checkpointBefore("multi_edit", [validPath], { dry_run });
      if (!dry_run) await fs.writeFile(validPath, next, "utf-8");
      await audit({ tool: "multi_edit", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok", details: { edits: edits.length } });
      const data = await enrichAfterEdit(
        { path: validPath, diff, edits: edits.length, dry_run, checkpoint_id: checkpointId },
        [validPath],
        dry_run
      );
      return toolResult("multi_edit", data);
    }
  );

  server.registerTool(
    "replace_regex",
    {
      title: "Replace Regex",
      description: "Apply a JavaScript regex replacement to a text file.",
      inputSchema: { path: z.string(), pattern: z.string(), replacement: z.string(), flags: z.string().optional().default("g"), dry_run: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, pattern, replacement, flags, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const original = await fs.readFile(validPath, "utf-8");
      const regex = new RegExp(pattern, flags);
      const next = original.replace(regex, replacement);
      if (next === original) throw new Error("Regex made no changes.");
      const diff = buildSimpleDiff(original, next);
      const checkpointId = await checkpointBefore("replace_regex", [validPath], { dry_run });
      if (!dry_run) await fs.writeFile(validPath, next, "utf-8");
      await audit({ tool: "replace_regex", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok" });
      return toolResult("replace_regex", { path: validPath, diff, dry_run, checkpoint_id: checkpointId });
    }
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Preferred way to edit code. Codex @@ hunks or *** Begin Patch format. Read the file first. Use dry_run:true to preview.",
      inputSchema: {
        path: z.string().optional().describe("Target file (single-file) or base directory (multi-file)"),
        patch: z.string(),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, patch, dry_run }) => {
      requireWriteAllowed();

      if (isMultiFilePatch(patch)) {
        let baseDir: string | undefined;
        if (filePath) {
          const validPath = await validatePath(filePath);
          const stat = await fs.stat(validPath);
          baseDir = stat.isDirectory() ? validPath : path.dirname(validPath);
        }
        const patchPaths = parseMultiFilePatch(patch, baseDir).map((op) => op.path);
        const checkpointId = await checkpointBefore("apply_patch", patchPaths, { dry_run });
        const results = await applyMultiFilePatch(patch, { base_dir: baseDir, dry_run });
        const failed = results.filter((r) => !r.ok);
        await audit({
          tool: "apply_patch",
          action: "patch",
          target: baseDir || "multi",
          status: failed.length ? "error" : dry_run ? "dry-run" : "ok",
          details: { files: results.length, failed: failed.length },
        });
        const okPaths = results.filter((r) => r.ok && r.path).map((r) => r.path as string);
        const payload = await enrichAfterEdit(
          { files: results, dry_run, multi_file: true, checkpoint_id: checkpointId },
          okPaths,
          dry_run
        );
        return toolResult("apply_patch", payload, {
          ok: failed.length === 0,
          summary: `patched ${results.length} file(s)${failed.length ? `, ${failed.length} failed` : ""}`,
        });
      }

      if (!filePath) throw new Error("path is required for single-file patches");
      const validPath = await validatePath(filePath);
      const original = await fs.readFile(validPath, "utf-8");
      const next = applyUnifiedPatchToText(original, patch);
      const diff = buildSimpleDiff(original, next);
      const checkpointId = await checkpointBefore("apply_patch", [validPath], { dry_run });
      if (!dry_run) await fs.writeFile(validPath, next, "utf-8");
      await audit({ tool: "apply_patch", action: "patch", target: validPath, status: dry_run ? "dry-run" : "ok" });
      const data = await enrichAfterEdit({ path: validPath, diff, dry_run, checkpoint_id: checkpointId }, [validPath], dry_run);
      return toolResult("apply_patch", data);
    }
  );

  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description: "List files and directories in a path. Claude LS equivalent with optional ignore globs.",
      inputSchema: {
        path: z.string(),
        ignore: z.array(z.string()).optional().describe("Glob patterns to ignore, e.g. node_modules, *.log"),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: dirPath, ignore }) => {
      const validPath = await validatePath(dirPath);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      const ignoreMatchers = (ignore || []).map(
        (p) => new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i")
      );
      const filtered = entries.filter((e) => !ignoreMatchers.some((m) => m.test(e.name)));
      const items = filtered.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      await audit({ tool: "list_directory", action: "list", target: validPath, status: "ok" });
      return toolResult("list_directory", { path: validPath, entries: items, count: items.length });
    }
  );

  server.registerTool(
    "glob",
    {
      title: "Glob",
      description: "Explore: find files by name pattern under a directory. Use before read_text_file when you do not know exact paths.",
      inputSchema: {
        pattern: z.string().describe('Glob pattern like "**/*.ts" or "src/**/*.tsx"'),
        path: z.string().optional().describe("Directory to search in; defaults to workspace root context"),
        max_results: z.number().int().positive().max(500).optional().default(100),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ pattern, path: searchPath, max_results }) => {
      const validPath = searchPath ? await validatePath(searchPath) : (await import("../lib/path-security.js")).getAllowedRoots()[0];
      const matches = await globFiles(validPath, pattern, max_results);
      await audit({ tool: "glob", action: "glob", target: validPath, status: "ok", details: { pattern, results: matches.length } });
      return toolResult("glob", { path: validPath, pattern, matches: matches.map((m) => m.path), count: matches.length });
    }
  );

  server.registerTool(
    "grep",
    {
      title: "Grep",
      description: "Explore: search file contents by regex. Prefer over reading many files blindly. Modes: content, files_with_matches, count.",
      inputSchema: {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional().default("*"),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional().default("content"),
        case_insensitive: z.boolean().optional().default(false),
        multiline: z.boolean().optional().default(false),
        head_limit: z.number().int().positive().max(1000).optional().default(200),
        context_before: z.number().int().nonnegative().max(20).optional().default(0),
        context_after: z.number().int().nonnegative().max(20).optional().default(0),
        context_around: z.number().int().nonnegative().max(20).optional().default(0),
      },

      annotations: toolAnnotations("read"),
    },
    async ({
      pattern,
      path: searchPath,
      glob: globPattern,
      output_mode,
      case_insensitive,
      multiline,
      head_limit,
      context_before,
      context_after,
      context_around,
    }) => {
      const validPath = searchPath ? await validatePath(searchPath) : (await import("../lib/path-security.js")).getAllowedRoots()[0];
      const output = await grepSearch({
        pattern,
        path: validPath,
        glob: globPattern,
        outputMode: output_mode,
        caseInsensitive: case_insensitive,
        multiline,
        headLimit: head_limit,
        contextBefore: context_before,
        contextAfter: context_after,
        contextAround: context_around,
      });
      await audit({ tool: "grep", action: "grep", target: validPath, status: "ok", details: { pattern, output_mode } });
      return toolResult("grep", { path: validPath, pattern, output_mode, output });
    }
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete File",
      description: "Delete a file from the filesystem.",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const stat = await fs.stat(validPath);
      if (!stat.isFile()) throw new Error("Path is not a file");
      const checkpointId = await checkpointBefore("delete_file", [validPath]);
      await fs.unlink(validPath);
      await audit({ tool: "delete_file", action: "delete", target: validPath, status: "ok" });
      return toolResult("delete_file", { path: validPath, checkpoint_id: checkpointId });
    }
  );

  server.registerTool(
    "create_directory",
    {
      title: "Create Directory",
      description: "Create a directory (and parents if needed).",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(dirPath);
      await fs.mkdir(validPath, { recursive: true });
      await audit({ tool: "create_directory", action: "mkdir", target: validPath, status: "ok" });
      return toolResult("create_directory", { path: validPath });
    }
  );

  server.registerTool(
    "delete_directory",
    {
      title: "Remove Local Folder",
      description:
        "Remove a folder from the local workspace (user-specified path). Does not affect remote servers.",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(dirPath);
      const stat = await fs.stat(validPath);
      if (!stat.isDirectory()) throw new Error("Path is not a directory");
      const checkpointId = await checkpointBefore("delete_directory", [validPath]);
      await fs.rm(validPath, { recursive: true, force: true });
      await audit({ tool: "delete_directory", action: "rmdir", target: validPath, status: "ok" });
      return toolResult("delete_directory", {
        path: validPath,
        checkpoint_id: checkpointId,
        run_command_fallback: `Remove-Item -Recurse -Force "${validPath}"`,
      });
    }
  );

  server.registerTool(
    "copy_file",
    {
      title: "Copy File",
      description: "Copy a file to a new location.",
      inputSchema: { source: z.string(), destination: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ source, destination }) => {
      requireWriteAllowed();
      const src = await validatePath(source);
      const dest = await validatePath(destination);
      const stat = await fs.stat(src);
      if (!stat.isFile()) throw new Error("Source is not a file");
      const checkpointId = await checkpointBefore("copy_file", [dest]);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      await audit({ tool: "copy_file", action: "copy", target: dest, status: "ok", details: { source: src } });
      return toolResult("copy_file", { source: src, destination: dest, checkpoint_id: checkpointId });
    }
  );

  server.registerTool(
    "move_file",
    {
      title: "Move File",
      description: "Move or rename a file or directory.",
      inputSchema: { source: z.string(), destination: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ source, destination }) => {
      requireWriteAllowed();
      const src = await validatePath(source);
      const dest = await validatePath(destination);
      const checkpointId = await checkpointBefore("move_file", [src, dest]);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fs.rename(src, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        const stat = await fs.stat(src);
        if (stat.isDirectory()) {
          await fs.cp(src, dest, { recursive: true, force: true });
          await fs.rm(src, { recursive: true, force: true });
        } else if (stat.isFile()) {
          await fs.copyFile(src, dest);
          const copied = await fs.stat(dest);
          if (copied.size !== stat.size) {
            throw new Error(`Cross-volume copy verification failed: ${copied.size} != ${stat.size}`);
          }
          await fs.unlink(src);
        } else {
          throw new Error("Cross-volume move supports files and directories only");
        }
      }
      await audit({ tool: "move_file", action: "move", target: dest, status: "ok", details: { source: src } });
      return toolResult("move_file", { source: src, destination: dest, checkpoint_id: checkpointId });
    }
  );

  server.registerTool("search_files", { title: "Search Files", description: "Search file contents for a text pattern.", inputSchema: { path: z.string(), pattern: z.string(), glob: z.string().optional().default("*"), max_results: z.number().optional().default(50) }, annotations: toolAnnotations("read") }, async ({ path: searchPath, pattern, glob: globPattern, max_results }) => {
    const validPath = await validatePath(searchPath);
    const results: string[] = [];
    await searchDirectory(validPath, new RegExp(pattern, "i"), globPattern, results, max_results);
    await audit({ tool: "search_files", action: "search", target: validPath, status: "ok", details: { pattern, results: results.length } });
    return toolResult("search_files", { path: validPath, pattern, matches: results, count: results.length });
  });

  server.registerTool("directory_tree", { title: "Directory Tree", description: "Get recursive directory structure as JSON.", inputSchema: { path: z.string(), max_depth: z.number().optional().default(4) }, annotations: toolAnnotations("read") }, async ({ path: dirPath, max_depth }) => {
    const validPath = await validatePath(dirPath);
    const tree = await buildTree(validPath, 0, max_depth);
    await audit({ tool: "directory_tree", action: "tree", target: validPath, status: "ok" });
    return toolResult("directory_tree", { path: validPath, tree, max_depth });
  });

  server.registerTool("list_allowed_directories", { title: "List Allowed Directories", description: "Show default working directory and machine access scope.", inputSchema: {}, annotations: toolAnnotations("read") }, async () => {
    const { getDefaultCwd, getMachineRoots } = await import("../lib/path-security.js");
    const { describePermissionProfile } = await import("../lib/permissions.js");
    const machineRoots = getMachineRoots();
    return toolResult("list_allowed_directories", {
      full_machine_access: true,
      permission: describePermissionProfile(),
      default_cwd: getDefaultCwd(),
      machine_roots: machineRoots,
    });
  });
}
