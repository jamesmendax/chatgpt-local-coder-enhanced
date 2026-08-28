# Security Policy

## Security model

ChatGPT Local Coder is intentionally powerful. A connected MCP client can read and write local files, run shell commands, and use git according to the server's configured permissions. It is **not** a sandbox.

Treat access to the MCP endpoint as privileged access to the host machine.

## Safe deployment baseline

- Keep `HOST=127.0.0.1`.
- Set a long random `MCP_TOKEN` before exposing port 3000 through any tunnel.
- Never expose `ADMIN_PORT` through a public tunnel.
- Prefer setting `ADMIN_TOKEN` even when the Admin UI is loopback-only.
- Keep `.env`, `.secrets/`, generated tunnel profiles, audit logs, checkpoints, and MCP state out of git.
- Store Windows tunnel Runtime keys with the provided DPAPI helpers where possible.
- Use only trusted ChatGPT workspaces/clients and trusted prompts.
- Review destructive operations such as delete, reset, install, package scripts, and commands from unknown repositories.

## Binary-file and attachment safety

For a file attached to the current ChatGPT conversation, prefer `save_chatgpt_file`. It uses ChatGPT's MCP file-parameter mechanism, streams bytes to `<target>.part`, calculates SHA256, validates available size metadata, and only publishes the final file after the transfer completes.

The attachment download path requires HTTPS, revalidates redirects, rejects localhost/private/reserved destinations, and caps the response body at 512 MiB by default to reduce SSRF and resource-exhaustion risk.

For generic binary transfer, use `write_file_base64` with `expected_size` and `expected_sha256` when available. Its staged mode also writes to `<target>.part` and only publishes the final path after validation succeeds.

Use `file_info` after transfer when the file type or hash matters. See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) and [docs/BINARY_FILES.md](docs/BINARY_FILES.md).

## Reporting a vulnerability

Do not open a public issue containing secrets, exploit details, tunnel IDs, API keys, or private file contents.

If the repository has GitHub Private Vulnerability Reporting enabled, use that channel. Otherwise contact the repository maintainer privately through the contact method listed on the repository profile and include:

- affected version/commit
- reproduction steps
- impact
- suggested mitigation if known

Please allow reasonable time for investigation before public disclosure.

## Supported versions

Security fixes are applied to the current `main` branch unless a release explicitly states otherwise.
