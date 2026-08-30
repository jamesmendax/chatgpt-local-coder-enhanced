# Web Harness V2

## Product boundary

ChatGPT Local Coder is a harness sidecar for ChatGPT Web over MCP and a network tunnel. It does not own the model request loop and will not implement or reserve an API-agent runtime, model-provider abstraction, model routing, or true LLM subagents.

The optimization target is the part of the agent system we can control:

1. **Execution** — local files, shell, compiler/test, Git, browser/runtime evidence.
2. **Context** — deliver high-signal project/task information to each useful MCP interaction.
3. **State** — external working memory that remains consistent across Web conversations and MCP sessions.
4. **Evidence** — distinguish facts proven by the environment from judgments made by the model or user.

## What we borrow from DeepSeek Harness

DeepSeek Harness owns its model loop, so its runtime cannot be copied directly. The reusable architectural ideas are narrower:

- **Append-only facts before projections.** DeepSeek's session log is the durable source of truth; V2 introduces a compatibility event log so Goal/task/evidence can converge on one fact stream over time.
- **Scoped state.** DeepSeek scopes capabilities and state to an Agent/Session. V2 scopes local task observations to project roots so work in another repository does not contaminate the active task.
- **Dynamic context as a first-class capability.** DeepSeek assembles prompt contexts per request. ChatGPT Web does not expose that hook, so V2 implements a Context Broker that attaches compact runtime context to MCP results and to `project_context` bundles.
- **Separate state from policy.** Durable facts, execution evidence, and model judgments carry distinct meanings instead of being treated as equally certain completion signals.

## What we deliberately do not borrow

These require ownership of the model request loop and are outside this Web-only product:

- LLM provider/model routing
- automatic model retries or request scheduling
- true LLM subagents and parallel model calls
- model-loop compaction
- API workflow orchestration
- reasoning-effort controls

## Phase 1 compatibility architecture

Phase 1 is intentionally a dual-write migration. Existing public tools and snapshot files remain compatible while new facts are also appended to an event stream.

```text
ChatGPT Web
    |
    | MCP over tunnel
    v
Stable 27-tool surface
    |
    +--> Execution tools -----------------------------+
    |                                                |
    +--> Goal / task_state snapshots (compatible)    |
    |          |                                     |
    |          +--> harness-events.jsonl <-----------+
    |                     |
    |                     +--> typed evidence
    |                     |
    |                     +--> Context Broker
    |                              |
    +------------------------------+--> compact runtime context
```

### Append-only event foundation

`src/lib/harness-events.ts` records versioned JSONL events with a monotonic sequence number:

- `goal/change`
- `task/change`
- `tool/observation`
- `evidence/recorded`
- `context/bundle`
- `goal/stall`

During the compatibility phase, event recording is fail-soft: a mirror failure must not break the proven Goal/task snapshot path. A later migration may make projections derive from the event stream after replay and migration tests exist.

### Project scope

`src/lib/project-scope.ts` detects project roots from explicit absolute paths and common repository markers. A durable task now carries:

- `project_roots`
- `project_scope_locked`

If the task objective explicitly names a project, the scope is locked at creation. Otherwise the first meaningful absolute tool target may lock it. Once locked, automatic task observation ignores operations whose absolute targets belong only to another project.

This is a state-observation boundary, not a filesystem security boundary. The MCP still has the configured machine access; project scope prevents unrelated work from polluting the wrong task.

### Evidence classes

Harness events distinguish four evidence sources:

- `deterministic` — filesystem/structured facts or other mechanically determined results
- `runtime` — commands, tests, builds, processes, browser/render execution
- `model_assessed` — semantic or visual judgment made by the model
- `user_confirmed` — explicit human acceptance/confirmation

The type is deliberately separate from pass/fail. A model judgment must not be treated as epistemically equivalent to a compiler exit code.

### Context Broker

`src/lib/context-broker.ts` builds a compact project-aware runtime view from:

- the matching active Goal summary
- the matching active durable task
- blockers and next actions
- recent typed evidence

The broker is attached to structured MCP tool results as `data.harness_context`. Most ordinary tools also receive a short textual `HARNESS CONTEXT` reminder. Tools that already expose state (`goal`, `task_state`, `project_context`, diagnostics/skill tools) skip the duplicate text.

`project_context(mode=relevant)` additionally returns its normal repository guidance bundle plus the project-matching harness runtime context and records a `context/bundle` event.

## Compatibility rules

- Keep the ChatGPT Web slim surface stable at 27 tools.
- Do not add a model-loop abstraction to the MCP.
- Do not remove Goal/task snapshot persistence until event replay/projection migration is separately proven.
- Do not allow event logging failure to break local execution during the compatibility phase.
- Keep project scope separate from filesystem authorization.
- Prefer high-signal structured context over larger prompt injection.

## Phase 1 verification target

The phase is considered structurally ready when:

- TypeScript builds.
- Cross-project mutations do not enter another project's active task state.
- Goal/task/tool/evidence events are append-only with contiguous sequence numbers.
- Context Broker returns task/Goal/evidence for the matching project and does not leak them to another project.
- Existing Goal Mode, durable task, context, command-observation, tool-profile, and agent-harness tests pass.
- The slim tool surface remains exactly 27 tools within the existing schema budget.
- After a manual production MCP restart, real ChatGPT Web tool results expose the new `harness_context` from the loaded build.
