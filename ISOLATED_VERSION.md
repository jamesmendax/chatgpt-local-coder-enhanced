# ChatGPT Web Harness Isolated 0.1.4-isolated.1

Windows x64 隔离预览版，与稳定版使用不同的应用身份和运行配置。

- [GitHub 预发布与下载](https://github.com/jamesmendax/chatgpt-local-coder-enhanced/releases/tag/v0.1.4-isolated.1)
- [版本说明](docs/releases/v0.1.4-isolated.1.md) · [公开验收摘要](docs/releases/v0.1.4-isolated.1-verification.json)

## 使用

下载 Release 中的 portable.exe，直接运行后自行填写工作区与 Tunnel 配置。无需覆盖原版，不会迁移原版配置或密钥，默认不自动启动服务。

| 项目 | 隔离版 |
| --- | --- |
| 名称 / appId | ChatGPT Web Harness Isolated / com.chatgpt-web-harness.isolated |
| MCP / Admin / Tunnel 默认端口 | 3300 / 3301 / 8380 |
| Portable 数据目录 | %APPDATA%\chatgpt-web-harness-isolated |
| 开发启动器数据目录 | desktop\.isolated\chatgpt-web-harness-isolated |
| runtime | 各自数据目录下的 runtime |

源码与 portable 的数据目录故意分开。不复用、不接管、不终止外部服务；端口冲突时报告冲突。不要让原版与隔离版同时使用同一个 Tunnel ID。

## 源码启动与验证

Windows 上准备 Node.js 和 npm，在仓库根目录运行：

~~~powershell
npm install
npm run build
npm --prefix desktop ci
.\Start-Isolated.cmd
~~~

回归入口：根目录 `npm test`；desktop 目录 `npm test`、`npm run test:status:native`、`npm run test:ui:isolated`。测试使用一次性数据与自建临时进程。

打包入口 `npm --prefix desktop run dist:portable` 默认使用 `--publish=never`，GitHub 上传是单独的显式发布步骤。运行所需的隧道客户端不在源码仓库中；如未提前准备，遵循应用内设置流程获取。

## 本轮改进

- 状态探测改为带超时和输出限制的异步查询，避免同步阻塞主线程。
- 非日志页只缓冲最多 3000 行日志，回到首页增量补齐，减少无效 DOM 工作。
- Skill 刷新与保存交错不会覆盖正在编辑的草稿，保存期间的新编辑会保留。
- 所有桌面入口先设置独立身份和数据/会话/运行目录；清理继承的令牌与环境覆盖，禁止任意 user-data-dir 或链接路径穿透。
- 移除安装器按映像名称全局结束进程的逻辑；隔离版只管理自身启动的服务。

## 验证与边界

106/106 定向回归及根/desktop 全量、原生进程、真实 Electron UI 检查通过；最终 portable 解包后核对 23 项桌面源码和 2618 项运行 payload。既有 Visual 浏览器退出测试曾偶发超时，原代码/断言的定向和全量复跑通过，未宣称该波动已根治。

Portable：94,707,143 bytes，SHA-256：

~~~text
ae2465fbd0311c5de2bd972d860b09de8ea6bcff8faa6273d67d9d3ed299acd5
~~~

这是运行配置与实例隔离，**不是 MCP 文件访问沙箱**。未做代码签名、干净 Windows VM、setup/ZIP 生命周期或真实 ChatGPT 云端验收；本次只发布已验证的 portable。

本机构建曾因 electron-builder 经 PowerShell 调 npm 返回空 stdout 而采用直接 npm-cli 的本地适配。适配不进入 app.asar、运行 payload 或公开产品源码，其他构建环境需自行评估。staging 生产依赖仍存在 semver 解析，严格可复现构建属后续工作。

## 回退与源码公开范围

正常退出隔离版后可继续使用原版，无需复制文件回原目录。数据默认保留，清理前只选择上表中的隔离版目录。发布树从公开 main 建立，只导入最终产品源码；不推送本地任务/交接记录、机器配置或私有提交历史。
