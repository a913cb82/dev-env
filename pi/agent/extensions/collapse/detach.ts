/** Detach-hiding of Pi thinking rows (collapse r27 experiment, default off).
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
const liveHidden = new WeakSet<object>();

/** Full thinking text by entry id (history) for the replacement row. */
const entryThinking = new Map<string, string>();

/** Full thinking text by trace run id for the replacement row. */
const runThinking = new Map<number, string>();

/** Run ids with a confirmed detach: the ONLY gate for the preview row. */
const hiddenRuns = new Set<number>();

/** Expanded (full-text) state per hidden run for the replacement row. */
const runThinkingOpen = new Set<number>();

/** Last session manager seen (session_start); the poller has no ctx. */
let lastSessionManager: any = undefined;

export function resetDetachState(): void {
  hiddenEntryIds.clear();
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

/** Full stashed thinking text for a hidden run (expansion view). */
export function runThinkingText(runId: number): string | undefined {
  return runThinking.get(runId);
}

/** Full stashed thinking text for a tool (diagnostics; follows run merges). */
export function runThinkingForTool(toolCallId: string): string | undefined {
  const entry = traceEntries.get(toolCallId);
  if (!entry) return undefined;
  return runThinking.get(entry.runId);
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

function collectDetachable(
  node: unknown,
  parent: { removeChild?(c: unknown): void } | undefined,
  out: Array<{ parent: { removeChild?(c: unknown): void } | undefined; row: unknown }>,
): void {
  if (!node || typeof node !== "object") return;
  if (isThinkingRow(node)) {
    out.push({ parent, row: node });
    return;
  }
  const children = (node as { children?: unknown }).children;
  if (Array.isArray(children)) {
    const self = node as { removeChild?(c: unknown): void };
    for (const child of children) {
      collectDetachable(
        child,
        typeof self.removeChild === "function" ? self : undefined,
        out,
      );
    }
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
    const byMessage = new Map<unknown, { id?: string }>();
    for (const entry of entriesOf(sm)) {
      if (entry && typeof entry === "object" && "message" in entry) {
        byMessage.set((entry as { message?: unknown }).message, entry);
      }
    }
    const found: Array<{
      parent: { removeChild?(c: unknown): void } | undefined;
      row: unknown;
    }> = [];
    collectDetachable(tui, undefined, found);
    for (const { parent, row } of found) {
      const message = (row as { lastMessage?: unknown }).lastMessage as {
        role?: unknown;
        content?: Array<{ type?: string; thinking?: string; id?: unknown }>;
      } | undefined;
      if (!message || message.role !== "assistant") {
        result.skipped++;
        continue;
      }
      const runId = hostRunFor(message);
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
      runThinking.set(runId, text);
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
