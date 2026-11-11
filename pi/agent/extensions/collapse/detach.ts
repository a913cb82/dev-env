/** Detach-hiding of Pi thinking rows (collapse r27 experiment, now on by
 *  default; opt out with COLLAPSE_HIDE_THINKING=0).
 *
 * Pi's thinking row (spacer + label) is unconditional given visible thinking,
 * so the only way to merge thinking into our gapless tool block is to
 * detach the thinking from the transcript tree via the public removeChild
 * — no message edits, no patching, nothing persisted. Text-free messages
 * detach whole; mixed messages (visible prose plus hidden thinking) lose
 * only their thinking children while the prose row stays mounted.
 *
 * Safety comes from two rules. First, the SAFE predicate (isSafeToDetach in
 * logic.ts, a mirror of Pi's own updateContent): detach only when the
 * component renders nothing but hidden-thinking label rows. Second, the
 * fail-open coupling: our replacement preview row renders in the trace if
 * and only if the detach is confirmed for that message — a missed detach
 * degrades to the stock Pi row, never a duplicate.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractThinkingText, isPartialSafeToDetach, isSafeToDetach, stripAnsi, thinkingPreview } from "./logic.js";
import { isDetachEnabled, isHiddenThinking } from "./settings.js";
import { hasVisibleProse, isThinkingRow, setStandaloneThinking, walkerTui } from "./labels.js";
import { traceEntries, tracePokeOwner, isTurnCurrent } from "./trace.js";

/** Entry ids whose thinking row is confirmed detached (history + adopted). */
const hiddenEntryIds = new Set<string>();

/** Live messages detached before persistence assigned an entry id. */
let liveHidden = new WeakSet<object>();

/** Full thinking text by entry id (history) for the replacement row. */
const entryThinking = new Map<string, string>();

/** Full thinking texts by trace run id for the replacement rows (a run can
 *  host several thinking-only messages; each keeps its own preview row).
 *  Each entry carries its transcript anchor: the neighboring tool in the
 *  same run (before/after by toolCallId), so previews interleave with the
 *  tool rows instead of clustering at the top. Unanchored entries (blind
 *  trees, entry-order fallback) keep the legacy top position. */
type ThinkingItem = { text: string; before?: string; after?: string };
const runThinking = new Map<number, ThinkingItem[]>();

/** Run ids with a confirmed detach: the ONLY gate for the preview row. */
const hiddenRuns = new Set<number>();

/** Expanded (full-text) state per hidden run for the replacement row. */
const runThinkingOpen = new Set<number>();

/** Skip reasons for the last pass (see detachDiag): pinpoints why rows
 *  stay mounted instead of guessing. */
type SkipReasons = { role: number; nohome: number; unsafe: number; empty: number; parent: number; remove: number };
const newSkipReasons = (): SkipReasons => ({ role: 0, nohome: 0, unsafe: 0, empty: 0, parent: 0, remove: 0 });

/** Thinking-toggle children (Pi wraps each hidden-thinking label in a
 *  MouseRegion) whose inner text carries our label: exactly the children
 *  a partial detach may remove. Structural match only — no Pi imports. */
function hiddenLabelKids(row: unknown, label: string): unknown[] {
  const kids: unknown[] = [];
  try {
    const container = (row as { contentContainer?: { children?: unknown[] } })?.contentContainer;
    if (!container || !Array.isArray(container.children)) return kids;
    const head = label.slice(0, 30);
    if (!head) return kids;
    for (const node of container.children) {
      const mouse = node as { onMouse?: unknown; child?: { text?: unknown } } | null | undefined;
      if (!mouse || typeof mouse.onMouse !== "function" || mouse.child == null) continue;
      const inner = mouse.child as { text?: unknown };
      if (typeof inner.text !== "string") continue;
      if (!stripAnsi(inner.text).includes(head)) continue;
      kids.push(node);
    }
  } catch {
    // Structural miss: no kids, caller skips.
  }
  return kids;
}

/** Last session manager seen (session_start); the poller has no ctx. */
let lastSessionManager: any = undefined;

/** Last pass summary for /collapse: walked rows, tools seen, outcomes. */
let lastDetachDiag = "no pass yet";
export function detachDiag(): string {
  return lastDetachDiag;
}

export function resetDetachState(): void {
  hiddenEntryIds.clear();
  liveHidden = new WeakSet<object>();
  entryThinking.clear();
  runThinking.clear();
  hiddenRuns.clear();
  runThinkingOpen.clear();
  lastSessionManager = undefined;
  lastDetachDiag = "no pass yet";
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
  return (runThinking.get(runId) ?? []).map((item) => item.text);
}

