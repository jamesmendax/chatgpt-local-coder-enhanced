# Web Harness Goal Continuous Execution 改造交接文档

日期：2026-08-30
项目：`D:\chatgpt-local-coder`
主题：将 Goal Mode 从“持久目标/完成门”升级为“持续执行契约（Continuous Execution Contract）”

---

## 1. 改造背景

原 Goal Mode 已经具备以下能力：

- 持久化 objective / success criteria / constraints / current phase；
- active Goal 会被 Instruction Context / Harness Context 持续注入；
- active Goal 的未完成 criteria 会阻止 durable task 进入 `DELIVERABLE_READY`；
- criteria 全部满足后，必须显式 `goal(action=complete)`，之后 task 才能 complete。

但原实现存在一个关键行为缺口：

> Goal 能约束“不能过早宣布完成”，却没有足够强地约束“不能只做阶段性进度汇报然后停止执行”。

实际表现可能是：

1. 模型创建 Goal；
2. 执行若干工具；
3. 输出“目前已完成……接下来会……”之类进度；
4. 当前 assistant turn 结束；
5. Goal 仍 active，需要用户再次发送消息才能继续。

这与希望实现的 Web Harness Agent 行为不一致。目标行为应为：

> 只要用户在新对话中创建了 active Goal，模型就应默认持续调用工具推进，普通 progress update 只能是 checkpoint，不是停止条件；除非遇到真实 blocker、需要用户输入/批准/凭证/物理操作，或 Goal 被 pause/cancel，否则应持续执行到 Goal 完成并完成相关 task 后再最终回复。

---

## 2. 本次核心设计

新增统一全局契约：`GOAL_CONTINUATION_CONTRACT`。

当前语义：

```text
Active Goal = continuous execution.
After goal(action=create) or resume, keep using tools in the same assistant turn until the goal is completed;
a progress update is not a stop condition.

Yield to the user only for a real blocker that requires user input, approval, credentials, or physical action
(record blocked state when a task exists), or when the goal is paused/cancelled.

When every criterion passes, immediately call goal(action=complete);
if an active durable task exists, then call task_state(action=complete)
and do not send the final answer until DELIVERABLE_READY.
```

新的标准完成链：

```text
Goal active
  ↓
持续执行工具
  ↓
criteria 全部满足
  ↓
goal(action=complete)
  ↓
若存在 active durable task：task_state(action=complete)
  ↓
DELIVERABLE_READY
  ↓
最终用户回复
```

普通阶段性 progress message 不再属于合法停止条件。

---

## 3. 修改文件

### 3.1 `src/lib/goals.ts`

主要修改：

1. 新增导出常量：

```ts
GOAL_CONTINUATION_CONTRACT
```

2. `GoalSummary` 增加：

```ts
execution_mode: "continuous";
continuation_contract: string;
```

因此 Goal 的结构化状态不再只说明“Goal 是 active”，还明确告诉模型当前执行模式为 continuous。

3. `goalSummary()` 现在返回：

- `execution_mode: "continuous"`
- `continuation_contract: GOAL_CONTINUATION_CONTRACT`

4. `formatActiveGoalForInstructions()` 强化。

原先主要表达：

> keep working toward this outcome; do not declare completion while criteria remain

现在明确增加：

- Goal 是 continuous execution contract；
- progress update 不是 stop condition；
- 普通进度只能视为 checkpoint；
- 除非契约允许 yield，否则继续执行。

5. `activeGoalReminder()` 强化。

现在每次 reminder 都显式包含：

```text
Execution contract: <GOAL_CONTINUATION_CONTRACT>
Continue executing now. Do not end the assistant turn for an ordinary progress update.
```

这样旧 reminder 路径也保持一致行为。

---

### 3.2 `src/lib/context-broker.ts`

这是本次改造最关键的运行时注入层。

原来 Context Broker 对 active Goal 的提示较弱，大意为：

```text
Keep working toward it; do not claim completion while criteria remain...
```

