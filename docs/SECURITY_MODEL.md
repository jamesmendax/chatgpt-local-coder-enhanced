# Security model

ChatGPT Local Coder is intentionally a privileged local automation service. It can expose filesystem, shell, git, and related development operations through MCP. It should not be treated as a sandbox or as safe for untrusted clients.

## Trust boundary

The main trust boundary is the MCP endpoint. A client that can successfully use the connector may be able to read or modify files and execute commands according to the configured permission model.

Recommended baseline:

- bind the MCP service to `127.0.0.1`
- expose only the MCP port through a tunnel you control
- never expose the Admin UI port through that tunnel
- use a strong `MCP_TOKEN` when the connection mode supports it
- set `ADMIN_TOKEN` for the local Admin UI
- keep Runtime API keys and tunnel configuration out of git
- only connect trusted ChatGPT workspaces/clients

## Local paths and permissions

`WORKSPACE_PATH` defines the default working directory. It is not automatically a security sandbox. Check the active permission configuration with `agent_status` before assuming paths outside the workspace are blocked.

Any change that removes or bypasses existing path validation or write-permission checks should be treated as a security-sensitive change.

## Shell and git

Shell execution is powerful enough to bypass higher-level file wrappers. If shell access is enabled, the effective trust level is close to local developer access.

Do not run commands copied from unknown repositories or untrusted web content without review.

## Admin UI

The Admin UI can expose operational state and may modify configuration. Keep it loopback-only and do not tunnel `ADMIN_PORT`.

## ChatGPT attachment download path

`save_chatgpt_file` is designed for current-conversation attachments supplied by ChatGPT through MCP `openai/fileParams` metadata.

The tool deliberately does not accept a plain arbitrary URL field as its public API. ChatGPT supplies a temporary attachment reference containing `file_id` and `download_url`.

The implementation adds network protections before following that URL:

- HTTPS is required
- `localhost`, `.localhost`, and `.local` are rejected
- literal private/reserved IP addresses are rejected
- DNS-resolved addresses are checked for private/reserved ranges
- each redirect target is revalidated
- redirects are bounded
- download duration is bounded by an abort timeout
- the response body is streamed and capped at 512 MiB by default

These checks reduce SSRF exposure but should still be considered security-sensitive code. Changes to URL validation, DNS handling, redirect behavior, file-size limits, or fetch behavior should receive focused review and tests.

Some local proxy products return synthetic DNS addresses for public hosts. The implementation contains a narrow allowance for recognized synthetic ranges so legitimate ChatGPT attachment downloads can work through those proxies without allowing normal private LAN targets.

## File finalization

Both direct attachment saving and reliable Base64 writes use staging files ending in `.part`.

The intent is that an interrupted or invalid transfer should not leave a corrupt partial file under the requested final filename.

For `save_chatgpt_file`:

- bytes are streamed to `<target>.part`
- SHA256 is calculated during streaming
- attachment size and HTTP `Content-Length` are checked when present
- staging is removed on failure
- final rename occurs only after successful completion

For `write_file_base64` staged mode:

- `expected_size` controls finalization
- optional `expected_sha256` adds integrity verification
- conflicting retries/overlaps are rejected

## Secrets and repository hygiene

Never commit:

- `.env`
- `.secrets/`
- real `MCP_TOKEN` values
- Runtime API keys
- real tunnel IDs
- generated tunnel profiles
- local MCP state/checkpoints/logs
- private workspace contents
- connector URLs that embed credentials

The repository includes `npm run check:secrets` as a lightweight pre-push guard. It is not a substitute for GitHub secret scanning or manual review.

## Disclosure

See the root [SECURITY.md](../SECURITY.md) for vulnerability-reporting guidance.