/** Stashed thinkings with their transcript anchors (see runThinking). */
export function runThinkingItems(runId: number): ThinkingItem[] {
  return [...(runThinking.get(runId) ?? [])];
}

export function runThinkingCount(runId: number): number {
  return runThinking.get(runId)?.length ?? 0;
}

/** Full stashed thinking text for a hidden run (joined expansion view). */
export function runThinkingText(runId: number): string | undefined {
  const texts = runThinking.get(runId);
  if (!texts || texts.length === 0) return undefined;
  return texts.map((item) => item.text).join("\n\n");
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
  | { kind: "tool"; runId: number; toolCallId: string }
  | { kind: "visible" };

function collectOrdered(
  node: unknown,
  parent: { removeChild?(c: unknown): void } | undefined,
  out: OrderedItem[],
  toolPos?: Map<string, number>,
): void {
  if (!node || typeof node !== "object") return;
  // Mounted prose is a segment boundary for OTHER thinkings (their runs
  // never span it); a mixed row's own thinking still hosts same-message.
  if (hasVisibleProse(node)) out.push({ kind: "visible" });
  if (isThinkingRow(node)) {
    out.push({ kind: "thinking", parent, row: node });
    return;
  }
  const toolCallId = (node as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string") {
    const runId = traceEntries.get(toolCallId)?.runId;
    if (runId !== undefined) {
      toolPos?.set(toolCallId, out.length);
      out.push({ kind: "tool", runId, toolCallId });
      return;
    }
  }
  const children = (node as { children?: unknown }).children;
  if (Array.isArray(children)) {
    const self = node as { removeChild?(c: unknown): void };
    const nextParent = typeof self.removeChild === "function" ? self : undefined;
    for (const child of children) collectOrdered(child, nextParent, out, toolPos);
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
): { detached: number; skipped: number; reasons: SkipReasons } {
  const result = { detached: 0, skipped: 0, reasons: newSkipReasons() };
  const skip = (reason: keyof SkipReasons): void => { result.skipped++; result.reasons[reason]++; };
  let noHome = 0;
  let walkedTotal = 0;
  let walkedThinking = 0;
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
    // toolCall id -> entry index of the message carrying it, for the
    // segment gate below.
    const toolEntryIdx = new Map<string, number>();
    entryList.forEach((entry, index) => {
      const content = (entry as { message?: { content?: unknown } })?.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const id = (block as { type?: unknown; id?: unknown })?.type === "toolCall"
          ? (block as { id?: unknown }).id
          : undefined;
        if (typeof id === "string") toolEntryIdx.set(id, index);
      }
    });
    /** Whether an entry message is visible to the user: a run boundary.
     *  Mirrors planToolRuns (user / visible custom break runs) plus
     *  assistant prose — a thinking-only message never does. */
    const isEntryVisible = (message: unknown): boolean => {
      if (!message || typeof message !== "object") return false;
      const role = (message as { role?: unknown }).role;
      if (role === "user") return true;
      if (role === "assistant") {
        const content = (message as { content?: unknown }).content;
        return Array.isArray(content) && content.some((block) =>
          (block as { type?: unknown })?.type === "text" &&
          typeof (block as { text?: unknown }).text === "string" &&
          (block as { text: string }).text.trim() !== "");
      }
      return false;
    };
    const isCustomEntryVisible = (entry: unknown): boolean =>
      !!entry && typeof entry === "object" &&
      (entry as { type?: unknown }).type === "custom_message" &&
      (entry as { display?: unknown }).display !== false;
    /** Segment gate: a thinking attaches only within its own visible
     *  segment — never across a user message, agent prose, or visible
     *  custom block. Mounted tree order and entry order EACH veto: trees
     *  hold the live rows entries have not landed yet, entries hold the
     *  settled rows no longer mounted. Fully unknown positions allow
     *  (the settled pass re-checks once entries land). */
    const segmentClear = (thinkIdx: number, thinkMsg: unknown, toolCallId: string): boolean => {
      const mountedAt = toolPos.get(toolCallId);
      if (mountedAt !== undefined) {
        const lo = Math.min(thinkIdx, mountedAt), hi = Math.max(thinkIdx, mountedAt);
        for (let k = lo + 1; k < hi; k++) {
          if (ordered[k].kind === "visible") return false;
        }
      }
      const ti = entryIndex.get(thinkMsg);
      const ci = toolEntryIdx.get(toolCallId);
      if (ti !== undefined && ci !== undefined) {
        const lo = Math.min(ti, ci), hi = Math.max(ti, ci);
        for (let k = lo + 1; k < hi; k++) {
          if (isEntryVisible((entryList[k] as { message?: unknown })?.message) ||
            isCustomEntryVisible(entryList[k])) return false;
        }
      }
      return true;
    };
    /** Nearest tool hosting a toolCall in entry order (forward, then back).
     *  Covers trees whose tool components are not mounted (tests, virtual
     *  rows): the transcript order still places the thinking. */
    const entryNeighborRun = (message: unknown, forward: boolean): { runId: number; toolCallId: string } | undefined => {
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
            if (runId !== undefined) return { runId, toolCallId: id };
          }
        }
      }
      return undefined;
    };
    const ordered: OrderedItem[] = [];
    // Mounted tool positions: the live segment gate (tree order decides
    // while entries are still landing). Entry order covers the rest.
    const toolPos = new Map<string, number>();
    collectOrdered(tui, undefined, ordered, toolPos);
    walkedTotal = ordered.length;
    walkedThinking = ordered.filter((o) => o.kind === "thinking").length;
    // Nearest tool run per position: next preferred (thinking usually
    // precedes the tools it informs), else previous. Tool ids ride along
    // so stashed thinkings anchor to their transcript neighbors.
    const nextTool: ({ runId: number; toolCallId: string } | undefined)[] = new Array(ordered.length);
    let next: { runId: number; toolCallId: string } | undefined;
    for (let i = ordered.length - 1; i >= 0; i--) {
      nextTool[i] = next;
      const item = ordered[i];
      if (item.kind === "tool") next = { runId: item.runId, toolCallId: item.toolCallId };
    }
    /** Transcript anchor for a stashed thinking: the neighboring tool in
     *  the same run (next preferred, else previous). Cross-run neighbors
     *  do not anchor — the render only honors same-run ids. */
    const anchorFor = (
      index: number,
      prevTool: { runId: number; toolCallId: string } | undefined,
      homeRunId: number,
    ): { before?: string; after?: string } => {
      const next = nextTool[index];
      if (next && next.runId === homeRunId) return { before: next.toolCallId };
      if (prevTool && prevTool.runId === homeRunId) return { after: prevTool.toolCallId };
      return {};
    };
    let prev: { runId: number; toolCallId: string } | undefined;
    for (let i = 0; i < ordered.length; i++) {
      const item = ordered[i];
      if (item.kind !== "thinking") {
        if (item.kind === "tool") prev = { runId: item.runId, toolCallId: item.toolCallId };
        continue;
      }
      const { parent, row } = item;
      const message = (row as { lastMessage?: unknown }).lastMessage as {
        role?: unknown;
        content?: Array<{ type?: string; thinking?: string; id?: unknown }>;
      } | undefined;
      if (!message || message.role !== "assistant") {
        skip("role");
        continue;
      }
      let runId = hostRunFor(message);
      if (runId === undefined) {
        // Live-edge guard: a thinking row whose message is not yet persisted
        // has no settled home — its tools may not have rendered (the poll
        // beats them). Falling back across a turn-resetting boundary would
        // teleport the thinking into the previous turn, so a guessed
        // neighbor only counts while its turn is still open (no user
        // message, session switch, or foreign tool since its tools
        // rendered); same-turn content splits never strand. Otherwise
        // defer — the poll retries once the tools land. A host toolCall in
        // the same message is direct evidence and always counts.
        // Persisted (history) messages keep the old behavior: their runs
        // are final.
        const settled = byMessage.has(message);
        const guessOk = (candidate: number | undefined): number | undefined =>
          candidate !== undefined && (settled || isTurnCurrent(candidate)) ? candidate : undefined;
        // Segment gate (spec: no run spans a visible message): a guessed
        // neighbor counts only with no user message, prose, or visible
        // custom between the thinking and that tool. Next preferred, else
        // previous — and a thinking past prose from every tool stands
        // alone instead of teleporting.
        const tryTool = (tool: { runId: number; toolCallId: string } | undefined): number | undefined => {
          if (!tool) return undefined;
          const g = guessOk(tool.runId);
          if (g === undefined) return undefined;
          return segmentClear(i, message, tool.toolCallId) ? g : undefined;
        };
        runId = tryTool(nextTool[i]) ?? tryTool(prev) ??
          tryTool(entryNeighborRun(message, true)) ?? tryTool(entryNeighborRun(message, false));
        if (runId === undefined && !settled) {
          // Walk-blind trees (no tool components mounted): the most
          // recently rendered tool is the turn's own while its turn is
          // open. Same guard — a stale newest means the tools are still
          // coming, so defer. Same segment gate.
          let newest: { runId: number; toolCallId: string } | undefined;
          for (const [id, entry] of traceEntries) newest = { runId: entry.runId, toolCallId: id };
          runId = tryTool(newest && isTurnCurrent(newest.runId) ? newest : undefined);
        }
      }
      const overrides = (row as { thinkingVisibilityOverrides?: unknown })
        .thinkingVisibilityOverrides as Map<number, boolean> | undefined;
      if (runId === undefined) {
        // No home: a completed thinking with nowhere to go collapses in
        // place (standalone header) instead of lingering as a stock row.
        // Streaming rows keep their live preview; unsafe rows keep stock.
        const text = extractThinkingText(message);
        if (text && message.stopReason != null && isSafeToDetach(message, true, overrides)) {
          setStandaloneThinking(message, true);
        }
        skip("nohome");
        noHome++;
        continue;
      }
      const wholeSafe = isSafeToDetach(message, true, overrides);
      // Mixed message: prose stays, only the thinking children go.
      // Requires our label (proves the row is managed, never stock) so a
      // visible-thinking run can never match by label text.
      let partialKids: unknown[] = [];
      if (!wholeSafe) {
        const label = (row as { hiddenThinkingLabel?: unknown }).hiddenThinkingLabel;
        if (!isPartialSafeToDetach(message, true, overrides) ||
            typeof label !== "string" || !label.includes("\u2026")) {
          skip("unsafe");
          continue;
        }
        partialKids = hiddenLabelKids(row, label);
        if (partialKids.length === 0) {
          skip("parent");
          continue;
        }
      }
      const text = extractThinkingText(message);
      if (!text) {
        skip("empty");
        continue;
      }
      if (wholeSafe) {
        try {
          if (!parent || typeof parent.removeChild !== "function") {
            skip("parent");
            continue;
          }
          parent.removeChild(row);
        } catch {
          skip("remove");
          continue;
        }
      } else {
        const container = (row as { contentContainer?: { removeChild?: (c: unknown) => void } })?.contentContainer;
        if (!container || typeof container.removeChild !== "function") {
          skip("parent");
          continue;
        }
        let removed = 0;
        try {
          for (const kid of partialKids) {
            container.removeChild(kid);
            removed++;
          }
        } catch {
          // Non-atomic: a later kid threw. Stash when at least one went
          // (fail-visible: counted and still shown) rather than lose text.
          if (removed === 0) {
            skip("remove");
            continue;
          }
        }
      }
      const entryId = byMessage.get(message)?.id;
      if (typeof entryId === "string") {
        hiddenEntryIds.add(entryId);
        entryThinking.set(entryId, text);
      } else {
        liveHidden.add(message);
      }
      setStandaloneThinking(message, false);
      const texts = runThinking.get(runId) ?? [];
      // Latest placement wins: Pi rebuilds re-add removed rows, so a second
      // detach of the same text moves it instead of duplicating it across
      // runs (which reads as one thinking per group and inflates counts).
      // A re-detach in the same run refreshes the anchor instead.
      for (const [other, otherTexts] of runThinking) {
        if (other === runId) continue;
        const at = otherTexts.findIndex((item) => item.text === text);
        if (at >= 0) {
          otherTexts.splice(at, 1);
          if (otherTexts.length === 0) {
            runThinking.delete(other);
            hiddenRuns.delete(other);
          }
        }
      }
      const anchor = anchorFor(i, prev, runId);
      const same = texts.findIndex((item) => item.text === text);
      if (same >= 0) texts[same] = { text, ...anchor };
      else texts.push({ text, ...anchor });
      runThinking.set(runId, texts);
      hiddenRuns.add(runId);
      tracePokeOwner(runId);
      result.detached++;
    }
  } catch {
    // Cosmetic only; never break the event loop.
  }
  lastDetachDiag =
    `walked ${walkedTotal} (${walkedThinking} thinking, ${walkedTotal - walkedThinking} tools); ` +
    `attached ${result.detached}; homeless ${noHome}; skipped ${result.skipped} ` +
    `(role=${result.reasons.role} nohome=${result.reasons.nohome} unsafe=${result.reasons.unsafe} ` +
    `empty=${result.reasons.empty} parent=${result.reasons.parent} remove=${result.reasons.remove})`;
  return result;
}

/** One-line preview for the replacement row (Pi's own label styling). The
 *  budget is generous on purpose: the row itself middle-truncates to the
 *  terminal width, so the preview function must not pre-chop the text. */
export function thinkingRowPreview(theme: any, text: string): string {
  // No leading ellipsis: the row middle-truncates to its width, so the
  // line always starts with real text and carries exactly one middle cut.
  const preview = thinkingPreview(text, 240);
  try {
    return theme.italic(theme.fg("thinkingText", preview));
  } catch {
    return preview;
  }
}
