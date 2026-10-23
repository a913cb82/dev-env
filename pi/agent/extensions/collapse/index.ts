// Collapse tool calls and thinking blocks into one-line rows — only while
// "Thinking blocks: hidden" is on. Flipping thinking to visible restores
// the stock tool sections (same chrome as expanded view); the toggle is
// read live from settings, so new renders follow it immediately.
//
// Adjacent tool calls share ONE component (the run's first tool owns the
// trace), so Pi emits a single leading blank line for the whole run instead
// of one per tool. Runs continue across turn boundaries: only a turn whose
// visible content (prose or a thinking block) renders above its tools starts
// a new run, so consecutive tool-only turns stay gapless. Clicking a row
// toggles just that row (registry expansion + per-row mouse regions);
// Pi-level expand shows every row.
//
// a row just opens it. Every row rests as a one-liner, in both Pi modes:
// a click shows the stock cell at the depth Pi currently asks for — the
// stock COLLAPSED cell while Pi is collapsed (ctrl+o off), the stock
// EXPANDED cell while Pi is expanded. Toggling ctrl+o re-depths already
// opened rows without another click. Clicking an opened row closes it.
//
// Each tool renders its own single row with no box, background, or indent
// (renderShell "self", like the built-in edit tool):
//   › read /path/to/file:10-20                          5.3k ch
//   › $ timeout 25 ls some/dist                         0.1k ch
// (›, not >: the row is a marker, not a prompt.)
// with the tool head bold violet (red when the tool failed), the read
// directory grey, the file name bold, the line range red, and the output size
// grey and right-aligned. Violet (not just weight) carries the head because
// some terminals render SGR-1 bold indistinguishably. Expanded view (ctrl+e)
// keeps the stock section, re-boxed in Pi's chrome
// (self-shell tools render bare, so the Box is rebuilt for default-shell
// tools); failed results keep the built-in rendering. Thinking blocks keep Pi's
// hidden label, updated per turn to a grey preview with its size:
//   about something rea…lots of thoughts were here. 1.5k ch
// Long rows truncate in the middle (head and tail survive); the count is
// always preserved at the right edge.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, MouseRegion, sliceByColumn, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  extractThinkingText,
  findLatestThinkingText,
  firstWord,
  formatCharCount,
  hasLeadingVisibleContent,
  lsParts,
  readLineParts,
  searchParts,
  splitDirBase,
  summarizeBashCommand,
  textCharCount,
  thinkingLabelForWidth,
} from "./logic.js";

const COUNT_GAP = 2;

/** Bump when the loaded code changes; reported by /collapse. */
const COLLAPSE_REVISION = 18;

/** Compact one-line rows only make sense in the hidden-thinking workflow:
 *  when thinking blocks are visible the transcript goes back to stock tool
 *  sections. Read live (per render) so the visibility toggle takes effect
 *  on the next update without a reload. Fail open: when the setting is
 *  unreadable, render stock. */
function isHiddenThinking(pi: ExtensionAPI): boolean {
  try {
    return (pi?.getSettings?.()?.hideThinkingBlock ?? false) === true;
  } catch {
    return false;
  }
}

function compactView(pi: ExtensionAPI, expanded: unknown): boolean {
  if (expanded) return false;
  return isHiddenThinking(pi);
}

/** Tool instances known to collapse, for visibility-toggle pokes. The toggle
 *  re-renders thinking blocks but explicitly skips tool components, so
 *  settled rows would stay stale without a poke through their invalidators.
 *  (No toggle event exists, hence the poll below.) Cleared on session_start. */
const collapsePoke = new Set<object>();
let collapseSawUI = false;
let collapseLastHidden: boolean | undefined;
const POLL_SLOT = "__collapsePollTick";

/** One poll tick: if the thinking-visibility setting flipped since the last
 *  tick, invalidate every known tool so it re-renders in the other mode. */
