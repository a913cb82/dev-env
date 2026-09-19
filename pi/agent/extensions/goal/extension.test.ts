import { describe, it, expect, vi, beforeEach } from "vitest";

function createMockPi() {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const tools = new Map<string, any>();
  const activeTools: string[] = ["read", "bash", "edit", "write"];
  const appendEntryCalls: any[] = [];
  const sendMessageCalls: any[] = [];
  const sendUserMessageCalls: any[] = [];

  const pi: any = {
    commands,
    handlers,
    tools,
    activeTools,
    appendEntryCalls,
    sendMessageCalls,
    sendUserMessageCalls,
    registerCommand: (name: string, opts: any) => {
      commands.set(name, opts);
    },
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      // pi activates extension tools registered at load (includeAllExtensionTools)
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.length = 0;
      activeTools.push(...names);
    },
    on: (event: string, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    appendEntry: (customType: string, data: any) => {
      appendEntryCalls.push({ customType, data });
    },
    sendMessage: (msg: any, opts?: any) => {
      sendMessageCalls.push({ msg, opts });
    },
    sendUserMessage: (content: any, opts?: any) => {
      sendUserMessageCalls.push({ content, opts });
    },
  };

  return pi;
}

function createMockCtx(overrides: any = {}) {
  const notifyCalls: any[] = [];
  const abortCalls: any[] = [];

  const ctx: any = {
    ui: {
      notify: (msg: string, level?: string) => notifyCalls.push({ msg, level }),
    },
    sessionManager: {
      getEntries: () => overrides.entries ?? [],
    },
    model: overrides.model ?? { provider: "test", id: "model", reasoning: false },
    thinkingLevel: "medium",
    isIdle: overrides.isIdle ?? (() => true),
    abort: () => {
      abortCalls.push({});
    },
    cwd: "/tmp",
    _notifyCalls: notifyCalls,
    _abortCalls: abortCalls,
  };
  return ctx;
}

async function emit(pi: any, event: string, payload: any, ctx: any) {
  const handlers = pi.handlers.get(event) ?? [];
  for (const handler of handlers) await handler(payload, ctx);
}

async function load(overrides: any = {}) {
  vi.resetModules();
  const pi = createMockPi();
  const ext = (await import("./index.js")).default;
  ext(pi);
  const ctx = createMockCtx(overrides);
  return { pi, ctx, handler: pi.commands.get("goal").handler };
}

// agent_settled wakes are intentionally delayed (see index.ts), so tests that
// expect a settle-driven wake must wait past the delay.
async function flushSettleWakes(ms = 350) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("goal extension - registration", () => {
  it("registers /goal command", async () => {
    const { pi, handler } = await load();
    expect(pi.commands.has("goal")).toBe(true);
    expect(handler).toBeTypeOf("function");
    expect(pi.commands.get("goal").description).toBeTruthy();
  });

  it("registers the update_goal tool", async () => {
    const { pi } = await load();
    expect(pi.tools.has("update_goal")).toBe(true);
    expect(pi.tools.get("update_goal").execute).toBeTypeOf("function");
  });

  it("never touches the system prompt", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    expect(pi.handlers.get("before_agent_start") ?? []).toHaveLength(0);
  });
});

describe("goal extension - tool availability (agent invisibility)", () => {
  it("hides update_goal when no goal exists", async () => {
    const { pi, ctx } = await load({ entries: [] });
    expect(pi.activeTools).toContain("update_goal");

    await emit(pi, "session_start", { reason: "startup" }, ctx);

    expect(pi.activeTools).not.toContain("update_goal");
    expect(pi.sendMessageCalls.length).toBe(0);
  });

  it("activates update_goal and wakes with the goal when a goal is set", async () => {
    const { pi, ctx, handler } = await load({ entries: [] });
    await emit(pi, "session_start", { reason: "startup" }, ctx);
    expect(pi.activeTools).not.toContain("update_goal");

    await handler("ship it", ctx);
    expect(pi.activeTools).toContain("update_goal");
    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("ship it");
  });

  it("removes update_goal after clear", async () => {
    const { pi, ctx, handler } = await load({ entries: [] });
    await handler("temporary goal", ctx);
    expect(pi.activeTools).toContain("update_goal");

    await handler("clear", ctx);
    expect(pi.activeTools).not.toContain("update_goal");
  });

  it("restores state on session_start", async () => {
    const { pi, ctx, handler } = await load({
      entries: [{ type: "custom", customType: "goal", data: { text: "old goal", paused: true } }],
    });
    await emit(pi, "session_start", { reason: "resume" }, ctx);

    expect(pi.activeTools).toContain("update_goal");
    await handler("", ctx);
    expect(ctx._notifyCalls.some((c: any) => c.msg.includes("paused") && c.msg.includes("old goal"))).toBe(true);
  });
});

