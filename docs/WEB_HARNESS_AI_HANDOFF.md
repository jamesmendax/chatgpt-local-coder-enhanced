# ChatGPT Local Coder → Web Harness 项目交接文档

> 用途：交给下一位 AI / Coding Agent，作为继续设计、审计和实现本项目的主说明文档。
>
> 当前项目目录：`D:\chatgpt-local-coder`
>
> 参考项目：`deepseek-ai/deepseek-harness`
>
> 文档原则：**不要把当前仓库里最近快速写入的 Web Harness V2 代码视为已经完成的最终方案。它们只是第一轮架构实验和可行性原型，接手者必须重新审计。**

---

# 1. 项目到底是什么

`ChatGPT Local Coder` 是一个面向 **ChatGPT Web / Developer Mode** 的本地 MCP Harness。

它运行在用户自己的电脑上，通过 MCP + 网络隧道，把 ChatGPT Web 连接到本地机器，使 ChatGPT 可以：

- 读取、搜索、修改本地代码和文件；
- 使用 patch 方式修改源码；
- 运行 shell / build / test / lint；
- 操作 Git；
- 管理后台进程；
- 获取项目上下文；
- 保存长期任务状态；
- 使用 Goal Mode 管理长期目标；
- 对图片、网页、PDF、PPTX、DOCX 等产物做 Visual Review；
- 在 ChatGPT Web 重新连接或 MCP session 变化后继续工作。

项目不是一个独立的 LLM Agent Runtime。

真正的模型推理循环、上下文窗口、模型选择、模型调用、tool-call 决策都仍然由 **ChatGPT Web** 控制。

因此，本项目应该被理解为：

> **ChatGPT Web 的本地执行、上下文、状态、证据与工程控制层。**

而不是：

> “在本地重新做一个 Claude Code / Codex / DeepSeek Agent API Runtime”。

这是后续所有设计的第一原则。

---

# 2. 当前已经比较成熟的能力

下面这些能力在提出“Web Harness”想法之前就已经存在，或者已经经过较多轮使用和测试。接手 AI 不应把它们和最近的实验性 Harness V2 混为一谈。

## 2.1 ChatGPT Web slim tool profile

当前 ChatGPT Web 主要使用 `slim` profile。

核心约束是：

- 对 ChatGPT Web 暴露 **27 个高价值工具**；
- 每类操作尽量只有一条推荐路径；
- 避免向模型暴露几十个重复、相似、低价值 wrapper；
- 控制 `tools/list` schema 大小，减少上下文成本和工具选择混乱。

当前已验证的 slim contract 是：

- 27 tools；
- tools/list 大约 22 KB；
- Goal Mode 已包含在这 27 个工具里。

**注意：仓库文档中 full profile 的工具数量曾出现 65、测试 catalog 又出现 67 statically registered tools 的差异。不要把 full profile 的精确数量当作稳定 contract。真正需要稳定的是 ChatGPT Web 的 slim 27-tool contract。**

## 2.2 Filesystem / patch / search

已有能力包括：

- `read_text_file`
- `write_file`
- `apply_patch`
- `glob`
- `grep`
- `list_directory`
- 二进制读写
- ChatGPT 附件直接保存
- 文件签名 / SHA256 检查

设计方向已经比较明确：

> 探索用 glob/grep/read，源码修改优先 apply_patch，机械文件操作可通过 shell 完成。

## 2.3 Shell / process / command evidence

已有：

- `run_command`
- 持久 cwd
- 完整 command log 文件
- compact stdout/stderr preview
- build/test/lint/format 自动分类
- `start_process`
- `process_status`
- `process_output`
- `stop_process`

也就是说项目已经不只是“能执行命令”，而是开始将执行结果变成可以供 Agent 使用的工程证据。

## 2.4 Git

slim profile 主要保留：

- `git_status`
- `git_diff`

Git mutation 倾向使用确定性的 `run_command`。

这样做是为了避免 Web tool surface 继续膨胀。

## 2.5 MCP Session Recovery

项目已经有自己的 MCP session manager，处理：

- Stateful MCP session；
- session TTL；
- stale session recovery；
- ChatGPT Web 因重新初始化产生的多 session 情况；
- session 数量上限。

这一层非常重要，因为 ChatGPT Web 的连接方式和 CLI coding agent 并不一样。

