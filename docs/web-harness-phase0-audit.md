# Web Harness Phase 0 审计报告

> 接手 AI 按交接文档 `WEB_HARNESS_AI_HANDOFF.md` §12 Phase 0 / §14 完成的审计。
> 审计日期:2026-08-29。审计方式:只读检查 + 现有测试结果复核,未做任何源码修改。
>
> 结论先行:**交接文档的判断全部成立**。V2 原型方向正确、结构测试通过,但生产加载的 build 早于当前 dist,V2 未在真实 ChatGPT Web 上生效;事件镜像在生产从未落盘成功过。建议先做一次用户授权的重启 + E2E,再做本报告列出的 P1 修复,然后才进入 event-sourcing 渐进迁移。**不需要推倒重写。**

---

## 0. 运行时事实(审计时实测)

| 项 | 值 |
|---|---|
| 生产 MCP | 运行中,PID 56004,`http://127.0.0.1:3000/health` OK |
| Tool profile | slim,`tool_count: 27` ✅(契约未破坏) |
| `stale_build` | **true** — loaded mtime `2026-08-29T14:27:18Z` < current dist mtime `15:18:33Z` |
| 服务器启动时间 | `2026-08-29T14:44:24Z`(晚于 loaded build,早于当前 dist) |
| Goal 状态 | **paused**,6/7 criteria passed(唯一未过:真实 Web E2E) |
| Active task | `5278b242`(active),等待"用户手动重启生产 MCP → 一次真实 Web E2E" |
| `harness-events.jsonl` | 审计开始时**整个 `D:\AI\codex\home` 下不存在**;审计中用当前 dist 代码手动执行一次 task checkpoint 后成功落盘(seq 0,单条 `task/change` 即 10,127 字节,因内嵌全量 task snapshot) |
| CODEX_HOME | `D:\AI\codex\home`(`C:\Users\<user>\.codex` 是指向它的 junction) |
| 项目状态目录 | `D:\AI\codex\home\projects\173c39c02962\`(slug = SHA256(`D:\web-local`) 前 12 位;WORKSPACE_PATH 是 `D:\web-local`,不是本仓库) |
| dist 与 src | dist(23:18 build)与当前 src 一致,含 V2 接线(goals/durable-tasks/server-factory 均引用 harness-events / context-broker) |

**时间线(本地时间)**:22:27 tsc build → 22:44 服务器启动(加载的就是这份 build,不含/未触发 V2 事件层)→ 23:11 前任 AI 经生产服务器创建 Goal + task → 23:18 重新 build(V2 完整版)→ 23:32 Goal 置 paused → 写交接文档离场。

由时间线 + 生产无 `harness-events.jsonl` 推断:**加载中的 build 不含 V2 事件层**。此推断已在审计中用对照实验证实(当前 dist 独立进程写事件成功,见 §0 表格与 §5-P0-1):根因是 stale build,不是事件层代码缺陷。重启后用 `agent_status`/health 的 `build_id` 与一次工具调用即可最终确认。

---

## 1. 当前项目完整架构图

```text
ChatGPT Web (Free :8080 / Business :8081 两条 OpenAI tunnel,共享同一个 MCP)
        │  MCP over HTTPS tunnel
        ▼
express :3000  src/index.ts
  ├─ /health          → runtime-manifest(build_id / tool_count / stale_build)
  ├─ /mcp(/<token>)   → mcp-session-manager(TTL / stale 恢复 / 多 session / 404-not-401 策略)
  └─ admin :3001/ui   → upstream MCP 导入、instructions 预览
        ▼
McpServer (server-factory.ts)
  ├─ instructions = buildInstructionContext(启动时一次性快照):
  │     CODEX_AGENT_PROMPT + Tool profile + ACTIVE GOAL + env + git snapshot
  │     + auto-memory(MEMORY.md)+ project memory(AGENTS/CLAUDE/README, slim 截断 8KB)+ skills(full only)
  ├─ 27 slim tools / 67 catalog(full):filesystem · shell/process · git · context ·
  │     visual(render/capture/visual_review) · goal · task_state · rewind · node_repl · browser · mcp bridge
  └─ 每个本地 tool 的回调被 configureToolRegistration 包一层:
        recordToolObservation()                      ← 跨项目过滤后写 task 观察 + 事件镜像
        appendHarnessRuntimeContextToResult()        ← Context Broker(harness_context)
        appendActiveGoalContextToResult()            ← ACTIVE GOAL reminder 文本
        ▼
