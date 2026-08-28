# Changelog

All notable user-facing changes to ChatGPT Local Coder Enhanced are recorded here.

## Unreleased

No unreleased changes yet.

## 1.1.0 - 2026-08-28

### Added

- `save_chatgpt_file` for direct streaming of files attached to the current ChatGPT conversation without Base64 transport through tool arguments.
- ChatGPT attachment metadata support through MCP `openai/fileParams`.
- Attachment-download hardening: HTTPS-only URLs, public-host validation, bounded redirects, 512 MiB streaming limit, size checks, SHA256 calculation, `.part` staging, and cleanup on failure.
- Verified binary-file transfer workflow for generic MCP clients.
- Staged binary writes using `.part` files before finalization.
- Optional file size and SHA256 verification before publishing binary output.
- `file_info` inspection for file metadata and magic-byte detection.
- Windows Free/Business dual-tunnel launchers that share one local MCP server and workspace.
- Linux and Windows GitHub Actions validation for public releases.
- Security, contributor, deployment, and binary-file documentation for public users.

### Changed

- Default ChatGPT `slim` profile is documented and tested at 39 tools; the full native catalog is documented and tested at 53 tools.
- Updated public documentation for the current ChatGPT Business custom MCP app workflow.
- Improved repository hygiene guidance for secrets, tunnel configuration, runtime state, and generated profiles.
- Normalized package metadata under `chatgpt-local-coder-enhanced` version `1.1.0`.
- Public release history is consolidated under the current maintainer identity while preserving the upstream project history and MIT attribution.

### Security

- Added SSRF-focused validation for the ChatGPT attachment download path, including redirect revalidation and private/reserved address rejection.
- Runtime API keys, tunnel IDs, MCP tokens, `.env`, DPAPI key files, generated tunnel profiles, and machine-specific state are excluded from the public release.
- Added a public secret-pattern verification step to CI.

### Compatibility

- Node.js 20+ is the supported runtime baseline.
- The Node/TypeScript MCP server remains cross-platform.
- Included one-click tunnel and DPAPI convenience scripts target Windows PowerShell.