问题是这只能防止“假装完成”，不能防止“进度汇报后停止”。

现在改为直接复用 `GOAL_CONTINUATION_CONTRACT`。

active Goal 的 Harness Context 中会出现：

```text
GOAL CONTINUATION CONTRACT: ...
ACTIVE GOAL: ...
Phase: ...
Success criteria: ...
Remaining: ...
```

这意味着模型在后续普通工具调用中，会持续收到明确的 continuous-execution 约束。

这一层解决的是：

> Goal 已经运行一段时间之后，模型不能因为上下文漂移而逐渐把 Goal 降级成普通 todo/checkpoint。

---

### 3.3 `src/tools/goal.ts`

这是解决“刚创建 Goal 就停”的关键入口。

原实现中 `goal` 属于 Context Broker 的 skip-text 工具之一，因此 `goal(action=create)` 的那次工具返回不会依赖普通 Broker text snapshot 来提醒模型。

以前 create 返回核心信息类似：

```text
goal active: <id>
```

现在 `create` 与 `resume` 的 Tool Result 会直接加入：

```json
{
  "execution_contract": "...",
  "continue_execution": true
}
```

summary 也改为：

```text
goal active: <id> — continue execution
```

因此 continuous execution 不再等到“下一个工具调用”才生效，而是在 Goal 创建/恢复成功的那一刻就显式生效。

同时 Goal tool description 也更新为 continuous-execution 语义。

注意：tool description 最初写得较长，导致 slim profile 的 `tools/list` 超过 23 KB 测试预算。后来将 description 精简，但保留完整语义，使最终工具目录预算恢复到测试阈值内。

---

### 3.4 `scripts/test-goal-mode.mjs`

新增回归检查，防止未来重构把 continuous execution 行为删掉。

新增验证包括：

1. `formatActiveGoalForInstructions()` 必须包含 `GOAL_CONTINUATION_CONTRACT`；
2. instruction 必须出现 `progress update is not a stop condition`；
3. `goalSummary()` 必须返回：

```text
execution_mode = continuous
continuation_contract = GOAL_CONTINUATION_CONTRACT
```

4. Context Broker V2 的 `formatHarnessRuntimeContext()` 必须包含：

```text
GOAL CONTINUATION CONTRACT
```

并包含 progress-not-stop 语义；

5. per-tool active-goal reminder 必须包含：

```text
Do not end the assistant turn for an ordinary progress update
```

原来的以下 completion gate 测试仍保留：

- criteria 未满足时 task complete 必须失败；
- criteria 全满足但 Goal 仍 active 时 task complete 必须失败；
- Goal complete 后 task 才允许 complete；
- revision CAS；
- `requires_confirmation`；
- `user_confirmed` evidence。

---

### 3.5 `AGENTS.md`

更新 Agent Onboarding 规则，将 Goal 明确定义为：

```text
continuous-execution contract
```

并明确完成链：

```text
goal complete
→ task_state complete
→ DELIVERABLE_READY
→ final reply
```

这样项目文档、运行时注入和实际状态机保持同一个行为模型。

---

## 4. 本次没有修改的关键边界

本次改造没有新增 MCP tool，也没有改变以下接口边界：

- 没有修改 MCP endpoint；
- 没有修改 tunnel ID / tunnel URL；
- 没有修改 `MCP_TOKEN` 鉴权方式；
- 没有修改现有 tool 名称；
- 没有新增 Goal action；
- 没有修改 Goal input schema 的参数结构；
- 没有新增用户必须配置的环境变量；
- 没有修改 Business / Free tunnel 架构。

变化主要发生在：

- Goal 返回内容；
- Goal summary；
- tool description；
- Instruction Context；
- Harness Context / Context Broker；
- Agent 行为约束。

---

## 5. 验证结果

### Build

执行：

```text
npm run build
```

结果：

```text
exit 0
```

TypeScript 编译通过。

### Full test suite

执行：

```text
npm run test
```

最终结果：

