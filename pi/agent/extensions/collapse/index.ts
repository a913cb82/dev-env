// Collapse tool calls into one-line rows — only while "Thinking blocks:
// hidden" is on. Flipping thinking to visible restores the stock tool
// sections; the toggle is read live from settings, so the next render pass
// follows it immediately (no reload).
//
// Each row is a marker, not a prompt. One leading space puts the first
// glyph on column 2, where Pi's prose, thinking rows and stock cells start:
//    read /path/to/file:10-20                    5.3k ch
//    $ timeout 25 ls some/dist                   0.1k ch
// Three levels, one meaning each: BOLD is identity (the tool name, and the
// command word of every segment of a bash/powershell command), PLAIN is the
// one specific thing acted on (file name, search pattern, path leaf, bare
// argument), DIM is everything else (gutter, dirs, operators, flags,
// numbers, ranges, timeouts, sizes, generic summaries). Violet carries the head
// because some terminals render SGR-1 weight indistinguishably; red replaces
// it when the tool failed. Rows truncate in the middle so head and tail
// survive; the count stays at the right edge.
//
// One component per run
// ---------------------
// Adjacent tool calls share ONE component (the run's first tool owns the
// trace), so Pi emits a single blank line per run instead of one per tool.
// A run continues across turn boundaries; only a turn whose VISIBLE content
// (prose or a thinking block) renders above its tools starts a new run,
// so consecutive tool-only turns stay gapless. Transcript rebuilds from
// history (startup, compaction, session switch/fork, tree navigation) give
// each historical tool its own run, so old rows never teleport.
//
// Click depth
// -----------
// Rows always rest as one-liners. A click opens that row's stock cell at the
// depth Pi currently asks for: the stock COLLAPSED cell while Pi is
// collapsed (ctrl+o off), the stock EXPANDED cell while Pi is expanded.
// Toggling ctrl+o re-depths already-open rows; clicking an open row closes
// it. Both depths are byte-identical to a real ToolExecutionComponent
// (pinned by tests).
//
// Thinking blocks keep Pi's hidden label, updated per turn to a grey preview
// with its size:
//   about something rea…lots of thoughts were here. 1.5k ch
// The label is a plain string, so it is rebuilt on terminal resize.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  detachPass,
  hiddenRunCount,
  isMessageHidden,
  noteSessionManager,
  resetDetachState,
  runThinkingForTool,
} from "./detach.js";
export {
  detachPass,
  hiddenRunCount,
  isMessageHidden,
  resetDetachState,
  runThinkingForTool,
};
import {
  captureWalkerTui,
  reconcileStreamingLabel,
  reconcileThinkingLabels,
  streamStatus,
  walkerStatus,
  walkerWidget,
  WALKER_KEY,
} from "./labels.js";
import { scheduleWrappingPass, unwrapAll, wrappingPass, wrapStatus } from "./wrap.js";
export { captureWalkerTui, reconcileStreamingLabel, reconcileThinkingLabels, scheduleWrappingPass, unwrapAll, wrappingPass, wrapStatus };
import {
  planToolRuns,
} from "./logic.js";
import {
  clearCollapsePokes,
  collapseDefinition,
  collapseTool,
  makeLeftByName,
  pokeAllCollapse,
  wrappedToolNames,
} from "./rows.js";
import { isHiddenThinking } from "./settings.js";
import {
  applyPlannedRuns,
  armHistoryPhase,
  boundaryReasons,
  endHistoryPhase,
  traceBoundary,
  traceOnMessageStart,
  traceOnMessageUpdate,
  traceOnToolExecutionStart,
  traceSummary,
} from "./trace.js";

/** Tests reset the registry through this; production never calls it. */
export { resetTraceState } from "./trace.js";
export { collapseDefinition };

const COLLAPSE_REVISION = 48;

const WRAP_SLOT = "__collapseWrapTool";
const POLL_SLOT = "__collapsePollTick";
let collapseSawUI = false;
let collapseLastHidden: boolean | undefined;

/** One poll tick: if the thinking-visibility setting flipped since the last
 *  tick, invalidate every known tool so it re-renders in the other mode. */
