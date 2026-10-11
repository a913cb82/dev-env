import { isProcessAlive, isTerminalStatus, readRecords, saveRecord } from "./registry.ts";
export { shouldSkipOwnerWrite } from "./registry.ts";
import { resumeSubagent, type SpawnContext } from "./spawn-agent.ts";
import { EMPTY_USAGE, type AgentRecord, type UsageSummary } from "./types.ts";

/** Self-reported completion for subagents whose parent already settled.
 *
 * A settled owner's process is reaped, so its monitors die with it: without
 * self-reporting, a grandchild that outlives its parent would rot into a fake
 * failure nobody can collect. Instead the session finalizes its own record at
 * `agent_before_settle` (when no live owner can do it) and wakes its parent
 * with the result. The woken parent collects the result as the direct owner,
 * reacts, and re-settles; the chain climbs until a live session owns the turn.
 * Ownership and claiming never move: no adoption, no promotion illusion.
 */

export type SelfSettleStatus = "completed" | "failed" | "cancelled";

export interface SettleSummary {
	status: SelfSettleStatus;
	finalText: string;
	usage: UsageSummary;
}

interface TranscriptMessage {
	role?: unknown;
	content?: Array<{ type?: unknown; text?: unknown }> | unknown;
	usage?: {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		totalTokens?: unknown;
		cost?: unknown;
	} | null;
}

export interface SettleEventLike {
	outcome?: unknown;
	context?: {
		pendingMessages?: unknown;
		contextMessages?: TranscriptMessage[] | unknown;
	} | null;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Extract completion state from a settle event: outcome maps to status, the
 * final text is the last assistant message, usage sums every assistant turn
 * (the transcript is the full history, so the sum is exact). Never throws. */
export function summarizeSettleEvent(event: SettleEventLike): SettleSummary {
	const usage: UsageSummary = { ...EMPTY_USAGE };
	let finalText = "(no output)";
	try {
		const messages = event?.context?.contextMessages;
		if (Array.isArray(messages)) {
			for (const message of messages) {
				if (!message || typeof message !== "object" || (message as TranscriptMessage).role !== "assistant") continue;
				const item = message as TranscriptMessage;
				const content = Array.isArray(item.content) ? item.content : [];
				const text = content
					.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
					.map((part) => part.text as string)
					.join("\n");
				if (text) finalText = text;
				if (item.usage && typeof item.usage === "object") {
					const turn = item.usage;
					usage.input += num(turn.input);
					usage.output += num(turn.output);
					usage.cacheRead += num(turn.cacheRead);
					usage.cacheWrite += num(turn.cacheWrite);
					usage.totalTokens += num(turn.totalTokens);
					const cost = turn.cost;
					usage.cost += typeof cost === "number" ? cost : num((cost as { total?: unknown } | null)?.total);
				}
			}
		}
	} catch {
		// A malformed event still settles; fields keep their fallbacks.
	}
	const outcome = (event as { outcome?: unknown } | null)?.outcome;
	const status: SelfSettleStatus = outcome === "aborted" ? "cancelled" : outcome === "error" ? "failed" : "completed";
	return { status, finalText, usage };
}

/** Write our own terminal record: status, text, exact usage, finish stamp.
 * The exiting process clears its pid. Always overwrites: this settle is the
 * freshest data, and a stale owner monitor must not win (it skips terminal
 * on-disk records via shouldSkipOwnerWrite). Returns "written" or "missing". */
export function finalizeOwnRun(agentDir: string, runId: string, summary: SettleSummary): "written" | "missing" {
	const current = readRecords(agentDir).find((record) => record.runId === runId);
	if (!current) return "missing";
	const now = new Date().toISOString();
	saveRecord(agentDir, {
		...current,
		status: summary.status,
		activity: summary.status,
		latestText: summary.finalText,
		usage: summary.usage,
		currentTool: undefined,
		error:
			summary.status === "completed"
				? current.error
				: (current.error ?? (summary.status === "cancelled" ? "Subagent was aborted" : "Subagent failed")),
		finishedAt: current.finishedAt ?? now,
		updatedAt: now,
		pid: undefined,
		pidStartTime: undefined,
	});
	return "written";
}

export interface WakeDeps {
	agentDir: string;
	ownRunId: string;
	/** False when the resumer's gate is full: a queued wake with no live
	 * process to drain it would stick forever, so skip instead. */
	canLaunch: () => boolean;
	buildContext: (parent: AgentRecord) => SpawnContext;
}

/** Wake a settled parent with our result notification. The parent resumes
 * from its transcript (same run, same owner) and collects our already
 * finalized record. Liveness, not status, decides: a settled-but-lingering
 * parent owns its turn (its monitor and mesh server are up, so the owner
 * path delivers), and resuming it too would run two writers on one session.
 * Only a settled parent with no live process is resumed. */
export async function maybeWakeParent(deps: WakeDeps): Promise<"resumed" | "parent-live" | "no-parent" | "missing" | "gate-full" | "resume-failed"> {
	const rows = readRecords(deps.agentDir);
	const own = rows.find((record) => record.runId === deps.ownRunId);
	if (!own) return "missing";
	const parent = rows.find((record) => record.runId === own.parentRunId);
	if (!parent) return "no-parent";
	if (!isTerminalStatus(parent.status)) return "parent-live";
	if (isProcessAlive(parent.pid)) return "parent-live";
	if (!deps.canLaunch()) return "gate-full";
	const wakeText =
		`Subagent ${own.name} finished (${own.status}, run ${own.runId.slice(0, 8)}). ` +
		`Use check_subagents to read its result.`;
	try {
		await resumeSubagent(parent, wakeText, deps.buildContext(parent), "steer");
	} catch {
		// A concurrent wake (or a mid-flight state change) already owns the
		// parent turn; either way the result has a live claimant again.
		return "resume-failed";
	}
	return "resumed";
}