```text
exit 0
```

其中 Agent Harness 最终验证：

```text
agent-harness: 27-tool slim (22944 bytes), Goal Mode, compact task tracking,
automatic observations, command logs, and background logs OK
```

Visual Review / Office Visual Review 等完整测试也通过。

实施过程中曾出现一次预期内的回归：Goal tool description 变长后 `tools/list` 达到 23036/23189 bytes，超过 23000 bytes budget；通过精简 description 后恢复为 22944 bytes，全量测试通过。

---

## 6. 是否需要重启 MCP

### 结论：需要。

原因：生产进程实际运行的是：

```text
node dist/index.js
```

正在运行的 Node 进程不会热加载本次 TypeScript / dist 变化。

本次已经执行过：

```text
npm run build
```

因此当前 `dist` 已生成新版代码。

接下来只需要重启 MCP 进程，让新进程加载当前 dist。

仓库已有：

```text
restart-mcp.cmd
```

其行为：

- 停止当前共享 MCP；
- 启动新的共享 MCP；
- 等待 `/health`；
- 检查 loaded build 是否 stale；
- **不会重启 Business / Free tunnel**。

`restart-mcp.cmd` 输出也明确说明：

```text
Shared MCP restarted. Business and Free tunnels were not restarted.
```

`Restart-SharedMcp` 还会检查：

```text
Restart completed, but the loaded build is still stale
```

如果出现该错误，说明进程没有加载当前 dist，需要检查 build 输出。

### 一个重要注意点

`start.ps1` 在 `dist/index.js` 已经存在时默认会直接使用现有 dist，而不是每次都强制重新 build。

所以以后如果又修改了 `src`：

```text
先 npm run build
再 restart-mcp.cmd
```

最稳妥。

本次已经完成 build，因此现在直接 `restart-mcp.cmd` 即可。

---

## 7. 是否需要重新发布 ChatGPT 应用

### 当前这次改造：正常情况下不需要重新发布应用。

理由：

ChatGPT 端连接的是同一个 MCP HTTPS endpoint：

```text
ChatGPT Web
→ existing connector/app
→ stable tunnel URL
→ local MCP :3000
```

本次没有改变：

- 应用 URL；
- tunnel ID；
- MCP endpoint path；
- token；
- tool 名称；
- input schema；
- 权限模型。

它属于服务端实现更新，而不是创建一个新的 ChatGPT App/Connector。

因此推荐操作是：

```text
1. npm run build                # 本次已完成
2. restart-mcp.cmd              # 需要执行
3. 保持 Business/Free tunnel 不动
4. ChatGPT Settings / Apps 中 Refresh 当前 connector/app
5. 新开一个聊天
6. 重新 tag/启用当前 connector
7. 创建一个测试 Goal 验证 continuous execution
```

README/AGENTS 也明确建议 server restart 后：

```text
Refresh connector + new chat
```

### 什么情况下才需要重新发布/重新创建应用

只有后续出现以下类型变更时，才应单独评估是否需要重新发布或重新扫描应用：

- MCP URL / tunnel URL 改变；
- token / auth 机制改变；
- 应用连接配置改变；
- tool 名称发生 breaking change；
- tool input schema 出现需要 ChatGPT 重新识别的重大结构变化；
- OpenAI App 发布配置/权限/metadata 本身发生改变；
- 平台明确要求已发布 App 对某类 tool capability 变更重新提交审核。

本次不属于上述情况。

本次虽然改变了 Goal tool description 和返回的附加结构化字段，但服务器仍通过同一个 MCP `tools/list` / `tools/call` 暴露能力；重启后 Refresh connector 即可让新对话读取当前服务器状态。

---

## 8. 重启后建议的验收测试

不要用旧聊天验证。推荐新开聊天，tag 当前 MCP，然后做最小行为测试。

测试目标：

```text
让 Agent 创建一个包含 2~3 个可机器完成 criterion 的 Goal，
任务必须实际调用多个工具才能完成。
```

