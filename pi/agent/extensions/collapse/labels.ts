/** Per-row collapsed-thinking labels via a tree walk, not the global setter.
 *
 * Pi's `setHiddenThinkingLabel` applies one string to every assistant row,
 * so any preview repeats the newest turn on all older rows. The rows
 * themselves, however, are per-instance objects with their own
 * `setHiddenThinkingLabel` method — reachable by walking the public TUI
 * tree handed to the widget factory. This module relabels each row from its
 * own message: no prototype patching, no Pi changes. If the tree shape ever
 * stops matching, everything below bails to stock behavior (never throws).
 */
import { Container, type Component } from "@earendil-works/pi-tui";
import { extractThinkingText, thinkingLabelForWidth } from "./logic.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentColumns, isHiddenThinking, liveOutputPad } from "./settings.js";

/** Widget key for the invisible handle holder (renders zero lines). */
export const WALKER_KEY = "collapse-thinking-walker";

/** Live TUI handle captured from the widget factory; unknown until the
 *  factory first runs (TUI mode only). */
let capturedTui: any = undefined;

/** Last reconcile outcome, reported by `/collapse`. */
let walkStatus = "inactive (no TUI handle)";

/** Rows already labeled for their current message: identity-keyed, so a
 *  steady transcript costs one Map lookup per row per pass and nothing else.
 *  WeakRefs would be purer; a WeakMap cannot be iterated for status, and
 *  entries die with their components anyway. */
/** Per-row label cache: message AND the width/pad it was built for. A
 *  resize must rebuild the label — a stale, wider label word-wraps its
 *  count — so width is part of the identity, not just the message. */
interface LabeledFor {
  message: unknown;
  width: number | undefined;
  pad: number;
}
const labeledFor = new WeakMap<object, LabeledFor>();

export function walkerStatus(): string {
  return walkStatus;
}

/** The live TUI handle captured by the walker widget (undefined until the
 *  factory first runs; TUI mode only). The detach pass reuses it. */
export function walkerTui(): unknown {
  return capturedTui;
}

/** Stash the live TUI handle. Called from the widget factory only — never
 *  labels anything (factories run during render; labeling there would loop). */
export function captureWalkerTui(tui: unknown): void {
  try {
    if (tui && typeof tui === "object") capturedTui = tui;
  } catch {
    // A hostile handle is the same as no handle: stock behavior.
  }
}

/** An assistant thinking row, duck-typed (never `instanceof`: jiti breaks it).
 *  Real rows expose all three; anything else is skipped. */
export function isThinkingRow(node: unknown): node is {
  lastMessage: { role?: unknown; content?: unknown };
  hiddenThinkingLabel: unknown;
  setHiddenThinkingLabel(label: string): void;
  updateContent(message: unknown, streaming?: boolean): void;
} {
  if (!node || typeof node !== "object") return false;
  const candidate = node as Record<string, unknown>;
  return (
    typeof candidate.setHiddenThinkingLabel === "function" &&
    typeof candidate.updateContent === "function" &&
    typeof (candidate.lastMessage as Record<string, unknown> | undefined)?.role === "string"
  );
}

/** Every assistant row under this subtree, in render order. */
function collectRows(node: unknown, out: unknown[]): void {
  if (!node || typeof node !== "object") return;
  if (isThinkingRow(node)) {
    out.push(node);
    return;
  }
  const children = (node as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const child of children) collectRows(child, out);
  }
}

/** Label every row from its own message. Idempotent: rows already labeled
 *  for their current message are skipped, so repeated passes are cheap and
 *  a clobbered row heals on the next pass. Returns rows newly labeled. */
