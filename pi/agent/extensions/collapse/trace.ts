// Tool-run registry: which adjacent tool calls share one rendered component,
// and where runs are split. See index.ts for the behaviour this implements.
import type { Box, Component } from "@earendil-works/pi-tui";
import { hasLeadingVisibleContent, isVisibleMessage } from "./logic.js";

export interface CollapseState {
  count?: number;
}

/** Renderer-owned slots. Pi passes our own previous output back as
 *  lastComponent — feeding that into the stock renderers (which reuse it as
 *  a Text via setText) crashes them into the bare fallback from the second
 *  update on. These slots keep a clean reuse chain for the stock
 *  components, plus the shared box. */
export interface CollapseSlots extends CollapseState {
  collapseCall?: Component;
  collapseResult?: Component;
  collapseBox?: Box;
  collapseInvalidate?: () => void;
}

/** One entry in a same-turn tool trace. The entry doubles as the stock
 *  renderers' state object, so their component-reuse chains stay clean
 *  (see CollapseSlots). */
export interface TraceEntry extends CollapseSlots {
  id: string;
  runId: number;
  toolName: string;
  original: any;
  args: any;
  argsSig?: string;
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
// Nothing here is ever pruned, by design: buildTrace reads this registry at
// render time and the TUI re-renders every component on resize/zoom, so a
// dropped entry would blank a row that is still on screen. Size is therefore
// proportional to the transcript, not to elapsed time.
export const traceEntries = new Map<string, TraceEntry>();
export const traceRuns = new Map<number, string[]>();
export const traceOwnerPoke = new Map<number, () => void>();
let traceRunId = 0;

/** True while the transcript is being rebuilt from history (startup and
 *  compaction). Nothing separates those messages, so merging would stack
 *  every past tool call into the oldest row's slot (rows teleport). During
 *  the build each tool gets its own run — history keeps its per-tool gaps,
 *  and live turns below it merge as usual. */
let traceHistoryPhase = true;
let historyTimer: ReturnType<typeof setTimeout> | undefined;

/** Arm the history pass before Pi rebuilds the transcript (compaction,
 *  session switch/fork, tree navigation). The rebuild renders each tool from
 *  that branch's history; without this, ids the registry has never seen
 *  would all join the current run and stack into the first row's slot.
 *  Disarmed by the completion event, or by any live event, whichever first —
 *  with a timer as a backstop for aborted switches. */
export function armHistoryPhase(reason: string): void {
  traceBoundary(reason);
  traceHistoryPhase = true;
  if (historyTimer !== undefined) clearTimeout(historyTimer);
  try {
    historyTimer = setTimeout(() => {
      traceHistoryPhase = false;
      historyTimer = undefined;
    }, 5000);
    (historyTimer as unknown as { unref?: () => void }).unref?.();
  } catch {
    // No timers: the completion/live events still disarm it.
  }
}

/** Message sequence for the "visible content already split this turn" guard. */
let messageSeq = 0;
let visibleBumpSeq = -1;

/** Row/runs summary for `/collapse`: how many rows the newest run holds, and
 *  how many runs are live. A gap between rows means two runs, so this says
 *  whether the rows you are looking at were ever merged. */
export function traceSummary(): string {
  const runs = [...traceRuns.entries()].filter(([, ids]) => ids.length > 0);
  if (runs.length === 0) return "trace: empty";
  const newest = runs.reduce((a, b) => (a[0] >= b[0] ? a : b));
  return `trace: newest run #${newest[0]} has ${newest[1].length} row(s); ${runs.length} run(s) live`;
}

/** A new transcript block starts: the next tool begins a fresh run.
 *  The reason is kept for `/collapse`: when rows show an unexpected gap,
 *  the report says exactly which boundary split them. */
export const boundaryReasons: string[] = [];
export function traceBoundary(reason = "?") {
  traceRunId++;
  boundaryReasons.push(`${reason}#${traceRunId}`);
  if (boundaryReasons.length > 8) boundaryReasons.shift();
  return reason;
}

/** Test-only: clear registry state so a render test starts from a known
 *  world. Exported as a module symbol (not a global) — production code never
 *  calls it. */
export function resetTraceState(): void {
  traceEntries.clear();
  traceRuns.clear();
  traceOwnerPoke.clear();
  plannedRunById.clear();
  boundaryReasons.length = 0;
  traceRunId++;
  traceHistoryPhase = false;
}

/** History runs planned at session_start (see planToolRuns in logic): the
 *  rebuild rendered one run per tool before this event, so merge each
 *  contiguous group into one run here. Every component repaints from this
 *  registry, so the next frame shows the same gapless layout live turns
 *  get. Groups never span visible content, so no row moves above its own
 *  context. Entries the planner could not place keep single-row runs. */
const plannedRunById = new Map<string, number>();

export function applyPlannedRuns(groups: string[][]): void {
  plannedRunById.clear();
  const byId = new Map(traceEntries);
  const planned = new Set<string>();
  traceRuns.clear();
  traceOwnerPoke.clear();
  for (const group of groups) {
    const ids = group.filter((id) => byId.has(id));
    if (ids.length === 0) continue;
    traceRunId++;
    const runId = traceRunId;
    for (const id of ids) {
      byId.get(id)!.runId = runId;
      planned.add(id);
      plannedRunById.set(id, runId);
    }
    traceRuns.set(runId, [...ids]);
  }
  for (const [id, entry] of byId) {
    if (planned.has(id)) continue;
    traceRunId++;
    entry.runId = traceRunId;
    traceRuns.set(entry.runId, [id]);
  }
  // traceRunId always names the run the next tool joins: leave it on a fresh
  // run, or the first live tool would collide into the last history run.
  traceRunId++;
}

export function traceOwnerId(runId: number): string | undefined {
  return traceRuns.get(runId)?.[0];
}

export function tracePokeOwner(runId: number): void {
  try {
    traceOwnerPoke.get(runId)?.();
  } catch {
    // Cosmetic only.
  }
}

/** First render wins: registration order is transcript order. Only wrapped
 *  built-in tools reach this (custom/MCP tools keep their own renderers), so
 *  any call with an id joins a run. Syncing happens separately so first
 *  contact always counts as a change. */
export function traceUpsert(toolName: string, toolCallId: unknown, original: any): TraceEntry | undefined {
  if (typeof toolCallId !== "string" || !toolCallId) return undefined;
  let entry = traceEntries.get(toolCallId);
  if (!entry) {
    entry = {
      id: toolCallId,
      // Late render of a planned history tool (or a live tool reusing an
      // id): rejoin its run instead of starting a new one.
      runId: plannedRunById.get(toolCallId) ?? traceRunId,
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

/** Exact up to this many characters; beyond it only the head, the tail and
 *  the lengths are compared. A row is truncated in the middle, so a change
 *  deep inside a large argument cannot be displayed anyway. */
const EXACT_ARGS_CHARS = 4096;
const SIGNATURE_CHARS = 128;

/** Change detection for tool arguments. `JSON.stringify` was O(args) on
 *  every streaming delta — a `write` streaming a megabyte of content cost
 *  ~3.4ms per delta — and the only thing it bought was a repaint of a row
 *  whose visible head and tail had not changed. */
function argsSignature(args: any): string {
  try {
    if (args === null || typeof args !== "object") return JSON.stringify(args ?? null);
    const keys = Object.keys(args);
    let total = 0;
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string") total += value.length;
    }
    if (total <= EXACT_ARGS_CHARS) return JSON.stringify(args);
    let sig = "";
    for (const key of keys) {
      const value = args[key];
      sig +=
        typeof value === "string"
          ? `|${key}:${value.length}:${value.slice(0, SIGNATURE_CHARS)}:${value.slice(-SIGNATURE_CHARS)}`
          : `|${key}:${Array.isArray(value) ? `[${value.length}]` : typeof value}`;
    }
    return sig;
  } catch {
    return "?";
  }
}

export function traceSync(
  entry: TraceEntry,
  args: any,
  context: any,
  count?: number,
  result?: unknown,
): boolean {
  let changed = false;
  // Identity first: Pi hands the same args object back on every render pass,
  // so a re-render costs nothing. Serialize only when the object changed.
  if (entry.args !== args) {
    const sig = argsSignature(args);
    if (entry.argsSig !== sig) {
      entry.argsSig = sig;
      changed = true;
    }
    // Adopt the object either way: equal content renders the same, and the
    // identity check above then skips serializing on the next pass.
    entry.args = args;
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


/** The transcript is no longer being rebuilt: seal the run so live tools
 *  merge again, and start a fresh message sequence. */
export function endHistoryPhase(reason: string): void {
  traceHistoryPhase = false;
  traceBoundary(reason);
  messageSeq++;
  visibleBumpSeq = -1;
}

/** A message began. `isKnownTool` tells foreign tool calls (custom/MCP) from
 *  ours; those render outside the trace and therefore split it. */
export function traceOnMessageStart(event: unknown): void {
  try {
    // Any lifecycle event means the transcript is no longer being rebuilt.
    traceHistoryPhase = false;
    const message = (event as { message?: { role?: string; display?: unknown } })?.message;
    const role = message?.role;
    if (role === "assistant") {
      messageSeq++;
    } else if (role !== "toolResult" && isVisibleMessage(role, message?.display)) {
      // toolResult messages are not transcript blocks: they render inside the
      // tool component that produced them, so they never split a run. Neither
      // do messages that render nothing at all.
      traceBoundary(`message:${role ?? "?"}`);
    }
  } catch {
    // Cosmetic only.
  }
}

/** Streaming update: a turn whose visible content (prose or a thinking block)
 *  renders ABOVE its tool calls must start its own run, or merging would lift
 *  those rows above the content. Tool-only turns never split. Content that
 *  only follows the tools renders below the rows and changes nothing. */
export function traceOnMessageUpdate(event: unknown): void {
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
}

/** A tool started executing. Foreign tools (custom/MCP) render their own
 *  components, so a run must not span them. */
export function traceOnToolExecutionStart(event: unknown, isOwnTool: (name: string) => boolean): void {
  try {
    traceHistoryPhase = false;
    const name = (event as { toolName?: string })?.toolName;
    if (name && !isOwnTool(name)) traceBoundary(`foreign-tool:${name}`);
  } catch {
    // Cosmetic only.
  }
}
