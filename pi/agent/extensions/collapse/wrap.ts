/** Per-instance render wrap for collapsed run owners.
 *
 * Pi's `ToolExecutionComponent` prepends one blank line to every non-empty
 * self-shell render (`lines.push("")` before content lines), and the custom
 * renderer cannot suppress it. Merging runs got that cost from one-per-tool
 * to one-per-run; this pass deletes the last one by shadowing two methods
 * on the run-owner instance only:
 *
 *   render: drop a single leading "" (leave everything else byte-identical)
 *   handleMouse: re-base y by +1 (Pi rejects y<=0 and delegates y-1, so
 *     displayed rows shift up by exactly the stripped line)
 *
 * Deletion (not assignment-to-undefined) restores the prototype methods on
 * unwrap. Visible mode self-bypasses inside the wrapped render (live
 * setting check), so toggling thinking visible restores stock spacing even
 * on already-wrapped instances. Never a prototype touch, never Pi sources:
 * delete the shadows and Pi is exactly as shipped.
 *
 * Fail-open throughout: anything unrecognized (wrong shape, foreign tool,
 * default shell, non-owner, visible mode, hostile handle) is skipped, and a
 * skipped wrap renders exactly today's output.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { walkerTui } from "./labels.js";
import { isHiddenThinking } from "./settings.js";
import { traceEntries, traceOwnerId } from "./trace.js";

export interface WrapCounts {
  wrapped: number;
  skipped: number;
  already: number;
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

export function wrapStatus(): string {
  return wrapOutcome;
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

/** Install the shadows. Returns true when this call wrapped. */
export function wrapToolComponent(node: unknown, pi: ExtensionAPI): boolean {
  try {
    if (!isToolComponent(node)) return false;
    if ((node as Record<symbol, unknown>)[WRAPPED] === true) return false;
    const unboundRender = node.render;
    const unboundHandleMouse = node.handleMouse;
    const origRender = node.render.bind(node);
    const origHandleMouse = node.handleMouse.bind(node);
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
      if (Array.isArray(lines) && lines.length > 0 && lines[0] === "") {
        return lines.slice(1);
      }
      return lines;
    };
    node.handleMouse = (event: unknown): unknown => {
      if (!event || typeof event !== "object") return origHandleMouse(event);
      const y = (event as { y?: unknown }).y;
      if (typeof y !== "number") return origHandleMouse(event);
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
      if ((node as Record<symbol, unknown>)[WRAPPED] === true) {
        if (unwrapToolComponent(node)) count++;
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

/** Walk the captured TUI tree and wrap wrappable run owners. Idempotent:
 *  wrapped instances are counted, never re-wrapped. */
export function wrappingPass(pi: ExtensionAPI): WrapCounts {
  const counts: WrapCounts = { wrapped: 0, skipped: 0, already: 0 };
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
    const stack: unknown[] = [...children];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if ((node as Record<symbol, unknown>)[WRAPPED] === true) {
        counts.already++;
        continue;
      }
      if (isWrappable(node, pi)) {
        if (wrapToolComponent(node, pi)) counts.wrapped++;
        else counts.skipped++;
        continue;
      }
      counts.skipped++;
      const kids = (node as { children?: unknown }).children;
      if (Array.isArray(kids)) stack.push(...kids);
    }
    wrapOutcome = `active (${counts.wrapped} wrapped, ${counts.already} already)`;
  } catch {
    wrapOutcome = "inactive (walk failed)";
  }
  return counts;
}
