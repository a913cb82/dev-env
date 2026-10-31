// Row painting: one collapsed line per tool, and the stock cell a row opens
// into. Everything here is pure rendering plus the trace registry.
import { Box, Container, MouseRegion, sliceByColumn, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { keyHint, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { ROW_RAIL, argsTextChars, bashSegments, extraArgPairs, fallbackArgsText, formatCharCount, genericToolRow, labelBudget, lsParts, previewLines, readLineParts, searchParts, splitDirBase, summarizeBashCommand, textCharCount, type BashSegment, type GenericPair } from "./logic.js";
import { currentColumns, isHiddenThinking, liveOutputPad } from "./settings.js";
import {
  isRunHidden,
  isRunThinkingOpen,
  runThinkingText,
  thinkingRowPreview,
  toggleRunThinking,
} from "./detach.js";
import {
  traceEntries,
  traceOwnerId,
  traceOwnerPoke,
  tracePokeOwner,
  traceRuns,
  traceSync,
  traceUpsert,
  type CollapseSlots,
  type TraceEntry,
} from "./trace.js";

const COUNT_GAP = 2;

/** Working-spinner quantum: Pi Loader's own 80ms cadence and braille frames.
 *  Same speed, arbitrary phase — see the note on breatheFrame. */
export const BREATHE_MS = 80;
/** Frame at a given moment: absolute wall-clock grid, no epoch, no tracking.
 *  Phase lockstep with Pi's Working spinner was tried across r66-r72 and
 *  abandoned: the tick phase is not observable through the extension API,
 *  run-boundary events do not fire reliably in harness-driven flows (so no
 *  anchor survives a session), and render-load jitter scatters the repaint
 *  phases a tracker would need. Same glyphs at the same cadence, each
 *  spinner on its own phase — occasionally aligned, never wrong-speed. */
export function breatheFrame(nowMs: number = Date.now()): number {
  if (nowMs < 0) return 0;
  return Math.floor(nowMs / BREATHE_MS) % WHEEL_FRAMES.length;
}
/** Working wheel for live rows: Pi Loader's braille frames, accent, fixed
 *  width so the count never shifts. Shape motion carries the animation. */
export const WHEEL_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export function breatheWheel(nowMs?: number): string {
  return WHEEL_FRAMES[breatheFrame(nowMs)]!;
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

/** Single collapsed row: styled summary left, char count right-aligned.
 *  Fills to width-outputPad, not width: thinking rows are indented by
 *  Pi's outputPad, so their counts end at W-pad — ending tool rows there
 *  too keeps both counts on the same column. */
export class CollapsedLine implements Component {
  constructor(
    private left: string,
    private right: string,
    private pad = 1,
    private theme?: Theme,
    private live = false,
  ) {}

  /** Column 1 carries the rail — or the wheel while live. With no pad
   *  the row starts at column 1 (stock cell with outputPad=0), so neither
   *  is drawn there: content must never shift sideways. */
  private prefix(): string {
    const pad = " ".repeat(Math.max(0, this.pad));
    if (this.pad < 1) return pad;
    const glyph = this.live ? breatheWheel() : ROW_RAIL;
    const color = this.live ? "accent" : "dim";
    return (this.theme ? this.theme.fg(color, glyph) : glyph) + pad.slice(1);
  }

  render(width: number): string[] {
    // The thinking label is sized from the terminal columns, but Pi can hand
    // a component a width one column narrower. Both counts must land on the
    // same column, so derive the target from the SAME source the label uses
    // (labelBudget: pad + (cols-1-2*pad) is the label's last column), and
    // clamp to the render width so a narrower host never overflows.
    const cols = currentColumns();
    const target = Math.max(8, Math.min(width, (cols ?? width) - 1 - this.pad));
    // No trailing space after the rail: it occupies column 1 alone, so the
    // first content glyph still lands on column 2 — the column Pi's prose
    // (outputPad), hidden-thinking rows (Text pad) and stock tool cells
    // (Box(1, 1)) start on. A row therefore expands into its stock cell
    // without its text moving sideways, and the repeated rail groups a run.
    const prefix = this.prefix();
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
  // Three-level ramp: bold = identity (the tool), plain = the one specific
  // thing acted on, dim = everything else (dirs, ranges, sizes).
  const base = parts.base ?? "";
  const range = parts.range ? theme.fg("dim", parts.range) : "";
  return `${toolHead(theme, "read ", isError)}${dir}${base}${range}`;
}

function pathLeft(theme: Theme, name: string, rawPath: unknown, isError: boolean): string {
  const { dir, base } = splitDirBase(typeof rawPath === "string" ? rawPath : "");
  const dirStyled = dir ? theme.fg("dim", dir) : "";
  return `${toolHead(theme, `${name} `, isError)}${dirStyled}${base}`;
}

function renderBashSegment(theme: Theme, segment: BashSegment): string {
  switch (segment.kind) {
    case "space":
      return " ";
    case "op":
    case "dim":
      return theme.fg("dim", segment.text);
    case "accent":
      return theme.style(segment.text, { fg: "accent", bold: true });
    case "cmd":
      return theme.style(segment.text, { bold: true });
    case "plain":
      return segment.text;
    case "path":
      return `${segment.dir ? theme.fg("dim", segment.dir) : ""}${segment.base}`;
  }
}

function shellLeft(theme: Theme, prompt: string, args: any, isError: boolean): string {
  const summary = summarizeBashCommand(typeof args?.command === "string" ? args.command : "");
  // The prompt is the tool: accent + bold, and nothing else. The command
  // words are bold, path leaves plain, and the syntax between them dim.
  const head = toolHead(theme, prompt, isError);
  const body = summary
    ? bashSegments(summary).map((segment) => renderBashSegment(theme, segment)).join("")
    : theme.fg("dim", "…");
  const timeout =
    typeof args?.timeout === "number" ? theme.fg("dim", ` (timeout ${args.timeout}s)`) : "";
  return `${head} ${body}${timeout}`;
}

function searchLeft(theme: Theme, name: string, args: any, isError: boolean): string {
  const parts = searchParts(args ?? {});
  const pattern = parts.pattern ? parts.pattern : theme.fg("dim", "…");
  const scope = parts.path ? ` ${theme.fg("dim", parts.path)}` : "";
  return `${toolHead(theme, `${name} `, isError)}${pattern}${scope}`;
}

function lsLeft(theme: Theme, args: any, isError: boolean): string {
  const { path } = lsParts(args ?? {});
  const dir = path ? theme.fg("dim", path) : theme.fg("dim", ".");
  return `${toolHead(theme, "ls ", isError)}${dir}`;
}

/** Truncate to a visible width, keeping the head (a pair's `key=` must
 *  survive; only its value may be cut). */
function truncateEndWidth(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth < 4) return sliceByColumn(text, 0, Math.max(0, maxWidth));
  return `${sliceByColumn(text, 0, maxWidth - 1)}…`;
}

/** Room for a row's left side: the same column arithmetic CollapsedLine
 *  uses, so the label and the count agree on the right edge. */
function rowBudget(pi: ExtensionAPI, count = ""): number {
  return Math.max(16, labelBudget(currentColumns(), liveOutputPad(pi)) - visibleWidth(count) - COUNT_GAP);
}

/** Append `pairs` after `head`, filling to `budget`: whole pairs while they
 *  fit, then the head of the next value (never mid-key); a three-character
 *  stub reads worse than an ellipsis, so stop short instead. `cut` reports
 *  that some of the pairs are not on the row. */
function fillPairs(
  theme: Theme,
  head: string,
  pairs: readonly GenericPair[],
  budget: number,
): { text: string; cut: boolean } {
  let text = head;
  let used = visibleWidth(text);
  for (const pair of pairs) {
    const plain = `${pair.key}=${pair.value}`;
    const width = visibleWidth(plain);
    if (used + 1 + width <= budget) {
      text += ` ${theme.fg("dim", plain)}`;
      used += 1 + width;
      continue;
    }
    const room = budget - used - 1;
    if (room >= 12) text += ` ${theme.fg("dim", truncateEndWidth(plain, room))}`;
    else if (used + 1 <= budget) text += theme.fg("dim", "…");
    return { text, cut: true };
  }
  return { text, cut: false };
}

/** Row text for a tool that ships no collapse renderer (extension tools,
 *  MCP tools): the argument that names the subject (plain), then every other
 *  argument as a dim `key=value` pair, filled to the row budget and cut at
 *  the end of the last value. */
function genericLeft(theme: Theme, name: string, args: any, isError: boolean, budget: number): string {
  const row = genericToolRow(args);
  const head = toolHead(theme, row.primary ? `${name} ` : name, isError);
  return fillPairs(theme, `${head}${row.primary}`, row.pairs, budget).text;
}

/** Row text for any tool: the hand-tuned renderer when we have one, the
 *  generic row otherwise. While a call is live, a hand-tuned row also streams
 *  the arguments its summary hides (`cut` says some did not fit). */
function makeLeftFor(
  name: string,
  theme: Theme,
  args: any,
  isError: boolean,
  budget: number,
  live = false,
): { text: string; cut: boolean } {
  const known = makeLeftByName[name];
  // Generic rows already carry every argument: nothing is hidden, so nothing
  // is cut.
  if (!known) return { text: genericLeft(theme, name, args, isError, budget), cut: false };
  const base = known(theme, args, isError);
  // A live row streams what its summary hides; a settled row keeps the calm
  // one-liner (the result count then says all there is to say).
  if (!live) return { text: base, cut: false };
  return fillPairs(theme, base, extraArgPairs(args, SHOWN_ARGS[name] ?? []), budget);
}

/** Summary builders by tool name, for trace rows owned by another tool. */
export const makeLeftByName: Record<string, (theme: Theme, args: any, isError: boolean) => string> = {
  read: readLeft,
  bash: (t, a, e) => shellLeft(t, "$", a, e),
  powershell: (t, a, e) => shellLeft(t, "PS>", a, e),
  edit: (t, a, e) => pathLeft(t, "edit", a?.path, e),
  write: (t, a, e) => pathLeft(t, "write", a?.path, e),
  grep: (t, a, e) => searchLeft(t, "grep", a, e),
  find: (t, a, e) => searchLeft(t, "find", a, e),
  ls: lsLeft,
};

/** The arguments each builtin summary already shows; everything else is a
 *  dim pair while the call is live. */
const SHOWN_ARGS: Record<string, readonly string[]> = {
  read: ["path", "file_path", "offset", "limit"],
  bash: ["command", "timeout"],
  powershell: ["command", "timeout"],
  edit: ["path"],
  write: ["path"],
  grep: ["pattern", "path"],
  find: ["pattern", "path"],
  ls: ["path"],
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
  if (!needsBox) {
    // Self-shell tools (edit) compose call and result inside Pi's own
    // container, and their renderers are STATEFUL ACROSS THE PAIR: edit's
    // renderResult writes the diff into the call component stashed in
    // context.state and rebuilds it (its own output is usually empty).
    // Skipping the result renderer therefore loses the diff entirely —
    // expanding shows a bare header.
    if (!entry.hasResult) return callInner;
    const resultInner =
      entry.original.renderResult(
        entry.result,
        { expanded, isPartial: entry.isPartial },
        theme,
        { ...fake, lastComponent: entry.collapseResult },
      ) ?? new Text("", 0, 0);
    entry.collapseResult = resultInner;
    const self = new Container();
    self.addChild(callInner);
    self.addChild(resultInner);
    return self;
  }
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
/** Right column while a call is live: the argument text written so far.
 *  Dim like settled counts — the wheel in column 1 is the live signal. */
export function liveCountSuffix(theme: Theme, chars: number): string {
  return chars > 0 ? theme.fg("dim", formatCharCount(chars)) : "";
}

function buildTrace(runId: number, theme: Theme, ownerCtx: any, pi: ExtensionAPI): Component {
  const trace = new Container();
  const piExpanded = !!ownerCtx?.expanded;
  // Replacement for a detached Pi thinking row (fail-open: renders only
  // when the detach pass confirmed this run's row is gone — a missed
  // detach degrades to the stock Pi row, never a duplicate).
  const hiddenThinking = isRunHidden(runId) ? runThinkingText(runId) : undefined;
  if (hiddenThinking) {
    const open = isRunThinkingOpen(runId);
    const thinkingRow = open
      ? new Text(hiddenThinking, liveOutputPad(pi), 0)
      : new CollapsedLine(thinkingRowPreview(theme, hiddenThinking), "", liveOutputPad(pi), theme);
    trace.addChild(
      new MouseRegion(thinkingRow, (event: any) => {
        if (!event || event.type !== "click") return undefined;
        toggleRunThinking(runId);
        tracePokeOwner(runId);
        return { handled: true };
      }),
    );
  }
  for (const id of traceRuns.get(runId) ?? []) {
    const entry = traceEntries.get(id);
    if (!entry) continue;
    const row = entry.rowOpen
      ? buildOpenedRow(entry, theme, ownerCtx, piExpanded)
      : (() => {
          // Live while Pi still streams (isPartial): partial renderResults
          // already carry output sizes, so count==null must NOT gate liveness.
          // The wheel in column 1 is the only live signal; counts stay dim.
          const live = entry.isPartial && !entry.isError;
          const count = countSuffix(theme, entry);
          // No result yet: the row streams the arguments its summary hides.
          // When they do not all fit, the right column says how much text the
          // model has written instead.
          const textChars = live ? argsTextChars(entry.args) : 0;
          let right = count;
          let left = makeLeftFor(entry.toolName, theme, entry.args, entry.isError, rowBudget(pi, right), live);
          if (live && left.cut && textChars > visibleWidth(left.text)) {
            const liveRight = liveCountSuffix(theme, textChars);
            if (liveRight) {
              right = liveRight;
              left = makeLeftFor(entry.toolName, theme, entry.args, entry.isError, rowBudget(pi, right), true);
            }
          }
          return new CollapsedLine(left.text, right, liveOutputPad(pi), theme, live);
        })();
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


/** Tool instances known to collapse, for visibility-toggle pokes. The toggle
 *  re-renders thinking blocks but explicitly skips tool components, so
 *  settled rows would stay stale without a poke through their invalidators.
 *  (No toggle event exists, hence the poll below.) Cleared on session_start. */
const collapsePoke = new Set<object>();
let collapseSawUI = false;
let collapseLastHidden: boolean | undefined;

/** Register a tool instance for visibility-toggle pokes (see collapsePoke). */
function trackCollapse(state: CollapseSlots, context: any): void {
  collapsePoke.add(state);
  if (typeof context?.invalidate === "function") state.collapseInvalidate = context.invalidate;
}

/** Wrap a built-in definition with collapsed renderers; expanded + errors
 *  keep stock content, re-boxed in Pi's chrome for default-shell tools. */
export function collapseTool(
  original: any,
  makeLeft: (theme: Theme, args: any, isError: boolean, budget: number) => string,
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
      if (!entry) {
        const live = !!context?.isPartial && !context?.isError;
        const right = countSuffix(theme, context?.state ?? {});
        return new CollapsedLine(makeLeft(theme, args, !!context?.isError, rowBudget(pi, right)), right, liveOutputPad(pi), theme, live);
      }
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
        // Visible thinking: stock sections, exactly as Pi renders them.
        // Compact rows only exist in hidden mode, so there is no collapsed
        // branch here.
        const state = (context?.state ?? {}) as CollapseSlots;
        const inner =
          original.renderResult(result, options, theme, { ...context, lastComponent: state.collapseResult }) ??
          new Text("", 0, 0);
        state.collapseResult = inner;
        if (!needsBox) return inner;
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


/** Drop stale registrations (session start): components from the previous
 *  session must not be poked. */
export function clearCollapsePokes(): void {
  collapsePoke.clear();
}

/** Invalidate every known tool: the visibility toggle changes the render mode
 *  but Pi only repaints assistant messages, so settled rows need a poke. */
export function pokeAllCollapse(): void {
  for (const state of collapsePoke) {
    try {
      (state as { collapseInvalidate?: () => void }).collapseInvalidate?.();
    } catch {
      // One dead component must not block the rest.
    }
  }
}

/** Names of extension/MCP tools that opted into collapsing. */
const wrappedNames = new Set<string>();

export function wrappedToolNames(): string[] {
  return [...wrappedNames];
}

/** Wrap a tool definition from any source (extension or MCP) so its calls
 *  collapse like the built-ins. Tools that ship no renderers of their own
 *  get synthesized ones: the generic summary as the call, the plain output
 *  text as the expanded result. */
export function collapseDefinition(original: any, pi: ExtensionAPI): any {
  if (!original || original.__collapseWrapped) return original;
  const name = String(original.name ?? "");
  wrappedNames.add(name);
  const withRenderers = {
    ...original,
    renderCall:
      original.renderCall ??
      ((args: any, theme: Theme, context: any) => fallbackCall(name, args, theme, !!context?.expanded)),
    renderResult:
      original.renderResult ??
      ((result: any, options: any, theme: Theme) => fallbackResult(result, theme, !!options?.expanded)),
  };
  const wrapped = collapseTool(
    withRenderers,
    (theme: Theme, args: any, isError: boolean, budget: number) =>
      makeLeftFor(name, theme, args, isError, budget).text,
    pi,
  );
  wrapped.__collapseWrapped = true;
  return wrapped;
}

/** Plain text of a tool result, for tools with no result renderer. */
function textOf(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .replace(/\r/g, "");
}

/** Pi's fallback call cell: the tool name and its arguments. Used only for
 *  tools that ship no renderers of their own, so their opened and visible
 *  cells stay stock. */
function fallbackCall(name: string, args: any, theme: Theme, expanded: boolean): Component {
  const head = theme.fg("toolTitle", theme.bold(name));
  const body = fallbackArgsText(args, expanded);
  if (!body) return new Text(head, 0, 0);
  return new Text(
    expanded ? `${head}\n${theme.fg("muted", body)}` : `${head} ${theme.fg("muted", body)}`,
    0,
    0,
  );
}

/** Pi's fallback result cell: the output text, previewed to ten lines until
 *  the cell is expanded. */
function fallbackResult(result: any, theme: Theme, expanded: boolean): Component {
  const text = textOf(result);
  if (!text) return new Text("", 0, 0);
  const { lines, remaining } = previewLines(text, expanded);
  let body = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
  if (remaining > 0) {
    body += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  }
  return new Text(body, 0, 0);
}