## 2.6 project_context

`project_context` 已经可以：

- 找到 AGENTS.md / CLAUDE.md / README / config；
- 返回 project map；
- 根据当前 query 选择相关章节；
- 控制返回字节数和 chunk 数；
- 避免每次把整个 README / AGENTS 全部塞给模型。

这是未来 Context Broker 的重要基础，但它当前更偏“静态项目文档检索”，不是完整的运行时上下文系统。

## 2.7 task_state

项目已有 Durable Task / `task_state`：

- task goal；
- current step；
- done；
- decisions；
- blockers；
- next actions；
- checks；
- changed files；
- artifacts；
- recent events；
- last failure；
- task completion gate。

工具调用期间还会自动观察部分高价值操作，把修改文件、测试结果和失败写入 task。

它解决的是：

> “这件工作现在做到哪儿了？”

## 2.8 Goal Mode

Goal Mode 是后来加入的一层长期 outcome 管理：

- objective；
- success criteria；
- constraints；
- current phase；
- active / paused / completed / cancelled；
- Goal completion gate。

Goal 和 task_state 当前的设计意图是：

- Goal = 最终必须做到什么；
- task_state = 实际执行到了哪里。

Goal 未满足时，durable task 不应该进入 `DELIVERABLE_READY`。

## 2.9 Visual Review

已有一个比较完整的 Universal Visual Review 体系，面向：

- image；
- SVG；
- HTML / local web；
- PDF；
- PPTX；
- DOCX。

它不仅看 renderer 是否成功，还区分：

- machine blocking issue；
- model semantic visual assessment；
- source freshness；
- multi-page coverage；
- improvement opportunity；
- 最多 5 轮自主视觉改进。

**这一层已经有自己的成熟逻辑，后续 Web Harness 重构不要顺手重写 Visual Review。**

---

# 3. 当前仓库状态：非常重要

当前 Git working tree **非常 dirty**。

存在大量已修改文件和未跟踪文件，其中混合了多轮真实开发工作，不仅仅是这次 Web Harness 实验。

因此接手 AI 必须遵守：

- 禁止 `git reset --hard`；
- 禁止 `git clean -fd`；
- 不得把整个仓库恢复到 origin/main；
- 不得因为“不知道某文件是谁改的”就直接覆盖；
- 必须先 inspect，再做 focused patch；
- 修改前后都要看 Git status / diff；
- 不要假设所有 untracked 文件都是垃圾。

这不是一个“可以随便重置后重新实现”的干净实验仓库。

---

# 4. 为什么现在想做 Web Harness

当前 MCP 已经解决了“ChatGPT 能不能操作本地电脑”的问题。

真正剩下的问题不再主要是工具数量，而是：

1. ChatGPT Web 在长任务中是否始终知道自己真正要完成什么；
2. 跨聊天、跨 MCP session 后状态是否仍然一致；
3. 一个项目的 task 是否会被另一个项目的操作污染；
4. Agent 是否拿到了足够但不过量的上下文；
5. 测试、运行结果、模型判断、用户确认是否被正确区分；
6. “做过某件事”和“证明某件事完成”是否被混为一谈；
7. 大型任务能否像真正 coding harness 那样逐步推进，而不是每一轮重新理解项目；
8. Harness 是否可以在不控制 ChatGPT model loop 的情况下，尽可能提高 Web Agent 的自主性、连续性和可靠性。

因此我们提出一个新的产品方向：

# **Web Harness**

目标不是增加越来越多 MCP 工具，而是让现有 MCP 从“工具集合”进化为：

> **面向 ChatGPT Web 的持续工程 Harness。**

---

# 5. DeepSeek Harness 为什么值得借鉴

参考仓库：`deepseek-ai/deepseek-harness`

我们不是要复制 DeepSeek Harness。

DeepSeek Harness 和我们的根本区别是：

- DeepSeek Harness 可以拥有自己的模型请求循环；
- 我们不能控制 ChatGPT Web 的模型 loop；
- DeepSeek 可以主动组织模型 request / session / prompt context；
- 我们只能通过 MCP instructions、tools、tool results、外部状态和文件系统影响 ChatGPT Web。

所以正确的方法是：

> **学习它的 Harness 架构思想，然后重新映射到 Web + MCP 约束。**

