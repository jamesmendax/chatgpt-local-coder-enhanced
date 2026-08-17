<div align="center">

# ChatGPT Local Coder

**Turn ChatGPT web into a local coding agent — files, shell, git, patches, 40+ MCP tools.**

[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1?style=flat-square)](https://modelcontextprotocol.io)
[![ChatGPT](https://img.shields.io/badge/ChatGPT-Developer%20Mode-10a37f?style=flat-square)](https://platform.openai.com/docs/guides/developer-mode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Windows](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d4?style=flat-square)](https://nodejs.org)

[Quick Start](#-quick-start) · [Connect ChatGPT](#-connect-chatgpt) · [Tools](#-tools) · [Tunnel](#-tunnel-options) · [Troubleshooting](#-troubleshooting) · [Tiếng Việt](#-tiếng-việt)

</div>

---

ChatGPT Local Coder is a **self-hosted MCP server** that gives ChatGPT (and any MCP client) full access to your machine — read and edit code, run `npm test`, manage git, apply unified diffs, and explore projects with `glob` / `grep`.

No desktop app. No vendor lock-in. Run one Node process on your PC, expose it through a tunnel, and code from ChatGPT in the browser.

```
┌─────────────────┐     HTTPS      ┌──────────────────┐     localhost     ┌─────────────────────┐
│   ChatGPT Web   │ ─────────────► │  Tunnel (opt.)   │ ────────────────► │  chatgpt-local-coder │
│ Developer Mode  │                │ OpenAI / CF      │      :3000/mcp    │  40+ MCP tools       │
└─────────────────┘                └──────────────────┘                   └──────────┬──────────┘
                                                                                    │
                                         ┌──────────────────────────────────────────┼──────────┐
                                         ▼                    ▼                    ▼          ▼
                                   Filesystem              Shell + Git         Background    Project
                                   read/write/patch        status/diff/commit   processes     context
```

## ✨ Why this project

| | ChatGPT alone | **+ ChatGPT Local Coder** |
|---|---|---|
| Edit your repo | ❌ | ✅ `apply_patch`, `edit_file`, `multi_edit` |
| Run tests / builds | ❌ | ✅ `run_command`, `start_process` |
| Git workflow | ❌ | ✅ `git_status`, `git_commit`, `git_push`, … |
| Explore codebase | Limited | ✅ `glob`, `grep`, `list_directory` |
| Full disk access | ❌ | ✅ Any path on your machine |
| Session recovery | — | ✅ Auto-recover after server restart |

Built for **[ChatGPT Developer Mode](https://platform.openai.com/docs/guides/developer-mode)** with optimized tool annotations (fewer permission popups) and **[OpenAI Secure MCP Tunnel](https://platform.openai.com/docs/guides/secure-mcp-tunnel)** support (stable URL, no connector re-wiring every restart).

## 🚀 Quick Start

**Requirements:** [Node.js](https://nodejs.org) 18+, npm, Git (optional, for git tools)

**Windows**

```powershell
git clone https://github.com/hoangcoderr/chatgpt-local-coder.git
cd chatgpt-local-coder
copy .env.example .env          # edit WORKSPACE_PATH + MCP_TOKEN
npm install
npm run build
.\start.ps1
```

**macOS / Linux**

```bash
git clone https://github.com/hoangcoderr/chatgpt-local-coder.git
cd chatgpt-local-coder
cp .env.example .env
npm install && npm run build

# Set your project root and an auth token
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # paste into MCP_TOKEN

npm start
```

> The `.ps1` scripts are **Windows-only**. On macOS/Linux use `npm start` and the shell tunnel commands below — everything else is cross-platform.

Server runs at `http://127.0.0.1:3000` — health check: `http://127.0.0.1:3000/health`

Set `WORKSPACE_PATH` to your project root (absolute path). With `MCP_TOKEN` set, the MCP endpoint becomes `/mcp/<token>` — that full path is what goes in the connector.

## 🔌 Connect ChatGPT

### 1. Enable Developer Mode

1. Open [ChatGPT](https://chatgpt.com) → **Settings** → **Apps & Connectors**
2. Under **Advanced**, enable **Developer mode**

### 2. Expose your server (pick one tunnel)

See [Tunnel options](#-tunnel-options) below. You need a **public HTTPS** URL pointing to your local server on port 3000.

### 3. Create a connector

1. **Settings** → **Connectors** → **Create**
2. Fill in:

| Field | Value |
|-------|-------|
| **Name** | `Local Coder` |
| **Description** | `Local coding agent. First call agent_status + project_context. Use glob/grep to explore, apply_patch to edit, run_command for shell.` |
| **URL** | `https://<your-tunnel>/mcp/<MCP_TOKEN>` — see below |
| **Authentication** | None (the token is already in the URL) |

3. **Create** → verify tools appear in the list

**The URL must include your `MCP_TOKEN`.** With `MCP_TOKEN=abc123`, the connector URL is `https://<your-tunnel>/mcp/abc123`. Plain `/mcp` returns **404** by design, so a URL without the token fails. Leave `MCP_TOKEN` empty to disable auth and use plain `/mcp` — not recommended, since anyone who learns the tunnel URL gets a shell on your machine.

> Treat the connector URL like a password: it contains the token.

### 4. Use in chat — **must tag the connector**

Every message that should use local tools **must include the connector**. If you skip this, ChatGPT only uses built-in tools, may show *"Looking for available tools"* / *"Đang tìm các công cụ có sẵn"*, then **"Error in message stream"** / **"Lỗi trong luồng tin nhắn"** — with **no error in server logs** (the MCP server was never called).

**How to tag (pick one):**

1. **Before sending:** **New chat** → **+** (tools) → **More** → enable **Local Coder** (connector stays on for that chat).
2. **In the message:** type **`@`** and choose **Local Coder** (or your connector name) so it appears as a pill/chip above the input.

Then send your prompt. You should see tool permission prompts or MCP activity — not a dead stream with no server log.

Example prompts (after tagging):

- *"Read package.json and explain the dependencies"*
- *"Run npm test and fix any failures"*
- *"Find all TODO comments with grep and summarize"*

> **Tip:** After server updates or restarts → **Refresh** the connector and start a **new chat** (re-tag the connector).  
> **Avoid** clicking **"Always allow"** on permission popups — it can reset the MCP session. Configure permissions in **Settings → Apps** instead.

## 🌐 Tunnel options

### Option A — OpenAI Secure MCP Tunnel *(recommended)*

Stable tunnel ID — connector URL never changes.

```powershell
# Terminal 1
.\start.ps1 -Force

# Terminal 2 — first time only
.\openai-tunnel.ps1 -Init    # enter tunnel_id + Runtime API key from OpenAI Platform

# Every time after
.\openai-tunnel.ps1
```

Get credentials: [OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels)

In ChatGPT Connectors: **Connection type → Tunnel** → paste your `tunnel_…` ID.

> **macOS / Linux:** `openai-tunnel.ps1` is PowerShell and downloads the **Windows** build, so it does not work here. Grab the matching `tunnel-client` binary from [openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases) and run it directly, or use one of the options below.

### Option B — Cloudflare Quick Tunnel

Free, but URL changes on every restart (update connector each time).

```powershell
# Windows — Terminal 1
.\start.ps1
# Terminal 2
.\tunnel.ps1    # copy https://….trycloudflare.com into connector URL
```

```bash
# macOS / Linux — Terminal 1
npm start
# Terminal 2
npm run tunnel  # cloudflared tunnel --url http://localhost:3000
```

Install cloudflared: `winget install Cloudflare.cloudflared` (Windows) · `brew install cloudflared` (macOS)

**Requires outbound port 7844** (TCP *and* UDP) to `*.argotunnel.com`. Many corporate/school/hotel networks block it, and `--protocol http2` does **not** help — it still uses 7844. Check with:

```bash
cloudflared tunnel --url http://localhost:3000 2>&1 | grep -E 'precheck|Registered'
```

If you see `TCP Connectivity … status=fail` and never `Registered tunnel connection`, the network is blocking it — use Option C.

### Option C — Pinggy *(works when Cloudflare is blocked)*

Pure SSH over port **443**, so it survives networks that block 7844. No install, no signup.

```bash
# Terminal 1
npm start

# Terminal 2
ssh -p 443 -R0:localhost:3000 a.pinggy.io
```

It prints two HTTPS URLs (`https://….free.pinggy.net` and `https://….run.pinggy-free.link`) — pick either and append `/mcp/<MCP_TOKEN>` for the connector.

Free sessions expire after **60 minutes** and the URL changes each time, so you re-paste the connector URL. A paid plan gives persistent URLs.

## 🧰 Tools

**40+ tools** with structured JSON responses `{ ok, tool, summary, data }`.

### Onboarding *(call these first)*

| Tool | Description |
|------|-------------|
| `agent_status` | Permissions, workspace roots, audit log |
| `project_context` | Reads AGENTS.md, README, CLAUDE.md, configs |

### Filesystem

| Tool | Description |
|------|-------------|
| `read_text_file` | Read source files (offset + limit) |
| `write_file` | Create or overwrite files |
| `edit_file` | Find-and-replace edits |
| `multi_edit` | Multiple edits in one file |
| `replace_regex` | Regex replace in file |
| `apply_patch` | Unified / Codex-style patches |
| `glob` | Find files by pattern (sorted by mtime) |
| `grep` | Search content (content / files / count modes) |
| `list_directory` | List folder contents |
| `directory_tree` | Recursive tree as JSON |
| `create_directory` | Create folders |
| `delete_file` / `delete_directory` | Remove files or dirs |
| `copy_file` / `move_file` | Copy or rename |
| `read_file_base64` / `write_file_base64` | Binary file support |

### Shell

| Tool | Description |
|------|-------------|
| `run_command` | Run shell commands (`npm test`, builds, …) |
| `shell_status` / `shell_reset` | Persistent shell session |
| `start_process` | Long-running / background commands |
| `process_status` / `process_output` / `stop_process` | Manage background jobs |

### Git

| Tool | Description |
|------|-------------|
| `git_status` / `git_diff` / `git_log` | Inspect repo |
| `git_add` / `git_commit` | Stage and commit |
| `git_branch` / `git_checkout` | Branch list, create, switch (local only) |
| `git_restore` | Restore tracked files to last commit |
| `git_push` / `git_pull` | Sync with configured remote |
| `git_stash` / `git_reset` | Stash and reset |

### Claude Code ↔ MCP mapping

| Claude Code | This server |
|-------------|-------------|
| `Read` | `read_text_file` |
| `Write` | `write_file` |
| `Edit` / `MultiEdit` | `edit_file` / `multi_edit` |
| `Glob` / `Grep` / `LS` | `glob` / `grep` / `list_directory` |
| `Bash` | `run_command` |
| — | `apply_patch`, `git_*`, `project_context` |

## ⚙️ Configuration

Copy `.env.example` → `.env`:

```env
PORT=3000
HOST=127.0.0.1
MCP_TOKEN=                      # generate one — see below
WORKSPACE_PATH=C:\Users\You\projects\my-app     # macOS: /Users/you/projects/my-app
CHATGPT_AUTO_APPROVE=true
SHELL_TIMEOUT=120
MCP_SESSION_RECOVERY=true
ADMIN_PORT=3011

# OpenAI Secure Tunnel (optional)
OPENAI_TUNNEL_ID=
OPENAI_TUNNEL_API_KEY=
```

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_PATH` | `cwd` | **Your project root** (like `cd` before `claude`). Auto-loads `CLAUDE.md` / `AGENTS.md` into MCP instructions |
| `HOST` | `127.0.0.1` | Bind address. Keep as-is — `0.0.0.0` exposes the shell to your whole LAN |
| `MCP_TOKEN` | *(empty)* | Secret in the endpoint path: `/mcp/<token>`. Empty = **no auth**. Generate: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |
| `ADMIN_PORT` | `3001` | [Admin UI](#-admin-ui) port (localhost-only, always on). Change it if something else uses 3001 — Docker Desktop often does |
| `ADMIN_TOKEN` | *(empty)* | Bearer token for the Admin UI. Empty = loopback check only |
| `CHATGPT_AUTO_APPROVE` | `true` | Tool annotations to reduce ChatGPT popups |
| `MCP_SESSION_RECOVERY` | `true` | Auto-recover stale sessions after restart |
| `SHELL_TIMEOUT` | `120` | Max seconds for `run_command` |
| `FULL_DISK_ACCESS` | `true` | Access any path on the machine |

> Variables already set in your shell **win over `.env`** (`dotenv` does not override). If a change to `.env` seems ignored, check `env | grep WORKSPACE_PATH` first.

> **Full machine access** is enabled by default. `WORKSPACE_PATH` only sets the default cwd — absolute paths like `D:\Projects\…` work everywhere.

## 🖥️ Admin UI

A local web console ships with the server. It starts **automatically** with `npm start` (same process, separate port) — there is no separate command and no on/off switch.

```
http://127.0.0.1:3001/ui          # or your ADMIN_PORT
```

The exact URL is printed in the startup banner. Stopping the server stops the admin UI too (`Ctrl+C`, `.\stop.ps1`, or `pkill -f "dist/index.js"`).

| Tab | What it does |
|-----|--------------|
| **Tổng quan** | PID, active ChatGPT sessions, default cwd, upstream health |
| **MCP Servers** | Enable/disable upstream MCP servers, test connections, inspect their tools |
| **Import** | Pull existing MCP config from Cursor / Claude Code / OpenCode |
| **Nhật ký** | Live tool-call log from ChatGPT (SSE stream) |
| **Project** | Preview the exact MCP instructions injected into ChatGPT each session |
| **Cài đặt** | Read **and write** `.env` |
| **Raw status** | Raw JSON status dump |

This is the **hub** side of the project: upstream MCP servers are proxied through this one connector, so ChatGPT reaches their tools without being wired up separately. Configure them in `MCP_UPSTREAM_CONFIG` (default `profiles/mcp-upstream.json`).

> ⚠️ **Never expose this port through a tunnel** — only tunnel port 3000. The admin API writes `.env`, so reaching it means being able to change `WORKSPACE_PATH` or switch `MCP_TOKEN` off. It is protected by a loopback-only guard plus the optional `ADMIN_TOKEN`; since it cannot be disabled, setting `ADMIN_TOKEN` is worthwhile.

## 🏗️ Architecture

```
src/
├── index.ts                 # Express + MCP session manager
├── server-factory.ts        # Tool registration
├── lib/
│   ├── mcp-session-manager.ts   # Session recovery, TTL
│   ├── patch.ts             # apply_patch engine
│   └── persistent-shell.ts  # Stateful shell
└── tools/
    ├── filesystem.ts        # 18 tools
    ├── shell.ts             # 8 tools
    ├── git.ts               # 11 tools
    └── context.ts           # agent_status, project_context
```

- **Transport:** MCP Streamable HTTP — `/mcp/<MCP_TOKEN>` and `/<MCP_TOKEN>` (or `/mcp` and `/` when `MCP_TOKEN` is empty)
- **Session:** Stateful with auto-recovery when ChatGPT holds a stale session ID
- **Output:** Structured JSON from every tool

## 🧪 Development

```powershell
npm run build          # compile TypeScript
npm test               # patch + tool unit tests
npm run dev            # watch mode (tsx)
node scripts/test-mcp-session.mjs   # integration test (server must be running)
```

## 🔒 Security

This server grants **full access to your machine** — files, shell, git. Only expose it through a tunnel you control. Never share your connector URL or tunnel API keys.

- Binds `127.0.0.1` only (`HOST`) — not reachable from your LAN. The tunnel connects to localhost, so it still works
- `MCP_TOKEN` guards the endpoint at `/mcp/<token>`; `/mcp` and `/` return 404. **Set it** — without it, anyone who learns your tunnel URL gets a shell
- The connector URL contains the token — treat it as a credential, and stop the tunnel when you are done
- `WORKSPACE_PATH` only sets the *default* cwd; it does **not** restrict access (`FULL_DISK_ACCESS` is on)
- The [Admin UI](#-admin-ui) is always running and can write `.env` — tunnel **only** port 3000, never `ADMIN_PORT`, and set `ADMIN_TOKEN`
- `.env` and secrets are gitignored
- Audit log: `.mcp-audit.log` (optional, configurable)
- Use on a trusted network / personal machine only

## 🩺 Troubleshooting

| Problem | Fix |
|---------|-----|
| **"Error in message stream"** / **"Lỗi trong luồng tin nhắn"** right after *"Looking for tools"* — **no server log** | You did **not tag the connector**. New chat → **+** → **More** → enable connector, or type **`@Local Coder`** in the message. Then retry. |
| **Resource not found** on tool call | Refresh connector + new chat. Server auto-recovers sessions — ensure latest build is running. |
| **Connection failed** | Check `.\start.ps1` + tunnel are both running. URL must be HTTPS. |
| **Permission popup every call** | Settings → Apps → set connector to *Ask before important changes*. Don't use popup "Always allow". |
| **Tool blocked by OpenAI safety** | Not a server bug. Retry with `run_command` (response may include `run_command_fallback`). Affects `git_push`, `git_checkout`, `delete_directory` occasionally. |
| **`stream canceled`** in tunnel log | Server/tunnel restarted mid-session → refresh connector, new chat. |
| **Tunnel URL keeps changing** | Switch to OpenAI Secure Tunnel (`openai-tunnel.ps1`). |
| **Connector stuck "loading" forever when you click Create** | Make sure you are on the latest build (`npm run build`) — older builds deadlocked on the SSE stream and never answered `tools/list`. Also confirm the URL includes `/mcp/<MCP_TOKEN>`. |
| **404 on the connector URL** | You omitted the token. Use `https://<tunnel>/mcp/<MCP_TOKEN>`, not `/mcp`. |
| **cloudflared never prints "Registered tunnel connection"** | Network blocks port 7844. `--protocol http2` will not help (same port). Use Pinggy — Option C. |
| **`EADDRINUSE` on 3001 at startup** | Something else owns the admin port (often Docker Desktop). Set `ADMIN_PORT=3011`. |
| **`.env` changes seem ignored** | A shell variable of the same name overrides it. Check `env \| grep WORKSPACE_PATH`. |
| **`npm test` fails with `spawn bash ENOENT`** | Stale `.mcp-state` from a previous run. `rm -rf .mcp-state` and re-run. |
| **`.ps1` scripts do nothing on macOS** | They are Windows-only. Use `npm start` and the Option B/C shell commands. |
| **Access denied** | Wrong path or OS permissions on that file. |
| **git not found** | Install [Git](https://git-scm.com). |

See also [AGENTS.md](AGENTS.md) for agent onboarding and `apply_patch` format.

## 📚 References

- [Model Context Protocol](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [ChatGPT Apps SDK](https://developers.openai.com/apps-sdk)
- [OpenAI Secure MCP Tunnel](https://platform.openai.com/docs/guides/secure-mcp-tunnel)

## 📄 License

[MIT](LICENSE) — use freely, attribution appreciated.

## ⭐ Support

If this saves you time, **star the repo** — it helps others find it.

---

## 🇻🇳 Tiếng Việt

**ChatGPT Local Coder** biến ChatGPT web thành agent code trên máy bạn qua MCP.

```powershell
git clone https://github.com/hoangcoderr/chatgpt-local-coder.git
cd chatgpt-local-coder
copy .env.example .env
npm install && npm run build
.\start.ps1                    # terminal 1
.\openai-tunnel.ps1            # terminal 2 (tunnel cố định)
```

**macOS / Linux** — các script `.ps1` chỉ chạy trên Windows:

```bash
git clone https://github.com/hoangcoderr/chatgpt-local-coder.git
cd chatgpt-local-coder
cp .env.example .env
npm install && npm run build

# Tạo token rồi dán vào MCP_TOKEN trong .env
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

npm start                                    # terminal 1
ssh -p 443 -R0:localhost:3000 a.pinggy.io    # terminal 2
```

Dùng Pinggy nếu mạng chặn cloudflared (cổng 7844). Nếu cloudflared chạy được thì `npm run tunnel` cũng ổn.

**ChatGPT:** Settings → Connectors → tạo connector → Refresh → chat mới.

**URL connector phải có token:** `https://<tunnel>/mcp/<MCP_TOKEN>`. Vào `/mcp` trơn sẽ trả **404**. Coi URL này như mật khẩu — ai có nó là có shell trên máy bạn.

**Bắt buộc tag connector mỗi chat:** Chat mới → **+** → **More** → bật connector, hoặc gõ **`@`** + tên connector trong ô chat. Nếu không tag, ChatGPT báo *"Đang tìm các công cụ có sẵn"* rồi *"Lỗi trong luồng tin nhắn"* — **server không có log lỗi** vì MCP chưa được gọi.

**WORKSPACE_PATH:** đặt đúng thư mục project (không phải thư mục `chatgpt-local-coder`). Server tự đọc `CLAUDE.md` / `AGENTS.md` giống Claude Code.

**Admin UI:** tự bật cùng `npm start` tại `http://127.0.0.1:<ADMIN_PORT>/ui` (mặc định 3001), không tắt riêng được. Dùng để quản lý MCP server khác, xem log tool call, sửa `.env`. **Đừng tunnel cổng này ra ngoài** — chỉ tunnel :3000.

**Lưu ý:** Không bấm **"Luôn cho phép"** trên popup — cấu hình quyền ở Settings → Apps. Sau khi restart server: Refresh connector + mở chat mới + tag lại connector.

Chi tiết cho AI agent: [AGENTS.md](AGENTS.md)