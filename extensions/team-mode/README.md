# pi-mono-team-mode

A faithful port of **Claude Code's team-mode mode** to the pi coding agent. Named workers are spawned as pi subprocesses by default, the coordinator ends its turn after launching, and completion arrives as a `<task-notification>` user-role message that wakes the coordinator event-driven — no polling, no leader subprocess.

> **Sibling of `pi-mono-team-mode`.** `team-mode` is leader-driven (a coordinator subprocess runs on its own task graph). `team-mode` maps 1:1 to Claude Code's semantics instead.

## Parity with Claude Code

Everything below mirrors `claude-code/src/` behavior (`coordinator/coordinatorMode.ts`, `tools/AgentTool`, `tools/SendMessageTool`, `tools/Task*Tool`, `utils/swarm/teammatePromptAddendum.ts`).

| Claude Code                                                                                         | team-mode                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Agent({ description, prompt, name?, team_name?, subagent_type?, isolation?, run_in_background? })` | `agent(...)` — same schema plus optional `runtime` selector         |
| `subagent({ tasks })`-style fan-out                                                                 | `delegate({ tasks: [...] })`                                        |
| `subagent({ chain })`-style sequencing                                                              | `delegate({ task, chain: [...] })`                                  |
| `SendMessage({ to, message })`                                                                      | `send_message(...)`                                                 |
| `TaskStop({ task_id })`                                                                             | `task_stop(...)`                                                    |
| `TaskOutput({ task_id })`                                                                           | `task_output(...)`                                                  |
| `TaskCreate({ subject, description, activeForm?, metadata? })`                                      | `task_create(...)`                                                  |
| `TaskUpdate({ task_id, status?, owner?, addBlocks?, addBlockedBy?, ... })`                          | `task_update(...)`                                                  |
| `TaskGet({ task_id })`                                                                              | `task_get(...)`                                                     |
| `TaskList({ status?, owner? })`                                                                     | `task_list(...)`                                                    |
| `TeamCreate / TeamDelete`                                                                           | `team_create / team_delete`                                         |
| `<task-notification>` XML wakes coordinator                                                         | Emitted via `pi.sendMessage({ triggerTurn: true })` on teammate end |
| Coordinator system prompt (`CLAUDE_CODE_COORDINATOR_MODE=1`)                                        | `PI_TEAM_MATE_COORDINATOR=1`                                        |
| Teammate prompt addendum (`TEAMMATE_SYSTEM_PROMPT_ADDENDUM`)                                        | Prepended to every teammate's system prompt                         |
| Task ids namespaced `agent-*`                                                                       | Same namespace; `task_stop` and `send_message` accept it            |

## The execution model

Workers are **event-driven, not polled**. You don't write "spawn, wait, spawn the next" loops:

```
Turn 1 (coordinator):
  agent({ description: "research auth", prompt: "..." })   → task_id: agent-r-ab1
  agent({ description: "research billing", prompt: "..." })→ task_id: agent-b-c3d
  "Investigating both — I'll report back."  [turn ends]

  ...workers run in parallel; zero coordinator tokens burned...

Between turns:
  <task-notification>
    <task-id>agent-r-ab1</task-id>
    <status>completed</status>
    <summary>Agent "research auth" completed</summary>
    <result>Found null pointer in src/auth/validate.ts:42...</result>
    <usage><duration_ms>14230</duration_ms></usage>
  </task-notification>

Turn 2 (coordinator, woken by the notification):
  "Found the bug. I'll fix it."
  send_message({ to: "agent-r-ab1", message: "Fix src/auth/validate.ts:42..." })
  [turn ends]
```

For a single coherent task, the coordinator should resolve it directly without creating a TODO item. Creating exactly one `task_create` entry is overhead, not coordination.

For a DAG of dependent tasks, the coordinator:

1. Seeds the TODO list via `task_create` (each task with `blocks`/`blockedBy` set via `task_update`).
2. Spawns a worker for each immediately-unblocked task, setting `task_update({ owner })` on the matching TODO.
3. **Ends its turn.**
4. On each `<task-notification>`, marks the TODO completed, checks what's newly unblocked, spawns the next wave.

The coordinator never waits — it runs briefly, reactively, on each notification.

## Install

```bash
pi install npm:pi-mono-team-mode
# or load locally
pi -e /path/to/pi-extensions/extensions/team-mode/index.ts
```

## Coordinator mode

Set `PI_TEAM_MATE_COORDINATOR=1` on the pi session you want to act as coordinator:

```bash
PI_TEAM_MATE_COORDINATOR=1 pi
```

This injects the coordinator system prompt at every turn via the `before_agent_start` hook. The prompt teaches the LLM the `<task-notification>` flow, the delegation discipline, and the "synthesize — don't hand off understanding" rule lifted straight from Claude Code.

## Teammate specs

Drop a markdown file into `.pi/teammates/<role>.md` (or `.claude/teammates/<role>.md`):

```markdown
---
name: reviewer
description: reviews diffs for bugs and style violations
modelTier: deep
thinkingLevel: high
tools: read, bash, grep
---