期望行为：

1. `goal(action=create)` 成功；
2. Goal 返回包含：

```text
continue_execution: true
execution_contract: ...
```

3. 模型不会在创建 Goal 后只发一段“我接下来会……”并停止；
4. 后续普通工具返回的 Harness Context 包含：

```text
GOAL CONTINUATION CONTRACT
```

5. 模型持续推进；
6. 普通 progress update 不结束执行链；
7. criteria 全满足后调用 `goal(action=complete)`；
8. 有 durable task 时继续 `task_state(action=complete)`；
9. 达到 `DELIVERABLE_READY` 后再最终回复。

如果遇到真实需要用户输入的 blocker，则允许停下，但应明确 blocker，而不是把普通 progress 当 blocker。

---

## 9. 后续维护原则

未来维护 Goal Mode 时应保持以下不变量：

### A. Goal create 本身必须携带 continuation signal

不能只依赖下一次 Context Broker 注入，否则“创建 Goal 后立即停”会重新出现。

### B. Context Broker 必须持续重复 continuous-execution contract

不能只在 session instructions 中注入一次，否则长任务中容易上下文漂移。

### C. Completion gate 与 continuation contract 是两层不同机制

- Completion gate：防止过早宣布完成；
- Continuation contract：防止尚未完成时仅汇报进度然后停住。

两层都必须存在。

### D. Progress update 不是停止条件

普通 progress 可以对用户可见，但只应是 checkpoint；如果平台允许继续工具调用，应在同一执行链继续。

### E. 保持 `tools/list` 预算

slim web profile 当前预算测试是：

```text
<= 23000 bytes
```

Goal/tool description 增长会直接影响该预算。修改 tool description 后必须跑 `npm run test`。

---

## 10. 当前交接状态

代码状态：已修改

Build：通过

Full tests：通过

Dist：已生成新版

MCP 生产进程：尚需重启后才能加载新版逻辑

Tunnel：无需重启

ChatGPT App/Connector：无需重新发布；重启 MCP 后 Refresh 当前 connector，并使用新聊天验证

下一步推荐：

```text
restart-mcp.cmd
```

随后：

```text
Refresh connector
→ 新聊天
→ tag connector
→ 创建测试 Goal
→ 验证 continuous execution 行为
```

---

## 11. 二轮强化与独立审查(2026-08-30 追加)

初版改造经用户确认意图后,又做了一轮针对性强化,并由**三个独立子代理**完成"覆盖审计 → 对抗攻击 → 复核确认"的完整闭环,最终判定 **PURPOSE-ACHIEVED**。

### 11.1 二轮强化内容

1. **停车时刻信号全覆盖**:
   - `goal update/confirm` 在仍有未满足 criteria 时返回 `continue_execution: true` + `execution_contract`;
   - `task_state create/resume/checkpoint` 全部携带继续信号;
   - `goal-exists` 拒绝、`completeGoal` 拒绝、`assertGoalAllowsTaskCompletion` 拒绝、blocking-checks 拒绝——四类完成门拒绝信息统一追加 "a progress update is not a stop condition" 指令。
2. **blocked 感知信号(P1-2 修复)**:`continuationFields(goal, blocked)` — 刚声明 blocker 的 checkpoint/resume 返回 `blocked_yield: true`(允许向用户让位),**不再**与 "keep executing" 自相矛盾;blocker 解除后信号自动恢复为 continue。
3. **快照抗截断(P1-1 修复)**:goal 块在 task 块**之前**渲染 + 所有变长行加帽(objective 300 / step 200 / phase 200 / blockers·next_actions·remaining 名 160 / blocked.message 200)。最坏实测(4000 字符 objective + 3×1000 字符 blockers):1821 字符快照中契约、目标、标准行**全部存活**。
4. Broker 构建失败时输出告警(不再静默丢快照)。
5. 测试:agent-harness 断言 create 信号与 checkpoint 信号;harness-v2 断言 heavy-text 存活与 "Remaining: none" 防护。