状态层(CODEX_HOME=D:\AI\codex\home\projects\<slug(workspace)>)
  goal.json · tasks/*.json + active-task.json · (设计上)harness-events.jsonl
  MEMORY.md · visual-reviews/ · command-logs/
仓库内:.mcp-audit.log · .mcp-checkpoints(rewind)· profiles/(upstream/connector 配置)
```

关键观察:

- **V2 的接入点是 `server-factory.ts` 里的一条 wrapper 链**,不是分散补丁——这个设计是对的,后续重构应保持"单一拦截点"。
- Context 有三个入口,彼此有重叠:① 启动 instructions(含 ACTIVE GOAL);② 每结果 `harness_context`(structured);③ 每结果 ACTIVE GOAL reminder 文本。`goal`/`task_state`/`project_context` 等自带状态的 tool 会跳过 ③,但 ①+②+③ 的重复问题在普通 tool 上存在。
- MCP instructions 是**进程启动时的快照**:Goal 中途创建/变更不会反映到已连接 session 的 instructions,只能靠 ②③ 补——这是 Web 约束下必须接受的,但要在设计上明确"instructions 是冷数据,tool result 才是热通道"。

## 2. 当前所有 state source map

| # | 状态源 | 位置 | 写入者 | 真相级别 | 与事件流关系 |
|---|---|---|---|---|---|
| 1 | Goal snapshot | `<state>/goal.json`(原子写) | `goal` tool | **主真相**(当前读路径) | 双写 `goal/change`(全量内嵌) |
| 2 | Durable task snapshot | `<state>/tasks/<uuid>.json` | `task_state` tool + 自动观察 | **主真相** | 双写 `task/change`(全量内嵌,每 observation 一次) |
| 3 | Active task 指针 | `tasks/active-task.json`,TTL 默认 24h | durable-tasks | 派生(可重建) | 未镜像 |
| 4 | Harness event log | `<state>/harness-events.jsonl` | goals/durable-tasks/context tools | 设计中的未来事实源 | ——(生产中不存在) |
| 5 | Auto memory | `<state>/MEMORY.md` | `remember` tool | 独立真相 | 未镜像 |
| 6 | Visual review state | `<state>/visual-reviews/` | `visual_review` tool | 独立真相(有 freshness gate) | 仅 task.visual_review 摘要镜像 |
| 7 | Command full output | `<state>/command-logs/` | persistent-shell | 证据附件 | 事件里只存 preview/key_lines |
| 8 | Activity/audit log | `.mcp-audit.log`(仓库内) | audit() | 审计旁路 | 不入事件流 |
| 9 | Checkpoints(rewind) | `.mcp-checkpoints/` | checkpoint.ts | 独立能力 | 不入事件流 |
| 10 | Project memory | workspace 内 AGENTS/CLAUDE/README | 用户/agent 编辑 | 外部真相 | 不入事件流 |
| 11 | Path rules / skills | workspace + `skills/` | 用户 | 外部真相 | 不入事件流 |
| 12 | Instructions 快照 | 进程内存 | 启动时构建 | **派生+会 stale** | 不入事件流 |
| 13 | Upstream MCP | `profiles/mcp-upstream.json` | admin UI | 配置 | 不入事件流 |

结论:符合交接文档 §10.5 判断——**snapshot 是主真相,事件只是单向 mirror**;mirror 覆盖了 1/2/6(摘要),完全没有覆盖 3/5/7/8/9。当前不存在"两个真相打架"的实际故障,但存在"mirror 静默丢失"(见 §5-P0)。

## 3. DeepSeek Harness 可迁移架构矩阵

参考仓库本地 clone:`C:\Users\<user>\dsh-harness`(→ `D:\AI\dsh`)。已通读其 session/event/persistence/system-prompt/goal/tools/scope 模块。核心机制摘要:

- Session = append-only event log(`SessionEvent{type,seq,time,data}`,seq 连续,`seq = log.length`);插件通过 declaration merging 贡献事件类型(goal/change、plan/mode、compaction/*、approval/*)。
- **状态 = replay,不是 snapshot**:`deriveMessages()` 折叠 surface 节点;projection 定义为 `{init, apply, view}` 纯函数,带 watermark 缓存。
- 磁盘格式:`~/.dsh/sessions/<cwd-encoded>/<id>/session.jsonl.zstd`,首帧 header(`version/id/cwd/createdAt`),格式版本不符直接拒载、不静默迁移;crash 时 torn tail 丢弃 + 给未闭合 turn 补合成 `turn/end{interrupted}`,**永不 truncate**。
- 不变量:"model-visible means logged"——每次 LLM 请求必须等于 log 派生历史 + 折叠 header(assert 强制)。
- Goal:`goal/change` 全量快照事件 + `GoalRef{id,revision}` CAS 更新;complete 需要精确 revision;blocked 需连续 3 轮才被机械接受。
- system-prompt 是注册表(section/context/variable,scoped shadow);动态上下文物化为保留历史之后的 `user/message` 事件(仅变化时追加)。

### 矩阵

| DeepSeek 设计 | 档位 | Web MCP 迁移方式 |
|---|---|---|
| append-only event envelope `{type,seq,time,data}` + seq 连续 | **A 直接借鉴** | 现有 `harness-events.ts` 已具备;需补 per-event id/causation/correlation 与 schema_version 拒载 |
| projection = `{init,apply,view}` 纯函数 + replay | **A 直接借鉴** | Phase C:goal/task projection 从事件 replay 构建,与 snapshot 对账测试通过后才切读路径 |
| 格式版本 header + 版本不符拒载(不静默迁移) | **A 直接借鉴** | event log 首行写 header(version, workspace, created_at);reader 遇到不认识的 version 必须 fail-loud |
| crash 策略:torn tail 丢弃 + 合成闭合事件,不 truncate | **A 直接借鉴** | reader 对最后一行 JSON.parse 失败 → 丢弃该行并告警(当前实现是静默跳过全部,半对) |
| `GoalRef{id,revision}` CAS | **A 直接借鉴** | `goal`/`task_state` 更新加可选 `expected_revision`,防跨 session 竞态覆盖 |
| goal blocked 语义(`blockedReason{code,message}` + 机械拒绝) | **A 直接借鉴** | `blockers: string[]` → 结构化对象;与 evidence gate 呼应 |
| SurfaceIntent / "model-visible means logged" 不变量 | **A 直接借鉴(重述)** | Web 版不变量:**"返回给 ChatGPT 的 harness_context 必须与已落盘事件一致"**——注入前先确认事件写成功,而不是写失败照样注入 |
| surface `replace` + compaction(历史重写,raw log 不动) | **B 重构后借鉴** | 无对话历史控制权;可对 `task.recent_events`/`evidence` 做 cap+归档,raw 事件保留 |
| system-prompt 注册表(per-request assemble) | **B 重构后借鉴** | 无 per-request 钩子;等价物 = 启动 instructions(冷)+ Context Broker(热);Broker 需要 relevance/TTL/token budget(见 §5-P1) |
| runtime-context 物化为 `user/message` 事件 | **C Web 不可实现** | 无法向 ChatGPT 注入消息;只能靠 tool result 附加(已做) |
| goal-round-driver(空闲自动续轮) | **C Web 不可实现** | 无 agent loop 钩子;等价物就是现有 goal reminder 文本 |
| approval/* 事件 | **C Web 不可实现** | 审批发生在 ChatGPT 侧;`user_confirmed` 需要靠显式 tool 语义(action=confirm)采集 |
| LLM adapter / retry / routing / subagent / fork / sandbox | **C/D 不做** | 产品边界(交接文档 §11),维持 |

总体判断:DeepSeek 真正值得抄的是**事件层的工程纪律**(版本 header、torn-tail 策略、replay 对账、CAS),而不是它的功能面。这与交接文档 §5 的方向一致。

## 4. Web Harness 目标架构(审计后确认版)

维持交接文档 §7 架构,落到本仓库的具体演进:

```text
Stable 27-tool surface(不动)
   │
   ├─ Execution(不动):filesystem / shell / git / visual / rewind
   │
   ├─ 单一 wrapper 拦截点(server-factory,保持):
   │     observation → evidence → event append(成功才注入)→ context 注入
   │
   ├─ Event/Facts 层(演进核心):harness-events.jsonl
   │     v2:header 行 + id/causation/correlation + version 拒载 + torn-tail 容错
   │     瘦身:task/change 只记 diff,不嵌全量 snapshot
   │
   ├─ Projection 层(Phase C):goal/task projection = replay(事件)
   │     与 snapshot 对账;对账稳定后才允许读路径切换(feature flag)
   │
   ├─ Context Broker(Phase D):相关性/新鲜度/token 预算;
   │     与 ACTIVE GOAL reminder 去重;冷数据(instructions)与热数据(result)分工
   │
   └─ Evidence/Completion(Phase C+):
         criterion → requires evidence(kind + freshness + scope)
         user_confirmed 获得显式写入路径;model_assessed 永不冒充 runtime
```

与交接文档 §7 的唯一差异:明确 **completion gate 已经存在三道**(blocking_checks、goal gate、visual freshness gate),Phase C 的工作是给 criterion 补 evidence 依赖声明,不是新建一套 gate。

## 5. 当前 prototype 风险审计

按严重度排序。P0 = 阻塞 E2E / 事实丢失;P1 = 会产生错误行为;P2 = 质量债。

**P0-1 事件层在生产从未生效;根因已定位为 stale build。** 审计开始时生产上 Goal/task 操作都发生了,事件文件却不存在;审计中用**当前 dist 代码**(独立 node 进程,同 CODEX_HOME)执行一次 task checkpoint,`harness-events.jsonl` 立即成功落盘——证明事件层代码本身可用,**根因是生产加载的 22:27 build 早于 V2 接线**,重启后预期事件即可流动。遗留的设计风险不变:`appendHarnessEventSafe` 吞掉一切异常且零可观测,若未来因权限/路径问题静默丢事件无人知晓。兼容双写阶段允许 fail-soft,但**必须可观测**:失败要计数并暴露到 `agent_status`/health,否则切读路径时会带着"事件是全的"错觉上线。

**P0-2 生产 stale,V2 从未经过真实 Web 验证。** 需用户手动重启;重启后第一步核对 `build_id` 变化 + `stale_build:false`,然后做唯一一次 E2E(见 §6 Phase A)。

**P1-1 事件层并发与 seq 一致性。** `appendChains`/`lastSeqCache` 是 per-process 内存态:多进程并发(重启窗口新旧进程并存、测试并行、未来多 workspace 共进程)时 seq 会冲突;`readLastSeq` 只看最后一行,若最后一行是 torn write(JSON 解析失败)会回退 `lines.length-1`,可能产生重复 seq。`fs.appendFile` 无 fsync。单进程当前够用,但 replay 前提是 seq 可信——Phase C 前必须修。

**P1-2 事件体积失控。** `goal/change`、`task/change` 的 `data` 内嵌完整 snapshot;`recordTaskChange` 在**每次 tool observation** 后都追加一条全量 task JSON(数 KB)。千次调用量级即数 MB,`readHarnessEvents` 又是全文件读入。Context Broker 的 `readHarnessEvents(limit:8)` 因此是 O(文件大小) 而不是 O(8)。需要:diff-only 事件 + 读侧索引或按 task 分文件。

**P1-3 Context Broker 每 tool call 的 I/O 放大与三重注入。** 每次 tool call:`buildHarnessRuntimeContext` 读 goal.json + active-task.json + task.json + 事件文件,`activeGoalReminder` 再读一次 goal.json;且 goal 信息同时出现在 instructions(冷)、`harness_context`(热)、ACTIVE GOAL reminder(热)三处。需要:短 TTL 缓存 + 去重(goal 只在 reminder 或 harness_context 一处出现)+ 失败时零成本降级。

**P1-4 Windows 路径大小写比较不一致(真实 bug 候选)。** `project-scope.ts` 的 `pathKey()` 做了大小写归一,但 `isPathWithinRoot()` 直接用 `path.relative`——Node 在 win32 上对大小写不同的路径会得出错误 relative 结果。`scopesOverlap`/跨项目过滤都建立在它上面;工具参数里的路径大小写与 project_roots 不一致时,**跨项目污染过滤会失效**(应滤的没滤)。现有测试恰好全程同大小写,未暴露。修法:`isPathWithinRoot` 在 win32 上对两侧做 `toLowerCase` 后再 `relative`。

**P1-5 project scope 推断启发式的既知盲区**(交接文档 §10.2 全部成立,实测确认):中文标点/空格路径的截断规则是手写正则;`detectProjectRoot` 向上扫 marker,在"workspace 自身是 repo"的场景会把 `D:\web-local` 本身当 project root;双 repo 任务 roots 最多 8 个但重叠语义未定义;monorepo/nested git 无特殊处理;CODEX_HOME 下的 artifact 不属于任何 project root(被过滤——行为合理但意味着 evidence 不含 artifact 路径)。这些是**可接受的 v1 简化**,但要在 `project_scope_locked` 的语义文档里写明"观察边界,非安全边界"(docs 已写,代码注释缺)。

**P2 汇总**(不逐条展开,列出待办):
- `user_confirmed` 只有类型定义,没有任何写入路径;criterion→evidence 依赖图不存在(§10.4 成立)。
- `evidence/recorded` 只在 observed check 或 model_assessed 时写;普通 runtime 命令只有 `tool/observation`,"runtime 证据"覆盖不全。
- 观察字段提取(`extractPaths`/`extractScopePaths`)依赖固定 key 名清单,tool schema 演进会静默漏记。
- `observedCheck` 把 stdout 尾行直接塞进 check detail,可能含无关噪音。
- `remember` 等 skip-text 工具仍会被注入 `data.harness_context`(结构化路径没跳),轻微噪音。
- active-task TTL 过期删指针但 task 文件仍标 active——`resolveDurableTask` 能兜底,但"active"语义有二义性,文档应写明。
- 事件无 id/causation/correlation;reader 不校验 `version:1`(写了但没人读)。
- snapshot 先写、事件后写,两步之间 crash 会留下"snapshot 有、事件无"的中间态——兼容期可接受,Phase C 必须定义对账规则。

## 6. 分阶段迁移计划

**Phase A — 重启 + 真实 E2E(阻塞中,需要用户授权重启生产 MCP)**
1. 用户手动重启(两个账号隧道在场时建议用现有 `restart-mcp.cmd`/一键脚本,不要手动杀进程)。
2. `/health` 确认 `build_id` 变化、`stale_build:false`。
3. 真实 ChatGPT Web 新聊天做一次小任务:普通 tool 调用看 `data.harness_context`;`project_context(query)` 看 bundle;执行一次会触发观察的写入,然后检查 `harness-events.jsonl` **是否真的出现**(P0-1 的最终裁决)。
4. 通过 → goal criterion 7 置 passed → `goal action=complete` + task complete。**到此停止验证,不重复跑。**

**Phase B — 小修(不动架构,1~2 轮改动)**
- B1 事件失败可观测:失败计数 + `agent_status` 暴露;`readLastSeq` 对 torn tail 重扫 + 告警。
- B2 `isPathWithinRoot` Windows 大小写归一(§5-P1-4)+ 补一个大小写不一致的回归测试。
- B3 事件瘦身:`task/change` 改 diff-only(raw snapshot 仍是主真相)。
- B4 Broker 降载:2s TTL 缓存 + goal 三重注入去重。
- 验证:`npm test` + `npm run test:all` 一轮即止。

**Phase C — 事件层成为事实源**
- C1 Event v2:header 行、id/causation、version 拒载;torn-tail 策略;多进程安全(seq 起始重扫)。
- C2 projection replay(`{init,apply,view}`)与 snapshot 对账测试;对账稳定后 feature-flag 切读路径。
- C3 evidence graph:criterion → requires evidence(kind/freshness/scope);`user_confirmed` 显式写入 tool 语义。

**Phase D — Context Broker V2**:relevance 选择、TTL/freshness、token 预算、query 感知;与 `project_context` 深度整合(冷热分工)。

每阶段边界都遵守交接文档 §15:不 reset、不 clean、不自动重启、不过度验证。

## 7. 先不动的代码(保护清单)

| 不动 | 原因 |
|---|---|
| `visual-harness.ts` / `visual-review-state.ts` / `tools/visual*` | 成熟体系,自带 freshness gate;交接文档明确要求不顺手重写 |
| `mcp-session-manager.ts` | 已验证的 Web 恢复语义(404-not-401、stale recover) |
| `tool-profile.ts` 的 27-tool slim 集合与 catalog | 外部契约;已验证 tools/list ≈22KB |
| `tools/filesystem|shell|git.ts` 的对外 schema | 成熟能力;观察层依赖其字段 |
| `persistent-shell.ts` / `command-observation.ts` | task 观察与 evidence 的地基 |
| `checkpoint.ts` / rewind | 独立能力,与事件层无关 |
| `goals.ts` / `durable-tasks.ts` 的**对外 schema** | 只加不改(DurableTask 已是 version 2 + project_roots) |
| start/stop/tunnel/一键脚本 | EXPERIENCE.md 记录的部署体系,生产双账号在用 |
| dirty git tree 中来历不明的修改 | 一律 inspect 后 focused patch,禁止覆盖 |

**可以动**:`harness-events.ts`、`context-broker.ts`、`project-scope.ts`、`server-factory.ts` 的 wrapper 链(保持单一拦截点)、`tools/context.ts` 的 bundle 接线——即 V2 原型自身的五个文件。

---

## 附:本次审计的证据命令(供复核)

- `GET http://127.0.0.1:3000/health` → stale_build:true,tool_count:27
- `find D:/AI/codex/home -name harness-events.jsonl` → 空
- `D:/AI/codex/home/projects/173c39c02962/goal.json` → paused,6/7,phase="等待其他 AI 先审计…"
- `tasks/5278b242….json` → active,4/5 blocking passed,等重启
- dist mtime 23:18 vs loaded 22:27;`grep harness-events dist/lib/goals.js` > 0(当前 dist 含 V2)
- DeepSeek 矩阵依据:`C:\Users\<user>\dsh-harness` 的 session/persistence/system-prompt/goal/tools 模块阅读报告(子代理产出,已在 §3 浓缩)
