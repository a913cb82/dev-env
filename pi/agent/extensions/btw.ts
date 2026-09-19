/**
 * /btw — side question in parallel with the main turn.
 *
 * - snapshots full branch (user + assistant + toolResults, compaction-aware)
 *   unlike /fork UI which only offers user messages
 * - runs via modelRegistry.complete with its own AbortController,
 *   NOT via sendMessage/sendUserMessage (those queue as steer/followUp)
 * - non-modal UI (setWidget/setStatus), handler returns immediately,
 *   so the main turn keeps progressing
 *
 * Usage:
 *   /btw why is this test flaky?   — replaces any running/finished btw
 *   /btw-clear                    — cancel/clear it
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const BTW_SYSTEM = `You are in a side conversation, not the main thread.
The messages below are the exact transcript of the main thread, reference-only.
Only the final user message (marked INTERRUPTION) is your active task.
Do not continue, execute, or complete anything from the inherited transcript.
Answer concisely, read-only. No tools.`;

const MAX_HISTORY_CHARS = 60000;
const WIDGET_LINES = 30;

/** Drop a trailing incomplete tail: assistant toolCalls with no results yet
 *  (snapshot taken mid-turn). Providers reject dangling tool calls. */
function trimDanglingTail(llm: any[]): any[] {
  const out = [...llm];
  const callIds = new Set<string>();
  for (const m of out) {
    if (m?.role === "assistant" && Array.isArray(m.content))
      for (const b of m.content) if (b?.type === "toolCall" && b.id) callIds.add(b.id);
  }
  while (out.length > 0) {
    const last: any = out[out.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b: any) => b?.type === "toolCall")) {
      out.pop();
      continue;
    }
    if (last?.role === "toolResult" && last?.toolCallId && !callIds.has(last.toolCallId)) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

/** Budget-trim from the front, keeping a leading summary + cutting at a user boundary when possible. */
function fitBudget(llm: any[], budget: number): any[] {
  const size = (m: any) => JSON.stringify(m).length;
  let total = llm.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return llm;
  const head = llm[0]?.role === "compactionSummary" || llm[0]?.role === "branchSummary" ? [llm[0]] : [];
  const rest = head.length ? llm.slice(1) : [...llm];
  let kept: any[] = [];
  let used = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const s = size(rest[i]);
    if (used + s > budget && kept.length > 0) break;
    kept.unshift(rest[i]);
    used += s;
  }
  // align cut to a user message so we don't start mid assistant/tool pair
  const ui = kept.findIndex((m: any) => m?.role === "user");
  if (ui > 0) kept = kept.slice(ui);
  return [...head, ...kept];
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message as AgentMessage;
  if (entry.type === "compaction")
    return {
      role: "compactionSummary",
      summary: (entry as any).summary,
      tokensBefore: (entry as any).tokensBefore,
      timestamp: new Date((entry as any).timestamp).getTime(),
    } as any;
  if (entry.type === "branch_summary")
    return {
      role: "branchSummary",
      summary: (entry as any).summary,
      fromId: (entry as any).fromId,
      timestamp: new Date((entry as any).timestamp).getTime(),
    } as any;
  return undefined;
}

const BTW_ID = "btw";