### 11.2 独立审查闭环记录

| 轮次 | 代理 | 结论 |
|---|---|---|
| 1 | 覆盖审计(逐停车时刻核对信号) | PURPOSE-ACHIEVED(主链路),5 个一致性缺口 |
| 1 | 对抗攻击(试图让目的失效) | GAPS-REMAIN:P1×2(截断吞契约、blocked 被反指令)+ 7×P2 |
| 2 | 复核确认(修复后) | 两个 P1 **CLOSED**、全部缺口 **CLOSED**,最终 **PURPOSE-ACHIEVED** |

### 11.3 信号覆盖矩阵(最终态)

| 停车风险时刻 | 信号 |
|---|---|
| goal create / resume | `continue_execution: true` + `execution_contract`(必然) |
| goal update / confirm(仍有未满足 criteria) | 同上(条件触发);criteria 全过时不发(应走 complete) |
| task_state create / resume / checkpoint(未 block) | `continue_execution: true` + `execution_hint` |
| task_state checkpoint(刚声明 blocker) | `blocked_yield: true` + 让位提示(契约的合法停车路径) |
| 普通工具调用 | harness_context 快照含 `GOAL CONTINUATION CONTRACT`(变化即注入 + 5 分钟刷新 + 新 session 重置) |
| 四类完成门拒绝 | 错误信息末尾带 "not a stop condition" 指令 |
| 新聊天 | instructions 冷注入 + 首次工具结果必注入(保留重置) |
| 长对话无状态变化 | 5 分钟刷新重投快照 |
| 机械兜底 | criteria 未满 → task 永远进不了 DELIVERABLE_READY |

### 11.4 已接受的已知项(不威胁目的)

- tools/list 22944/23000(56 字节余量,两处断言把守);
- goal-only 会话(无 task)契约节奏为 5 分钟刷新 + create/update 结果;
- `activeGoalReminder`/`appendActiveGoalContextToResult` 为未接线的遗留路径(仅测试引用);
- instructions 每会话一次构建(重启后生效;运行中 goal 变更靠热通道补);
- visual-gate 拒绝信息无统一后缀,但各自含明确下一步指令(等价目的)。

---

## 12. 真实 Web 复现后的根因修复(2026-08-30 追加)

用户在真实 ChatGPT Web 上测试后反馈:goal 依然反复停在"请求进入下一阶段"。排查结论:**新 build 已加载(stale_build:false,goal 也真实创建,事件 121+ 条),信号存在但设计有结构性缺口**:

1. **快照去重把信号从停车决策现场移走了**:完整快照只在状态变化或 5 分钟刷新时注入;模型做出"结束 turn"决定的那个瞬间,最近一条工具结果里往往**没有**契约(它躺在上下文历史里,不在眼前)。这正是"报告进度然后等确认"复发的空间。
2. **契约未显式禁止"请求进入下一阶段"**:goal 带 current_phase,模型把 phase 边界当成合法请示点。

修复(需重启后生效):

1. **常驻继续信号**:goal active 且 criteria 未满足时,**每条**工具结果都追加一行轻量信号(约 1 行,去重的只是完整快照):`GOAL x/y — keep executing toward: <下一标准>. A progress update is not a stop condition; do not ask permission for the next phase — continue.` 模型在停车决策前的最后一个 token 永远是继续指令。
2. **契约显式枚举禁止模式**:"Never end the turn by asking permission to proceed to the next phase or step, by presenting a plan instead of results, or with any form of 'shall I continue?' — phases are bookkeeping, not stopping points."
3. instructions 的 Goal rules 与 checkpoint 的 execution_hint 同步加入该禁止。

维护不变量新增:**去重只能去完整快照,常驻一行继续信号不可去**——它是防"报告即停车"的核心机制,不是 token 优化对象。

---

## 13. 二轮对抗审查后的信号升级(2026-08-30 追加)