重点研究 DeepSeek Harness 中以下思想，而不是机械照搬代码：

## 5.1 Session / Event Log

核心问题：

> 一个 Agent session 的“事实”应该保存在哪里？

值得借鉴的方向是：

- append-only event；
- snapshot / projection 是事件事实的派生视图；
- 不让 Goal、task、memory、activity log 各自发展出互相矛盾的真相。

我们未来希望逐步形成：

```text
事实事件流
   ↓
Goal projection
Task projection
Evidence projection
Context projection
History / audit
```

而不是：

```text
goal.json       自己一套真相
task.json       自己一套真相
activity log    自己一套真相
memory          自己一套真相
visual state    自己一套真相
```

## 5.2 Scoped State

DeepSeek Harness 的很多能力都天然属于某个 Agent / Session scope。

我们需要把这个思想映射成：

- workspace scope；
- project/repository scope；
- goal scope；
- task scope；
- visual artifact scope。

尤其要解决当前最现实的问题：

> MCP 可以访问整台机器，但一个 active task 不应该因为 AI 顺手处理了另一个目录，就把另一个项目的文件和测试混入当前 task。

## 5.3 Dynamic Context

真正的 coding harness 不应该只在 session 开始时给模型一大段固定 prompt。

上下文应该随当前任务变化：

- 当前 Goal；
- 当前 phase；
- 当前 task；
- blocker；
- 下一步；
- 最近失败；
- 最近通过的高价值测试；
- 当前 project 的规则；
- 最近 changed files；
- relevant source context；
- 当前 evidence。

DeepSeek 可以在 model request 前组装 context。

我们无法直接控制 ChatGPT Web request，因此 Web Harness 必须寻找替代机制：

- MCP session instructions；
- `project_context`；
- tool structured results；
- compact runtime reminders；
- Goal reminders；
- persistent external state。

这就是 **Context Broker** 的意义。

## 5.4 Capability / Policy / State 分离

不要把以下东西混成一个概念：

- “工具可以做到什么”；
- “Agent 当前应该做什么”；
- “已经发生过什么”；
- “什么被证明完成”；
- “模型认为结果好不好”；
- “用户是否确认”。

未来 Harness 应该明确区分：

- Capability；
- State；
- Policy；
- Evidence；
- Context；
- Completion Gate。

---

# 6. Web Harness 的目标定义

可以把最终目标概括为一句话：

> **在完全不拥有 ChatGPT 模型调用循环的前提下，把我们能够控制的 MCP sidecar 做到尽可能接近成熟 coding-agent harness 的可靠性。**

它至少应该优化四个层面：

## A. Execution

让 Agent 可以可靠地：

- inspect；
- edit；
- build；
- test；
- run；
- Git；
- visual verify；
- produce artifacts。

这一层当前已经相对成熟。

## B. Context

让每一个重要操作都获得“现在真正相关的上下文”，而不是依赖模型自己从整个聊天历史里找。

## C. State

让长期目标、执行状态、事件历史、失败、验证结果跨 chat / MCP session 保持稳定。

## D. Evidence

让 Harness 清楚知道：

- 什么只是 AI 说过；
- 什么是文件系统事实；
- 什么是 compiler/test/runtime 证明；
- 什么是模型语义判断；
- 什么是用户明确确认。

---

# 7. 建议的目标架构

下面是一个建议方向，不要求接手 AI 原样照做，但必须在审计后给出同等级别的架构解释。

```text
                   ChatGPT Web
                       |
                 MCP over tunnel
                       |
              Stable Web Tool Surface
                       |
       +---------------+---------------+
       |               |               |
   Execution        Context         Control
       |               |               |
 files/shell/git   Context Broker   Goal / Task
 browser/visual        |               |
       |               |               |
       +--------- Event / Evidence -----+
                       |
                Append-only Facts
                       |
        +--------------+--------------+
        |              |              |
   Goal projection Task projection Evidence projection
        |              |              |
        +--------------+--------------+
                       |
                Completion Gates
```

关键思想：

- 工具 surface 保持小而稳定；
- 内部 Harness 可以变强，但不要通过不断增加 Web tools 来实现；
- Event/Facts 应逐步成为可信底层；
- Goal/task 等变成 projection；
- Context Broker 面向当前 project/task 动态选择内容；
- completion 必须依赖 evidence，而不是依赖一句“完成了”。

