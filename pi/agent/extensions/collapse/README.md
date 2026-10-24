# collapse

Compacts Pi's transcript into one-line tool rows and a one-line thinking
preview. Active only while **Thinking blocks: hidden** is on (`ctrl+t`).

```
▏read /home/abrai/dev-env/src/app.ts:10-20          5.3k ch
▏$ timeout 25 ls some/dist                          0.1k ch
▏grep flushTimers src/                              1.2k ch
```

Three levels, one meaning each:

- **Bold** is identity — the tool name (violet, red when the tool failed), and
  each command word of a `bash`/`powershell` row: the first word after the
  start, `;`, `&`, `&&`, `||`, or `|`. The prompt itself (`$`, `PS>`) is the
  tool, so it keeps the violet accent.
- **Plain** is the one specific thing the row acts on — file name, search
  pattern, path leaf, bare argument, the text inside quotes.
- **Dim** is everything else — directories, operators,
  flags, numbers, `$VAR` expansions, line ranges, timeouts, output sizes
  (right-aligned), and the summary of any tool without a dedicated renderer.

```
▏read /a/b.txt:5-10                                5.3k ch
▏$ cd /path/to/thing && cat > /tmp/real/thing | tail -n 3   0.8k ch
```

`bash`/`powershell` rows are tokenized rather than styled by position:
`cd /path/to/thing && cat > /tmp/real/thing` reads as **`cd`**, dim
`/path/to/`, `thing`, dim `&&`, **`cat`**, dim `>`, dim `/tmp/real/`,
`thing`. Quoted operators are not syntax, and a mid-command `>` only dims —
it never promotes the following word to a command. Styling stops at 192
tokens / 2048 characters (the row can never show more), so a pathological
command cannot slow a repaint.

Long rows cut in the middle, so the head and the count survive.

Every row's first glyph lands on column 2 — the same column as Pi's prose
(`outputPad`), hidden-thinking rows (`Text` pad) and stock tool cells
(`Box(1, 1)`). Column 1 carries a single dim cell rule (`▏`) with no space
after it, so it costs no width and the content still starts on column 2. A
run of rows therefore reads as one block — a continuous left margin, like a
blockquote — and a row still expands into its stock cell without its text
moving sideways.

Tool rows draw the rule themselves (dim, in their own line). Thinking rows
are Pi's `Text`, so the rule replaces that row's pad cell at render time
(instance-only shadow, current label only, fail-open): same width, label
still on column 2, and the rule takes the row's own style — Pi styles the
whole label with `thinkingText`, so the margin stays visually even. Rows
carrying Pi's OSC 133 marks keep them. With `outputPad = 0` no rule is
drawn: content already starts on column 1, and a rule would push it out of
alignment.

## Behaviour

**One component per run.** Adjacent tool calls share a single component, so Pi
emits one blank line per run instead of one per tool. A run continues across
turn boundaries; only a turn whose *visible* content (prose or a thinking
block) renders above its tools starts a new one. Rows therefore stay adjacent
to whatever is actually on screen, and consecutive tool-only turns are
gapless.

