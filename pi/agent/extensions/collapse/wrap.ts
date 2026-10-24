/** Per-instance render wrap for collapsed run owners, plus the
 *  thinking-side counterpart (leading-spacer surgery).
 *
 * Pi's `ToolExecutionComponent` prepends one blank line to every non-empty
 * self-shell render (`lines.push("")` before content lines), and the custom
 * renderer cannot suppress it. That line is a SHARED separator: it is the
 * gap after a thinking label (which must go) and the paragraph seam after
 * prose (which must stay). So the shadow strips conditionally, per render:
 *
 *   render: drop a single leading "" only when the previous sibling renders
 *     a thinking run, collapsed or expanded, (or is another tool row)
 *     directly above — i.e. nothing but thinking pixels sit between the
 *     tool block and the row above. After prose, or as a first child, the
 *     blank is kept byte-identical.
 *   handleMouse: re-base y by +1 under the same verdict (Pi rejects y<=0
 *     and delegates y-1, so displayed rows shift up by exactly the stripped
 *     line — and a click on a KEPT blank still hits nothing).
 *
 * Mirror image below the block: an assistant row whose first rendered line
 * is a thinking run, collapsed or expanded, directly follows a tool row,
 * its leading `Spacer(1)` is removed (public `removeChild` on its
 * `contentContainer`). Prose-first rows, non-tool predecessors, and global
 * visible-thinking mode are never touched. Both directions are pure
 * structure (class names + child order), so a per-row expand/collapse
 * self-heals through the class check with no unwrap pass.
 *
 * Never a prototype touch, never Pi sources: instance shadows and a
 * child removal Pi itself re-adds on its next rebuild. Fail-open
 * throughout: anything unrecognized keeps stock rendering.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isThinkingRow, walkerTui } from "./labels.js";
import { isHiddenThinking } from "./settings.js";
import { traceEntries, traceOwnerId } from "./trace.js";

export interface WrapCounts {
  wrapped: number;
  skipped: number;
  already: number;
  spacers: number;
  synced: number;
}

/** Marks instances carrying our shadows (same module instance, so one
 *  symbol cannot collide with a foreign one). */
const WRAPPED = Symbol("collapseRenderWrap");

/** Installed shadows plus the originals they replaced, to prove on unwrap
 *  that the current methods are still ours before restoring (never touch a
 *  method we did not install). Originals are stored unbound and restored
 *  by assignment, so unwrap works whether the original lived on the
 *  prototype (real Pi components) or the instance (test doubles). */
interface InstalledWrap {
  shadowRender: unknown;
  shadowHandleMouse: unknown;
  origRender: (width: number) => string[];
  origHandleMouse: (event: unknown) => unknown;
}
const installedWraps = new WeakMap<object, InstalledWrap>();

let wrapOutcome = "idle (no pass yet)";

/** Marks assistant rows carrying our `updateContent` shadow (distinct from
 *  the render/handleMouse shadows on tool components; the two node kinds
 *  never overlap). */
const ROW_SYNCED = Symbol("collapseRowSync");

/** Installed row-sync shadows plus the original they replaced. */
interface InstalledRowSync {
  shadowUpdateContent: unknown;
  origUpdateContent: (message: unknown, streaming?: unknown) => unknown;
}
const installedRowSyncs = new WeakMap<object, InstalledRowSync>();

/** A pass scheduled but not yet run (at most one pending: repeat captures
 *  during a render storm collapse into a single immediate pass). */
let scheduledPass: { pi: ExtensionAPI } | undefined;

/** Sync an assistant row's `updateContent`: after Pi rebuilds the children
 *  (streaming delta, click-toggle), re-drop the leading spacer when the
 *  live gate still holds. The gate re-evaluates per call, so a toggle to
 *  visible thinking (Markdown children) simply stops healing. Returns true
 *  when this call installed the shadow. */
export function syncRowUpdates(
  row: unknown,
  pi: ExtensionAPI,
  getPrev?: () => unknown,
): boolean {
  try {
    if (!isThinkingRow(row)) return false;
    if ((row as Record<symbol, unknown>)[ROW_SYNCED] === true) return false;
    const unbound = row.updateContent;
    const orig = unbound.bind(row);
    const prevOf = getPrev ?? (() => undefined);
    row.updateContent = (message: unknown, streaming?: unknown): unknown => {
      const result = orig(message, streaming);
      try {
        if (isHiddenThinking(pi)) dropLeadingSpacers(row, prevOf());
      } catch {
        // Pi's rebuild stands; the next pass heals.
      }
      return result;
    };
    installedRowSyncs.set(row, {
      shadowUpdateContent: row.updateContent,
      origUpdateContent: unbound,
    });
    (row as Record<symbol, unknown>)[ROW_SYNCED] = true;
    return true;
  } catch {
    return false;
  }
}

