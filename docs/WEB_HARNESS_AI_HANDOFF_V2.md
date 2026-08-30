# Web Harness 交接文档 V2(2026-08-30)

> 交接对象:下一位 AI / Coding Agent。本文取代 `WEB_HARNESS_AI_HANDOFF.md` 成为**当前**主交接文档;旧文档保留作为历史脉络。
>
> 阅读顺序:本文 → `docs/web-harness-phase0-audit.md`(Phase 0 审计)→ `docs/web-harness-dsh-plan.md`(优化计划书)→ `docs/web-harness-v2.md`(架构边界)。
>
> **当前状态一句话**:计划书阶段 1-5(事件层 v2、防循环 guard、Context Broker V2、Goal/Task 加固、projection 对账)全部实施并三轮全量测试通过;经两轮独立审查(计划一致性 PASS + 对抗找 bug)并修复全部 P1/P2;生产 MCP 仍是旧 build,等用户手动重启后做唯一一次真实 ChatGPT Web E2E(新 Goal `d0b797af` 的 criterion 7),通过后 goal + task 正式 complete。

---

## 1. 项目与硬边界

`D:\chatgpt-local-coder` 是面向 **ChatGPT Web(Developer Mode)** 的本地 MCP Harness:ChatGPT 拥有模型循环,我们拥有执行、状态、上下文与证据层。永久边界(不因任何参考项目改变):

- **27-tool slim 契约不破坏**(slim 集合见 `src/lib/tool-profile.ts`,tools/list ≈22KB);
- **不做** model loop / LLM provider / subagent / 模型路由 / API runtime;
- 对外 schema **只加不改**;新增能力走 structured data、server-factory 拦截链、Admin UI(:3001),**不加新 MCP 工具**;
- 安全约束:`git reset --hard` / `git clean -fd` 禁止;生产 MCP 只能由**用户**手动重启(建议 `restart-mcp.cmd`);不碰 tunnel;dirty 工作树是真实工作,改前改后看 `git status`。

运维事实:双账号(Free :8080 / Business :8081)共享同一个 3000 MCP;`~/.codex` 是指向 `CODEX_HOME=D:\AI\codex\home` 的 junction;MCP 的 `WORKSPACE_PATH=D:\web-local`(注意:不是本仓库目录)。

## 2. 状态与磁盘布局(接手第一件事是搞清这个)