---

# 8. Evidence 模型

建议至少区分四种 evidence：

## deterministic

机械确定的事实，例如：

- 某文件存在；
- SHA256；
- Git status；
- patch 成功；
- structured parser 结果。

## runtime

真实执行得到：

- test；
- build；
- lint；
- process；
- HTTP request；
- browser runtime；
- renderer。

## model_assessed

只能由模型判断的内容：

- UI 是否好看；
- 文案是否符合语义；
- 图片构图是否正确；
- 实现是否符合某个高层意图。

## user_confirmed

用户明确确认：

- “这个版本可以”；
- “这个视觉效果就是我要的”；
- 某个现实业务结果已经发生。

这四种 evidence 的权重和用途不同。

**永远不要因为 `model_assessed=pass` 就把它当成 `runtime test=pass`。**

---

# 9. 当前快速实现的 Web Harness V2 原型

最近一轮已经快速加入了一些代码，但必须视为 **prototype**。

新增/修改的主要文件包括：

- `src/lib/project-scope.ts`
- `src/lib/harness-events.ts`
- `src/lib/context-broker.ts`
- `src/lib/goals.ts`
- `src/lib/durable-tasks.ts`
- `src/server-factory.ts`
- `src/tools/context.ts`
- `scripts/test-harness-v2.mjs`
- `scripts/run-all-tests.mjs`
- `docs/web-harness-v2.md`

目前原型包含：

1. project scope 推断；
2. task 的 `project_roots` / `project_scope_locked`；
3. append-only `harness-events.jsonl`；
4. Goal/task/tool/evidence/context 的 event mirror；
5. Context Broker；
6. `harness_context` 注入 structured MCP result；
7. evidence type；
8. 一个跨 project 隔离测试。

结构测试已经通过：

- TypeScript build；
- harness-v2 focused test；
- Goal Mode；
- durable task；
- context bundle；
- command observation；
- tool profile；
- agent harness。

但：

# **这不等于 Web Harness 已完成。**

当前 Goal 仍然是 active，只有 6/7 criteria 被标记完成。

唯一没有完成的原 Goal criterion 是真实生产 ChatGPT Web E2E。

更重要的是，即使补完 E2E，这一版仍然只能说明：

> “这套原型没有立刻破坏现有系统，并且一些核心概念可以运行。”

它不能证明：

> “这是正确的最终 Harness 架构。”

---

# 10. 接手 AI 必须重新审计的地方

以下内容不能直接信任当前实现：

## 10.1 Event log 目前只是兼容双写

现在 snapshot 仍然是主要读路径，event log 只是 mirror。

也就是说现在并没有真正完成 event sourcing。

接手者需要回答：

- Event schema 是否足够稳定？
- 是否可以 replay？
- 是否需要 event id / causation id / correlation id？
- crash 时 append 是否安全？
- snapshot 和 event 写入顺序产生不一致怎么办？
- 是否需要 migration version？
- 是否需要 compaction / archive？
- 是否应该按 workspace、project、task 进一步分流？

## 10.2 project scope 推断可能过于粗糙

当前有从绝对路径和 repo marker 推断 project root 的原型。

需要重新审计：

- Windows path；
- 路径带空格；
- monorepo；
- nested Git repo；
- workspace 包含多个 project；
- command 没有显式 cwd；
- 一个任务合法跨多个 repo；
- artifact/log 在 CODEX_HOME 但属于某 project；
- URL / remote target 不属于 filesystem root。

project scope 不能简单等同 filesystem authorization。

## 10.3 Context Broker 还很初级

当前 prototype 主要拼：

- Goal summary；
- task summary；
- blockers / next actions；
- recent evidence。

真正需要研究的是：

- 什么信息应该每次注入？
- 什么只在 query relevant 时注入？
- 如何控制 token / schema 开销？
- 是否和 Active Goal reminder 重复？
- tool result 里附加大量 context 会不会反过来污染模型？
- context 是否应该有优先级、TTL、freshness？
- source code context 和 state context 应该怎样组合？

## 10.4 evidence 只有分类，还没有完整证据图

目前只是给部分事件打类型。

还没有真正建立：

```text
criterion
   ↓
requires evidence
   ↓
evidence source
   ↓
freshness / scope / timestamp
   ↓
completion decision
```