/** Remove the row-sync shadow iff it is still ours. */
function unsyncRowUpdates(row: unknown): boolean {
  try {
    if (!row || typeof row !== "object") return false;
    if ((row as Record<symbol, unknown>)[ROW_SYNCED] !== true) return false;
    const installed = installedRowSyncs.get(row);
    if (!installed) return false;
    if (installed.shadowUpdateContent === (row as { updateContent?: unknown }).updateContent) {
      try {
        (row as { updateContent: unknown }).updateContent = installed.origUpdateContent;
      } catch {
        return false;
      }
    }
    installedRowSyncs.delete(row);
    try {
      delete (row as Record<symbol, unknown>)[ROW_SYNCED];
    } catch {
      // Mark unreadable: treat as unsynced; the method is restored.
    }
    return true;
  } catch {
    return false;
  }
}

/** Schedule one pass on the next immediate tick (coalesced). The walker
 *  handle becomes valid inside a render, where tree surgery is unsafe;
 *  the tick runs right after that render commits, so post-reload rows
 *  converge in milliseconds instead of waiting out the 1s poll. */
export function scheduleWrappingPass(pi: ExtensionAPI): void {
  try {
    if (scheduledPass) {
      scheduledPass.pi = pi;
      return;
    }
    if (typeof setImmediate !== "function") {
      wrappingPass(pi);
      return;
    }
    scheduledPass = { pi };
    setImmediate(() => {
      const pending = scheduledPass;
      scheduledPass = undefined;
      if (!pending) return;
      try {
        wrappingPass(pending.pi);
      } catch {
        // The poll tick stays the backstop.
      }
    });
  } catch {
    // The poll tick stays the backstop.
  }
}

export function wrapStatus(): string {
  return wrapOutcome;
}

/** Class name of a node, the jiti-safe identity check (`instanceof`
 *  breaks across module instances; dist ships unminified so names hold).
 *  Unknown names fail closed: callers treat them as opaque content. */
