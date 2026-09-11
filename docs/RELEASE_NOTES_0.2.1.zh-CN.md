# ChatGPT Web Harness Isolated v0.2.1

这是 0.2.0 的修复版本，重点修复多账号隔离模式下的 Computer Use、Git 发现与短时网络/子进程异常韧性问题。

## 主要修复

- Computer Use：账号隔离仍保留独立 `CODEX_HOME` 与启用状态，但可只读发现宿主 OpenAI bundled Computer Use Skill 与 CUA Node runtime；开关按账号持久化，并在新的 MCP 会话中生效。
- Git：在隔离 PATH 被缩窄时，通过受信任的 Git for Windows 安装位置发现 `git.exe`，不恢复整段宿主 PATH。
- MCP 进程清理：修复 Windows PATH 大小写别名导致 System32 丢失，以及超时清理时 `taskkill` 异步 spawn 错误可能令 MCP 进程崩溃的问题。
- 服务恢复：仅对本应用明确拥有且异常退出的 MCP/Tunnel 做有限、退避式恢复；主动停止、配置切换、账号切换与认证错误不会被误判为自动重启条件。
- Tunnel：基于 OpenAI `tunnel-client v0.0.14` 的可审计派生补丁，将终端 JSON-RPC 结果回传置于 90 秒有限重试窗口内，同时保留通知消息原有的防重放规则。故障注入验证覆盖 5 秒取任务故障与 30 秒结果回传 503/reset，工具只执行一次且最终结果成功送达。
- 多账号与 UI：修复账号创建/切换、Skills/插件页面及相关自动化验收竞态。

## 已验证交付物

- `ChatGPT Web Harness Isolated-0.2.1-setup.exe`
  - 116,571,735 bytes
  - SHA-256 `f02bf610073e31b1d6f7bf1b060f9369d1f3c62811349c1f036f72b834bb410f`
- `ChatGPT Web Harness Isolated-0.2.1-portable.exe`
  - 105,038,338 bytes
  - SHA-256 `3fb387b9c7b9c840bc3f875666ceb3783caa44dc67dcbf79d6bde3ec22a53fc3`
- `ChatGPT Web Harness Isolated-0.2.1-setup.exe.blockmap`
  - 121,929 bytes
  - SHA-256 `a1dfc078f9eab6fc4f1b0fae9c802044c6f5f8d1c4c372c5be695cdaf81f50b8`

同时提供 `SHA256SUMS-0.2.1.txt` 与 `VERIFICATION-0.2.1.txt`。

## 边界

- Windows EXE 当前未做 Authenticode 签名。
- Computer Use 开关变化需要新的 MCP 会话才会反映到运行时工具/Skill 集合。
- 多账号实现的是配置、运行目录与受管进程隔离，不宣称 Windows OS 级安全沙箱。
- 发布此版本不会覆盖既有 0.2.0 资产，也不会改写 1.x 主线历史。