尤其 `user_confirmed` 当前更多是类型预留，不代表已经有完整的人类确认写入和 completion policy。

## 10.5 Goal / task / event 关系还未真正统一

现在仍然存在：

- Goal snapshot；
- Task snapshot；
- recent_events in task；
- harness-events；
- activity log；
- auto memory；
- visual review state。

接手者应该先画出完整 state map，再决定哪些合并，哪些必须保持独立。

不要为了“统一”而强行把所有数据都塞进一个 JSONL。

## 10.6 当前 production build 尚未加载这一版原型

最近一次检查时，生产 MCP 仍然是旧 loaded runtime，`stale_build=true`。

所以当前原型没有完成真实 production Web E2E。

**不要在没有用户当前明确授权的情况下自动 restart / stop production MCP。**

同样：

**不要动 tunnel。**

---

# 11. Web Harness 明确不做什么

这是产品边界，不要因为参考 DeepSeek Harness 就越做越偏。

当前方向明确不做：

- 自建 ChatGPT/OpenAI API Agent Runtime；
- LLM provider abstraction；
- 模型路由；
- reasoning effort 调度；
- token-level model loop compaction；
- 自己发起并行 LLM subagents；
- API request scheduler；
- 重造一个完整 Claude Code/Codex CLI。

如果某个 DeepSeek Harness 设计依赖“我们控制每次 LLM request”，就必须重新思考它在 Web MCP 中有没有等价实现。

没有等价实现时，宁可不做，也不要制造一个假的 abstraction。

---

# 12. 推荐给接手 AI 的执行流程

## Phase 0：先审计，禁止立即大改

第一步必须做：

1. 阅读本交接文档；
2. 阅读 `AGENTS.md`；
3. 阅读 `README.md`；
4. 阅读 `docs/web-harness-v2.md`；
5. 查看 Git status；
6. 查看当前 Goal / task_state；
7. 检查当前 production runtime 是否 stale；
8. 阅读最近新增的 Harness V2 文件；
9. 阅读 DeepSeek Harness 对应模块；
10. 画出“当前架构 vs 目标架构”映射。

在完成这一步之前，不要继续堆代码。

## Phase 1：深入阅读 DeepSeek Harness

不要只看 README。

重点追代码路径：

- Session 是怎么创建和恢复的；
- Event 怎么定义、append、读取；
- 当前 session state 如何从 event 得到；
- Prompt context 如何组装；
- capability 如何注入；
- goal / task / agent lifecycle 如何表达；
- state 与 runtime execution 如何分离；
- 哪些模块依赖 model loop，哪些模块不依赖。

然后形成一份：

> **DeepSeek Harness → ChatGPT Web MCP 可迁移矩阵**

每个设计分成：

- 可以直接借鉴；
- 需要重构后借鉴；
- Web 环境下不可实现；
- 没有必要实现。

## Phase 2：重新设计 State Foundation

目标不是马上删除 task_state / Goal。

而是先定义：

- Event schema；
- Scope schema；
- Projection ownership；
- versioning；
- replay；
- crash consistency；
- migration strategy。

然后再决定当前 `harness-events.ts` 是否保留。

## Phase 3：Context Broker V2

Context Broker 应该成为 Web Harness 的核心。

研究怎样根据：

- project；
- Goal；
- task；
- current tool；
- current query；
- recent failures；
- recent evidence；
- changed files；
- repository rules；

生成**最小但足够**的 runtime context。

不要简单地“什么都 append 到每个 tool result”。

## Phase 4：Evidence + Completion

重新定义 completion：

> criterion 完成，不等于某个 boolean 被 AI 写成 true。

应该研究 evidence-backed criteria：

- 哪个 criterion 需要什么 evidence；
- evidence 是否属于正确 project/task；
- evidence 是否已经 stale；
- source 修改后旧测试是否失效；
- user confirmed 是否可以覆盖某类判断；
- model_assessed 能验证什么，不能验证什么。

Visual Review 的 freshness gate 是一个可以参考的现有范例。

## Phase 5：兼容迁移

任何大改都必须保证：

- 27-tool slim surface 不意外膨胀；
- Goal 外部使用方式尽量不破坏；
- task_state 外部使用方式尽量不破坏；
- visual_review 不回归；
- session recovery 不回归；
- file/shell/git 基础能力不回归。

