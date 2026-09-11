# 通用视觉与代码工作：质量反馈审计

本次针对 ChatGPT Web Harness 的输入、工具反馈与完成验收，避免把通用问题缩成某一幅 SVG 的绘画提示词。以下结论来自源码及真实 MCP 客户端回归，不构成两个模型能力差异的受控评测。

## 已复现的问题与修复候选

| 问题 | 实际后果 | 修复与验证 |
| --- | --- | --- |
| Playwright newPage 参数错误，width/height 未放进 viewport | 请求手机 390×844 或桌面 1440×900，实际均为 1280×720；手机 CSS 未触发 | 公共页面创建修正参数；PNG 尺寸及 media query 颜色检测 |
| 独立 SVG 画布超出截图 | 横图右边、竖图下边的内容缺失 | 适配完整外画布，保留 viewBox 和 preserveAspectRatio；四角像素及源文件哈希验证 |
| 请求完整网页超过截图安全上限仅发提示 | 不完整截图可能被当完整证据 | 返回 machine blocking issue；长网页 render_status=blocked |
| 超长文本行丢失尾部并错误标记读取完成 | 模型据不完整代码做判断 | 行号和行内字符续读，含 Unicode 边界与 EOF 回归 |
| 业务失败没有 MCP isError 标志 | 宿主缺少标准失败信号 | ok=false 同时设置 isError=true |
| 成功工具调用被当作任意验收项证据 | 无关目录的测试也可确认代码任务 | 验收声明绑定命令、目录、源码和测试文件；检查启动与完成时指纹及完成时的新鲜度 |
| 后台旧结果重读风险 | 修改源码后可能把旧成功重新当新证据 | 指纹绑定进程生命周期；重复 process_output/status 不重新生成有效指纹 |

写入成功只证明保存；视觉评分是调用模型自报。新增反馈明确 delivery_ready、independent_quality_verified=false 和下一步动作，避免工具操作成功被误读成作品合格。

## 参考项目的具体机制

这些项目是相关实现样本；GitHub stars 只能反映关注度，不能证明实际用户数量或模型效果。

- **coding-tools-mcp**：工具文本专门呈现错误、是否可重试、截断与下一次读取调用，保留 structuredContent，避免把完整 JSON 机械复制到文本。可借鉴的是可执行的恢复线索；不能未经宿主兼容测试直接删掉所有文本。[tool_results.py](https://github.com/xyTom/coding-tools-mcp/blob/bedb632e1afd2e9ec9b268a50fe0b04695c22c64/coding_tools_mcp/tool_results.py)
- **codexpro**：上下文包含文件 SHA-256、行范围、已包含/跳过文件清单和总预算。应借鉴可追溯的上下文完整性声明，而非仅增加上下文长度。其最终截断仍使用字符串切片，不能把整个实现视为无损阅读保证。[proContext.ts](https://github.com/rebel0789/codexpro/blob/587f7fd3a4644a847bba13aeb49336056052e1f6/src/proContext.ts)
- **Serena**：先用符号概览理解文件，按需要获取符号内容，并限制答案长度。适合后续补强大仓库的精准定位；不是让模型反复读取整个项目。[symbol_tools.py](https://github.com/oraios/serena/blob/701e7c843f46c6a649203a488cece1bf19f1df90/src/serena/tools/symbol_tools.py)
- **Aider**：repository map 按相关性排序并受 token 预算限制，结合已提及文件与标识符。适合减少无关上下文，不是机械缩短有用证据。[repomap.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py)

## 仍需优化与验收的边界

已有 Goal 没有 verification 时，确认会返回 GOAL_VERIFICATION_REQUIRED；用 goal(update) 为同一验收项补充检查，再执行检查并 confirm，无需删除 Goal。命令类 target 是绝对工作目录，command 是实际完整命令，files 包含此次检查依赖的源码与测试文件。它只保护声明过的输入；未列入的配置或依赖变更不在内容指纹覆盖范围内。file_exists 仅用于存在性条件，不能用于代码正确性或视觉质量。

1. **验收条件的质量**：命令绑定只能证明该命令检查了该版本的输入；模型选择了空洞测试，仍不能证明需求完成。代码应覆盖用户行为、边界与回归；视觉应分开检查内容准确、布局、可读性、全页覆盖和关键细节。不能用文件存在或主观分数替代这些检查。
2. **独立复核**：当前视觉 critique/assess 是同一调用模型的报告，不是独立视觉评审。对高要求交付，应引入独立复核或明确保留人工评价状态；不可把模型填的 inspected_full_render 当作看过图片的外部证明。
3. **宿主循环**：MCP 可以拒绝错误的 goal complete，但不拥有 ChatGPT 的生成循环，不能强制其继续。需用真实网页任务验证模型是否消费工具图片、错误与续读指令。
4. **公平评测**：固定任务、输入文件、工具目录、预算和验收标准，在 Web 上分别记录首次交付、漏检项、修复轮数和真实结果。机械回归与模型实际表现分别报告。
5. **交付一致性**：源代码回归通过不等于正在运行的桌面包已更新；须核对实际运行文件、工具 schema 和宿主缓存。发布仍走指定公开仓库的选择性同步，不能整仓公开生产数据。

## 当前状态

候选源码已通过构建、八项质量反馈回归（含旧 Goal 恢复、后台旧结果重放和执行期间输入变更）、HTML/SVG 像素回归及 Goal 正常完成流程的定向检查。视觉综合测试单独运行通过；完整套件两次分别遇到 Chromium screenshot capture 错误和 browser close 15000ms 超时，不能报告全绿。原始基线单独视觉测试也通过，尚不足以确定失败归因。服务端集成段及 Office 的 PowerPoint/Word 渲染检查已分别通过。发布集成和真实网页对照验收仍未完成；本文件不声明已经部署，也不声明 GPT-6 Pro 的整体表现已恢复。

配置读取也发现了错误被隐藏的路径：权限错误或损坏 JSON 原先被当成首次启动默认值。候选修复只对 ENOENT 使用默认配置，其他读取错误明确阻止启动，保留原文件。配置与隔离相关的 22 项定向测试已通过；启动入口无副作用检查仍在补充。既有便携包早于此修复，不能当作最新源码的验收包。

用户批准后，本次创建的空测试目录已清理。浏览器连接重试仍被运行时自动审批拒绝（BROWSER_CONNECT_FAILED）；只读 doctor 能定位运行时，但不证明已连接网页。因此真实网页对照验收仍未完成。
