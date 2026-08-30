# Codex MCP Server — Agent Onboarding

MCP server local giống Codex: đọc/ghi file, chạy lệnh, git. Dùng với ChatGPT Developer Mode hoặc bất kỳ MCP client nào.

## Lần đầu kết nối — gọi ngay 2 tool này

1. **`agent_status`** — xem quyền, full disk access, workspace roots
2. **`project_context`** — đọc AGENTS.md, README, CLAUDE.md trong project

## Quyền truy cập

- **Full machine access** — không giới hạn path, không chặn lệnh
- Dùng absolute path bất kỳ: `C:\`, `D:\Projects\...` (Windows) · `/Users/you/projects/...` (macOS) · `/home/you/...` (Linux)
- `WORKSPACE_PATH` chỉ là thư mục mặc định cho path tương đối và shell/git
- `CHATGPT_AUTO_APPROVE=true` — giảm popup xác nhận trên ChatGPT

## ChatGPT: tránh popup + lỗi "Luôn cho phép phải kết nối lại"

### Cách đúng (làm TRƯỚC khi chat)

1. **Settings → Apps → Connectors** → chọn connector **Codex Local**
2. Đặt quyền app: **Chỉ hỏi trước thay đổi quan trọng** hoặc **Hỏi trước khi thay đổi**
3. Bấm **Refresh** connector (sau mỗi lần update server)
4. Mở chat mới, chọn connector, rồi mới gửi prompt

### KHÔNG bấm "Luôn cho phép" trên popup

Đây là bug/UI ChatGPT: bấm **Luôn cho phép** thường **đóng MCP session** → tunnel log `stream canceled` → phải kết nối lại.

Thay vào đó:
- Bấm **Cho phép một lần** khi cần, hoặc
- Cấu hình quyền ở **Settings → Apps** (bước trên) để ít hỏi hơn

### Lỗi tunnel `stream canceled by remote`

Bình thường khi:
- Server restart (`stop.ps1` / `start.ps1`, hoặc Ctrl+C `npm start`) trong lúc ChatGPT đang kết nối
- ChatGPT đóng stream SSE sau khi đổi quyền
- Tunnel URL đổi (chạy lại `tunnel.ps1` cloudflared) mà chưa update Connector URL

**Fix:** Giữ server + tunnel chạy ổn định, không restart giữa chừng. Nếu restart → Refresh connector + chat mới.

**Khuyến nghị:** Dùng OpenAI Secure MCP Tunnel — `tunnel_id` cố định, không cần đổi URL connector mỗi lần. Trên Windows: `openai-tunnel.ps1`. Trên macOS/Linux script này không chạy (PowerShell + bản Windows), phải tự tải binary từ [openai/tunnel-client](https://github.com/openai/tunnel-client/releases).

## Tool profile — `slim` (mặc định) vs `full`

`CHATGPT_TOOL_PROFILE` trong `.env` quyết định agent thấy bao nhiêu tool:

| Profile | Số tool | Dùng khi |
|---|---|---|
| `slim` *(mặc định)* | **27** | ChatGPT web — một tool ưu tiên cho mỗi thao tác, có thêm `goal`, `tools/list` khoảng 22 KB |
| `full` | **65 local tools** | MCP client khác, compatibility wrappers, browser/task diagnostics |

**Chỉ có ở `full`** — gọi các tool này ở `slim` sẽ báo *tool not found*:

`edit_file` · `multi_edit` · `replace_regex` · `directory_tree` · `search_files` · file/directory mutation wrappers · `shell_reset` · `node_repl` · full `git_*` mutation family · browser tools · legacy detailed task tools · `mcp_tools` / `mcp_call`

Ở `slim`, dùng `apply_patch` cho edit và `run_command` cho thao tác cơ học (`git commit`, `git restore`, `rm`, `mv`, …). Gọi `agent_status` chỉ khi cần diagnostic.

## Mapping Claude Code ↔ Codex MCP

| Claude Code | Codex MCP | Ghi chú |
|---|---|---|
| `Read` | `read_text_file` | Có `offset`+`limit` (line numbers) |
| `Write` | `write_file` | |
| Binary read/write | `read_file_base64` / `write_file_base64` | Có chunk offset; final write có thể verify SHA256 |
| `Edit` / `MultiEdit` | `apply_patch` | Một hoặc nhiều file, có dry-run |
| `Glob` | `glob` | Sort theo mtime |
| `Grep` | `grep` | content / files_with_matches / count |
| `LS` | `list_directory` | Có `ignore` globs |
| `Bash` | `run_command` | Lệnh ngắn, chờ xong |
| Background shell | `start_process` + `process_status` / `process_output` / `stop_process` | |
| Long-task handoff | `task_state` | Goal, done, decisions, blockers, next actions, checks, changed files |
| Persistent outcome | `goal` | Objective, success criteria, constraints, phase, pause/resume, completion gate |
| `Rewind` | `rewind` | `list` / `preview` / `restore` — undo file edits qua checkpoint tự động |
| — | `<server>__<tool>` | MCP upstream đang `enabled` được expose trực tiếp, ví dụ `chrome-devtools__list_pages`, `linear__get_user` |
| — | `mcp_servers`, `mcp_tools`, `mcp_call` | Diagnostic/fallback cho MCP upstream; chỉ `full` |
| — | Admin UI `:<ADMIN_PORT>/ui` | Import MCP từ Cursor / Claude Code / OpenCode (mặc định 3001) |
| — | `apply_patch` | Codex/OpenAI style (thêm so với Claude) |
| — | `git_status`, `git_diff` | Inspect có cấu trúc; mutation dùng `run_command` trong slim |
| — | `project_context` | Map hoặc phần AGENTS/CLAUDE/README liên quan tới query |
| — | `open_image` | Trả ảnh local thành MCP image content thật |

**Không có trong MCP này** (ChatGPT built-in hoặc MCP khác): `WebSearch`, `WebFetch`, `Task`/subagent, `NotebookEdit`, `LSP`.

## Sửa code — tool nào dùng khi nào

| Việc cần làm | Tool |
|---|---|
| Tìm file theo tên | `glob` |
| Tìm nội dung | `grep` |
| Đọc file | `read_text_file` |
| Liệt kê thư mục | `list_directory` |
| Sửa bằng diff/patch | `apply_patch` (ưu tiên) |
| Sửa nhiều đoạn / nhiều file | `apply_patch` |
| Sửa bằng regex | `replace_regex` *(full)* hoặc script qua `run_command` |
| Tạo file mới | `write_file` |
| Xóa / đổi tên | `delete_file`, `move_file` *(full)* — ở `slim` dùng `run_command` |
| Chạy lệnh ngắn | `run_command` |
| Build/test dài | `start_process` → `process_status` / `process_output` → `stop_process` khi cần |
| Git inspect | `git_status`, `git_diff` |
| Git mutation | `run_command` (`git commit`, `git restore`, `git switch`, …) |
| Undo edits trong session | `rewind` action `list` → `preview` → `restore` (không track bash) |
| Long task | `task_state` create → checkpoint theo phase → complete khi blocking checks pass |

## ChatGPT safety layer — tool bị chặn ngẫu nhiên

Một số tool wrapper đôi khi bị OpenAI chặn với *"Lệnh gọi công cụ này đã bị chặn bởi cơ chế kiểm tra an toàn"* — **không phải lỗi server**. Cùng thao tác qua `run_command` thường vẫn chạy được.

| Tool hay bị chặn | Fallback `run_command` |
|---|---|
| `git_push` | `git push -u origin <branch>` |
| `git_checkout` | `git switch <branch>` |
| `git_restore` | `git restore -- <files>` |
| `delete_directory` | `Remove-Item -Recurse -Force <path>` (Windows) · `rm -rf <path>` (macOS/Linux) |

Tool response có thể chứa `run_command_fallback` — dùng lệnh đó nếu wrapper bị chặn.

> Các wrapper mutation nằm trong `full`; ở `slim` chủ động dùng `run_command` để chỉ có một đường thao tác rõ ràng.

**Slim:** `git_status`, `git_diff`. **Full:** toàn bộ wrapper `git_*`.

## Compact task state + command evidence

- `task_state` chỉ tạo một handle cho task dài; checkpoint ở ranh giới phase, không checkpoint sau mỗi tool call.
- `goal` là lớp outcome bền vững phía trên `task_state`; active goal là **continuous-execution contract**: sau `goal(action=create)`/resume, agent phải tiếp tục dùng tool trong cùng assistant turn, không được kết thúc chỉ để báo progress. Chỉ được yield khi có blocker thật sự cần user input/approval/credentials/physical action, hoặc goal bị pause/cancel. Khi criteria pass: `goal complete` → nếu có active task thì `task_state complete` → `DELIVERABLE_READY` → final reply.
- Khi task active, MCP tự ghi changed files, test/build/lint/format result, last failure và recent events.
- `run_command` mặc định trả preview gọn + diagnostics/test counts; output đầy đủ nằm ở `full_output_path`.
- Task pointer hết hạn sau 24 giờ không hoạt động theo mặc định (`ACTIVE_TASK_TTL_MS`), tránh task cũ nhận nhầm tool call; file task vẫn có thể resume bằng ID.
- `DELIVERABLE_READY` chỉ xuất hiện khi tất cả blocking checks đã pass.

## Fixed Agent Eval

```
npm run eval:list
npm run eval:prepare -- --task code-fix
npm run eval:grade -- --run <run-directory>
npm run eval:selftest
```

Visual SVG eval có 60 điểm machine structure/render và 40 điểm chỉ do user chấm.

## Format `apply_patch` (Codex-style)

```
@@
-old line to remove
+new line to add
 context line unchanged