function collapseTick(pi: ExtensionAPI): void {
  try {
    if (!collapseSawUI) return;
    detachPass(pi);
    wrappingPass(pi);
    // Also on the poll: a resize changes the label width, and reconcile is
    // idempotent per row (message + width + pad), so this relabels exactly
    // the rows whose label no longer fits.
    reconcileThinkingLabels(pi);
    const hidden = (pi?.getSettings?.()?.hideThinkingBlock ?? false) === true;
    if (collapseLastHidden === undefined || hidden === collapseLastHidden) {
      collapseLastHidden = hidden;
      return;
    }
    collapseLastHidden = hidden;
    pokeAllCollapse();
  } catch {
    // Cosmetic only; never break the loop.
  }
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  try {
    collapseLastHidden = (pi?.getSettings?.()?.hideThinkingBlock ?? false) === true;
  } catch {
    collapseLastHidden = undefined;
  }

  pi.registerCommand("collapse", {
    description: "Show collapse extension status (proves this revision is loaded)",
    handler: async (_args, ctx) => {
      detachPass(pi);
      wrappingPass(pi);
      ctx.ui.notify(
        `collapse r${COLLAPSE_REVISION}: ${isHiddenThinking(pi) ? "compact rows (thinking hidden)" : "stock sections (thinking visible)"}; ${traceSummary()}; boundaries: ${boundaryReasons.join(" → ") || "none yet"}; thinking label: default (Pi stock); thinking walk: ${walkerStatus()} (${streamStatus()}); wrap: ${wrapStatus()}; hidden: ${hiddenRunCount()} run(s)${uncollapsedReport(pi)}`,
      );
    },
  });

  // One source of truth: the same table paints the rows and builds the tools,
  // so a name can never drift between the two.
  const definitions: Record<
    string,
    ((dir: string) => any) | undefined
  > = {
    read: createReadToolDefinition,
    bash: createBashToolDefinition,
    powershell: createPowerShellToolDefinition,
    edit: createEditToolDefinition,
    write: createWriteToolDefinition,
    grep: createGrepToolDefinition,
    find: createFindToolDefinition,
    ls: createLsToolDefinition,
  };
  for (const [name, makeLeft] of Object.entries(makeLeftByName)) {
    const create = definitions[name];
    if (!create) continue;
    pi.registerTool(collapseTool(create(cwd), makeLeft, pi));
  }

  // Tools from other extensions and MCP servers can only collapse if they hand
  // us their definition (getAllTools exposes metadata, not renderers). Sibling
  // extensions opt in through the global slot below; anything else is listed
  // here so a plain row is never a mystery.
  const uncollapsedReport = (api: ExtensionAPI): string => {
    const own = new Set([...Object.keys(definitions), ...wrappedToolNames()]);
    let all: { name: string }[] = [];
    try {
      all = api.getAllTools?.() ?? [];
    } catch {
      return "";
    }
    const missing = all.map((tool) => tool.name).filter((name) => !own.has(name));
    return missing.length > 0 ? `; not collapsed (no definition access): ${missing.join(", ")}` : "";
  };

  // Sibling extensions (for example subagents) cannot be inspected from the
  // outside: getAllTools returns metadata but not the execute function or the
  // renderers. They call this slot at registration time instead, which keeps
  // their definition intact and only overlays the row renderers.
  try {
    (globalThis as Record<string, unknown>)[WRAP_SLOT] = (definition: any) =>
      collapseDefinition(definition, pi);
  } catch {
    // Fixture hosts without a global object: nothing to share.
  }
  pi.on("session_shutdown", () => {
    try {
      const g = globalThis as Record<string, unknown>;
      // Only clear our own slot; a newer activation may already own it.
      if (typeof g[WRAP_SLOT] === "function") delete g[WRAP_SLOT];
    } catch {
      // Host without globals: nothing to clear.
    }
  });


  // Visibility-toggle poller: no toggle event exists, and the toggle
  // skips tool components, so poll the setting and poke known tools.
  // No unload hook exists; the previous activation's timer is replaced via
  // the shared slot. Unref'd so it never holds the process open.
  try {
    const g = globalThis as Record<string, unknown>;
    const prev = g[POLL_SLOT];
    if (typeof prev === "object" && prev !== null) clearInterval((prev as { timer: unknown }).timer as any);
    const timer = setInterval(() => {
      if ((g[POLL_SLOT] as { timer?: unknown } | undefined)?.timer !== timer) {
        clearInterval(timer);
        return;
      }
      collapseTick(pi);
    }, 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
    g[POLL_SLOT] = { timer, tick: () => collapseTick(pi) };
  } catch {
    // Timers unavailable: renders still follow the setting, minus live pokes.
  }

  // Backfill from history: the newest text-bearing turn may predate this
  // extension load (or the latest turns may be encrypted), so scan the
  // branch on startup instead of waiting for a fresh text turn.
  // A new transcript block starts a fresh tool run: a following tool must
  // not join the previous run's trace (its row would teleport). Boundaries:
  // turn/message ends, non-assistant messages, foreign tools, user bash,
  // compaction, and session start (which also drops dead registrations).
  const boundary = (reason: string) => traceBoundary(reason);
  pi.on("session_start", (_event, ctx) => {
    try {
      clearCollapsePokes();
      // History is rendered before this event; keep those entries so their
      // rows stay put, but seal the run so live tools start a fresh trace.
      endHistoryPhase("session-start");
      if (ctx.hasUI) collapseSawUI = true;
      try {
        ctx.ui?.setWidget?.(WALKER_KEY, (tui: unknown) => {
          captureWalkerTui(tui);
          // The handle becomes valid inside a render; schedule the pass for
          // the tick right after it commits (coalesced, idempotent), so
          // post-reload rows converge in milliseconds, not on the 1s poll.
          scheduleWrappingPass(pi);
          return walkerWidget();
        });
      } catch {
        // No widget host (RPC/print): rows keep the stock label.
      }
      reconcileThinkingLabels(pi);
      const sm = ctx.sessionManager as any;
      noteSessionManager(sm);
      const entries =
        typeof sm?.getBranch === "function" ? sm.getBranch() : (sm?.getEntries?.() ?? []);
      // The rebuild rendered one run per history tool (anti-teleport while
      // positions were unknown). Merge contiguous groups now: rows stay
      // where they are, but share one component, so one blank line total.
      applyPlannedRuns(planToolRuns(entries, isOwnTool));
      // Detach only after planning: applyPlannedRuns reassigns run ids,
      // and the replacement preview row is keyed by the final run.
      detachPass(pi, sm);
      wrappingPass(pi);
    } catch {
      // Label update is cosmetic; never break startup.
    }
  });

  // Per-row thinking labels: reconcile whenever rows land (history),
  // stream (partials), or finalize (message_end runs before Pi's own
  // finalize, so the deferred triggers below converge on the final text).
  const reconcileRows = () => {
    reconcileThinkingLabels(pi);
  };
  pi.on("session_start", () => reconcileRows());
  pi.on("message_start", (event) => {
    traceOnMessageStart(event);
    reconcileRows();
    // Shadow the new row before its first content lands: otherwise its
    // first paint carries the stock label and the un-healed leading spacer
    // (the row appears one line low, then jumps up when the pass runs).
    scheduleWrappingPass(pi);
  });
  pi.on("message_update", (event) => {
    traceOnMessageUpdate(event);
    // Live preview: Pi renders no thinking region until text exists, so
    // writing our label on the delta means the stock `Thinking...` never
    // paints. Throttled per row; the settle pass fixes the final count.
    reconcileStreamingLabel(pi, (event as { message?: unknown })?.message);
    scheduleWrappingPass(pi);
  });
  pi.on("message_end", () => {
    reconcileRows();
    detachPass(pi);
    wrappingPass(pi);
  });
  pi.on("tool_execution_start", () => {
    reconcileRows();
    // A tool row owned by the trace needs its wrap before the first paint.
    scheduleWrappingPass(pi);
  });
  pi.on("turn_end", () => {
    reconcileRows();
    detachPass(pi);
    wrappingPass(pi);
  });
  // Tools that opted into collapsing (the global wrap slot) render their
  // own rows, so they merge like the built-ins; anything else still splits.
  const isOwnTool = (name: string): boolean =>
    !!makeLeftByName[name] || wrappedToolNames().includes(name);
  pi.on("tool_execution_start", (event) => {
    traceOnToolExecutionStart(event, isOwnTool);
  });
  // Pi validates user_bash results (undefined or a valid result object):
  // never leak traceBoundary's return value through the arrow body.
  pi.on("user_bash", () => {
    traceBoundary("user-bash");
  });
  // Anything that rebuilds the transcript from history arms the history pass.
  pi.on("session_compact", () => armHistoryPhase("session-compact"));
  pi.on("session_before_switch", () => armHistoryPhase("session-switch"));
  pi.on("session_before_fork", () => armHistoryPhase("session-fork"));
  pi.on("session_before_tree", () => armHistoryPhase("session-tree"));
  // Completion events seal the pass so live turns merge again.
  pi.on("session_tree", () => endHistoryPhase("session-tree"));
}
