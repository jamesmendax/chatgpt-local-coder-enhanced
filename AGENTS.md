# ChatGPT Local Coder - Agent Onboarding

This repository runs a local MCP server that can expose filesystem, shell, git, checkpoint, and optional upstream-MCP capabilities to ChatGPT or another MCP client.

## First connection

1. Call `agent_status` to inspect the active tool profile, workspace roots, and permission mode.
2. Call `project_context` only when you need project memory for a repository other than the configured `WORKSPACE_PATH`.

## Access model

- `WORKSPACE_PATH` is the default cwd for relative paths and shell/git operations.
- Depending on the configured permission model, absolute paths may be allowed outside `WORKSPACE_PATH`.
- This project is not a sandbox. A connected client can be highly privileged.
- Review destructive operations before running them.

## ChatGPT Business app lifecycle

For Business custom MCP apps, use the current Apps workflow:

1. Start the MCP server and tunnel.
2. Open Workspace Settings -> Apps.
3. Create a custom MCP app and configure the endpoint.
4. Run Scan Tools.
5. Test the draft in a new chat.
6. Publish only after validation.

Published app definitions should be treated as a snapshot. If tool names, schemas, or OpenAI-specific tool metadata change, recreate/re-publish the app rather than assuming the published definition refreshes automatically.

## Tool profiles

`CHATGPT_TOOL_PROFILE` selects the native tool set.

| Profile | Native tools | Intended use |
|---|---:|---|
| `slim` | 39 | ChatGPT web, smaller `tools/list` payload |
| `full` | 53 | Other MCP clients or advanced/diagnostic tools |

The current `slim` profile includes the important file tools such as:

- `read_text_file`
- `read_file_base64`
- `file_info`
- `write_file`
- `write_file_base64`
- `save_chatgpt_file`
- `edit_file`
- `multi_edit`
- `apply_patch`
- `glob`
- `grep`
- `list_directory`
- `create_directory`
- `copy_file`
- `move_file`
- `delete_file`

`delete_directory` remains outside the default slim profile.

## ChatGPT attachments

For a file attached to the current ChatGPT conversation, prefer `save_chatgpt_file`.

It uses MCP metadata `openai/fileParams` so ChatGPT can pass an authorized attachment reference. The local MCP then streams the original bytes directly to disk instead of sending the whole file as Base64 through the model/tool arguments.

The direct attachment path:

- accepts HTTPS download URLs supplied with the ChatGPT attachment reference
- rejects localhost/private/reserved destinations to reduce SSRF risk
- limits redirects
- streams to `<target>.part`
- enforces a 512 MiB safety limit by default
- validates attachment/HTTP size metadata when present
- calculates SHA256 while streaming
- only publishes the final path after the transfer completes

For other binary transfer, use `read_file_base64` / `write_file_base64`.

## Editing workflow

- Find files: `glob`
- Search contents: `grep`
- Read text: `read_text_file`
- Inspect binary/local file: `file_info`
- Patch code: `apply_patch` (preferred)
- Multiple exact replacements: `multi_edit`
- Create text: `write_file`
- Save current ChatGPT attachment: `save_chatgpt_file`
- Generic binary transfer: `read_file_base64` / `write_file_base64`
- Short commands/tests: `run_command`
- Long jobs: `start_process`, then `process_status` / `process_output` / `stop_process`
- Undo MCP-tracked file edits: `rewind`

## Binary transfer

For generic Base64 writes, prefer staged mode:

- first chunk: `offset=0`, `truncate=true`
- provide `expected_size` on every chunk
- provide `expected_sha256` when available
- later chunks: `truncate=false` and continue from `next_offset`

The staged file is `<target>.part` and is finalized only after validation.

## Git

Common tools include `git_status`, `git_diff`, `git_add`, `git_commit`, and `git_restore`. Additional git operations are available in `full` or through `run_command` depending on the active profile.

## Startup

Windows:

```powershell
.\start.ps1
.\openai-tunnel.ps1
```

Optional dual-tunnel helpers are documented in `docs/WINDOWS_DUAL_TUNNEL.md`.

macOS/Linux can run the Node server directly with `npm start`; the provided Windows PowerShell tunnel helpers are platform-specific.

## Security

Read `SECURITY.md` and `docs/SECURITY_MODEL.md` before exposing this server remotely.

Never commit or publish real `.env` values, `.secrets/`, tunnel IDs, Runtime API keys, generated tunnel profiles, MCP tokens, private workspace contents, or local runtime state.
