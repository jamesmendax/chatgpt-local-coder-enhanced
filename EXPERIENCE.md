# chatgpt-local-coder 使用经验与操作手册

## 一、先记住实际结构

你要控制的是两个 ChatGPT 账号的“隧道”，不是两份本地项目：

```text
Free 隧道（8080）       ┐
                        ├─ 共享 MCP（3000）─ D:\web-local
Business 隧道（8081）  ┘
```

因此，两个账号同时使用时只需要：

- 1 个共享 MCP 服务窗口；
- 1 个 Free 隧道窗口；
- 1 个 Business 隧道窗口。

一共是 3 个实际运行进程，但提供 4 个互相独立的单击控制文件。不能为两个账号各启动一个 3000 服务，因为同一个端口不能同时绑定两份服务。

## 二、四个单击文件和两个维护用 key 保存入口

它们都在 `D:\chatgpt-local-coder`：

| 文件 | 做什么 |
|---|---|
| `start-free-plugin.cmd` | 需要时启动共享 MCP，然后启动 Free 隧道 |
| `stop-free-plugin.cmd` | 关闭 Free 隧道；Business 仍运行时保留共享 MCP |
| `start-business-plugin.cmd` | 需要时启动共享 MCP，然后启动 Business 隧道 |
| `stop-business-plugin.cmd` | 关闭 Business 隧道；Free 仍运行时保留共享 MCP |

四个入口内部共用 `_one-click-control.ps1`。这个公共文件不要删除，否则四个 `.cmd` 都不能工作。

另外有两个维护用保存入口：`save-free-key.cmd` 和 `save-business-key.cmd`。它们不会把 key 写进脚本，而是把 Runtime API key 保存为当前 Windows 用户可解密的 DPAPI 加密文件。两个 key 现在都已保存，日常启动不需要再运行这两个文件；只有换 key、换 Windows 用户/机器，或加密文件丢失时才使用。Free 保存器曾从 `.env` 自动完成迁移，Business 保存器曾隐藏输入一次。

## 三、推荐使用顺序

### 1. 启动 Free

双击：

```text
D:\chatgpt-local-coder\start-free-plugin.cmd
```

它会：

1. 检查 3000 是否已经是本项目 MCP 服务。
2. 如果没有，打开一个窗口启动 `start.ps1`。
3. 检查 Free 的 8080 是否已经 ready。
4. 如果没有，打开一个窗口运行 `openai-tunnel.ps1`。

Free 现在优先使用 `.secrets\free-runtime-key.xml`；只有加密文件不可用时才回退到 `.env`，且不会在窗口中显示 key。

成功信号：新窗口中的 Free 隧道正常运行，且访问 `http://127.0.0.1:8080/readyz` 得到 `ready`。

### 2. 需要时重新保存 Free key

正常使用不需要执行这一步。只有 key 需要更换、DPAPI 文件丢失，或换了 Windows 用户/机器时，才双击：

```text
D:\chatgpt-local-coder\save-free-key.cmd
```

如果 `.env` 中已有 Free key，保存器会直接读取并加密，不会显示 key；如果没有，按提示隐藏输入一次。保存位置是：

```text
D:\chatgpt-local-coder\.secrets\free-runtime-key.xml
```

这是 Windows DPAPI 加密文件，只能由保存它的 Windows 用户在这台机器上解密。不要把它上传、复制到 Git 或发给别人。

### 3. 需要时重新保存 Business key

正常使用不需要执行这一步。只有 key 需要更换、DPAPI 文件丢失，或换了 Windows 用户/机器时，才双击：

```text
D:\chatgpt-local-coder\save-business-key.cmd
```

按提示输入一次 Business Runtime API key。输入不会显示，保存位置是：

```text
D:\chatgpt-local-coder\.secrets\business-runtime-key.xml
```

这是 Windows DPAPI 加密文件，只能由保存它的 Windows 用户在这台机器上解密。不要把它上传、复制到 Git 或发给别人。

### 4. 启动 Business

双击：

```text
D:\chatgpt-local-coder\start-business-plugin.cmd
```

如果共享 MCP 已经运行，Business 会直接复用它，不会再启动第二份。随后会打开 Business 隧道窗口，自动读取已保存的加密 key，不再要求输入。

如果没有找到加密文件，Business 脚本会回退到隐藏输入。启动成功后应关闭该窗口，并运行一次 `save-business-key.cmd`，避免下一次再次输入。

成功信号：Business 隧道启动后，`http://127.0.0.1:8081/readyz` 返回 `ready`。

### 5. 在 ChatGPT 中使用

两个账号都连接到各自已经配置好的 MCP app。打开对应账号的新聊天，选择/标记相应 app，然后先做一个无破坏测试，例如读取项目目录或读取一个已知文本文件。

不要一开始就测试删除、覆盖、Git reset、推送或运行未知安装命令。

### 6. 只关闭 Free

双击：

```text
D:\chatgpt-local-coder\stop-free-plugin.cmd
```

如果 Business 还在运行，控制器只关闭 Free 隧道，保留 3000 MCP 服务，Business 不会被连带关闭。

### 7. 只关闭 Business

双击：

```text
D:\chatgpt-local-coder\stop-business-plugin.cmd
```

如果 Free 还在运行，控制器只关闭 Business 隧道，保留 3000 MCP 服务，Free 不会被连带关闭。