You are a careful code reviewer. ...
```

Frontmatter fields: `name`, `description`, `needsWorktree`, `hasMemory`, `modelTier`, `thinkingLevel`, `tools` (comma-separated). The body becomes the teammate's system prompt. The Claude Code teammate addendum (`send_message` instructions) is prepended automatically.

## Model and thinking selection

`agent(...)` and each `delegate` task accept both `model` and `thinking` (`thinking_level` is accepted as an alias):

```ts
agent({
  description: "review diff",
  prompt: "Review the current branch",
  subagent_type: "reviewer",
  model: "deep",
  thinking: "high",
});
```

## Direct model mentions

Use `@@model` in the editor to delegate a prompt directly to one or more selected models:

```text
@@claude-sonnet-4-5 review current changes
@@gpt-5.4 what do you think about the proposal above?
```

An `@@model` mention selects a worker model; it does not classify the task. The parent orchestrator interprets the request using its full conversation, generates a self-contained prompt with the relevant context, execution boundaries, and expected output, and launches the selected worker. Worker prompts omit the routing mention and prohibit recursive delegation. This keeps references such as “the last message” and “above” meaningful without treating words such as `review` as repository-specific instructions.

Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Team-mode passes the selected level to the teammate subprocess as `pi --thinking <level>`. Token budgets remain pi's responsibility via `~/.pi/agent/settings.json` `thinkingBudgets`.

`model-config.json` defines provider catalogs plus role/tier defaults. Schema v2 accepts an ordered array of model entries per tier:

```jsonc
{
  "version": 2,
  "provider": "auto",
  "defaultTier": "md",
  "providers": {
    "openai-codex": {
      "xs": [{ "model": "openai-codex/gpt-5.3-codex", "effort": "medium" }],
      "md": [
        {
          "model": "openai-codex/gpt-5.6-terra",
          "effort": "medium",
          "weight": 3
        },
        { "model": "openai-codex/gpt-5.5", "effort": "high", "weight": 1 }
      ]
    },
    // v1 strings remain valid and can be mixed with v2 arrays.
    "anthropic": {
      "md": "anthropic/claude-sonnet-4-6"
    }
  },
  "tiers": {
    "xs": { "name": "Extra Small", "thinkingLevel": "minimal" },
    "sm": { "name": "Small", "thinkingLevel": "low" },
    "md": { "name": "Medium", "thinkingLevel": "medium" },
    "lg": { "name": "Large", "thinkingLevel": "high" },
    "xl": { "name": "Deep", "thinkingLevel": "xhigh" }
  },
  "roles": {
    "researcher": "sm",
    "docs": "xs",
    "backend": "md",
    "frontend": "md",
    "tester": "md",
    "planner": "lg",
    "reviewer": "md"
  }
}
```

Each v2 entry supports:

- `model` (required): fully-qualified `provider/model` ID.
- `effort` or `thinkingLevel`: aliases using `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `provider`: optional provider override; otherwise the model prefix is used.
- `weight`: positive round-robin weight; defaults to `1`.
- `enabled`: set to `false` to retain an entry without selecting it.

Multiple enabled entries form both a process-lifetime weighted round-robin pool and an ordered fallback chain. Each spawn rotates the primary according to weight. If that model fails before producing assistant output or starting a tool, team-mode tries the remaining entries in rotated order. A working fallback is persisted for durable teammates so `send_message` resumes with it. Aborted or active runs are not retried.

The `version` field is explicit in v2 configs; when omitted, team-mode infers v1 or v2 from the catalog shape. Built-in catalogs and v1 string tiers remain supported, and v1 strings can be mixed with v2 arrays in the same catalog. Legacy `roleTiers`, `tierThinkingLevels`, and `roleThinkingLevels` also remain supported.

Thinking resolution order is: explicit tool `thinking`, teammate spec `thinkingLevel`, v2 entry `effort`/`thinkingLevel`, legacy `roleThinkingLevels`, tier metadata (`tiers[tier].thinkingLevel`), a legacy `:<thinking>` model suffix such as `gpt-5.4:high`, legacy `tierThinkingLevels`, then `defaultThinkingLevel`. If none applies, pi inherits its normal default.