**Render wrap.** The run owner's component still carries Pi's hardcoded
leading blank line, which no renderer can suppress — so the extension shadows
the instance's `render` (drop a single leading `""`) and `handleMouse`
(re-base y by +1, matching Pi's y-1 delegation). The strip is conditional:
it applies only when the previous sibling renders a hidden thinking label
(or is another tool row) with nothing else between — after prose, or as a
first child, the blank is kept byte-identical, and clicks on a kept blank
keep stock hit behavior. Only the run owner is ever wrapped; foreign tools,
default-shell components, and visible-thinking mode are skipped, and visible
mode self-bypasses inside the wrapped render, so toggling thinking visible
restores stock spacing with no unwrap pass.

**Spacer surgery.** Mirror image below the block: when an assistant row whose
first rendered line is a thinking run — collapsed or expanded — opens
directly under a tool row, its leading `Spacer(1)` is removed via public
`removeChild` on its `contentContainer`. Prose-first rows, non-tool predecessors, and visible
thinking (which renders `Markdown`, failing the label check) are never
touched — a visibility toggle rebuilds the children and self-heals. Both
directions are pure tree structure, evaluated per render, so a sibling
streaming from thinking into prose flips the verdict live. Convergence is
immediate, not polled: the walker factory schedules a pass for the tick
right after the capturing render commits (post-reload rows settle in
milliseconds), and every thinking row carries an `updateContent` shadow
that re-heals its spacer synchronously after Pi's own rebuilds
(streaming deltas, click-toggles). No Pi sources
are touched and no prototype is modified. `/collapse` reports
`wrap: N wrapped, M spacers dropped`.

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
`ToolExecutionComponent` (pinned by tests, `edit` included).

An opened row runs the tool's own call *and* result renderers even for
self-shell tools. That is not optional: Pi's renderers can be stateful
across the pair — `edit` writes its diff into the call component stashed in
`context.state` from inside `renderResult`, whose own output is usually
empty. Skipping the result renderer would leave an expanded `edit` row as a
bare header with no diff.

**Thinking-row detach (opt-in experiment, default off).** Pi's thinking row is
unconditional given visible thinking, so the only way to merge thinking into
the gapless tool block is to detach the whole assistant component via the
public `removeChild` — no message edits, no patching. Enable with
`COLLAPSE_HIDE_THINKING=1`. Two rules keep it safe: the SAFE predicate
(`isSafeToDetach`, a mirror of Pi's own renderer — no text, all runs hidden,
clean stop, has tools) means a detach never hides anything but hidden-label
rows; and the replacement preview row (first row of the trace, click to
expand the full stashed text) renders iff the detach is confirmed — a miss
degrades to the stock Pi row, never a duplicate. Detach runs on
`message_end` / `turn_end` / `session_start` (history backfill) plus the
1-second poll tick, which heals any rebuild path within a second. Messages
are never edited, so history, replay, compaction, and reload backfill keep
full reasoning. `/collapse` reports `hidden: N run(s)`.

**Thinking label.** Per row, via a tree walk — never the global setter.
Pi's `setHiddenThinkingLabel` applies one string to every assistant row, so
the extension does not call it at all. Instead it walks the public TUI tree
(from the widget factory handle) and sets each thinking row's *own* label
from its *own* message, on `message_start` / `message_end` /
`tool_execution_start` / `turn_end` / `session_start` (history backfill).
Reconciling is idempotent: a row already labeled for its current message is
skipped, and a clobbered row heals on the next pass. If the tree shape ever
stops matching, the walk bails silently and rows keep Pi's stock
`Thinking...`; `/collapse` reports `thinking walk: active (N row(s))` or the
inactive reason. (The pure preview helpers stay in `logic.ts`, tested.)

The count is not italic. Pi renders the label as
`theme.italic(theme.fg("thinkingText", label))` — the whole string — so the
extension ends the italic run from inside the label, just before the count.
`SGR 23` cannot do that job: Pi's italic is chalk, and chalk 6 rewrites every
copy of its own close code in its input into close+open, which re-enables the
italic immediately. The label therefore uses `SGR 23;23` — the same attribute
twice, which chalk does not recognise as a close, which terminals apply left
to right, and which leaves the foreground colour alone. Escape bytes add no
visible width, so right alignment is unchanged. `tests/pi-internals.test.sh`
pins both the Pi wrapper and chalk's rewrite, so a change on either side fails
the test instead of silently bringing the italic back.

The label is sized from `process.stdout.columns` and carries its width in the
per-row cache, so the first poll after a resize rebuilds it. The one-column
margin above is what keeps the gap between a resize and that poll invisible.

**Live preview while thinking.** The label is also written on
`message_update`, so the preview (and its char count) grows as the model
thinks instead of flashing stock `Thinking...` until the turn settles. Rows
are matched by their own `isStreaming` flag, not by event identity: an
extension handler can run before interactive-mode applies the delta, so the
row's message is then one delta behind the event's, and an identity check
would never match (leaving the stock label up for the whole thinking
phase). The label is computed from the row's own message for the same
reason. Writes happen inline and again from the deferred pass (which runs
after the event chain, when the row already holds the delta), so event
ordering cannot defeat it, and they are throttled to ~10/s per row so the
row is not rebuilt on every token. Pi renders no thinking region at all
until a block has non-empty text, so there is no pre-text window that would
need a placeholder. Labels written while streaming are not cached, so the
settle pass always recomputes the final count; `/collapse` reports the live
write count.

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
recent run boundaries, the current thinking label, and the render-wrap status.
If rows show an unexpected gap, the boundary list names what split them.

## Layout

| File | Responsibility |
| --- | --- |
| `index.ts` | registration, events, poller, thinking label |
| `rows.ts` | row painting, the stock cell a row opens, tool wrappers, the opt-in slot for foreign tools |
| `trace.ts` | run registry, boundaries, history phase, diagnostics |
| `settings.ts` | read-live Pi settings (`hideThinkingBlock`, `outputPad`, columns) |
| `labels.ts` | tree-walk per-row thinking labels (settle + live preview), walker widget, reconcile |
| `detach.ts` | opt-in thinking-row detach (env-gated experiment, default off) |
| `wrap.ts` | per-instance render wrap deleting the run owner's leading blank |
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