全部持久状态在 `D:\AI\codex\home\projects\173c39c02962\`(slug = SHA256(`D:\web-local`) 前 12 位):

| 文件 | 说明 |
|---|---|
| `goal.json` | 单一 Goal 快照。**含 `revision` 字段**,每次变更 +1;`requires_confirmation` 的 criterion 只能经 confirm 置 passed |
| `tasks/<uuid>.json` | Durable task 快照(version 2,含 `project_roots`/`project_scope_locked`/`blocked{code,message,since}`) |
| `tasks/active-task.json` | 活跃任务指针,`updated_at` 是 24h TTL 心跳,过期自动清除并回退到最近活跃任务 |
| `harness-events.jsonl` | **v2 事件日志**:首行 header `{"kind":"harness-log","version":2,...}`,此后每行一个事件,seq 从 0 连续;损坏尾自动截断修复、中段损伤隔离为 `.corrupt-<ts>`、legacy v1 自动迁移、写失败计数可在 `agent_status` 的 `event_log` 段看到 |
| `MEMORY.md` / `visual-reviews/` / `command-logs/` | 自动记忆 / 视觉审查状态 / 命令完整输出(SpillRef locator) |

仓库内:`.mcp-audit.log`、`.mcp-checkpoints/`(rewind)。**生产旧 build 在重启前不写事件文件**;重启后一切写入都是 v2。

## 3. 本次完成的内容(阶段 1-5 + 审核修复)

| 阶段 | 内容 | 关键文件 |
|---|---|---|
| 1 事件层 v2 | header + 版本双向拒载、未知键/类型拒载、seq 连续断言、torn-tail 修复(任意时刻,含 init 后)、legacy 迁移、写失败可观测、观察事件瘦身(≤1.2KB,实测最大 544B)、移除每观察全量 task/change | `src/lib/harness-events.ts`(重写) |
| 2 guard + spill | repeat-tool-reminder 移植(阈值 3/5/8、失败也计数、状态工具排除、大参数 sha256 稳定键)、SpillRef{locator,bytes,retrieval_hint}、产物 SHA256 引用化 | `repeat-guard.ts`、`spill.ts`(新),`server-factory.ts`、`tools/shell.ts`、`durable-tasks.ts` |
| 3 Context Broker V2 | 快照全文去重(变化即注入 + 5 分钟刷新心跳)、supersede 头行、CLEARED 迁移语义、预算级联 + 省略披露、新 session 重置保持(`resetHarnessSnapshotRetention`)、2s 状态缓存 + `state-invalidate` 失效通知、`readHarnessEventTail` 增量尾读(open+offset,不全文件加载)、goal 三重注入去重(移除每调用 ACTIVE GOAL 文本) | `context-broker.ts`(重写)、`state-invalidate.ts`(新) |
| 4 Goal/Task 加固 | `revision` CAS(`GOAL_STALE_REVISION` 可自愈)、goal 变更工作区锁(并发丢更新防护)、`requires_confirmation` criterion + `goal action=confirm`(写 user_confirmed 证据)、task `blocked{code,message,since}`(lower-kebab,`task_state` 已暴露)、goal/task 完成出口 grounding 注记 | `goals.ts`、`durable-tasks.ts`、`tools/goal.ts`、`tools/tasks.ts` |
| 5 projection | `ProjectionDefinition{key,init,apply,stateVersion}` 契约(同引用返回、whole-value)+ 30 goal/26 task 随机操作 `replay===snapshot` 对账 | `projection.ts`(新)、`scripts/test-projection-replay.mjs` |

内部审核 + 两轮独立审查共产出 **12 项修复**,重点:新 session 重置快照保持(否则新聊天 5 分钟内看不到 goal)、观察热路径不打穿 Broker 缓存(TTL 心跳保留)、预算最底层不再把未满足标准渲染成 "Remaining: none"(诱导虚假完成)、中段损伤隔离而非截断、goal 变更加锁、超 60KB task/change 降级摘要、证据窗口随修复代数重置、指针过期删除加防护。测试:`scripts/test-harness-v2.mjs`(主集成)、`test-repeat-guard.mjs`、`test-projection-replay.mjs`,全部注册于 `scripts/run-all-tests.mjs`;`npm run build && npm run test:all` 为验收命令。

## 4. 计划 vs 实施偏差(用户已裁决:计划书是参考,不是合同)

| 偏差 | 理由 / 处置 |
|---|---|
| 计划的"blocked 连续门槛"未实现 | DSH 的机械门槛依赖轮次归因(我们有不了);诚实的等价物需要重新设计,**延后到 E2E 之后**,见 §6 |
| `blockers:string[]` 未改写为对象数组,而是增量加 `task.blocked` | 遵守"对外 schema 只加不改";version 保持 2 |
| guard 的"用户插话重置"不可实现 | MCP 观察不到用户轮次;重置语义 = 任何不同调用 |
| projection 契约省略 `view` 成员;预算级联第三档与计划文字不同 | 实现时的简化/更优选择 |
| `blocked_reason` 原本只到库层 | 审查后已补齐:`task_state` schema 已暴露,模型可用 |

## 5. 拦截链(理解本项目的钥匙)

`server-factory.ts` 的 `configureToolRegistration` 是唯一拦截点,每个本地工具回调被包为:

```text
tool 回调
  → recordToolObservation()            跨项目过滤 + task 观察 + 事件镜像(tool/observation、evidence/recorded)
  → appendHarnessRuntimeContextToResult()  Broker:快照去重后注入 HARNESS CONTEXT 文本 + data.harness_context
  → appendRepeatGuardReminderToResult()    防循环提醒(达到阈值时追加文本)
  → 错误路径:观察失败 + guard 计数
```

状态失效链:`goals.ts`/`durable-tasks.ts` 的每次变更 → `notifyStateInvalidated` → Broker 立即丢缓存。观察(非渲染字段)不失效——这是契约,不是遗漏。

## 6. 已知限制与后续路线

1. **criterion 7:真实 Web E2E(当前唯一阻塞)**——用户重启 → `/health` 确认 `build_id` 变化 + `stale_build:false` → 新聊天验证 `agent_status.event_log`、一次写入 + 一次命令的 `harness_context` 注入 → 通过后 goal `action=complete` + task complete,**然后停止,不重复验证**。
2. **observation 字段折叠**:projection 目前只对账显式状态操作;`tool/observation` 驱动的 `changed_files/observed_checks/recent_events` 折叠是切事件读路径的前置(见 `projection.ts` 注释)。
3. **blocked 门槛**:需要先设计"无循环所有权下的归因"再实现。
4. **旧 build 共存窗口**:重启前旧 build 写的 goal.json 无 revision(新代码默认 1,CAS 基线重置一次);重启即消除,无需处理。
5. 日志无轮转:单日 ~105KB,观察类事件已瘦身,暂不需要;若未来膨胀再做 rotation + 索引。

## 7. 给下一个 AI 的第一步

1. 读本文 + Phase 0 审计 + 计划书(顺序见顶部);
2. `git status` + `git log -1` 确认现场;`GET http://127.0.0.1:3000/health` 看 `stale_build`;
3. 检查 Goal/task 状态(`D:\AI\codex\home\projects\173c39c02962\goal.json`)——如果 criterion 7 已过、goal 已 completed,直接从 §6.2 的后续路线接;如果还没重启,推动用户完成 E2E;
4. 任何改动:先 inspect 再 focused patch,`npm run build && npm run test:all` 全绿才算完成,blocking verification 通过后不重复跑。