function collapseTick(pi: ExtensionAPI): void {
  try {
    if (!collapseSawUI) return;
    const hidden = (pi?.getSettings?.()?.hideThinkingBlock ?? false) === true;
    if (collapseLastHidden === undefined || hidden === collapseLastHidden) {
      collapseLastHidden = hidden;
      return;
    }
    collapseLastHidden = hidden;
    for (const state of collapsePoke) {
      try {
        (state as { collapseInvalidate?: () => void }).collapseInvalidate?.();
      } catch {
        // One dead component must not block the rest.
      }
    }
  } catch {
    // Cosmetic only; never break the loop.
  }
}

/** Pi's message indent (Text outputPad), read live per render/event.
 *  Takes pi explicitly — activations stay self-contained (no module state). */
function liveOutputPad(pi: ExtensionAPI): number {
  try {
    const pad = pi?.getSettings?.()?.outputPad;
    return pad === 0 ? 0 : 1;
  } catch {
    return 1;
  }
}

/** Middle-truncate styled text to a visible width: keep the head and the
 *  tail around "…" (end truncation would eat the file name / command
 *  tail that identifies the row). Falls back to a plain slice when the
 *  budget is too small for both sides. */
function truncateMiddleWidth(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth < 4) return sliceByColumn(text, 0, Math.max(0, maxWidth));
  const keep = maxWidth - 1;
  const start = Math.ceil(keep / 2);
  const end = keep - start;
  return `${sliceByColumn(text, 0, start)}…${sliceByColumn(text, visibleWidth(text) - end, end)}`;
}

interface CollapseState {
  count?: number;
}

/** Renderer-owned slots. Pi passes our own previous output back as
 *  lastComponent — feeding that into the stock renderers (which reuse it as
 *  a Text via setText) crashes them into the bare fallback from the second
 *  update on. These slots keep a clean reuse chain for the stock
 *  components, plus the shared box. */
interface CollapseSlots extends CollapseState {
  collapseCall?: Component;
  collapseResult?: Component;
  collapseBox?: Box;
  collapseInvalidate?: () => void;
}

/** Register a tool instance for visibility-toggle pokes (see collapsePoke). */
function trackCollapse(state: CollapseSlots, context: any): void {
  collapsePoke.add(state);
  if (typeof context?.invalidate === "function") state.collapseInvalidate = context.invalidate;
}

/** One entry in a same-turn tool trace. The entry doubles as the stock
 *  renderers' state object, so their component-reuse chains stay clean
 *  (see CollapseSlots). */
interface TraceEntry extends CollapseSlots {
  id: string;
  runId: number;
  toolName: string;
  original: any;
  args: any;
  argsJson?: string;
  expanded: boolean;
  isError: boolean;
  isPartial: boolean;
  executionStarted: boolean;
  argsComplete: boolean;
  hasResult: boolean;
  result?: any;
}

/** Adjacent same-turn tool calls, rendered as one component so Pi emits a
 *  single leading blank line for the whole run instead of one per tool.
 *  The FIRST tool of each run owns the trace (stable position); later tools
 *  render nothing. Keyed by toolCallId; only live-observed tools join, so
 *  history can never teleport (unregistered tools fall back to single rows). */
const traceEntries = new Map<string, TraceEntry>();
const traceRuns = new Map<number, string[]>();
const traceOwnerPoke = new Map<number, () => void>();
let traceRunId = 0;
const TRACE_SLOT = "__collapseTraceReset";

/** True while the transcript is being rebuilt from history (startup and
 *  compaction). Nothing separates those messages, so merging would stack
 *  every past tool call into the oldest row's slot (rows teleport). During
 *  the build each tool gets its own run — history keeps its per-tool gaps,
 *  and live turns below it merge as usual. */
let traceHistoryPhase = true;

/** Message sequence for the "visible content already split this turn" guard. */
let messageSeq = 0;
let visibleBumpSeq = -1;

/** A new transcript block starts: the next tool begins a fresh run.
 *  The reason is kept for `/collapse`: when rows show an unexpected gap,
 *  the report says exactly which boundary split them. */
const boundaryReasons: string[] = [];
function traceBoundary(reason = "?") {
  traceRunId++;
  boundaryReasons.push(`${reason}#${traceRunId}`);
  if (boundaryReasons.length > 8) boundaryReasons.shift();
  return reason;
}

