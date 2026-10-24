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
let walkerTui: any = undefined;

/** Last reconcile outcome, reported by `/collapse`. */
let walkStatus = "inactive (no TUI handle)";

/** Rows already labeled for their current message: identity-keyed, so a
 *  steady transcript costs one Map lookup per row per pass and nothing else.
 *  WeakRefs would be purer; a WeakMap cannot be iterated for status, and
 *  entries die with their components anyway. */
const labeledFor = new WeakMap<object, unknown>();

export function walkerStatus(): string {
  return walkStatus;
}

/** Stash the live TUI handle. Called from the widget factory only — never
 *  labels anything (factories run during render; labeling there would loop). */
export function captureWalkerTui(tui: unknown): void {
  try {
    if (tui && typeof tui === "object") walkerTui = tui;
  } catch {
    // A hostile handle is the same as no handle: stock behavior.
  }
}

/** An assistant thinking row, duck-typed (never `instanceof`: jiti breaks it).
 *  Real rows expose all three; anything else is skipped. */
function isThinkingRow(node: unknown): node is {
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
    if (!walkerTui || !Array.isArray((walkerTui as { children?: unknown }).children)) {
      walkStatus = "inactive (no TUI handle)";
      return 0;
    }
    const rows: unknown[] = [];
    collectRows(walkerTui, rows);
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
      if (labeledFor.get(row) === message) continue;
      const thinking = extractThinkingText(message);
      if (!thinking) {
        labeledFor.set(row, message);
        continue;
      }
      const label = thinkingLabelForWidth(thinking, width, pad);
      if (row.hiddenThinkingLabel !== label) row.setHiddenThinkingLabel(label);
      labeledFor.set(row, message);
      labeled++;
    }
    walkStatus = `active (${rows.length} row(s))`;
    return labeled;
  } catch {
    walkStatus = "inactive (walk failed)";
    return 0;
  }
}

/** The invisible widget whose factory smuggles out the live TUI handle.
 *  Renders nothing; exists only so `captureWalkerTui` runs. */
export function walkerWidget(): Component {
  return new Container();
}