常驻信号上线前,又由两个独立子代理做了"逐停车点模拟审计"(12 个停车决策点 12/12 有信号)与"效果充分性对抗评估"(判定 PARTIAL,机制对但强度不足)。据其建议完成 4 项升级:

1. **命令式尾部措辞**(替换被动提醒):
   `GOAL x/y — NOT DONE. Your next action must be a tool call advancing: <下一标准>. Progress updates, plans, and "shall I continue?" are forbidden turn endings. Genuinely blocked? task_state checkpoint with blocked_reason, then yield — otherwise continue.`
   生产复盘证实:模型在看到完整契约约 2.5 分钟后仍然停车——一次性送达会失效,**信号必须是对下一个动作的指令**,并自带合法让位出口(防过度纠正:不会为了不停车而硬闯真 blocker)。
2. **skip 工具补上尾部信号**(此前最大的洞):ChatGPT 每轮开头的预检动作恰好全是 skip 集合(agent_status/remember/load_skill/project_context),且任何以它们结尾的 turn 完全无信号。现在 skip 工具跳过的是完整快照,**尾部信号照发**;仅 goal/task_state(自带信号)豁免。
3. **升级措辞**:同一工作区连续 12 条"仅尾部"结果后,尾部切换为升级变体(`Unchanged for N results — either call a tool that advances X, or pass it via goal(action=update) only with supporting evidence; do not narrate progress`),对抗模板化疲劳。
4. **死代码清理**:`activeGoalReminder`/`appendActiveGoalContextToResult`(未接线的遗留路径)已删除,对应测试断言同步移除。

已接受的项:尾部 ~75 token/条(200 次调用约 1.2 万 token,可接受);追加在结果末尾是正确位置(停车决策读取最近的文本);抛出式异常(MCP error)不带信号,但 ChatGPT 对失败会重试;instructions 每会话一次构建,goal 中途创建时冷通道缺席属固有限制。

**验证**:`npm run build` + `npm run test:all` 全绿;harness-v2 断言尾部措辞/skip 工具覆盖/自信号豁免;agent-harness 断言 create 与 checkpoint 信号。

---

## 14. 真实冲突事故的根因修复(规则冲突 + 脏状态,2026-08-30 追加)

真实网页端复现:鹈鹕任务轮,agent 在 6+ 次工具调用后发出进度消息并停车。网页端 agent 自己定位的根因**成立**:用户全局长任务规则("每 3 个工具调用必须汇报进度")与本契约("完成前禁止用户可见回复")正面冲突。连带发现一个**脏状态 bug**。

### 14.1 修复清单(全部已实现并测试)

1. **契约显式压制通用进度规则**:契约新增一句——goal active 期间**取代**任何"每 N 次调用汇报进度"类通用规则,全部中间进度只进 task_state checkpoint,直到 DELIVERABLE_READY 或已验证 blocker。常驻尾部同步加入 `MUST_CONTINUE_TO_TOOL` / `USER_REPLY_ALLOWED: false until DELIVERABLE_READY or a verified blocker` 与压制声明。
2. **脏状态根因修复(goal-exists 话术反噬)**:此前拒绝话术说"继续朝现有 goal 干",直接诱导模型把新任务的 criteria **追加**到旧 goal 上(5/9 混合状态的成因)。已重写:拒绝信息现在区分"同一任务 → update 继续干"与"不同任务 → 先 cancel 或 `action=create` 带 `supersede=true`",并明确禁止往旧 goal 追加无关 criteria。
3. **`goal(create, supersede: true)` 原子替换**:取消旧 goal + 创建干净新 goal,一次调用完成——从机制上消灭"criteria 杂物抽屉"。
4. **execution_policy 状态锁**:goalSummary 新增 `execution_policy: { progress_messages: "checkpoint_only", user_reply: "until_DELIVERABLE_READY_or_verified_blocker", supersedes_generic_progress_rules: true }`,随快照/结构化结果发到模型——即用户要求的"Harness 状态锁"层。
5. **停车遥测**:新事件 `goal/stall`——goal active + criteria 未满足 + 高价值活动间隔超过阈值(默认 10 分钟,`GOAL_STALL_GAP_MS` 可调)时记录 `{gap_ms, criteria_passed, criteria_total}`;已验证 blocker 让位不算 stall;每间隙节流一条。中停从此可量化。
6. **tools/list 预算口径统一**:run-all-tests 原先量的是含 JSON-RPC 信封的原始响应文本(23011),与 agent-harness 的载荷口径(22977)不一致导致假告警;统一为载荷测量。

