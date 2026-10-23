// Row painting: one collapsed line per tool, and the stock cell a row opens
// into. Everything here is pure rendering plus the trace registry.
import { Box, Container, MouseRegion, sliceByColumn, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  firstWord,
  genericToolSummary,
  formatCharCount,
  lsParts,
  readLineParts,
  searchParts,
  splitDirBase,
  summarizeBashCommand,
  textCharCount,
} from "./logic.js";
import { isHiddenThinking, liveOutputPad } from "./settings.js";
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

/** Row text for a tool that ships no collapse renderer (extension tools,
 *  MCP tools): the tool name plus the best argument it has. */
function genericLeft(theme: Theme, name: string, args: any, isError: boolean): string {
  const summary = genericToolSummary(args);
  // No summarizable argument (check_subagents {wait} and friends): the name
  // alone is the row. A "…" placeholder would read as truncated content.
  if (!summary) return toolHead(theme, name, isError);
  return `${toolHead(theme, `${name} `, isError)}${theme.fg("dim", summary)}`;
}

/** Row text for any tool: the hand-tuned renderer when we have one, the
 *  generic summary otherwise. */
function makeLeftFor(
  name: string,
  theme: Theme,
  args: any,
  isError: boolean,
): string {
  const known = makeLeftByName[name];
  return known ? known(theme, args, isError) : genericLeft(theme, name, args, isError);
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
    const row = entry.rowOpen
      ? buildOpenedRow(entry, theme, ownerCtx, piExpanded)
      : new CollapsedLine(makeLeftFor(entry.toolName, theme, entry.args, entry.isError), countSuffix(theme, entry), liveOutputPad(pi));
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
      ((args: any, theme: Theme) =>
        new Text(genericLeft(theme, name, args, false), 0, 0)),
    renderResult:
      original.renderResult ??
      ((result: any, options: any) => {
        if (!options?.expanded) return new Text("", 0, 0);
        return new Text(textOf(result), 0, 0);
      }),
  };
  const wrapped = collapseTool(
    withRenderers,
    (theme: Theme, args: any, isError: boolean) => makeLeftFor(name, theme, args, isError),
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
    .join("\n");
}
