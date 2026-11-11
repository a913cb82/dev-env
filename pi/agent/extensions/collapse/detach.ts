/** Detach-hiding of Pi thinking rows (collapse r27 experiment, now on by
 *  default; opt out with COLLAPSE_HIDE_THINKING=0).
 *
 * Pi's thinking row (spacer + label) is unconditional given visible thinking,
 * so the only way to merge thinking into our gapless tool block is to
 * detach the whole AssistantMessageComponent from the transcript tree via
 * the public removeChild — no message edits, no patching, nothing persisted.
 *
 * Safety comes from two rules. First, the SAFE predicate (isSafeToDetach in
 * logic.ts, a mirror of Pi's own updateContent): detach only when the
 * component renders nothing but hidden-thinking label rows. Second, the
 * fail-open coupling: our replacement preview row renders in the trace if
 * and only if the detach is confirmed for that message — a missed detach
 * degrades to the stock Pi row, never a duplicate.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractThinkingText, isSafeToDetach, thinkingPreview } from "./logic.js";
import { isDetachEnabled, isHiddenThinking } from "./settings.js";
import { isThinkingRow, walkerTui } from "./labels.js";
import { traceEntries, tracePokeOwner } from "./trace.js";

/** Entry ids whose thinking row is confirmed detached (history + adopted). */
const hiddenEntryIds = new Set<string>();

/** Live messages detached before persistence assigned an entry id. */
let liveHidden = new WeakSet<object>();

/** Full thinking text by entry id (history) for the replacement row. */
const entryThinking = new Map<string, string>();

/** Full thinking texts by trace run id for the replacement rows (a run can
 *  host several thinking-only messages; each keeps its own preview row). */
const runThinking = new Map<number, string[]>();

/** Run ids with a confirmed detach: the ONLY gate for the preview row. */
const hiddenRuns = new Set<number>();

/** Expanded (full-text) state per hidden run for the replacement row. */
const runThinkingOpen = new Set<number>();

/** Last session manager seen (session_start); the poller has no ctx. */
let lastSessionManager: any = undefined;

export function resetDetachState(): void {
  hiddenEntryIds.clear();
  liveHidden = new WeakSet<object>();
  entryThinking.clear();
  runThinking.clear();
  hiddenRuns.clear();
  runThinkingOpen.clear();
  lastSessionManager = undefined;
}

export function noteSessionManager(sm: unknown): void {
  if (sm) lastSessionManager = sm;
}

/** Confirmed detached (fail-open gate for diagnostics). */
export function isMessageHidden(entryId: string): boolean {
  return hiddenEntryIds.has(entryId);
}

/** Runs whose replacement preview row may render (fail-open gate). */
export function isRunHidden(runId: number): boolean {
  return hiddenRuns.has(runId);
}

/** Full stashed thinking texts for a hidden run (expansion view). */
export function runThinkingTexts(runId: number): string[] {
  return [...(runThinking.get(runId) ?? [])];
}

export function runThinkingCount(runId: number): number {
  return runThinking.get(runId)?.length ?? 0;
}

/** Full stashed thinking text for a hidden run (joined expansion view). */
export function runThinkingText(runId: number): string | undefined {
  const texts = runThinking.get(runId);
  if (!texts || texts.length === 0) return undefined;
  return texts.join("\n\n");
}

/** Full stashed thinking text for a tool (diagnostics; follows run merges). */
export function runThinkingForTool(toolCallId: string): string | undefined {
  const entry = traceEntries.get(toolCallId);
  if (!entry) return undefined;
  return runThinkingText(entry.runId);
}

export function hiddenRunCount(): number {
  return hiddenRuns.size;
}

export function isRunThinkingOpen(runId: number): boolean {
  return runThinkingOpen.has(runId);
}

export function toggleRunThinking(runId: number): void {
  if (runThinkingOpen.has(runId)) runThinkingOpen.delete(runId);
  else runThinkingOpen.add(runId);
}