function traceReset(): void {
  traceEntries.clear();
  traceRuns.clear();
  traceOwnerPoke.clear();
  boundaryReasons.length = 0;
  traceRunId++;
  traceHistoryPhase = false;
}

function traceOwnerId(runId: number): string | undefined {
  return traceRuns.get(runId)?.[0];
}

function tracePokeOwner(runId: number): void {
  try {
    traceOwnerPoke.get(runId)?.();
  } catch {
    // Cosmetic only.
  }
}

/** First render wins: registration order is transcript order. Returns
 *  undefined for tools that must not join traces (unknown names). Syncing
 *  happens separately so first contact always counts as a change. */
function traceUpsert(toolName: string, toolCallId: unknown, original: any): TraceEntry | undefined {
  if (typeof toolCallId !== "string" || !toolCallId || !makeLeftByName[toolName]) return undefined;
  let entry = traceEntries.get(toolCallId);
  if (!entry) {
    entry = {
      id: toolCallId,
      runId: traceRunId,
      toolName,
      original,
      args: undefined,
      rowOpen: false,
      isError: false,
      isPartial: false,
      executionStarted: false,
      argsComplete: false,
      hasResult: false,
    };
    traceEntries.set(toolCallId, entry);
    const run = traceRuns.get(entry.runId) ?? [];
    run.push(toolCallId);
    traceRuns.set(entry.runId, run);
    // Rebuilding from history: one run per tool (see traceHistoryPhase).
    if (traceHistoryPhase) traceRunId++;
  }
  return entry;
}

/** Sync live fields into the entry. Returns true when anything observable
 *  changed (so the owner knows to repaint). Poke only on change: poking
 *  unconditionally would invalidate -> re-render -> poke forever. */
function traceSync(
  entry: TraceEntry,
  args: any,
  context: any,
  count?: number,
  result?: unknown,
): boolean {
  let changed = false;
  const sig = JSON.stringify(args ?? null);
  if (entry.argsJson !== sig) {
    entry.argsJson = sig;
    entry.args = args;
    changed = true;
  }
  const flags = {
    isError: !!context?.isError,
    isPartial: !!context?.isPartial,
    executionStarted: !!context?.executionStarted,
    argsComplete: !!context?.argsComplete,
  };
  for (const key of Object.keys(flags) as (keyof typeof flags)[]) {
    if (entry[key] !== flags[key]) {
      (entry as any)[key] = flags[key];
      changed = true;
    }
  }
  // Counts also flow through each tool's own renderer state (set by its
  // result slot), so rows stay live even before a result sync lands.
  const syncedCount = count ?? (context?.state as { count?: number } | undefined)?.count;
  if (syncedCount !== undefined && entry.count !== syncedCount) {
    entry.count = syncedCount;
    changed = true;
  }
  if (result !== undefined && !entry.hasResult) {
    entry.hasResult = true;
    entry.result = result;
    changed = true;
  } else if (result !== undefined) {
    entry.result = result;
  }
  return changed;
}

/** Single collapsed row: styled summary left, char count right-aligned.
 *  Fills to width-outputPad, not width: thinking rows are indented by
 *  Pi's outputPad, so their counts end at W-pad — ending tool rows there
 *  too keeps both counts on the same column. */
class CollapsedLine implements Component {
  constructor(
    private left: string,
    private right: string,
    private pad = 1,
  ) {}

  render(width: number): string[] {
    const target = Math.max(8, width - this.pad);
    const prefix = "› ";
    const prefixWidth = visibleWidth(prefix);
    const rightWidth = visibleWidth(this.right);
    const leftWidth = visibleWidth(this.left);
    let left = this.left;
    const available = target - prefixWidth - rightWidth - COUNT_GAP;
    if (available >= 4 && leftWidth > available) {
      left = truncateMiddleWidth(this.left, available);
    }
    const gap = this.right ? Math.max(1, target - prefixWidth - visibleWidth(left) - rightWidth) : 0;
    return [`${prefix}${left}${" ".repeat(gap)}${this.right}`];
  }

  invalidate(): void {}
}

