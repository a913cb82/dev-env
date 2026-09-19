import { describe, it, expect } from "vitest";
import {
  parseGoalArgs,
  parseBudgetAmount,
  buildGoalWakeContent,
  findLastGoalState,
  formatDollars,
  remainingBudget,
  turnCost,
  goalArgumentCompletions,
  UPDATE_GOAL_TOOL,
} from "./logic.js";

describe("parseGoalArgs", () => {
  it("returns show when empty", () => {
    expect(parseGoalArgs("")).toEqual({ action: "show" });
    expect(parseGoalArgs("   ")).toEqual({ action: "show" });
  });

  it("returns clear for /goal clear", () => {
    expect(parseGoalArgs("clear")).toEqual({ action: "clear" });
    expect(parseGoalArgs("  clear  ")).toEqual({ action: "clear" });
    expect(parseGoalArgs("CLEAR")).toEqual({ action: "clear" });
  });

  it("returns pause for /goal pause", () => {
    expect(parseGoalArgs("pause")).toEqual({ action: "pause" });
    expect(parseGoalArgs("  PAUSE  ")).toEqual({ action: "pause" });
  });

  it("returns resume for /goal resume", () => {
    expect(parseGoalArgs("resume")).toEqual({ action: "resume" });
    expect(parseGoalArgs("Resume")).toEqual({ action: "resume" });
  });

  it("returns budgetShow for /goal budget", () => {
    expect(parseGoalArgs("budget")).toEqual({ action: "budgetShow" });
    expect(parseGoalArgs("  BUDGET  ")).toEqual({ action: "budgetShow" });
  });

  it("returns budgetSet for /goal budget <amount>", () => {
    expect(parseGoalArgs("budget 5")).toEqual({ action: "budgetSet", amount: 5 });
    expect(parseGoalArgs("budget $2.50")).toEqual({ action: "budgetSet", amount: 2.5 });
    expect(parseGoalArgs("budget 0")).toEqual({ action: "budgetSet", amount: 0 });
  });

  it("treats non-amount budget text as a goal", () => {
    expect(parseGoalArgs("budget review")).toEqual({ action: "set", text: "budget review" });
    expect(parseGoalArgs("budget cuts needed")).toEqual({
      action: "set",
      text: "budget cuts needed",
    });
  });

  it("returns set for normal text", () => {
    expect(parseGoalArgs("fix login redirect")).toEqual({ action: "set", text: "fix login redirect" });
    expect(parseGoalArgs("  fix login redirect  ")).toEqual({ action: "set", text: "fix login redirect" });
  });

  it("preserves case for set", () => {
    expect(parseGoalArgs("Fix Login BUG")).toEqual({ action: "set", text: "Fix Login BUG" });
  });
});

describe("parseBudgetAmount", () => {
  it("parses plain and $-prefixed amounts", () => {
    expect(parseBudgetAmount("5")).toBe(5);
    expect(parseBudgetAmount("$5")).toBe(5);
    expect(parseBudgetAmount("2.50")).toBe(2.5);
    expect(parseBudgetAmount("  $0.75  ")).toBe(0.75);
    expect(parseBudgetAmount("0")).toBe(0);
  });

  it("rejects non-amounts", () => {
    expect(parseBudgetAmount("")).toBeNull();
    expect(parseBudgetAmount("abc")).toBeNull();
    expect(parseBudgetAmount("-3")).toBeNull();
    expect(parseBudgetAmount("5x")).toBeNull();
    expect(parseBudgetAmount("$")).toBeNull();
  });
});

describe("buildGoalWakeContent", () => {
  it("contains the goal text", () => {
    expect(buildGoalWakeContent("fix login redirect")).toContain("fix login redirect");
  });

  it("tells the agent to clear via the update_goal tool when done", () => {
    const content = buildGoalWakeContent("ship feature");
    expect(content).toContain(UPDATE_GOAL_TOOL);
    expect(content).toMatch(/achieved/);
  });

  it("says the goal persists across turns", () => {
    expect(buildGoalWakeContent("ship feature")).toMatch(/persists/i);
  });

  it("never exposes budget to the agent", () => {
    const content = buildGoalWakeContent("ship feature");
    expect(content).not.toMatch(/budget/i);
    expect(content).not.toMatch(/\$/);
  });
});

describe("goalArgumentCompletions", () => {
  it("lists all subcommands on empty input", () => {
    expect(goalArgumentCompletions("").map((c) => c.value)).toEqual([
      "clear",
      "pause",
      "resume",
      "budget",
    ]);
    expect(goalArgumentCompletions("   ").map((c) => c.value)).toEqual([
      "clear",
      "pause",
      "resume",
      "budget",
    ]);
  });

  it("filters as you type", () => {
    expect(goalArgumentCompletions("cl").map((c) => c.value)).toEqual(["clear"]);
    expect(goalArgumentCompletions("b").map((c) => c.value)).toEqual(["budget"]);
    expect(goalArgumentCompletions("PA").map((c) => c.value)).toEqual(["pause"]);
    expect(goalArgumentCompletions("xyz")).toEqual([]);
  });

  it("returns nothing on an exact subcommand so Enter submits", () => {
    expect(goalArgumentCompletions("clear")).toEqual([]);
    expect(goalArgumentCompletions("CLEAR")).toEqual([]);
    expect(goalArgumentCompletions("budget")).toEqual([]);
  });

  it("suggests amounts after budget", () => {
    const all = goalArgumentCompletions("budget ").map((c) => c.value);
    expect(all).toContain("5");
    expect(all).toContain("0");
    expect(goalArgumentCompletions("budget 2").map((c) => c.value)).toEqual(["20"]);
    expect(goalArgumentCompletions("budget 5")).toEqual([]);
  });

  it("returns nothing for free text or unknown subcommands", () => {
    expect(goalArgumentCompletions("fix login")).toEqual([]);
    expect(goalArgumentCompletions("clear now")).toEqual([]);
    expect(goalArgumentCompletions("budget 5x")).toEqual([]);
  });
});

