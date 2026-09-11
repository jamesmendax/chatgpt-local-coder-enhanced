# 多账号桌面改进：五个上游项目评估与实施边界

评估日期：2026-09-11。以本轮通过 GitHub 读取的默认分支 README 与当前候选源码为依据，不用 stars 代替工程质量，不把上游宣传数字当作本项目性能证据。下列 SHA 是读取到的 README blob SHA，不是整个仓库的 commit。

## 结论

最优先的缺口是账号身份与运行实例没有进入桌面架构，而不是文件工具不够多。当前 main.js 的 Services/ActivityFeeds、paths.js 的 runtime/config/logs、harness.js 的 launcher.yaml 都是单例。先把这些单例改为按稳定 account ID 绑定的实例，再谈新工具；只增加下拉框会产生“界面已切账号，异步任务仍写错目录”的风险。

| 项目与一手来源 | 实际能力与值得借鉴之处 | 本项目已有能力 | 决策 |
| --- | --- | --- | --- |
| [coding-tools-mcp](https://github.com/xyTom/coding-tools-mcp/blob/main/README.md) | 默认 safe/trusted 目录 18 项（注册表 19 项）；按工作区配置档管理服务/隧道；精简 content、完整 structuredContent、分页与可重跑 dogfood；原子、基线校验的多文件修改 | slim/full；输出上限、spill 完整日志；后台进程；任务证据 | 本轮吸收配置档、明确服务归属与失败关闭。下一项做真实 tools/list 字节预算及相同任务的成功率/字节/延时基准，不能粗暴裁掉上游 schema。README 所称 37% 缩减不是本项目实测。 |
| [codexpro](https://github.com/rebel0789/codexpro/blob/main/README.md) | 明确允许的工作区、附件来源限制、diff/verify/handoff；文档建议两个账号用不同进程、端口、URL | 已有附件流式保存、编辑/差异、Goal/task/交接；当前权限模型仍可全盘 shell | 本轮采用“独立账号对应独立 MCP + 独立隧道”的拓扑，不共用一个后台然后只切名称。未来受限工作区模式必须同时约束 shell、真实路径和插件，不能只在文件工具上做字符串前缀检查。 |
| [Serena](https://github.com/oraios/serena/blob/main/README.md) | LSP 驱动的符号、引用、结构检索及语义编辑；可选 JetBrains 后端并非免费核心前提 | 文本 glob/grep/context，缺少真正符号引用图 | 优先作为每个账号可独立启用的 Upstream MCP，而非在核心重写语言服务器。初始仅开放符号概览/查找/引用等只读能力，验证 schema 原样代理后再开放语义编辑。尚未声称已安装、索引或测得性能收益。 |
| [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/README.md) | 交互式长进程、会话、输出 offset/length 分页、有界审计和日志 | start_process、process_output/status、spill 全日志已经存在 | 不重复导入整套文件/Office/执行工具。下一项统一输出游标、进程归属和取消语义，补多账号交叉 PID/日志访问测试；保持进程句柄归账号而非归当前页面。 |
| [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web/blob/main/README.md) | Codex 的 Responses/SSE → 嵌入式 ChatGPT 浏览器；可选任务绑定 MCP 回到原 Codex task；独立 DEV 配置档、浏览器状态、CODEX_HOME、broker/隧道；能力漂移失败关闭 | 本项目方向是 ChatGPT → 本机 MCP，不是模型代理；已有 Goal 会话/证据 | 借鉴明确身份绑定、开发/正式环境分离、真实发布验证与诊断。不要为了多账号管理引入网页登录自动化、复制 cookies 或自动点击批准，也不照搬“Zero Risk”营销名称作为风险保证。 |

## 本轮读取的来源身份

- coding-tools-mcp/README.md：`32340dfb8f9f64683bc7fd7aefdc902d8a07d23d`
- codexpro/README.md：`ce819abd82693bcda8b77c8027b1c1792d5117ae`
- serena/README.md：`6e16380f712b3a5a71d917d45fa4ad18e93da412`
- DesktopCommanderMCP/README.md：`670c947b1e4e5909a7e0d14060b549e561e4e1f0`
- codex-chatgpt-web/README.md：`0fcb85d950cb97c506c14dcfd3dbc1ff62ab63ea`

本轮为独立实现，不复制这些仓库的代码。未来复制实现前逐文件核对许可证与声明；例如 coding-tools-mcp 为 Apache-2.0，而 Serena 的核心 README 标明 MIT。不要将可选商业插件与开源核心混为一谈。

## 第一阶段落地设计

```text
一个桌面控制台（当前账号只是视图选择，不是全局身份）
 ├─ 默认账号：保留旧 config.json、runtime、logs，不挪动/复制凭据
 ├─ 账号 B：accounts/<稳定 ID>/config.json + runtime + logs
 │    ├─ MCP B：独立 MCP/Admin 端口、CODEX_HOME、shell state、审计与 checkpoint
 │    └─ Tunnel B：自己的 Tunnel ID/Runtime Key，固定转发 MCP B
 └─ 账号 C：另一组目录、端口、实例和隧道
```

每个 IPC 请求发起时捕获 account ID；异步操作的身份不会随页面切换变化。子进程日志、状态轮询、活动源与退出清理亦绑定原账号。界面迟到响应不能覆盖另一个账号的表单。新账号从无密钥、未初始化、不自动启动的空配置开始，端口自动避让，工作区默认独立。重复端口与重复 Tunnel ID 必须在保存/启动前拒绝；运行时配置修改须先停止本账号，不影响其他账号。

界面明确区分“切换正在查看的账号”“启动/停止该账号”“退出时停止本程序所有自建服务”。显示账号名、三个本地端口、工作区、数据位置与各自 MCP/隧道状态。连接向导要求用户在正确的 ChatGPT 账号/工作区配置对应隧道；本机名称不是云端已认证身份。

## 安全与验收边界

同一 Windows 用户下的多个目录和进程只提供运行隔离，不抵御一个拥有任意 shell 的账号访问另一个账号。DPAPI/safeStorage 保护落盘凭据不等于隔离同一 Windows 用户；多账号都能访问的本地监听也不是安全边界。需要相互不信任主体隔离时，应独立 Windows 用户配合 ACL、受限服务，或独立 VM/容器与必要的权限收缩。本轮不创建系统用户、不修改系统策略，不将目录隔离冒充沙箱。

本轮验收应覆盖：旧配置字节保全、创建无密钥继承、并发异步路径/日志不串号、重复端口/隧道拒绝、只停一个账号不影响另一个、真实双 MCP 进程、实际 Electron UI、最终 portable 解包和 payload。tunnel-client doctor/local ready 不是云端认证成功；没有第二账号凭据时不声称真实第二账号已连接。

后续独立工作包：真实上游原始 schema 扩展字段回归（上传状态的 17 项需与实际源码对齐）、工具目录预算、Serena 按账号集成、独立视觉评审链与模型任务基准、真正 OS 权限模式。它们不能因本轮多账号功能可用而被勾选为已完成。
