# Changelog

All notable user-facing changes to ChatGPT Local Coder Enhanced are recorded here.

## 1.3.0 - 2026-08-30

### Added

- Durable goal mode with continuous-execution contract: mechanical completion gates, revision CAS, `requires_confirmation` criteria with explicit user-confirmation evidence, structured blockers, and an execution-policy state lock surfaced with every goal result.
- Goal continuation signals on every tool result: imperative continuation tail, `MUST_CONTINUE_TO_TOOL` / reply-suppression lock, escalating wording on stagnation, and per-session retention reset so new chats always see the active goal.
- `goal/stall` telemetry: "report-and-wait" relapses are recorded as events (task-backed and goal-only workflows; sanctioned blocker yields are exempt).
- harness-events v2 event log: header + two-way version refusal, seq contiguity, torn-tail repair, mid-file quarantine, legacy migration, and counted (never silent) write failures exposed via `agent_status`.
- Context broker: budgeted harness-context snapshots on every tool result with change-detection dedup, per-session retention reset, repair-generation invalidation, and incremental evidence reads.
- Supersede flow: `goal(create, supersede=true)` atomically replaces an existing goal with a clean one and cancels its stale durable task.
- Repeat guard: escalating reminders for consecutive identical tool calls (state tools exempt).
- Spill references for large command output and sha256 artifact references.
- Projection replay-parity tests, goal outcome crystallization into cross-session memory, git timeout protection, node_repl async deadline, and persistent-shell cwd/cwd-state fixes.

### Changed

- tools/list budget is now measured on the tools payload (27 tools, ~22 KB).
- `.env.example` and AGENTS.md refreshed to match the shipped tool surface.

### Compatibility

- No tool names or input schemas were removed; the slim tools/list contract holds at 27 tools.
- Existing ChatGPT Apps do not require re-publication.

## 1.2.0 - 2026-08-28

### Added

- Bounded MCP session retention with a configurable LRU cap (`MCP_SESSION_MAX_COUNT`, default 32).
- Active-request and initialization protection so in-flight MCP work is not evicted by TTL or LRU cleanup.
- Integration coverage that creates more sessions than the configured cap, verifies the cap, and verifies stale-session auto-recovery after eviction.

### Changed

- Default idle session TTL is reduced from 24 hours to 5 minutes for ChatGPT web workloads that may initialize a new MCP session for individual tool calls.
- Default session cleanup interval is reduced from 5 minutes to 30 seconds.
- Expired and LRU-evicted sessions close their transports and unregister their per-session MCP servers so memory can be reclaimed promptly.
- Session retention remains transparent to normal ChatGPT conversations: an expired/evicted MCP session ID is rebuilt on the next tool call through the existing recovery path.

### Fixed

- Prevented long-running ChatGPT web usage from retaining hundreds of per-session `McpServer` and transport objects and causing steadily increasing Node.js heap usage.
- Fixed an orphaned recovery path where a failed pending recovery could leave its MCP server registered and strongly referenced.

### Compatibility

- No native tool names or input schemas changed in this release. Existing ChatGPT custom MCP apps do not need to be recreated or re-published solely for this update; restart the local MCP server after upgrading.

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