export default function (pi: ExtensionAPI) {
  let current: AbortController | undefined;

  const clearBtw = (ctx: { ui: { setWidget: (k: string, v: any) => void; setStatus: (k: string, v: any) => void } }) => {
    current?.abort();
    current = undefined;
    ctx.ui.setWidget(BTW_ID, undefined);
    ctx.ui.setStatus(BTW_ID, undefined);
  };

  pi.on("session_shutdown", async (_event, ctx) => {
    clearBtw(ctx);
  });

  pi.registerCommand("btw", {
    description: "Ask a side question in parallel (full context to now)",
    handler: async (args, ctx) => {
      const q = args.trim();
      if (!q) {
        ctx.ui.notify("Usage: /btw <question>", "info");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      // 1. Snapshot synchronously — leaf moves under you once main continues.
      let branch: SessionEntry[];
      try {
        const sm = ctx.sessionManager as any;
        branch =
          typeof sm.buildContextEntries === "function"
            ? sm.buildContextEntries()
            : sm.getBranch();
      } catch (e: any) {
        ctx.ui.notify(`btw: can't read context: ${e?.message ?? e}`, "error");
        return;
      }
      // Prefer the resolved session context (compaction-aware AgentMessages),
      // fall back to branch mapping.
      let agentMessages: AgentMessage[];
      try {
        const sm = ctx.sessionManager as any;
        if (typeof sm.buildSessionContext === "function") {
          agentMessages = sm.buildSessionContext().messages as AgentMessage[];
        } else {
          agentMessages = branch
            .map(entryToMessage)
            .filter((m): m is AgentMessage => m !== undefined);
        }
      } catch {
        agentMessages = branch
          .map(entryToMessage)
          .filter((m): m is AgentMessage => m !== undefined);
      }
      if (agentMessages.length === 0) {
        ctx.ui.notify("No conversation yet to ask about", "info");
        return;
      }
      const transcript = fitBudget(trimDanglingTail(convertToLlm(agentMessages) as any[]), MAX_HISTORY_CHARS);

      // 2. Singleton: new /btw aborts + replaces the old one. Independent
      // lifetime — NOT ctx.signal (that's the main turn).
      current?.abort();
      const abort = new AbortController();
      current = abort;
      const id = BTW_ID;
      const model = ctx.model!;
      const ui = ctx.ui;
      const registry = ctx.modelRegistry;
      // opencode-go routes by x-opencode-session header. Direct
      // modelRegistry.complete() bypasses pi's SDK wrapper that normally
      // injects it, so set it explicitly to the *main* pi session id
      // (a random uuid gets rejected with MissingSessionID).
      const piSessionId: string | undefined = (() => {
        try {
          return (ctx.sessionManager as any).getSessionId?.();
        } catch {
          return undefined;
        }
      })();

      ui.setStatus(id, "btw running…");
      ui.setWidget(id, [`btw ${id}: ${q.slice(0, 100)}`, "…thinking (main keeps running)…"], { placement: "belowEditor" } as any);

      // 3. Fire-and-forget — handler returns immediately, prompt() unblocks.
      void (async () => {
        try {
          const res = await registry.complete(
            model,
            {
              systemPrompt: BTW_SYSTEM,
              messages: [
                ...transcript,
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `INTERRUPTION — everything above is inherited history from the main thread. It is reference context only, not your task. Do not continue, execute, or complete anything above.\n\nYour only active instruction: ${q}`,
                    },
                  ],
                  timestamp: Date.now(),
                },
              ],
            },
            {
              signal: abort.signal,
              sessionId: piSessionId,
              headers: piSessionId
                ? { "x-opencode-session": piSessionId, "x-opencode-client": "pi" }
                : undefined,
            } as any,
          );
          const raw = JSON.stringify(res).slice(0, 2000);
          // eslint-disable-next-line no-console
          console.error(`[btw] stopReason=${(res as any).stopReason} contentTypes=${((res as any).content ?? []).map((c: any) => c.type).join(",")} rawHead=${raw}`);
          const text = ((res as any).content ?? [])
            .filter((c: any) => c.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("\n")
            .trim();
          const body =
            text ||
            `stopReason=${(res as any).stopReason ?? "?"} types=[${((res as any).content ?? []).map((c: any) => c.type).join(",")}] raw=${raw}`;
          if (current !== abort) return; // superseded by a newer /btw
          ui.setWidget(
            id,
            [`btw: ${q}`, "", ...body.split("\n").slice(0, WIDGET_LINES)],
            { placement: "belowEditor" } as any,
          );
          ui.notify("btw done", "info");
        } catch (e: any) {
          if (current !== abort) return;
          const cancelled = abort.signal.aborted;
          ui.setWidget(id, [
            `btw: ${q.slice(0, 100)}`,
            cancelled ? "(cancelled)" : `error: ${e?.message ?? e}`,
          ]);
        } finally {
          if (current === abort) {
            ui.setStatus(id, undefined);
            current = undefined;
          }
        }
      })();
    },
  });

  pi.registerCommand("btw-clear", {
    description: "Cancel/clear the btw side answer",
    handler: async (_args, ctx) => {
      clearBtw(ctx);
      ctx.ui.notify("btw cleared", "info");
    },
  });
}