function countSuffix(theme: Theme, state: CollapseState): string {
  if (state?.count == null) return "";
  return theme.fg("dim", formatCharCount(state.count));
}

function toolHead(theme: Theme, label: string, isError: boolean): string {
  // NB: theme.style, not theme.bold — theme.bold goes through chalk, whose
  // own color detection can be level 0 (no output) while Pi's pipeline still
  // emits colors. style() uses the same pipeline as theme.fg(). Accent
  // carries the head for terminals that render SGR-1 weight indistinguishably.
  return isError
    ? theme.style(label, { fg: "error", bold: true })
    : theme.style(label, { fg: "accent", bold: true });
}

function readLeft(theme: Theme, args: any, isError: boolean): string {
  const parts = readLineParts(args ?? {});
  const dir = parts.dir ? theme.fg("dim", parts.dir) : "";
  const base = parts.base ? theme.style(parts.base, { bold: true }) : "";
  const range = parts.range ? theme.fg("error", parts.range) : "";
  return `${toolHead(theme, "read ", isError)}${dir}${base}${range}`;
}

function pathLeft(theme: Theme, name: string, rawPath: unknown, isError: boolean): string {
  const { dir, base } = splitDirBase(typeof rawPath === "string" ? rawPath : "");
  const dirStyled = dir ? theme.fg("dim", dir) : "";
  const baseStyled = base ? theme.style(base, { bold: true }) : "";
  return `${toolHead(theme, `${name} `, isError)}${dirStyled}${baseStyled}`;
}

function shellLeft(theme: Theme, prompt: string, args: any, isError: boolean): string {
  const summary = summarizeBashCommand(typeof args?.command === "string" ? args.command : "");
  const head = firstWord(summary);
  // VAR=value prefixes: highlight only the variable name, not the assignment.
  const eq = head.indexOf("=");
  const headName = eq > 0 ? head.slice(0, eq) : head;
  const headSuffix = eq > 0 ? head.slice(eq) : "";
  const rest = head ? summary.slice(head.length) : summary;
  const headStyled = summary
    ? toolHead(theme, `${prompt} ${headName}`, isError)
    : toolHead(theme, `${prompt} `, isError) + theme.fg("dim", "…");
  const timeout =
    typeof args?.timeout === "number" ? theme.fg("dim", ` (timeout ${args.timeout}s)`) : "";
  return `${headStyled}${headSuffix}${rest}${timeout}`;
}

function searchLeft(theme: Theme, name: string, args: any, isError: boolean): string {
  const parts = searchParts(args ?? {});
  const pattern = parts.pattern ? theme.style(parts.pattern, { bold: true }) : theme.fg("dim", "…");
  const scope = parts.path ? ` ${theme.fg("dim", parts.path)}` : "";
  return `${toolHead(theme, `${name} `, isError)}${pattern}${scope}`;
}

function lsLeft(theme: Theme, args: any, isError: boolean): string {
  const { path } = lsParts(args ?? {});
  const dir = path ? theme.fg("dim", path) : theme.fg("dim", ".");
  return `${toolHead(theme, "ls ", isError)}${dir}`;
}

/** Summary builders by tool name, for trace rows owned by another tool. */
const makeLeftByName: Record<string, (theme: Theme, args: any, isError: boolean) => string> = {
  read: readLeft,
  bash: (t, a, e) => shellLeft(t, "$", a, e),
  powershell: (t, a, e) => shellLeft(t, "PS>", a, e),
  edit: (t, a, e) => pathLeft(t, "edit", a?.path, e),
  write: (t, a, e) => pathLeft(t, "write", a?.path, e),
  grep: (t, a, e) => searchLeft(t, "grep", a, e),
  find: (t, a, e) => searchLeft(t, "find", a, e),
  ls: lsLeft,
};

/** Stock content for one opened trace row, boxed like Pi's own section. The
 *  row's own original renderers run against its own persistent state, so
 *  reuse chains (bash timers, edit previews) behave exactly as stock. */
