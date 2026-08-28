<div align="center">

<img src="icon.png" alt="ChatGPT Local Coder Enhanced" width="96">

# ChatGPT Local Coder Enhanced

**Self-hosted MCP server for ChatGPT with local files, shell, git, checkpoints, direct attachment saving, and verified binary-file transfer.**

[![CI](https://github.com/jamesmendax/chatgpt-local-coder-enhanced/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesmendax/chatgpt-local-coder-enhanced/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-43853d?style=flat-square)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1?style=flat-square)](https://modelcontextprotocol.io/)
[![Maintenance](https://img.shields.io/badge/maintenance-active-brightgreen?style=flat-square)](CHANGELOG.md)
[![Last commit](https://img.shields.io/github/last-commit/jamesmendax/chatgpt-local-coder-enhanced?style=flat-square)](https://github.com/jamesmendax/chatgpt-local-coder-enhanced/commits/main)

</div>

> [!WARNING]
> This server can read and write local files and execute shell commands. Treat the MCP endpoint as privileged remote access to your computer. Read [SECURITY.md](SECURITY.md) before exposing it through any tunnel.

## About this fork

This repository is the enhanced fork maintained by [@jamesmendax](https://github.com/jamesmendax) at [`jamesmendax/chatgpt-local-coder-enhanced`](https://github.com/jamesmendax/chatgpt-local-coder-enhanced). It is based on [`hoangcoderr/chatgpt-local-coder`](https://github.com/hoangcoderr/chatgpt-local-coder) and remains MIT licensed.

The enhanced branch adds and hardens direct ChatGPT attachment saving, ChatGPT web tool profiles, MCP session recovery, checkpoint/rewind support, verified binary-file transfer, file inspection, Windows dual-tunnel launchers, and additional integration tests. See [NOTICE.md](NOTICE.md) and [CHANGELOG.md](CHANGELOG.md).

## What it does

```text
ChatGPT Web
    |
    | HTTPS / Secure MCP Tunnel
    v
+---------------------------+
| ChatGPT Local Coder       |
| MCP server on localhost   |
+-------------+-------------+
              |
       +------+------+----------------+
       |             |                 |
       v             v                 v
   Filesystem      Shell + Git     Checkpoints
   text/binary     commands        rewind
       |
       v
 verified binary transfer
 .part -> size/SHA256 -> final file
```

Current automated tests verify **53 statically registered native tools**. The default `slim` profile exposes **39** tools to keep ChatGPT's `tools/list` payload smaller; `full` exposes all native tools.

Highlights:

- text file read/write/edit, glob, grep, directory listing, patch application
- direct ChatGPT conversation-attachment saving with `save_chatgpt_file` without Base64-copying the whole file through the model
- streaming download to `<target>.part` with SHA256 and size validation before finalization
- binary file read/write with chunk offsets for generic MCP transfers
- safe staged Base64 writes using `<target>.part`
- optional `expected_size` and streaming SHA256 validation before finalization
- `file_info` for size, timestamps, SHA256, and magic-byte inspection
- persistent local shell, background processes, and Node REPL
- git status/diff/add/commit/restore plus additional git tools in `full`
- automatic file checkpoints and `rewind`
- MCP session recovery after reconnects/restarts
- bounded MCP session retention with idle TTL, an LRU cap, and active-request protection to prevent ChatGPT web sessions from accumulating in RAM
- local Admin UI and optional upstream MCP hub
- OpenAI Secure MCP Tunnel helpers on Windows
- optional Free/Business dual-tunnel launchers sharing one local MCP server

## Project status

**Active maintenance.** The repository is intended to remain deployable from a clean clone. User-facing changes are recorded in [CHANGELOG.md](CHANGELOG.md), automated verification runs in GitHub Actions, and bug reports or focused pull requests are welcome through GitHub Issues/PRs.

Current tested baseline: **39 tools in `slim`** and **53 native tools in the full catalog**.

Session retention defaults are tuned for ChatGPT web workloads: idle sessions expire after 5 minutes, cleanup runs every 30 seconds, and at most 32 retained sessions are kept by default. These values are configurable with `MCP_SESSION_TTL_MS`, `MCP_SESSION_CLEANUP_MS`, and `MCP_SESSION_MAX_COUNT`. Evicted or expired session IDs remain recoverable on the next tool call, so this retention policy does not expire the ChatGPT conversation itself.

## Requirements

- Node.js 20 or newer
- npm
- Git if you want the git tools
- Windows PowerShell for the included `.ps1` and one-click tunnel helpers

The Node/TypeScript MCP server itself is cross-platform. The Windows tunnel convenience scripts are not.

## Quick start

```powershell
git clone https://github.com/jamesmendax/chatgpt-local-coder-enhanced.git
cd chatgpt-local-coder-enhanced
copy .env.example .env
npm ci
npm run build
```

Edit `.env` and set at minimum:

```env
WORKSPACE_PATH=C:\path\to\your\project
MCP_TOKEN=<generate-a-long-random-token>
```

Generate a token with:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Start the MCP server:

```powershell
.\start.ps1
```

Health check:

```text
http://127.0.0.1:3000/health
```

Do **not** expose the Admin UI port (`ADMIN_PORT`, default 3001) through a tunnel.

## Connect ChatGPT

For current ChatGPT Business custom MCP apps:

1. Start the local MCP server and your tunnel.
2. In the Business workspace, open **Workspace Settings -> Apps** and create a custom MCP app.
3. Enter the tunnel connection details.
4. Run **Scan Tools**.
5. Create the app as a draft and test it in a new chat.
6. Publish only after the draft works.

Published Business custom MCP apps use a snapshot of the tool definitions. If you later change tool names or input schemas, recreate/re-publish the app rather than assuming the published app will automatically pick up the new tool list.

OpenAI reference: [Developer mode, apps, and full MCP connectors](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta).

More detail: [docs/CHATGPT_BUSINESS.md](docs/CHATGPT_BUSINESS.md).

## OpenAI Secure MCP Tunnel on Windows

The helper downloads/uses OpenAI's `tunnel-client` and generates its local profile under the gitignored `profiles/` directory.

First install the tunnel client:

```powershell
.\openai-tunnel.ps1 -Install
```

Configure the primary tunnel ID in `.env`:

```env
OPENAI_TUNNEL_ID=tunnel_<your-id>
OPENAI_TUNNEL_HEALTH_PORT=8080
```

Prefer storing the Runtime API key with Windows DPAPI instead of plaintext `.env`:

```powershell
.\save-free-key.cmd
```

Then run:

```powershell
.\openai-tunnel.ps1
```

### Optional second Business tunnel

A second tunnel can share the same local MCP server. Configure only its ID/health port in `.env`:

```env
OPENAI_BUSINESS_TUNNEL_ID=tunnel_<your-business-id>
OPENAI_BUSINESS_TUNNEL_HEALTH_PORT=8081
```

Store its Runtime key once:

```powershell
.\save-business-key.cmd
```

One-click launchers:

```text
start-free-plugin.cmd
stop-free-plugin.cmd
start-business-plugin.cmd
stop-business-plugin.cmd
```

Both roles share the same port-3000 MCP process and therefore the same configured `WORKSPACE_PATH`; the launchers only separate the tunnel processes. See [docs/WINDOWS_DUAL_TUNNEL.md](docs/WINDOWS_DUAL_TUNNEL.md).

## Binary files and large ChatGPT attachments

For a file attached to the current ChatGPT conversation, prefer `save_chatgpt_file`. ChatGPT supplies a temporary authorized attachment reference through the MCP `openai/fileParams` mechanism, and the local MCP streams the original bytes directly to disk instead of sending the whole file through Base64 tool arguments.

```text
ChatGPT conversation attachment
          |
          v
   save_chatgpt_file
          |
          v
    target.bin.part
          |
          +-- HTTPS/public-host checks
          +-- streaming size limit
          +-- metadata/Content-Length checks
          +-- SHA256 while streaming
          |
          v
     atomic finalize
          |
          v
      target.bin
```

The current default safety limit for this direct attachment path is **512 MiB**. Redirects are bounded, URLs must use HTTPS, and localhost/private/reserved destinations are rejected to reduce SSRF risk.

For generic binary transfer when there is no ChatGPT attachment object, use `read_file_base64` / `write_file_base64`. Reliable Base64 writes support `<target>.part`, `expected_size`, and optional `expected_sha256` validation before finalization.

`file_info` can verify the final local file's size, hash, timestamps, and leading magic bytes.

See [docs/BINARY_FILES.md](docs/BINARY_FILES.md).

## Tool profiles

Set in `.env`:

```env
CHATGPT_TOOL_PROFILE=slim
```

- `slim`: 39 tools in the current test suite; optimized for ChatGPT web discovery.
- `full`: all 53 statically registered native tools.

Core filesystem tools exposed in `slim` include:

```text
read_text_file
read_file_base64
file_info
write_file
write_file_base64
save_chatgpt_file
edit_file
multi_edit
apply_patch
glob
grep
list_directory
create_directory
copy_file
move_file
delete_file
```

`delete_directory` remains outside the default slim set.

## Security model

Important defaults and recommendations:

- keep `HOST=127.0.0.1`
- set a strong `MCP_TOKEN` before exposing port 3000 remotely
- never tunnel `ADMIN_PORT`
- set `ADMIN_TOKEN` if you use the Admin UI regularly
- never commit `.env`, `.secrets/`, generated tunnel profiles, audit logs, or MCP state
- only connect trusted ChatGPT workspaces/clients
- do not send untrusted instructions to a connector with full local shell/file privileges
- review destructive operations such as deletes, resets, installs, or scripts from unknown repositories

See [SECURITY.md](SECURITY.md).

## Development

```powershell
npm ci
npm run build
npm run test:all
npm run check:secrets
```

Or run the combined verification command:

```powershell
npm run verify
```

The integration suite starts a temporary MCP server on a separate test port; it does not require replacing your normal port-3000 service.

## Repository hygiene

Runtime/private data is intentionally ignored, including:

```text
.env
.secrets/
profiles/*.yaml
bin/
node_modules/
dist/
.mcp-state/
.mcp-checkpoints/
.mcp-audit.log
```

The repository includes a lightweight secret-pattern check in addition to GitHub's own secret-scanning features.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm run verify` before opening a pull request. Bug reports can use the repository issue template, and focused improvements are welcome.

## License

MIT. The original upstream copyright notice is preserved in [LICENSE](LICENSE). Additional attribution and fork information are in [NOTICE.md](NOTICE.md).

## Disclaimer

This project is provided on an **"AS IS"** basis, without warranties or guarantees of availability, fitness for a particular purpose, security, data integrity, or compatibility with any specific ChatGPT/OpenAI configuration. You are solely responsible for how you deploy and use it, including any filesystem, shell, Git, network, tunnel, credential, or data-access consequences. The maintainers are not responsible for direct or indirect loss, data loss, service interruption, account issues, security incidents, or other damages resulting from use of this project.

## Non-commercial use notice

The maintainer does **not authorize or endorse commercial use of the enhanced additions maintained in this fork** without prior permission. If you plan to sell this enhanced fork, bundle its enhanced functionality into a paid product or service, provide paid deployment/support based on the maintainer's added work, or otherwise use the maintainer's original enhancements for commercial gain, please obtain permission from the maintainer first.

> Important: this repository is derived from MIT-licensed upstream software. The upstream MIT license grants rights, including commercial-use rights, to the upstream code covered by that license. This non-commercial notice is not intended to revoke or misrepresent rights already granted by the upstream MIT license. If stricter, legally enforceable non-commercial terms are required for the maintainer's original additions, those additions should be placed under a separate compatible license/notice rather than treating the entire upstream-derived repository as non-commercial.
