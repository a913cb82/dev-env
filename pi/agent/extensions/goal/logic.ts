export type ParseGoalResult =
  | { action: "show" }
  | { action: "clear" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "set"; text: string }
  | { action: "budgetShow" }
  | { action: "budgetSet"; amount: number };

export const UPDATE_GOAL_TOOL = "update_goal";

export type GoalCompletion = { value: string; label: string; description?: string };

const GOAL_SUBCOMMANDS: GoalCompletion[] = [
  { value: "clear", label: "clear", description: "Remove the session goal" },
  { value: "pause", label: "pause", description: "Stop automatic wakes (keeps the goal)" },
  { value: "resume", label: "resume", description: "Restart automatic wakes" },
  { value: "budget", label: "budget", description: "Show or set the dollar budget" },
];

const BUDGET_AMOUNT_SUGGESTIONS = ["0", "1", "5", "10", "20", "50", "100"];

// Argument completions for /goal. Filters as you type; returns [] on an exact
// or complete input so the popup dismisses and Enter submits immediately.
export function goalArgumentCompletions(argumentText: string): GoalCompletion[] {
  const trimmed = argumentText.trim();
  if (!trimmed) return [...GOAL_SUBCOMMANDS];
  const parts = trimmed.split(/\s+/);
  const hasSecondToken = parts.length > 1 || /\s$/.test(argumentText);
  if (!hasSecondToken) {
    const lower = parts[0].toLowerCase();
    if (GOAL_SUBCOMMANDS.some((s) => s.value === lower)) return [];
    return GOAL_SUBCOMMANDS.filter((s) => s.value.startsWith(lower));
  }
  if (parts[0].toLowerCase() !== "budget") return [];
  const amountPrefix = parts.length > 1 ? parts.slice(1).join(" ") : "";
  if (BUDGET_AMOUNT_SUGGESTIONS.includes(amountPrefix)) return [];
  return BUDGET_AMOUNT_SUGGESTIONS.filter((a) => a.startsWith(amountPrefix)).map((a) => ({
    value: a,
    label: a === "0" ? "0 (disable)" : `$${a}`,
    description: a === "0" ? "Disable the budget (unlimited)" : `Set budget to $${a}`,
  }));
}

export function parseBudgetAmount(raw: string): number | null {
  const match = raw.trim().match(/^\$?(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

export function parseGoalArgs(args: string): ParseGoalResult {
  const trimmed = args.trim();
  if (!trimmed) return { action: "show" };
  const lower = trimmed.toLowerCase();
  if (lower === "clear") return { action: "clear" };
  if (lower === "pause") return { action: "pause" };
  if (lower === "resume") return { action: "resume" };
  if (lower === "budget") return { action: "budgetShow" };
  const budgetMatch = trimmed.match(/^budget\s+(.+)$/i);
  if (budgetMatch) {
    const amount = parseBudgetAmount(budgetMatch[1]);
    if (amount !== null) return { action: "budgetSet", amount };
  }
  return { action: "set", text: trimmed };
}

export function buildGoalWakeContent(goal: string): string {
  const objective = goal.trim();
  return (
    `[GOAL] ${objective}\n\nContinue working toward this goal. ` +
    `The goal persists across turns — ending a turn does not complete it. ` +
    `You are responsible for unblocking yourself — work around blockers autonomously. ` +
    `If the goal is achieved, call ${UPDATE_GOAL_TOOL} with action "clear".`
  );
}

export function formatDollars(n: number): string {
  const cents = Math.round(n * 100) / 100;
  if (cents !== 0) return `$${cents.toFixed(2)}`;
  // Sub-cent amounts (e.g. $0.0005 turns) still show movement.
  const micro = Math.round(n * 10000) / 10000;
  if (micro !== 0) return `$${micro.toFixed(4)}`;
  return "$0.00";
}

export function remainingBudget(total: number, spent: number): number {
  return Math.max(0, Math.round((total - spent) * 100) / 100);
}

function usageCostTotal(usage: any): number {
  const total = usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}

/** Dollar cost of one turn: assistant usage + nested tool usage (mirrors pi's session totals).
 * Kept at full precision: cheap models bill sub-cent turns ($0.0003-type), and
 * cent-rounding here would silently drop them from the budget. Display rounds. */
export function turnCost(message: any, toolResults: any[]): number {
  let total = 0;
  if (message?.role === "assistant") total += usageCostTotal(message.usage);
  for (const result of toolResults ?? []) total += usageCostTotal(result?.usage);
  return total;
}

export type GoalState = {
  text: string | null;
  paused: boolean;
  budgetTotal: number | null;
  budgetSpent: number;
};

// Returns null only when no goal entries exist at all. The budget outlives
// goals, so even a cleared (text: null) entry carries the budget forward.
export function findLastGoalState(entries: any[]): GoalState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "custom") continue;
    if (e?.customType !== "goal") continue;
    const data = e?.data;
    const rawTotal = data?.budgetTotal;
    const budgetTotal =
      typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal > 0
        ? rawTotal
        : null;
    const rawSpent = data?.budgetSpent;
    const budgetSpent =
      typeof rawSpent === "number" && Number.isFinite(rawSpent) && rawSpent > 0
        ? rawSpent
        : 0;
    const text = data?.text;
    if (typeof text === "string" && text.trim().length > 0) {
      return { text, paused: data?.paused === true, budgetTotal, budgetSpent };
    }
    return { text: null, paused: false, budgetTotal, budgetSpent };
  }
  return null;
}