function entriesOf(sm: unknown): Array<{ id?: string; message?: unknown }> {
  try {
    if (!sm || typeof sm !== "object") return [];
    const source = sm as {
      getBranch?: () => unknown;
      getEntries?: () => unknown;
    };
    const list =
      typeof source.getBranch === "function"
        ? source.getBranch()
        : typeof source.getEntries === "function"
          ? source.getEntries()
          : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Transcript order walk: thinking rows plus the tool components that own
 *  trace runs. Thinking-only messages carry no toolCall, so a bare
 *  `hostRunFor` cannot place them; the nearest tool run in transcript order
 *  (next preferred — thinking usually precedes the tools it informs — else
 *  previous) hosts them instead. A transcript with no tools at all hosts
 *  nothing and stays stock. */
type OrderedItem =
  | { kind: "thinking"; parent: { removeChild?(c: unknown): void } | undefined; row: unknown }
  | { kind: "tool"; runId: number };

function collectOrdered(
  node: unknown,
  parent: { removeChild?(c: unknown): void } | undefined,
  out: OrderedItem[],
): void {
  if (!node || typeof node !== "object") return;
  if (isThinkingRow(node)) {
    out.push({ kind: "thinking", parent, row: node });
    return;
  }
  const toolCallId = (node as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string") {
    const runId = traceEntries.get(toolCallId)?.runId;
    if (runId !== undefined) {
      out.push({ kind: "tool", runId });
      return;
    }
  }
  const children = (node as { children?: unknown }).children;
  if (Array.isArray(children)) {
    const self = node as { removeChild?(c: unknown): void };
    const nextParent = typeof self.removeChild === "function" ? self : undefined;
    for (const child of children) collectOrdered(child, nextParent, out);
  }
}

function hostRunFor(message: {
  content?: Array<{ type?: string; id?: unknown }>;
}): number | undefined {
  if (!Array.isArray(message?.content)) return undefined;
  for (const block of message.content) {
    if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
    const runId = traceEntries.get(block.id)?.runId;
    if (runId !== undefined) return runId;
  }
  return undefined;
}

/** One idempotent pass: detach every SAFE+hosted thinking row. Returns
 *  counts for /collapse diagnostics. Silent on every failure (cosmetic). */
export function detachPass(
  pi: ExtensionAPI,
  sessionManager?: unknown,
): { detached: number; skipped: number } {
  const result = { detached: 0, skipped: 0 };
  try {
    if (!isDetachEnabled() || !isHiddenThinking(pi)) return result;
    const tui = walkerTui();
    if (!tui || typeof tui !== "object") return result;
    if (!Array.isArray((tui as { children?: unknown }).children)) return result;
    const sm = sessionManager ?? lastSessionManager;
    const entryList = entriesOf(sm);
    const byMessage = new Map<unknown, { id?: string }>();
    const entryIndex = new Map<unknown, number>();
    entryList.forEach((entry, index) => {
      if (entry && typeof entry === "object" && "message" in entry) {
        const message = (entry as { message?: unknown }).message;
        byMessage.set(message, entry as { id?: string });
        if (!entryIndex.has(message)) entryIndex.set(message, index);
      }
    });
    /** Nearest run hosting a toolCall in entry order (forward, then back).
     *  Covers trees whose tool components are not mounted (tests, virtual
     *  rows): the transcript order still places the thinking. */
    const entryNeighborRun = (message: unknown, forward: boolean): number | undefined => {
      const at = entryIndex.get(message);
      if (at === undefined) return undefined;
      const step = forward ? 1 : -1;
      for (let k = at + step; k >= 0 && k < entryList.length; k += step) {
        const content = (entryList[k] as { message?: { content?: unknown } })?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const id = (block as { type?: unknown; id?: unknown })?.type === "toolCall"
            ? (block as { id?: unknown }).id
            : undefined;
          if (typeof id === "string") {
            const runId = traceEntries.get(id)?.runId;
            if (runId !== undefined) return runId;
          }
        }
      }
      return undefined;
    };
    const ordered: OrderedItem[] = [];
    collectOrdered(tui, undefined, ordered);
    // Nearest tool run per position: next preferred (thinking usually
    // precedes the tools it informs), else previous.
    const nextRun: (number | undefined)[] = new Array(ordered.length);
    let next: number | undefined;
    for (let i = ordered.length - 1; i >= 0; i--) {
      nextRun[i] = next;
      if (ordered[i].kind === "tool") next = ordered[i].runId;
    }
    let prev: number | undefined;
    for (let i = 0; i < ordered.length; i++) {
      const item = ordered[i];
      if (item.kind !== "thinking") {
        if (item.kind === "tool") prev = item.runId;
        continue;
      }
      const { parent, row } = item;
      const message = (row as { lastMessage?: unknown }).lastMessage as {
        role?: unknown;
        content?: Array<{ type?: string; thinking?: string; id?: unknown }>;
      } | undefined;
      if (!message || message.role !== "assistant") {
        result.skipped++;
        continue;
      }
      let runId = hostRunFor(message) ?? nextRun[i] ?? prev;
      if (runId === undefined) runId = entryNeighborRun(message, true) ?? entryNeighborRun(message, false);
      if (runId === undefined) {
        result.skipped++;
        continue;
      }
      const overrides = (row as { thinkingVisibilityOverrides?: unknown })
        .thinkingVisibilityOverrides as Map<number, boolean> | undefined;
      if (!isSafeToDetach(message, true, overrides)) {
        result.skipped++;
        continue;
      }
      const text = extractThinkingText(message);
      if (!text) {
        result.skipped++;
        continue;
      }
      try {
        if (!parent || typeof parent.removeChild !== "function") {
          result.skipped++;
          continue;
        }
        parent.removeChild(row);
      } catch {
        result.skipped++;
        continue;
      }
      const entryId = byMessage.get(message)?.id;
      if (typeof entryId === "string") {
        hiddenEntryIds.add(entryId);
        entryThinking.set(entryId, text);
      } else {
        liveHidden.add(message);
      }
      const texts = runThinking.get(runId) ?? [];
      if (!texts.includes(text)) texts.push(text);
      runThinking.set(runId, texts);
      hiddenRuns.add(runId);
      tracePokeOwner(runId);
      result.detached++;
    }
  } catch {
    // Cosmetic only; never break the event loop.
  }
  return result;
}

/** One-line preview for the replacement row (Pi's own label styling). */
export function thinkingRowPreview(theme: any, text: string): string {
  const preview = thinkingPreview(text, 64);
  try {
    return theme.italic(theme.fg("thinkingText", `… ${preview}`));
  } catch {
    return `… ${preview}`;
  }
}