```

Hoặc unified diff chuẩn:

```
@@ -10,3 +10,4 @@
 context
-old
+new
```

Tham số: `{ "path": "src/foo.ts", "patch": "...", "dry_run": false }`

Dùng `dry_run: true` để xem diff trước khi ghi.

## Đường dẫn file

- Dùng path tuyệt đối: `C:\Users\...\project\src\file.ts` · `/Users/you/project/src/file.ts`
- Hoặc relative từ `WORKSPACE_PATH` trong `.env`
- Gọi `agent_status` để xem workspace roots (`list_allowed_directories` chỉ có ở profile `full`)

## Khởi động server

**Windows**

```powershell
.\start.ps1 -Force          # Terminal 1: MCP server
.\openai-tunnel.ps1         # Terminal 2: OpenAI tunnel (URL cố định)
```

**Lần đầu:** chạy `.\openai-tunnel.ps1 -Init` → nhập `tunnel_id` + Runtime API key từ [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels).

Tunnel cũ (URL đổi mỗi lần): `.\tunnel.ps1` (cloudflared).

**macOS / Linux** — các script `.ps1` không chạy trực tiếp:

```bash
npm start                                    # Terminal 1: MCP server
npm run tunnel                               # Terminal 2: cloudflared
ssh -p 443 -R0:localhost:3000 a.pinggy.io    # hoặc Pinggy, nếu mạng chặn cổng 7844
```

**ChatGPT:** [Settings → Connectors](https://chatgpt.com/#settings/Connectors) → URL phải là `https://<tunnel>/mcp/<MCP_TOKEN>`. Vào `/mcp` trơn sẽ trả 404. Coi URL này như mật khẩu.

Health check: `http://127.0.0.1:3000/health` | Admin UI: `http://127.0.0.1:<ADMIN_PORT>/ui` (mặc định 3001)

## Troubleshooting

| Lỗi | Cách xử lý |
|---|---|
| Access denied | Kiểm tra path; bật `FULL_DISK_ACCESS=true` |
| Patch context not found | Đọc file trước; thêm context lines (dòng bắt đầu bằng space) |
| ChatGPT hỏi quyền mỗi lần | Settings → Apps → đặt *Chỉ hỏi trước thay đổi quan trọng*; kiểm tra `CHATGPT_AUTO_APPROVE=true`. **Không** bấm "Luôn cho phép" trên popup (xem mục trên) |
| Connection failed | Server + tunnel đều phải chạy; URL phải HTTPS và có `/mcp/<MCP_TOKEN>` |
| Tool not found | Tool đó chỉ có ở profile `full` — xem mục *Tool profile*. Gọi `agent_status` để kiểm tra |
| Connector loading mãi khi bấm Create | Build cũ bị deadlock SSE stream. Chạy `npm run build` rồi khởi động lại server |