function classNameOf(node: unknown): string | undefined {
  try {
    if (!node || typeof node !== "object") return undefined;
    const name = (node as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** A pi-tui `Spacer`: renders exactly one blank line, carries no content. */
function isSpacerLike(node: unknown): boolean {
  return classNameOf(node) === "Spacer";
}

/** A thinking run's region: a MouseRegion wrapping hidden (`Text`) or
 *  expanded (`Markdown`) thinking. Pi only ever wraps thinking runs this
 *  way (prose and errors render bare), and hidden-vs-visible is exactly
 *  Text-vs-Markdown — so the class encodes the run without any settings
 *  lookup, including per-run click-toggles. Global visible mode never
 *  reaches this check: the passes early-return while it is on. */
function isThinkingRegion(node: unknown): boolean {
  try {
    if (classNameOf(node) !== "MouseRegion") return false;
    const childName = classNameOf((node as { child?: unknown }).child);
    return childName === "Text" || childName === "Markdown";
  } catch {
    return false;
  }
}

/** The rendered children of an assistant row: Pi nests them one level down
 *  in the public `contentContainer` (images may attach beside it, which the
 *  fallback covers by scanning the row's own children). */
function rowKids(row: unknown): unknown[] {
  try {
    const container = (row as { contentContainer?: { children?: unknown } }).contentContainer;
    if (container && Array.isArray(container.children)) return container.children as unknown[];
    const direct = (row as { children?: unknown }).children;
    if (Array.isArray(direct)) return direct as unknown[];
  } catch {
    // Fall through to empty: no scannable children, no surgery.
  }
  return [];
}

/** True when the tool block and the row above share one visual block: the
 *  previous sibling renders a hidden thinking label (or is another tool
 *  row) with nothing else between. Prose, errors, first-child position,
 *  or anything unrecognized keeps the separator. Evaluated per render:
 *  a sibling streaming from thinking into prose flips the verdict live. */
function gluesToPrev(prev: unknown): boolean {
  try {
    if (!prev || typeof prev !== "object") return false;
    // Tool-to-tool run boundaries stay glued (r31 behavior).
    if (isToolComponent(prev)) return true;
    if (!isThinkingRow(prev)) return false;
    const kids = rowKids(prev);
    for (let i = kids.length - 1; i >= 0; i--) {
      if (isSpacerLike(kids[i])) continue;
      return isThinkingRegion(kids[i]);
    }
    return false;
  } catch {
    return false;
  }
}

/** Drop the leading spacers of a thinking row that opens directly under a
 *  tool row: after removal the row's first rendered line is its hidden
 *  label, glued to the tools above. Only spacers BEFORE the first
 *  non-spacer child go (a prose-first row keeps everything); the label
 *  itself is never touched. Returns spacers removed. Pi re-adds the
 *  spacer on its next content rebuild (streaming delta, visibility
 *  toggle), so the next pass simply re-applies — self-healing. */
function dropLeadingSpacers(row: unknown, prev: unknown): number {
  try {
    if (!isThinkingRow(row)) return 0;
    if (!prev || typeof prev !== "object" || !isToolComponent(prev)) return 0;
    const container = (row as { contentContainer?: { children?: unknown[]; removeChild?: (c: unknown) => unknown } }).contentContainer;
    if (!container || !Array.isArray(container.children) || typeof container.removeChild !== "function") return 0;
    let first = -1;
    for (let i = 0; i < container.children.length; i++) {
      if (isSpacerLike(container.children[i])) continue;
      first = i;
      break;
    }
    if (first < 0 || !isThinkingRegion(container.children[first])) return 0;
    const leading = container.children.slice(0, first);
    let dropped = 0;
    for (const child of leading) {
      try {
        container.removeChild(child);
        dropped++;
      } catch {
        // One stuck spacer keeps its blank; the rest still go.
      }
    }
    return dropped;
  } catch {
    return 0;
  }
}

/** A Pi tool execution component, duck-typed (never `instanceof`: jiti
 *  breaks it, same reason `isThinkingRow` duck-types). Real rows expose all
 *  four; stock Pi internals (`Spacer`, `Text`, `Container`) expose none of
 *  the tool trio, so they can never match. */
function isToolComponent(node: unknown): node is {
  toolCallId: string;
  getRenderShell(): string;
  render(width: number): string[];
  handleMouse(event: unknown): unknown;
} {
  if (!node || typeof node !== "object") return false;
  const candidate = node as Record<string, unknown>;
  return (
    typeof candidate.toolCallId === "string" &&
    typeof candidate.getRenderShell === "function" &&
    typeof candidate.render === "function" &&
    typeof candidate.handleMouse === "function"
  );
}

/** Wrap this instance iff it is OUR collapsed run owner: hidden thinking
 *  (visible mode keeps stock spacing), a self-shell component (our tools
 *  render through the self shell; foreign/default shells keep their
 *  `Spacer`+`Box` chrome), and the first tool of its trace run (non-owners
 *  render `[]`, nothing to strip). */
export function isWrappable(node: unknown, pi: ExtensionAPI): boolean {
  try {
    if (!isHiddenThinking(pi)) return false;
    if (!isToolComponent(node)) return false;
    let shell: string;
    try {
      shell = node.getRenderShell();
    } catch {
      return false;
    }
    if (shell !== "self") return false;
    const entry = traceEntries.get(node.toolCallId);
    if (!entry) return false;
    return traceOwnerId(entry.runId) === node.toolCallId;
  } catch {
    return false;
  }
}

/** Install the shadows. `getPrev` reads the live previous sibling on
 *  every render, so streaming siblings flip the verdict without a re-wrap.
 *  Returns true when this call wrapped. */
export function wrapToolComponent(
  node: unknown,
  pi: ExtensionAPI,
  getPrev?: () => unknown,
): boolean {
  try {
    if (!isToolComponent(node)) return false;
    if ((node as Record<symbol, unknown>)[WRAPPED] === true) return false;
    const unboundRender = node.render;
    const unboundHandleMouse = node.handleMouse;
    const origRender = node.render.bind(node);
    const origHandleMouse = node.handleMouse.bind(node);
    const prevOf = getPrev ?? (() => undefined);
    node.render = (width: number): string[] => {
      // Visible mode restores stock sections: bypass live, so a toggle
      // needs no unwrap pass and already-wrapped instances follow it.
      let hidden = true;
      try {
        hidden = isHiddenThinking(pi);
      } catch {
        hidden = true;
      }
      const lines = origRender(width);
      if (!hidden) return lines;
      let strip = false;
      try {
        strip = gluesToPrev(prevOf());
      } catch {
        strip = false;
      }
      if (strip && Array.isArray(lines) && lines.length > 0 && lines[0] === "") {
        return lines.slice(1);
      }
      return lines;
    };
    node.handleMouse = (event: unknown): unknown => {
      if (!event || typeof event !== "object") return origHandleMouse(event);
      const y = (event as { y?: unknown }).y;
      if (typeof y !== "number") return origHandleMouse(event);
      // A kept blank must keep stock hit behavior: only re-base when the
      // render above stripped the same line.
      let strip = false;
      try {
        strip = gluesToPrev(prevOf());
      } catch {
        strip = false;
      }
      if (!strip) return origHandleMouse(event);
      return origHandleMouse({ ...(event as Record<string, unknown>), y: y + 1 });
    };
    installedWraps.set(node, {
      shadowRender: node.render,
      shadowHandleMouse: node.handleMouse,
      origRender: unboundRender,
      origHandleMouse: unboundHandleMouse,
    });
    (node as Record<symbol, unknown>)[WRAPPED] = true;
    return true;
  } catch {
    return false;
  }
}

/** Remove the shadows iff they are still ours. Returns true when unwrapped. */
export function unwrapToolComponent(node: unknown): boolean {
  try {
    if (!node || typeof node !== "object") return false;
    if ((node as Record<symbol, unknown>)[WRAPPED] !== true) return false;
    const installed = installedWraps.get(node);
    if (!installed) return false;
    if (installed.shadowRender === (node as { render?: unknown }).render) {
      try {
        (node as { render: unknown }).render = installed.origRender;
      } catch {
        return false;
      }
    }
    if (installed.shadowHandleMouse === (node as { handleMouse?: unknown }).handleMouse) {
      try {
        (node as { handleMouse: unknown }).handleMouse = installed.origHandleMouse;
      } catch {
        // render already restored; a stale click shadow is cosmetically
        // inert (it only re-bases y on a then-stock layout).
      }
    }
    installedWraps.delete(node);
    try {
      delete (node as Record<symbol, unknown>)[WRAPPED];
    } catch {
      // Mark unreadable: treat as unwrapped; the methods are restored.
    }
    return true;
  } catch {
    return false;
  }
}

/** Restore every wrapped instance (teardown path; production rebuilds
 *  normally strand old instances, which die with their components). */
export function unwrapAll(): number {
  // Instances are only reachable via the tree; sweep it.
  let count = 0;
  try {
    const tui = walkerTui();
    const children = (tui as { children?: unknown } | undefined)?.children;
    if (!Array.isArray(children)) return 0;
    const stack: unknown[] = [...children];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (
        (node as Record<symbol, unknown>)[WRAPPED] === true ||
        (node as Record<symbol, unknown>)[ROW_SYNCED] === true
      ) {
        if (unwrapToolComponent(node)) count++;
        if (unsyncRowUpdates(node)) count++;
        continue;
      }
      const kids = (node as { children?: unknown }).children;
      if (Array.isArray(kids)) stack.push(...kids);
    }
  } catch {
    // Cosmetic only.
  }
  return count;
}

/** Walk the captured TUI tree: wrap wrappable run owners and drop the
 *  leading spacer of thinking rows that open directly under tools.
 *  Idempotent: wrapped instances are counted, never re-wrapped; missing
 *  spacers are simply not counted. Frames carry (parent, index) so both
 *  halves can read the live previous sibling. */
export function wrappingPass(pi: ExtensionAPI): WrapCounts {
  const counts: WrapCounts = { wrapped: 0, skipped: 0, already: 0, spacers: 0, synced: 0 };
  try {
    const tui = walkerTui();
    const children = (tui as { children?: unknown } | undefined)?.children;
    if (!Array.isArray(children)) {
      wrapOutcome = "inactive (no TUI handle)";
      return counts;
    }
    if (!isHiddenThinking(pi)) {
      wrapOutcome = "idle (thinking visible)";
      return counts;
    }
    const root = { children };
    const stack: { node: unknown; parent: { children: unknown[] }; index: number }[] = children.map(
      (node, index) => ({ node, parent: root as { children: unknown[] }, index }),
    );
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) continue;
      const { node, parent, index } = frame;
      if (!node || typeof node !== "object") continue;
      if ((node as Record<symbol, unknown>)[WRAPPED] === true) {
        counts.already++;
        continue;
      }
      if (isWrappable(node, pi)) {
        const kids = parent.children;
        const at = index;
        const getPrev = (): unknown =>
          Array.isArray(kids) && at > 0 ? kids[at - 1] : undefined;
        if (wrapToolComponent(node, pi, getPrev)) counts.wrapped++;
        else counts.skipped++;
        continue;
      }
      if (isThinkingRow(node)) {
        const kids = parent.children;
        const getPrev = (): unknown =>
          Array.isArray(kids) && index > 0 ? kids[index - 1] : undefined;
        try {
          counts.spacers += dropLeadingSpacers(node, getPrev());
        } catch {
          // Surgery skipped; the blank stays stock.
        }
        try {
          if (syncRowUpdates(node, pi, getPrev)) counts.synced++;
        } catch {
          // The next pass retries the install.
        }
      }
      counts.skipped++;
      const kids = (node as { children?: unknown }).children;
      if (Array.isArray(kids)) {
        const holder = { children: kids };
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ node: kids[i], parent: holder as { children: unknown[] }, index: i });
        }
      }
    }
    wrapOutcome = `active (${counts.wrapped} wrapped, ${counts.spacers} spacers dropped)`;
  } catch {
    wrapOutcome = "inactive (walk failed)";
  }
  return counts;
}