describe("goal extension - command handler", () => {
  let pi: any;
  let ctx: any;
  let handler: any;

  beforeEach(async () => {
    ({ pi, ctx, handler } = await load());
  });

  it("sets and persists a goal", async () => {
    await handler("fix login redirect", ctx);
    expect(
      pi.appendEntryCalls.some(
        (c: any) => c.customType === "goal" && c.data.text === "fix login redirect" && c.data.paused === false
      )
    ).toBe(true);
    expect(ctx._notifyCalls.some((c: any) => c.msg.includes("Goal set"))).toBe(true);
  });

  it("updates an existing goal", async () => {
    await handler("old goal", ctx);
    await handler("new goal", ctx);
    expect(pi.appendEntryCalls.some((c: any) => c.customType === "goal" && c.data.text === "new goal")).toBe(true);
  });

  it("shows the current goal", async () => {
    await handler("my goal", ctx);
    ctx._notifyCalls.length = 0;
    await handler("", ctx);
    expect(ctx._notifyCalls.some((c: any) => c.msg.includes("my goal"))).toBe(true);
  });

  it("lists options and mentions budget in help text", async () => {
    expect(pi.commands.get("goal").description).toMatch(/budget/i);
    await handler("", ctx);
    const msg = ctx._notifyCalls.at(-1)?.msg ?? "";
    expect(msg).toMatch(/clear/);
    expect(msg).toMatch(/pause/);
    expect(msg).toMatch(/resume/);
    expect(msg).toMatch(/budget/);
  });

  it("exposes argument completions that filter as you type", async () => {
    const complete = pi.commands.get("goal").getArgumentCompletions;
    expect(complete).toBeTypeOf("function");
    expect(complete("cl").map((c: any) => c.value)).toEqual(["clear"]);
    expect(complete("clear")).toEqual([]);
    expect(complete("").length).toBeGreaterThan(0);
  });

  it("shows the budget line when a budget is set", async () => {
    await handler("my goal", ctx);
    await handler("budget 5", ctx);
    ctx._notifyCalls.length = 0;
    await handler("", ctx);
    expect(ctx._notifyCalls.some((c: any) => c.msg.includes("$5.00"))).toBe(true);
  });

  it("clears the goal", async () => {
    await handler("some goal", ctx);
    ctx._notifyCalls.length = 0;
    pi.appendEntryCalls.length = 0;
    await handler("clear", ctx);
    expect(pi.appendEntryCalls.some((c: any) => c.customType === "goal" && c.data.text === null)).toBe(true);
    expect(ctx._notifyCalls.some((c: any) => c.msg.toLowerCase().includes("clear"))).toBe(true);
  });

  it("pauses an existing goal", async () => {
    await handler("some goal", ctx);
    ctx._notifyCalls.length = 0;
    pi.appendEntryCalls.length = 0;
    await handler("pause", ctx);
    expect(
      pi.appendEntryCalls.some(
        (c: any) => c.customType === "goal" && c.data.text === "some goal" && c.data.paused === true
      )
    ).toBe(true);
    expect(ctx._notifyCalls.some((c: any) => c.msg.toLowerCase().includes("paused"))).toBe(true);
  });

  it("resumes a paused goal and wakes when idle", async () => {
    await handler("some goal", ctx);
    await handler("pause", ctx);
    pi.appendEntryCalls.length = 0;
    pi.sendMessageCalls.length = 0;
    await handler("resume", ctx);
    expect(
      pi.appendEntryCalls.some(
        (c: any) => c.customType === "goal" && c.data.text === "some goal" && c.data.paused === false
      )
    ).toBe(true);
    expect(pi.sendMessageCalls.length).toBe(1);
    expect(ctx._notifyCalls.some((c: any) => c.msg.toLowerCase().includes("resumed"))).toBe(true);
  });

  it("notifies plainly when pausing or resuming without a goal", async () => {
    await handler("pause", ctx);
    await handler("resume", ctx);
    expect(ctx._notifyCalls.some((c: any) => c.msg === "No goal to pause." && c.level === "info")).toBe(true);
    expect(ctx._notifyCalls.some((c: any) => c.msg === "No goal to resume." && c.level === "info")).toBe(true);
  });

  it("wakes with the goal as turn input when a goal is set while idle", async () => {
    await handler("do important work", ctx);
    expect(pi.sendUserMessageCalls.length).toBe(0);
    expect(pi.sendMessageCalls.length).toBe(1);

    const { msg, opts } = pi.sendMessageCalls[0];
    expect(msg.customType).toBe("goal-wake");
    expect(msg.content).toContain("do important work");
    expect(msg.content).toContain("update_goal");
    expect(msg.display).toBe(false);
    expect(msg.details).toEqual({ goal: "do important work" });
    expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("does not wake when not idle", async () => {
    ctx.isIdle = () => false;
    await handler("another goal", ctx);
    expect(pi.sendMessageCalls.length).toBe(0);
    expect(pi.sendUserMessageCalls.length).toBe(0);
  });
});

describe("goal extension - budgets", () => {
  it("sets and shows a budget", async () => {
    const { pi, ctx, handler } = await load();
    await handler("my goal", ctx);
    await handler("budget 5", ctx);

    expect(
      pi.appendEntryCalls.some(
        (c: any) => c.customType === "goal" && c.data.budgetTotal === 5 && c.data.budgetSpent === 0
      )
    ).toBe(true);
    expect(ctx._notifyCalls.some((c: any) => c.msg.includes("$5.00"))).toBe(true);

    ctx._notifyCalls.length = 0;
    await handler("budget", ctx);
    expect(ctx._notifyCalls.some((c: any) => c.msg.includes("$5.00") && c.msg.includes("remaining"))).toBe(true);
  });

  it("accepts $-prefixed amounts and disables on 0", async () => {
    const { pi, ctx, handler } = await load();
    await handler("my goal", ctx);

    await handler("budget $2.50", ctx);
    expect(pi.appendEntryCalls.some((c: any) => c.data.budgetTotal === 2.5)).toBe(true);

    await handler("budget 0", ctx);
    expect(pi.appendEntryCalls.some((c: any) => c.data.budgetTotal === null)).toBe(true);
    expect(ctx._notifyCalls.some((c: any) => c.msg.toLowerCase().includes("unlimited"))).toBe(true);
  });

  it("sets and shows a budget with no goal set", async () => {
    const { pi, ctx, handler } = await load();
    await handler("budget 5", ctx);
    expect(pi.appendEntryCalls.some((c: any) => c.data.budgetTotal === 5)).toBe(true);
    expect(pi.sendMessageCalls.length).toBe(0);

    ctx._notifyCalls.length = 0;
    await handler("budget", ctx);
    expect(ctx._notifyCalls.some((c: any) => c.msg.includes("$5.00"))).toBe(true);
  });

  it("treats non-amount budget text as a goal", async () => {
    const { pi, ctx, handler } = await load();
    await handler("budget review", ctx);
    expect(pi.appendEntryCalls.some((c: any) => c.data.text === "budget review")).toBe(true);
  });

  it("accumulates spend on turn_end while budgeted", async () => {
    const { pi, ctx, handler } = await load();
    await handler("my goal", ctx);
    await handler("budget 5", ctx);
    pi.appendEntryCalls.length = 0;

    const turn = {
      message: { role: "assistant", usage: { cost: { total: 1.25 } } },
      toolResults: [{ usage: { cost: { total: 0.75 } } }],
    };
    await emit(pi, "turn_end", turn, ctx);
    expect(pi.appendEntryCalls.some((c: any) => c.data.budgetSpent === 2)).toBe(true);

    await emit(pi, "turn_end", { message: { role: "assistant" }, toolResults: [] }, ctx);
    expect(pi.appendEntryCalls.some((c: any) => c.data.budgetSpent === 2)).toBe(true);
    expect(ctx._notifyCalls.some((c: any) => c.level === "warning")).toBe(false);
  });

  it("accumulates sub-cent turns without cent-rounding loss", async () => {
    const { pi, ctx, handler } = await load();
    await handler("my goal", ctx);
    await handler("budget 5", ctx);
    pi.appendEntryCalls.length = 0;

    // A flushed subagent turn ($0.000325-type) riding on a cheap parent turn.
    const turn = {
      message: { role: "assistant", usage: { cost: { total: 0.0002 } } },
      toolResults: [{ usage: { cost: { total: 0.000324926 } } }],
    };
    await emit(pi, "turn_end", turn, ctx);
    await emit(pi, "turn_end", turn, ctx);
    const spent = pi.appendEntryCalls.map((c: any) => c.data.budgetSpent);
    expect(spent.some((s: number) => Math.abs(s - 0.001049852) < 1e-12)).toBe(true);
  });

  it("ignores spend without a budget, without a goal, or while paused", async () => {
    const { pi, ctx, handler } = await load();
    await handler("budget 20", ctx);
    const turn = {
      message: { role: "assistant", usage: { cost: { total: 9 } } },
      toolResults: [],
    };

    pi.appendEntryCalls.length = 0;
    await emit(pi, "turn_end", turn, ctx);
    expect(pi.appendEntryCalls.length).toBe(0);

    await handler("my goal", ctx);
    await emit(pi, "turn_end", turn, ctx);
    await handler("pause", ctx);
    pi.appendEntryCalls.length = 0;
    await emit(pi, "turn_end", turn, ctx);
    expect(pi.appendEntryCalls.length).toBe(0);
  });

  it("keeps the budget across goal replacement and clear", async () => {
    const { pi, ctx, handler } = await load();
    await handler("goal one", ctx);
    await handler("budget 10", ctx);
    await emit(
      pi,
      "turn_end",
      { message: { role: "assistant", usage: { cost: { total: 2 } } }, toolResults: [] },
      ctx
    );
    await handler("clear", ctx);
    const cleared = pi.appendEntryCalls.at(-1);
    expect(cleared.data.text).toBeNull();
    expect(cleared.data.budgetTotal).toBe(10);
    expect(cleared.data.budgetSpent).toBe(2);

    await handler("goal two", ctx);
    await emit(
      pi,
      "turn_end",
      { message: { role: "assistant", usage: { cost: { total: 1 } } }, toolResults: [] },
      ctx
    );
    expect(pi.appendEntryCalls.some((c: any) => c.data.text === "goal two" && c.data.budgetSpent === 3)).toBe(true);
  });

  it("disabling keeps spent for a later re-enable", async () => {
    const { pi, ctx, handler } = await load();
    await handler("my goal", ctx);
    await handler("budget 10", ctx);
    await emit(
      pi,
      "turn_end",
      { message: { role: "assistant", usage: { cost: { total: 4 } } }, toolResults: [] },
      ctx
    );
    await handler("budget 0", ctx);
    const disabled = pi.appendEntryCalls.at(-1);
    expect(disabled.data.budgetTotal).toBeNull();
    expect(disabled.data.budgetSpent).toBe(4);
  });

  it("auto-pauses when the budget is exhausted", async () => {
    const { pi, ctx, handler } = await load();
    await handler("my goal", ctx);
    await handler("budget 2", ctx);
    pi.appendEntryCalls.length = 0;
    ctx._notifyCalls.length = 0;

    await emit(
      pi,
      "turn_end",
      { message: { role: "assistant", usage: { cost: { total: 2.5 } } }, toolResults: [] },
      ctx
    );

    expect(
      pi.appendEntryCalls.some(
        (c: any) => c.data.budgetSpent === 2.5 && c.data.paused === true
      )
    ).toBe(true);
    expect(ctx._notifyCalls.some((c: any) => c.level === "info" && /exhausted/i.test(c.msg))).toBe(true);

    pi.sendMessageCalls.length = 0;
    await emit(pi, "agent_settled", {}, ctx);
    expect(pi.sendMessageCalls.length).toBe(0);
  });

  it("pauses immediately when the cap is set below spent", async () => {
    const { pi, ctx, handler } = await load();
    await handler("my goal", ctx);
    await handler("budget 10", ctx);
    await emit(
      pi,
      "turn_end",
      { message: { role: "assistant", usage: { cost: { total: 3 } } }, toolResults: [] },
      ctx
    );
    ctx._notifyCalls.length = 0;

    await handler("budget 2", ctx);
    expect(pi.appendEntryCalls.some((c: any) => c.data.paused === true)).toBe(true);
    expect(ctx._notifyCalls.some((c: any) => c.level === "info" && /exhausted/i.test(c.msg))).toBe(true);
  });

  it("keeps budget invisible in the wake message", async () => {
    const { pi, ctx, handler } = await load();
    await handler("my goal", ctx);
    await handler("budget 5", ctx);
    await emit(
      pi,
      "turn_end",
      { message: { role: "assistant", usage: { cost: { total: 1 } } }, toolResults: [] },
      ctx
    );
    pi.sendMessageCalls.length = 0;

    await emit(pi, "agent_settled", {}, ctx);
    await flushSettleWakes();

    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("my goal");
    expect(pi.sendMessageCalls[0].msg.content).not.toMatch(/budget/i);
    expect(pi.sendMessageCalls[0].msg.content).not.toMatch(/\$/);
  });

  it("restores budget state on session_start", async () => {
    const { pi, ctx, handler } = await load({
      entries: [
        { type: "custom", customType: "goal", data: { text: "old goal", paused: false, budgetTotal: 5, budgetSpent: 1 } },
      ],
    });
    await emit(pi, "session_start", { reason: "resume" }, ctx);
    ctx._notifyCalls.length = 0;
    await handler("budget", ctx);
    expect(ctx._notifyCalls.some((c: any) => c.msg.includes("$4.00"))).toBe(true);
  });
});

describe("goal extension - wake on settle (no stop condition)", () => {
  it("wakes with the goal while a goal is active", async () => {
    const { pi, ctx, handler } = await load();
    await handler("keep going", ctx);
    pi.sendMessageCalls.length = 0;

    await emit(pi, "agent_settled", {}, ctx);
    await flushSettleWakes();

    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("keep going");
    expect(pi.sendMessageCalls[0].msg.display).toBe(false);
  });

  it("keeps waking on every settle until cleared", async () => {
    const { pi, ctx, handler } = await load();
    await handler("loop goal", ctx);
    pi.sendMessageCalls.length = 0;

    for (let i = 0; i < 5; i++) {
      await emit(pi, "agent_settled", {}, ctx);
    }
    await flushSettleWakes();

    expect(pi.sendMessageCalls.length).toBe(5);
    expect(pi.appendEntryCalls.some((c: any) => c.data.paused === true)).toBe(false);
  });

  it("does not wake without a goal", async () => {
    const { pi, ctx } = await load();
    await emit(pi, "agent_settled", {}, ctx);
    expect(pi.sendMessageCalls.length).toBe(0);
  });

  it("does not wake while paused", async () => {
    const { pi, ctx, handler } = await load();
    await handler("paused goal", ctx);
    await handler("pause", ctx);
    pi.sendMessageCalls.length = 0;

    await emit(pi, "agent_settled", {}, ctx);
    await flushSettleWakes();
    expect(pi.sendMessageCalls.length).toBe(0);
  });

  it("restored goals wake on settle", async () => {
    const { pi, ctx } = await load({
      entries: [{ type: "custom", customType: "goal", data: { text: "restored goal", paused: false } }],
    });
    await emit(pi, "session_start", { reason: "startup" }, ctx);
    await emit(pi, "agent_settled", {}, ctx);
    await flushSettleWakes();

    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("restored goal");
  });
});

describe("goal extension - update_goal tool", () => {
  it("clears the goal and deactivates itself", async () => {
    const { pi, ctx, handler } = await load({ entries: [] });
    await emit(pi, "session_start", { reason: "startup" }, ctx);
    await handler("ship it", ctx);
    pi.appendEntryCalls.length = 0;

    const tool = pi.tools.get("update_goal");
    const res = await tool.execute("call-1", { action: "clear" }, undefined, undefined, ctx);
    expect(res.content[0].text).toContain("cleared");
    expect(pi.appendEntryCalls.some((c: any) => c.data.text === null)).toBe(true);
    expect(pi.activeTools).not.toContain("update_goal");
  });

  it("rejects pause — the agent must unblock itself", async () => {
    const { pi, ctx, handler } = await load({ entries: [] });
    await handler("ship it", ctx);

    const tool = pi.tools.get("update_goal");
    await expect(
      tool.execute("call-1", { action: "pause" }, undefined, undefined, ctx)
    ).rejects.toThrow(/unknown action/i);
    // Goal stays active after the rejected pause.
    expect(pi.appendEntryCalls.some((c: any) => c.data.paused === true)).toBe(false);
    expect(pi.activeTools).toContain("update_goal");
  });

  it("tells the agent clear is only for achievement", async () => {
    const { pi } = await load();
    const tool = pi.tools.get("update_goal");
    expect(tool.description).toMatch(/only when.*achieved/i);
    expect(tool.description).not.toMatch(/pause/i);
    expect(tool.promptGuidelines.join(" ")).toMatch(/fully achieved/i);
    expect(tool.promptGuidelines.join(" ")).not.toMatch(/pause/i);
  });

  it("rejects unknown actions", async () => {
    const { pi, ctx, handler } = await load({ entries: [] });
    await handler("ship it", ctx);
    const tool = pi.tools.get("update_goal");
    await expect(
      tool.execute("call-1", { action: "resume" }, undefined, undefined, ctx)
    ).rejects.toThrow(/unknown action/i);
    await expect(
      tool.execute("call-1", { action: "pause" }, undefined, undefined, ctx)
    ).rejects.toThrow(/unknown action/i);
  });

  it("rejects when no goal is active", async () => {
    const { pi, ctx } = await load({ entries: [] });
    await emit(pi, "session_start", { reason: "startup" }, ctx);
    const tool = pi.tools.get("update_goal");
    await expect(
      tool.execute("call-1", { action: "clear" }, undefined, undefined, ctx)
    ).rejects.toThrow(/no active goal/i);
  });
});

describe("goal extension - manual compaction", () => {
  it("does not wake on agent_settled while compaction is in progress", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    pi.sendMessageCalls.length = 0;

    await emit(pi, "session_before_compact", { reason: "manual" }, ctx);
    await emit(pi, "agent_settled", {}, ctx);
    await flushSettleWakes();

    expect(pi.sendMessageCalls.length).toBe(0);
  });

  it("does not start a turn synchronously on the abort settle before compaction", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    pi.sendMessageCalls.length = 0;

    // The abort settle that kicks off /compact must not synchronously start a
    // new turn (that deadlocks compact's waitForIdle); it is deferred instead.
    await emit(pi, "agent_settled", {}, ctx);
    expect(pi.sendMessageCalls.length).toBe(0);

    await emit(pi, "session_before_compact", { reason: "manual" }, ctx);
    await flushSettleWakes();
    expect(pi.sendMessageCalls.length).toBe(0);

    await emit(pi, "session_compact", { reason: "manual" }, ctx);
    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("ship feature X");
  });

  it("defers resume-during-compaction until session_compact", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    await handler("pause", ctx);
    await emit(pi, "session_before_compact", { reason: "manual" }, ctx);
    pi.sendMessageCalls.length = 0;

    await handler("resume", ctx);
    expect(pi.sendMessageCalls.length).toBe(0);
    expect(ctx._notifyCalls.some((c: any) => c.msg.toLowerCase().includes("resumed"))).toBe(true);

    await emit(pi, "session_compact", { reason: "manual" }, ctx);
    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("ship feature X");
  });

  it("defers a newly set goal until session_compact", async () => {
    const { pi, ctx, handler } = await load();
    await emit(pi, "session_before_compact", { reason: "manual" }, ctx);
    pi.sendMessageCalls.length = 0;

    await handler("brand new goal", ctx);
    expect(pi.sendMessageCalls.length).toBe(0);

    await emit(pi, "session_compact", { reason: "manual" }, ctx);
    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("brand new goal");
  });

  it("pause during compaction cancels the pending wake", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    await emit(pi, "session_before_compact", { reason: "manual" }, ctx);
    await emit(pi, "agent_settled", {}, ctx);
    await handler("pause", ctx);
    pi.sendMessageCalls.length = 0;

    await emit(pi, "session_compact", { reason: "manual" }, ctx);
    await flushSettleWakes();
    expect(pi.sendMessageCalls.length).toBe(0);
  });

  it("clear during compaction cancels the pending wake", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    await emit(pi, "session_before_compact", { reason: "manual" }, ctx);
    await emit(pi, "agent_settled", {}, ctx);
    await handler("clear", ctx);
    pi.sendMessageCalls.length = 0;

    await emit(pi, "session_compact", { reason: "manual" }, ctx);
    await flushSettleWakes();
    expect(pi.sendMessageCalls.length).toBe(0);
  });

  it("compaction cancel flushes the pending wake", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    await handler("pause", ctx);
    const controller = new AbortController();
    await emit(pi, "session_before_compact", { reason: "manual", signal: controller.signal }, ctx);
    pi.sendMessageCalls.length = 0;

    await handler("resume", ctx);
    expect(pi.sendMessageCalls.length).toBe(0);

    controller.abort();
    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("ship feature X");
  });

  it("a pause inside the settle delay suppresses the wake", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    pi.sendMessageCalls.length = 0;

    await emit(pi, "agent_settled", {}, ctx);
    await handler("pause", ctx);
    await flushSettleWakes();
    expect(pi.sendMessageCalls.length).toBe(0);
  });

  it("resumes after compaction even with no wake requested during it", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    pi.sendMessageCalls.length = 0;

    // Agent idle (no settle timer pending), compaction runs with no
    // intervening events, then finishes. The loop must resume anyway.
    await emit(pi, "session_before_compact", { reason: "manual" }, ctx);
    await emit(pi, "session_compact", { reason: "manual" }, ctx);

    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("ship feature X");
  });

  it("resumes after failed/cancelled compaction", async () => {
    const { pi, ctx, handler } = await load();
    await handler("ship feature X", ctx);
    await emit(pi, "session_before_compact", { reason: "manual" }, ctx);
    await emit(pi, "agent_settled", {}, ctx);
    pi.sendMessageCalls.length = 0;

    await emit(pi, "session_compact_failed", { reason: "manual", aborted: true }, ctx);
    expect(pi.sendMessageCalls.length).toBe(1);
    expect(pi.sendMessageCalls[0].msg.content).toContain("ship feature X");

    // Drain the backup wake, then prove the flag is truly cleared: later
    // settles wake normally.
    await flushSettleWakes();
    pi.sendMessageCalls.length = 0;
    await emit(pi, "agent_settled", {}, ctx);
    await flushSettleWakes();
    expect(pi.sendMessageCalls.length).toBe(1);
  });

  it("session_start resets compaction state", async () => {
    const entries = [
      { type: "custom", customType: "goal", data: { text: "ship feature X", paused: false } },
    ];
    const { pi, ctx } = await load({ entries });
    await emit(pi, "session_start", { reason: "startup" }, ctx);
    await emit(pi, "session_before_compact", { reason: "manual" }, ctx);
    pi.sendMessageCalls.length = 0;

    await emit(pi, "agent_settled", {}, ctx);
    await flushSettleWakes();
    expect(pi.sendMessageCalls.length).toBe(0);

    // Reload clears the suppression: settles wake normally again.
    await emit(pi, "session_start", { reason: "reload" }, ctx);
    await emit(pi, "agent_settled", {}, ctx);
    await flushSettleWakes();
    expect(pi.sendMessageCalls.length).toBe(1);
  });
});
