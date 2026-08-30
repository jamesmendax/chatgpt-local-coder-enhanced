# Web Harness × DeepSeek Harness 精读报告与优化计划书

> 依据:deepseek-ai/deepseek-harness 上游原仓库(GitHub HEAD `cd5ef814`,tag `dsh-0.1.2-alpha.1`,2026-08-28,合并自 PR #3248)。本仓库本地 clone(`C:\Users\<user>\dsh-harness`)停留在 8-13 的 `47f94385`,落后上游 **1933 个提交**,因此本次全部精读以临时克隆的上游代码为准(`/tmp/dsh-upstream`)。
>
> 方法:四个子系统并行深读(事件与持久化、上下文装配与压缩、Goal 与工具与权限、外部控制面与周边),全部读真实 TypeScript 源码并带 file:line 证据,再逐域对照本仓库(`chatgpt-local-coder`)Phase 0 审计结论(`docs/web-harness-phase0-audit.md`)给出借鉴决策与实施计划。
>
> 本文是"计划书",不是"实施记录"。所有阶段的落地仍受交接文档与审计报告的安全约束:不 `git reset --hard`、不自动重启生产 MCP、27-tool slim 外部契约不得破坏、成熟模块(Visual Review、session manager、文件/shell/git surface)不顺手重写。

---

## 1. 执行摘要

把上游 DSH(dsh-0.1.2-alpha.1)读穿之后,一个此前只存在于猜测层面的事实现在有了代码级证据:**DSH 的全部可靠性来自"事件日志 + 派生状态 + 机械校验"这一层,而这一层与"谁拥有模型循环"基本无关**。DSH 自己的文档和代码都表明,session log、persistence、projection、goal 的持久语义、工具管线的输出校验、guard 的防循环提醒,全部是纯状态/协议层;唯一死死绑住模型循环的只有 agent-loop 的 turn/step 驱动、pre-step 拦截和"请求必须等于日志重放"这条不变量。这正好印证了我们在 Phase 0 审计里的判断:值得抄的是事件层的工程纪律,而不是功能面。

对我们就绪度最高的六个借鉴点,按价值排序:

1. **写侧校验 + 读侧 fail-closed 的事件信封纪律**(固定键集、seq 连续不变量、版本拒载、未知事件类型拒读)——直接修掉我们 P1 的 seq 一致性风险和 P2 的"version 字段没人读"问题。
2. **RuntimeContextProjection 的"快照去重 + 更替语义"**——这是 Context Broker 从"每条工具结果都附加上下文"进化为"只在变化时注入一次快照"的现成蓝图,一并解决我们的 Broker I/O 放大与三重注入问题。
3. **repeat-tool-reminder 的防循环 guard**——DSH 用约 230 行代码解决"模型用相同参数反复调同一工具"的顽疾,机制完全可移植到我们的 server-factory 拦截链,是我们目前完全缺失的能力。
4. **GoalRef{id, revision} CAS 与 goal/change 严格折叠**——让"模型拿着过期的 goal 状态做决定"在机械上不可能,是 anti-false-completion 的地基,直接补强我们的 Goal 层。
5. **compaction-tool-result-pruner 的"头尾保留 + 影子计价"输出裁剪**——我们已有 command-logs 落盘 + compact preview,DSH 的 head/tail 分割与 marker 规范可以直接吸收;spill 的 locator + retrievalHint 语义是同一主题的完整版。
6. **崩溃恢复的合成闭合事件**(给未完成的工具调用补"结果未知,仅在只读/幂等时重试"的合成结果)——对我们 MCP restart 场景下的 active task 一致性有直接价值。

同时,有四类东西被明确判定为不可移植或不必要(模型循环钩子、surface replace 压缩、Cordis 插件框架、SQLite/zstd 重装化),详见第 4 节矩阵与第 7 节边界。

实施安排上,本计划把审计报告的 Phase A–D 细化为六个可独立验收的工程阶段(第 6 节),每个阶段都标注了涉及文件、验收命令、规模估计与回退方式。第一优先级不变:**等待用户授权重启生产 MCP 并完成一次真实 Web E2E**(这是被 paused Goal 的第 7 条 criterion 阻塞的唯一事项);其余阶段都不依赖 E2E,可并行准备。

---

## 2. 我们读到的 DSH:架构全景

先给出基于源码的全景,后续所有借鉴判断都以这一节为事实基础。

**进程模型。** DSH 是 pnpm monorepo,每个包是 `@deepseek-ai/dsh-<name>`;运行时是 vendored Cordis 插件树("一切皆插件"),由 `packages/bundle/base/cordis.patch.yml` 组装约 78 个插件。入口 `apps/cli`(`bin.ts` → `profile-boot.ts`),没有独立 server 进程;web 前端由 CLI 的 web profile 托管。核心 agent 运行时是 `packages/core/agent-loop`,它实现 `packages/core/agent` 定义的 `Agent` 接口,且**按设计可替换**(`ctx.agents.setFactory`)。

**事实层。** 一切围绕 append-only session 日志。`Session`(`packages/core/session`)维护 `log: SessionEvent[]`,信封恰好六个键 `{type, seq, time, data, surfaceOp?, sourceEventSeqs?}`,多一个键直接抛 `invalid event envelope`;`seq = log.length`,从 0 连续。事件词汇表 `SessionEventMap` 共 13 种核心类型(turn/start、turn/end、step/start、step/end、user/message、assistant/chunk、assistant/message、tool/call、tool/result、request/header、request/context、session/end-seed 等),插件通过 declaration merging 贡献自己的类型(goal/change、plan/mode、compaction/*、approval/*、schedule/change……),全部收录进生成的 `KNOWN_SESSION_EVENT_TYPES`(54 个)。**没有 per-event 的"可忽略"位**:读侧遇到未知类型整份日志拒载,理由写在 types.ts 注释里——"silently skipping content that shapes reconstruction is a wrong read"(跳过会影响重建的内容是一种错误读取)。

**持久化层。** `SessionPersistence` 抽象(`packages/session/session-persistence`)有两个后端:JSONL+zstd(默认)与 SQLite。写路径是 write-behind:每 session 一个批处理器,200ms 固定窗口,enqueue 时 structuredClone,失败时整批保留重试;`sessions.flush(session)` 是显式持久化屏障。检查点策略插件在三处强制 flush:首个模型流 chunk 之前、顶层工具派发之前、每个 pre-step。磁盘布局 `<home>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.jsonl.zstd`,首行 header(version/id/createdAt/cwd/parentSession/seedLength/delegationDepth),之后每个批次一个独立 zstd 帧(带 checksum);materialize 用临时文件 + fsync + link(而非 rename)发布,Windows 走 `MoveFileExW(MOVEFILE_WRITE_THROUGH)`;append 失败回滚到写入前长度,保证游标重试幂等。

**派生层。** 状态一律从日志重放得到,不用快照当真相:`Session.deriveMessages()` 折叠 surface 节点(append / range-replace 两种操作,replace 必须声明被遮蔽的全部 seq);通用 projection 定义为 `{init, apply, view, stateVersion}`,apply 必须同步、纯函数、对不关心的事件返回**同一引用**(用 `Object.is` 免费获得变更检测);持久化缓存按 session 一文档,绑定 `{createdAt, cwd}` 身份防"删了重建的同名 id 读到旧状态",且写入顺序强制"先截取一致性切面,再 flush 日志,再写缓存"——缓存可以落后于日志,永不超前,即"可能过期,但不会错"。

**上下文层。** system-prompt 是注册表(section/context/variable,scoped shadowing);动态上下文(PromptContext)不在 system prompt 里,而是**物化为 durable 的 user 消息快照**:每个 step 前渲染当前上下文,与保留快照做全文相等比较,只有变化才提交,消息头行写明"This snapshot supersedes earlier runtime-context snapshots"(靠更替表达新鲜度,而不是改写历史)。AGENTS.md 加载(agent-instructions)有完整的预算级联(超预算先丢最宽文件、再二分截断最具体文件、并披露省略了什么)和增量模型(工具触碰文件触发 delta,排队到 step 边界,按内容摘要去重)。

**Goal 与防漂移。** Goal 是 `goal/change` 全量快照事件 + `{id, revision}` CAS;每个变更 revision+1,模型必须先 get_goal 再携带精确 revision 调 update,拿旧的直接 `GOAL_STALE_REVISION`。自主续轮由 round-driver 驱动,轮数计入 `maxGoalRounds`(默认 256,人类消息永不占预算,按消息 source 统计);模型宣称 blocked 在连续 3 轮之前被机械拒绝;complete/blocked 只允许发生在"恰好是当前 revision 的第 N 轮"或"真人消息在场的开放 turn"里,折叠器在重放时校验轮次归因,伪造轮次会让整份日志重放失败。

**工具管线。** 每个调用走五段瀑布:pre-execute(allow/deny/ask)→ guard(单调只否)→ execute(超时包装)→ post-execute(accept/replace/block,block 会把错误结果转换成给模型的纠正反馈)→ result 观察。参数先快照深冻结;输出必须通过声明的 output schema,否则 `INVALID_TOOL_OUTPUT`;`schemas()` 只向模型暴露 name/description/parameters。guard/repeat-tool-reminder 在 post-execute 数"连续相同调用"(键 = 工具名 + 参数深度排序后的 JSON),阈值 [3,5,8] 时注入温和→详细的提醒,被拒绝的调用也计数,用户插话即重置。

**外部控制面。** DSH 只做 MCP 客户端(`mcp__<server>__<tool>` 桥接外部工具),从不把自身暴露为 MCP server。对外是三条 stdio/HTTP 面:SDK(3 个请求 + 4 个通知,prompt 返回"入队回执" messageId 而非回复,最终回复由客户端定义为 idle 前最后一条文本)、ACP(9 方法,server→client 的 session/update 流 + request_permission 单次授权)、Typert RPC 网关(供自家 web 客户端,RemoteJournalStream 的"先跟随再补页、缺口修复"读模型)。周边还有 spill(超长输出落盘,返回头尾预览 + opaque locator + retrievalHint)、attachment(sha256 内容寻址图片库,事件里只存引用)、jobs(后台任务完成以"通知消息"推进对话而不是靠轮询)、session-query(FTS5 全文检索)、workspace registry(宿主侧项目分组)。

---

## 3. 分域精读:机制 → 我们的现状 → 借鉴判断

### 3.1 事件模型与持久化:最值得整层吸收的纪律

**DSH 的关键机制。** 上面 §2 已概述,这里补四个对我们最有操作意义的细节。

第一,append 站点的校验与加载站点的校验是**同一套不变量**:`snapshotJsonValue` 单遍遍历同时完成验证和拷贝(拒绝循环、稀疏数组、跨 realm 异构对象、有状态 getter——getter 在验证和存储时可能返回不同值,单遍遍历从结构上消灭这类 TOCTOU),bad event 在生产者处失败,绝不会"写进去了、读不出来"。

第二,写失败的处理是"回滚 + 幂等重试"而不是"尽力而为":append 先 stat 记下文件长度,写+fsync,任何一步失败就截断回原长度再 fsync,然后重抛——因为游标不变、批次会重试,残留的部分字节会造成重复 seq。这对我们是直接可抄的代码模式。

第三,崩溃恢复的**分界线**画在"最后一个完整的 turn/end"上:分界线之前的损坏是 fatal corruption(整份日志拒绝),之后的是可移除的物理尾巴;尾巴里未完成的工具调用会得到合成闭合——已记录开始但无结果的补 `TOOL_OUTCOME_UNKNOWN`(文本明确说"仅在只读或幂等时重试,不要盲目重试"),未开始的补 `TOOL_NOT_STARTED`,然后 step/end、turn/end{interrupted},时间戳复用最后一条真实事件,绝不发明未来时间。

第四,持久化缓存的三条纪律:身份绑定(`{createdAt, cwd}`)防幽灵;写入顺序保证缓存只可能落后于日志;`restoreFloor` 把重放锚点放在最低可用水位线**之下一个事件**,这样"日志被截短"会被检测出来(空尾读不满水位 → 全量重读),而不是拿过期缓存冒充现状。

**我们的现状。** `harness-events.ts` 是一个约 130 行的兼容镜像:固定五类事件,信封 `version:1` 写了但读侧从不检查;seq 依赖 per-process 内存链 + "读最后一行"缓存,最后一行损坏时回退 `lines.length-1`,可能重复;`appendHarnessEventSafe` 吞掉一切错误零可观测(Phase 0 P0-1);事件 data 内嵌全量 task snapshot,单条 10KB(P1-2);无 header 行、无 torn-tail 策略、无投影。

**判断:整层吸收(A 档)。** 信封固定键集、seq 连续断言、append 校验、header 行、版本双向拒载、torn-tail 分界、append 回滚、写失败可观测——每一项都是小而独立的改造,且全部在"可以先写事件再写快照失败也可见"的兼容窗口内完成。特别是"读侧未知类型拒载"对我们有个特殊价值:未来我们加新事件类型时,旧 runtime(比如现在还活着的生产旧 build)会显式失败而不是静默读错,这把"忘了重启"从隐性问题变成显性问题。

### 3.2 状态派生:projection/replay 是迁移的终点站

**DSH 的关键机制。** ProjectionDefinition 的 `apply` 对不关心的事件返回同一引用,change listener 用 `Object.is` 判断,零成本变更检测;`stateVersion` 升版本直接丢弃旧持久化行(从不迁移,因为"状态可以从日志重放,为什么要迁移");whole-value 规则——携带状态的事件必须携带变更后的**完整状态**,不允许裸 delta(这让任何消费者重放都能收敛到同一状态,也让"这条事件是干什么的"永远无歧义)。

**我们的现状。** goal.json / tasks/*.json 快照是主真相,事件是单向 mirror,两边写序非原子,没有对账。审计报告 Phase C 已规划"replay 对账后再切读路径",但缺少具体契约。

**判断:契约级借鉴(A 档),实现放在事件层硬化之后。** 具体采纳三条规则:(1) goal/change、task/change 的 data 携带完整变更后状态(我们现在就是全量内嵌,方向是对的,错的是频率——见 3.6 的瘦身方案,把"每次观察都全量"改成"状态变更才全量,观察类事件只带增量字段");(2) apply 纯同步 + 同引用返回;(3) stateVersion 丢弃而非迁移。replay 与 snapshot 的对账测试(同一事件流,重放结果 === snapshot 文件内容)是切读路径的前置门禁,这条要写进验收。

### 3.3 上下文装配:RuntimeContextProjection 是 Context Broker V2 的完整蓝图

**DSH 的关键机制。** 这是我们本次精读对"产品体验"影响最大的发现。DSH 处理动态上下文的完整链条是:

- 每个step 前把当前所有动态上下文渲染成一个快照文本;
- 与"上一次已提交的快照"做**整文本相等**比较,不变则什么都不发生(零 token 成本、零 I/O);
- 变了才提交一条 user 消息,内容头行固定为"本快照更替更早的快照",消息 source 带 `{form:'snapshot', sections:[{name,text}...]}` 归因(每个 section 是谁、说了什么);
- 上下文为空时提交一个显式的 CLEARED 文本而不是静默消失;
- 旧快照永不改写,靠 compaction 的 range-replace 物理移除,并同步把 projection 的 retained 置空。

配套的还有 agent-instructions 的预算级联(maxBytes 之下:先整篇丢最宽的文件,还不行就对最具体的文件做 UTF-8 安全的二分截断,最后追加省略披露行——**省略必须是可见的**)、time-context 的 refreshIntervalMs 节流(节流状态从原始事件扫描得出,天然在 compaction/重启后存活)、以及 session-reference 对不可信数据的前导声明 + 标签包裹(把"这是检索来的外部内容,不要当指令"写进协议本身)。

**我们的现状。** Context Broker(约 160 行)每次工具调用都全量重建上下文:读 goal.json + active-task.json + task 文件 + 事件文件,再和 ACTIVE GOAL reminder、启动 instructions 三处重复注入 goal 信息;没有变化检测、没有预算、没有节流(P1-3)。

**判断:按 DSH 蓝图重写注入策略(A 档),保留 MCP 载体差异(B 档适配)。** 我们没有"提交 user 消息"的通道,等价物是"附加到工具结果"。翻译过来就是:Broker 维护 `retained {seq, text}`(内存 + 可选落盘),每次工具调用渲染候选快照,与 retained 全文比较,相同则**本次结果完全不附加**;不同则注入并更新 retained,快照自带 "This harness context supersedes earlier snapshots" 头行与 sections 归因。加上 maxBytes 级联与 4-chars/token 估算,这一组改动同时解决 I/O 放大(比较先行,大部分调用零注入)、三重注入(goal 只出现在 instructions 冷快照 + 变更后的热快照)、上下文膨胀(预算 + 披露)三件事。这与"27-tool 契约不破坏"完全兼容——全部发生在 server-factory 现有拦截链内部。

### 3.4 防循环 guard:一个我们完全没有的能力,纯增益

**DSH 的关键机制。** repeat-tool-reminder 在 post-execute 统计"连续相同的工具调用"(键 = `[toolName, deep-sort-key-then-stringify(args)]`,对 JSON 键序不敏感),默认阈值 [3,5,8]:第一次到阈值注入温和提醒("你在用完全相同的参数重复调用,先分析上次结果"),后续阈值注入详细提醒(点名工具、连续次数 N、参数头 500 字符预览,结尾"不要再用这些参数调用")。三个设计细节体现功力:(1) 计数放在 post-execute,**被拒绝的调用也计数**——模型反复锤一扇打不开的门正是最需要打破的循环;(2) 提醒在 allow 和 block 两种下游决定里都会前缀注入,被 block 的调用同样收到劝告;(3) 用户插话即重置整条链——"跨用户输入的重复不是循环"。配套的 timeout-policy 则用合作式 deadline 包装实现 per-tool 超时,只在自己的计时器触发时才把结果归类为 TOOL_TIMEOUT,避免嵌套外层 deadline 被误判。

**我们的现状。** 什么都没有。模型如果陷入"read_text_file 失败 → 原样重试 → 再失败"的循环,唯一的刹车是 ChatGPT 自己的耐心。我们的 run_command 观察层已经能识别 test/build/lint,但对"同一调用反复失败"没有机械反馈。

**判断:直接移植(A 档)。** 在 server-factory 的 wrapper 链里加一个 per-workspace 的 `Chain` 计数器(工具名 + canonical args),阈值 [3,5,8],提醒文本追加到工具结果 content(我们的等价 additionalContexts 就是 content 数组)。拒绝/错误的结果也计数;`goal`/`task_state` 等状态工具可以进 include 白名单之外。预计 100 行上下,是整个计划里性价比最高的一项。

### 3.5 Goal 体系:防伪完成是"机械规则",不是"提示词"

**DSH 的关键机制。** §2 已概述 CAS 与轮次归因,补充三个我们可直接借用的语义:(1) **revision 由服务单方面递增**,调用方永远只能传递它读到的值,这消灭了"模型基于过期状态做决定"的整类问题,错误消息里同时写出期望与实际 revision,模型能自愈;(2) **blocked 是有门槛的**:不足 3 个连续自主轮次时机械拒绝,且 block 的 code 一律由策略写死为 `model-reported`,提示词同时声明"困难、不确定或有剩余工作都不算 blocked"——把"我不爽了所以宣布阻塞"这条逃避通道用规则焊死;(3) **收尾消息的 grounding**:自主 complete/blocked 之后强制追加收尾指令"只报告本 session 的轮次与工具结果实际建立了的事实;session 里没有的细节,直说没有,不要编造",并禁止再调工具。

**我们的现状。** goal.json 有 status + criteria,completion gate 要求 criteria 全过且显式 complete;但没有 revision(两个 chat 同时操作一个 workspace 的 goal 会互相静默覆盖),blockers 是纯字符串列表,没有 blocked 语义门槛,user_confirmed 类型没有任何写入路径,也没有"完成后的 grounding"提示。

**判断:语义级移植(A 档),轮次驱动不可移植(C 档)。** 采纳:goal revision CAS(expected_revision 参数 + GOAL_STALE_REVISION 错误)、blockedReason {code,message} 结构化与 lower-kebab 约束、user_confirmed 的显式写入动作(goal 工具加 confirm 语义或独立 confirm_evidence 动作,记录 evidence 事件)、complete 成功后的 grounding 文本注入。round-driver / pre-step 门 / inbox 预留全部属于"拥有循环"的能力,明确不做——我们的对应物已经是"启动 instructions + 每结果 reminder"的热通道,这在 DSH 报告里也被认为是可接受的等价物。

### 3.6 工具管线与输出治理:spill / attachment / jobs 的取舍

**DSH 的关键机制。** 工具侧五段瀑布里,对我们有直接价值的两件:post-execute 的 block 决定把"错误的成功"转换成带纠正反馈的 isError 结果(我们的 wrapper 链正好有这个位置);`schemas()` 白名单确保执行元数据永不模型可见(我们的 tool annotations 已经在做类似分层)。输出侧三件套:spill 的 `SpillRef{locator, bytes, retrievalHint}` + 头尾对半的 preview + "(省略 N 字节,完整结果在:<locator>,用 read offset/limit 或 grep 该路径)"固定句式 + **best-effort(落盘失败保留原结果,绝不因治理失败而丢数据)**;attachment 的 sha256 内容寻址 + 读回校验 + "事件只存引用,base64/路径永不进日志";jobs 的完成推送语义(空闲时唤醒、忙时注入下一步,标记 reported 后抑制重复通知)。

**我们的现状。** run_command 已经有 full_output_path 落盘 + compact preview(本质就是 spill,但 locator 语义和 retrievalHint 不系统);rewind/checkpoint 有自己的文件体系;start_process 有 process_status/process_output 轮询但没有完成推送;视觉产物有 visual-reviews 目录但事件里只存摘要。

**判断:规范化借鉴(B 档)。** 把 command-logs 的路径升级为正式 SpillRef 语义(bytes + retrievalHint 写明"用 read_text_file 读该路径"),统一 preview 的头尾分割规则(参考 4096/1024 的头尾比例思想);事件与 task artifact 只记 SHA256 引用与路径,不内嵌大文本;后台进程完成提示走 harness_context 快照(复用 3.3 的去重机制,天然不重复)。全量对齐 attachment 的 2 字符前缀分桶没必要(D 档),我们产物量级不需要。

### 3.7 外部控制面:一个"反直觉的确认"

**发现。** DSH 从不把自己暴露为 MCP server;它对外控制面(SDK 3 请求 + 4 通知、ACP 9 方法)的共同设计是**入队回执 + 拉取观察**:提交 prompt 只拿 messageId,结果靠订阅事件流或"先跟随再补页"的 journal 读模型拉取;审批通过 server 发起的单次请求往返。包 `packages/mcp` 只是客户端桥。

**对我们的意义。** 这确认了两件事:(1) 我们"通过工具结果回带状态"的做法不是权宜之计,而是无推送通道环境下的标准形态——DSH 自己的 web 客户端拉取历史用的正是"journal 读模型 + seq 窗口";(2) 如果未来需要在 Web 上回看 harness 的执行轨迹,正确形态不是加新工具,而是在现有工具的 structured data 里提供 `journal` 读取段(遵循 readWindowMax=50 的窗口约束),或走 Admin UI(:3001)这个我们已有的宿主侧通道——workspace registry 在 DSH 里就是"宿主可见、模型不可见"的先例。

---

## 4. 可借鉴性总矩阵

| # | DSH 机制 | 档位 | 落点 |
|---|---|---|---|
| 1 | 事件信封固定键集 + append 校验单遍验证拷贝 | A 直接抄 | harness-events v2 |
| 2 | seq=log.length 断言 + torn-tail 分界(最后完整检查点前后区别对待) | A 直接抄 | harness-events v2 |
| 3 | header 行 + 版本双向拒载 + 未知类型 fail-closed | A 直接抄 | harness-events v2 |
| 4 | append 回滚(截回原长)+ 写失败可观测 | A 直接抄 | harness-events v2 |
| 5 | ProjectionDefinition{init,apply,view,stateVersion} + 同引用返回 + whole-value 事件 | A 直接抄 | projection 层(Phase 3) |
| 6 | 持久化缓存:身份绑定、缓存只落后不超前、restoreFloor 检测日志缩短 | A 直接抄 | projection 缓存(Phase 3) |
| 7 | RuntimeContextProjection:快照全文去重 + supersede 头行 + sections 归因 + CLEARED | A 直接抄(载体换为工具结果) | Context Broker V2 |
| 8 | agent-instructions 预算级联(丢最宽→截最具体→省略披露) | A 直接抄 | Context Broker V2 |
| 9 | refreshIntervalMs 节流(状态从原始事件扫描,抗重启) | A 直接抄 | Context Broker V2 |
| 10 | repeat-tool-reminder(canonical args 键、阈值 3/5/8、拒绝也计数、用户插话重置) | A 直接抄 | server-factory guard |
| 11 | timeout-policy 合作式 deadline(只归类自己的超时) | B 改造后抄 | shell/process 工具 |
| 12 | GoalRef{id,revision} CAS + GOAL_STALE_REVISION | A 直接抄 | goals.ts v2 |
| 13 | goal/change 全量快照事件 + 严格折叠(非法迁移重放失败) | A 直接抄 | projection 对账 |
| 14 | blockedReason{code,message} + blocked 门槛 + model-reported 写死 | A 直接抄 | goals/task |
| 15 | 自主完成后的 grounding 收尾文本 | A 直接抄 | goal/task 工具结果 |
| 16 | post-execute block → isError 纠正反馈;输出 schema 校验 INVALID_TOOL_OUTPUT | B 借鉴思想 | wrapper 链 |
| 17 | spill:头尾 preview + locator + retrievalHint + best-effort | B 规范化 | command-logs/run_command |
| 18 | 附件 sha256 内容寻址、事件只存引用 | B 简化版 | task artifacts/evidence |
| 19 | jobs 完成推送(忙注入/闲唤醒/reported 抑制) | B 改造后抄 | harness_context 后台任务段 |
| 20 | journal 读模型(seq 窗口 + 先跟随再补页) | B 内部 API | agent_status/ Admin UI |
| 21 | 轮次驱动 / inbox 预留 / pre-step 门 / 宿主认证人类 turn | C 不可实现 | —— |
| 22 | surface range-replace 压缩(compaction 重写对话历史) | C 不可实现 | 对话历史归 ChatGPT |
| 23 | request/header epoch + "请求=重放"不变量 | C 不可实现(无请求控制权) | —— |
| 24 | MCP server 化自身 / SDK / ACP 对外暴露 | C 不做 | 产品边界 |
| 25 | Cordis 插件框架 / scope chain 完整实现 | D 不必要 | 单文件模块足够 |
| 26 | zstd 帧 + chunk packing(~56-60% 压缩)/ SQLite 后端 + FTS5 | D 不必要(规模不需要) | JSONL + 原子写 |
| 27 | fork/OPEN_TURN 代数、HMR live adoption、legacy 迁移层 | D 不必要 | 新格式无历史包袱 |

一句话读法:A 档 14 项是本计划的主体;B 档 7 项按"借语义不借实现"处理;C/D 档写进第 7 节边界,防止未来走偏。

---

## 5. 差距分析:我们的每个已知问题,D Stack 里都有现成答案

把 Phase 0 审计的风险清单与 DSH 机制对齐,得到一张"问题→答案"表:

| 我们的问题(审计编号) | DSH 的答案 | 采纳后的验收形态 |
|---|---|---|
| P0-1 事件镜像静默失败、零可观测 | 写失败重试可见、检查点屏障;读侧 fail-closed | 事件写入失败计数暴露在 agent_status;写失败不再无感 |
| P1-1 seq 一致性(per-process 缓存、最后一行损坏回退) | seq=log.length 断言 + 单遍校验 + torn-tail 分界 | 损坏尾部丢弃且告警;seq 永不重复;未知类型拒载 |
| P1-2 事件体积(单条 task/change 10KB) | whole-value 规则 + 低频全量/高频增量分流 | 观察类事件 ≤1KB;全量快照仅在状态变更事件中出现 |
| P1-3 Broker I/O 放大 + 三重注入 | 快照全文去重 + supersede + sections 归因 | 无变化调用零注入;goal 信息冷热各一处 |
| P1-4 isPathWithinRoot Windows 大小写 | (DSH 无此问题,项目键有规范化先例 projectKey/encodeSegment) | 大小写归一后 relative;补大小写回归测试 |
| P1-5 project scope 启发式盲区 | DSH 的 per-cwd 键与 workspace registry(宿主侧) | 保持 v1 简化 + 文档声明"观察边界";范围锁定事件显式化 |
| P2 user_confirmed 无写入路径 | approval 审计对(asked/decided)+ closed outcome | confirm 动作写入 user_confirmed evidence,进 completion gate |
| P2 无防循环能力 | repeat-tool-reminder | 阈值提醒出现在连续重复调用的结果里 |
| P2 goal 并发覆盖、无 revision | GoalRef CAS | 过期 revision 显式报错并可自愈 |
| P2 事件无 id/causation、version 无人读 | 信封纪律 + KNOWN 类型集 | 新信封带 id/causation 可选字段;version 拒载生效 |
| P2 snapshot 与事件写序非原子 | "缓存只落后于日志"的写序纪律 | 快照先行、事件镜像失败可见;Phase 3 后倒转并做对账 |

这张表说明:我们的问题清单没有一项需要发明新方案,全部有经过生产检验的参照实现。剩下的工作是把它们翻译进 MCP/Express/JSONL 的语境,并保持 27-tool 契约与现有成熟模块不动。

---

## 6. 优化计划:六个阶段

以下阶段编号承接审计报告(其 Phase A"重启+E2E"即本计划的阶段 0)。每个阶段独立可验收、独立可回退;除阶段 0 外互不阻塞,但建议按序执行以复用前序基础设施。

### 阶段 0:生产重启 + 真实 Web E2E(阻塞中,等待用户授权)

目标:让 V2 原型在真实 ChatGPT Web 上生效并验证,了结 paused Goal 的最后一条 criterion。

步骤:用户重启生产 MCP(建议 `restart-mcp.cmd`,不要手动杀进程,两条账号隧道在场时尤其如此)→ `/health` 确认 `build_id` 变化且 `stale_build:false` → 新聊天做一次小任务:普通工具调用验证 `data.harness_context` 出现且项目匹配;`project_context(query)` 验证 bundle;执行一次会触发观察的写入,检查 `harness-events.jsonl` 增长 → 通过后 goal criterion 7 置 passed → `goal action=complete` + task complete → **停止,不重复验证**。

若 E2E 发现 harness_context 未出现:按 P0-1 路径排查(loaded build 是否正确、事件写入是否有错误被吞),这本身就是阶段 1 的第一项输入。

验收:goal/task 正常 complete;`npm run test:all` 保持全绿。

### 阶段 1:事件层工程纪律硬化(harness-events v2)

目标:把事件层从"兼容镜像"升级为"可信事实基础",消灭 P0-1/P1-1/P1-2。

任务清单:
1. **信封 v2**:固定键集 `{type, seq, time, data, id?, causation_id?}`(id/causation 可选先留桩);`version` 从每条事件移到**文件首行 header**(`{kind:'harness-log', version:1, workspace_root, created_at}`);读侧检查 header version 与事件键集,不认识即抛带文件路径的 `FormatUnsupported` 错误(向上暴露,不吞)。
2. **append 校验**:写入前对 data 做单遍 JSON 验证(拒绝循环/非有限数/超深),复用现有 `atomicWriteJson` 的临时文件纪律;append 失败(含 ENOSPC/EACCES)→ 内存失败计数 + stderr 告警 + `agent_status` 暴露 `{event_log: {events, last_seq, torn_tail, dropped_writes}}`。
3. **seq 纪律**:seq 从 header 后重放计数(不再只看最后一行);最后一行 JSON 解析失败 → 视为 torn tail,丢弃该行、计数并告警;seq 不连续 → 读侧报错(写侧由单进程链保证)。
4. **体积分流**:goal/change、task/change(状态变更类)保留全量快照(whole-value);`tool/observation` 只保留 `{tool, ok, summary≤300, paths≤10, exit_code}`;`evidence/recorded` 增加可选 `shadow` 字段记录被摘要的原始尺寸。目标:观察类单条 ≤1.2KB。
5. **写序纪律**:维持"快照先行"(兼容期原则),但事件写失败不再静默——`recordTaskChange`/`recordGoalChange` 的调用点感知失败计数,`agent_status` 如实报告"事件落后"。

涉及文件:`src/lib/harness-events.ts`(重写)、`src/lib/goals.ts`/`src/lib/durable-tasks.ts`(调用点小改)、`src/tools/context.ts`(agent_status 增加段)。

验收:`scripts/test-harness-v2.mjs` 扩展——torn tail 注入用例、seq 断言用例、体积断言(观察事件字节数上限)、失败注入用例(只读目录写入失败 → 计数器 +1 且主流程不受影响);`npm test` 全绿。

规模:约 2 个工作日。回退:事件层故障不影响任何主功能(fail-soft 保留在"写不进"分支,只是不再无感)。

### 阶段 2:防循环 guard + 输出治理规范化

目标:补上"模型行为机械反馈"缺口,规范大输出语义。

任务清单:
1. **repeat guard**:server-factory wrapper 链新增 per-workspace `Chain{key,count}`(键 = 工具名 + 参数深排序 JSON;args 解析失败则用原始字符串);阈值 [3,5,8];3→温和提醒,5/8→详细提醒(工具名、连续次数 N、参数头 500 字符预览);结果为 error 或被拒也计数;`goal`/`task_state`/`agent_status`/`visual_review` 不跟踪;提醒文本追加到 content 数组(受阶段 3 的快照去重管辖,不与 harness_context 叠加)。
2. **spill 语义统一**:`run_command`/`start_process`/`process_output` 的 full_output 返回升级为 `{spill: {locator: 绝对路径, bytes, retrieval_hint: "Use read_text_file with offset/limit on this path"}}`;preview 头尾分割规则固化为常量(head 35% / tail 65%,与现状一致但文档化);落盘失败 best-effort 保留原结果。
3. **artifact 引用化**:task artifacts 与 evidence 事件只记 `{path, sha256, bytes}`,不内嵌内容(复用 filesystem 已有的 sha256 能力)。

涉及文件:`src/server-factory.ts`、新增 `src/lib/repeat-guard.ts`、`src/tools/shell.ts`、`src/lib/durable-tasks.ts`(artifact 提取)。

验收:新测试 `scripts/test-repeat-guard.mjs`(模拟 8 次相同调用断言提醒出现与重置行为);现有 shell/command-observation 测试全绿;`test-tool-profile` 确认 27-tool 不变。

规模:约 1.5 个工作日。

### 阶段 3:Context Broker V2(快照去重 + 预算 + 节流)

目标:解决 P1-3,把上下文注入从"每调用必附"升级为"变化才注入",同时保留 Active Goal 通道的正确分工。

任务清单:
1. **retained 快照**:Broker 维护 `{seq, text}`(内存;可选持久化到事件 log 的 `context/bundle` 事件以跨重启生效);渲染候选 harness_context 全文,与 retained 全文相等 → 本次结果零附加;不等 → 附加 + 更新 retained。文本头部固定:"This harness context supersedes earlier harness context snapshots."
2. **sections 归因**:structured `harness_context` 保持现有 schema,文本段按段生成(goal/task/evidence/guard 各一段),CLEARED 语义:无活跃 goal/task 且无证据时注入显式 "No active goal or task." 一行(而不是静默)——防止模型把"没消息"误解为"没状态"。
3. **预算级联**:总预算默认 1800 字符(现状),超限次序:先丢 recent_evidence 旧条目 → 再截 goal 约束列表 → 最后对 task.next_actions 做 UTF-8 安全截断,并在尾部追加 "(N chars omitted)" 披露行。
4. **三重注入去重**:instructions(冷)保留完整 ACTIVE GOAL 段;reminder(热)只在 goal **状态变化后第一次**工具结果附加(由 retained 快照机制天然实现,因为不变就不注入),常规调用不再重复;`goal`/`task_state`/`project_context` 工具自身返回的仍跳过文本注入。
5. **节流**:evidence 段扫描使用 `readFrom(last_seen_seq)` 增量读(依赖阶段 1 的 seq 纪律),替代每次全文件读。
6. **后台任务完成推送**:start_process 完成状态进入快照的 `pending_notices` 段,已被模型看见过(出现在某次注入中)即标记 reported,之后不再重复——借 jobs 的 reported 抑制语义。

涉及文件:`src/lib/context-broker.ts`(重写)、`src/lib/goals.ts`(reminder 调用点)、`src/server-factory.ts`(接线不变)。

验收:扩展 `test-harness-v2.mjs` 或新增 `test-context-broker-v2.mjs`:同一状态连续两次调用 → 第二次结果不含 HARNESS CONTEXT 文本;goal 变更后 → 下一次调用出现更新;预算超限 → 出现披露行且结构完整;`npm run test:all` 全绿。

规模:约 2 个工作日。风险:去重可能让"上下文没跟上"的模型困惑——缓解:supersede 头行 + task/goal 变化必然改变快照文本(包含 updated_at),实际不变即真不变。

### 阶段 4:Goal/Task 语义加固(CAS + blocked + user_confirmed)

目标:把防伪完成从提示词约束升级为机械约束。

任务清单:
1. **Goal revision**:`goal.json` 增加 `revision`(create=1,每次 mutation+1);`goal` 工具的 update/pause/resume/complete/confirm 接受可选 `expected_revision`,提供时必须等于当前值,否则报错并回显期望值(错误消息学 DSH:同时写出 expected/actual,模型可自愈);不提供则保持现状兼容(渐进)。
2. **blockedReason 结构化**:task blockers 从 `string[]` 迁移为 `{code, message}[]`(code lower-kebab 白名单风格:env-missing、test-failing、visual-failed、user-input-needed、model-reported……);DurableTask version 3,normalizeTask 兼容旧字符串。
3. **blocked 门槛**:同一 task 连续 checkpoint 中 blockers 未解除的次数 <2 时,拒绝新的 `model-reported` 类 blocker(机械拒绝,提示"先解决或升级为 user-input-needed");不影响其他 code。
4. **user_confirmed 写入路径**:goal 工具新增语义(在现有 action 集合内,如 `action=confirm` + criterion 名),写入 `evidence/recorded {kind:'user_confirmed', criterion, detail}`;completion gate 扩展:criterion 若声明了 `requires_confirmation`,必须存在对应 user_confirmed 证据才能置 passed(由 gate 校验,不信模型自述)。
5. **grounding 收尾**:goal complete 成功的结果尾部追加固定文本:"只报告工具结果与已验证证据实际建立的事实;未验证的细节注明未验证。"(借 DSH wrap-up 措辞精神)。

涉及文件:`src/lib/goals.ts`、`src/lib/durable-tasks.ts`、`src/tools/goal.ts`、`src/tools/tasks.ts`。

验收:`test-goal-mode.mjs` 扩展:revision 冲突用例、blocked 门槛用例、confirm→criterion→complete 全链用例;`npm test` 全绿;外部契约:goal/task_state 输入参数只增不改,旧调用方式全部仍工作。

规模:约 2.5 个工作日。

### 阶段 5:Projection + replay 对账(事件层转正的前置门)

目标:证明"状态可以从事件重放",为未来把读路径切到事件层铺路(本阶段**不**切读路径)。

任务清单:
1. **ProjectionDefinition 移植**:`src/lib/projection.ts` 提供 `{key, init, apply, view, stateVersion}` 契约(同步纯函数、同引用返回);实现 `goalProjection` 与 `taskProjection` 两个单元。
2. **对账测试**:生成随机操作序列(goal/task 混合、含跨项目观察),一边写 snapshot 一边写事件;然后从事件重放,断言重放结果与 snapshot 深相等;再断言 stateVersion 升级时旧持久化缓存被丢弃。
3. **身份绑定缓存**(可选落盘):`{workspaceSlug, goalCreatedAt}` 绑定,防"删库重建后读到幽灵状态";restoreFloor 思想:重放锚点取最低水位线下一个事件,日志缩短可检测。
4. **读路径不动**:goal.json/tasks/*.json 仍是主真相;projection 仅存在于测试与诊断(`agent_status` 可暴露 projection 与 snapshot 的一致性状态)。

涉及文件:新增 `src/lib/projection.ts`、`scripts/test-projection-replay.mjs`。

验收:对账测试 1000 次随机操作全等;`npm run test:all` 全绿。

规模:约 2 个工作日。此阶段完成后,"切读路径"变成一个 feature-flag 决策,而非工程冒险。

### 阶段 6:可观测性收尾与文档

任务:agent_status 汇总暴露(event log 健康、projection 一致性、guard 计数、broker retained 状态);Admin UI 增加只读的事件日志查看段(宿主侧通道,不加 MCP 工具);把本计划与审计报告的经验回写 `docs/web-harness-v2.md`(状态从"prototype 说明"升级为"现行架构说明");EXPERIENCE.md 补充运维条目(事件文件位置、损坏恢复步骤)。

---

## 7. 边界:明确不做的事

1. **不做模型循环相关件**:轮次驱动、inbox 预留、pre-step 门、request/header epoch、subagent、fork——即使 DSH 实现摆在那里也不抄,因为没有等价的循环钩子,伪装一个只会制造假抽象。
2. **不做对话历史压缩**:compaction 的 range-replace 重写的是模型对话,那归 ChatGPT 管;我们的"压缩"仅指 task.recent_events 上限、evidence 归档、事件瘦身,不碰对话。
3. **不把 harness 暴露为 MCP server / SDK / ACP**:产品边界,ChatGPT Web 是唯一模型侧客户。
4. **不引入插件框架**:Cordis 的 scope chain 语义(nearest-wins、限制相交、deny 单调)作为**规则**吸收进 wrapper 链的代码注释与实现约定,框架本身不引入——我们一个 Express + 拦截链装得下。
5. **不上 SQLite/zstd/FTS**:当前数据量级(单 workspace 数百事件)下 JSONL + 原子写 + fsync 足够;等事件量到了需要索引再说,且优先用系统 grep 而不是嵌入式数据库。
6. **不加任何新 MCP 工具**:27-tool 契约是硬边界,阶段 1–6 的全部能力通过现有工具的 structured data、server-factory 拦截链与 Admin UI 交付。

---

## 8. 附录:DSH 源码索引(供后续对照)

事件与信封:`packages/core/session/src/types.ts`(SessionEventMap、envelope、SESSION_FORMAT_VERSION)· `index.ts`(append 校验、deriveMessages、SessionStore.flush)· `surface.ts`(append/replace 节点模型)· `chunk-rows.ts`(打包白名单)。持久化:`packages/session/session-persistence/src/coordinator.ts`(写后批处理、torn tail、版本拒载)· `write-behind.ts`(200ms 窗口)· `session-persistence-jsonl/src/index.ts`(link 发布、append 回滚、revision 元组)· `session-checkpoint-policy`(三处 flush)。投影:`packages/session/session-projection`(apply 契约)· `session-projection-cache`(身份绑定、写序)。上下文:`packages/core/agent-loop/src/runtime-context.ts`(快照物化)· `packages/core/system-prompt/src/index.ts`(注册表与 assemble)· `packages/context/agent-instructions`(预算级联与增量)· `session-reference`(不可信数据框架)。压缩:`packages/compaction/compaction-basic`(0.8/0.16 阈值、配对平衡、提交事务)· `compaction-tool-result-pruner`(8192/4096/1024 裁剪)。Goal:`packages/goal/goal/src/index.ts`(CAS)· `fold.ts`(严格重放)· `goal-round-driver`(轮次)· `tool-goal`(门槛与收尾)。工具与 guard:`packages/core/tools/src/index.ts`(五段瀑布、schemas 白名单)· `packages/guard/repeat-tool-reminder` · `timeout-policy`。审批与沙箱:`packages/interaction/user-approval`(fail-closed)· `permission-presets`(阶梯)。外部面:`packages/sdk/protocol/src/types.ts` · `packages/acp/acp/src/index.ts` · `packages/mcp/mcp-client/src/tools.ts`。周边:`packages/spill/spill-policy` · `packages/attachment/attachment-local` · `packages/jobs/tool-jobs` · `packages/session/session-query-sqlite`。