function buildOpenedRow(
  entry: TraceEntry,
  theme: Theme,
  ownerCtx: any,
  expanded: boolean,
): Component {
  const needsBox = (entry.original.renderShell ?? "default") !== "self";
  const fake = {
    ...ownerCtx,
    args: entry.args,
    state: entry,
    lastComponent: entry.collapseCall,
    isPartial: entry.isPartial,
    isError: entry.isError,
    executionStarted: entry.executionStarted,
    argsComplete: entry.argsComplete,
    expanded,
    invalidate: () => tracePokeOwner(entry.runId),
  };
  const callInner =
    entry.original.renderCall(entry.args, theme, fake) ?? new Text("", 0, 0);
  entry.collapseCall = callInner;
  if (!needsBox) return callInner;
  const box = stockBox(theme, entry, entry.isPartial, entry.isError);
  box.clear();
  box.addChild(callInner);
  if (entry.hasResult) {
    const resultInner =
      entry.original.renderResult(
        entry.result,
        { expanded, isPartial: entry.isPartial },
        theme,
        { ...fake, lastComponent: entry.collapseResult },
      ) ?? new Text("", 0, 0);
    entry.collapseResult = resultInner;
    box.addChild(resultInner);
  }
  return box;
}

/** One component for a whole run. Every row rests as a one-liner; a row
 *  opened by a click shows its stock cell at the depth Pi currently asks
 *  for (collapsed cell while Pi is collapsed, expanded cell while Pi is
 *  expanded). The region handles the click, so Pi's own toggle never fires
 *  for row clicks. */
function buildTrace(runId: number, theme: Theme, ownerCtx: any, pi: ExtensionAPI): Component {
  const trace = new Container();
  const piExpanded = !!ownerCtx?.expanded;
  for (const id of traceRuns.get(runId) ?? []) {
    const entry = traceEntries.get(id);
    if (!entry) continue;
    const makeLeft = makeLeftByName[entry.toolName];
    if (!makeLeft) continue;
    const row = entry.rowOpen
      ? buildOpenedRow(entry, theme, ownerCtx, piExpanded)
      : new CollapsedLine(makeLeft(theme, entry.args, entry.isError), countSuffix(theme, entry), liveOutputPad(pi));
    trace.addChild(
      new MouseRegion(row, (event: any) => {
        if (!event || event.type !== "click") return undefined;
        entry.rowOpen = !entry.rowOpen;
        tracePokeOwner(runId);
        return { handled: true };
      }),
    );
  }
  return trace;
}

/** Stock status background for an expanded box: pending while streaming,
 *  error on failure, success once settled. Mirrors ToolExecutionComponent. */
function statusBgFn(theme: Theme, isPartial: unknown, isError: unknown): (text: string) => string {
  if (isPartial) return (text) => theme.bg("toolPendingBg", text);
  if (isError) return (text) => theme.bg("toolErrorBg", text);
  return (text) => theme.bg("toolSuccessBg", text);
}

/** One shared Box per tool instance holding [call, result], exactly like
 *  Pi's stock contentBox: a single continuous section with no seam. Both
 *  wrappers mutate it in place during the same update pass (Pi always runs
 *  call before result). Reused across passes; bg follows the latest phase. */
function stockBox(theme: Theme, state: CollapseSlots, isPartial: unknown, isError: unknown): Box {
  let box = state.collapseBox;
  if (!box) {
    box = new Box(1, 1, statusBgFn(theme, isPartial, isError));
    state.collapseBox = box;
  }
  box.setBgFn(statusBgFn(theme, isPartial, isError));
  return box;
}

/** Wrap a built-in definition with collapsed renderers; expanded + errors
 *  keep stock content, re-boxed in Pi's chrome for default-shell tools. */