## Phase 6：真实 Web E2E

只有结构测试通过后，才做一次 production Web E2E。

流程建议：

1. 告知用户需要手动 restart MCP；
2. 用户重启；
3. 检查 loaded build 与 current dist 一致；
4. 从真正 ChatGPT Web 调用工具；
5. 验证 Context / State / Evidence 是否真的传到了模型；
6. 做一个跨 project 的小型真实任务；
7. 检查事件和 projection；
8. 通过后立即停止重复验证。

---

# 13. 真正的最终成功标准

Web Harness 最终不是“多了几个 TS 文件”就算完成。

真正的成功应该体现在行为上：

1. **Long-horizon continuity**
   - 换 chat / session 后仍知道目标、当前阶段、blocker 和下一步。

2. **Project isolation**
   - 处理 A repo 时，不会因为另外一个工具调用自动污染到 B repo task。

3. **Context quality**
   - 模型能拿到当前真正需要的信息，同时上下文不会无限膨胀。

4. **Evidence-backed completion**
   - build/test/runtime/model/user confirmation 不会混为一谈。

5. **No false completion**
   - 没有验证过的 criterion 不能仅凭模型语言进入完成状态。

6. **Stable Web contract**
   - ChatGPT Web 不需要面对越来越多工具。

7. **Recovery**
   - MCP restart / stale Web session 不会破坏长期工作事实。

8. **Observability**
   - 可以解释为什么 Harness 认为某任务完成、阻塞、失败或需要继续。

9. **Compatibility**
   - 当前成熟的 filesystem / shell / Git / Goal / task / visual 能力不被架构实验破坏。

10. **Real Web validation**
    - 不只是 unit test；必须证明 ChatGPT Web 实际能利用这些 Harness 能力。

---

# 14. 对接手 AI 的直接任务指令

你不是来“继续完成上一位 AI 写到一半的几份文件”的。

你的任务是：

> **重新从架构层面审计 ChatGPT Local Coder，并把它逐步发展成真正适合 ChatGPT Web 的 Web Harness。**

请把 `deepseek-ai/deepseek-harness` 当作参考架构之一，深入阅读其 Session/Event/Context/Capability 相关代码，判断哪些思想可以迁移到我们的 Web + MCP 环境。

不要把当前 `src/lib/harness-events.ts`、`project-scope.ts`、`context-broker.ts` 视为既定方案。

它们只是上一轮快速验证“这些方向是否能在当前代码里落地”的 prototype。

你可以：

- 保留；
- 重构；
- 拆分；
- 部分回退；
- 用更好的设计替换。

但必须说明原因，并保持已有成熟功能稳定。

第一阶段请先完成：

1. 当前项目完整架构图；
2. 当前所有 state source map；
3. DeepSeek Harness 可迁移架构矩阵；
4. Web Harness 目标架构；
5. 当前 prototype 风险审计；
6. 分阶段迁移计划；
7. 明确哪些代码应该先不动。

**在这 7 项完成以前，不要进行大规模源码重构。**

---

# 15. 操作安全约束

必须遵守：

- 不得 `git reset --hard`；
- 不得 `git clean -fd`；
- 不得覆盖未知来源的真实用户改动；
- 不得自动重启生产 MCP，除非用户在当前请求中明确授权；
- 不得停止或修改 tunnel；
- build 后如果 production stale，只报告并请求用户手动 restart；
- 不要因为工具测试通过就宣称整个 Harness 已经完成；
- blocking verification 一旦通过，不要无意义重复跑相同测试；
- 对“结构测试通过”和“真实 ChatGPT Web 生效”做明确区分。

---

# 16. 当前状态一句话总结

当前 `ChatGPT Local Coder` 已经是一个相当完整的 **ChatGPT Web 本地 coding MCP**，拥有 27-tool slim surface、Goal Mode、durable task、command evidence、session recovery、project context 和 Universal Visual Review。

下一步真正值得做的，不是继续增加工具，而是借鉴 DeepSeek Harness 等成熟 Agent Harness 的架构思想，把项目进一步升级为具有：

> **统一状态事实、项目隔离、动态上下文、证据驱动完成判断和跨 session 连续性**

的 **Web Harness**。

当前已经存在一轮快速 V2 prototype，但它应该被接手 AI 当作“需要审计的实验实现”，而不是完成品。
