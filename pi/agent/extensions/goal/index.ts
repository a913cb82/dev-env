import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  UPDATE_GOAL_TOOL,
  parseGoalArgs,
  buildGoalWakeContent,
  findLastGoalState,
  formatDollars,
  remainingBudget,
  turnCost,
  goalArgumentCompletions,
} from "./logic.js";

const WAKE_MESSAGE_TYPE = "goal-wake";

export default function (pi: ExtensionAPI) {
  let goal: string | null = null;
  let paused = false;
  let budgetTotal: number | null = null;
  let budgetSpent = 0;

  // Manual (/compact) and automatic compaction rebuild agent state around the
  // summarization call. A wake fired mid-compaction either deadlocks compact's
  // `await abort()` (the abort settle synchronously starts a new turn, so idle
  // never arrives) or starts a turn whose messages are then discarded by
  // compact's `agent.state.messages = ...` reset — surfacing as
  // "Operation aborted". Wakes are therefore suppressed while compacting:
  // - agent_settled wakes are delayed by SETTLE_WAKE_DELAY_MS so the abort
  //   settle that precedes session_before_compact lands inside the compacting
  //   window (dropped) instead of starting a turn inside compact's abort;
  // - every compaction end (success, failure, or cancel) resumes the loop
  //   unconditionally when a goal is active: an immediate wake plus a backup
  //   delayed wake. Resume is state-based, not paired with a wake observed
  //   mid-compaction, so no interleaving can strand the loop — and the backup
  //   covers a flush-wake whose fire-and-forget send failed silently.
  let compacting = false;
  const settleTimers = new Set<ReturnType<typeof setTimeout>>();
  const SETTLE_WAKE_DELAY_MS = 250;

  function clearSettleTimers() {
    for (const t of settleTimers) clearTimeout(t);
    settleTimers.clear();
  }

  function notify(
    ctx: any,
    msg: string,
    level: "info" | "warning" | "error" = "info"
  ) {
    ctx.ui?.notify?.(msg, level);
  }

  // update_goal is registered once but only active while a goal exists, so the
  // agent sees nothing goal-related (tool, guidelines, wake) otherwise.
  function syncToolAvailability() {
    const active = pi.getActiveTools();
    const has = active.includes(UPDATE_GOAL_TOOL);
    const wanted = !!goal?.trim();
    if (wanted && !has) {
      pi.setActiveTools([...active, UPDATE_GOAL_TOOL]);
    } else if (!wanted && has) {
      pi.setActiveTools(active.filter((name) => name !== UPDATE_GOAL_TOOL));
    }
  }

  function save() {
    pi.appendEntry("goal", { text: goal, paused, budgetTotal, budgetSpent });
    syncToolAvailability();
  }

  function restore(ctx: any) {
    const found = findLastGoalState(ctx.sessionManager.getEntries() ?? []);
    goal = found?.text ?? null;
    paused = found?.paused ?? false;
    budgetTotal = found?.budgetTotal ?? null;
    budgetSpent = found?.budgetSpent ?? 0;
    syncToolAvailability();
  }

  function budgetLine(): string | null {
    if (budgetTotal === null) return null;
    return (
      `Budget: ${formatDollars(remainingBudget(budgetTotal, budgetSpent))} ` +
      `remaining of ${formatDollars(budgetTotal)} (${formatDollars(budgetSpent)} used).`
    );
  }

  // Codex-style wake: the goal travels as the turn's input message (hidden in
  // the TUI), never as a system-prompt line. The agent always sees the current
  // goal when woken, so it can continue an old task or pivot to a new one.
  // There is deliberately no wake budget or auto-stop: wakes fire on every
  // settle until the agent clears the goal or the user clears/pauses it.
  // The dollar budget is a user-side spend guard only: it is never shown to
  // the agent. Exhaustion pauses the goal.
  function scheduleDelayedWake(ctx: any) {
    if (!goal?.trim() || paused) return;
    const timer = setTimeout(() => {
      settleTimers.delete(timer);
      try {
        wake(ctx);
      } catch {
        // Session replaced during the delay; drop the wake.
      }
    }, SETTLE_WAKE_DELAY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    settleTimers.add(timer);
  }

  function wake(ctx: any) {
    if (!goal?.trim() || paused) return;
    if (compacting) return;
    if (!ctx.isIdle()) return;
    pi.sendMessage(
      {
        customType: WAKE_MESSAGE_TYPE,
        content: buildGoalWakeContent(goal),
        display: false,
        details: { goal },
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }

  // Resume after any compaction end: wake now (idle-guarded) plus a backup
  // delayed wake in case the immediate send failed silently or the agent was
  // transiently busy. When healthy the backup finds a running turn and drops.
  function resumeAfterCompaction(ctx: any) {
    compacting = false;
    clearSettleTimers();
    wake(ctx);
    scheduleDelayedWake(ctx);
  }

  // The budget outlives goals: it is never reset here, only by /goal budget x.
  function setGoal(text: string, ctx: any) {
    goal = text;
    paused = false;
    save();
    notify(ctx, `Goal set: ${text}`);
    wake(ctx);
  }

  function clearGoal(ctx: any) {
    const had = !!goal?.trim();
    goal = null;
    paused = false;
    save();
    notify(ctx, had ? "Goal cleared" : "No goal to clear.");
  }

  function pauseGoal(ctx: any) {
    if (!goal?.trim()) {
      notify(ctx, "No goal to pause.");
      return;
    }
    if (paused) {
      notify(ctx, "Goal is already paused.");
      return;
    }
    paused = true;
    save();
    notify(ctx, "Goal paused — automatic wakes stopped. Use /goal resume to continue.");
  }

  function resumeGoal(ctx: any) {
    if (!goal?.trim()) {
      notify(ctx, "No goal to resume.");
      return;
    }
    if (!paused) {
      notify(ctx, "Goal is already active.");
      return;
    }
    paused = false;
    save();
    notify(ctx, "Goal resumed.");
    wake(ctx);
  }

  function exhaustBudget(ctx: any) {
    paused = true;
    save();
    notify(
      ctx,
      `Goal budget exhausted (${formatDollars(budgetSpent)} used of ${formatDollars(budgetTotal ?? 0)}). ` +
        `Goal paused — use /goal resume to continue or /goal budget <dollars> to raise it.`
    );
  }

  function showBudget(ctx: any) {
    notify(ctx, budgetLine() ?? "No budget set (unlimited). Use /goal budget <dollars> to set one.");
  }

  function setBudget(amount: number, ctx: any) {
    if (amount === 0) {
      budgetTotal = null;
      save();
      notify(ctx, "Goal budget disabled (unlimited).");
      return;
    }
    budgetTotal = amount;
    if (budgetSpent >= budgetTotal && goal?.trim()) {
      exhaustBudget(ctx);
    } else {
      save();
      notify(
        ctx,
        `Goal budget set: ${formatDollars(remainingBudget(budgetTotal, budgetSpent))} ` +
          `remaining of ${formatDollars(budgetTotal)}.`
      );
    }
  }

  pi.registerCommand("goal", {
    description: "Set, show, clear, pause, resume, or budget the session goal",
    getArgumentCompletions: (prefix: string) => goalArgumentCompletions(prefix),
    handler: async (args: string, ctx: any) => {
      const parsed = parseGoalArgs(args);
      switch (parsed.action) {
        case "show":
          if (goal?.trim()) {
            const line = budgetLine();
            notify(
              ctx,
              `Goal${paused ? " (paused)" : ""}: ${goal}` +
                (line ? `\n${line}` : "") +
                `\nSubcommands: clear, pause, resume, budget [<dollars>]`
            );
          } else {
            notify(ctx, "No goal set. Use /goal <text> to set one.\nSubcommands: clear, pause, resume, budget [<dollars>].");
          }
          return;
        case "clear":
          clearGoal(ctx);
          return;
        case "pause":
          pauseGoal(ctx);
          return;
        case "resume":
          resumeGoal(ctx);
          return;
        case "budgetShow":
          showBudget(ctx);
          return;
        case "budgetSet":
          setBudget(parsed.amount, ctx);
          return;
        case "set":
          setGoal(parsed.text, ctx);
          return;
      }
    },
  });

  pi.registerTool({
    name: UPDATE_GOAL_TOOL,
    label: "Update Goal",
    description:
      "Clear the active session goal only when it has been fully " +
      "achieved — never to abandon unfinished work, skip remaining steps, or stop early. " +
      "You are responsible for unblocking yourself.",
    promptSnippet: "Clear the active session goal when achieved",
    promptGuidelines: [
      `Use ${UPDATE_GOAL_TOOL} with action "clear" only when the active goal has been fully achieved.`,
    ],
    parameters: Type.Object({
      action: StringEnum(["clear"] as const, {
        description: "clear: goal achieved",
      }),
    }),

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      if (!goal?.trim()) {
        throw new Error("update_goal: no active goal");
      }
      switch (params.action) {
        case "clear":
          clearGoal(ctx);
          return {
            content: [{ type: "text", text: "Goal cleared." }],
            details: { action: "clear", goal: null, paused: false },
          };
        default:
          throw new Error(`update_goal: unknown action "${String(params.action)}"`);
      }
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    compacting = false;
    clearSettleTimers();
    restore(ctx);
  });
  pi.on("session_tree", async (_event: any, ctx: any) => {
    compacting = false;
    clearSettleTimers();
    restore(ctx);
  });

  // Compaction lifecycle: suppress wakes while the session is being rebuilt,
  // then resume unconditionally (see resumeAfterCompaction). No ctx.abort()
  // here: in TUI mode it is a no-op for the agent, and on newer cores a
  // session abort would cancel the very compaction in flight.
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    compacting = true;
    clearSettleTimers();
    event?.signal?.addEventListener?.(
      "abort",
      () => {
        if (!compacting) return;
        resumeAfterCompaction(ctx);
      },
      { once: true }
    );
  });

  pi.on("session_compact", async (_event: any, ctx: any) => {
    // In-memory state is authoritative across compaction (custom entries are
    // never trimmed from the session file), so no restore() — just resume.
    resumeAfterCompaction(ctx);
  });

  // Newer cores (0.85+) report failed/cancelled compaction to extensions;
  // older cores never emit this (the cast keeps this loadable there too).
  (pi as any).on("session_compact_failed", async (_event: any, ctx: any) => {
    resumeAfterCompaction(ctx);
  });

  // Spend accrues only while a goal is set, unpaused, and budgeted.
  pi.on("turn_end", async (event: any, ctx: any) => {
    if (!goal?.trim() || paused || budgetTotal === null) return;
    const cost = turnCost(event?.message, event?.toolResults);
    if (cost <= 0) return;
    budgetSpent += cost; // full precision; display rounds via formatDollars
    if (budgetSpent >= budgetTotal) {
      exhaustBudget(ctx);
    } else {
      save();
    }
  });

  // Wake a sleeping agent while an active goal exists. Delayed so the abort
  // settle that kicks off a manual /compact lands inside the compacting
  // window (dropped above) instead of synchronously starting a turn that
  // deadlocks compact's waitForIdle.
  pi.on("agent_settled", (_event: any, ctx: any) => {
    if (compacting) return;
    scheduleDelayedWake(ctx);
  });
}