## Execution runtimes

`agent` and `delegate` accept an explicit `runtime` selector:

```ts
agent({
  description: "quick summary",
  prompt: "Summarize README.md",
  runtime: "transient",
});

delegate({
  runtime: "transient",
  tasks: [
    { description: "scan docs", prompt: "Find docs gaps" },
    { description: "scan tests", prompt: "Find missing coverage" },
  ],
});
```

- `runtime: "subprocess"` (default): durable, resumable workers backed by `pi --session`; supports `send_message`, names, teams, worktree isolation, background notifications, transcripts, and persistent records.
- `runtime: "transient"`: fast one-shot in-process `createAgentSession()` runs; returns output directly to the current tool call; does not create teammate records, cannot be resumed, and does not share the parent LLM context window.

Transient prompts must be fully self-contained. They only share the parent Node.js process/runtime infrastructure, not the coordinator conversation. Initial transient mode rejects `isolation: "worktree"`, `run_in_background: true`, `team_name`, and `name` because those imply durable teammate semantics.

Use transient mode for quick disposable research/summarization fan-out. Use subprocess mode for implementation work, resumable teammates, background work, worktrees, or anything that needs a stable `task_id` for later `send_message`.

## Storage

```
~/.pi/agent/extensions/team-mode/
├── model-config.json                            # provider/tier/role + taskCompletedHook
├── teammates/<agent-id>/record.json
├── teammates/<agent-id>/sessions/<id>.jsonl     # pi --session target
├── teams/<team-id>/record.json
├── tasks/<parent-session-id>/<task-id>.json     # shared TODO list
└── runtime/<parent-session-id>/index.json       # teammate name → agent-id
```

Override with `PI_TEAM_MATE_STORAGE_ROOT` for tests.

## Quality gates

Add to `model-config.json`:

```jsonc
{ "taskCompletedHook": "pnpm test --run" }
```

When a task transitions to `completed`, the hook runs in the task's cwd. Non-zero exit reverts the task to `failed` and attaches hook output (stdout + stderr, first 8 KB) to `result`. 2-minute timeout. Stale PID-based lock files are auto-recovered after 10 s.

## Concurrency model

- Each task is its own file under `tasks/<parent-session-id>/<task-id>.json`.
- `task_update` takes an exclusive filesystem lock (`<task-id>.lock` via `open(..., "wx")`) and bumps a CAS `version` counter.
- Stale locks (>10 s) are reclaimed automatically — safe across teammate subprocesses.

## Delegate groups + live progress

- `delegate({ tasks: [...] })` runs bounded parallel workers and returns aggregated output blocks.
- `delegate({ task, chain: [...] })` runs sequential chains with `{task}`, `{previous}`, `{chain_dir}` substitution and optional inner `parallel` fan-out.
- Per-step `output` and `reads` let chain steps exchange large artifacts through files in `{chain_dir}`.
- Parallel caps: `PI_TEAM_MATE_MAX_PARALLEL` (default `8`) and `PI_TEAM_MATE_PARALLEL_CONCURRENCY` (default `4`).
- Live TUI widget now renders a multi-line **● Agents** panel (spinner, turns/tool-uses/tokens/elapsed, activity hint, queued tail).
- `<task-notification>` messages are rendered as styled completion boxes (status glyph, counters, duration, transcript path).

## Slash commands & keybinding

- `/teammate list | status <name> | stop <name>`
- `/team list | create <name> | delete <id>`
- `/tasks list | show <id> | clear`
- **Ctrl+Shift+T** — show the shared task list (pi's built-in Ctrl+T toggles thinking blocks)

## Differences from Claude Code (honest)

- **Broadcast `to: "*"`** is not implemented. Swarm/persistent teammate pattern with mailboxes isn't needed for the one-shot worker model; each `send_message` resumes a teammate via `pi --session`, but injecting into an actively-running worker turn is not supported.
- **Tool restriction in coordinator mode** is prompt-only, not enforced. Claude Code's coordinator mode actually strips Bash/Edit/Write from the tool pool; pi's extension API doesn't expose tool removal from the main session. The coordinator prompt tells the LLM not to use those tools, but the LLM could still call them.
- **`TaskOutput` on a running worker** returns the teammate's last-saved record, not live stdout streaming. Completed workers return their final message faithfully.

## Tests

```bash
cd extensions/team-mode
npm test
```
