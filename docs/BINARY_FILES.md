# Binary files and ChatGPT attachments

ChatGPT Local Coder has two binary-transfer paths:

1. `save_chatgpt_file` for a file attached to the current ChatGPT conversation.
2. `read_file_base64` / `write_file_base64` for generic binary transfer when no ChatGPT attachment object is available.

## Preferred path: `save_chatgpt_file`

When a user attaches a file in ChatGPT, the MCP tool declares:

```json
{
  "openai/fileParams": ["file"]
}
```

This allows ChatGPT to pass a temporary authorized attachment reference to the tool. The local MCP then streams the original bytes directly from the provided `download_url` to the local filesystem.

The file bytes are not copied through Base64 model/tool arguments.

```text
ChatGPT conversation attachment
          |
          v
   save_chatgpt_file
          |
          v
  authorized HTTPS URL
          |
          v
    target.ext.part
          |
          +-- bounded redirects
          +-- public-host / SSRF checks
          +-- 512 MiB safety limit
          +-- metadata size validation
          +-- HTTP Content-Length validation
          +-- streaming SHA256
          |
          v
     final rename
          |
          v
      target.ext
```

### Input

The `file` parameter is supplied by ChatGPT and should not be manually constructed. Its schema includes fields such as:

- `file_id`
- `download_url`
- optional original file name
- optional MIME type
- optional size metadata

The optional `path` parameter selects the local destination. Relative paths resolve from `WORKSPACE_PATH`. If `path` is omitted, the original attachment name is used when available.

### Safety behavior

The direct attachment path currently:

- requires HTTPS
- rejects `localhost`, `.localhost`, and `.local` hostnames
- rejects private/reserved IP destinations
- resolves hostnames and checks resolved addresses
- permits known proxy synthetic addresses used by some local proxy setups without treating them as real LAN addresses
- manually validates each redirect destination
- limits redirects to 5
- uses a 120-second fetch timeout
- limits the downloaded body to 512 MiB by default
- compares downloaded byte count with ChatGPT attachment metadata when a size is supplied
- compares downloaded byte count with HTTP `Content-Length` when supplied
- calculates SHA256 while streaming
- writes to `<destination>.part`
- removes the staging file on failure
- only renames the staging file to the final destination after the transfer completes successfully

This design is intended to make the tool useful for large conversation attachments without turning it into an unrestricted internal-network downloader.

## Generic binary path: Base64

Use `read_file_base64` and `write_file_base64` when the source is not a ChatGPT conversation attachment or when the MCP client does not support the attachment metadata mechanism.

Typical formats include PNG/JPEG/WebP images, PDF, ZIP, DOCX, XLSX, PPTX, audio, video, databases, and other opaque binary formats.

For reliable writes, provide `expected_size` on every `write_file_base64` call. The server writes to:

```text
<final-path>.part
```

and publishes the final path only after the staged size is exactly correct. If `expected_sha256` is supplied, the hash must also match before finalization.

```text
source bytes
   |
   v
base64 chunks
   |
   v
file.bin.part
   |
   +-- expected_size reached?
   +-- expected_sha256 matches? (when provided)
   |
   v
rename/finalize
   |
   v
file.bin
```

### Recommended Base64 flow

1. Calculate source byte size.
2. Calculate SHA256 when possible.
3. Send small Base64 chunks. For ChatGPT web, decoded chunks around 64-256 KiB are practical even though the server-side hard limit is larger.
4. First call: `offset=0`, `truncate=true`, `expected_size=<total bytes>`.
5. Later calls: `truncate=false` and continue from the previous `next_offset`.
6. Include `expected_sha256` when available.
7. After finalization, call `file_info` with `sha256=true` when independent verification matters.

### Retry behavior

A repeated chunk at an already-written offset is accepted only when existing bytes match the payload. Normal retries are therefore idempotent instead of silently overwriting different data.

A conflicting overlap is rejected.

## `file_info`

`file_info` is read-only and can return:

- path type
- file size
- extension
- created/modified/accessed timestamps
- optional SHA256
- leading bytes as hexadecimal
- basic magic-byte detection for PNG, JPEG, GIF, WebP, PDF, and ZIP-based formats

Common signatures:

```text
PNG       89504E470D0A1A0A
JPEG      FFD8FF
PDF       255044462D
ZIP       504B0304
```

DOCX/XLSX/PPTX are ZIP containers, so their outer signature normally appears as ZIP.

## Which path should I use?

```text
Is the file attached to the current ChatGPT conversation?
          |
       yes|-----------------> save_chatgpt_file
          |
         no
          |
          v
Do you need generic local/MCP binary transfer?
          |
          +-----------------> read_file_base64 / write_file_base64
```

For large ChatGPT attachments, `save_chatgpt_file` is the preferred path because it avoids expanding the file into Base64 and avoids repeatedly transporting those bytes through tool arguments.
