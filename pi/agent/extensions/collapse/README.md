# collapse

Compacts Pi's transcript into one-line tool rows and a one-line thinking
preview. Active only while **Thinking blocks: hidden** is on (`ctrl+t`).

```
› read /home/abrai/dev-env/src/app.ts:10-20            5.3k ch
› $ timeout 25 ls some/dist                            0.1k ch
› grep flushTimers src/                                1.2k ch
```

Head is bold violet (red when the tool failed), directory grey, file name
bold, line range red, output size grey and right-aligned. Long rows cut in
the middle, so the head and the tail survive and the count stays at the right
edge.

## Behaviour

**One component per run.** Adjacent tool calls share a single component, so Pi
emits one blank line per run instead of one per tool. A run continues across
turn boundaries; only a turn whose *visible* content (prose or a thinking
block) renders above its tools starts a new one. Rows therefore stay adjacent
to whatever is actually on screen, and consecutive tool-only turns are
gapless.

**Transcript rebuilds are safe.** Startup, compaction, session switch, fork and
tree navigation re-render history. During a rebuild each historical tool gets
its own run, so old rows never move; live turns below resume merging.

**Click depth.** Rows always rest as one-liners. Clicking a row opens its stock
cell at the depth Pi currently asks for:

| Pi (ctrl+o) | At rest | After click |
| --- | --- | --- |
| collapsed | one-liner | stock collapsed cell |
| expanded | one-liner | stock expanded cell |

Toggling `ctrl+o` re-depths an open row without another click; clicking it
again closes it. Both depths are byte-identical to a real
`ToolExecutionComponent` (pinned by tests).

**Thinking label.** Pi's hidden label becomes a grey preview with its size,
rebuilt on terminal resize. Repeating the same preview is a no-op: Pi's label
is one string applied to every assistant row, so re-setting it re-renders the
whole transcript. A terminated stream leaves one assistant message per
attempt, each drawing its own thinking line and error text; the preview string
is shared, so those lines read alike. That repetition comes from Pi's
transcript, not from this extension.

**Any tool, not just the built-ins.** Tools from other extensions and MCP
servers render through the same row pipeline as soon as they hand over their
definition. Pi's public tool listing exposes only metadata (name, description,
schema), never `execute` or the renderers, so collapse cannot take a foreign
tool over by itself. The owner opts in with one line at registration:

```ts
const wrap = (globalThis as any).__collapseWrapTool;
pi.registerTool(typeof wrap === "function" ? wrap(definition) : definition);
```

`subagents` does exactly this, so `spawn_agent`, `check_subagents`,
`send_to_subagent` and `cancel_subagent` collapse like `read` or `bash`.
A definition without renderers gets synthesized ones: the row shows the tool
name plus its most telling argument (`name`, `description`, `command`, `path`,
`prompt`, ... in that order), and the expanded cell shows the plain result
text. Definitions with their own renderers keep them, wrapped in the shared
chrome. `/collapse` lists any tool that never opted in.

## Diagnostics

`/collapse` reports the loaded revision, the mode, the newest run's row count,
recent run boundaries, and the current thinking label. If rows show an
unexpected gap, the boundary list names what split them.

## Layout

| File | Responsibility |
| --- | --- |
| `index.ts` | registration, events, poller, thinking label |
| `rows.ts` | row painting, the stock cell a row opens, tool wrappers, the opt-in slot for foreign tools |
| `trace.ts` | run registry, boundaries, history phase, diagnostics |
| `settings.ts` | read-live Pi settings (`hideThinkingBlock`, `outputPad`, columns) |
| `logic.ts` | pure helpers (summaries, truncation, label sizing) |

Registry entries are never pruned: `buildTrace` reads them at render time and
the TUI re-renders every component on resize, so dropping one would blank a row
still on screen. Size is proportional to the transcript.

## Tests

```
node logic.test.cjs      # pure helpers
node collapse.test.cjs   # renderers, trace behaviour, click depth, diagnostics
```

Both run on plain Node via `jiti`, with the installed Pi bundle aliased; no
network and no real terminal required.
