import { descendantsOf } from "./registry.ts";
import type { AgentRecord, UsageSummary } from "./types.ts";

/**
 * Subagent cost roll-up. Every session reports its direct children's subtree
 * cost deltas as `usage` on its own tool results, so pi's `$` meter shows
 * own + entire subtree. Grandchildren are included by summation over the
 * shared registry (direct reads), not by relaying through intermediates.
 *
 * Exactly-once accounting rests on three invariants:
 * - Record usage only grows (never reset, never decreases).
 * - Each record has exactly one reporter: its direct parent's session.
 * - The floor is rebuilt (replaced, never merged) from session entries on
 *   session start/tree, so it always equals what this session file counted —
 *   including across reloads and forks (which copy a subset of entries).
 */

/** Cost below one-billionth of a dollar is float dust from summation order, not spend. Token fields are integers and compare exactly. */
export const COST_EPSILON = 1e-9;

/** runId -> last reported subtree total. */
export type CostFloor = Map<string, UsageSummary>;

/** pi Usage shape for tool-result attribution. Breakdown fields we don't track stay zero; `total` carries the dollars. */
export interface AttributedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export function emptyUsage(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function addInto(target: UsageSummary, source: UsageSummary): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.cost += source.cost;
}

/** Own usage plus every descendant's, summed field-by-field. Cumulative across executions, so resumption needs no baseline. */
export function subtreeUsage(records: readonly AgentRecord[], runId: string): UsageSummary {
	const total = emptyUsage();
	const root = records.find((record) => record.runId === runId);
	if (root) addInto(total, root.usage);
	for (const record of descendantsOf(records, runId)) addInto(total, record.usage);
	return total;
}

export function toPiUsage(total: UsageSummary): AttributedUsage {
	return {
		input: total.input,
		output: total.output,
		cacheRead: total.cacheRead,
		cacheWrite: total.cacheWrite,
		totalTokens: total.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: total.cost },
	};
}

function isValidReportedVector(value: unknown): value is UsageSummary {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].every(
		(field) => typeof v[field] === "number" && Number.isFinite(v[field] as number) && (v[field] as number) >= 0,
	);
}

function maxVector(a: UsageSummary, b: UsageSummary): UsageSummary {
	return {
		input: Math.max(a.input, b.input),
		output: Math.max(a.output, b.output),
		cacheRead: Math.max(a.cacheRead, b.cacheRead),
		cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
		totalTokens: Math.max(a.totalTokens, b.totalTokens),
		cost: Math.max(a.cost, b.cost),
	};
}

/**
 * Rebuild the floor from session entries: per runId, the per-field max of
 * every `details.costReported` receipt. Matches pi's meter walk (all entries,
 * not the branch), so the floor always equals what this file counted.
 * Per-field max (not cost comparison) keeps token-only growth reporting on
 * zero-cost models. Corrupt receipts are ignored.
 */
export function rebuildFloor(entries: readonly unknown[]): CostFloor {
	const floor: CostFloor = new Map();
	for (const entry of entries) {
		const raw = entry as
			| { type?: unknown; message?: { role?: unknown; details?: unknown } }
			| undefined;
		const details = raw?.type === "message" && raw.message?.role === "toolResult" ? raw.message.details : undefined;
		const reported = details !== null && typeof details === "object"
			? (details as { costReported?: unknown }).costReported
			: undefined;
		if (!reported || typeof reported !== "object") continue;
		for (const [runId, vector] of Object.entries(reported as Record<string, unknown>)) {
			if (!isValidReportedVector(vector)) continue;
			const prev = floor.get(runId);
			floor.set(runId, prev ? maxVector(prev, vector) : { ...vector });
		}
	}
	return floor;
}

/**
 * Compute the unreported subtree-cost delta for each direct child of
 * `parentRunId`. Pure and synchronous: reads the floor, and advances it only
 * for children with a real delta (token fields exact, cost above epsilon).
 * Negative field deltas are clamped to zero (usage should only grow; a dip is
 * a glitch and must not subtract from the meter) while still advancing the
 * floor so it can't re-emit forever.
 */
export function computeFlush(
	records: readonly AgentRecord[],
	parentRunId: string,
	floor: CostFloor,
): { usage: AttributedUsage; receipt: Record<string, UsageSummary> } | undefined {
	let aggregate: UsageSummary | undefined;
	let receipt: Record<string, UsageSummary> | undefined;
	for (const record of records) {
		if (record.parentRunId !== parentRunId) continue;
		const total = subtreeUsage(records, record.runId);
		const prev = floor.get(record.runId);
		const delta = {
			input: total.input - (prev?.input ?? 0),
			output: total.output - (prev?.output ?? 0),
			cacheRead: total.cacheRead - (prev?.cacheRead ?? 0),
			cacheWrite: total.cacheWrite - (prev?.cacheWrite ?? 0),
			totalTokens: total.totalTokens - (prev?.totalTokens ?? 0),
			cost: total.cost - (prev?.cost ?? 0),
		};
		if (
			delta.input === 0 && delta.output === 0 && delta.cacheRead === 0 &&
			delta.cacheWrite === 0 && delta.totalTokens === 0 && delta.cost <= COST_EPSILON
		) {
			continue;
		}
		if (!aggregate) aggregate = emptyUsage();
		aggregate.input += Math.max(0, delta.input);
		aggregate.output += Math.max(0, delta.output);
		aggregate.cacheRead += Math.max(0, delta.cacheRead);
		aggregate.cacheWrite += Math.max(0, delta.cacheWrite);
		aggregate.totalTokens += Math.max(0, delta.totalTokens);
		aggregate.cost += Math.max(0, delta.cost);
		if (!receipt) receipt = {};
		receipt[record.runId] = { ...total };
		floor.set(record.runId, { ...total });
	}
	if (!aggregate || !receipt) return undefined;
	return { usage: toPiUsage(aggregate), receipt };
}

/** Rebuild `floor` in place from session entries (replace, never merge — see above). Tolerates hosts without full entry history. */
export function restoreCostFloor(floor: CostFloor, sessionManager: unknown): void {
	floor.clear();
	const getEntries = (sessionManager as { getEntries?: unknown })?.getEntries;
	if (typeof getEntries !== "function") return;
	let entries: unknown;
	try {
		entries = (getEntries as () => unknown).call(sessionManager);
	} catch {
		return;
	}
	if (!Array.isArray(entries)) return;
	for (const [runId, vector] of rebuildFloor(entries)) floor.set(runId, vector);
}
