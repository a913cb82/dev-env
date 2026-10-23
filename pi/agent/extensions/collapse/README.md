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
rebuilt on terminal resize.

Custom and MCP tools are untouched: they keep their own renderers.

## Diagnostics

`/collapse` reports the loaded revision, the mode, the newest run's row count,
recent run boundaries, and the current thinking label. If rows show an
unexpected gap, the boundary list names what split them.

## Layout

| File | Responsibility |
| --- | --- |
| `index.ts` | registration, events, poller, thinking label |
| `rows.ts` | row painting, the stock cell a row opens, tool wrappers |
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
