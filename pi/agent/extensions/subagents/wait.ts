import { resolve } from "node:path";
import { descendantsOf, isTerminalStatus, readRecords } from "./registry.ts";
import type { AgentRecord } from "./types.ts";

const DEFAULT_POLL_MS = 250;

export interface WaitUntilIdleOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	/** How often to re-read the registry while waiting. */
	pollMs?: number;
	/** Restrict the wait to these run ids; omit to watch every descendant. */
	targets?: readonly string[];
	/** Resolve when any (or all) of the selected subagents are terminal. Default "all". */
	mode?: "any" | "all";
}

interface Waiter {
	agentDir: string;
	wake: () => void;
}

const waiters = new Set<Waiter>();

function dirKey(agentDir: string): string {
	return resolve(agentDir);
}

function snapshotDescendants(agentDir: string, parentRunId: string): AgentRecord[] {
	return descendantsOf(readRecords(agentDir), parentRunId);
}

/** Build the predicate over a (optionally targeted) selection of descendants. */
function selectionPredicate(options: WaitUntilIdleOptions): (rows: readonly AgentRecord[]) => boolean {
	const targetIds = options.targets ? new Set(options.targets) : undefined;
	const mode = options.mode ?? "all";
	return (rows) => {
		const watched = targetIds ? rows.filter((record) => targetIds.has(record.runId)) : rows;
		if (watched.length === 0) return true; // nothing to wait for
		return mode === "any"
			? watched.some((record) => isTerminalStatus(record.status))
			: watched.every((record) => isTerminalStatus(record.status));
	};
}

/** Wake waiters after an in-process record change (spawn/settle/cancel). */
export function notifyWaiters(agentDir?: string): void {
	const key = agentDir === undefined ? undefined : dirKey(agentDir);
	for (const waiter of [...waiters]) {
		if (key === undefined || waiter.agentDir === key) waiter.wake();
	}
}

/** Test helper: live waiters. */
export function waitDebugState(): { waiters: number } {
	return { waiters: waiters.size };
}

/**
 * Block until the selected descendants of `parentRunId` are terminal, `timeoutMs`
 * elapses, or `signal` aborts. Without `targets` every descendant is watched and
 * `mode: "all"` waits for all of them; `mode: "any"` resolves on the first
 * finish. Completion is noticed by in-process notifications (spawn/settle/cancel)
 * or by re-reading the registry every `pollMs`; the timeout is a ceiling.
 */
export async function waitUntilSubagentsIdle(
	agentDir: string,
	parentRunId: string,
	options: WaitUntilIdleOptions,
): Promise<AgentRecord[]> {
	const timeoutMs = options.timeoutMs;
	const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
	const isDone = selectionPredicate(options);
	const snapshot = () => snapshotDescendants(agentDir, parentRunId);
	let rows = snapshot();
	if (isDone(rows) || timeoutMs <= 0) return rows;
	if (options.signal?.aborted) throw new Error("check_subagents was aborted");

	return new Promise<AgentRecord[]>((resolveWait, rejectWait) => {
		let settled = false;
		const key = dirKey(agentDir);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let poll: ReturnType<typeof setInterval> | undefined;
		const onAbort = () => finish(new Error("check_subagents was aborted"));
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (poll) clearInterval(poll);
			options.signal?.removeEventListener("abort", onAbort);
			waiters.delete(waiter);
			if (error) rejectWait(error);
			else {
				try {
					resolveWait(snapshot());
				} catch (snapshotError) {
					rejectWait(snapshotError instanceof Error ? snapshotError : new Error(String(snapshotError)));
				}
			}
		};
		const waiter: Waiter = {
			agentDir: key,
			wake() {
				try {
					if (isDone(snapshot())) finish();
				} catch {
					// Keep waiting until timeout; a transient read must not fail the tool.
				}
			},
		};
		waiters.add(waiter);
		poll = setInterval(() => waiter.wake(), pollMs);
		poll.unref?.();
		timer = setTimeout(() => finish(), timeoutMs);
		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
		waiter.wake();
	});
}
