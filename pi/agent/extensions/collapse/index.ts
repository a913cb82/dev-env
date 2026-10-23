// Collapse tool calls into one-line rows — only while "Thinking blocks:
// hidden" is on. Flipping thinking to visible restores the stock tool
// sections; the toggle is read live from settings, so the next render pass
// follows it immediately (no reload).
//
// Each row is a marker, not a prompt:
//   › read /path/to/file:10-20                    5.3k ch
//   › $ timeout 25 ls some/dist                   0.1k ch
// The tool head is bold violet (red when the tool failed), the read
// directory grey, the file name bold, the line range red, and the output
// size grey and right-aligned. Violet carries the head because some
// terminals render SGR-1 weight indistinguishably. Rows truncate in the
// middle so head and tail survive; the count stays at the right edge.
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
  extractThinkingText,
  findLatestThinkingText,
  thinkingLabelForWidth,
} from "./logic.js";
import {
  clearCollapsePokes,
  collapseDefinition,
  collapseTool,
  makeLeftByName,
  pokeAllCollapse,
  wrappedToolNames,
} from "./rows.js";
import { currentColumns, isHiddenThinking, liveOutputPad } from "./settings.js";
import {
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

const COLLAPSE_REVISION = 22;

const WRAP_SLOT = "__collapseWrapTool";
const POLL_SLOT = "__collapsePollTick";
let collapseSawUI = false;
let collapseLastHidden: boolean | undefined;

/** One poll tick: if the thinking-visibility setting flipped since the last
 *  tick, invalidate every known tool so it re-renders in the other mode. */
function collapseTick(pi: ExtensionAPI): void {
  try {
    if (!collapseSawUI) return;
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

/** Raw material to rebuild the thinking label after a resize: the label is
 *  a plain string, so every width change needs a fresh budget + reissue.
 *  setHiddenThinkingLabel pushes the rebuild into all existing rows. */
const thinkingLive: { text?: string; ui?: any; width?: number } = {};
const RESIZE_SLOT = "__collapseResizeHandler";

/** One-line label sized to the live terminal, count pinned right. The label
 *  is a plain string (no render-time width), so budget up front from
 *  stdout.columns with a non-tty fallback. */
function widthAwareThinkingLabel(thinking: string, pi: ExtensionAPI): string {
  return thinkingLabelForWidth(thinking, currentColumns(), liveOutputPad(pi));
}

/** Last label handed to Pi: setHiddenThinkingLabel re-renders every assistant
 *  row, so repeating the same string is pure churn (terminated turns fire
 *  message_end once per attempt). */
let thinkingLabelSent: string | undefined;

function applyThinkingLabel(
  thinking: string | undefined,
  ctx: any,
  setLast: (label: string) => void,
  pi: ExtensionAPI,
): void {
  if (ctx.hasUI) collapseSawUI = true;
  if (!thinking || !ctx.hasUI) return;
  try {
    const label = widthAwareThinkingLabel(thinking, pi);
    thinkingLive.text = thinking;
    thinkingLive.ui = ctx.ui;
    thinkingLive.width = currentColumns();
    setLast(label);
    if (label === thinkingLabelSent) return;
    thinkingLabelSent = label;
    ctx.ui.setHiddenThinkingLabel(label);
  } catch {
    // Label update is cosmetic; never break the turn.
  }
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  let lastThinkingLabel: string | undefined;
  try {
    collapseLastHidden = (pi?.getSettings?.()?.hideThinkingBlock ?? false) === true;
  } catch {
    collapseLastHidden = undefined;
  }

  // Rebuild the thinking label on terminal resize/zoom: tool rows re-render
  // at the new width on their own, but the label is a fixed string.
  // No unload hook exists, so the previous activation's listener is removed
  // via the shared slot before installing this one.
  try {
    const g = globalThis as Record<string, unknown>;
    const prev = g[RESIZE_SLOT];
    if (typeof prev === "function") process.stdout?.off?.("resize", prev as (...args: any[]) => void);
    const onResize = () => {
      try {
        const cols = currentColumns();
        if (cols === undefined || cols === thinkingLive.width) return;
        const { text, ui } = thinkingLive;
        if (!text || !ui?.setHiddenThinkingLabel) return;
        const label = thinkingLabelForWidth(text, cols, liveOutputPad(pi));
        thinkingLive.width = cols;
        lastThinkingLabel = label;
        ui.setHiddenThinkingLabel(label);
      } catch {
        // Cosmetic only; never break the loop.
      }
    };
    g[RESIZE_SLOT] = onResize;
    if (process.stdout?.isTTY && typeof process.stdout.on === "function") {
      process.stdout.on("resize", onResize);
    }
  } catch {
    // Non-tty hosts (tests, pipes): resizing cannot happen; skip silently.
  }

  pi.registerCommand("collapse", {
    description: "Show collapse extension status (proves this revision is loaded)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `collapse r${COLLAPSE_REVISION}: ${isHiddenThinking(pi) ? "compact rows (thinking hidden)" : "stock sections (thinking visible)"}; ${traceSummary()}; boundaries: ${boundaryReasons.join(" → ") || "none yet"}; thinking label: ${lastThinkingLabel ?? "default — no thinking text seen this session"}${uncollapsedReport(pi)}`,
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
      if (ctx.hasUI && ctx.ui) thinkingLive.ui = ctx.ui;
      const sm = ctx.sessionManager as any;
      const entries =
        typeof sm?.getBranch === "function" ? sm.getBranch() : (sm?.getEntries?.() ?? []);
      applyThinkingLabel(
        findLatestThinkingText(entries),
        ctx,
        (label) => {
          lastThinkingLabel = label;
        },
        pi,
      );
    } catch {
      // Label update is cosmetic; never break startup.
    }
  });

  pi.on("message_start", (event) => traceOnMessageStart(event));
  pi.on("message_update", (event) => traceOnMessageUpdate(event));
  pi.on("tool_execution_start", (event) =>
    // Tools that opted into collapsing (the global wrap slot) render their
    // own rows, so they merge like the built-ins; anything else still splits.
    traceOnToolExecutionStart(event, (name) => !!makeLeftByName[name] || wrappedToolNames().includes(name)),
  );
  pi.on("user_bash", () => traceBoundary("user-bash"));
  // Anything that rebuilds the transcript from history arms the history pass.
  pi.on("session_compact", () => armHistoryPhase("session-compact"));
  pi.on("session_before_switch", () => armHistoryPhase("session-switch"));
  pi.on("session_before_fork", () => armHistoryPhase("session-fork"));
  pi.on("session_before_tree", () => armHistoryPhase("session-tree"));
  // Completion events seal the pass so live turns merge again.
  pi.on("session_tree", () => endHistoryPhase("session-tree"));
  pi.on("message_end", (event, ctx) => {
    // No boundary: a tool-only turn merges with the run above it. Turns
    // that do carry visible content split via message_update instead.
    applyThinkingLabel(
      extractThinkingText((event as { message?: unknown }).message as any),
      ctx,
      (label) => {
        lastThinkingLabel = label;
      },
      pi,
    );
  });
}