function collapseTool(
  original: any,
  makeLeft: (theme: Theme, args: any, isError: boolean) => string,
  pi: ExtensionAPI,
): any {
  // edit already draws its own framing (stock self shell): boxing it again
  // would double the chrome.
  const needsBox = (original.renderShell ?? "default") !== "self";
  return {
    ...original,
    // Self framing: no Box means no background, border, indent, or padding
    // gaps — the row stands alone like the built-in edit tool's rows.
    renderShell: "self" as const,
    renderCall(args: any, theme: Theme, context: any): Component {
      trackCollapse((context?.state ?? {}) as CollapseSlots, context);
      if (!isHiddenThinking(pi)) {
        // Visible thinking: stock sections per tool (expanded and collapsed
        // alike — compact rows only exist in hidden mode).
        const state = (context?.state ?? {}) as CollapseSlots;
        const inner =
          original.renderCall(args, theme, { ...context, lastComponent: state.collapseCall }) ??
          new Text("", 0, 0);
        state.collapseCall = inner;
        if (!needsBox) return inner;
        const box = stockBox(theme, state, context?.isPartial, context?.isError);
        box.clear();
        box.addChild(inner);
        if (state.collapseResult) box.addChild(state.collapseResult);
        return box;
      }
      const toolCallId = context?.toolCallId;
      const entry = traceUpsert(original.name, toolCallId, original);
      if (!entry) return new CollapsedLine(makeLeft(theme, args, !!context?.isError), countSuffix(theme, context?.state ?? {}), liveOutputPad(pi));
      const changed = traceSync(entry, args, context);
      if (traceOwnerId(entry.runId) !== entry.id) {
        if (changed) tracePokeOwner(entry.runId);
        return new Container();
      }
      if (typeof context?.invalidate === "function") traceOwnerPoke.set(entry.runId, context.invalidate);
      return buildTrace(entry.runId, theme, context, pi);
    },
    renderResult(result: any, options: any, theme: Theme, context: any): Component {
      trackCollapse((context?.state ?? {}) as CollapseSlots, context);
      if (!isHiddenThinking(pi)) {
        if (compactView(pi, options?.expanded) && !context?.isError) {
          const count = textCharCount(result?.content);
          const state = (context?.state ?? {}) as CollapseSlots;
          if (state.count !== count) {
            state.count = count;
            context?.invalidate?.();
          }
          return new Text("", 0, 0);
        }
        const state = (context?.state ?? {}) as CollapseSlots;
        const inner =
          original.renderResult(result, options, theme, { ...context, lastComponent: state.collapseResult }) ??
          new Text("", 0, 0);
        state.collapseResult = inner;
        if (!needsBox || compactView(pi, options?.expanded)) return inner;
        const box = stockBox(theme, state, options?.isPartial, context?.isError);
        box.clear();
        if (state.collapseCall) box.addChild(state.collapseCall);
        box.addChild(inner);
        return new Text("", 0, 0);
      }
      // Hidden thinking: trace mode. The owner's component draws every row;
      // this slot only syncs and stays empty.
      const toolCallId = context?.toolCallId;
      const entry = traceUpsert(original.name, toolCallId, original);
      const count = textCharCount(result?.content);
      const state = (context?.state ?? {}) as CollapseSlots;
      if (state.count !== count) state.count = count;
      const changed = entry ? traceSync(entry, context?.args, context, count, result) : false;
      if (changed) {
        context?.invalidate?.();
        if (entry && traceOwnerId(entry.runId) !== entry.id) tracePokeOwner(entry.runId);
      }
      return new Text("", 0, 0);
    },
  };
}

/** Live terminal width (tty only). */
function currentColumns(): number | undefined {
  return typeof process.stdout?.columns === "number" ? process.stdout.columns : undefined;
}

/** Raw material to rebuild the thinking label after a resize: the label is
 *  a plain string, so every width change needs a fresh budget + reissue.
 *  setHiddenThinkingLabel pushes the rebuild into all existing rows. */
const thinkingLive: { text?: string; ui?: any; width?: number } = {};
const RESIZE_SLOT = "__collapseResizeHandler";

/** One-line label sized to the live terminal, count pinned right. The label
 *  is a plain string (no render-time width), so budget up front from
 *  stdout.columns with a non-tty fallback. */
function widthAwareThinkingLabel(thinking: string, pi: ExtensionAPI): string {
  return thinkingLabelForWidth(thinking, currentColumns(), liveOutputPad(pi));
}

