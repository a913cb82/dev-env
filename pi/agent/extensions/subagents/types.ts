export type AgentStatus =
	| "queued"
	| "starting"
	| "thinking"
	| "running_tool"
	| "idle"
	| "completed"
	| "failed"
	| "cancelled";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface AgentRecord {
	version: 1;
	runId: string;
	parentRunId: string;
	rootRunId: string;
	sessionId: string;
	sessionFile?: string;
	pid?: number;
	/** Linux /proc start time used to reject stale PID reuse during cleanup. */
	pidStartTime?: string;
	name: string;
	task: string;
	cwd: string;
	model: string;
	thinking: string;
	tools?: string[];
	depth: number;
	maxDepth: number;
	status: AgentStatus;
	/** Fresh on each agent_start; scopes parent-owned result/UI markers to one execution. */
	executionId?: string;
	/** Set once this child's result has been delivered to the parent session. */
	resultsDelivered?: boolean;
	activity?: string;
	currentTool?: string;
	latestText?: string;
	error?: string;
	usage: UsageSummary;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
}

export interface SubagentSettings {
	/** Runtime provenance: a depth flag overrides file limits throughout its subtree. */
	maxDepthFlagOverride?: boolean;
	defaultModel?: string;
	defaultThinking?: string;
	maxDepth: number;
	maxConcurrency: number;
	/** Maximum UTF-16 code units per child RPC stdout record (default 64 Mi). */
	rpcMaxLineChars?: number;
	/** Prune delivered terminal runs older than this many days (default 14). */
	pruneDeliveredAfterDays?: number;
	/** Always keep this many newest delivered candidates (default 50). */
	pruneDeliveredKeep?: number;
	/** Prune undelivered terminal runs older than this many days (default 30, 0 disables). */
	pruneUndeliveredAfterDays?: number;
	/** Keep this many newest undelivered runs; excess oldest go past the cap grace floor (default 500, 0 disables). */
	pruneUndeliveredKeep?: number;
}

export interface SpawnAgentInput {
	task: string;
	name?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
}

/** How a parent message is delivered to a subagent. Maps to pi's native
 * steering (`steer`: redirect current work, delivered before the next LLM
 * call) and follow-up (`followUp`: queued until current work finishes)
 * queueing. Transported as `prompt` + `streamingBehavior` so an idle child
 * starts a turn instead of stranding the message in a queue no run drains. */
export type SubagentMessageMode = "steer" | "followUp";

export function normalizeMessageMode(value: unknown): SubagentMessageMode {
	if (value === undefined) return "steer";
	if (value === "steer" || value === "followUp") return value;
	throw new Error(`Subagent message mode must be "steer" or "followUp", got ${JSON.stringify(value)}`);
}

export const EMPTY_USAGE: UsageSummary = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};