export function reconcileThinkingLabels(pi: ExtensionAPI): number {
  try {
    if (!isHiddenThinking(pi)) {
      walkStatus = "idle (thinking visible)";
      return 0;
    }
    if (!capturedTui || !Array.isArray((capturedTui as { children?: unknown }).children)) {
      walkStatus = "inactive (no TUI handle)";
      return 0;
    }
    const rows: unknown[] = [];
    collectRows(capturedTui, rows);
    if (rows.length === 0) {
      walkStatus = "inactive (no rows found)";
      return 0;
    }
    const width = currentColumns();
    const pad = liveOutputPad(pi);
    let labeled = 0;
    for (const row of rows) {
      if (!isThinkingRow(row)) continue;
      const message = row.lastMessage as { role?: unknown; content?: unknown };
      if (message?.role !== "assistant") continue;
      const cached = labeledFor.get(row);
      if (cached && cached.message === message && cached.width === width && cached.pad === pad) continue;
      const thinking = extractThinkingText(message);
      if (!thinking) {
        labeledFor.set(row, { message, width, pad });
        continue;
      }
      const label = thinkingLabelForWidth(thinking, width, pad);
      if (row.hiddenThinkingLabel !== label) row.setHiddenThinkingLabel(label);
      labeledFor.set(row, { message, width, pad });
      labeled++;
    }
    walkStatus = `active (${rows.length} row(s))`;
    return labeled;
  } catch {
    walkStatus = "inactive (walk failed)";
    return 0;
  }
}

/** Streaming relabel window: a live row's preview refreshes at most this
 *  often. Reads as smooth growth (~10 updates/s) without relabeling on
 *  every token, which would rebuild the row's children each delta. */
const STREAM_LABEL_MS = 100;

/** Last live relabel per row, so a brand-new row writes immediately (no
 *  stock "Thinking..." frame) and later deltas coalesce. */
const streamLabelAt = new WeakMap<object, number>();

/** Live-preview writes since activation, for `/collapse`. A number that
 *  stays at 0 while a model thinks means the streaming path is not firing. */
let streamWrites = 0;

export function streamStatus(): string {
  return `${streamWrites} live write(s)`;
}

/** Relabel live rows while their thinking streams.
 *
 * Pi renders NO thinking region until a block has non-empty text
 * (`if (thinkingBlocks.length === 0) continue`), so before the first token
 * there is nothing to label — and once text exists, waiting for a settle
 * event would flash the stock `Thinking...`. This writes our preview (with
 * its live char count) on the delta instead, throttled per row.
 *
 * Rows are matched by their OWN `isStreaming` flag, never by event
 * identity: extension handlers can run before interactive-mode applies the
 * delta, so `row.lastMessage` is then one delta behind `event.message` and
 * an identity check would silently never match (the stock label would stay
 * up for the whole thinking phase). The label is computed from the row's
 * own message for the same reason — it is the row's truth, and it can never
 * label one row with another row's text.
 *
 * Labels written here are deliberately NOT cached in `labeledFor`: the
 * settle pass must recompute from the final text, so the count lands
 * exactly even when the last delta was throttled away. Returns rows
 * written. */
export function reconcileStreamingLabel(
  pi: ExtensionAPI,
  message?: unknown,
  now = Date.now(),
): number {
  try {
    if (!isHiddenThinking(pi)) return 0;
    if (!capturedTui || !Array.isArray((capturedTui as { children?: unknown }).children)) return 0;
    const rows: unknown[] = [];
    collectRows(capturedTui, rows);
    const width = currentColumns();
    const pad = liveOutputPad(pi);
    let written = 0;
    for (const row of rows) {
      if (!isThinkingRow(row)) continue;
      const own = row.lastMessage as { role?: unknown; content?: unknown };
      if (own?.role !== "assistant") continue;
      const live =
        (row as { isStreaming?: unknown }).isStreaming === true ||
        (message !== undefined && own === message);
      if (!live) continue;
      const text = extractThinkingText(own);
      // Match Pi: no thinking region renders without non-empty text, so there
      // is nothing to label and nothing that could flash as stock.
      if (!text) continue;
      const at = streamLabelAt.get(row);
      if (at !== undefined && now - at < STREAM_LABEL_MS) continue;
      streamLabelAt.set(row, now);
      const label = thinkingLabelForWidth(text, width, pad);
      labeledFor.delete(row);
      if (row.hiddenThinkingLabel !== label) {
        row.setHiddenThinkingLabel(label);
        streamWrites++;
        written++;
      }
    }
    return written;
  } catch {
    return 0;
  }
}

/** The invisible widget whose factory smuggles out the live TUI handle.
 *  Renders nothing; exists only so `captureWalkerTui` runs. */
export function walkerWidget(): Component {
  return new Container();
}