### 14.2 用户侧动作(一次性)

全局长任务规则中加入例外条款(网页端 agent 起草的版本可用,推荐与契约一致的措辞):

```text
【Goal Continuous Runner 最高优先例外】
当存在 status=active 的 Goal 时,暂停执行所有"每 3 个工具调用必须汇报进度"、
"阶段性成果必须立即报告"等用户可见进度规则。Goal active 期间:
1. 所有阶段进度只写入 task_state/checkpoint,不发送给用户;
2. 普通工具错误、文件生成、测试通过、视觉审核结果均不触发用户可见消息;
3. 仅两种状态允许回复:A. Goal completed + task completed + DELIVERABLE_READY;
   B. 已验证的 user-only blocker(先用 task_state checkpoint blocked_reason 记录);
4. Goal completed 后恢复正常进度规则。
```

同时注意:**旧 goal 若与新任务无关,让 agent 先 cancel 再建新 goal,或 `goal(create, supersede=true)`**——不要往旧 goal 上追加 criteria。

---

## 15. 契约重写(从补丁堆到单一连贯契约,2026-08-30 追加)

用户新子代理的对抗审查指出:契约经 4 轮演进已成补丁堆——"real blocker" 与 "verified blocker" 措辞分裂、缺"用户插话"条款、SUPERSEDES 类别未覆盖 pacing/check-in 类规则、且 **supersede/cancel 会留下旧 active durable task 继续污染快照导向**。已按审查建议整体重写(不再是追加补丁):

1. **契约单源重写**(goals.ts):统一 "verified blocker" 措辞;SUPERSEDES 类别扩为 "progress-reporting, pacing, or check-in rule";新增**用户插话条款**("If the user sends a message mid-goal, answer it in the same turn and keep executing; a user reply is never a stop condition"——回答用户提问不是停车);以"仅有的两种合法结束方式"枚举(verified blocker 记录后让位 / completion)收拢全部例外。
2. **尾部去过度压制**:`USER_REPLY_ALLOWED: false` 改为 `Expect no user reply until DELIVERABLE_READY or a verified blocker`(修复"模型永远不许说话"的误读);`MUST_CONTINUE_TO_TOOL` 保留。
3. **脏状态残余清理**:goal supersede/cancel 时联动取消遗留的 active durable task(此前会继续污染快照导向旧目标)。
4. instructions 的 Goal rules 去重(契约已在上文,不再复述)。
5. 保留的低危已记录项:stall 遥测盲区(goal-only 工作流、纯停车滞后指标、>24h 指针过期)、lastStallNotified 节流表不清理(量级无害)。

用户侧最终指令(替换而非删除——该规则对无 goal 的长任务仍有价值,只是要划作用域):

```text
当 harness goal 处于活跃状态时:不要发送进度汇报,不要等待确认——harness 在
checkpoint 记录进度;仅当 harness 报告 DELIVERABLE_READY 或已验证 blocker,
或我直接向你提问时,才结束回合。
若你的配置里还有"含糊时提出澄清问题"类规则,为其加上作用域:
"goal 活跃期间,把含糊处记录为 task_state checkpoint blocker,而不是停下来问"。
```

审查闭环:第一子代理(修复链路审计)RESOLVED(F1-F6 全闭合);第二子代理(策略对抗)GAPS(4 项)→ 本节全部修复 → 生产已重启加载(build 3df72a6482f9ff72)。