describe("formatDollars", () => {
  it("formats to two decimals", () => {
    expect(formatDollars(5)).toBe("$5.00");
    expect(formatDollars(2.5)).toBe("$2.50");
    expect(formatDollars(0)).toBe("$0.00");
  });

  it("rounds float drift", () => {
    expect(formatDollars(0.1 + 0.2)).toBe("$0.30");
  });

  it("shows sub-cent amounts with more precision", () => {
    expect(formatDollars(0.0042)).toBe("$0.0042");
    expect(formatDollars(0.0005)).toBe("$0.0005");
    expect(formatDollars(0.000001)).toBe("$0.00");
  });
});

describe("remainingBudget", () => {
  it("subtracts spent and floors at zero", () => {
    expect(remainingBudget(5, 1.5)).toBe(3.5);
    expect(remainingBudget(5, 5)).toBe(0);
    expect(remainingBudget(5, 9)).toBe(0);
  });
});

describe("turnCost", () => {
  it("sums assistant and nested tool usage", () => {
    const message = { role: "assistant", usage: { cost: { total: 1.25 } } };
    const toolResults = [{ usage: { cost: { total: 0.75 } } }, {}];
    expect(turnCost(message, toolResults)).toBe(2);
  });

  it("ignores missing or invalid usage", () => {
    expect(turnCost({ role: "assistant" }, [])).toBe(0);
    expect(turnCost({ role: "user" }, [])).toBe(0);
    expect(turnCost(null, null as any)).toBe(0);
    expect(turnCost({ role: "assistant", usage: { cost: { total: NaN } } }, [])).toBe(0);
    expect(turnCost({ role: "assistant", usage: { cost: { total: -2 } } }, [])).toBe(0);
  });

  it("keeps sub-cent turns at full precision", () => {
    const message = { role: "assistant", usage: { cost: { total: 0.0002 } } };
    const toolResults = [{ usage: { cost: { total: 0.000324926 } } }];
    expect(turnCost(message, toolResults)).toBeCloseTo(0.000524926, 12);
  });
});

describe("findLastGoalState", () => {
  it("returns null for empty entries", () => {
    expect(findLastGoalState([])).toBeNull();
  });

  it("returns text and paused flag", () => {
    const entries: any[] = [
      { type: "custom", customType: "goal", data: { text: "first" } },
      { type: "message", message: { role: "user" } },
      { type: "custom", customType: "goal", data: { text: "second", paused: true } },
    ];
    expect(findLastGoalState(entries)).toEqual({
      text: "second",
      paused: true,
      budgetTotal: null,
      budgetSpent: 0,
    });
  });

  it("defaults paused to false for legacy entries", () => {
    const entries: any[] = [{ type: "custom", customType: "goal", data: { text: "legacy" } }];
    expect(findLastGoalState(entries)).toEqual({
      text: "legacy",
      paused: false,
      budgetTotal: null,
      budgetSpent: 0,
    });
  });

  it("reads budget fields when present", () => {
    const entries: any[] = [
      { type: "custom", customType: "goal", data: { text: "g", paused: false, budgetTotal: 5, budgetSpent: 1.25 } },
    ];
    expect(findLastGoalState(entries)).toEqual({
      text: "g",
      paused: false,
      budgetTotal: 5,
      budgetSpent: 1.25,
    });
  });

  it("restores sub-cent spend at full precision", () => {
    const entries: any[] = [
      { type: "custom", customType: "goal", data: { text: "g", paused: false, budgetTotal: 5, budgetSpent: 0.000524926 } },
    ];
    expect(findLastGoalState(entries)).toEqual({
      text: "g",
      paused: false,
      budgetTotal: 5,
      budgetSpent: 0.000524926,
    });
  });

  it("ignores invalid budget fields", () => {
    const entries: any[] = [
      { type: "custom", customType: "goal", data: { text: "g", budgetTotal: 0, budgetSpent: -2 } },
    ];
    expect(findLastGoalState(entries)).toEqual({
      text: "g",
      paused: false,
      budgetTotal: null,
      budgetSpent: 0,
    });
  });

  it("returns text null but keeps the budget when the latest entry cleared it", () => {
    const entries: any[] = [
      { type: "custom", customType: "goal", data: { text: "first", budgetTotal: 5, budgetSpent: 2 } },
      { type: "custom", customType: "goal", data: { text: null, budgetTotal: 5, budgetSpent: 2 } },
    ];
    expect(findLastGoalState(entries)).toEqual({
      text: null,
      paused: false,
      budgetTotal: 5,
      budgetSpent: 2,
    });
  });

  it("ignores other custom types", () => {
    const entries: any[] = [
      { type: "custom", customType: "other", data: { text: "ignored" } },
      { type: "custom", customType: "goal", data: { text: "real" } },
    ];
    expect(findLastGoalState(entries)).toEqual({
      text: "real",
      paused: false,
      budgetTotal: null,
      budgetSpent: 0,
    });
  });

  it("handles undefined data.text", () => {
    const entries: any[] = [{ type: "custom", customType: "goal", data: {} }];
    expect(findLastGoalState(entries)).toEqual({
      text: null,
      paused: false,
      budgetTotal: null,
      budgetSpent: 0,
    });
  });
});