当两个隧道都已经关闭后，再关闭其中一个角色时，控制器会尝试关闭确认属于本项目的共享 MCP 服务。如果端口所有者无法确认，它会停止并提示，不会强杀未知进程。

## 四、遇到提示时怎么判断

### Business doctor 出现 OAuth metadata 404

你创建 ChatGPT app 时选择的是 No authentication。这个模式下本地 MCP 没有 OAuth metadata 是预期现象；现有 Business 脚本只把唯一的 `oauth_metadata` 失败当作警告，然后继续运行。

不要为了消除这条提示，擅自把 ChatGPT app 改成 OAuth。那会改变认证方案，必须重新设计和验证。

### 提示端口已被占用

不要直接使用 `start.ps1 -Force`。先检查：

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in @(3000,3001,8080,8081) } |
  ForEach-Object { "port=$($_.LocalPort) pid=$($_.OwningProcess)" }
```

控制器已经内置了更保守的判断：端口被未知进程占用时不自动杀进程。

### Business 窗口还没有 ready

通常是对应加密 key 文件尚未保存、文件属于另一 Windows 用户、key 无效，或还停留在等待输入。先看窗口的原始提示，不要连续双击启动按钮；连续启动可能造成重复 tunnel-client。

### 窗口变多了

检查 3000/8080/8081：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-WebRequest http://127.0.0.1:8080/readyz -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:8081/readyz -UseBasicParsing
```

正常同时运行时，应该是一个 3000、一个 8080、一个 8081。重复启动按钮不会在 ready 状态下再创建同角色进程。

## 五、这次部署中最重要的经验

1. 账号/工作区归属在 ChatGPT 隧道和 app 配置中；本地 MCP 服务只负责提供工具。两个账号可以共享同一个本地工作区。
2. 共享服务和账号隧道要分开管理。停止 Free 不等于停止 Business，也不等于一定要停止 3000 服务。
3. “slim”只减少工具列表，不是安全沙箱。当前 MCP 仍有完整机器权限、命令执行和 Node REPL。
4. Free/Business key 采用一次隐藏输入后由 DPAPI 加密保存，既减少重复操作，也避免把 key 写到脚本或命令行。
5. `.env`、`.secrets/`、`profiles/`、`.mcp-state/` 属于运行配置/状态，不要用 `git add .` 一次性加入版本库。此前的任务验证缓存 `.codex/`、测试临时目录 `.tool-test-tmp/` 和旧 `.mcp-audit.log` 已清理；审计开启后日志可能重新生成。
6. 富文本、Markdown 代码围栏或乱码复制进 PowerShell 文件，会造成“意外标记”“字符串缺少终止符”等 parser error；脚本文件应保持纯脚本内容。
7. 健康检查成功只说明本地/隧道就绪，不等于两个 ChatGPT 账号的网页端真实调用已经分别验证；网页端仍需在各自新聊天里做一次安全的只读测试。

## 六、当前安全提醒

本项目的主要风险是本机权限，不是“多开两个账号”本身：

- `MCP_TOKEN` 当前为空；
- `ADMIN_TOKEN` 当前为空；
- CORS 默认仅允许 chatgpt.com / chat.openai.com 来源（未配置 MCP_CORS_ORIGINS；配置为 `*` 才是任意来源）；
- `CHATGPT_AUTO_APPROVE` 当前为 `true`；
- 工具允许绝对路径、文件写入和 shell 命令；
- Personal key 旧配置仍保存在 `.env`；Free/Business key 若已保存则位于 `.secrets/` 的 DPAPI 文件中；
- checkpoint/活动记录可能保存操作内容。

这些设置支持“网页端直接编程”，但使用时不要把不可信网页、陌生 MCP 或未知代码任务直接交给这个连接器。

## 七、最终检查清单

- [ ] Free 启动入口能打开/复用 3000 和 8080。
- [x] Free 启动入口已接入 Free DPAPI 加密 key 自动读取。
- [x] Business 启动入口已接入 Business DPAPI 加密 key 自动读取。
- [ ] 两个启动入口能打开/复用 3000；没有对应加密文件时才使用兼容回退。
- [ ] 只关闭 Free 时 Business 仍能访问。
- [ ] 只关闭 Business 时 Free 仍能访问。
- [ ] 两边都关闭后，共享 MCP 服务能安全结束，或在未知端口占用时明确停止而不强杀。
- [ ] 两个 ChatGPT 账号各自的新聊天都能完成一次安全的只读工具调用。【未验证】

## 八、清理后的保留清单

必须保留：四个 `start/stop-*-plugin.cmd`、`_one-click-control.ps1`、`start.ps1`、`openai-tunnel*.ps1`、`dist\`、`bin\tunnel-client.exe`、`node_modules\`、`profiles\`、`.env`、`.secrets\` 和 `.mcp-state\`。

维护时保留：`save-free-key.cmd/.ps1` 与 `save-business-key.cmd/.ps1`。它们不是启动依赖，但用于换 key、换 Windows 用户/机器或 DPAPI 文件损坏后的恢复。

已清理且不应依赖：项目根目录下的 `.codex\` 任务验证缓存、`.tool-test-tmp\` 测试临时目录和旧 `.mcp-audit.log`。其中审计日志在启用审计后可以再次自动生成。

## 九、相关官方说明

- [OpenAI Secure MCP tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ChatGPT Developer mode and MCP apps](https://help.openai.com/en/articles/12584461)