function applyThinkingLabel(
  thinking: string | undefined,
  ctx: any,
  setLast: (label: string) => void,
  pi: ExtensionAPI,
): void {
  if (ctx.hasUI) collapseSawUI = true;
  if (!thinking || !ctx.hasUI) return;
  try {
    const label = widthAwareThinkingLabel(thinking, pi);
    thinkingLive.text = thinking;
    thinkingLive.ui = ctx.ui;
    thinkingLive.width = currentColumns();
    setLast(label);
    ctx.ui.setHiddenThinkingLabel(label);
  } catch {
    // Label update is cosmetic; never break the turn.
  }
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  let lastThinkingLabel: string | undefined;
  try {
    collapseLastHidden = (pi?.getSettings?.()?.hideThinkingBlock ?? false) === true;
  } catch {
    collapseLastHidden = undefined;
  }

  // Rebuild the thinking label on terminal resize/zoom: tool rows re-render
  // at the new width on their own, but the label is a fixed string.
  // No unload hook exists, so the previous activation's listener is removed
  // via the shared slot before installing this one.
  try {
    const g = globalThis as Record<string, unknown>;
    const prev = g[RESIZE_SLOT];
    if (typeof prev === "function") process.stdout?.off?.("resize", prev as (...args: any[]) => void);
    const onResize = () => {
      try {
        const cols = currentColumns();
        if (cols === undefined || cols === thinkingLive.width) return;
        const { text, ui } = thinkingLive;
        if (!text || !ui?.setHiddenThinkingLabel) return;
        const label = thinkingLabelForWidth(text, cols, liveOutputPad(pi));
        thinkingLive.width = cols;
        lastThinkingLabel = label;
        ui.setHiddenThinkingLabel(label);
      } catch {
        // Cosmetic only; never break the loop.
      }
    };
    g[RESIZE_SLOT] = onResize;
    if (process.stdout?.isTTY && typeof process.stdout.on === "function") {
      process.stdout.on("resize", onResize);
    }
  } catch {
    // Non-tty hosts (tests, pipes): resizing cannot happen; skip silently.
  }

  pi.registerCommand("collapse", {
    description: "Show collapse extension status (proves this revision is loaded)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `collapse r${COLLAPSE_REVISION}: ${compactView(pi, false) ? "compact rows" : "stock sections"} (thinking ${compactView(pi, false) ? "hidden" : "visible"}); boundaries: ${boundaryReasons.join(" → ") || "none yet"}; thinking label: ${lastThinkingLabel ?? "default — no thinking text seen this session"}`,
      );
    },
  });

  pi.registerTool(collapseTool(createReadToolDefinition(cwd), readLeft, pi));
  pi.registerTool(collapseTool(createBashToolDefinition(cwd), (theme, args, isError) => shellLeft(theme, "$", args, isError), pi));
  pi.registerTool(collapseTool(createPowerShellToolDefinition(cwd), (theme, args, isError) => shellLeft(theme, "PS>", args, isError), pi));
  pi.registerTool(collapseTool(createEditToolDefinition(cwd), (theme, args, isError) => pathLeft(theme, "edit", args?.path, isError), pi));
  pi.registerTool(collapseTool(createWriteToolDefinition(cwd), (theme, args, isError) => pathLeft(theme, "write", args?.path, isError), pi));
  pi.registerTool(collapseTool(createGrepToolDefinition(cwd), (theme, args, isError) => searchLeft(theme, "grep", args, isError), pi));
  pi.registerTool(collapseTool(createFindToolDefinition(cwd), (theme, args, isError) => searchLeft(theme, "find", args, isError), pi));
  pi.registerTool(collapseTool(createLsToolDefinition(cwd), lsLeft, pi));

  // Visibility-toggle poller: no toggle event exists, and the toggle
  // skips tool components, so poll the setting and poke known tools.
  // No unload hook exists; the previous activation's timer is replaced via
  // the shared slot. Unref'd so it never holds the process open.
  try {
    const g = globalThis as Record<string, unknown>;
    const prev = g[POLL_SLOT];
    if (typeof prev === "object" && prev !== null) clearInterval((prev as { timer: unknown }).timer as any);
    const timer = setInterval(() => {
      if ((g[POLL_SLOT] as { timer?: unknown } | undefined)?.timer !== timer) {
        clearInterval(timer);
        return;
      }
      collapseTick(pi);
    }, 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
    g[POLL_SLOT] = { timer, tick: () => collapseTick(pi) };
  } catch {
    // Timers unavailable: renders still follow the setting, minus live pokes.
  }

  // Backfill from history: the newest text-bearing turn may predate this
  // extension load (or the latest turns may be encrypted), so scan the
  // branch on startup instead of waiting for a fresh text turn.
  (globalThis as Record<string, unknown>)[TRACE_SLOT] = () => {
    traceReset();
  };

  // A new transcript block starts a fresh tool run: a following tool must
  // not join the previous run's trace (its row would teleport). Boundaries:
  // turn/message ends, non-assistant messages, foreign tools, user bash,
  // compaction, and session start (which also drops dead registrations).
  const boundary = (reason: string) => traceBoundary(reason);
  pi.on("session_start", (_event, ctx) => {
    try {
      collapsePoke.clear();
      // History is rendered before this event; keep those entries so their
      // rows stay put, but seal the run so live tools start a fresh trace.
      traceHistoryPhase = false;
      traceBoundary("session-start");
      messageSeq++;
      visibleBumpSeq = -1;
      if (ctx.hasUI && ctx.ui) thinkingLive.ui = ctx.ui;
      const sm = ctx.sessionManager as any;
      const entries =
        typeof sm?.getBranch === "function" ? sm.getBranch() : (sm?.getEntries?.() ?? []);
      applyThinkingLabel(
        findLatestThinkingText(entries),
        ctx,
        (label) => {
          lastThinkingLabel = label;
        },
        pi,
      );
    } catch {
      // Label update is cosmetic; never break startup.
    }
  });

  pi.on("message_start", (event) => {
    try {
      // Any lifecycle event means the transcript is no longer being rebuilt.
      traceHistoryPhase = false;
      const role = (event as { message?: { role?: string } })?.message?.role;
      if (role !== "assistant") traceBoundary(`message:${role ?? "?"}`);
      else messageSeq++;
    } catch {
      // Cosmetic only.
    }
  });
  // A turn whose visible content (prose or a thinking block) renders above
  // its tool calls must start its own run: merging would lift those rows
  // above the content. Tool-only turns never split, so consecutive tool
  // calls stay gapless across turn boundaries. Content that only follows
  // the tools renders below the rows and changes nothing.
  pi.on("message_update", (event) => {
    try {
      // Guard first: this fires per streaming delta.
      if (visibleBumpSeq === messageSeq) return;
      const message = (event as { message?: unknown })?.message;
      if (!hasLeadingVisibleContent(message as { role?: unknown; content?: unknown })) return;
      visibleBumpSeq = messageSeq;
      traceBoundary("leading-content");
    } catch {
      // Cosmetic only.
    }
  });
  pi.on("tool_execution_start", (event) => {
    try {
      traceHistoryPhase = false;
      const name = (event as { toolName?: string })?.toolName;
      if (name && !makeLeftByName[name]) traceBoundary(`foreign-tool:${name}`);
    } catch {
      // Cosmetic only.
    }
  });
  pi.on("user_bash", () => traceBoundary("user-bash"));
  pi.on("session_compact", () => {
    // The chat is rebuilt from history right after this: treat the rebuild
    // as a history pass, then seal it so live turns merge again.
    traceBoundary("session-compact");
    traceHistoryPhase = true;
    try {
      const timer = setTimeout(() => {
        traceHistoryPhase = false;
        traceBoundary("history-sealed");
      }, 0);
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      traceHistoryPhase = false;
    }
  });
  pi.on("message_end", (event, ctx) => {
    // No boundary: a tool-only turn merges with the run above it. Turns
    // that do carry visible content split via message_update instead.
    applyThinkingLabel(
      extractThinkingText((event as { message?: unknown }).message as any),
      ctx,
      (label) => {
        lastThinkingLabel = label;
      },
      pi,
    );
  });
}
