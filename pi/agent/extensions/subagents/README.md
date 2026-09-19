# pi-subagents

Recursive, isolated, asynchronous subagents for the [Pi coding agent](https://github.com/earendil-works/pi).

`pi-subagents` adds background delegation to Pi without external npm dependencies. Spawn several focused agents in parallel, let agents recursively delegate their own work, watch outstanding subagents in Pi's footer, and collect their results when they finish.

Based on [`williamcr01/pi-subagents`](https://github.com/williamcr01/pi-subagents) (MIT, © William Crona) — see LICENSE. This fork adds targeted/quorum checks, steer/follow-up messaging, and transcript resume.

## Features

- **Asynchronous spawning** — `spawn_agent` returns immediately while the child runs in its own Pi process and session.
- **Recursive delegation** — children can create grandchildren within the configured depth budget.
- **Parallel work** — concurrency is configurable, including unlimited mode with `maxConcurrency: -1`.
- **Status footer** — a passive footer lists outstanding subagents with model and live activity; a line disappears once its result is read.
- **Targeted checks and quorum waits** — `check_subagents` checks all descendants or a named subset, and can block until any or all of them finish.
- **Steering and follow-ups** — send a steering message to redirect a running child, or a follow-up to queue behind its work; messaging a finished or cancelled child restarts it from its transcript in a fresh process.
- **Automatic delivery** — finished results arrive with the next completed parent tool result. An idle parent receives one batch and resumes. `check_subagents` can collect pending results explicitly.
- **Cancellation** — abort a child's current turn by run ID, session ID, or name; its process is stopped and a later message resumes it from its transcript.
- **No added dependencies** — uses Pi's extension and TUI APIs plus Node.js built-ins.

## Install

The repo is a pi package: one command installs the extension and the skill.

```sh
# local dev (path-based; edits apply on /reload — no copy)
pi install /path/to/pi-subagents

# or from git (durable, for other machines)
pi install git:git@github.com:a913cb82/pi-subagents.git
```

Install at **user level** (no `-l`): subagents spawn children that load global extensions. Restart pi (or `/reload`).

This version requires Pi 0.85.0 or newer.

## Usage

Once installed, Pi automatically loads the extension. Ask Pi to delegate work, or use the tools directly:

```text
spawn_agent({
  task: "Inspect the authentication flow and report security risks",
  name: "auth-reviewer",
  cwd: ".",
  tools: ["read", "grep"]
})
```

Use `check_subagents` to check progress, narrow to specific children, or wait for results:

```text
check_subagents({ wait: true, timeoutMs: 120000 })
check_subagents({ targets: ["auth-reviewer", "test-runner"], wait: true, mode: "any" })
```

Use `send_to_subagent` to steer a running child or continue a finished or cancelled one. Use `cancel_subagent` to abort a child's current turn. Both accept a full run ID, a unique run-ID prefix (including the eight characters shown in tool output), a session ID, or an exact name. Exact matches take precedence over prefixes; ambiguous targets are rejected with full run IDs for disambiguation.

## Isolation model

Each child has a separate Pi process and session, but it is not an OS sandbox. Children use the same user account, filesystem permissions, environment, and installed extensions as the parent.

A trusted parent passes project approval only when the child's canonical working directory remains inside the parent's canonical directory. A symlink that points outside that tree does not inherit approval, so Pi evaluates trust for the target directory normally.

In TUI mode a passive footer lists the subagents whose results the parent has not read yet (running children, plus finished ones with an outstanding report). Control flow is the tools, not the UI: steer with `send_to_subagent`, stop with `cancel_subagent`.

## Tools

### `spawn_agent`

Start an isolated child in the background. It returns immediately, so continue other work while the child runs.

```text
spawn_agent({
  task: "Inspect the authentication flow and report security risks",
  name: "auth-reviewer",
  cwd: ".",
  tools: ["read", "grep"]
})
```

Optional fields are `name`, `cwd`, `model`, `thinking`, and an exact `tools` allowlist. Model selection is resolved as:

1. Per-spawn `model`
2. `defaultModel` in configuration
3. The creating agent's active model

Omitting `model` (and the `defaultModel` fallback) never fails the scope check: the child inherits the creating agent's active model even when that model sits outside Pi's `--models`/`enabledModels` scope. An **explicitly** requested `model` must be inside the scope. The scope and its pinned thinking levels are passed to the child; a pin is applied as the child's `--thinking` value, and an explicit `thinking` that disagrees with the pin is rejected. An empty scope keeps Pi's unrestricted model behavior.

Omitting `tools` copies the creating session's active tool set. An explicit list can only remove tools from that set, and `tools: []` starts the child with `--no-tools`. Include `spawn_agent` to allow recursive delegation. A child receives it automatically only when `spawn_agent` is active in the parent and `tools` is omitted or explicitly includes it.

Thinking level follows the same precedence and is clamped to the selected child model.

### `check_subagents`

Inspect descendants and collect newly finished results without repeating results already delivered. Each ancestor sees a descendant execution once, without claiming the direct parent's result. `targets` narrows the check to a named subset:

```text
check_subagents({ wait: true, timeoutMs: 120000 })
check_subagents({ targets: ["auth-reviewer", "test-runner"], wait: true, mode: "any" })
```

Each target is an exact name, run id, unique run-id prefix, or session id; unknown or ambiguous targets are rejected. `wait: true` blocks until the selected subagents finish: `mode: "all"` (default) waits for every one, `mode: "any"` returns on the first. `timeoutMs` defaults to 30 seconds, is capped at 300 seconds, and is only a maximum; omitted `targets` watches every descendant.

### `send_to_subagent`

Send a steering message (default) or a follow-up message to a child by exact name, run ID, unique run-ID prefix, or session ID. `mode: "steer"` redirects the child's current work (delivered before its next LLM call); `mode: "followUp"` queues behind the current work until it finishes. Both use pi's native steering/follow-up queueing while the child streams, and start a new turn when it is idle:

```text
send_to_subagent({ target: "auth-reviewer", message: "Focus on the token refresh path." })
send_to_subagent({ target: "auth-reviewer", message: "When done, also audit the logout flow.", mode: "followUp" })
```

Works on running, finished, AND cancelled direct children — messaging a finished or cancelled child resumes it from its transcript in a fresh process as a new execution (which takes the creator's concurrency slot). Finished child processes are reaped on settle, so resume costs one process start. Messaging is parent → direct child only: a deeper descendant is reached through its own parent.

### `cancel_subagent`

Abort a child's current turn by exact name, run ID, or session ID:

```text
cancel_subagent({ target: "auth-reviewer" })
```

Cancellation stops the child process (no idle pi lingers), so `send_to_subagent` resumes a cancelled child from its transcript exactly like a finished one. Session shutdown still terminates everything still running.

## Result delivery

While the parent works, finished child reports stay in the registry until a completed parent tool result or `check_subagents` consumes them. Automatic delivery appends reports to the tool output without steering the parent or skipping sibling tool calls. If the parent becomes idle first, it receives the pending reports in one message that starts a new turn.

If a child completes several follow-ups before the parent consumes its report, only the latest execution is delivered. Earlier output remains available in the child's session file.

## Cost accounting

Each session's `$` meter shows its own spend plus its entire subtree: every parent tool result carries its direct children's unreported cost deltas (full token breakdown, grandchildren included by summation), reported exactly once across reloads and forks. Spend accrued after the session's final tool call is never metered; the registry (`usage` per run file) stays the exact audit source.

## Configuration

Global settings live at `~/.pi/agent/subagents.json`. A trusted project's `<configDir>/subagents.json` (`.pi` by default; Pi's `CONFIG_DIR_NAME`) can override them for that project.

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "defaultThinking": "medium",
  "maxDepth": 4,
  "maxConcurrency": -1
}
```

All fields are optional. Defaults are `maxDepth: 2` and `maxConcurrency: 4`.

- `defaultModel` — fallback model for spawns that omit `model`.
- `defaultThinking` — fallback thinking level for spawns that omit `thinking`.
- `maxDepth` — maximum recursive depth. The root is depth `0`; `maxDepth: 0` disables spawning. Descendants inherit the root limit and may only tighten it.
- `maxConcurrency` — number of children allowed to run at once per creating session. Use `-1` for unlimited or a positive integer for a limit; extra children queue automatically. Resuming a finished child waits for the creator's slot; steering a running child does not require another slot.
- `rpcMaxLineChars` — defensive limit per child stdout JSONL record, default `67108864` (64 Mi UTF-16 code units, including an optional trailing CR but excluding LF). Must be a positive safe integer; there is no unlimited mode.
- `pruneDeliveredAfterDays` (default `14`) / `pruneDeliveredKeep` (default `50`) — rotation for delivered terminal runs: older than N days go, newest K are always kept.
- `pruneUndeliveredAfterDays` (default `30`, `0` disables) / `pruneUndeliveredKeep` (default `500`, `0` disables) — rotation for terminal runs whose result was never collected. A terminal result older than the threshold has no live claimant left, so reaping it is safe. The count cap only takes runs older than 7 days, so a burst of fresh uncollected results is never trimmed.

The `--subagent-depth N` Pi flag overrides configured depth for the tree; descendants inherit that override rather than reapplying file limits. Without a flag override, explicit global or trusted-project depth settings may tighten the inherited limit. Built-in defaults never tighten an inherited limit. An explicit descendant `--subagent-depth N` may also tighten the limit and overrides file limits for its subtree. No descendant can raise an inherited limit.

## Footer

While subagents are outstanding, a passive footer lists them, indented by depth:

```text
● auth-reviewer · openai-codex/gpt-5.5 · running grep
  ● sub-scanner · openai-codex/gpt-5.5 · thinking
● test-runner · openai-codex/gpt-5.5 · running npm test
```

A child disappears the moment its result is read by its direct parent — delivered on the next tool result, in the idle batch, or by `check_subagents`. Grandchildren disappear when *their* parent reads them, not when the root inspects them. There is no interactive panel or transcript viewer: use `check_subagents` and the child's session file for history.

## Registry maintenance

Run records accumulate in `~/.pi/agent/subagents/runs/`. On every session start the extension prunes terminal runs: delivered ones older than `pruneDeliveredAfterDays` (default 14, always keeping the newest `pruneDeliveredKeep`, default 50), and undelivered ones older than `pruneUndeliveredAfterDays` (default 30, `0` disables) or beyond the newest `pruneUndeliveredKeep` (default 500, `0` disables; the cap never takes runs younger than 7 days). Running children, queued work, and young undelivered results are never pruned. Marker sidecars of pruned runs — and orphan markers whose record is already gone — go with them. Hot paths (footer ticks, tool results, waits) share one mtime-guarded scan per registry state instead of re-reading every file, so steady-state overhead is a single directory stat.

## Development

The extension is plain TypeScript loaded directly by Pi. The regression suite uses a local fake Pi child and makes no API calls:

```sh
npm install
npm test
```

Source files live in `extensions/subagents`, organized by responsibility:

- `index.ts` — Pi registration, lifecycle hooks, tools, delivery, and UI wiring
- `config.ts` — settings validation and precedence
- `registry.ts` — atomic run records
- `wait.ts` — event-driven wait for descendant completion (`check_subagents` wait:true)
- `spawn-agent.ts` — RPC process control, concurrency, cancellation, and depth enforcement
- `events.ts` — child JSON event parsing and status updates
- `widget.ts` — passive footer listing unread/unfinished descendants

## License

[MIT](LICENSE) — upstream © William Crona; see LICENSE.
